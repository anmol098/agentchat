/**
 * `agentchat agents`, driven in process against a stubbed server.
 *
 * The suite under `../../tests/agents.test.ts` spawns the real binary and is
 * what proves the stream contract; this one covers the branches a subprocess
 * test would pay a process launch each to reach — an empty project, a project
 * the caller is not in, and the several ways the plural command can be typed
 * when the singular one was meant.
 *
 * Two claims are asserted throughout rather than once, because both are things
 * a later change could break silently:
 *
 * - **Nothing is sorted here.** Every fixture lists its agents in an order no
 *   client-side sort would produce, and the assertions demand that order back.
 *   A sort added later would fail these rather than quietly disagreeing with
 *   the server.
 * - **Discovery is one request, not one per agent.** The transport records
 *   every call, and the counts are checked.
 *
 * @module
 */

import type { Transport, TransportRequest, TransportResponse } from '@stackgrid/client';
import { InMemoryCredentialStore } from '@stackgrid/client';
import type { ProjectAgent } from '@stackgrid/protocol';
import { AgentId, ErrorCode, errorEnvelope, ProjectId, UserId } from '@stackgrid/protocol';
import { describe, expect, it } from 'vitest';

import { captureRun } from '../testing.js';
import type { AgentsOverrides } from './agents.js';
import { addressOf, createAgentsCommand, groupByOwner, presenceOf } from './agents.js';

const SERVER = 'https://chat.example.test';

const LIST_PROJECTS = 'GET /projects';

const PROJECT = ProjectId.generate();
const ALICE = UserId.generate();
const BOB = UserId.generate();
const CHARLIE = UserId.generate();

const DISCOVER = `GET /projects/${PROJECT}/agents`;

/** The project the fixtures discover in, as `GET /projects` reports it. */
const MEMBERSHIP = {
  id: PROJECT,
  slug: 'payments',
  name: 'Payments Platform',
  createdBy: ALICE,
  createdAt: '2026-01-01T00:00:00.000Z',
  role: 'member',
};

/** One owner, as the discovery listing carries them. */
function owner(id: string, username: string, displayName: string): ProjectAgent['owner'] {
  return { id, username, displayName } as ProjectAgent['owner'];
}

const ALICE_OWNER = owner(ALICE, 'alice', 'Alice Example');
const BOB_OWNER = owner(BOB, 'bob', 'Bob Example');
const CHARLIE_OWNER = owner(CHARLIE, 'charlie', 'Charlie Example');

/**
 * One row of the discovery listing, in the shape the protocol parses.
 *
 * @param name - The agent's name.
 * @param by - The owner.
 * @param sessions - Active sessions. `online` is derived from it, as the server
 *   derives it, so no fixture can accidentally assert on an impossible pair.
 * @param id - The agent's id. Generated unless a case needs to assert on it.
 * @returns The wire representation.
 */
function row(
  name: string,
  by: ProjectAgent['owner'],
  sessions: number,
  id: string = AgentId.generate(),
): Record<string, unknown> {
  return {
    agent: {
      id,
      userId: by.id,
      name,
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
    owner: by,
    online: sessions > 0,
    sessions,
  };
}

/** The agent ids the exhaustive `--json` assertion names. */
const ALICE_BACKEND = AgentId.generate();
const ALICE_FRONTEND = AgentId.generate();
const BOB_BACKEND = AgentId.generate();
const CHARLIE_RESEARCH = AgentId.generate();

/**
 * The listing every fixture uses, in the server's order: by username, then by
 * agent name.
 */
const LISTING = [
  row('backend', ALICE_OWNER, 2, ALICE_BACKEND),
  row('frontend', ALICE_OWNER, 0, ALICE_FRONTEND),
  row('backend', BOB_OWNER, 1, BOB_BACKEND),
  row('research', CHARLIE_OWNER, 1, CHARLIE_RESEARCH),
];

/** One scripted response. */
interface Reply {
  readonly status: number;
  readonly body?: unknown;
}

/** A transport that answers from a script instead of a socket. */
class StubServer implements Transport {
  public readonly calls: TransportRequest[] = [];
  readonly #replies = new Map<string, Reply>();

  public on(key: string, reply: Reply): this {
    this.#replies.set(key, reply);
    return this;
  }

  public get keys(): readonly string[] {
    return this.calls.map((call) => `${call.method} ${call.path}`);
  }

  public countOf(key: string): number {
    return this.keys.filter((seen) => seen === key).length;
  }

  public request(request: TransportRequest): Promise<TransportResponse> {
    this.calls.push(request);
    const key = `${request.method} ${request.path}`;
    const reply = this.#replies.get(key);
    if (reply === undefined) {
      return Promise.resolve({
        status: 404,
        headers: {},
        body: errorEnvelope(ErrorCode.NOT_FOUND, `No stub for ${key}.`),
      });
    }
    return Promise.resolve({ status: reply.status, headers: {}, body: reply.body ?? {} });
  }
}

/**
 * A stub that answers the project listing and the discovery listing.
 *
 * @param items - The discovery rows to answer with. Defaults to {@link LISTING}.
 * @returns The stub.
 */
function stubWith(items: readonly Record<string, unknown>[] = LISTING): StubServer {
  return new StubServer()
    .on(LIST_PROJECTS, { status: 200, body: { items: [MEMBERSHIP] } })
    .on(DISCOVER, { status: 200, body: { items } });
}

/**
 * A store that is logged in, so `auth: 'required'` calls reach the transport.
 *
 * @returns The store.
 */
function signedIn(): InMemoryCredentialStore {
  return new InMemoryCredentialStore({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
  });
}

/** What one in-process invocation produced. */
interface Outcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/**
 * Runs `agentchat agents` through the whole framework.
 *
 * @param argv - The arguments after `agents`.
 * @param overrides - The seams to run against. A signed-in store is supplied
 *   unless the case brings its own.
 * @param env - Extra environment, merged over the defaults.
 * @returns Both streams and the exit code.
 */
async function runAgents(
  argv: readonly string[] = [],
  overrides: AgentsOverrides = {},
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<Outcome> {
  return await captureRun(['agents', ...argv, '--server', SERVER], {
    commands: [createAgentsCommand({ store: signedIn(), ...overrides })],
    env: { XDG_CONFIG_HOME: '/nonexistent', AGENTCHAT_PROJECT: PROJECT, ...env },
    cwd: '/tmp',
  });
}

/**
 * The one JSON document a run put on stdout.
 *
 * @param outcome - The run.
 * @returns The parsed document.
 */
function documentOf(outcome: Outcome): Record<string, unknown> {
  const lines = outcome.stdout.trimEnd().split('\n');
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? '') as Record<string, unknown>;
}

describe('--json', () => {
  it('emits one document carrying the project and a flat items array', async () => {
    const transport = stubWith();

    const run = await runAgents(['--json'], { transport });

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(documentOf(run)).toStrictEqual({
      project: { id: PROJECT, slug: 'payments', name: 'Payments Platform' },
      items: [
        {
          address: '@alice/backend',
          agent: {
            id: ALICE_BACKEND,
            userId: ALICE,
            name: 'backend',
            createdAt: '2026-01-02T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
          owner: { id: ALICE, username: 'alice', displayName: 'Alice Example' },
          online: true,
          sessions: 2,
        },
        {
          address: '@alice/frontend',
          agent: {
            id: ALICE_FRONTEND,
            userId: ALICE,
            name: 'frontend',
            createdAt: '2026-01-02T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
          owner: { id: ALICE, username: 'alice', displayName: 'Alice Example' },
          online: false,
          sessions: 0,
        },
        {
          address: '@bob/backend',
          agent: {
            id: BOB_BACKEND,
            userId: BOB,
            name: 'backend',
            createdAt: '2026-01-02T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
          owner: { id: BOB, username: 'bob', displayName: 'Bob Example' },
          online: true,
          sessions: 1,
        },
        {
          address: '@charlie/research',
          agent: {
            id: CHARLIE_RESEARCH,
            userId: CHARLIE,
            name: 'research',
            createdAt: '2026-01-02T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
          owner: { id: CHARLIE, username: 'charlie', displayName: 'Charlie Example' },
          online: true,
          sessions: 1,
        },
      ],
    });
  });

  it('keeps the server order rather than sorting anything of its own', async () => {
    // Deliberately not alphabetical by anything: a client-side sort on the
    // address, the name, the owner, or presence would each reorder this.
    const transport = stubWith([
      row('zeta', CHARLIE_OWNER, 0),
      row('alpha', ALICE_OWNER, 3),
      row('beta', BOB_OWNER, 1),
      row('gamma', ALICE_OWNER, 0),
    ]);

    const run = await runAgents(['--json'], { transport });

    const items = documentOf(run)['items'] as readonly { address: string }[];
    expect(items.map((item) => item.address)).toStrictEqual([
      '@charlie/zeta',
      '@alice/alpha',
      '@bob/beta',
      '@alice/gamma',
    ]);
  });

  it('carries the session count beside online, including when it is more than one', async () => {
    const transport = stubWith();

    const run = await runAgents(['--json'], { transport });

    const items = documentOf(run)['items'] as readonly { online: boolean; sessions: number }[];
    expect(items.map((item) => [item.online, item.sessions])).toStrictEqual([
      [true, 2],
      [false, 0],
      [true, 1],
      [true, 1],
    ]);
  });

  it('emits an empty items array for a project with no agents, not an error', async () => {
    const transport = stubWith([]);

    const run = await runAgents(['--json'], { transport });

    expect(run.code).toBe(0);
    expect(documentOf(run)).toStrictEqual({
      project: { id: PROJECT, slug: 'payments', name: 'Payments Platform' },
      items: [],
    });
  });

  it('asks the server once for the whole project, not once per agent', async () => {
    const transport = stubWith();

    await runAgents(['--json'], { transport });

    expect(transport.countOf(DISCOVER)).toBe(1);
    expect(transport.keys).toStrictEqual([LIST_PROJECTS, DISCOVER]);
  });
});

describe('human output', () => {
  it('groups by owner under a project heading, in the shape PRD §21 gives', async () => {
    const transport = stubWith();

    const run = await runAgents([], { transport });

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
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

  it('says a listener is still running by printing the count behind online', async () => {
    const transport = stubWith([row('backend', ALICE_OWNER, 3)]);

    const run = await runAgents([], { transport });

    expect(run.stdout).toContain('online   3 sessions');
  });

  it('does not merge two owners who share a display name', async () => {
    const transport = stubWith([
      row('backend', owner(ALICE, 'alice', 'Alex'), 1),
      row('backend', owner(BOB, 'bob', 'Alex'), 0),
    ]);

    const run = await runAgents([], { transport });

    expect(run.stdout).toContain('Alex (@alice)');
    expect(run.stdout).toContain('Alex (@bob)');
    expect(run.stdout).toContain('@alice/backend');
    expect(run.stdout).toContain('@bob/backend');
  });

  it('names an online agent in the send hint rather than an offline one', async () => {
    const transport = stubWith([row('frontend', ALICE_OWNER, 0), row('backend', BOB_OWNER, 2)]);

    const run = await runAgents([], { transport });

    expect(run.stdout).toContain('agentchat send @bob/backend');
  });

  it('falls back to the first agent when nobody is listening', async () => {
    const transport = stubWith([row('frontend', ALICE_OWNER, 0), row('backend', BOB_OWNER, 0)]);

    const run = await runAgents([], { transport });

    expect(run.stdout).toContain('agentchat send @alice/frontend');
  });

  it('explains an empty project instead of printing a bare heading', async () => {
    const transport = stubWith([]);

    const run = await runAgents([], { transport });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('No agents are in Payments Platform.');
    expect(run.stdout).toContain('agentchat agent create <name>');
  });
});

describe('the plural command and the singular one', () => {
  it('rejects a subcommand of `agent` by naming `agent`', async () => {
    const transport = stubWith();

    const run = await runAgents(['list'], { transport });

    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('`agentchat agents` takes no arguments; got `list`');
    expect(run.stderr).toContain('`agentchat agent list`');
    // Rejected before anything was sent.
    expect(transport.calls).toHaveLength(0);
  });

  it.each(['create', 'rename', 'delete', 'use', 'join'])(
    'points `agents %s` at the singular command too',
    async (subcommand) => {
      const run = await runAgents([subcommand], { transport: stubWith() });

      expect(run.code).toBe(2);
      expect(run.stderr).toContain(`\`agentchat agent ${subcommand}\``);
    },
  );

  it('falls back to the usage line for a word that is not a subcommand', async () => {
    const run = await runAgents(['bogus'], { transport: stubWith() });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('Usage: agentchat agents [--project <slug|id>] [--json]');
    expect(run.stderr).not.toContain('agentchat agent bogus');
  });

  it('reports the refusal as an error envelope in JSON mode, with stdout clean', async () => {
    const run = await runAgents(['list', '--json'], { transport: stubWith() });

    expect(run.code).toBe(2);
    expect(JSON.parse(run.stdout)).toMatchObject({
      error: { code: ErrorCode.BAD_REQUEST },
    });
  });
});

describe('context and failures', () => {
  it('resolves the project by slug and discovers by the id it found', async () => {
    const transport = stubWith();

    const run = await runAgents(['--json'], { transport }, { AGENTCHAT_PROJECT: 'payments' });

    expect(run.code).toBe(0);
    expect(transport.keys).toStrictEqual([LIST_PROJECTS, DISCOVER]);
  });

  it('exits 4 when nothing names a project', async () => {
    const run = await runAgents([], { transport: stubWith() }, { AGENTCHAT_PROJECT: undefined });

    expect(run.code).toBe(4);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('project');
  });

  it('says which project it could not find when the caller is not a member', async () => {
    const transport = stubWith();

    const run = await runAgents([], { transport }, { AGENTCHAT_PROJECT: 'billing' });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('You are not in a project called `billing`.');
    expect(run.stderr).toContain('agentchat project list');
    // The discovery request is never made against a project we cannot name.
    expect(transport.countOf(DISCOVER)).toBe(0);
  });

  it('never writes operational output to stdout', async () => {
    const transport = stubWith();

    const run = await runAgents([], { transport });

    expect(run.stdout).not.toContain('error');
    expect(run.stdout.startsWith('PROJECT:')).toBe(true);
  });
});

describe('groupByOwner', () => {
  it('keys on the owner id, not the username', () => {
    // Contrived on purpose: usernames are unique today, and this asserts that
    // the grouping does not depend on their being so.
    const rows = [
      row('backend', owner(ALICE, 'alice', 'Alice'), 1),
      row('backend', owner(BOB, 'alice', 'Also Alice'), 0),
    ] as unknown as readonly ProjectAgent[];

    const groups = groupByOwner(rows);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.owner.id)).toStrictEqual([ALICE, BOB]);
  });

  it('keys on the owner id, not the agent name', () => {
    const rows = [
      row('backend', ALICE_OWNER, 1),
      row('backend', BOB_OWNER, 1),
    ] as unknown as readonly ProjectAgent[];

    expect(groupByOwner(rows)).toHaveLength(2);
  });

  it('places an owner where their first agent appeared and keeps agent order', () => {
    const rows = [
      row('zeta', BOB_OWNER, 0),
      row('alpha', ALICE_OWNER, 0),
      row('beta', BOB_OWNER, 0),
    ] as unknown as readonly ProjectAgent[];

    const groups = groupByOwner(rows);

    expect(groups.map((group) => group.owner.username)).toStrictEqual(['bob', 'alice']);
    expect(groups[0]?.agents.map((agent) => agent.agent.name)).toStrictEqual(['zeta', 'beta']);
  });

  it('returns nothing for an empty listing', () => {
    expect(groupByOwner([])).toStrictEqual([]);
  });
});

describe('addressOf and presenceOf', () => {
  it('builds the address `agentchat send` accepts', () => {
    const [only] = [row('backend', ALICE_OWNER, 0)] as unknown as readonly ProjectAgent[];

    expect(only === undefined ? '' : addressOf(only)).toBe('@alice/backend');
  });

  it.each([
    [0, 'offline', ''],
    [1, 'online', '1 session'],
    [2, 'online', '2 sessions'],
  ])('renders %i sessions as %s %s', (sessions, status, count) => {
    const [only] = [row('backend', ALICE_OWNER, sessions)] as unknown as readonly ProjectAgent[];

    expect(only === undefined ? null : presenceOf(only)).toStrictEqual({ status, sessions: count });
  });
});
