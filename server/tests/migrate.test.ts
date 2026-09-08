/**
 * The migration program's argument and environment handling.
 *
 * These are the paths that decide whether a database is touched at all, so they
 * are tested without one: every case here returns before a connection is
 * opened. The paths that do open one are in `migrate.integration.test.ts`,
 * where they are exercised as processes.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  EXIT_CONFIG,
  EXIT_OK,
  migrateOnBoot,
  parseArguments,
  resolveMigrationsFolder,
  run,
} from '../src/migrate.js';

/** A syntactically valid connection string that is never actually dialled. */
const DATABASE_URL = 'postgres://agentchat:agentchat@localhost:5432/agentchat';

/**
 * The environment a migration run actually needs, and nothing more.
 *
 * `LOG_LEVEL=silent` because the logger writes to file descriptor 1 directly,
 * which Vitest cannot capture: without it every one of these cases would print
 * a JSON record into the test report.
 *
 * There are deliberately no authentication variables here (T-022). This program
 * used to load the server's whole configuration before migrating anything, so
 * that a run failed for the same reasons as the server it precedes. Once
 * authentication landed that meant an operator had to hand a migration
 * container a signing key and an OAuth app to apply SQL that reads neither.
 */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { DATABASE_URL, LOG_LEVEL: 'silent', ...overrides };
}

/** The authentication variables, for the cases that still require them. */
const AUTHENTICATION = {
  JWT_SECRET: 'j'.repeat(32),
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
} as const;

/** The environment a supervisor that migrates and then serves would supply. */
function bootEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return env({ ...AUTHENTICATION, ...overrides });
}

/** Directories made here, removed once the file is done. */
const scratchDirectories: string[] = [];

/** A directory tree with `<root>/<...nesting>/` and a journal at `<root>/drizzle`. */
function imageLayout(nesting: string[]): { root: string; moduleDirectory: string } {
  const root = mkdtempSync(join(tmpdir(), 'agentchat-layout-'));
  scratchDirectories.push(root);

  mkdirSync(join(root, 'drizzle', 'meta'), { recursive: true });
  writeFileSync(join(root, 'drizzle', 'meta', '_journal.json'), '{"entries":[]}', 'utf8');

  const moduleDirectory = join(root, ...nesting);
  mkdirSync(moduleDirectory, { recursive: true });

  return { root, moduleDirectory };
}

/** Collects what `run` wrote, so a test can assert on prose meant for a human. */
function capture(): { text: () => string; write: (chunk: string) => void } {
  let buffer = '';
  return {
    text: (): string => buffer,
    write: (chunk: string): void => {
      buffer += chunk;
    },
  };
}

afterAll(() => {
  for (const folder of scratchDirectories) {
    rmSync(folder, { recursive: true, force: true });
  }
});

describe('parsing arguments', () => {
  it('defaults to migrating, from the bundled directory', () => {
    expect(parseArguments([])).toEqual({
      help: false,
      onBoot: false,
      migrationsFolder: undefined,
      lockTimeoutMs: undefined,
    });
  });

  it('takes the migrations directory explicitly', () => {
    expect(parseArguments(['--migrations', '/app/server/drizzle']).migrationsFolder).toBe(
      '/app/server/drizzle',
    );
  });

  it('takes a lock timeout', () => {
    expect(parseArguments(['--lock-timeout', '5000']).lockTimeoutMs).toBe(5_000);
  });

  it('refuses an unknown flag rather than ignoring it', () => {
    // A deploy script with a typo that quietly migrated the default directory
    // would be far worse than one that failed.
    expect(() => parseArguments(['--migrate-everything'])).toThrow('Unknown argument');
  });

  it('refuses a flag whose value is missing', () => {
    expect(() => parseArguments(['--migrations'])).toThrow('--migrations needs a value');
    expect(() => parseArguments(['--migrations', '--on-boot'])).toThrow(
      '--migrations needs a value',
    );
  });

  it('refuses a lock timeout that is not a number of milliseconds', () => {
    expect(() => parseArguments(['--lock-timeout', '30s'])).toThrow('whole number');
  });
});

describe('MIGRATE_ON_BOOT', () => {
  it('defaults to migrating when unset or blank', () => {
    expect(migrateOnBoot({})).toBe(true);
    expect(migrateOnBoot({ MIGRATE_ON_BOOT: '   ' })).toBe(true);
  });

  it.each(['1', 'true', 'TRUE', 'yes', 'on'])('treats %s as enabled', (value) => {
    expect(migrateOnBoot({ MIGRATE_ON_BOOT: value })).toBe(true);
  });

  it.each(['0', 'false', 'FALSE', 'no', 'off'])('treats %s as disabled', (value) => {
    expect(migrateOnBoot({ MIGRATE_ON_BOOT: value })).toBe(false);
  });

  it('refuses a value it does not recognise instead of falling back to the default', () => {
    // The operator who wrote something else is the one who needed to be told;
    // the container entrypoint refuses the same values for the same reason.
    expect(() => migrateOnBoot({ MIGRATE_ON_BOOT: 'no-please' })).toThrow(
      "MIGRATE_ON_BOOT must be true or false (got 'no-please')",
    );
  });
});

describe('finding the bundled migrations', () => {
  it('finds them from the compiled layout, dist/src/migrate.js', () => {
    const { root, moduleDirectory } = imageLayout(['dist', 'src']);

    expect(resolveMigrationsFolder(moduleDirectory)).toBe(join(root, 'drizzle'));
  });

  it('finds them from the source layout, src/migrate.ts under tsx', () => {
    const { root, moduleDirectory } = imageLayout(['src']);

    expect(resolveMigrationsFolder(moduleDirectory)).toBe(join(root, 'drizzle'));
  });

  it('names every path it looked at when there are none', () => {
    const empty = mkdtempSync(join(tmpdir(), 'agentchat-layout-'));
    scratchDirectories.push(empty);

    expect(() => resolveMigrationsFolder(empty)).toThrow('No bundled migrations found');
    expect(() => resolveMigrationsFolder(empty)).toThrow('--migrations');
  });
});

describe('running the program', () => {
  it('prints usage for --help and succeeds', async () => {
    const stdout = capture();

    await expect(
      run({ argv: ['--help'], env: env(), moduleDirectory: '/nowhere', stdout: stdout.write }),
    ).resolves.toBe(EXIT_OK);

    expect(stdout.text()).toContain('--migrations <dir>');
    expect(stdout.text()).toContain('AGENTCHAT_ALLOW_SCHEMA_AHEAD');
  });

  it('does nothing, successfully, when MIGRATE_ON_BOOT is false at boot', async () => {
    // Exit 0 and no database contact: the operator applies migrations as a
    // separate step, and refusing to boot would defeat the point of the switch.
    await expect(
      run({
        argv: ['--on-boot'],
        env: bootEnv({ MIGRATE_ON_BOOT: 'false' }),
        moduleDirectory: '/nowhere',
      }),
    ).resolves.toBe(EXIT_OK);
  });

  it('reports an unusable MIGRATE_ON_BOOT as a configuration error', async () => {
    const stderr = capture();

    await expect(
      run({
        argv: ['--on-boot'],
        env: bootEnv({ MIGRATE_ON_BOOT: 'maybe' }),
        moduleDirectory: '/nowhere',
        stderr: stderr.write,
      }),
    ).resolves.toBe(EXIT_CONFIG);

    expect(stderr.text()).toContain('MIGRATE_ON_BOOT must be true or false');
  });

  it('reports an unknown argument as a configuration error, on stderr', async () => {
    const stderr = capture();

    await expect(
      run({ argv: ['--force'], env: env(), moduleDirectory: '/nowhere', stderr: stderr.write }),
    ).resolves.toBe(EXIT_CONFIG);

    expect(stderr.text()).toContain('Unknown argument');
  });

  it('reports a missing DATABASE_URL the way the server does', async () => {
    const stderr = capture();

    await expect(
      run({
        argv: [],
        env: { LOG_LEVEL: 'silent' },
        moduleDirectory: '/nowhere',
        stderr: stderr.write,
      }),
    ).resolves.toBe(EXIT_CONFIG);

    expect(stderr.text()).toContain('DATABASE_URL');
  });

  it('reports an image with no bundled migrations as a configuration error', async () => {
    const stderr = capture();

    await expect(
      run({ argv: [], env: env(), moduleDirectory: '/nowhere', stderr: stderr.write }),
    ).resolves.toBe(EXIT_CONFIG);

    expect(stderr.text()).toContain('No bundled migrations found');
  });
});

/**
 * How much of the environment a run demands (T-022).
 *
 * Two behaviours, and they are the same decision seen from both sides. A run on
 * its own asks for what a migration reads. A run that is the first half of a
 * server start — `--on-boot` — asks for everything, because the server that
 * follows genuinely needs it and finding that out after the schema has moved is
 * worse than finding it out before.
 *
 * That a migration then *succeeds* without the authentication variables is
 * proved against a real database in `migrate.integration.test.ts`; what is
 * checked here is that nothing stops it on the way.
 */
describe('the configuration a run requires', () => {
  it('does not ask for the authentication variables', async () => {
    const stderr = capture();

    // Reaching the bundled-migrations lookup is the point: that is the last
    // step before a connection is opened, so nothing turned this run away over
    // a signing key or an OAuth app on the way there.
    await expect(
      run({ argv: [], env: env(), moduleDirectory: '/nowhere', stderr: stderr.write }),
    ).resolves.toBe(EXIT_CONFIG);

    expect(stderr.text()).toContain('No bundled migrations found');
    expect(stderr.text()).not.toContain('JWT_SECRET');
    expect(stderr.text()).not.toContain('GITHUB_CLIENT_ID');
    expect(stderr.text()).not.toContain('GITHUB_CLIENT_SECRET');
  });

  it('says what it needs without sending the operator to register an OAuth app', async () => {
    const stderr = capture();

    await expect(
      run({
        argv: [],
        env: { LOG_LEVEL: 'silent' },
        moduleDirectory: '/nowhere',
        stderr: stderr.write,
      }),
    ).resolves.toBe(EXIT_CONFIG);

    expect(stderr.text()).toContain('DATABASE_URL');
    expect(stderr.text()).toContain('docker compose up -d postgres');
    expect(stderr.text()).not.toContain('github.com/settings/developers');
  });

  it('still requires the whole server configuration at boot', async () => {
    const stderr = capture();

    await expect(
      run({ argv: ['--on-boot'], env: env(), moduleDirectory: '/nowhere', stderr: stderr.write }),
    ).resolves.toBe(EXIT_CONFIG);

    // Refused before the migrations were even located, so a supervisor that
    // migrates and then serves stops before the schema moves rather than after.
    expect(stderr.text()).not.toContain('No bundled migrations found');

    // And the message is the server's own, unchanged: every variable named,
    // each with how to obtain one.
    expect(stderr.text()).toContain('JWT_SECRET');
    expect(stderr.text()).toContain('openssl rand -hex 32');
    expect(stderr.text()).toContain('GITHUB_CLIENT_ID');
    expect(stderr.text()).toContain('https://github.com/settings/developers');
    expect(stderr.text()).toContain('GITHUB_CLIENT_SECRET');
  });

  it('gets no further at boot than it would on its own, once configured', async () => {
    const stderr = capture();

    await expect(
      run({
        argv: ['--on-boot'],
        env: bootEnv(),
        moduleDirectory: '/nowhere',
        stderr: stderr.write,
      }),
    ).resolves.toBe(EXIT_CONFIG);

    expect(stderr.text()).toContain('No bundled migrations found');
  });

  it('reads DATABASE_URL by the same rule whichever amount it loads', async () => {
    // One schema extended, not two lists: a connection string the server would
    // refuse cannot be one a migration accepts. The reverse — the migration
    // job accepting what the server refuses — is the failure mode that would
    // make this split worse than the coupling it replaced.
    for (const argv of [[], ['--on-boot']]) {
      const stderr = capture();

      await expect(
        run({
          argv,
          env: bootEnv({ DATABASE_URL: 'mysql://localhost:3306/agentchat' }),
          moduleDirectory: '/nowhere',
          stderr: stderr.write,
        }),
      ).resolves.toBe(EXIT_CONFIG);

      expect(stderr.text()).toContain('DATABASE_URL');
      expect(stderr.text()).toContain('must be a PostgreSQL connection URL');
    }
  });
});
