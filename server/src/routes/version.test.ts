/**
 * What `GET /version` answers, and who the guard beside it refuses.
 *
 * Two claims here are worth stating plainly, because both are the point of the
 * endpoint rather than incidental properties of it:
 *
 *  - **It answers with no database.** The shell is built with a probe that
 *    rejects, which is what a server with an unreachable database looks like.
 *    `/healthz` goes 503 in that state, and `/version` still answers 200. A
 *    self-hoster whose `DATABASE_URL` is wrong can still tell an AgentChat
 *    server from a proxy, and `agentchat version --server …` still works.
 *  - **The floor is enforced everywhere except where enforcing it would hide
 *    the remedy.** A too-old client is refused on an ordinary route with 426
 *    and a message naming the version and the command, and is still served
 *    `/version` and `/healthz`.
 *
 * The suite hosts the module on `createAppShell` rather than the full `createApp`,
 * so the error envelope, the not-found handler and the request-id header are the
 * real ones while Postgres and the identity provider are not involved.
 * `server/tests/route-wiring.integration.test.ts` is where reachability on the
 * application a deployment actually runs is asserted.
 */

import { readFileSync } from 'node:fs';
import {
  CLIENT_VERSION_HEADER,
  ErrorCode,
  type ErrorEnvelope,
  type GetVersionResponse,
  GetVersionResponseSchema,
  MIN_CLIENT_VERSION,
  PROTOCOL_VERSION,
} from '@stackgrid/protocol';
import type { FastifyInstance } from 'fastify';
import pino, { type Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAppShell } from '../app.js';
import { MIN_JWT_SECRET_LENGTH } from '../auth/tokens.js';
import { loadConfig, type ServerConfig } from '../config.js';
import type { HealthProbe } from './health.js';
import { registerVersionRoutes, SERVER_VERSION, VERSION_GUARD_EXEMPT_ROUTES } from './version.js';

const config: ServerConfig = loadConfig({
  DATABASE_URL: 'postgres://agentchat:agentchat@localhost:5432/agentchat',
  LOG_LEVEL: 'silent',
  JWT_SECRET: 'j'.repeat(MIN_JWT_SECRET_LENGTH),
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
});

/** A logger that goes nowhere; the guard logs, and none of it is under test. */
function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

/** A database that is not there. The state this endpoint has to survive. */
const unreachable: HealthProbe = {
  ping: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432')),
};

/** The floor every guard test below uses. Deliberately not this build's. */
const FLOOR = '1.2.0';

let app: FastifyInstance;

/**
 * Builds an instance with the version routes and one guarded route to try them
 * against.
 *
 * @param minClientVersion - The floor to enforce.
 * @returns The instance, not yet ready.
 */
function build(minClientVersion = FLOOR): FastifyInstance {
  const instance = createAppShell({ config, database: unreachable, logger: silentLogger() });

  registerVersionRoutes(instance, {
    version: '4.5.6',
    protocolVersion: 11,
    minClientVersion,
  });

  // Stands in for every ordinary route. Nothing about the guard is specific to
  // any of them; what matters is that it is not `/version` or `/healthz`.
  instance.get('/projects', async () => ({ items: [] }));

  return instance;
}

beforeEach(() => {
  app = build();
});

afterEach(async () => {
  await app.close();
});

/**
 * The `X-AgentChat-Client` header for a version.
 *
 * @param version - The version to announce.
 * @returns Headers to pass to `inject`.
 */
function announcing(version: string): Record<string, string> {
  return { [CLIENT_VERSION_HEADER]: `agentchat/${version}` };
}

describe('GET /version', () => {
  it('reports the release, the protocol, and the floor', async () => {
    const response = await app.inject({ method: 'GET', url: '/version' });

    expect(response.statusCode).toBe(200);
    const body = GetVersionResponseSchema.parse(response.json());
    expect(body).toEqual({
      version: '4.5.6',
      protocolVersion: 11,
      minClientVersion: FLOOR,
    });
  });

  it('answers while the database is unreachable', async () => {
    // The whole argument for this endpoint having no dependencies. `/healthz`
    // in the same instance reports the failure, because it is asking a
    // different question — "can I work" rather than "am I an AgentChat server".
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(503);

    const version = await app.inject({ method: 'GET', url: '/version' });
    expect(version.statusCode).toBe(200);
  });

  it('defaults to this build’s own constants', async () => {
    const bare = createAppShell({ config, database: unreachable, logger: silentLogger() });
    registerVersionRoutes(bare);

    try {
      const response = await bare.inject({ method: 'GET', url: '/version' });
      const body: GetVersionResponse = response.json();

      expect(body.version).toBe(SERVER_VERSION);
      expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(body.minClientVersion).toBe(MIN_CLIENT_VERSION);
    } finally {
      await bare.close();
    }
  });
});

describe('SERVER_VERSION', () => {
  it('equals the version in server/package.json', () => {
    // The constant is duplicated on purpose — see the note in `./version.ts` —
    // so the duplication is checked here rather than trusted.
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    const declared = (manifest as { readonly version?: unknown }).version;
    expect(declared).toBe(SERVER_VERSION);
  });
});

describe('the client-version guard — too old', () => {
  it('refuses with 426 and a stable code', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/projects',
      headers: announcing('1.1.9'),
    });

    expect(response.statusCode).toBe(426);
    const envelope: ErrorEnvelope = response.json();
    expect(envelope.error.code).toBe(ErrorCode.UPGRADE_REQUIRED);
  });

  it('names the floor and the exact upgrade command in the message', async () => {
    // The client being refused may predate every line of code that could have
    // composed this sentence, so the sentence has to travel with the refusal.
    const response = await app.inject({
      method: 'GET',
      url: '/projects',
      headers: announcing('1.1.9'),
    });

    const envelope: ErrorEnvelope = response.json();
    expect(envelope.error.message).toBe(
      `Server requires agentchat >= ${FLOOR}. Run: npm i -g agentchat@latest`,
    );
  });

  it('compares numerically, so 0.9.0 is below a 0.10.0 floor', async () => {
    const strict = build('0.10.0');
    try {
      const refused = await strict.inject({
        method: 'GET',
        url: '/projects',
        headers: announcing('0.9.0'),
      });
      expect(refused.statusCode).toBe(426);

      const served = await strict.inject({
        method: 'GET',
        url: '/projects',
        headers: announcing('0.10.0'),
      });
      expect(served.statusCode).toBe(200);
    } finally {
      await strict.close();
    }
  });

  it('still serves /version and /healthz to a client it will not otherwise serve', async () => {
    // Guarding `/version` would answer "you are too old" to the one question
    // whose answer says how to stop being too old.
    const version = await app.inject({
      method: 'GET',
      url: '/version',
      headers: announcing('0.0.1'),
    });
    expect(version.statusCode).toBe(200);
    expect(version.json<GetVersionResponse>().minClientVersion).toBe(FLOOR);

    // 503 because the database is unreachable in this suite, not 426. The
    // orchestrator is not the party being asked to upgrade.
    const health = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: announcing('0.0.1'),
    });
    expect(health.statusCode).toBe(503);
    expect(health.json<{ readonly status: string }>().status).toBe('error');
  });

  it('exempts exactly the two routes it documents', () => {
    expect([...VERSION_GUARD_EXEMPT_ROUTES].sort()).toEqual(['/healthz', '/version']);
  });
});

describe('the client-version guard — too new and matched', () => {
  it('serves a client newer than the server', async () => {
    // The additive-only rule: a newer client is supported, and options this
    // server does not recognise are ignored rather than rejected. Nothing here
    // refuses it and nothing here warns — the warning is the client's, on its
    // own stderr.
    const response = await app.inject({
      method: 'GET',
      url: '/projects',
      headers: announcing('99.0.0'),
    });
    expect(response.statusCode).toBe(200);
  });

  it('serves a client exactly at the floor', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/projects',
      headers: announcing(FLOOR),
    });
    expect(response.statusCode).toBe(200);
  });

  it('serves a caller that announces nothing', async () => {
    // A third-party harness embedding `packages/client` is not the `agentchat`
    // CLI and has no release version to claim. The floor tells a CLI user to
    // upgrade; it is not an admission gate for the API.
    const response = await app.inject({ method: 'GET', url: '/projects' });
    expect(response.statusCode).toBe(200);
  });

  it('refuses a malformed header rather than treating it as absent', async () => {
    // Otherwise "I claim to be something unparseable" becomes free passage past
    // the floor.
    for (const value of ['agentchat', '1.2.0', 'agentchat/latest', 'agentchat/1.2']) {
      const response = await app.inject({
        method: 'GET',
        url: '/projects',
        headers: { [CLIENT_VERSION_HEADER]: value },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorEnvelope>().error.code).toBe(ErrorCode.BAD_REQUEST);
    }
  });

  it('refuses a pre-release of the floor, which precedes it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/projects',
      headers: announcing(`${FLOOR}-rc.1`),
    });
    expect(response.statusCode).toBe(426);
  });
});
