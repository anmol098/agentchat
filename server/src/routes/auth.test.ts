/**
 * The device-flow routes, over a real Fastify instance and a stubbed identity
 * provider.
 *
 * The app is built by `createApp` rather than assembled here, so every
 * assertion about a status or an error code is an assertion about what a client
 * actually receives: the codes travel through the same error handler,
 * `toErrorResponse` and outbound `ErrorCodeSchema` check that T-015 installed
 * for every route.
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

import { createApp } from '../app.js';
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
});

/** The health probe `createApp` requires; no route under test uses it. */
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
  const app = createApp({ config, database, logger });

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

  it('refuses a client polling faster than it was told, without asking the provider', async () => {
    const time = clock();
    const stub = stubProvider(() => ({ status: 'pending' }));
    const app = buildApp({ provider: stub.provider, now: time.now });

    const deviceCode = await startFlow(app);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/device/poll',
      payload: { deviceCode },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: ErrorCode.CONFLICT } });
    expect(Number(response.headers[RETRY_AFTER_HEADER])).toBeGreaterThan(0);
    // The point of absorbing this locally: the provider's rate limit is not
    // spent on a client that cannot count.
    expect(stub.polls()).toBe(0);
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

    expect(slowed.statusCode).toBe(409);
    expect(slowed.json()).toMatchObject({ error: { code: ErrorCode.CONFLICT } });
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
    expect(tooSoon.statusCode).toBe(409);

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
