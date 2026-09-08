// biome-ignore-all lint/correctness/useImportExtensions: TypeScript's NodeNext resolution
// requires relative imports to name the *emitted* specifier, so `.js` is correct here and
// `.ts` would not compile. Biome's rule needs `forceJsExtensions: true` in biome.json to
// agree; that file belongs to another task, so this suppression stands in until it lands.
import { createServer } from 'node:net';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig, type ServerConfig } from '../src/config.js';
import { createDatabase, type Database } from '../src/db/client.js';

/**
 * `GET /healthz` against a real PostgreSQL server.
 *
 * Both outcomes are proven here, and neither is simulated. The 200 comes from a
 * `select 1` that actually reaches the database named by `DATABASE_URL`. The
 * 503 comes from pointing an otherwise identical server at an address where
 * nothing is listening, and then — for the stronger version of the same claim —
 * from taking the working database away from a server that was answering 200 a
 * moment earlier. Stubbing the client would prove only that the route can
 * format an error it was handed; the point of this endpoint is that the round
 * trip is real, so the failure has to be real too.
 */

/**
 * Finds a TCP port on the loopback interface that nothing is listening on.
 *
 * Binding port 0 lets the kernel pick one that is free right now; closing it
 * again leaves an address that refuses connections. This is how the test gets a
 * genuinely unreachable database without hard-coding a port some other process
 * on the machine might own.
 */
async function findClosedPort(): Promise<number> {
  const probe = createServer();

  const port = await new Promise<number>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('The probe server did not report a numeric address.'));
        return;
      }
      resolve(address.port);
    });
  });

  await new Promise<void>((resolve, reject) => {
    probe.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  return port;
}

/** Starts an app on an ephemeral loopback port and returns its base URL. */
async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.addresses()[0];
  if (address === undefined) {
    throw new Error('The server reported no listening address.');
  }
  return `http://127.0.0.1:${address.port}`;
}

/** Configuration built from the real DATABASE_URL the runner insisted on. */
const config: ServerConfig = loadConfig({
  DATABASE_URL: process.env['DATABASE_URL'],
  // A short pool timeout keeps the unreachable case fast; the connection is
  // refused long before it expires, so this only bounds the pathological case.
  DATABASE_CONNECTION_TIMEOUT_MS: '2000',
});

/** Silent, so a passing run does not bury the report in request logs. */
const logger = pino({ level: 'silent' });

let database: Database;
let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  database = createDatabase({ url: config.databaseUrl });
  app = createApp({ config, database, logger });
  baseUrl = await listen(app);
});

afterAll(async () => {
  await app.close();
  await database.close();
});

describe('GET /healthz with the database reachable', () => {
  it('returns 200 over real HTTP after a real query', async () => {
    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('proves the query really ran by making the same call directly', async () => {
    // If `ping` were a no-op the 200 above would mean nothing. This asserts the
    // same round trip the route performs, against the same pool.
    await expect(database.ping()).resolves.toBeUndefined();
  });
});

describe('GET /healthz with the database unreachable', () => {
  it('returns 503 when nothing is listening at the configured address', async () => {
    const port = await findClosedPort();
    const deadConfig = loadConfig({
      DATABASE_URL: `postgres://agentchat:agentchat@127.0.0.1:${port}/agentchat`,
      DATABASE_CONNECTION_TIMEOUT_MS: '2000',
    });

    const deadDatabase = createDatabase({
      url: deadConfig.databaseUrl,
      connectionTimeoutMillis: deadConfig.database.connectionTimeoutMillis,
      // The pool must not take the process down when it fails on its own.
      onIdleError: () => undefined,
    });
    const deadApp = createApp({ config: deadConfig, database: deadDatabase, logger });

    try {
      const url = await listen(deadApp);
      const response = await fetch(`${url}/healthz`);

      expect(response.status).toBe(503);
      const body: unknown = await response.json();
      expect(body).toEqual({
        status: 'error',
        checks: { database: 'error' },
        error: { code: 'DATABASE_UNAVAILABLE', message: 'The database is not reachable.' },
      });
      // The refused address is a deployment detail; it goes to the log.
      expect(JSON.stringify(body)).not.toContain(String(port));
    } finally {
      await deadApp.close();
      await deadDatabase.close();
    }
  });

  it('returns 503 when a database that was working is taken away', async () => {
    // The sharpest version of the claim: one server, one code path, answering
    // 200 a moment ago. Nothing about the route changed — only the database
    // did. This runs last because it deliberately breaks the shared pool.
    const before = await fetch(`${baseUrl}/healthz`);
    expect(before.status).toBe(200);

    await database.close();

    const after = await fetch(`${baseUrl}/healthz`);

    expect(after.status).toBe(503);
    expect(await after.json()).toMatchObject({
      status: 'error',
      error: { code: 'DATABASE_UNAVAILABLE' },
    });
  });
});
