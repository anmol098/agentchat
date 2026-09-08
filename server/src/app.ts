/**
 * The Fastify application.
 *
 * `createApp` is a factory, not a singleton: it takes its logger and database
 * as arguments and registers routes on a fresh instance. Composition happens in
 * `index.ts`, which is the only module that reads the environment or installs
 * signal handlers, so a test can build a complete server without inheriting a
 * process-wide lifecycle.
 */

import { randomUUID } from 'node:crypto';
import { ErrorCode, errorEnvelope } from '@agentchat/protocol';
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
import type { ServerConfig } from './config.js';
import { HTTP_STATUS_BY_ERROR_CODE, SERVER_ERROR_FLOOR, toErrorResponse } from './errors.js';
import { type HealthProbe, registerHealthRoutes } from './routes/health.js';

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

/** Options for {@link createApp}. */
export interface AppOptions {
  /** Validated configuration. */
  readonly config: ServerConfig;
  /** Database handle the health check queries. */
  readonly database: HealthProbe;
  /** Logger the server and every request log through. */
  readonly logger: Logger;
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
 * Builds the HTTP application with its routes registered.
 *
 * The returned instance is not listening; the caller decides when and where.
 * Nothing here reads `process.env`.
 *
 * @param options - See {@link AppOptions}.
 * @returns A Fastify instance ready to `listen` or `inject`.
 */
export function createApp(options: AppOptions): FastifyInstance {
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

  registerHealthRoutes(app, { database });

  return app;
}
