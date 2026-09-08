/**
 * The pending queue and D3, against a real PostgreSQL database.
 *
 * `./inbox.test.ts` covers the page size, which is decided without a
 * connection. Everything this module actually promises is a claim about rows
 * and can only be proved here:
 *
 * - **D3.** An acknowledgement from *any* session of an agent clears the
 *   message for that agent. Proved with two sessions and two listeners' worth
 *   of replay: the second session's queue is empty after the first one
 *   acknowledged, which is the whole reason `message_inbox` is keyed on the
 *   agent.
 * - **Idempotency.** A repeat is a no-op with the *original* timestamp, both
 *   when it arrives afterwards and when two sessions acknowledge at once and
 *   the row lock has to pick a winner. The concurrent case is arranged by
 *   holding a transaction open, because two acknowledgements left to overlap on
 *   their own serialise and never take the path under test.
 * - **Refusal.** Acknowledging somebody else's message is refused and leaves
 *   the queue untouched — the queue being untouched is the half a test that
 *   only checked the error code would miss.
 * - **Diagnostics stay diagnostic.** `deliveries` rows are written and stamped,
 *   and none of it moves the pending state: a message acknowledged by one
 *   session leaves the other session's delivery row null forever, and a
 *   delivery recorded after an acknowledgement does not resurrect the debt.
 * - **The plan.** The replay read runs on every reconnect, so the statement the
 *   service *actually issues* — captured off the driver rather than retyped
 *   into the test — is explained and asserted to use
 *   `message_inbox_pending_idx` with no sequential scan and no sort.
 *
 * The suite owns a freshly created database, following the precedent in
 * `./messages.integration.test.ts`, so the migration lands on an empty one and
 * no other suite's rows can affect a count or a query plan.
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  AgentId,
  ConversationId,
  ErrorCode,
  MachineId,
  MessageId,
  ProjectId,
  ProtocolError,
  SessionId,
  UserId,
} from '@agentchat/protocol';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentProjects, agents } from '../db/schema/agents.js';
import { projectMembers, projects, users } from '../db/schema/identity.js';
import {
  conversations,
  deliveries,
  machines,
  messageInbox,
  messages,
  sessions,
} from '../db/schema/messaging.js';
import {
  createInboxService,
  DEFAULT_PENDING_LIMIT,
  type InboxDatabase,
  type InboxQueryRunner,
  type InboxService,
  MAX_PENDING_LIMIT,
} from './inbox.js';
import { createMessageService } from './messages.js';

/** The generated SQL migrations, exactly as the server image ships them. */
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
  messageInbox,
  deliveries,
};

/** A short unique suffix so nothing collides between runs. */
const unique = (): string => randomUUID().replaceAll('-', '').slice(0, 12);

let pool: Pool | undefined;
/** A second pool, used only to read what another connection committed. */
let observer: Pool | undefined;
let observerDb: NodePgDatabase<typeof schema>;
let db: NodePgDatabase<typeof schema>;
let databaseName: string;
let service: InboxService;

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
 * Creates an agent, joined to any projects named.
 *
 * @param owner - Who owns it.
 * @param joined - Projects to join it to.
 * @returns The new agent's identifier.
 */
async function createAgent(owner: UserId, ...joined: ProjectId[]): Promise<AgentId> {
  const id = AgentId.generate();

  await db.insert(agents).values({ id, userId: owner, name: `a-${unique()}` });
  for (const projectId of joined) {
    await db.insert(agentProjects).values({ agentId: id, projectId });
  }

  return id;
}

/**
 * Creates a session: one `agentchat listen` invocation.
 *
 * Every call mints a new machine as well, so two sessions of one agent are as
 * unrelated as two laptops — which is the case D3 has to survive.
 *
 * @param owner - The user whose machine it runs on.
 * @param agentId - The agent the listener speaks for.
 * @param projectId - The project it listens in.
 * @returns The new session's identifier.
 */
async function createSession(
  owner: UserId,
  agentId: AgentId,
  projectId: ProjectId,
): Promise<SessionId> {
  const machineId = MachineId.generate();
  await db.insert(machines).values({ id: machineId, userId: owner, name: `host-${unique()}` });

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

/** A message written straight into the tables, with its inbox row. */
interface PendingFixture {
  /** The message. */
  readonly messageId: MessageId;
  /** The thread it opened. */
  readonly conversationId: ConversationId;
}

/**
 * Writes one message addressed to `recipient` and leaves it pending.
 *
 * Direct inserts rather than the message service, for two reasons. The suite is
 * about what happens *after* a send, and `./messages.integration.test.ts`
 * already owns the send; and `createdAt` has to be chosen here — see
 * {@link ordered} — which a real send does not let a caller do.
 *
 * @param options - Who, where, and when.
 * @returns The message and its conversation.
 */
async function pend(options: {
  projectId: ProjectId;
  senderAgentId: AgentId;
  recipientAgentId: AgentId;
  content?: string;
  createdAt?: Date;
  conversationId?: ConversationId;
}): Promise<PendingFixture> {
  const conversationId = options.conversationId ?? ConversationId.generate();
  if (options.conversationId === undefined) {
    await db.insert(conversations).values({ id: conversationId, projectId: options.projectId });
  }

  const messageId = MessageId.generate();
  await db.insert(messages).values({
    id: messageId,
    projectId: options.projectId,
    conversationId,
    senderAgentId: options.senderAgentId,
    recipientAgentId: options.recipientAgentId,
    content: options.content ?? 'ship it',
    clientMessageId: `cli-${unique()}`,
    ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
  });

  await db.insert(messageInbox).values({
    messageId,
    agentId: options.recipientAgentId,
    projectId: options.projectId,
    status: 'pending',
  });

  return { messageId, conversationId };
}

/**
 * Reads one queue row on the observing connection.
 *
 * On the observer because what another connection can see is what is committed,
 * and committed is the only thing a claim about durability can mean.
 *
 * @param messageId - The message.
 * @param agentId - The agent that owes the acknowledgement.
 * @returns The row, or `undefined`.
 */
async function queueRow(
  messageId: MessageId,
  agentId: AgentId,
): Promise<{ status: string; ackedAt: Date | null; ackedBySessionId: string | null } | undefined> {
  const rows = await observerDb
    .select({
      status: messageInbox.status,
      ackedAt: messageInbox.ackedAt,
      ackedBySessionId: messageInbox.ackedBySessionId,
    })
    .from(messageInbox)
    .where(and(eq(messageInbox.messageId, messageId), eq(messageInbox.agentId, agentId)))
    .limit(1);

  return rows[0];
}

/**
 * Reads one delivery row on the observing connection.
 *
 * @param messageId - The message written out.
 * @param sessionId - The session it was written to.
 * @returns The row, or `undefined`.
 */
async function deliveryRow(
  messageId: MessageId,
  sessionId: SessionId,
): Promise<{ deliveredAt: Date; ackedAt: Date | null } | undefined> {
  const rows = await observerDb
    .select({ deliveredAt: deliveries.deliveredAt, ackedAt: deliveries.ackedAt })
    .from(deliveries)
    .where(and(eq(deliveries.messageId, messageId), eq(deliveries.sessionId, sessionId)))
    .limit(1);

  return rows[0];
}

/**
 * Runs a call expected to fail and returns the error it threw.
 *
 * @param run - The call.
 * @returns The `ProtocolError`.
 * @throws {Error} If it succeeded, or threw something else — either is a rule
 *   that is not enforced, which must not read as a pass.
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

/**
 * A handle whose acknowledgement transaction is held open after its writes.
 *
 * The only way to make two acknowledgements genuinely collide. Left to
 * themselves they serialise: the second one's `UPDATE` runs after the first has
 * committed, sees `'acked'`, and takes the ordinary repeat path — which is a
 * different code path from the one where the row lock is contended, and it is
 * the contended one that could lose an update.
 *
 * @param gate - Released to let the held transaction commit.
 * @param onHeld - Called once the writes are done and the lock is held.
 * @returns A database handle for {@link createInboxService}.
 */
function holdingDatabase(gate: Promise<void>, onHeld: () => void): InboxDatabase {
  return {
    // The runner types are a `Pick` of the Drizzle handle; its overloads do not
    // survive being wrapped, so the shape is restated here rather than weakened
    // in the module the server depends on. Same device as T-303's suite.
    select: ((...args: Parameters<InboxQueryRunner['select']>) =>
      db.select(...args)) as InboxQueryRunner['select'],
    insert: ((...args: Parameters<InboxQueryRunner['insert']>) =>
      db.insert(...args)) as InboxQueryRunner['insert'],
    update: ((...args: Parameters<InboxQueryRunner['update']>) =>
      db.update(...args)) as InboxQueryRunner['update'],
    transaction: <T>(callback: (tx: InboxQueryRunner) => Promise<T>): Promise<T> =>
      db.transaction(async (tx) => {
        const result = await callback(tx);
        onHeld();
        await gate;
        return result;
      }),
  };
}

// The cast. Alice owns the project and does the sending; Bob owns the agent
// that is listened for and runs two sessions of it, which is what D3 is about.
// `omega` is a second project both of them are in, with Bob's *same* agent
// joined to it, so that the queue's project scoping can be tested without the
// authorization rules refusing first and hiding the result.
let alice: UserId;
let bob: UserId;
let carol: UserId;
let alpha: ProjectId;
let omega: ProjectId;
let beta: ProjectId;

/** Alice's agent in `alpha` and `omega`. The sender throughout. */
let aliceInAlpha: AgentId;
/** Bob's agent, in `alpha` and `omega`. The one with a queue. */
let bobInAlpha: AgentId;
/** Bob's second agent in `alpha`, so "per agent" is testable. */
let bobOther: AgentId;
/** Bob's soft-deleted agent in `alpha` (D13). */
let bobDeleted: AgentId;
/** Carol's agent in `beta`. A stranger to everything above. */
let carolInBeta: AgentId;

/** Bob's first listener for `bobInAlpha` in `alpha`. */
let sessionOne: SessionId;
/** Bob's second listener for the same agent and project, on another machine. */
let sessionTwo: SessionId;

beforeAll(async () => {
  databaseName = `agentchat_t304_${unique()}`;

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`create database "${databaseName}"`);
  } finally {
    await admin.end();
  }

  const connectionString = urlForScratchDatabase(databaseName);
  pool = new Pool({ connectionString, max: 8 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  // Deliberately a second pool, not a second query on the first. What it can
  // see is what another process would see.
  observer = new Pool({ connectionString, max: 2 });
  observerDb = drizzle(observer, { schema });

  service = createInboxService(db);

  alice = await createUser('alice');
  bob = await createUser('bob');
  carol = await createUser('carol');

  alpha = await createProject(alice);
  omega = await createProject(alice);
  beta = await createProject(carol);
  await addMember(alpha, bob);
  await addMember(omega, bob);

  aliceInAlpha = await createAgent(alice, alpha, omega);
  bobInAlpha = await createAgent(bob, alpha, omega);
  bobOther = await createAgent(bob, alpha);
  carolInBeta = await createAgent(carol, beta);

  bobDeleted = await createAgent(bob, alpha);
  await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, bobDeleted));

  sessionOne = await createSession(bob, bobInAlpha, alpha);
  sessionTwo = await createSession(bob, bobInAlpha, alpha);
});

afterAll(async () => {
  await pool?.end();
  await observer?.end();

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await admin.end();
  }
});

/**
 * Everything `bobInAlpha` currently owes in `alpha`, as ids.
 *
 * @param options - Paging, when a test is about paging.
 * @returns The pending message ids in the order replay would send them.
 */
async function bobsQueue(
  options: { limit?: number; after?: MessageId } = {},
): Promise<MessageId[]> {
  const page = await service.listPending({
    userId: bob,
    agentId: bobInAlpha,
    projectId: alpha,
    ...options,
  });

  return page.messages.map((message) => message.id);
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

describe('listing what an agent is owed', () => {
  it('returns a message pending for this agent in this project', async () => {
    const { messageId, conversationId } = await pend({
      projectId: alpha,
      senderAgentId: aliceInAlpha,
      recipientAgentId: bobInAlpha,
      content: 'deploy is green',
    });

    expect(await bobsQueue()).toContain(messageId);

    const page = await service.listPending({
      userId: bob,
      agentId: bobInAlpha,
      projectId: alpha,
    });
    const message = page.messages.find((candidate) => candidate.id === messageId);

    expect(message).toBeDefined();
    expect(message?.content).toBe('deploy is green');
    expect(message?.senderAgentId).toBe(aliceInAlpha);
    expect(message?.recipientAgentId).toBe(bobInAlpha);
    expect(message?.conversationId).toBe(conversationId);
    expect(message?.projectId).toBe(alpha);
    expect(message?.parentMessageId).toBeUndefined();
  });

  it('leaves the message pending, because reading is not receiving', async () => {
    // A listener that dies between the replay and its acknowledgement has to
    // get the message again. That works only because this read writes nothing.
    const { messageId } = await pend({
      projectId: alpha,
      senderAgentId: aliceInAlpha,
      recipientAgentId: bobInAlpha,
    });

    await bobsQueue();
    await bobsQueue();

    expect((await queueRow(messageId, bobInAlpha))?.status).toBe('pending');
  });

  it('does not show one agent another agent’s queue', async () => {
    // "Per agent" is not a filter that could be forgotten in a route: the queue
    // is keyed on the agent, so this is the shape of the table.
    const { messageId } = await pend({
      projectId: alpha,
      senderAgentId: aliceInAlpha,
      recipientAgentId: bobOther,
    });

    expect(await bobsQueue()).not.toContain(messageId);

    const others = await service.listPending({
      userId: bob,
      agentId: bobOther,
      projectId: alpha,
    });
    expect(others.messages.map((message) => message.id)).toContain(messageId);
  });

  it('does not leak a queue across projects', async () => {
    const { messageId } = await pend({
      projectId: omega,
      senderAgentId: aliceInAlpha,
      recipientAgentId: bobInAlpha,
    });

    expect(await bobsQueue()).not.toContain(messageId);

    const inOmega = await service.listPending({
      userId: bob,
      agentId: bobInAlpha,
      projectId: omega,
    });
    expect(inOmega.messages.map((message) => message.id)).toContain(messageId);
  });

  it('sees what the message service committed, with no delivery in between', async () => {
    // The two modules compose: `send` writes the debt, this reads it. Nothing
    // was delivered — this suite has no socket — and the message is owed anyway,
    // which is Plan §4.4's first line stated from the other end.
    const messageService = createMessageService(db);
    const result = await messageService.send({
      userId: alice,
      projectId: alpha,
      senderAgentId: aliceInAlpha,
      recipientAgentId: bobInAlpha,
      content: 'through the real send path',
      clientMessageId: `cli-${unique()}`,
    });

    expect(await bobsQueue()).toContain(result.message.id);
  });
});

// ---------------------------------------------------------------------------
// Ordering and paging
// ---------------------------------------------------------------------------

describe('ordering', () => {
  it('replays oldest first, and by message id that is the same order as created_at', async () => {
    // The ordering decision, asserted rather than asserted-about. `msg_` ids
    // are UUIDv7s behind a fixed-width prefix, so lexicographic order is
    // creation order; the service orders by `message_id` because that comes out
    // of `message_inbox_pending_idx` already sorted and can be used as a cursor.
    //
    // The timestamps are spaced a full millisecond apart on purpose:
    // `created_at` is a `timestamptz(3)`, so several messages written in one
    // millisecond have no defined order by it at all, and a comparison against
    // an undefined order would be a test that passes for the wrong reason.
    const agent = await createAgent(bob, alpha);
    const base = Date.now();
    const written: MessageId[] = [];

    for (let index = 0; index < 6; index += 1) {
      const { messageId } = await pend({
        projectId: alpha,
        senderAgentId: aliceInAlpha,
        recipientAgentId: agent,
        createdAt: new Date(base + index * 10),
      });
      written.push(messageId);
    }

    const page = await service.listPending({ userId: bob, agentId: agent, projectId: alpha });

    expect(page.messages.map((message) => message.id)).toEqual(written);

    // Lexicographic id order and timestamp order agree, which is the claim the
    // decision rests on.
    const byCreatedAt = [...page.messages].sort(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
    );
    expect(byCreatedAt.map((message) => message.id)).toEqual(written);
    expect([...written].sort()).toEqual(written);
  });

  it('pages with a cursor and stops when the queue runs out', async () => {
    const agent = await createAgent(bob, alpha);
    const written: MessageId[] = [];
    for (let index = 0; index < 5; index += 1) {
      const { messageId } = await pend({
        projectId: alpha,
        senderAgentId: aliceInAlpha,
        recipientAgentId: agent,
      });
      written.push(messageId);
    }

    const first = await service.listPending({
      userId: bob,
      agentId: agent,
      projectId: alpha,
      limit: 2,
    });
    expect(first.messages.map((message) => message.id)).toEqual(written.slice(0, 2));
    expect(first.nextCursor).toBe(written[1]);

    const second = await service.listPending({
      userId: bob,
      agentId: agent,
      projectId: alpha,
      limit: 2,
      after: first.nextCursor,
    });
    expect(second.messages.map((message) => message.id)).toEqual(written.slice(2, 4));

    const third = await service.listPending({
      userId: bob,
      agentId: agent,
      projectId: alpha,
      limit: 2,
      after: second.nextCursor,
    });
    expect(third.messages.map((message) => message.id)).toEqual(written.slice(4));

    // Exactly the end, not "probably the end": the page is read one row wider
    // than the limit, so a cursor appears when and only when a further row was
    // seen.
    expect(third.nextCursor).toBeUndefined();
  });

  it('gives a full page no cursor when the queue ends exactly on the boundary', async () => {
    const agent = await createAgent(bob, alpha);
    for (let index = 0; index < 2; index += 1) {
      await pend({
        projectId: alpha,
        senderAgentId: aliceInAlpha,
        recipientAgentId: agent,
      });
    }

    const page = await service.listPending({
      userId: bob,
      agentId: agent,
      projectId: alpha,
      limit: 2,
    });

    expect(page.messages).toHaveLength(2);
    expect(page.nextCursor).toBeUndefined();
  });

  it('clamps a page larger than the ceiling instead of refusing it', async () => {
    const page = await service.listPending({
      userId: bob,
      agentId: bobInAlpha,
      projectId: alpha,
      limit: MAX_PENDING_LIMIT + 5_000,
    });

    expect(page.messages.length).toBeLessThanOrEqual(MAX_PENDING_LIMIT);
  });
});

// ---------------------------------------------------------------------------
// Acknowledgement — the point of the task
// ---------------------------------------------------------------------------

describe('acknowledgement is scoped to the agent (D3)', () => {
  it('clears the message for every session of the agent, not just the one that acked', async () => {
    // The acceptance criterion, and the reason this table is not keyed on a
    // session. Both sessions are told about the message; one acknowledges; the
    // other's replay no longer contains it.
    const { messageId } = await pend({
      projectId: alpha,
      senderAgentId: aliceInAlpha,
      recipientAgentId: bobInAlpha,
      content: 'two listeners, one debt',
    });

    // Both listeners replay it — D2's fan-out, which is what makes the
    // acknowledgement ambiguous unless D3 settles it.
    await service.recordDelivery({ messageId, sessionId: sessionOne });
    await service.recordDelivery({ messageId, sessionId: sessionTwo });
    expect(await bobsQueue()).toContain(messageId);

    const result = await service.acknowledge({
      userId: bob,
      agentId: bobInAlpha,
      projectId: alpha,
      messageId,
      sessionId: sessionOne,
    });

    expect(result.alreadyAcknowledged).toBe(false);
    expect(result.acknowledgedBySessionId).toBe(sessionOne);

    // The evidence: nothing about the read below mentions `sessionOne`, and the
    // message is gone from it. A session-scoped queue would still owe it.
    expect(await bobsQueue()).not.toContain(messageId);

    const row = await queueRow(messageId, bobInAlpha);
    expect(row?.status).toBe('acked');
    expect(row?.ackedBySessionId).toBe(sessionOne);
  });

  it('accepts an acknowledgement from a session that was never delivered to', async () => {
    // The other half of the same rule. A message replayed to `sessionOne` may
    // be acknowledged by `sessionTwo` — or, per Plan §3, over HTTP by no session
    // at all — because the debt belongs to the agent.
    const { messageId } = await pend({
      projectId: alpha,
      senderAgentId: aliceInAlpha,
      recipientAgentId: bobInAlpha,
    });
    await service.recordDelivery({ messageId, sessionId: sessionOne });

    const result = await service.acknowledge({
      userId: bob,
      agentId: bobInAlpha,
      projectId: alpha,
      messageId,
      sessionId: sessionTwo,
    });

    expect(result.alreadyAcknowledged).toBe(false);
    expect(await bobsQueue()).not.toContain(messageId);

    // `sessionOne` received it and never confirmed; that row stays null forever,
    // which is correct and not a defect.
    expect((await deliveryRow(messageId, sessionOne))?.ackedAt).toBeNull();
  });

  it('accepts an acknowledgement carrying no session at all', async () => {
    const { messageId } = await pend({
      projectId: alpha,
      senderAgentId: aliceInAlpha,
      recipientAgentId: bobInAlpha,
    });

    const result = await service.acknowledge({
      userId: bob,
      agentId: bobInAlpha,
      projectId: alpha,
      messageId,
    });

    expect(result.alreadyAcknowledged).toBe(false);
    expect(result.acknowledgedBySessionId).toBeUndefined();
    expect((await queueRow(messageId, bobInAlpha))?.status).toBe('acked');
  });
});

describe('acknowledgement is idempotent', () => {
  it('reports a repeat as a no-op and keeps the original timestamp', async () => {
    const { messageId } = await pend({
      projectId: alpha,
      senderAgentId: aliceInAlpha,
      recipientAgentId: bobInAlpha,
    });

    const first = await service.acknowledge({
      userId: bob,
      agentId: bobInAlpha,
      projectId: alpha,
      messageId,
      sessionId: sessionOne,
    });

    // A real retry arrives later. The wait makes "the original timestamp"
    // mean something: without it the two are equal by coincidence.
    await delay(15);

    const second = await service.acknowledge({
      userId: bob,
      agentId: bobInAlpha,
      projectId: alpha,
      messageId,
      sessionId: sessionTwo,
    });

    expect(first.alreadyAcknowledged).toBe(false);
    expect(second.alreadyAcknowledged).toBe(true);
    expect(second.acknowledgedAt.getTime()).toBe(first.acknowledgedAt.getTime());

    // The repeat rewrote nothing: the queue still records the session that
    // actually settled the debt, not the one that retried.
    const row = await queueRow(messageId, bobInAlpha);
    expect(row?.ackedBySessionId).toBe(sessionOne);
    expect(row?.ackedAt?.getTime()).toBe(first.acknowledgedAt.getTime());
  });

  it('survives a replay that overtakes the acknowledgement', async () => {
    // At-least-once means a message can be on its way out while its
    // acknowledgement is on its way in. Both orders have to be safe.
    const { messageId } = await pend({
      projectId: alpha,
      senderAgentId: aliceInAlpha,
      recipientAgentId: bobInAlpha,
    });

    // The replay reads the queue *before* the acknowledgement lands: this is
    // the in-flight page a listener is already writing to a socket.
    const inFlight = await bobsQueue();
    expect(inFlight).toContain(messageId);

    await service.acknowledge({
      userId: bob,
      agentId: bobInAlpha,
      projectId: alpha,
      messageId,
      sessionId: sessionOne,
    });

    // The delivery attempt finishes after the acknowledgement. It records a
    // diagnostic row and does not resurrect the debt — a queue that could be
    // reopened by a delivery would replay forever.
    await service.recordDelivery({ messageId, sessionId: sessionTwo });
    expect((await queueRow(messageId, bobInAlpha))?.status).toBe('acked');
    expect(await bobsQueue()).not.toContain(messageId);

    // The listener acknowledges the duplicate it was sent. A no-op, not an
    // error, which is what stops a client's retry loop from breaking.
    const late = await service.acknowledge({
      userId: bob,
      agentId: bobInAlpha,
      projectId: alpha,
      messageId,
      sessionId: sessionTwo,
    });
    expect(late.alreadyAcknowledged).toBe(true);
  });

  it('lets two sessions acknowledge at once without losing the update', async () => {
    // Arranged rather than hoped for: the first acknowledgement's transaction
    // is held open after its `UPDATE`, so the second one meets a contended row
    // lock instead of a committed row. Under `READ COMMITTED` it blocks, then
    // re-evaluates `status = 'pending'` against the updated row and matches
    // nothing — which is exactly the no-op wanted, with no explicit lock.
    const { messageId } = await pend({
      projectId: alpha,
      senderAgentId: aliceInAlpha,
      recipientAgentId: bobInAlpha,
    });

    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = (): void => {};
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });

    const winner = createInboxService(holdingDatabase(gate, held)).acknowledge({
      userId: bob,
      agentId: bobInAlpha,
      projectId: alpha,
      messageId,
      sessionId: sessionOne,
    });

    await holding;

    const loser = service.acknowledge({
      userId: bob,
      agentId: bobInAlpha,
      projectId: alpha,
      messageId,
      sessionId: sessionTwo,
    });

    // Long enough that the second acknowledgement has certainly reached the
    // lock. If it had not, the test would still pass — it would simply be
    // testing the serialised path, which the previous test already covers.
    await delay(50);
    release();

    const [first, second] = await Promise.all([winner, loser]);

    expect(first.alreadyAcknowledged).toBe(false);
    expect(second.alreadyAcknowledged).toBe(true);
    expect(second.acknowledgedAt.getTime()).toBe(first.acknowledgedAt.getTime());

    const row = await queueRow(messageId, bobInAlpha);
    expect(row?.status).toBe('acked');
    expect(row?.ackedBySessionId).toBe(sessionOne);
  });
});

describe('acknowledging what is not owed to you', () => {
  it('refuses a message addressed to another agent, and leaves it pending', async () => {
    const { messageId } = await pend({
      projectId: alpha,
      senderAgentId: aliceInAlpha,
      recipientAgentId: bobOther,
    });

    const error = await refusal(() =>
      service.acknowledge({
        userId: bob,
        agentId: bobInAlpha,
        projectId: alpha,
        messageId,
        sessionId: sessionOne,
      }),
    );

    expect(error.code).toBe(ErrorCode.NOT_FOUND);

    // The half that matters: the refusal did not quietly clear somebody else's
    // debt, and did not write a diagnostic row about a message it refused.
    expect((await queueRow(messageId, bobOther))?.status).toBe('pending');
    expect(await deliveryRow(messageId, sessionOne)).toBeUndefined();
  });

  it('refuses a message owed in a different project', async () => {
    // `bobInAlpha` is in both projects and Bob is a member of both, so the
    // authorization rules pass and the queue's own scoping is what refuses.
    const { messageId } = await pend({
      projectId: alpha,
      senderAgentId: aliceInAlpha,
      recipientAgentId: bobInAlpha,
    });

    const error = await refusal(() =>
      service.acknowledge({
        userId: bob,
        agentId: bobInAlpha,
        projectId: omega,
        messageId,
      }),
    );

    expect(error.code).toBe(ErrorCode.NOT_FOUND);
    expect((await queueRow(messageId, bobInAlpha))?.status).toBe('pending');
  });

  it('answers a message that does not exist the same way', async () => {
    // Deliberately the same code as somebody else's message: a caller who may
    // not acknowledge it may not learn whether it exists.
    const error = await refusal(() =>
      service.acknowledge({
        userId: bob,
        agentId: bobInAlpha,
        projectId: alpha,
        messageId: MessageId.generate(),
      }),
    );

    expect(error.code).toBe(ErrorCode.NOT_FOUND);
  });
});

// ---------------------------------------------------------------------------
// Authorization is called, not restated
// ---------------------------------------------------------------------------

describe('who may read and clear a queue', () => {
  it('refuses a caller who does not own the agent', async () => {
    const { messageId } = await pend({
      projectId: alpha,
      senderAgentId: aliceInAlpha,
      recipientAgentId: bobInAlpha,
    });

    const listing = await refusal(() =>
      service.listPending({ userId: alice, agentId: bobInAlpha, projectId: alpha }),
    );
    const ack = await refusal(() =>
      service.acknowledge({
        userId: alice,
        agentId: bobInAlpha,
        projectId: alpha,
        messageId,
      }),
    );

    expect(listing.code).toBe(ErrorCode.NOT_FOUND);
    expect(ack.code).toBe(ErrorCode.NOT_FOUND);
    expect((await queueRow(messageId, bobInAlpha))?.status).toBe('pending');
  });

  it('refuses a caller who is not in the project', async () => {
    const error = await refusal(() =>
      service.listPending({ userId: carol, agentId: carolInBeta, projectId: alpha }),
    );

    expect(error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('refuses a soft-deleted agent with the code its owner can act on', async () => {
    // D13. The rows survive — a soft delete is not a purge — they simply stop
    // being asked for, and the owner is told why rather than being told the
    // agent never existed.
    const error = await refusal(() =>
      service.listPending({ userId: bob, agentId: bobDeleted, projectId: alpha }),
    );

    expect(error.code).toBe(ErrorCode.AGENT_DELETED);
  });

  it('refuses an agent that is live but not in the project', async () => {
    const unjoined = await createAgent(bob);

    const error = await refusal(() =>
      service.listPending({ userId: bob, agentId: unjoined, projectId: alpha }),
    );

    expect(error.code).toBe(ErrorCode.AGENT_NOT_IN_PROJECT);
  });
});

// ---------------------------------------------------------------------------
// The delivery record stays diagnostic
// ---------------------------------------------------------------------------

describe('the per-session delivery record', () => {
  it('records an attempt without making the message any less owed', async () => {
    const { messageId } = await pend({
      projectId: alpha,
      senderAgentId: aliceInAlpha,
      recipientAgentId: bobInAlpha,
    });

    await service.recordDelivery({ messageId, sessionId: sessionOne });

    const row = await deliveryRow(messageId, sessionOne);
    expect(row).toBeDefined();
    expect(row?.ackedAt).toBeNull();

    // The debt is untouched. `deliveries` records what was attempted; only the
    // queue records what is owed.
    expect((await queueRow(messageId, bobInAlpha))?.status).toBe('pending');
    expect(await bobsQueue()).toContain(messageId);
  });

  it('updates the attempt rather than adding a row when a socket is written to twice', async () => {
    const { messageId } = await pend({
      projectId: alpha,
      senderAgentId: aliceInAlpha,
      recipientAgentId: bobInAlpha,
    });

    await service.recordDelivery({ messageId, sessionId: sessionOne });
    const first = await deliveryRow(messageId, sessionOne);
    await delay(15);
    await service.recordDelivery({ messageId, sessionId: sessionOne });

    const rows = await observerDb
      .select({ messageId: deliveries.messageId })
      .from(deliveries)
      .where(eq(deliveries.messageId, messageId));

    expect(rows).toHaveLength(1);
    expect((await deliveryRow(messageId, sessionOne))?.deliveredAt.getTime()).toBeGreaterThan(
      first?.deliveredAt.getTime() ?? 0,
    );
  });

  it('stamps the acknowledging session’s row and only that one', async () => {
    const { messageId } = await pend({
      projectId: alpha,
      senderAgentId: aliceInAlpha,
      recipientAgentId: bobInAlpha,
    });
    await service.recordDelivery({ messageId, sessionId: sessionOne });
    await service.recordDelivery({ messageId, sessionId: sessionTwo });

    await service.acknowledge({
      userId: bob,
      agentId: bobInAlpha,
      projectId: alpha,
      messageId,
      sessionId: sessionTwo,
    });

    expect((await deliveryRow(messageId, sessionTwo))?.ackedAt).not.toBeNull();
    // Not a defect: `sessionOne` was written to and never confirmed. The two
    // tables answer different questions and neither is derivable from the other.
    expect((await deliveryRow(messageId, sessionOne))?.ackedAt).toBeNull();
  });

  it('still stamps a repeating session’s row, without rewriting the queue', async () => {
    // A repeat writes nothing to the queue but still records that *this* socket
    // confirmed, because "did this socket confirm?" is not settled by another
    // session having settled the debt.
    const { messageId } = await pend({
      projectId: alpha,
      senderAgentId: aliceInAlpha,
      recipientAgentId: bobInAlpha,
    });
    await service.recordDelivery({ messageId, sessionId: sessionOne });
    await service.recordDelivery({ messageId, sessionId: sessionTwo });

    await service.acknowledge({
      userId: bob,
      agentId: bobInAlpha,
      projectId: alpha,
      messageId,
      sessionId: sessionOne,
    });
    const repeat = await service.acknowledge({
      userId: bob,
      agentId: bobInAlpha,
      projectId: alpha,
      messageId,
      sessionId: sessionTwo,
    });

    expect(repeat.alreadyAcknowledged).toBe(true);
    expect((await deliveryRow(messageId, sessionTwo))?.ackedAt).not.toBeNull();
    // And the queue still names the session that actually cleared it.
    expect((await queueRow(messageId, bobInAlpha))?.ackedBySessionId).toBe(sessionOne);
  });

  it('acknowledges a message that has no delivery row at all', async () => {
    // The offline case: nothing was ever written to a socket, the listener
    // starts, replays from the queue and acknowledges. The diagnostic `UPDATE`
    // matches nothing and the acknowledgement is unaffected — which is the
    // proof that the queue does not depend on this table.
    const { messageId } = await pend({
      projectId: alpha,
      senderAgentId: aliceInAlpha,
      recipientAgentId: bobInAlpha,
    });

    const result = await service.acknowledge({
      userId: bob,
      agentId: bobInAlpha,
      projectId: alpha,
      messageId,
      sessionId: sessionOne,
    });

    expect(result.alreadyAcknowledged).toBe(false);
    expect(await deliveryRow(messageId, sessionOne)).toBeUndefined();
    expect((await queueRow(messageId, bobInAlpha))?.status).toBe('acked');
  });
});

// ---------------------------------------------------------------------------
// The plan for the read that runs on every reconnect
// ---------------------------------------------------------------------------

describe('the replay read uses its index', () => {
  it('is answered from message_inbox_pending_idx with no scan and no sort', async () => {
    // The statement explained here is the one the service issued, captured off
    // the driver rather than retyped: a hand-written copy in a test proves the
    // planner likes *the copy*, which is how a route ships with a plan nobody
    // predicted.
    //
    // `VACUUM`, not just `ANALYZE`. `ANALYZE` collects row statistics; only
    // `VACUUM` sets the visibility map, and until it is set the planner must
    // assume a heap visit per row and prices the index scan out. A table that
    // has been in service long enough for autovacuum to have been round does
    // not look like a freshly bulk-loaded one, and it is the former these
    // assertions are about.
    const agent = await createAgent(bob, alpha);
    await seedForQueryPlan(agent);
    await db.execute(sql`vacuum (analyze) messages, message_inbox`);

    const statements = await captureStatements(() =>
      service.listPending({ userId: bob, agentId: agent, projectId: alpha }),
    );

    const replay = statements.find((statement) => statement.text.includes('"message_inbox"'));
    expect(replay).toBeDefined();

    const plan = await explain(replay?.text ?? '', replay?.values ?? []);

    // The pending set comes out of the partial index, ordered, with no heap
    // visits at all — the `Heap Fetches: 0` an index-only scan reports is what
    // the `VACUUM` above buys.
    expect(plan).toContain('message_inbox_pending_idx');
    expect(plan).not.toMatch(/Seq Scan on message_inbox/);

    // `messages` is reached by primary key, once per pending row. A sequential
    // scan here is the failure that matters at scale: it is the whole table on
    // every reconnect of every listener.
    expect(plan).not.toMatch(/Seq Scan on messages/);

    // And no sort, because the index supplied the order. This is the assertion
    // that fails if somebody re-spells the `ORDER BY` as `created_at` — the
    // rows would be identical and the plan would not.
    expect(plan).not.toMatch(/\bSort\b/);
  });
});

/**
 * How many messages the query-plan fixture writes into `alpha`.
 *
 * Load-bearing, and arrived at rather than picked. The plan is a function of
 * how much of `messages` the join would have to read: at three thousand rows
 * — a hundred heap pages — Postgres hash-joins the whole table against the
 * pending set and sorts the result, and it is *right* to, because twenty index
 * probes at `random_page_cost` cost more than reading a table that small. The
 * plan this module is written for only becomes the cheap one once the table is
 * large enough that reading it whole is not free, which is every deployment
 * that has been in service for a week and none that has been up for an hour.
 *
 * Fifty thousand is comfortably past that boundary and still seeds in about a
 * second, because it is one `INSERT … SELECT` rather than fifty thousand round
 * trips.
 */
const PLAN_MESSAGE_COUNT = 50_000;
/** How many of them are left pending for the fixture's agent. */
const PLAN_PENDING_COUNT = 20;

/**
 * Fills the tables so the plan under test is the plan production gets.
 *
 * Ids are minted in SQL rather than by {@link MessageId.generate}: fifty
 * thousand round trips is a minute of test time, and the identifiers only have
 * to satisfy `messages_id_format` for this fixture's purpose. `overlay` puts the
 * version nibble and the variant bits where RFC 9562 wants them, which is all
 * that constraint asks. They are therefore *not* time-ordered — irrelevant here,
 * since a query plan does not depend on the values, and the ordering claim is
 * proved by its own test on ids that are.
 *
 * @param agent - The agent whose queue keeps {@link PLAN_PENDING_COUNT} rows.
 */
async function seedForQueryPlan(agent: AgentId): Promise<void> {
  const conversationId = ConversationId.generate();
  await db.insert(conversations).values({ id: conversationId, projectId: alpha });

  await db.execute(sql`
    insert into messages
      (id, project_id, conversation_id, sender_agent_id, recipient_agent_id, content, client_message_id)
    select
      'msg_' || overlay(overlay(gen_random_uuid()::text placing '7' from 15) placing '8' from 20),
      ${alpha}, ${conversationId}, ${aliceInAlpha}, ${agent},
      'plan fixture', 'cli-' || gen_random_uuid()::text
    from generate_series(1, ${PLAN_MESSAGE_COUNT})
  `);

  await db.execute(sql`
    insert into message_inbox (message_id, agent_id, project_id, status, acked_at)
    select id, ${agent}, ${alpha}, 'acked', now()
    from messages where recipient_agent_id = ${agent}
  `);

  // A small live set inside a large table: the shape a listener that mostly
  // keeps up actually produces, and the shape the partial index is for.
  await db.execute(sql`
    update message_inbox set status = 'pending', acked_at = null
    where agent_id = ${agent}
      and message_id in (
        select message_id from message_inbox
        where agent_id = ${agent}
        order by message_id desc
        limit ${PLAN_PENDING_COUNT}
      )
  `);
}

/** One statement as it crossed the connection. */
interface CapturedStatement {
  /** The SQL text, with `$n` placeholders. */
  readonly text: string;
  /** The parameters bound to them. */
  readonly values: unknown[];
}

/**
 * Records the SQL the service sends while `run` is in flight.
 *
 * The `pg` pool's own `query` is intercepted rather than a Drizzle builder,
 * because what reaches the connection is the only thing `EXPLAIN` can honestly
 * be run against: a statement retyped into a test proves that the planner likes
 * *the copy*.
 *
 * @param run - The work to observe.
 * @returns Every statement it issued, in order.
 */
async function captureStatements(run: () => Promise<unknown>): Promise<CapturedStatement[]> {
  const client = pool;
  if (client === undefined) {
    throw new Error('the pool is not open.');
  }

  const statements: CapturedStatement[] = [];
  const original = client.query.bind(client);

  const intercept = (...args: unknown[]): unknown => {
    const [first, second] = args;
    const text = typeof first === 'string' ? first : (first as { text?: unknown }).text;
    if (typeof text === 'string') {
      statements.push({ text, values: Array.isArray(second) ? second : [] });
    }
    return (original as (...forwarded: unknown[]) => unknown)(...args);
  };

  Object.defineProperty(client, 'query', { value: intercept, configurable: true, writable: true });
  try {
    await run();
  } finally {
    Object.defineProperty(client, 'query', {
      value: original,
      configurable: true,
      writable: true,
    });
  }

  return statements;
}

/**
 * Runs `EXPLAIN (ANALYZE, BUFFERS)` over a statement and its parameters.
 *
 * `ANALYZE` rather than a plain `EXPLAIN` so the assertion is about the plan
 * that actually executed, with the row counts to prove it did.
 *
 * @param text - The statement, exactly as the driver sent it.
 * @param values - Its bound parameters.
 * @returns The plan, newline-joined.
 */
async function explain(text: string, values: unknown[]): Promise<string> {
  const client = pool;
  if (client === undefined) {
    throw new Error('the pool is not open.');
  }

  const result = await client.query<Record<string, string>>(
    `explain (analyze, buffers) ${text}`,
    values,
  );

  return result.rows.map((row) => Object.values(row)[0]).join('\n');
}

/** The default is documented; a listing that ignored it would be a lie. */
describe('the documented default', () => {
  it('returns at most the default page when no limit is given', async () => {
    const agent = await createAgent(bob, alpha);
    for (let index = 0; index < 3; index += 1) {
      await pend({
        projectId: alpha,
        senderAgentId: aliceInAlpha,
        recipientAgentId: agent,
      });
    }

    const page = await service.listPending({ userId: bob, agentId: agent, projectId: alpha });

    expect(page.messages.length).toBeLessThanOrEqual(DEFAULT_PENDING_LIMIT);
    expect(page.messages).toHaveLength(3);
  });
});
