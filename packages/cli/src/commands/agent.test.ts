/**
 * `agentchat agent …`, driven in process against a stubbed server.
 *
 * The suite under `../../tests/agent.test.ts` spawns the real binary and is
 * what proves the stream contract; this one covers the branches — a name
 * rejected before the socket opens, a declined confirmation, a default that has
 * to be forgotten — that a subprocess test would pay a process launch each to
 * reach.
 *
 * Two things are asserted throughout rather than once. Nothing operational ever
 * appears on stdout, and no request is made before an argument the client can
 * judge for itself has been judged.
 *
 * @module
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Transport, TransportRequest, TransportResponse } from '@agentchat/client';
import { InMemoryCredentialStore } from '@agentchat/client';
import { AgentId, ErrorCode, errorEnvelope, ProjectId, UserId } from '@agentchat/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { captureRun } from '../testing.js';
import type { AgentOverrides } from './agent.js';
import { createAgentCommand, requireAgentName } from './agent.js';

const SERVER = 'https://chat.example.test';

const LIST_AGENTS = 'GET /agents';
const CREATE_AGENT = 'POST /agents';
const LIST_PROJECTS = 'GET /projects';

const USER = UserId.generate();
const PROJECT = ProjectId.generate();
const BACKEND = AgentId.generate();
const REVIEWER = AgentId.generate();

/** The project the fixtures act in, as `GET /projects` reports it. */
const MEMBERSHIP = {
  id: PROJECT,
  slug: 'payments',
  name: 'Payments Platform',
  createdBy: USER,
  createdAt: '2026-01-01T00:00:00.000Z',
  role: 'member',
};

/**
 * An agent, in the shape `AgentSchema` parses.
 *
 * @param id - The agent's id.
 * @param name - The agent's name.
 * @returns The wire representation.
 */
function agent(id: string, name: string): Record<string, unknown> {
  return {
    id,
    userId: USER,
    name,
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
}

/** One agent of the project's discovery listing. */
function projectAgent(id: string, name: string): Record<string, unknown> {
  return {
    agent: agent(id, name),
    owner: { id: USER, username: 'alice', displayName: 'Alice Example' },
    online: false,
    sessions: 0,
  };
}

/** One scripted response. */
interface Reply {
  readonly status: number;
  readonly body?: unknown;
}

/**
 * A transport that answers from a script instead of a socket.
 *
 * The last reply for a route repeats, so "always answers this" is one entry.
 */
class StubServer implements Transport {
  public readonly calls: TransportRequest[] = [];
  readonly #queues = new Map<string, Reply[]>();

  public on(key: string, ...replies: readonly Reply[]): this {
    this.#queues.set(key, [...replies]);
    return this;
  }

  public get keys(): readonly string[] {
    return this.calls.map((call) => `${call.method} ${call.path}`);
  }

  public countOf(key: string): number {
    return this.keys.filter((seen) => seen === key).length;
  }

  public bodyOf(key: string): unknown {
    return this.calls.find((call) => `${call.method} ${call.path}` === key)?.body;
  }

  public request(request: TransportRequest): Promise<TransportResponse> {
    this.calls.push(request);
    const key = `${request.method} ${request.path}`;
    const queue = this.#queues.get(key);
    const next = queue === undefined || queue.length === 0 ? undefined : queue[0];
    if (next === undefined) {
      return Promise.resolve({
        status: 404,
        headers: {},
        body: errorEnvelope(ErrorCode.NOT_FOUND, `No stub for ${key}.`),
      });
    }
    if (queue !== undefined && queue.length > 1) {
      queue.shift();
    }
    return Promise.resolve({ status: next.status, headers: {}, body: next.body ?? {} });
  }
}

/** A stub that answers the two listings every fixture needs. */
function stubWithAgents(...agents: readonly Record<string, unknown>[]): StubServer {
  return new StubServer()
    .on(LIST_AGENTS, { status: 200, body: { items: agents } })
    .on(LIST_PROJECTS, { status: 200, body: { items: [MEMBERSHIP] } });
}

/** A store that is logged in, so `auth: 'required'` calls reach the transport. */
function signedIn(): InMemoryCredentialStore {
  return new InMemoryCredentialStore({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
  });
}

const temporaries: string[] = [];

/**
 * A throwaway configuration directory.
 *
 * @returns Its absolute path.
 */
async function temporaryHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agentchat-agent-'));
  temporaries.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaries.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** What one in-process invocation produced. */
interface Outcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly home: string;
}

/**
 * Runs one `agent` subcommand through the whole framework.
 *
 * The project is named through `AGENTCHAT_PROJECT` unless the caller overrides
 * it, so no fixture has to exist on disk for resolution to succeed.
 *
 * @param argv - The arguments, starting with `agent`.
 * @param overrides - The seams to run against.
 * @param extra - Extra environment, merged last.
 * @param home - An existing configuration directory, if one is being reused.
 * @returns Both streams, the exit code, and the home that was used.
 */
async function runAgent(
  argv: readonly string[],
  overrides: AgentOverrides,
  extra: Readonly<Record<string, string | undefined>> = {},
  home?: string,
): Promise<Outcome> {
  const configHome = home ?? (await temporaryHome());
  const run = await captureRun([...argv, '--server', SERVER], {
    commands: [createAgentCommand(overrides)],
    env: { XDG_CONFIG_HOME: configHome, AGENTCHAT_PROJECT: PROJECT, ...extra },
    cwd: configHome,
  });
  return { ...run, home: configHome };
}

/**
 * The user configuration written under a fake home.
 *
 * @param home - The configuration directory.
 * @returns The parsed document, or `null` if none was written.
 */
async function userConfig(home: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(home, 'agentchat', 'config.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

describe('requireAgentName', () => {
  it('accepts the grammar the server accepts', () => {
    expect(requireAgentName('backend')).toBe('backend');
    expect(requireAgentName('code-review-2')).toBe('code-review-2');
    expect(requireAgentName('a'.repeat(32))).toBe('a'.repeat(32));
  });

  it('rejects everything outside it, quoting the schema’s own explanation', () => {
    for (const bad of ['Backend', '-leading', 'has space', 'under_score', '', 'a'.repeat(33)]) {
      expect(() => requireAgentName(bad)).toThrow(/not a valid agent name/);
    }
  });

  it('names which argument was wrong, so `rename` can say which of two', () => {
    expect(() => requireAgentName('Nope', 'new name')).toThrow(/not a valid new name/);
  });
});

describe('agent list', () => {
  it('lists the caller’s agents and marks the default for this project', async () => {
    const home = await temporaryHome();
    const stub = stubWithAgents(agent(BACKEND, 'backend'), agent(REVIEWER, 'reviewer')).on(
      `GET /projects/${PROJECT}/agents`,
      { status: 200, body: { items: [projectAgent(BACKEND, 'backend')] } },
    );
    const used = await runAgent(
      ['agent', 'use', 'backend'],
      { store: signedIn(), transport: stub },
      {},
      home,
    );
    expect(used.code).toBe(0);

    const run = await runAgent(
      ['agent', 'list'],
      { store: signedIn(), transport: stubWithAgents(agent(BACKEND, 'backend')) },
      {},
      home,
    );

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('backend');
    expect(run.stdout).toContain('(default here)');
  });

  it('answers with an item list and an isDefault flag under --json', async () => {
    const run = await runAgent(['agent', 'list', '--json'], {
      store: signedIn(),
      transport: stubWithAgents(agent(BACKEND, 'backend')),
    });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      items: [
        {
          id: BACKEND,
          name: 'backend',
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
          isDefault: false,
        },
      ],
    });
  });

  it('says how to create one when there are none, and still exits 0', async () => {
    const run = await runAgent(['agent', 'list'], {
      store: signedIn(),
      transport: stubWithAgents(),
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('agent create');
  });

  it('works with no project at all, because agents are not project-scoped', async () => {
    const stub = stubWithAgents(agent(BACKEND, 'backend'));
    const run = await runAgent(
      ['agent', 'list', '--json'],
      { store: signedIn(), transport: stub },
      { AGENTCHAT_PROJECT: undefined },
    );

    expect(run.code).toBe(0);
    expect(stub.countOf(LIST_PROJECTS)).toBe(0);
  });
});

describe('agent create', () => {
  it('creates the agent and joins it to the resolved project', async () => {
    const stub = stubWithAgents()
      .on(CREATE_AGENT, { status: 201, body: agent(BACKEND, 'backend') })
      .on(`POST /agents/${BACKEND}/projects`, { status: 200, body: {} });

    const run = await runAgent(['agent', 'create', 'backend', '--json'], {
      store: signedIn(),
      transport: stub,
    });

    expect(run.code).toBe(0);
    expect(stub.bodyOf(CREATE_AGENT)).toEqual({ name: 'backend' });
    expect(stub.bodyOf(`POST /agents/${BACKEND}/projects`)).toEqual({ projectId: PROJECT });
    expect(JSON.parse(run.stdout)).toMatchObject({
      agent: { id: BACKEND, name: 'backend' },
      project: { id: PROJECT, slug: null },
    });
  });

  it('resolves a project named by slug through the caller’s memberships', async () => {
    const stub = stubWithAgents()
      .on(CREATE_AGENT, { status: 201, body: agent(BACKEND, 'backend') })
      .on(`POST /agents/${BACKEND}/projects`, { status: 200, body: {} });

    const run = await runAgent(
      ['agent', 'create', 'backend'],
      { store: signedIn(), transport: stub },
      { AGENTCHAT_PROJECT: 'payments' },
    );

    expect(run.code).toBe(0);
    expect(stub.bodyOf(`POST /agents/${BACKEND}/projects`)).toEqual({ projectId: PROJECT });
  });

  it('rejects an invalid name without opening a connection', async () => {
    const stub = stubWithAgents();

    const run = await runAgent(['agent', 'create', 'Backend'], {
      store: signedIn(),
      transport: stub,
    });

    expect(run.code).toBe(2);
    expect(stub.calls).toHaveLength(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('not a valid agent name');
  });

  it('creates nothing when no project resolves, and exits 4', async () => {
    const stub = stubWithAgents();

    const run = await runAgent(
      ['agent', 'create', 'backend'],
      { store: signedIn(), transport: stub },
      { AGENTCHAT_PROJECT: undefined },
    );

    expect(run.code).toBe(4);
    expect(stub.countOf(CREATE_AGENT)).toBe(0);
  });

  it('says the agent exists when the join fails, then fails', async () => {
    const stub = stubWithAgents()
      .on(CREATE_AGENT, { status: 201, body: agent(BACKEND, 'backend') })
      .on(`POST /agents/${BACKEND}/projects`, {
        status: 403,
        body: errorEnvelope(ErrorCode.FORBIDDEN, 'not a member'),
      });

    const run = await runAgent(['agent', 'create', 'backend'], {
      store: signedIn(),
      transport: stub,
    });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('agent join backend');
    expect(run.stdout).toBe('');
  });
});

describe('agent rename', () => {
  it('renames by name and reports both names', async () => {
    const stub = stubWithAgents(agent(BACKEND, 'backend')).on(`PATCH /agents/${BACKEND}`, {
      status: 200,
      body: agent(BACKEND, 'backend-2'),
    });

    const run = await runAgent(['agent', 'rename', 'backend', 'backend-2', '--json'], {
      store: signedIn(),
      transport: stub,
    });

    expect(run.code).toBe(0);
    expect(stub.bodyOf(`PATCH /agents/${BACKEND}`)).toEqual({ name: 'backend-2' });
    expect(JSON.parse(run.stdout)).toMatchObject({
      previousName: 'backend',
      agent: { id: BACKEND, name: 'backend-2' },
    });
  });

  it('reports an unknown name with the names that do exist', async () => {
    const run = await runAgent(['agent', 'rename', 'missing', 'backend-2'], {
      store: signedIn(),
      transport: stubWithAgents(agent(BACKEND, 'backend')),
    });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('You have no agent named `missing`');
    expect(run.stderr).toContain('backend');
  });

  it('rejects a new name that cannot be one, before the lookup', async () => {
    const stub = stubWithAgents(agent(BACKEND, 'backend'));

    const run = await runAgent(['agent', 'rename', 'backend', 'Backend'], {
      store: signedIn(),
      transport: stub,
    });

    expect(run.code).toBe(2);
    expect(stub.calls).toHaveLength(0);
  });
});

describe('agent delete', () => {
  /** A stub that owns `backend` and accepts its deletion. */
  function deletableStub(): StubServer {
    return stubWithAgents(agent(BACKEND, 'backend')).on(`DELETE /agents/${BACKEND}`, {
      status: 200,
      body: {},
    });
  }

  it('explains that history is preserved and that the name is not the identity', async () => {
    const stub = deletableStub();
    const asked: string[] = [];

    const run = await runAgent(['agent', 'delete', 'backend'], {
      store: signedIn(),
      transport: stub,
      confirm: (question) => {
        asked.push(question);
        return Promise.resolve(true);
      },
    });

    expect(run.code).toBe(0);
    expect(asked).toEqual(['Delete backend?']);
    expect(run.stderr).toContain('History is preserved');
    expect(run.stderr).toContain('mints a NEW agent that');
    expect(run.stderr).toContain('shares the address but not the identity');
    expect(stub.countOf(`DELETE /agents/${BACKEND}`)).toBe(1);
    // The warning is prose for a person; stdout carries the result only.
    expect(run.stdout).not.toContain('History is preserved');
    expect(run.stdout).toContain('Deleted backend');
  });

  it('deletes nothing when the answer is no, and still exits 0', async () => {
    const stub = deletableStub();

    const run = await runAgent(['agent', 'delete', 'backend'], {
      store: signedIn(),
      transport: stub,
      confirm: () => Promise.resolve(false),
    });

    expect(run.code).toBe(0);
    expect(stub.countOf(`DELETE /agents/${BACKEND}`)).toBe(0);
    expect(run.stderr).toContain('Cancelled');
    expect(run.stdout).toBe('');
  });

  it('does not ask when --yes is given', async () => {
    const stub = deletableStub();
    let asked = false;

    const run = await runAgent(['agent', 'delete', 'backend', '--yes'], {
      store: signedIn(),
      transport: stub,
      confirm: () => {
        asked = true;
        return Promise.resolve(true);
      },
    });

    expect(run.code).toBe(0);
    expect(asked).toBe(false);
    expect(stub.countOf(`DELETE /agents/${BACKEND}`)).toBe(1);
  });

  it('refuses --json without --yes before it asks the server anything', async () => {
    const stub = deletableStub();

    const run = await runAgent(['agent', 'delete', 'backend', '--json'], {
      store: signedIn(),
      transport: stub,
    });

    expect(run.code).toBe(2);
    expect(stub.calls).toHaveLength(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ error: { code: 'BAD_REQUEST' } });
  });

  it('forgets a default that pointed at the deleted agent, in every project', async () => {
    const home = await temporaryHome();
    const other = ProjectId.generate();

    // Two projects, both defaulting to `backend`, set through the command
    // itself so the fixture is the thing the code actually writes.
    for (const project of [PROJECT, other]) {
      const stub = stubWithAgents(agent(BACKEND, 'backend')).on(`GET /projects/${project}/agents`, {
        status: 200,
        body: { items: [projectAgent(BACKEND, 'backend')] },
      });
      const used = await runAgent(
        ['agent', 'use', 'backend'],
        { store: signedIn(), transport: stub },
        { AGENTCHAT_PROJECT: project },
        home,
      );
      expect(used.code).toBe(0);
    }
    expect(await userConfig(home)).toMatchObject({
      defaultAgentByProject: { [PROJECT]: BACKEND, [other]: BACKEND },
    });

    const run = await runAgent(
      ['agent', 'delete', 'backend', '--yes'],
      { store: signedIn(), transport: deletableStub() },
      {},
      home,
    );

    expect(run.code).toBe(0);
    expect(await userConfig(home)).toMatchObject({ defaultAgentByProject: {} });
    expect(run.stderr).toContain('no longer has a default agent');
  });

  it('leaves another agent’s default alone', async () => {
    const home = await temporaryHome();
    const stub = stubWithAgents(agent(REVIEWER, 'reviewer')).on(`GET /projects/${PROJECT}/agents`, {
      status: 200,
      body: { items: [projectAgent(REVIEWER, 'reviewer')] },
    });
    await runAgent(['agent', 'use', 'reviewer'], { store: signedIn(), transport: stub }, {}, home);

    await runAgent(
      ['agent', 'delete', 'backend', '--yes'],
      { store: signedIn(), transport: deletableStub() },
      {},
      home,
    );

    expect(await userConfig(home)).toMatchObject({
      defaultAgentByProject: { [PROJECT]: REVIEWER },
    });
  });
});

describe('agent use', () => {
  /** A stub whose project contains `backend`. */
  function memberStub(): StubServer {
    return stubWithAgents(agent(BACKEND, 'backend')).on(`GET /projects/${PROJECT}/agents`, {
      status: 200,
      body: { items: [projectAgent(BACKEND, 'backend')] },
    });
  }

  it('records the default in user configuration, keyed by project id', async () => {
    const run = await runAgent(['agent', 'use', 'backend', '--json'], {
      store: signedIn(),
      transport: memberStub(),
    });

    expect(run.code).toBe(0);
    expect(await userConfig(run.home)).toEqual({
      defaultAgentByProject: { [PROJECT]: BACKEND },
    });
    expect(JSON.parse(run.stdout)).toMatchObject({
      agent: { id: BACKEND, name: 'backend' },
      project: { id: PROJECT },
    });
  });

  it('never writes the repository configuration, which is shared and committed', async () => {
    const run = await runAgent(['agent', 'use', 'backend'], {
      store: signedIn(),
      transport: memberStub(),
    });

    expect(run.code).toBe(0);
    await expect(stat(join(run.home, '.agentchat'))).rejects.toThrow();
  });

  it('preserves what the file already held, including the configured server', async () => {
    const home = await temporaryHome();
    await mkdir(join(home, 'agentchat'), { recursive: true });
    await writeFile(
      join(home, 'agentchat', 'config.json'),
      JSON.stringify({ serverUrl: SERVER, somethingNewer: true }),
      'utf8',
    );

    const run = await runAgent(
      ['agent', 'use', 'backend'],
      { store: signedIn(), transport: memberStub() },
      {},
      home,
    );

    expect(run.code).toBe(0);
    expect(await userConfig(home)).toEqual({
      serverUrl: SERVER,
      somethingNewer: true,
      defaultAgentByProject: { [PROJECT]: BACKEND },
    });
  });

  it('refuses an agent that is not in the project, and records nothing', async () => {
    const stub = stubWithAgents(agent(BACKEND, 'backend')).on(`GET /projects/${PROJECT}/agents`, {
      status: 200,
      body: { items: [] },
    });

    const run = await runAgent(['agent', 'use', 'backend'], {
      store: signedIn(),
      transport: stub,
    });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('agent join backend');
    expect(await userConfig(run.home)).toBeNull();
  });

  it('exits 4 when no project can be resolved', async () => {
    const run = await runAgent(
      ['agent', 'use', 'backend'],
      { store: signedIn(), transport: memberStub() },
      { AGENTCHAT_PROJECT: undefined },
    );

    expect(run.code).toBe(4);
    expect(await userConfig(run.home)).toBeNull();
  });
});

describe('agent join', () => {
  it('adds the agent to the project and succeeds a second time', async () => {
    const stub = stubWithAgents(agent(BACKEND, 'backend')).on(`POST /agents/${BACKEND}/projects`, {
      status: 200,
      body: {},
    });

    const first = await runAgent(['agent', 'join', 'backend'], {
      store: signedIn(),
      transport: stub,
    });
    const second = await runAgent(['agent', 'join', 'backend', '--json'], {
      store: signedIn(),
      transport: stub,
    });

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(stub.countOf(`POST /agents/${BACKEND}/projects`)).toBe(2);
    expect(JSON.parse(second.stdout)).toMatchObject({ joined: true, project: { id: PROJECT } });
  });
});

describe('every subcommand', () => {
  it('reports being logged out as exit 3 without asking the server', async () => {
    const stub = stubWithAgents(agent(BACKEND, 'backend'));

    const run = await runAgent(['agent', 'list'], {
      store: new InMemoryCredentialStore(),
      transport: stub,
    });

    expect(run.code).toBe(3);
    expect(stub.calls).toHaveLength(0);
  });

  it('refuses to guess a server when none is configured', async () => {
    const home = await temporaryHome();
    const run = await captureRun(['agent', 'list'], {
      commands: [createAgentCommand({ store: signedIn(), transport: stubWithAgents() })],
      env: { XDG_CONFIG_HOME: home, AGENTCHAT_PROJECT: PROJECT },
      cwd: home,
    });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('No AgentChat server is configured');
  });
});
