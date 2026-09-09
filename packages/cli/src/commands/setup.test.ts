/**
 * `agentchat setup`, driven in process against a stubbed server.
 *
 * Three runs matter, and they are the three this file is built around: a fresh
 * installation with nothing on the machine, the same command run again after it
 * worked, and an invocation with nobody to answer its questions.
 *
 * The fresh run is deliberately written as one scripted standard input and one
 * stubbed server rather than as four tests of four steps. What it is asserting
 * is that the steps compose — that the address the first question obtains is
 * the one the last step's `project init` is issued against, and that the
 * project created in the middle is the one the committed file ends up naming —
 * and a suite that stubbed each step's neighbours would assert none of that.
 *
 * The re-run then asserts the property that makes the command safe to reach
 * for: given the state the fresh run leaves behind, it asks nothing, writes
 * nothing, and sends no request that changes anything.
 *
 * @module
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Transport, TransportRequest, TransportResponse } from '@agentchat/client';
import { InMemoryCredentialStore } from '@agentchat/client';
import { AgentId, ErrorCode, errorEnvelope, ProjectId, UserId } from '@agentchat/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { captureRun } from '../testing.js';
import type { SetupOverrides } from './setup.js';
import { createSetupCommand } from './setup.js';

const SERVER = 'https://chat.example.test';

const START = 'POST /auth/device/start';
const POLL = 'POST /auth/device/poll';
const LIST_PROJECTS = 'GET /projects';
const CREATE_PROJECT = 'POST /projects';
const LIST_AGENTS = 'GET /agents';
const CREATE_AGENT = 'POST /agents';
const REFRESH = 'POST /auth/refresh';

const USER = UserId.generate();
const PROJECT = ProjectId.generate();
const BACKEND = AgentId.generate();
const REVIEWER = AgentId.generate();

const JOIN_PROJECT = `POST /agents/${BACKEND}/projects`;
const LIST_PROJECT_AGENTS = `GET /projects/${PROJECT}/agents`;

const GRANT = {
  deviceCode: 'device-code-abc',
  userCode: 'ABCD-1234',
  verificationUri: 'https://chat.example.test/device',
  interval: 5,
  expiresIn: 900,
};

const APPROVED = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  user: {
    id: USER,
    username: 'alice',
    displayName: 'Alice Example',
    email: 'alice@example.test',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
};

/** The project the fixtures act in, as `GET /projects` reports it. */
const MEMBERSHIP = {
  id: PROJECT,
  slug: 'payments',
  name: 'Payments Platform',
  createdBy: USER,
  createdAt: '2026-01-01T00:00:00.000Z',
  role: 'owner',
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

/**
 * One agent of the project's discovery listing.
 *
 * @param id - The agent's id.
 * @param name - The agent's name.
 * @returns The wire representation.
 */
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
 * The last reply for a route repeats, so "always answers this" is one entry and
 * "empty, then not" is two.
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

/**
 * A server that answers everything a first run needs.
 *
 * The project listing is empty and then is not, which is the state the run
 * itself changes half-way through: the wizard asks before creating anything and
 * `project init` asks again afterwards.
 *
 * @returns The stub.
 */
function stubForFirstRun(): StubServer {
  return new StubServer()
    .on(START, { status: 200, body: GRANT })
    .on(POLL, { status: 200, body: APPROVED })
    .on(
      LIST_PROJECTS,
      { status: 200, body: { items: [] } },
      { status: 200, body: { items: [MEMBERSHIP] } },
    )
    .on(CREATE_PROJECT, { status: 201, body: MEMBERSHIP })
    .on(LIST_AGENTS, { status: 200, body: { items: [] } })
    .on(LIST_PROJECT_AGENTS, { status: 200, body: { items: [] } })
    .on(CREATE_AGENT, { status: 201, body: agent(BACKEND, 'backend') })
    .on(JOIN_PROJECT, { status: 200, body: {} });
}

/**
 * A server that answers a machine which is already set up.
 *
 * @returns The stub.
 */
function stubForSecondRun(): StubServer {
  return new StubServer()
    .on(LIST_PROJECTS, { status: 200, body: { items: [MEMBERSHIP] } })
    .on(LIST_AGENTS, { status: 200, body: { items: [agent(BACKEND, 'backend')] } })
    .on(LIST_PROJECT_AGENTS, {
      status: 200,
      body: { items: [projectAgent(BACKEND, 'backend')] },
    });
}

/** A store with no credentials in it: a machine nobody has signed in on. */
function signedOut(): InMemoryCredentialStore {
  return new InMemoryCredentialStore();
}

/** A store that is logged in, so the first request reaches the transport. */
function signedIn(): InMemoryCredentialStore {
  return new InMemoryCredentialStore({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
  });
}

const temporaries: string[] = [];

/**
 * A throwaway directory.
 *
 * @returns Its absolute path.
 */
async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agentchat-setup-'));
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
  readonly cwd: string;
}

/** How to run the wizard. */
interface RunSetup {
  /** What standard input produces. Defaults to a closed descriptor. */
  readonly stdin?: string;

  /** Whether stderr claims to be a terminal. Defaults to `true`. */
  readonly terminal?: boolean;

  /** Extra environment, merged over the defaults. */
  readonly env?: Readonly<Record<string, string | undefined>>;

  /** The working directory. Defaults to a fresh one. */
  readonly cwd?: string;

  /** A configuration directory to reuse. */
  readonly home?: string;

  /** Extra arguments. */
  readonly argv?: readonly string[];
}

/**
 * Runs `setup` through the whole framework.
 *
 * The clock is not stubbed and does not need to be: `sleep` resolves at once,
 * and the poll loop's deadline is measured against a real clock that has not
 * moved by the time the first poll succeeds.
 *
 * @param overrides - The seams to run against.
 * @param setup - Input, environment, and directories.
 * @returns Both streams, the exit code, and the directories that were used.
 */
async function runSetup(overrides: SetupOverrides, setup: RunSetup = {}): Promise<Outcome> {
  const home = setup.home ?? (await temporaryDirectory());
  const cwd = setup.cwd ?? (await temporaryDirectory());
  const run = await captureRun(['setup', ...(setup.argv ?? [])], {
    commands: [createSetupCommand({ sleep: () => Promise.resolve(), ...overrides })],
    env: { XDG_CONFIG_HOME: home, ...setup.env },
    cwd,
    stderrIsTTY: setup.terminal ?? true,
    ...(setup.stdin === undefined ? {} : { stdin: setup.stdin }),
  });
  return { ...run, home, cwd };
}

/**
 * The repository configuration written into a directory.
 *
 * @param cwd - The directory.
 * @returns The parsed document, or `null` if none was written.
 */
async function repositoryConfig(cwd: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(cwd, '.agentchat', 'config.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

/**
 * The user configuration under a fake configuration home.
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

/**
 * Writes a repository configuration into a directory.
 *
 * @param cwd - The directory.
 * @param document - What to write.
 * @returns A promise that resolves once it is on disk.
 */
async function writeRepositoryFixture(cwd: string, document: unknown): Promise<void> {
  await mkdir(join(cwd, '.agentchat'), { recursive: true });
  await writeFile(join(cwd, '.agentchat', 'config.json'), `${JSON.stringify(document)}\n`);
}

/**
 * Writes a user configuration under a fake configuration home.
 *
 * @param home - The configuration directory.
 * @param document - What to write.
 * @returns A promise that resolves once it is on disk.
 */
async function writeUserFixture(home: string, document: unknown): Promise<void> {
  await mkdir(join(home, 'agentchat'), { recursive: true });
  await writeFile(join(home, 'agentchat', 'config.json'), `${JSON.stringify(document)}\n`);
}

/** Everything a first run is asked, in the order it is asked. */
const FIRST_RUN_ANSWERS = [SERVER, 'create', 'Payments Platform', 'backend', 'claude-code'];

describe('a fresh installation', () => {
  it('walks all four steps and ends by naming the listen command', async () => {
    const stub = stubForFirstRun();
    const run = await runSetup(
      { store: signedOut(), transport: stub },
      { stdin: `${FIRST_RUN_ANSWERS.join('\n')}\n` },
    );

    expect(run.code).toBe(0);

    // The four steps happened, in order, through the real commands.
    expect(stub.keys).toEqual([
      START,
      POLL,
      LIST_PROJECTS,
      CREATE_PROJECT,
      LIST_AGENTS,
      LIST_PROJECT_AGENTS,
      CREATE_AGENT,
      JOIN_PROJECT,
      LIST_PROJECTS,
    ]);
    expect(stub.bodyOf(CREATE_PROJECT)).toEqual({ name: 'Payments Platform' });
    expect(stub.bodyOf(CREATE_AGENT)).toEqual({ name: 'backend' });
    expect(stub.bodyOf(JOIN_PROJECT)).toEqual({ projectId: PROJECT });

    // The address the first question obtained was written down by `login`, and
    // the committed file names the project created half-way through.
    expect(await userConfig(run.home)).toMatchObject({ serverUrl: SERVER });
    expect(await repositoryConfig(run.cwd)).toEqual({
      projectId: PROJECT,
      projectSlug: 'payments',
    });

    // The last thing it says is the command to run next, exactly as typed.
    expect(run.stdout).toContain('agentchat listen --runtime claude-code');
  });

  it('keeps the questions and the progress off stdout', async () => {
    const run = await runSetup(
      { store: signedOut(), transport: stubForFirstRun() },
      { stdin: `${FIRST_RUN_ANSWERS.join('\n')}\n` },
    );

    expect(run.code).toBe(0);
    // The prompts, the device code, and every progress line are stderr's. A
    // harness reading file descriptor 1 sees the summary and nothing else.
    expect(run.stderr).toContain(GRANT.userCode);
    expect(run.stdout).not.toContain(GRANT.userCode);
    expect(run.stdout).not.toContain('What is the project called?');
    expect(run.stdout).not.toContain('[agentchat]');
  });

  it('asks the server address first, because nothing else can happen without one', async () => {
    const stub = stubForFirstRun();
    const run = await runSetup({ store: signedOut(), transport: stub }, { stdin: '' });

    // Nobody answered, so nothing was attempted and the equivalent commands are
    // what it printed instead.
    expect(run.code).toBe(2);
    expect(stub.calls).toHaveLength(0);
    expect(run.stderr).toContain('agentchat login --server <url>');
  });

  it('rejects a name the server would reject, without sending it', async () => {
    const stub = stubForFirstRun();
    const answers = [SERVER, 'create', '', 'Payments Platform', 'backend', 'claude-code'];
    const run = await runSetup(
      { store: signedOut(), transport: stub },
      { stdin: `${answers.join('\n')}\n` },
    );

    expect(run.code).toBe(0);
    // One create, not two: the empty name never left the machine.
    expect(stub.countOf(CREATE_PROJECT)).toBe(1);
    expect(stub.bodyOf(CREATE_PROJECT)).toEqual({ name: 'Payments Platform' });
  });
});

describe('running it again', () => {
  /**
   * The machine the fresh run leaves behind.
   *
   * @returns The configuration directory and the working directory.
   */
  async function settled(): Promise<{ home: string; cwd: string }> {
    const home = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    await writeUserFixture(home, { serverUrl: SERVER, defaultAgentByProject: {} });
    await writeRepositoryFixture(cwd, { projectId: PROJECT, projectSlug: 'payments' });
    return { home, cwd };
  }

  it('asks nothing, writes nothing, and still names the listen command', async () => {
    const { home, cwd } = await settled();
    const before = await repositoryConfig(cwd);
    const stub = stubForSecondRun();

    const run = await runSetup(
      { store: signedIn(), transport: stub },
      { home, cwd, argv: ['--runtime', 'codex'], stdin: '' },
    );

    expect(run.code).toBe(0);
    // Only the three listings that answer "is there anything to do here?".
    expect(stub.keys).toEqual([LIST_PROJECTS, LIST_AGENTS, LIST_PROJECT_AGENTS]);
    expect(await repositoryConfig(cwd)).toEqual(before);
    expect(run.stdout).toContain('agentchat listen --runtime codex');
  });

  it('says of every step that it was already satisfied', async () => {
    const { home, cwd } = await settled();
    const run = await runSetup(
      { store: signedIn(), transport: stubForSecondRun() },
      { home, cwd, argv: ['--runtime', 'codex', '--json'], stdin: '' },
    );

    expect(run.code).toBe(0);
    const emitted = JSON.parse(run.stdout) as {
      steps: { name: string; status: string }[];
      next: { command: string };
    };
    expect(emitted.steps.map((step) => `${step.name}:${step.status}`)).toEqual([
      'login:satisfied',
      'project:satisfied',
      'agent:satisfied',
      'repository:satisfied',
    ]);
    expect(emitted.next.command).toBe('agentchat listen --runtime codex');
  });

  it('runs the steps that are outstanding and skips the ones that are not', async () => {
    // Signed in and in the project, but this directory has never been linked
    // and there is no agent here yet: two steps to do, two to skip.
    const home = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    await writeUserFixture(home, { serverUrl: SERVER, defaultAgentByProject: {} });
    const stub = new StubServer()
      .on(LIST_PROJECTS, { status: 200, body: { items: [MEMBERSHIP] } })
      .on(LIST_AGENTS, { status: 200, body: { items: [] } })
      .on(LIST_PROJECT_AGENTS, { status: 200, body: { items: [] } })
      .on(CREATE_AGENT, { status: 201, body: agent(BACKEND, 'backend') })
      .on(JOIN_PROJECT, { status: 200, body: {} });

    const run = await runSetup(
      { store: signedIn(), transport: stub },
      {
        home,
        cwd,
        env: { AGENTCHAT_PROJECT: 'payments' },
        argv: ['--runtime', 'codex'],
        stdin: 'backend\n',
      },
    );

    expect(run.code).toBe(0);
    expect(stub.countOf(START)).toBe(0);
    expect(stub.countOf(CREATE_PROJECT)).toBe(0);
    expect(stub.countOf(CREATE_AGENT)).toBe(1);
    expect(await repositoryConfig(cwd)).toEqual({
      projectId: PROJECT,
      projectSlug: 'payments',
    });
  });

  it('signs in again when the stored credentials are no longer accepted', async () => {
    // The state T-043 leaves a machine in overnight: a credentials file whose
    // access token has expired and whose refresh token cannot be spent.
    const { home, cwd } = await settled();
    const stub = new StubServer()
      .on(START, { status: 200, body: GRANT })
      .on(POLL, { status: 200, body: APPROVED })
      // The client refreshes once before giving up, and a server that will not
      // honour the refresh token answers this. It is stubbed as the protocol
      // specifies rather than as the server behaves today: `POST /auth/refresh`
      // does not exist yet and answers the unmatched-route NOT_FOUND (T-043),
      // and a test written around that would have to be rewritten the day the
      // route lands — having asserted, in the meantime, that a defect is the
      // contract.
      .on(REFRESH, { status: 401, body: errorEnvelope(ErrorCode.AUTH_REQUIRED, 'expired') })
      .on(
        LIST_PROJECTS,
        { status: 401, body: errorEnvelope(ErrorCode.AUTH_REQUIRED, 'expired') },
        { status: 200, body: { items: [MEMBERSHIP] } },
      )
      .on(LIST_AGENTS, { status: 200, body: { items: [agent(BACKEND, 'backend')] } })
      .on(LIST_PROJECT_AGENTS, {
        status: 200,
        body: { items: [projectAgent(BACKEND, 'backend')] },
      });

    const run = await runSetup(
      { store: signedIn(), transport: stub },
      { home, cwd, argv: ['--runtime', 'codex'], stdin: '' },
    );

    expect(run.code).toBe(0);
    expect(stub.countOf(START)).toBe(1);
    expect(run.stdout).toContain('agentchat listen --runtime codex');
  });
});

describe('with nobody to answer', () => {
  it('prints the individual commands instead of waiting, and exits 2', async () => {
    const stub = stubForFirstRun();
    const run = await runSetup({ store: signedOut(), transport: stub }, { terminal: false });

    expect(run.code).toBe(2);
    expect(stub.calls).toHaveLength(0);
    expect(run.stdout).toBe('');
    for (const command of [
      'agentchat login --server <url>',
      'agentchat project create <name>',
      'agentchat agent create <name>',
      'agentchat project init <slug>',
      'agentchat listen --runtime <name>',
    ]) {
      expect(run.stderr).toContain(command);
    }
    expect(run.stderr).toContain('agentchat project join <code>');
  });

  it('lists only what is outstanding, filled in with what it knows', async () => {
    const home = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    await writeUserFixture(home, { serverUrl: SERVER, defaultAgentByProject: {} });
    const stub = new StubServer()
      .on(LIST_PROJECTS, { status: 200, body: { items: [MEMBERSHIP] } })
      .on(LIST_AGENTS, { status: 200, body: { items: [] } })
      .on(LIST_PROJECT_AGENTS, { status: 200, body: { items: [] } });

    const run = await runSetup(
      { store: signedIn(), transport: stub },
      { home, cwd, terminal: false, env: { AGENTCHAT_PROJECT: 'payments' } },
    );

    expect(run.code).toBe(2);
    // Signed in and in the project already, so neither is listed; the project
    // is known, so `project init` names it rather than a placeholder.
    expect(run.stderr).not.toContain('agentchat login');
    expect(run.stderr).not.toContain('agentchat project create');
    expect(run.stderr).toContain('agentchat agent create <name>');
    expect(run.stderr).toContain('agentchat project init payments');
  });

  it('refuses under --json and carries the commands in the envelope', async () => {
    const run = await runSetup(
      { store: signedOut(), transport: stubForFirstRun() },
      { terminal: true, argv: ['--json'] },
    );

    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout) as { error: { code: string; hint: string } };
    expect(envelope.error.code).toBe('BAD_REQUEST');
    expect(envelope.error.hint).toContain('agentchat login --server <url>');
    expect(envelope.error.hint).toContain('agentchat listen --runtime <name>');
    // The block is a human rendering; a consumer reads the envelope, and the
    // two must not both be present or a merged descriptor shows it twice.
    expect(run.stderr).not.toContain('These are the steps that are left');
  });
});

describe('the questions it asks', () => {
  it('offers the projects you are already in, and takes one by number', async () => {
    const home = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    await writeUserFixture(home, { serverUrl: SERVER, defaultAgentByProject: {} });
    const stub = new StubServer()
      .on(LIST_PROJECTS, { status: 200, body: { items: [MEMBERSHIP] } })
      .on(LIST_AGENTS, { status: 200, body: { items: [agent(BACKEND, 'backend')] } })
      .on(LIST_PROJECT_AGENTS, {
        status: 200,
        body: { items: [projectAgent(BACKEND, 'backend')] },
      });

    const run = await runSetup(
      { store: signedIn(), transport: stub },
      { home, cwd, stdin: '1\ncodex\n' },
    );

    expect(run.code).toBe(0);
    expect(stub.countOf(CREATE_PROJECT)).toBe(0);
    expect(run.stderr).toContain('payments');
    expect(await repositoryConfig(cwd)).toMatchObject({ projectSlug: 'payments' });
  });

  it('chooses between several agents rather than making another one', async () => {
    const home = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    await writeUserFixture(home, { serverUrl: SERVER, defaultAgentByProject: {} });
    await writeRepositoryFixture(cwd, { projectId: PROJECT, projectSlug: 'payments' });
    const stub = new StubServer()
      .on(LIST_PROJECTS, { status: 200, body: { items: [MEMBERSHIP] } })
      .on(LIST_AGENTS, {
        status: 200,
        body: { items: [agent(BACKEND, 'backend'), agent(REVIEWER, 'reviewer')] },
      })
      .on(LIST_PROJECT_AGENTS, {
        status: 200,
        body: {
          items: [projectAgent(BACKEND, 'backend'), projectAgent(REVIEWER, 'reviewer')],
        },
      });

    const run = await runSetup(
      { store: signedIn(), transport: stub },
      { home, cwd, stdin: 'reviewer\ncodex\n' },
    );

    expect(run.code).toBe(0);
    expect(stub.countOf(CREATE_AGENT)).toBe(0);
    // `agent use` is what fixes the ambiguity for good, so the choice is on
    // disk rather than only in this run's summary.
    expect(await userConfig(home)).toMatchObject({
      defaultAgentByProject: { [PROJECT]: REVIEWER },
    });
  });

  it('refuses to set up a project the repository names and you are not in', async () => {
    const home = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    await writeUserFixture(home, { serverUrl: SERVER, defaultAgentByProject: {} });
    await writeRepositoryFixture(cwd, { projectId: ProjectId.generate(), projectSlug: 'billing' });
    const stub = new StubServer().on(LIST_PROJECTS, {
      status: 200,
      body: { items: [MEMBERSHIP] },
    });

    const run = await runSetup(
      { store: signedIn(), transport: stub },
      { home, cwd, stdin: 'create\nSomething Else\n' },
    );

    expect(run.code).toBe(1);
    expect(stub.countOf(CREATE_PROJECT)).toBe(0);
    expect(run.stderr).toContain('billing');
  });
});
