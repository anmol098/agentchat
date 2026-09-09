/**
 * A real AgentChat server, on a real port, over a real database — for the
 * suites that have to cross a package boundary to say anything.
 *
 * ## Why this lives at the repository root
 *
 * The gap T-043 was filed for lived exactly between two honest suites. Every
 * command test in `packages/cli` drives a stub server that answers `GET /me`,
 * `POST /auth/refresh` and `POST /auth/logout`, so the commands were correct
 * against a server that did not exist. Every server test in `server/` drives
 * routes the server actually registers, so it could not miss a route that was
 * never written. Both suites were green and five shipped commands were broken.
 *
 * Closing that gap needs the AGPL server and the MIT client in one process, and
 * `scripts/check-licenses.mjs` is right to refuse that edge inside `packages/`:
 * an MIT package that depends on the server would pull AGPL code into every
 * tree that installs it. The root manifest is private, covers a tree with two
 * licences, and is the one place the two halves may meet — which is what
 * `vitest.config.ts` already means by "cross-cutting suites that belong to no
 * single package".
 *
 * ## What is faked, and what is emphatically not
 *
 * One thing is stubbed: the identity provider, because a test may not reach
 * github.com. It answers in RFC 8628's vocabulary, which is the seam
 * `auth/identity.ts` defines, so nothing here knows a provider name.
 *
 * Everything else is the real article. The application is `createApp`, the
 * database is PostgreSQL with the migrations a deployment ships, the token
 * service writes real digests, the guard is the real plugin, requests cross a
 * real socket via `fetch`, and the thing making them is `@agentchat/client` —
 * the same library `agentchat listen` runs on.
 *
 * ## The clock
 *
 * {@link ServerFixture.advance} moves the server's clock forward. It is the
 * only way to ask the question T-043 exists for — *does a listener left running
 * overnight recover on its own?* — in less than an hour. It is an offset on top
 * of the real clock rather than a frozen instant, so intervals that depend on
 * time genuinely passing, such as the device flow's polling floor, still behave
 * normally.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AgentChatClient, type InMemoryCredentialStore } from '@agentchat/client';
import { createApp } from '@agentchat/server/dist/src/app.js';
import type {
  DeviceAuthorizationOutcome,
  IdentityProvider,
  ProviderIdentity,
} from '@agentchat/server/dist/src/auth/identity.js';
import { MIN_JWT_SECRET_LENGTH } from '@agentchat/server/dist/src/auth/tokens.js';
import { loadConfig } from '@agentchat/server/dist/src/config.js';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import pino from 'pino';

/** The generated SQL migrations, exactly as the server image ships them. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../server/drizzle', import.meta.url));

/**
 * Seconds the stub provider advertises between polls.
 *
 * The contract's minimum, so a login costs about a second of real time rather
 * than five. The route enforces this floor itself, which is why the helper
 * below sleeps rather than polling in a tight loop.
 */
const POLL_INTERVAL_SECONDS = 1;

/** Milliseconds to wait before the first poll. Comfortably past the floor. */
const POLL_WAIT_MS = 700;

/** A short unique suffix for names that must not collide between runs. */
export function unique(): string {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

/** Sleeps, because the advertised polling interval is a real second. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Connection string for `name` on the server `DATABASE_URL` points at. */
function urlForScratchDatabase(name: string): string {
  const raw = process.env['DATABASE_URL'];
  if (raw === undefined) {
    throw new Error('DATABASE_URL is not set; the global setup should have refused to start.');
  }

  const url = new URL(raw);
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * An identity provider that approves on the first poll.
 *
 * The only stub in this file; see the module note.
 */
function stubProvider(identity: ProviderIdentity): IdentityProvider {
  return {
    startDeviceAuthorization: () =>
      Promise.resolve({
        deviceCode: `provider-device-code-${unique()}`,
        userCode: 'WDJB-MJHT',
        verificationUri: 'https://example.test/device',
        interval: POLL_INTERVAL_SECONDS,
        expiresIn: 900,
      }),

    redeemDeviceAuthorization: (): Promise<DeviceAuthorizationOutcome> =>
      Promise.resolve({ status: 'approved', identity }),
  };
}

/** A running server, and the handles a test needs to interrogate it. */
export interface ServerFixture {
  /** Where the server is listening, e.g. `http://127.0.0.1:54321`. */
  readonly baseUrl: string;

  /** The Fastify instance, for direct inspection. */
  readonly app: FastifyInstance;

  /** A Drizzle handle on the scratch database, for asserting on rows. */
  readonly db: NodePgDatabase<Record<string, never>>;

  /** How many requests the server has answered for `METHOD /path`. */
  readonly countOf: (route: string) => number;

  /** Everything the server logged, as newline-delimited JSON. */
  readonly logs: () => string;

  /**
   * Moves the server's clock forward.
   *
   * @param seconds - How far forward. Cumulative across calls.
   */
  readonly advance: (seconds: number) => void;

  /**
   * Signs a user in through the real device flow.
   *
   * @param store - Where the issued credentials are written. The client owns
   *   this, so passing the same store to {@link client} is what makes the
   *   returned client authenticated.
   * @returns The identity that was signed in.
   */
  readonly login: (store: InMemoryCredentialStore) => Promise<ProviderIdentity>;

  /**
   * A client pointed at this server.
   *
   * @param store - The credential store the client reads and writes.
   * @returns The client.
   */
  readonly client: (store: InMemoryCredentialStore) => AgentChatClient;

  /** Stops the server and drops the scratch database. */
  readonly close: () => Promise<void>;
}

/**
 * Stands up a server on its own database and its own port.
 *
 * The database is created fresh and dropped on {@link ServerFixture.close}, for
 * the reason `db/schema/tests/identity.integration.test.ts` gives: integration
 * tests share one PostgreSQL server, and rows written here must not disturb
 * another suite's.
 *
 * @returns The fixture. The caller must `close()` it.
 */
export async function startServer(): Promise<ServerFixture> {
  const databaseName = `agentchat_t043_${unique()}`;

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`create database "${databaseName}"`);
  } finally {
    await admin.end();
  }

  const pool = new Pool({ connectionString: urlForScratchDatabase(databaseName) });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  const lines: string[] = [];
  const logger = pino(
    { level: 'trace', base: null, timestamp: false },
    {
      write(line: string): void {
        lines.push(line);
      },
    },
  );

  let offsetMs = 0;

  const config = loadConfig({
    DATABASE_URL: urlForScratchDatabase(databaseName),
    LOG_LEVEL: 'trace',
    JWT_SECRET: randomUUID()
      .repeat(2)
      .slice(0, MIN_JWT_SECRET_LENGTH + 8),
    GITHUB_CLIENT_ID: 'Iv1.integrationtest',
    GITHUB_CLIENT_SECRET: `ghs_${randomUUID()}`,
  });

  const identity: ProviderIdentity = {
    subject: `gh-${unique()}`,
    username: `alice-${unique()}`,
    displayName: 'Alice Smith',
    email: 'alice@example.com',
  };

  const app = createApp({
    config,
    database: { ping: () => pool.query('select 1').then(() => undefined), db },
    logger,
    identityProvider: stubProvider(identity),

    // An offset on the real clock, not a frozen instant. See the module note.
    now: () => new Date(Date.now() + offsetMs),
  });

  // Registered before `listen`, so it is in the hook chain for every request.
  // Counting on the server rather than wrapping `fetch` is deliberate: the
  // question "did exactly one refresh reach the server" is about the server,
  // and a counter on the client side would still read 1 if the client sent one
  // request that the server somehow saw twice.
  const counts = new Map<string, number>();
  app.addHook('onRequest', (request, _reply, done) => {
    const key = `${request.method} ${new URL(request.url, 'http://x').pathname}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    done();
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind a TCP port');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    app,
    db,
    countOf: (route) => counts.get(route) ?? 0,
    logs: () => lines.join('\n'),
    advance: (seconds) => {
      offsetMs += seconds * 1000;
    },

    client: (store) => new AgentChatClient({ baseUrl, credentials: store }),

    login: async (store) => {
      const client = new AgentChatClient({ baseUrl, credentials: store });
      const grant = await client.auth.startDeviceAuthorization();

      // The route enforces the interval it advertised, so this waits rather
      // than polling in a loop: a tight loop would earn a `slow_down` and
      // prove nothing about the flow.
      await sleep(POLL_WAIT_MS);

      // Writes the issued pair into `store` before it resolves, which is what
      // makes the client authenticated from here on.
      await client.auth.pollDeviceAuthorization({ deviceCode: grant.deviceCode });
      return identity;
    },

    close: async () => {
      await app.close();
      await pool.end();

      const cleanup = new Pool({ connectionString: process.env['DATABASE_URL'] });
      try {
        await cleanup.query(`drop database if exists "${databaseName}" with (force)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
