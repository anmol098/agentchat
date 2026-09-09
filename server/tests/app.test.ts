import {
  CLIENT_VERSION_HEADER,
  ErrorCode,
  MIN_CLIENT_VERSION,
  PROTOCOL_VERSION,
  UserId,
  upgradeRequiredMessage,
} from '@agentchat/protocol';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import Fastify, {
  type FastifyBaseLogger,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import { Pool } from 'pg';
import pino, { type Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AppDatabase, createApp, PUBLIC_ROUTES, REQUEST_ID_HEADER } from '../src/app.js';
import { MIN_JWT_SECRET_LENGTH, signAccessToken } from '../src/auth/tokens.js';
import { loadConfig, type ServerConfig } from '../src/config.js';
import { type HealthProbe, registerHealthRoutes } from '../src/routes/health.js';
import { SERVER_VERSION } from '../src/routes/version.js';

/**
 * Unit tests for the application wiring: request identifiers, log structure,
 * the error envelope and the shape of the health response.
 *
 * These use a stub probe and never open a socket to Postgres. They are about
 * what the HTTP layer does with the result of a health check, not about whether
 * the check is real — that is what
 * `server/tests/health.integration.test.ts` exists to prove, against a database
 * that is genuinely there and then genuinely not.
 */

/** Collects the JSON records a logger emits, so a test can read them back. */
function recordingLogger(): { logger: Logger; records: () => Record<string, unknown>[] } {
  const lines: string[] = [];

  const logger = pino(
    { level: 'info', base: null, timestamp: false },
    {
      write(line: string): void {
        lines.push(line);
      },
    },
  );

  return {
    logger,
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** A probe that always says the database is fine. */
const reachable: HealthProbe = { ping: () => Promise.resolve() };

/** A probe that fails the way `pg` does when nothing is listening. */
const unreachable: HealthProbe = {
  ping: () =>
    Promise.reject(
      Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432'), { code: 'ECONNREFUSED' }),
    ),
};

/** The signing key this suite's tokens are made with. */
const JWT_SECRET = 'j'.repeat(MIN_JWT_SECRET_LENGTH);

const config: ServerConfig = loadConfig({
  DATABASE_URL: 'postgres://agentchat:agentchat@localhost:5432/agentchat',
  LOG_LEVEL: 'info',
  JWT_SECRET,
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
});

/**
 * A Drizzle handle over a pool that is never dialled.
 *
 * `createApp` builds the login flow's user directory and refresh-token store
 * over this, so it has to be a real handle rather than a shape. No test in this
 * file reaches a route that queries — the login flow against a real database is
 * `server/tests/auth-wiring.integration.test.ts` — and `pg` opens no socket
 * until somebody asks it for a connection, so nothing here connects.
 */
function idleDatabase(): NodePgDatabase<Record<string, never>> {
  return drizzle(new Pool({ connectionString: config.databaseUrl }));
}

const started: { close(): Promise<unknown> }[] = [];

/** Builds an app and registers it for teardown. */
function buildApp(probe: HealthProbe, logger: Logger) {
  const database: AppDatabase = { ping: probe.ping.bind(probe), db: idleDatabase() };
  const app = createApp({ config, database, logger });
  started.push(app);
  return app;
}

/** A bearer credential this app should accept, for a user that need not exist. */
function bearerToken(): string {
  const issuedAt = Math.floor(Date.now() / 1_000);
  return signAccessToken(
    { sub: UserId.generate(), iat: issuedAt, exp: issuedAt + 3_600 },
    JWT_SECRET,
  );
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((app) => app.close()));
});

describe('createApp', () => {
  it('answers GET /healthz with 200 when the probe succeeds', async () => {
    const app = buildApp(reachable, recordingLogger().logger);

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });
    // A cached health check reports the state of whichever server answered
    // first, for as long as the cache lives.
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('answers GET /healthz with 503 when the probe fails, without leaking why', async () => {
    const app = buildApp(unreachable, recordingLogger().logger);

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'error',
      checks: { database: 'error' },
      error: { code: 'DATABASE_UNAVAILABLE', message: 'The database is not reachable.' },
    });
    // Hosts, ports and credentials belong in the log, not in a response any
    // unauthenticated caller can read.
    expect(response.body).not.toContain('ECONNREFUSED');
    expect(response.body).not.toContain('10.1.2.3');
  });

  it('logs the driver error behind a 503 so an operator can still diagnose it', async () => {
    const { logger, records } = recordingLogger();
    const app = buildApp(unreachable, logger);

    await app.inject({ method: 'GET', url: '/healthz' });

    const failure = records().find(
      (record) => record['msg'] === 'health check failed: database unreachable',
    );
    expect(failure).toBeDefined();
    expect(JSON.stringify(failure)).toContain('ECONNREFUSED');
  });

  it('gives every request an identifier and echoes it back', async () => {
    const app = buildApp(reachable, recordingLogger().logger);

    const response = await app.inject({ method: 'GET', url: '/healthz' });
    const id = response.headers[REQUEST_ID_HEADER];

    expect(typeof id).toBe('string');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('adopts a well-formed request identifier supplied by a proxy', async () => {
    const app = buildApp(reachable, recordingLogger().logger);

    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { [REQUEST_ID_HEADER]: 'edge-7f3a91' },
    });

    expect(response.headers[REQUEST_ID_HEADER]).toBe('edge-7f3a91');
  });

  it('replaces a request identifier that could forge a log record', async () => {
    const app = buildApp(reachable, recordingLogger().logger);

    const forged = 'abc"} {"level":60,"msg":"database deleted';
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { [REQUEST_ID_HEADER]: forged },
    });

    expect(response.headers[REQUEST_ID_HEADER]).not.toBe(forged);
  });

  it('writes structured records carrying the request identifier', async () => {
    const { logger, records } = recordingLogger();
    const app = buildApp(reachable, logger);

    await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { [REQUEST_ID_HEADER]: 'trace-42' },
    });

    const requestRecords = records().filter((record) => record['reqId'] === 'trace-42');

    // Both ends of the request, so a log reader can measure it.
    expect(requestRecords.map((record) => record['msg'])).toEqual(
      expect.arrayContaining(['incoming request', 'request completed']),
    );
    // Structured, not a formatted string: every record is a JSON object with a
    // level, which is what makes the log queryable.
    for (const record of requestRecords) {
      expect(typeof record['level']).toBe('number');
    }
  });

  it('returns the documented error envelope for an unknown route', async () => {
    const app = buildApp(reachable, recordingLogger().logger);

    const response = await app.inject({
      method: 'GET',
      url: '/nope',
      headers: { authorization: `Bearer ${bearerToken()}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('applies the 2 MiB body limit from the configuration', async () => {
    const app = buildApp(reachable, recordingLogger().logger);
    await app.ready();

    expect(app.initialConfig.bodyLimit).toBe(config.bodyLimitBytes);
    expect(config.bodyLimitBytes).toBe(2 * 1024 * 1024);
  });
});

/**
 * The authentication wiring (T-019).
 *
 * `createApp` is where the device flow, the token service and the bearer plugin
 * meet, and until this task none of the three was reachable from a running
 * server. What is asserted here is the wiring itself: that the guard is
 * installed, that the unauthenticated surface is exactly the declared one, and
 * that a token this server would issue is accepted on a route nobody annotated.
 *
 * The whole login path against a real Postgres and a real token service is
 * `server/tests/auth-wiring.integration.test.ts`; nothing here stubs the plugin
 * or the token service either, but the identity provider is stubbed because a
 * unit test may not reach github.com.
 */
describe('createApp wires authentication', () => {
  /** An identity provider that fails if it is ever polled; only `start` is used. */
  const provider = {
    startDeviceAuthorization: () =>
      Promise.resolve({
        deviceCode: 'provider-device-code',
        userCode: 'ABCD-1234',
        verificationUri: 'https://example.test/device',
        interval: 5,
        expiresIn: 900,
      }),
    redeemDeviceAuthorization: () => Promise.reject(new Error('not polled by this suite')),
  };

  /** Builds the real application with only the provider substituted. */
  function buildAuthenticatedApp(logger: Logger = recordingLogger().logger) {
    const app = createApp({
      config,
      database: { ping: reachable.ping.bind(reachable), db: idleDatabase() },
      logger,
      identityProvider: provider,
    });
    started.push(app);
    return app;
  }

  // The list is written out rather than derived, so that widening the
  // unauthenticated surface cannot be done without a reviewer seeing a diff
  // that says so. `/auth/refresh` was added by T-043: a client whose access
  // token has expired has only a refresh token, so a route that demanded an
  // access token would be unreachable in the one situation it exists for. The
  // credential it does verify is the refresh token, checked against a stored
  // digest by the token service.
  it('declares exactly the unauthenticated surface Plan section 3 lists', () => {
    expect([...PUBLIC_ROUTES].sort()).toEqual([
      '/auth/device/poll',
      '/auth/device/start',
      '/auth/refresh',
      '/healthz',
      '/version',
    ]);
  });

  it('leaves the declared public routes open', async () => {
    const app = buildAuthenticatedApp();

    const health = await app.inject({ method: 'GET', url: '/healthz' });
    const start = await app.inject({ method: 'POST', url: '/auth/device/start', payload: {} });

    // Both without a credential: this is how a client acquires one.
    expect(health.statusCode).toBe(200);
    expect(start.statusCode).toBe(200);
  });

  it('protects a route that says nothing about authentication', async () => {
    const app = buildAuthenticatedApp();
    app.get('/says-nothing', (request) => ({ userId: request.requireUser().id }));

    const anonymous = await app.inject({ method: 'GET', url: '/says-nothing' });

    // The route was registered after `registerAuth` ran and declared no stance.
    // Both facts matter: the guard covers what comes later, and silence means
    // protected. A milestone 1 route author has to do nothing to get this.
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
    expect(anonymous.headers['www-authenticate']).toBe('Bearer');
  });

  it('accepts a token signed with the configured secret on that same route', async () => {
    const app = buildAuthenticatedApp();
    app.get('/says-nothing', (request) => ({ userId: request.requireUser().id }));

    const response = await app.inject({
      method: 'GET',
      url: '/says-nothing',
      headers: { authorization: `Bearer ${bearerToken()}` },
    });

    // The plugin verifies against `config.jwtSecret`, which is the same value
    // the token service signs with. Getting those two out of step is the one
    // way this wiring could look right and reject every real login.
    expect(response.statusCode).toBe(200);
    expect(String(response.json().userId)).toMatch(/^usr_/);
  });

  it('refuses an unmatched route rather than saying whether it exists', async () => {
    const app = buildAuthenticatedApp();

    const response = await app.inject({ method: 'GET', url: '/no-such-route' });

    expect(response.statusCode).toBe(401);
  });

  it('states the unauthenticated surface in the boot log', () => {
    const { logger, records } = recordingLogger();
    buildAuthenticatedApp(logger);

    const declared = records().find(
      (record) => record['msg'] === 'routes declared as unauthenticated',
    );

    // An opt-out nobody notices in review is the one real risk of this scheme,
    // so the surface has to be readable off a boot log rather than reassembled
    // by grepping route files.
    expect(declared?.['routes']).toEqual([...PUBLIC_ROUTES]);
  });
});

/**
 * Version negotiation, on the assembled application (T-041).
 *
 * `server/src/routes/version.ts` was finished, tested against an instance of
 * its own, and called from nowhere: the endpoint 404'd and no client was ever
 * refused for being too old. `routes/version.test.ts` still proves what the
 * module does. This proves that the server a deployment runs *calls* it, and
 * the two things that can only be got wrong here:
 *
 * - **the endpoint answers without a credential** — it is public because
 *   `PUBLIC_ROUTES` names it, and a route absent from that list is protected by
 *   omission, so registering it and forgetting the declaration yields a 401 on
 *   the one endpoint that has to work for a client holding nothing;
 * - **the refusal comes before authentication** — both hooks are `onRequest`
 *   and run in registration order, so a client below the floor that also has no
 *   token is told which of the two facts it can act on.
 */
describe('createApp wires version negotiation', () => {
  /** An identity provider that is never reached; this suite touches no login. */
  const provider = {
    startDeviceAuthorization: () => Promise.reject(new Error('not started by this suite')),
    redeemDeviceAuthorization: () => Promise.reject(new Error('not polled by this suite')),
  };

  /** The real application, with only the provider substituted. */
  function buildApplication() {
    const app = createApp({
      config,
      database: { ping: reachable.ping.bind(reachable), db: idleDatabase() },
      logger: recordingLogger().logger,
      identityProvider: provider,
    });
    started.push(app);
    return app;
  }

  /** A release below `MIN_CLIENT_VERSION`, as the header carries it. */
  const tooOld = `agentchat/${'0.0.9'}`;

  it('answers GET /version without a credential', async () => {
    const app = buildApplication();

    const response = await app.inject({ method: 'GET', url: '/version' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      version: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      minClientVersion: MIN_CLIENT_VERSION,
    });
  });

  it('refuses a client below the floor with the upgrade instruction, not a 401', async () => {
    const app = buildApplication();

    // No `authorization` header either. Both refusals are available and the
    // order of the two hooks is what picks between them: only one of these two
    // true statements tells the caller what to do about it.
    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { [CLIENT_VERSION_HEADER]: tooOld },
    });

    expect(response.statusCode).toBe(426);
    expect(response.json()).toEqual({
      error: {
        code: ErrorCode.UPGRADE_REQUIRED,
        message: upgradeRequiredMessage(MIN_CLIENT_VERSION),
      },
    });

    // The message is the remedy, and it has to be, because a client this old
    // may predate every line of code that could have composed one for itself.
    expect(response.json().error.message).toContain(MIN_CLIENT_VERSION);
  });

  it('still tells a too-old client what to upgrade to, on the endpoint that says so', async () => {
    const app = buildApplication();

    const response = await app.inject({
      method: 'GET',
      url: '/version',
      headers: { [CLIENT_VERSION_HEADER]: tooOld },
    });

    // Guarding this would answer "you are too old" to the one question whose
    // answer says how to stop being too old.
    expect(response.statusCode).toBe(200);
    expect(response.json().minClientVersion).toBe(MIN_CLIENT_VERSION);
  });

  it('does not let an ancient curl in a smoke test make a healthy server look unhealthy', async () => {
    const app = buildApplication();

    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { [CLIENT_VERSION_HEADER]: tooOld },
    });

    expect(response.statusCode).toBe(200);
  });

  it('serves a caller that announces nothing, because the header is optional', async () => {
    const app = buildApplication();

    // A third-party harness embedding `@agentchat/client` is not the CLI and
    // has no release to claim. It reaches authentication like anybody else,
    // which is what the 401 here shows.
    const response = await app.inject({ method: 'GET', url: '/me' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: ErrorCode.AUTH_REQUIRED } });
  });

  it.each([
    ['at the floor', MIN_CLIENT_VERSION],
    ['newer than the server', '99.0.0'],
  ])('lets a client %s through the guard to authentication', async (_case, version) => {
    const app = buildApplication();

    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { [CLIENT_VERSION_HEADER]: `agentchat/${version}` },
    });

    // Deliberately without a token, so the answer says which hook stopped it.
    // A client newer than the server is not refused at all — that direction is
    // the client's own single stderr warning, never the server's business.
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: ErrorCode.AUTH_REQUIRED } });
  });

  it('refuses a version it cannot compare rather than treating it as absent', async () => {
    const app = buildApplication();

    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { [CLIENT_VERSION_HEADER]: 'agentchat/not-a-version' },
    });

    // Silently reading a malformed value as "no header" would turn "I claim to
    // be 0.0.1" into free passage past the floor.
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: ErrorCode.BAD_REQUEST } });
  });
});

/**
 * Every interval this application starts is stopped when it closes (T-041).
 *
 * There are two — the session sweeper and the heartbeat — created by different
 * modules and stopped by different hooks. A leaked one is invisible: both are
 * `unref`ed as belt-and-braces, so the process still exits and nothing fails,
 * and the only symptom is a server that goes on pinging sockets it has already
 * closed and a test run doing work after its last assertion.
 *
 * Counting handles rather than reaching into either module is what makes this
 * survive a third timer: an interval added tomorrow and stopped by nobody fails
 * this test on the day it is written, which is the only day it is cheap to fix.
 */
describe('createApp stops every timer it starts', () => {
  it('clears each interval it created by the time close() resolves', async () => {
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;

    /** Intervals started and not yet cleared. */
    const live = new Set<NodeJS.Timeout>();

    const started = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation((...args: Parameters<typeof setInterval>) => {
        const timer = realSetInterval(...args);
        live.add(timer);
        return timer;
      });

    const stopped = vi
      .spyOn(globalThis, 'clearInterval')
      .mockImplementation((timer?: NodeJS.Timeout | string | number) => {
        if (typeof timer === 'object') {
          live.delete(timer);
        }
        realClearInterval(timer);
      });

    try {
      const app = createApp({
        config,
        database: { ping: reachable.ping.bind(reachable), db: idleDatabase() },
        logger: recordingLogger().logger,
        identityProvider: {
          startDeviceAuthorization: () => Promise.reject(new Error('not started by this suite')),
          redeemDeviceAuthorization: () => Promise.reject(new Error('not polled by this suite')),
        },
      });

      // Both start at construction: the sweeper in `startSessionSweeper`, the
      // heartbeat in `createHeartbeat`. Asserted, because a run in which
      // nothing was started would make the real assertion below vacuous.
      expect(live.size).toBeGreaterThanOrEqual(2);

      await app.close();

      expect(
        live.size,
        'createApp started an interval that closing the application does not clear.',
      ).toBe(0);
    } finally {
      started.mockRestore();
      stopped.mockRestore();
    }
  });
});

describe('health route timeout', () => {
  it('reports 503 rather than hanging when the database never answers', async () => {
    // The logger generic is pinned for the same reason `createApp` pins it:
    // inferring pino's concrete `Logger` specialises every route signature.
    const app = Fastify<
      RawServerDefault,
      RawRequestDefaultExpression,
      RawReplyDefaultExpression,
      FastifyBaseLogger
    >({ loggerInstance: recordingLogger().logger });
    started.push(app);

    // A probe that never settles is what a half-open connection to a wedged
    // database looks like: no error, no answer.
    registerHealthRoutes(app, {
      database: { ping: () => new Promise<void>(() => {}) },
      timeoutMs: 50,
    });

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'DATABASE_UNAVAILABLE' } });
  });
});
