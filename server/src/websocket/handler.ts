/**
 * The real-time entry point: authenticate the upgrade, require a `hello`, and
 * validate every frame after it.
 *
 * A socket goes through exactly three gates before it can carry anything.
 *
 * 1. **The version floor**, at the upgrade and before anything else is read.
 *    A client whose `X-AgentChat-Client` names a release below
 *    `MIN_CLIENT_VERSION` is refused `426` with the upgrade instruction, and
 *    one that names no release at all is served. See
 *    {@link clientVersionRefusal} for why it is first, and why it is not on
 *    `hello`.
 * 2. **Authentication**, also at the upgrade. {@link authenticateUpgrade}
 *    verifies an access token and yields the user, or refuses. No token, no
 *    socket.
 * 3. **Binding**, on the first frame. That frame must be `hello`, the session
 *    it names must exist and belong to the authenticated user, and it must not
 *    have ended. Until then the connection has an identity but no session, and
 *    every other known frame is refused.
 *
 * The three are separate because they answer different questions. The header
 * says *whether we can talk at all*; the token says *who*; the `hello` says *as
 * which listener*, and only the session knows the agent and project that make
 * delivery addressable.
 *
 * ## A `hello` revives a stale session (T-041)
 *
 * `stale` is not a verdict on a session; it is a statement about the present —
 * "nothing has been heard from this listener lately". A `hello` is the evidence
 * that contradicts it, so this module revives such a session to `active`
 * through {@link SessionService.heartbeat} and binds it, exactly as
 * `POST /sessions/:id/heartbeat` would. Only `ended` is terminal.
 *
 * This is not a relaxation for convenience. Until T-041 the handshake refused
 * anything but `active`, and that was survivable only because nothing marked a
 * session stale on disconnect. Wiring T-309's heartbeat made it fatal: it marks
 * a session `stale` the moment its socket closes, cleanly or not; the handshake
 * then refused the reconnect with {@link CloseCode.SESSION_INVALID}; and
 * `packages/client` treats that code as fatal and stops retrying, because only
 * a new registration can fix it and that is the caller's decision. As
 * `agentchat listen` registers exactly once, the *first* disconnect ended a
 * listener for good — the failure this project exists to prevent.
 *
 * The alternatives were each worse. Not marking a session stale on close would
 * make presence lie about which listeners are connected. Making `4403`
 * retryable in the client would have it re-`hello` a session the server has
 * already refused, forever, and would blunt the code for the case it is for.
 * Reviving here changes only the status a `hello` may start from, and it is the
 * meaning `stale` already carried: the session, its agent, its project and its
 * unacknowledged inbox are all intact, and reconnecting to them is what the
 * replay in {@link ConnectionObserver.bound} is for.
 *
 * A session the sweeper has *ended* is still refused, and a session belonging
 * to somebody else is still invisible. Neither of those is what the client
 * retries against.
 *
 * ## Why the session comes from the frame and never from the token
 *
 * An access token may carry a `sid` claim, and using it would look like the
 * tighter design — one fewer thing the client can get wrong. T-302 established
 * that it is the broken one: the claim is not preserved across a refresh, so a
 * listener that has been running longer than an access token's life holds a
 * token whose session claim is stale or absent. Trusting it would refuse
 * precisely the long-lived listeners this system exists to serve, and would do
 * so intermittently, an hour into a run. The claim is not consulted here.
 *
 * Nothing is lost by reading the session from the frame, because the frame's
 * session is checked against the *token's* user before it is accepted. A client
 * that names somebody else's session is refused by ownership, not by trust.
 *
 * ## A token in a query string
 *
 * Browsers and several WebSocket clients cannot set headers on a socket, so
 * Plan §3 allows the access token as a query parameter. That is a real hazard:
 * a URL is written to access logs, kept in proxy buffers, and shown in error
 * reports, none of which is true of a header this project already redacts. The
 * mitigations are all in this module:
 *
 * - **The header wins.** {@link ACCESS_TOKEN_QUERY_PARAMETER} is read only when
 *   there is no `Authorization` header at all, so a correct client never puts a
 *   credential in a URL by accident.
 * - **The URL is never logged intact.** {@link redactUpgradeUrl} replaces the
 *   parameter's value, and it is what this module logs. Callers logging the
 *   upgrade themselves must use it — pino's `redact` in `../app.ts` covers
 *   headers and cannot see inside a URL.
 * - **It is reported.** A socket authenticated from a query string logs at
 *   `warn` with `credentialSource: 'query'`, so an operator can see which
 *   clients are doing it rather than having to guess.
 * - **The blast radius is an hour.** The parameter carries an access token
 *   (`ACCESS_TOKEN_TTL_SECONDS`), never a refresh token. A leaked URL is a
 *   short-lived read of one user's sockets, not a way back into the account.
 *
 * ## A socket that is not read is closed, not buffered for
 *
 * Delivery hands bytes to the transport and returns, so a peer that has stopped
 * reading never delays another recipient. What it does instead is accumulate:
 * `ws` queues every unread frame, at up to {@link MAX_FRAME_BYTES} apiece, with
 * no ceiling of its own. One suspended laptop is therefore not a latency problem
 * for its own listener but an availability problem for every healthy socket on
 * the instance, which dies with the process when the heap does.
 *
 * So there is a ceiling, and it is here rather than in `../routing/router.ts`.
 * The fan-out's job is to write to whoever is registered; a module that had to
 * know about transport buffers in order to do that would be two jobs. This one
 * already owns a socket's lifetime from its first frame to its last, and
 * closing a socket is the only remedy anyone has for this condition.
 *
 * **The bound is checked on the frames delivery writes, and only those.**
 * {@link SocketBinding.send} is the seam replay and the router push through, and
 * it is the only unbounded source of outbound bytes. `ready`, `pong` and the
 * `error` frame before a close are one small frame each, sent by this module in
 * answer to something the client did, and checking after them would buy nothing
 * except a re-entrant close to reason about.
 *
 * **Closing loses nothing, and that is a property of the inbox rather than a
 * hope.** A message is owed until its `message_inbox` row says acknowledged
 * (Plan §4.4); neither a delivery this server recorded nor a socket that was
 * open a moment ago reduces that debt. The frame that trips the bound has
 * already been handed to the transport, and whether the peer ever reads it does
 * not matter: it is unacknowledged either way, so the next `hello` replays it,
 * and the client deduplicates by `messageId` as it must for every other replay.
 * Anything the router writes after the close is dropped, which is the same
 * no-op a frame racing an ordinary disconnect meets — again unacknowledged,
 * again replayed. There is no path here that acknowledges, discards or
 * otherwise forgets a message.
 *
 * **A code of its own, and no `error` frame.** T-032 closed this with 1000,
 * reasoning that the remedy — reconnect, `hello`, take the replay — is what
 * `NORMAL` already means, and left minting a code to a task that owns
 * `./frames.ts` (subagent protocol §9). T-048 minted it:
 * {@link CloseCode.BACKLOG_UNREAD}. 1000 was not wrong about the remedy for the
 * *socket*; it was wrong about the remedy for the *client*, which is to fix the
 * consumer that stopped reading rather than to wait out somebody else's deploy,
 * and a peer that reconnects without doing so is dropped again. The close code
 * is the only part of a close a structured consumer sees — `agentchat listen
 * --json` reports the closure's code and not its reason — so a distinction
 * carried only by {@link UNREAD_CLOSE_REASON} was a distinction no harness could
 * act on. The reason still travels, for a human reading a close frame.
 *
 * No `error` frame precedes it, which is why {@link close} is not the path
 * taken. Nothing the client sent was wrong, so no code in the frozen set fits;
 * and a frame explaining that a socket's buffer is too full would be written
 * into that buffer.
 *
 * ## Nothing here touches the transport
 *
 * The handler talks to {@link FrameSocket} — send text, close with a code — and
 * is driven by {@link SocketConnection.receive}. It imports no WebSocket
 * library and adds no dependency to `server/package.json`, which is not this
 * task's file. Plan §6 names `@fastify/websocket`, and the task that registers
 * the route adds it and writes the ten-line adapter: `ws`'s `WebSocket`
 * already satisfies {@link FrameSocket} structurally, so the adapter forwards
 * `message` to `receive` and `close` to `disconnected`.
 *
 * That is not only about file ownership. Every rejection path below is a unit
 * test with no server, no socket and no port, which is why each of them has one.
 *
 * @module
 */

import {
  CLIENT_VERSION_HEADER,
  ClientVersionHeaderSchema,
  ErrorCode,
  isClientTooOld,
  MIN_CLIENT_VERSION,
  type SessionId,
  upgradeRequiredMessage,
} from '@stackgrid/protocol';
import { type AccessTokenClaims, verifyAccessToken } from '../auth/tokens.js';
import type { AuthenticatedUser } from '../plugins/auth.js';
import { SESSION_STATUS, type SessionRecord, type SessionService } from '../services/sessions.js';
import {
  type ClientFrame,
  CloseCode,
  type CloseCodeValue,
  type CloseReason,
  closeReasonText,
  decodeFrame,
  encodeFrame,
  errorFrame,
  type HelloFrame,
  internalFailure,
  MAX_FRAME_BYTES,
  outOfOrder,
  type RawFrame,
  type ServerFrame,
  type SocketIdentity,
  sessionInvalid,
  unauthenticated,
} from './frames.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Bytes a socket may have queued for an unread peer before it is closed.
 *
 * Eight maximum-size frames, 16 MiB. A peer that has genuinely stopped reading
 * passes any threshold within seconds, so the only thing a ceiling can be wrong
 * about is how much room a *healthy* listener gets before it is mistaken for a
 * stopped one.
 *
 * T-032 derived it from the largest burst the server writes at a healthy
 * listener, and got that burst wrong. It reasoned that one replay page —
 * `REPLAY_PAGE_SIZE` (100) messages, written before the next page is read from
 * the database (`../routing/delivery.ts`) — is "pessimistically" 64 KiB a
 * message and therefore about 6.5 MiB, against which 16 MiB is two and a half
 * times the headroom. But 64 KiB is a guess about *typical* agent traffic
 * (prose and patches) dressed as a worst case. The legal maximum is D10's 1 MiB
 * of content, so a page's legal maximum is a hundred times that: **100 MiB
 * against a 16 MiB ceiling.** Seventeen ordinary 1 MiB messages were enough to
 * make a listener unreplayable, and it stayed that way through every reconnect
 * (T-053).
 *
 * The lesson is about the shape of the argument rather than the number. A
 * ceiling derived from what a healthy peer *usually* buffers is a ceiling that
 * some legal input crosses, and raising it only moves which input. So the burst
 * no longer argues with the ceiling: {@link SocketBinding.drain} makes a replay
 * wait for the socket to fall back below {@link DRAIN_RESUME_BYTES} before it
 * writes the next frame, which bounds a replay's contribution at
 * `DRAIN_RESUME_BYTES + MAX_FRAME_BYTES` — 4 MiB, a quarter of this — whatever
 * the backlog and whatever the machine.
 *
 * What is left for this number to be is what it always should have been: the
 * point past which a peer is not reading *at all*. Eight maximum-size frames
 * leaves the fan-out, which does not wait for anybody, twelve megabytes of room
 * above a replay in flight, and no single frame and no small burst can come
 * near it.
 *
 * It is also twice `BUFFER_WARNING_BYTES` in `../routing/router.ts`, so the
 * operator's warning always fires before anything is closed. That relationship
 * is restated rather than imported: `router.ts` imports this module, and a
 * cycle is a higher price than a documented constant.
 *
 * What the bound cannot catch is a peer that reads *slowly* rather than not at
 * all — such a peer drains the buffer between writes and never accumulates.
 * That is the intended shape. The failure this exists for is a consumer that has
 * stopped, and the cost of misjudging one is a reconnect and a replay.
 */
export const MAX_BUFFERED_BYTES = 8 * MAX_FRAME_BYTES;

/**
 * What a socket closed for an unread backlog is told.
 *
 * Carried as the close frame's reason rather than in an `error` frame: sending
 * more bytes to a peer whose buffer is being closed for holding too many would
 * be an odd way to end, and there is no honest contract code for it either (see
 * {@link CloseCode.BACKLOG_UNREAD}). It is prose for whoever reads a close
 * frame; the machine-readable half is the close code. Kept inside
 * `MAX_CLOSE_REASON_BYTES` so the transport does not throw as the socket goes;
 * there is a test.
 */
export const UNREAD_CLOSE_REASON =
  'backlog was not being read; reconnect and unacknowledged messages replay';

/**
 * Queued bytes a replay waits to fall back to before it writes its next frame.
 *
 * One maximum-size frame. A writer that pauses here and resumes only when the
 * transport is back under it can leave at most `DRAIN_RESUME_BYTES +
 * MAX_FRAME_BYTES` queued — 4 MiB, a quarter of {@link MAX_BUFFERED_BYTES} —
 * because the frame it then writes is itself at most one maximum frame. That
 * inequality, rather than any assumption about message sizes, is what makes a
 * backlog of any legal size replayable: see {@link SocketBinding.drain}.
 *
 * Low enough that a stopped peer is noticed while the buffer is still small,
 * high enough that a healthy one is never actually made to wait — a socket the
 * kernel is draining is under a megabyte between writes, so the fast path in
 * `drain` is the only path an ordinary listener takes.
 */
export const DRAIN_RESUME_BYTES = MAX_FRAME_BYTES;

/**
 * How often a paused replay asks the transport whether the peer has read
 * anything.
 *
 * Polling, because `bufferedAmount` is the only drain signal every transport
 * has; `ws` fires no event for it, and a per-write completion callback would be
 * a promise about a specific library rather than about {@link FrameSocket}.
 *
 * The interval only costs anything while a socket is *over*
 * {@link DRAIN_RESUME_BYTES}, which a healthy listener never is. It also sets
 * the floor on replay throughput — one resume window (2 MiB) per interval, so
 * roughly 80 MiB/s — which is far above anything a socket sustains.
 */
export const DRAIN_POLL_INTERVAL_MS = 25;

/**
 * How long a socket may fail to move a single byte before the peer is declared
 * stopped and the connection is closed.
 *
 * The measure is *progress*, not duration: every observed fall in
 * `bufferedAmount` restarts the clock, so a peer on a slow link replays for as
 * long as it needs, and only one that has stopped entirely runs out of time.
 * That is the distinction {@link MAX_BUFFERED_BYTES} draws for the fan-out —
 * slow is fine, stopped is not — kept intact for the one writer that now waits
 * instead of accumulating.
 *
 * Thirty seconds is longer than the reference client's own liveness window
 * (protocol §9.7: a 20 s idle interval and a 20 s answer window), so a peer this
 * server gives up on is one its own watchdog would already have given up on.
 */
export const DRAIN_STALL_TIMEOUT_MS = 30_000;

/**
 * What a socket closed for stalling mid-replay is told.
 *
 * A different sentence from {@link UNREAD_CLOSE_REASON} behind the same
 * {@link CloseCode.BACKLOG_UNREAD}, because the two are the same condition for
 * a *client* — you stopped reading; reconnect and read — and different events
 * for an *operator*. One is a peer that let an unbounded fan-out pile up; the
 * other is a peer that stopped taking a replay it asked for and never reached
 * `ready`. A client branching on the code is right to treat them alike; an
 * operator reading a close frame or a log line should not have to guess which
 * happened. Kept inside `MAX_CLOSE_REASON_BYTES`; there is a test.
 */
export const STALLED_REPLAY_CLOSE_REASON =
  'replay stalled: the socket was not being read; reconnect and it replays';

/**
 * What {@link SocketBinding.drain} concluded.
 *
 * `ready` means the transport is back under {@link DRAIN_RESUME_BYTES} and the
 * caller may write. `closed` means there is nothing left to write to — the
 * socket had already gone, or this call closed it because the peer stopped
 * draining — and the caller should stop.
 */
export type DrainOutcome = 'ready' | 'closed';

/** How the outbound back-pressure numbers may be overridden, for tests. */
export interface BackPressureOptions {
  /** Defaults to {@link DRAIN_RESUME_BYTES}. */
  readonly resumeBytes?: number | undefined;

  /** Defaults to {@link DRAIN_POLL_INTERVAL_MS}. */
  readonly pollIntervalMs?: number | undefined;

  /** Defaults to {@link DRAIN_STALL_TIMEOUT_MS}. */
  readonly stallTimeoutMs?: number | undefined;
}

/** The back-pressure numbers a connection actually runs with. */
interface BackPressureSettings {
  readonly resumeBytes: number;
  readonly pollIntervalMs: number;
  readonly stallTimeoutMs: number;
}

/**
 * Fills in {@link BackPressureOptions} from the module's constants.
 *
 * @param options - What the caller overrode, if anything.
 * @returns Every number the drain loop needs.
 */
function backPressureSettings(options: BackPressureOptions | undefined): BackPressureSettings {
  return {
    resumeBytes: options?.resumeBytes ?? DRAIN_RESUME_BYTES,
    pollIntervalMs: options?.pollIntervalMs ?? DRAIN_POLL_INTERVAL_MS,
    stallTimeoutMs: options?.stallTimeoutMs ?? DRAIN_STALL_TIMEOUT_MS,
  };
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * The query parameter an access token may arrive in when the client cannot set
 * a header.
 *
 * The name is RFC 6750 §2.3's, so a client library that already knows how to
 * pass a bearer token in a URI needs no configuration. See the module note for
 * what is done about the fact that a URL is logged.
 */
export const ACCESS_TOKEN_QUERY_PARAMETER = 'access_token';

/**
 * What {@link redactUpgradeUrl} puts where a token was.
 *
 * Not `[redacted]`, which is the censor `../app.ts` uses for headers: brackets
 * are percent-encoded on the way back into a query string, so the marker in the
 * log would read `%5Bredacted%5D` and a reader grepping for the familiar word
 * would miss it. A bare token survives serialisation as itself.
 */
export const REDACTED_TOKEN = 'redacted';

/** Milliseconds in a second; token claims are in seconds. */
const MILLISECONDS_PER_SECOND = 1_000;

/**
 * A bearer credential in an `Authorization` header.
 *
 * Mirrors the pattern in `../plugins/auth.ts`, which does not export it. The
 * duplication is deliberate and small: exporting it would mean editing a file
 * this task does not own, and a socket that accepted a header shape the HTTP
 * side rejects would be a hole nobody would think to look for.
 */
const BEARER_HEADER = /^bearer[ \t]+(?<token>[\x21-\x7e]+)[ \t]*$/i;

/** Base for resolving the path-and-query a transport reports. Never dereferenced. */
const RELATIVE_URL_BASE = 'http://localhost';

/** The part of an HTTP upgrade request this module reads. */
export interface UpgradeRequest {
  /** Request headers, as a Node HTTP server presents them. */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;

  /** The request target, e.g. `/ws?access_token=…`. Absolute URLs are accepted too. */
  readonly url: string;
}

/** Where a socket's credential came from. */
export type CredentialSource = 'header' | 'query';

/** The upgrade carried a valid access token. */
export interface UpgradeAccepted {
  readonly outcome: 'accepted';

  /** The authenticated caller, in the same shape HTTP routes see. */
  readonly user: AuthenticatedUser;

  /** Header or query string. `'query'` is logged at `warn`. */
  readonly credentialSource: CredentialSource;
}

/**
 * Why an upgrade was refused: what the caller is told, and what the operator is
 * told.
 *
 * {@link CloseReason} in both registers, with the close code made optional, and
 * that one difference is the whole of T-042.
 *
 * A refusal decided from the *upgrade request* is decided while the caller can
 * still be answered in HTTP, which is a strictly richer vocabulary than the
 * close codes: a status, an error envelope, and a body a client that has never
 * heard of this server can read. Authentication's refusal has both registers
 * because a socket that fails it after the handshake exists — `4401` — but the
 * version floor has no such twin. There is no close code for "you are too old"
 * in `./frames.ts`, and this module may not mint one (subagent protocol §9);
 * more to the point it does not need one, because the check reads a request
 * header and therefore always answers before {@link CloseCode} is the only
 * vocabulary left.
 *
 * So `code` is absent exactly when there is no close that could carry this
 * refusal, rather than being filled with a code that would say something else.
 * An adapter closing an already-upgraded socket must not invent one either; see
 * the note on the `hello` frame in {@link clientVersionRefusal}.
 */
export interface UpgradeRefusal {
  /** The contract code. Decides the HTTP status through `../errors.ts`. */
  readonly error: ErrorCode;

  /** Client-facing, and names a remedy. */
  readonly message: string;

  /** Operator-facing. Logged, never sent. */
  readonly detail: string;

  /**
   * The close code, when the refusal has one.
   *
   * Present for authentication (`4401`), absent for the version floor. See the
   * interface note.
   */
  readonly code?: CloseCodeValue | undefined;
}

/** The upgrade did not. */
export interface UpgradeRefused {
  readonly outcome: 'refused';

  /**
   * Why, in both registers. A caller that can still answer HTTP should reply
   * with {@link UpgradeRefusal.error}'s status — `401` with a
   * `WWW-Authenticate: Bearer` challenge for a credential failure, `426` for a
   * client below the floor — and one that has already completed the handshake
   * closes with {@link UpgradeRefusal.code}, which is why a refusal that has no
   * close code is one that can only be decided before the handshake.
   */
  readonly reason: UpgradeRefusal;
}

/** The verdict on an upgrade request. */
export type UpgradeDecision = UpgradeAccepted | UpgradeRefused;

/** What {@link authenticateUpgrade} needs to verify a token. */
export interface UpgradeAuthOptions {
  /** The HS256 secret access tokens are signed with. */
  readonly jwtSecret: string;

  /** The clock, injectable so expiry is testable. Defaults to the wall clock. */
  readonly now?: (() => Date) | undefined;

  /**
   * The oldest client release this server will serve.
   *
   * Defaults to `MIN_CLIENT_VERSION`, which is what production passes. A
   * parameter only so a test can move the floor without moving the constant
   * every other test compares against — the same reason
   * `../routes/version.ts` takes it.
   */
  readonly minClientVersion?: string | undefined;
}

/**
 * The `Authorization` header's bearer token, if there is one.
 *
 * @param value - The raw header, which Node may present as an array.
 * @returns The token, or `undefined` if the header is absent or not a bearer.
 */
function headerToken(value: string | string[] | undefined): string | undefined {
  // A repeated Authorization header is not a request this server should try to
  // interpret; taking the first would let a proxy's idea of the credential and
  // this server's disagree.
  if (typeof value !== 'string') {
    return undefined;
  }

  return BEARER_HEADER.exec(value)?.groups?.['token'];
}

/**
 * Parses the query string off a request target.
 *
 * @param url - The request target, relative or absolute.
 * @returns Its parameters, empty if the target will not parse.
 */
function queryOf(url: string): URLSearchParams {
  try {
    return new URL(url, RELATIVE_URL_BASE).searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/**
 * Rewrites an upgrade URL so it can be logged.
 *
 * Every occurrence of {@link ACCESS_TOKEN_QUERY_PARAMETER} loses its value —
 * every one, not the first, because a URL with the parameter twice is exactly
 * the shape an attempt to slip a credential past a naive redactor takes. A URL
 * that will not parse is reported as unparseable rather than returned, since a
 * string this function could not understand is a string it cannot promise is
 * clean.
 *
 * @param url - The request target as it arrived.
 * @returns A form safe to write to a log.
 */
export function redactUpgradeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url, RELATIVE_URL_BASE);
  } catch {
    return '(unparseable url)';
  }

  if (!parsed.searchParams.has(ACCESS_TOKEN_QUERY_PARAMETER)) {
    return `${parsed.pathname}${parsed.search}`;
  }

  parsed.searchParams.set(ACCESS_TOKEN_QUERY_PARAMETER, REDACTED_TOKEN);
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * Turns the token's claims into the caller, exactly as the HTTP side does.
 *
 * `../plugins/auth.ts` keeps its equivalent private, so this is a copy; it is
 * three fields and a conditional spread, and sharing it would mean editing that
 * file. The spread rather than `sessionId: undefined` is required by
 * `exactOptionalPropertyTypes`.
 *
 * The `sid` claim is carried because the type has it, and is never read by this
 * module. See the module note on why.
 *
 * @param claims - The verified claims.
 * @returns The authenticated caller.
 */
function userOf(claims: AccessTokenClaims): AuthenticatedUser {
  const identity = {
    id: claims.sub,
    issuedAt: new Date(claims.iat * MILLISECONDS_PER_SECOND),
    expiresAt: new Date(claims.exp * MILLISECONDS_PER_SECOND),
  };

  return claims.sid === undefined ? identity : { ...identity, sessionId: claims.sid };
}

/**
 * The version floor applied to an upgrade request (T-042).
 *
 * The rule and the sentence are `../routes/version.ts`'s, deliberately, because
 * two ways of saying one rule is worse than one way of saying it in one place.
 * Same header, same `isClientTooOld` from `@stackgrid/protocol`, same
 * `upgradeRequiredMessage`, same three outcomes:
 *
 * - **Absent** — `null`, served. A third-party harness embedding
 *   `@stackgrid/client` is not the `agentchat` CLI and has no release to claim.
 *   The floor exists to tell a CLI user to upgrade, not to gate the API, and a
 *   browser cannot set a header on a `WebSocket` at all.
 * - **Malformed** — `BAD_REQUEST`. A claim this server cannot compare must not
 *   be treated as if none had been made; that would turn "I am 0.0.1" into free
 *   passage past the floor.
 * - **Below the floor** — `UPGRADE_REQUIRED`, carrying the floor and the
 *   command to run.
 *
 * ## Why here, and why not on `hello`
 *
 * An upgrade *is* an HTTP request — protocol §2.2 already says the CLI sends
 * this header on every one — but it is not a Fastify route, so the `onRequest`
 * guard that enforces the floor everywhere else never runs for it. That is the
 * gap; this closes it at the same door and in the same vocabulary.
 *
 * `hello` also carries the identifier, as `HelloFrame.client`, and enforcing it
 * *there* is a different answer to the client rather than the same answer later:
 * the handshake has completed, HTTP is gone, and the only thing left to say it
 * with is a close code. `./frames.ts` has none that means "upgrade", and this
 * module may not mint one (subagent protocol §9). Reusing one would be worse
 * than the gap — `4401` is the exact confusion T-041 wired the HTTP guard ahead
 * of authentication to prevent, and the reference client answers it by
 * refreshing a token that was never the problem.
 *
 * Doing it before the credential is read is the same ordering and the same
 * argument: a CLI three releases old usually has an expired token as well, both
 * answers are true, and only one of them names a remedy.
 *
 * @param request - The upgrade request's headers.
 * @param minClientVersion - The oldest release this server will serve.
 * @returns The refusal, or `null` if the caller may proceed. Never throws.
 */
function clientVersionRefusal(
  request: UpgradeRequest,
  minClientVersion: string,
): UpgradeRefusal | null {
  const raw = request.headers[CLIENT_VERSION_HEADER];
  if (raw === undefined) {
    return null;
  }

  // Node collapses a repeated header into an array, and two different version
  // claims in one request is not something to pick a winner from. Joining
  // rather than indexing hands the whole of what arrived to the schema, which
  // rejects it — the same line `../routes/version.ts` writes.
  const value = Array.isArray(raw) ? raw.join(', ') : raw;

  const parsed = ClientVersionHeaderSchema.safeParse(value);
  if (!parsed.success) {
    return {
      error: ErrorCode.BAD_REQUEST,
      message: `Invalid ${CLIENT_VERSION_HEADER} header. Expected a value of the form agentchat/X.Y.Z.`,
      detail: 'client version header is present but not of the form agentchat/X.Y.Z',
    };
  }

  // `isClientTooOld` throws on a version it cannot parse; the schema above has
  // already established that this one parses, so the call cannot throw here.
  // It is semver precedence rather than string ordering, which is what keeps
  // 0.10.0 newer than 0.9.0 and keeps people out of nobody's server.
  if (!isClientTooOld(parsed.data, minClientVersion)) {
    return null;
  }

  return {
    error: ErrorCode.UPGRADE_REQUIRED,
    // Built by `@stackgrid/protocol` so this sentence and the one the HTTP
    // guard sends cannot drift, and so a client too old to contain any of this
    // code still receives the command that fixes it.
    message: upgradeRequiredMessage(minClientVersion),
    detail: `client ${parsed.data} is below the minimum ${minClientVersion}`,
  };
}

/**
 * Decides whether an upgrade request may become a socket.
 *
 * **The version floor is checked first**, before the credential is even read.
 * See {@link clientVersionRefusal} for why the order is load-bearing and why
 * the check is here rather than on `hello`.
 *
 * Then: header first, query string only if there is no `Authorization` header
 * at all. A present-but-unusable header is a refusal, not a reason to look in
 * the URL: falling through would mean a client with a broken header and a token
 * in its URL connects anyway, and nobody ever finds out the header was wrong.
 *
 * Every *credential* refusal is the same {@link CloseReason} — missing,
 * malformed, expired, forged — with the cause in `detail` for the log only,
 * following the 401 in `../plugins/auth.ts`. A version refusal is deliberately
 * distinguishable from those, because unlike them it names something the caller
 * can fix and telling them apart is the entire point. Never throws.
 *
 * @param request - The upgrade request's headers and target.
 * @param options - The signing secret, the floor, and, for tests, a clock.
 * @returns Accepted with the caller, or refused with a reason.
 */
export function authenticateUpgrade(
  request: UpgradeRequest,
  options: UpgradeAuthOptions,
): UpgradeDecision {
  const now = options.now ?? (() => new Date());

  const tooOld = clientVersionRefusal(request, options.minClientVersion ?? MIN_CLIENT_VERSION);
  if (tooOld !== null) {
    return { outcome: 'refused', reason: tooOld };
  }

  const rawHeader = request.headers['authorization'];

  let token: string | undefined;
  let credentialSource: CredentialSource;

  if (rawHeader !== undefined) {
    token = headerToken(rawHeader);
    credentialSource = 'header';
    if (token === undefined) {
      return {
        outcome: 'refused',
        reason: unauthenticated('authorization header is not a bearer credential'),
      };
    }
  } else {
    token = queryOf(request.url).get(ACCESS_TOKEN_QUERY_PARAMETER) ?? undefined;
    credentialSource = 'query';
    if (token === undefined || token === '') {
      return {
        outcome: 'refused',
        reason: unauthenticated('no bearer credential in the authorization header or the url'),
      };
    }
  }

  let claims: AccessTokenClaims;
  try {
    claims = verifyAccessToken(token, options.jwtSecret, now());
  } catch (error: unknown) {
    return { outcome: 'refused', reason: unauthenticated(reasonOf(error)) };
  }

  return { outcome: 'accepted', user: userOf(claims), credentialSource };
}

/**
 * The most specific account of why a token was refused.
 *
 * `verifyAccessToken` gives every failure the same client-facing message and
 * puts the real one in the `cause`. Logging the outer message would record the
 * same uninformative sentence for every distinct failure.
 *
 * @param error - Whatever verification threw.
 * @returns A short reason for the log. Never the credential.
 */
function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'access token rejected';
  }

  if (error.cause instanceof Error && error.cause.message !== '') {
    return error.cause.message;
  }

  return error.message === '' ? 'access token rejected' : error.message;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * The transport, reduced to what this module does with it.
 *
 * `ws`'s `WebSocket` satisfies this structurally, so the adapter that registers
 * the route passes the socket through unchanged.
 */
export interface FrameSocket {
  /** Sends one text frame. */
  send(data: string): void;

  /** Closes with a status code and a reason of at most 123 bytes. */
  close(code: number, reason: string): void;

  /**
   * Bytes handed to the transport that the peer has not read yet (`ws` calls it
   * `bufferedAmount`).
   *
   * Optional because it belongs to the transport rather than to this protocol,
   * and a socket that does not report it is simply never closed for
   * {@link MAX_BUFFERED_BYTES} — the bound is a safety valve on a number only
   * the transport can supply, not a promise this module can keep alone.
   */
  readonly bufferedAmount?: number | undefined;
}

/** The logging calls this module makes. pino's `Logger` satisfies it. */
export interface SocketLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

/**
 * How the handler finds a session, and how it revives a `stale` one.
 *
 * Deliberately `list` and not a lookup by id. `list` scopes to the caller in
 * SQL — it is driven from `agents` with the owner in the join — so it is
 * structurally incapable of returning somebody else's session, and the
 * ownership half of the `hello` check is therefore not a comparison this module
 * could forget to write. A lookup by id would hand back a row belonging to
 * anybody and leave the check to a line of TypeScript.
 *
 * `heartbeat` is here for the reconnect path described in
 * {@link createWebSocketHandler}, and it is reused rather than reimplemented
 * because it already *is* the revival rule: it moves `stale` back to `active`
 * in a single compare-and-set, refuses an `ended` session with `CONFLICT`, and
 * scopes itself to the caller. A second method that revived a session would be
 * a second copy of that rule to keep in step with this one.
 */
export type SessionLookup = Pick<SessionService, 'list' | 'heartbeat'>;

/**
 * A socket that has completed its handshake, as the rest of the system sees it.
 *
 * Handed to {@link ConnectionObserver}; this is the object T-307 puts in the
 * registry and T-308 delivers through.
 */
export interface SocketBinding {
  /** The user, session, agent and project this socket serves. */
  readonly identity: SocketIdentity;

  /** The session record as it was when `hello` was accepted. */
  readonly session: SessionRecord;

  /** The client identifier from `hello`, if it sent one (Plan §12.4). */
  readonly client: string | undefined;

  /**
   * Sends a frame. Silently does nothing once the socket is closed, so a
   * delivery racing a disconnect is not an error anybody has to handle.
   *
   * This is the delivery seam, and therefore where {@link MAX_BUFFERED_BYTES} is
   * enforced: a frame that leaves the socket's buffer over the bound closes it.
   * The frame itself is still written first, and is replayed like any other
   * unacknowledged message. See the module note.
   */
  send(frame: ServerFrame): void;

  /** Closes the socket, sending the matching `error` frame first. */
  close(reason: CloseReason): void;

  /**
   * Bytes queued for a peer that has not read them, if the transport says.
   *
   * A live reading, not a snapshot: `../websocket/registry.ts` files this object
   * as its `DeliverySocket`, and `../routing/router.ts` reads it on every
   * delivery to warn about a consumer falling behind.
   *
   * Optional for the same reason {@link FrameSocket.bufferedAmount} is, and it
   * is the same value: a transport that does not report queued bytes leaves both
   * `undefined`, and neither the warning nor the bound has anything to act on.
   */
  readonly bufferedBytes?: number | undefined;

  /**
   * Waits until the peer has read enough for another frame to be worth writing.
   *
   * **This is the back-pressure a bulk writer owes the transport, and the reason
   * a backlog of any legal size can be replayed.** A caller that writes only
   * after this resolves `ready` leaves at most
   * {@link DRAIN_RESUME_BYTES} + `MAX_FRAME_BYTES` queued, so it cannot reach
   * {@link MAX_BUFFERED_BYTES} however many messages it has to write or however
   * fast it writes them. Without it the only thing standing between a large
   * replay and the ceiling was a race between two speeds, which a loaded machine
   * lost and an idle one won — the shape of T-053.
   *
   * Resolves immediately, without a timer, whenever the socket is already under
   * the mark or the transport does not report `bufferedAmount`, so an ordinary
   * listener pays a microtask per message and nothing else.
   *
   * `closed` is not an error: the socket had already gone, or this call gave up
   * on a peer that read nothing at all for {@link DRAIN_STALL_TIMEOUT_MS} and
   * closed it with {@link CloseCode.BACKLOG_UNREAD}. Either way the caller
   * should stop writing; nothing is lost, because nothing it wrote was ever
   * acknowledged.
   *
   * Optional for the same reason {@link bufferedBytes} is — a binding somebody
   * else builds may not have one — and a caller that finds it missing simply has
   * no back-pressure, exactly as it had none before this existed.
   */
  drain?(): Promise<DrainOutcome>;
}

/**
 * The hooks the rest of milestone 3 attaches to a socket.
 *
 * Every method is optional and every one is awaited, so an implementation may
 * be synchronous. This is the whole seam between the handshake and everything
 * that uses it:
 *
 * - `bound` is where T-307 registers the socket under `(agentId, projectId)`
 *   and T-308 replays the pending inbox. It runs **before** the `ready` frame
 *   is sent and returns the count that frame carries, which is the ordering
 *   Plan §4.3 specifies: replay each message, then `ready` with `pending: n`.
 * - `acked` is T-308's acknowledgement half.
 * - `pinged` is informational; this module has already sent the `pong`, because
 *   liveness must not depend on a hook being installed.
 * - `closed` is where T-307 deregisters and T-309 marks the session stale.
 *
 * A hook that throws closes the socket with `CloseCode.INTERNAL_ERROR`
 * and logs — it does not take the process down, and it does not leave a socket
 * half-registered while pretending the handshake succeeded.
 */
export interface ConnectionObserver {
  /**
   * The socket has bound to a session.
   *
   * @param binding - The bound socket.
   * @returns How many messages were replayed, for the `ready` frame.
   */
  bound?(binding: SocketBinding): Promise<number> | number;

  /**
   * The client acknowledged a message.
   *
   * @param binding - The bound socket.
   * @param messageId - The message being acknowledged.
   */
  acked?(binding: SocketBinding, messageId: string): Promise<void> | void;

  /**
   * The client sent a `ping`. The `pong` has already gone out.
   *
   * @param binding - The bound socket.
   */
  pinged?(binding: SocketBinding): Promise<void> | void;

  /**
   * The socket is gone, for any reason including a refusal.
   *
   * Called exactly once per connection, and only if `bound` ran — an
   * unauthenticated or never-bound socket has nothing to clean up.
   *
   * @param binding - The socket that closed.
   * @param code - The close code it went out with.
   */
  closed?(binding: SocketBinding, code: number): Promise<void> | void;
}

/** What {@link createWebSocketHandler} needs. */
export interface WebSocketHandlerOptions {
  /** The HS256 secret access tokens are signed with. */
  readonly jwtSecret: string;

  /** How sessions are resolved. See {@link SessionLookup}. */
  readonly sessions: SessionLookup;

  /** Where connection events go. */
  readonly logger: SocketLogger;

  /** Delivery, registry and heartbeat hooks. See {@link ConnectionObserver}. */
  readonly observer?: ConnectionObserver | undefined;

  /** The clock, injectable so token expiry is testable. */
  readonly now?: (() => Date) | undefined;

  /**
   * The oldest client release this server will serve, enforced on the upgrade.
   *
   * Defaults to `MIN_CLIENT_VERSION`, which is what `../app.ts` gets by passing
   * nothing. See {@link clientVersionRefusal}.
   */
  readonly minClientVersion?: string | undefined;

  /**
   * The outbound back-pressure numbers, injectable so the drain loop is
   * testable without waiting seconds for a deadline or writing megabytes to
   * reach a threshold. Production uses the constants.
   */
  readonly backPressure?: BackPressureOptions | undefined;
}

/** One live connection, driven by the transport adapter. */
export interface SocketConnection {
  /** The bound session's identity, or `null` before `hello` is accepted. */
  readonly identity: SocketIdentity | null;

  /**
   * Handles one arriving message.
   *
   * Frames are processed strictly in order even when a hook is slow: calls are
   * chained onto one promise rather than run as they arrive. Without that, an
   * `ack` sent immediately after a `hello` could be handled while the `hello`
   * was still awaiting the database, and would be refused for arriving before a
   * handshake that was in fact already under way.
   *
   * Never rejects. Every failure becomes a close.
   *
   * @param raw - The text or bytes of one WebSocket message.
   */
  receive(raw: RawFrame): Promise<void>;

  /**
   * The transport reports the socket is gone.
   *
   * Idempotent, and safe to call after a close this module initiated.
   *
   * @param code - The close code observed.
   */
  disconnected(code: number): Promise<void>;

  /**
   * Closes the socket, sending the matching `error` frame first.
   *
   * @param reason - Why.
   */
  close(reason: CloseReason): void;
}

/** The two things a transport adapter calls. */
export interface WebSocketHandler {
  /**
   * Decides whether an upgrade request may become a socket.
   *
   * @param request - Headers and request target.
   * @returns Accepted with the caller, or refused with a reason.
   */
  authenticate(request: UpgradeRequest): UpgradeDecision;

  /**
   * Takes over an authenticated socket.
   *
   * @param socket - The transport.
   * @param user - The caller {@link WebSocketHandler.authenticate} returned.
   * @param credentialSource - Where the token came from, for the log.
   * @returns The connection to drive.
   */
  connect(
    socket: FrameSocket,
    user: AuthenticatedUser,
    credentialSource?: CredentialSource,
  ): SocketConnection;
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

/**
 * Builds the WebSocket handler.
 *
 * @param options - Secret, session lookup, logger and hooks.
 * @returns A handler an adapter can register on any transport.
 */
export function createWebSocketHandler(options: WebSocketHandlerOptions): WebSocketHandler {
  const { jwtSecret, sessions, logger } = options;
  const observer = options.observer ?? {};
  const now = options.now ?? (() => new Date());
  const minClientVersion = options.minClientVersion ?? MIN_CLIENT_VERSION;
  const backPressure = backPressureSettings(options.backPressure);

  return {
    authenticate(request: UpgradeRequest): UpgradeDecision {
      const decision = authenticateUpgrade(request, { jwtSecret, now, minClientVersion });

      if (decision.outcome === 'refused') {
        // `code` is logged alongside `reason` because the refusals are no
        // longer all the same one. An operator whose users have suddenly
        // stopped connecting needs to see `UPGRADE_REQUIRED` rather than infer
        // it from prose, and the 426 itself only ever reaches the person being
        // refused — the same argument `../routes/version.ts` makes for logging
        // its own refusal.
        logger.info(
          {
            code: decision.reason.error,
            reason: decision.reason.detail,
            url: redactUpgradeUrl(request.url),
          },
          'websocket upgrade rejected',
        );
        return decision;
      }

      if (decision.credentialSource === 'query') {
        // Worth a warning rather than an info line: the operator's access log
        // has already recorded this URL, and this is the entry that tells them
        // to go and look at what their proxy retains.
        logger.warn(
          { userId: decision.user.id, url: redactUpgradeUrl(request.url) },
          'websocket authenticated from a token in the url; the header is preferred',
        );
      }

      return decision;
    },

    connect(
      socket: FrameSocket,
      user: AuthenticatedUser,
      credentialSource: CredentialSource = 'header',
    ): SocketConnection {
      return createConnection({
        socket,
        user,
        credentialSource,
        sessions,
        logger,
        observer,
        backPressure,
      });
    },
  };
}

/**
 * What resolving a `hello`'s session came to: the record, or the refusal.
 *
 * A tagged pair rather than `SessionRecord | CloseReason`, because narrowing
 * that union means testing for a field one of the two happens not to have, and
 * a field added to either type later would silently change which branch runs.
 */
type SessionResolution =
  | { readonly outcome: 'session'; readonly session: SessionRecord }
  | { readonly outcome: 'refused'; readonly reason: CloseReason };

/**
 * Waits, as a promise.
 *
 * The one timer this module owns. It is only ever waited on while a socket is
 * over {@link DRAIN_RESUME_BYTES}, so an idle server schedules nothing.
 *
 * @param ms - How long to wait.
 * @returns A promise that settles after that long.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Everything one connection needs. */
interface ConnectionOptions {
  readonly socket: FrameSocket;
  readonly user: AuthenticatedUser;
  readonly credentialSource: CredentialSource;
  readonly sessions: SessionLookup;
  readonly logger: SocketLogger;
  readonly observer: ConnectionObserver;
  readonly backPressure: BackPressureSettings;
}

/**
 * Drives one socket from its first frame to its close.
 *
 * @param options - The socket, its caller, and the collaborators.
 * @returns The connection the adapter drives.
 */
function createConnection(options: ConnectionOptions): SocketConnection {
  const { socket, user, credentialSource, sessions, logger, observer, backPressure } = options;

  /** Set by a successful `hello`. Its presence *is* "the handshake is done". */
  let binding: SocketBinding | null = null;

  /** Whether anything may still be written to the socket. */
  let open = true;

  /** Whether {@link ConnectionObserver.closed} has run. */
  let notifiedClosed = false;

  /** The tail of the in-order frame queue. See {@link SocketConnection.receive}. */
  let queue: Promise<void> = Promise.resolve();

  /** Unknown frame types seen, so a newer client logs once per type, not per frame. */
  const ignoredTypes = new Set<string>();

  /** The fields every log line from this connection carries. */
  function context(): Record<string, unknown> {
    return binding === null
      ? { userId: user.id, credentialSource }
      : {
          userId: user.id,
          credentialSource,
          sessionId: binding.identity.sessionId,
          agentId: binding.identity.agentId,
          projectId: binding.identity.projectId,
        };
  }

  function send(frame: ServerFrame): void {
    if (!open) {
      return;
    }

    try {
      socket.send(encodeFrame(frame));
    } catch (error: unknown) {
      // A send failing means the peer is gone. There is nothing to tell it, and
      // throwing here would turn a lost peer into an unhandled rejection in
      // whatever was delivering.
      logger.info({ ...context(), err: error }, 'websocket send failed');
      open = false;
    }
  }

  /**
   * Ends the connection: nothing more is written, the transport is closed, and
   * the observer hears about it once.
   *
   * Shared by the two ways a socket ends on this server's initiative — a
   * {@link CloseReason} refusal, and the orderly drop of a peer that is not
   * reading — so that neither can grow a cleanup step the other lacks.
   *
   * @param code - The close code to go out with.
   * @param text - The close reason, already within the transport's limit.
   */
  function shutdown(code: number, text: string): void {
    open = false;
    try {
      socket.close(code, text);
    } catch (error: unknown) {
      logger.info({ ...context(), err: error }, 'websocket close failed');
    }

    void notifyClosed(code);
  }

  function close(reason: CloseReason): void {
    if (!open) {
      return;
    }

    // The error frame goes first so a client that only reads frames still
    // learns the contract code; the close code is for one that only reads
    // close codes. Neither kind of client has to be the one this server assumes.
    send(errorFrame(reason));

    logger.info(
      { ...context(), closeCode: reason.code, code: reason.error, reason: reason.detail },
      'websocket closed by server',
    );

    shutdown(reason.code, closeReasonText(reason));
  }

  /**
   * Sends a delivered frame, and closes the socket if the peer is not reading.
   *
   * What {@link SocketBinding.send} is bound to, and the only place the outbound
   * bound is checked: replay and the router are the sole unbounded sources of
   * frames, and both arrive here. The order matters and is not an accident — the
   * frame is written *before* the buffer is measured, so the message that trips
   * the bound is never one this server decided not to send. It is unacknowledged
   * whichever way that write went, and the next `hello` replays it.
   *
   * @param frame - The frame delivery wants written.
   */
  function deliver(frame: ServerFrame): void {
    send(frame);

    if (!open) {
      return;
    }

    const buffered = socket.bufferedAmount;
    if (buffered === undefined || buffered <= MAX_BUFFERED_BYTES) {
      return;
    }

    // `warn`, because an operator wants the reading and the listener, not just
    // the fact. The close code says *what* happened and is what a client
    // branches on; this line says how far past the bound it got and to whom.
    logger.warn(
      { ...context(), bufferedBytes: buffered, limitBytes: MAX_BUFFERED_BYTES },
      'websocket peer is not reading; closing it before its backlog exhausts the process',
    );

    shutdown(CloseCode.BACKLOG_UNREAD, UNREAD_CLOSE_REASON);
  }

  /**
   * Waits until the peer has read enough for another frame to be worth writing.
   *
   * What {@link SocketBinding.drain} is bound to. The loop is deliberately dull:
   * ask the transport how much is queued, and if it is over the mark, wait and
   * ask again. Everything interesting is in the two ways out.
   *
   * **Progress, not patience, is what is measured.** Every observed fall in
   * `bufferedAmount` restarts the deadline, so a peer on a slow link is waited
   * on for as long as it keeps taking bytes, and only one that has moved nothing
   * at all for {@link BackPressureSettings.stallTimeoutMs} is given up on. A
   * duration-based deadline would close exactly the listeners a replay exists to
   * serve — the ones with a large backlog and a modest link.
   *
   * **A peer that has stopped is still closed, and says so differently.** The
   * close code is {@link CloseCode.BACKLOG_UNREAD}, the same one
   * {@link deliver} uses, because the remedy a client must apply is the same:
   * read your socket, then reconnect. The reason and the log line are not, so an
   * operator can tell a fan-out that piled up on a peer that walked away from a
   * replay that the peer stopped taking (T-053).
   *
   * The clock is `Date.now()` rather than the injected `now`, which is the token
   * clock and is frozen in tests. This measures an elapsed duration, not a point
   * in time, and freezing it would turn "the peer has stopped" into "the peer
   * cannot stop".
   *
   * @returns Whether the caller may write, or should stop.
   */
  async function drain(): Promise<DrainOutcome> {
    if (!open) {
      return 'closed';
    }

    // The fast path, and the one every healthy listener takes: no timer, no
    // scheduling, nothing but a property read.
    let buffered = socket.bufferedAmount;
    if (buffered === undefined || buffered <= backPressure.resumeBytes) {
      return 'ready';
    }

    let lowest = buffered;
    let lastProgress = Date.now();

    for (;;) {
      await sleep(backPressure.pollIntervalMs);

      if (!open) {
        // Closed under us: the peer disconnected, the fan-out tripped the
        // ceiling, or the server is shutting down. Nothing to write to.
        return 'closed';
      }

      buffered = socket.bufferedAmount;
      if (buffered === undefined || buffered <= backPressure.resumeBytes) {
        return 'ready';
      }

      if (buffered < lowest) {
        lowest = buffered;
        lastProgress = Date.now();
        continue;
      }

      if (Date.now() - lastProgress < backPressure.stallTimeoutMs) {
        continue;
      }

      // `warn` for the same reason `deliver` warns: an operator wants the
      // reading and the listener, not just the fact. A different message from
      // `deliver`'s, because this is a different event — a replay abandoned
      // before `ready`, not a fan-out that outran a peer.
      logger.warn(
        {
          ...context(),
          bufferedBytes: buffered,
          resumeBytes: backPressure.resumeBytes,
          stalledForMs: Date.now() - lastProgress,
        },
        'websocket peer stopped reading during replay; closing it rather than waiting forever',
      );

      shutdown(CloseCode.BACKLOG_UNREAD, STALLED_REPLAY_CLOSE_REASON);
      return 'closed';
    }
  }

  /**
   * Tells the observer once, whatever order the close arrives in.
   *
   * @param code - The close code.
   */
  async function notifyClosed(code: number): Promise<void> {
    if (notifiedClosed || binding === null) {
      return;
    }
    notifiedClosed = true;

    try {
      await observer.closed?.(binding, code);
    } catch (error: unknown) {
      // The socket is already gone; there is no one to refuse. A registry that
      // failed to clean up is the operator's problem, and this is how they hear.
      logger.error({ ...context(), err: error }, 'websocket close hook failed');
    }
  }

  /**
   * Resolves the session a `hello` names, or says why it will not do.
   *
   * Ownership is not a comparison written here: `list` is scoped to the caller
   * in SQL, so a session belonging to anybody else is simply not in the result.
   * `includeEnded` is on so an ended session is found and refused for being
   * ended — in the log; on the wire it is the same refusal as an unknown id,
   * because the id is the thing that must not be confirmed.
   *
   * A `stale` session is revived rather than refused, and the *revived* record
   * is what binds, so `SocketBinding.session.status` is `active` for every
   * bound socket regardless of which status it arrived in. See the module
   * documentation for why.
   *
   * @param sessionId - The session from the frame.
   * @returns The session to bind, or the refusal to close with.
   */
  async function resolveSession(sessionId: SessionId): Promise<SessionResolution> {
    const owned = await sessions.list({ userId: user.id, includeEnded: true });
    const session = owned.find((candidate) => candidate.id === sessionId);

    if (session === undefined) {
      return {
        outcome: 'refused',
        reason: sessionInvalid(`session ${sessionId} does not exist or is not the caller's`),
      };
    }

    if (session.status === SESSION_STATUS.ENDED) {
      // Terminal, and the one status a `hello` cannot argue with. The remedy is
      // a new registration, which is the caller's decision (protocol §10.4).
      return {
        outcome: 'refused',
        reason: sessionInvalid(`session ${sessionId} is ${session.status}, not active`),
      };
    }

    if (session.status === SESSION_STATUS.ACTIVE) {
      return { outcome: 'session', session };
    }

    // Stale, and this frame is the evidence that contradicts it. See
    // `createWebSocketHandler` for why refusing here ended listeners
    // permanently.
    let revived: SessionRecord;
    try {
      revived = await sessions.heartbeat({ userId: user.id, sessionId: session.id });
    } catch (error: unknown) {
      // The only expected failure is the session ending between the read above
      // and the write — the sweeper's, or the client's own `DELETE` racing its
      // reconnect. `ended` is terminal either way, so this is the same refusal
      // the branch above gives, reached a moment later.
      logger.warn(
        { ...context(), sessionId, err: error },
        'websocket could not revive a stale session',
      );
      return {
        outcome: 'refused',
        reason: sessionInvalid(`session ${sessionId} could not be revived`),
      };
    }

    logger.info({ ...context(), sessionId }, 'websocket revived a stale session on hello');

    return { outcome: 'session', session: revived };
  }

  /**
   * Handles the `hello`.
   *
   * @param frame - The parsed frame.
   */
  async function bind(frame: HelloFrame): Promise<void> {
    if (binding !== null) {
      close(outOfOrder('hello arrived on a socket that is already bound'));
      return;
    }

    let resolved: SessionResolution;
    try {
      resolved = await resolveSession(frame.sessionId);
    } catch (error: unknown) {
      logger.error({ ...context(), err: error }, 'websocket session lookup failed');
      close(internalFailure('session lookup failed'));
      return;
    }

    if (resolved.outcome === 'refused') {
      close(resolved.reason);
      return;
    }

    const { session } = resolved;
    const identity: SocketIdentity = {
      userId: user.id,
      sessionId: session.id,
      agentId: session.agentId,
      projectId: session.projectId,
    };

    const bound: SocketBinding = {
      identity,
      session,
      client: frame.client,
      send: deliver,
      close,
      drain,
      get bufferedBytes(): number | undefined {
        return socket.bufferedAmount;
      },
    };
    binding = bound;

    let pending = 0;
    try {
      pending = (await observer.bound?.(bound)) ?? 0;
    } catch (error: unknown) {
      logger.error({ ...context(), err: error }, 'websocket bind hook failed');
      close(internalFailure('bind hook failed'));
      return;
    }

    logger.info({ ...context(), client: frame.client, pending }, 'websocket bound to session');

    // After the replay `bound` performed, per Plan §4.3: every pending message,
    // then the count of them. A client that has read `ready` knows its backlog
    // is behind it.
    send({ type: 'ready', sessionId: identity.sessionId, pending });
  }

  /**
   * Routes one validated frame.
   *
   * @param frame - The parsed frame.
   */
  async function dispatch(frame: ClientFrame): Promise<void> {
    if (frame.type === 'hello') {
      await bind(frame);
      return;
    }

    if (binding === null) {
      close(outOfOrder(`${frame.type} frame arrived before hello`));
      return;
    }

    if (frame.type === 'ping') {
      // Answered before the hook runs. Liveness is this module's promise and
      // must not depend on a hook being installed or being quick.
      send({ type: 'pong' });
      await observer.pinged?.(binding);
      return;
    }

    await observer.acked?.(binding, frame.messageId);
  }

  /**
   * Decodes and acts on one arriving message.
   *
   * @param raw - The text or bytes.
   */
  async function handle(raw: RawFrame): Promise<void> {
    if (!open) {
      return;
    }

    const decoded = decodeFrame(raw);

    if (decoded.kind === 'rejected') {
      close(decoded.reason);
      return;
    }

    if (decoded.kind === 'ignored') {
      // The additive-only rule (Plan §12.4). Not an error, not answered, and
      // logged once per type so a newer client talking to an older server is
      // visible to an operator without flooding anything.
      if (!ignoredTypes.has(decoded.type)) {
        ignoredTypes.add(decoded.type);
        logger.info(
          { ...context(), frameType: decoded.type },
          'ignoring unknown frame type; the client may be newer than this server',
        );
      }
      return;
    }

    try {
      await dispatch(decoded.frame);
    } catch (error: unknown) {
      logger.error(
        { ...context(), err: error, frameType: decoded.frame.type },
        'websocket frame handling failed',
      );
      close(internalFailure(`handling a ${decoded.frame.type} frame failed`));
    }
  }

  return {
    get identity(): SocketIdentity | null {
      return binding?.identity ?? null;
    },

    receive(raw: RawFrame): Promise<void> {
      // Chained, not concurrent. See SocketConnection.receive for why.
      queue = queue.then(() => handle(raw));
      return queue;
    },

    async disconnected(code: number): Promise<void> {
      open = false;
      await notifyClosed(code);
    },

    close,
  };
}
