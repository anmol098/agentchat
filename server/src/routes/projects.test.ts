/**
 * The project routes, over a real Fastify instance and a stubbed service.
 *
 * What this suite is for is the half of a route that has nothing to do with
 * Postgres: which schema each request is parsed against, that the caller's
 * identity comes from the token rather than from the body, and that the
 * failures a malformed request produces are contract envelopes rather than
 * framework ones. The app is built by `createAppShell` and guarded by
 * `registerAuth`, so every status and code asserted here is one a client would
 * actually receive — through `toErrorResponse` and the outbound
 * `ErrorCodeSchema` check T-015 installed.
 *
 * The service is a stub because what it does to a database is proven in
 * `projects.integration.test.ts`, against a real one. What is *not* stubbed is
 * authentication: the one property this file can establish that no other can is
 * that these routes are protected by omission — none of them declares
 * `config.auth`, so all of them refuse an anonymous caller — and stubbing the
 * guard would make that assertion circular.
 */

import {
  type CreateProjectRequest,
  type CreateProjectResponse,
  ErrorCode,
  ErrorCodeSchema,
  type GetProjectResponse,
  type LeaveProjectResponse,
  type ListProjectAgentsResponse,
  type ListProjectsResponse,
  ProjectId,
  type ProjectId as ProjectIdType,
  type ProjectName,
  ProtocolError,
  UserId,
  type UserId as UserIdType,
} from '@agentchat/protocol';
import type { FastifyInstance } from 'fastify';
import pino, { type Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAppShell } from '../app.js';
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken } from '../auth/tokens.js';
import { loadConfig, type ServerConfig } from '../config.js';
import { registerAuth } from '../plugins/auth.js';
import type { ProjectService } from '../services/projects.js';
import type { HealthProbe } from './health.js';
import { registerProjectRoutes } from './projects.js';

/** The signing key both the token and the guard use. */
const JWT_SECRET = 'j'.repeat(32);

const config: ServerConfig = loadConfig({
  DATABASE_URL: 'postgres://agentchat:agentchat@localhost:5432/agentchat',
  LOG_LEVEL: 'silent',
  JWT_SECRET,
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
});

/** The health probe `createAppShell` requires; no route under test uses it. */
const database: HealthProbe = { ping: () => Promise.resolve() };

/** A logger that writes nowhere. */
const logger: Logger = pino({ level: 'silent' });

/** The caller every authenticated request below is made as. */
const caller: UserIdType = UserId.generate();

/** The project the stub answers about. */
const projectId: ProjectIdType = ProjectId.generate();

/** One membership, as the service would return it. */
const membership: GetProjectResponse = {
  id: projectId,
  slug: 'payments',
  name: 'Payments Platform',
  createdBy: caller,
  createdAt: new Date('2026-09-08T10:00:00.000Z').toISOString(),
  role: 'owner',
};

/** What the stub service was asked, so a test can assert the route passed it on. */
interface Call {
  readonly method: string;
  readonly userId: UserIdType;
  readonly projectId?: ProjectIdType;
  readonly request?: CreateProjectRequest;
}

let calls: Call[];
let app: FastifyInstance;

/** A bearer header for a user, valid now. */
function bearer(userId: UserIdType): string {
  const iat = Math.floor(Date.now() / 1000);
  return `Bearer ${signAccessToken({ sub: userId, iat, exp: iat + ACCESS_TOKEN_TTL_SECONDS }, JWT_SECRET)}`;
}

/** A service that records what it was asked and answers with fixtures. */
function recordingService(): ProjectService {
  return {
    list(userId: UserIdType): Promise<ListProjectsResponse> {
      calls.push({ method: 'list', userId });
      return Promise.resolve({ items: [membership] });
    },
    create(userId: UserIdType, request: CreateProjectRequest): Promise<CreateProjectResponse> {
      calls.push({ method: 'create', userId, request });
      return Promise.resolve(membership);
    },
    get(userId: UserIdType, id: ProjectIdType): Promise<GetProjectResponse> {
      calls.push({ method: 'get', userId, projectId: id });
      return Promise.resolve(membership);
    },
    rename(userId: UserIdType, id: ProjectIdType, _name: ProjectName): Promise<GetProjectResponse> {
      calls.push({ method: 'rename', userId, projectId: id });
      return Promise.resolve(membership);
    },
    leave(userId: UserIdType, id: ProjectIdType): Promise<LeaveProjectResponse> {
      calls.push({ method: 'leave', userId, projectId: id });
      return Promise.resolve({});
    },
    listAgents(userId: UserIdType, id: ProjectIdType): Promise<ListProjectAgentsResponse> {
      calls.push({ method: 'listAgents', userId, projectId: id });
      return Promise.resolve({ items: [] });
    },
  };
}

/** The error envelope a response carries. */
function envelopeOf(payload: string): { code: string; message: string } {
  const parsed = JSON.parse(payload) as { error: { code: string; message: string } };
  return parsed.error;
}

beforeEach(() => {
  calls = [];
  app = createAppShell({ config, database, logger });
  registerAuth(app, { jwtSecret: JWT_SECRET });
  // `db` is required by the options type and unused: the stub service is what
  // answers, and passing a real handle here would make this a slower version of
  // the integration suite.
  registerProjectRoutes(app, {
    db: undefined as never,
    service: recordingService(),
  });
});

afterEach(async () => {
  await app.close();
});

describe('authentication', () => {
  it('refuses every project route without a token', async () => {
    // Protected by omission: not one of these routes declares `config.auth`,
    // and that is the entire reason they are guarded. A route added to this
    // module without a thought about credentials joins this list rather than
    // becoming a hole in it.
    const routes = [
      { method: 'GET' as const, url: '/projects' },
      { method: 'POST' as const, url: '/projects' },
      { method: 'GET' as const, url: `/projects/${projectId}` },
      { method: 'POST' as const, url: `/projects/${projectId}/leave` },
      { method: 'GET' as const, url: `/projects/${projectId}/agents` },
    ];

    for (const route of routes) {
      const response = await app.inject({ ...route, payload: {} });
      expect(response.statusCode, route.url).toBe(401);
      expect(envelopeOf(response.payload).code, route.url).toBe(ErrorCode.AUTH_REQUIRED);
    }

    expect(calls).toStrictEqual([]);
  });

  it('takes the caller from the token, never from the request', async () => {
    const impostor = UserId.generate();

    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: bearer(caller) },
      // A body naming somebody else. The route reads `request.requireUser()`
      // and the schema strips everything it does not declare, so this changes
      // nothing — which is the assertion.
      payload: { name: 'Payments Platform', createdBy: impostor, role: 'owner' },
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toStrictEqual([
      { method: 'create', userId: caller, request: { name: 'Payments Platform' } },
    ]);
  });
});

describe('GET /projects', () => {
  it('answers with an items envelope rather than a bare array', async () => {
    // D17. A bare array cannot carry a cursor, and §12.4 makes adding one to a
    // top-level array a major-version change.
    const response = await app.inject({
      method: 'GET',
      url: '/projects',
      headers: { authorization: bearer(caller) },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toStrictEqual({ items: [membership] });
  });
});

describe('POST /projects', () => {
  it('passes the validated body to the service', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: bearer(caller) },
      payload: { name: 'Payments Platform', slug: 'payments' },
    });

    expect(response.statusCode).toBe(200);
    expect(calls[0]?.request).toStrictEqual({ name: 'Payments Platform', slug: 'payments' });
  });

  it('rejects a body the contract does not accept, naming the field', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: bearer(caller) },
      payload: { name: '', slug: 'Not A Slug' },
    });

    expect(response.statusCode).toBe(400);
    const error = envelopeOf(response.payload);
    expect(error.code).toBe(ErrorCode.BAD_REQUEST);
    expect(error.message).toContain('slug');
    expect(calls).toStrictEqual([]);
  });

  it('rejects a missing body rather than defaulting the name', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: bearer(caller) },
    });

    expect(response.statusCode).toBe(400);
    expect(envelopeOf(response.payload).code).toBe(ErrorCode.BAD_REQUEST);
  });
});

describe('/projects/:id', () => {
  it('parses the path parameter with the branded schema', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}`,
      headers: { authorization: bearer(caller) },
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toStrictEqual([{ method: 'get', userId: caller, projectId }]);
  });

  it('answers a malformed identifier with BAD_REQUEST, not NOT_FOUND', async () => {
    // A lookup that misses and a segment that is not an identifier are
    // different mistakes, and only one of them is worth retrying with a
    // different id. Answering both with 404 would tell a caller their
    // well-formed id was wrong when it was never well-formed.
    const response = await app.inject({
      method: 'GET',
      url: '/projects/not-an-id',
      headers: { authorization: bearer(caller) },
    });

    expect(response.statusCode).toBe(400);
    expect(envelopeOf(response.payload).code).toBe(ErrorCode.BAD_REQUEST);
    expect(calls).toStrictEqual([]);
  });

  it('refuses an agent identifier in the project slot', async () => {
    // Branded ids are not interchangeable, and the prefix is what makes that
    // true on the wire as well as in the type system.
    const response = await app.inject({
      method: 'GET',
      url: '/projects/agt_0199a0c0-0000-7000-8000-000000000000',
      headers: { authorization: bearer(caller) },
    });

    expect(response.statusCode).toBe(400);
    expect(calls).toStrictEqual([]);
  });
});

describe('POST /projects/:id/leave', () => {
  it('answers with the empty body the contract specifies', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/leave`,
      headers: { authorization: bearer(caller) },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toStrictEqual({});
    expect(calls).toStrictEqual([{ method: 'leave', userId: caller, projectId }]);
  });

  it('accepts an absent body, since the request has no fields', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/leave`,
      headers: { authorization: bearer(caller) },
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('failures from the service', () => {
  it('travels as a contract envelope with the status the code maps to', async () => {
    const failing: ProjectService = {
      ...recordingService(),
      get(): Promise<GetProjectResponse> {
        return Promise.reject(
          new ProtocolError(ErrorCode.NOT_FOUND, 'No such project, or you are not a member of it.'),
        );
      },
    };

    const own = createAppShell({ config, database, logger });
    registerAuth(own, { jwtSecret: JWT_SECRET });
    registerProjectRoutes(own, { db: undefined as never, service: failing });

    const response = await own.inject({
      method: 'GET',
      url: `/projects/${projectId}`,
      headers: { authorization: bearer(caller) },
    });

    expect(response.statusCode).toBe(404);
    const error = envelopeOf(response.payload);
    expect(ErrorCodeSchema.safeParse(error.code).success).toBe(true);
    expect(error.code).toBe(ErrorCode.NOT_FOUND);

    await own.close();
  });
});
