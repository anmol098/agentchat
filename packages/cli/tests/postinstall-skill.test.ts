/**
 * `scripts/postinstall-skill.mjs`, spawned, against a fake `npx`.
 *
 * This script runs unattended on every install of the published package,
 * including a global one that has nothing to do with skills, so the two
 * things worth proving are the ones that would otherwise only surface on a
 * real user's machine: it never reaches the network except when the install
 * actually was global, and it never fails, hangs, or reports a bad exit code
 * regardless of what the network call does. A real `npx` is not exercised
 * here — that would make this suite's pass/fail depend on skills.sh's own
 * availability — so `npx` is a fake script on `PATH` that records how it was
 * invoked and behaves exactly as each test tells it to.
 *
 * @module
 */

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import { PACKAGE_ROOT, runCli } from './spawn.js';

const SCRIPT = join(PACKAGE_ROOT, 'scripts', 'postinstall-skill.mjs');

/** Directories created by a test, removed after it. */
const cleanupDirs: string[] = [];

afterEach(() => {
  cleanupDirs.length = 0;
});

/**
 * Puts a fake `npx` on its own directory and returns that directory plus the
 * file the fake writes its received argv to.
 *
 * @param behaviour - How the fake should behave once invoked.
 * @returns The `PATH` entry to prepend, and where to read the recorded argv.
 */
function fakeNpx(behaviour: { exit?: number; sleepSeconds?: number } = {}): {
  binDir: string;
  logFile: string;
} {
  const binDir = mkdtempSync(join(tmpdir(), 'agentchat-fake-npx-'));
  cleanupDirs.push(binDir);
  const logFile = join(binDir, 'invocation.log');
  const sleep = behaviour.sleepSeconds ? `sleep ${String(behaviour.sleepSeconds)}` : '';
  writeFileSync(
    join(binDir, 'npx'),
    `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(logFile)}\n${sleep}\nexit ${String(behaviour.exit ?? 0)}\n`,
    { mode: 0o755 },
  );
  chmodSync(join(binDir, 'npx'), 0o755);
  return { binDir, logFile };
}

describe('postinstall-skill.mjs', () => {
  it('never invokes npx when AGENTCHAT_SKIP_SKILL_INSTALL is set', async () => {
    const { binDir, logFile } = fakeNpx();
    const run = await runCli([], {
      script: SCRIPT,
      env: {
        PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
        npm_config_global: 'true',
        AGENTCHAT_SKIP_SKILL_INSTALL: '1',
      },
    });

    expect(run.code).toBe(0);
    expect(run.stderr).toContain('AGENTCHAT_SKIP_SKILL_INSTALL is set');
    expect(() => readFileSync(logFile, 'utf8')).toThrow();
  });

  it('never invokes npx under CI', async () => {
    const { binDir, logFile } = fakeNpx();
    const run = await runCli([], {
      script: SCRIPT,
      env: {
        PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
        npm_config_global: 'true',
        CI: 'true',
      },
    });

    expect(run.code).toBe(0);
    expect(run.stderr).toContain('running in CI');
    expect(() => readFileSync(logFile, 'utf8')).toThrow();
  });

  it('never invokes npx when the install was not global', async () => {
    const { binDir, logFile } = fakeNpx();
    const run = await runCli([], {
      script: SCRIPT,
      env: {
        PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
      },
    });

    expect(run.code).toBe(0);
    expect(() => readFileSync(logFile, 'utf8')).toThrow();
  });

  it('invokes npx with the expected arguments on a real global install', async () => {
    const { binDir, logFile } = fakeNpx();
    const run = await runCli([], {
      script: SCRIPT,
      env: {
        PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
        npm_config_global: 'true',
      },
    });

    expect(run.code).toBe(0);
    expect(run.stderr).toContain('installing the agentchat Skill');
    expect(readFileSync(logFile, 'utf8').trim()).toBe(
      '--yes skills add anmol098/agentchat --skill agentchat -g -y',
    );
  });

  it('still exits 0 and reports a fallback when npx fails', async () => {
    const { binDir } = fakeNpx({ exit: 1 });
    const run = await runCli([], {
      script: SCRIPT,
      env: {
        PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
        npm_config_global: 'true',
      },
    });

    expect(run.code).toBe(0);
    expect(run.stderr).toContain('run `npx skills add anmol098/agentchat` yourself');
  });

  it('bounds a hung npx with the timeout and still exits 0', async () => {
    const { binDir } = fakeNpx({ sleepSeconds: 5 });
    const started = Date.now();
    const run = await runCli([], {
      script: SCRIPT,
      env: {
        PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
        npm_config_global: 'true',
        // Real installs get 30s; this proves the timeout is respected without
        // the suite actually waiting that long.
        AGENTCHAT_SKILL_INSTALL_TIMEOUT_MS: '200',
      },
    });
    const elapsedMs = Date.now() - started;

    expect(run.code).toBe(0);
    // Comfortably below the fake's full 5s sleep (proving the timeout, not
    // the sleep, ended it) with generous room above the 200ms bound for CI
    // scheduling jitter.
    expect(elapsedMs).toBeLessThan(3000);
    expect(run.stderr).toContain('run `npx skills add anmol098/agentchat` yourself');
  });
});
