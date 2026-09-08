import { UserId } from '@agentchat/protocol';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import Fastify, {
  type FastifyBaseLogger,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import { Pool } from 'pg';
import pino, { type Logger } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { type AppDatabase, createApp, PUBLIC_ROUTES, REQUEST_ID_HEADER } from '../src/app.js';
import { MIN_JWT_SECRET_LENGTH, signAccessToken } from '../src/auth/tokens.js';
import { loadConfig, type ServerConfig } from '../src/config.js';
import { type HealthProbe, registerHealthRoutes } from '../src/routes/health.js';

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

  it('declares exactly the unauthenticated surface Plan section 3 lists', () => {
    expect([...PUBLIC_ROUTES].sort()).toEqual([
      '/auth/device/poll',
      '/auth/device/start',
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
