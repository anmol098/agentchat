/**
 * The real-time entry point: authenticate the upgrade, require a `hello`, and
 * validate every frame after it.
 *
 * A socket goes through exactly two gates before it can carry anything.
 *
 * 1. **Authentication**, at the upgrade. {@link authenticateUpgrade} verifies an
 *    access token and yields the user, or refuses. No token, no socket.
 * 2. **Binding**, on the first frame. That frame must be `hello`, and the
 *    session it names must exist, be `active`, and belong to the authenticated
 *    user. Until then the connection has an identity but no session, and every
 *    other known frame is refused.
 *
 * The two are separate because they answer different questions. The token says
 * *who*; the `hello` says *as which listener*, and only the session knows the
 * agent and project that make delivery addressable.
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

import type { SessionId } from '@agentchat/protocol';
import { type AccessTokenClaims, verifyAccessToken } from '../auth/tokens.js';
import type { AuthenticatedUser } from '../plugins/auth.js';
import { SESSION_STATUS, type SessionRecord, type SessionService } from '../services/sessions.js';
import {
  type ClientFrame,
  type CloseReason,
  closeReasonText,
  decodeFrame,
  encodeFrame,
  errorFrame,
  type HelloFrame,
  internalFailure,
  outOfOrder,
  type RawFrame,
  type ServerFrame,
  type SocketIdentity,
  sessionInvalid,
  unauthenticated,
} from './frames.js';

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

/** What {@link redactUpgradeUrl} puts where a token was. */
export const REDACTED_TOKEN = '[redacted]';

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

/** The upgrade did not. */
export interface UpgradeRefused {
  readonly outcome: 'refused';

  /**
   * Why, in both registers. A caller that can still answer HTTP should reply
   * `401` with a `WWW-Authenticate: Bearer` challenge; one that has already
   * completed the handshake closes with `CloseCode.UNAUTHENTICATED`.
   */
  readonly reason: CloseReason;
}

/** The verdict on an upgrade request. */
export type UpgradeDecision = UpgradeAccepted | UpgradeRefused;

/** What {@link authenticateUpgrade} needs to verify a token. */
export interface UpgradeAuthOptions {
  /** The HS256 secret access tokens are signed with. */
  readonly jwtSecret: string;

  /** The clock, injectable so expiry is testable. Defaults to the wall clock. */
  readonly now?: (() => Date) | undefined;
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
 * Decides whether an upgrade request may become a socket.
 *
 * Header first, query string only if there is no `Authorization` header at all.
 * A present-but-unusable header is a refusal, not a reason to look in the URL:
 * falling through would mean a client with a broken header and a token in its
 * URL connects anyway, and nobody ever finds out the header was wrong.
 *
 * Every refusal is the same {@link CloseReason} — missing, malformed, expired,
 * forged — with the cause in `detail` for the log only, following the 401 in
 * `../plugins/auth.ts`. Never throws.
 *
 * @param request - The upgrade request's headers and target.
 * @param options - The signing secret and, for tests, a clock.
 * @returns Accepted with the caller, or refused with a reason.
 */
export function authenticateUpgrade(
  request: UpgradeRequest,
  options: UpgradeAuthOptions,
): UpgradeDecision {
  const now = options.now ?? (() => new Date());
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
}

/** The logging calls this module makes. pino's `Logger` satisfies it. */
export interface SocketLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

/**
 * How the handler finds a session.
 *
 * Deliberately `list` and not a lookup by id. `list` scopes to the caller in
 * SQL — it is driven from `agents` with the owner in the join — so it is
 * structurally incapable of returning somebody else's session, and the
 * ownership half of the `hello` check is therefore not a comparison this module
 * could forget to write. A lookup by id would hand back a row belonging to
 * anybody and leave the check to a line of TypeScript.
 */
export type SessionLookup = Pick<SessionService, 'list'>;

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
   */
  send(frame: ServerFrame): void;

  /** Closes the socket, sending the matching `error` frame first. */
  close(reason: CloseReason): void;
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

  return {
    authenticate(request: UpgradeRequest): UpgradeDecision {
      const decision = authenticateUpgrade(request, { jwtSecret, now });

      if (decision.outcome === 'refused') {
        logger.info(
          { reason: decision.reason.detail, url: redactUpgradeUrl(request.url) },
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

/** Everything one connection needs. */
interface ConnectionOptions {
  readonly socket: FrameSocket;
  readonly user: AuthenticatedUser;
  readonly credentialSource: CredentialSource;
  readonly sessions: SessionLookup;
  readonly logger: SocketLogger;
  readonly observer: ConnectionObserver;
}

/**
 * Drives one socket from its first frame to its close.
 *
 * @param options - The socket, its caller, and the collaborators.
 * @returns The connection the adapter drives.
 */
function createConnection(options: ConnectionOptions): SocketConnection {
  const { socket, user, credentialSource, sessions, logger, observer } = options;

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

    open = false;
    try {
      socket.close(reason.code, closeReasonText(reason));
    } catch (error: unknown) {
      logger.info({ ...context(), err: error }, 'websocket close failed');
    }

    void notifyClosed(reason.code);
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
   * @param sessionId - The session from the frame.
   * @returns The record, or `undefined` with the reason logged by the caller.
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

    if (session.status !== SESSION_STATUS.ACTIVE) {
      // T-302: only an active session may bind. A stale one is a listener the
      // sweeper has already stopped believing in, and letting it bind would put
      // messages on a socket presence says is not there.
      return {
        outcome: 'refused',
        reason: sessionInvalid(`session ${sessionId} is ${session.status}, not active`),
      };
    }

    return { outcome: 'session', session };
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
      send,
      close,
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
