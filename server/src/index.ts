/**
 * Server entry point.
 *
 * This is the only module that reads the environment, owns the process-wide
 * database pool, or installs signal handlers. Everything else takes what it
 * needs as an argument, which is what makes the server testable without a
 * process of its own.
 *
 * Importing this module does not start anything. It starts only when it is the
 * program Node was asked to run.
 */

import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { createApp, createLogger } from './app.js';
import { ConfigurationError, loadConfig, type ServerConfig } from './config.js';
import { createDatabase, type Database } from './db/client.js';

/** Signals that mean "finish what you are doing and stop". */
const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/** A started server and the handles needed to stop it again. */
export interface RunningServer {
  /** The listening Fastify instance. */
  readonly app: FastifyInstance;
  /** The process-wide database handle. */
  readonly database: Database;
  /** The logger the server writes through. */
  readonly logger: Logger;
  /** Validated configuration the server started with. */
  readonly config: ServerConfig;
  /**
   * Closes the HTTP server and then the database pool, in that order.
   *
   * Idempotent: concurrent or repeated calls await the same shutdown.
   */
  close(): Promise<void>;
}

/**
 * Builds and starts the server.
 *
 * @param env - Environment to configure from. Defaults to `process.env`.
 * @returns The running server, already listening.
 * @throws {ConfigurationError} If the environment is missing or malformed.
 */
export async function start(env: NodeJS.ProcessEnv = process.env): Promise<RunningServer> {
  const config = loadConfig(env);
  const logger = createLogger(config);

  const database = createDatabase({
    url: config.databaseUrl,
    maxConnections: config.database.maxConnections,
    connectionTimeoutMillis: config.database.connectionTimeoutMillis,
    idleTimeoutMillis: config.database.idleTimeoutMillis,
    // Without a handler here, a Postgres restart makes `pg` emit an unhandled
    // `error` event on an idle connection and Node kills the process for it.
    onIdleError: (error) => {
      logger.error({ err: error }, 'idle database connection failed');
    },
  });

  const app = createApp({ config, database, logger });

  let closing: Promise<void> | undefined;

  const close = async (): Promise<void> => {
    // Order matters. The HTTP server goes first so requests already in flight
    // finish while the pool is still there to serve them; closing the pool
    // first would fail those requests on the way out.
    closing ??= (async (): Promise<void> => {
      await app.close();
      await database.close();
    })();

    await closing;
  };

  await app.listen({ host: config.host, port: config.port });

  // Prove the database is reachable, but do not refuse to start over it. A
  // server that exits because Postgres is briefly down cannot report *why* it
  // is unhealthy; one that starts and answers 503 on /healthz can, and it
  // recovers on its own when the database comes back.
  try {
    await database.ping();
    logger.info('database reachable');
  } catch (error) {
    logger.warn(
      { err: error },
      'database unreachable at startup; /healthz will report 503 until it recovers',
    );
  }

  logger.info(
    {
      address: app.addresses()[0],
      bodyLimitBytes: config.bodyLimitBytes,
      nodeEnv: config.nodeEnv,
    },
    'server listening',
  );

  return { app, database, logger, config, close };
}

/**
 * Stops the server, or gives up and exits non-zero if it takes too long.
 *
 * The timeout exists because a shutdown that hangs is worse than a rough one:
 * the orchestrator's own grace period ends in SIGKILL, which produces no log
 * line at all explaining what was stuck.
 */
async function shutdown(server: RunningServer, signal: string): Promise<never> {
  const { logger, config } = server;
  logger.info({ signal }, 'shutting down');

  const timer = setTimeout(() => {
    logger.fatal(
      { signal, timeoutMs: config.shutdownTimeoutMs },
      'graceful shutdown timed out; exiting',
    );
    process.exit(1);
  }, config.shutdownTimeoutMs);
  timer.unref();

  try {
    await server.close();
    clearTimeout(timer);
    logger.info({ signal }, 'shutdown complete');
    process.exit(0);
  } catch (error) {
    clearTimeout(timer);
    logger.fatal({ err: error, signal }, 'shutdown failed');
    process.exit(1);
  }
}

/**
 * Starts the server and wires it to the process lifecycle.
 *
 * A configuration failure is reported on stderr rather than through pino: the
 * logger's level comes from the configuration that just failed to load, and the
 * person who has to fix it needs prose, not a JSON record.
 */
async function main(): Promise<void> {
  let server: RunningServer;

  try {
    server = await start();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  let signalled = false;

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      if (signalled) {
        // An impatient operator pressing Ctrl-C again must not start a second
        // shutdown on top of the first.
        server.logger.warn({ signal }, 'shutdown already in progress');
        return;
      }
      signalled = true;
      void shutdown(server, signal);
    });
  }

  process.on('uncaughtException', (error) => {
    server.logger.fatal({ err: error }, 'uncaught exception');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    server.logger.fatal({ err: reason }, 'unhandled promise rejection');
    process.exit(1);
  });
}

/** Whether this module is the program Node was asked to run, rather than an import. */
function isEntrypoint(): boolean {
  const invoked = process.argv[1];
  return invoked !== undefined && pathToFileURL(invoked).href === import.meta.url;
}

if (isEntrypoint()) {
  await main();
}
