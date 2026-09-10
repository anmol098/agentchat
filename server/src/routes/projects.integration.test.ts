/**
 * The project endpoints end to end: a real Fastify instance, the real
 * authentication guard, the real authorization service, and a real PostgreSQL.
 *
 * Nothing here is stubbed except the identity provider's absence — tokens are
 * signed directly, because how a token is obtained is T-103's suite and not
 * this one's. Everything else is the production path, which matters because
 * almost every property this task has to establish is decided by the database
 * rather than by this repository:
 *
 *  - the slug unique constraint, and that a collision arrives as a `CONFLICT`
 *    rather than as a 500;
 *  - that creating a project and its owner membership is one transaction, so
 *    no project can exist with nobody able to administer it;
 *  - that a non-member is answered `NOT_FOUND`, byte for byte the same as for
 *    a project that never existed;
 *  - that the last owner cannot leave, and is told why;
 *  - that discovery excludes soft-deleted agents and counts only `active`
 *    sessions.
 *
 * The suite owns a freshly created database, for the reason the other
 * integration suites give: they share one server, and rows written here must
 * not disturb another's.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  AgentId,
  CreateProjectResponseSchema,
  ErrorCode,
  GetProjectResponseSchema,
  ListProjectAgentsResponseSchema,
  ListProjectsResponseSchema,
  MachineId,
  ProjectId,
  type ProjectId as ProjectIdType,
  ProtocolError,
  SessionId,
  UserId,
  type UserId as UserIdType,
} from '@stackgrid/protocol';
import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import pino, { type Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAppShell } from '../app.js';
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken } from '../auth/tokens.js';
import { loadConfig, type ServerConfig } from '../config.js';
import { agentProjects, agents } from '../db/schema/agents.js';
import { projectMembers, projects, users } from '../db/schema/identity.js';
import { machines, sessions } from '../db/schema/messaging.js';
import { registerAuth } from '../plugins/auth.js';
import { createAuthorizationService } from '../services/authorization.js';
import { createProjectService, type ProjectService } from '../services/projects.js';
import type { HealthProbe } from './health.js';
import { registerProjectRoutes } from './projects.js';

/** The generated SQL migrations, exactly as the server image will ship them. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** The signing key both the tokens and the guard use. */
const JWT_SECRET = 'j'.repeat(32);

const schema = { users, projects, projectMembers, agents, agentProjects, machines, sessions };

/** A short unique suffix so nothing collides between runs. */
const unique = (): string => randomUUID().replaceAll('-', '').slice(0, 12);

let pool: Pool | undefined;
let db: NodePgDatabase<typeof schema>;
let databaseName: string;
let app: FastifyInstance;
let service: ProjectService;

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

/** A bearer header for a user, valid now. */
function bearer(userId: UserIdType): string {
  const iat = Math.floor(Date.now() / 1000);
  return `Bearer ${signAccessToken({ sub: userId, iat, exp: iat + ACCESS_TOKEN_TTL_SECONDS }, JWT_SECRET)}`;
}

/**
 * Creates a user.
 *
 * @param handle - Becomes the login, so it must match the schema's grammar.
 * @returns The new user's identifier.
 */
async function createUser(handle: string): Promise<UserIdType> {
  const id = UserId.generate();

  await db.insert(users).values({
    id,
    githubId: unique(),
    username: `${handle}-${unique()}`,
    displayName: handle,
  });

  return id;
}

/** The error envelope a response carries. */
function envelopeOf(payload: string): { code: string; message: string } {
  return (JSON.parse(payload) as { error: { code: string; message: string } }).error;
}

/**
 * Creates a project through the endpoint, as a given caller.
 *
 * @param owner - Who creates it.
 * @param name - The display name.
 * @param slug - An explicit slug, or `undefined` to have one derived.
 * @returns The response, unparsed, so a test can assert on the status too.
 */
async function postProject(
  owner: UserIdType,
  name: string,
  slug?: string,
): Promise<{ statusCode: number; payload: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/projects',
    headers: { authorization: bearer(owner) },
    payload: slug === undefined ? { name } : { name, slug },
  });

  return { statusCode: response.statusCode, payload: response.payload };
}

/**
 * Creates a project and returns its id, failing loudly if creation did not
 * succeed.
 *
 * @param owner - Who creates it.
 * @param name - The display name.
 * @returns The new project's identifier.
 */
async function createProject(owner: UserIdType, name: string): Promise<ProjectIdType> {
  const response = await postProject(owner, name, `p-${unique()}`);
  expect(response.statusCode, response.payload).toBe(200);
  return ProjectId.parse(CreateProjectResponseSchema.parse(JSON.parse(response.payload)).id);
}

/**
 * Adds a member directly, since joining is T-108's endpoint rather than this
 * task's.
 *
 * @param projectId - The project.
 * @param userId - The person joining.
 * @param role - Their role.
 */
async function addMember(
  projectId: ProjectIdType,
  userId: UserIdType,
  role: 'owner' | 'member',
): Promise<void> {
  await db.insert(projectMembers).values({ projectId, userId, role });
}

/**
 * Creates an agent, optionally joined to a project.
 *
 * @param owner - Who owns it.
 * @param name - Its name.
 * @param projectId - A project to join it to.
 * @returns The new agent's identifier.
 */
async function createAgent(
  owner: UserIdType,
  name: string,
  projectId?: ProjectIdType,
): Promise<string> {
  const id = AgentId.generate();
  await db.insert(agents).values({ id, userId: owner, name });
  if (projectId !== undefined) {
    await db.insert(agentProjects).values({ agentId: id, projectId });
  }
  return id;
}

/**
 * Opens a session for an agent in a project.
 *
 * @param owner - The agent's owner, who owns the machine too.
 * @param agentId - The listening agent.
 * @param projectId - Where it is listening.
 * @param status - `active`, `stale` or `ended`; only `active` is presence.
 */
async function openSession(
  owner: UserIdType,
  agentId: string,
  projectId: ProjectIdType,
  status: 'active' | 'stale' | 'ended',
): Promise<void> {
  const machineId = MachineId.generate();
  await db.insert(machines).values({ id: machineId, userId: owner, name: `mac-${unique()}` });

  await db.insert(sessions).values({
    id: SessionId.generate(),
    agentId,
    projectId,
    machineId,
    workingDirectory: '/tmp',
    status,
    endedAt: status === 'ended' ? new Date() : null,
  });
}

/**
 * Runs a service call expected to be refused and returns the error.
 *
 * @param run - The call.
 * @returns The `ProtocolError`.
 * @throws {Error} If it did not throw, or threw something else.
 */
async function refusal(run: () => Promise<unknown>): Promise<ProtocolError> {
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof ProtocolError) {
      return error;
    }
    throw new Error(`Expected a ProtocolError, got: ${String(error)}`);
  }
  throw new Error('Expected this call to be refused, but it returned.');
}

beforeAll(async () => {
  databaseName = `agentchat_t107_${unique()}`;

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`create database "${databaseName}"`);
  } finally {
    await admin.end();
  }

  pool = new Pool({ connectionString: urlForScratchDatabase(databaseName), max: 5 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  const config: ServerConfig = loadConfig({
    DATABASE_URL: urlForScratchDatabase(databaseName),
    LOG_LEVEL: 'silent',
    JWT_SECRET,
    GITHUB_CLIENT_ID: 'test-client-id',
    GITHUB_CLIENT_SECRET: 'test-client-secret',
  });
  const logger: Logger = pino({ level: 'silent' });
  const probe: HealthProbe = { ping: () => Promise.resolve() };

  app = createAppShell({ config, database: probe, logger });
  registerAuth(app, { jwtSecret: JWT_SECRET });
  // Exactly the line T-023 adds to `app.ts`, plus the explicit service so the
  // rename rule — which has no endpoint yet — can be exercised too.
  registerProjectRoutes(app, { db });

  service = createProjectService({ db, authorization: createAuthorizationService(db) });
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

describe('the happy path', () => {
  it('creates a project, makes the creator its owner, and lists it back', async () => {
    const alice = await createUser('alice');

    const created = await postProject(alice, 'Payments Platform');
    expect(created.statusCode, created.payload).toBe(200);

    const project = CreateProjectResponseSchema.parse(JSON.parse(created.payload));
    expect(project.slug).toBe('payments-platform');
    expect(project.name).toBe('Payments Platform');
    expect(project.createdBy).toBe(alice);
    // The creator is the owner. Nothing in the request said so and nothing may.
    expect(project.role).toBe('owner');

    const membershipRows = await db
      .select()
      .from(projectMembers)
      .where(eq(projectMembers.projectId, project.id));
    expect(membershipRows).toStrictEqual([
      expect.objectContaining({ userId: alice, role: 'owner' }),
    ]);

    const read = await app.inject({
      method: 'GET',
      url: `/projects/${project.id}`,
      headers: { authorization: bearer(alice) },
    });
    expect(read.statusCode).toBe(200);
    expect(GetProjectResponseSchema.parse(JSON.parse(read.payload))).toStrictEqual(project);

    const listed = await app.inject({
      method: 'GET',
      url: '/projects',
      headers: { authorization: bearer(alice) },
    });
    expect(listed.statusCode).toBe(200);
    expect(ListProjectsResponseSchema.parse(JSON.parse(listed.payload)).items).toStrictEqual([
      project,
    ]);
  });

  it('lists a member with their own role, not the owner’s', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');
    const projectId = await createProject(alice, 'Shared');
    await addMember(projectId, bob, 'member');

    const response = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}`,
      headers: { authorization: bearer(bob) },
    });

    expect(response.statusCode).toBe(200);
    expect(GetProjectResponseSchema.parse(JSON.parse(response.payload)).role).toBe('member');
  });

  it('lists only the caller’s own projects', async () => {
    const alice = await createUser('alice');
    const carol = await createUser('carol');
    await createProject(alice, 'Hers');

    const response = await app.inject({
      method: 'GET',
      url: '/projects',
      headers: { authorization: bearer(carol) },
    });

    expect(response.statusCode).toBe(200);
    expect(ListProjectsResponseSchema.parse(JSON.parse(response.payload)).items).toStrictEqual([]);
  });
});

describe('a non-member', () => {
  it('is told the project does not exist, in the same words as a project that does not', async () => {
    // The point of the not-found answer (T-106) is that these two responses are
    // indistinguishable. Project ids sit in URLs, shell history and the
    // committed `.agentchat/config.json`, so a `FORBIDDEN` here would turn this
    // endpoint into an oracle for which ids are real.
    const alice = await createUser('alice');
    const carol = await createUser('carol');
    const real = await createProject(alice, 'Invisible');
    const imaginary = ProjectId.generate();

    const [hidden, absent] = await Promise.all([
      app.inject({
        method: 'GET',
        url: `/projects/${real}`,
        headers: { authorization: bearer(carol) },
      }),
      app.inject({
        method: 'GET',
        url: `/projects/${imaginary}`,
        headers: { authorization: bearer(carol) },
      }),
    ]);

    expect(hidden.statusCode).toBe(404);
    expect(absent.statusCode).toBe(404);
    expect(envelopeOf(hidden.payload)).toStrictEqual(envelopeOf(absent.payload));
    expect(envelopeOf(hidden.payload).code).toBe(ErrorCode.NOT_FOUND);
  });

  it('is refused on every route that names a project', async () => {
    const alice = await createUser('alice');
    const carol = await createUser('carol');
    const projectId = await createProject(alice, 'Invisible');

    const attempts = [
      { method: 'GET' as const, url: `/projects/${projectId}` },
      { method: 'GET' as const, url: `/projects/${projectId}/agents` },
      { method: 'POST' as const, url: `/projects/${projectId}/leave` },
    ];

    for (const attempt of attempts) {
      const response = await app.inject({
        ...attempt,
        headers: { authorization: bearer(carol) },
        payload: {},
      });
      expect(response.statusCode, attempt.url).toBe(404);
      expect(envelopeOf(response.payload).code, attempt.url).toBe(ErrorCode.NOT_FOUND);
    }
  });

  it('cannot leave a project it is not in, and leaves the members untouched', async () => {
    const alice = await createUser('alice');
    const carol = await createUser('carol');
    const projectId = await createProject(alice, 'Invisible');

    await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/leave`,
      headers: { authorization: bearer(carol) },
      payload: {},
    });

    const rows = await db
      .select()
      .from(projectMembers)
      .where(eq(projectMembers.projectId, projectId));
    expect(rows).toHaveLength(1);
  });
});

describe('slugs', () => {
  it('refuses a slug already in use rather than suffixing a near-miss', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');
    const slug = `dup-${unique()}`;

    expect((await postProject(alice, 'First', slug)).statusCode).toBe(200);

    const second = await postProject(bob, 'Second', slug);
    expect(second.statusCode).toBe(409);
    expect(envelopeOf(second.payload).code).toBe(ErrorCode.CONFLICT);
    // The caller may well have meant the project that already holds the slug.
    expect(envelopeOf(second.payload).message).toContain('invite');
  });

  it('refuses a collision on a derived slug too, and writes nothing', async () => {
    const alice = await createUser('alice');
    const name = `Derived ${unique()}`;

    expect((await postProject(alice, name)).statusCode).toBe(200);

    const before = await db.select().from(projects);
    const second = await postProject(alice, name);
    expect(second.statusCode).toBe(409);

    // The transaction rolled back: no orphan project row, and therefore no
    // project without an owner.
    expect(await db.select().from(projects)).toHaveLength(before.length);
  });

  it('asks for an explicit slug when the name yields none', async () => {
    const alice = await createUser('alice');

    const response = await postProject(alice, '日本語');
    expect(response.statusCode).toBe(400);
    expect(envelopeOf(response.payload).code).toBe(ErrorCode.BAD_REQUEST);
    expect(envelopeOf(response.payload).message).toContain('slug');

    // And that explicit slug is honoured.
    const named = await postProject(alice, '日本語', `nihongo-${unique()}`);
    expect(named.statusCode).toBe(200);
  });

  it('refuses a slug the check constraint would reject, without a 500', async () => {
    // `a--b` satisfies the protocol's pattern and violates the database's. The
    // service catches it first, so the caller gets an actionable 400 rather
    // than an opaque server error.
    const alice = await createUser('alice');

    const response = await postProject(alice, 'Payments', 'a--b');
    expect(response.statusCode).toBe(400);
    expect(envelopeOf(response.payload).code).toBe(ErrorCode.BAD_REQUEST);
  });
});

describe('leaving', () => {
  it('removes the member, and the project stops being visible to them', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');
    const projectId = await createProject(alice, 'Shared');
    await addMember(projectId, bob, 'member');

    const left = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/leave`,
      headers: { authorization: bearer(bob) },
      payload: {},
    });
    expect(left.statusCode).toBe(200);
    expect(JSON.parse(left.payload)).toStrictEqual({});

    const after = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}`,
      headers: { authorization: bearer(bob) },
    });
    expect(after.statusCode).toBe(404);
  });

  it('refuses the last owner, and says why rather than only no', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');
    const projectId = await createProject(alice, 'Shared');
    await addMember(projectId, bob, 'member');

    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/leave`,
      headers: { authorization: bearer(alice) },
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    const error = envelopeOf(response.payload);
    expect(error.code).toBe(ErrorCode.CONFLICT);
    // The remedy, not just the refusal: an ownerless project can never be
    // renamed or deleted by anybody again.
    expect(error.message).toContain('only owner');
    expect(error.message).toContain('owner before you leave');
  });

  it('lets the last owner leave once somebody else owns it too', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');
    const projectId = await createProject(alice, 'Shared');
    await addMember(projectId, bob, 'owner');

    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/leave`,
      headers: { authorization: bearer(alice) },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
  });

  it('takes the leaver’s agents out of the project with them', async () => {
    // Otherwise `@bob/backend` stays addressable, and deliverable to, in a
    // project Bob can no longer see. The recipient rule asks whether the agent
    // participates, not whether its owner is still a member.
    const alice = await createUser('alice');
    const bob = await createUser('bob');
    const projectId = await createProject(alice, 'Shared');
    const other = await createProject(bob, 'Bobs');
    await addMember(projectId, bob, 'member');

    const bobsAgent = await createAgent(bob, 'backend', projectId);
    await db.insert(agentProjects).values({ agentId: bobsAgent, projectId: other });
    const alicesAgent = await createAgent(alice, 'frontend', projectId);

    await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/leave`,
      headers: { authorization: bearer(bob) },
      payload: {},
    });

    const remaining = await db
      .select()
      .from(agentProjects)
      .where(eq(agentProjects.projectId, projectId));
    expect(remaining).toStrictEqual([expect.objectContaining({ agentId: alicesAgent })]);

    // Only this project. Bob's agent is untouched everywhere else.
    const elsewhere = await db
      .select()
      .from(agentProjects)
      .where(eq(agentProjects.agentId, bobsAgent));
    expect(elsewhere).toStrictEqual([expect.objectContaining({ projectId: other })]);
  });
});

describe('renaming', () => {
  it('lets an owner change the display name and leaves the slug alone', async () => {
    // The slug is committed to `.agentchat/config.json` and typed by teammates;
    // moving it to match a cosmetic change would break both.
    const alice = await createUser('alice');
    const projectId = await createProject(alice, 'Before');

    const before = await service.get(alice, projectId);
    const renamed = await service.rename(alice, projectId, 'After');

    expect(renamed.name).toBe('After');
    expect(renamed.slug).toBe(before.slug);
    expect(renamed.role).toBe('owner');
    expect((await service.get(alice, projectId)).name).toBe('After');
  });

  it('refuses a member with FORBIDDEN, which tells them who to ask', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');
    const projectId = await createProject(alice, 'Before');
    await addMember(projectId, bob, 'member');

    const error = await refusal(() => service.rename(bob, projectId, 'After'));
    // A member already knows the project exists, so hiding it would tell them
    // nothing they do not know and would hide the actionable part.
    expect(error.code).toBe(ErrorCode.FORBIDDEN);
    expect((await service.get(alice, projectId)).name).toBe('Before');
  });

  it('refuses a non-member with NOT_FOUND, revealing nothing', async () => {
    const alice = await createUser('alice');
    const carol = await createUser('carol');
    const projectId = await createProject(alice, 'Before');

    const error = await refusal(() => service.rename(carol, projectId, 'After'));
    expect(error.code).toBe(ErrorCode.NOT_FOUND);
    expect((await service.get(alice, projectId)).name).toBe('Before');
  });
});

describe('agent discovery', () => {
  it('lists live agents with their owner and their presence', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');
    const projectId = await createProject(alice, 'Shared');
    await addMember(projectId, bob, 'member');

    const alicesAgent = await createAgent(alice, 'aaa', projectId);
    const bobsAgent = await createAgent(bob, 'bbb', projectId);
    await openSession(alice, alicesAgent, projectId, 'active');
    await openSession(alice, alicesAgent, projectId, 'active');
    // Neither of these is presence: plan §2 counts `active` sessions only.
    await openSession(bob, bobsAgent, projectId, 'stale');
    await openSession(bob, bobsAgent, projectId, 'ended');

    const response = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}/agents`,
      headers: { authorization: bearer(bob) },
    });

    expect(response.statusCode, response.payload).toBe(200);
    const { items } = ListProjectAgentsResponseSchema.parse(JSON.parse(response.payload));
    expect(items).toHaveLength(2);

    const mine = items.find((item) => item.agent.id === alicesAgent);
    expect(mine?.sessions).toBe(2);
    expect(mine?.online).toBe(true);
    expect(mine?.owner.id).toBe(alice);
    // A fellow member sees a summary, never a contact address.
    expect(mine?.owner).not.toHaveProperty('email');

    const theirs = items.find((item) => item.agent.id === bobsAgent);
    expect(theirs?.sessions).toBe(0);
    expect(theirs?.online).toBe(false);
  });

  it('counts only sessions in this project', async () => {
    const alice = await createUser('alice');
    const here = await createProject(alice, 'Here');
    const elsewhere = await createProject(alice, 'Elsewhere');

    const agentId = await createAgent(alice, 'roamer', here);
    await db.insert(agentProjects).values({ agentId, projectId: elsewhere });
    await openSession(alice, agentId, elsewhere, 'active');

    const response = await app.inject({
      method: 'GET',
      url: `/projects/${here}/agents`,
      headers: { authorization: bearer(alice) },
    });

    const { items } = ListProjectAgentsResponseSchema.parse(JSON.parse(response.payload));
    expect(items[0]?.sessions).toBe(0);
    expect(items[0]?.online).toBe(false);
  });

  it('omits a soft-deleted agent (D13)', async () => {
    const alice = await createUser('alice');
    const projectId = await createProject(alice, 'Shared');
    const live = await createAgent(alice, 'live', projectId);
    const dead = await createAgent(alice, 'dead', projectId);
    await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, dead));

    const response = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}/agents`,
      headers: { authorization: bearer(alice) },
    });

    const { items } = ListProjectAgentsResponseSchema.parse(JSON.parse(response.payload));
    expect(items.map((item) => item.agent.id)).toStrictEqual([live]);
  });

  it('omits an agent whose owner is no longer a member', async () => {
    // Belt and braces beside the cleanup in `leave`: discovery answers "who
    // else is in this project", and somebody who has left is not.
    const alice = await createUser('alice');
    const bob = await createUser('bob');
    const projectId = await createProject(alice, 'Shared');
    await addMember(projectId, bob, 'member');

    const alicesAgent = await createAgent(alice, 'stays', projectId);
    const bobsAgent = await createAgent(bob, 'goes', projectId);

    // The membership row removed on its own, as an admin path or a future
    // removal endpoint might: the participation row is deliberately left.
    await db.delete(projectMembers).where(eq(projectMembers.userId, bob));
    expect(bobsAgent).toBeDefined();

    const response = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}/agents`,
      headers: { authorization: bearer(alice) },
    });

    const { items } = ListProjectAgentsResponseSchema.parse(JSON.parse(response.payload));
    expect(items.map((item) => item.agent.id)).toStrictEqual([alicesAgent]);
  });

  it('answers an empty project with an items envelope, not a bare array', async () => {
    const alice = await createUser('alice');
    const projectId = await createProject(alice, 'Empty');

    const response = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}/agents`,
      headers: { authorization: bearer(alice) },
    });

    expect(JSON.parse(response.payload)).toStrictEqual({ items: [] });
  });
});
