/**
 * What the agent routes do with a service, and what they refuse before there is
 * one to call.
 *
 * The service is substituted here on purpose. Everything this suite asserts is
 * a property of the *route*: which schema each position is parsed against, what
 * the caller is told when it does not fit, which status a success carries, what
 * the envelope looks like, and — the one that has to hold for all six at once —
 * that not a single route answers without a bearer token, because none of them
 * declares itself public. `services/agents.integration.test.ts` proves what the
 * service does; a stub cannot, and pretending otherwise would only assert that
 * the test and the code agree about a query neither of them runs.
 *
 * The two claims worth stating plainly:
 *
 *  - **Validation happens before the round trip.** Every rejection below is
 *    recorded with the stub having been called zero times. That is the whole
 *    point of parsing with `AgentNameSchema` — the same grammar the database's
 *    `agents_name_format` check compiles — rather than letting the driver
 *    report a constraint violation.
 *  - **A tombstone never reaches the wire.** The service's `AgentRecord` has no
 *    `deletedAt`, and `AgentSchema.parse` on the way out is what keeps it that
 *    way if somebody ever adds one.
 */

import {
  AgentId,
  type AgentName,
  ErrorCode,
  type ErrorEnvelope,
  ProjectId,
  ProtocolError,
  UserId,
} from '@agentchat/protocol';
import type { FastifyInstance } from 'fastify';
import pino, { type Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAppShell } from '../app.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  MIN_JWT_SECRET_LENGTH,
  signAccessToken,
} from '../auth/tokens.js';
import { loadConfig, type ServerConfig } from '../config.js';
import { registerAuth } from '../plugins/auth.js';
import type {
  AgentDeletion,
  AgentProjectRemoval,
  AgentProjectRequest,
  AgentService,
  CreateAgentRequest,
  DeleteAgentRequest,
  ListAgentsRequest,
  RenameAgentRequest,
} from '../services/agents.js';
import type { AgentRecord } from '../services/authorization.js';
import { registerAgentRoutes } from './agents.js';
import type { HealthProbe } from './health.js';

/** The signing key this suite's tokens are minted with. */
const SECRET = 'a'.repeat(MIN_JWT_SECRET_LENGTH);

/** Fixed clock, so nothing here depends on when it runs. */
const NOW = new Date('2026-09-08T12:00:00.000Z');

/** `NOW` in whole seconds, the unit the claims use. */
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);

/** The caller every request below is made as. */
const CALLER = UserId.generate();

const config: ServerConfig = loadConfig({
  DATABASE_URL: 'postgres://agentchat:agentchat@localhost:5432/agentchat',
  LOG_LEVEL: 'silent',
  JWT_SECRET: 'j'.repeat(MIN_JWT_SECRET_LENGTH),
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
});

/** Nothing in this suite queries the database. */
const reachable: HealthProbe = { ping: () => Promise.resolve() };

/** A logger that goes nowhere; the routes log, and none of it is under test. */
function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

/** One call the stub recorded, so a test can assert it was *not* made. */
type Call =
  | { readonly method: 'list'; readonly request: ListAgentsRequest }
  | { readonly method: 'create'; readonly request: CreateAgentRequest }
  | { readonly method: 'rename'; readonly request: RenameAgentRequest }
  | { readonly method: 'delete'; readonly request: DeleteAgentRequest }
  | { readonly method: 'addToProject'; readonly request: AgentProjectRequest }
  | { readonly method: 'removeFromProject'; readonly request: AgentProjectRequest };

/** What the stub should do instead of touching a database. */
interface StubBehaviour {
  /** Thrown by whichever method is called, when set. */
  readonly fails?: ProtocolError;
  /** The agents `list` returns. */
  readonly agents?: readonly AgentRecord[];
}

/** The stub, plus the calls it recorded. */
interface Stub {
  /** The service handed to the routes. */
  readonly service: AgentService;
  /** Every call, in order. */
  readonly calls: Call[];
}

/** An agent record as the service would return one. */
function agentRecord(name: string, owner: UserId = CALLER): AgentRecord {
  return {
    id: AgentId.generate(),
    userId: owner,
    name,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/**
 * Builds a service that records what it was asked and answers from
 * {@link StubBehaviour}.
 *
 * @param behaviour - What it should do.
 * @returns The stub and its call log.
 */
function stubService(behaviour: StubBehaviour = {}): Stub {
  const calls: Call[] = [];

  /** Records a call and applies the configured failure, if any. */
  function record(call: Call): void {
    calls.push(call);
    if (behaviour.fails !== undefined) {
      throw behaviour.fails;
    }
  }

  const service: AgentService = {
    list(request: ListAgentsRequest): Promise<AgentRecord[]> {
      record({ method: 'list', request });
      return Promise.resolve([...(behaviour.agents ?? [])]);
    },
    create(request: CreateAgentRequest): Promise<AgentRecord> {
      record({ method: 'create', request });
      return Promise.resolve(agentRecord(request.name, request.userId));
    },
    rename(request: RenameAgentRequest): Promise<AgentRecord> {
      record({ method: 'rename', request });
      return Promise.resolve({ ...agentRecord(request.name, request.userId), id: request.agentId });
    },
    delete(request: DeleteAgentRequest): Promise<AgentDeletion> {
      record({ method: 'delete', request });
      return Promise.resolve({
        agentId: request.agentId,
        deletedAt: NOW,
        projectsLeft: 2,
        sessionsEnded: 3,
      });
    },
    addToProject(request: AgentProjectRequest): Promise<boolean> {
      record({ method: 'addToProject', request });
      return Promise.resolve(true);
    },
    removeFromProject(request: AgentProjectRequest): Promise<AgentProjectRemoval> {
      record({ method: 'removeFromProject', request });
      return Promise.resolve({ removed: true, sessionsEnded: 1 });
    },
  };

  return { service, calls };
}

const started: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((app) => app.close()));
});

let stub: Stub;
let app: FastifyInstance;

/**
 * Builds the shell with authentication and the agent routes on it.
 *
 * The shell rather than `createApp`, for the reason `plugins/auth.test.ts`
 * gives: `createApp` registers the auth plugin itself, and a second
 * registration on one instance is a duplicate decorator. What matters for this
 * suite is that `registerAgentRoutes` is called with no `config.auth` anywhere
 * in sight — exactly as T-023 will call it — so the 401s below are produced by
 * omission and by nothing else.
 *
 * @param behaviour - How the stubbed service should answer.
 */
function build(behaviour: StubBehaviour = {}): void {
  stub = stubService(behaviour);
  app = createAppShell({ config, database: reachable, logger: silentLogger() });
  started.push(app);

  registerAuth(app, { jwtSecret: SECRET, now: () => NOW });
  registerAgentRoutes(app, { agents: stub.service });
}

/** A bearer token this server accepts, for {@link CALLER}. */
function authorization(): { authorization: string } {
  const token = signAccessToken(
    { sub: CALLER, iat: NOW_SECONDS, exp: NOW_SECONDS + ACCESS_TOKEN_TTL_SECONDS },
    SECRET,
  );

  return { authorization: `Bearer ${token}` };
}

/** The error code in a response body. */
function codeOf(payload: string): string {
  return (JSON.parse(payload) as ErrorEnvelope).error.code;
}

beforeEach(() => {
  build();
});

describe('every agent route is protected by omission', () => {
  // Not one of them names itself in `PUBLIC_ROUTES` and not one sets
  // `config.auth`. If protection ever became opt-in, this is the table that
  // goes red first.
  const routes = [
    { method: 'GET', url: '/agents' },
    { method: 'POST', url: '/agents' },
    { method: 'PATCH', url: `/agents/${AgentId.generate()}` },
    { method: 'DELETE', url: `/agents/${AgentId.generate()}` },
    { method: 'POST', url: `/agents/${AgentId.generate()}/projects` },
    {
      method: 'DELETE',
      url: `/agents/${AgentId.generate()}/projects/${ProjectId.generate()}`,
    },
  ] as const;

  it.each(routes)('refuses $method $url without a token', async ({ method, url }) => {
    const response = await app.inject({ method, url, payload: {} });

    expect(response.statusCode).toBe(401);
    expect(codeOf(response.payload)).toBe(ErrorCode.AUTH_REQUIRED);

    // The service was never reached: authentication happens in a hook, before
    // any handler and therefore before any query.
    expect(stub.calls).toHaveLength(0);
  });
});

describe('GET /agents', () => {
  it('envelopes the list as { items } (D17)', async () => {
    build({ agents: [agentRecord('backend'), agentRecord('frontend')] });

    const response = await app.inject({
      method: 'GET',
      url: '/agents',
      headers: authorization(),
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.payload) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(2);
  });

  it('asks only for the caller’s own agents', async () => {
    await app.inject({ method: 'GET', url: '/agents', headers: authorization() });

    expect(stub.calls).toEqual([{ method: 'list', request: { userId: CALLER } }]);
  });

  it('puts no tombstone on the wire', async () => {
    build({ agents: [agentRecord('backend')] });

    const response = await app.inject({
      method: 'GET',
      url: '/agents',
      headers: authorization(),
    });

    const [item] = (JSON.parse(response.payload) as { items: Record<string, unknown>[] }).items;
    expect(Object.keys(item ?? {}).sort()).toEqual([
      'createdAt',
      'id',
      'name',
      'updatedAt',
      'userId',
    ]);
  });
});

describe('POST /agents', () => {
  it('answers 201 with the created agent', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: authorization(),
      payload: { name: 'backend' },
    });

    expect(response.statusCode).toBe(201);
    expect((JSON.parse(response.payload) as { name: string }).name).toBe('backend');
  });

  it.each([
    ['an empty name', ''],
    ['a leading hyphen', '-backend'],
    ['an uppercase letter', 'Backend'],
    ['an underscore', 'back_end'],
    ['33 characters', 'a'.repeat(33)],
  ])('refuses %s before the service is called', async (_case, name) => {
    const response = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: authorization(),
      payload: { name },
    });

    expect(response.statusCode).toBe(400);
    expect(codeOf(response.payload)).toBe(ErrorCode.BAD_REQUEST);

    // The claim in the module note: the error arrives before the round trip.
    expect(stub.calls).toHaveLength(0);
  });

  it('names the offending field without echoing its value', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: authorization(),
      payload: { name: 'NOT-A-VALID-NAME' },
    });

    const { message } = (JSON.parse(response.payload) as ErrorEnvelope).error;
    expect(message).toContain('name');
    expect(message).not.toContain('NOT-A-VALID-NAME');
  });

  it('reports a name already taken as CONFLICT', async () => {
    build({ fails: new ProtocolError(ErrorCode.CONFLICT, 'taken') });

    const response = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: authorization(),
      payload: { name: 'backend' },
    });

    expect(response.statusCode).toBe(409);
    expect(codeOf(response.payload)).toBe(ErrorCode.CONFLICT);
  });
});

describe('PATCH /agents/:id', () => {
  it('renames and returns the whole agent', async () => {
    const id = AgentId.generate();

    const response = await app.inject({
      method: 'PATCH',
      url: `/agents/${id}`,
      headers: authorization(),
      payload: { name: 'renamed' },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toMatchObject({ id, name: 'renamed' });
    expect(stub.calls).toEqual([
      { method: 'rename', request: { userId: CALLER, agentId: id, name: 'renamed' as AgentName } },
    ]);
  });

  it('refuses a project id in the agent position', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/agents/${ProjectId.generate()}`,
      headers: authorization(),
      payload: { name: 'renamed' },
    });

    expect(response.statusCode).toBe(400);
    expect(stub.calls).toHaveLength(0);
  });

  it('reports a deleted agent as AGENT_DELETED, which is a 410', async () => {
    build({ fails: new ProtocolError(ErrorCode.AGENT_DELETED, 'gone') });

    const response = await app.inject({
      method: 'PATCH',
      url: `/agents/${AgentId.generate()}`,
      headers: authorization(),
      payload: { name: 'renamed' },
    });

    expect(response.statusCode).toBe(410);
    expect(codeOf(response.payload)).toBe(ErrorCode.AGENT_DELETED);
  });
});

describe('DELETE /agents/:id', () => {
  it('answers with no fields', async () => {
    const id = AgentId.generate();

    const response = await app.inject({
      method: 'DELETE',
      url: `/agents/${id}`,
      headers: authorization(),
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({});
    expect(stub.calls).toEqual([{ method: 'delete', request: { userId: CALLER, agentId: id } }]);
  });

  it('reports somebody else’s agent as NOT_FOUND', async () => {
    build({ fails: new ProtocolError(ErrorCode.NOT_FOUND, 'no such agent') });

    const response = await app.inject({
      method: 'DELETE',
      url: `/agents/${AgentId.generate()}`,
      headers: authorization(),
    });

    expect(response.statusCode).toBe(404);
    expect(codeOf(response.payload)).toBe(ErrorCode.NOT_FOUND);
  });
});

describe('POST /agents/:id/projects', () => {
  it('passes both identifiers through, each parsed as its own kind', async () => {
    const agentId = AgentId.generate();
    const projectId = ProjectId.generate();

    const response = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/projects`,
      headers: authorization(),
      payload: { projectId },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({});
    expect(stub.calls).toEqual([
      { method: 'addToProject', request: { userId: CALLER, agentId, projectId } },
    ]);
  });

  it('refuses an agent id in the projectId field', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/agents/${AgentId.generate()}/projects`,
      headers: authorization(),
      payload: { projectId: AgentId.generate() },
    });

    expect(response.statusCode).toBe(400);
    expect(stub.calls).toHaveLength(0);
  });
});

describe('DELETE /agents/:id/projects/:pid', () => {
  it('keeps the two identifier kinds apart', async () => {
    const agentId = AgentId.generate();
    const projectId = ProjectId.generate();

    const response = await app.inject({
      method: 'DELETE',
      url: `/agents/${agentId}/projects/${projectId}`,
      headers: authorization(),
    });

    expect(response.statusCode).toBe(200);
    expect(stub.calls).toEqual([
      { method: 'removeFromProject', request: { userId: CALLER, agentId, projectId } },
    ]);
  });

  it('refuses the two kinds swapped', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/agents/${ProjectId.generate()}/projects/${AgentId.generate()}`,
      headers: authorization(),
    });

    expect(response.statusCode).toBe(400);
    expect(stub.calls).toHaveLength(0);
  });
});
