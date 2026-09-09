/**
 * `agentchat listen` — the reading half of the product, and the reason the
 * project exists (plan §6.3, PRD §38–§40).
 *
 * ```text
 * agentchat listen --runtime claude-code
 * agentchat listen --runtime codex --json | while read -r line; do …; done
 * agentchat listen --runtime opencode --no-ack        # ack with `agentchat ack`
 * ```
 *
 * Nobody types this. An AI coding agent runs it, holds it open for hours, and
 * parses its standard output; every decision below defers to that reader.
 *
 * ## The stdout contract, and how it is kept here
 *
 * > Standard output carries message payloads. Nothing else. Ever.
 *
 * PRD §39, and the one rule this command cannot get wrong: a single stray line
 * on file descriptor 1 corrupts the input of the program reading it, silently
 * on our side and bafflingly on theirs. Three things together keep it.
 *
 * **The types.** A command is handed `emit` and `log` and no writable stdout at
 * all (`../command.ts`). Every connection message, every reconnect, every
 * warning below goes through `context.log`, which can only reach stderr.
 *
 * **One writer, one write per event.** Every payload leaves through
 * {@link OutputQueue}, which holds a single promise chain: one `emit` is one
 * `write` of one complete line, and the next does not start until the previous
 * has flushed. Two messages arriving in the same tick cannot interleave, and a
 * reader never sees half a line followed by the start of another.
 *
 * **The test spawns the binary.** `packages/cli/tests/listen.test.ts` reads the
 * two descriptors independently from a real process, because a helper that
 * merged them would let the suite pass while the contract was broken.
 *
 * ## Acknowledgement happens after the write, not after the render
 *
 * Plan §6.3 step 3: the acknowledgement is sent once the stdout write has
 * completed. `emit` resolves when the write callback has fired — that guarantee
 * is built into `../output/streams.ts` for this command specifically — so the
 * `ack` frame is sent from the continuation of that promise and from nowhere
 * else.
 *
 * The failure it prevents is the expensive one. Acknowledging on receipt tells
 * the server to forget a message the consumer may never have seen: the harness
 * had gone, the pipe was closed, the disk was full. Acknowledging after the
 * write means a dead pipe leaves the message pending, and the next `listen`
 * replays it. The reverse ordering loses messages permanently and looks
 * completely healthy while it does.
 *
 * `--no-ack` turns the acknowledgement off for a consumer that would rather
 * acknowledge when it has *acted* on a message rather than when it has read it;
 * `agentchat ack <id>` is the other half of that arrangement, and `--json`
 * reports `"ack": false` at startup so a harness can tell which world it is in
 * without being told.
 *
 * ## What a replay looks like, and why a duplicate is acknowledged again
 *
 * Delivery is at-least-once. A message whose acknowledgement was lost with the
 * socket is replayed on the next `hello`, and `SessionListener` suppresses it —
 * the consumer sees each identifier exactly once, which is the whole point of
 * the deduplication.
 *
 * A suppressed message is still *pending on the server*, though, and the reason
 * it is pending is that its acknowledgement never landed. So a duplicate is
 * acknowledged again, silently: it was written to stdout the first time, which
 * is what an acknowledgement asserts. Doing nothing instead would leave the
 * message replayed on every reconnect for the life of the inbox row, delivered
 * to nobody.
 *
 * ## A permanent refusal is an exit, not a backoff
 *
 * `SessionListener` sorts a closed socket into retry, refresh, and fatal. A
 * session that has been deleted (`4403`), or a frame this build sent that the
 * server will not accept, will be refused identically on every future attempt.
 * Backing off against that produces a process that looks like a working
 * listener and delivers nothing, which is worse than an error, so a refusal
 * ends the command with the code the failure carries — 1 for a refused session,
 * 3 for credentials the server rejected. Only a transient failure is retried,
 * and every attempt is visible on stderr and, in `--json`, on stdout.
 *
 * ## Why `--runtime` is required (D14)
 *
 * The runtime is metadata other people read: `agentchat agents` shows which
 * harness an agent is listening from. A CLI that guessed it — from an
 * environment variable, a parent process name, a heuristic on `argv` — would be
 * wrong some of the time and authoritative all of the time, and nobody reading
 * the discovery listing could tell the difference. The invoking agent knows its
 * own runtime. Omitting it is a usage error and exits 2.
 *
 * ## What `--json` promises
 *
 * Newline-delimited JSON, one object per event, every object carrying `event`:
 *
 * ```json
 * {"event":"listening","sessionId":"ses_…","agent":"@you/backend","ack":true, …}
 * {"event":"status","state":"connecting","attempt":0}
 * {"event":"status","state":"connected","sessionId":"ses_…","pending":1}
 * {"event":"message","messageId":"msg_…","conversationId":"cnv_…","content":"…", …}
 * {"event":"status","state":"reconnecting","attempt":1,"delayMs":1043,"code":1006}
 * {"event":"status","state":"disconnected","reason":"stopped"}
 * ```
 *
 * **Connection state is on stdout too.** Plan §6.3 step 6: a consumer in JSON
 * mode never has to parse stderr. Everything it needs to know — that the
 * process is up, which session it registered, that the connection dropped and
 * is coming back — is an object on the same stream as the messages, in order.
 * stderr stays a human's log.
 *
 * **A message event is the server's envelope, verbatim.** The fields are the
 * ones PRD §40 names, and any field a newer server adds arrives with them: the
 * frame is parsed leniently by `@agentchat/client` and passed through here
 * rather than projected onto a shape this build knows. A consumer that reads
 * `content` keeps working; one that wants a field added next month gets it
 * without a CLI release.
 *
 * **There is no reply hint in JSON.** The human rendering carries a ready-made
 * `agentchat send …` line because a person needs the command; a program has
 * `sender` and `conversationId`, which is the same fact without a string it
 * would have to parse a command line out of.
 *
 * @module
 */

import { hostname as osHostname } from 'node:os';

import type {
  AgentChatClient,
  ClosedReason,
  DeliveredMessage,
  FrameConnector,
  ListenerStatus,
} from '@agentchat/client';
import { SessionListener, WebSocketConnector } from '@agentchat/client';
import type {
  AgentId,
  MessageId,
  ProjectAgent,
  ProjectId,
  ProtocolError,
  SessionId,
} from '@agentchat/protocol';
import { ErrorCode, MAX_RUNTIME_LENGTH } from '@agentchat/protocol';

import type { OptionSpecs } from '../args.js';
import type { ClientSeams } from '../client.js';
import { clientFor } from '../client.js';
import type { Command, CommandContext } from '../command.js';
import { requireServer, serverRequestFor } from '../config.js';
import type { AgentIdentity, ResolvedAgent, ResolvedProject } from '../context.js';
import {
  CONTEXT_OPTIONS,
  contextRequestFor,
  describeProject,
  resolveAgent,
  resolveProject,
} from '../context.js';
import { CliError, UsageError } from '../errors.js';
import type { JsonValue, View } from '../output/output.js';
import { view } from '../output/output.js';
import { CLI_VERSION, PROGRAM } from '../version.js';
import { requireSender } from './send.js';

/** The usage line, quoted by every failure that is about how it was typed. */
const USAGE = 'listen --runtime <name> [--json] [--no-ack]';

/** The environment variable `--runtime` falls back to. */
export const RUNTIME_ENV = 'AGENTCHAT_RUNTIME';

/**
 * How long the teardown at the end of an interrupted run may take.
 *
 * Bounded because it runs *after* `Ctrl-C`, when the user has already asked for
 * this process to end and the commonest reason the socket died is that the
 * network went with it. An unbounded `DELETE /sessions/:id` would hang a
 * listener that had been interrupted precisely because its server was
 * unreachable. Nothing is orphaned when it times out: a session that stops
 * heartbeating is aged out by the server's own sweep, which is exactly what a
 * killed listener leaves behind anyway.
 */
const TEARDOWN_TIMEOUT_MS = 5_000;

/** `--project`, `--agent`, and this command's own two. */
const LISTEN_OPTIONS: OptionSpecs = Object.freeze({
  ...CONTEXT_OPTIONS,
  runtime: {
    type: 'string',
    placeholder: '<name>',
    description: `the harness this listener runs in, required (also ${RUNTIME_ENV})`,
  },
  ack: {
    type: 'boolean',
    description: 'acknowledge each message once it has reached stdout; --no-ack disables it',
  },
});

/** The seams this command is built on; see `../client.ts`. */
export interface ListenOverrides extends ClientSeams {
  /**
   * How to open sockets.
   *
   * A seam so a test can drive the whole command — registration, the message
   * rendering, the acknowledgement ordering, the exit code — against frames it
   * supplies, with no socket and no server. Production passes nothing and gets
   * a {@link WebSocketConnector} pointed at the resolved server.
   */
  readonly connector?: (baseUrl: string) => FrameConnector;

  /**
   * This machine's name, as `POST /sessions` records it.
   *
   * A seam because the hostname is the one field of a registration a test
   * cannot predict, and asserting on the request is how the registration is
   * covered at all.
   */
  readonly hostname?: () => string;
}

// ---------------------------------------------------------------------------
// Serialising stdout
// ---------------------------------------------------------------------------

/**
 * One writer for standard output, and the acknowledgement hanging off each
 * write.
 *
 * Everything this command puts on stdout goes through one instance. Events
 * arrive from a socket callback, which is synchronous and cannot await
 * anything, so without a queue two messages delivered in the same tick would
 * start two overlapping writes and two acknowledgements would race their own
 * flushes. The chain makes the order on the wire the order on the stream, and
 * makes "after the write" mean after *this* event's write.
 *
 * A write that fails stops the queue. Once stdout is gone there is nowhere for
 * the remaining events to go, and continuing to acknowledge messages that
 * cannot be delivered would throw them away on behalf of a reader that has
 * already left.
 */
class OutputQueue {
  readonly #emit: (value: View) => Promise<void>;
  readonly #onFailure: (error: unknown) => void;
  #tail: Promise<void> = Promise.resolve();
  #failure: unknown = null;

  /**
   * @param emit - The command context's `emit`, which resolves after the flush.
   * @param onFailure - Called once, with the first write that failed.
   */
  public constructor(emit: (value: View) => Promise<void>, onFailure: (error: unknown) => void) {
    this.#emit = emit;
    this.#onFailure = onFailure;
  }

  /**
   * Queues one event, and what to do once it has reached the operating system.
   *
   * @param value - The event, in both representations.
   * @param written - Run after the write has flushed, and only then. This is
   *   where an acknowledgement belongs; it is not run at all if the write
   *   failed, which is the whole point.
   */
  public push(value: View, written?: () => void): void {
    this.#tail = this.#tail
      .then(async () => {
        if (this.#failure !== null) {
          return;
        }
        await this.#emit(value);
        written?.();
      })
      .catch((error: unknown) => {
        if (this.#failure === null) {
          this.#failure = error;
          this.#onFailure(error);
        }
      });
  }

  /**
   * Waits for everything queued so far.
   *
   * @returns When the last queued write has finished, successfully or not.
   */
  public drain(): Promise<void> {
    return this.#tail;
  }
}

// ---------------------------------------------------------------------------
// Reading a delivered payload
// ---------------------------------------------------------------------------

/**
 * Reads a string field off a delivered message, if it has one.
 *
 * The payload is validated for `messageId` and passed through otherwise
 * (`@agentchat/client`'s `MessageFrameSchema`), because its fields belong to
 * the messages service rather than to the transport. So every field the human
 * rendering wants is read defensively: a server that stops sending one, or a
 * frame from a version that never sent it, costs a line of the rendering and
 * not the delivery of the message.
 *
 * @param message - The delivered payload.
 * @param field - The field to read.
 * @returns The value, or `null` when it is absent or is not a string.
 */
function text(message: DeliveredMessage, field: string): string | null {
  const value: unknown = message[field];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Converts an arbitrary decoded value into one `JSON.stringify` reproduces
 * exactly.
 *
 * A delivered payload came off `JSON.parse`, so in practice every value in it
 * is already JSON. This is the boundary that makes that a fact rather than an
 * assumption, and it exists instead of a cast: `JsonValue` is what stops a
 * `Date` or a class instance reaching `--json` as `{}`, and casting past it
 * would give up the guarantee for the one payload in the CLI that did not come
 * from a schema this build wrote.
 *
 * @param value - Anything.
 * @returns The value as JSON, or `undefined` for something JSON cannot carry —
 *   which is then dropped rather than emitted as `null`, so a consumer is never
 *   told a field was present and empty when it was unrepresentable.
 */
function asJson(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    // A hole or an unrepresentable element becomes `null`, as `JSON.stringify`
    // does: dropping it would shift every later index.
    return value.map((element: unknown) => asJson(element) ?? null);
  }
  if (typeof value === 'object') {
    const result: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      const converted = asJson(entry);
      if (converted !== undefined) {
        result[key] = converted;
      }
    }
    return result;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** What the reply hint needs to name, beyond the thread itself. */
export interface ReplyContext {
  /** `--agent <name>`, when a bare `send` here would not resolve this agent. */
  readonly agent: string | null;

  /** `--project <slug>`, for the same reason. */
  readonly project: string | null;
}

/**
 * The ready-made reply command for one message.
 *
 * Included on purpose (plan §6.3): it lets a coding agent answer in-thread
 * without reading any documentation, which is the difference between a
 * listener that produces conversations and one that produces transcripts.
 *
 * `--agent` and `--project` appear only when the listening invocation resolved
 * them from a flag. A flag is the one source `send` cannot reproduce on its own
 * — the environment and the repository configuration are still there when the
 * reply is typed, and a stored default is what `send` would pick anyway — so
 * without them the hint would quietly reply as a different agent.
 *
 * @param message - The delivered payload.
 * @param context - What the invocation resolved from a flag.
 * @returns The command line, or `null` when the sender cannot be addressed.
 */
export function replyCommand(message: DeliveredMessage, context: ReplyContext): string | null {
  const recipient = text(message, 'sender') ?? text(message, 'senderAgentId');
  if (recipient === null) {
    return null;
  }

  const parts = [PROGRAM, 'send', recipient];
  if (context.project !== null) {
    parts.push('--project', context.project);
  }
  if (context.agent !== null) {
    parts.push('--agent', context.agent);
  }

  const conversation = text(message, 'conversationId');
  if (conversation !== null) {
    parts.push('--conversation', conversation);
  }
  parts.push('"…"');
  return parts.join(' ');
}

/**
 * One delivered message, in both representations.
 *
 * @param message - The payload exactly as it arrived.
 * @param reply - What the reply hint should name; see {@link replyCommand}.
 * @returns The view. See the module note for what the JSON promises.
 */
export function messageView(message: DeliveredMessage, reply: ReplyContext): View {
  const fields: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(message)) {
    // `event` is the envelope's discriminator and has to be the CLI's word, not
    // a field name a future server might reuse. The server sends no such field.
    if (key === 'event') {
      continue;
    }
    const converted = asJson(value);
    if (converted !== undefined) {
      fields[key] = converted;
    }
  }
  const json: JsonValue = { event: 'message', ...fields };

  return view(json, (writer) => {
    writer.line(writer.style.dim(`[${PROGRAM} message]`));
    writer.fields([
      ['id', message.messageId],
      ['from', text(message, 'sender') ?? text(message, 'senderAgentId')],
      ['conversation', text(message, 'conversationId')],
      ['reply', replyCommand(message, reply)],
    ]);
    writer.blank();
    // Split rather than written as one string so that content ending in a
    // newline does not produce a doubled blank line, and content containing one
    // is still one line per line to whatever is reading.
    for (const line of (text(message, 'content') ?? '').split('\n')) {
      writer.line(line);
    }
    // The separator between one message and the next. `blank` collapses it
    // against content that already ended empty.
    writer.blank();
  });
}

/**
 * The startup announcement: which agent, which session, and how it will
 * acknowledge.
 *
 * Only in `--json`. The human equivalent is one line on stderr, because for a
 * person it is commentary on the run and not a message.
 *
 * @param details - What was registered.
 * @returns The view.
 */
function listeningView(details: {
  readonly sessionId: SessionId;
  readonly agent: string;
  readonly agentId: string;
  readonly projectId: ProjectId;
  readonly runtime: string;
  readonly ack: boolean;
}): View {
  return view(
    {
      event: 'listening',
      sessionId: details.sessionId,
      agent: details.agent,
      agentId: details.agentId,
      projectId: details.projectId,
      runtime: details.runtime,
      // So a consumer knows whether it is responsible for `agentchat ack`
      // without having been told which flags it was started with.
      ack: details.ack,
    },
    (writer) => {
      writer.line(`Listening as ${details.agent} (session ${details.sessionId})`);
    },
  );
}

/**
 * A connection state change, as `--json` reports it.
 *
 * A projection of `ListenerStatus` rather than the union itself: `connecting`,
 * `connected`, `reconnecting`, `disconnected`, which is the vocabulary plan
 * §6.3 step 6 names plus the first attempt, which tells a harness the process
 * is alive and trying before anything has succeeded. A consumer branching on
 * the three documented states is unaffected by the fourth, which is what the
 * additive rule asks of it.
 *
 * @param status - What the listener reported.
 * @returns The view, or `null` for a transition with nothing to say.
 */
function statusView(status: ListenerStatus): View {
  switch (status.state) {
    case 'connecting':
      return view({ event: 'status', state: 'connecting', attempt: status.attempt }, (writer) => {
        writer.line(`connecting (attempt ${String(status.attempt + 1)})`);
      });
    case 'connected':
      return view(
        {
          event: 'status',
          state: 'connected',
          sessionId: status.sessionId,
          pending: status.pending,
        },
        (writer) => {
          writer.line(`connected, ${String(status.pending)} pending`);
        },
      );
    case 'reconnecting':
      return view(
        {
          event: 'status',
          state: 'reconnecting',
          attempt: status.attempt,
          delayMs: status.delayMs,
          code: status.closure.code,
        },
        (writer) => {
          writer.line(`reconnecting in ${String(status.delayMs)}ms`);
        },
      );
    case 'closed':
      return view({ event: 'status', state: 'disconnected', reason: status.reason }, (writer) => {
        writer.line(`disconnected (${status.reason})`);
      });
  }
}

/**
 * The stderr line for a connection state change.
 *
 * Every one of these is operational: it describes the run, not a result, so it
 * goes to stderr in both output modes. In `--json` the same transition is also
 * an object on stdout — the two are not alternatives, because a person reading
 * a log and a program reading a stream both need it and neither should have to
 * read the other's stream.
 *
 * @param status - What the listener reported.
 * @param log - Where operational output goes.
 */
function reportStatus(status: ListenerStatus, log: CommandContext['log']): void {
  switch (status.state) {
    case 'connecting':
      // Only the retries are worth a line: the first attempt is already implied
      // by the process having started, and a listener that reconnects all day
      // should not fill a log with news that it is about to.
      if (status.attempt > 0) {
        log.debug(`connecting, attempt ${String(status.attempt + 1)}`);
      }
      return;
    case 'connected':
      log.info(
        status.pending > 0
          ? `Connected. ${String(status.pending)} pending message(s) replayed.`
          : 'Connected.',
      );
      return;
    case 'reconnecting':
      log.warn(
        `Connection lost (close ${String(status.closure.code)}); reconnecting in ${String(
          Math.round(status.delayMs / 100) / 10,
        )}s (attempt ${String(status.attempt + 1)}).`,
      );
      return;
    case 'closed':
      log.debug(`Listener closed: ${status.reason}.`);
  }
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/**
 * The runtime this listener declares, from `--runtime` or the environment.
 *
 * @param context - The command context.
 * @returns The runtime, trimmed.
 * @throws {UsageError} When it is absent, empty, or longer than the server will
 *   store. Exit 2: a re-run with the same arguments fails identically. See the
 *   module note for why nothing guesses it (D14).
 */
export function requireRuntime(context: CommandContext): string {
  const given = context.args.value('runtime') ?? context.env.env[RUNTIME_ENV];
  const runtime = given?.trim() ?? '';

  if (runtime === '') {
    throw new UsageError(
      given === undefined
        ? '`--runtime` is required: name the harness this listener runs in.'
        : '`--runtime` was given an empty value.',
      {
        hint: `Pass the harness you are running in — \`--runtime claude-code\`, \`--runtime codex\`, \`--runtime opencode\` — or set ${RUNTIME_ENV}. It is free-form, it is shown to everyone in the project by \`${PROGRAM} agents\`, and nothing guesses it because a guess would look exactly like a fact. Usage: ${PROGRAM} ${USAGE}`,
      },
    );
  }

  if (runtime.length > MAX_RUNTIME_LENGTH) {
    throw new UsageError(
      `\`--runtime\` is ${String(runtime.length)} characters; the limit is ${String(MAX_RUNTIME_LENGTH)}.`,
      { hint: `Usage: ${PROGRAM} ${USAGE}` },
    );
  }

  return runtime;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/** Everything resolved before a socket is opened. */
interface Listening {
  /** The project the session is registered in. */
  readonly projectId: ProjectId;

  /** The agent this listener speaks for. */
  readonly agentId: AgentId;

  /** How that agent is addressed: `@you/backend`. */
  readonly address: string;

  /** The project as a human names it, for the line on stderr. */
  readonly where: string;

  /** What the reply hint has to name explicitly. */
  readonly reply: ReplyContext;
}

/** How a discovery row is addressed. Mirrors `./agents.ts`'s `addressOf`. */
function addressOf(row: ProjectAgent): string {
  return `@${row.owner.username}/${row.agent.name}`;
}

/**
 * Turns a project reference into an identifier.
 *
 * Only when it is not already known: a repository configuration records the id
 * (T-205), so the common case makes no request at all.
 *
 * @param client - The client to ask.
 * @param project - The resolved project.
 * @param signal - The interrupt signal.
 * @returns The project's identifier.
 * @throws {CliError} `NOT_FOUND` when the caller is in no such project.
 */
async function projectIdFor(
  client: AgentChatClient,
  project: ResolvedProject,
  signal: AbortSignal,
): Promise<ProjectId> {
  if (project.id !== null) {
    return project.id;
  }

  const { items } = await client.projects.list({ signal });
  const match = items.find((membership) => membership.slug === project.slug);
  if (match !== undefined) {
    return match.id;
  }

  throw new CliError(ErrorCode.NOT_FOUND, `You are not in a project called \`${project.slug}\`.`, {
    hint: `That came from ${project.origin}. \`${PROGRAM} project list\` shows the projects you are in.`,
  });
}

/**
 * Resolves the project and the agent this invocation listens as.
 *
 * The same two round trips `agentchat send` makes, and for the same reason: the
 * roster answers whether the agent is in the project, and `GET /me` says which
 * of its rows are the caller's.
 *
 * @param context - The command context.
 * @param client - The client.
 * @returns Everything needed to register a session.
 * @throws {CliError} `AGENT_NOT_IN_PROJECT` when the resolved agent is not the
 *   caller's here; `NOT_FOUND` when the project is not one they are in.
 */
async function resolveListening(
  context: CommandContext,
  client: AgentChatClient,
): Promise<Listening> {
  const project = await resolveProject(contextRequestFor(context));
  const projectId = await projectIdFor(client, project, context.signal);

  const [roster, me] = await Promise.all([
    client.projects.listAgents(projectId, { signal: context.signal }),
    client.auth.me({ signal: context.signal }),
  ]);

  const own = roster.items.filter((row) => row.owner.id === me.id);
  const identities: readonly AgentIdentity[] = own.map((row) => ({
    id: row.agent.id,
    name: row.agent.name,
  }));
  const resolved: ResolvedAgent = await resolveAgent(
    project,
    contextRequestFor(context, { agents: () => Promise.resolve(identities) }),
  );
  const row = requireSender(resolved, own, project);

  return {
    projectId,
    agentId: row.agent.id,
    address: addressOf(row),
    where: describeProject(project),
    reply: {
      agent: resolved.source === 'flag' ? row.agent.name : null,
      project: project.source === 'flag' ? (project.slug ?? project.id) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** Why the listening loop finished. */
type Ending =
  /** `SIGINT` or `SIGTERM`. Exit 0 after the session has been ended. */
  | { readonly kind: 'interrupted' }
  /** The listener stopped for good. */
  | { readonly kind: 'closed'; readonly reason: ClosedReason; readonly error: ProtocolError | null }
  /** A write to stdout failed, so there is no longer anywhere to deliver. */
  | { readonly kind: 'output'; readonly error: unknown };

/**
 * Ends the session, reporting a failure rather than raising it.
 *
 * Runs when the process is already on its way out, most often because the user
 * interrupted it — so it does not use the command's own signal, which is
 * aborted by then and would cancel this request before it was sent. It gets a
 * fresh deadline of its own instead.
 *
 * A teardown that fails is a warning and never the reported failure: the
 * session is not orphaned, because a listener that stops heartbeating is aged
 * out by the server's sweep, and a `Ctrl-C` that ended with an error about a
 * session nobody asked about would bury whatever actually went wrong.
 *
 * @param client - The client.
 * @param sessionId - The session to end.
 * @param context - The command context, for stderr.
 * @returns When the teardown has finished or given up.
 */
async function endSession(
  client: AgentChatClient,
  sessionId: SessionId,
  context: CommandContext,
): Promise<void> {
  try {
    await client.sessions.end(sessionId, { signal: AbortSignal.timeout(TEARDOWN_TIMEOUT_MS) });
    context.log.info(`Session ${sessionId} ended.`);
  } catch (error) {
    context.log.warn(
      `Could not end session ${sessionId}: ${error instanceof Error ? error.message : String(error)}. The server will expire it when it stops heartbeating.`,
    );
  }
}

/**
 * Runs `agentchat listen`.
 *
 * @param context - The command context.
 * @param overrides - Test seams.
 * @returns When the listener has stopped and its session has been ended.
 * @throws {ProtocolError} When the connection was refused permanently, or the
 *   credentials were rejected, or stdout failed for a reason other than the
 *   reader closing the pipe.
 */
async function listen(context: CommandContext, overrides: ListenOverrides): Promise<void> {
  const runtime = requireRuntime(context);
  const acknowledge = context.args.tristate('ack') ?? true;

  const server = await requireServer(serverRequestFor(context));
  const client = await clientFor(context, overrides);
  const listening = await resolveListening(context, client);

  const sessionId = await client.sessions.register(
    {
      agentId: listening.agentId,
      projectId: listening.projectId,
      machine: { name: (overrides.hostname ?? osHostname)() },
      runtime,
      workingDirectory: context.env.cwd,
    },
    { signal: context.signal },
  );

  // Plan 6.3 step 2, and it goes to stderr in both modes: it says what this
  // process is, which is commentary on the run rather than a message.
  context.log.info(
    `Listening as ${listening.address} in ${listening.where} (session ${sessionId})`,
  );

  const listener = new SessionListener({
    connector: (overrides.connector ?? defaultConnector)(server.url),
    tokens: client.tokens,
    sessionId,
    client: `${PROGRAM}/${CLI_VERSION}`,
  });

  // Only the first ending counts: a failed write also drops the socket, and an
  // interrupt arrives while a close is already in flight.
  const finished = once<Ending>();

  const out = new OutputQueue(
    (value) => context.emit(value),
    (error) => {
      finished.settle({ kind: 'output', error });
    },
  );

  if (context.isJson) {
    // Before the first status event, because it is what tells a consumer which
    // session the states that follow belong to.
    out.push(
      listeningView({
        sessionId,
        agent: listening.address,
        agentId: listening.agentId,
        projectId: listening.projectId,
        runtime,
        ack: acknowledge,
      }),
    );
  }

  listener.on('status', (status) => {
    reportStatus(status, context.log);
    if (context.isJson) {
      out.push(statusView(status));
    }
    if (status.state === 'closed') {
      finished.settle({ kind: 'closed', reason: status.reason, error: status.error });
    }
  });

  listener.on('message', (message) => {
    out.push(messageView(message, listening.reply), () => {
      if (acknowledge) {
        // After the flush, and only after it. See the module note.
        acknowledgeMessage(listener, message.messageId, context);
      }
    });
  });

  listener.on('duplicate', ({ messageId }) => {
    context.log.debug(`Message ${messageId} was replayed and had already been delivered.`);
    if (acknowledge) {
      // Already written to stdout on an earlier connection; the acknowledgement
      // that would have cleared it is what went missing. See the module note.
      acknowledgeMessage(listener, messageId, context);
    }
  });

  listener.on('error', ({ phase, error }) => {
    context.log.debug(`${phase}: ${error.message}`);
  });

  const interrupted = (): void => {
    finished.settle({ kind: 'interrupted' });
  };
  context.signal.addEventListener('abort', interrupted, { once: true });

  let ending: Ending;
  try {
    listener.start();
    // An interrupt that arrived during the setup above never fires a listener,
    // because `addEventListener` on an already-aborted signal does not.
    if (context.signal.aborted) {
      interrupted();
    }
    ending = await finished.promise;
  } finally {
    context.signal.removeEventListener('abort', interrupted);
  }

  await listener.stop();
  // Everything already queued still belongs to the consumer: a message written
  // while the socket was closing is a message it is owed. Its acknowledgement
  // will not be sent — the socket is gone by then — which leaves the message
  // pending and replayed, which is the correct end of an at-least-once
  // delivery.
  await out.drain();
  await endSession(client, sessionId, context);

  if (ending.kind === 'closed' && ending.error !== null) {
    throw ending.error;
  }
  if (ending.kind === 'output') {
    // A reader that closed the pipe deliberately — `listen --json | head -1` —
    // is not a failure, and `../main.ts` turns its `EPIPE` into exit 0. Anything
    // else that broke stdout is.
    throw ending.error instanceof Error
      ? ending.error
      : new Error(`Writing to standard output failed: ${String(ending.error)}`);
  }
}

/**
 * A promise that something else resolves, exactly once.
 *
 * The listening loop ends for three unrelated reasons — a socket that closed
 * for good, an interrupt, a write that failed — each of which is reported by a
 * callback rather than by a return. This is the join between them, and the
 * "exactly once" is the point: two of the three routinely happen together,
 * because whatever ended the run tends to end the other two as well, and the
 * first one to arrive is the one that explains it.
 *
 * @returns The promise and the function that settles it.
 */
function once<T>(): { readonly promise: Promise<T>; readonly settle: (value: T) => void } {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    let settled = false;
    settle = (value: T): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
  });
  return { promise, settle };
}

/**
 * Sends an acknowledgement, reporting rather than raising a failure.
 *
 * @param listener - The listener holding the socket.
 * @param messageId - The message to acknowledge.
 * @param context - The command context, for stderr.
 */
function acknowledgeMessage(
  listener: SessionListener,
  messageId: MessageId,
  context: CommandContext,
): void {
  if (!listener.ack(messageId)) {
    // The socket dropped between the delivery and the flush. Not an error: the
    // message is still pending server-side, the next `hello` replays it, and
    // the deduplication keeps that invisible to the consumer.
    context.log.debug(`Could not acknowledge ${messageId} yet; it will be replayed.`);
  }
}

/**
 * The production socket factory.
 *
 * @param baseUrl - The resolved server.
 * @returns A connector that opens `/ws` there, with the token in a header.
 */
function defaultConnector(baseUrl: string): FrameConnector {
  return new WebSocketConnector({ baseUrl });
}

/**
 * Builds `agentchat listen`.
 *
 * @param overrides - Test seams; empty in production.
 * @returns The command.
 */
export function createListenCommand(overrides: ListenOverrides = {}): Command {
  return {
    kind: 'command',
    name: 'listen',
    summary: 'hold a connection open and print messages as they arrive',
    usage: USAGE,
    options: LISTEN_OPTIONS,
    details: [
      'Blocks until interrupted. Registers a session, holds a WebSocket open, prints each message to standard output, and reconnects on its own with backoff. `SIGINT` and `SIGTERM` close the socket, end the session, and exit 0.',
      'Standard output carries message payloads and nothing else; every connection message, warning and progress line goes to standard error. That split is what makes it safe for a coding agent to parse this command directly.',
      '`--runtime` is required and names the harness you are running in — `claude-code`, `codex`, `opencode`, anything. It is shown to everyone in the project, and nothing guesses it, because a guessed runtime is indistinguishable from a true one.',
      '`--json` emits newline-delimited JSON: one object per event, carrying `listening`, `message` and `status` events, so a consumer never has to read standard error.',
      'Each message is acknowledged only after its bytes have reached standard output, so a dead pipe leaves the message pending and it is replayed to the next listener. Pass `--no-ack` to take that over yourself with `agentchat ack`.',
    ],

    /** @inheritdoc */
    run(context: CommandContext): Promise<void> {
      return listen(context, overrides);
    },
  };
}

/** `agentchat listen`. */
export const listenCommand: Command = createListenCommand();
