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
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import pino, { type Logger } from 'pino';
import type { ServerConfig } from './config.js';
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
    return503OnClosing: true,
  });

  // Echo the identifier so a caller can quote it in a bug report and an
  // operator can find the request in the log.
  app.addHook('onSend', (request, reply, _payload, done) => {
    reply.header(REQUEST_ID_HEADER, request.id);
    done();
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} does not exist.`,
      },
    });
  });

  // Plan §3: every error is `{ error: { code, message } }` with a stable code.
  // `error` is annotated because Fastify's overloads otherwise widen it to
  // `unknown` here rather than defaulting to `FastifyError`.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;

    if (statusCode >= 500) {
      request.log.error({ err: error }, 'request failed');

      // Nothing internal crosses the wire. A stack trace or a driver message
      // tells an attacker about the deployment and tells a legitimate caller
      // nothing they can act on; the request id links the two views.
      void reply.code(statusCode).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'The server failed to handle this request.',
        },
      });
      return;
    }

    // 4xx are the caller's own fault and describing them is the point: an
    // oversized body, a malformed route parameter, an unsupported media type.
    // Fastify's own errors always carry a code; one thrown by a handler with a
    // `statusCode` but no code still needs a stable one.
    const code = typeof error.code === 'string' && error.code !== '' ? error.code : 'BAD_REQUEST';

    request.log.info({ err: error }, 'request rejected');
    void reply.code(statusCode).send({
      error: { code, message: error.message },
    });
  });

  registerHealthRoutes(app, { database });

  return app;
}
