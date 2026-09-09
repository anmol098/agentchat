/**
 * The migration program, exercised as a process rather than as a module.
 *
 * The container entrypoint (T-501) runs `node dist/src/migrate.js` and branches
 * on nothing but the exit status. Exit codes, signal handling and the
 * serialisation of two containers starting at once are properties of a
 * *process*: a signal handler that is never installed, or two runs that only
 * happen not to overlap in one event loop, are invisible to a test that imports
 * a function. So this spawns the real program the way the image does, and talks
 * to it with an exit status and a signal — the same approach
 * `bootstrap.integration.test.ts` takes for the server.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

/** Directory of the `server` workspace, whatever the runner's cwd happens to be. */
const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

/** The program, run through tsx so no build step is needed first. */
const ENTRY = fileURLToPath(new URL('../src/migrate.ts', import.meta.url));

/** Exit codes the program documents. */
const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_SCHEMA_AHEAD = 65;
const EXIT_UNAVAILABLE = 69;
const EXIT_CONFIG = 78;
const EXIT_SIGINT = 130;
const EXIT_SIGTERM = 143;

/**
 * The advisory lock the runner takes, from `db/migrate.ts`.
 *
 * Duplicated as a literal rather than imported, because a test that took the
 * lock the implementation currently uses would still pass if the implementation
 * stopped taking one at all. `src/db/tests/migrate.test.ts` pins the constant
 * to its derivation; this pins the running program to the constant.
 */
const MIGRATION_LOCK_KEY = '-7846882383417283556';

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

/** The configured connection string with parts replaced, for the ways one is wrong. */
function urlWith(overrides: { port?: number; password?: string }): string {
  const raw = process.env['DATABASE_URL'];
  if (raw === undefined) {
    throw new Error('DATABASE_URL is not set; the global setup should have refused to start.');
  }

  const url = new URL(raw);
  if (overrides.port !== undefined) url.port = String(overrides.port);
  if (overrides.password !== undefined) url.password = overrides.password;
  return url.toString();
}

/**
 * A loopback port with nothing listening on it.
 *
 * Bound and released rather than picked, so the case under test is "nothing
 * answered" and not "something unexpected did".
 */
async function closedPort(): Promise<number> {
  const probe = createServer();

  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();

  if (address === null || typeof address === 'string') {
    throw new Error('The probe socket did not report a numeric port.');
  }

  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error === undefined ? resolve() : reject(error)));
  });

  return address.port;
}

/** Creates an empty database and returns its connection string. */
async function freshDatabase(label: string): Promise<string> {
  const name = `agentchat_t502cli_${label}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
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
  const folder = mkdtempSync(join(tmpdir(), 'agentchat-cli-migrations-'));
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

/** What a finished migration process left behind. */
interface Finished {
  /** Exit status, or `null` when the process was killed outright. */
  readonly code: number | null;
  /** Signal that killed it, if one did. */
  readonly signal: NodeJS.Signals | null;
  /** Structured log records the program wrote to stdout. */
  readonly records: Record<string, unknown>[];
  /** Everything it wrote to stderr, verbatim. */
  readonly stderr: string;
}

/** A migration process still running, and the promise of what it leaves behind. */
interface Running {
  readonly child: ChildProcess;
  readonly finished: Promise<Finished>;
  /** Resolves once a record matching `predicate` has been seen on stdout. */
  waitFor(predicate: (record: Record<string, unknown>) => boolean): Promise<void>;
}

/**
 * The server's authentication variables.
 *
 * The program itself no longer reads them (T-022) — a schema change uses none
 * of them — but `--on-boot` still does, because there a server start follows in
 * the same breath. Fixed values rather than the developer's own, so a run does
 * not depend on what happens to be exported.
 */
const AUTH_ENV = {
  JWT_SECRET: 'j'.repeat(32),
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
} as const;

/** How a spawned run is configured beyond its own environment. */
interface SpawnOptions {
  /**
   * Whether the process gets {@link AUTH_ENV}. Default true.
   *
   * `false` also strips those names out of the inherited environment, so the
   * case that matters — an operator who has never registered an OAuth app —
   * is genuinely under test rather than masked by the developer's own shell.
   */
  readonly authentication?: boolean;
}

/** Starts the program with exactly the given arguments and environment. */
function startMigration(
  argv: readonly string[],
  env: Record<string, string>,
  options: SpawnOptions = {},
): Running {
  const inherited: NodeJS.ProcessEnv = { ...process.env, ...AUTH_ENV };

  if (options.authentication === false) {
    for (const name of Object.keys(AUTH_ENV)) {
      delete inherited[name];
    }
  }

  const child = spawn(process.execPath, ['--import', 'tsx', ENTRY, ...argv], {
    cwd: SERVER_DIR,
    env: { ...inherited, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const { stdout, stderr } = child;
  if (stdout === null || stderr === null) {
    throw new Error('The spawned migration has no piped stdout/stderr.');
  }

  const records: Record<string, unknown>[] = [];
  const waiters: { matches: (record: Record<string, unknown>) => boolean; resolve: () => void }[] =
    [];
  let pendingLine = '';
  let errorOutput = '';

  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => {
    pendingLine += chunk;
    const lines = pendingLine.split('\n');
    pendingLine = lines.pop() ?? '';

    for (const line of lines) {
      if (line.trim() === '') continue;

      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // Not a log record. The stdout of this program is pino's, so anything
        // else is worth surfacing rather than swallowing.
        record = { raw: line };
      }

      records.push(record);
      for (const waiter of [...waiters]) {
        if (waiter.matches(record)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
    }
  });

  stderr.setEncoding('utf8');
  stderr.on('data', (chunk: string) => {
    errorOutput += chunk;
  });

  const finished = new Promise<Finished>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, records: [...records], stderr: errorOutput });
    });
  });

  return {
    child,
    finished,
    waitFor(predicate): Promise<void> {
      if (records.some(predicate)) return Promise.resolve();

      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Timed out waiting for a log record.'));
        }, 20_000);

        waiters.push({
          matches: predicate,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
    },
  };
}

/** Runs the program to completion. */
async function migrate(
  argv: readonly string[],
  env: Record<string, string>,
  options: SpawnOptions = {},
): Promise<Finished> {
  return await startMigration(argv, env, options).finished;
}

/** Whether a record's message contains `text`. */
function saying(text: string): (record: Record<string, unknown>) => boolean {
  return (record) => typeof record['msg'] === 'string' && record['msg'].includes(text);
}

/**
 * How many advisory locks are held in the database `url` names.
 *
 * Scoped to that database, because `pg_locks` is a view over the whole server's
 * lock table rather than over one database's. Several agents run their suites
 * against one shared container, so an unscoped count also counts theirs: the
 * assertion then passes when the container is quiet and fails when it is busy,
 * in both cases regardless of the code under test. T-018 fixed the same
 * assumption in the module-level suite and flagged the rest; this is the rest.
 */
async function advisoryLockCount(url: string): Promise<number> {
  const count = await scalar(
    url,
    `select count(*)::int from pg_locks
      where locktype = 'advisory'
        and database = (select oid from pg_database where datname = current_database())`,
  );

  return Number(count);
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

/** A migration that takes about three seconds, so a race is observable. */
const SLOW_SQL =
  'CREATE TABLE "slow_marker" ("id" integer);\n--> statement-breakpoint\nSELECT pg_sleep(3);';

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

/**
 * A migration container that was never given the server's credentials (T-022).
 *
 * The three callers this is for are all real: the rollback verification job
 * runs migrations in isolation, an operator applying them before switching
 * traffic runs a container that never serves, and a self-hoster creating their
 * schema has not registered an OAuth app yet — nor should they have to before
 * they can have a database.
 *
 * Spawned rather than called, because "the process exits 0 having applied the
 * migration" is the claim, and a function call cannot make it.
 */
describe('a run with no authentication configured', () => {
  it('applies migrations with only a database URL set', async () => {
    const databaseUrl = await freshDatabase('unauthenticated');

    const finished = await migrate(
      [
        '--migrations',
        migrationFolder('0000_plain', 1_000_000_000_000, 'CREATE TABLE "plain" ("id" integer);'),
      ],
      { DATABASE_URL: databaseUrl },
      { authentication: false },
    );

    expect(finished.code).toBe(EXIT_OK);
    expect(finished.stderr).toBe('');

    // The migration really ran; the exit status is not just an early return.
    await expect(
      scalar(databaseUrl, `select count(*)::int from pg_class where relname = 'plain'`),
    ).resolves.toBe(1);
    await expect(
      scalar(databaseUrl, 'select count(*)::int from drizzle.__drizzle_migrations'),
    ).resolves.toBe(1);
  }, 30_000);

  it('still refuses to migrate as the first half of a server start', async () => {
    const databaseUrl = await freshDatabase('unauthenticated_boot');

    const finished = await migrate(
      [
        '--on-boot',
        '--migrations',
        migrationFolder('0000_plain', 1_000_000_000_000, 'CREATE TABLE "plain" ("id" integer);'),
      ],
      { DATABASE_URL: databaseUrl },
      { authentication: false },
    );

    // The original coupling, kept where it earns its keep: a supervisor that
    // migrates and then serves is told about the missing variables before the
    // schema moves, not after.
    expect(finished.code).toBe(EXIT_CONFIG);
    expect(finished.stderr).toContain('JWT_SECRET');
    expect(finished.stderr).toContain('openssl rand -hex 32');
    expect(finished.stderr).toContain('GITHUB_CLIENT_ID');
    expect(finished.stderr).toContain('https://github.com/settings/developers');

    await expect(
      scalar(databaseUrl, `select to_regclass('drizzle.__drizzle_migrations') is null`),
    ).resolves.toBe(true);
  }, 30_000);
});

describe('two containers starting at the same instant', () => {
  it('has exactly one migrate while the other waits, and both exit 0', async () => {
    const databaseUrl = await freshDatabase('concurrent');
    const migrationsFolder = migrationFolder('0000_slow', 1_000_000_000_000, SLOW_SQL);
    const env = { DATABASE_URL: databaseUrl };
    const argv = ['--migrations', migrationsFolder];

    // Started in the same tick, which is as close to simultaneous as two
    // `docker compose up` replicas ever get.
    const [first, second] = await Promise.all([migrate(argv, env), migrate(argv, env)]);

    expect(first.code).toBe(EXIT_OK);
    expect(second.code).toBe(EXIT_OK);

    const applied = [first, second].filter((run) =>
      run.records.some(saying('applied 1 migration')),
    );
    const waited = [first, second].filter((run) => run.records.some(saying('up to date')));

    expect(applied).toHaveLength(1);
    expect(waited).toHaveLength(1);

    // The waiter really blocked: it sat on the advisory lock for as long as the
    // other process held it, rather than racing past a check.
    const lockWait = waited[0]?.records.find((record) => record['lockWaitMs'] !== undefined);
    expect(Number(lockWait?.['lockWaitMs'])).toBeGreaterThan(1_000);

    await expect(
      scalar(databaseUrl, 'select count(*)::int from drizzle.__drizzle_migrations'),
    ).resolves.toBe(1);
    await expect(advisoryLockCount(databaseUrl)).resolves.toBe(0);
  }, 60_000);
});

describe('MIGRATE_ON_BOOT', () => {
  it('does nothing and exits 0 when it is false at boot', async () => {
    const databaseUrl = await freshDatabase('disabled');

    const finished = await migrate(
      ['--on-boot', '--migrations', migrationFolder('0000_slow', 1_000_000_000_000, SLOW_SQL)],
      {
        DATABASE_URL: databaseUrl,
        MIGRATE_ON_BOOT: 'false',
      },
    );

    expect(finished.code).toBe(EXIT_OK);
    expect(finished.records.some(saying('MIGRATE_ON_BOOT is false'))).toBe(true);

    // Nothing was applied, and the bookkeeping table was never even created.
    await expect(
      scalar(databaseUrl, `select to_regclass('drizzle.__drizzle_migrations') is null`),
    ).resolves.toBe(true);
  }, 30_000);

  it('migrates when it is true', async () => {
    const databaseUrl = await freshDatabase('enabled');

    const finished = await migrate(
      [
        '--on-boot',
        '--migrations',
        migrationFolder('0000_one', 1_000_000_000_000, 'CREATE TABLE "one" ("id" integer);'),
      ],
      { DATABASE_URL: databaseUrl, MIGRATE_ON_BOOT: 'true' },
    );

    expect(finished.code).toBe(EXIT_OK);
    await expect(
      scalar(databaseUrl, 'select count(*)::int from drizzle.__drizzle_migrations'),
    ).resolves.toBe(1);
  }, 30_000);
});

/**
 * The exit codes a deploy script branches on (T-044, Plan §12.2).
 *
 * Every one is caused rather than simulated: the process is started the way the
 * container entrypoint starts it and its real exit status is read. That is the
 * only kind of test that can catch what this task was filed for — an
 * unreachable database exited 1, "a migration failed, do not retry", for a
 * condition that clears on its own — because the mapping the program contains
 * was correct all along and simply never saw the error.
 */
describe('the exit codes an orchestrator branches on', () => {
  /** A migration the run never reaches, because it fails before applying. */
  const unreached = (): string => migrationFolder('0000_unreached', 1_000_000_000_000, 'SELECT 1;');

  it('exits 69 when nothing is listening on the database port', async () => {
    const finished = await migrate(['--migrations', unreached()], {
      DATABASE_URL: urlWith({ port: await closedPort() }),
    });

    expect(finished.code).toBe(EXIT_UNAVAILABLE);
  }, 30_000);

  it('exits 69 while another process holds the migration lock', async () => {
    // The one condition here that is not about the connection: the database is
    // reachable and busy. Same advice — wait and try again — so the same code.
    const databaseUrl = await freshDatabase('lock_busy');
    const holder = new Pool({ connectionString: databaseUrl });

    try {
      const client = await holder.connect();
      await client.query('select pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);

      const finished = await migrate(
        ['--migrations', migrationFolder('0000_blocked', 1_000_000_000_000, SLOW_SQL)],
        { DATABASE_URL: databaseUrl, MIGRATION_LOCK_TIMEOUT_MS: '1000' },
      );

      expect(finished.code).toBe(EXIT_UNAVAILABLE);

      // Unlocked explicitly rather than by dropping the connection. Closing a
      // socket releases a session lock too, but only once Postgres has reaped
      // the backend, and the tests after this one count advisory locks across
      // the whole server — a lock that outlives its test by a few milliseconds
      // is a failure somewhere else, in a file that looks innocent.
      await client.query('select pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY]);
      client.release();
    } finally {
      await holder.end();
    }
  }, 60_000);

  it('exits 78 when the credentials are wrong', async () => {
    // Reachable, and refused. Retrying cannot help, so this must not look like
    // the case above however similar the two feel from a log line.
    const finished = await migrate(['--migrations', unreached()], {
      DATABASE_URL: urlWith({ password: 'not-the-password' }),
    });

    expect(finished.code).toBe(EXIT_CONFIG);
    expect(finished.stderr).toContain('DATABASE_URL');
  }, 30_000);

  it('exits 78 when the image bundles no migrations, rather than 0', async () => {
    // Worse than a wrong exit code if it were allowed: a deploy that reports
    // success with no schema applied, and a server that starts against nothing.
    const databaseUrl = await freshDatabase('empty_journal');
    const folder = mkdtempSync(join(tmpdir(), 'agentchat-cli-migrations-'));
    directories.push(folder);
    mkdirSync(join(folder, 'meta'), { recursive: true });
    writeFileSync(join(folder, 'meta', '_journal.json'), '{"entries":[]}', 'utf8');

    const finished = await migrate(['--migrations', folder], { DATABASE_URL: databaseUrl });

    expect(finished.code).toBe(EXIT_CONFIG);
    expect(finished.stderr).toContain('lists no migrations');

    await expect(
      scalar(databaseUrl, `select to_regclass('drizzle.__drizzle_migrations') is null`),
    ).resolves.toBe(true);
  }, 30_000);

  it('exits 1 when a migration itself fails', async () => {
    // The code that means "read the log, this will not fix itself", left for
    // the one condition that actually deserves it.
    const databaseUrl = await freshDatabase('broken_migration');
    const folder = migrationFolder(
      '0000_broken',
      1_000_000_000_000,
      'CREATE TABLE "half_applied" ("id" integer);\n--> statement-breakpoint\nSELECT 1 / 0;',
    );

    const finished = await migrate(['--migrations', folder], { DATABASE_URL: databaseUrl });

    expect(finished.code).toBe(EXIT_FAILURE);
    await expect(
      scalar(databaseUrl, `select count(*)::int from pg_class where relname = 'half_applied'`),
    ).resolves.toBe(0);
  }, 30_000);
});

describe('SIGTERM part way through a migration', () => {
  it('rolls back, releases the lock, and exits as a signalled process would', async () => {
    const databaseUrl = await freshDatabase('sigterm');
    const migrationsFolder = migrationFolder('0000_slow', 1_000_000_000_000, SLOW_SQL);

    const running = startMigration(['--migrations', migrationsFolder], {
      DATABASE_URL: databaseUrl,
    });

    await running.waitFor(saying('applying 1 migration'));
    running.child.kill('SIGTERM');

    const finished = await running.finished;

    // 143 rather than 1: the container entrypoint treats a status above 128 as
    // "the operator stopped this", not "a migration is broken". Getting this
    // wrong sends somebody hunting for a bad migration after a routine restart.
    expect(finished.code).toBe(EXIT_SIGTERM);
    expect(finished.records.some(saying('interrupt received'))).toBe(true);

    await expect(
      scalar(databaseUrl, `select count(*)::int from pg_class where relname = 'slow_marker'`),
    ).resolves.toBe(0);
    await expect(advisoryLockCount(databaseUrl)).resolves.toBe(0);

    // And the next start succeeds, which is the whole point of rolling back.
    const retry = await migrate(['--migrations', migrationsFolder], { DATABASE_URL: databaseUrl });
    expect(retry.code).toBe(EXIT_OK);
  }, 60_000);

  it('reports SIGINT as 130, the way a shell reports a Ctrl-C', async () => {
    // The table documents both, and an operator pressing Ctrl-C on a `docker
    // compose run migrate` is the ordinary way to reach this one. A signalled
    // run is not a failed migration, whichever signal did it.
    const databaseUrl = await freshDatabase('sigint');
    const migrationsFolder = migrationFolder('0000_slow', 1_000_000_000_000, SLOW_SQL);

    const running = startMigration(['--migrations', migrationsFolder], {
      DATABASE_URL: databaseUrl,
    });

    await running.waitFor(saying('applying 1 migration'));
    running.child.kill('SIGINT');

    const finished = await running.finished;

    expect(finished.code).toBe(EXIT_SIGINT);
    await expect(
      scalar(databaseUrl, `select count(*)::int from pg_class where relname = 'slow_marker'`),
    ).resolves.toBe(0);
  }, 60_000);
});

describe('a database migrated by a newer version', () => {
  it('is refused with exit 65 and a message naming the version it needs', async () => {
    const databaseUrl = await freshDatabase('ahead');
    const migrationsFolder = migrationFolder(
      '0000_old',
      1_700_000_000_000,
      'CREATE TABLE "old_thing" ("id" integer);',
    );

    const first = await migrate(['--migrations', migrationsFolder], { DATABASE_URL: databaseUrl });
    expect(first.code).toBe(EXIT_OK);

    // What a newer release leaves behind before somebody rolls the image back.
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await pool.query(
        `insert into drizzle.__drizzle_migrations ("hash", "created_at")
         values ('from-a-newer-release', 1893456000000)`,
      );
    } finally {
      await pool.end();
    }

    const refused = await migrate(['--migrations', migrationsFolder], {
      DATABASE_URL: databaseUrl,
    });

    expect(refused.code).toBe(EXIT_SCHEMA_AHEAD);
    // The paragraph goes to stderr as prose, not only as an escaped JSON field:
    // this is what an operator reads in `docker compose logs` mid-deploy.
    expect(refused.stderr).toContain('the database schema is newer than this server image');
    expect(refused.stderr).toContain('1893456000000');
    expect(refused.stderr).toContain('AGENTCHAT_ALLOW_SCHEMA_AHEAD');

    // Refusing must not also wedge the database.
    await expect(advisoryLockCount(databaseUrl)).resolves.toBe(0);

    // And the documented, deliberate rollback still has a way through.
    const forced = await migrate(['--migrations', migrationsFolder], {
      DATABASE_URL: databaseUrl,
      AGENTCHAT_ALLOW_SCHEMA_AHEAD: 'true',
    });
    expect(forced.code).toBe(EXIT_OK);
  }, 60_000);
});
