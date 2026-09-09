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
 * - **Every failure leaves here classified.** The program above this one turns
 *   the class into an exit code and an operator's deploy script branches on
 *   that (Plan §12.2), so "the database was not there" and "the migration is
 *   broken" must not arrive as the same unlabelled driver error. This is the
 *   only layer that still holds the driver's error, so it is the only one that
 *   can tell them apart.
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
  MigrationJournalError,
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

/**
 * Failures that mean the session is gone, rather than that a statement was bad.
 *
 * The first group is libuv's: no socket was ever opened, or the one there was
 * has died. The second is Postgres answering that it is going away — SQLSTATE
 * class `08` is "connection exception", `57P01`/`57P02` are the shutdown a
 * restarting server sends, `57P03` is a database still coming up, and `53300`
 * is one that has no connection slot to spare right now. Every one of them is
 * a condition the next attempt may well not meet.
 */
const SESSION_LOST_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EAI_AGAIN',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
  '57P01',
  '57P02',
  '57P03',
  '53300',
]);

/**
 * Failures that mean Postgres read the connection string and said no.
 *
 * `28000` and `28P01` are a rejected user or password; `3D000` is a database
 * that does not exist. Nothing about waiting changes any of them — this
 * migration is pointed somewhere it cannot go, and only an operator can move
 * it. Creating the database is deliberately not this program's job: an image
 * that quietly created what it could not find would also quietly migrate the
 * wrong one after a typo.
 */
const UNUSABLE_TARGET_CODES: ReadonlySet<string> = new Set(['28000', '28P01', '3D000']);

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

/**
 * Thrown when the database could not be reached, or went away mid-run.
 *
 * Distinct from {@link MigrationFailedError} because the two lead to opposite
 * decisions by whoever is watching the exit status: a broken migration is a
 * dead end no retry can fix, while a database that is not there yet is the
 * ordinary case of a deploy that started ahead of its Postgres, and the answer
 * is to try again. Only this module holds the driver's error, so only this
 * module can tell them apart — leaving that to the caller means every caller
 * re-deriving it from a `cause`, and getting it wrong once is a wrong
 * operational decision rather than a cosmetic bug (T-044).
 */
export class MigrationUnavailableError extends Error {
  /** Stable, machine-readable identifier for this failure. */
  public readonly code = 'MIGRATION_DATABASE_UNAVAILABLE';

  public constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = 'MigrationUnavailableError';
  }
}

/**
 * Thrown when the database answered and refused: wrong credentials, or no such
 * database.
 *
 * The opposite of {@link MigrationUnavailableError} in the only way that
 * matters. Postgres was reachable — it read the connection string and rejected
 * it — so retrying with the same `DATABASE_URL` fails identically forever. That
 * is a misconfiguration to be fixed by a human, and the exit code has to say so
 * rather than inviting a restart loop.
 */
export class MigrationTargetError extends Error {
  /** Stable, machine-readable identifier for this failure. */
  public readonly code = 'MIGRATION_TARGET_UNUSABLE';

  public constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = 'MigrationTargetError';
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

/** The nested failures of an `AggregateError`, or nothing. */
function nestedErrors(error: unknown): readonly unknown[] {
  return error instanceof AggregateError && Array.isArray(error.errors) ? error.errors : [];
}

/**
 * Every `code` a thrown value carries, its nested failures included.
 *
 * Nesting is not a corner case here: a host that resolves to both `::1` and
 * `127.0.0.1` — which `localhost` does on every developer machine and in most
 * containers — fails as one `AggregateError` wrapping one error per address,
 * and reading only the outer value is how "the database is not up yet" came to
 * look like an ordinary migration failure in the first place.
 */
function errorCodes(error: unknown): string[] {
  const own = sqlStateOf(error);
  const codes = own === undefined ? [] : [own];

  for (const nested of nestedErrors(error)) {
    const code = sqlStateOf(nested);
    if (code !== undefined) codes.push(code);
  }

  return codes;
}

/** Whether the failure means the connection is gone rather than the SQL bad. */
function isSessionLost(error: unknown): boolean {
  return errorCodes(error).some((code) => SESSION_LOST_CODES.has(code));
}

/** Whether Postgres refused the connection string itself. */
function isUnusableTarget(error: unknown): boolean {
  return errorCodes(error).some((code) => UNUSABLE_TARGET_CODES.has(code));
}

/** Human-readable description of a thrown value, for a log line or a message. */
function describeError(error: unknown): string {
  const nested = nestedErrors(error);

  if (nested.length > 0) {
    // An `AggregateError` from a failed connect has an empty `message` and puts
    // everything worth reading in `errors`, so describing it the ordinary way
    // produces a blank sentence. The addresses tried are usually identical bar
    // the family, hence the de-duplication.
    const described = [...new Set(nested.map(describeError))].filter((text) => text !== '');
    if (described.length > 0) return described.join('; ');
  }

  return error instanceof Error ? error.message : String(error);
}

/** Whether a thrown value already carries a meaning, rather than a driver's. */
function isClassified(error: unknown): boolean {
  return (
    error instanceof MigrationFailedError ||
    error instanceof MigrationInterruptedError ||
    error instanceof MigrationLockTimeoutError ||
    error instanceof MigrationTargetError ||
    error instanceof MigrationUnavailableError ||
    error instanceof MigrationJournalError ||
    error instanceof SchemaAheadError
  );
}

/**
 * Gives a driver failure the class its exit code depends on.
 *
 * Three outcomes, because an operator has three different things to do: wait
 * and retry, fix the connection string, or read the migration that broke. The
 * plan's exit codes (§12.2) are exactly this distinction, so it is made once,
 * here, where the driver's error is still intact.
 *
 * @param message - What was being attempted, for the operator reading it.
 * @param cause - Whatever the driver threw.
 */
function classifyDriverFailure(message: string, cause: unknown): Error {
  if (isUnusableTarget(cause)) {
    return new MigrationTargetError(
      `${message}: ${describeError(cause)}. Check the user, password and database name in ` +
        'DATABASE_URL; Postgres answered, so retrying unchanged will fail the same way.',
      { cause },
    );
  }

  if (isSessionLost(cause)) {
    return new MigrationUnavailableError(`${message}: ${describeError(cause)}`, { cause });
  }

  return new MigrationFailedError(`${message}: ${describeError(cause)}`, { cause });
}

/**
 * Takes a connection, or says why it could not.
 *
 * Failing to obtain a session at all is an availability problem by definition:
 * either nothing answered, or what answered refused the credentials. That is
 * why this does not sniff for network error codes the way the mid-run paths do
 * — `pg`'s own connection timeout carries no code at all, and treating an
 * unclassifiable failure here as a broken migration is precisely the bug this
 * function exists to prevent.
 */
async function connect(pool: Pool): Promise<PoolClient> {
  try {
    return await pool.connect();
  } catch (error) {
    if (isUnusableTarget(error)) {
      throw classifyDriverFailure('The database refused this connection', error);
    }

    throw new MigrationUnavailableError(
      `Could not connect to the database: ${describeError(error)}. It may not be accepting ` +
        'connections yet; nothing has been applied, so this is safe to retry.',
      { cause: error },
    );
  }
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
 * @throws {MigrationUnavailableError} If the database could not be reached, or
 * the connection was lost part way through. Nothing was applied; retry.
 * @throws {MigrationTargetError} If Postgres refused the connection string:
 * wrong credentials, or no such database. Retrying will not help.
 * @throws {MigrationFailedError} If a migration itself failed. Its transaction
 * rolled back, so the schema is as it was.
 * @throws {MigrationJournalError} If the migrations folder has no usable
 * journal, or lists no migrations at all.
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

  // A journal listing nothing is refused rather than treated as "nothing to
  // do", because against an empty database the two are indistinguishable from
  // the outside and only one of them is true: the run would report success
  // having created no schema at all, and the server behind it would start and
  // fail on its first query. Migrations are forward-only and cumulative, so a
  // release that legitimately bundles none cannot exist; an empty journal only
  // ever means the image was built wrong or `--migrations` points at the wrong
  // directory (T-044).
  if (bundled.entries.length === 0) {
    throw new MigrationJournalError(
      `The migration journal in ${migrationsFolder} lists no migrations. An image that ` +
        'bundles none would report success against an empty database and leave the server ' +
        'with no schema, so this is a build error rather than a no-op. Point --migrations or ' +
        'MIGRATIONS_DIR at the directory the image ships; inside the server image it is ' +
        '/app/server/drizzle.',
    );
  }

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
    const lock = await connect(pool);
    lockClient = lock;
    const applier = await connect(pool);
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
        throw classifyDriverFailure('Could not take the migration advisory lock', error);
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

        // A connection that died half way through a migration is not a broken
        // migration: the transaction went with it, so the schema is untouched
        // and the next attempt starts from exactly where this one did.
        throw classifyDriverFailure('Migration failed', error);
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
  } catch (error) {
    // The statements outside the two guarded blocks above talk to the database
    // too — reading a backend pid, setting `lock_timeout`, reading the schema
    // version — and a connection dying during one of those is the same
    // retryable condition as one dying during a migration. Left unclassified
    // they reach the caller as an unrecognised driver error, which is how an
    // unreachable database came to be reported as a broken migration.
    throw isClassified(error) ? error : classifyDriverFailure('The migration run failed', error);
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
