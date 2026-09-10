/**
 * The delivery loop against a real PostgreSQL database: real sends, real inbox
 * rows, real acknowledgements, and fake sockets.
 *
 * `./delivery.test.ts` proves the orderings and the isolation, which need a
 * socket that misbehaves on demand and no database at all. What is proved here
 * is everything that is a claim about **rows**, because every promise this
 * module makes is ultimately a promise about `message_inbox`:
 *
 * - **Fan-out to two sessions.** One agent listening twice is the normal case
 *   (D2). Both sockets receive the same message, both get a `deliveries` row,
 *   and the *single* inbox row is untouched by either — a delivery is not an
 *   acknowledgement.
 * - **Offline delivery.** A send with nobody listening reaches nobody and is
 *   not an error. The row stays `pending` and the next handshake replays it.
 * - **Crash before acknowledging.** A listener that takes a message and dies
 *   without acknowledging is replayed it when it comes back — the same message
 *   id, so a client deduplicating by id ends up with exactly one. The
 *   acknowledgement it then sends clears it, and a third handshake replays
 *   nothing.
 * - **D3 across sessions.** One session's acknowledgement empties the other
 *   session's replay, because the queue belongs to the agent.
 * - **A failure is one socket's own.** A socket that throws mid-fan-out is
 *   dropped and its neighbour still receives, is recorded, and can clear the
 *   message for both.
 * - **The sender handle.** `@user/agent` comes back from a real join, for a
 *   soft-deleted sender too (D13).
 * - **Paging.** A backlog larger than a page replays whole and in order.
 *
 * The sockets are fakes on purpose. Nothing registers a WebSocket route yet
 * (T-033), and a real socket would be proving the adapter rather than the
 * delivery loop; these objects satisfy `SocketBinding` structurally, which is
 * the same seam the handshake hands over.
 *
 * Rows are read on a **second pool** throughout, following
 * `../services/messages.integration.test.ts`: a row your own connection can see
 * proves nothing, and committed is the only thing a claim about durability can
 * mean.
 *
 * The suite owns a freshly created database, following the precedent in
 * `../services/inbox.integration.test.ts`, so no other suite's rows can affect
 * a count.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  AgentId,
  MachineId,
  type MessageId,
  ProjectId,
  SessionId,
  UserId,
} from '@stackgrid/protocol';
import { and, eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { createInboxService, type InboxDatabase, type InboxService } from '../services/inbox.js';
import {
  createMessageService,
  type MessageDatabase,
  type MessageRecord,
  type MessageService,
} from '../services/messages.js';
import type { SessionRecord } from '../services/sessions.js';
import type { ServerFrame, SocketIdentity } from '../websocket/frames.js';
import type { SocketBinding, SocketLogger } from '../websocket/handler.js';
import { createSocketRegistry, type SocketRegistry } from '../websocket/registry.js';
import {
  createDeliveryService,
  createSenderDirectory,
  type DeliveryService,
  type MessageEnvelope,
} from './delivery.js';
import { createInProcessRouter, type Router } from './router.js';

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

let inbox: InboxService;
let messageService: MessageService;

/** Rebuilt for every test, so no test inherits another's registrations. */
let registry: SocketRegistry;
let router: Router;
let delivery: DeliveryService;

/** Everything the service logged during the current test. */
let logs: LogLine[] = [];

/** A log line something under test wrote. */
interface LogLine {
  readonly level: 'info' | 'warn' | 'error';
  readonly details: Record<string, unknown>;
  readonly message: string;
}

const logger: SocketLogger = {
  info: (details, message) => logs.push({ level: 'info', details, message }),
  warn: (details, message) => logs.push({ level: 'warn', details, message }),
  error: (details, message) => logs.push({ level: 'error', details, message }),
};

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
// Row fixtures
// ---------------------------------------------------------------------------

/** A user, with the username their agents' handles are built from. */
interface Person {
  readonly id: UserId;
  readonly username: string;
}

/**
 * Creates a user.
 *
 * @param handle - Becomes the GitHub login, so it must match the lowercase
 *   grammar the schema enforces.
 * @returns The new user.
 */
async function createUser(handle: string): Promise<Person> {
  const id = UserId.generate();
  const username = `${handle}-${unique()}`;

  await db.insert(users).values({
    id,
    githubId: unique(),
    username,
    displayName: handle,
  });

  return { id, username };
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

/** An agent and the handle a delivered frame should carry for it. */
interface Agent {
  readonly id: AgentId;
  readonly handle: string;
}

/**
 * Creates an agent, joined to any projects named.
 *
 * @param owner - Who owns it.
 * @param name - The agent half of its handle.
 * @param joined - Projects to join it to.
 * @returns The agent and its `@user/agent` handle.
 */
async function createAgent(owner: Person, name: string, ...joined: ProjectId[]): Promise<Agent> {
  const id = AgentId.generate();
  const agentName = `${name}-${unique()}`;

  await db.insert(agents).values({ id, userId: owner.id, name: agentName });
  for (const projectId of joined) {
    await db.insert(agentProjects).values({ agentId: id, projectId });
  }

  return { id, handle: `@${owner.username}/${agentName}` };
}

/**
 * Creates a session: one `agentchat listen` invocation.
 *
 * Every call mints a new machine as well, so two sessions of one agent are as
 * unrelated as two laptops — which is the case D2 and D3 are both about.
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

// ---------------------------------------------------------------------------
// Sockets
// ---------------------------------------------------------------------------

/** A fake socket, and everything it was written. */
interface Listener extends SocketBinding {
  /** Everything written to it. */
  readonly frames: ServerFrame[];
  /** The envelopes of its `message` frames, in arrival order. */
  readonly envelopes: MessageEnvelope[];
  /** The message ids it saw, deduplicated the way `agentchat listen` does. */
  readonly deduplicated: readonly MessageId[];
}

/**
 * Builds a socket for one session, as the handshake would hand it over.
 *
 * @param owner - The authenticated user behind it.
 * @param sessionId - The session it bound to.
 * @param agent - The agent it speaks for.
 * @param projectId - The project it listens in.
 * @param onSend - Runs before each frame is recorded. Throw to make the socket
 *   fail the way a departed peer does.
 * @returns The binding, with what it received.
 */
function listener(
  owner: UserId,
  sessionId: SessionId,
  agent: AgentId,
  projectId: ProjectId,
  onSend?: (frame: ServerFrame) => void,
): Listener {
  const frames: ServerFrame[] = [];
  const identity: SocketIdentity = { userId: owner, sessionId, agentId: agent, projectId };

  // The handshake resolved and validated this record before binding; nothing in
  // delivery reads it, so only the fields a reader would look for are set.
  const session = {
    id: sessionId,
    agentId: agent,
    projectId,
    status: 'active',
  } as unknown as SessionRecord;

  function envelopes(): MessageEnvelope[] {
    return frames
      .filter((frame) => frame.type === 'message')
      .map((frame) => frame.message as MessageEnvelope);
  }

  return {
    identity,
    session,
    client: 'agentchat/0.0.0',
    frames,
    get envelopes(): MessageEnvelope[] {
      return envelopes();
    },
    get deduplicated(): readonly MessageId[] {
      return [...new Set(envelopes().map((envelope) => envelope.messageId))];
    },
    send(frame: ServerFrame): void {
      onSend?.(frame);
      frames.push(frame);
    },
    close(): void {
      // The handshake owns closing a socket; delivery never does.
    },
  };
}

// ---------------------------------------------------------------------------
// Reads, on the observing connection
// ---------------------------------------------------------------------------

/**
 * Reads one queue row on the observing connection.
 *
 * @param messageId - The message.
 * @param agentId - The agent that owes the acknowledgement.
 * @returns The row, or `undefined`.
 */
async function queueRow(
  messageId: MessageId,
  agentId: AgentId,
): Promise<{ status: string; ackedBySessionId: string | null } | undefined> {
  const rows = await observerDb
    .select({ status: messageInbox.status, ackedBySessionId: messageInbox.ackedBySessionId })
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

// ---------------------------------------------------------------------------
// The cast
// ---------------------------------------------------------------------------

/** Alice owns the project and does the sending. */
let alice: Person;
/** Bob owns the agent with a queue, and runs the listeners. */
let bob: Person;
let alpha: ProjectId;
/** Alice's agent in `alpha`. The sender throughout. */
let sender: Agent;
/**
 * Bob's agent in `alpha`, and the one with a queue.
 *
 * Minted afresh for every test rather than shared, because a queue is the
 * thing under test: a leftover pending row from an earlier test would be
 * replayed into a later one's handshake and every count would be off by
 * however many tests ran first. Cleaning up by acknowledging at the end of
 * each test would work, and would make each test depend on the last one having
 * remembered to.
 */
let recipient: Agent;

/**
 * Sends a message and delivers it, in the one order that is allowed.
 *
 * `deliver` is called strictly after `send` resolves — the row is committed and
 * visible on another connection by then, which is what makes a replay or an
 * acknowledgement arriving a microsecond later find something.
 *
 * @param content - The body.
 * @returns The committed message.
 */
async function sendAndDeliver(content: string): Promise<MessageRecord> {
  const result = await messageService.send({
    userId: alice.id,
    projectId: alpha,
    senderAgentId: sender.id,
    recipientAgentId: recipient.id,
    content,
    clientMessageId: `cli-${unique()}`,
  });

  await delivery.deliver(result.message);
  return result.message;
}

/**
 * Binds a fresh session for Bob's agent and replays its queue.
 *
 * @param onSend - Passed through to the socket.
 * @returns The listener and the count the `ready` frame would carry.
 */
async function connect(
  onSend?: (frame: ServerFrame) => void,
): Promise<{ socket: Listener; pending: number }> {
  const sessionId = await createSession(bob.id, recipient.id, alpha);
  const socket = listener(bob.id, sessionId, recipient.id, alpha, onSend);
  const pending = await delivery.bound(socket);
  return { socket, pending };
}

beforeAll(async () => {
  databaseName = `agentchat_t308_${unique()}`;

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

  inbox = createInboxService(db as unknown as InboxDatabase);
  messageService = createMessageService(db as unknown as MessageDatabase);

  alice = await createUser('alice');
  bob = await createUser('bob');
  alpha = await createProject(alice.id);
  await addMember(alpha, bob.id);
  sender = await createAgent(alice, 'backend', alpha);
}, 120_000);

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

beforeEach(async () => {
  logs = [];
  recipient = await createAgent(bob, 'worker', alpha);
  registry = createSocketRegistry();
  router = createInProcessRouter({ registry, logger });
  delivery = createDeliveryService({
    router,
    registry,
    inbox,
    senders: createSenderDirectory(db),
    logger,
    // Two, so a backlog of three proves the paging loop without three hundred
    // rows. The real page size is the inbox's; see `./delivery.ts`.
    replayPageSize: 2,
  });
});

// ---------------------------------------------------------------------------

describe('fan-out to two sessions', () => {
  it('delivers one message to both listeners and records both attempts', async () => {
    const first = await connect();
    const second = await connect();

    const message = await sendAndDeliver('deploy is green');

    expect(first.socket.envelopes.map((envelope) => envelope.content)).toStrictEqual([
      'deploy is green',
    ]);
    expect(second.socket.envelopes.map((envelope) => envelope.content)).toStrictEqual([
      'deploy is green',
    ]);
    expect(first.socket.envelopes[0]?.messageId).toBe(message.id);
    expect(second.socket.envelopes[0]?.messageId).toBe(message.id);

    // One attempt recorded per socket, keyed by session (Plan §2).
    expect(await deliveryRow(message.id, first.socket.identity.sessionId)).toBeDefined();
    expect(await deliveryRow(message.id, second.socket.identity.sessionId)).toBeDefined();

    // And one queue row for the agent, still owed. Delivering is not
    // acknowledging, however many sockets took it.
    expect(await queueRow(message.id, recipient.id)).toStrictEqual({
      status: 'pending',
      ackedBySessionId: null,
    });
  });

  it('carries the sender handle, joined from real rows', async () => {
    const { socket } = await connect();
    const message = await sendAndDeliver('who sent this?');

    expect(socket.envelopes[0]).toStrictEqual({
      messageId: message.id,
      projectId: alpha,
      conversationId: message.conversationId,
      parentMessageId: undefined,
      senderAgentId: sender.id,
      sender: sender.handle,
      recipientAgentId: recipient.id,
      content: 'who sent this?',
      createdAt: message.createdAt.toISOString(),
    });
  });

  it('still names a sender whose agent has since been soft-deleted', async () => {
    // D13: a year-old message still has to say who wrote it. Deleting the
    // author is not a reason to render the message as having none.
    const ghost = await createAgent(alice, 'ghost', alpha);
    const result = await messageService.send({
      userId: alice.id,
      projectId: alpha,
      senderAgentId: ghost.id,
      recipientAgentId: recipient.id,
      content: 'from beyond',
      clientMessageId: `cli-${unique()}`,
    });

    await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, ghost.id));

    const { socket } = await connect();
    await delivery.deliver(result.message);

    // Twice: once replayed by the handshake, once by the live fan-out. The same
    // id both times, which is what makes the duplicate free.
    expect(socket.deduplicated).toStrictEqual([result.message.id]);
    expect(socket.envelopes[0]?.sender).toBe(ghost.handle);
  });

  it('acknowledged by one session, the message is gone for the other', async () => {
    // D3: the queue belongs to the agent, not to a session.
    const first = await connect();
    const second = await connect();
    const message = await sendAndDeliver('only one of you needs to answer');

    await delivery.acked(first.socket, message.id);

    expect(await queueRow(message.id, recipient.id)).toStrictEqual({
      status: 'acked',
      ackedBySessionId: first.socket.identity.sessionId,
    });

    const third = await connect();
    expect(third.pending).toBe(0);
    expect(third.socket.frames).toStrictEqual([]);
    expect(second.socket.envelopes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('offline delivery', () => {
  it('reaches nobody, is not an error, and arrives on the next handshake', async () => {
    const message = await sendAndDeliver('nobody is home');

    // Nothing was written anywhere, and nothing was recorded.
    expect(registry.size).toBe(0);
    expect(await deliveryRow(message.id, SessionId.generate())).toBeUndefined();

    // The row is untouched, which is the entire mechanism.
    expect(await queueRow(message.id, recipient.id)).toStrictEqual({
      status: 'pending',
      ackedBySessionId: null,
    });

    // Logged as an outcome, not a failure.
    const line = logs.find((entry) => entry.message.startsWith('message delivered to no live'));
    expect(line?.level).toBe('info');

    const { socket, pending } = await connect();

    expect(pending).toBe(1);
    expect(socket.envelopes.map((envelope) => envelope.content)).toStrictEqual(['nobody is home']);
    expect(await deliveryRow(message.id, socket.identity.sessionId)).toBeDefined();
  });

  it('replays a backlog larger than a page, in order, and reports the whole count', async () => {
    const first = await sendAndDeliver('one');
    const second = await sendAndDeliver('two');
    const third = await sendAndDeliver('three');

    const { socket, pending } = await connect();

    expect(pending).toBe(3);
    expect(socket.envelopes.map((envelope) => envelope.content)).toStrictEqual([
      'one',
      'two',
      'three',
    ]);
    expect(socket.envelopes.map((envelope) => envelope.messageId)).toStrictEqual([
      first.id,
      second.id,
      third.id,
    ]);

    for (const message of [first, second, third]) {
      expect(await deliveryRow(message.id, socket.identity.sessionId)).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------

describe('a listener that dies before acknowledging', () => {
  it('is replayed the message on restart, exactly once after deduplication', async () => {
    const first = await connect();
    const message = await sendAndDeliver('please confirm');

    expect(first.socket.deduplicated).toStrictEqual([message.id]);

    // It dies. No acknowledgement, and the socket goes without one.
    await delivery.closed(first.socket);
    expect(registry.size).toBe(0);

    // The debt survives the process that owed it.
    expect(await queueRow(message.id, recipient.id)).toStrictEqual({
      status: 'pending',
      ackedBySessionId: null,
    });

    // It comes back as a new session, the way `agentchat listen` always does.
    const second = await connect();

    expect(second.pending).toBe(1);
    expect(second.socket.deduplicated).toStrictEqual([message.id]);
    expect(second.socket.envelopes[0]?.content).toBe('please confirm');

    // The delivery is recorded against the *new* session; the dead one's row
    // stays as it was, never acknowledged, which is what makes it diagnosable.
    expect(await deliveryRow(message.id, second.socket.identity.sessionId)).toBeDefined();
    expect((await deliveryRow(message.id, first.socket.identity.sessionId))?.ackedAt).toBeNull();

    // This time it answers.
    await delivery.acked(second.socket, message.id);
    expect(await queueRow(message.id, recipient.id)).toStrictEqual({
      status: 'acked',
      ackedBySessionId: second.socket.identity.sessionId,
    });

    // And a third handshake is handed nothing. The replay is over.
    const third = await connect();
    expect(third.pending).toBe(0);
    expect(third.socket.frames).toStrictEqual([]);
  });

  it('accepts the acknowledgement it did not manage to send before dying', async () => {
    // A client that restarts with an unsent acknowledgement in hand replays it.
    // The message is already cleared by then, and saying so is a success rather
    // than a reason to close the socket.
    const first = await connect();
    const message = await sendAndDeliver('twice-answered');
    await delivery.acked(first.socket, message.id);

    const second = await connect();
    await expect(delivery.acked(second.socket, message.id)).resolves.toBeUndefined();

    expect(logs.some((line) => line.message.includes('already cleared'))).toBe(true);
    expect(await queueRow(message.id, recipient.id)).toStrictEqual({
      status: 'acked',
      ackedBySessionId: first.socket.identity.sessionId,
    });
  });

  it('ignores an acknowledgement for a message it was never owed', async () => {
    const { socket } = await connect();
    const stranger = await messageService.send({
      userId: alice.id,
      projectId: alpha,
      senderAgentId: sender.id,
      // Addressed to the sender's own agent, so Bob's queue never had it.
      recipientAgentId: sender.id,
      content: 'not for you',
      clientMessageId: `cli-${unique()}`,
    });

    await expect(delivery.acked(socket, stranger.message.id)).resolves.toBeUndefined();
    expect(logs.some((line) => line.message.includes('does not owe'))).toBe(true);

    // And the message it was not owed is still owed by whoever was.
    expect(await queueRow(stranger.message.id, sender.id)).toStrictEqual({
      status: 'pending',
      ackedBySessionId: null,
    });
  });
});

// ---------------------------------------------------------------------------

describe('a failure to one socket', () => {
  it('never prevents delivery to another', async () => {
    const broken = await connect(() => {
      throw new Error('EPIPE');
    });
    const healthy = await connect();

    const message = await sendAndDeliver('one of you is gone');

    // The healthy socket received, was recorded, and can still settle the debt.
    expect(healthy.socket.envelopes.map((envelope) => envelope.content)).toStrictEqual([
      'one of you is gone',
    ]);
    expect(await deliveryRow(message.id, healthy.socket.identity.sessionId)).toBeDefined();

    // The broken one is deregistered and has no delivery row, because nothing
    // was delivered to it.
    expect(registry.socketsFor({ agentId: recipient.id, projectId: alpha })).toStrictEqual([
      healthy.socket,
    ]);
    expect(await deliveryRow(message.id, broken.socket.identity.sessionId)).toBeUndefined();

    await delivery.acked(healthy.socket, message.id);
    expect(await queueRow(message.id, recipient.id)).toStrictEqual({
      status: 'acked',
      ackedBySessionId: healthy.socket.identity.sessionId,
    });
  });

  it('leaves the message pending when every socket fails, so it replays', async () => {
    await connect(() => {
      throw new Error('ECONNRESET');
    });

    const message = await sendAndDeliver('into the void');

    expect(await queueRow(message.id, recipient.id)).toStrictEqual({
      status: 'pending',
      ackedBySessionId: null,
    });

    const { socket, pending } = await connect();
    expect(pending).toBe(1);
    expect(socket.envelopes[0]?.messageId).toBe(message.id);
  });
});
