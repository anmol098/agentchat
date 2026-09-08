/**
 * Database connection management.
 *
 * One process owns one pool. Everything that talks to Postgres goes through
 * the Drizzle instance returned here, and shutdown goes through {@link
 * Database.close} so that in-flight queries finish before the process exits.
 */

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';

/**
 * Thrown when the database configuration is missing or unusable.
 *
 * Carries a stable `code` so callers can branch on it without matching on
 * message text (Protocol §7.3).
 */
export class DatabaseConfigurationError extends Error {
  /** Stable, machine-readable identifier for this failure. */
  public readonly code = 'DATABASE_CONFIGURATION_INVALID';

  public constructor(message: string) {
    super(message);
    this.name = 'DatabaseConfigurationError';
  }
}

/**
 * Reads the connection string the server should use.
 *
 * @param env - Environment to read from. Defaults to `process.env`.
 * @returns The value of `DATABASE_URL`.
 * @throws {DatabaseConfigurationError} If `DATABASE_URL` is unset or blank.
 */
export function readDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env['DATABASE_URL']?.trim();

  if (url === undefined || url === '') {
    throw new DatabaseConfigurationError(
      'DATABASE_URL is not set. Start the local database with `docker compose up -d postgres` ' +
        'and export DATABASE_URL=postgres://agentchat:agentchat@localhost:5432/agentchat',
    );
  }

  return url;
}

/** Options for {@link createDatabase}. */
export interface DatabaseOptions<TSchema extends Record<string, unknown>> {
  /**
   * Connection string. Defaults to `DATABASE_URL` from the environment, read
   * through {@link readDatabaseUrl}.
   */
  readonly url?: string;

  /**
   * Drizzle model definitions, keyed by export name. Supplying them enables the
   * relational query API; omitting them leaves the SQL builder fully usable.
   */
  readonly schema?: TSchema;

  /**
   * Maximum number of connections in the pool. Defaults to 10, which is
   * deliberately modest: a single VM runs both the server and Postgres in the
   * reference deployment (D6), and Postgres charges roughly the same for an
   * idle backend as a busy one.
   */
  readonly maxConnections?: number;

  /**
   * How long to wait for a connection from the pool before giving up, in
   * milliseconds. Defaults to 5000 so a database outage surfaces as a fast
   * error instead of a hung request.
   */
  readonly connectionTimeoutMillis?: number;

  /**
   * How long an unused connection stays open, in milliseconds. Defaults to
   * 30000.
   */
  readonly idleTimeoutMillis?: number;

  /**
   * Called when the pool reports an error on an *idle* connection — typically
   * because Postgres restarted or a proxy dropped the socket. Such errors have
   * no query to reject, so without a handler `pg` emits an unhandled `error`
   * event and takes the process down with it.
   *
   * Defaults to a one-line warning on stderr. T-007 replaces it with the pino
   * logger.
   */
  readonly onIdleError?: (error: Error) => void;
}

/** A pooled database connection and the lifecycle around it. */
export interface Database<TSchema extends Record<string, unknown> = Record<string, never>> {
  /** Drizzle query interface. This is what services should use. */
  readonly db: NodePgDatabase<TSchema>;

  /**
   * The underlying `pg` pool, for the rare operation Drizzle does not cover —
   * advisory locks around migrations (T-502), for example.
   */
  readonly pool: Pool;

  /**
   * Runs a trivial query to prove the database is reachable.
   *
   * @throws Whatever `pg` throws when the connection cannot be established.
   */
  ping(): Promise<void>;

  /**
   * Drains the pool and closes every connection.
   *
   * Waits for checked-out connections to be released, so a request in flight
   * when SIGTERM arrives still completes. Safe to call more than once: repeat
   * calls return the same promise rather than throwing.
   */
  close(): Promise<void>;
}

const DEFAULT_MAX_CONNECTIONS = 10;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

function warnOnStderr(error: Error): void {
  // stderr, never stdout: the CLI contract depends on stdout carrying nothing
  // but message payloads, and this module is linked into tooling that runs
  // beside it.
  process.stderr.write(`[db] idle client error: ${error.message}\n`);
}

/**
 * Creates the process-wide database handle.
 *
 * Call this once during startup and pass the result around; creating a second
 * pool doubles the connection count without doubling the throughput.
 *
 * @param options - See {@link DatabaseOptions}. All fields have defaults except
 * the connection string, which falls back to the environment.
 * @returns A handle whose `close` must be called during shutdown.
 * @throws {DatabaseConfigurationError} If no `url` is given and `DATABASE_URL`
 * is unset.
 */
export function createDatabase<TSchema extends Record<string, unknown> = Record<string, never>>(
  options: DatabaseOptions<TSchema> = {},
): Database<TSchema> {
  const connectionString = options.url ?? readDatabaseUrl();

  const poolConfig: PoolConfig = {
    connectionString,
    max: options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: options.idleTimeoutMillis ?? DEFAULT_IDLE_TIMEOUT_MS,
    // Fail fast rather than letting a wedged statement hold a connection for
    // the lifetime of the process. Long-running migrations use their own
    // connection settings (T-502).
    statement_timeout: 30_000,
    application_name: 'agentchat-server',
  };

  const pool = new Pool(poolConfig);
  pool.on('error', options.onIdleError ?? warnOnStderr);

  const schema = options.schema;
  // The cast covers the no-schema branch only, where Drizzle reports the empty
  // schema `Record<string, never>` and the caller's TSchema is unconstrained.
  // Nothing is asserted about runtime shape: with no models registered the
  // relational query API has nothing to return either way.
  const db =
    schema === undefined ? (drizzle(pool) as NodePgDatabase<TSchema>) : drizzle(pool, { schema });

  let closing: Promise<void> | undefined;

  return {
    db,
    pool,

    async ping(): Promise<void> {
      await pool.query('select 1');
    },

    async close(): Promise<void> {
      // `pool.end()` rejects if called twice, and SIGTERM arriving during a
      // shutdown that is already under way is entirely normal.
      closing ??= pool.end();
      await closing;
    },
  };
}
