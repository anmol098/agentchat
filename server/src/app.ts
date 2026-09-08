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
 * {@link createApp}, together with the session sweeper. Each was written by a
 * task that correctly declined to edit this file, so until that block existed
 * every one of them was complete, tested and unreachable — the third time on
 * this project that finished work sat behind an unowned one-line seam.
 *
 * None of those routes is named in {@link PUBLIC_ROUTES}, which is the whole of
 * their authentication. `GET /invites/:code` is the one that reads like an
 * exception and is not: it relaxes authorization, not authentication. See the
 * comment at the registration site.
 */

import { randomUUID } from 'node:crypto';
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
import { createGitHubIdentityProvider } from './auth/github.js';
import type { IdentityProvider } from './auth/identity.js';
import { createDrizzleRefreshTokenStore, createTokenService } from './auth/tokens.js';
import type { ServerConfig } from './config.js';
import { HTTP_STATUS_BY_ERROR_CODE, SERVER_ERROR_FLOOR, toErrorResponse } from './errors.js';
import { registerAuth } from './plugins/auth.js';
import { registerAgentRoutes } from './routes/agents.js';
import { createUserDirectory, registerAuthRoutes, type TokenIssuer } from './routes/auth.js';
import { type HealthProbe, registerHealthRoutes } from './routes/health.js';
import { registerInviteRoutes } from './routes/invites.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { createAgentService } from './services/agents.js';
import { createAuthorizationService } from './services/authorization.js';
import { createSessionService, startSessionSweeper } from './services/sessions.js';

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
  // below this line is reachable for the first time here.
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

  return app;
}
