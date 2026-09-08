/**
 * `agentchat project …`, spawned.
 *
 * The acceptance tests for T-207. Like the rest of this directory they start a
 * real process against a real socket and read file descriptor 1 and file
 * descriptor 2 **separately** (`./spawn.ts`), which is the only way to prove
 * the claim these commands make: the invite code and the joined project are on
 * stdout, and the preview, the leaving warning and both prompts are on stderr
 * (PRD §39).
 *
 * The interactive paths are exercised for real. The child's stdin is a pipe
 * carrying an answer — or carrying nothing and closing, which is the case a
 * `confirm` seam could never have reached, and the one a CI runner actually
 * has. That is the reason `CliEnvironment` acquired an input descriptor with
 * this task rather than a second command reaching for `process.stdin`.
 *
 * Every run gets its own `HOME` and its own working directory, so nothing here
 * can read the developer's credentials or their repository configuration.
 *
 * @module
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Run } from './spawn.js';
import { ANSI, buildPackage, parseNdjson, runCli } from './spawn.js';

/** The project every fixture acts in. */
const PROJECT_ID = 'prj_0199a1b2-c3d4-7e5f-8071-8293a4b5c6d7';

/** A second project, for the cases that need two. */
const OTHER_PROJECT_ID = 'prj_0199a1b2-c3d4-7e5f-8071-8293a4b5c6da';

/** The account the stub server answers for. */
const USER_ID = 'usr_0199a1b2-c3d4-7e5f-8071-8293a4b5c6d8';

/** The agent the fixtures own. */
const AGENT_ID = 'agt_0199a1b2-c3d4-7e5f-8071-8293a4b5c6d9';

/** The invite code the fixtures mint and redeem. */
const CODE = 'ANET-7K4M-Q2P9';

/** The project, in the shape the protocol parses, with the caller's role. */
const MEMBERSHIP = {
  id: PROJECT_ID,
  slug: 'payments',
  name: 'Payments Platform',
  createdBy: USER_ID,
  createdAt: '2026-01-01T00:00:00.000Z',
  role: 'member',
};

/** The agent, in the shape the protocol parses. */
const AGENT = {
  id: AGENT_ID,
  userId: USER_ID,
  name: 'backend',
  createdAt: '2026-01-02T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

/** One stubbed answer. */
interface Reply {
  /** The status code to send. */
  readonly status: number;

  /** The JSON body to send. */
  readonly body: unknown;
}

/** The routes the stub answers, keyed by `METHOD /path`. */
type Routes = Readonly<Record<string, Reply>>;

/**
 * The project listing every fixture needs, plus whatever the case adds.
 *
 * @param extra - Additional routes.
 * @returns The route table.
 */
function baseRoutes(extra: Routes = {}): Routes {
  return {
    'GET /projects': { status: 200, body: { items: [MEMBERSHIP] } },
    ...extra,
  };
}

let server: Server;
let baseUrl: string;
let routes: Routes = {};
let received: string[] = [];
let root: string;

beforeAll(async () => {
  await buildPackage();
  root = mkdtempSync(join(tmpdir(), 'agentchat-project-cli-'));

  server = createServer((request, response) => {
    const key = `${request.method ?? 'GET'} ${(request.url ?? '/').split('?')[0] ?? '/'}`;
    received.push(key);
    const reply = routes[key] ?? {
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: `No stub for ${key}.` } },
    };
    response.writeHead(reply.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}, 180_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
});

beforeEach(() => {
  routes = {};
  received = [];
});

/** A prepared fixture: a fake home and a working directory. */
interface Prepared {
  /** The fake `HOME`. */
  readonly home: string;

  /** Where the command runs. */
  readonly cwd: string;
}

/**
 * Builds one throwaway home, logged in, optionally with a default agent.
 *
 * @param defaultAgent - The agent id to record as the default for the project.
 * @returns The paths to run against.
 */
function prepare(defaultAgent?: string): Prepared {
  const base = mkdtempSync(join(root, 'case-'));
  const home = join(base, 'home');
  const cwd = join(base, 'work');
  const configDirectory = join(home, '.config', 'agentchat');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });

  writeFileSync(
    join(configDirectory, 'credentials.json'),
    `${JSON.stringify({ version: 1, accessToken: 'access-token', refreshToken: 'refresh-token' }, null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(configDirectory, 'config.json'),
    `${JSON.stringify(
      {
        serverUrl: baseUrl,
        defaultAgentByProject: defaultAgent === undefined ? {} : { [PROJECT_ID]: defaultAgent },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  return { home, cwd };
}

/**
 * Runs `agentchat project …` against a fixture.
 *
 * @param prepared - The home and working directory to run in.
 * @param argv - The arguments after `project`.
 * @param stdin - What to write to the child's standard input, then close it.
 * @returns Both streams and the exit code.
 */
async function projectCli(prepared: Prepared, argv: readonly string[], stdin = ''): Promise<Run> {
  return await runCli(['project', ...argv], {
    cwd: prepared.cwd,
    env: { HOME: prepared.home, AGENTCHAT_PROJECT: 'payments' },
    stdin,
  });
}

/**
 * The repository configuration in a fixture's working directory.
 *
 * @param prepared - The fixture.
 * @returns The parsed document, or `null` when there is none.
 */
function repositoryConfig(prepared: Prepared): Record<string, unknown> | null {
  const path = join(prepared.cwd, '.agentchat', 'config.json');
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
    : null;
}

/**
 * The user configuration as it stands after a run.
 *
 * @param prepared - The fixture.
 * @returns The parsed document.
 */
function userConfig(prepared: Prepared): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(prepared.home, '.config', 'agentchat', 'config.json'), 'utf8'),
  ) as Record<string, unknown>;
}

describe('project list', () => {
  it('puts one JSON document on stdout and nothing else anywhere', async () => {
    routes = baseRoutes();

    const run = await projectCli(prepare(), ['list', '--json']);

    expect(run.code).toBe(0);
    const documents = parseNdjson(run.stdout);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      items: [{ id: PROJECT_ID, slug: 'payments', isCurrent: true }],
    });
    expect(run.stdout).not.toMatch(ANSI);
    expect(run.stderr).toBe('');
  });
});

describe('project invite', () => {
  it('puts the code on stdout and the advice about it nowhere else', async () => {
    routes = baseRoutes({
      [`POST /projects/${PROJECT_ID}/invites`]: {
        status: 201,
        body: { code: CODE, expiresAt: '2026-01-08T00:00:00.000Z' },
      },
    });

    const run = await projectCli(prepare(), ['invite', '--json']);

    expect(run.code).toBe(0);
    expect(parseNdjson(run.stdout)[0]).toMatchObject({
      code: CODE,
      expiresAt: '2026-01-08T00:00:00.000Z',
    });
    expect(run.stderr).toBe('');
  });
});

describe('project join', () => {
  /**
   * The routes a join needs.
   *
   * @returns The route table.
   */
  function joinRoutes(): Routes {
    return baseRoutes({
      [`GET /invites/${CODE}`]: {
        status: 200,
        body: {
          project: {
            id: PROJECT_ID,
            slug: 'payments',
            name: 'Payments Platform',
            createdBy: USER_ID,
            createdAt: MEMBERSHIP.createdAt,
          },
          invitedBy: { id: USER_ID, username: 'alice', displayName: 'Alice Example' },
        },
      },
      [`POST /invites/${CODE}/join`]: { status: 200, body: { project: MEMBERSHIP } },
    });
  }

  it('asks on stderr, and puts only the joined project on stdout', async () => {
    routes = joinRoutes();

    const run = await projectCli(prepare(), ['join', CODE], 'y\n');

    expect(run.code).toBe(0);
    // PRD §27, split across the two descriptors: everything a person reads
    // before answering is on stderr, and the result is on stdout.
    expect(run.stderr).toContain('Project: Payments Platform (payments)');
    expect(run.stderr).toContain('Invited by: Alice Example (@alice)');
    expect(run.stderr).toContain('Join Payments Platform? [Y/n]');
    expect(run.stdout).toContain('Joined Payments Platform.');
    expect(run.stdout).not.toContain('Invited by');
    expect(received).toContain(`POST /invites/${CODE}/join`);
  });

  it('declines when standard input closes without an answer', async () => {
    routes = joinRoutes();

    // The child's stdin is a pipe that is closed immediately: `< /dev/null`, or
    // a CI runner with no terminal. The prompt shows `[Y/n]`, and this still
    // does not join — a default belongs to a person who chose not to type.
    const run = await projectCli(prepare(), ['join', CODE]);

    expect(run.code).toBe(0);
    expect(run.stderr).toContain('Cancelled. You did not join Payments Platform.');
    expect(run.stdout).toBe('');
    expect(received).not.toContain(`POST /invites/${CODE}/join`);
  });

  it('refuses --json without --yes, and puts the refusal on stdout as JSON', async () => {
    routes = joinRoutes();

    const run = await projectCli(prepare(), ['join', CODE, '--json']);

    expect(run.code).toBe(2);
    expect(parseNdjson(run.stdout)[0]).toMatchObject({
      error: { code: 'BAD_REQUEST' },
    });
    expect(received).toHaveLength(0);
  });

  it('joins without asking when --yes is given', async () => {
    routes = joinRoutes();

    const run = await projectCli(prepare(), ['join', CODE, '--yes', '--json']);

    expect(run.code).toBe(0);
    expect(parseNdjson(run.stdout)[0]).toMatchObject({ joined: true });
    expect(run.stderr).toBe('');
  });
});

describe('project leave', () => {
  /**
   * The routes a leave needs.
   *
   * @returns The route table.
   */
  function leaveRoutes(): Routes {
    return baseRoutes({
      'GET /agents': { status: 200, body: { items: [AGENT] } },
      [`GET /projects/${PROJECT_ID}/agents`]: {
        status: 200,
        body: {
          items: [
            {
              agent: AGENT,
              owner: { id: USER_ID, username: 'alice', displayName: 'Alice Example' },
              online: false,
              sessions: 0,
            },
          ],
        },
      },
      [`POST /projects/${PROJECT_ID}/leave`]: { status: 200, body: {} },
    });
  }

  it('names the agents that go with you, on stderr, before asking', async () => {
    routes = leaveRoutes();
    const fixture = prepare(AGENT_ID);

    const run = await projectCli(fixture, ['leave'], 'y\n');

    expect(run.code).toBe(0);
    expect(run.stderr).toContain('Leaving also removes this agent of yours');
    expect(run.stderr).toContain('backend');
    expect(run.stderr).toContain('Leave payments? [y/N]');
    expect(run.stdout).toContain('Left payments.');
    // The default agent for the project pointed at an agent that is no longer
    // in it, so it is forgotten rather than left to fail every later command.
    expect(userConfig(fixture)).toMatchObject({ defaultAgentByProject: {} });
  });

  it('does not leave on a bare Return, and says nothing on stdout', async () => {
    routes = leaveRoutes();

    const run = await projectCli(prepare(), ['leave'], '\n');

    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('Cancelled. You are still in payments.');
    expect(received).not.toContain(`POST /projects/${PROJECT_ID}/leave`);
  });
});

describe('project init', () => {
  it('writes the committed file, and only the project identity into it', async () => {
    routes = baseRoutes();
    const fixture = prepare();

    const run = await projectCli(fixture, ['init', 'payments']);

    expect(run.code).toBe(0);
    expect(repositoryConfig(fixture)).toEqual({
      projectId: PROJECT_ID,
      projectSlug: 'payments',
    });
    expect(run.stdout).toContain('Linked this directory to Payments Platform.');
    expect(run.stderr).toBe('');
  });

  it('refuses to repoint the directory at another project without --force', async () => {
    routes = baseRoutes();
    const fixture = prepare();
    mkdirSync(join(fixture.cwd, '.agentchat'), { recursive: true });
    writeFileSync(
      join(fixture.cwd, '.agentchat', 'config.json'),
      `${JSON.stringify({ projectId: OTHER_PROJECT_ID, projectSlug: 'billing' })}\n`,
    );

    const run = await projectCli(fixture, ['init', 'payments']);

    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('--force');
    expect(repositoryConfig(fixture)).toMatchObject({ projectId: OTHER_PROJECT_ID });
  });
});

describe('project current', () => {
  it('reports the resolved project and where it came from, without a server', async () => {
    const fixture = prepare();
    mkdirSync(join(fixture.cwd, '.agentchat'), { recursive: true });
    writeFileSync(
      join(fixture.cwd, '.agentchat', 'config.json'),
      `${JSON.stringify({ projectId: PROJECT_ID, projectSlug: 'payments' })}\n`,
    );

    const run = await runCli(['project', 'current', '--json'], {
      cwd: fixture.cwd,
      // No `AGENTCHAT_SERVER`, and the stub is never contacted: resolution is
      // local, which is what makes this answerable when the server is not.
      env: { HOME: fixture.home },
    });

    expect(run.code).toBe(0);
    // The path is compared by suffix: the child reports its own working
    // directory, and on macOS that is the `/private` form of the temporary path
    // this process created.
    expect(parseNdjson(run.stdout)[0]).toMatchObject({
      project: {
        id: PROJECT_ID,
        slug: 'payments',
        source: 'repository',
        origin: expect.stringContaining(join('work', '.agentchat', 'config.json')),
        configPath: expect.stringContaining(join('work', '.agentchat', 'config.json')),
      },
    });
    expect(run.stderr).toBe('');
    expect(received).toHaveLength(0);
  });

  it('exits 4 and names `project init` when nothing resolves', async () => {
    const fixture = prepare();

    const run = await runCli(['project', 'current'], {
      cwd: fixture.cwd,
      env: { HOME: fixture.home },
    });

    expect(run.code).toBe(4);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('project init');
  });
});
