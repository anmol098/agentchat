/**
 * What the upgrade path answers when it will not become a socket (T-057).
 *
 * `server/tests/websocket-wiring.integration.test.ts` proves the upgrade that
 * succeeds, and needs a database to do it because a socket has to bind to a
 * registered session. Everything here is decided *before* any of that: the
 * version floor and the credential are read off the request headers by
 * `handler.authenticate`, and a refusal is written straight to the raw socket.
 * So this suite listens on a real port, sends real upgrade requests, and never
 * dials Postgres.
 *
 * Two things it exists to pin, neither of which `app.inject` can see, because
 * an upgrade never reaches Fastify's router and therefore runs no `onRequest`
 * hook, no route handler and no `onSend`:
 *
 * - **The floor binds the socket path.** T-042 enforced it here, on the
 *   `X-AgentChat-Client` header, and the client this project ships sent that
 *   header on every HTTP request except the one that matters. The header on the
 *   upgrade is what makes the guard reach a real client, so the case worth
 *   pinning is a below-floor client *carrying a valid credential*: it must be
 *   refused for its version rather than served.
 * - **`WWW-Authenticate` belongs to the 401 alone.** `refuseUpgrade` took the
 *   challenge unconditionally, so the `426` and the `400` both answered
 *   `www-authenticate: Bearer` — an invitation to present a different
 *   credential, in answer to two refusals a different credential cannot fix.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  CLIENT_VERSION_HEADER,
  ErrorCode,
  formatClientVersionHeader,
  MIN_CLIENT_VERSION,
  UserId,
  upgradeRequiredMessage,
} from '@agentchat/protocol';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import pino, { type Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createApp, WEBSOCKET_PATH } from '../src/app.js';
import { MIN_JWT_SECRET_LENGTH, signAccessToken } from '../src/auth/tokens.js';
import { loadConfig } from '../src/config.js';

/** The signing key for this run. */
const JWT_SECRET = randomUUID()
  .repeat(2)
  .slice(0, MIN_JWT_SECRET_LENGTH + 8);

/** A release below {@link MIN_CLIENT_VERSION}, as the header carries it. */
const TOO_OLD = formatClientVersionHeader('0.0.1');

/** This build's own floor, as the header carries it. A client exactly at it is served. */
const AT_THE_FLOOR = formatClientVersionHeader(MIN_CLIENT_VERSION);

let app: FastifyInstance;

/** Where the listening server is, e.g. `ws://127.0.0.1:54123`. */
let origin: string;

/** A credential this app verifies, for a user no query ever looks for. */
let bearer: string;

/**
 * A Drizzle handle over a pool that is never dialled.
 *
 * `createApp` builds its services over this, and `pg` opens no socket until
 * somebody asks it for a connection. No refusal in this file gets far enough to
 * ask: the version check and the token check both read headers and return.
 *
 * @returns The handle.
 */
function idleDatabase(): NodePgDatabase<Record<string, never>> {
  return drizzle(new Pool({ connectionString: 'postgres://agentchat:agentchat@127.0.0.1:5432/x' }));
}

/** Silent, because this suite asserts on what a client receives, not on logs. */
function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

beforeAll(async () => {
  const config = loadConfig({
    DATABASE_URL: 'postgres://agentchat:agentchat@127.0.0.1:5432/x',
    LOG_LEVEL: 'silent',
    JWT_SECRET,
    GITHUB_CLIENT_ID: 'test-client-id',
    GITHUB_CLIENT_SECRET: 'test-client-secret',
  });

  const database = { ping: () => Promise.resolve(), db: idleDatabase() };
  app = createApp({ config, database, logger: silentLogger() });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the test server did not report a port');
  }
  origin = `ws://127.0.0.1:${address.port}`;

  const issuedAt = Math.floor(Date.now() / 1_000);
  bearer = signAccessToken(
    { sub: UserId.generate(), iat: issuedAt, exp: issuedAt + 3_600 },
    JWT_SECRET,
  );
});

afterAll(async () => {
  await app?.close();
});

/** What the server answered an upgrade it would not accept with. */
interface Refusal {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: unknown;
}

/**
 * Asks for an upgrade that is expected to fail, and reads the HTTP answer.
 *
 * The answer is the point, and it is the whole reason these refusals are HTTP
 * rather than close codes: an upgrade is decided while HTTP is still available,
 * so a client can be told a status, a code and a sentence instead of an opaque
 * `1006`.
 *
 * @param headers - Request headers, if any.
 * @returns The status, headers and parsed body.
 */
function refusedUpgrade(headers: Record<string, string> = {}): Promise<Refusal> {
  return new Promise<Refusal>((resolve, reject) => {
    const socket = new WebSocket(`${origin}${WEBSOCKET_PATH}`, { headers });

    socket.on('open', () => {
      socket.close();
      reject(new Error('the upgrade completed when it should have been refused'));
    });

    socket.on('unexpected-response', (_request, response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: text === '' ? undefined : (JSON.parse(text) as unknown),
        });
      });
    });

    socket.on('error', reject);
  });
}

describe('the upgrade refuses a client below the version floor', () => {
  it('refuses a below-floor client that holds a perfectly good credential', async () => {
    // The case the header on the upgrade is for. Without it this request is
    // indistinguishable from a current client's and is upgraded, which is what
    // made T-042's guard bind nobody: the floor was enforced on a header the
    // shipped client never sent here.
    const refusal = await refusedUpgrade({
      authorization: `Bearer ${bearer}`,
      [CLIENT_VERSION_HEADER]: TOO_OLD,
    });

    expect(refusal.statusCode).toBe(426);
    expect(refusal.body).toEqual({
      error: {
        code: ErrorCode.UPGRADE_REQUIRED,
        // Byte-identical to the HTTP path's, because both build it with
        // `upgradeRequiredMessage`. Two sentences for one rule is worse than
        // one sentence in one place.
        message: upgradeRequiredMessage(MIN_CLIENT_VERSION),
      },
    });
  });

  it('decides the version before the credential, so a token is not the missing piece', async () => {
    const refusal = await refusedUpgrade({ [CLIENT_VERSION_HEADER]: TOO_OLD });

    // Both statements are true of this request and only one is actionable. A
    // 401 would send the user to log in again, which fixes nothing.
    expect(refusal.statusCode).toBe(426);
  });

  it('serves a client exactly at the floor, which then fails on the credential instead', async () => {
    const refusal = await refusedUpgrade({ [CLIENT_VERSION_HEADER]: AT_THE_FLOOR });

    expect(refusal.statusCode).toBe(401);
    expect(refusal.body).toMatchObject({ error: { code: ErrorCode.AUTH_REQUIRED } });
  });

  it('refuses a malformed client identifier rather than treating it as absent', async () => {
    const refusal = await refusedUpgrade({
      authorization: `Bearer ${bearer}`,
      [CLIENT_VERSION_HEADER]: 'agentchat/not-a-version',
    });

    expect(refusal.statusCode).toBe(400);
    expect(refusal.body).toMatchObject({ error: { code: ErrorCode.BAD_REQUEST } });
  });
});

describe('the upgrade challenges only where a credential is the answer', () => {
  it('sends WWW-Authenticate with the 401, where a different credential would help', async () => {
    const refusal = await refusedUpgrade();

    expect(refusal.statusCode).toBe(401);
    expect(refusal.headers['www-authenticate']).toBe('Bearer');
  });

  it('sends no WWW-Authenticate with the 426, which no credential can fix', async () => {
    const refusal = await refusedUpgrade({
      authorization: `Bearer ${bearer}`,
      [CLIENT_VERSION_HEADER]: TOO_OLD,
    });

    // The header reads as "authenticate and try again" to anything parsing the
    // exchange, and `curl -v` prints it. Here the credential was accepted-shaped
    // and irrelevant; the remedy is in the body, and it is to upgrade.
    expect(refusal.headers['www-authenticate']).toBeUndefined();
  });

  it('sends no WWW-Authenticate with the 400 from a malformed client identifier', async () => {
    const refusal = await refusedUpgrade({
      [CLIENT_VERSION_HEADER]: 'agentchat/not-a-version',
    });

    expect(refusal.statusCode).toBe(400);
    expect(refusal.headers['www-authenticate']).toBeUndefined();
  });
});
