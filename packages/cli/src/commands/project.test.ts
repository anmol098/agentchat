/**
 * `agentchat project …`, driven in process against a stubbed server.
 *
 * The suite under `../../tests/project.test.ts` spawns the real binary and is
 * what proves the stream contract; this one covers the branches — a code
 * rejected before the socket opens, a prompt answered four different ways, a
 * repository file that already names somebody else's project — that a
 * subprocess test would pay a process launch each to reach.
 *
 * Both prompts are exercised through the input descriptor rather than through a
 * stub of the asking. That is the whole reason the descriptor exists: the case
 * that matters most is the one where nobody answers, and a `confirm` seam would
 * have replaced exactly the code that decides what silence means.
 *
 * Two things are asserted throughout rather than once. Nothing operational ever
 * appears on stdout, and no request is made before an argument the client can
 * judge for itself has been judged.
 *
 * @module
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Transport, TransportRequest, TransportResponse } from '@agentchat/client';
import { InMemoryCredentialStore } from '@agentchat/client';
import {
  AgentId,
  ErrorCode,
  errorEnvelope,
  InviteId,
  ProjectId,
  UserId,
} from '@agentchat/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { captureRun } from '../testing.js';
import type { ProjectOverrides } from './project.js';
import {
  createProjectCommand,
  parseProjectReference,
  requireInviteCode,
  requireProjectName,
  requireProjectSlug,
} from './project.js';

const SERVER = 'https://chat.example.test';
const CODE = 'ANET-7K4M-Q2P9';

const LIST_PROJECTS = 'GET /projects';
const CREATE_PROJECT = 'POST /projects';
const LIST_AGENTS = 'GET /agents';
const PREVIEW_INVITE = `GET /invites/${CODE}`;
const JOIN_INVITE = `POST /invites/${CODE}/join`;

const USER = UserId.generate();
const PROJECT = ProjectId.generate();
const OTHER_PROJECT = ProjectId.generate();
const INVITE = InviteId.generate();
const BACKEND = AgentId.generate();
const SOMEBODY_ELSES = AgentId.generate();

/** The project the fixtures act in, as `GET /projects` reports it. */
const MEMBERSHIP = {
  id: PROJECT,
  slug: 'payments',
  name: 'Payments Platform',
  createdBy: USER,
  createdAt: '2026-01-01T00:00:00.000Z',
  role: 'member',
};

/** A second project, for the cases that need two. */
const OTHER_MEMBERSHIP = {
  ...MEMBERSHIP,
  id: OTHER_PROJECT,
  slug: 'billing',
  name: 'Billing',
  role: 'owner',
};

/**
 * An agent, in the shape `AgentSchema` parses.
 *
 * @param id - The agent's id.
 * @param name - The agent's name.
 * @param userId - The owner. Defaults to the caller.
 * @returns The wire representation.
 */
function agent(id: string, name: string, userId: string = USER): Record<string, unknown> {
  return {
    id,
    userId,
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
 * @param userId - The owner. Defaults to the caller.
 * @returns The wire representation.
 */
function projectAgent(id: string, name: string, userId: string = USER): Record<string, unknown> {
  return {
    agent: agent(id, name, userId),
    owner: { id: userId, username: 'alice', displayName: 'Alice Example' },
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

/**
 * A stub that answers the project listing every fixture needs.
 *
 * @param memberships - The projects the caller is in.
 * @returns The stub.
 */
function stubWithProjects(...memberships: readonly Record<string, unknown>[]): StubServer {
  return new StubServer().on(LIST_PROJECTS, { status: 200, body: { items: memberships } });
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

const temporaries: string[] = [];

/**
 * A throwaway directory.
 *
 * @returns Its absolute path.
 */
async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agentchat-project-'));
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

/** How to run one subcommand. */
interface RunSetup {
  /** Extra environment, merged over the defaults. */
  readonly env?: Readonly<Record<string, string | undefined>>;

  /** What standard input produces. Defaults to a closed descriptor. */
  readonly stdin?: string;

  /** The working directory. Defaults to a fresh one. */
  readonly cwd?: string;

  /** A configuration directory to reuse. */
  readonly home?: string;
}

/**
 * Runs one `project` subcommand through the whole framework.
 *
 * The project is named through `AGENTCHAT_PROJECT` unless the caller overrides
 * it, so no fixture has to exist on disk for resolution to succeed.
 *
 * @param argv - The arguments after `project`.
 * @param overrides - The seams to run against.
 * @param setup - Environment, input, and directories.
 * @returns Both streams, the exit code, and the directories that were used.
 */
async function runProject(
  argv: readonly string[],
  overrides: ProjectOverrides,
  setup: RunSetup = {},
): Promise<Outcome> {
  const home = setup.home ?? (await temporaryDirectory());
  const cwd = setup.cwd ?? (await temporaryDirectory());
  const run = await captureRun(['project', ...argv, '--server', SERVER], {
    commands: [createProjectCommand(overrides)],
    env: { XDG_CONFIG_HOME: home, AGENTCHAT_PROJECT: PROJECT, ...setup.env },
    cwd,
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
 * The user configuration written under a fake configuration home.
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

describe('argument validation', () => {
  it('accepts the project references `--project` accepts, and nothing else', () => {
    expect(parseProjectReference('payments')).toEqual({ slug: 'payments' });
    expect(parseProjectReference(` ${PROJECT} `)).toEqual({ id: PROJECT });
    for (const bad of ['Payments', '-leading', 'has space', 'under_score', '']) {
      expect(() => parseProjectReference(bad)).toThrow(/neither a project id/);
    }
  });

  it('quotes the schema’s own explanation for a bad name, slug, or code', () => {
    expect(requireProjectName('Payments Platform')).toBe('Payments Platform');
    expect(() => requireProjectName('')).toThrow(/not a valid project name/);
    expect(() => requireProjectName('x'.repeat(101))).toThrow(/not a valid project name/);

    expect(requireProjectSlug('code-review-2')).toBe('code-review-2');
    expect(() => requireProjectSlug('Payments')).toThrow(/not a valid project slug/);

    expect(requireInviteCode(` ${CODE} `)).toBe(CODE);
    expect(() => requireInviteCode('has space')).toThrow(/not a valid invite code/);
  });
});

describe('project list', () => {
  it('lists the caller’s projects and marks the one this directory resolves to', async () => {
    const stub = stubWithProjects(MEMBERSHIP, OTHER_MEMBERSHIP);

    const run = await runProject(['list'], { store: signedIn(), transport: stub });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('payments');
    expect(run.stdout).toContain('(this directory)');
    expect(run.stdout).toContain('billing');
    // The marker is on `payments`, which is what AGENTCHAT_PROJECT named.
    expect(run.stdout.split('billing')[1]).not.toContain('(this directory)');
    expect(run.stderr).toBe('');
  });

  it('carries the ids in --json even though the table leaves them out', async () => {
    const stub = stubWithProjects(MEMBERSHIP, OTHER_MEMBERSHIP);

    const run = await runProject(['list', '--json'], { store: signedIn(), transport: stub });

    expect(JSON.parse(run.stdout)).toEqual({
      items: [
        {
          id: PROJECT,
          slug: 'payments',
          name: 'Payments Platform',
          createdAt: MEMBERSHIP.createdAt,
          role: 'member',
          isCurrent: true,
        },
        {
          id: OTHER_PROJECT,
          slug: 'billing',
          name: 'Billing',
          createdAt: MEMBERSHIP.createdAt,
          role: 'owner',
          isCurrent: false,
        },
      ],
    });
  });

  it('works outside a project, and says how to link the directory', async () => {
    const stub = stubWithProjects(MEMBERSHIP);

    const run = await runProject(
      ['list'],
      { store: signedIn(), transport: stub },
      {
        env: { AGENTCHAT_PROJECT: undefined },
      },
    );

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('project init');
    expect(run.stdout).not.toContain('(this directory)');
  });

  it('says what to do when there are no projects at all', async () => {
    const run = await runProject(
      ['list'],
      { store: signedIn(), transport: stubWithProjects() },
      { env: { AGENTCHAT_PROJECT: undefined } },
    );

    expect(run.stdout).toContain('You are in no projects.');
    expect(run.stdout).toContain('project create');
    expect(run.stdout).toContain('project join');
  });
});

describe('project create', () => {
  it('sends the name and reports the slug the server derived', async () => {
    const stub = new StubServer().on(CREATE_PROJECT, { status: 201, body: MEMBERSHIP });

    const run = await runProject(['create', 'Payments Platform'], {
      store: signedIn(),
      transport: stub,
    });

    expect(run.code).toBe(0);
    expect(stub.bodyOf(CREATE_PROJECT)).toEqual({ name: 'Payments Platform' });
    expect(run.stdout).toContain('payments');
    expect(run.stdout).toContain('project init payments');
  });

  it('passes an explicit --slug through rather than deriving one', async () => {
    const stub = new StubServer().on(CREATE_PROJECT, { status: 201, body: MEMBERSHIP });

    await runProject(['create', 'Payments Platform', '--slug', 'payments'], {
      store: signedIn(),
      transport: stub,
    });

    expect(stub.bodyOf(CREATE_PROJECT)).toEqual({ name: 'Payments Platform', slug: 'payments' });
  });

  it('rejects a slug that cannot be one before opening a socket', async () => {
    const stub = new StubServer();

    const run = await runProject(['create', 'Payments', '--slug', 'Payments'], {
      store: signedIn(),
      transport: stub,
    });

    expect(run.code).toBe(2);
    expect(stub.calls).toHaveLength(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('not a valid project slug');
  });

  it('reports a slug collision as the conflict it is', async () => {
    const stub = new StubServer().on(CREATE_PROJECT, {
      status: 409,
      body: errorEnvelope(ErrorCode.CONFLICT, 'The slug "payments" is already in use.'),
    });

    const run = await runProject(['create', 'Payments', '--slug', 'payments'], {
      store: signedIn(),
      transport: stub,
    });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('already in use');
    expect(run.stdout).toBe('');
  });
});

describe('project invite', () => {
  const MINTED = {
    id: INVITE,
    code: CODE,
    expiresAt: '2026-01-08T00:00:00.000Z',
  };

  /**
   * A stub whose project can be invited into.
   *
   * @param body - What `POST /projects/:id/invites` answers. Defaults to a
   *   server that discloses the identifier, which every current one does.
   * @returns The stub.
   */
  function invitable(body: Record<string, unknown> = MINTED): StubServer {
    return stubWithProjects(MEMBERSHIP).on(`POST /projects/${PROJECT}/invites`, {
      status: 201,
      body,
    });
  }

  it('puts the code on stdout and the advice around it', async () => {
    const run = await runProject(['invite'], { store: signedIn(), transport: invitable() });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(CODE);
    expect(run.stdout).toContain('2026-01-08T00:00:00.000Z');
    expect(run.stderr).toBe('');
  });

  // The create response is the only place an identifier is ever disclosed
  // (protocol §6), so a rendering that drops it makes `project revoke-invite`
  // unreachable for that invite forever.
  it('discloses the identifier, and how to revoke with it', async () => {
    const run = await runProject(['invite'], { store: signedIn(), transport: invitable() });

    expect(run.stdout).toContain(INVITE);
    expect(run.stdout).toContain(`project revoke-invite ${INVITE}`);
    expect(run.stdout).toContain('nowhere else');
  });

  it('says the code is a bearer credential until it expires or is revoked', async () => {
    const run = await runProject(['invite'], { store: signedIn(), transport: invitable() });

    expect(run.stdout).toContain('Anyone holding this code can join');
    expect(run.stdout).toContain('until it expires or is revoked');
  });

  it('turns a slug from --project into an id before asking', async () => {
    const run = await runProject(
      ['invite', '--project', 'payments', '--json'],
      { store: signedIn(), transport: invitable() },
      { env: { AGENTCHAT_PROJECT: undefined } },
    );

    expect(JSON.parse(run.stdout)).toEqual({
      id: INVITE,
      code: CODE,
      expiresAt: '2026-01-08T00:00:00.000Z',
      project: { id: PROJECT, slug: 'payments' },
    });
  });

  // `id` is optional in `CreateInviteResponseSchema` precisely so a client can
  // talk to a server older than the revoke route. Such a server must not make
  // this command fail, and must not leave it advertising a revocation the
  // caller has no argument for.
  it('still works against a server that discloses no identifier', async () => {
    const stub = invitable({ code: CODE, expiresAt: '2026-01-08T00:00:00.000Z' });

    const human = await runProject(['invite'], { store: signedIn(), transport: stub });
    const json = await runProject(['invite', '--json'], { store: signedIn(), transport: stub });

    expect(human.code).toBe(0);
    expect(human.stdout).toContain(CODE);
    expect(human.stdout).toContain('cannot be revoked from the command line');
    expect(human.stdout).not.toContain('revoke-invite');
    // Named through `AGENTCHAT_PROJECT`, which carries an id and no slug.
    expect(JSON.parse(json.stdout)).toEqual({
      code: CODE,
      expiresAt: '2026-01-08T00:00:00.000Z',
      project: { id: PROJECT, slug: null },
    });
  });

  it('fails when the caller is not in the project the slug names', async () => {
    const run = await runProject(
      ['invite', '--project', 'billing'],
      { store: signedIn(), transport: stubWithProjects(MEMBERSHIP) },
      { env: { AGENTCHAT_PROJECT: undefined } },
    );

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('not in a project with the slug `billing`');
  });
});

describe('project join', () => {
  const PREVIEW = {
    project: {
      id: PROJECT,
      slug: 'payments',
      name: 'Payments Platform',
      createdBy: USER,
      createdAt: MEMBERSHIP.createdAt,
    },
    invitedBy: { id: USER, username: 'alice', displayName: 'Alice Example' },
  };

  /**
   * A stub that previews and then joins.
   *
   * @returns The stub.
   */
  function joinable(): StubServer {
    return new StubServer()
      .on(PREVIEW_INVITE, { status: 200, body: PREVIEW })
      .on(JOIN_INVITE, { status: 200, body: { project: MEMBERSHIP } });
  }

  it('shows the project and the inviter on stderr, and joins when answered yes', async () => {
    const stub = joinable();

    const run = await runProject(
      ['join', CODE],
      { store: signedIn(), transport: stub },
      { stdin: 'y\n' },
    );

    expect(run.code).toBe(0);
    // PRD §27: the preview and the question are what a person reads, so they
    // are on stderr; the joined project is the result, so it is on stdout.
    expect(run.stderr).toContain('Project: Payments Platform (payments)');
    expect(run.stderr).toContain('Invited by: Alice Example (@alice)');
    expect(run.stderr).toContain('Join Payments Platform? [Y/n]');
    expect(run.stdout).toContain('Joined Payments Platform.');
    expect(run.stdout).not.toContain('Invited by');
    expect(stub.countOf(JOIN_INVITE)).toBe(1);
  });

  it('treats a bare Return as yes, because the prompt says [Y/n]', async () => {
    const stub = joinable();

    const run = await runProject(
      ['join', CODE],
      { store: signedIn(), transport: stub },
      { stdin: '\n' },
    );

    expect(run.code).toBe(0);
    expect(stub.countOf(JOIN_INVITE)).toBe(1);
  });

  it('does not join when answered no, and is still a success', async () => {
    const stub = joinable();

    const run = await runProject(
      ['join', CODE],
      { store: signedIn(), transport: stub },
      { stdin: 'n\n' },
    );

    // Declining is not a failure: nothing went wrong.
    expect(run.code).toBe(0);
    expect(stub.countOf(JOIN_INVITE)).toBe(0);
    expect(run.stderr).toContain('Cancelled. You did not join Payments Platform.');
    expect(run.stdout).toBe('');
  });

  it('does not join when nobody is there, even though the default is yes', async () => {
    const stub = joinable();

    // A closed descriptor: `< /dev/null`, or a CI runner with no terminal. The
    // visible default is `Y`, but a default is for a person choosing not to
    // type, not for an absent one.
    const run = await runProject(['join', CODE], { store: signedIn(), transport: stub });

    expect(run.code).toBe(0);
    expect(stub.countOf(JOIN_INVITE)).toBe(0);
    expect(run.stderr).toContain('Cancelled.');
  });

  it('refuses --json without --yes, before any request', async () => {
    const stub = joinable();

    const run = await runProject(['join', CODE, '--json'], {
      store: signedIn(),
      transport: stub,
    });

    expect(run.code).toBe(2);
    expect(stub.calls).toHaveLength(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      error: { code: 'BAD_REQUEST', hint: expect.stringContaining('--yes') },
    });
  });

  it('joins without previewing when --yes has already decided', async () => {
    const stub = joinable();

    const run = await runProject(['join', CODE, '--yes', '--json'], {
      store: signedIn(),
      transport: stub,
    });

    expect(run.code).toBe(0);
    // The preview exists to be shown to somebody. With `--yes` there is nobody
    // to show it to, so the round trip is not made.
    expect(stub.countOf(PREVIEW_INVITE)).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ joined: true, project: { slug: 'payments' } });
  });

  it('rejects a malformed code before opening a socket', async () => {
    const stub = joinable();

    const run = await runProject(['join', 'not a code'], {
      store: signedIn(),
      transport: stub,
    });

    expect(run.code).toBe(2);
    expect(stub.calls).toHaveLength(0);
  });

  it('reports an unusable code as one failure, whatever is wrong with it', async () => {
    const stub = new StubServer().on(PREVIEW_INVITE, {
      status: 404,
      body: errorEnvelope(ErrorCode.INVITE_INVALID, 'That invite code does not work.'),
    });

    const run = await runProject(
      ['join', CODE],
      { store: signedIn(), transport: stub },
      { stdin: 'y\n' },
    );

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('does not work');
    expect(run.stdout).toBe('');
  });
});

describe('project leave', () => {
  /**
   * A stub that can answer everything leaving needs.
   *
   * @param mine - The caller's agents in the project.
   * @returns The stub.
   */
  function leavable(...mine: readonly string[]): StubServer {
    return stubWithProjects(MEMBERSHIP)
      .on(LIST_AGENTS, {
        status: 200,
        body: { items: mine.map((name) => agent(BACKEND, name)) },
      })
      .on(`GET /projects/${PROJECT}/agents`, {
        status: 200,
        body: {
          items: [
            ...mine.map((name) => projectAgent(BACKEND, name)),
            projectAgent(SOMEBODY_ELSES, 'theirs', UserId.generate()),
          ],
        },
      })
      .on(`POST /projects/${PROJECT}/leave`, { status: 200, body: {} });
  }

  /**
   * Runs `project leave` against a project named by slug.
   *
   * The slug rather than the id, because that is what a repository
   * configuration records and what the prompt has to be able to name back.
   *
   * @param argv - The arguments after `leave`.
   * @param stub - The server to answer from.
   * @param setup - Input and directories.
   * @returns Both streams and the exit code.
   */
  async function runLeave(
    argv: readonly string[],
    stub: StubServer,
    setup: RunSetup = {},
  ): Promise<Outcome> {
    return await runProject(
      ['leave', ...argv],
      { store: signedIn(), transport: stub },
      {
        ...setup,
        env: { AGENTCHAT_PROJECT: 'payments', ...setup.env },
      },
    );
  }

  it('names the agents that leave with you before asking', async () => {
    const stub = leavable('backend');

    const run = await runLeave([], stub, { stdin: 'y\n' });

    expect(run.code).toBe(0);
    expect(run.stderr).toContain('Leaving also removes this agent of yours');
    expect(run.stderr).toContain('backend');
    // Somebody else's agent in the same project is not ours to warn about.
    expect(run.stderr).not.toContain('theirs');
    expect(run.stderr).toContain('Leave payments? [y/N]');
    expect(run.stdout).toContain('Left payments.');
  });

  it('says so plainly when you have no agents in the project', async () => {
    const stub = leavable();

    const run = await runLeave([], stub, { stdin: 'y\n' });

    expect(run.stderr).toContain('You have no agents in this project');
    expect(run.code).toBe(0);
  });

  it('defaults to no, because leaving is not what a stray Return should do', async () => {
    const stub = leavable('backend');

    const run = await runLeave([], stub, { stdin: '\n' });

    expect(run.code).toBe(0);
    expect(stub.countOf(`POST /projects/${PROJECT}/leave`)).toBe(0);
    expect(run.stderr).toContain('Cancelled. You are still in payments.');
    expect(run.stdout).toBe('');
  });

  it('forgets the default agent for the project it just left', async () => {
    const home = await temporaryDirectory();
    await writeUserFixture(home, {
      serverUrl: SERVER,
      defaultAgentByProject: { [PROJECT]: BACKEND, [OTHER_PROJECT]: BACKEND },
    });

    const run = await runLeave(['--yes', '--json'], leavable('backend'), { home });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      left: { id: PROJECT, slug: 'payments' },
      agentsRemoved: ['backend'],
      clearedDefaultAgent: true,
    });
    // The default for the project that was *not* left is untouched.
    expect(await userConfig(home)).toMatchObject({
      defaultAgentByProject: { [OTHER_PROJECT]: BACKEND },
    });
  });

  it('reports agentsRemoved as null when the lookup could not answer', async () => {
    // `GET /agents` is unstubbed, so discovery fails. Leaving still works: this
    // lookup exists to make a warning specific, not to gate the command.
    const stub = stubWithProjects(MEMBERSHIP).on(`POST /projects/${PROJECT}/leave`, {
      status: 200,
      body: {},
    });

    const run = await runLeave(['--yes', '--json'], stub);

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ agentsRemoved: null });
  });

  it('falls back to the general warning when the agents cannot be named', async () => {
    const stub = stubWithProjects(MEMBERSHIP).on(`POST /projects/${PROJECT}/leave`, {
      status: 200,
      body: {},
    });

    const run = await runLeave([], stub, { stdin: 'y\n' });

    expect(run.stderr).toContain('could not be determined');
    expect(run.code).toBe(0);
  });

  it('refuses --json without --yes, before any request', async () => {
    const stub = leavable('backend');

    const run = await runLeave(['--json'], stub);

    expect(run.code).toBe(2);
    expect(stub.calls).toHaveLength(0);
  });

  it('passes the last-owner refusal through as the server phrased it', async () => {
    const stub = leavable('backend').on(`POST /projects/${PROJECT}/leave`, {
      status: 409,
      body: errorEnvelope(
        ErrorCode.CONFLICT,
        'You are the only owner of this project. Make another member an owner before you leave.',
      ),
    });

    const run = await runLeave(['--yes'], stub);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('only owner of this project');
    expect(run.stdout).toBe('');
  });
});

describe('project init', () => {
  it('writes the project identity, and nothing else, into the working directory', async () => {
    const cwd = await temporaryDirectory();

    const run = await runProject(
      ['init', 'payments'],
      { store: signedIn(), transport: stubWithProjects(MEMBERSHIP) },
      { cwd, env: { AGENTCHAT_PROJECT: undefined } },
    );

    expect(run.code).toBe(0);
    // Exactly two keys. This file is committed; anything else in it is either a
    // secret in the repository history or a personal choice imposed on the team.
    expect(await repositoryConfig(cwd)).toEqual({
      projectId: PROJECT,
      projectSlug: 'payments',
    });
    expect(run.stdout).toContain('Linked this directory to Payments Platform.');
  });

  it('accepts an id, and records the slug it looked up alongside it', async () => {
    const cwd = await temporaryDirectory();
    const stub = new StubServer().on(`GET /projects/${PROJECT}`, {
      status: 200,
      body: MEMBERSHIP,
    });

    await runProject(
      ['init', PROJECT],
      { store: signedIn(), transport: stub },
      { cwd, env: { AGENTCHAT_PROJECT: undefined } },
    );

    expect(await repositoryConfig(cwd)).toEqual({
      projectId: PROJECT,
      projectSlug: 'payments',
    });
  });

  it('is idempotent when the file already names the same project', async () => {
    const cwd = await temporaryDirectory();
    await writeRepositoryFixture(cwd, { projectId: PROJECT, projectSlug: 'payments' });

    const run = await runProject(
      ['init', 'payments', '--json'],
      { store: signedIn(), transport: stubWithProjects(MEMBERSHIP) },
      { cwd, env: { AGENTCHAT_PROJECT: undefined } },
    );

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ alreadyLinked: true });
  });

  it('will not repoint a directory at a different project without --force', async () => {
    const cwd = await temporaryDirectory();
    await writeRepositoryFixture(cwd, { projectId: OTHER_PROJECT, projectSlug: 'billing' });

    const run = await runProject(
      ['init', 'payments'],
      { store: signedIn(), transport: stubWithProjects(MEMBERSHIP) },
      { cwd, env: { AGENTCHAT_PROJECT: undefined } },
    );

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('--force');
    expect(await repositoryConfig(cwd)).toMatchObject({ projectId: OTHER_PROJECT });
  });

  it('repoints it when --force says so', async () => {
    const cwd = await temporaryDirectory();
    await writeRepositoryFixture(cwd, { projectId: OTHER_PROJECT, projectSlug: 'billing' });

    const run = await runProject(
      ['init', 'payments', '--force'],
      { store: signedIn(), transport: stubWithProjects(MEMBERSHIP) },
      { cwd, env: { AGENTCHAT_PROJECT: undefined } },
    );

    expect(run.code).toBe(0);
    expect(await repositoryConfig(cwd)).toMatchObject({ projectId: PROJECT });
  });

  it('replaces a file it cannot read only when --force says so', async () => {
    const cwd = await temporaryDirectory();
    await writeRepositoryFixture(cwd, { projectId: PROJECT, apiToken: 'a'.repeat(48) });

    const refused = await runProject(
      ['init', 'payments'],
      { store: signedIn(), transport: stubWithProjects(MEMBERSHIP) },
      { cwd, env: { AGENTCHAT_PROJECT: undefined } },
    );

    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('--force');

    const forced = await runProject(
      ['init', 'payments', '--force'],
      { store: signedIn(), transport: stubWithProjects(MEMBERSHIP) },
      { cwd, env: { AGENTCHAT_PROJECT: undefined } },
    );

    expect(forced.code).toBe(0);
    expect(await repositoryConfig(cwd)).toEqual({
      projectId: PROJECT,
      projectSlug: 'payments',
    });
  });

  it('warns that the file it writes shadows one in a parent directory', async () => {
    const parent = await temporaryDirectory();
    const cwd = join(parent, 'nested');
    await mkdir(cwd, { recursive: true });
    await writeRepositoryFixture(parent, { projectId: OTHER_PROJECT, projectSlug: 'billing' });

    const run = await runProject(
      ['init', 'payments'],
      { store: signedIn(), transport: stubWithProjects(MEMBERSHIP) },
      { cwd, env: { AGENTCHAT_PROJECT: undefined } },
    );

    expect(run.code).toBe(0);
    expect(run.stderr).toContain('takes precedence');
    expect(await repositoryConfig(cwd)).toMatchObject({ projectId: PROJECT });
    expect(await repositoryConfig(parent)).toMatchObject({ projectId: OTHER_PROJECT });
  });

  it('writes nothing when the caller is not in the project', async () => {
    const cwd = await temporaryDirectory();

    const run = await runProject(
      ['init', 'billing'],
      { store: signedIn(), transport: stubWithProjects(MEMBERSHIP) },
      { cwd, env: { AGENTCHAT_PROJECT: undefined } },
    );

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('not in a project with the slug `billing`');
    expect(await repositoryConfig(cwd)).toBeNull();
  });

  it('rejects a reference that is neither an id nor a slug, before any request', async () => {
    const stub = stubWithProjects(MEMBERSHIP);

    const run = await runProject(
      ['init', 'Payments Platform'],
      { store: signedIn(), transport: stub },
      { env: { AGENTCHAT_PROJECT: undefined } },
    );

    expect(run.code).toBe(2);
    expect(stub.calls).toHaveLength(0);
  });
});

describe('project current', () => {
  it('reports the repository configuration, and the file it came from', async () => {
    const cwd = await temporaryDirectory();
    await writeRepositoryFixture(cwd, { projectId: PROJECT, projectSlug: 'payments' });

    const run = await runProject(
      ['current', '--json'],
      {},
      { cwd, env: { AGENTCHAT_PROJECT: undefined } },
    );

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      project: {
        id: PROJECT,
        slug: 'payments',
        source: 'repository',
        origin: join(cwd, '.agentchat', 'config.json'),
        configPath: join(cwd, '.agentchat', 'config.json'),
      },
    });
  });

  it('says which rule answered when it was not the file', async () => {
    const fromFlag = await runProject(['current', '--project', 'payments'], {});
    expect(fromFlag.stdout).toContain('the `--project` flag');

    const fromEnvironment = await runProject(['current'], {});
    expect(fromEnvironment.stdout).toContain('AGENTCHAT_PROJECT');
  });

  it('answers without a server configured at all, because it reaches none', async () => {
    const cwd = await temporaryDirectory();
    await writeRepositoryFixture(cwd, { projectId: PROJECT, projectSlug: 'payments' });

    // No `--server`, and no user configuration naming one. `status` is what
    // someone runs when things are broken; `current` is the smaller question
    // and must answer it offline too.
    const run = await captureRun(['project', 'current'], {
      commands: [createProjectCommand()],
      env: { XDG_CONFIG_HOME: await temporaryDirectory() },
      cwd,
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('payments');
  });

  it('fails with the code a harness reads as “write a configuration”', async () => {
    const run = await runProject(
      ['current'],
      {},
      { cwd: await temporaryDirectory(), env: { AGENTCHAT_PROJECT: undefined } },
    );

    expect(run.code).toBe(4);
    expect(run.stderr).toContain('project init');
    expect(run.stdout).toBe('');
  });
});
