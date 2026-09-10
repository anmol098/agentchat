/**
 * The session routes, as a client sees them.
 *
 * Every case goes through `createAppShell` plus the real `registerAuth`, so
 * what is asserted is the response a caller actually receives — status, code
 * and envelope — rather than the value a handler returned. The service is a
 * stub, because the lifecycle it implements is proved against a real database
 * in `../services/sessions.integration.test.ts`; what is under test here is the
 * boundary: what the routes accept, what they refuse before the service is
 * reached, and that they are protected at all.
 *
 * The two properties worth stating up front:
 *
 *  - **Protected by omission (T-019).** None of these routes appears in
 *    `PUBLIC_ROUTES`, so all four are guarded. The first suite asserts that of
 *    every one of them, because a route that silently became public would
 *    otherwise be found by its first user.
 *  - **Runtime is required (D14).** A registration without one is refused at
 *    the schema, before any handler runs, and nothing in the request path fills
 *    it in.
 */

import { randomUUID } from 'node:crypto';
import type { SessionSummary } from '@stackgrid/protocol';
import {
  AgentId,
  ErrorCode,
  ProjectId,
  ProtocolError,
  SessionId,
  UserId,
} from '@stackgrid/protocol';
import type { FastifyInstance, InjectOptions } from 'fastify';
import pino, { type Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAppShell } from '../app.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  MIN_JWT_SECRET_LENGTH,
  signAccessToken,
} from '../auth/tokens.js';
import { loadConfig, type ServerConfig } from '../config.js';
import { registerAuth } from '../plugins/auth.js';
import type {
  ListSessionsRequest,
  RegisterSessionRequest,
  SessionOwnerRequest,
  SessionRecord,
  SessionService,
} from '../services/sessions.js';
import type { HealthProbe } from './health.js';
import { registerSessionRoutes } from './sessions.js';

/** The signing key under test. Long enough to be accepted; otherwise arbitrary. */
const SECRET = 's'.repeat(MIN_JWT_SECRET_LENGTH);

/** Fixed clock, so an expiry is a decision rather than a race. */
const NOW = new Date('2026-09-08T12:00:00.000Z');

/** `NOW` in whole seconds, which is the unit the claims use. */
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

const CALLER = UserId.generate();
const AGENT = AgentId.generate();
const PROJECT = ProjectId.generate();

const config: ServerConfig = loadConfig({
  DATABASE_URL: 'postgres://agentchat:agentchat@localhost:5432/agentchat',
  LOG_LEVEL: 'silent',
  JWT_SECRET: 'j'.repeat(MIN_JWT_SECRET_LENGTH),
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
});

/** A probe that always says the database is fine; nothing here queries it. */
const reachable: HealthProbe = { ping: () => Promise.resolve() };

/** A logger that goes nowhere. */
function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

/** A plausible session, as the service would return one. */
function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: SessionId.generate(),
    agentId: AGENT,
    projectId: PROJECT,
    machineId: `mch_${randomUUID()}` as SessionRecord['machineId'],
    machineName: 'alices-mbp',
    runtime: 'claude-code',
    workingDirectory: '/Users/alice/src/payments',
    startedAt: NOW,
    lastSeenAt: NOW,
    endedAt: null,
    status: 'active',
    ...overrides,
  };
}

/** A body `POST /sessions` accepts. */
function registrationBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: AGENT,
    projectId: PROJECT,
    machine: { name: 'alices-mbp' },
    runtime: 'claude-code',
    workingDirectory: '/Users/alice/src/payments',
    ...overrides,
  };
}

/** The stubbed lifecycle, with each call recorded. */
interface ServiceStub {
  readonly service: SessionService;
  readonly register: ReturnType<typeof vi.fn>;
  readonly heartbeat: ReturnType<typeof vi.fn>;
  readonly end: ReturnType<typeof vi.fn>;
  readonly list: ReturnType<typeof vi.fn>;
}

/**
 * Builds a service whose methods succeed unless a test says otherwise.
 *
 * @param overrides - Implementations to substitute.
 * @returns The stub and its spies.
 */
function stubService(overrides: Partial<Record<keyof SessionService, unknown>> = {}): ServiceStub {
  const register = vi.fn(async (_request: RegisterSessionRequest) => sessionRecord());
  const heartbeat = vi.fn(async (_request: SessionOwnerRequest) => sessionRecord());
  const end = vi.fn(async (_request: SessionOwnerRequest) =>
    sessionRecord({ status: 'ended', endedAt: NOW }),
  );
  const list = vi.fn(async (_request: ListSessionsRequest) => [sessionRecord()]);

  const service = {
    register,
    heartbeat,
    end,
    list,
    sweep: async () => ({ markedStale: 0, ended: 0 }),
    ...overrides,
  } as unknown as SessionService;

  return { service, register, heartbeat, end, list };
}

const started: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((app) => app.close()));
});

/**
 * Builds the application with the session routes on it.
 *
 * The shell rather than `createApp`, because `createApp` registers the auth
 * plugin itself and a second `registerAuth` on one instance is a duplicate
 * decorator. `registerAuth` runs before the routes so its `onRoute` hook covers
 * them, exactly as the wiring in `app.ts` arranges.
 *
 * @param stub - The service the routes call.
 * @returns The instance.
 */
function buildApp(stub: ServiceStub): FastifyInstance {
  const app = createAppShell({ config, database: reachable, logger: silentLogger() });
  started.push(app);

  registerAuth(app, { jwtSecret: SECRET, now: () => NOW });
  registerSessionRoutes(app, { sessions: stub.service });

  return app;
}

/** A token this server should accept. */
function token(): string {
  return signAccessToken(
    { sub: CALLER, iat: NOW_SECONDS, exp: NOW_SECONDS + ACCESS_TOKEN_TTL_SECONDS },
    SECRET,
  );
}

/** The `Authorization` header for an authenticated request. */
function authorized(): Record<string, string> {
  return { authorization: `Bearer ${token()}` };
}

describe('protected by omission', () => {
  // Four routes, no `config.auth` on any of them, and none named in
  // `PUBLIC_ROUTES`. That is the whole mechanism, and this is the assertion
  // that it worked.
  const routes = [
    { method: 'POST' as const, url: '/sessions' },
    { method: 'POST' as const, url: `/sessions/${SessionId.generate()}/heartbeat` },
    { method: 'DELETE' as const, url: `/sessions/${SessionId.generate()}` },
    { method: 'GET' as const, url: '/sessions' },
  ];

  for (const route of routes) {
    it(`refuses ${route.method} ${route.url.replace(/ses_[^/]+/, ':id')} without a token`, async () => {
      const stub = stubService();
      const app = buildApp(stub);

      // Built up rather than spread inline, because a `payload: undefined` is
      // not the same as no payload under `exactOptionalPropertyTypes`.
      const injection: InjectOptions = { method: route.method, url: route.url };
      if (route.method === 'POST') {
        injection.payload = registrationBody();
      }

      const response = await app.inject(injection);

      expect(response.statusCode).toBe(401);
      expect(response.json<{ error: { code: string } }>().error.code).toBe(ErrorCode.AUTH_REQUIRED);

      // And nothing reached the service. A route that authenticated *after*
      // doing its work would still answer 401 here.
      expect(stub.register).not.toHaveBeenCalled();
      expect(stub.heartbeat).not.toHaveBeenCalled();
      expect(stub.end).not.toHaveBeenCalled();
      expect(stub.list).not.toHaveBeenCalled();
    });
  }
});

describe('POST /sessions', () => {
  it('registers and answers with the session id, as plan §3 specifies', async () => {
    const stub = stubService();
    const app = buildApp(stub);

    const response = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: authorized(),
      payload: registrationBody(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ sessionId: string }>();
    expect(body.sessionId).toMatch(/^ses_/);

    // The caller's identity comes from the verified token, never from the body.
    expect(stub.register).toHaveBeenCalledWith({
      userId: CALLER,
      agentId: AGENT,
      projectId: PROJECT,
      machineName: 'alices-mbp',
      runtime: 'claude-code',
      workingDirectory: '/Users/alice/src/payments',
    });
  });

  it('refuses a registration with no runtime, before the service is reached (D14)', async () => {
    const stub = stubService();
    const app = buildApp(stub);

    const { runtime: _omitted, ...withoutRuntime } = registrationBody();

    const response = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: authorized(),
      payload: withoutRuntime,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(ErrorCode.BAD_REQUEST);
    expect(response.json<{ error: { message: string } }>().error.message).toContain('runtime');

    // The point of D14: there is no path by which the server supplies one.
    expect(stub.register).not.toHaveBeenCalled();
  });

  it('refuses an empty or whitespace runtime rather than storing it', async () => {
    const stub = stubService();
    const app = buildApp(stub);

    for (const runtime of ['', '   ']) {
      const response = await app.inject({
        method: 'POST',
        url: '/sessions',
        headers: authorized(),
        payload: registrationBody({ runtime }),
      });

      expect(response.statusCode).toBe(400);
    }

    expect(stub.register).not.toHaveBeenCalled();
  });

  it('passes an unfamiliar runtime through untouched', async () => {
    // Free-form by design. The server does not interpret it any more than it
    // interprets message content, so a harness this build has never heard of
    // registers exactly as well as one it has.
    const stub = stubService();
    const app = buildApp(stub);

    await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: authorized(),
      payload: registrationBody({ runtime: 'some-future-harness' }),
    });

    expect(stub.register).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: 'some-future-harness' }),
    );
  });

  it('refuses an agent id of the wrong kind', async () => {
    const stub = stubService();
    const app = buildApp(stub);

    const response = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: authorized(),
      // A project id where an agent id belongs: well-formed, and the wrong
      // kind. The branded schemas are what make this a 400 rather than a
      // lookup that happens to miss.
      payload: registrationBody({ agentId: ProjectId.generate() }),
    });

    expect(response.statusCode).toBe(400);
    expect(stub.register).not.toHaveBeenCalled();
  });

  it('reports the service’s refusal with the service’s code', async () => {
    // The handler adds nothing: a rule the service enforced arrives at the
    // client with the code the service chose, through `errors.ts`.
    const stub = stubService({
      register: vi.fn(() =>
        Promise.reject(
          new ProtocolError(ErrorCode.AGENT_NOT_IN_PROJECT, 'That agent is not in this project.'),
        ),
      ),
    });
    const app = buildApp(stub);

    const response = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: authorized(),
      payload: registrationBody(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      ErrorCode.AGENT_NOT_IN_PROJECT,
    );
  });
});

describe('POST /sessions/:id/heartbeat', () => {
  it('answers with the status the heartbeat produced', async () => {
    const id = SessionId.generate();
    const stub = stubService();
    const app = buildApp(stub);

    const response = await app.inject({
      method: 'POST',
      url: `/sessions/${id}/heartbeat`,
      headers: authorized(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe('active');
    expect(response.json<{ lastSeenAt: string }>().lastSeenAt).toBe(NOW.toISOString());
    expect(stub.heartbeat).toHaveBeenCalledWith({ userId: CALLER, sessionId: id });
  });

  it('says a revived session is active again', async () => {
    // A listener that was unreachable for a while wants to know its presence
    // came back rather than assume it.
    const stub = stubService({
      heartbeat: vi.fn(async () => sessionRecord({ status: 'active' })),
    });
    const app = buildApp(stub);

    const response = await app.inject({
      method: 'POST',
      url: `/sessions/${SessionId.generate()}/heartbeat`,
      headers: authorized(),
    });

    expect(response.json<{ status: string }>().status).toBe('active');
  });

  it('refuses a malformed session id in the path', async () => {
    const stub = stubService();
    const app = buildApp(stub);

    const response = await app.inject({
      method: 'POST',
      url: '/sessions/not-a-session-id/heartbeat',
      headers: authorized(),
    });

    expect(response.statusCode).toBe(400);
    expect(stub.heartbeat).not.toHaveBeenCalled();
  });

  it('reports an ended session as a conflict, with the remedy', async () => {
    const stub = stubService({
      heartbeat: vi.fn(() =>
        Promise.reject(
          new ProtocolError(
            ErrorCode.CONFLICT,
            'That session has already ended. Start a new listener with: agentchat listen --runtime <name>',
          ),
        ),
      ),
    });
    const app = buildApp(stub);

    const response = await app.inject({
      method: 'POST',
      url: `/sessions/${SessionId.generate()}/heartbeat`,
      headers: authorized(),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(ErrorCode.CONFLICT);
  });
});

describe('DELETE /sessions/:id', () => {
  it('ends the session and reports when it ended', async () => {
    const id = SessionId.generate();
    const stub = stubService();
    const app = buildApp(stub);

    const response = await app.inject({
      method: 'DELETE',
      url: `/sessions/${id}`,
      headers: authorized(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe('ended');
    expect(response.json<{ endedAt: string }>().endedAt).toBe(NOW.toISOString());
    expect(stub.end).toHaveBeenCalledWith({ userId: CALLER, sessionId: id });
  });

  it('answers a retried teardown the same way, because DELETE is idempotent', async () => {
    const id = SessionId.generate();
    const stub = stubService();
    const app = buildApp(stub);

    const first = await app.inject({
      method: 'DELETE',
      url: `/sessions/${id}`,
      headers: authorized(),
    });
    const second = await app.inject({
      method: 'DELETE',
      url: `/sessions/${id}`,
      headers: authorized(),
    });

    expect(second.statusCode).toBe(first.statusCode);
    expect(second.json()).toEqual(first.json());
  });

  it('reports somebody else’s session as not found', async () => {
    const stub = stubService({
      end: vi.fn(() =>
        Promise.reject(
          new ProtocolError(ErrorCode.NOT_FOUND, 'No such session, or it is not one you can use.'),
        ),
      ),
    });
    const app = buildApp(stub);

    const response = await app.inject({
      method: 'DELETE',
      url: `/sessions/${SessionId.generate()}`,
      headers: authorized(),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(ErrorCode.NOT_FOUND);
  });
});

describe('GET /sessions', () => {
  it('envelopes the list', async () => {
    const stub = stubService();
    const app = buildApp(stub);

    const response = await app.inject({ method: 'GET', url: '/sessions', headers: authorized() });

    expect(response.statusCode).toBe(200);

    // `{ items: [...] }`, not a bare array: a bare array cannot carry a
    // pagination cursor, and §12.4 makes adding one to it a major version.
    const body = response.json<{ items: unknown[] }>();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(1);
  });

  it('carries the hostname and the runtime as metadata beside the identity', async () => {
    const stub = stubService();
    const app = buildApp(stub);

    const response = await app.inject({ method: 'GET', url: '/sessions', headers: authorized() });
    const [item] = response.json<{ items: SessionSummary[] }>().items;

    expect(item?.agentId).toBe(AGENT);
    expect(item?.machineName).toBe('alices-mbp');
    expect(item?.runtime).toBe('claude-code');
    expect(item?.status).toBe('active');
    expect(item?.endedAt).toBeNull();
  });

  it('passes both filters through', async () => {
    const stub = stubService();
    const app = buildApp(stub);

    await app.inject({
      method: 'GET',
      url: `/sessions?projectId=${PROJECT}&agentId=${AGENT}`,
      headers: authorized(),
    });

    expect(stub.list).toHaveBeenCalledWith({
      userId: CALLER,
      projectId: PROJECT,
      agentId: AGENT,
      includeEnded: false,
    });
  });

  it('reads includeEnded as a string, so ?includeEnded=false really is false', async () => {
    // Query values arrive as strings, and `Boolean('false')` is `true`. Only
    // the exact string enables the flag.
    const stub = stubService();
    const app = buildApp(stub);

    await app.inject({ method: 'GET', url: '/sessions?includeEnded=false', headers: authorized() });
    expect(stub.list).toHaveBeenCalledWith(expect.objectContaining({ includeEnded: false }));

    await app.inject({ method: 'GET', url: '/sessions?includeEnded=true', headers: authorized() });
    expect(stub.list).toHaveBeenCalledWith(expect.objectContaining({ includeEnded: true }));
  });

  it('refuses a malformed filter rather than ignoring it', async () => {
    const stub = stubService();
    const app = buildApp(stub);

    const response = await app.inject({
      method: 'GET',
      url: '/sessions?agentId=nonsense',
      headers: authorized(),
    });

    expect(response.statusCode).toBe(400);
    expect(stub.list).not.toHaveBeenCalled();
  });

  it('serves an empty list rather than refusing, when nothing matches', async () => {
    // The scoping is a join, so a stranger's agent id yields nothing to show.
    // A refusal here would confirm the id exists.
    const stub = stubService({ list: vi.fn(async () => []) });
    const app = buildApp(stub);

    const response = await app.inject({
      method: 'GET',
      url: `/sessions?agentId=${AgentId.generate()}`,
      headers: authorized(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: unknown[] }>().items).toEqual([]);
  });
});
