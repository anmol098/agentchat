/**
 * `agentchat status`, spawned.
 *
 * These are the acceptance tests for T-209, and like the rest of this
 * directory they start a real process and read file descriptor 1 and file
 * descriptor 2 **separately** (`./spawn.ts`). That matters more here than
 * anywhere else: this command logs progress while it probes the server, and
 * one of those lines landing on stdout would corrupt the JSON a harness is
 * parsing (PRD §39). Only two independent descriptors can prove it did not.
 *
 * The three states the command exists for each get their own block: healthy,
 * logged out, and no project configured. Each asserts the same three things —
 * exit 0, a parseable result on stdout, operational chatter on stderr and
 * nowhere else.
 *
 * Every run gets its own `HOME` and its own working directory, so nothing here
 * can read the developer's real credentials or their real repository
 * configuration, and a failure cannot be caused by one.
 *
 * @module
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@agentchat/protocol';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Run } from './spawn.js';
import { ANSI, buildPackage, parseNdjson, runCli } from './spawn.js';

/** A canonical project id, so the repository configuration parses. */
const PROJECT_ID = 'prj_0199a1b2-c3d4-7e5f-8071-8293a4b5c6d7';

/** The caller's user id, as `GET /me` and the discovery rows both report it. */
const USER_ID = 'usr_0199a1b2-c3d4-7e5f-8071-8293a4b5c6d8';

/** The caller's one agent in the project. */
const AGENT_ID = 'agt_0199a1b2-c3d4-7e5f-8071-8293a4b5c6d9';

/** Somebody else's agent in the same project, to prove the shortcut filters. */
const OTHER_AGENT_ID = 'agt_0199a1b2-c3d4-7e5f-8071-8293a4b5c6da';

/** Another member, who owns {@link OTHER_AGENT_ID}. */
const OTHER_USER_ID = 'usr_0199a1b2-c3d4-7e5f-8071-8293a4b5c6db';

/** An instant far enough ahead that the report never calls it expired. */
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

/**
 * An access token shaped like the one the server mints: three base64url
 * segments whose middle one carries an `exp`.
 *
 * Not signed, and it does not have to be — nothing in this suite verifies it,
 * and the stub server accepts any bearer token. What it exercises is the
 * report's ability to say *when the login goes stale* without a round trip,
 * which is a claim about parsing and not about cryptography.
 *
 * @param exp - The expiry, in seconds since the epoch.
 * @returns A token with that expiry in its payload.
 */
function tokenExpiring(exp: number): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: USER_ID, exp })}.signature`;
}

/** One stubbed HTTP answer. */
interface Reply {
  /** The status code to send. */
  readonly status: number;

  /** The JSON body to send. */
  readonly body: unknown;
}

/** The routes the stub server answers, keyed by `METHOD /path`. */
type Routes = Readonly<Record<string, Reply>>;

/** The session `GET /sessions` lists when the caller has one running. */
const SESSION = {
  id: 'ses_0199a1b2-c3d4-7e5f-8071-8293a4b5c6dc',
  agentId: AGENT_ID,
  projectId: PROJECT_ID,
  machineName: 'alice-laptop',
  runtime: 'claude-code',
  workingDirectory: '/work/repo',
  startedAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-01-01T00:00:30.000Z',
  endedAt: null,
  status: 'active',
};

/**
 * A healthy server: every route answers, and the caller has one agent here.
 *
 * @param sessions - How many active listeners that agent has. The discovery
 *   count and the diagnostics listing are the same fact (plan §2), so a stub
 *   that let them disagree would be testing a server that cannot exist.
 * @returns The stubbed routes.
 */
function healthyRoutes(sessions: number): Routes {
  return {
    'GET /sessions': {
      status: 200,
      body: { items: Array.from({ length: sessions }, () => SESSION) },
    },
    'GET /version': {
      status: 200,
      body: { version: '9.9.9', protocolVersion: PROTOCOL_VERSION, minClientVersion: '0.1.0' },
    },
    'GET /me': {
      status: 200,
      body: {
        id: USER_ID,
        username: 'alice',
        displayName: 'Alice Liddell',
        email: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    },
    'GET /projects': {
      status: 200,
      body: {
        items: [
          {
            id: PROJECT_ID,
            slug: 'payments',
            name: 'Payments',
            createdBy: USER_ID,
            createdAt: '2026-01-01T00:00:00.000Z',
            role: 'owner',
          },
        ],
      },
    },
    [`GET /projects/${PROJECT_ID}/agents`]: {
      status: 200,
      body: {
        items: [
          {
            agent: {
              id: AGENT_ID,
              userId: USER_ID,
              name: 'backend',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
            owner: { id: USER_ID, username: 'alice', displayName: 'Alice Liddell' },
            online: sessions > 0,
            sessions,
          },
          {
            agent: {
              id: OTHER_AGENT_ID,
              userId: OTHER_USER_ID,
              name: 'frontend',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
            owner: { id: OTHER_USER_ID, username: 'bob', displayName: 'Bob Robertson' },
            online: true,
            sessions: 2,
          },
        ],
      },
    },
  };
}

let server: Server;
let baseUrl: string;
let routes: Routes = {};

/** The temporary root every fixture directory is made under. */
let root: string;

beforeAll(async () => {
  await buildPackage();

  root = mkdtempSync(join(tmpdir(), 'agentchat-status-'));

  server = createServer((request, response) => {
    const key = `${request.method ?? 'GET'} ${(request.url ?? '/').split('?')[0] ?? '/'}`;
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
});

/** How to lay out one fixture: what is on disk before the command runs. */
interface Fixture {
  /** Write a repository configuration naming this project. */
  readonly project?: boolean;

  /** Write a credentials file holding a token with this expiry. */
  readonly tokenExpiry?: number;

  /** Write a user configuration recording this default agent for the project. */
  readonly defaultAgent?: string;

  /** Write a user configuration naming this server. */
  readonly serverUrl?: string;
}

/** A prepared fixture: a home directory and a working directory inside it. */
interface Prepared {
  /** The fake `HOME`. */
  readonly home: string;

  /** Where the command runs, two levels below the repository root. */
  readonly cwd: string;
}

/**
 * Builds one throwaway home and working directory.
 *
 * The working directory is deliberately nested below the one holding
 * `.agentchat/`, so a passing project check proves the upward walk ran rather
 * than that the file happened to be underfoot.
 *
 * @param fixture - What to write.
 * @returns The paths to run against.
 */
function prepare(fixture: Fixture): Prepared {
  const base = mkdtempSync(join(root, 'case-'));
  const home = join(base, 'home');
  const repository = join(base, 'repository');
  const cwd = join(repository, 'services', 'api');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  if (fixture.project === true) {
    mkdirSync(join(repository, '.agentchat'), { recursive: true });
    writeFileSync(
      join(repository, '.agentchat', 'config.json'),
      `${JSON.stringify({ projectId: PROJECT_ID, projectSlug: 'payments' }, null, 2)}\n`,
    );
  }

  const configDirectory = join(home, '.config', 'agentchat');
  if (fixture.tokenExpiry !== undefined) {
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(configDirectory, 'credentials.json'),
      `${JSON.stringify(
        {
          version: 1,
          accessToken: tokenExpiring(fixture.tokenExpiry),
          refreshToken: 'refresh-token-for-the-fixture',
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }

  if (fixture.defaultAgent !== undefined || fixture.serverUrl !== undefined) {
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(configDirectory, 'config.json'),
      `${JSON.stringify(
        {
          ...(fixture.serverUrl === undefined ? {} : { serverUrl: fixture.serverUrl }),
          defaultAgentByProject:
            fixture.defaultAgent === undefined ? {} : { [PROJECT_ID]: fixture.defaultAgent },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }

  return { home, cwd };
}

/**
 * Runs `agentchat status` against a fixture.
 *
 * @param fixture - What is on disk.
 * @param argv - Arguments after `status`.
 * @param env - Extra environment for the child.
 * @returns Both streams and the exit code.
 */
async function status(
  fixture: Fixture,
  argv: readonly string[] = [],
  env: Readonly<Record<string, string>> = {},
): Promise<Run> {
  const prepared = prepare(fixture);
  return await runCli(['status', ...argv], {
    cwd: prepared.cwd,
    env: { HOME: prepared.home, ...env },
  });
}

/**
 * The one `--json` document on stdout.
 *
 * @param run - What the process produced.
 * @returns The parsed report.
 */
function report(run: Run): Record<string, unknown> {
  const lines = parseNdjson(run.stdout);
  expect(lines).toHaveLength(1);
  return lines[0] as Record<string, unknown>;
}

describe('healthy: everything resolves and the server answers', () => {
  it('reports every check, exits 0, and keeps stdout to one JSON document', async () => {
    routes = healthyRoutes(1);

    const run = await status(
      { project: true, tokenExpiry: FUTURE, defaultAgent: AGENT_ID },
      ['--json'],
      { AGENTCHAT_SERVER: baseUrl },
    );

    expect(run.code).toBe(0);
    expect(report(run)).toMatchObject({
      ok: true,
      problems: [],
      server: {
        url: baseUrl,
        source: 'environment',
        origin: 'AGENTCHAT_SERVER',
        reachable: true,
        version: '9.9.9',
        protocolVersion: PROTOCOL_VERSION,
        minClientVersion: '0.1.0',
      },
      login: {
        loggedIn: true,
        verified: true,
        hasStoredToken: true,
        accessTokenExpired: false,
        user: { id: USER_ID, username: 'alice', displayName: 'Alice Liddell' },
      },
      project: { resolved: true, id: PROJECT_ID, slug: 'payments', source: 'repository' },
      // The stored default is an id — that is how `agent use` records it — and
      // the discovery rows are what turn it back into a name a person knows.
      agent: { resolved: true, id: AGENT_ID, name: 'backend', source: 'user-config' },
      sessions: { checked: true, count: 1, online: true },
    });

    // The probe said what it was doing, on the other descriptor.
    expect(run.stderr).toContain('[agentchat]');
    expect(run.stderr).toContain('Asking');
  });

  it('names the repository configuration it read the project from', async () => {
    routes = healthyRoutes(1);

    const run = await status(
      { project: true, tokenExpiry: FUTURE, defaultAgent: AGENT_ID },
      ['--json'],
      { AGENTCHAT_SERVER: baseUrl },
    );

    const project = report(run)['project'] as Record<string, unknown>;
    // The whole point of reporting a source: the reader can go and look at it.
    expect(project['configPath']).toMatch(/repository\/\.agentchat\/config\.json$/);
    expect(project['origin']).toBe(project['configPath']);
    expect(project['role']).toBe('owner');
  });

  it('renders a human report with no colour on a pipe and nothing on stderr but the probe', async () => {
    routes = healthyRoutes(1);

    const run = await status({ project: true, tokenExpiry: FUTURE, defaultAgent: AGENT_ID }, [], {
      AGENTCHAT_SERVER: baseUrl,
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('No problems found.');
    expect(run.stdout).toContain('@alice');
    expect(run.stdout).toContain('payments');
    expect(run.stdout).toContain('1 active');
    expect(run.stdout).not.toMatch(ANSI);
    expect(run.stderr).not.toContain('error:');
  });

  it('takes the single-agent shortcut without counting other members agents', async () => {
    routes = healthyRoutes(0);

    // No `defaultAgent`: the only rule left is "you have exactly one agent
    // here", and the project also contains somebody else's.
    const run = await status({ project: true, tokenExpiry: FUTURE }, ['--json'], {
      AGENTCHAT_SERVER: baseUrl,
    });

    expect(run.code).toBe(0);
    expect(report(run)).toMatchObject({
      ok: true,
      agent: { resolved: true, id: AGENT_ID, name: 'backend', source: 'only-agent' },
      sessions: { checked: true, count: 0, online: false },
    });
  });
});

describe('the session detail, which is what a count could not say', () => {
  it('carries every field of every listener in --json', async () => {
    routes = healthyRoutes(1);

    const run = await status(
      { project: true, tokenExpiry: FUTURE, defaultAgent: AGENT_ID },
      ['--json'],
      { AGENTCHAT_SERVER: baseUrl },
    );

    const sessions = report(run)['sessions'] as Record<string, unknown>;
    expect(sessions['items']).toEqual([
      {
        id: SESSION.id,
        status: 'active',
        machineName: 'alice-laptop',
        runtime: 'claude-code',
        workingDirectory: '/work/repo',
        startedAt: SESSION.startedAt,
        lastSeenAt: SESSION.lastSeenAt,
      },
    ]);
  });

  it('prints the machine, the runtime, the directory and the id a human can match', async () => {
    // T-209 named these four as the things it could not report. The session id
    // is the one that matters most: `listen` prints it on stderr, so this is
    // how somebody tells which of two terminals a row belongs to.
    routes = healthyRoutes(1);

    const run = await status({ project: true, tokenExpiry: FUTURE, defaultAgent: AGENT_ID }, [], {
      AGENTCHAT_SERVER: baseUrl,
    });

    expect(run.stdout).toContain(SESSION.id);
    expect(run.stdout).toContain('alice-laptop');
    expect(run.stdout).toContain('claude-code');
    expect(run.stdout).toContain('/work/repo');
    expect(run.stdout).toContain(SESSION.lastSeenAt);
  });

  it('distinguishes a stale listener from nothing running at all', async () => {
    // The situation the endpoint exists for: registered, and not answering.
    // The old derived count reported this as a bare zero, which reads as "start
    // a listener" when one is already running and wedged.
    routes = {
      ...healthyRoutes(0),
      'GET /sessions': { status: 200, body: { items: [{ ...SESSION, status: 'stale' }] } },
    };

    const run = await status({ project: true, tokenExpiry: FUTURE, defaultAgent: AGENT_ID }, [], {
      AGENTCHAT_SERVER: baseUrl,
    });

    expect(run.stdout).toContain('none active');
    expect(run.stdout).toContain('1 stale');
    expect(run.stdout).toContain('not answering');
    // Not the "nothing is running, start one" advice, which would be wrong here.
    expect(run.stdout).not.toContain('to receive messages here');
  });

  it('keeps a stale session out of the count, because presence is active only', async () => {
    routes = {
      ...healthyRoutes(0),
      'GET /sessions': {
        status: 200,
        body: {
          items: [
            SESSION,
            { ...SESSION, id: 'ses_0199a1b2-c3d4-7e5f-8071-8293a4b5c6dd', status: 'stale' },
          ],
        },
      },
    };

    const run = await status(
      { project: true, tokenExpiry: FUTURE, defaultAgent: AGENT_ID },
      ['--json'],
      { AGENTCHAT_SERVER: baseUrl },
    );

    const sessions = report(run)['sessions'] as Record<string, unknown>;
    expect(sessions['count']).toBe(1);
    expect(sessions['online']).toBe(true);
    // Both rows are still listed: the stale one is the interesting one.
    expect(sessions['items']).toHaveLength(2);
  });

  it('still reports when the listing itself fails, and says the detail is missing', async () => {
    // A diagnostic that gives up when a call fails is useless exactly where it
    // is needed. Everything above the session check succeeded, so the discovery
    // count is still in hand and the report degrades to it.
    routes = {
      ...healthyRoutes(1),
      'GET /sessions': {
        status: 500,
        body: { error: { code: 'INTERNAL', message: 'the listing broke' } },
      },
    };

    const run = await status(
      { project: true, tokenExpiry: FUTURE, defaultAgent: AGENT_ID },
      ['--json'],
      { AGENTCHAT_SERVER: baseUrl },
    );

    expect(run.code).toBe(0);
    const document = report(run);
    const sessions = document['sessions'] as Record<string, unknown>;

    expect(sessions['checked']).toBe(true);
    expect(sessions['count']).toBe(1);
    // `null`, not `[]`: "could not ask" and "nothing is running" are different
    // answers and a harness has to be able to tell them apart.
    expect(sessions['items']).toBeNull();
    expect(document['problems']).toContainEqual(
      expect.objectContaining({ area: 'sessions', code: 'INTERNAL' }),
    );
  });
});

describe('logged out', () => {
  it('still reports the project and the server, and still exits 0', async () => {
    routes = healthyRoutes(1);

    const run = await status({ project: true }, ['--json'], { AGENTCHAT_SERVER: baseUrl });

    expect(run.code).toBe(0);
    const document = report(run);
    expect(document).toMatchObject({
      ok: false,
      // The server check is unauthenticated, so it still passes.
      server: { reachable: true, version: '9.9.9' },
      login: { loggedIn: false, hasStoredToken: false, verified: false, user: null },
      // Resolved from the repository configuration, with no login involved.
      project: { resolved: true, id: PROJECT_ID, slug: 'payments', source: 'repository' },
      sessions: { checked: false, count: null, online: null },
    });

    const problems = document['problems'] as { area: string; code: string; hint: string }[];
    const login = problems.find((problem) => problem.area === 'login');
    expect(login?.code).toBe('AUTH_REQUIRED');
    expect(login?.hint).toContain('agentchat login');
  });

  it('says what to run, in human mode, with stdout carrying the whole report', async () => {
    routes = healthyRoutes(1);

    const run = await status({ project: true }, [], { AGENTCHAT_SERVER: baseUrl });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('not signed in');
    expect(run.stdout).toContain('agentchat login');
    expect(run.stdout).toContain('problem');
  });

  it('reports a stored token the server no longer accepts as not logged in', async () => {
    // The real sequence: the call 401s, the client spends the refresh token,
    // and the refresh is rejected too. Both halves have to be stubbed, because
    // it is the second one that makes the rejection definitive.
    routes = {
      ...healthyRoutes(1),
      'GET /me': {
        status: 401,
        body: { error: { code: 'AUTH_REQUIRED', message: 'Your session has expired.' } },
      },
      'POST /auth/refresh': {
        status: 401,
        body: { error: { code: 'AUTH_REQUIRED', message: 'That refresh token is spent.' } },
      },
    };

    const run = await status({ project: true, tokenExpiry: FUTURE }, ['--json'], {
      AGENTCHAT_SERVER: baseUrl,
    });

    expect(run.code).toBe(0);
    expect(report(run)).toMatchObject({
      ok: false,
      login: { loggedIn: false, hasStoredToken: true, verified: true, user: null },
    });
  });

  it('never puts a token on either stream', async () => {
    routes = healthyRoutes(1);
    const token = tokenExpiring(FUTURE);

    const human = await status({ project: true, tokenExpiry: FUTURE }, [], {
      AGENTCHAT_SERVER: baseUrl,
    });
    const json = await status({ project: true, tokenExpiry: FUTURE }, ['--json'], {
      AGENTCHAT_SERVER: baseUrl,
    });

    for (const run of [human, json]) {
      expect(run.stdout).not.toContain(token);
      expect(run.stdout).not.toContain('refresh-token-for-the-fixture');
      expect(run.stderr).not.toContain(token);
      expect(run.stderr).not.toContain('refresh-token-for-the-fixture');
    }
    // What it says instead: that one exists, and when it goes stale.
    expect(human.stdout).toContain('access token expires at');
    expect(report(json)['login']).toMatchObject({ accessTokenExpired: false });
  });

  it('reports an expired access token as expired without failing', async () => {
    routes = healthyRoutes(1);

    const run = await status(
      { project: true, tokenExpiry: Math.floor(Date.now() / 1000) - 60 },
      ['--json'],
      { AGENTCHAT_SERVER: baseUrl },
    );

    expect(run.code).toBe(0);
    expect(report(run)['login']).toMatchObject({ accessTokenExpired: true, verified: true });
  });
});

describe('no project configured', () => {
  it('reports every check it still can, and exits 0', async () => {
    const run = await status({}, ['--json']);

    expect(run.code).toBe(0);
    const document = report(run);
    expect(document).toMatchObject({
      ok: false,
      // Nothing was configured, so nothing was contacted: `reachable` is
      // "not asked", not "asked and failed".
      server: { url: null, source: null, reachable: null },
      login: { loggedIn: false, hasStoredToken: false },
      project: { resolved: false, id: null, slug: null, source: null },
      agent: { resolved: false },
      sessions: { checked: false },
    });

    const problems = document['problems'] as { area: string; code: string; message: string }[];
    expect(problems.map((problem) => problem.area)).toEqual([
      'server',
      'login',
      'project',
      'agent',
    ]);
    const project = problems.find((problem) => problem.area === 'project');
    expect(project?.code).toBe('NO_PROJECT');
    expect(project?.message).toContain('agentchat project init');
  });

  it('makes no network call at all when no server is configured', async () => {
    // Nothing was stubbed this run, so any request would 404 and show up as an
    // unreachable-or-erroring server. It stays `null`, which is the claim.
    const run = await status({});

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('not configured');
    expect(run.stderr).not.toContain('Asking');
  });

  it('resolves a project from --project even with nothing on disk', async () => {
    const run = await status({}, ['--project', 'payments', '--json']);

    expect(run.code).toBe(0);
    expect(report(run)['project']).toMatchObject({
      resolved: true,
      id: null,
      slug: 'payments',
      source: 'flag',
      origin: '--project',
    });
  });

  it('reports a project reference the account is not a member of', async () => {
    routes = healthyRoutes(1);

    const run = await status({ tokenExpiry: FUTURE }, ['--project', 'elsewhere', '--json'], {
      AGENTCHAT_SERVER: baseUrl,
    });

    expect(run.code).toBe(0);
    const problems = report(run)['problems'] as { area: string; code: string }[];
    expect(problems).toContainEqual(
      expect.objectContaining({ area: 'project', code: 'NOT_FOUND' }) as unknown as object,
    );
  });
});

describe('an unreachable server', () => {
  it('is reported as unreachable rather than failing the command', async () => {
    // Port 9 is `discard`, and nothing is listening on it here.
    const run = await status({ project: true }, ['--json'], {
      AGENTCHAT_SERVER: 'http://127.0.0.1:9',
    });

    expect(run.code).toBe(0);
    const document = report(run);
    expect(document).toMatchObject({
      ok: false,
      server: { url: 'http://127.0.0.1:9', reachable: false, version: null },
      // The offline promise: the project still resolves, from disk alone.
      project: { resolved: true, slug: 'payments', source: 'repository' },
    });
    const problems = document['problems'] as { area: string; message: string }[];
    expect(problems.find((problem) => problem.area === 'server')?.message).toContain(
      'could not be reached',
    );
  });

  it('reports a server URL that is not a usable HTTP URL', async () => {
    const run = await status({ project: true }, ['--json'], { AGENTCHAT_SERVER: 'not-a-url' });

    expect(run.code).toBe(0);
    expect(report(run)).toMatchObject({
      ok: false,
      server: { url: 'not-a-url', source: 'environment', reachable: null },
    });
  });
});

describe('the invocation itself', () => {
  it('is still a usage error when a flag is unknown, and still exits 2', async () => {
    // The contract this command bends is "a problem it found is not a failure".
    // A malformed invocation is not something it found; no report exists.
    const run = await status({}, ['--not-a-flag', '--json']);

    expect(run.code).toBe(2);
    expect(parseNdjson(run.stdout)).toMatchObject([{ error: { code: 'BAD_REQUEST' } }]);
  });

  it('appears in the command list', async () => {
    const run = await runCli(['--help']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('status');
  });
});
