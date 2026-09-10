/**
 * The send path against a real PostgreSQL database.
 *
 * `./messages.test.ts` covers the refusals decided from the request alone.
 * Everything else about a send is a claim about the database and cannot be
 * proved anywhere but here:
 *
 * - **Atomicity.** The message row and its inbox row are both present or both
 *   absent. Proved by breaking the second insert and looking for the first —
 *   the only way to observe a transaction is to fail inside one.
 * - **Durability before delivery.** After `send` resolves, both rows are
 *   visible *on a different connection*. A row this session's own transaction
 *   can see proves nothing; a row another connection can see is committed, and
 *   committed is what "recoverable even if every listener dies" means.
 * - **Idempotency.** A repeated `clientMessageId` returns the original row,
 *   both when the retry arrives afterwards and when two sends race and the
 *   unique index has to pick a winner.
 * - **Authorization.** The three assertions are three rules. Proved by
 *   arranging a caller who passes two of them and fails the third, once per
 *   rule, which a single composite call could not distinguish.
 *
 * The suite owns a freshly created database, following the precedent in
 * `./authorization.integration.test.ts`, so the migration lands on an empty one
 * and no other suite's rows can affect a count.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  AgentId,
  ConversationId,
  ErrorCode,
  MessageId,
  ProjectId,
  ProtocolError,
  UserId,
} from '@stackgrid/protocol';
import { and, eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentProjects, agents } from '../db/schema/agents.js';
import { projectMembers, projects, users } from '../db/schema/identity.js';
import { conversations, messageInbox, messages } from '../db/schema/messaging.js';
import { toErrorResponse } from '../errors.js';
import {
  createMessageService,
  MAX_CONTENT_BYTES,
  type MessageDatabase,
  type MessageQueryRunner,
  type MessageService,
  type SendMessageRequest,
} from './messages.js';

/** The generated SQL migrations, exactly as the server image ships them. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

const schema = {
  users,
  projects,
  projectMembers,
  agents,
  agentProjects,
  conversations,
  messages,
  messageInbox,
};

/** A short unique suffix so nothing collides between runs. */
const unique = (): string => randomUUID().replaceAll('-', '').slice(0, 12);

let pool: Pool | undefined;
/** A second pool, used only to read what another connection committed. */
let observer: Pool | undefined;
let observerDb: NodePgDatabase<typeof schema>;
let db: NodePgDatabase<typeof schema>;
let databaseName: string;
let service: MessageService;

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
 * Runs a send expected to fail and returns the error it threw.
 *
 * @param run - The send.
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
  throw new Error('Expected this send to be refused, but it succeeded.');
}

/** How many messages and inbox rows a project holds, read on `observerDb`. */
async function committedCounts(projectId: ProjectId): Promise<{
  messages: number;
  inbox: number;
  conversations: number;
}> {
  const [sent, owed, threads] = await Promise.all([
    observerDb.select({ id: messages.id }).from(messages).where(eq(messages.projectId, projectId)),
    observerDb
      .select({ id: messageInbox.messageId })
      .from(messageInbox)
      .where(eq(messageInbox.projectId, projectId)),
    observerDb
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.projectId, projectId)),
  ]);

  return { messages: sent.length, inbox: owed.length, conversations: threads.length };
}

/** How an instrumented handle should misbehave. */
interface Instrumentation {
  /**
   * Throw instead of writing, once this many inserts have been allowed.
   *
   * How a failure *between* the message and its inbox row is arranged; there is
   * no way to ask PostgreSQL to fail exactly there on request.
   */
  readonly failAfterInserts?: number;

  /**
   * Hold the transaction open after this insert until {@link gate} resolves.
   *
   * How a genuine idempotency race is arranged. Two sends left to overlap on
   * their own usually do not collide — the second's read finds the first — so
   * the collision has to be held open deliberately, or the constraint path is
   * never the one under test.
   */
  readonly pauseAfterInsert?: number;

  /** Released to let a paused transaction continue. */
  readonly gate?: Promise<void>;

  /** Called when the pause is reached, so the test can act while it is held. */
  readonly onPaused?: () => void;
}

/**
 * Wraps a handle so its verbs can be counted, broken, or held.
 *
 * The wrapper is the real handle in every other respect: the statements it
 * issues are the service's own, against the same database.
 *
 * @param instrumentation - What to do and when.
 * @returns A database handle and the counters it maintains.
 */
function instrumentedDatabase(instrumentation: Instrumentation = {}): {
  database: MessageDatabase;
  counts: { selects: number; inserts: number };
} {
  const counts = { selects: 0, inserts: 0 };
  const { failAfterInserts, pauseAfterInsert, gate, onPaused } = instrumentation;

  const wrap = (runner: MessageQueryRunner): MessageQueryRunner => ({
    // The runner types are a `Pick` of the Drizzle handle; its overloads do not
    // survive being wrapped, so the shape is restated here rather than weakened
    // in the module the server depends on. Same device as T-106's suite.
    select: ((...args: Parameters<MessageQueryRunner['select']>) => {
      counts.selects += 1;
      return runner.select(...args);
    }) as MessageQueryRunner['select'],

    insert: ((...args: Parameters<MessageQueryRunner['insert']>) => {
      counts.inserts += 1;
      const ordinal = counts.inserts;

      if (failAfterInserts !== undefined && ordinal > failAfterInserts) {
        throw new Error('simulated failure partway through the send');
      }

      const builder = runner.insert(...args);
      if (ordinal !== pauseAfterInsert) {
        return builder;
      }

      // Only ever applied to the conversation insert, which is awaited whole.
      // An insert whose result is chained — `.values(…).returning(…)` — would
      // not survive being replaced by a promise, and none is paused.
      const values = (builder as unknown as { values: (value: unknown) => Promise<unknown> })
        .values;
      return {
        values: async (value: unknown): Promise<unknown> => {
          const result = await values.call(builder, value);
          onPaused?.();
          await gate;
          return result;
        },
      } as unknown as ReturnType<MessageQueryRunner['insert']>;
    }) as MessageQueryRunner['insert'],
  });

  const base = wrap(db);

  return {
    database: {
      select: base.select,
      insert: base.insert,
      transaction: <T>(callback: (tx: MessageQueryRunner) => Promise<T>): Promise<T> =>
        db.transaction(async (tx) => callback(wrap(tx))),
    },
    counts,
  };
}

// The cast of characters. Alice and Bob share `alpha`; Carol is a stranger to
// it and owns an agent in `beta`, which is what makes the cross-project cases
// real rather than hypothetical.
let alice: UserId;
let bob: UserId;
let carol: UserId;
let alpha: ProjectId;
let beta: ProjectId;

/** Alice's agent, in `alpha`. The usual sender. */
let aliceInAlpha: AgentId;
/** Alice's second agent, in `alpha`. */
let aliceOther: AgentId;
/** Alice's agent, live, in no project. */
let aliceUnjoined: AgentId;
/** Bob's agent, in `alpha`. The usual recipient. */
let bobInAlpha: AgentId;
/** Carol's agent, in `beta` only. Never reachable from `alpha`. */
let carolInBeta: AgentId;

/**
 * A well-formed send from `aliceInAlpha` to `bobInAlpha`.
 *
 * @param overrides - Fields to replace.
 * @returns The request.
 */
function send(overrides: Partial<SendMessageRequest> = {}): SendMessageRequest {
  return {
    userId: alice,
    projectId: alpha,
    senderAgentId: aliceInAlpha,
    recipientAgentId: bobInAlpha,
    content: 'ship it',
    clientMessageId: `cli-${unique()}`,
    ...overrides,
  };
}

beforeAll(async () => {
  databaseName = `agentchat_t303_${unique()}`;

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`create database "${databaseName}"`);
  } finally {
    await admin.end();
  }

  const connectionString = urlForScratchDatabase(databaseName);
  pool = new Pool({ connectionString, max: 5 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  // Deliberately a second pool, not a second query on the first. What it can
  // see is what another process would see.
  observer = new Pool({ connectionString, max: 2 });
  observerDb = drizzle(observer, { schema });

  service = createMessageService(db);

  alice = await createUser('alice');
  bob = await createUser('bob');
  carol = await createUser('carol');

  alpha = await createProject(alice);
  beta = await createProject(carol);
  await addMember(alpha, bob);

  aliceInAlpha = await createAgent(alice, alpha);
  aliceOther = await createAgent(alice, alpha);
  aliceUnjoined = await createAgent(alice);
  bobInAlpha = await createAgent(bob, alpha);
  carolInBeta = await createAgent(carol, beta);
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

describe('accepting a message', () => {
  it('writes the message, its inbox row and a new conversation', async () => {
    const request = send({ content: 'first' });

    const result = await service.send(request);

    expect(result.duplicate).toBe(false);
    expect(result.conversationCreated).toBe(true);
    expect(MessageId.is(result.message.id)).toBe(true);
    expect(ConversationId.is(result.message.conversationId)).toBe(true);
    expect(result.message.content).toBe('first');
    expect(result.message.senderAgentId).toBe(aliceInAlpha);
    expect(result.message.recipientAgentId).toBe(bobInAlpha);
    expect(result.message.parentMessageId).toBeUndefined();
    expect(result.message.clientMessageId).toBe(request.clientMessageId);
  });

  it('addresses the inbox row to the recipient agent, not to a session', async () => {
    // D3. Sessions are ephemeral; the inbox is what replay keys on, so the row
    // must name the durable identity or an agent's second `listen` would not
    // find what its first one missed.
    const result = await service.send(send());

    const rows = await observerDb
      .select()
      .from(messageInbox)
      .where(eq(messageInbox.messageId, result.message.id));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.agentId).toBe(bobInAlpha);
    expect(rows[0]?.projectId).toBe(alpha);
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.ackedAt).toBeNull();
    expect(rows[0]?.ackedBySessionId).toBeNull();
  });

  it('has committed both rows by the time it returns, on another connection', async () => {
    // The durability claim in Plan §4.4, stated as a test. Nothing has been
    // delivered — this suite has no registry and no socket — and yet a
    // different connection can already see the message and the debt.
    const result = await service.send(send({ content: 'durable' }));

    const [message] = await observerDb
      .select()
      .from(messages)
      .where(eq(messages.id, result.message.id));
    const [owed] = await observerDb
      .select()
      .from(messageInbox)
      .where(eq(messageInbox.messageId, result.message.id));

    expect(message?.content).toBe('durable');
    expect(owed?.status).toBe('pending');
  });

  it('lets an agent send to itself, because no rule forbids it', async () => {
    const result = await service.send(
      send({ recipientAgentId: aliceInAlpha, content: 'note to self' }),
    );

    const rows = await observerDb
      .select()
      .from(messageInbox)
      .where(eq(messageInbox.messageId, result.message.id));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.agentId).toBe(aliceInAlpha);
  });
});

describe('conversation resolution', () => {
  it('opens a new conversation when none is named', async () => {
    const first = await service.send(send());
    const second = await service.send(send());

    expect(first.conversationCreated).toBe(true);
    expect(second.conversationCreated).toBe(true);
    expect(second.message.conversationId).not.toBe(first.message.conversationId);
  });

  it('makes a reply inherit its parent conversation', async () => {
    const parent = await service.send(send({ content: 'question' }));

    // Bob replies with his own agent, which is the ordinary case: the two ends
    // of a thread are owned by different people.
    const reply = await service.send(
      send({
        userId: bob,
        senderAgentId: bobInAlpha,
        recipientAgentId: aliceInAlpha,
        content: 'answer',
        parentMessageId: parent.message.id,
      }),
    );

    expect(reply.conversationCreated).toBe(false);
    expect(reply.message.conversationId).toBe(parent.message.conversationId);
    expect(reply.message.parentMessageId).toBe(parent.message.id);
  });

  it('joins a conversation the caller is already party to', async () => {
    const first = await service.send(send());

    const second = await service.send(
      send({ conversationId: first.message.conversationId, content: 'same thread' }),
    );

    expect(second.conversationCreated).toBe(false);
    expect(second.message.conversationId).toBe(first.message.conversationId);
  });

  it('refuses a reply whose parent is in another project', async () => {
    const parent = await service.send(send());

    const error = await refusal(() =>
      service.send({
        userId: carol,
        projectId: beta,
        senderAgentId: carolInBeta,
        recipientAgentId: carolInBeta,
        content: 'threading into alpha',
        clientMessageId: `cli-${unique()}`,
        parentMessageId: parent.message.id,
      }),
    );

    expect(error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('refuses a reply to a message between two other agents (D15)', async () => {
    // Carol is not in `alpha` at all, so she is refused earlier. The case that
    // needs proving is a *member* of the project: Bob can send in `alpha`, and
    // must still not be able to thread into a conversation he is not part of.
    const between = await service.send(
      send({ recipientAgentId: aliceOther, content: 'between alice and alice' }),
    );

    const error = await refusal(() =>
      service.send(
        send({
          userId: bob,
          senderAgentId: bobInAlpha,
          recipientAgentId: aliceInAlpha,
          parentMessageId: between.message.id,
        }),
      ),
    );

    expect(error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('refuses an explicit conversation the caller is not party to (D15)', async () => {
    const between = await service.send(send({ recipientAgentId: aliceOther }));

    const error = await refusal(() =>
      service.send(
        send({
          userId: bob,
          senderAgentId: bobInAlpha,
          recipientAgentId: aliceInAlpha,
          conversationId: between.message.conversationId,
        }),
      ),
    );

    expect(error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('refuses a conversation that does not exist, with the same answer', async () => {
    const hidden = await service.send(send({ recipientAgentId: aliceOther }));

    const invented = await refusal(() =>
      service.send(send({ conversationId: ConversationId.generate() })),
    );
    const real = await refusal(() =>
      service.send(
        send({
          userId: bob,
          senderAgentId: bobInAlpha,
          recipientAgentId: aliceInAlpha,
          conversationId: hidden.message.conversationId,
        }),
      ),
    );

    // An invented conversation and a real one the caller may not see answer
    // identically, or the refusal is an oracle for conversation ids.
    expect(toErrorResponse(invented)).toStrictEqual(toErrorResponse(real));
  });

  it('refuses a reply that names a different conversation', async () => {
    const parent = await service.send(send());
    const other = await service.send(send());

    const error = await refusal(() =>
      service.send(
        send({ parentMessageId: parent.message.id, conversationId: other.message.conversationId }),
      ),
    );

    expect(error.code).toBe(ErrorCode.BAD_REQUEST);
  });

  it('leaves no conversation behind when the send is refused', async () => {
    const before = await committedCounts(alpha);

    await refusal(() =>
      service.send(send({ recipientAgentId: carolInBeta, content: 'cross project' })),
    );

    const after = await committedCounts(alpha);
    expect(after.conversations).toBe(before.conversations);
  });
});

describe('authorization is three rules, not one', () => {
  it('refuses a sender the caller does not own', async () => {
    // Alice is a member of `alpha` and Bob's agent is in `alpha`, so the
    // project rule and the participation rule both pass. Only ownership fails.
    const error = await refusal(() => service.send(send({ senderAgentId: bobInAlpha })));

    expect(error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('refuses a sender the caller owns but has not joined to the project', async () => {
    // The half that ownership does not imply. `aliceUnjoined` is hers and it is
    // live; it is simply not in `alpha`, and the remedy is `agentchat agent
    // join`, which is why this is a different code from the one above.
    const error = await refusal(() => service.send(send({ senderAgentId: aliceUnjoined })));

    expect(error.code).toBe(ErrorCode.AGENT_NOT_IN_PROJECT);
  });

  it('refuses a recipient in another project', async () => {
    const error = await refusal(() => service.send(send({ recipientAgentId: carolInBeta })));

    expect(error.code).toBe(ErrorCode.NOT_FOUND);
    expect(await committedCounts(beta)).toStrictEqual({
      messages: 0,
      inbox: 0,
      conversations: 0,
    });
  });

  it('refuses a caller who is not a member of the project', async () => {
    const error = await refusal(() =>
      service.send({
        userId: carol,
        projectId: alpha,
        senderAgentId: carolInBeta,
        recipientAgentId: bobInAlpha,
        content: 'from outside',
        clientMessageId: `cli-${unique()}`,
      }),
    );

    expect(error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('refuses a recipient that is live but outside the project', async () => {
    const error = await refusal(() => service.send(send({ recipientAgentId: aliceUnjoined })));

    // Alice's own agent, so the code may name the remedy.
    expect(error.code).toBe(ErrorCode.AGENT_NOT_IN_PROJECT);
  });

  it('writes nothing at all when a rule refuses', async () => {
    const before = await committedCounts(alpha);

    await refusal(() => service.send(send({ senderAgentId: bobInAlpha })));
    await refusal(() => service.send(send({ recipientAgentId: carolInBeta })));

    expect(await committedCounts(alpha)).toStrictEqual(before);
  });
});

describe('the content limit', () => {
  it('refuses content over 1 MiB with PAYLOAD_TOO_LARGE', async () => {
    const error = await refusal(() =>
      service.send(send({ content: 'a'.repeat(MAX_CONTENT_BYTES + 1) })),
    );

    expect(error.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
    expect(toErrorResponse(error).statusCode).toBe(413);
  });

  it('refuses before touching the database', async () => {
    // The claim is not merely that oversize content is rejected — the schema
    // would do that — but that it is rejected without a round trip. Counted,
    // because "fails fast" is otherwise unfalsifiable.
    const { database, counts } = instrumentedDatabase();
    const instrumented = createMessageService(database);

    await refusal(() => instrumented.send(send({ content: 'a'.repeat(MAX_CONTENT_BYTES + 1) })));

    expect(counts).toStrictEqual({ selects: 0, inserts: 0 });
  });

  it('accepts content of exactly 1 MiB, agreeing with the constraint', async () => {
    const content = 'a'.repeat(MAX_CONTENT_BYTES);

    const result = await service.send(send({ content }));

    const [row] = await observerDb
      .select({ content: messages.content })
      .from(messages)
      .where(eq(messages.id, result.message.id));

    expect(row?.content).toHaveLength(MAX_CONTENT_BYTES);
  });
});

describe('a repeated client message identifier', () => {
  it('returns the original message rather than creating a second one', async () => {
    const request = send({ content: 'retried' });

    const first = await service.send(request);
    const second = await service.send(request);

    expect(second.duplicate).toBe(true);
    expect(second.message).toStrictEqual(first.message);
    expect(second.message.id).toBe(first.message.id);
    expect(second.message.createdAt.getTime()).toBe(first.message.createdAt.getTime());
  });

  it('is a success, not a CONFLICT — the CLI retries and must not see an error', async () => {
    const request = send();
    await service.send(request);

    await expect(service.send(request)).resolves.toMatchObject({ duplicate: true });
  });

  it('writes no second row, no second inbox row and no second conversation', async () => {
    const request = send();
    const before = await committedCounts(alpha);

    await service.send(request);
    const after = await committedCounts(alpha);

    await service.send(request);
    await service.send(request);
    const afterRetries = await committedCounts(alpha);

    expect(after.messages).toBe(before.messages + 1);
    expect(after.inbox).toBe(before.inbox + 1);
    expect(after.conversations).toBe(before.conversations + 1);
    expect(afterRetries).toStrictEqual(after);
  });

  it('writes nothing on the retry path', async () => {
    const request = send();
    await service.send(request);

    const { database, counts } = instrumentedDatabase();
    const instrumented = createMessageService(database);
    const again = await instrumented.send(request);

    expect(again.duplicate).toBe(true);
    expect(counts.inserts).toBe(0);
  });

  it('scopes the key to the sender: two agents may pick the same string', async () => {
    const clientMessageId = `shared-${unique()}`;

    const fromAlice = await service.send(send({ clientMessageId }));
    const fromBob = await service.send(
      send({
        userId: bob,
        senderAgentId: bobInAlpha,
        recipientAgentId: aliceInAlpha,
        clientMessageId,
      }),
    );

    expect(fromBob.duplicate).toBe(false);
    expect(fromBob.message.id).not.toBe(fromAlice.message.id);
  });

  it('tolerates two overlapping sends', async () => {
    const request = send({ content: 'overlapping' });
    const before = await committedCounts(alpha);

    const [first, second] = await Promise.all([service.send(request), service.send(request)]);

    expect(second.message.id).toBe(first.message.id);
    expect([first.duplicate, second.duplicate].filter(Boolean)).toHaveLength(1);

    const after = await committedCounts(alpha);
    expect(after.messages).toBe(before.messages + 1);
    expect(after.inbox).toBe(before.inbox + 1);
  });

  it('returns the original when the unique index has to pick the winner', async () => {
    // The test above does not reach the constraint: left to themselves the two
    // transactions serialise and the second one's read finds the first. The
    // collision has to be held open, or the fallback that a retry-under-load
    // actually depends on is never executed. Here the loser is paused after it
    // has read the key (miss) and created its conversation; the winner then
    // commits underneath it; only then is it allowed to insert.
    const request = send({ content: 'raced' });
    const before = await committedCounts(alpha);

    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = (): void => undefined;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });

    const { database } = instrumentedDatabase({
      pauseAfterInsert: 1,
      gate,
      onPaused: () => {
        reached();
      },
    });
    const loser = createMessageService(database);

    const losing = loser.send(request);
    await paused;

    const winner = await service.send(request);
    release();
    const lost = await losing;

    expect(winner.duplicate).toBe(false);
    expect(lost.duplicate).toBe(true);
    expect(lost.message).toStrictEqual(winner.message);

    const after = await committedCounts(alpha);
    expect(after.messages).toBe(before.messages + 1);
    expect(after.inbox).toBe(before.inbox + 1);
    // The loser created a conversation before it lost. That conversation must
    // have gone with its transaction, or a lost race would leave behind a
    // thread nobody is in.
    expect(after.conversations).toBe(before.conversations + 1);
  });
});

describe('a failure partway through', () => {
  it('leaves the message and the inbox row both absent', async () => {
    // Three inserts make a send from a new conversation: the conversation, the
    // message, the inbox row. Allowing two breaks it exactly between the
    // message and the debt it creates — the split that would otherwise be
    // silent, because nothing reads `messages` to decide what to deliver.
    const { database, counts } = instrumentedDatabase({ failAfterInserts: 2 });
    const instrumented = createMessageService(database);
    const request = send({ content: 'never committed' });
    const before = await committedCounts(alpha);

    await expect(instrumented.send(request)).rejects.toThrow(
      'simulated failure partway through the send',
    );

    expect(counts.inserts).toBe(3);
    expect(await committedCounts(alpha)).toStrictEqual(before);

    const orphans = await observerDb
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.senderAgentId, request.senderAgentId),
          eq(messages.clientMessageId, request.clientMessageId),
        ),
      );
    expect(orphans).toHaveLength(0);
  });

  it('does not consume the idempotency key, so the retry actually sends', async () => {
    // The other half of "both absent": a rolled-back send must not look like a
    // duplicate afterwards, or the CLI's retry would report success for a
    // message that was never written.
    const { database } = instrumentedDatabase({ failAfterInserts: 2 });
    const broken = createMessageService(database);
    const request = send({ content: 'retry after failure' });

    await expect(broken.send(request)).rejects.toThrow('simulated failure');

    const retried = await service.send(request);

    expect(retried.duplicate).toBe(false);
    const [owed] = await observerDb
      .select()
      .from(messageInbox)
      .where(eq(messageInbox.messageId, retried.message.id));
    expect(owed?.status).toBe('pending');
  });

  it('rolls the message back when only the inbox insert is refused', async () => {
    // The same split arranged by the database rather than by the wrapper: a
    // reply reuses its parent's conversation, so its send makes two inserts,
    // and allowing one stops after the message.
    const parent = await service.send(send());
    const { database } = instrumentedDatabase({ failAfterInserts: 1 });
    const instrumented = createMessageService(database);
    const before = await committedCounts(alpha);

    await expect(
      instrumented.send(send({ parentMessageId: parent.message.id, content: 'reply' })),
    ).rejects.toThrow('simulated failure');

    expect(await committedCounts(alpha)).toStrictEqual(before);
  });
});
