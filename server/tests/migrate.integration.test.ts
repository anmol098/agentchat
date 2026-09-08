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
const EXIT_SCHEMA_AHEAD = 65;
const EXIT_SIGTERM = 143;

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
 * The authentication variables every spawned process needs since T-019.
 *
 * `loadConfig` requires them, and it is loaded before anything else so that a
 * process fails for the same reasons as the server it is part of. Fixed values
 * rather than the developer's own, so a run does not depend on what happens to
 * be exported.
 */
const AUTH_ENV = {
  JWT_SECRET: 'j'.repeat(32),
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
} as const;

/** Starts the program with exactly the given arguments and environment. */
function startMigration(argv: readonly string[], env: Record<string, string>): Running {
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRY, ...argv], {
    cwd: SERVER_DIR,
    env: { ...process.env, ...AUTH_ENV, ...env },
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
async function migrate(argv: readonly string[], env: Record<string, string>): Promise<Finished> {
  return await startMigration(argv, env).finished;
}

/** Whether a record's message contains `text`. */
function saying(text: string): (record: Record<string, unknown>) => boolean {
  return (record) => typeof record['msg'] === 'string' && record['msg'].includes(text);
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
    await expect(
      scalar(databaseUrl, `select count(*)::int from pg_locks where locktype = 'advisory'`),
    ).resolves.toBe(0);
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
    await expect(
      scalar(databaseUrl, `select count(*)::int from pg_locks where locktype = 'advisory'`),
    ).resolves.toBe(0);

    // And the next start succeeds, which is the whole point of rolling back.
    const retry = await migrate(['--migrations', migrationsFolder], { DATABASE_URL: databaseUrl });
    expect(retry.code).toBe(EXIT_OK);
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
    await expect(
      scalar(databaseUrl, `select count(*)::int from pg_locks where locktype = 'advisory'`),
    ).resolves.toBe(0);

    // And the documented, deliberate rollback still has a way through.
    const forced = await migrate(['--migrations', migrationsFolder], {
      DATABASE_URL: databaseUrl,
      AGENTCHAT_ALLOW_SCHEMA_AHEAD: 'true',
    });
    expect(forced.code).toBe(EXIT_OK);
  }, 60_000);
});
