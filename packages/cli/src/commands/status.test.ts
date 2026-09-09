/**
 * `agentchat status`, driven in-process.
 *
 * The counterpart to `../../tests/status.test.ts`, which spawns the binary and
 * is where the stream and exit-code contract is actually proved. This file
 * covers the branches that are about *local files being wrong* — a corrupt
 * configuration, a credential-shaped key committed to a repository, an opaque
 * token — where the thing under test is a decision rather than a descriptor,
 * and a process launch per case would buy nothing.
 *
 * Every case gets its own `HOME` and its own working directory. That is not
 * tidiness: without it these tests would read the developer's real credentials
 * and their real `.agentchat/config.json`, and pass or fail accordingly.
 *
 * @module
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { Capture } from '../testing.js';
import { captureRun } from '../testing.js';

/** Where every fixture directory is made. Removed once the file finishes. */
const root = mkdtempSync(join(tmpdir(), 'agentchat-status-unit-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** What one case puts on disk before `status` runs. */
interface Fixture {
  /** Contents of `<repository>/.agentchat/config.json`, verbatim. */
  readonly repositoryConfig?: string;

  /** Contents of `$HOME/.config/agentchat/config.json`, verbatim. */
  readonly userConfig?: string;

  /** Contents of `$HOME/.config/agentchat/credentials.json`, verbatim. */
  readonly credentials?: string;
}

/**
 * Runs `agentchat status` against a throwaway home and working directory.
 *
 * @param fixture - What to write first.
 * @param argv - Arguments after `status`.
 * @param env - Extra environment, merged over `HOME`.
 * @returns Both streams and the exit code.
 */
async function status(
  fixture: Fixture = {},
  argv: readonly string[] = ['--json'],
  env: Readonly<Record<string, string>> = {},
): Promise<Capture> {
  const base = mkdtempSync(join(root, 'case-'));
  const home = join(base, 'home');
  const cwd = join(base, 'repository', 'services');
  const configDirectory = join(home, '.config', 'agentchat');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });

  if (fixture.repositoryConfig !== undefined) {
    mkdirSync(join(base, 'repository', '.agentchat'), { recursive: true });
    writeFileSync(join(base, 'repository', '.agentchat', 'config.json'), fixture.repositoryConfig);
  }
  if (fixture.userConfig !== undefined) {
    writeFileSync(join(configDirectory, 'config.json'), fixture.userConfig, { mode: 0o600 });
  }
  if (fixture.credentials !== undefined) {
    writeFileSync(join(configDirectory, 'credentials.json'), fixture.credentials, { mode: 0o600 });
  }

  return await captureRun(['status', ...argv], { cwd, env: { HOME: home, ...env } });
}

/**
 * The single JSON document on stdout.
 *
 * @param capture - What the run produced.
 * @returns The parsed report.
 */
function report(capture: Capture): Record<string, unknown> {
  const lines = capture.stdout.trimEnd().split('\n');
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? '') as Record<string, unknown>;
}

/**
 * The problems in one area.
 *
 * @param capture - What the run produced.
 * @param area - The check to filter to.
 * @returns Its problems.
 */
function problemsIn(
  capture: Capture,
  area: string,
): { code: string; message: string; hint: string | null }[] {
  const all = report(capture)['problems'] as {
    area: string;
    code: string;
    message: string;
    hint: string | null;
  }[];
  return all.filter((problem) => problem.area === area);
}

describe('the --json shape', () => {
  it('has every documented key, whatever went wrong', async () => {
    const capture = await status();

    expect(capture.code).toBe(0);
    const document = report(capture);
    // Spelled out rather than snapshotted: this is the published contract, and
    // a snapshot that silently re-records is not a contract test.
    expect(Object.keys(document).sort()).toEqual([
      'agent',
      'cli',
      'login',
      'ok',
      'problems',
      'project',
      'server',
      'sessions',
    ]);
    expect(Object.keys(document['server'] as object).sort()).toEqual([
      'minClientVersion',
      'origin',
      'protocolVersion',
      'reachable',
      'source',
      'url',
      'version',
    ]);
    expect(Object.keys(document['login'] as object).sort()).toEqual([
      'accessTokenExpired',
      'accessTokenExpiresAt',
      'credentialsPath',
      'hasStoredToken',
      'loggedIn',
      'user',
      'verified',
    ]);
    expect(Object.keys(document['project'] as object).sort()).toEqual([
      'configPath',
      'id',
      'origin',
      'resolved',
      'role',
      'slug',
      'source',
    ]);
    expect(Object.keys(document['agent'] as object).sort()).toEqual([
      'id',
      'name',
      'origin',
      'resolved',
      'source',
    ]);
    expect(Object.keys(document['sessions'] as object).sort()).toEqual([
      'checked',
      'count',
      'items',
      'online',
    ]);
  });

  it('writes exactly one line, and nothing to stderr, when nothing is configured', async () => {
    const capture = await status();

    // No server means no probe, so there is not even a progress line.
    expect(capture.stderr).toBe('');
    expect(capture.stdout.endsWith('\n')).toBe(true);
  });
});

describe('a broken user configuration', () => {
  it('is reported rather than raised, and the rest of the report still happens', async () => {
    const capture = await status({ userConfig: '{ this is not json' });

    expect(capture.code).toBe(0);
    // `readUserConfig` raises INTERNAL for this, which for every other command
    // is right and here would take out the whole diagnostic.
    const login = problemsIn(capture, 'login');
    expect(login[0]?.code).toBe('INTERNAL');
    expect(login[0]?.message).toContain('not valid JSON');
    // And the project check ran anyway.
    expect(problemsIn(capture, 'project')).toHaveLength(1);
  });

  it('does not stop the server URL being read from a flag', async () => {
    const capture = await status({ userConfig: '[]' }, ['--json', '--server', 'not-a-url']);

    expect(capture.code).toBe(0);
    expect(report(capture)['server']).toMatchObject({
      url: 'not-a-url',
      source: 'flag',
      origin: '--server',
      reachable: null,
    });
  });
});

describe('a broken repository configuration', () => {
  it('reports a credential-shaped key instead of reading past it', async () => {
    const capture = await status({
      repositoryConfig: JSON.stringify({
        projectId: 'prj_0199a1b2-c3d4-7e5f-8071-8293a4b5c6d7',
        githubToken: 'ghp_notarealtokenatallbutitlooksliketone',
      }),
    });

    expect(capture.code).toBe(0);
    const project = problemsIn(capture, 'project');
    expect(project[0]?.code).toBe('NO_PROJECT');
    expect(project[0]?.message).toContain('githubToken');
    // The refusal is the point; the file is not treated as a project.
    expect(report(capture)['project']).toMatchObject({ resolved: false });
  });

  it('reports a malformed project id and names the file', async () => {
    const capture = await status({ repositoryConfig: JSON.stringify({ projectId: 'nope' }) });

    expect(capture.code).toBe(0);
    expect(problemsIn(capture, 'project')[0]?.message).toContain('.agentchat/config.json');
  });
});

describe('the credential file', () => {
  it('reports an opaque token as stored with an unknown expiry', async () => {
    const capture = await status({
      credentials: JSON.stringify({
        version: 1,
        accessToken: 'an-entirely-opaque-access-token',
        refreshToken: 'an-entirely-opaque-refresh-token',
      }),
    });

    expect(capture.code).toBe(0);
    expect(report(capture)['login']).toMatchObject({
      hasStoredToken: true,
      loggedIn: true,
      verified: false,
      accessTokenExpiresAt: null,
      accessTokenExpired: null,
    });
  });

  it('reports a token whose payload is not JSON the same way', async () => {
    const capture = await status({
      credentials: JSON.stringify({
        version: 1,
        accessToken: 'header.not-base64url-json.signature',
        refreshToken: 'refresh',
      }),
    });

    expect(capture.code).toBe(0);
    expect(report(capture)['login']).toMatchObject({ accessTokenExpiresAt: null });
  });

  it('reports a corrupt file as a login to redo, and puts none of it on a stream', async () => {
    const capture = await status({ credentials: 'this file is not JSON at all' });

    expect(capture.code).toBe(0);
    expect(problemsIn(capture, 'login')[0]?.hint).toContain('agentchat login');
    expect(capture.stdout).not.toContain('not JSON at all');
  });

  it('never puts either token on a stream in human mode', async () => {
    const capture = await status(
      {
        credentials: JSON.stringify({
          version: 1,
          accessToken: 'ACCESS-TOKEN-SENTINEL',
          refreshToken: 'REFRESH-TOKEN-SENTINEL',
        }),
      },
      [],
    );

    expect(capture.stdout).not.toContain('SENTINEL');
    expect(capture.stderr).not.toContain('SENTINEL');
    expect(capture.stdout).toContain('expiry unknown');
  });
});

describe('a value that cannot be what it claims to be', () => {
  it('reports a --project that is neither an id nor a slug, and still exits 0', async () => {
    const capture = await status({}, ['--json', '--project', 'Not A Slug']);

    expect(capture.code).toBe(0);
    expect(problemsIn(capture, 'project')[0]?.code).toBe('BAD_REQUEST');
  });

  it('reports an AGENTCHAT_AGENT that is not an agent reference', async () => {
    const capture = await status({}, ['--json', '--project', 'payments'], {
      AGENTCHAT_AGENT: '@alice/backend',
    });

    expect(capture.code).toBe(0);
    // The environment is exactly where a bad value hides, which is why this is
    // a line in the report rather than a refusal to produce one.
    const agent = problemsIn(capture, 'agent');
    expect(agent[0]?.code).toBe('BAD_REQUEST');
    expect(agent[0]?.message).toContain('AGENTCHAT_AGENT');
  });

  it('is still a usage error when an option is missing its value', async () => {
    // No check owns this: the parser rejected the invocation before any of them
    // ran, so there is no report to be made from it and exit 2 is the answer.
    const capture = await status({}, ['--json', '--project']);

    expect(capture.code).toBe(2);
    expect(JSON.parse(capture.stdout.trim()) as unknown).toMatchObject({
      error: { code: 'BAD_REQUEST' },
    });
  });
});

describe('the server URL', () => {
  it('comes from the user configuration when no flag or variable answers', async () => {
    const capture = await status({
      userConfig: JSON.stringify({
        serverUrl: 'https://chat.example.com',
        defaultAgentByProject: {},
      }),
    });

    // Nothing is listening there; the point is only where the URL came from.
    expect(report(capture)['server']).toMatchObject({
      url: 'https://chat.example.com',
      source: 'user-config',
      origin: expect.stringContaining('config.json') as unknown as string,
    });
  });

  it('prefers the flag over the variable and says so', async () => {
    const capture = await status({}, ['--json', '--server', 'https://flag.example'], {
      AGENTCHAT_SERVER: 'https://variable.example',
    });

    expect(report(capture)['server']).toMatchObject({
      url: 'https://flag.example',
      source: 'flag',
      origin: '--server',
    });
  });
});
