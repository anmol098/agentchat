// biome-ignore-all lint/correctness/useImportExtensions: TypeScript's NodeNext resolution
// requires relative imports to name the *emitted* specifier, so `.js` is correct here and
// `.ts` would not compile. Biome's rule needs `forceJsExtensions: true` in biome.json to
// agree; that file belongs to another task, so this suppression stands in until it lands.
import Fastify, {
  type FastifyBaseLogger,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import pino, { type Logger } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, REQUEST_ID_HEADER } from '../src/app.js';
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

const config: ServerConfig = loadConfig({
  DATABASE_URL: 'postgres://agentchat:agentchat@localhost:5432/agentchat',
  LOG_LEVEL: 'info',
});

const started: { close(): Promise<unknown> }[] = [];

/** Builds an app and registers it for teardown. */
function buildApp(database: HealthProbe, logger: Logger) {
  const app = createApp({ config, database, logger });
  started.push(app);
  return app;
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

    const response = await app.inject({ method: 'GET', url: '/nope' });

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
