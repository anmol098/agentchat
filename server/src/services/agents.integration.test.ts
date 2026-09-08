/**
 * The agent lifecycle against a real PostgreSQL database.
 *
 * `routes/agents.test.ts` proves what the routes do with a service. This suite
 * proves what the service does, and almost everything it asserts is decided by
 * the database rather than by this repository: which partial index a name
 * collides on, that a tombstone releases that name, that a session's `status`
 * and `ended_at` may not disagree, and — the claim this suite exists for —
 * that a soft delete is one transaction and not three writes that happen to be
 * next to each other. A stub would only demonstrate that the test and the code
 * agree about statements neither of them runs.
 *
 * ## The atomicity case
 *
 * The delete does three things (D13): stamps the tombstone, removes the
 * `agent_projects` rows, ends the sessions. "Half-applied, so the agent is
 * deleted and still addressable" is not a hypothetical — it is the zombie
 * `services/authorization.ts` guards against, and its suite has a test for it.
 * So this one makes the third write fail *for real*: another connection holds
 * an `ACCESS EXCLUSIVE` lock on `sessions`, and the service's own connection is
 * configured with a `lock_timeout`, so the `UPDATE sessions` is refused by the
 * engine after the first two writes have already been applied inside the
 * transaction. Nothing is stubbed, nothing is monkey-patched, and the assertion
 * afterwards is the one that matters: the agent is live, joined, listening and
 * still addressable. A delete that did not happen, rather than one that half
 * did.
 *
 * The suite owns a freshly created database, for the reason the other
 * integration suites give: they share one server and rows written here must not
 * disturb another's.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  type AgentId,
  ConversationId,
  ErrorCode,
  MachineId,
  MessageId,
  ProjectId,
  ProtocolError,
  SessionId,
  UserId,
} from '@agentchat/protocol';
import { and, eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { agentProjects, agents } from '../db/schema/agents.js';
import { projectMembers, projects, users } from '../db/schema/identity.js';
import { conversations, machines, messages, sessions } from '../db/schema/messaging.js';
import { type AgentService, createAgentService } from './agents.js';
import { createAuthorizationService } from './authorization.js';

/** The generated SQL migrations, exactly as the server image will ship them. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

const schema = {
  users,
  projects,
  projectMembers,
  agents,
  agentProjects,
  machines,
  sessions,
  conversations,
  messages,
};

/** A short unique suffix so nothing collides between runs. */
const unique = (): string => randomUUID().replaceAll('-', '').slice(0, 12);

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let databaseName: string;
let service: AgentService;

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
 * @param handle - Becomes the GitHub login, so it must match the lowercase
 *   grammar the schema enforces.
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
 */
async function addMember(projectId: ProjectId, userId: UserId): Promise<void> {
  await db.insert(projectMembers).values({ projectId, userId, role: 'member' });
}

/**
 * Registers a listener: one `agentchat listen` process, as a row.
 *
 * @param userId - Who owns the machine.
 * @param agentId - The agent the listener speaks for.
 * @param projectId - The project it is listening in.
 * @returns The new session's identifier.
 */
async function createSession(
  userId: UserId,
  agentId: AgentId,
  projectId: ProjectId,
): Promise<SessionId> {
  const machineId = MachineId.generate();
  await db.insert(machines).values({ id: machineId, userId, name: `m-${unique()}` });

  const id = SessionId.generate();
  await db.insert(sessions).values({
    id,
    agentId,
    projectId,
    machineId,
    runtime: 'claude-code',
    workingDirectory: '/tmp/agentchat',
  });

  return id;
}

/**
 * Sends a message from one agent to another, so a later delete has history to
 * preserve.
 *
 * @param projectId - The project it was sent in.
 * @param senderAgentId - Who sent it.
 * @param recipientAgentId - Who it was addressed to.
 * @returns The new message's identifier.
 */
async function createMessage(
  projectId: ProjectId,
  senderAgentId: AgentId,
  recipientAgentId: AgentId,
): Promise<MessageId> {
  const conversationId = ConversationId.generate();
  await db.insert(conversations).values({ id: conversationId, projectId });

  const id = MessageId.generate();
  await db.insert(messages).values({
    id,
    projectId,
    conversationId,
    senderAgentId,
    recipientAgentId,
    content: 'the build is green',
    clientMessageId: unique(),
  });

  return id;
}

/** The stored row for an agent, tombstone included. Read directly, on purpose. */
async function agentRow(agentId: AgentId): Promise<typeof agents.$inferSelect | undefined> {
  const rows = await db.select().from(agents).where(eq(agents.id, agentId));
  return rows[0];
}

/** Which projects an agent currently participates in. */
async function participationOf(agentId: AgentId): Promise<string[]> {
  const rows = await db
    .select({ projectId: agentProjects.projectId })
    .from(agentProjects)
    .where(eq(agentProjects.agentId, agentId));

  return rows.map((row) => row.projectId).sort();
}

/**
 * Postgres' `lock_not_available`, raised when `lock_timeout` expires.
 *
 * The atomicity case asserts this specific code rather than "an error", because
 * it is what pins *where* the delete failed: nothing else in the transaction
 * touches a locked object, so a lock timeout can only have come from the third
 * write. An assertion that merely something threw would pass just as happily if
 * the first statement had failed, which would prove nothing about rollback.
 */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * The Postgres `SQLSTATE` a thrown value carries, if any.
 *
 * Walks the cause chain, because Drizzle wraps driver errors.
 *
 * @param error - Whatever was thrown.
 * @returns The five-character code, or `undefined`.
 */
function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;

  while (typeof current === 'object' && current !== null) {
    if ('code' in current) {
      const { code } = current as { code: unknown };
      if (typeof code === 'string') {
        return code;
      }
    }
    current = 'cause' in current ? (current as { cause: unknown }).cause : undefined;
  }

  return undefined;
}

/** The status of one session. */
async function sessionStatus(sessionId: SessionId): Promise<string | undefined> {
  const rows = await db
    .select({ status: sessions.status, endedAt: sessions.endedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId));

  return rows[0]?.status;
}

/**
 * Runs a call expected to fail and returns the `ProtocolError` it threw.
 *
 * @param run - The call.
 * @returns The error.
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
  throw new Error('Expected this call to be refused, but it succeeded.');
}

// The cast of characters. Alice and Bob share `alpha`; Carol is a stranger to
// it, which is what makes her project the one Alice may not join an agent to.
let alice: UserId;
let bob: UserId;
let carol: UserId;
let alpha: ProjectId;
let beta: ProjectId;
let carolsProject: ProjectId;

beforeAll(async () => {
  databaseName = `agentchat_t109_${unique()}`;

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`create database "${databaseName}"`);
  } finally {
    await admin.end();
  }

  pool = new Pool({ connectionString: urlForScratchDatabase(databaseName), max: 5 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  service = createAgentService(db);
}, 60_000);

afterAll(async () => {
  await pool.end();

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await admin.end();
  }
});

beforeEach(async () => {
  alice = await createUser('alice');
  bob = await createUser('bob');
  carol = await createUser('carol');

  alpha = await createProject(alice);
  beta = await createProject(alice);
  carolsProject = await createProject(carol);

  await addMember(alpha, bob);
});

describe('create', () => {
  it('mints a prefixed identifier and returns the stored row', async () => {
    const created = await service.create({ userId: alice, name: 'backend' });

    expect(created.id.startsWith('agt_')).toBe(true);
    expect(created).toMatchObject({ userId: alice, name: 'backend' });
    expect(await agentRow(created.id)).toMatchObject({ name: 'backend', deletedAt: null });
  });

  it('refuses a second live agent with the same name, as CONFLICT', async () => {
    await service.create({ userId: alice, name: 'backend' });

    const error = await refusal(() => service.create({ userId: alice, name: 'backend' }));
    expect(error.code).toBe(ErrorCode.CONFLICT);
  });

  it('lets two different users each have an agent called backend', async () => {
    await service.create({ userId: alice, name: 'backend' });
    const bobs = await service.create({ userId: bob, name: 'backend' });

    expect(bobs.userId).toBe(bob);
  });
});

describe('list', () => {
  it('returns the caller’s live agents by name, and nobody else’s', async () => {
    await service.create({ userId: alice, name: 'zeta' });
    await service.create({ userId: alice, name: 'alpha-agent' });
    await service.create({ userId: bob, name: 'bobs-agent' });

    const mine = await service.list({ userId: alice });

    expect(mine.map((agent) => agent.name)).toEqual(['alpha-agent', 'zeta']);
  });

  it('omits a deleted agent', async () => {
    const created = await service.create({ userId: alice, name: 'backend' });
    await service.delete({ userId: alice, agentId: created.id });

    expect(await service.list({ userId: alice })).toEqual([]);
  });
});

describe('rename', () => {
  it('changes the name and bumps updatedAt', async () => {
    const created = await service.create({ userId: alice, name: 'backend' });

    const renamed = await service.rename({
      userId: alice,
      agentId: created.id,
      name: 'api',
    });

    expect(renamed).toMatchObject({ id: created.id, name: 'api' });
    expect(renamed.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  it('refuses a name another live agent of the caller holds', async () => {
    const first = await service.create({ userId: alice, name: 'backend' });
    await service.create({ userId: alice, name: 'frontend' });

    const error = await refusal(() =>
      service.rename({ userId: alice, agentId: first.id, name: 'frontend' }),
    );
    expect(error.code).toBe(ErrorCode.CONFLICT);
  });

  it('accepts a name freed by a deleted agent of the caller', async () => {
    const retired = await service.create({ userId: alice, name: 'backend' });
    await service.delete({ userId: alice, agentId: retired.id });

    const other = await service.create({ userId: alice, name: 'frontend' });
    const renamed = await service.rename({ userId: alice, agentId: other.id, name: 'backend' });

    expect(renamed.name).toBe('backend');
  });

  it('refuses somebody else’s agent as NOT_FOUND', async () => {
    const bobs = await service.create({ userId: bob, name: 'backend' });

    const error = await refusal(() =>
      service.rename({ userId: alice, agentId: bobs.id, name: 'stolen' }),
    );
    expect(error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('refuses a deleted agent as AGENT_DELETED', async () => {
    const created = await service.create({ userId: alice, name: 'backend' });
    await service.delete({ userId: alice, agentId: created.id });

    const error = await refusal(() =>
      service.rename({ userId: alice, agentId: created.id, name: 'revived' }),
    );
    expect(error.code).toBe(ErrorCode.AGENT_DELETED);
  });
});

describe('project participation', () => {
  it('adds the agent and is idempotent', async () => {
    const created = await service.create({ userId: alice, name: 'backend' });

    expect(
      await service.addToProject({ userId: alice, agentId: created.id, projectId: alpha }),
    ).toBe(true);
    expect(
      await service.addToProject({ userId: alice, agentId: created.id, projectId: alpha }),
    ).toBe(false);
    expect(await participationOf(created.id)).toEqual([alpha]);
  });

  it('refuses a project the caller is not a member of, and writes nothing', async () => {
    const created = await service.create({ userId: alice, name: 'backend' });

    const error = await refusal(() =>
      service.addToProject({ userId: alice, agentId: created.id, projectId: carolsProject }),
    );

    // NOT_FOUND rather than FORBIDDEN: a project is invisible outside its
    // membership, and project ids travel in URLs and a committed config file.
    expect(error.code).toBe(ErrorCode.NOT_FOUND);
    expect(await participationOf(created.id)).toEqual([]);
  });

  it('refuses somebody else’s agent even in a shared project', async () => {
    const bobs = await service.create({ userId: bob, name: 'backend' });

    const error = await refusal(() =>
      service.addToProject({ userId: alice, agentId: bobs.id, projectId: alpha }),
    );

    expect(error.code).toBe(ErrorCode.NOT_FOUND);
    expect(await participationOf(bobs.id)).toEqual([]);
  });

  it('removes the agent and ends its sessions in that project only', async () => {
    const created = await service.create({ userId: alice, name: 'backend' });
    await service.addToProject({ userId: alice, agentId: created.id, projectId: alpha });
    await service.addToProject({ userId: alice, agentId: created.id, projectId: beta });

    const inAlpha = await createSession(alice, created.id, alpha);
    const inBeta = await createSession(alice, created.id, beta);

    const removal = await service.removeFromProject({
      userId: alice,
      agentId: created.id,
      projectId: alpha,
    });

    expect(removal).toEqual({ removed: true, sessionsEnded: 1 });
    expect(await participationOf(created.id)).toEqual([beta]);
    expect(await sessionStatus(inAlpha)).toBe('ended');
    expect(await sessionStatus(inBeta)).toBe('active');
  });

  it('is idempotent about a project the agent is not in', async () => {
    const created = await service.create({ userId: alice, name: 'backend' });

    const removal = await service.removeFromProject({
      userId: alice,
      agentId: created.id,
      projectId: alpha,
    });

    expect(removal).toEqual({ removed: false, sessionsEnded: 0 });
  });
});

describe('soft delete', () => {
  it('does all three things: tombstone, participation, sessions', async () => {
    const created = await service.create({ userId: alice, name: 'backend' });
    await service.addToProject({ userId: alice, agentId: created.id, projectId: alpha });
    await service.addToProject({ userId: alice, agentId: created.id, projectId: beta });
    const listening = await createSession(alice, created.id, alpha);

    const deletion = await service.delete({ userId: alice, agentId: created.id });

    expect(deletion).toMatchObject({ projectsLeft: 2, sessionsEnded: 1 });
    expect((await agentRow(created.id))?.deletedAt).not.toBeNull();
    expect(await participationOf(created.id)).toEqual([]);
    expect(await sessionStatus(listening)).toBe('ended');
  });

  it('leaves the row itself in place, so history keeps resolving', async () => {
    const sender = await service.create({ userId: alice, name: 'backend' });
    const recipient = await service.create({ userId: bob, name: 'frontend' });
    await service.addToProject({ userId: alice, agentId: sender.id, projectId: alpha });
    await service.addToProject({ userId: bob, agentId: recipient.id, projectId: alpha });

    const messageId = await createMessage(alpha, sender.id, recipient.id);

    await service.delete({ userId: alice, agentId: sender.id });

    // The message still names the agent, and the agent still resolves — which
    // is the entire reason the delete is soft.
    const [row] = await db
      .select({ senderName: agents.name, senderId: agents.id })
      .from(messages)
      .innerJoin(agents, eq(agents.id, messages.senderAgentId))
      .where(eq(messages.id, messageId));

    expect(row).toEqual({ senderName: 'backend', senderId: sender.id });
  });

  it('makes the agent unaddressable and absent from discovery', async () => {
    const created = await service.create({ userId: alice, name: 'backend' });
    await service.addToProject({ userId: alice, agentId: created.id, projectId: alpha });

    await service.delete({ userId: alice, agentId: created.id });

    const authorization = createAuthorizationService(db);

    // Its owner is told the id is stale.
    const owner = await refusal(() =>
      authorization.assertAgentInProject({
        userId: alice,
        agentId: created.id,
        projectId: alpha,
      }),
    );
    expect(owner.code).toBe(ErrorCode.AGENT_DELETED);

    // A co-member cannot address it, and is not told why.
    const coMember = await refusal(() =>
      authorization.assertAgentInProject({
        userId: bob,
        agentId: created.id,
        projectId: alpha,
      }),
    );
    expect(coMember.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('refuses a second delete as AGENT_DELETED', async () => {
    const created = await service.create({ userId: alice, name: 'backend' });
    await service.delete({ userId: alice, agentId: created.id });

    const error = await refusal(() => service.delete({ userId: alice, agentId: created.id }));
    expect(error.code).toBe(ErrorCode.AGENT_DELETED);
  });

  it('refuses somebody else’s agent as NOT_FOUND, and deletes nothing', async () => {
    const bobs = await service.create({ userId: bob, name: 'backend' });

    const error = await refusal(() => service.delete({ userId: alice, agentId: bobs.id }));

    expect(error.code).toBe(ErrorCode.NOT_FOUND);
    expect((await agentRow(bobs.id))?.deletedAt).toBeNull();
  });
});

describe('a name is not an identity', () => {
  it('frees the name, and re-creating it mints a NEW agent', async () => {
    const first = await service.create({ userId: alice, name: 'backend' });
    await service.addToProject({ userId: alice, agentId: first.id, projectId: alpha });
    const messageId = await createMessage(alpha, first.id, first.id);

    await service.delete({ userId: alice, agentId: first.id });

    const second = await service.create({ userId: alice, name: 'backend' });

    // Same address, different agent.
    expect(second.name).toBe('backend');
    expect(second.id).not.toBe(first.id);

    // And the old message still belongs to the old one, not to the new one.
    const [row] = await db
      .select({ senderAgentId: messages.senderAgentId })
      .from(messages)
      .where(eq(messages.id, messageId));
    expect(row?.senderAgentId).toBe(first.id);

    // The new agent starts unjoined; it did not inherit the old one's projects.
    expect(await participationOf(second.id)).toEqual([]);
    expect((await service.list({ userId: alice })).map((agent) => agent.id)).toEqual([second.id]);
  });

  it('puts no ceiling on how many times a name is recycled', async () => {
    const minted: AgentId[] = [];

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const created = await service.create({ userId: alice, name: 'backend' });
      minted.push(created.id);
      await service.delete({ userId: alice, agentId: created.id });
    }

    const live = await service.create({ userId: alice, name: 'backend' });

    // Three tombstones and one live agent, all called `backend`, all distinct.
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.userId, alice), eq(agents.name, 'backend')));

    expect(rows).toHaveLength(4);
    expect(new Set([...minted, live.id]).size).toBe(4);
  });
});

describe('the delete is atomic', () => {
  /**
   * A handle whose connections refuse to wait for a lock.
   *
   * `lock_timeout` is set as a startup option rather than with a `SET`, because
   * a transaction takes whichever connection the pool hands it and a `SET` on
   * one of them would be a coin toss.
   */
  let impatientPool: Pool;
  let impatient: AgentService;

  beforeAll(() => {
    impatientPool = new Pool({
      connectionString: urlForScratchDatabase(databaseName),
      max: 2,
      options: '-c lock_timeout=1000ms',
    });

    impatient = createAgentService(drizzle(impatientPool, { schema }));
  });

  afterAll(async () => {
    await impatientPool.end();
  });

  it('rolls the whole delete back when the last of its three writes fails', async () => {
    const created = await service.create({ userId: alice, name: 'backend' });
    await service.addToProject({ userId: alice, agentId: created.id, projectId: alpha });
    await service.addToProject({ userId: alice, agentId: created.id, projectId: beta });
    const listening = await createSession(alice, created.id, alpha);

    // Block the third write, and only the third. `agents` and `agent_projects`
    // are untouched, so the tombstone and the participation delete both apply
    // inside the transaction before it hits this.
    const locker = await pool.connect();
    let failure: unknown;

    try {
      await locker.query('begin');
      await locker.query('lock table sessions in access exclusive mode');

      failure = await impatient
        .delete({ userId: alice, agentId: created.id })
        .then(() => undefined)
        .catch((error: unknown) => error);
    } finally {
      await locker.query('rollback');
      locker.release();
    }

    // It failed at the database rather than by a check of ours, and it failed
    // on the *third* write: `sessions` is the only locked object in the
    // transaction, so a lock timeout can have come from nowhere else. The
    // tombstone and the participation delete had therefore already been applied
    // when it happened.
    expect(sqlStateOf(failure)).toBe(LOCK_NOT_AVAILABLE);

    // And nothing survived of the two writes that had already been applied.
    // This is the assertion the transaction exists for: the alternative is an
    // agent that is deleted and still addressable.
    expect((await agentRow(created.id))?.deletedAt).toBeNull();
    expect(await participationOf(created.id)).toEqual([alpha, beta].sort());
    expect(await sessionStatus(listening)).toBe('active');

    // Still live to every rule that matters, not merely still present.
    const authorization = createAuthorizationService(db);
    await expect(
      authorization.assertAgentOwner({ userId: alice, agentId: created.id }),
    ).resolves.toMatchObject({ id: created.id, name: 'backend' });
    await expect(
      authorization.assertAgentInProject({
        userId: bob,
        agentId: created.id,
        projectId: alpha,
      }),
    ).resolves.toMatchObject({ id: created.id });

    // And it is still listed, so a retry addresses the same agent.
    expect((await service.list({ userId: alice })).map((agent) => agent.id)).toEqual([created.id]);
  });

  it('leaves a retry able to complete the delete', async () => {
    const created = await service.create({ userId: alice, name: 'backend' });
    await service.addToProject({ userId: alice, agentId: created.id, projectId: alpha });
    const listening = await createSession(alice, created.id, alpha);

    const locker = await pool.connect();
    try {
      await locker.query('begin');
      await locker.query('lock table sessions in access exclusive mode');
      await impatient.delete({ userId: alice, agentId: created.id }).catch(() => undefined);
    } finally {
      await locker.query('rollback');
      locker.release();
    }

    // The lock is gone; the same request works, and works completely.
    const deletion = await service.delete({ userId: alice, agentId: created.id });

    expect(deletion).toMatchObject({ projectsLeft: 1, sessionsEnded: 1 });
    expect((await agentRow(created.id))?.deletedAt).not.toBeNull();
    expect(await participationOf(created.id)).toEqual([]);
    expect(await sessionStatus(listening)).toBe('ended');
  });
});
