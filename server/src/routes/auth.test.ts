/**
 * The device-flow routes, over a real Fastify instance and a stubbed identity
 * provider.
 *
 * The app is built by `createAppShell` rather than assembled here, so every
 * assertion about a status or an error code is an assertion about what a client
 * actually receives: the codes travel through the same error handler,
 * `toErrorResponse` and outbound `ErrorCodeSchema` check that T-015 installed
 * for every route. The shell rather than `createApp` because `createApp`
 * registers these routes itself (T-019), and this suite registers them with its
 * own stubs and its own clock.
 *
 * The provider, the token service and the user store are all stubs. The first
 * because nothing may talk to GitHub in a test; the second because
 * `server/src/auth/tokens.ts` belongs to T-104 and this route depends on the
 * interface rather than on the module; the third because what the upsert does
 * to Postgres is proven in `auth.integration.test.ts`, against a real database.
 */

import {
  ErrorCode,
  PollDeviceAuthorizationResponseSchema,
  ProtocolError,
  StartDeviceAuthorizationResponseSchema,
  type User,
  UserId,
  type UserId as UserIdType,
} from '@agentchat/protocol';
import pino, { type Logger } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { createAppShell } from '../app.js';
import type {
  DeviceAuthorizationOutcome,
  IdentityProvider,
  ProviderIdentity,
} from '../auth/identity.js';
import { loadConfig, type ServerConfig } from '../config.js';
import {
  createDeviceAuthorizationService,
  MAX_PENDING_AUTHORIZATIONS,
  RETRY_AFTER_HEADER,
  registerAuthRoutes,
  type TokenIssuer,
  type UserDirectory,
} from './auth.js';
import type { HealthProbe } from './health.js';

const config: ServerConfig = loadConfig({
  DATABASE_URL: 'postgres://agentchat:agentchat@localhost:5432/agentchat',
  LOG_LEVEL: 'info',
  // Required since T-019, and unused here: this suite hosts the routes on the
  // shell, which has neither a token service nor an identity provider.
  JWT_SECRET: 'j'.repeat(32),
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
});

/** The health probe `createAppShell` requires; no route under test uses it. */
const database: HealthProbe = { ping: () => Promise.resolve() };

/** The provider's device code. It must never appear on the wire. */
const PROVIDER_DEVICE_CODE = 'provider-device-code-do-not-leak';

/** Seconds the stub provider advertises between polls. */
const INTERVAL = 5;

/** Seconds the stub provider's authorization stays alive. */
const EXPIRES_IN = 900;

/** The identity the stub provider reports on approval. */
const identity: ProviderIdentity = {
  subject: '4207',
  username: 'alice-smith',
  displayName: 'Alice Smith',
  email: 'alice@example.com',
};

/** The account the stub directory returns for {@link identity}. */
const account: User = {
  id: UserId.generate(),
  username: 'alice-smith',
  displayName: 'Alice Smith',
  email: 'alice@example.com',
  createdAt: new Date('2026-09-08T10:00:00.000Z').toISOString(),
};

/** Collects log records so a test can prove what was not written to them. */
function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = pino(
    { level: 'trace', base: null, timestamp: false },
    {
      write(line: string): void {
        lines.push(line);
      },
    },
  );
  return { logger, lines };
}

/** A provider whose every poll answers with the scripted outcome. */
function stubProvider(
  outcome: () => DeviceAuthorizationOutcome | Promise<DeviceAuthorizationOutcome>,
): { provider: IdentityProvider; polls: () => number } {
  let polls = 0;

  return {
    provider: {
      startDeviceAuthorization: () =>
        Promise.resolve({
          deviceCode: PROVIDER_DEVICE_CODE,
          userCode: 'ABCD-1234',
          verificationUri: 'https://example.test/device',
          interval: INTERVAL,
          expiresIn: EXPIRES_IN,
        }),
      redeemDeviceAuthorization: async (deviceCode: string) => {
        expect(deviceCode).toBe(PROVIDER_DEVICE_CODE);
        polls += 1;
        return await outcome();
      },
    },
    polls: () => polls,
  };
}

/** A token service standing in for T-104's. */
function stubTokens(): { tokens: TokenIssuer; issuedFor: () => UserIdType[] } {
  const issuedFor: UserIdType[] = [];

  return {
    tokens: {
      issueForUser: (userId) => {
        issuedFor.push(userId);
        return Promise.resolve({ accessToken: 'access-token', refreshToken: 'refresh-token' });
      },
    },
    issuedFor: () => issuedFor,
  };
}

/** A user store standing in for Postgres. */
function stubDirectory(
  upsert: (identity: ProviderIdentity) => Promise<User> = () => Promise.resolve(account),
): { users: UserDirectory; seen: () => ProviderIdentity[] } {
  const seen: ProviderIdentity[] = [];

  return {
    users: {
      upsertFromIdentity: async (given) => {
        seen.push(given);
        return await upsert(given);
      },
    },
    seen: () => seen,
  };
}

const started: { close(): Promise<unknown> }[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((app) => app.close()));
});

/** A clock the tests move by hand, so no test waits for a real interval. */
function clock(startMs = Date.parse('2026-09-08T10:00:00.000Z')): {
  now: () => number;
  advance: (seconds: number) => void;
} {
  let current = startMs;
  return {
    now: () => current,
    advance: (seconds: number) => {
      current += seconds * 1000;
    },
  };
}

/** Builds an app with the auth routes registered on it. */
function buildApp(options: {
  provider: IdentityProvider;
  tokens?: TokenIssuer;
  users?: UserDirectory;
  now?: () => number;
  logger?: Logger;
}) {
  const logger = options.logger ?? recordingLogger().logger;
  const app = createAppShell({ config, database, logger });

  registerAuthRoutes(app, {
    identityProvider: options.provider,
    tokens: options.tokens ?? stubTokens().tokens,
    users: options.users ?? stubDirectory().users,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  started.push(app);
  return app;
}

/** Starts a flow and returns the device code the server issued. */
async function startFlow(app: ReturnType<typeof buildApp>): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/auth/device/start', payload: {} });
  expect(response.statusCode).toBe(200);
  return StartDeviceAuthorizationResponseSchema.parse(response.json()).deviceCode;
}

describe('POST /auth/device/start', () => {
  it('answers with everything the client needs to prompt and poll', async () => {
    const app = buildApp({ provider: stubProvider(() => ({ status: 'pending' })).provider });

    const response = await app.inject({ method: 'POST', url: '/auth/device/start', payload: {} });

    expect(response.statusCode).toBe(200);
    const body = StartDeviceAuthorizationResponseSchema.parse(response.json());
    expect(body.userCode).toBe('ABCD-1234');
    expect(body.verificationUri).toBe('https://example.test/device');
    expect(body.interval).toBe(INTERVAL);
    expect(body.expiresIn).toBe(EXPIRES_IN);
    expect(body.deviceCode.length).toBeGreaterThan(20);
  });

  it("issues its own device code rather than passing the provider's through", async () => {
    const app = buildApp({ provider: stubProvider(() => ({ status: 'pending' })).provider });

    const response = await app.inject({ method: 'POST', url: '/auth/device/start', payload: {} });

    expect(response.body).not.toContain(PROVIDER_DEVICE_CODE);
    expect(response.json()).not.toMatchObject({ deviceCode: PROVIDER_DEVICE_CODE });
  });

  it('forbids caching a body that contains a credential', async () => {
    const app = buildApp({ provider: stubProvider(() => ({ status: 'pending' })).provider });

    const response = await app.inject({ method: 'POST', url: '/auth/device/start', payload: {} });

    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('reports a provider failure as a generic 500', async () => {
    const app = buildApp({
      provider: {
        startDeviceAuthorization: () =>
          Promise.reject(new ProtocolError(ErrorCode.INTERNAL, 'upstream exploded')),
        redeemDeviceAuthorization: () => Promise.reject(new Error('not reached')),
      },
    });

    const response = await app.inject({ method: 'POST', url: '/auth/device/start', payload: {} });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: ErrorCode.INTERNAL, message: 'The server failed to handle this request.' },
    });
    expect(response.body).not.toContain('upstream exploded');
  });
});

describe('the in-memory store of pending authorizations', () => {
  it('refuses to hold more authorizations than it will, rather than growing without bound', async () => {
    // `POST /auth/device/start` is unauthenticated, so anyone who can reach the
    // server can mint records here. The bound is what stops that becoming the
    // process's memory; it is exercised directly rather than over HTTP because
    // the point is the store's own rule.
    //
    // Ten thousand `start` calls cost about 80ms on an idle machine, nearly all
    // of it the per-call `randomBytes` and SHA-256. It used to cost around
    // 400ms, and nine seconds under the load of six agents, because each call
    // walked the whole store looking for expired records (T-031).
    const time = clock();
    const service = createDeviceAuthorizationService({
      identityProvider: stubProvider(() => ({ status: 'pending' })).provider,
      tokens: stubTokens().tokens,
      users: stubDirectory().users,
      now: time.now,
    });

    for (let i = 0; i < MAX_PENDING_AUTHORIZATIONS; i += 1) {
      await service.start();
    }
    expect(service.size()).toBe(MAX_PENDING_AUTHORIZATIONS);

    // Reported as the server's own failure, because it is: the caller did
    // nothing wrong and there is nothing in their request to fix.
    await expect(service.start()).rejects.toMatchObject({ code: ErrorCode.INTERNAL });

    // And it is a bound, not a wall: once the records expire the sweep makes
    // room again without an operator restarting anything.
    time.advance(EXPIRES_IN + 1);
    await expect(service.start()).resolves.toMatchObject({ userCode: 'ABCD-1234' });
    expect(service.size()).toBe(1);
  });

  it('frees slots in expiry order rather than in the order the authorizations arrived', async () => {
    // The store is ordered on expiry, and this is the difference between that
    // and the cheaper thing it could have been — reclaiming from the front of
    // an insertion-ordered map and stopping at the first live record. The
    // shortest-lived authorization here is the second one started, so that
    // shortcut would reclaim nothing at all on the first advance.
    const time = clock();
    const lifetimes = [900, 60, 300];
    let started = 0;

    const service = createDeviceAuthorizationService({
      identityProvider: {
        startDeviceAuthorization: () => {
          const expiresIn = lifetimes[started] ?? 900;
          started += 1;
          return Promise.resolve({
            deviceCode: PROVIDER_DEVICE_CODE,
            userCode: 'ABCD-1234',
            verificationUri: 'https://example.test/device',
            interval: INTERVAL,
            expiresIn,
          });
        },
        redeemDeviceAuthorization: () => Promise.resolve({ status: 'pending' as const }),
      },
      tokens: stubTokens().tokens,
      users: stubDirectory().users,
      now: time.now,
    });

    await service.start();
    await service.start();
    await service.start();
    expect(service.size()).toBe(3);

    // A poll of a code that was never issued is the cheapest way to make the
    // store do its housekeeping without also adding to it.
    time.advance(61);
    await service.poll('never-issued');
    expect(service.size()).toBe(2);

    time.advance(300 - 61);
    await service.poll('never-issued');
    expect(service.size()).toBe(1);

    time.advance(900);
    await service.poll('never-issued');
    expect(service.size()).toBe(0);
  });

  it('reclaims exactly the expired records at every instant, over many jumbled lifetimes', async () => {
    // The three-element case above says which order; this says the ordering
    // actually holds at a size where an off-by-one in the heap would show. The
    // lifetimes come from a fixed multiplicative generator rather than
    // `Math.random`, so a failure here is one somebody can reproduce.
    const time = clock();
    const lifetimes: number[] = [];
    let seed = 1;
    for (let i = 0; i < 500; i += 1) {
      seed = (seed * 48_271) % 2_147_483_647;
      lifetimes.push((seed % 600) + 1);
    }

    let started = 0;
    const service = createDeviceAuthorizationService({
      identityProvider: {
        startDeviceAuthorization: () => {
          const expiresIn = lifetimes[started] ?? 1;
          started += 1;
          return Promise.resolve({
            deviceCode: PROVIDER_DEVICE_CODE,
            userCode: 'ABCD-1234',
            verificationUri: 'https://example.test/device',
            interval: INTERVAL,
            expiresIn,
          });
        },
        redeemDeviceAuthorization: () => Promise.resolve({ status: 'pending' as const }),
      },
      tokens: stubTokens().tokens,
      users: stubDirectory().users,
      now: time.now,
    });

    // All started at the same instant, so a record's lifetime is its expiry.
    for (let i = 0; i < lifetimes.length; i += 1) {
      await service.start();
    }
    expect(service.size()).toBe(lifetimes.length);

    for (let elapsed = 10; elapsed <= 610; elapsed += 10) {
      time.advance(10);
      await service.poll('never-issued');
      expect(service.size()).toBe(lifetimes.filter((lifetime) => lifetime > elapsed).length);
    }

    expect(service.size()).toBe(0);
  });

  it('keeps a live authorization redeemable through a churn of expiries and redemptions', async () => {
    // Records that are redeemed leave their expiry-queue entry behind, and the
    // store drops those in batches once they outnumber the live ones. This is
    // the property that compaction must not break: rebuilding the queue may
    // discard nothing that is still redeemable.
    const time = clock();
    const outcomes: DeviceAuthorizationOutcome[] = [];
    const service = createDeviceAuthorizationService({
      identityProvider: {
        startDeviceAuthorization: () =>
          Promise.resolve({
            deviceCode: PROVIDER_DEVICE_CODE,
            userCode: 'ABCD-1234',
            verificationUri: 'https://example.test/device',
            interval: INTERVAL,
            expiresIn: EXPIRES_IN,
          }),
        redeemDeviceAuthorization: () =>
          Promise.resolve(outcomes.shift() ?? { status: 'pending' as const }),
      },
      tokens: stubTokens().tokens,
      users: stubDirectory().users,
      now: time.now,
    });

    const survivors: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      survivors.push((await service.start()).deviceCode);
    }

    // Enough churn to force compaction many times over: with fifty live
    // records the queue is rebuilt roughly every twenty-five redemptions.
    for (let i = 0; i < 100; i += 1) {
      const doomed = (await service.start()).deviceCode;
      time.advance(INTERVAL);
      outcomes.push({ status: 'denied' });
      await expect(service.poll(doomed)).resolves.toMatchObject({ kind: 'denied' });
    }

    expect(service.size()).toBe(survivors.length);

    // Every one of them still resolves to its record rather than to the answer
    // an unknown code gets, which is what a compaction that dropped a live node
    // would look like from here.
    for (const survivor of survivors) {
      await expect(service.poll(survivor)).resolves.toMatchObject({ kind: 'pending' });
    }

    time.advance(INTERVAL);
    outcomes.push({ status: 'approved', identity });
    await expect(service.poll(survivors[0] ?? '')).resolves.toMatchObject({ kind: 'approved' });
    expect(service.size()).toBe(survivors.length - 1);
  });

  it('refuses an authorization the instant it expires, whatever has been reclaimed', async () => {
    // The acceptance criterion T-031 cares about most: expiry is decided
    // against the record's own instant, not against whether anything has swept
    // it away. Nothing but this poll ever runs, so no reclamation can have
    // happened before the answer is given.
    const time = clock();
    const stub = stubProvider(() => ({ status: 'pending' }));
    const service = createDeviceAuthorizationService({
      identityProvider: stub.provider,
      tokens: stubTokens().tokens,
      users: stubDirectory().users,
      now: time.now,
    });

    const deviceCode = (await service.start()).deviceCode;

    // Exactly the expiry instant, not a second past it: `expiresAtMs` is the
    // first moment the code is dead, and an off-by-one here is a credential
    // that outlives its own lifetime.
    time.advance(EXPIRES_IN);
    await expect(service.poll(deviceCode)).resolves.toEqual({ kind: 'expired' });
    expect(stub.polls()).toBe(0);
  });
});

describe('POST /auth/device/poll', () => {
  it('answers 428 while the user has not approved yet', async () => {
    const time = clock();
    const app = buildApp({
      provider: stubProvider(() => ({ status: 'pending' })).provider,
      now: time.now,
    });

    const deviceCode = await startFlow(app);
    time.advance(INTERVAL);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/device/poll',
      payload: { deviceCode },
    });

    expect(response.statusCode).toBe(428);
    expect(response.json()).toMatchObject({ error: { code: ErrorCode.AUTH_PENDING } });
    expect(response.headers[RETRY_AFTER_HEADER]).toBe(String(INTERVAL));
  });

  it('answers RATE_LIMITED to a client polling faster than it was told, without asking the provider', async () => {
    const time = clock();
    const stub = stubProvider(() => ({ status: 'pending' }));
    const app = buildApp({ provider: stub.provider, now: time.now });

    const deviceCode = await startFlow(app);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/device/poll',
      payload: { deviceCode },
    });

    // Not CONFLICT. Nothing collided; the request was fine and arrived early.
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ error: { code: ErrorCode.RATE_LIMITED } });
    expect(Number(response.headers[RETRY_AFTER_HEADER])).toBeGreaterThan(0);
    // The point of absorbing this locally: the provider's rate limit is not
    // spent on a client that cannot count.
    expect(stub.polls()).toBe(0);
  });

  it('never answers CONFLICT from the poll route, for any outcome the flow can reach', async () => {
    const time = clock();
    // Every non-approved outcome in turn, plus the too-fast case the route
    // produces on its own. CONFLICT is reserved for a collision with existing
    // state, and this endpoint has none to collide with.
    const outcomes: readonly DeviceAuthorizationOutcome[] = [
      { status: 'pending' },
      { status: 'slow_down', interval: 7 },
      { status: 'denied' },
      { status: 'expired' },
    ];

    for (const outcome of outcomes) {
      const app = buildApp({ provider: stubProvider(() => outcome).provider, now: time.now });
      const deviceCode = await startFlow(app);

      const tooFast = await app.inject({
        method: 'POST',
        url: '/auth/device/poll',
        payload: { deviceCode },
      });
      expect(tooFast.json()).not.toMatchObject({ error: { code: ErrorCode.CONFLICT } });

      time.advance(INTERVAL);
      const onTime = await app.inject({
        method: 'POST',
        url: '/auth/device/poll',
        payload: { deviceCode },
      });
      expect(onTime.json()).not.toMatchObject({ error: { code: ErrorCode.CONFLICT } });
    }
  });

  it('backs off and stays backed off when the provider says slow down', async () => {
    const time = clock();
    let outcome: DeviceAuthorizationOutcome = { status: 'slow_down', interval: 7 };
    const stub = stubProvider(() => outcome);
    const app = buildApp({ provider: stub.provider, now: time.now });

    const deviceCode = await startFlow(app);
    time.advance(INTERVAL);

    const slowed = await app.inject({
      method: 'POST',
      url: '/auth/device/poll',
      payload: { deviceCode },
    });

    expect(slowed.statusCode).toBe(429);
    expect(slowed.json()).toMatchObject({ error: { code: ErrorCode.RATE_LIMITED } });
    // The larger of the provider's number and our own increment: 5 + 5 beats 7.
    expect(response(slowed)).toBe(10);

    // The new interval sticks: polling at the old one is still too fast.
    outcome = { status: 'pending' };
    time.advance(INTERVAL);
    const tooSoon = await app.inject({
      method: 'POST',
      url: '/auth/device/poll',
      payload: { deviceCode },
    });
    expect(tooSoon.statusCode).toBe(429);

    time.advance(INTERVAL);
    const allowed = await app.inject({
      method: 'POST',
      url: '/auth/device/poll',
      payload: { deviceCode },
    });
    expect(allowed.statusCode).toBe(428);
  });

  it('answers 403 when the user refused in the browser', async () => {
    const time = clock();
    const app = buildApp({
      provider: stubProvider(() => ({ status: 'denied' })).provider,
      now: time.now,
    });

    const deviceCode = await startFlow(app);
    time.advance(INTERVAL);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/device/poll',
      payload: { deviceCode },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: ErrorCode.FORBIDDEN } });
  });

  it('answers 400 with a distinct code once the provider says the code expired', async () => {
    const time = clock();
    const app = buildApp({
      provider: stubProvider(() => ({ status: 'expired' })).provider,
      now: time.now,
    });

    const deviceCode = await startFlow(app);
    time.advance(INTERVAL);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/device/poll',
      payload: { deviceCode },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: ErrorCode.DEVICE_CODE_EXPIRED } });
  });

  it('expires a device code on its own clock, without asking the provider', async () => {
    const time = clock();
    const stub = stubProvider(() => ({ status: 'pending' }));
    const app = buildApp({ provider: stub.provider, now: time.now });

    const deviceCode = await startFlow(app);
    time.advance(EXPIRES_IN + 1);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/device/poll',
      payload: { deviceCode },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: ErrorCode.DEVICE_CODE_EXPIRED } });
    expect(stub.polls()).toBe(0);
  });

  it('answers an unknown device code exactly as it answers an expired one', async () => {
    const time = clock();
    const app = buildApp({
      provider: stubProvider(() => ({ status: 'pending' })).provider,
      now: time.now,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/device/poll',
      payload: { deviceCode: 'never-issued-by-this-server' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: ErrorCode.DEVICE_CODE_EXPIRED } });
  });

  it('issues credentials and the account on approval', async () => {
    const time = clock();
    const tokens = stubTokens();
    const directory = stubDirectory();
    const app = buildApp({
      provider: stubProvider(() => ({ status: 'approved', identity })).provider,
      tokens: tokens.tokens,
      users: directory.users,
      now: time.now,
    });

    const deviceCode = await startFlow(app);
    time.advance(INTERVAL);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/device/poll',
      payload: { deviceCode },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(PollDeviceAuthorizationResponseSchema.parse(response.json())).toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      user: account,
    });

    // The identity reaches the store as the provider described it, and the
    // credentials are minted for the account the store returned.
    expect(directory.seen()).toEqual([identity]);
    expect(tokens.issuedFor()).toEqual([account.id]);
  });

  it('redeems a device code exactly once', async () => {
    const time = clock();
    const app = buildApp({
      provider: stubProvider(() => ({ status: 'approved', identity })).provider,
      now: time.now,
    });

    const deviceCode = await startFlow(app);
    time.advance(INTERVAL);

    const first = await app.inject({
      method: 'POST',
      url: '/auth/device/poll',
      payload: { deviceCode },
    });
    expect(first.statusCode).toBe(200);

    time.advance(INTERVAL);
    const replay = await app.inject({
      method: 'POST',
      url: '/auth/device/poll',
      payload: { deviceCode },
    });

    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({ error: { code: ErrorCode.DEVICE_CODE_EXPIRED } });
  });

  it('issues no credentials when the account cannot be stored', async () => {
    const time = clock();
    const tokens = stubTokens();
    const directory = stubDirectory(() =>
      Promise.reject(new ProtocolError(ErrorCode.CONFLICT, 'That username already belongs to…')),
    );
    const app = buildApp({
      provider: stubProvider(() => ({ status: 'approved', identity })).provider,
      tokens: tokens.tokens,
      users: directory.users,
      now: time.now,
    });

    const deviceCode = await startFlow(app);
    time.advance(INTERVAL);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/device/poll',
      payload: { deviceCode },
    });

    expect(response.statusCode).toBe(409);
    expect(tokens.issuedFor()).toEqual([]);
  });

  it('rejects a body that is not a poll request', async () => {
    const time = clock();
    const app = buildApp({
      provider: stubProvider(() => ({ status: 'pending' })).provider,
      now: time.now,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/device/poll',
      payload: { notADeviceCode: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: ErrorCode.BAD_REQUEST } });
  });

  it('writes no device code to the log', async () => {
    const time = clock();
    const recorder = recordingLogger();
    const app = buildApp({
      provider: stubProvider(() => ({ status: 'pending' })).provider,
      now: time.now,
      logger: recorder.logger,
    });

    const deviceCode = await startFlow(app);
    time.advance(INTERVAL);
    await app.inject({ method: 'POST', url: '/auth/device/poll', payload: { deviceCode } });

    const log = recorder.lines.join('\n');
    expect(log).not.toContain(deviceCode);
    expect(log).not.toContain(PROVIDER_DEVICE_CODE);
  });
});

/** The `Retry-After` value of a response, as a number. */
function response(reply: { headers: Record<string, unknown> }): number {
  return Number(reply.headers[RETRY_AFTER_HEADER]);
}
