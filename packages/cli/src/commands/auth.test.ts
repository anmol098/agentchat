import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Credentials,
  Transport,
  TransportRequest,
  TransportResponse,
} from '@agentchat/client';
import { ApiError, InMemoryCredentialStore, TransportError } from '@agentchat/client';
import { ErrorCode, errorEnvelope, ProtocolError, UserId } from '@agentchat/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { captureRun } from '../testing.js';
import type { AuthOverrides, Sleep } from './auth.js';
import {
  createLoginCommand,
  createLogoutCommand,
  createWhoamiCommand,
  pollSignalOf,
  retryAfterSecondsOf,
} from './auth.js';

const SERVER = 'https://chat.example.test';

const START = 'POST /auth/device/start';
const POLL = 'POST /auth/device/poll';
const LOGOUT = 'POST /auth/logout';
const REFRESH = 'POST /auth/refresh';
const ME = 'GET /me';

const USER = {
  id: UserId.generate(),
  username: 'alice',
  displayName: 'Alice Example',
  email: 'alice@example.test',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const GRANT = {
  deviceCode: 'device-code-abc',
  userCode: 'ABCD-1234',
  verificationUri: 'https://github.com/login/device',
  interval: 5,
  expiresIn: 900,
};

const APPROVED = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  user: USER,
};

/** One scripted response. */
interface Reply {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * A transport that answers from a script instead of a socket.
 *
 * Replies for one route are consumed in order and the last one repeats, which
 * is what lets "pending forever" be written as a single reply.
 */
class StubServer implements Transport {
  public readonly calls: TransportRequest[] = [];
  readonly #queues = new Map<string, Reply[]>();

  public on(key: string, ...replies: readonly Reply[]): this {
    this.#queues.set(key, [...replies]);
    return this;
  }

  public countOf(key: string): number {
    return this.calls.filter((call) => `${call.method} ${call.path}` === key).length;
  }

  public bodyOf(key: string): unknown {
    return this.calls.find((call) => `${call.method} ${call.path}` === key)?.body;
  }

  public request(request: TransportRequest): Promise<TransportResponse> {
    this.calls.push(request);
    const queue = this.#queues.get(`${request.method} ${request.path}`);
    const next = queue === undefined || queue.length === 0 ? undefined : queue[0];
    if (next === undefined) {
      return Promise.resolve({
        status: 404,
        headers: {},
        body: errorEnvelope(ErrorCode.NOT_FOUND, `No stub for ${request.method} ${request.path}.`),
      });
    }
    if (queue !== undefined && queue.length > 1) {
      queue.shift();
    }
    return Promise.resolve({
      status: next.status,
      headers: next.headers ?? {},
      body: next.body ?? {},
    });
  }
}

/** An error envelope reply. */
function fails(status: number, code: ErrorCode, headers?: Record<string, string>): Reply {
  return {
    status,
    body: errorEnvelope(code, `stubbed ${code}`),
    ...(headers === undefined ? {} : { headers }),
  };
}

/**
 * A clock that only moves when something sleeps.
 *
 * The poll loop's deadline is measured on this clock, so "the server answers
 * pending until the code expires" runs in microseconds and asserts the real
 * arithmetic rather than a shortened timeout.
 */
function fakeClock(): { now: () => number; sleep: Sleep; waits: number[] } {
  let current = 1_000_000;
  const waits: number[] = [];
  return {
    now: () => current,
    sleep: (milliseconds: number): Promise<void> => {
      waits.push(milliseconds);
      current += milliseconds;
      return Promise.resolve();
    },
    waits,
  };
}

/** The environment every run gets, so nothing reaches the real home directory. */
function envFor(home: string): Record<string, string> {
  return { XDG_CONFIG_HOME: home };
}

const temporaries: string[] = [];

async function temporaryHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agentchat-auth-'));
  temporaries.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaries.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** Runs one auth command through the whole framework. */
async function runAuth(
  argv: readonly string[],
  build: (overrides: AuthOverrides) => ReturnType<typeof createLoginCommand>,
  overrides: AuthOverrides,
  home: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await captureRun([...argv, '--server', SERVER], {
    commands: [build(overrides)],
    env: envFor(home),
  });
}

function ndjson(text: string): unknown[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as unknown);
}

describe('pollSignalOf', () => {
  it('maps each of the four non-success outcomes to a different decision', () => {
    expect(pollSignalOf(new ApiError(428, ErrorCode.AUTH_PENDING, 'x'))).toBe('pending');
    expect(pollSignalOf(new ApiError(409, ErrorCode.CONFLICT, 'x'))).toBe('slow-down');
    expect(pollSignalOf(new ApiError(403, ErrorCode.FORBIDDEN, 'x'))).toBe('denied');
    expect(pollSignalOf(new ApiError(400, ErrorCode.DEVICE_CODE_EXPIRED, 'x'))).toBe('expired');
  });

  it('refuses to guess at anything else, so the loop rethrows it', () => {
    expect(pollSignalOf(new ApiError(500, ErrorCode.INTERNAL, 'x'))).toBe('other');
    expect(pollSignalOf(new TransportError('unreachable'))).toBe('other');
    expect(pollSignalOf(new ProtocolError(ErrorCode.CONFLICT, 'not from the wire'))).toBe('other');
    expect(pollSignalOf('a string')).toBe('other');
  });
});

describe('retryAfterSecondsOf', () => {
  it('reads delta-seconds', () => {
    expect(retryAfterSecondsOf({ 'retry-after': '11' })).toBe(11);
  });

  it('reads an HTTP-date, which the header equally permits', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    expect(retryAfterSecondsOf({ 'retry-after': 'Thu, 01 Jan 2026 00:00:30 GMT' }, () => now)).toBe(
      30,
    );
  });

  it('is null when the header is absent, unreadable, zero, or already past', () => {
    expect(retryAfterSecondsOf({})).toBeNull();
    expect(retryAfterSecondsOf({ 'retry-after': 'soon' })).toBeNull();
    expect(retryAfterSecondsOf({ 'retry-after': '0' })).toBeNull();
    expect(retryAfterSecondsOf({ 'retry-after': '-4' })).toBeNull();
    const now = Date.parse('2026-01-01T00:01:00.000Z');
    expect(
      retryAfterSecondsOf({ 'retry-after': 'Thu, 01 Jan 2026 00:00:00 GMT' }, () => now),
    ).toBeNull();
  });
});

describe('login', () => {
  it('signs in, stores the tokens, and reports the account on stdout', async () => {
    const home = await temporaryHome();
    const stub = new StubServer().on(START, { status: 200, body: GRANT }).on(POLL, {
      status: 200,
      body: APPROVED,
    });
    const store = new InMemoryCredentialStore();
    const clock = fakeClock();

    const run = await runAuth(
      ['login'],
      createLoginCommand,
      { transport: stub, store, sleep: clock.sleep, now: clock.now },
      home,
    );

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Signed in as @alice');
    expect(run.stdout).toContain(SERVER);
    await expect(store.load()).resolves.toEqual<Credentials>({
      accessToken: APPROVED.accessToken,
      refreshToken: APPROVED.refreshToken,
    });
  });

  it('puts the verification URL and code on stderr, never on stdout', async () => {
    const home = await temporaryHome();
    const stub = new StubServer()
      .on(START, { status: 200, body: GRANT })
      .on(POLL, { status: 200, body: APPROVED });
    const clock = fakeClock();

    const run = await runAuth(
      ['login'],
      createLoginCommand,
      { transport: stub, store: new InMemoryCredentialStore(), sleep: clock.sleep, now: clock.now },
      home,
    );

    expect(run.stderr).toContain(GRANT.verificationUri);
    expect(run.stderr).toContain(GRANT.userCode);
    expect(run.stdout).not.toContain(GRANT.verificationUri);
    expect(run.stdout).not.toContain(GRANT.userCode);
  });

  it('with --json puts the instruction on stdout as its own record instead', async () => {
    const home = await temporaryHome();
    const stub = new StubServer()
      .on(START, { status: 200, body: GRANT })
      .on(POLL, { status: 200, body: APPROVED });
    const clock = fakeClock();

    const run = await captureRun(['login', '--json', '--server', SERVER], {
      commands: [
        createLoginCommand({
          transport: stub,
          store: new InMemoryCredentialStore(),
          sleep: clock.sleep,
          now: clock.now,
        }),
      ],
      env: envFor(home),
    });

    expect(run.code).toBe(0);
    expect(ndjson(run.stdout)).toEqual([
      {
        status: 'pending',
        verificationUri: GRANT.verificationUri,
        userCode: GRANT.userCode,
        interval: GRANT.interval,
        expiresIn: GRANT.expiresIn,
      },
      {
        status: 'authenticated',
        user: {
          id: USER.id,
          username: USER.username,
          displayName: USER.displayName,
          email: USER.email,
        },
        server: SERVER,
      },
    ]);
    expect(run.stderr).not.toContain(GRANT.userCode);
  });

  it('waits the interval the server chose before the first poll and between polls', async () => {
    const home = await temporaryHome();
    const stub = new StubServer()
      .on(START, { status: 200, body: { ...GRANT, interval: 7 } })
      .on(POLL, fails(428, ErrorCode.AUTH_PENDING), { status: 200, body: APPROVED });
    const clock = fakeClock();

    const run = await runAuth(
      ['login'],
      createLoginCommand,
      { transport: stub, store: new InMemoryCredentialStore(), sleep: clock.sleep, now: clock.now },
      home,
    );

    expect(run.code).toBe(0);
    // Waits before the very first poll too: the server will not accept one
    // before `interval` has passed, and the user has not typed the code yet.
    expect(clock.waits).toEqual([7000, 7000]);
    expect(stub.countOf(POLL)).toBe(2);
  });

  it('adopts a Retry-After sent alongside a pending answer', async () => {
    const home = await temporaryHome();
    const stub = new StubServer()
      .on(START, { status: 200, body: GRANT })
      .on(POLL, fails(428, ErrorCode.AUTH_PENDING, { 'retry-after': '9' }), {
        status: 200,
        body: APPROVED,
      });
    const clock = fakeClock();

    await runAuth(
      ['login'],
      createLoginCommand,
      { transport: stub, store: new InMemoryCredentialStore(), sleep: clock.sleep, now: clock.now },
      home,
    );

    expect(clock.waits).toEqual([5000, 9000]);
  });

  it('slows down when rate limited, using the hint the server sent', async () => {
    const home = await temporaryHome();
    const stub = new StubServer()
      .on(START, { status: 200, body: GRANT })
      .on(POLL, fails(409, ErrorCode.CONFLICT, { 'retry-after': '23' }), {
        status: 200,
        body: APPROVED,
      });
    const clock = fakeClock();

    const run = await runAuth(
      ['login'],
      createLoginCommand,
      { transport: stub, store: new InMemoryCredentialStore(), sleep: clock.sleep, now: clock.now },
      home,
    );

    expect(run.code).toBe(0);
    expect(clock.waits).toEqual([5000, 23000]);
    expect(run.stderr).toContain('slower polling');
    // Kept polling. Treating the rate-limit signal as a failure would strand a
    // user who did nothing wrong.
    expect(stub.countOf(POLL)).toBe(2);
  });

  it('backs off by five seconds when rate limited with no Retry-After', async () => {
    const home = await temporaryHome();
    const stub = new StubServer()
      .on(START, { status: 200, body: GRANT })
      .on(POLL, fails(409, ErrorCode.CONFLICT), fails(409, ErrorCode.CONFLICT), {
        status: 200,
        body: APPROVED,
      });
    const clock = fakeClock();

    await runAuth(
      ['login'],
      createLoginCommand,
      { transport: stub, store: new InMemoryCredentialStore(), sleep: clock.sleep, now: clock.now },
      home,
    );

    expect(clock.waits).toEqual([5000, 10000, 15000]);
  });

  it('stops at once when the user denies the sign-in', async () => {
    const home = await temporaryHome();
    const stub = new StubServer()
      .on(START, { status: 200, body: GRANT })
      .on(POLL, fails(403, ErrorCode.FORBIDDEN));
    const store = new InMemoryCredentialStore();
    const clock = fakeClock();

    const run = await runAuth(
      ['login'],
      createLoginCommand,
      { transport: stub, store, sleep: clock.sleep, now: clock.now },
      home,
    );

    expect(run.code).toBe(3);
    expect(run.stderr).toContain('denied');
    expect(stub.countOf(POLL)).toBe(1);
    await expect(store.load()).resolves.toBeNull();
  });

  it('stops when the server reports the code expired, and says what to do', async () => {
    const home = await temporaryHome();
    const stub = new StubServer()
      .on(START, { status: 200, body: GRANT })
      .on(POLL, fails(400, ErrorCode.DEVICE_CODE_EXPIRED));
    const clock = fakeClock();

    const run = await runAuth(
      ['login'],
      createLoginCommand,
      { transport: stub, store: new InMemoryCredentialStore(), sleep: clock.sleep, now: clock.now },
      home,
    );

    expect(run.code).toBe(3);
    expect(run.stderr).toContain('expired');
    expect(run.stderr).toContain('agentchat login');
    expect(stub.countOf(POLL)).toBe(1);
  });

  it('stops itself at the expiry even if the server never says so', async () => {
    const home = await temporaryHome();
    const stub = new StubServer()
      .on(START, { status: 200, body: { ...GRANT, interval: 5, expiresIn: 20 } })
      .on(POLL, fails(428, ErrorCode.AUTH_PENDING));
    const clock = fakeClock();

    const run = await runAuth(
      ['login'],
      createLoginCommand,
      { transport: stub, store: new InMemoryCredentialStore(), sleep: clock.sleep, now: clock.now },
      home,
    );

    expect(run.code).toBe(3);
    expect(run.stderr).toContain('expired');
    expect(stub.countOf(POLL)).toBe(3);
    expect(clock.waits).toEqual([5000, 5000, 5000, 5000]);
  });

  it('reports a failure the poll endpoint has no signal for, rather than looping on it', async () => {
    const home = await temporaryHome();
    const stub = new StubServer()
      .on(START, { status: 200, body: GRANT })
      .on(POLL, fails(500, ErrorCode.INTERNAL));
    const clock = fakeClock();

    const run = await runAuth(
      ['login'],
      createLoginCommand,
      { transport: stub, store: new InMemoryCredentialStore(), sleep: clock.sleep, now: clock.now },
      home,
    );

    expect(run.code).toBe(1);
    expect(stub.countOf(POLL)).toBe(1);
  });

  it('is a usage error when no server is configured', async () => {
    const home = await temporaryHome();
    const run = await captureRun(['login'], {
      commands: [createLoginCommand({ store: new InMemoryCredentialStore() })],
      env: envFor(home),
    });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('No AgentChat server is configured');
  });
});

describe('logout', () => {
  const signedIn = (): InMemoryCredentialStore =>
    new InMemoryCredentialStore({ accessToken: 'access', refreshToken: 'refresh' });

  it('revokes the refresh token, then removes the local credentials', async () => {
    const home = await temporaryHome();
    const stub = new StubServer().on(LOGOUT, { status: 200, body: {} });
    const store = signedIn();

    const run = await runAuth(['logout'], createLogoutCommand, { transport: stub, store }, home);

    expect(run.code).toBe(0);
    expect(stub.bodyOf(LOGOUT)).toEqual({ refreshToken: 'refresh' });
    await expect(store.load()).resolves.toBeNull();
    expect(run.stdout).toContain('Signed out of');
  });

  it('keeps the credentials when the server does not confirm the revocation', async () => {
    const home = await temporaryHome();
    const stub = new StubServer().on(LOGOUT, fails(500, ErrorCode.INTERNAL));
    const store = signedIn();

    const run = await runAuth(['logout'], createLogoutCommand, { transport: stub, store }, home);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('left in place');
    // The whole point: the refresh token is the only handle on that session, so
    // a failed revocation must not also destroy the means of retrying it.
    await expect(store.load()).resolves.not.toBeNull();
    expect(run.stdout).toBe('');
  });

  it('removes them anyway with --force, saying what that costs', async () => {
    const home = await temporaryHome();
    const stub = new StubServer().on(LOGOUT, fails(500, ErrorCode.INTERNAL));
    const store = signedIn();

    const run = await captureRun(['logout', '--force', '--server', SERVER], {
      commands: [createLogoutCommand({ transport: stub, store })],
      env: envFor(home),
    });

    expect(run.code).toBe(0);
    expect(run.stderr).toContain('stays valid on the server');
    await expect(store.load()).resolves.toBeNull();
  });

  it('treats an already-invalid session as signed out', async () => {
    const home = await temporaryHome();
    const stub = new StubServer()
      .on(LOGOUT, fails(401, ErrorCode.AUTH_REQUIRED))
      .on(REFRESH, fails(401, ErrorCode.AUTH_REQUIRED));
    const store = signedIn();

    const run = await runAuth(['logout'], createLogoutCommand, { transport: stub, store }, home);

    expect(run.code).toBe(0);
    await expect(store.load()).resolves.toBeNull();
  });

  it('succeeds when there was nothing to sign out of', async () => {
    const home = await temporaryHome();
    const stub = new StubServer();

    const run = await captureRun(['logout', '--json', '--server', SERVER], {
      commands: [createLogoutCommand({ transport: stub, store: new InMemoryCredentialStore() })],
      env: envFor(home),
    });

    expect(run.code).toBe(0);
    expect(ndjson(run.stdout)).toEqual([{ status: 'signed-out', server: SERVER, revoked: false }]);
    expect(stub.calls).toHaveLength(0);
  });
});

describe('whoami', () => {
  it('reports the account and the server', async () => {
    const home = await temporaryHome();
    const stub = new StubServer().on(ME, { status: 200, body: USER });
    const store = new InMemoryCredentialStore({ accessToken: 'a', refreshToken: 'r' });

    const run = await runAuth(['whoami'], createWhoamiCommand, { transport: stub, store }, home);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('@alice');
    expect(run.stdout).toContain(SERVER);
  });

  it('emits the account and the server as one JSON record', async () => {
    const home = await temporaryHome();
    const stub = new StubServer().on(ME, { status: 200, body: USER });

    const run = await captureRun(['whoami', '--json', '--server', SERVER], {
      commands: [
        createWhoamiCommand({
          transport: stub,
          store: new InMemoryCredentialStore({ accessToken: 'a', refreshToken: 'r' }),
        }),
      ],
      env: envFor(home),
    });

    expect(ndjson(run.stdout)).toEqual([
      {
        user: {
          id: USER.id,
          username: USER.username,
          displayName: USER.displayName,
          email: USER.email,
        },
        server: SERVER,
      },
    ]);
  });

  it('exits 3 when there are no credentials, without asking the server', async () => {
    const home = await temporaryHome();
    const stub = new StubServer();

    const run = await runAuth(
      ['whoami'],
      createWhoamiCommand,
      { transport: stub, store: new InMemoryCredentialStore() },
      home,
    );

    expect(run.code).toBe(3);
    expect(run.stderr).toContain('not signed in');
    expect(stub.calls).toHaveLength(0);
    expect(run.stdout).toBe('');
  });

  it('exits 3 rather than 2 when neither a server nor credentials are configured', async () => {
    const home = await temporaryHome();
    const run = await captureRun(['whoami'], {
      commands: [createWhoamiCommand({ store: new InMemoryCredentialStore() })],
      env: envFor(home),
    });

    expect(run.code).toBe(3);
  });
});

describe('the credential store’s warning sink', () => {
  it.skipIf(process.platform === 'win32')(
    'surfaces the permission warning on stderr instead of discarding it',
    async () => {
      const home = await temporaryHome();
      const directory = join(home, 'agentchat');
      await mkdir(directory, { recursive: true });
      const file = join(directory, 'credentials.json');
      await writeFile(
        file,
        `${JSON.stringify({ version: 1, accessToken: 'a', refreshToken: 'r' })}\n`,
        'utf8',
      );
      await chmod(file, 0o644);

      const stub = new StubServer().on(ME, { status: 200, body: USER });

      // No `store` override: this is the real file store, wired the way the
      // commands wire it.
      const run = await captureRun(['whoami', '--server', SERVER], {
        commands: [createWhoamiCommand({ transport: stub })],
        env: envFor(home),
      });

      expect(run.code).toBe(0);
      expect(run.stderr).toContain('readable by other users');
      // The token itself is never in the warning.
      expect(run.stderr).not.toContain('refresh-token');
    },
  );
});
