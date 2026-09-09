/**
 * `agentchat project …` — the projects this account is a member of, and which
 * one this directory belongs to (plan §6.2, PRD §27).
 *
 * Eight subcommands. Six talk to the server; `init` writes a file into the
 * working directory and `current` reads one, and neither opens a socket.
 * `revoke-invite` is one of the six and lives in `./invite.ts`, which is where
 * the reasons for its shape are written down.
 *
 * ## Two files, and only one of them is committed
 *
 * `init` writes `.agentchat/config.json`, and that file is committed. It holds
 * the project identity and nothing else — no token, no server URL, no choice of
 * agent — because everyone who clones the repository gets it. T-205 owns the
 * writer and enforces the rule from the other side: a repository configuration
 * containing anything credential-shaped is refused on read, with a message
 * saying to rotate the secret because it is already in the history.
 *
 * Which agent a person speaks as is theirs alone and lives in *user*
 * configuration, which is why `agent use` writes there and nothing here does.
 * The one exception is `leave`, and it is a deletion rather than a choice: see
 * below.
 *
 * ## Leaving takes your agents with you
 *
 * `POST /projects/:id/leave` removes the caller's membership *and* every one of
 * the caller's agents from that project, in one transaction. That is not a
 * detail of the implementation: `agent_projects` is what makes an agent
 * addressable inside a project, and leaving the rows behind would keep
 * `@alice/backend` deliverable-to in a project Alice can no longer read.
 *
 * So it is the right behaviour, and it is also more than "leave" says on the
 * tin. The confirmation therefore names the agents by name, having looked them
 * up first, rather than describing the consequence in the abstract. Somebody
 * about to lose `backend` and `code-review` from a project should be told those
 * two words before they answer, not afterwards.
 *
 * Leaving also forgets the default agent recorded for that project, for the
 * reason T-208 established for `agent delete`: a default is an identifier, and
 * one that survives its usefulness fails every later command in a way that
 * reads as a server problem rather than as a stale choice.
 *
 * ## Which stream carries what
 *
 * PRD §39, unchanged. The result goes to stdout in whichever representation was
 * asked for; the invite preview, the leaving warning, both prompts, and every
 * progress line go to stderr. Every subcommand supports `--json`.
 *
 * `--json` and a confirmation prompt cannot both happen, so the two commands
 * that prompt refuse `--json` without `--yes` — before any request is made,
 * because it is a fact about the invocation rather than about the answer. The
 * alternatives were both worse: prompting anyway asks a question on stderr that
 * a JSON consumer is not reading and then blocks forever on an answer that
 * cannot come, and proceeding silently would make `--json` mean "and also skip
 * the confirmation", which is a safety flag hiding inside a formatting one.
 * `--yes` is how a script says yes, in either mode, and it is the same flag
 * `agent delete` already uses.
 *
 * @module
 */

import { resolve as resolvePath } from 'node:path';

import type { AgentChatClient } from '@agentchat/client';
import type {
  CreateInviteResponse,
  InviteCode,
  Project,
  ProjectId,
  ProjectMembership,
} from '@agentchat/protocol';
import {
  ErrorCode,
  InviteCodeSchema,
  PROJECT_SLUG_PATTERN,
  ProjectId as ProjectIdKind,
  ProjectNameSchema,
  ProjectSlugSchema,
} from '@agentchat/protocol';

import type { OptionSpecs } from '../args.js';
import type { ClientSeams } from '../client.js';
import { clientFor } from '../client.js';
import type { Command, CommandContext, CommandGroup } from '../command.js';
import type { DiscoveredRepositoryConfig } from '../config.js';
import {
  defaultAgentFor,
  findRepositoryConfig,
  REPOSITORY_CONFIG_RELATIVE,
  readUserConfig,
  withoutDefaultAgent,
  writeRepositoryConfig,
  writeUserConfig,
} from '../config.js';
import type { ProjectSource, ResolvedProject } from '../context.js';
import { CONTEXT_OPTIONS, contextRequestFor, projectIdFor, resolveProject } from '../context.js';
import { CliError, UsageError } from '../errors.js';
import type { JsonValue, View } from '../output/output.js';
import { view } from '../output/output.js';
import { StreamSource } from '../output/streams.js';
import { PROGRAM } from '../version.js';
import { createProjectRevokeInviteCommand } from './invite.js';

/**
 * The seams these seven commands are built on.
 *
 * There is no `confirm` here, and its absence is the point. T-208 needed one
 * because the prompt read `process.stdin` and a test had no way to reach it;
 * the input descriptor added with this task is that way, so both prompts are
 * driven the way a person drives them — through the descriptor — in the
 * in-process suite as well as in the spawned one. A seam that skips the code
 * under test is not a seam worth having twice.
 *
 * The two that remain are {@link ClientSeams} rather than a restatement of it,
 * so a seam added there reaches these seven subcommands without anyone
 * remembering to copy it across.
 */
export type ProjectOverrides = ClientSeams;

/**
 * `--project`, for the subcommands that act on the project this directory is
 * in rather than on one named as an argument.
 *
 * Derived from {@link CONTEXT_OPTIONS} rather than restated, so the description
 * and the environment variable it names stay in one place. `--agent` is
 * deliberately absent: nothing here acts *as* an agent, and a flag that does
 * nothing is worse than an absent one because `--help` promises it works.
 */
const PROJECT_OPTIONS: OptionSpecs = Object.freeze(
  Object.fromEntries(Object.entries(CONTEXT_OPTIONS).filter(([name]) => name === 'project')),
);

/** `--yes`, for the two subcommands that ask a question. */
const YES_OPTION: OptionSpecs = Object.freeze({
  yes: {
    type: 'boolean',
    description: 'skip the confirmation prompt',
  },
});

/**
 * The project this invocation acts in.
 *
 * @param context - The command context.
 * @returns The resolved project.
 * @throws {CliError} `NO_PROJECT` (exit 4) when nothing names one. The message
 *   names `project init`, which is a command in this very file.
 */
async function requireProject(context: CommandContext): Promise<ResolvedProject> {
  return await resolveProject(contextRequestFor(context));
}

/**
 * The project this invocation acts in, if any does.
 *
 * Used only by `project list`, which is useful outside a project and merely
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
 * Interprets the argument to `project init`: an id, or a slug.
 *
 * The same grammar `--project` accepts, so `project init payments` and
 * `--project payments` cannot disagree about what a project reference is.
 *
 * @param value - What the user typed.
 * @returns The id, or the slug, whichever it is.
 * @throws {UsageError} Exit 2, before anything is sent, when it is neither.
 */
export function parseProjectReference(
  value: string,
): { readonly id: ProjectId } | { readonly slug: string } {
  const trimmed = value.trim();
  if (ProjectIdKind.is(trimmed)) {
    return { id: trimmed };
  }
  if (PROJECT_SLUG_PATTERN.test(trimmed)) {
    return { slug: trimmed };
  }
  throw new UsageError(
    `\`${value}\` is neither a project id (\`${ProjectIdKind.prefix}<uuidv7>\`) nor a project slug.`,
    {
      hint: `A slug is 1 to 32 lowercase letters and digits joined by single hyphens. \`${PROGRAM} project list\` shows the projects you are in.`,
    },
  );
}

/**
 * The caller's membership of one project, by id or by slug.
 *
 * `project init` needs both halves of the identity: the id, because that is
 * what the file records and what everything resolves by, and the slug, because
 * that is what makes the committed file legible to the next person reading the
 * diff. It also needs to know the caller is a member, since writing a file
 * pointing at a project they cannot read would fail on every later command
 * rather than on this one.
 *
 * Not `membershipFor` from `../context.ts`, and not a copy of it either. That
 * one answers for the project a command *resolved* — a flag, a variable, or the
 * repository file — and reads `GET /projects` because it may hold only a slug.
 * This one answers for a reference typed as an argument to `project init`,
 * which is the one place an id is worth a `GET /projects/:id`: this is the
 * command that decides what the repository file will say, and the caller has
 * asked about a project that is not yet this directory's.
 *
 * @param client - The client to ask.
 * @param reference - The id or slug the user typed.
 * @param signal - The interrupt signal.
 * @returns The project, with the caller's role in it.
 * @throws {CliError} `NOT_FOUND` when the caller is not in it, or it does not
 *   exist. The two are indistinguishable on purpose (plan §3).
 */
async function findMembership(
  client: AgentChatClient,
  reference: { readonly id: ProjectId } | { readonly slug: string },
  signal: AbortSignal,
): Promise<ProjectMembership> {
  if ('id' in reference) {
    return await client.projects.get(reference.id, { signal });
  }

  const { items } = await client.projects.list({ signal });
  const match = items.find((membership) => membership.slug === reference.slug);
  if (match !== undefined) {
    return match;
  }

  throw new CliError(
    ErrorCode.NOT_FOUND,
    `You are not in a project with the slug \`${reference.slug}\`.`,
    {
      hint:
        items.length === 0
          ? `You are in no projects. Create one with \`${PROGRAM} project create <name>\`, or join one with \`${PROGRAM} project join <code>\`.`
          : `The projects you are in are: ${items.map((membership) => membership.slug).join(', ')}.`,
    },
  );
}

/**
 * Validates a project name before it is sent.
 *
 * Both the verdict and the explanation come from the server's own schema, so
 * neither the rule nor the sentence describing it is written twice.
 *
 * @param value - What the user typed.
 * @returns The name, unchanged.
 * @throws {UsageError} Exit 2, before the round trip.
 */
export function requireProjectName(value: string): string {
  const parsed = ProjectNameSchema.safeParse(value);
  if (!parsed.success) {
    const reason = parsed.error.issues[0]?.message ?? 'It is not a usable project name.';
    throw new UsageError(`\`${value}\` is not a valid project name.`, {
      hint: `${reason} A name is free text of 1 to 100 characters, for example: Payments Platform.`,
    });
  }
  return parsed.data;
}

/**
 * Validates an explicit `--slug` before it is sent.
 *
 * @param value - What the user typed.
 * @returns The slug, unchanged.
 * @throws {UsageError} Exit 2, before the round trip.
 */
export function requireProjectSlug(value: string): string {
  const parsed = ProjectSlugSchema.safeParse(value);
  if (!parsed.success) {
    const reason = parsed.error.issues[0]?.message ?? 'It does not match the slug grammar.';
    throw new UsageError(`\`${value}\` is not a valid project slug.`, {
      hint: `${reason} For example: payments, code-review-2.`,
    });
  }
  return parsed.data;
}

/**
 * Validates an invite code before it is spliced into a URL.
 *
 * The client validates this too, and rejecting it here as well is not
 * redundant: this failure is a {@link UsageError} naming the argument, exit 2,
 * with no request made, which is the right answer to a code that was mistyped
 * or truncated by a chat client.
 *
 * @param value - What the user typed.
 * @returns The code, unchanged.
 * @throws {UsageError} Exit 2, before the round trip.
 */
export function requireInviteCode(value: string): InviteCode {
  const parsed = InviteCodeSchema.safeParse(value.trim());
  if (!parsed.success) {
    const reason = parsed.error.issues[0]?.message ?? 'It does not match the invite-code grammar.';
    throw new UsageError(`\`${value}\` is not a valid invite code.`, {
      hint: `${reason} It is the code a member sends you, for example: ANET-7K4M-Q2P9.`,
    });
  }
  return parsed.data;
}

/**
 * Refuses `--json` without `--yes`, before anything is asked of the server.
 *
 * Checked at the top of the command rather than at the prompt so that the
 * refusal costs no round trips: it is a fact about the invocation, known before
 * any lookup. See the module note for why refusing beats the alternatives.
 *
 * @param context - The command context.
 * @param what - How to name the action in the hint: `join this project`.
 * @throws {UsageError} Exit 2, when `--json` was given without `--yes`.
 */
function requireAnswerableConfirmation(context: CommandContext, what: string): void {
  if (context.isJson && !context.args.flag('yes')) {
    throw new UsageError('`--json` cannot answer a confirmation prompt.', {
      hint: `Pass \`--yes\` to ${what} without being asked.`,
    });
  }
}

/**
 * Asks the user a yes-or-no question on stderr.
 *
 * Reads through {@link CommandContext.env}'s input descriptor, which is what
 * makes both the answered and the unanswered paths testable without a
 * pseudo-terminal.
 *
 * End of input is always no, whichever way the default points. A closed or
 * empty standard input — `agentchat project join CODE < /dev/null`, or a CI
 * runner with no terminal — is nobody being there, and nobody being there
 * cannot be read as agreement even when the visible default is `Y`. That
 * distinction is the reason {@link StreamSource.readLine} answers `null` for
 * end of input and `''` for a line someone actually entered.
 *
 * @param context - The command context, for the stream to ask on and the
 *   interrupt signal to stop waiting on.
 * @param question - One line, without the `[y/N]` suffix.
 * @param fallback - What a bare Return means.
 * @returns Whether the answer was yes.
 */
async function confirm(
  context: CommandContext,
  question: string,
  fallback: boolean,
): Promise<boolean> {
  // `raw` rather than `info`: a prompt is not progress, and `--quiet` must not
  // suppress the one line the command is waiting on an answer to.
  context.log.raw(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `);

  const source = new StreamSource(context.env.stdin);
  try {
    const answer = await source.readLine(context.signal);
    if (answer === null) {
      return false;
    }
    const normalised = answer.trim().toLowerCase();
    if (normalised === '') {
      return fallback;
    }
    return normalised === 'y' || normalised === 'yes';
  } finally {
    await source.close();
  }
}

/**
 * A project, as `--json` carries it.
 *
 * @param project - The project, with or without the caller's role.
 * @returns The JSON object.
 */
function projectJson(project: Project | ProjectMembership): JsonValue {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    createdAt: project.createdAt,
    ...('role' in project ? { role: project.role } : {}),
  };
}

/**
 * Whether a listed project is the one this directory resolves to.
 *
 * By id when resolution produced one, and by slug otherwise — which is the only
 * thing `--project payments` gives us, and is why this is a comparison rather
 * than an equality test on a single field.
 *
 * @param membership - The listed project.
 * @param current - The resolved project, or `null`.
 * @returns `true` when they are the same project.
 */
function isCurrent(membership: ProjectMembership, current: ResolvedProject | null): boolean {
  if (current === null) {
    return false;
  }
  return current.id !== null ? current.id === membership.id : current.slug === membership.slug;
}

/**
 * `project list`, in both representations.
 *
 * Ids are in the JSON and not in the table. Nothing a human types takes an id —
 * `init`, `--project` and `AGENTCHAT_PROJECT` all accept the slug — and a
 * column of UUIDv7s costs the width that the names need. `project current`
 * prints the id of the one project whose id anybody usually wants.
 *
 * @param projects - The caller's memberships.
 * @param current - The project this directory resolves to, or `null`.
 * @returns The view.
 */
export function projectListView(
  projects: readonly ProjectMembership[],
  current: ResolvedProject | null,
): View {
  const json: JsonValue = {
    items: projects.map((membership) => ({
      ...(projectJson(membership) as Record<string, JsonValue>),
      isCurrent: isCurrent(membership, current),
    })),
  };

  return view(json, (writer) => {
    if (projects.length === 0) {
      writer.line(`You are in no projects.`);
      writer.line(
        `Create one with \`${PROGRAM} project create <name>\`, or join one with \`${PROGRAM} project join <code>\`.`,
      );
      return;
    }

    writer.table(
      [
        {
          header: 'SLUG',
          cell: (membership: ProjectMembership): string =>
            isCurrent(membership, current)
              ? `${writer.style.bold(membership.slug)} ${writer.style.dim('(this directory)')}`
              : membership.slug,
        },
        { header: 'NAME', cell: (membership: ProjectMembership): string => membership.name },
        { header: 'ROLE', cell: (membership: ProjectMembership): string => membership.role },
      ],
      projects,
    );

    if (current === null) {
      writer.blank();
      writer.line(
        writer.style.dim(
          `This directory is not linked to a project. Link it with \`${PROGRAM} project init <slug>\`.`,
        ),
      );
    }
  });
}

/**
 * `project create`, in both representations.
 *
 * @param project - The project that was created.
 * @returns The view.
 */
export function projectCreatedView(project: ProjectMembership): View {
  return view({ project: projectJson(project) }, (writer) => {
    writer.line(`Created ${writer.style.bold(project.name)}.`);
    writer.fields([
      ['slug', project.slug],
      ['id', project.id],
      ['your role', project.role],
    ]);
    writer.blank();
    writer.line(
      writer.style.dim(
        `Link a directory to it with \`${PROGRAM} project init ${project.slug}\`, and add an agent with \`${PROGRAM} agent create <name>\`.`,
      ),
    );
  });
}

/**
 * `project invite`, in both representations.
 *
 * The code is the result, so it goes to stdout — that is what a script running
 * this command is capturing. Everything around it is a human rendering of the
 * same fact and vanishes under `--json`.
 *
 * ## Why the identifier is printed too
 *
 * `docs/protocol.md` §6 makes the create response the *only* place an invite
 * identifier is ever disclosed: no endpoint lists invites and none turns a code
 * back into an identifier, deliberately, because a lookup keyed on a live
 * bearer credential is a lookup that discloses one. So an identifier this
 * command withholds is an identifier nobody can ever hold, and
 * `project revoke-invite` — which takes one and refuses to take a code — would
 * have no argument any user could supply.
 *
 * It is added to `json` rather than substituted into it, so a consumer written
 * against the shipped `{ code, expiresAt, project }` keeps working. The
 * identifier is not a second credential: it names a row, cannot be redeemed,
 * and every route taking one asserts project membership first.
 *
 * `id` is absent when the server is older than the revoke route — the protocol
 * schema makes it optional for exactly that pairing — and the human rendering
 * says so rather than silently offering a revoke command that cannot be run.
 *
 * @param invite - The minted invite: identifier, code, and expiry.
 * @param projectId - The project it opens.
 * @param project - The resolution that project came from.
 * @returns The view.
 */
export function projectInviteView(
  invite: CreateInviteResponse,
  projectId: ProjectId,
  project: ResolvedProject,
): View {
  const { id, code, expiresAt } = invite;
  return view(
    {
      // Additive, and first because it is the field this command was missing.
      ...(id === undefined ? {} : { id }),
      code,
      expiresAt,
      project: { id: projectId, slug: project.slug },
    },
    (writer) => {
      writer.line(`Invite code for ${writer.style.bold(project.slug ?? projectId)}:`);
      writer.blank();
      writer.line(`  ${writer.style.cyan(code)}`);
      writer.blank();
      writer.line(
        `Anyone holding this code can join the project until it expires or is revoked, so send it the way you would send a password.`,
      );
      writer.line(`It stops working at ${expiresAt}.`);
      writer.line(
        writer.style.dim(`Whoever you send it to runs \`${PROGRAM} project join ${code}\`.`),
      );
      writer.blank();
      if (id === undefined) {
        writer.line(
          'This server returned no invite identifier, so this code cannot be revoked from the command line; it stops working on its own at the time above.',
        );
        return;
      }
      writer.line(`To revoke it before then:`);
      writer.blank();
      writer.line(`  ${PROGRAM} project revoke-invite ${id}`);
      writer.blank();
      writer.line(
        writer.style.dim(
          'That identifier is disclosed here and nowhere else — nothing turns a code back into one — so keep it if you may need to revoke.',
        ),
      );
    },
  );
}

/**
 * `project join`, in both representations.
 *
 * @param project - The project just joined, with the caller's role.
 * @returns The view.
 */
export function projectJoinedView(project: ProjectMembership): View {
  return view({ project: projectJson(project), joined: true }, (writer) => {
    writer.line(`Joined ${writer.style.bold(project.name)}.`);
    writer.fields([
      ['slug', project.slug],
      ['id', project.id],
      ['your role', project.role],
    ]);
    writer.blank();
    writer.line(
      writer.style.dim(
        `Link a directory to it with \`${PROGRAM} project init ${project.slug}\`, and add an agent with \`${PROGRAM} agent create <name>\`.`,
      ),
    );
  });
}

/**
 * `project leave`, in both representations.
 *
 * `agentsRemoved` is on the wire as well as in the prose, because a harness
 * deciding whether to warn its own user should not have to parse an English
 * sentence to learn which agents stopped being addressable. It is `null`, and
 * not `[]`, when the lookup that would have populated it failed: "none" and "we
 * could not find out" are different answers, and only one of them is safe to
 * report as nothing having happened.
 *
 * @param projectId - The project that was left.
 * @param project - The resolution it came from.
 * @param agentsRemoved - The caller's agents that left with them.
 * @param clearedDefaultAgent - Whether a stored default was forgotten.
 * @returns The view.
 */
export function projectLeftView(
  projectId: ProjectId,
  project: ResolvedProject,
  agentsRemoved: readonly string[] | null,
  clearedDefaultAgent: boolean,
): View {
  const json: JsonValue = {
    left: { id: projectId, slug: project.slug },
    agentsRemoved: agentsRemoved === null ? null : [...agentsRemoved],
    clearedDefaultAgent,
  };

  return view(json, (writer) => {
    writer.line(`Left ${writer.style.bold(project.slug ?? projectId)}.`);
    if (agentsRemoved !== null && agentsRemoved.length > 0) {
      writer.line(
        `${agentsRemoved.join(', ')} ${agentsRemoved.length === 1 ? 'is' : 'are'} no longer in it. ${agentsRemoved.length === 1 ? 'It still exists' : 'They still exist'} and ${agentsRemoved.length === 1 ? 'its' : 'their'} message history is untouched.`,
      );
    }
  });
}

/**
 * `project init`, in both representations.
 *
 * @param project - The project this directory now belongs to.
 * @param path - The file that was written.
 * @param alreadyLinked - Whether the file already named this project.
 * @returns The view.
 */
export function projectInitView(
  project: ProjectMembership,
  path: string,
  alreadyLinked: boolean,
): View {
  return view({ project: projectJson(project), configPath: path, alreadyLinked }, (writer) => {
    writer.line(
      alreadyLinked
        ? `Already linked to ${writer.style.bold(project.name)}.`
        : `Linked this directory to ${writer.style.bold(project.name)}.`,
    );
    writer.fields([
      ['wrote', path],
      ['project', project.id],
    ]);
    writer.blank();
    writer.line(
      writer.style.dim(
        `Commit \`${REPOSITORY_CONFIG_RELATIVE}\`: it names the project and holds no secrets, so everyone who clones this repository resolves the same one.`,
      ),
    );
  });
}

/**
 * How a project came to be resolved, in a sentence.
 *
 * @param project - The resolved project.
 * @returns A phrase naming the rule and where it read from.
 */
export function describeProjectSource(project: ResolvedProject): string {
  const sources: Readonly<Record<ProjectSource, string>> = {
    flag: 'the `--project` flag',
    environment: 'the AGENTCHAT_PROJECT environment variable',
    repository: 'the repository configuration',
  };
  const rule = sources[project.source];
  return project.configPath === null ? rule : `${rule} at ${project.configPath}`;
}

/**
 * `project current`, in both representations.
 *
 * Answers offline, deliberately. `status` is what someone runs when things are
 * broken and T-205 made resolution reach no socket for exactly that reason;
 * `project current` is the smaller question — *which project is this directory
 * in, and who decided that* — and it would be a poor answer to a person whose
 * network is down. So the name is absent unless the repository file recorded a
 * slug, and no round trip is made to fetch one.
 *
 * @param project - The resolved project.
 * @returns The view.
 */
export function projectCurrentView(project: ResolvedProject): View {
  const json: JsonValue = {
    project: {
      id: project.id,
      slug: project.slug,
      source: project.source,
      origin: project.origin,
      configPath: project.configPath,
    },
  };

  return view(json, (writer) => {
    writer.line(writer.style.bold(project.slug ?? project.id ?? 'this project'));
    writer.fields([
      ['id', project.id],
      ['slug', project.slug],
      ['from', describeProjectSource(project)],
    ]);
  });
}

/**
 * The lines the leaving prompt is wrapped in.
 *
 * Written out rather than summarised because the consequence — that the
 * caller's agents leave with them — is not what the word "leave" says, and it
 * is not recoverable by running the command again.
 *
 * @param name - The project, as the user names it.
 * @param agents - The caller's agents in it, or `null` when the lookup failed.
 * @returns The lines, in order, without trailing newlines.
 */
export function leavingWarning(name: string, agents: readonly string[] | null): readonly string[] {
  const lines = [`Leave the project ${name}?`, ''];

  if (agents === null) {
    lines.push(
      'Leaving also removes every agent you own from this project, in the same',
      'operation. Which of your agents are in it could not be determined, so',
      'this is the general case.',
    );
  } else if (agents.length === 0) {
    lines.push('You have no agents in this project, so none will be removed.');
  } else {
    lines.push(
      `Leaving also removes ${agents.length === 1 ? 'this agent of yours' : 'these agents of yours'} from the project, in the same`,
      'operation:',
      '',
      `  ${agents.join(', ')}`,
      '',
      `${agents.length === 1 ? 'It stops being' : 'They stop being'} addressable here and ${agents.length === 1 ? 'stops' : 'stop'} receiving messages sent to`,
      `${agents.length === 1 ? 'it' : 'them'} in this project. ${agents.length === 1 ? 'The agent itself is' : 'The agents themselves are'} not deleted, ${agents.length === 1 ? 'its' : 'their'} name and`,
      `${agents.length === 1 ? 'its' : 'their'} history stay, and every other project ${agents.length === 1 ? 'it is' : 'they are'} in is untouched.`,
    );
  }

  lines.push(
    '',
    'Rejoining needs a fresh invite from a member, and your agents would have',
    'to be added again.',
    '',
  );
  return lines;
}

/**
 * The names of the caller's own agents that participate in a project.
 *
 * Two listings rather than one: `GET /projects/:id/agents` is discovery, so it
 * answers with everybody's agents, and `GET /agents` is the only listing that
 * answers for the caller specifically. An agent id is unique across owners, so
 * intersecting on it is enough and no `GET /me` is needed.
 *
 * Failure here is not failure of the command. This exists to make a warning
 * specific, and a warning that could not be made specific is still worth
 * printing in general terms — refusing to let someone leave a project because
 * discovery was slow would be the wrong trade.
 *
 * @param client - The client to ask.
 * @param projectId - The project.
 * @param signal - The interrupt signal.
 * @returns The names, sorted, or `null` when they could not be determined.
 * @throws Whatever the lookup threw, if the interrupt is what stopped it.
 */
async function ownAgentsIn(
  client: AgentChatClient,
  projectId: ProjectId,
  signal: AbortSignal,
): Promise<readonly string[] | null> {
  try {
    const [mine, here] = await Promise.all([
      client.agents.list({ signal }),
      client.projects.listAgents(projectId, { signal }),
    ]);
    const owned = new Set(mine.items.map((agent) => agent.id));
    return here.items
      .filter((row) => owned.has(row.agent.id))
      .map((row) => row.agent.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    return null;
  }
}

/**
 * `agentchat project list`.
 *
 * @param context - The command context.
 * @param overrides - Test seams.
 * @returns A promise that resolves when the listing has been written.
 */
async function listProjects(context: CommandContext, overrides: ProjectOverrides): Promise<void> {
  const client = await clientFor(context, overrides);
  const current = await optionalProject(context);
  const { items } = await client.projects.list({ signal: context.signal });

  await context.emit(projectListView(items, current));
}

/**
 * `agentchat project create <name>`.
 *
 * The slug is not derived here even though the rule is knowable: the server
 * derives it, and a client that guessed would print one thing and record
 * another the first time the two derivations drifted. An explicit `--slug`
 * that is taken is a `CONFLICT` rather than a silently suffixed near-miss,
 * because the caller may be about to commit it (D12).
 *
 * @param context - The command context.
 * @param overrides - Test seams.
 * @returns A promise that resolves when the project has been created.
 */
async function createProject(context: CommandContext, overrides: ProjectOverrides): Promise<void> {
  const usage = 'project create <name> [--slug <slug>]';
  const name = requireProjectName(context.args.required(0, 'a project name', usage));
  const slugFlag = context.args.value('slug');
  const slug = slugFlag === undefined ? undefined : requireProjectSlug(slugFlag);

  const client = await clientFor(context, overrides);
  const project = await client.projects.create(slug === undefined ? { name } : { name, slug }, {
    signal: context.signal,
  });

  await context.emit(projectCreatedView(project));
}

/**
 * `agentchat project invite`.
 *
 * No `--expires`. Plan §6.2 sketches one, but the protocol fixes expiry and use
 * limits as server policy — `CreateInviteRequestSchema` has no fields — so the
 * flag would be accepted and ignored, which is worse than absent.
 *
 * @param context - The command context.
 * @param overrides - Test seams.
 * @returns A promise that resolves when the code has been written.
 */
async function inviteToProject(
  context: CommandContext,
  overrides: ProjectOverrides,
): Promise<void> {
  const client = await clientFor(context, overrides);
  const project = await requireProject(context);
  const projectId = await projectIdFor(client, project, context.signal);

  const invite = await client.projects.createInvite(projectId, { signal: context.signal });
  await context.emit(projectInviteView(invite, projectId, project));
}

/**
 * `agentchat project join <code>`.
 *
 * The preview is the whole point of the command's shape (PRD §27). A code is an
 * opaque string that arrives over chat, and redeeming it puts the holder into a
 * project belonging to whoever minted it; being shown the project's name and
 * who invited you *before* answering is the only opportunity to notice that the
 * code is not the one you were expecting. `GET /invites/:code` exists precisely
 * so that a non-member can be told that much.
 *
 * @param context - The command context.
 * @param overrides - Test seams.
 * @returns A promise that resolves once the project has been joined, or once
 *   the user has declined. Declining is success: nothing went wrong.
 */
async function joinProject(context: CommandContext, overrides: ProjectOverrides): Promise<void> {
  const code = requireInviteCode(
    context.args.required(0, 'an invite code', 'project join <code> [--yes]'),
  );
  requireAnswerableConfirmation(context, 'join this project');

  const client = await clientFor(context, overrides);

  // Previewed only when there is somebody to show it to. `--yes` has already
  // decided, so the extra round trip would buy nothing: an unusable code fails
  // the same way one step later, with the same `INVITE_INVALID`.
  if (!context.args.flag('yes')) {
    const preview = await client.invites.preview(code, { signal: context.signal });

    context.log.raw('');
    context.log.raw(`Project: ${preview.project.name} (${preview.project.slug})`);
    context.log.raw(
      `Invited by: ${preview.invitedBy.displayName} (@${preview.invitedBy.username})`,
    );
    context.log.raw('');

    // The default is yes: somebody who typed a code they were sent has already
    // said what they want, and PRD §27 shows `[Y/n]`. End of input is still no
    // — a default is for a person choosing not to type, not for an absent one.
    if (!(await confirm(context, `Join ${preview.project.name}?`, true))) {
      context.log.raw(`Cancelled. You did not join ${preview.project.name}.`);
      return;
    }
  }

  const { project } = await client.invites.join(code, { signal: context.signal });
  await context.emit(projectJoinedView(project));
}

/**
 * `agentchat project leave`.
 *
 * @param context - The command context.
 * @param overrides - Test seams.
 * @returns A promise that resolves once the project has been left, or once the
 *   user has declined.
 */
async function leaveProject(context: CommandContext, overrides: ProjectOverrides): Promise<void> {
  requireAnswerableConfirmation(context, 'leave the project');

  const client = await clientFor(context, overrides);
  const project = await requireProject(context);
  const projectId = await projectIdFor(client, project, context.signal);

  // Looked up in both modes, not only when there is a prompt to fill: with
  // `--yes` it is what `agentsRemoved` reports, and a JSON consumer needs the
  // same fact the prompt would have shown a person.
  const agents = await ownAgentsIn(client, projectId, context.signal);

  if (!context.args.flag('yes')) {
    for (const line of leavingWarning(project.slug ?? projectId, agents)) {
      context.log.raw(line);
    }
    if (!(await confirm(context, `Leave ${project.slug ?? projectId}?`, false))) {
      context.log.raw(`Cancelled. You are still in ${project.slug ?? projectId}.`);
      return;
    }
  }

  await client.projects.leave(projectId, { signal: context.signal });

  // After the leave, never before: a cleared default plus a leave that then
  // failed would be the one outcome nobody asked for.
  const cleared = await forgetDefaultAgent(context, projectId);
  if (cleared) {
    context.log.info(
      `${project.slug ?? projectId} no longer has a default agent, because your agents are no longer in it.`,
    );
  }

  await context.emit(projectLeftView(projectId, project, agents, cleared));
}

/**
 * Forgets the default agent recorded for a project that has just been left.
 *
 * The reason is T-208's, applied to the other way of arriving at the same
 * state: the default is keyed by agent id, the agents it names are no longer in
 * the project, and every later command resolving it would fail with
 * `AGENT_NOT_IN_PROJECT` — an error about the send, not about the stale choice
 * that caused it.
 *
 * @param context - The command context.
 * @param projectId - The project that was left.
 * @returns Whether a default was forgotten.
 */
async function forgetDefaultAgent(context: CommandContext, projectId: ProjectId): Promise<boolean> {
  try {
    const config = await readUserConfig(context.env.env);
    if (defaultAgentFor(config, projectId) === null) {
      return false;
    }
    await writeUserConfig(context.env.env, withoutDefaultAgent(config, projectId));
    return true;
  } catch (error) {
    // The membership is gone; saying so is more useful than failing a command
    // that did what it was asked.
    context.log.warn(
      `You left the project, but your default agent for it could not be updated: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/**
 * The repository configuration at or above the working directory, if it is
 * readable.
 *
 * `findRepositoryConfig` refuses a file it cannot parse, which is right for
 * every other caller and wrong for this one: `init` is the command that
 * *replaces* that file, and the error telling a user to delete it by hand is a
 * poor answer from the command that would have written a good one. So the
 * refusal is caught and turned into "there is something there", which `--force`
 * then overwrites.
 *
 * @param cwd - The working directory.
 * @returns The configuration, `null` when there is none, or the failure that
 *   reading it produced.
 */
async function existingConfig(cwd: string): Promise<DiscoveredRepositoryConfig | CliError | null> {
  try {
    return await findRepositoryConfig(cwd);
  } catch (error) {
    if (error instanceof CliError && error.code === ErrorCode.NO_PROJECT) {
      return error;
    }
    throw error;
  }
}

/**
 * `agentchat project init <slug|id>`.
 *
 * Writes the one file in this system that is committed. Everything about the
 * command follows from that: the project is confirmed to exist and to be one
 * the caller is in *before* anything is written, both halves of the identity
 * are recorded so the diff is legible, and a file already naming a different
 * project is not silently replaced.
 *
 * @param context - The command context.
 * @param overrides - Test seams.
 * @returns A promise that resolves once the file has been written.
 */
async function initProject(context: CommandContext, overrides: ProjectOverrides): Promise<void> {
  const reference = parseProjectReference(
    context.args.required(0, 'a project slug or id', 'project init <slug|id> [--force]'),
  );
  const cwd = resolvePath(context.env.cwd);
  const force = context.args.flag('force');
  const existing = await existingConfig(cwd);

  if (existing instanceof CliError && !force) {
    throw new UsageError(
      `There is already an AgentChat configuration at or above ${cwd}, and it could not be read.`,
      {
        cause: existing,
        hint: `${existing.message} Pass \`--force\` to replace it with a new \`${REPOSITORY_CONFIG_RELATIVE}\` in this directory.`,
      },
    );
  }

  const here = existing instanceof CliError || existing === null ? null : existing;
  const inThisDirectory = here !== null && here.directory === cwd;

  const client = await clientFor(context, overrides);
  const project = await findMembership(client, reference, context.signal);

  if (inThisDirectory && here.config.projectId !== project.id && !force) {
    throw new UsageError(
      `${here.path} already links this directory to ${here.config.projectSlug ?? here.config.projectId}.`,
      {
        hint: `Pass \`--force\` to point it at ${project.slug} instead. Everyone who clones this repository resolves whichever project the committed file names, so repointing it moves them all.`,
      },
    );
  }

  if (here !== null && !inThisDirectory) {
    // Not an error: a subdirectory belonging to a different project is a real
    // arrangement. It is worth saying out loud, because the file about to be
    // written silently wins over one the user may not remember is there.
    context.log.warn(
      `${here.path} already covers this directory. The file written here takes precedence for ${cwd} and everything below it.`,
    );
  }

  const alreadyLinked = inThisDirectory && here.config.projectId === project.id;
  const path = await writeRepositoryConfig(cwd, {
    projectId: project.id,
    projectSlug: project.slug,
  });

  await context.emit(projectInitView(project, path, alreadyLinked));
}

/**
 * `agentchat project current`.
 *
 * @param context - The command context.
 * @returns A promise that resolves when the answer has been written.
 */
async function currentProject(context: CommandContext): Promise<void> {
  const project = await requireProject(context);
  await context.emit(projectCurrentView(project));
}

/**
 * Builds `agentchat project list`.
 *
 * @param overrides - Test seams; empty in production.
 * @returns The command.
 */
export function createProjectListCommand(overrides: ProjectOverrides = {}): Command {
  return {
    kind: 'command',
    name: 'list',
    summary: 'list the projects you are in',
    usage: 'project list [--project <slug|id>]',
    options: PROJECT_OPTIONS,
    details: [
      'Membership is the filter: a project you have left is absent rather than listed without a role.',
      'The project this directory resolves to is marked. Ids are in `--json`; nothing you type takes one.',
    ],

    /** @inheritdoc */
    run(context: CommandContext): Promise<void> {
      return listProjects(context, overrides);
    },
  };
}

/**
 * Builds `agentchat project create`.
 *
 * @param overrides - Test seams; empty in production.
 * @returns The command.
 */
export function createProjectCreateCommand(overrides: ProjectOverrides = {}): Command {
  return {
    kind: 'command',
    name: 'create',
    summary: 'create a project you own',
    usage: 'project create <name> [--slug <slug>]',
    options: Object.freeze({
      slug: {
        type: 'string',
        placeholder: '<slug>',
        description: 'the handle to use, instead of one derived from the name',
      },
    }),
    positionals: { min: 1 },
    details: [
      'The name is free text; the slug is the handle people type and repositories commit.',
      'A slug already in use fails rather than being suffixed, because you may be about to commit it.',
      'Creating a project does not link this directory to it. `agentchat project init <slug>` does that.',
    ],

    /** @inheritdoc */
    run(context: CommandContext): Promise<void> {
      return createProject(context, overrides);
    },
  };
}

/**
 * Builds `agentchat project invite`.
 *
 * @param overrides - Test seams; empty in production.
 * @returns The command.
 */
export function createProjectInviteCommand(overrides: ProjectOverrides = {}): Command {
  return {
    kind: 'command',
    name: 'invite',
    summary: 'mint an invite code for this project',
    usage: 'project invite [--project <slug|id>]',
    options: PROJECT_OPTIONS,
    details: [
      'Any member may invite, not only an owner.',
      'The code goes to stdout and expires; expiry and use limits are the server’s policy, not a flag.',
      'Anyone holding the code can join until it expires or is revoked, so send it the way you would send a password.',
      `The invite’s identifier is printed with it and disclosed nowhere else; \`${PROGRAM} project revoke-invite\` needs it.`,
    ],

    /** @inheritdoc */
    run(context: CommandContext): Promise<void> {
      return inviteToProject(context, overrides);
    },
  };
}

/**
 * Builds `agentchat project join`.
 *
 * @param overrides - Test seams; empty in production.
 * @returns The command.
 */
export function createProjectJoinCommand(overrides: ProjectOverrides = {}): Command {
  return {
    kind: 'command',
    name: 'join',
    summary: 'redeem an invite code, after showing what it opens',
    usage: 'project join <code> [--yes]',
    options: YES_OPTION,
    positionals: { min: 1 },
    details: [
      'Shows the project’s name and who invited you on stderr, then asks, unless --yes is given.',
      'With --json it refuses to prompt: pass --yes, which is how a script answers in either mode.',
      'Joining a project you are already in succeeds and changes nothing.',
    ],

    /** @inheritdoc */
    run(context: CommandContext): Promise<void> {
      return joinProject(context, overrides);
    },
  };
}

/**
 * Builds `agentchat project leave`.
 *
 * @param overrides - Test seams; empty in production.
 * @returns The command.
 */
export function createProjectLeaveCommand(overrides: ProjectOverrides = {}): Command {
  return {
    kind: 'command',
    name: 'leave',
    summary: 'leave a project, removing your agents from it too',
    usage: 'project leave [--project <slug|id>] [--yes]',
    options: Object.freeze({ ...PROJECT_OPTIONS, ...YES_OPTION }),
    details: [
      'Leaving also removes every agent you own from the project, in the same operation; the confirmation names them.',
      'The agents are not deleted: their names, their history and their other projects are untouched.',
      'The last owner of a project cannot leave until another member is made an owner.',
      'With --json it refuses to prompt: pass --yes.',
    ],

    /** @inheritdoc */
    run(context: CommandContext): Promise<void> {
      return leaveProject(context, overrides);
    },
  };
}

/**
 * Builds `agentchat project init`.
 *
 * @param overrides - Test seams; empty in production.
 * @returns The command.
 */
export function createProjectInitCommand(overrides: ProjectOverrides = {}): Command {
  return {
    kind: 'command',
    name: 'init',
    summary: 'link this directory to a project',
    usage: 'project init <slug|id> [--force]',
    options: Object.freeze({
      force: {
        type: 'boolean',
        description: 'replace a configuration that names a different project',
      },
    }),
    positionals: { min: 1 },
    details: [
      `Writes \`${REPOSITORY_CONFIG_RELATIVE}\` in the working directory, holding the project id and slug and nothing else.`,
      'Commit it. It is how everyone who clones the repository resolves the same project, and it holds no secrets.',
      'Your credentials and your default agent stay in your own configuration and are never written here.',
      'A file already naming a different project is not replaced without --force.',
    ],

    /** @inheritdoc */
    run(context: CommandContext): Promise<void> {
      return initProject(context, overrides);
    },
  };
}

/**
 * Builds `agentchat project current`.
 *
 * @returns The command.
 */
export function createProjectCurrentCommand(): Command {
  return {
    kind: 'command',
    name: 'current',
    summary: 'show the project this directory resolves to, and why',
    usage: 'project current [--project <slug|id>]',
    options: PROJECT_OPTIONS,
    details: [
      'Reports which rule answered: the --project flag, the AGENTCHAT_PROJECT variable, or the nearest repository configuration.',
      'Reaches no network, so it answers when the server does not.',
    ],

    /** @inheritdoc */
    run(context: CommandContext): Promise<void> {
      return currentProject(context);
    },
  };
}

/**
 * Builds the `project` group.
 *
 * @param overrides - Test seams; empty in production.
 * @returns The group, with its eight subcommands in help order.
 */
export function createProjectCommand(overrides: ProjectOverrides = {}): CommandGroup {
  return {
    kind: 'group',
    name: 'project',
    summary: 'create, join, and link the projects you are in',
    children: [
      createProjectListCommand(overrides),
      createProjectCreateCommand(overrides),
      createProjectInviteCommand(overrides),
      // Directly after the command that mints one, and the only place the
      // identifier it takes is ever printed. Implemented in `./invite.ts`; see
      // that module for why it is a sibling leaf rather than
      // `project invite revoke`.
      createProjectRevokeInviteCommand(overrides),
      createProjectJoinCommand(overrides),
      createProjectLeaveCommand(overrides),
      createProjectInitCommand(overrides),
      createProjectCurrentCommand(),
    ],
  };
}

/** `agentchat project …`. */
export const projectCommand: CommandGroup = createProjectCommand();
