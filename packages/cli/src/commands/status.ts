/**
 * `agentchat status` — the command you run when nothing else works (plan §6.2).
 *
 * Every other command answers a question. This one answers *why the answer was
 * not what you expected*, so it is a diagnostic rather than a status line: each
 * line either confirms something or names the command that fixes it.
 *
 * ```text
 * agentchat 0.1.0 (protocol 1)
 *
 * server    https://chat.example.com  from AGENTCHAT_SERVER
 *           reachable — server 0.1.0, protocol 1
 * login     @alice (Alice Liddell)  from ~/.config/agentchat/credentials.json
 *           access token expires 2026-09-08T12:34:56Z (in 41m)
 * project   payments  prj_018f…  from /work/repo/.agentchat/config.json
 * agent     backend  from your default agent for this project
 * sessions  1 active
 *           ses_018f…  active  alice-laptop  claude-code
 *             /work/repo
 *             started 2026-09-08T11:52:03Z, last seen 2026-09-08T12:34:41Z
 *
 * No problems found.
 * ```
 *
 * ## Five checks, in the order things break
 *
 * `server`, `login`, `project`, `agent`, `sessions` — causes above effects. You
 * cannot log in without a server, cannot resolve an agent without knowing which
 * project, and cannot have a session without all four. So the topmost `→` line
 * is the root cause, and fixing it is often the only thing that has to be
 * fixed. Ordering them by *how often each one is wrong* would scatter a single
 * cause across the report and put its symptoms above it.
 *
 * ## It never refuses to run
 *
 * A diagnostic that fails when the system is broken is useless exactly when it
 * is needed, so every failure this command *reports on* is caught and rendered
 * as a line rather than thrown: no project, no agent, logged out, a server that
 * cannot be reached, a `AGENTCHAT_PROJECT` holding something that is not a
 * project reference, an unreadable user configuration. See
 * {@link statusCommand} for the exit-code decision that follows from this.
 *
 * ## It works offline
 *
 * T-205 made context resolution open no socket of its own, precisely so this
 * command could resolve fully offline; the single-agent shortcut is a lookup a
 * caller supplies, and this command supplies one only once it knows there is a
 * reachable server and a login to make it with. With no server configured
 * nothing here touches the network, and the project, the credential file, and
 * the local half of agent resolution are still reported.
 *
 * ## It never prints a token
 *
 * This is the one command that reads the credential file in order to talk about
 * it, so the rule is worth stating: the report says that a token exists, where
 * it is stored, and when it expires. Never a prefix, never a length, never a
 * fingerprint. The expiry is read from the access token's own unverified `exp`
 * claim when it has one, and reported as unknown when it does not — the
 * protocol calls these tokens opaque, so this is a best-effort convenience and
 * never a check anything depends on.
 *
 * ## The `--json` shape
 *
 * One object, and it is a contract: keys are added but never removed or
 * repurposed. `null` means "not known"; a boolean is only ever `true` or
 * `false` when the thing was actually determined.
 *
 * ```jsonc
 * {
 *   "ok": false,                       // true when `problems` is empty
 *   "cli":      { "version": "0.1.0", "protocolVersion": 1 },
 *   "server":   { "url", "source", "origin", "reachable", "version",
 *                 "protocolVersion", "minClientVersion" },
 *   "login":    { "loggedIn", "credentialsPath", "hasStoredToken", "verified",
 *                 "accessTokenExpiresAt", "accessTokenExpired", "user" },
 *   "project":  { "resolved", "id", "slug", "source", "origin", "configPath",
 *                 "role" },
 *   "agent":    { "resolved", "id", "name", "source", "origin" },
 *   "sessions": { "checked", "count", "online",
 *                 "items": [ { "id", "status", "machineName", "runtime",
 *                              "workingDirectory", "startedAt", "lastSeenAt" } ] },
 *   "problems": [ { "area", "code", "message", "hint" } ]
 * }
 * ```
 *
 * `sessions.count` is the number of **active** sessions, which is presence.
 * `sessions.items` is every session the server listed, stale ones included, so
 * a harness can tell "nothing is running" from "something is running and has
 * stopped answering". An `items` of `null` means the listing could not be made
 * at all, which is a third thing again.
 *
 * `source` is the machine-readable rule that produced a value — `flag`,
 * `environment`, `repository`, `user-config`, `only-agent` — and `origin` is
 * the same fact for a human: `--project`, `AGENTCHAT_PROJECT`, or the absolute
 * path of the file it was read from. Knowing *where* a value came from is
 * usually what unsticks someone, which is why both are in the contract.
 *
 * `problems` is the field a harness branches on. Each entry names the area, a
 * stable error code from `@agentchat/protocol`, and the next step.
 *
 * @module
 */

import type { CredentialStore } from '@agentchat/client';
import {
  AgentChatClient,
  ApiError,
  normaliseBaseUrl,
  ResponseFormatError,
  TransportError,
} from '@agentchat/client';
import type {
  GetVersionResponse,
  ProjectAgent,
  ProjectId,
  ProjectRole,
  User,
  WireErrorCode,
} from '@agentchat/protocol';
import { ErrorCode, PROTOCOL_VERSION, ProtocolError } from '@agentchat/protocol';

import type { Command, CommandContext } from '../command.js';
import type { ServerSource, UserConfig } from '../config.js';
import {
  EMPTY_USER_CONFIG,
  noServerConfiguredText,
  readUserConfig,
  resolveServer,
  serverRequestFor,
} from '../config.js';
import type { AgentIdentity, ContextRequest, ResolvedAgent, ResolvedProject } from '../context.js';
import { CONTEXT_OPTIONS, contextRequestFor, resolveAgent, resolveProject } from '../context.js';
import { createCredentialStore, credentialsPath } from '../credentials.js';
import { describeFailure } from '../errors.js';
import type { JsonValue, View } from '../output/output.js';
import { view } from '../output/output.js';
import type { HumanWriter } from '../output/writer.js';
import { CLI_VERSION, PROGRAM } from '../version.js';

/** Which check a problem belongs to. Also the order the report is rendered in. */
export type StatusArea = 'server' | 'login' | 'project' | 'agent' | 'sessions';

/** One thing that is wrong, and what to do about it. */
export interface StatusProblem {
  /** The check that found it. */
  readonly area: StatusArea;

  /**
   * A stable code from the frozen set, exactly as it arrived where a server
   * supplied it. Branch on this rather than on {@link StatusProblem.message}.
   */
  readonly code: WireErrorCode;

  /** What is wrong, in a sentence. */
  readonly message: string;

  /** The next step, naming a command where one exists. */
  readonly hint: string | null;
}

/**
 * Where the server URL came from.
 *
 * Defined by `../config.ts`, which owns the resolution order, and re-exported
 * here because this command's report is where it reaches a person. A copy of the
 * union would have to be widened by hand every time a source is added, and the
 * build would not say so — it would just start rendering `null`.
 */
export type { ServerSource };

/** The server this CLI would talk to, and whether it answers. */
export interface ServerStatus {
  /** The configured URL, normalised, or `null` when none is configured. */
  readonly url: string | null;

  /** Which rule produced it. */
  readonly source: ServerSource | null;

  /** Where it came from, for a human: `--server`, a variable, or a file path. */
  readonly origin: string | null;

  /**
   * Whether `GET /version` answered. `null` when no request was made at all —
   * no URL configured, or one that is not a usable HTTP URL.
   */
  readonly reachable: boolean | null;

  /** The server's release version, when it answered. */
  readonly version: string | null;

  /** The protocol version it speaks, when it answered. */
  readonly protocolVersion: number | null;

  /** The oldest client it will serve, when it answered. */
  readonly minClientVersion: string | null;
}

/** Who this machine is signed in as, and whether the server still agrees. */
export interface LoginStatus {
  /**
   * Whether this CLI can act as somebody. `true` only when a token is stored
   * *and* nothing has proved it dead; a server that could not be reached leaves
   * a stored token believed-good and {@link LoginStatus.verified} `false`.
   */
  readonly loggedIn: boolean;

  /** The absolute path of the credentials file, whether or not it exists. */
  readonly credentialsPath: string;

  /** Whether a usable token pair is on disk. Never says anything about its value. */
  readonly hasStoredToken: boolean;

  /** Whether the token was actually presented to the server this run. */
  readonly verified: boolean;

  /**
   * When the access token expires, from its own unverified `exp` claim, or
   * `null` when the token carries no readable expiry. See the module note.
   */
  readonly accessTokenExpiresAt: string | null;

  /** Whether that expiry has passed. `null` when it is unknown. */
  readonly accessTokenExpired: boolean | null;

  /** The account, when `GET /me` answered. */
  readonly user: {
    readonly id: string;
    readonly username: string;
    readonly displayName: string;
  } | null;
}

/** The resolved project, and where the resolution came from. */
export interface ProjectStatus {
  /** Whether a project was resolved at all. */
  readonly resolved: boolean;

  /** Its id, when known. A slug-only resolution has none until the server names it. */
  readonly id: string | null;

  /** Its slug, when known. */
  readonly slug: string | null;

  /** Which rule produced it: `flag`, `environment`, or `repository`. */
  readonly source: string | null;

  /** Where it came from, for a human. */
  readonly origin: string | null;

  /** The repository configuration it was read from, when that is the source. */
  readonly configPath: string | null;

  /** The caller's role in it, when the server was asked and answered. */
  readonly role: ProjectRole | null;
}

/** The resolved agent, and where the resolution came from. */
export interface AgentStatus {
  /** Whether an agent was resolved at all. */
  readonly resolved: boolean;

  /** Its id, when known. */
  readonly id: string | null;

  /** Its name, when known. */
  readonly name: string | null;

  /** Which rule produced it: `flag`, `environment`, `user-config`, `only-agent`. */
  readonly source: string | null;

  /** Where it came from, for a human. */
  readonly origin: string | null;
}

/**
 * One of the resolved agent's listeners, as the report talks about it.
 *
 * A subset of the wire's {@link SessionSummary}: `agentId` and `projectId` are
 * dropped because the report has already named both above this line, and
 * repeating them in every row would be the JSON equivalent of shouting.
 */
export interface SessionDetail {
  /** `ses_` identifier. `listen` prints this on stderr, so the two match up. */
  readonly id: string;

  /** `active`, `stale`, or `ended`. Only `active` is present. */
  readonly status: string;

  /** The machine it runs on. */
  readonly machineName: string;

  /** The harness that opened it, or `null` for a row this CLI did not write. */
  readonly runtime: string | null;

  /** The directory `listen` was started in. */
  readonly workingDirectory: string;

  /** When it registered. */
  readonly startedAt: string;

  /** Its last heartbeat. How far in the past is what says it is wedged. */
  readonly lastSeenAt: string;
}

/** The resolved agent's live sessions in the resolved project. */
export interface SessionsStatus {
  /** Whether the server was actually asked. Everything else is `null` when not. */
  readonly checked: boolean;

  /** How many *active* sessions the resolved agent has here. */
  readonly count: number | null;

  /** Whether it has at least one — presence, as plan §2 defines it. */
  readonly online: boolean | null;

  /**
   * Every session the endpoint listed, `stale` ones included, newest first.
   *
   * `null` when the listing could not be made, which is not the same as `[]`.
   * A stale session is deliberately in here and deliberately not in
   * {@link SessionsStatus.count}: it is registered and it will not answer, and
   * that is the exact state somebody with a wedged listener is trying to see.
   */
  readonly items: readonly SessionDetail[] | null;
}

/** Everything one `agentchat status` determined. */
export interface StatusReport {
  /** Whether every check passed. Equivalent to `problems.length === 0`. */
  readonly ok: boolean;

  /** This build, for the bug report. */
  readonly cli: { readonly version: string; readonly protocolVersion: number };

  /** The server check. */
  readonly server: ServerStatus;

  /** The credential check. */
  readonly login: LoginStatus;

  /** The project check. */
  readonly project: ProjectStatus;

  /** The agent check. */
  readonly agent: AgentStatus;

  /** The session check. */
  readonly sessions: SessionsStatus;

  /** Everything that is wrong, in the order the checks ran. */
  readonly problems: readonly StatusProblem[];
}

/** Widest label in the human rendering (`sessions`), for the hanging indent. */
const LABEL_WIDTH = 8;

/** How the human rendering marks a line that says what to run. */
const ARROW = '→';

/**
 * The one session status that counts as present (plan §2).
 *
 * Named rather than inlined because it is a rule, not a string: `stale` is a
 * session the server still holds a row for and will not deliver to, and every
 * place this report decides whether somebody is reachable has to agree about
 * that.
 */
const SESSION_ACTIVE = 'active';

/**
 * `agentchat status`.
 *
 * ## Why it exits 0 even when it finds problems
 *
 * The exit-code contract (`../exit.ts`) reserves 3 for "authentication
 * required" and 4 for "no project or agent context", and every other command
 * that cannot resolve a login or a context exits with them. This one does not,
 * and the reason is what the codes are *for*: they tell a harness that **the
 * command it asked for did not happen** and name the automatable remedy. Here
 * the command that was asked for is the report, and the report happened. A
 * diagnostic that exits 4 because it successfully diagnosed a missing project
 * has confused its subject with itself.
 *
 * It also has a practical cost that is easy to underestimate: `agentchat
 * status` is the natural thing to put at the top of a setup script or a harness
 * preflight, and under `set -e` — or any wrapper that treats non-zero as fatal
 * — a status command that exits 4 aborts the script *before* anybody reads the
 * explanation it just printed. The one command whose entire output is the
 * explanation must not be the one that gets swallowed.
 *
 * So the machine-readable signal is in the payload rather than in the exit
 * code, and it is strictly richer: `ok` is the boolean, and `problems[]` says
 * *which* thing is wrong, with a stable `code` and the command that fixes it.
 * A caller that wants a gate writes
 * `agentchat status --json | jq -e .ok >/dev/null`.
 *
 * What is *not* suppressed is a failure of the report itself. An invocation the
 * framework rejects before any check has run — an unknown flag, an option whose
 * value is missing — is still a usage error and still exits 2, because there is
 * no report to be made from it. Everything a check raises while running is a line in that
 * check instead, including an `AGENTCHAT_PROJECT` or a `--project` holding
 * something that is not a project reference: a bad value in ambient
 * configuration is one of the commonest reasons somebody runs this at all, and
 * the report is where they will look for it.
 */
export const statusCommand: Command = {
  kind: 'command',
  name: 'status',
  summary: 'diagnose the resolved context, credentials, server, and sessions',
  usage: 'status [--project <slug|id>] [--agent <name|id>] [--json]',
  options: CONTEXT_OPTIONS,
  details: [
    'Run this first when something is not working. Each line either confirms something or names the command that fixes it; the lines marked with an arrow are the ones to act on, topmost first.',
    'The checks are ordered so that causes come above effects: a server that cannot be reached explains a login that cannot be verified, which explains sessions that cannot be listed.',
    'With no server configured this makes no network call at all, and still reports the project, the agent, and the credential file. A server that cannot be reached is reported as unreachable rather than failing the command.',
    'It always exits 0 when it produced a report, including when the report is entirely bad news, so that a preflight script can read the result instead of aborting on it. Branch on `ok` and `problems` in --json output.',
    'It never prints a token. It reports that one is stored and when it expires.',
  ],

  /** @inheritdoc */
  async run(context: CommandContext): Promise<void> {
    await context.emit(statusView(await collectStatus(context)));
  },
};

/**
 * Runs every check.
 *
 * The order is the order of the report, and it is also a dependency order: each
 * step may use what the ones above it learned, and degrades to a local answer
 * when they failed. Nothing here throws for anything it is checking: see
 * {@link statusCommand}.
 *
 * @param context - The command's context.
 * @returns Everything that could be determined.
 */
async function collectStatus(context: CommandContext): Promise<StatusReport> {
  const problems: StatusProblem[] = [];
  const userConfig = await readUserConfigSafely(context, problems);

  const store = createCredentialStore({
    path: credentialsFileFor(context.env.env),
    warn: (message) => {
      context.log.warn(message);
    },
  });
  const { status: server, client } = await checkServer(context, userConfig, store, problems);
  const login = await checkLogin(context, store, server, client, problems);

  const request = contextRequestFor(context, { userConfig });
  const project = await checkProject(context, request, problems);

  // Only now can the project's id be filled in from the server, and only with a
  // login: `GET /projects` is authenticated. This is also the membership check,
  // which is why it earns its own problem when the project is not in the list.
  const identified =
    login.loggedIn && client !== null && project.resolved
      ? await identifyProject(context, client, project, problems)
      : { project, projectId: idOf(project) };

  const own =
    identified.projectId === null || !login.loggedIn || client === null
      ? null
      : await listProjectAgents(context, client, identified.projectId, problems);

  const resolved = await checkAgent(request, project, login, own, problems);
  const row = matchAgentRow(resolved, own);
  const agent = nameAgent(resolved, row);
  const sessions = await checkSessions(client, identified.projectId, agent, own, row, problems);

  return {
    ok: problems.length === 0,
    cli: { version: CLI_VERSION, protocolVersion: PROTOCOL_VERSION },
    server,
    login,
    project: identified.project,
    agent,
    sessions,
    problems,
  };
}

/**
 * Reads the user configuration, reporting a broken one instead of failing.
 *
 * `readUserConfig` throws `INTERNAL` for a file that exists and cannot be
 * parsed, which is correct for every other command and wrong for this one: a
 * corrupt `config.json` is a thing to diagnose, and it is one of the reasons
 * somebody runs this command.
 *
 * @param context - The command's context.
 * @param problems - Collected problems, appended to.
 * @returns The configuration, or an empty one when it could not be read.
 */
async function readUserConfigSafely(
  context: CommandContext,
  problems: StatusProblem[],
): Promise<UserConfig> {
  try {
    return await readUserConfig(context.env.env);
  } catch (error) {
    problems.push(problemFrom('login', error));
    return EMPTY_USER_CONFIG;
  }
}

/** The server check's two products: what to report, and what to talk to. */
interface ServerCheck {
  /** What to report. */
  readonly status: ServerStatus;

  /**
   * A client for the server, or `null` when there is nothing to talk to.
   *
   * Non-null only when a URL was configured, was a usable HTTP URL, and
   * answered `GET /version` — which is exactly the condition under which any
   * later call could succeed. Building it here rather than in the caller is
   * what keeps a malformed `AGENTCHAT_SERVER` a reported problem: the client
   * constructor rejects one, and this is the only place that catches it.
   */
  readonly client: AgentChatClient | null;
}

/**
 * Works out which server this CLI would talk to, and asks it for its version.
 *
 * @param context - The command's context.
 * @param userConfig - The user configuration, for its `serverUrl`.
 * @param store - The credential store the returned client authenticates from.
 * @param problems - Collected problems, appended to.
 * @returns What is configured, what answered, and a client if there is one.
 */
async function checkServer(
  context: CommandContext,
  userConfig: UserConfig,
  store: CredentialStore,
  problems: StatusProblem[],
): Promise<ServerCheck> {
  const configured = await resolveServer(serverRequestFor(context, { userConfig }));
  const unasked: ServerStatus = {
    ...configured,
    reachable: null,
    version: null,
    protocolVersion: null,
    minClientVersion: null,
  };

  if (configured.url === null) {
    // The message and hint come from the resolver so that this report and the
    // failure `login` raises say the same thing about the same situation. They
    // used to be written out separately here, and named different remedies.
    problems.push({
      // The frozen set has no "nothing is configured" code, and inventing one
      // is not this task's to do. `BAD_REQUEST` is the closest true statement:
      // the configuration this CLI was given is incomplete.
      area: 'server',
      code: ErrorCode.BAD_REQUEST,
      ...noServerConfiguredText(context.env.env),
    });
    return { status: unasked, client: null };
  }

  let client: AgentChatClient;
  let normalised: string;
  try {
    normalised = normaliseBaseUrl(configured.url);
    client = buildClient(normalised, store);
  } catch (error) {
    // A URL that is not an absolute `http:` or `https:` one. Reported rather
    // than raised: it is exactly the kind of thing somebody runs this command
    // to discover, and the raw value is left in the report so they can see the
    // typo they made.
    problems.push(problemFrom('server', error));
    return { status: unasked, client: null };
  }

  const settled = { ...configured, url: normalised };
  context.log.info(`Asking ${normalised} for its version…`);

  let answer: GetVersionResponse;
  try {
    // Unauthenticated on purpose (plan §12.4): reachability has to be
    // answerable before a login exists to be rejected. `GET /version` is
    // declared `auth: 'none'`, so this touches no credential.
    answer = await client.version.get({ signal: context.signal });
  } catch (error) {
    const reachable = !(error instanceof TransportError);
    problems.push(problemFrom('server', error));
    return {
      status: {
        ...settled,
        reachable,
        version: null,
        protocolVersion: null,
        minClientVersion: null,
      },
      // Something answered, but not with a version. Whatever is there is not a
      // server this build can hold a conversation with, so nothing else asks it
      // anything and every later check reports itself as unchecked.
      client: null,
    };
  }

  if (answer.protocolVersion !== PROTOCOL_VERSION) {
    problems.push({
      area: 'server',
      code: ErrorCode.UPGRADE_REQUIRED,
      message: `The server speaks protocol ${String(answer.protocolVersion)} and this ${PROGRAM} speaks ${String(PROTOCOL_VERSION)}.`,
      hint: `The server will serve clients from ${answer.minClientVersion}; this build is ${CLI_VERSION}. Update \`${PROGRAM}\`, or point it at a server on the same protocol.`,
    });
  }

  return {
    status: {
      ...settled,
      reachable: true,
      version: answer.version,
      protocolVersion: answer.protocolVersion,
      minClientVersion: answer.minClientVersion,
    },
    client,
  };
}

/**
 * Reads the credential file and, when there is a server to ask, checks that the
 * token is still accepted.
 *
 * A token the server *definitively* rejects is removed by the client itself —
 * `TokenManager` clears the store when a refresh comes back `AUTH_REQUIRED`,
 * because keeping a credential the server has already revoked only guarantees
 * the next command fails the same way. That is worth knowing here because it
 * makes this command the rare read-only one with a side effect, and the side
 * effect is the correct one: it is what turns "logged in, but nothing works"
 * into "logged out", which is a state `agentchat login` can fix.
 *
 * @param context - The command's context.
 * @param store - The credential store to read.
 * @param server - What the server check found.
 * @param client - A client pointed at the server, or `null` when there is none.
 * @param problems - Collected problems, appended to.
 * @returns The login state. Never contains a token.
 */
async function checkLogin(
  context: CommandContext,
  store: CredentialStore,
  server: ServerStatus,
  client: AgentChatClient | null,
  problems: StatusProblem[],
): Promise<LoginStatus> {
  const path = credentialsFileFor(context.env.env);
  const empty: LoginStatus = {
    loggedIn: false,
    credentialsPath: path,
    hasStoredToken: false,
    verified: false,
    accessTokenExpiresAt: null,
    accessTokenExpired: null,
    user: null,
  };

  let stored: Awaited<ReturnType<CredentialStore['load']>>;
  try {
    stored = await store.load();
  } catch (error) {
    problems.push(problemFrom('login', error));
    return empty;
  }

  if (stored === null) {
    problems.push({
      area: 'login',
      code: ErrorCode.AUTH_REQUIRED,
      message: `No credentials are stored in ${path}.`,
      hint: `Run \`${PROGRAM} login\` to sign in.`,
    });
    return empty;
  }

  const expiry = accessTokenExpiry(stored.accessToken);
  const held: LoginStatus = {
    ...empty,
    loggedIn: true,
    hasStoredToken: true,
    accessTokenExpiresAt: expiry === null ? null : expiry.toISOString(),
    accessTokenExpired: expiry === null ? null : expiry.getTime() <= Date.now(),
  };

  if (client === null || server.reachable !== true) {
    // Believed good, unproven. Not a problem in its own right: the server check
    // above has already reported whatever stopped us asking, and repeating it
    // here would make one fault look like two.
    return held;
  }

  context.log.info('Checking the stored credentials…');
  try {
    return {
      ...held,
      verified: true,
      user: summarise(await client.auth.me({ signal: context.signal })),
    };
  } catch (error) {
    if (error instanceof ProtocolError && error.code === ErrorCode.AUTH_REQUIRED) {
      problems.push({
        area: 'login',
        code: error instanceof ApiError ? error.wireCode : error.code,
        message: `The server no longer accepts the credentials in ${path}.`,
        hint: `Run \`${PROGRAM} login\` to sign in again.`,
      });
      return { ...held, loggedIn: false, verified: true };
    }
    problems.push(problemFrom('login', error));
    return held;
  }
}

/**
 * The parts of an account this report shows.
 *
 * `email` is deliberately dropped: it is on `GET /me` because the account owner
 * may see it, not because a diagnostic anyone might paste into an issue should
 * print it.
 *
 * @param user - The account the server described.
 * @returns Id, username, and display name.
 */
function summarise(user: User): { id: string; username: string; displayName: string } {
  return { id: user.id, username: user.username, displayName: user.displayName };
}

/**
 * Resolves the project, reporting a failure rather than raising it.
 *
 * @param context - The command's context.
 * @param request - The resolution request.
 * @param problems - Collected problems, appended to.
 * @returns What was resolved, or an unresolved status.
 */
async function checkProject(
  context: CommandContext,
  request: ContextRequest,
  problems: StatusProblem[],
): Promise<ProjectStatus> {
  try {
    return fromResolvedProject(await resolveProject(request));
  } catch (error) {
    problems.push(problemFrom('project', error, context.env.cwd));
    return {
      resolved: false,
      id: null,
      slug: null,
      source: null,
      origin: null,
      configPath: null,
      role: null,
    };
  }
}

/**
 * Turns a resolution into the reported shape.
 *
 * @param project - What resolution produced.
 * @returns The project status, with `role` not yet known.
 */
function fromResolvedProject(project: ResolvedProject): ProjectStatus {
  return {
    resolved: true,
    id: project.id,
    slug: project.slug,
    source: project.source,
    origin: project.origin,
    configPath: project.configPath,
    role: null,
  };
}

/** A project status and the id the later calls need, if there is one. */
interface IdentifiedProject {
  /** The status, with whichever of id, slug, and role the server supplied. */
  readonly project: ProjectStatus;

  /** The id, for the calls that require one. */
  readonly projectId: ProjectId | null;
}

/**
 * Fills in the half of the project identity the local configuration did not
 * have, and checks that the caller is actually a member.
 *
 * A repository configuration names a project by id and may or may not carry the
 * slug; `--project payments` gives a slug and no id. Both are legitimate, and
 * both leave a hole — the id is what `GET /projects/:id/agents` needs, and the
 * slug is what a human recognises. `GET /projects` closes it, and answers a
 * question worth asking on its own: a project reference that resolves perfectly
 * well locally but names a project this account is not in is a common and
 * otherwise baffling way for everything to fail with `NOT_FOUND`.
 *
 * @param context - The command's context.
 * @param client - A client for the configured server.
 * @param project - What resolution produced.
 * @param problems - Collected problems, appended to.
 * @returns The project as far as it can now be described.
 */
async function identifyProject(
  context: CommandContext,
  client: AgentChatClient,
  project: ProjectStatus,
  problems: StatusProblem[],
): Promise<IdentifiedProject> {
  let memberships: Awaited<ReturnType<AgentChatClient['projects']['list']>>;
  try {
    memberships = await client.projects.list({ signal: context.signal });
  } catch (error) {
    problems.push(problemFrom('project', error));
    return { project, projectId: idOf(project) };
  }

  const match = memberships.items.find(
    (item) => item.id === project.id || (project.id === null && item.slug === project.slug),
  );
  if (match === undefined) {
    problems.push({
      area: 'project',
      code: ErrorCode.NOT_FOUND,
      message: `You are not a member of a project called ${project.slug ?? project.id ?? 'that'}, so every project-scoped command will fail.`,
      hint: `\`${PROGRAM} project list\` shows the projects you are in. Check ${project.origin ?? 'the project you passed'}, or ask a member for an invite.`,
    });
    return { project, projectId: idOf(project) };
  }

  return {
    project: { ...project, id: match.id, slug: match.slug, role: match.role },
    projectId: match.id,
  };
}

/**
 * The typed project id, when one is known.
 *
 * @param project - The project status.
 * @returns The id, or `null`.
 */
function idOf(project: ProjectStatus): ProjectId | null {
  return project.id === null ? null : (project.id as ProjectId);
}

/**
 * Lists every agent in the project, for both the single-agent shortcut and the
 * session count.
 *
 * One request serves both, which is why it happens here rather than inside the
 * lookup that agent resolution is handed: the rows are needed again afterwards
 * whether or not the shortcut ended up using them.
 *
 * @param context - The command's context.
 * @param client - A client for the configured server.
 * @param projectId - The project to ask about.
 * @param problems - Collected problems, appended to.
 * @returns The rows, or `null` when the call failed.
 */
async function listProjectAgents(
  context: CommandContext,
  client: AgentChatClient,
  projectId: ProjectId,
  problems: StatusProblem[],
): Promise<readonly ProjectAgent[] | null> {
  try {
    const answer = await client.projects.listAgents(projectId, { signal: context.signal });
    return answer.items;
  } catch (error) {
    problems.push(problemFrom('agent', error));
    return null;
  }
}

/**
 * Resolves the agent, reporting a failure rather than raising it.
 *
 * The single-agent shortcut is enabled only when the rows to evaluate it are
 * already in hand, which keeps the promise T-205 made: resolution here opens no
 * socket that the report has not already accounted for.
 *
 * @param request - The resolution request.
 * @param project - What the project check found.
 * @param login - What the login check found, for whose agents to keep.
 * @param own - Every agent in the project, or `null` when they are not known.
 * @param problems - Collected problems, appended to.
 * @returns What was resolved, or an unresolved status.
 */
async function checkAgent(
  request: ContextRequest,
  project: ProjectStatus,
  login: LoginStatus,
  own: readonly ProjectAgent[] | null,
  problems: StatusProblem[],
): Promise<AgentStatus> {
  const unresolved: AgentStatus = {
    resolved: false,
    id: null,
    name: null,
    source: null,
    origin: null,
  };

  if (!project.resolved) {
    // Agent resolution takes a project, and every message it could produce
    // would name one it does not have. The project's own problem is the one to
    // read, and a second line repeating it would only compete with it.
    problems.push({
      area: 'agent',
      code: ErrorCode.NO_AGENT,
      message: 'No agent could be resolved, because no project was.',
      hint: 'Fix the project first; the agent is chosen per project.',
    });
    return unresolved;
  }

  const mine = ownAgentsOf(own, login);
  const resolution: ContextRequest = {
    ...request,
    ...(mine === null ? {} : { agents: () => Promise.resolve(mine) }),
  };

  try {
    const resolved = await resolveAgent(asResolvedProject(project), resolution);
    return fromResolvedAgent(resolved);
  } catch (error) {
    problems.push(problemFrom('agent', error));
    return unresolved;
  }
}

/**
 * The caller's own agents among a project's agents.
 *
 * `GET /projects/:id/agents` is discovery: it answers with everybody's. The
 * shortcut is "you have exactly one agent *here*", so anyone else's rows must
 * go — and without a verified account there is no way to tell which are which,
 * so the shortcut is skipped rather than guessed at.
 *
 * @param rows - Every agent in the project, or `null`.
 * @param login - The login state, for the account id.
 * @returns The caller's own agents, or `null` when they cannot be identified.
 */
function ownAgentsOf(
  rows: readonly ProjectAgent[] | null,
  login: LoginStatus,
): readonly AgentIdentity[] | null {
  const me = login.user;
  if (rows === null || me === null) {
    return null;
  }
  return rows
    .filter((row) => row.owner.id === me.id)
    .map((row) => ({ id: row.agent.id, name: row.agent.name }));
}

/**
 * Turns a resolution into the reported shape.
 *
 * @param agent - What resolution produced.
 * @returns The agent status.
 */
function fromResolvedAgent(agent: ResolvedAgent): AgentStatus {
  return {
    resolved: true,
    id: agent.id,
    name: agent.name,
    source: agent.source,
    origin: agent.origin,
  };
}

/**
 * The reported project, back in the shape resolution expects.
 *
 * @param project - The project status, which must be resolved.
 * @returns The equivalent {@link ResolvedProject}.
 */
function asResolvedProject(project: ProjectStatus): ResolvedProject {
  return {
    id: idOf(project),
    slug: project.slug,
    // Only ever read back out for a message; the four sources are the same
    // strings this status carried in from resolution.
    source: (project.source ?? 'repository') as ResolvedProject['source'],
    origin: project.origin ?? '',
    configPath: project.configPath,
  };
}

/**
 * Finds the resolved agent among the project's agents.
 *
 * Resolution produces an id *or* a name depending on which rule answered — a
 * stored default is an id, a `--agent` is usually a name — so both are matched.
 *
 * @param agent - What the agent check found.
 * @param rows - Every agent in the project, or `null`.
 * @returns The row, or `null` when there are no rows or none match.
 */
function matchAgentRow(
  agent: AgentStatus,
  rows: readonly ProjectAgent[] | null,
): ProjectAgent | null {
  if (rows === null || !agent.resolved) {
    return null;
  }
  return (
    rows.find(
      (candidate) =>
        (agent.id !== null && candidate.agent.id === agent.id) ||
        (agent.id === null && candidate.agent.name === agent.name),
    ) ?? null
  );
}

/**
 * Fills in whichever of the agent's name and id the resolution did not carry.
 *
 * A default agent is stored by id (`../config.ts` keys it that way so a rename
 * cannot orphan the choice), which means the honest report of a perfectly
 * healthy setup would otherwise be a bare `agt_018f…`. The server has just told
 * us what that id is called; saying so costs nothing and is the difference
 * between a line a person recognises and one they have to go and look up.
 *
 * @param agent - What the agent check found.
 * @param row - The matching discovery row, if there is one.
 * @returns The agent, named where it can be.
 */
function nameAgent(agent: AgentStatus, row: ProjectAgent | null): AgentStatus {
  if (row === null) {
    return agent;
  }
  return { ...agent, id: agent.id ?? row.agent.id, name: agent.name ?? row.agent.name };
}

/**
 * Lists the resolved agent's listeners in the resolved project.
 *
 * ## Why this asks the server a second time
 *
 * The discovery row already carries `online` and an exact `sessions` count —
 * plan §2 defines presence as "at least one active session in this project", so
 * they are the same fact — and this command used to read them from a request it
 * was already making. That was correct and it was not enough. The failure this
 * product will be debugged for most often is an agent that is registered and not
 * receiving, and a count cannot describe it: one healthy listener and one wedged
 * listener are both "1". `GET /sessions` says which machine, which runtime,
 * which directory, how old, and the identifier `listen` printed on stderr, which
 * is what lets somebody match a row to the terminal it belongs to.
 *
 * The count stays in the report anyway, because a harness branches on it and the
 * `--json` shape is a contract. It is now derived from the listing — `active`
 * rows only, so it still means presence and a stale session does not inflate it.
 *
 * ## The listing can fail, and this still reports
 *
 * Everything above it succeeded, so a failure here is narrow: an older server
 * without the endpoint, or one that broke while answering. Either way the
 * discovery row is still in hand, so the count and `online` fall back to it and
 * the report says the detail is what could not be fetched. A diagnostic that
 * threw at this point would be useless exactly where it is needed.
 *
 * @param client - A client for the server, or `null` when there is none.
 * @param projectId - The resolved project, or `null`.
 * @param agent - What the agent check found.
 * @param rows - Every agent in the project, or `null`.
 * @param row - The resolved agent's row, or `null` when it has none.
 * @param problems - Collected problems, appended to.
 * @returns The sessions, or an unchecked status.
 */
async function checkSessions(
  client: AgentChatClient | null,
  projectId: ProjectId | null,
  agent: AgentStatus,
  rows: readonly ProjectAgent[] | null,
  row: ProjectAgent | null,
  problems: StatusProblem[],
): Promise<SessionsStatus> {
  const unchecked: SessionsStatus = { checked: false, count: null, online: null, items: null };
  if (rows === null || !agent.resolved) {
    return unchecked;
  }

  if (row === null) {
    // The rows were fetched and the agent is not among them. That is not a
    // resolution failure — the name or id is perfectly good — it is the agent
    // not being a participant here, which fails every send and every listen
    // with `AGENT_NOT_IN_PROJECT` and is otherwise very hard to guess at.
    problems.push({
      area: 'sessions',
      code: ErrorCode.AGENT_NOT_IN_PROJECT,
      message: `The resolved agent ${agent.name ?? agent.id ?? ''} is not in this project, so it can neither send nor receive here.`,
      hint: `Run \`${PROGRAM} agent join ${agent.name ?? '<name>'}\` to add it, or \`${PROGRAM} agent use <name>\` to pick one that is already here.`,
    });
    return unchecked;
  }

  const derived: SessionsStatus = {
    checked: true,
    count: row.sessions,
    online: row.online,
    items: null,
  };
  if (client === null || projectId === null) {
    return derived;
  }

  try {
    // Filtered to this agent in this project, because that is what the rest of
    // the report is about. A listener of the same agent somewhere else is not a
    // reason this project's messages are not arriving.
    const listed = await client.sessions.list({ projectId, agentId: row.agent.id });
    const items = listed.map(
      (session): SessionDetail => ({
        id: session.id,
        status: session.status,
        machineName: session.machineName,
        runtime: session.runtime,
        workingDirectory: session.workingDirectory,
        startedAt: session.startedAt,
        lastSeenAt: session.lastSeenAt,
      }),
    );
    const active = items.filter((session) => session.status === SESSION_ACTIVE);

    return { checked: true, count: active.length, online: active.length > 0, items };
  } catch (error) {
    problems.push(problemFrom('sessions', error));
    return derived;
  }
}

/**
 * A client for one server, sharing this process's credential store.
 *
 * @param baseUrl - Where the server is.
 * @param credentials - The store to authenticate from.
 * @returns The client.
 */
function buildClient(baseUrl: string, credentials: CredentialStore): AgentChatClient {
  // Always passed, as `version` does: omitting it sends no `X-AgentChat-Client`
  // header, which would take this process out of the negotiation in plan §12.4
  // and make the reachability check answer for a client that is not this one.
  return new AgentChatClient({ baseUrl, credentials, clientVersion: CLI_VERSION });
}

/**
 * The credentials file, resolved against the environment this command was
 * given rather than the process's own.
 *
 * `credentialsPath` takes the home directory as a second parameter and defaults
 * it to `os.homedir()`, while `config.ts` reads `HOME` out of the environment.
 * For the real binary the two agree, because `homedir()` consults `HOME`; for
 * anything running the CLI in-process against a supplied environment they do
 * not, and this command would read the developer's own credentials while
 * claiming to read the fixture's. T-024 is filed to make that one
 * implementation; until it lands, this passes the home explicitly.
 *
 * @param env - The environment this invocation was given.
 * @returns The absolute path of the credentials file.
 */
function credentialsFileFor(env: Readonly<Record<string, string | undefined>>): string {
  const home = env['HOME'] ?? env['USERPROFILE'];
  return home === undefined ? credentialsPath(env) : credentialsPath(env, home);
}

/**
 * Reads the expiry out of an access token without verifying it.
 *
 * The token is a credential this process holds and is about to send anyway, so
 * looking at its own claim costs nothing and answers the question a user
 * actually has — "is my login stale?" — without a round trip. It is a
 * convenience and never a check: the server verifies the signature, and a token
 * shaped like anything else simply reports no expiry.
 *
 * Nothing derived from the token is ever returned to the caller except this
 * timestamp.
 *
 * @param token - The stored access token.
 * @returns When it expires, or `null` if it does not say.
 */
function accessTokenExpiry(token: string): Date | null {
  const segments = token.split('.');
  if (segments.length !== 3) {
    return null;
  }
  const payload = segments[1];
  if (payload === undefined || payload === '') {
    return null;
  }

  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null) {
      return null;
    }
    const exp = (decoded as { exp?: unknown }).exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) {
      return null;
    }
    return new Date(exp * 1000);
  } catch {
    // Not JSON, not base64url, not our business. The token is still sent; only
    // the convenience is unavailable.
    return null;
  }
}

/**
 * Describes any thrown value as a problem in one area.
 *
 * Reuses `describeFailure`, so a failure reported here carries the same code
 * and the same next step it would have carried had the command let it out —
 * which is what makes the report a faithful preview of what the other commands
 * are about to do.
 *
 * @param area - The check that caught it.
 * @param error - Whatever was thrown.
 * @param cwd - The working directory, appended to a `NO_PROJECT` message that
 *   would otherwise not say where the search started.
 * @returns The problem to record.
 */
function problemFrom(area: StatusArea, error: unknown, cwd?: string): StatusProblem {
  const failure = describeFailure(error);
  const where =
    cwd !== undefined && !(error instanceof ProtocolError) ? ` (while looking in ${cwd})` : '';
  return {
    area,
    code: failure.code,
    message: `${transportPrefix(error)}${failure.message}${where}`,
    hint: failure.hint,
  };
}

/**
 * Names the two failure classes whose code does not describe them.
 *
 * Both carry `INTERNAL` until T-017 gives transport failures a code of their
 * own, and "an internal error occurred" is not what a reader needs to see when
 * the truth is that the server did not answer.
 *
 * @param error - The thrown value.
 * @returns A prefix for the message, or an empty string.
 */
function transportPrefix(error: unknown): string {
  if (error instanceof TransportError) {
    return 'The server could not be reached: ';
  }
  if (error instanceof ResponseFormatError) {
    return 'The server answered something this build cannot read: ';
  }
  return '';
}

/**
 * The report, in both representations.
 *
 * @param report - What the checks found.
 * @returns The view `emit` writes.
 */
export function statusView(report: StatusReport): View {
  return view(toJson(report), (writer) => {
    render(report, writer);
  });
}

/**
 * The `--json` document.
 *
 * Spelled out field by field rather than spread from {@link StatusReport}, so
 * that adding a field to the internal shape is a deliberate act rather than an
 * accidental addition to a published contract.
 *
 * @param report - What the checks found.
 * @returns The JSON value.
 */
function toJson(report: StatusReport): JsonValue {
  return {
    ok: report.ok,
    cli: { version: report.cli.version, protocolVersion: report.cli.protocolVersion },
    server: {
      url: report.server.url,
      source: report.server.source,
      origin: report.server.origin,
      reachable: report.server.reachable,
      version: report.server.version,
      protocolVersion: report.server.protocolVersion,
      minClientVersion: report.server.minClientVersion,
    },
    login: {
      loggedIn: report.login.loggedIn,
      credentialsPath: report.login.credentialsPath,
      hasStoredToken: report.login.hasStoredToken,
      verified: report.login.verified,
      accessTokenExpiresAt: report.login.accessTokenExpiresAt,
      accessTokenExpired: report.login.accessTokenExpired,
      user: report.login.user === null ? null : { ...report.login.user },
    },
    project: {
      resolved: report.project.resolved,
      id: report.project.id,
      slug: report.project.slug,
      source: report.project.source,
      origin: report.project.origin,
      configPath: report.project.configPath,
      role: report.project.role,
    },
    agent: {
      resolved: report.agent.resolved,
      id: report.agent.id,
      name: report.agent.name,
      source: report.agent.source,
      origin: report.agent.origin,
    },
    sessions: {
      checked: report.sessions.checked,
      count: report.sessions.count,
      online: report.sessions.online,
      // `null` when the listing could not be made, which a harness must be able
      // to tell from "no listeners are running".
      items:
        report.sessions.items === null
          ? null
          : report.sessions.items.map((session) => ({
              id: session.id,
              status: session.status,
              machineName: session.machineName,
              runtime: session.runtime,
              workingDirectory: session.workingDirectory,
              startedAt: session.startedAt,
              lastSeenAt: session.lastSeenAt,
            })),
    },
    problems: report.problems.map((problem) => ({
      area: problem.area,
      code: problem.code,
      message: problem.message,
      hint: problem.hint,
    })),
  };
}

/**
 * The human rendering: one labelled line per check, its detail indented under
 * it, and the next step marked so it can be found by eye.
 *
 * @param report - What the checks found.
 * @param writer - The accumulating writer.
 */
function render(report: StatusReport, writer: HumanWriter): void {
  const style = writer.style;
  writer.line(
    `${style.bold(`${PROGRAM} ${report.cli.version}`)} ${style.dim(`(protocol ${String(report.cli.protocolVersion)})`)}`,
  );
  writer.blank();

  renderServer(report, writer);
  renderLogin(report, writer);
  renderProject(report, writer);
  renderAgent(report, writer);
  renderSessions(report, writer);

  writer.blank();
  if (report.problems.length === 0) {
    writer.line(style.green('No problems found.'));
    return;
  }
  const count = report.problems.length;
  writer.line(
    style.yellow(
      `${String(count)} problem${count === 1 ? '' : 's'} found. The ${ARROW} lines say what to run; start at the top.`,
    ),
  );
}

/**
 * Appends one check's headline.
 *
 * @param writer - The accumulating writer.
 * @param label - The check's name.
 * @param value - The headline value, already styled.
 */
function headline(writer: HumanWriter, label: string, value: string): void {
  writer.line(`${writer.style.dim(label.padEnd(LABEL_WIDTH))}  ${value}`);
}

/**
 * Appends a detail line under the previous headline.
 *
 * @param writer - The accumulating writer.
 * @param text - The detail, already styled.
 */
function detail(writer: HumanWriter, text: string): void {
  writer.line(`${' '.repeat(LABEL_WIDTH)}  ${text}`);
}

/**
 * Appends every problem one check found: what is wrong, then what to do.
 *
 * The arrow goes on the *message* rather than on the hint, because the messages
 * this CLI raises put the command in their first sentence on purpose
 * (`../context.ts`) — so the marked line is already actionable, and the hint
 * below it is the elaboration for a reader who needs one. The pairing is the
 * same one the error renderer uses for a failure that was actually thrown
 * (`../output/failure.ts`), which is what makes this report a preview of what
 * the other commands are about to say.
 *
 * @param report - What the checks found.
 * @param writer - The accumulating writer.
 * @param area - The check whose problems to print.
 */
function renderHints(report: StatusReport, writer: HumanWriter, area: StatusArea): void {
  for (const problem of report.problems) {
    if (problem.area !== area) {
      continue;
    }
    detail(writer, writer.style.yellow(`${ARROW} ${problem.message}`));
    if (problem.hint !== null) {
      detail(writer, `  ${writer.style.dim(problem.hint)}`);
    }
  }
}

/**
 * Renders the server check.
 *
 * @param report - What the checks found.
 * @param writer - The accumulating writer.
 */
function renderServer(report: StatusReport, writer: HumanWriter): void {
  const { server } = report;
  const style = writer.style;

  if (server.url === null) {
    headline(writer, 'server', style.yellow('not configured'));
  } else {
    headline(
      writer,
      'server',
      `${style.cyan(server.url)}  ${style.dim(`from ${server.origin ?? 'configuration'}`)}`,
    );
    if (server.reachable === true) {
      detail(
        writer,
        `${style.green('reachable')} ${style.dim(`— server ${server.version ?? 'unknown'}, protocol ${server.protocolVersion === null ? 'unknown' : String(server.protocolVersion)}`)}`,
      );
    } else if (server.reachable === false) {
      detail(writer, style.red('unreachable'));
    }
  }
  renderHints(report, writer, 'server');
}

/**
 * Renders the login check.
 *
 * @param report - What the checks found.
 * @param writer - The accumulating writer.
 */
function renderLogin(report: StatusReport, writer: HumanWriter): void {
  const { login } = report;
  const style = writer.style;

  if (login.user !== null) {
    headline(
      writer,
      'login',
      `${style.cyan(`@${login.user.username}`)} ${style.dim(`(${login.user.displayName})`)}`,
    );
  } else if (login.hasStoredToken) {
    headline(
      writer,
      'login',
      login.loggedIn
        ? `${style.yellow('token stored, not verified')} ${style.dim('— the server could not be asked')}`
        : style.red('the stored credentials were rejected'),
    );
  } else {
    headline(writer, 'login', style.yellow('not signed in'));
  }

  if (login.hasStoredToken) {
    detail(writer, style.dim(`credentials in ${login.credentialsPath}`));
    detail(writer, style.dim(`access token ${expiryPhrase(login)}`));
  }
  renderHints(report, writer, 'login');
}

/**
 * How to say when the access token expires.
 *
 * Never says anything about the token itself; see the module note.
 *
 * @param login - The login state.
 * @returns A phrase completing "access token …".
 */
function expiryPhrase(login: LoginStatus): string {
  if (login.accessTokenExpiresAt === null) {
    return 'expiry unknown (the token carries none this build can read)';
  }
  const at = login.accessTokenExpiresAt;
  return login.accessTokenExpired === true
    ? `expired at ${at}; it is refreshed automatically on the next command`
    : `expires at ${at}`;
}

/**
 * Renders the project check.
 *
 * @param report - What the checks found.
 * @param writer - The accumulating writer.
 */
function renderProject(report: StatusReport, writer: HumanWriter): void {
  const { project } = report;
  const style = writer.style;

  if (!project.resolved) {
    headline(writer, 'project', style.yellow('not resolved'));
  } else {
    const named = project.slug ?? project.id ?? 'unknown';
    const also = project.slug !== null && project.id !== null ? `  ${style.dim(project.id)}` : '';
    headline(writer, 'project', `${style.cyan(named)}${also}`);
    detail(writer, style.dim(`from ${project.origin ?? 'configuration'}`));
    if (project.role !== null) {
      detail(writer, style.dim(`you are ${project.role === 'owner' ? 'its owner' : 'a member'}`));
    }
  }
  renderHints(report, writer, 'project');
}

/**
 * Renders the agent check.
 *
 * @param report - What the checks found.
 * @param writer - The accumulating writer.
 */
function renderAgent(report: StatusReport, writer: HumanWriter): void {
  const { agent } = report;
  const style = writer.style;

  if (!agent.resolved) {
    headline(writer, 'agent', style.yellow('not resolved'));
  } else {
    const named = agent.name ?? agent.id ?? 'unknown';
    const also = agent.name !== null && agent.id !== null ? `  ${style.dim(agent.id)}` : '';
    headline(writer, 'agent', `${style.cyan(named)}${also}`);
    detail(writer, style.dim(`from ${agent.origin ?? 'configuration'}`));
  }
  renderHints(report, writer, 'agent');
}

/**
 * Renders the session check.
 *
 * The headline counts and the lines under it identify, because those are two
 * different questions. "1 active" answers "am I reachable"; the row beneath it
 * answers "is that the listener I think it is", which is the one somebody with
 * two terminals open and a message that never arrived is actually asking.
 *
 * A stale session is named in the headline rather than folded into the count.
 * "none active, 1 stale" is a completely different situation from "none
 * active" — the first says a listener is running and has stopped answering, the
 * second says nothing is running — and they need different next steps.
 *
 * @param report - What the checks found.
 * @param writer - The accumulating writer.
 */
function renderSessions(report: StatusReport, writer: HumanWriter): void {
  const { sessions } = report;
  const style = writer.style;
  const items = sessions.items ?? [];
  const stale = items.filter((session) => session.status !== SESSION_ACTIVE).length;
  const count = sessions.count ?? 0;

  if (!sessions.checked) {
    headline(writer, 'sessions', style.dim('not checked'));
    detail(writer, style.dim('needs a resolved agent in a reachable project'));
  } else if (count === 0 && stale === 0) {
    headline(writer, 'sessions', style.yellow('none active'));
    detail(
      writer,
      style.dim(`run \`${PROGRAM} listen --runtime <name>\` to receive messages here`),
    );
  } else {
    const staleSuffix = stale === 0 ? '' : style.yellow(`, ${String(stale)} stale`);
    const active =
      count === 0 ? style.yellow('none active') : style.green(`${String(count)} active`);
    headline(writer, 'sessions', `${active}${staleSuffix}`);

    for (const session of items) {
      renderSession(session, writer);
    }
    if (sessions.items === null) {
      // The count came from the discovery row and the detail did not arrive.
      // Said plainly, because the problem line below explains why.
      detail(writer, style.dim('per-session detail unavailable'));
    }
    if (stale > 0) {
      detail(
        writer,
        style.dim('a stale listener is registered and not answering; restart it to be reachable'),
      );
    }
  }
  renderHints(report, writer, 'sessions');
}

/**
 * Renders one session: what it is, then when it was last heard from.
 *
 * Instants are absolute rather than relative, like the token expiry above:
 * "4m ago" is friendlier and is also unpasteable into a bug report, and this is
 * the command whose output people paste into bug reports.
 *
 * @param session - One listener.
 * @param writer - The accumulating writer.
 */
function renderSession(session: SessionDetail, writer: HumanWriter): void {
  const style = writer.style;
  const state =
    session.status === SESSION_ACTIVE ? style.green(session.status) : style.yellow(session.status);
  const runtime = session.runtime ?? 'unknown runtime';

  detail(
    writer,
    `${style.cyan(session.id)}  ${state}  ${style.dim(`${session.machineName}  ${runtime}`)}`,
  );
  detail(writer, `  ${style.dim(session.workingDirectory)}`);
  detail(writer, `  ${style.dim(`started ${session.startedAt}, last seen ${session.lastSeenAt}`)}`);
}
