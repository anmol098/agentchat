/**
 * `agentchat agents`, spawned.
 *
 * The acceptance tests for T-402. Like the rest of this directory they start a
 * real process against a real socket and read file descriptor 1 and file
 * descriptor 2 **separately** (`./spawn.ts`). That separation is the whole point
 * here: this command exists to be run by another program, which reads stdout and
 * nothing else, and a suite that merged the descriptors would pass while the
 * contract it protects was broken (PRD §39).
 *
 * So every case below asserts on both streams, and the `--json` cases assert
 * that stdout is exactly one parseable document with no ANSI in it — the child's
 * descriptors are pipes, so colour must vanish on its own.
 *
 * Every run gets its own `HOME` and its own working directory, so nothing here
 * can read the developer's credentials or their repository configuration.
 *
 * @module
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Run } from './spawn.js';
import { ANSI, buildPackage, parseNdjson, runCli } from './spawn.js';

/** The project every fixture discovers in. */
const PROJECT_ID = 'prj_0199a1b2-c3d4-7e5f-8071-8293a4b5c6d7';

/** The three accounts the stub server answers for. */
const ALICE_ID = 'usr_0199a1b2-c3d4-7e5f-8071-8293a4b5c6d8';
const BOB_ID = 'usr_0199a1b2-c3d4-7e5f-8071-8293a4b5c6d9';
const CHARLIE_ID = 'usr_0199a1b2-c3d4-7e5f-8071-8293a4b5c6da';

const ALICE = { id: ALICE_ID, username: 'alice', displayName: 'Alice Example' };
const BOB = { id: BOB_ID, username: 'bob', displayName: 'Bob Example' };
const CHARLIE = { id: CHARLIE_ID, username: 'charlie', displayName: 'Charlie Example' };

/** The project, in the shape the protocol parses, with the caller's role. */
const MEMBERSHIP = {
  id: PROJECT_ID,
  slug: 'payments',
  name: 'Payments Platform',
  createdBy: ALICE_ID,
  createdAt: '2026-01-01T00:00:00.000Z',
  role: 'member',
};

/**
 * One row of the discovery listing.
 *
 * @param suffix - Two hex characters, to keep agent ids distinct.
 * @param name - The agent's name.
 * @param owner - Who owns it.
 * @param sessions - Active sessions; `online` is derived from it as the server
 *   derives it.
 * @returns The wire representation.
 */
function row(
  suffix: string,
  name: string,
  owner: { id: string; username: string; displayName: string },
  sessions: number,
): Record<string, unknown> {
  return {
    agent: {
      id: `agt_0199a1b2-c3d4-7e5f-8071-8293a4b5c6${suffix}`,
      userId: owner.id,
      name,
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
    owner,
    online: sessions > 0,
    sessions,
  };
}

/** The listing, in the server's order: by username, then by agent name. */
const LISTING = [
  row('e1', 'backend', ALICE, 2),
  row('e2', 'frontend', ALICE, 0),
  row('e3', 'backend', BOB, 1),
  row('e4', 'research', CHARLIE, 1),
];

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
 * The project listing every fixture needs, plus a discovery listing.
 *
 * @param items - The discovery rows. Defaults to {@link LISTING}.
 * @returns The route table.
 */
function baseRoutes(items: readonly Record<string, unknown>[] = LISTING): Routes {
  return {
    'GET /projects': { status: 200, body: { items: [MEMBERSHIP] } },
    [`GET /projects/${PROJECT_ID}/agents`]: { status: 200, body: { items } },
  };
}

let server: Server;
let baseUrl: string;
let routes: Routes = {};
let received: string[] = [];
let root: string;

beforeAll(async () => {
  await buildPackage();
  root = mkdtempSync(join(tmpdir(), 'agentchat-agents-cli-'));

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
  routes = baseRoutes();
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
 * Builds one throwaway home, logged in and pointed at the stub server.
 *
 * @returns The paths to run against.
 */
function prepare(): Prepared {
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
    `${JSON.stringify({ serverUrl: baseUrl, defaultAgentByProject: {} }, null, 2)}\n`,
    { mode: 0o600 },
  );

  return { home, cwd };
}

/**
 * Runs `agentchat agents …` against a fixture.
 *
 * @param prepared - The home and working directory to run in.
 * @param argv - The arguments after `agents`.
 * @returns Both streams and the exit code.
 */
async function agentsCli(prepared: Prepared, argv: readonly string[] = []): Promise<Run> {
  return await runCli(['agents', ...argv], {
    cwd: prepared.cwd,
    env: { HOME: prepared.home, AGENTCHAT_PROJECT: 'payments' },
    stdin: '',
  });
}

describe('agents --json', () => {
  it('puts one JSON document on stdout and nothing at all on stderr', async () => {
    const run = await agentsCli(prepare(), ['--json']);

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).not.toMatch(ANSI);

    const documents = parseNdjson(run.stdout);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toStrictEqual({
      project: { id: PROJECT_ID, slug: 'payments', name: 'Payments Platform' },
      items: [
        {
          address: '@alice/backend',
          agent: {
            id: 'agt_0199a1b2-c3d4-7e5f-8071-8293a4b5c6e1',
            userId: ALICE_ID,
            name: 'backend',
            createdAt: '2026-01-02T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
          owner: ALICE,
          online: true,
          sessions: 2,
        },
        {
          address: '@alice/frontend',
          agent: {
            id: 'agt_0199a1b2-c3d4-7e5f-8071-8293a4b5c6e2',
            userId: ALICE_ID,
            name: 'frontend',
            createdAt: '2026-01-02T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
          owner: ALICE,
          online: false,
          sessions: 0,
        },
        {
          address: '@bob/backend',
          agent: {
            id: 'agt_0199a1b2-c3d4-7e5f-8071-8293a4b5c6e3',
            userId: BOB_ID,
            name: 'backend',
            createdAt: '2026-01-02T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
          owner: BOB,
          online: true,
          sessions: 1,
        },
        {
          address: '@charlie/research',
          agent: {
            id: 'agt_0199a1b2-c3d4-7e5f-8071-8293a4b5c6e4',
            userId: CHARLIE_ID,
            name: 'research',
            createdAt: '2026-01-02T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
          owner: CHARLIE,
          online: true,
          sessions: 1,
        },
      ],
    });
  });

  it('produces byte-identical stdout on two runs against unchanged data', async () => {
    const first = await agentsCli(prepare(), ['--json']);
    const second = await agentsCli(prepare(), ['--json']);

    expect(first.stdout).toBe(second.stdout);
  });

  it('asks for the whole project once rather than once per agent', async () => {
    await agentsCli(prepare(), ['--json']);

    expect(received).toStrictEqual(['GET /projects', `GET /projects/${PROJECT_ID}/agents`]);
  });
});

describe('agents', () => {
  it('prints the grouped listing on stdout, uncoloured on a pipe', async () => {
    const run = await agentsCli(prepare());

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).not.toMatch(ANSI);
    expect(run.stdout).toBe(
      [
        'PROJECT: Payments Platform',
        '',
        'Alice Example (@alice)',
        '  @alice/backend     online   2 sessions',
        '  @alice/frontend    offline',
        '',
        'Bob Example (@bob)',
        '  @bob/backend       online   1 session',
        '',
        'Charlie Example (@charlie)',
        '  @charlie/research  online   1 session',
        '',
        'Send to one with `agentchat send @alice/backend "…"`.',
        '',
      ].join('\n'),
    );
  });

  it('reports an empty project without failing', async () => {
    routes = baseRoutes([]);

    const run = await agentsCli(prepare());

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain('No agents are in Payments Platform.');
  });
});

describe('agents and agent', () => {
  it('sends a subcommand of the singular command back with the right spelling', async () => {
    const run = await agentsCli(prepare(), ['list']);

    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('`agentchat agents` takes no arguments; got `list`');
    expect(run.stderr).toContain('`agentchat agent list`');
    // Refused before the socket was opened.
    expect(received).toStrictEqual([]);
  });

  it('keeps stdout carrying only the error envelope in JSON mode', async () => {
    const run = await agentsCli(prepare(), ['list', '--json']);

    expect(run.code).toBe(2);
    expect(parseNdjson(run.stdout)).toStrictEqual([
      {
        error: {
          code: 'BAD_REQUEST',
          message: '`agentchat agents` takes no arguments; got `list`.',
          hint: "`agentchat agents` lists everyone's agents in the project. You may have meant `agentchat agent list`, which acts on the agents you own.",
        },
      },
    ]);
  });

  it('lists both commands in help, adjacent and contrasting', async () => {
    const run = await runCli(['--help'], { env: { HOME: prepare().home } });

    expect(run.code).toBe(0);
    const lines = run.stdout.split('\n');
    const singular = lines.findIndex((line) => line.trimStart().startsWith('agent '));
    const plural = lines.findIndex((line) => line.trimStart().startsWith('agents '));

    expect(singular).toBeGreaterThan(-1);
    expect(plural).toBe(singular + 1);
    expect(lines[singular]).toContain('you own');
    expect(lines[plural]).toContain("everyone's");
  });
});
