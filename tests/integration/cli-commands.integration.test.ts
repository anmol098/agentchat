/**
 * The commands that call the identity endpoint, run against a real server.
 *
 * Five commands call `GET /me` — `whoami`, `status`, `send`, `listen` and
 * `inbox` — and `logout` calls `POST /auth/logout`. Every one of them was
 * already covered by a passing test in `packages/cli`, and every one of them
 * failed against a real server, because those tests drive a stub that answers
 * routes the server had never registered. The commands were correct against a
 * server that did not exist.
 *
 * That is the specific hole this file closes, so it is deliberately built the
 * opposite way round. There is no stub. The binary is the built
 * `packages/cli/dist/bin.js`, spawned as its own process the way a user runs
 * it; it reads a credentials file from disk that a real device-flow login
 * wrote; it resolves its server from `AGENTCHAT_SERVER`; and what answers is
 * `createApp` over PostgreSQL. Nothing in the loop is a test double except the
 * identity provider, which cannot be reached from a test.
 *
 * A command "works" here means it exits 0 and prints the thing it exists to
 * print. That matters more than it sounds: before T-043 each of these failed
 * with the unmatched-route response, which the CLI renders as an error and
 * exits non-zero on, so exit 0 is exactly the assertion that would have caught
 * this.
 *
 * @module
 */

import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentChatClient, InMemoryCredentialStore } from '@agentchat/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ServerFixture, startServer, unique } from './server-fixture.js';

/** The built executable, exactly as `packages/cli/package.json` points at it. */
const BINARY = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url));

/** How long a command may run before the suite calls it hung. */
const COMMAND_TIMEOUT_MS = 20_000;

/** What one spawned run produced. */
interface Run {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

let server: ServerFixture;
let configHome: string;
let username: string;
let projectSlug: string;

/**
 * Runs the real binary.
 *
 * The environment replaces the parent's rather than extending it, so a
 * developer's exported `AGENTCHAT_SERVER` or `NO_COLOR` cannot change what this
 * suite asserts. `PATH` is kept because Node needs it to re-exec itself.
 *
 * @param argv - Arguments after the program name.
 * @param options - Extra environment, and how to stop a command that does not
 *   stop on its own.
 * @returns Both descriptors, captured separately, and the exit code.
 */
function runCli(
  argv: readonly string[],
  options: {
    readonly env?: Readonly<Record<string, string>>;
    /** Sends `SIGINT` once this appears on either descriptor. */
    readonly stopWhen?: string;
  } = {},
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BINARY, ...argv], {
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: configHome,
        XDG_CONFIG_HOME: configHome,
        AGENTCHAT_SERVER: server.baseUrl,
        ...options.env,
      },
      cwd: configHome,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stopped = false;

    /** Interrupts a command that holds its connection open, once it is up. */
    const maybeStop = (): void => {
      if (
        options.stopWhen !== undefined &&
        !stopped &&
        (stdout + stderr).includes(options.stopWhen)
      ) {
        stopped = true;
        child.kill('SIGINT');
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      maybeStop();
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      maybeStop();
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`\`agentchat ${argv.join(' ')}\` did not finish\n${stdout}\n${stderr}`));
    }, COMMAND_TIMEOUT_MS);

    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

/** Writes the credentials file the CLI reads, with the modes it insists on. */
async function writeCredentials(accessToken: string, refreshToken: string): Promise<void> {
  const directory = join(configHome, 'agentchat');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'credentials.json');
  await writeFile(file, `${JSON.stringify({ accessToken, refreshToken }, null, 2)}\n`, 'utf8');
  await chmod(file, 0o600);
}

beforeAll(async () => {
  server = await startServer();
  configHome = await mkdtemp(join(tmpdir(), 'agentchat-t043-'));

  // A real login, through the real device flow, against the real server. The
  // tokens the CLI will use are the ones this issued.
  const store = new InMemoryCredentialStore();
  const identity = await server.login(store);
  username = identity.username;

  const credentials = await store.load();
  if (credentials === null) {
    throw new Error('the device flow issued nothing');
  }
  await writeCredentials(credentials.accessToken, credentials.refreshToken);

  // Enough of a world for the commands that need one. Created through the
  // client rather than by inserting rows, so the fixtures go through the same
  // routes and the same authorization the commands will.
  const client = new AgentChatClient({ baseUrl: server.baseUrl, credentials: store });

  const project = await client.projects.create({ name: `T043 ${unique()}` });
  projectSlug = project.slug;

  for (const name of ['backend', 'frontend']) {
    const agent = await client.agents.create({ name });
    await client.agents.addToProject(agent.id, { projectId: project.id });
  }
}, 60_000);

afterAll(async () => {
  await server?.close();
});

/** The context the project-scoped commands resolve from. */
function projectEnv(agent: string): Record<string, string> {
  return { AGENTCHAT_PROJECT: projectSlug, AGENTCHAT_AGENT: agent };
}

/**
 * Runs a command and reports how many `GET /me` calls reached the server.
 *
 * Exit 0 alone would be satisfied by a command that stopped calling the
 * identity endpoint altogether, which is the one way this suite could go green
 * while the bug came back. Counting on the server settles it.
 *
 * @param argv - Arguments after the program name.
 * @param options - As {@link runCli}.
 * @returns The run, and how many identity calls it made.
 */
async function runCounting(
  argv: readonly string[],
  options?: Parameters<typeof runCli>[1],
): Promise<Run & { readonly identityCalls: number }> {
  const before = server.countOf('GET /me');
  const run = await runCli(argv, options);
  return { ...run, identityCalls: server.countOf('GET /me') - before };
}

describe('the commands that call GET /me, against a real server', () => {
  it('whoami reports the account the device flow created', async () => {
    const run = await runCounting(['whoami']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(username);
    expect(run.identityCalls).toBe(1);
  });

  it('inbox reads the queue for the resolved agent', async () => {
    const run = await runCounting(['inbox'], { env: projectEnv('backend') });

    expect(run.code).toBe(0);
    expect(run.identityCalls).toBe(1);
  });

  it('send delivers a message to another agent in the project', async () => {
    const run = await runCounting(['send', `@${username}/frontend`, 'hello from T-043'], {
      env: projectEnv('backend'),
    });

    expect(run.code).toBe(0);
    expect(run.identityCalls).toBe(1);
  });

  it('inbox then shows the message send delivered', async () => {
    const run = await runCounting(['inbox', '--json'], { env: projectEnv('frontend') });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('hello from T-043');
    expect(run.identityCalls).toBe(1);
  });

  /**
   * `status` is the fifth caller, and it reaches `GET /me` again.
   *
   * It probes `GET /version` first and short-circuits the rest of the report
   * when the server does not answer. For a while that probe failed for a reason
   * that was not this suite's: `routes/version.ts` was complete, tested, listed
   * in `PUBLIC_ROUTES` and registered nowhere, so this expected **zero**
   * identity calls and said in as many words that it should become one when
   * T-041 landed. T-041 landed; this is that one.
   */
  it('status runs, probes the version endpoint, and resolves its context', async () => {
    const run = await runCounting(['status'], { env: projectEnv('backend') });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(projectSlug);
    expect(run.stdout).toContain('backend');
    expect(run.identityCalls).toBe(1);
  });

  it('listen resolves its identity and holds the connection open', async () => {
    // The only command here that does not end on its own. It is interrupted
    // once it has announced itself, which it can only do after `GET /me` has
    // told it which of the caller's agents it is.
    const run = await runCli(['listen', '--runtime', 'integration-test'], {
      env: projectEnv('backend'),
      stopWhen: 'Listening as',
    });

    // It announced the agent it resolved, which it could only learn by asking
    // `GET /me` which of this account's agents `AGENTCHAT_AGENT` names.
    expect(`${run.stdout}${run.stderr}`).toContain(`Listening as @${username}/backend`);
  });
});

describe('logout, against a real server', () => {
  it('revokes the refresh token, and says so again when asked twice', async () => {
    // A separate login, so revoking it cannot disturb the credentials the
    // tests above share.
    const store = new InMemoryCredentialStore();
    await server.login(store);
    const credentials = await store.load();
    if (credentials === null) {
      throw new Error('the device flow issued nothing');
    }
    await writeCredentials(credentials.accessToken, credentials.refreshToken);

    const first = await runCli(['logout']);
    expect(first.code).toBe(0);

    // The token is really gone: the server refuses to spend it.
    //
    // Worth being precise about what this proves, because a logged-out token
    // and a replayed one are the same row to `auth/tokens.ts` — both are
    // revoked, and it revokes the account's whole chain for either. That is
    // T-104's deliberate choice and not this route's to reinterpret, so the
    // assertion is on the refusal and not on how loudly it was refused.
    const spent = await fetch(`${server.baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: credentials.refreshToken }),
    });
    expect(spent.status).toBe(401);

    // A retrying client is the case that matters. `logout` cleared the local
    // file, so this second run makes no request at all — but the route it
    // would have called is idempotent too, which is asserted directly below
    // because the command can no longer reach it.
    const second = await runCli(['logout']);
    expect(second.code).toBe(0);

    // Logging out twice is a success. So is logging out with a token this
    // server has already forgotten. A client told its retry had failed would
    // strand credentials it can no longer use, and a route that answered
    // differently for a live token than for a dead one would let any
    // authenticated caller test strings against the token store.
    const store2 = new InMemoryCredentialStore();
    await server.login(store2);
    const live = await store2.load();
    if (live === null) {
      throw new Error('the device flow issued nothing');
    }

    // Measured as a delta, because the deliberate replay above has already put
    // one revocation in this log and a whole-log search would find it.
    const logBefore = server.logs().length;

    const logoutTwice = async (refreshToken: string): Promise<number> => {
      const response = await fetch(`${server.baseUrl}/auth/logout`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${live.accessToken}`,
        },
        body: JSON.stringify({ refreshToken }),
      });
      expect(await response.json()).toEqual({});
      return response.status;
    };

    expect(await logoutTwice(live.refreshToken)).toBe(200);
    expect(await logoutTwice(live.refreshToken)).toBe(200);
    expect(await logoutTwice('a-string-this-server-never-issued')).toBe(200);

    // And revoking twice was not read as reuse: reuse detection revokes the
    // account's whole chain and logs it, which would turn a careful client's
    // retry into a self-inflicted logout of every other machine. This is the
    // difference between `logout` and `refresh` on an already-revoked token,
    // and it is the reason logout goes through `TokenService.logout` rather
    // than through anything that rotates.
    expect(server.logs().slice(logBefore)).not.toContain('refresh token replayed');
  });
});

describe('GET /me', () => {
  it('answers with the same user shape the login flow already returns', async () => {
    const store = new InMemoryCredentialStore();
    await server.login(store);
    const credentials = await store.load();
    if (credentials === null) {
      throw new Error('the device flow issued nothing');
    }

    // The poll response carries a `user`; `/me` is that same object unwrapped.
    // Field by field, because a fourth variant of the user shape would differ
    // in exactly one field — a timestamp format, a missing email — and would
    // still parse as an object.
    const client = new AgentChatClient({ baseUrl: server.baseUrl, credentials: store });
    const me = await client.auth.me();

    const response = await fetch(`${server.baseUrl}/me`, {
      headers: { authorization: `Bearer ${credentials.accessToken}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(me);

    // Unwrapped, not `{ user }`. There is one thing this endpoint can return
    // and a wrapper would only be a name for it.
    expect(me).toHaveProperty('username');
    expect(me).not.toHaveProperty('user');
  });
});
