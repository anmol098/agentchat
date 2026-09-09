/**
 * Logging in, end to end, against the server a deployment actually runs.
 *
 * Everything else about authentication is already tested, and none of it proved
 * this. `routes/auth.test.ts` drives the device flow with a stubbed token
 * service and a stubbed user store. `auth/tokens.integration.test.ts` proves
 * rotation and reuse detection with no HTTP anywhere near it.
 * `plugins/auth.test.ts` proves the guard against tokens it signed itself. Each
 * is honest about its seams, and between them they leave exactly one question
 * open: whether the pieces fit.
 *
 * They did not. Until T-019 nothing called `registerAuthRoutes` or
 * `registerAuth`, and `config.ts` read none of their variables — three tasks
 * each correctly declining to edit a file they did not own, and a login that
 * did not work.
 *
 * So this suite stubs one thing and one thing only: the identity provider,
 * because a test may not reach github.com. The application is `createApp`, the
 * database is a real PostgreSQL, the token service is the real one writing real
 * rows, and the guard is the real plugin verifying a token it has never seen
 * before against the configured secret. The chain asserted is the whole
 * product: **an unauthenticated request is refused, the device flow completes,
 * and the token it returns is accepted on that same route.**
 *
 * The suite owns a freshly created database, for the reason
 * `db/schema/tests/identity.integration.test.ts` gives: integration tests share
 * one server, and rows written here must not disturb another suite's.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { UserId, UserSchema } from '@agentchat/protocol';
import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import pino, { type Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type {
  DeviceAuthorizationOutcome,
  IdentityProvider,
  ProviderIdentity,
} from '../src/auth/identity.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  hashRefreshToken,
  MIN_JWT_SECRET_LENGTH,
  signAccessToken,
} from '../src/auth/tokens.js';
import { loadConfig, type ServerConfig } from '../src/config.js';
import { refreshTokens, users } from '../src/db/schema/identity.js';

/** The generated SQL migrations, exactly as the server image will ship them. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

/**
 * The signing key for this run. Real bytes, and one of the values the log sweep
 * at the end of this file looks for.
 */
const JWT_SECRET = randomUUID()
  .repeat(2)
  .slice(0, MIN_JWT_SECRET_LENGTH + 8);

/** The identity provider's client secret. Also swept for. */
const GITHUB_CLIENT_SECRET = `ghs_${randomUUID()}`;

/** The provider's own device code. It must never reach the wire or a log. */
const PROVIDER_DEVICE_CODE = `provider-device-code-${randomUUID()}`;

/** Seconds the stub provider advertises between polls. The contract's minimum. */
const INTERVAL = 1;

/** A short unique suffix for names that must not collide between runs. */
const unique = (): string => randomUUID().replaceAll('-', '').slice(0, 12);

let pool: Pool;
let db: NodePgDatabase<Record<string, never>>;
let databaseName: string;

/** Connection string for `databaseName` on the server `DATABASE_URL` names. */
function urlForScratchDatabase(name: string): string {
  const raw = process.env['DATABASE_URL'];
  if (raw === undefined) {
    throw new Error('DATABASE_URL is not set; the global setup should have refused to start.');
  }

  const url = new URL(raw);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Collects every log line the server writes, so a test can search them. */
function recordingLogger(): { logger: Logger; text: () => string } {
  const lines: string[] = [];

  const logger = pino(
    { level: 'trace', base: null, timestamp: false },
    {
      write(line: string): void {
        lines.push(line);
      },
    },
  );

  return { logger, text: () => lines.join('\n') };
}

/**
 * An identity provider that approves after the given number of polls.
 *
 * The only stub in this file. It answers in RFC 8628's vocabulary, which is the
 * seam `auth/identity.ts` defines, so nothing here knows or cares that the
 * production implementation talks to GitHub.
 */
function stubProvider(identity: ProviderIdentity, pendingPolls: number): IdentityProvider {
  let polls = 0;

  return {
    startDeviceAuthorization: () =>
      Promise.resolve({
        deviceCode: PROVIDER_DEVICE_CODE,
        userCode: 'WDJB-MJHT',
        verificationUri: 'https://example.test/device',
        interval: INTERVAL,
        expiresIn: 900,
      }),

    redeemDeviceAuthorization: (deviceCode: string): Promise<DeviceAuthorizationOutcome> => {
      // The server brokers rather than proxies: whatever the client sent, what
      // reaches the provider is the provider's own code.
      expect(deviceCode).toBe(PROVIDER_DEVICE_CODE);

      polls += 1;
      return Promise.resolve(
        polls > pendingPolls ? { status: 'approved', identity } : { status: 'pending' },
      );
    },
  };
}

/** An identity as a provider adapter hands one over: username already lowercased. */
function identityFor(): ProviderIdentity {
  return {
    subject: `gh-${unique()}`,
    username: `alice-${unique()}`,
    displayName: 'Alice Smith',
    email: 'alice@example.com',
  };
}

const started: FastifyInstance[] = [];

/**
 * Builds the real application over the scratch database.
 *
 * The one protected route is registered here rather than being one of the
 * server's own, because the server has none yet: every route in milestone 1 is
 * still to be written, and this is the shape each will take — a handler that
 * calls `requireUser()` and says nothing at all about authentication.
 */
function buildServer(provider: IdentityProvider): { app: FastifyInstance; logs: () => string } {
  const { logger, text } = recordingLogger();

  const config: ServerConfig = loadConfig({
    DATABASE_URL: urlForScratchDatabase(databaseName),
    LOG_LEVEL: 'trace',
    JWT_SECRET,
    GITHUB_CLIENT_ID: 'Iv1.integrationtest',
    GITHUB_CLIENT_SECRET,
  });

  const app = createApp({
    config,
    database: { ping: () => pool.query('select 1').then(() => undefined), db },
    logger,
    identityProvider: provider,
  });

  app.get('/whoami', (request) => {
    const user = request.requireUser();
    return { userId: user.id, expiresAt: user.expiresAt.toISOString() };
  });

  started.push(app);
  return { app, logs: text };
}

/**
 * A well-formed, unexpired access token signed with somebody else's key.
 *
 * Used to prove the guard verifies against the *configured* secret rather than
 * against anything it chose for itself.
 */
function foreignToken(): string {
  const issuedAt = Math.floor(Date.now() / 1_000);
  return signAccessToken(
    { sub: UserId.generate(), iat: issuedAt, exp: issuedAt + ACCESS_TOKEN_TTL_SECONDS },
    'f'.repeat(MIN_JWT_SECRET_LENGTH),
  );
}

/** Sleeps, because the advertised polling interval is a real second. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

beforeAll(async () => {
  databaseName = `agentchat_t019_${unique()}`;

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`create database "${databaseName}"`);
  } finally {
    await admin.end();
  }

  pool = new Pool({ connectionString: urlForScratchDatabase(databaseName) });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
});

afterAll(async () => {
  await Promise.all(started.splice(0).map((app) => app.close()));
  await pool?.end();

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await admin.end();
  }
});

describe('logging in against the assembled server', () => {
  it('refuses, then issues, then accepts', async () => {
    const identity = identityFor();
    const { app, logs } = buildServer(stubProvider(identity, 1));

    // 1. Before anything: the protected route is closed. Nothing about
    //    `/whoami` mentions authentication, which is the point — a route
    //    author gets this by writing no configuration at all.
    const refused = await app.inject({ method: 'GET', url: '/whoami' });

    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
    expect(refused.headers['www-authenticate']).toBe('Bearer');

    // 2. The device flow is open, because it is how a client gets a token.
    const startResponse = await app.inject({
      method: 'POST',
      url: '/auth/device/start',
      payload: {},
    });

    expect(startResponse.statusCode).toBe(200);
    const grant = startResponse.json();
    expect(grant.userCode).toBe('WDJB-MJHT');
    expect(grant.verificationUri).toBe('https://example.test/device');
    // The server's device code, not the provider's. D4: nothing on the wire is
    // provider-shaped.
    expect(grant.deviceCode).not.toContain(PROVIDER_DEVICE_CODE);

    // 3. Polling before the advertised interval is refused by this server,
    //    without the provider being asked at all.
    const tooSoon = await app.inject({
      method: 'POST',
      url: '/auth/device/poll',
      payload: { deviceCode: grant.deviceCode },
    });

    expect(tooSoon.statusCode).toBe(429);
    expect(tooSoon.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    // The interval to wait is in the header, which is the part a caller acts
    // on, and it survived the code change (T-055).
    expect(Number(tooSoon.headers['retry-after'])).toBeGreaterThan(0);

    await sleep(INTERVAL * 1000 - 300);

    // 4. The user has not approved yet.
    const pending = await app.inject({
      method: 'POST',
      url: '/auth/device/poll',
      payload: { deviceCode: grant.deviceCode },
    });

    expect(pending.statusCode).toBe(428);
    expect(pending.json()).toMatchObject({ error: { code: 'AUTH_PENDING' } });

    await sleep(INTERVAL * 1000 - 300);

    // 5. Approved. The account is upserted into a real `users` table and the
    //    real token service mints the pair.
    const approved = await app.inject({
      method: 'POST',
      url: '/auth/device/poll',
      payload: { deviceCode: grant.deviceCode },
    });

    expect(approved.statusCode).toBe(200);
    const body = approved.json();
    const user = UserSchema.parse(body.user);
    expect(user.username).toBe(identity.username);
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.refreshToken).toBe('string');

    // The row is really there, under the provider's subject rather than the
    // username, which is what makes a rename survivable.
    const rows = await db.select().from(users).where(eq(users.githubId, identity.subject));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(user.id);

    // And so is the refresh token, stored as a digest exactly as plan §7 says.
    // This is the assertion that proves the *real* token service ran: a stub
    // could return a plausible pair, but only the service writes this row.
    const stored = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashRefreshToken(body.refreshToken)));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.userId).toBe(user.id);
    expect(stored[0]?.revokedAt).toBeNull();

    // 6. The whole point. The same route that answered 401 accepts the token
    //    the flow just issued, and reports the account the flow just created.
    const accepted = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });

    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().userId).toBe(user.id);

    // 7. A device code is single use. Replaying the one that was just redeemed
    //    is answered as an expired code, not as a second login.
    const replayed = await app.inject({
      method: 'POST',
      url: '/auth/device/poll',
      payload: { deviceCode: grant.deviceCode },
    });

    expect(replayed.statusCode).toBe(400);
    expect(replayed.json()).toMatchObject({ error: { code: 'DEVICE_CODE_EXPIRED' } });

    // 8. Nothing secret was written down along the way. Every one of these is
    //    a credential that a debug log is the natural place to lose.
    const written = logs();
    expect(written).not.toContain(JWT_SECRET);
    expect(written).not.toContain(GITHUB_CLIENT_SECRET);
    expect(written).not.toContain(PROVIDER_DEVICE_CODE);
    expect(written).not.toContain(grant.deviceCode);
    expect(written).not.toContain(body.accessToken);
    expect(written).not.toContain(body.refreshToken);
  });

  it('refuses a token signed with a different key, on a server that issues real ones', async () => {
    const { app } = buildServer(stubProvider(identityFor(), 0));

    // A token from another deployment: well-formed, unexpired, wrong key. The
    // guard verifies against `config.jwtSecret`, so this is the assertion that
    // the secret being checked is the secret being configured rather than
    // something the plugin defaulted to.
    const foreign = foreignToken();

    const response = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { authorization: `Bearer ${foreign}` },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  });

  it('answers /healthz without a credential, against the real database', async () => {
    const { app } = buildServer(stubProvider(identityFor(), 0));

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });
  });
});
