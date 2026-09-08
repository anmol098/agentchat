/**
 * Applying migrations safely (Plan §12.2).
 *
 * The rules this module exists to keep:
 *
 * - **Two instances starting at once must not both migrate.** They serialise on
 *   a Postgres advisory lock: the first applies, the rest wait and then find
 *   nothing to do.
 * - **The lock must always be released**, including after a failed migration
 *   and after a SIGKILL. A session-level advisory lock dies with its
 *   connection, so the worst case an operator can reach is "the previous
 *   attempt's connection has not been reaped yet", never "manually unlock the
 *   database before you can deploy again".
 * - **An interrupted migration must not leave a half-applied schema.** Every
 *   migration is applied inside one transaction, DDL in Postgres is
 *   transactional, and an interrupt cancels the running statement so that
 *   transaction rolls back whole.
 * - **A database ahead of this image is refused**, not quietly served. See
 *   `version-guard.ts`.
 *
 * The migrations directory is always passed in. `drizzle.config.ts` is
 * deliberately absent from the production image — it is development tooling —
 * so nothing here may read configuration from it.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool, type PoolClient } from 'pg';
import type { Logger } from 'pino';
import {
  assertSchemaNotAhead,
  type BundledMigrations,
  describeSchemaVersion,
  readBundledMigrations,
  readDatabaseSchemaVersion,
  SchemaAheadError,
} from './version-guard.js';

/**
 * The advisory lock every AgentChat migration run takes.
 *
 * Advisory locks share one namespace per database, so the constant has to be
 * something no other application would pick by accident, and it can never
 * change: two versions using different keys would not see each other and the
 * lock would stop being a lock. It is the first eight bytes of
 * `sha256('agentchat:migrations')` read as a signed 64-bit integer, which
 * `migrate.test.ts` asserts, so the literal cannot drift from its derivation
 * without a test failing.
 */
export const MIGRATION_LOCK_KEY = -7_846_882_383_417_283_556n;

/** How long to wait for the lock before giving up, in milliseconds. */
const DEFAULT_LOCK_TIMEOUT_MS = 60_000;

/** How long to wait for a connection before giving up, in milliseconds. */
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

/** Postgres `lock_not_available`: `lock_timeout` expired. */
const LOCK_NOT_AVAILABLE = '55P03';

/** Postgres `query_canceled`: `pg_cancel_backend` reached the statement. */
const QUERY_CANCELED = '57014';

/** Thrown when the lock could not be taken before `lockTimeoutMs` elapsed. */
export class MigrationLockTimeoutError extends Error {
  /** Stable, machine-readable identifier for this failure. */
  public readonly code = 'MIGRATION_LOCK_TIMEOUT';

  public constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = 'MigrationLockTimeoutError';
  }
}

/** Thrown when the run was cancelled by its caller, typically on SIGTERM. */
export class MigrationInterruptedError extends Error {
  /** Stable, machine-readable identifier for this failure. */
  public readonly code = 'MIGRATION_INTERRUPTED';

  public constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = 'MigrationInterruptedError';
  }
}

/** Thrown when a migration itself failed. The cause is the driver's error. */
export class MigrationFailedError extends Error {
  /** Stable, machine-readable identifier for this failure. */
  public readonly code = 'MIGRATION_FAILED';

  public constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = 'MigrationFailedError';
  }
}

/** Options for {@link runMigrations}. */
export interface MigrationRunOptions {
  /** PostgreSQL connection string. */
  readonly databaseUrl: string;

  /**
   * Directory holding `meta/_journal.json` and the `.sql` files. Always
   * explicit: the image ships migrations without the Drizzle config that would
   * otherwise say where they are.
   */
  readonly migrationsFolder: string;

  /** Where progress and timings are written. */
  readonly logger: Logger;

  /**
   * Advisory lock key. Defaults to {@link MIGRATION_LOCK_KEY}; tests override
   * it so a run cannot collide with a developer's own server on the same
   * database.
   */
  readonly lockKey?: bigint;

  /** How long to wait for the lock. Defaults to 60 000 ms. */
  readonly lockTimeoutMs?: number;

  /**
   * Proceed even when the database is ahead of this image's migrations.
   *
   * Off by default, and only ever set from an explicit operator opt-in: this is
   * the deliberate-rollback escape hatch named in the guard's own error
   * message, not something to switch on to make a deploy go through.
   */
  readonly allowSchemaAhead?: boolean;

  /**
   * Cancels the run. Aborting cancels the statement Postgres is executing, so
   * the migration transaction rolls back rather than being abandoned in flight.
   */
  readonly signal?: AbortSignal;
}

/** What a completed run did. */
export interface MigrationRunResult {
  /** Migrations applied by this run, oldest first. Empty when up to date. */
  readonly appliedTags: readonly string[];
  /** Schema version before the run, `null` for an empty database. */
  readonly schemaVersionBefore: number | null;
  /** Schema version after the run. */
  readonly schemaVersionAfter: number | null;
  /** Milliseconds spent waiting for the advisory lock. */
  readonly lockWaitMs: number;
  /** Milliseconds spent applying migrations. Zero when there were none. */
  readonly applyMs: number;
  /** Milliseconds the whole run took, lock wait included. */
  readonly durationMs: number;
}

/** SQLSTATE, when the thrown value carries one. */
function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }

  const code: unknown = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Human-readable description of a thrown value, for a log line or a message. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads the backend process id of a connection, for {@link cancelBackend}. */
async function backendPid(client: PoolClient): Promise<number> {
  const result = await client.query<{ pid: string }>('select pg_backend_pid() as pid');
  const pid = result.rows[0]?.pid;

  if (pid === undefined) {
    throw new MigrationFailedError('PostgreSQL did not report a backend process id.');
  }

  return Number(pid);
}

/**
 * Cancels whatever another connection is currently running.
 *
 * `pg_cancel_backend` is the only way to interrupt a statement already in
 * flight; closing the socket would leave Postgres executing it to completion.
 * Cancelling from *another* connection is the point — the one being cancelled
 * is by definition busy.
 *
 * Failures are swallowed deliberately: this runs on the interrupt path, where
 * the statement having already finished is a perfectly normal race.
 */
async function cancelBackend(client: PoolClient, pid: number, logger: Logger): Promise<void> {
  try {
    await client.query('select pg_cancel_backend($1)', [pid]);
  } catch (error) {
    logger.debug({ err: error, pid }, 'could not cancel the backend; it may have finished already');
  }
}

/** Which bundled migrations a database at `version` has not yet seen. */
function pendingSince(bundled: BundledMigrations, version: number | null): readonly string[] {
  // Mirrors Drizzle's own rule exactly (`pg-core/dialect.ts`): a migration is
  // applied when its journal `when` is strictly greater than the newest
  // `created_at` in the database. Reimplementing the comparison differently
  // here would produce a log line that disagrees with what actually ran.
  return bundled.entries
    .filter((entry) => version === null || entry.when > version)
    .map((entry) => entry.tag);
}

/**
 * Applies every pending migration, once, under the advisory lock.
 *
 * Safe to call concurrently from any number of processes: exactly one applies
 * and the others wait for it and then find themselves up to date.
 *
 * @param options - See {@link MigrationRunOptions}.
 * @returns What the run did; see {@link MigrationRunResult}.
 * @throws {SchemaAheadError} If the database was migrated by a newer image and
 * `allowSchemaAhead` is not set.
 * @throws {MigrationLockTimeoutError} If the lock could not be taken in time.
 * @throws {MigrationInterruptedError} If `signal` aborted the run. Nothing was
 * left half-applied: the transaction rolled back.
 * @throws {MigrationFailedError} If a migration or the connection failed.
 * @throws {MigrationJournalError} If the migrations folder has no usable
 * journal.
 */
export async function runMigrations(options: MigrationRunOptions): Promise<MigrationRunResult> {
  const {
    databaseUrl,
    migrationsFolder,
    logger,
    lockKey = MIGRATION_LOCK_KEY,
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    allowSchemaAhead = false,
    signal,
  } = options;

  const startedAt = Date.now();

  // Read the journal before opening a connection. A missing or malformed
  // migrations directory is a packaging error, and reporting it should not
  // depend on the database being reachable.
  const bundled = readBundledMigrations(migrationsFolder);

  logger.info(
    {
      migrationsFolder,
      bundledCount: bundled.entries.length,
      imageSchemaVersion: bundled.version,
      newestBundledTag: bundled.newestTag,
    },
    'migration run starting',
  );

  // A pool of two: one connection holds the lock for the whole run, the other
  // applies the migrations. Two is also what makes cancellation work — each can
  // interrupt the other, and neither needs a third connection at the moment it
  // matters.
  //
  // `statement_timeout` is explicitly disabled. The server's pool sets 30 s so
  // a wedged query cannot pin a connection, but a migration that creates an
  // index on a large table is meant to take minutes, and inheriting a timeout
  // from a `DATABASE_URL` query parameter would abort it half way through.
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    application_name: 'agentchat-migrate',
    connectionTimeoutMillis: DEFAULT_CONNECTION_TIMEOUT_MS,
    statement_timeout: 0,
    idle_in_transaction_session_timeout: 0,
  });

  // An idle connection failing mid-run must not take the process down through
  // an unhandled 'error' event; the operation that cares will fail on its own.
  pool.on('error', (error) => {
    logger.warn({ err: error }, 'idle migration connection failed');
  });

  let lockClient: PoolClient | undefined;
  let migrationClient: PoolClient | undefined;
  let locked = false;
  // Whether the connections may go back to the pool. A connection that was
  // cancelled or errored is destroyed instead, which is also the belt to the
  // explicit unlock's braces: a destroyed connection cannot carry the advisory
  // lock anywhere.
  let poisoned = false;

  try {
    const lock = await pool.connect();
    lockClient = lock;
    const applier = await pool.connect();
    migrationClient = applier;

    const lockPid = await backendPid(lock);
    const applierPid = await backendPid(applier);

    // Interrupts are handled by cancelling whichever connection is blocking,
    // from the other one — a busy connection cannot cancel itself, and issuing a
    // second query on a connection that is mid-statement is not allowed at all.
    // Which one is blocking depends on the stage, so the stage is tracked.
    let stage: 'idle' | 'locking' | 'applying' | 'finished' = 'idle';
    let interrupted = false;
    let cancelPulse: NodeJS.Timeout | undefined;

    const pulse = (): void => {
      if (stage === 'locking') {
        void cancelBackend(applier, lockPid, logger);
      } else if (stage === 'applying') {
        void cancelBackend(lock, applierPid, logger);
      }
    };

    const onAbort = (): void => {
      interrupted = true;
      logger.warn('interrupt received; cancelling the migration and rolling back');
      pulse();

      // Repeated rather than once, because `pg_cancel_backend` only interrupts a
      // statement that is actually running: a signal arriving in the gap between
      // two statements of a migration would otherwise be a no-op and the
      // migration would run to completion after being told to stop. Pulsing
      // catches whichever statement starts next.
      cancelPulse = setInterval(pulse, 100);
      cancelPulse.unref();
    };

    const stopCancelling = (): void => {
      stage = 'finished';
      if (cancelPulse !== undefined) {
        clearInterval(cancelPulse);
        cancelPulse = undefined;
      }
    };

    if (signal?.aborted === true) {
      throw new MigrationInterruptedError('Interrupted before the migration started.');
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      // `lock_timeout` covers the advisory lock wait too, so a deploy against a
      // database whose previous migration is wedged fails with a message rather
      // than hanging until the orchestrator kills it.
      await lock.query(`set lock_timeout = ${Math.trunc(lockTimeoutMs)}`);

      logger.info({ lockKey: lockKey.toString(), lockTimeoutMs }, 'waiting for the advisory lock');
      const lockStartedAt = Date.now();

      stage = 'locking';

      try {
        await lock.query('select pg_advisory_lock($1::bigint)', [lockKey.toString()]);
      } catch (error) {
        poisoned = true;
        if (interrupted) {
          throw new MigrationInterruptedError('Interrupted while waiting for the advisory lock.', {
            cause: error,
          });
        }
        if (sqlStateOf(error) === LOCK_NOT_AVAILABLE) {
          throw new MigrationLockTimeoutError(
            `Another process has held the migration lock for more than ${lockTimeoutMs} ms. ` +
              'It is applying migrations, or it died without its connection being reaped yet. ' +
              'Wait and retry; there is nothing to unlock by hand.',
            { cause: error },
          );
        }
        throw new MigrationFailedError(
          `Could not take the migration advisory lock: ${describeError(error)}`,
          { cause: error },
        );
      }

      stage = 'idle';
      locked = true;
      const lockWaitMs = Date.now() - lockStartedAt;
      logger.info({ lockWaitMs }, 'advisory lock acquired');

      // Everything below runs with the lock held, so the version read cannot
      // race another instance's migration.
      const schemaVersionBefore = await readDatabaseSchemaVersion(applier);

      try {
        assertSchemaNotAhead({ databaseVersion: schemaVersionBefore, bundled });
      } catch (error) {
        if (error instanceof SchemaAheadError && allowSchemaAhead) {
          logger.warn(
            {
              databaseSchemaVersion: error.databaseVersion,
              imageSchemaVersion: error.imageVersion,
            },
            'AGENTCHAT_ALLOW_SCHEMA_AHEAD is set: serving a database newer than this image',
          );
        } else {
          throw error;
        }
      }

      const pending = pendingSince(bundled, schemaVersionBefore);

      if (pending.length === 0) {
        logger.info(
          { schemaVersion: describeSchemaVersion(schemaVersionBefore) },
          'database schema is up to date; nothing to apply',
        );

        return {
          appliedTags: [],
          schemaVersionBefore,
          schemaVersionAfter: schemaVersionBefore,
          lockWaitMs,
          applyMs: 0,
          durationMs: Date.now() - startedAt,
        };
      }

      logger.info(
        {
          pendingCount: pending.length,
          pendingTags: pending,
          fromSchemaVersion: describeSchemaVersion(schemaVersionBefore),
          toSchemaVersion: describeSchemaVersion(bundled.version),
        },
        `applying ${pending.length} migration(s)`,
      );

      if (interrupted) {
        throw new MigrationInterruptedError('Interrupted before any migration was applied.');
      }

      const applyStartedAt = Date.now();
      stage = 'applying';

      try {
        // Drizzle is handed the single client rather than the pool, so the
        // transaction it opens runs on the connection whose pid the interrupt
        // handler knows how to cancel. Given a pool it would check out a
        // connection of its own and there would be nothing to cancel.
        await drizzleMigrate(drizzle(applier), { migrationsFolder });
      } catch (error) {
        poisoned = true;

        if (interrupted || sqlStateOf(error) === QUERY_CANCELED) {
          throw new MigrationInterruptedError(
            'Interrupted while applying migrations. The transaction was rolled back, so the ' +
              'schema is exactly as it was before this attempt.',
            { cause: error },
          );
        }

        throw new MigrationFailedError(`Migration failed: ${describeError(error)}`, {
          cause: error,
        });
      } finally {
        // Before anything else touches these connections: a pulse landing on the
        // ROLLBACK Drizzle issues, or on the version read below, would turn a
        // clean interrupt into a confusing second failure.
        stopCancelling();
      }

      const applyMs = Date.now() - applyStartedAt;
      const schemaVersionAfter = await readDatabaseSchemaVersion(applier);

      logger.info(
        {
          appliedCount: pending.length,
          appliedTags: pending,
          applyMs,
          schemaVersion: describeSchemaVersion(schemaVersionAfter),
        },
        `applied ${pending.length} migration(s) in ${applyMs} ms`,
      );

      return {
        appliedTags: pending,
        schemaVersionBefore,
        schemaVersionAfter,
        lockWaitMs,
        applyMs,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      stopCancelling();
      signal?.removeEventListener('abort', onAbort);
    }
  } finally {
    // Three layers, because a lock that outlives a failed deploy is the failure
    // mode nobody can recover from without a DBA: release it explicitly,
    // destroy the connection that held it if anything went wrong, and end the
    // pool so even an unexpected throw closes the session. Postgres releases
    // session-level advisory locks when the connection goes, which is why a
    // SIGKILL is survivable too.
    if (locked && lockClient !== undefined && !poisoned) {
      try {
        await lockClient.query('select pg_advisory_unlock($1::bigint)', [lockKey.toString()]);
      } catch (error) {
        logger.debug({ err: error }, 'advisory unlock failed; the connection will be closed');
        poisoned = true;
      }
    }

    lockClient?.release(poisoned);
    migrationClient?.release(poisoned);

    try {
      await pool.end();
    } catch (error) {
      logger.debug({ err: error }, 'closing the migration pool failed');
    }
  }
}
