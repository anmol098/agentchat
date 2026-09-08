/**
 * The migration runner against a real PostgreSQL.
 *
 * Everything worth knowing about this module is a property of a Postgres
 * session — an advisory lock that another connection can see, a transaction
 * that rolls back, a statement that can be cancelled — so none of it can be
 * shown with a mock. Each case gets its own freshly created database, for the
 * reason the identity schema tests give: a migration must be watched applying
 * to a genuinely empty database, and integration tests share one server.
 *
 * Fixtures rather than the repository's own migrations, for the cases that need
 * a migration to be slow or to fail: `server/drizzle/` belongs to other tasks
 * and a test that depended on its contents would break the day one is added.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MigrationFailedError,
  MigrationInterruptedError,
  MigrationLockTimeoutError,
  runMigrations,
} from '../migrate.js';
import { SchemaAheadError } from '../version-guard.js';

/** The migrations the image really ships, for the fresh-install case. */
const SHIPPED_MIGRATIONS = fileURLToPath(new URL('../../../drizzle', import.meta.url));

/**
 * A lock key of this run's own, drawn fresh every time the file is loaded.
 *
 * It cannot be a constant. Advisory locks are held per database, but `pg_locks`
 * is not scoped to one: it reports every backend on the whole server, so a
 * count against a fixed key also counts the locks some other process holds for
 * that same key in a database of its own. Several agents run their suites
 * against one shared PostgreSQL container at a time, and with a fixed key the
 * assertions below passed when the container was idle and failed when it was
 * busy — in both cases regardless of the code under test. That is the worst
 * property a flaky test can have, because the failure looks exactly like a real
 * defect in the locking logic.
 *
 * Random rather than derived from the pid or the database name, because the
 * colliding run may be on another machine, in another container, pointed at the
 * same server. Sixty-four random bits make a collision — with another run of
 * this suite, with the production key, or with a developer's own server —
 * not worth guarding against further.
 *
 * Belt and braces: {@link advisoryLockCount} and
 * {@link runningMigrationStatements} additionally restrict themselves to the
 * database the query is running in, so neither can see another run even if two
 * keys somehow met.
 */
const TEST_LOCK_KEY = BigInt.asIntN(64, BigInt(`0x${randomBytes(8).toString('hex')}`));

/** Silent, because these tests assert on the database, not on log lines. */
const logger = pino({ level: 'silent' });

/** Scratch databases and directories to clean up. */
const databases: string[] = [];
const directories: string[] = [];

/** Connection string for `name` on the server `DATABASE_URL` points at. */
function urlFor(name: string): string {
  const raw = process.env['DATABASE_URL'];
  if (raw === undefined) {
    throw new Error('DATABASE_URL is not set; the global setup should have refused to start.');
  }

  const url = new URL(raw);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Creates an empty database and returns its connection string. */
async function freshDatabase(label: string): Promise<string> {
  const name = `agentchat_t502_${label}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });

  try {
    await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }

  databases.push(name);
  return urlFor(name);
}

/** Writes a one-migration folder whose SQL is `sql`. */
function migrationFolder(tag: string, when: number, sql: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'agentchat-migrations-'));
  directories.push(folder);

  mkdirSync(join(folder, 'meta'), { recursive: true });
  writeFileSync(join(folder, `${tag}.sql`), sql, 'utf8');
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: [{ idx: 0, version: '7', when, tag, breakpoints: true }],
    }),
    'utf8',
  );

  return folder;
}

/** Runs a query against `url` and returns the first column of the first row. */
async function scalar(url: string, sql: string): Promise<unknown> {
  const pool = new Pool({ connectionString: url });
  try {
    const result = await pool.query(sql);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row === undefined ? undefined : Object.values(row)[0];
  } finally {
    await pool.end();
  }
}

/** How many advisory locks are held for `key` in the database `url` names. */
async function advisoryLockCount(url: string, key: bigint): Promise<number> {
  // `pg_locks` reports a bigint advisory key split across classid and objid.
  const unsigned = BigInt.asUintN(64, key);
  const classid = Number(unsigned >> 32n);
  const objid = Number(unsigned & 0xffff_ffffn);

  const count = await scalar(
    url,
    // `pg_locks` is a view over the whole server's lock table, not over this
    // database's, so both halves of the filter matter: the key narrows it to
    // this run, and `database` narrows it to this case's scratch database.
    // Without them the count includes whatever another agent's suite is holding
    // on the shared container.
    `select count(*)::int from pg_locks
      where locktype = 'advisory'
        and classid = ${classid}
        and objid = ${objid}
        and database = (select oid from pg_database where datname = current_database())`,
  );

  return Number(count);
}

/** How many migration statements are executing right now in this database. */
async function runningMigrationStatements(url: string): Promise<number> {
  const count = await scalar(
    url,
    // `pg_stat_activity` is server-wide too, and `agentchat-migrate` is the
    // application name every migration run uses — including the ones other
    // suites are spawning right now. `datname` is what keeps this to our own.
    `select count(*)::int from pg_stat_activity
      where application_name = 'agentchat-migrate'
        and datname = current_database()
        and state = 'active'
        and query ilike '%pg_sleep%'`,
  );

  return Number(count);
}

/** Waits until `condition` holds, or gives up. Used instead of a fixed sleep. */
async function until(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error('Timed out waiting for a condition to hold.');
}

/** A migration that takes about three seconds, so a race is observable. */
const SLOW_SQL =
  'CREATE TABLE "slow_marker" ("id" integer);\n--> statement-breakpoint\nSELECT pg_sleep(3);';

/** A migration that creates a table and then fails, mid-transaction. */
const FAILING_SQL =
  'CREATE TABLE "half_applied" ("id" integer);\n--> statement-breakpoint\nSELECT 1 / 0;';

afterAll(async () => {
  for (const folder of directories) {
    rmSync(folder, { recursive: true, force: true });
  }

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    for (const name of databases) {
      await admin.query(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await admin.end();
  }
});

describe('applying the migrations this repository ships', () => {
  let databaseUrl: string;

  beforeAll(async () => {
    databaseUrl = await freshDatabase('shipped');
  });

  it('applies them to an empty database and records the schema version', async () => {
    const result = await runMigrations({
      databaseUrl,
      migrationsFolder: SHIPPED_MIGRATIONS,
      logger,
      lockKey: TEST_LOCK_KEY,
    });

    expect(result.appliedTags.length).toBeGreaterThan(0);
    expect(result.schemaVersionBefore).toBeNull();
    expect(result.schemaVersionAfter).not.toBeNull();
    expect(result.applyMs).toBeGreaterThanOrEqual(0);
  });

  it('does nothing the second time, and says so', async () => {
    const result = await runMigrations({
      databaseUrl,
      migrationsFolder: SHIPPED_MIGRATIONS,
      logger,
      lockKey: TEST_LOCK_KEY,
    });

    expect(result.appliedTags).toEqual([]);
    expect(result.applyMs).toBe(0);
    expect(result.schemaVersionAfter).toBe(result.schemaVersionBefore);
  });

  it('leaves no advisory lock behind', async () => {
    await expect(advisoryLockCount(databaseUrl, TEST_LOCK_KEY)).resolves.toBe(0);
  });
});

describe('two runs starting at the same time', () => {
  it('lets exactly one migrate while the other waits and then finds nothing to do', async () => {
    const databaseUrl = await freshDatabase('concurrent');
    const migrationsFolder = migrationFolder('0000_slow', 1_000_000_000_000, SLOW_SQL);

    const run = (): ReturnType<typeof runMigrations> =>
      runMigrations({ databaseUrl, migrationsFolder, logger, lockKey: TEST_LOCK_KEY });

    const [first, second] = await Promise.all([run(), run()]);

    const applied = [first, second].filter((result) => result.appliedTags.length > 0);
    const waited = [first, second].filter((result) => result.appliedTags.length === 0);

    expect(applied).toHaveLength(1);
    expect(waited).toHaveLength(1);

    // The one that did nothing did not simply skip: it blocked on the lock for
    // as long as the other held it. Without the lock both would have entered
    // Drizzle's migrator, and one would have failed on a duplicate table.
    expect(waited[0]?.lockWaitMs).toBeGreaterThan(1_000);
    expect(applied[0]?.lockWaitMs).toBeLessThan(1_000);

    // And Postgres agrees the migration ran exactly once.
    await expect(
      scalar(databaseUrl, 'select count(*)::int from drizzle.__drizzle_migrations'),
    ).resolves.toBe(1);
    await expect(advisoryLockCount(databaseUrl, TEST_LOCK_KEY)).resolves.toBe(0);
  });
});

describe('when a migration fails', () => {
  let databaseUrl: string;

  beforeAll(async () => {
    databaseUrl = await freshDatabase('failing');
  });

  it('reports the failure with a stable code', async () => {
    await expect(
      runMigrations({
        databaseUrl,
        migrationsFolder: migrationFolder('0000_bad', 1_000_000_000_000, FAILING_SQL),
        logger,
        lockKey: TEST_LOCK_KEY,
      }),
    ).rejects.toMatchObject({ code: 'MIGRATION_FAILED' });
  });

  it('rolls the whole thing back, so nothing is half-applied', async () => {
    // The failing migration creates a table before the statement that fails.
    // Postgres DDL is transactional, which is the only reason a boot-time
    // migrator can be safe at all.
    await expect(
      scalar(databaseUrl, `select count(*)::int from pg_class where relname = 'half_applied'`),
    ).resolves.toBe(0);
  });

  it('releases the advisory lock, so the next attempt is not deadlocked forever', async () => {
    await expect(advisoryLockCount(databaseUrl, TEST_LOCK_KEY)).resolves.toBe(0);
  });

  it('lets the next attempt take the lock immediately', async () => {
    const result = await runMigrations({
      databaseUrl,
      migrationsFolder: migrationFolder(
        '0000_good',
        1_000_000_000_000,
        'CREATE TABLE "ok" ("id" integer);',
      ),
      logger,
      lockKey: TEST_LOCK_KEY,
      lockTimeoutMs: 2_000,
    });

    expect(result.appliedTags).toEqual(['0000_good']);
    expect(result.lockWaitMs).toBeLessThan(1_000);
  });
});

describe('when the run is interrupted', () => {
  let databaseUrl: string;
  let thrown: unknown;

  beforeAll(async () => {
    databaseUrl = await freshDatabase('interrupted');
    const migrationsFolder = migrationFolder('0000_slow', 1_000_000_000_000, SLOW_SQL);
    const controller = new AbortController();

    const running = runMigrations({
      databaseUrl,
      migrationsFolder,
      logger,
      lockKey: TEST_LOCK_KEY,
      signal: controller.signal,
    });

    // Abort only once a statement of the migration is genuinely executing. The
    // property under test is that a *running* migration is cancelled and rolled
    // back; aborting before it started would prove nothing and would pass even
    // if cancellation did not work at all.
    await until(async () => (await runningMigrationStatements(databaseUrl)) > 0);
    controller.abort('SIGTERM');

    try {
      await running;
    } catch (error) {
      thrown = error;
    }
  }, 30_000);

  it('reports an interruption rather than a failed migration', () => {
    expect(thrown).toBeInstanceOf(MigrationInterruptedError);
    expect(thrown).not.toBeInstanceOf(MigrationFailedError);
  });

  it('leaves no half-applied schema: the transaction rolled back', async () => {
    await expect(
      scalar(databaseUrl, `select count(*)::int from pg_class where relname = 'slow_marker'`),
    ).resolves.toBe(0);
    // The bookkeeping table itself survives: Drizzle creates the schema and the
    // table *before* opening the transaction, so an interrupted run leaves an
    // empty table rather than none. What matters is that no migration is
    // recorded as applied, because that is what the next start reads.
    await expect(
      scalar(databaseUrl, 'select count(*)::int from drizzle.__drizzle_migrations'),
    ).resolves.toBe(0);
  });

  it('releases the advisory lock', async () => {
    await expect(advisoryLockCount(databaseUrl, TEST_LOCK_KEY)).resolves.toBe(0);
  });

  it('lets a later attempt apply the same migration cleanly', async () => {
    const result = await runMigrations({
      databaseUrl,
      migrationsFolder: migrationFolder('0000_slow', 1_000_000_000_000, SLOW_SQL),
      logger,
      lockKey: TEST_LOCK_KEY,
      lockTimeoutMs: 5_000,
    });

    expect(result.appliedTags).toEqual(['0000_slow']);
  }, 30_000);

  it('refuses immediately when the signal is already aborted', async () => {
    await expect(
      runMigrations({
        databaseUrl,
        migrationsFolder: SHIPPED_MIGRATIONS,
        logger,
        lockKey: TEST_LOCK_KEY,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toBeInstanceOf(MigrationInterruptedError);
  });
});

describe('when another process is holding the lock', () => {
  it('gives up after the lock timeout with an actionable message', async () => {
    const databaseUrl = await freshDatabase('locked');
    const holder = new Pool({ connectionString: databaseUrl, max: 1 });

    try {
      await holder.query('select pg_advisory_lock($1::bigint)', [TEST_LOCK_KEY.toString()]);

      const failure = runMigrations({
        databaseUrl,
        migrationsFolder: SHIPPED_MIGRATIONS,
        logger,
        lockKey: TEST_LOCK_KEY,
        lockTimeoutMs: 500,
      });

      await expect(failure).rejects.toBeInstanceOf(MigrationLockTimeoutError);
      // "Wait and retry" rather than "unlock it by hand": there is never
      // anything for an operator to unlock, and telling them there is would
      // send them poking at a database mid-deploy.
      await expect(failure).rejects.toThrow('Wait and retry');
    } finally {
      await holder.end();
    }
  });
});

describe('when the database is newer than this image', () => {
  let databaseUrl: string;

  /** A migration folder that stops at 2026, next to a database that reached 2030. */
  const oldImage = (): string =>
    migrationFolder('0000_old', 1_700_000_000_000, 'CREATE TABLE "old_thing" ("id" integer);');

  beforeAll(async () => {
    databaseUrl = await freshDatabase('ahead');

    // Apply the old image's migration, then record a migration from a version
    // this image has never seen — exactly what a newer release would leave
    // behind before somebody rolled the image back.
    await runMigrations({
      databaseUrl,
      migrationsFolder: oldImage(),
      logger,
      lockKey: TEST_LOCK_KEY,
    });

    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await pool.query(
        `insert into drizzle.__drizzle_migrations ("hash", "created_at")
         values ('from-a-newer-release', 1893456000000)`,
      );
    } finally {
      await pool.end();
    }
  });

  it('refuses, naming the version the database needs', async () => {
    const failure = runMigrations({
      databaseUrl,
      migrationsFolder: oldImage(),
      logger,
      lockKey: TEST_LOCK_KEY,
    });

    await expect(failure).rejects.toBeInstanceOf(SchemaAheadError);
    await expect(failure).rejects.toMatchObject({
      code: 'SCHEMA_AHEAD_OF_BINARY',
      databaseVersion: 1_893_456_000_000,
      imageVersion: 1_700_000_000_000,
    });
    await expect(failure).rejects.toThrow('1893456000000');
  });

  it('releases the lock on the way out, so the refusal is not also an outage', async () => {
    await expect(advisoryLockCount(databaseUrl, TEST_LOCK_KEY)).resolves.toBe(0);
  });

  it('proceeds when the operator has explicitly opted in to a rollback', async () => {
    const result = await runMigrations({
      databaseUrl,
      migrationsFolder: oldImage(),
      logger,
      lockKey: TEST_LOCK_KEY,
      allowSchemaAhead: true,
    });

    expect(result.appliedTags).toEqual([]);
  });
});
