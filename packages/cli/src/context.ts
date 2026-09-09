/**
 * Which project, and which agent — the question every command has to answer
 * before it can do anything (plan §6.1).
 *
 * ```text
 * project:  --project  →  AGENTCHAT_PROJECT  →  nearest .agentchat/config.json  →  NO_PROJECT
 * agent:    --agent    →  AGENTCHAT_AGENT    →  user config default for project →
 *                                                the only agent you have here   →  NO_AGENT
 * ```
 *
 * The order is the same shape both times, and it is the order of *how specific
 * the instruction was*: what the person typed just now beats what their shell
 * has been carrying since login, which beats what they chose once, which beats
 * what could be inferred.
 *
 * ## The failures are the feature
 *
 * Getting this wrong is the most common way a new user gets stuck, so every
 * failure here names the command that fixes it in the first sentence, before the
 * hint. "No project configured" is a true statement that leaves someone
 * searching the documentation; "run `agentchat project init <slug>` here" is the
 * same statement with the answer in it. Both codes exit 4 (`./exit.ts`), which
 * is the code a harness reads as "write a configuration and try again".
 *
 * ## Resolution does not go to the network, except where it is asked to
 *
 * Three of the four agent sources are local. The fourth — "you have exactly one
 * agent in this project, so it must be that one" — cannot be evaluated without
 * asking the server which agents the caller has here.
 *
 * Rather than make every command's context resolution secretly depend on the
 * network, the lookup is a function the *caller* passes in
 * ({@link ContextRequest.agents}). A command that is going to talk to the server
 * anyway — `send`, `listen` — supplies it and gets the shortcut. A command that
 * is not, or one running offline, omits it and gets a `NO_AGENT` naming
 * `agentchat agent use`. `agentchat status` (T-209) is the deliberate middle
 * case: it can report the resolved project without ever opening a socket.
 *
 * When the lookup is supplied but the server cannot be reached, that is not
 * reported as a transport failure. The user's problem is that no agent is
 * chosen; the failure says so, says that the shortcut could not be tried, and
 * points at the command that makes the question moot for good.
 *
 * ## What resolution does *not* do
 *
 * It never turns a slug into an id, and never checks that the project or the
 * agent exists. Both are round trips, and both belong to the command that is
 * about to make a round trip anyway — where a `NOT_FOUND` from the server is a
 * better answer than a guess made here. {@link ResolvedProject} therefore
 * carries whichever of the two the user gave, and says which.
 *
 * ## The round trip that answers it, once
 *
 * That round trip is still exactly one round trip, and it had been written out
 * privately in `commands/project.ts`, `commands/agent.ts` and
 * `commands/agents.ts` before T-036 collapsed them. {@link membershipFor} and
 * {@link projectIdFor} are the shared implementations, and they live here rather
 * than beside the client builder because what they consume is a
 * {@link ResolvedProject} — the thing this module produces, and the only thing
 * that knows whether the user named a slug or an id. Resolution itself still
 * makes no request of its own: a command calls these deliberately, once it has
 * decided it is going to talk to a server anyway.
 *
 * @module
 */

import type { AgentChatClient } from '@agentchat/client';
import { TransportError } from '@agentchat/client';
import type { ProjectMembership } from '@agentchat/protocol';
import {
  AGENT_NAME_PATTERN,
  AgentId,
  ErrorCode,
  PROJECT_SLUG_PATTERN,
  ProjectId,
} from '@agentchat/protocol';

import type { OptionSpecs } from './args.js';
import type { CommandContext } from './command.js';
import type { UserConfig } from './config.js';
import { defaultAgentFor, findRepositoryConfig, readUserConfig } from './config.js';
import { CliError, UsageError } from './errors.js';
import { PROGRAM } from './version.js';

/** The environment variable naming the project, when no flag was given. */
export const PROJECT_ENV = 'AGENTCHAT_PROJECT';

/** The environment variable naming the agent, when no flag was given. */
export const AGENT_ENV = 'AGENTCHAT_AGENT';

/**
 * The two options every context-sensitive command declares.
 *
 * ```ts
 * export const sendCommand: Command = {
 *   kind: 'command',
 *   name: 'send',
 *   options: { ...CONTEXT_OPTIONS, conversation: { … } },
 *   …
 * };
 * ```
 *
 * Declared here rather than in each command so the flag, its help line, and the
 * environment variable it falls back to are described in exactly one place. They
 * are not global options: `agentchat login` has no project, and offering
 * `--project` there would be a flag that does nothing.
 */
export const CONTEXT_OPTIONS: OptionSpecs = Object.freeze({
  project: {
    type: 'string',
    placeholder: '<slug|id>',
    description: `the project to act in (also ${PROJECT_ENV})`,
  },
  agent: {
    type: 'string',
    placeholder: '<name|id>',
    description: `the agent to act as (also ${AGENT_ENV})`,
  },
});

/** Where a resolved project came from, for `agentchat status` and `project current`. */
export type ProjectSource = 'flag' | 'environment' | 'repository';

/** Where a resolved agent came from. */
export type AgentSource = 'flag' | 'environment' | 'user-config' | 'only-agent';

/**
 * The project a command is acting in.
 *
 * Exactly one of {@link ResolvedProject.id} and {@link ResolvedProject.slug} is
 * guaranteed; both are present when the repository configuration recorded the
 * slug alongside the id. A command that needs the id and has only a slug asks
 * the server for it — see the module note.
 */
export interface ResolvedProject {
  /** The project id, or `null` when the user named the project by slug. */
  readonly id: ProjectId | null;

  /** The project slug, or `null` when only an id is known. */
  readonly slug: string | null;

  /** Which rule produced this. */
  readonly source: ProjectSource;

  /**
   * Where it came from, for a human: `--project`, `AGENTCHAT_PROJECT`, or the
   * absolute path of the configuration file.
   */
  readonly origin: string;

  /** The configuration file it came from, or `null` for the other sources. */
  readonly configPath: string | null;
}

/**
 * The agent a command is acting as.
 *
 * As with the project, one of the two identifying fields may be `null`: a
 * `--agent backend` gives a name, a user-configuration default gives an id, and
 * the single-agent shortcut gives both.
 */
export interface ResolvedAgent {
  /** The agent id, or `null` when the user named the agent by name. */
  readonly id: AgentId | null;

  /** The agent name, or `null` when only an id is known. */
  readonly name: string | null;

  /** Which rule produced this. */
  readonly source: AgentSource;

  /** Where it came from, for a human. */
  readonly origin: string;
}

/** Both halves of the answer. */
export interface ResolvedContext {
  /** The project. */
  readonly project: ResolvedProject;

  /** The agent. */
  readonly agent: ResolvedAgent;
}

/** One of the caller's agents, as the single-agent shortcut needs to see it. */
export interface AgentIdentity {
  /** The agent's id. */
  readonly id: AgentId;

  /** The agent's name, for the message when there is more than one. */
  readonly name: string;
}

/**
 * Answers "which of my agents are in this project?" for the single-agent
 * shortcut.
 *
 * Supplied by the caller, because it is a network call and this module makes
 * none of its own. The project is passed whole, since the implementation may
 * have to resolve a slug to an id before it can ask.
 *
 * @param project - The project already resolved.
 * @param options - Carries the abort signal; pass it to the client call.
 * @returns The caller's own live agents in that project.
 */
export type OwnAgentLookup = (
  project: ResolvedProject,
  options: { readonly signal?: AbortSignal | undefined },
) => Promise<readonly AgentIdentity[]>;

/** Everything resolution reads. */
export interface ContextRequest {
  /** The working directory the walk starts from. */
  readonly cwd: string;

  /** The process environment. */
  readonly env: Readonly<Record<string, string | undefined>>;

  /** The value of `--project`, if it was given. */
  readonly projectFlag?: string | undefined;

  /** The value of `--agent`, if it was given. */
  readonly agentFlag?: string | undefined;

  /**
   * The user configuration, if the caller has already read it.
   *
   * Omitted, it is read from disk. Supplied, no file is touched — which is what
   * lets a command read it once and use it for both the server URL and the
   * default agent.
   */
  readonly userConfig?: UserConfig | undefined;

  /**
   * Enables the single-agent shortcut. Omitted, the shortcut is skipped and a
   * user with one agent and no default gets `NO_AGENT`. See the module note.
   */
  readonly agents?: OwnAgentLookup | undefined;

  /** Aborted on interrupt; forwarded to {@link ContextRequest.agents}. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Builds a {@link ContextRequest} from what a command was given.
 *
 * @param context - The command's context.
 * @param extra - The optional halves a command supplies: a user configuration it
 *   has already read, and the lookup that enables the single-agent shortcut.
 * @returns The request to hand to {@link resolveContext}.
 * @throws {UsageError} If `--project` or `--agent` was given more than once.
 */
export function contextRequestFor(
  context: CommandContext,
  extra: Pick<ContextRequest, 'userConfig' | 'agents'> = {},
): ContextRequest {
  const projectFlag = context.args.value('project');
  const agentFlag = context.args.value('agent');
  return {
    cwd: context.env.cwd,
    env: context.env.env,
    ...(projectFlag === undefined ? {} : { projectFlag }),
    ...(agentFlag === undefined ? {} : { agentFlag }),
    ...(extra.userConfig === undefined ? {} : { userConfig: extra.userConfig }),
    ...(extra.agents === undefined ? {} : { agents: extra.agents }),
    signal: context.signal,
  };
}

/**
 * Resolves the project.
 *
 * @param request - What to read.
 * @returns The project, and where it came from.
 * @throws {CliError} `NO_PROJECT` (exit 4) when none of the three sources
 *   answers, or when the configuration found is unusable.
 * @throws {UsageError} (exit 2) when a flag or variable holds something that is
 *   neither a project id nor a slug.
 */
export async function resolveProject(request: ContextRequest): Promise<ResolvedProject> {
  const flag = readFlag(request.projectFlag, 'project');
  if (flag !== null) {
    return projectFromReference(flag, 'flag', '--project', '`--project`');
  }

  const fromEnv = readEnv(request.env, PROJECT_ENV);
  if (fromEnv !== null) {
    return projectFromReference(fromEnv, 'environment', PROJECT_ENV, `\`${PROJECT_ENV}\``);
  }

  const discovered = await findRepositoryConfig(request.cwd);
  if (discovered !== null) {
    return {
      id: discovered.config.projectId,
      slug: discovered.config.projectSlug,
      source: 'repository',
      origin: discovered.path,
      configPath: discovered.path,
    };
  }

  throw noProject(request.cwd);
}

/**
 * Resolves the agent, given the project it has to belong to.
 *
 * @param project - The project, already resolved.
 * @param request - What to read.
 * @returns The agent, and where it came from.
 * @throws {CliError} `NO_AGENT` (exit 4) when nothing selects an agent. The
 *   message differs by *why*: no agents here, several here, or a default that
 *   could not be looked up.
 * @throws {UsageError} (exit 2) when a flag or variable holds something that is
 *   neither an agent id nor a name.
 */
export async function resolveAgent(
  project: ResolvedProject,
  request: ContextRequest,
): Promise<ResolvedAgent> {
  const flag = readFlag(request.agentFlag, 'agent');
  if (flag !== null) {
    return agentFromReference(flag, 'flag', '--agent', '`--agent`');
  }

  const fromEnv = readEnv(request.env, AGENT_ENV);
  if (fromEnv !== null) {
    return agentFromReference(fromEnv, 'environment', AGENT_ENV, `\`${AGENT_ENV}\``);
  }

  // Only a project *id* can key the stored defaults. Someone who passed
  // `--project payments` has not told us which id that is, so the stored default
  // cannot be looked up and the shortcut below answers instead.
  if (project.id !== null) {
    const userConfig = request.userConfig ?? (await readUserConfig(request.env));
    const stored = defaultAgentFor(userConfig, project.id);
    if (stored !== null) {
      return {
        id: stored,
        name: null,
        source: 'user-config',
        origin: 'your default agent for this project',
      };
    }
  }

  return await onlyAgentIn(project, request);
}

/**
 * Resolves both halves.
 *
 * @param request - What to read.
 * @returns The project and the agent.
 * @throws {CliError} `NO_PROJECT` or `NO_AGENT`, exit 4 either way.
 */
export async function resolveContext(request: ContextRequest): Promise<ResolvedContext> {
  const project = await resolveProject(request);
  const agent = await resolveAgent(project, request);
  return { project, agent };
}

/**
 * The caller's membership of the resolved project: its id, its slug, its name,
 * and the role the caller holds in it.
 *
 * `GET /projects` is the only lookup that turns a slug into an id, and it
 * doubles as the membership check, because a project the caller is not in is
 * not in that list. It is asked even when the id is already known, since the
 * *name* is what a human heading prints and an id alone cannot supply it.
 *
 * A caller that needs only the id should ask {@link projectIdFor} instead, which
 * skips the request when resolution already produced one.
 *
 * @param client - The client to ask.
 * @param project - The project, already resolved.
 * @param signal - The interrupt signal.
 * @returns The membership row.
 * @throws {CliError} `NOT_FOUND` when the caller is in no such project. A
 *   project that does not exist and one the caller cannot see are deliberately
 *   indistinguishable (plan §3).
 */
export async function membershipFor(
  client: AgentChatClient,
  project: ResolvedProject,
  signal: AbortSignal,
): Promise<ProjectMembership> {
  const match = await findMembership(client, project, signal);
  if (match === null) {
    throw notInProject(project, `called \`${project.slug ?? project.id ?? ''}\``);
  }
  return match;
}

/**
 * The project id for a resolved project.
 *
 * Not a wrapper that throws away the rest of {@link membershipFor}'s answer: the
 * id resolution already produced is returned unasked, so a `--project prj_…`, or
 * a repository configuration that recorded the id, costs no request at all.
 * Putting one in front of every `agent join` and `project invite` would be a
 * round trip added by a refactor, which is not a refactor.
 *
 * @param client - The client to ask, when the reference is a slug.
 * @param project - The project, already resolved.
 * @param signal - The interrupt signal.
 * @returns The project's id.
 * @throws {CliError} `NOT_FOUND` when no project of the caller's carries that
 *   slug.
 */
export async function projectIdFor(
  client: AgentChatClient,
  project: ResolvedProject,
  signal: AbortSignal,
): Promise<ProjectId> {
  if (project.id !== null) {
    return project.id;
  }

  const match = await findMembership(client, project, signal);
  if (match === null) {
    throw notInProject(project, `with the slug \`${project.slug ?? ''}\``);
  }
  return match.id;
}

/**
 * The one round trip both lookups make, and the one rule for reading its
 * answer: match on the id when resolution produced one, on the slug otherwise.
 *
 * @param client - The client to ask.
 * @param project - The project, already resolved.
 * @param signal - The interrupt signal.
 * @returns The caller's membership, or `null` when they have none.
 */
async function findMembership(
  client: AgentChatClient,
  project: ResolvedProject,
  signal: AbortSignal,
): Promise<ProjectMembership | null> {
  const { items } = await client.projects.list({ signal });
  const match = items.find((membership) =>
    project.id !== null ? membership.id === project.id : membership.slug === project.slug,
  );
  return match ?? null;
}

/**
 * "You are not in a project …", for either lookup.
 *
 * The phrase is a parameter because it is the one thing the three private
 * copies did not agree on: `project` and `agent` said "with the slug
 * `payments`", `agents` said "called `payments`", and the same input reaches
 * both. Collapsing them into one sentence would change what a user reads, and
 * what a user reads is CLI surface, which a refactor is not entitled to redefine
 * on its own (protocol §7.6). So both wordings survive — but three lines apart
 * in one function, where the disagreement is visible and can be settled, rather
 * than in three files where it was neither.
 *
 * @param project - The project that could not be found.
 * @param describedAs - How the sentence names it, quoting the reference.
 * @returns The error to throw.
 */
function notInProject(project: ResolvedProject, describedAs: string): CliError {
  return new CliError(ErrorCode.NOT_FOUND, `You are not in a project ${describedAs}.`, {
    hint: `That came from ${project.origin}. \`${PROGRAM} project list\` shows the projects you are in.`,
  });
}

/**
 * The last agent rule: if the caller has exactly one agent in this project, it
 * is not ambiguous.
 *
 * @param project - The resolved project.
 * @param request - The request, which may or may not carry a lookup.
 * @returns The only agent.
 * @throws {CliError} `NO_AGENT` when there is no lookup, no agent, or more than
 *   one. Also when the lookup could not reach the server — see the module note
 *   on offline behaviour. Any other failure from the lookup (an expired login,
 *   say) is left alone: its own remedy is better than this one.
 */
async function onlyAgentIn(
  project: ResolvedProject,
  request: ContextRequest,
): Promise<ResolvedAgent> {
  const lookup = request.agents;
  if (lookup === undefined) {
    throw noAgent(project);
  }

  let agents: readonly AgentIdentity[];
  try {
    // Wrapped rather than awaited directly: the lookup is a caller-supplied
    // function type the linter cannot see through to prove is thenable. It also
    // normalises one that answers with a plain array.
    agents = await Promise.resolve(lookup(project, { signal: request.signal }));
  } catch (cause) {
    if (cause instanceof TransportError) {
      throw noAgentOffline(project, cause);
    }
    throw cause;
  }

  const only = agents[0];
  if (agents.length === 1 && only !== undefined) {
    return {
      id: only.id,
      name: only.name,
      source: 'only-agent',
      origin: `your only agent in ${projectPhrase(project)}`,
    };
  }

  throw agents.length === 0 ? noAgentsInProject(project) : tooManyAgents(project, agents);
}

/**
 * Reads a flag value, rejecting an empty one.
 *
 * An empty *variable* means "unset" (see {@link readEnv}), but an empty flag was
 * typed on purpose and is almost always a shell expansion that produced nothing
 * — `--project "$PROJECT"` with `PROJECT` unset. Silently ignoring it resolves
 * some other project and does the work there.
 *
 * @param value - The flag's value, if any.
 * @param name - The flag's name, for the error.
 * @returns The value, or `null` when the flag was absent.
 * @throws {UsageError} If the flag was given with an empty value.
 */
function readFlag(value: string | undefined, name: string): string | null {
  if (value === undefined) {
    return null;
  }
  if (value.trim() === '') {
    throw new UsageError(`\`--${name}\` was given an empty value.`, {
      hint: `Pass a ${name === 'project' ? 'project slug or id' : 'agent name or id'} after \`--${name}\`, or leave the flag out.`,
    });
  }
  return value.trim();
}

/**
 * Reads an environment variable, treating empty as unset.
 *
 * `export AGENTCHAT_PROJECT=` is how a shell clears a variable, and a harness
 * that sets one from a possibly-empty value should get the same behaviour as one
 * that did not set it at all.
 *
 * @param env - The environment.
 * @param name - The variable.
 * @returns Its trimmed value, or `null`.
 */
function readEnv(env: Readonly<Record<string, string | undefined>>, name: string): string | null {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    return null;
  }
  return value.trim();
}

/**
 * Interprets a project reference: an id, or a slug.
 *
 * @param reference - What the user supplied.
 * @param source - Which rule this came from.
 * @param origin - Where it came from, for a human.
 * @param label - How to name the source in an error.
 * @returns The resolved project.
 * @throws {UsageError} If it is neither an id nor a valid slug.
 */
function projectFromReference(
  reference: string,
  source: ProjectSource,
  origin: string,
  label: string,
): ResolvedProject {
  if (ProjectId.is(reference)) {
    return { id: reference, slug: null, source, origin, configPath: null };
  }
  if (PROJECT_SLUG_PATTERN.test(reference)) {
    return { id: null, slug: reference, source, origin, configPath: null };
  }
  throw new UsageError(
    `${label} is ${quote(reference)}, which is neither a project id (\`${ProjectId.prefix}<uuidv7>\`) nor a project slug.`,
    {
      hint: 'A slug is lower case letters, digits and hyphens, at most 32 characters. `agentchat project list` shows the projects you are in.',
    },
  );
}

/**
 * Interprets an agent reference: an id, or a name.
 *
 * A `@user/agent` handle is deliberately not accepted. `--agent` says which
 * agent *you* are acting as, and you can only act as your own; the handle form
 * belongs to `agentchat send`, where the recipient may be anybody's.
 *
 * @param reference - What the user supplied.
 * @param source - Which rule this came from.
 * @param origin - Where it came from, for a human.
 * @param label - How to name the source in an error.
 * @returns The resolved agent.
 * @throws {UsageError} If it is neither an id nor a valid name.
 */
function agentFromReference(
  reference: string,
  source: AgentSource,
  origin: string,
  label: string,
): ResolvedAgent {
  if (AgentId.is(reference)) {
    return { id: reference, name: null, source, origin };
  }
  if (AGENT_NAME_PATTERN.test(reference)) {
    return { id: null, name: reference, source, origin };
  }
  const handle = reference.startsWith('@')
    ? ' `--agent` takes one of your own agents, so it is a bare name: `--agent backend`, not `--agent @you/backend`.'
    : '';
  throw new UsageError(
    `${label} is ${quote(reference)}, which is neither an agent id (\`${AgentId.prefix}<uuidv7>\`) nor an agent name.`,
    {
      hint: `An agent name is lower case letters, digits and hyphens, at most 32 characters.${handle} \`agentchat agent list\` shows yours.`,
    },
  );
}

/**
 * Names a project the way a message should: by slug when there is one, since
 * that is what the person typed and what they will type again.
 *
 * @param project - The resolved project.
 * @returns `payments`, or `prj_018f…`.
 */
export function describeProject(project: ResolvedProject): string {
  return project.slug ?? project.id ?? 'this project';
}

/**
 * The same, as it appears inside a sentence.
 *
 * "No agent is selected for payments" reads like a missing word to anyone who
 * does not already know that `payments` is a project.
 *
 * @param project - The resolved project.
 * @returns `project payments`, or `this project` when neither half is known.
 */
function projectPhrase(project: ResolvedProject): string {
  const named = project.slug ?? project.id;
  return named === null ? 'this project' : `project ${named}`;
}

/**
 * Renders an untrusted value for a message, bounded.
 *
 * @param value - The value.
 * @returns It, quoted, truncated at 48 characters.
 */
function quote(value: string): string {
  return JSON.stringify(value.length > 48 ? `${value.slice(0, 48)}…` : value);
}

/**
 * The failure a new user is most likely to see.
 *
 * The first sentence names the command. Someone who reads no further than the
 * `error:` line still knows what to type.
 *
 * @param cwd - Where the walk started.
 * @returns The error to throw.
 */
function noProject(cwd: string): CliError {
  return new CliError(
    ErrorCode.NO_PROJECT,
    `No AgentChat project is configured for ${cwd} — run \`agentchat project init <slug>\` here to link this directory to one.`,
    {
      hint: `No \`.agentchat/config.json\` was found in that directory or any directory above it. For a single command, pass \`--project <slug>\` or set ${PROJECT_ENV}. \`agentchat project list\` shows the projects you are in, and \`agentchat setup\` walks through creating one.`,
    },
  );
}

/**
 * No agent selected, and nothing was able to infer one.
 *
 * @param project - The project the agent would be for.
 * @returns The error to throw.
 */
function noAgent(project: ResolvedProject): CliError {
  return new CliError(
    ErrorCode.NO_AGENT,
    `No agent is selected for ${projectPhrase(project)} — run \`agentchat agent use <name>\` to choose one.`,
    {
      hint: `\`agentchat agent list\` shows your agents and \`agentchat agent create <name>\` makes a new one. For a single command, pass \`--agent <name>\` or set ${AGENT_ENV}. The choice is stored in your own configuration, never in the repository, so it is yours alone.`,
    },
  );
}

/**
 * The caller has agents, but none in this project.
 *
 * A different remedy from every other `NO_AGENT`, so a different message:
 * choosing a default cannot help, and `agent use` would be the wrong advice.
 *
 * @param project - The project.
 * @returns The error to throw.
 */
function noAgentsInProject(project: ResolvedProject): CliError {
  const name = projectPhrase(project);
  return new CliError(
    ErrorCode.NO_AGENT,
    `You have no agents in ${name} — run \`agentchat agent create <name>\` to add one.`,
    {
      hint: `\`agentchat agent join <name>\` puts an agent you already have into it instead. \`agentchat agents\` lists everyone's agents there.`,
    },
  );
}

/**
 * The caller has several agents here, so the shortcut cannot choose.
 *
 * The message lists them. The reader's next command is `agentchat agent use
 * <one of these>`, and making them run `agent list` first to find out what the
 * options are is a round trip this sentence can save.
 *
 * @param project - The project.
 * @param agents - The caller's agents in it.
 * @returns The error to throw.
 */
function tooManyAgents(project: ResolvedProject, agents: readonly AgentIdentity[]): CliError {
  const names = agents.map((agent) => agent.name);
  const shown = names.length > 8 ? [...names.slice(0, 8), '…'] : names;
  const example = names[0] ?? '<name>';
  return new CliError(
    ErrorCode.NO_AGENT,
    `You have ${String(agents.length)} agents in ${projectPhrase(project)} (${shown.join(', ')}) — run \`agentchat agent use ${example}\` to choose which one this directory speaks as.`,
    {
      hint: `The choice is remembered per project, in your own configuration rather than in the repository. For a single command, pass \`--agent <name>\` or set ${AGENT_ENV}.`,
    },
  );
}

/**
 * No agent selected and the server could not be asked.
 *
 * Reported as `NO_AGENT` rather than as the transport failure it also is,
 * because "no agent is selected" is the user's actual problem and choosing one
 * fixes it permanently, including for the next time they are offline. The
 * transport error is kept as the cause and `--verbose` prints it.
 *
 * @param project - The project.
 * @param cause - The transport failure.
 * @returns The error to throw.
 */
function noAgentOffline(project: ResolvedProject, cause: TransportError): CliError {
  return new CliError(
    ErrorCode.NO_AGENT,
    `No agent is selected for ${projectPhrase(project)}, and the server could not be reached to check whether you have exactly one there — run \`agentchat agent use <name>\` to choose one.`,
    {
      cause,
      hint: `Once chosen it is stored locally, so it resolves without the network. For a single command, pass \`--agent <name>\` or set ${AGENT_ENV}. \`agentchat status\` reports whether the server is reachable.`,
    },
  );
}
