/**
 * The Fastify application.
 *
 * `createApp` is a factory, not a singleton: it takes its logger and database
 * as arguments and registers routes on a fresh instance. Composition happens in
 * `index.ts`, which is the only module that reads the environment or installs
 * signal handlers, so a test can build a complete server without inheriting a
 * process-wide lifecycle.
 *
 * ## Where authentication is wired (T-019)
 *
 * The device flow (`routes/auth.ts`), the token service (`auth/tokens.ts`) and
 * the bearer-token plugin (`plugins/auth.ts`) are three modules that each take
 * their collaborators as arguments and know nothing about each other. This is
 * the file where they meet, and the meeting has four parts:
 *
 * 1. {@link PUBLIC_ROUTES} names the unauthenticated surface, and an `onRoute`
 *    hook stamps `config.auth = 'public'` on those routes as they register.
 *    Every other route is protected because it said nothing — see the note in
 *    `plugins/auth.ts` on why the default is the strict one.
 * 2. `registerAuth` runs **first**, before any route. It has to: its own
 *    `onRoute` hook logs the public surface, and an `onRoute` hook is a
 *    registration-time notification that fires only for routes added after it.
 *    (Its `onRequest` guard is not order-sensitive — Fastify assembles the
 *    request hook chain at ready time, so it covers routes registered before
 *    the call as well. `plugins/auth.test.ts` asserts that, and
 *    `server/tests/app.test.ts` asserts it again against this wiring, because
 *    the whole scheme fails open if it ever stops being true.)
 * 3. The token service is built over the Drizzle handle and adapted to the one
 *    method `routes/auth.ts` asks for. See {@link createApp}.
 * 4. The identity provider is built from configuration, or supplied by the
 *    caller. `AppOptions.identityProvider` is the seam `auth/identity.ts`
 *    describes: a self-hoster on a different provider replaces one object here
 *    and no route, schema, error code or test moves.
 *
 * ## Where the product surface is wired (T-023)
 *
 * The project, invite, agent and session route modules are wired at the end of
 * {@link createApp}, together with the session sweeper; the message and
 * conversation modules joined them in T-038, a little further down because they
 * need the delivery service. Each was written by a task that correctly declined
 * to edit this file, so until that block existed every one of them was
 * complete, tested and unreachable — the third time on this project that
 * finished work sat behind an unowned one-line seam.
 *
 * None of those routes is named in {@link PUBLIC_ROUTES}, which is the whole of
 * their authentication. `GET /invites/:code` is the one that reads like an
 * exception and is not: it relaxes authorization, not authentication. See the
 * comment at the registration site.
 *
 * ## Where the WebSocket endpoint is wired (T-033)
 *
 * The fourth instance of the same shape, and the first one created before the
 * work rather than found after it. `websocket/handler.ts` was written against
 * structural interfaces and took no transport dependency; `websocket/registry.ts`
 * and `routing/router.ts` were written against each other; `routing/delivery.ts`
 * was written to *be* the handshake's observer. All four were finished, tested
 * and unreachable, because nothing accepted an upgrade.
 *
 * {@link registerWebSocketEndpoint} is what accepts one, and three decisions in
 * this file decide the rest of it.
 *
 * 1. **The registry is held here and nowhere else.** {@link createApp} builds
 *    it and hands it to exactly two collaborators — the router, which finds
 *    sockets through it, and the delivery service, which files and releases one
 *    from the handshake's `bound` and `closed` hooks. Nothing else is given a
 *    reference, which is the constraint `routing/router.ts` names as the
 *    difference between a cross-instance router being a constructor swap and
 *    being a rewrite.
 * 2. **Observers are composed, not chosen.** `ConnectionObserver` has one
 *    `closed` hook and more than one thing wants it: delivery deregisters the
 *    socket, and the heartbeat (T-309) has to stop its timers and mark the
 *    session stale. {@link composeConnectionObservers} is the answer, so
 *    adding the second is one entry in an array rather than an argument about
 *    who owns the hook.
 * 3. **Shutdown runs sockets, then HTTP, then the pool.** See the `preClose`
 *    hook at the end of {@link createApp} for why it is `preClose` and not
 *    `onClose`, which is not a style preference — the other one hangs.
 *
 * ## Where a send becomes a delivery (T-038)
 *
 * The fifth instance of the same shape, and the one the product is named after.
 * The message and conversation routes were finished and unregistered; the
 * delivery service was finished, wired into the handshake, and its fan-out had
 * no possible caller. A message sent to a connected agent was persisted and
 * never pushed — durable, replayed on the listener's next reconnect, and a
 * reconnect late.
 *
 * Both halves are closed at one site, because closing either alone is worse
 * than closing neither: registering the routes without the hook produces sends
 * that persist and never push, which looks correct until somebody measures
 * latency.
 *
 * The hook is `createDeliveringMessageService` from `routing/delivery.ts`, and
 * the decision it encodes is that the ordering is **structural rather than
 * remembered**. `deliver` must run after `send` commits, and a route holding
 * both calls is a route that can put them in the wrong order or omit the
 * second — once here, and again in every future caller. So the route is handed
 * a `MessageService` that already delivers, and never learns that sockets
 * exist. The registration site says the rest.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { STATUS_CODES } from 'node:http';
import type { Duplex } from 'node:stream';
import { ErrorCode, errorEnvelope } from '@agentchat/protocol';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import pino, { type Logger } from 'pino';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import { createGitHubIdentityProvider } from './auth/github.js';
import type { IdentityProvider } from './auth/identity.js';
import { createDrizzleRefreshTokenStore, createTokenService } from './auth/tokens.js';
import type { ServerConfig } from './config.js';
import { HTTP_STATUS_BY_ERROR_CODE, SERVER_ERROR_FLOOR, toErrorResponse } from './errors.js';
import { registerAuth, WWW_AUTHENTICATE_CHALLENGE } from './plugins/auth.js';
import { registerAgentRoutes } from './routes/agents.js';
import { createUserDirectory, registerAuthRoutes, type TokenIssuer } from './routes/auth.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { type HealthProbe, registerHealthRoutes } from './routes/health.js';
import { registerInviteRoutes } from './routes/invites.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerSessionRoutes } from './routes/sessions.js';
import {
  createDeliveringMessageService,
  createDeliveryService,
  createSenderDirectory,
} from './routing/delivery.js';
import { createInProcessRouter } from './routing/router.js';
import { createAgentService } from './services/agents.js';
import { createAuthorizationService } from './services/authorization.js';
import { createConversationService } from './services/conversations.js';
import { createInboxService } from './services/inbox.js';
import { createMessageService } from './services/messages.js';
import { createSessionService, startSessionSweeper } from './services/sessions.js';
import { CloseCode, MAX_FRAME_BYTES, type RawFrame } from './websocket/frames.js';
import {
  type ConnectionObserver,
  createWebSocketHandler,
  type SocketBinding,
  type WebSocketHandler,
} from './websocket/handler.js';
import { createSocketRegistry } from './websocket/registry.js';

/** Header carrying a request identifier assigned upstream, if there is one. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Request identifiers accepted from a caller.
 *
 * A request id is written verbatim into every log line for that request, so an
 * unchecked one is a log-injection channel: newlines would forge log records
 * and an unbounded string would bloat them. Anything that does not match is
 * replaced by a generated identifier rather than rejected, because a malformed
 * trace header is not a reason to fail a health check.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * The routes that answer without credentials, from Plan §3.
 *
 * This list is the entire unauthenticated surface of the server, and it is a
 * list rather than a prefix rule so that `/auth/device/start` being public
 * cannot quietly make `/auth/sessions` public too.
 *
 * It is declared here, at the wiring site, because the two modules that
 * register these routes take no say in it: `routes/health.ts` and
 * `routes/auth.ts` are libraries of routes, and whether a given deployment
 * exposes them without a token is a property of the application that assembles
 * them. Both directions of drift fail safe. A route renamed out of this list
 * becomes protected and its first caller gets a 401 — a bug report. A route
 * added to a module without being named here is protected too, which is the
 * default `plugins/auth.ts` chose and the reason it chose it.
 *
 * `/version` is listed before it exists. It is unauthenticated in Plan §3, the
 * task that adds it should not have to also discover this file, and a name that
 * matches no route marks nothing.
 */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  '/healthz',
  '/version',
  '/auth/device/start',
  '/auth/device/poll',
]);

/**
 * Where the WebSocket lives.
 *
 * The same path `packages/client` ships as `DEFAULT_WEBSOCKET_PATH`, restated
 * rather than imported: `@agentchat/client` is a client library and is not a
 * dependency of the server. It is deliberately *not* in {@link PUBLIC_ROUTES},
 * and it is not a Fastify route at all — an upgrade never reaches the router.
 * See {@link registerWebSocketEndpoint} for what authenticates it instead.
 */
export const WEBSOCKET_PATH = '/ws';

/** Base for resolving an upgrade target's path. Never dereferenced. */
const UPGRADE_URL_BASE = 'http://localhost';

/** The close reason a socket is given when the process is stopping. */
const SHUTDOWN_CLOSE_REASON = 'server is shutting down';

/**
 * How long a socket is given to complete its closing handshake at shutdown.
 *
 * A WebSocket is a connection the HTTP server will wait for indefinitely, so
 * something has to decide when a peer that is not answering stops being a
 * reason to keep the process alive. One second is far longer than a close
 * handshake over a live connection needs and far shorter than
 * `SHUTDOWN_TIMEOUT_MS`, which is the deadline that ends in a non-zero exit and
 * a log line nobody can act on. Whatever is still open afterwards is
 * terminated; the client reconnects, its `hello` replays the inbox, and nothing
 * it was owed is lost.
 */
const SOCKET_CLOSE_GRACE_MS = 1_000;

/**
 * The database surface the application needs.
 *
 * Two things, for two reasons. `ping` is the health check's, narrowed by
 * `HealthProbe` so that route cannot grow a dependency on the pool. `db` is the
 * Drizzle handle the login flow writes accounts and refresh tokens through;
 * `createDatabase` returns exactly this shape, so `index.ts` passes its handle
 * unchanged.
 *
 * `TSchema` is carried through rather than pinned to the empty schema so that a
 * handle built with `createDatabase({ schema })` still fits. Nothing here uses
 * the relational query API; the parameter exists only so registering models
 * later is not a breaking change to this signature.
 */
export interface AppDatabase<TSchema extends Record<string, unknown> = Record<string, never>>
  extends HealthProbe {
  /** Drizzle query interface over the process-wide pool. */
  readonly db: NodePgDatabase<TSchema>;
}

/** Options for {@link createAppShell}. */
export interface AppShellOptions {
  /** Validated configuration. */
  readonly config: ServerConfig;
  /** Database handle the health check probes. */
  readonly database: HealthProbe;
  /** Logger the server and every request log through. */
  readonly logger: Logger;
}

/** Options for {@link createApp}. */
export interface AppOptions<TSchema extends Record<string, unknown> = Record<string, never>>
  extends AppShellOptions {
  /** Database handle the health check probes and the login flow writes through. */
  readonly database: AppDatabase<TSchema>;
  /**
   * Brokers the device flow.
   *
   * Defaults to the GitHub adapter built from
   * {@link ServerConfig.identityProvider}. Supplying one is how a self-hoster
   * points at a different provider — the seam `auth/identity.ts` exists for —
   * and how the integration suite completes a login without reaching
   * github.com.
   */
  readonly identityProvider?: IdentityProvider;
}

/**
 * Creates the process logger.
 *
 * Writes newline-delimited JSON to stdout, synchronously. Synchronous writes
 * cost throughput this server will not miss and buy the guarantee that the last
 * lines before an exit — the reason for the exit, usually — are actually on the
 * wire rather than sitting in a buffer that the process never flushes.
 *
 * @param config - Supplies the log level and environment name.
 * @returns A pino logger. The caller owns it and passes it to {@link createApp}.
 */
export function createLogger(config: ServerConfig): Logger {
  return pino(
    {
      level: config.logLevel,
      base: { name: 'agentchat-server', env: config.nodeEnv },
      timestamp: pino.stdTimeFunctions.isoTime,
      // Belt and braces. Fastify's default request serializer does not log
      // headers, but a future hook that logs one should not be able to leak a
      // bearer token by accident.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'headers.authorization',
          'headers.cookie',
        ],
        censor: '[redacted]',
      },
    },
    pino.destination({ dest: 1, sync: true }),
  );
}

/**
 * Chooses the identifier for an incoming request.
 *
 * Honours a well-formed `x-request-id` from a proxy so one identifier follows a
 * request across hops, and generates a UUID otherwise.
 */
function generateRequestId(req: {
  headers: Record<string, string | string[] | undefined>;
}): string {
  const supplied = req.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(supplied) ? supplied[0] : supplied;

  return candidate !== undefined && SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();
}

/**
 * Answers a failed request with the protocol envelope.
 *
 * The single place a failure becomes a response, shared by Fastify's error
 * handler and by its framework-error hook. Which code is sent is decided
 * entirely by {@link toErrorResponse}; nothing in this module chooses one, so a
 * route added later cannot reintroduce a string literal by copying a handler.
 *
 * @param error - Whatever failed.
 * @param request - The request that failed, for its log.
 * @param reply - The reply to send on.
 */
function replyWithError(error: unknown, request: FastifyRequest, reply: FastifyReply): void {
  const { statusCode, body } = toErrorResponse(error);

  // The whole error goes to the log either way; what differs is the level and
  // what the caller is told. A 5xx is the server's fault and the operator needs
  // the detail; a 4xx is the caller's, and routine.
  if (statusCode >= SERVER_ERROR_FLOOR) {
    request.log.error({ err: error }, 'request failed');
  } else {
    request.log.info({ err: error }, 'request rejected');
  }

  // Normally the `onSend` hook does this. A framework error is answered on a
  // reply the router built before any route context existed, so no hook runs
  // for it; without this line the one response a caller most wants to quote in
  // a bug report is the only one with no identifier to quote. Setting it twice
  // on the ordinary path is a harmless overwrite with the same value.
  reply.header(REQUEST_ID_HEADER, request.id);

  void reply.code(statusCode).send(body);
}

/**
 * Builds the HTTP shell: everything that is true of every response, and no
 * authentication.
 *
 * That is the request identifier, the log wiring, the body limit, the error
 * envelope, the not-found handler, the {@link PUBLIC_ROUTES} declaration and
 * `/healthz`. What it does *not* have is a way to learn who is calling — so an
 * instance from here serves every route it is given to anybody who asks, and it
 * is not what a deployment runs. {@link createApp} is.
 *
 * It is exported for one purpose: a test of a single route module can host that
 * module under the real error contract, and assert against the envelope a
 * client would actually receive, without also standing up authentication,
 * Postgres and an identity provider it is not testing. Production code calls
 * {@link createApp}.
 *
 * @param options - See {@link AppShellOptions}.
 * @returns A Fastify instance with no credentials of any kind.
 */
export function createAppShell(options: AppShellOptions): FastifyInstance {
  const { config, database, logger } = options;

  // The logger generic is pinned to Fastify's own `FastifyBaseLogger` rather
  // than left to infer pino's `Logger`. Inference would specialise every route,
  // hook and plugin signature on the concrete logger type, and under
  // `exactOptionalPropertyTypes` nothing typed against a plain
  // `FastifyInstance` would fit any more.
  const app = Fastify<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    FastifyBaseLogger
  >({
    loggerInstance: logger,

    // 2 MiB, fixed by Plan §2 so a 1 MiB message plus its JSON envelope fits.
    bodyLimit: config.bodyLimitBytes,

    // `genReqId` reads the header itself, with validation, so Fastify must not
    // also copy it in unchecked.
    requestIdHeader: false,
    genReqId: generateRequestId,

    // Terminating proxies are the norm in the reference deployment, and an
    // access log full of the load balancer's address is useless.
    trustProxy: true,

    // While shutting down, refuse new requests with 503 rather than accepting
    // work that will be cut off mid-flight.
    //
    // This one body is written straight to the socket by Fastify and cannot be
    // intercepted by any hook, so it is not the protocol envelope. It carries
    // no error *code* at all — only a status and a reason phrase — so there is
    // nothing off-contract for a client to branch on, and it is emitted for a
    // few milliseconds during shutdown rather than by any route.
    return503OnClosing: true,

    // Not every framework error reaches `setErrorHandler`. A URL that will not
    // decode, or a route parameter over the router's length limit, is rejected
    // by the router before a route is matched, and Fastify's default for that
    // path writes its own JSON — `{"error":"Bad Request","code":
    // "FST_ERR_BAD_URL",...}` — direct to the socket. That is both the wrong
    // shape and a framework-internal code, and no `onSend` hook or error
    // handler sees it. Supplying this option is the only way to route those
    // through the contract.
    frameworkErrors: replyWithError,
  });

  // Echo the identifier so a caller can quote it in a bug report and an
  // operator can find the request in the log.
  app.addHook('onSend', (request, reply, _payload, done) => {
    reply.header(REQUEST_ID_HEADER, request.id);
    done();
  });

  // The code and its status are both imported rather than written out.
  // `packages/protocol` owns the frozen set, and a literal here is a copy of it
  // that nothing checks — which is how this file came to answer 500s with
  // `INTERNAL_ERROR`, a code the contract has never contained (T-015).
  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(HTTP_STATUS_BY_ERROR_CODE[ErrorCode.NOT_FOUND])
      .send(
        errorEnvelope(
          ErrorCode.NOT_FOUND,
          `Route ${request.method} ${request.url} does not exist.`,
        ),
      );
  });

  // Plan §3: every error is `{ error: { code, message } }` with a stable code.
  //
  // The status and the envelope are both decided by `toErrorResponse`, which is
  // where the contract is enforced: it maps Fastify's own `FST_ERR_*` codes
  // onto the frozen set, falls back to a contract code for anything it does not
  // recognise, and re-checks the result against `ErrorCodeSchema` before it
  // leaves.
  //
  // `error` is annotated because Fastify's overloads otherwise widen it to
  // `unknown` here rather than defaulting to `FastifyError`.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    replyWithError(error, request, reply);
  });

  // Declares the unauthenticated surface as each of those routes registers.
  // Installed before any route, so it covers `/healthz` below and the
  // device-flow routes {@link createApp} adds afterwards.
  app.addHook('onRoute', (route) => {
    if (PUBLIC_ROUTES.has(route.url)) {
      route.config = { ...route.config, auth: 'public' };
    }
  });

  registerHealthRoutes(app, { database });

  return app;
}

/**
 * Runs several {@link ConnectionObserver}s as one.
 *
 * The handshake takes a single observer and there is more than one thing that
 * wants to know when a socket binds and when it goes: `routing/delivery.ts`
 * files the socket in the registry and replays its inbox, and the heartbeat
 * (T-309) keeps timers and marks the session stale. Both want `closed`. Without
 * this function that is a choice between them, and the way that choice is
 * normally made — one observer reaching into the other and calling it — makes
 * two modules that only work in one order.
 *
 * The contract:
 *
 * - **Order is registration order**, for every hook.
 * - **`bound` sums.** The `ready` frame carries how many messages were replayed
 *   and an observer that replays nothing contributes nothing, so the fold that
 *   is correct for one replaying observer is also correct for none and for a
 *   later second. It is not a `Math.max`, which would silently under-report if
 *   two observers ever did replay.
 * - **`bound`, `acked` and `pinged` fail fast.** A throwing hook closes the
 *   socket with `INTERNAL_ERROR`, and running the rest of a handshake that has
 *   already failed would leave state behind for a connection that is going
 *   away. The socket's `closed` still runs, because the handshake sets the
 *   binding before it calls `bound`.
 * - **`closed` runs every observer even when one throws**, and reports the
 *   first failure afterwards. Cleanup is the one place where skipping the rest
 *   of the list leaks: a registry entry that outlives its socket is a message
 *   delivered to a peer that is not there.
 * - **The close code is forwarded.** `DeliveryService.closed` declares one
 *   parameter and the interface passes two, which is legal and is exactly why
 *   this wrapper cannot be written as `observer.closed?.(binding)` — the
 *   heartbeat needs to tell 1000 from 1006.
 *
 * @param observers - The observers to run, in the order they should run.
 * @returns One observer that drives all of them.
 */
export function composeConnectionObservers(
  ...observers: readonly ConnectionObserver[]
): ConnectionObserver {
  return {
    async bound(binding: SocketBinding): Promise<number> {
      let replayed = 0;
      for (const observer of observers) {
        replayed += (await observer.bound?.(binding)) ?? 0;
      }
      return replayed;
    },

    async acked(binding: SocketBinding, messageId: string): Promise<void> {
      for (const observer of observers) {
        await observer.acked?.(binding, messageId);
      }
    },

    async pinged(binding: SocketBinding): Promise<void> {
      for (const observer of observers) {
        await observer.pinged?.(binding);
      }
    },

    async closed(binding: SocketBinding, code: number): Promise<void> {
      let failure: unknown;
      let failed = false;

      for (const observer of observers) {
        try {
          await observer.closed?.(binding, code);
        } catch (error: unknown) {
          // Kept, not rethrown here. The next observer's cleanup is not the
          // failed one's to cancel.
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      }

      if (failed) {
        throw failure;
      }
    },
  };
}

/**
 * Answers an upgrade request that will not become a socket.
 *
 * The refusal is written to the raw socket because there is no reply to send
 * it on: an upgrade never reaches Fastify's router, so no route context, no
 * `onSend` hook and no error handler exists for it. The envelope is built from
 * the same {@link errorEnvelope} and {@link HTTP_STATUS_BY_ERROR_CODE} every
 * other refusal in this server uses, so a client parses one shape whichever
 * door it was turned away from.
 *
 * @param socket - The connection the upgrade arrived on.
 * @param code - The contract code, which also decides the status.
 * @param message - Client-facing. Never the operator-facing `detail`.
 * @param challenge - `WWW-Authenticate`, for a 401.
 */
function refuseUpgrade(socket: Duplex, code: ErrorCode, message: string, challenge?: string): void {
  const status = HTTP_STATUS_BY_ERROR_CODE[code];
  const body = JSON.stringify(errorEnvelope(code, message));

  const headers = [
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}`,
    'connection: close',
    'content-type: application/json; charset=utf-8',
    `content-length: ${Buffer.byteLength(body, 'utf8')}`,
    ...(challenge === undefined ? [] : [`www-authenticate: ${challenge}`]),
  ];

  socket.end(`${headers.join('\r\n')}\r\n\r\n${body}`);
}

/**
 * The path an upgrade request is asking for.
 *
 * @param url - The request target, relative or absolute.
 * @returns Its path, or the empty string if the target will not parse — which
 *   matches no endpoint and is therefore a 404 rather than a crash.
 */
function upgradePath(url: string): string {
  try {
    return new URL(url, UPGRADE_URL_BASE).pathname;
  } catch {
    return '';
  }
}

/**
 * One arriving WebSocket message, in the shape `decodeFrame` reads.
 *
 * `ws` hands over a `Buffer` for an ordinary message, and the other two shapes
 * are configuration this server does not use. All three are normalised anyway,
 * because a `Buffer[]` reaching `decodeFrame` would be measured as an array of
 * objects and silently pass a size check it should have failed.
 *
 * The text/binary distinction is deliberately dropped: `decodeFrame` decodes
 * UTF-8 itself, and a client that sends its JSON as bytes is not wrong.
 *
 * @param data - Whatever `ws` emitted.
 * @returns The bytes of one frame.
 */
function frameOf(data: RawData): RawFrame {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }

  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

/** What {@link registerWebSocketEndpoint} needs. */
interface WebSocketEndpointOptions {
  /** The handshake. Authenticates the upgrade and drives each connection. */
  readonly handler: WebSocketHandler;

  /** Where upgrade refusals and transport errors go. */
  readonly logger: Logger;
}

/**
 * Puts the handshake on the HTTP server.
 *
 * The upgrade is handled on Node's own `upgrade` event with `ws` in `noServer`
 * mode, rather than as a Fastify route through `@fastify/websocket`. That is
 * the decision this function exists to record.
 *
 * A plugin-registered route runs the whole request lifecycle, including the
 * `onRequest` guard in `plugins/auth.ts`. The guard refuses anything without a
 * bearer *header*, and `websocket/handler.ts` documents a query-string token as
 * the supported fallback for clients that cannot set one — the browser's
 * `WebSocket` cannot, which is the entire reason RFC 6750 §2.3 exists. The only
 * way to let that through a route would be to name the path in
 * {@link PUBLIC_ROUTES}, and that list means "answers without credentials". This
 * endpoint demands them; it just reads them itself.
 *
 * Handling the raw event also keeps the refusal honest. `UpgradeRefused` is
 * documented as a 401 with a `WWW-Authenticate` challenge for a caller that can
 * still speak HTTP, and before `handleUpgrade` this one still can. After it,
 * the only vocabulary left is a close code.
 *
 * @param app - The instance whose server accepts the upgrades.
 * @param options - See {@link WebSocketEndpointOptions}.
 * @returns Closes every live socket. Call it before the HTTP server closes.
 */
function registerWebSocketEndpoint(
  app: FastifyInstance,
  options: WebSocketEndpointOptions,
): () => Promise<void> {
  const { handler, logger } = options;

  const server = new WebSocketServer({
    noServer: true,

    // The same number as the HTTP body limit, because `MAX_FRAME_BYTES` is that
    // constant and `websocket/frames.ts` imports it rather than restating it: a
    // 1 MiB message plus its envelope has to fit through either door, and two
    // literals would be two numbers.
    //
    // Making the two limits equal has one visible consequence, which is worth
    // stating rather than discovering. `ws` enforces `maxPayload` while it is
    // still reassembling the frame and closes with RFC 6455's 1009, so a peer
    // that sends an oversize frame sees 1009 and not the 4413 `decodeFrame`
    // would answer. That is the right trade: the check that matters for
    // *availability* is the one that refuses the bytes before they are all in
    // memory, and the documented code stays reachable for anything the
    // transport does let through.
    maxPayload: MAX_FRAME_BYTES,

    // This module keeps its own set, because it needs one that a socket leaves
    // on close for the shutdown wait below to mean anything.
    clientTracking: false,
  });

  /** Every socket this process is serving. */
  const live = new Set<WebSocket>();

  /** Resolves the shutdown wait when `live` empties. Set only while closing. */
  let drained: (() => void) | undefined;

  /**
   * Forgets a socket, and releases the shutdown wait if it was the last.
   *
   * @param socket - The socket that closed.
   */
  function forget(socket: WebSocket): void {
    live.delete(socket);
    if (live.size === 0) {
      drained?.();
    }
  }

  app.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = request.url ?? '/';

    if (upgradePath(url) !== WEBSOCKET_PATH) {
      // The same answer the HTTP not-found handler gives, for the same reason:
      // a client that mistyped the path should be told that, not left holding a
      // connection that never upgrades.
      refuseUpgrade(socket, ErrorCode.NOT_FOUND, `No WebSocket endpoint at ${WEBSOCKET_PATH}.`);
      return;
    }

    const decision = handler.authenticate({ headers: request.headers, url });

    if (decision.outcome === 'refused') {
      // `handler.authenticate` has already logged why, with the cause. What is
      // sent is `message`, never `detail`; see `CloseReason`.
      refuseUpgrade(
        socket,
        decision.reason.error,
        decision.reason.message,
        WWW_AUTHENTICATE_CHALLENGE,
      );
      return;
    }

    server.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      live.add(ws);

      // `ws`'s WebSocket satisfies `FrameSocket` structurally, which is why no
      // adapter object exists here to go stale.
      const connection = handler.connect(ws, decision.user, decision.credentialSource);

      ws.on('message', (data: RawData) => {
        // `receive` never rejects; every failure inside it becomes a close.
        void connection.receive(frameOf(data));
      });

      ws.on('close', (code: number) => {
        forget(ws);
        void connection.disconnected(code);
      });

      ws.on('error', (error: Error) => {
        // Logged and nothing else. `ws` always follows an error with a close,
        // so deregistration happens once, above, whichever way the socket ends.
        logger.info({ err: error }, 'websocket transport error');
      });
    });
  });

  return async function closeSockets(): Promise<void> {
    server.close();

    if (live.size === 0) {
      return;
    }

    logger.info({ sockets: live.size }, 'closing websockets for shutdown');

    const allClosed = new Promise<void>((resolve) => {
      drained = resolve;
    });

    for (const socket of [...live]) {
      socket.close(CloseCode.NORMAL, SHUTDOWN_CLOSE_REASON);
    }

    await Promise.race([
      allClosed,
      new Promise<void>((resolve) => {
        setTimeout(resolve, SOCKET_CLOSE_GRACE_MS).unref();
      }),
    ]);

    // Whatever did not answer its closing handshake. Without this the HTTP
    // server below never finishes closing, because a socket Node still holds is
    // a connection it waits for.
    for (const socket of [...live]) {
      logger.warn('websocket did not close in time; terminating it');
      socket.terminate();
      forget(socket);
    }
  };
}

/**
 * Builds the application a deployment runs: the shell, authenticated, with the
 * login flow on it.
 *
 * The returned instance is not listening; the caller decides when and where.
 * Nothing here reads `process.env`.
 *
 * @param options - See {@link AppOptions}.
 * @returns A Fastify instance ready to `listen` or `inject`.
 * @throws {TokenServiceConfigurationError} If `config.jwtSecret` is too short
 *   to sign with. `loadConfig` rejects one first, so reaching this means a
 *   caller built a `ServerConfig` by hand.
 */
export function createApp<TSchema extends Record<string, unknown> = Record<string, never>>(
  options: AppOptions<TSchema>,
): FastifyInstance {
  const { config, database, logger } = options;

  const app = createAppShell(options);

  // Before the device-flow routes, so its own `onRoute` hook sees them declare
  // themselves public. Its `onRequest` guard is not order-sensitive — it
  // already covers `/healthz`, registered inside the shell above — but that
  // hook is, because `onRoute` fires at registration rather than per request.
  registerAuth(app, { jwtSecret: config.jwtSecret });

  // `registerAuth` announces each public route it *sees*, which by construction
  // cannot include the ones registered before it. This states the whole
  // declared surface in one line so an operator can read it off a boot log
  // without reconstructing it from two sources.
  logger.info({ routes: [...PUBLIC_ROUTES] }, 'routes declared as unauthenticated');

  // The token service owns rotation, reuse detection and revocation, none of
  // which the login route knows about. It is built here because this is the
  // only place that holds both the signing key and the database handle.
  const tokenService = createTokenService({
    store: createDrizzleRefreshTokenStore(database.db),
    jwtSecret: config.jwtSecret,

    // The service deliberately has no logger of its own. A replayed refresh
    // token is the most interesting security event this server can observe and
    // must not be reduced to a 401 in an access log, so the callback is wired
    // to the process logger here. No token, hash or secret is in the event.
    onReuseDetected: (event) => {
      logger.warn(
        {
          userId: event.userId,
          revokedCount: event.revokedCount,
          originallyRevokedAt: event.originallyRevokedAt.toISOString(),
        },
        'refresh token replayed; every live token for this account was revoked',
      );
    },
  });

  // The adapter T-019 exists for. `routes/auth.ts` depends on `issueForUser`
  // and `auth/tokens.ts` provides `issue`, because the two were written in
  // parallel against an interface rather than against each other. Reconciling
  // them is four lines at the point where both are in scope; changing either
  // module would have made one of them worse to satisfy a name.
  //
  // Only the two credentials are passed on. The expiry timestamps the service
  // also returns are not part of the poll response, and forwarding a wider
  // object than the contract describes is how a field ends up on the wire
  // because nobody stopped it.
  const tokens: TokenIssuer = {
    async issueForUser(userId) {
      const issued = await tokenService.issue({ userId });
      return { accessToken: issued.accessToken, refreshToken: issued.refreshToken };
    },
  };

  const identityProvider =
    options.identityProvider ??
    createGitHubIdentityProvider({
      clientId: config.identityProvider.clientId,
      clientSecret: config.identityProvider.clientSecret,
    });

  registerAuthRoutes(app, {
    identityProvider,
    tokens,
    users: createUserDirectory(database.db),
  });

  // --- The product surface (T-023) --------------------------------------
  //
  // Four modules, each of which exports a register function, takes its
  // collaborators as arguments, and is called from nowhere else. Everything
  // below this line is reachable for the first time here. Two more — messages
  // and conversations — follow the delivery service further down, for the
  // reason stated there.
  //
  // Not one of the URLs they add is named in {@link PUBLIC_ROUTES}, and that
  // omission *is* their authentication: the `onRoute` hook in
  // `createAppShell` stamps `config.auth = 'public'` only on the routes it
  // recognises, and `plugins/auth.ts` refuses anything that did not declare
  // itself. So the way to make one of these public is to add its URL above,
  // in one visible place, and there is no way to do it from a route module.
  //
  // `GET /invites/:code` is the one that looks like it belongs in that set and
  // must not go into it. It relaxes *authorization* — `InviteService.preview`
  // takes no user id, so it answers a caller who is a member of nothing — and
  // relaxing authentication as well would make the code alone enough to learn
  // a project's name and who is recruiting into it, with no account behind the
  // request and nothing to rate-limit on. `routes/invites.ts` states the same
  // conclusion at length; it is repeated here because this is the file that
  // could make the mistake.
  //
  // Order is not load-bearing. The guard is an `onRequest` hook and Fastify
  // assembles those at ready time, so it covers routes registered before
  // `registerAuth` as well — `/healthz` is one. None of these four modules
  // installs a hook of its own, so nothing here needs to see anything else
  // register. They follow `registerAuth` anyway, so that a route later moved
  // into the public set is announced by its `onRoute` logging like the
  // device-flow routes are, rather than silently missing from the boot log.

  // One permission matrix for the whole application rather than one per route
  // module. Each module would build its own from `db` if this were left out;
  // sharing it is what keeps "how many statements does a request cost"
  // answerable in a single place, and it is the argument both project and
  // invite routes document as the reason the option exists.
  const authorization = createAuthorizationService(database.db);

  registerProjectRoutes(app, { db: database.db, authorization });
  registerInviteRoutes(app, { db: database.db, authorization });
  registerAgentRoutes(app, { agents: createAgentService(database.db) });

  const sessions = createSessionService({ db: database.db, authorization });
  registerSessionRoutes(app, { sessions });

  // Sessions expire by being swept, not by being told. A listener's process is
  // normally killed rather than shut down, so `DELETE /sessions/:id` is a
  // courtesy and this timer is the mechanism: without a caller,
  // `startSessionSweeper` is dead code and every session stays `active`
  // forever, which makes presence claim that agents nobody is running are
  // online. That is the failure this line exists to prevent, and it is
  // invisible until someone asks who is listening.
  //
  // Tied to the instance rather than to the process: `createApp` is a factory
  // and a test may build several, so the timer is stopped when the app that
  // owns it closes. `index.ts` awaits `app.close()` during shutdown, and the
  // interval is `unref`ed besides, so a sweeper nobody stopped cannot hold the
  // process open on its own.
  const sweeper = startSessionSweeper({
    sessions,
    observer: {
      onSwept: (result) => {
        logger.info(
          { markedStale: result.markedStale, ended: result.ended },
          'swept sessions that stopped heartbeating',
        );
      },

      // A failed pass is not fatal — the next one repeats the same idempotent
      // statements — but it must not be silent, or a database that has been
      // refusing the sweep for a day looks exactly like a day with no stale
      // sessions.
      onFailed: (error) => {
        logger.error({ err: error }, 'session sweep failed; the next pass will retry');
      },
    },
  });

  app.addHook('onClose', (_instance, done) => {
    sweeper.stop();
    done();
  });

  // --- Delivery (T-033, T-038) ------------------------------------------
  //
  // Built before the message routes rather than after, because it is no longer
  // only the WebSocket endpoint's collaborator: `POST /messages` is the other
  // half of the product's headline claim and needs the same instance. One
  // service, so a socket that bound over the WebSocket endpoint is one the send
  // route can reach — two would each hold half the connected listeners and
  // every live delivery would be a coin flip.

  // The registry is created here and referred to exactly twice, below. It is
  // not returned, not decorated onto the instance, and not passed to any route:
  // `routing/router.ts` is the interface the rest of the server is allowed to
  // hold, and a caller that reached past it into the map is the thing that
  // would make the cross-instance implementation a rewrite rather than a
  // constructor swap.
  const registry = createSocketRegistry();
  const router = createInProcessRouter({ registry, logger });

  // Shared with the message routes below, for the reason `authorization` is
  // shared: one instance is what keeps "how many statements does a request
  // cost" answerable in a single place.
  const inbox = createInboxService(database.db);

  // Delivery *is* the connection observer — see `routing/delivery.ts` — and it
  // is the only holder of the registry besides the router, because it is the
  // thing that knows when a socket has bound and when it has gone.
  const delivery = createDeliveryService({
    router,
    registry,
    inbox,
    senders: createSenderDirectory(database.db),
    logger,
  });

  // --- The message surface (T-038) --------------------------------------
  //
  // The two route groups that were written, tested and never registered, and
  // the seam that makes a send push rather than only persist.
  //
  // `createDeliveringMessageService` is that seam, and the choice it encodes is
  // that the ordering — commit, *then* fan out — is a property of the object
  // the route is handed rather than a step the route remembers to take. The
  // route below therefore says nothing about delivery, and neither will the
  // next caller of a `MessageService`: the WebSocket send frame and any admin
  // command get the fan-out for free, in the right order, because there is no
  // way from here to obtain a send that does not deliver. See that function's
  // note for why a route calling `delivery.deliver` itself was rejected.
  //
  // Neither URL is in {@link PUBLIC_ROUTES}: protected by omission, like every
  // group above.
  registerConversationRoutes(app, {
    conversations: createConversationService({ db: database.db, authorization }),
  });

  registerMessageRoutes(app, {
    messages: createDeliveringMessageService({
      messages: createMessageService(database.db),
      delivery,
      logger,
    }),
    inbox,
  });

  // --- The WebSocket endpoint (T-033) -----------------------------------
  //
  // Everything from here to the `preClose` hook is reachable for the first
  // time. See the module note for the three decisions it makes.

  // One entry today. The heartbeat (T-309) is the second, and adding it is this
  // line plus its constructor — not a negotiation over who gets `closed`.
  const observer = composeConnectionObservers(delivery);

  const closeSockets = registerWebSocketEndpoint(app, {
    handler: createWebSocketHandler({
      jwtSecret: config.jwtSecret,
      sessions,
      logger,
      observer,
    }),
    logger,
  });

  // Shutdown order: sockets, then the HTTP server, then the database pool.
  //
  // `preClose` and not `onClose`, and the difference is not stylistic. Fastify
  // registers its own `onClose` hook — the one that calls `server.close()` — at
  // `preReady`, and those hooks run last-registered-first, so it runs *before*
  // anything this file adds. `server.close()` stops new connections and then
  // waits for the open ones, and a WebSocket is an open connection that has no
  // reason to end. Closing the sockets from `onClose` would therefore mean
  // waiting for a close that only that hook could cause: every shutdown would
  // hang until `SHUTDOWN_TIMEOUT_MS` expired and the process exited non-zero.
  // `preClose` runs inside that same hook, before `server.close()`.
  //
  // The router closes after the sockets and before the pool. After, so that
  // each connection's own `closed` hook releases its registration through the
  // path that is exercised a thousand times a day, rather than through
  // `clear()`; `router.close()` then collects anything a socket that died
  // abruptly left behind. Before the pool, because `index.ts` closes that after
  // `app.close()` resolves, and a delivery still in flight needs a database to
  // record itself against. A delivery that arrives after this point is not lost
  // and is not an error: `router.deliver` says so and returns nothing
  // delivered, the message's inbox row stays pending, and the listener collects
  // it on its next `hello`.
  app.addHook('preClose', async () => {
    await closeSockets();
    await router.close();
  });

  return app;
}
