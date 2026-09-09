/**
 * `agentchat agent …` — the agents this account owns, and the projects they
 * are in (plan §6.2, D13).
 *
 * Six subcommands: `list`, `create`, `rename`, `delete`, `use`, and `join`. Five
 * of them talk to `/agents`; `use` writes a file and is the only one whose
 * result never leaves this machine.
 *
 * ## An agent's name is an address, not an identity
 *
 * This is the one thing about this command surface that surprises people, so it
 * is said out loud in the deletion prompt rather than left in the manual.
 *
 * Deletion is soft (D13): `DELETE /agents/:id` sets `deleted_at`, ends the
 * agent's sessions, and drops its project memberships, but every message it
 * sent or received keeps pointing at that row, which still exists and still
 * resolves. What deletion *does* release is the name — and T-109 established
 * what happens next: creating an agent with the freed name mints a **new**
 * identifier. The new agent answers at the same `@user/agent` address, and none
 * of the old conversation belongs to it.
 *
 * So "delete and re-create to start fresh" does exactly what someone would want
 * and "delete and re-create to fix a typo in a running setup" quietly leaves
 * every stored reference — including the default this command writes — pointing
 * at the agent that is gone. The confirmation says both halves; `--yes` skips
 * the asking, not the consequence.
 *
 * ## Deleting the default does not leave a dangling default
 *
 * `agent use` records a default per project, keyed by *id*, so a default that
 * outlives its agent is not merely stale: it is unusable. Every later command
 * resolves the agent from user configuration (T-205), gets an id the server has
 * soft-deleted, and fails with `AGENT_DELETED` — and it keeps failing after the
 * user creates a replacement under the same name, because the replacement has a
 * different id. The fallbacks that would have rescued them (the single-agent
 * shortcut) never run, because a stored default wins over them.
 *
 * `agent delete` therefore forgets every default that pointed at the agent it
 * just deleted, in every project, and says so on stderr. The alternative —
 * leaving it and letting the next command explain itself — was rejected because
 * the next command cannot: `AGENT_DELETED` from a stored id reads as a server
 * problem, and the remedy (`agent use` again) is not one this file's absence
 * would suggest. Forgetting restores the resolution order to what a user with
 * no default has, which is a state the CLI already knows how to talk about.
 *
 * ## Names are rejected here before they are sent
 *
 * {@link AgentNameSchema} is the server's own rule, imported rather than
 * retyped, so `agentchat agent create Backend` fails with the grammar in the
 * message and no round trip. A copy of the pattern would be a second source of
 * truth that drifts the first time the grammar moves.
 *
 * ## Which stream carries what
 *
 * PRD §39, unchanged: the result goes to stdout in whichever representation was
 * asked for, and everything a person reads on the way — progress, the deletion
 * prompt, the warning that a default was forgotten — goes to stderr. Every
 * subcommand supports `--json`; `agent delete --json` additionally refuses to
 * prompt, because a prompt on stderr is not something a JSON consumer can
 * answer. See {@link confirmOnStdin}.
 *
 * @module
 */

import process from 'node:process';
import { createInterface } from 'node:readline';

import type { AgentChatClient } from '@agentchat/client';
import type { Agent, AgentId, ProjectId } from '@agentchat/protocol';
import { AgentNameSchema, ErrorCode, ProjectId as ProjectIdKind } from '@agentchat/protocol';

import type { OptionSpecs } from '../args.js';
import type { ClientSeams } from '../client.js';
import { clientFor } from '../client.js';
import type { Command, CommandContext, CommandGroup } from '../command.js';
import type { UserConfig } from '../config.js';
import {
  defaultAgentFor,
  readUserConfig,
  withDefaultAgent,
  withoutDefaultAgent,
  writeUserConfig,
} from '../config.js';
import type { ResolvedProject } from '../context.js';
import { CONTEXT_OPTIONS, contextRequestFor, projectIdFor, resolveProject } from '../context.js';
import { CliError, UsageError } from '../errors.js';
import type { JsonValue, View } from '../output/output.js';
import { view } from '../output/output.js';
import { PROGRAM } from '../version.js';

/**
 * Asks the user a yes-or-no question.
 *
 * A seam, because the alternative is a test that either drives a pseudo-terminal
 * or cannot cover the "answered no" branch at all.
 *
 * @param question - One line, already phrased so that "no" is the safe answer.
 * @param context - The command context, for the stream the question goes to.
 * @returns Whether the user said yes. Anything else, including end of input, is
 *   no.
 */
export type Confirm = (question: string, context: CommandContext) => Promise<boolean>;

/**
 * The seams these six commands are built on.
 *
 * Every field has a real default; they exist so a test can drive a whole
 * command — parsing, resolution, streams, exit code — against a stubbed server
 * without a socket, a home directory, or a terminal to type into.
 *
 * The two the client is built from are inherited from {@link ClientSeams}
 * rather than restated, so a seam added there reaches these six subcommands
 * without anyone remembering to copy it across.
 */
export interface AgentOverrides extends ClientSeams {
  /** How the deletion prompt is answered. Defaults to reading stdin. */
  readonly confirm?: Confirm;
}

/**
 * `--project`, and deliberately not `--agent`.
 *
 * Every command here names its agent as a positional argument, so the flag that
 * chooses one somewhere else would do nothing here — and a flag that does
 * nothing is worse than an absent one, because `--help` promises it works.
 * Derived from {@link CONTEXT_OPTIONS} rather than restated so the description
 * and the environment variable it names stay in one place.
 */
const PROJECT_OPTIONS: OptionSpecs = Object.freeze(
  Object.fromEntries(Object.entries(CONTEXT_OPTIONS).filter(([name]) => name === 'project')),
);

/** `--yes`, for `agent delete` in a script. */
const CONFIRMATION_OPTIONS: OptionSpecs = Object.freeze({
  ...PROJECT_OPTIONS,
  yes: {
    type: 'boolean',
    description: 'skip the confirmation prompt',
  },
});

/**
 * Validates an agent name against the server's own rule.
 *
 * Both the verdict and the explanation come from {@link AgentNameSchema}, so
 * neither the pattern nor the sentence describing it is written twice. Only the
 * examples are this file's own.
 *
 * @param value - What the user typed.
 * @param what - Which argument it was, for the message: `new name`.
 * @returns The name, unchanged.
 * @throws {UsageError} Exit 2, carrying the grammar, before anything is sent.
 */
export function requireAgentName(value: string, what = 'agent name'): string {
  const parsed = AgentNameSchema.safeParse(value);
  if (!parsed.success) {
    const reason = parsed.error.issues[0]?.message ?? 'It does not match the agent-name grammar.';
    throw new UsageError(`\`${value}\` is not a valid ${what}.`, {
      hint: `${reason} For example: backend, code-review-2.`,
    });
  }
  return parsed.data;
}

/**
 * One of the caller's own live agents, by name.
 *
 * Every subcommand but `create` takes a name and needs an id, and `GET /agents`
 * is the only listing that answers for the caller specifically. Deleted agents
 * are not in it, so a name freed by deletion reads here exactly as a name that
 * never existed — which is what it now is.
 *
 * @param client - The client to ask.
 * @param name - The agent's name.
 * @param signal - The interrupt signal.
 * @returns The agent.
 * @throws {CliError} `NOT_FOUND` when the caller owns no live agent by that
 *   name, with the names they do own in the hint.
 */
async function findOwnAgent(
  client: AgentChatClient,
  name: string,
  signal: AbortSignal,
): Promise<Agent> {
  const { items } = await client.agents.list({ signal });
  const match = items.find((agent) => agent.name === name);
  if (match !== undefined) {
    return match;
  }

  throw new CliError(ErrorCode.NOT_FOUND, `You have no agent named \`${name}\`.`, {
    hint:
      items.length === 0
        ? `You have no agents yet. Create one with \`${PROGRAM} agent create ${name}\`.`
        : `Your agents are: ${items.map((agent) => agent.name).join(', ')}.`,
  });
}

/**
 * Whether an agent is in a project.
 *
 * `GET /projects/:id/agents` is discovery, so it answers with everybody's
 * agents; an id is unique across owners, so matching on it alone is enough and
 * no `GET /me` is needed to know which rows are ours.
 *
 * @param client - The client to ask.
 * @param projectId - The project.
 * @param agentId - The agent.
 * @param signal - The interrupt signal.
 * @returns `true` if the agent participates in that project.
 */
async function isAgentInProject(
  client: AgentChatClient,
  projectId: ProjectId,
  agentId: AgentId,
  signal: AbortSignal,
): Promise<boolean> {
  const { items } = await client.projects.listAgents(projectId, { signal });
  return items.some((row) => row.agent.id === agentId);
}

/**
 * The project this invocation acts in.
 *
 * @param context - The command context.
 * @returns The resolved project.
 * @throws {CliError} `NO_PROJECT` (exit 4) when nothing names one.
 */
async function requireProject(context: CommandContext): Promise<ResolvedProject> {
  return await resolveProject(contextRequestFor(context));
}

/**
 * The project this invocation acts in, if any does.
 *
 * Used only by `agent list`, which is useful outside a project and merely
 * *better* inside one. A `NO_PROJECT` is swallowed because it means the user
 * never named a project; anything else — a malformed `--project`, an unreadable
 * configuration file — is raised, because they did name one and got it wrong.
 *
 * @param context - The command context.
 * @returns The resolved project, or `null` when none was named.
 */
async function optionalProject(context: CommandContext): Promise<ResolvedProject | null> {
  try {
    return await requireProject(context);
  } catch (error) {
    if (error instanceof CliError && error.code === ErrorCode.NO_PROJECT) {
      return null;
    }
    throw error;
  }
}

/**
 * An agent, as `--json` carries it.
 *
 * @param agent - The agent.
 * @returns The JSON object.
 */
function agentJson(agent: Agent): JsonValue {
  return {
    id: agent.id,
    name: agent.name,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

/**
 * A project, as `--json` carries it. `null` where none was resolved.
 *
 * @param id - The project id, once known.
 * @param project - The resolution it came from, for the slug.
 * @returns The JSON object.
 */
function projectJson(id: ProjectId, project: ResolvedProject): JsonValue {
  return { id, slug: project.slug };
}

/**
 * `agent list`, in both representations.
 *
 * @param agents - The caller's live agents.
 * @param project - The project the default applies to, or `null`.
 * @param defaultAgent - The default agent's id for that project, or `null`.
 * @returns The view.
 */
export function agentListView(
  agents: readonly Agent[],
  project: ResolvedProject | null,
  defaultAgent: AgentId | null,
): View {
  const json: JsonValue = {
    items: agents.map((agent) => ({
      ...(agentJson(agent) as Record<string, JsonValue>),
      isDefault: agent.id === defaultAgent,
    })),
  };

  return view(json, (writer) => {
    if (agents.length === 0) {
      writer.line(`No agents. Create one with \`${PROGRAM} agent create <name>\`.`);
      return;
    }

    writer.table(
      [
        {
          header: 'NAME',
          cell: (agent: Agent): string =>
            agent.id === defaultAgent
              ? `${writer.style.bold(agent.name)} ${writer.style.dim('(default here)')}`
              : agent.name,
        },
        { header: 'ID', cell: (agent: Agent): string => agent.id },
        { header: 'CREATED', cell: (agent: Agent): string => agent.createdAt },
      ],
      agents,
    );

    if (defaultAgent === null && project !== null) {
      writer.blank();
      writer.line(
        writer.style.dim(`No default agent here. Set one with \`${PROGRAM} agent use <name>\`.`),
      );
    }
  });
}

/**
 * `agent create`, in both representations.
 *
 * @param agent - The agent that was created.
 * @param projectId - The project it joined.
 * @param project - The resolution that project came from.
 * @returns The view.
 */
export function agentCreatedView(
  agent: Agent,
  projectId: ProjectId,
  project: ResolvedProject,
): View {
  return view({ agent: agentJson(agent), project: projectJson(projectId, project) }, (writer) => {
    writer.line(
      `Created ${writer.style.bold(agent.name)} and joined it to ${project.slug ?? projectId}.`,
    );
    writer.fields([
      ['id', agent.id],
      ['project', projectId],
    ]);
  });
}

/**
 * `agent rename`, in both representations.
 *
 * @param agent - The agent as it now stands.
 * @param previousName - What it was called.
 * @returns The view.
 */
export function agentRenamedView(agent: Agent, previousName: string): View {
  return view({ agent: agentJson(agent), previousName }, (writer) => {
    writer.line(`Renamed ${writer.style.bold(previousName)} to ${writer.style.bold(agent.name)}.`);
    writer.fields([['id', agent.id]]);
  });
}

/**
 * `agent delete`, in both representations.
 *
 * `historyPreserved` is on the wire as well as in the prose because it is the
 * fact that makes the command safe to run, and a harness deciding whether to
 * warn its own user should not have to parse an English sentence to learn it.
 *
 * @param agent - The agent that was deleted.
 * @param clearedDefaultFor - Projects whose stored default pointed at it.
 * @returns The view.
 */
export function agentDeletedView(agent: Agent, clearedDefaultFor: readonly ProjectId[]): View {
  const json: JsonValue = {
    deleted: agentJson(agent),
    historyPreserved: true,
    clearedDefaultFor: [...clearedDefaultFor],
  };

  return view(json, (writer) => {
    writer.line(`Deleted ${writer.style.bold(agent.name)}.`);
    writer.line('Its message history is preserved; the name is free to use again.');
  });
}

/**
 * `agent use`, in both representations.
 *
 * @param agent - The agent that is now the default.
 * @param projectId - The project the choice applies to.
 * @param project - The resolution that project came from.
 * @param path - The user configuration file it was written to.
 * @returns The view.
 */
export function agentUsedView(
  agent: Agent,
  projectId: ProjectId,
  project: ResolvedProject,
  path: string,
): View {
  return view(
    { agent: agentJson(agent), project: projectJson(projectId, project), configPath: path },
    (writer) => {
      writer.line(
        `${writer.style.bold(agent.name)} is now your default agent in ${project.slug ?? projectId}.`,
      );
      writer.fields([['recorded in', path]]);
    },
  );
}

/**
 * `agent join`, in both representations.
 *
 * @param agent - The agent that joined.
 * @param projectId - The project it joined.
 * @param project - The resolution that project came from.
 * @returns The view.
 */
export function agentJoinedView(
  agent: Agent,
  projectId: ProjectId,
  project: ResolvedProject,
): View {
  return view(
    { agent: agentJson(agent), project: projectJson(projectId, project), joined: true },
    (writer) => {
      writer.line(`${writer.style.bold(agent.name)} is in ${project.slug ?? projectId}.`);
      writer.fields([
        ['id', agent.id],
        ['project', projectId],
      ]);
    },
  );
}

/**
 * The prose the deletion prompt is wrapped in.
 *
 * Written out rather than summarised because the surprising half — that a
 * re-created agent is a different agent wearing the same address — is the half
 * a user cannot discover until it has already cost them a conversation.
 *
 * @param agent - The agent about to be deleted.
 * @returns The lines, in order, without trailing newlines.
 */
export function deletionWarning(agent: Agent): readonly string[] {
  return [
    `Delete the agent ${agent.name} (${agent.id})?`,
    '',
    'History is preserved: every message this agent sent or received keeps',
    'pointing at it and stays readable. Its sessions end and it leaves every',
    'project it is in.',
    '',
    `Deleting frees the name. Creating ${agent.name} again mints a NEW agent that`,
    'shares the address but not the identity — the old messages stay attached to',
    'this one, not to its replacement, and anything that stored this agent will',
    'not follow the name across.',
    '',
  ];
}

/**
 * Reads a yes-or-no answer from standard input.
 *
 * The default {@link Confirm}, and the one place in this package below `bin.ts`
 * that reaches for `process`. `CliEnvironment` carries the two output
 * descriptors and no input one, so there is no seam to take stdin from; adding
 * one is a change to a file this task does not own, and `project join` (T-207)
 * will want the same thing, which is the moment to do it properly.
 *
 * End of input is "no". A closed or empty stdin — `agentchat agent delete x
 * < /dev/null`, or a CI runner with no terminal — therefore cancels rather than
 * waiting for an answer that is never coming.
 *
 * @param question - The question, without the `[y/N]` suffix.
 * @param context - The command context, for the stream to ask on.
 * @returns Whether the answer was yes.
 */
export async function confirmOnStdin(question: string, context: CommandContext): Promise<boolean> {
  // `raw` rather than `info`: a prompt is not progress, and `--quiet` must not
  // suppress the one line the command is waiting on an answer to.
  context.log.raw(`${question} [y/N] `);

  const reader = createInterface({ input: process.stdin });
  const abort = (): void => {
    reader.close();
  };
  context.signal.addEventListener('abort', abort, { once: true });

  try {
    const iterator = reader[Symbol.asyncIterator]();
    const first = await iterator.next();
    const answer = first.done === true ? '' : first.value.trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    context.signal.removeEventListener('abort', abort);
    reader.close();
  }
}

/**
 * Refuses `--json` without `--yes`, before anything is asked of the server.
 *
 * The prompt is prose on stderr, which is not something a JSON consumer can
 * answer, and waiting for an answer that cannot come is worse than refusing.
 * Checked here rather than at the prompt so that the refusal costs no round
 * trips: it is a fact about the invocation, known before the name is looked up.
 *
 * @param context - The command context.
 * @param name - The agent named on the command line.
 * @throws {UsageError} Exit 2, when `--json` was given without `--yes`.
 */
function requireAnswerableConfirmation(context: CommandContext, name: string): void {
  if (context.isJson && !context.args.flag('yes')) {
    throw new UsageError('`--json` cannot answer a confirmation prompt.', {
      hint: `Pass \`--yes\` to delete ${name} without being asked.`,
    });
  }
}

/**
 * Asks for confirmation, or decides without asking.
 *
 * @param context - The command context.
 * @param overrides - Test seams.
 * @param agent - The agent about to be deleted.
 * @returns Whether to go ahead.
 */
async function confirmDeletion(
  context: CommandContext,
  overrides: AgentOverrides,
  agent: Agent,
): Promise<boolean> {
  if (context.args.flag('yes')) {
    return true;
  }

  for (const line of deletionWarning(agent)) {
    context.log.raw(line);
  }
  const confirm = overrides.confirm ?? confirmOnStdin;
  return await confirm(`Delete ${agent.name}?`, context);
}

/**
 * Forgets every stored default that pointed at a deleted agent.
 *
 * @param context - The command context.
 * @param agentId - The agent that has just been deleted.
 * @returns The projects whose default was forgotten.
 */
async function forgetDefaults(
  context: CommandContext,
  agentId: AgentId,
): Promise<readonly ProjectId[]> {
  const config = await readUserConfig(context.env.env);
  const affected = Object.entries(config.defaultAgentByProject)
    .filter(([, id]) => id === agentId)
    .map(([projectId]) => projectId)
    .filter((projectId): projectId is ProjectId => ProjectIdKind.is(projectId));

  if (affected.length === 0) {
    return [];
  }

  let next: UserConfig = config;
  for (const projectId of affected) {
    next = withoutDefaultAgent(next, projectId);
  }
  await writeUserConfig(context.env.env, next);
  return affected;
}

/**
 * `agentchat agent list`.
 *
 * @param context - The command context.
 * @param overrides - Test seams.
 * @returns A promise that resolves when the listing has been written.
 */
async function listAgents(context: CommandContext, overrides: AgentOverrides): Promise<void> {
  const client = await clientFor(context, overrides);
  const project = await optionalProject(context);
  const { items } = await client.agents.list({ signal: context.signal });

  let projectId: ProjectId | null = null;
  if (project !== null) {
    projectId = await projectIdFor(client, project, context.signal);
  }
  const defaultAgent =
    projectId === null ? null : defaultAgentFor(await readUserConfig(context.env.env), projectId);

  await context.emit(agentListView(items, project, defaultAgent));
}

/**
 * `agentchat agent create <name>`.
 *
 * The project is resolved *before* the agent is created, so the common failure
 * — running this outside a repository that has been `project init`ed — costs
 * nothing and leaves nothing behind. Creating and joining are two calls (plan
 * §3), so a join that fails after a create that succeeded is possible; it says
 * so, names the command that finishes the job, and still fails.
 *
 * @param context - The command context.
 * @param overrides - Test seams.
 * @returns A promise that resolves when the agent has been created and joined.
 */
async function createAgent(context: CommandContext, overrides: AgentOverrides): Promise<void> {
  const name = requireAgentName(
    context.args.required(0, 'an agent name', 'agent create <name> [--project <slug|id>]'),
  );
  const client = await clientFor(context, overrides);
  const project = await requireProject(context);
  const projectId = await projectIdFor(client, project, context.signal);

  const agent = await client.agents.create({ name }, { signal: context.signal });
  context.log.info(`Created ${agent.name} (${agent.id}).`);

  try {
    await client.agents.addToProject(agent.id, { projectId }, { signal: context.signal });
  } catch (error) {
    context.log.warn(
      `${agent.name} was created but could not join ${project.slug ?? projectId}. Run \`${PROGRAM} agent join ${agent.name}\` once that is fixed.`,
    );
    throw error;
  }

  await context.emit(agentCreatedView(agent, projectId, project));
}

/**
 * `agentchat agent rename <old> <new>`.
 *
 * A stored default survives a rename untouched, because it is keyed by id. That
 * is the whole reason T-205 keyed it that way, and it is why this command is
 * the safe way to fix a name that reads wrong — as against deleting and
 * re-creating, which is not.
 *
 * @param context - The command context.
 * @param overrides - Test seams.
 * @returns A promise that resolves when the rename has been written.
 */
async function renameAgent(context: CommandContext, overrides: AgentOverrides): Promise<void> {
  const usage = 'agent rename <old> <new>';
  const previousName = requireAgentName(
    context.args.required(0, 'the agent to rename', usage),
    'current name',
  );
  const name = requireAgentName(context.args.required(1, 'the new name', usage), 'new name');

  const client = await clientFor(context, overrides);
  const existing = await findOwnAgent(client, previousName, context.signal);
  const agent = await client.agents.rename(existing.id, { name }, { signal: context.signal });

  await context.emit(agentRenamedView(agent, previousName));
}

/**
 * `agentchat agent delete <name>`.
 *
 * @param context - The command context.
 * @param overrides - Test seams.
 * @returns A promise that resolves when the agent has been deleted, or when the
 *   user declined. Declining is success: nothing went wrong.
 */
async function deleteAgent(context: CommandContext, overrides: AgentOverrides): Promise<void> {
  const name = requireAgentName(
    context.args.required(0, 'the agent to delete', 'agent delete <name> [--yes]'),
  );
  requireAnswerableConfirmation(context, name);
  const client = await clientFor(context, overrides);
  const agent = await findOwnAgent(client, name, context.signal);

  if (!(await confirmDeletion(context, overrides, agent))) {
    context.log.raw(`Cancelled. ${agent.name} was not deleted.`);
    return;
  }

  await client.agents.delete(agent.id, { signal: context.signal });

  // After the deletion, never before: a cleared default plus a delete that then
  // failed would be the one outcome nobody asked for.
  let cleared: readonly ProjectId[] = [];
  try {
    cleared = await forgetDefaults(context, agent.id);
  } catch (error) {
    // The agent is gone; saying so is more useful than failing a command that
    // did what it was asked. The stale default is named so it can be fixed.
    context.log.warn(
      `${agent.name} was deleted, but your default agent could not be updated: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const projectId of cleared) {
    context.log.info(
      `${projectId} no longer has a default agent. Run \`${PROGRAM} agent use <name>\` to choose one.`,
    );
  }

  await context.emit(agentDeletedView(agent, cleared));
}

/**
 * `agentchat agent use <name>`.
 *
 * Writes the *user* configuration and never the repository one (plan §6.1, PRD
 * §15): the repository file is committed and shared, and which agent a person
 * speaks as is theirs alone. The write itself is T-205's
 * {@link withDefaultAgent} plus {@link writeUserConfig}, which merges rather
 * than overwrites, so a field a newer build wrote survives an older one.
 *
 * Membership is checked first. A default that names an agent which is not in
 * the project would be recorded happily and then rejected by every command that
 * used it, with an error about the send rather than about this choice.
 *
 * @param context - The command context.
 * @param overrides - Test seams.
 * @returns A promise that resolves when the default has been recorded.
 */
async function useAgent(context: CommandContext, overrides: AgentOverrides): Promise<void> {
  const name = requireAgentName(
    context.args.required(0, 'an agent name', 'agent use <name> [--project <slug|id>]'),
  );
  const client = await clientFor(context, overrides);
  const project = await requireProject(context);
  const projectId = await projectIdFor(client, project, context.signal);
  const agent = await findOwnAgent(client, name, context.signal);

  if (!(await isAgentInProject(client, projectId, agent.id, context.signal))) {
    throw new CliError(
      ErrorCode.AGENT_NOT_IN_PROJECT,
      `${agent.name} is not in ${project.slug ?? projectId}.`,
      { hint: `Run \`${PROGRAM} agent join ${agent.name}\` first.` },
    );
  }

  const config = await readUserConfig(context.env.env);
  const path = await writeUserConfig(
    context.env.env,
    withDefaultAgent(config, projectId, agent.id),
  );

  await context.emit(agentUsedView(agent, projectId, project, path));
}

/**
 * `agentchat agent join <name>`.
 *
 * Idempotent, because the route is: joining a project the agent is already in
 * succeeds and says the same thing, which is what a setup script re-run needs.
 *
 * @param context - The command context.
 * @param overrides - Test seams.
 * @returns A promise that resolves once the agent is in the project.
 */
async function joinProject(context: CommandContext, overrides: AgentOverrides): Promise<void> {
  const name = requireAgentName(
    context.args.required(0, 'an agent name', 'agent join <name> [--project <slug|id>]'),
  );
  const client = await clientFor(context, overrides);
  const project = await requireProject(context);
  const projectId = await projectIdFor(client, project, context.signal);
  const agent = await findOwnAgent(client, name, context.signal);

  await client.agents.addToProject(agent.id, { projectId }, { signal: context.signal });
  await context.emit(agentJoinedView(agent, projectId, project));
}

/**
 * Builds `agentchat agent list`.
 *
 * @param overrides - Test seams; empty in production.
 * @returns The command.
 */
export function createAgentListCommand(overrides: AgentOverrides = {}): Command {
  return {
    kind: 'command',
    name: 'list',
    summary: 'list the agents you own',
    usage: 'agent list [--project <slug|id>]',
    options: PROJECT_OPTIONS,
    details: [
      'Lists your own agents, never anyone else’s; soft-deleted ones never appear.',
      'When a project resolves, the agent you have chosen there with `agentchat agent use` is marked.',
    ],

    /** @inheritdoc */
    run(context: CommandContext): Promise<void> {
      return listAgents(context, overrides);
    },
  };
}

/**
 * Builds `agentchat agent create`.
 *
 * @param overrides - Test seams; empty in production.
 * @returns The command.
 */
export function createAgentCreateCommand(overrides: AgentOverrides = {}): Command {
  return {
    kind: 'command',
    name: 'create',
    summary: 'create an agent and join it to this project',
    usage: 'agent create <name> [--project <slug|id>]',
    options: PROJECT_OPTIONS,
    positionals: { min: 1 },
    details: [
      'The name must be 1 to 32 lowercase letters, digits and hyphens, and unique among your live agents.',
      'The project is resolved before anything is created, so running this outside a project costs nothing.',
    ],

    /** @inheritdoc */
    run(context: CommandContext): Promise<void> {
      return createAgent(context, overrides);
    },
  };
}

/**
 * Builds `agentchat agent rename`.
 *
 * @param overrides - Test seams; empty in production.
 * @returns The command.
 */
export function createAgentRenameCommand(overrides: AgentOverrides = {}): Command {
  return {
    kind: 'command',
    name: 'rename',
    summary: 'give one of your agents a new name',
    usage: 'agent rename <old> <new>',
    positionals: { min: 2 },
    details: [
      'The agent keeps its identity: its messages, its sessions, and any default you have set stay with it.',
    ],

    /** @inheritdoc */
    run(context: CommandContext): Promise<void> {
      return renameAgent(context, overrides);
    },
  };
}

/**
 * Builds `agentchat agent delete`.
 *
 * @param overrides - Test seams; empty in production.
 * @returns The command.
 */
export function createAgentDeleteCommand(overrides: AgentOverrides = {}): Command {
  return {
    kind: 'command',
    name: 'delete',
    summary: 'delete one of your agents, keeping its message history',
    usage: 'agent delete <name> [--yes]',
    options: CONFIRMATION_OPTIONS,
    positionals: { min: 1 },
    details: [
      'Asks for confirmation on stderr unless --yes is given; with --json it refuses instead of prompting.',
      'History is preserved. The name is freed, and re-creating it mints a new agent that shares the address but not the identity.',
      'Any default agent pointing at the deleted agent is forgotten, so no project is left with a default that cannot be used.',
    ],

    /** @inheritdoc */
    run(context: CommandContext): Promise<void> {
      return deleteAgent(context, overrides);
    },
  };
}

/**
 * Builds `agentchat agent use`.
 *
 * @param overrides - Test seams; empty in production.
 * @returns The command.
 */
export function createAgentUseCommand(overrides: AgentOverrides = {}): Command {
  return {
    kind: 'command',
    name: 'use',
    summary: 'make an agent your default in this project',
    usage: 'agent use <name> [--project <slug|id>]',
    options: PROJECT_OPTIONS,
    positionals: { min: 1 },
    details: [
      'Recorded in your own configuration, never in the repository file: the repository is shared, the choice is personal.',
      'The agent must already be in the project; `agentchat agent join` puts it there.',
    ],

    /** @inheritdoc */
    run(context: CommandContext): Promise<void> {
      return useAgent(context, overrides);
    },
  };
}

/**
 * Builds `agentchat agent join`.
 *
 * @param overrides - Test seams; empty in production.
 * @returns The command.
 */
export function createAgentJoinCommand(overrides: AgentOverrides = {}): Command {
  return {
    kind: 'command',
    name: 'join',
    summary: 'add one of your agents to a project',
    usage: 'agent join <name> [--project <slug|id>]',
    options: PROJECT_OPTIONS,
    positionals: { min: 1 },
    details: ['Joining a project the agent is already in succeeds and changes nothing.'],

    /** @inheritdoc */
    run(context: CommandContext): Promise<void> {
      return joinProject(context, overrides);
    },
  };
}

/**
 * Builds the `agent` group.
 *
 * @param overrides - Test seams; empty in production.
 * @returns The group, with its six subcommands in help order.
 */
export function createAgentCommand(overrides: AgentOverrides = {}): CommandGroup {
  return {
    kind: 'group',
    name: 'agent',
    summary: 'create, name, and choose the agents you own',
    children: [
      createAgentListCommand(overrides),
      createAgentCreateCommand(overrides),
      createAgentRenameCommand(overrides),
      createAgentDeleteCommand(overrides),
      createAgentUseCommand(overrides),
      createAgentJoinCommand(overrides),
    ],
  };
}

/** `agentchat agent …`. */
export const agentCommand: CommandGroup = createAgentCommand();
