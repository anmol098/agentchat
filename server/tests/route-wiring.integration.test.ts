/**
 * Every route group, on the application a deployment actually runs.
 *
 * The route modules are thoroughly tested already, and none of those suites
 * could have caught what this one is for. `routes/projects.test.ts`,
 * `routes/invites.test.ts`, `routes/agents.test.ts` and `routes/sessions.test.ts`
 * each mount their own module on a bare instance and drive it; the integration
 * suites beside them do the same over a real database. All of them call the
 * register function themselves, which is exactly the assumption under test
 * here: **that anything calls it in production.** Until T-023 nothing did, and
 * four finished, green, fully covered modules answered 404 to every client.
 *
 * So this file asserts reachability the only way that means anything: it builds
 * `createApp` — not a shell, not a hand-mounted module — and sends real
 * requests to it. A module that stopped being registered would fail here even
 * though its own suite still passed, because the thing being checked is the
 * wiring rather than the handler.
 *
 * The second half of every check is the refusal. `plugins/auth.ts` protects a
 * route that says nothing, so a group is only correctly wired if it is
 * *reachable with a token and refused without one*; a group that answered both
 * would be wired and unprotected, which is worse than not wired. The invite
 * preview gets that check by name, because it is the one route in the four that
 * reads like it should be public and must not be — see the note above its test.
 *
 * One thing is stubbed: the identity provider, because a test may not reach
 * github.com. The database is a real PostgreSQL on a database this suite
 * creates and drops, the token is minted by the real token service through the
 * real device flow, and the guard is the real plugin.
 *
 * T-038 added the message and conversation groups, which had gone the same way
 * for the same reason and for longer. What those two do *beyond* being
 * reachable — a send reaching a socket that is already open — is not here: it
 * needs a real WebSocket, so it lives in `websocket-wiring.integration.test.ts`
 * next door. This file's question about them is only the one it asks of every
 * other group: are they served with a token, and refused without one.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { Pool } from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp, PUBLIC_ROUTES } from '../src/app.js';
import type { IdentityProvider, ProviderIdentity } from '../src/auth/identity.js';
import { MIN_JWT_SECRET_LENGTH } from '../src/auth/tokens.js';
import { loadConfig } from '../src/config.js';
import { sessions } from '../src/db/schema/messaging.js';
import { SESSION_SWEEP_INTERVAL_MS } from '../src/services/sessions.js';

/** The generated SQL migrations, exactly as the server image will ship them. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

/** The signing key for this run. */
const JWT_SECRET = randomUUID()
  .repeat(2)
  .slice(0, MIN_JWT_SECRET_LENGTH + 8);

/** The provider's own device code, brokered rather than proxied. */
const PROVIDER_DEVICE_CODE = `provider-device-code-${randomUUID()}`;

/** Seconds the stub advertises between polls. The contract's minimum. */
const INTERVAL = 1;

/** A short unique suffix for names that must not collide between runs. */
const unique = (): string => randomUUID().replaceAll('-', '').slice(0, 12);

let pool: Pool;
let db: NodePgDatabase<Record<string, never>>;
let databaseName: string;
let app: FastifyInstance;

/** The access token the device flow issued, used by every authenticated call. */
let bearer: string;

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

/**
 * An identity provider that approves on the first poll.
 *
 * The only stub in this file, and it speaks RFC 8628 rather than GitHub, which
 * is the seam `auth/identity.ts` defines.
 */
function stubProvider(identity: ProviderIdentity): IdentityProvider {
  return {
    startDeviceAuthorization: () =>
      Promise.resolve({
        deviceCode: PROVIDER_DEVICE_CODE,
        userCode: 'WDJB-MJHT',
        verificationUri: 'https://example.test/device',
        interval: INTERVAL,
        expiresIn: 900,
      }),
    redeemDeviceAuthorization: () => Promise.resolve({ status: 'approved' as const, identity }),
  };
}

/** Sleeps, because the advertised polling interval is a real second. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Sends a request with the token the device flow issued. */
function asUser(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${bearer}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

/** Sends the same request with no credential at all. */
function anonymously(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

/**
 * Asserts a route is closed to an anonymous caller.
 *
 * The status *and* the code, because a 404 would also be a refusal and would
 * mean the opposite of what this suite is checking: an unregistered route.
 * `AUTH_REQUIRED` can only come from the guard, which only runs for a route
 * that exists.
 */
async function expectRefused(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<void> {
  const response = await anonymously(method, url, payload);

  expect(response.statusCode, `${method} ${url} should require a token`).toBe(401);
  expect(response.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  expect(response.headers['www-authenticate']).toBe('Bearer');
}

/** Creates a project as the logged-in user and returns it. */
async function createProject(): Promise<{ id: string; name: string }> {
  const name = `Wiring ${unique()}`;
  const response = await asUser('POST', '/projects', { name });

  expect(response.statusCode, response.body).toBe(200);
  const project = response.json();
  return { id: project.id, name };
}

/** Creates an agent as the logged-in user and returns its id. */
async function createAgent(): Promise<string> {
  const response = await asUser('POST', '/agents', { name: `wire-${unique()}` });

  expect(response.statusCode, response.body).toBe(201);
  return response.json().id;
}

beforeAll(async () => {
  databaseName = `agentchat_t023_${unique()}`;

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`create database "${databaseName}"`);
  } finally {
    await admin.end();
  }

  pool = new Pool({ connectionString: urlForScratchDatabase(databaseName) });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  const config = loadConfig({
    DATABASE_URL: urlForScratchDatabase(databaseName),
    LOG_LEVEL: 'warn',
    JWT_SECRET,
    GITHUB_CLIENT_ID: 'Iv1.integrationtest',
    GITHUB_CLIENT_SECRET: `ghs_${randomUUID()}`,
  });

  const identity: ProviderIdentity = {
    subject: `gh-${unique()}`,
    username: `wirer-${unique()}`,
    displayName: 'Wiring Tester',
    email: 'wirer@example.com',
  };

  app = createApp({
    config,
    database: { ping: () => pool.query('select 1').then(() => undefined), db },
    logger: pino({ level: 'warn' }, pino.destination({ dest: '/dev/null', sync: true })),
    identityProvider: stubProvider(identity),
  });

  // A real login, so the credential the rest of this file uses is one the
  // server issued rather than one the test signed for itself. That also creates
  // the `users` row every route below writes rows against.
  const start = await app.inject({ method: 'POST', url: '/auth/device/start', payload: {} });
  expect(start.statusCode).toBe(200);

  await sleep(INTERVAL * 1000 + 100);

  const poll = await app.inject({
    method: 'POST',
    url: '/auth/device/poll',
    payload: { deviceCode: start.json().deviceCode },
  });

  expect(poll.statusCode, poll.body).toBe(200);
  bearer = poll.json().accessToken;
});

afterAll(async () => {
  await app?.close();
  await pool?.end();

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await admin.end();
  }
});

describe('project routes are registered', () => {
  it('serves the group with a token and refuses it without one', async () => {
    await expectRefused('GET', '/projects');
    await expectRefused('POST', '/projects', { name: 'Anonymous' });

    const project = await createProject();

    const read = await asUser('GET', `/projects/${project.id}`);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({ id: project.id, name: project.name, role: 'owner' });

    const listed = await asUser('GET', '/projects');
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items.map((item: { id: string }) => item.id)).toContain(project.id);

    // Registered, and therefore reachable at its sub-paths too, which a single
    // top-level check would not have proved.
    await expectRefused('GET', `/projects/${project.id}`);
    await expectRefused('GET', `/projects/${project.id}/agents`);

    const members = await asUser('GET', `/projects/${project.id}/agents`);
    expect(members.statusCode, members.body).toBe(200);
    expect(members.json()).toMatchObject({ items: [] });
  });
});

describe('agent routes are registered', () => {
  it('serves the group with a token and refuses it without one', async () => {
    await expectRefused('GET', '/agents');
    await expectRefused('POST', '/agents', { name: 'anonymous' });

    const agentId = await createAgent();

    const listed = await asUser('GET', '/agents');
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items.map((item: { id: string }) => item.id)).toContain(agentId);

    const renamed = await asUser('PATCH', `/agents/${agentId}`, { name: `wire-${unique()}` });
    expect(renamed.statusCode, renamed.body).toBe(200);

    await expectRefused('PATCH', `/agents/${agentId}`, { name: 'nope' });
    await expectRefused('DELETE', `/agents/${agentId}`);
  });
});

describe('invite routes are registered', () => {
  it('serves the group with a token and refuses it without one', async () => {
    const project = await createProject();

    await expectRefused('POST', `/projects/${project.id}/invites`);

    const minted = await asUser('POST', `/projects/${project.id}/invites`, {});
    expect(minted.statusCode, minted.body).toBe(200);

    const { code } = minted.json();
    expect(typeof code).toBe('string');

    const preview = await asUser('GET', `/invites/${code}`);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ project: { id: project.id, name: project.name } });

    await expectRefused('POST', `/invites/${code}/join`, {});
  });

  /**
   * The one route in the four that reads like it belongs in `PUBLIC_ROUTES`.
   *
   * It does not, and this is the test that says so out loud rather than in a
   * comment. `GET /invites/:code` relaxes *authorization* — `InviteService.preview`
   * takes no user id, so it answers a caller who is a member of nothing — and
   * T-108 was explicit about what relaxing authentication as well would cost:
   * the code alone would then be enough to learn a project's name and who is
   * recruiting into it, unauthenticated and with nothing to rate-limit on.
   *
   * A future change that adds this URL to the public set passes every other
   * test in the repository and fails this one.
   */
  it('keeps the invite preview behind a token, because it relaxes authorization only', async () => {
    const project = await createProject();
    const minted = await asUser('POST', `/projects/${project.id}/invites`, {});
    const { code } = minted.json();

    await expectRefused('GET', `/invites/${code}`);

    // And structurally, at the declaration rather than at the response: no
    // spelling of the preview is named as unauthenticated.
    expect([...PUBLIC_ROUTES]).not.toContain('/invites/:code');
    expect([...PUBLIC_ROUTES]).not.toContain(`/invites/${code}`);
    expect([...PUBLIC_ROUTES].filter((route) => route.startsWith('/invites'))).toEqual([]);
  });
});

describe('session routes are registered', () => {
  it('serves the group with a token and refuses it without one', async () => {
    const project = await createProject();
    const agentId = await createAgent();

    const joined = await asUser('POST', `/agents/${agentId}/projects`, { projectId: project.id });
    expect(joined.statusCode, joined.body).toBe(200);

    await expectRefused('GET', '/sessions');
    await expectRefused('POST', '/sessions', {
      agentId,
      projectId: project.id,
      machine: { name: 'laptop.local' },
      runtime: 'claude-code',
      workingDirectory: '/tmp/wiring',
    });

    const registered = await asUser('POST', '/sessions', {
      agentId,
      projectId: project.id,
      machine: { name: 'laptop.local' },
      runtime: 'claude-code',
      workingDirectory: '/tmp/wiring',
    });

    expect(registered.statusCode, registered.body).toBe(200);
    const { sessionId } = registered.json();

    const listed = await asUser('GET', `/sessions?projectId=${project.id}`);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().items.map((item: { id: string }) => item.id)).toContain(sessionId);

    const beat = await asUser('POST', `/sessions/${sessionId}/heartbeat`);
    expect(beat.statusCode, beat.body).toBe(200);
    expect(beat.json().status).toBe('active');

    await expectRefused('POST', `/sessions/${sessionId}/heartbeat`);
    await expectRefused('DELETE', `/sessions/${sessionId}`);

    const ended = await asUser('DELETE', `/sessions/${sessionId}`);
    expect(ended.statusCode, ended.body).toBe(200);
    expect(ended.json().status).toBe('ended');
  });
});

describe('message routes are registered', () => {
  it('serves the group with a token and refuses it without one', async () => {
    const project = await createProject();
    const sender = await createAgent();
    const recipient = await createAgent();

    await asUser('POST', `/agents/${sender}/projects`, { projectId: project.id });
    await asUser('POST', `/agents/${recipient}/projects`, { projectId: project.id });

    const send = {
      projectId: project.id,
      senderAgentId: sender,
      recipientAgentId: recipient,
      content: 'the routes are wired',
      clientMessageId: `wire-${unique()}`,
    };

    await expectRefused('POST', '/messages', send);
    await expectRefused('GET', `/messages?projectId=${project.id}&agentId=${recipient}`);

    const sent = await asUser('POST', '/messages', send);
    expect(sent.statusCode, sent.body).toBe(201);
    const message = sent.json();
    expect(message).toMatchObject({ projectId: project.id, content: send.content });

    // The idempotency rule through the wiring, because it is the one place a
    // client depends on the *status line* rather than the body: the same
    // `clientMessageId` is the original message and a 200.
    const repeated = await asUser('POST', '/messages', send);
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.json().id).toBe(message.id);

    // Nobody was listening, so the message is owed — the send did not swallow
    // it and the fan-out reaching nobody did not fail it.
    const pending = await asUser('GET', `/messages?projectId=${project.id}&agentId=${recipient}`);
    expect(pending.statusCode, pending.body).toBe(200);
    expect(pending.json().items.map((item: { id: string }) => item.id)).toStrictEqual([message.id]);

    await expectRefused('POST', `/messages/${message.id}/ack`, {
      agentId: recipient,
      projectId: project.id,
    });

    const acked = await asUser('POST', `/messages/${message.id}/ack`, {
      agentId: recipient,
      projectId: project.id,
    });
    expect(acked.statusCode, acked.body).toBe(200);
    expect(acked.json()).toMatchObject({ messageId: message.id, alreadyAcknowledged: false });

    const drained = await asUser('GET', `/messages?projectId=${project.id}&agentId=${recipient}`);
    expect(drained.json()).toMatchObject({ items: [], nextCursor: null });
  });
});

describe('conversation routes are registered', () => {
  it('serves the group with a token and refuses it without one', async () => {
    const project = await createProject();
    const sender = await createAgent();
    const recipient = await createAgent();

    await asUser('POST', `/agents/${sender}/projects`, { projectId: project.id });
    await asUser('POST', `/agents/${recipient}/projects`, { projectId: project.id });

    const sent = await asUser('POST', '/messages', {
      projectId: project.id,
      senderAgentId: sender,
      recipientAgentId: recipient,
      content: 'opens a thread',
      clientMessageId: `wire-${unique()}`,
    });
    const { id: messageId, conversationId } = sent.json();

    await expectRefused('GET', `/conversations/${conversationId}`);

    const thread = await asUser('GET', `/conversations/${conversationId}`);
    expect(thread.statusCode, thread.body).toBe(200);
    expect(thread.json()).toMatchObject({
      conversation: { id: conversationId, projectId: project.id },
      nextCursor: null,
    });
    expect(thread.json().messages.map((item: { id: string }) => item.id)).toStrictEqual([
      messageId,
    ]);
  });
});

describe('the session sweeper is running', () => {
  /**
   * The sweeper is the one piece of this wiring that no request can reveal.
   *
   * `startSessionSweeper` had no caller anywhere in the tree, and nothing about
   * a served route would have said so: sessions would simply have stayed
   * `active` forever, and presence — which is derived from active sessions —
   * would have reported agents nobody was running as online. That failure is
   * invisible until somebody asks who is listening, which is why it is worth a
   * slow test rather than a comment.
   *
   * The wait is real time. The interval is twenty seconds and `createApp` does
   * not take an override, deliberately: an override would let this test pass
   * against a sweeper the production path never starts, which is the entire
   * class of bug being ruled out. So the timeout is generous and the assertion
   * is polled rather than slept for, and this is the only test in the suite
   * that costs more than a request.
   */
  it('moves a session that stopped heartbeating to stale, with nothing asking it to', async () => {
    const project = await createProject();
    const agentId = await createAgent();
    await asUser('POST', `/agents/${agentId}/projects`, { projectId: project.id });

    const registered = await asUser('POST', '/sessions', {
      agentId,
      projectId: project.id,
      machine: { name: 'abandoned.local' },
      runtime: 'claude-code',
      workingDirectory: '/tmp/abandoned',
    });
    const { sessionId } = registered.json();

    // Backdated in *database* time, on the same clock the sweep's predicate
    // reads, so this is a listener that has genuinely been silent past the
    // sixty-second threshold rather than one this process believes is old.
    await db.execute(
      sql`update ${sessions} set last_seen_at = now() - make_interval(secs => 600) where id = ${sessionId}`,
    );

    const deadline = Date.now() + SESSION_SWEEP_INTERVAL_MS * 2 + 5_000;
    let status = 'active';

    while (Date.now() < deadline && status !== 'stale') {
      await sleep(250);
      const found = await asUser('GET', `/sessions?projectId=${project.id}`);
      status = found.json().items[0]?.status ?? 'active';
    }

    expect(status, 'no sweep ran; startSessionSweeper has no caller').toBe('stale');
  }, 60_000);
});
