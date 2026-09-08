/**
 * The authorization service against a real PostgreSQL database.
 *
 * `./authorization.test.ts` proves the decision table is right. This suite
 * proves the queries feed it the facts it is decided on — that "is the caller a
 * member", "does the agent participate" and "is the agent's owner a member" are
 * three different questions and each `select` asks the one it claims to.
 * Mocking that would be mocking the thing under test.
 *
 * It also asserts two properties that only exist at this level:
 *
 *  - the *envelope* a caller receives is identical for two different causes of
 *    one code, after passing through `errors.ts` exactly as a route's would;
 *  - each assertion costs one statement, counted by a runner that wraps the
 *    real handle. That is a hot-path claim in the module's own documentation,
 *    and documentation is not a test.
 *
 * The suite owns a freshly created database so the migration is applied to an
 * empty one and nothing here can disturb another suite's rows.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AgentId, ErrorCode, ProjectId, ProtocolError, UserId } from '@agentchat/protocol';
import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentProjects, agents } from '../db/schema/agents.js';
import { projectMembers, projects, users } from '../db/schema/identity.js';
import { type ErrorResponse, toErrorResponse } from '../errors.js';
import {
  type AuthorizationService,
  createAuthorizationService,
  type ProjectRole,
} from './authorization.js';

/** The generated SQL migrations, exactly as the server image will ship them. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

const schema = { users, projects, projectMembers, agents, agentProjects };

/** A short unique suffix so nothing collides between runs. */
const unique = (): string => randomUUID().replaceAll('-', '').slice(0, 12);

let pool: Pool | undefined;
let db: NodePgDatabase<typeof schema>;
let databaseName: string;

/** Counts the statements the service issues, for the one-round-trip claim. */
let statements = 0;

/** The service under test, over a handle that counts `select`s. */
let auth: AuthorizationService;

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
 * Creates a user.
 *
 * @param handle - Becomes the GitHub login, so it must match the schema's
 *   lowercase grammar.
 * @returns The new user's identifier.
 */
async function createUser(handle: string): Promise<UserId> {
  const id = UserId.generate();

  await db.insert(users).values({
    id,
    githubId: unique(),
    username: `${handle}-${unique()}`,
    displayName: handle,
  });

  return id;
}

/**
 * Creates a project with one owner.
 *
 * @param owner - Who creates it and owns it.
 * @returns The new project's identifier.
 */
async function createProject(owner: UserId): Promise<ProjectId> {
  const id = ProjectId.generate();
  const slug = `p-${unique()}`;

  await db.insert(projects).values({ id, slug, name: slug, createdBy: owner });
  await db.insert(projectMembers).values({ projectId: id, userId: owner, role: 'owner' });

  return id;
}

/**
 * Adds a member to a project.
 *
 * @param projectId - The project.
 * @param userId - The person joining.
 * @param role - Their role.
 */
async function addMember(projectId: ProjectId, userId: UserId, role: ProjectRole): Promise<void> {
  await db.insert(projectMembers).values({ projectId, userId, role });
}

/**
 * Creates an agent, optionally joined to a project.
 *
 * @param owner - Who owns it.
 * @param projectId - A project to join it to, or `undefined` to leave it out.
 * @returns The new agent's identifier.
 */
async function createAgent(owner: UserId, projectId?: ProjectId): Promise<AgentId> {
  const id = AgentId.generate();

  await db.insert(agents).values({ id, userId: owner, name: `a-${unique()}` });
  if (projectId !== undefined) {
    await db.insert(agentProjects).values({ agentId: id, projectId });
  }

  return id;
}

/**
 * Soft-deletes an agent the way D13 describes: the tombstone is set and the
 * participation rows go.
 *
 * @param agentId - The agent to retire.
 */
async function softDelete(agentId: AgentId): Promise<void> {
  await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, agentId));
  await db.delete(agentProjects).where(eq(agentProjects.agentId, agentId));
}

/**
 * Runs an assertion expected to fail and returns the error it threw.
 *
 * @param run - The assertion.
 * @returns The `ProtocolError`.
 * @throws {Error} If it did not throw, or threw something else — either is a
 *   rule that is not enforced, which must not read as a pass.
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
  throw new Error('Expected this assertion to be refused, but it passed.');
}

/**
 * The response a route would send for a refusal.
 *
 * @param run - The assertion.
 * @returns Status and envelope, through the same path a handler's throw takes.
 */
async function responseFor(run: () => Promise<unknown>): Promise<ErrorResponse> {
  return toErrorResponse(await refusal(run));
}

/**
 * Counts the statements one call issues.
 *
 * @param run - The call.
 * @returns How many `select`s reached the database handle.
 */
async function statementsFor(run: () => Promise<unknown>): Promise<number> {
  statements = 0;
  await run().catch(() => undefined);
  return statements;
}

// The cast of characters. Alice and Bob share `alpha`; Carol is a stranger to
// it, which is what makes her agents the ones that must stay invisible.
let alice: UserId;
let bob: UserId;
let carol: UserId;
let alpha: ProjectId;
let beta: ProjectId;

/** Alice's agent, in `alpha`. */
let aliceInAlpha: AgentId;
/** Alice's agent, live, in no project. */
let aliceUnjoined: AgentId;
/** Alice's agent, soft-deleted. */
let aliceDeleted: AgentId;
/** Bob's agent, in `alpha`. */
let bobInAlpha: AgentId;
/** Carol's agent, in `beta` only. */
let carolInBeta: AgentId;

beforeAll(async () => {
  databaseName = `agentchat_t106_${unique()}`;

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`create database "${databaseName}"`);
  } finally {
    await admin.end();
  }

  pool = new Pool({ connectionString: urlForScratchDatabase(databaseName), max: 5 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  // A handle that is the real one in every respect except that it keeps count.
  auth = createAuthorizationService({
    select: ((...args: Parameters<typeof db.select>) => {
      statements += 1;
      return db.select(...args);
      // The service's runner type is a `Pick` of the Drizzle handle; the
      // overloads do not survive being wrapped, so the shape is restated here
      // rather than weakened in the module the server depends on.
    }) as typeof db.select,
  });

  alice = await createUser('alice');
  bob = await createUser('bob');
  carol = await createUser('carol');

  alpha = await createProject(alice);
  beta = await createProject(carol);
  await addMember(alpha, bob, 'member');

  aliceInAlpha = await createAgent(alice, alpha);
  aliceUnjoined = await createAgent(alice);
  aliceDeleted = await createAgent(alice, alpha);
  await softDelete(aliceDeleted);
  bobInAlpha = await createAgent(bob, alpha);
  carolInBeta = await createAgent(carol, beta);
});

afterAll(async () => {
  await pool?.end();

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await admin.end();
  }
});

describe('project membership', () => {
  it('returns the project and the role, so the caller need not select it again', async () => {
    const access = await auth.assertProjectMember({ userId: bob, projectId: alpha });

    expect(access.project.id).toBe(alpha);
    expect(access.project.slug).toMatch(/^p-/);
    expect(access.project.createdBy).toBe(alice);
    expect(access.role).toBe('member');
    expect(access.joinedAt).toBeInstanceOf(Date);
  });

  it('refuses a non-member with 404', async () => {
    const response = await responseFor(() =>
      auth.assertProjectMember({ userId: carol, projectId: alpha }),
    );

    expect(response.statusCode).toBe(404);
    expect(response.body.error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('answers a real project and an imaginary one identically', async () => {
    // The disclosure test. If these envelopes differed by a byte,
    // `GET /projects/:id` would confirm which project ids exist.
    const stranger = await responseFor(() =>
      auth.assertProjectMember({ userId: carol, projectId: alpha }),
    );
    const imaginary = await responseFor(() =>
      auth.assertProjectMember({ userId: carol, projectId: ProjectId.generate() }),
    );

    expect(stranger).toEqual(imaginary);
  });
});

describe('project ownership', () => {
  it('admits the owner', async () => {
    const access = await auth.assertProjectOwner({ userId: alice, projectId: alpha });
    expect(access.role).toBe('owner');
  });

  it('refuses an ordinary member with 403, naming the remedy', async () => {
    const response = await responseFor(() =>
      auth.assertProjectOwner({ userId: bob, projectId: alpha }),
    );

    expect(response.statusCode).toBe(403);
    expect(response.body.error.code).toBe(ErrorCode.FORBIDDEN);
    expect(response.body.error.message).toContain('owner');
  });

  it('refuses a non-member with 404, not 403', async () => {
    // Bob and Carol both fail the same rule on the same project and are told
    // different things, because only one of them already knows it exists.
    const response = await responseFor(() =>
      auth.assertProjectOwner({ userId: carol, projectId: alpha }),
    );

    expect(response.statusCode).toBe(404);
    expect(response.body.error.code).toBe(ErrorCode.NOT_FOUND);
  });
});

describe('agent ownership', () => {
  it('returns a live agent without a tombstone field to forget', async () => {
    const agent = await auth.assertAgentOwner({ userId: alice, agentId: aliceInAlpha });

    expect(agent.id).toBe(aliceInAlpha);
    expect(agent.userId).toBe(alice);
    expect(agent).not.toHaveProperty('deletedAt');
  });

  it("refuses somebody else's agent as if it did not exist", async () => {
    const stranger = await responseFor(() =>
      auth.assertAgentOwner({ userId: bob, agentId: aliceInAlpha }),
    );
    const imaginary = await responseFor(() =>
      auth.assertAgentOwner({ userId: bob, agentId: AgentId.generate() }),
    );

    expect(stranger.statusCode).toBe(404);
    expect(stranger).toEqual(imaginary);
  });

  it('refuses a soft-deleted agent with 410 to its owner', async () => {
    const response = await responseFor(() =>
      auth.assertAgentOwner({ userId: alice, agentId: aliceDeleted }),
    );

    expect(response.statusCode).toBe(410);
    expect(response.body.error.code).toBe(ErrorCode.AGENT_DELETED);
  });

  it('refuses a soft-deleted agent with 404 to anybody else', async () => {
    const response = await responseFor(() =>
      auth.assertAgentOwner({ userId: bob, agentId: aliceDeleted }),
    );

    expect(response.statusCode).toBe(404);
    expect(response.body.error.code).toBe(ErrorCode.NOT_FOUND);
  });
});

describe('addressing an agent in a project', () => {
  it("admits a co-member's participating agent", async () => {
    const agent = await auth.assertAgentInProject({
      userId: bob,
      agentId: aliceInAlpha,
      projectId: alpha,
    });

    expect(agent.id).toBe(aliceInAlpha);
    expect(agent.userId).toBe(alice);
  });

  it('refuses a caller who is not in the project', async () => {
    // Carol asks about an agent that genuinely is in `alpha`, and is told
    // nothing about either.
    const response = await responseFor(() =>
      auth.assertAgentInProject({ userId: carol, agentId: aliceInAlpha, projectId: alpha }),
    );

    expect(response.statusCode).toBe(404);
    expect(response.body.error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it("offers the join remedy for a co-member's agent that is outside the project", async () => {
    const response = await responseFor(() =>
      auth.assertAgentInProject({ userId: bob, agentId: aliceUnjoined, projectId: alpha }),
    );

    expect(response.statusCode).toBe(403);
    expect(response.body.error.code).toBe(ErrorCode.AGENT_NOT_IN_PROJECT);
    expect(response.body.error.message).toContain('agentchat agent join');
  });

  it("hides a stranger's agent rather than confirming it exists", async () => {
    // Carol is in no project with Alice, so `carolInBeta` must look exactly
    // like an id that was never minted, even though it names a live agent.
    const stranger = await responseFor(() =>
      auth.assertAgentInProject({ userId: alice, agentId: carolInBeta, projectId: alpha }),
    );
    const imaginary = await responseFor(() =>
      auth.assertAgentInProject({ userId: alice, agentId: AgentId.generate(), projectId: alpha }),
    );

    expect(stranger.statusCode).toBe(404);
    expect(stranger).toEqual(imaginary);
  });

  it('refuses a soft-deleted agent, telling only its owner why', async () => {
    const toOwner = await responseFor(() =>
      auth.assertAgentInProject({ userId: alice, agentId: aliceDeleted, projectId: alpha }),
    );
    const toOther = await responseFor(() =>
      auth.assertAgentInProject({ userId: bob, agentId: aliceDeleted, projectId: alpha }),
    );

    expect(toOwner.body.error.code).toBe(ErrorCode.AGENT_DELETED);
    expect(toOther.body.error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('refuses a tombstone that still holds a participation row', async () => {
    // Deletion is meant to remove `agent_projects` rows, but nothing in the
    // database enforces that, so a hand-written UPDATE or a half-finished
    // service call can leave one behind. Liveness is checked before
    // participation precisely so that row does not become a way back in.
    const zombie = await createAgent(alice, alpha);
    await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, zombie));

    const response = await responseFor(() =>
      auth.assertAgentInProject({ userId: alice, agentId: zombie, projectId: alpha }),
    );

    expect(response.body.error.code).toBe(ErrorCode.AGENT_DELETED);
    await expect(
      auth.assertOwnAgentInProject({ userId: alice, agentId: zombie, projectId: alpha }),
    ).rejects.toBeInstanceOf(ProtocolError);
  });
});

describe('acting as an agent in a project', () => {
  it('admits an owned, live, participating agent', async () => {
    const agent = await auth.assertOwnAgentInProject({
      userId: alice,
      agentId: aliceInAlpha,
      projectId: alpha,
    });

    expect(agent.id).toBe(aliceInAlpha);
  });

  it("refuses a co-member's agent even though it is in the project", async () => {
    // The rule that stops Bob sending as `@alice/backend`. Participation alone
    // would have admitted it: `bobInAlpha` and `aliceInAlpha` are equally in
    // `alpha`, and only ownership separates them.
    const response = await responseFor(() =>
      auth.assertOwnAgentInProject({ userId: bob, agentId: aliceInAlpha, projectId: alpha }),
    );

    expect(response.statusCode).toBe(404);
    expect(response.body.error.code).toBe(ErrorCode.NOT_FOUND);

    // And the same call for Bob's own agent passes, so the refusal above is
    // about ownership and not about something incidental to the fixtures.
    await expect(
      auth.assertOwnAgentInProject({ userId: bob, agentId: bobInAlpha, projectId: alpha }),
    ).resolves.toMatchObject({ id: bobInAlpha });
  });

  it('refuses an owned agent that never joined the project', async () => {
    const response = await responseFor(() =>
      auth.assertOwnAgentInProject({ userId: alice, agentId: aliceUnjoined, projectId: alpha }),
    );

    expect(response.statusCode).toBe(403);
    expect(response.body.error.code).toBe(ErrorCode.AGENT_NOT_IN_PROJECT);
  });

  it('refuses an owner who is not in the project themselves', async () => {
    // Carol owns `carolInBeta` and it is in `beta`, but she is asking about
    // `alpha`, where she is nobody.
    const response = await responseFor(() =>
      auth.assertOwnAgentInProject({ userId: carol, agentId: carolInBeta, projectId: alpha }),
    );

    expect(response.statusCode).toBe(404);
    expect(response.body.error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('refuses a soft-deleted agent', async () => {
    const response = await responseFor(() =>
      auth.assertOwnAgentInProject({ userId: alice, agentId: aliceDeleted, projectId: alpha }),
    );

    expect(response.statusCode).toBe(410);
    expect(response.body.error.code).toBe(ErrorCode.AGENT_DELETED);
  });
});

describe('leaving a project', () => {
  it('lets an ordinary member leave', async () => {
    const access = await auth.assertCanLeaveProject({ userId: bob, projectId: alpha });
    expect(access.role).toBe('member');
  });

  it('refuses the last owner with 409', async () => {
    const response = await responseFor(() =>
      auth.assertCanLeaveProject({ userId: alice, projectId: alpha }),
    );

    expect(response.statusCode).toBe(409);
    expect(response.body.error.code).toBe(ErrorCode.CONFLICT);
  });

  it('refuses a non-member with 404', async () => {
    const response = await responseFor(() =>
      auth.assertCanLeaveProject({ userId: carol, projectId: alpha }),
    );

    expect(response.statusCode).toBe(404);
  });

  it('lets the former last owner leave once a second owner exists', async () => {
    const owner = await createUser('dana');
    const project = await createProject(owner);
    const heir = await createUser('erin');

    await expect(
      auth.assertCanLeaveProject({ userId: owner, projectId: project }),
    ).rejects.toBeInstanceOf(ProtocolError);

    await addMember(project, heir, 'owner');

    await expect(
      auth.assertCanLeaveProject({ userId: owner, projectId: project }),
    ).resolves.toMatchObject({ role: 'owner' });
  });
});

describe('cost', () => {
  it('spends one statement per assertion, on the paths a send takes', async () => {
    // Three assertions on every send. If any of them grew a second round trip
    // this would say so, which prose in the module header cannot.
    expect(
      await statementsFor(() => auth.assertProjectMember({ userId: alice, projectId: alpha })),
    ).toBe(1);
    expect(
      await statementsFor(() =>
        auth.assertOwnAgentInProject({ userId: alice, agentId: aliceInAlpha, projectId: alpha }),
      ),
    ).toBe(1);
    expect(
      await statementsFor(() =>
        auth.assertAgentInProject({ userId: alice, agentId: bobInAlpha, projectId: alpha }),
      ),
    ).toBe(1);
    expect(
      await statementsFor(() => auth.assertAgentOwner({ userId: alice, agentId: aliceInAlpha })),
    ).toBe(1);
    expect(
      await statementsFor(() => auth.assertCanLeaveProject({ userId: bob, projectId: alpha })),
    ).toBe(1);
  });

  it('spends one statement on a refusal too', async () => {
    // A rule that answered a stranger more slowly than a member would be a
    // timing oracle for exactly the fact the code choice hides.
    expect(
      await statementsFor(() => auth.assertProjectMember({ userId: carol, projectId: alpha })),
    ).toBe(1);
    expect(
      await statementsFor(() =>
        auth.assertAgentInProject({ userId: carol, agentId: aliceInAlpha, projectId: alpha }),
      ),
    ).toBe(1);
  });
});
