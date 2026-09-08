/**
 * `agentchat agent …`, spawned.
 *
 * The acceptance tests for T-208. Like the rest of this directory they start a
 * real process against a real socket and read file descriptor 1 and file
 * descriptor 2 **separately** (`./spawn.ts`), which is the only way to prove
 * the claim these commands make: the result is on stdout, and the deletion
 * warning, the prompt, and the notice that a default was forgotten are on
 * stderr (PRD §39).
 *
 * The interactive path is exercised for real. The child's stdin is a pipe
 * carrying `y`, so the confirmation is answered the way a person answers it
 * rather than through the test seam the in-process suite uses.
 *
 * Every run gets its own `HOME` and its own working directory, so nothing here
 * can read the developer's credentials or their repository configuration.
 *
 * @module
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

/** The account the stub server answers for. */
const USER_ID = 'usr_0199a1b2-c3d4-7e5f-8071-8293a4b5c6d8';

/** The agent the fixtures own. */
const AGENT_ID = 'agt_0199a1b2-c3d4-7e5f-8071-8293a4b5c6d9';

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

/** The listings every fixture needs, plus whatever the case adds. */
function baseRoutes(extra: Routes = {}): Routes {
  return {
    'GET /agents': { status: 200, body: { items: [AGENT] } },
    'GET /projects': {
      status: 200,
      body: {
        items: [
          {
            id: PROJECT_ID,
            slug: 'payments',
            name: 'Payments Platform',
            createdBy: USER_ID,
            createdAt: '2026-01-01T00:00:00.000Z',
            role: 'member',
          },
        ],
      },
    },
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
  root = mkdtempSync(join(tmpdir(), 'agentchat-agent-cli-'));

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
 * Runs `agentchat agent …` against a fixture.
 *
 * @param prepared - The home and working directory to run in.
 * @param argv - The arguments after `agent`.
 * @param stdin - What to write to the child's standard input.
 * @returns Both streams and the exit code.
 */
async function agentCli(prepared: Prepared, argv: readonly string[], stdin = ''): Promise<Run> {
  return await runCli(['agent', ...argv], {
    cwd: prepared.cwd,
    env: { HOME: prepared.home, AGENTCHAT_PROJECT: PROJECT_ID },
    stdin,
  });
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

describe('agent list', () => {
  it('puts one JSON document on stdout and nothing else anywhere', async () => {
    routes = baseRoutes();
    const run = await agentCli(prepare(), ['list', '--json']);

    expect(run.code).toBe(0);
    const documents = parseNdjson(run.stdout);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ items: [{ id: AGENT_ID, name: 'backend' }] });
    expect(run.stdout).not.toMatch(ANSI);
    expect(run.stderr).toBe('');
  });
});

describe('agent use', () => {
  it('records the default in the user configuration and reports it on stdout', async () => {
    routes = baseRoutes({
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
    });
    const fixture = prepare();

    const run = await agentCli(fixture, ['use', 'backend']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('default agent');
    expect(userConfig(fixture)).toMatchObject({
      serverUrl: baseUrl,
      defaultAgentByProject: { [PROJECT_ID]: AGENT_ID },
    });
  });
});

describe('agent delete', () => {
  /** The routes a successful deletion needs. */
  function deletableRoutes(): Routes {
    return baseRoutes({ [`DELETE /agents/${AGENT_ID}`]: { status: 200, body: {} } });
  }

  it('warns on stderr, takes `y` from stdin, and writes only the result to stdout', async () => {
    routes = deletableRoutes();
    const fixture = prepare();

    const run = await agentCli(fixture, ['delete', 'backend'], 'y\n');

    expect(run.code).toBe(0);

    // The whole warning is on the descriptor a person reads…
    expect(run.stderr).toContain('History is preserved');
    expect(run.stderr).toContain('mints a NEW agent that');
    expect(run.stderr).toContain('Delete backend? [y/N]');

    // …and none of it is on the one a harness parses.
    expect(run.stdout).not.toContain('History is preserved');
    expect(run.stdout).not.toContain('[y/N]');
    expect(run.stdout).toContain('Deleted backend');

    expect(received).toContain(`DELETE /agents/${AGENT_ID}`);
  });

  it('cancels on end of input rather than waiting for an answer', async () => {
    routes = deletableRoutes();

    const run = await agentCli(prepare(), ['delete', 'backend'], '');

    expect(run.code).toBe(0);
    expect(run.stderr).toContain('Cancelled');
    expect(run.stdout).toBe('');
    expect(received).not.toContain(`DELETE /agents/${AGENT_ID}`);
  });

  it('forgets the default that pointed at the deleted agent, saying so on stderr', async () => {
    routes = deletableRoutes();
    const fixture = prepare(AGENT_ID);

    const run = await agentCli(fixture, ['delete', 'backend', '--yes', '--json']);

    expect(run.code).toBe(0);
    expect(parseNdjson(run.stdout)).toEqual([
      {
        deleted: {
          id: AGENT_ID,
          name: 'backend',
          createdAt: AGENT.createdAt,
          updatedAt: AGENT.updatedAt,
        },
        historyPreserved: true,
        clearedDefaultFor: [PROJECT_ID],
      },
    ]);
    expect(run.stderr).toContain('no longer has a default agent');
    expect(userConfig(fixture)).toMatchObject({
      serverUrl: baseUrl,
      defaultAgentByProject: {},
    });
  });

  it('refuses --json without --yes, on stdout as JSON, with exit 2', async () => {
    routes = deletableRoutes();

    const run = await agentCli(prepare(), ['delete', 'backend', '--json']);

    expect(run.code).toBe(2);
    expect(parseNdjson(run.stdout)[0]).toMatchObject({ error: { code: 'BAD_REQUEST' } });
    expect(received).toEqual([]);
  });
});

describe('agent create', () => {
  it('validates the name in this process, before any request is sent', async () => {
    routes = baseRoutes();

    const run = await agentCli(prepare(), ['create', 'Backend']);

    expect(run.code).toBe(2);
    expect(received).toEqual([]);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('not a valid agent name');
  });
});
