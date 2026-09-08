/**
 * The message and conversation endpoints end to end: a real Fastify instance,
 * the real authentication guard, the real authorization service, the real
 * message and inbox services, and a real PostgreSQL.
 *
 * The property this suite exists for is one sentence of D15, and it cannot be
 * established anywhere else:
 *
 * > **A member of a project cannot read a conversation between two other
 * > agents.**
 *
 * Not "is not shown it" — cannot obtain it, with a valid token, a correct
 * `cnv_` id, and full membership of the project the thread lives in. A stubbed
 * service could be made to say that; only the database can prove it, because
 * the rule is a predicate in the `WHERE` of the query and a mock would be
 * mocking the thing under test.
 *
 * Three further properties follow it here for the same reason:
 *
 *  - **The rule is applied per message, not per thread.** A caller who is party
 *    to a conversation still does not see the messages inside it that neither
 *    of their agents sent or received — the same rule `services/messages.ts`
 *    applies when it resolves a `--reply-to` parent.
 *  - **The read is paged**, with an exact cursor: `nextCursor` is present when
 *    and only when a further *readable* message exists, so paging never
 *    reveals the size of what it skipped.
 *  - **A duplicate send is 200 and a fresh send is 201**, which is a claim
 *    about a unique index and therefore about the database.
 *
 * The suite owns a freshly created database, for the reason the other
 * integration suites give: they share one server, and rows written here must
 * not disturb another's.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  AgentId,
  type AgentId as AgentIdType,
  type ConversationId as ConversationIdType,
  ErrorCode,
  type MessageId as MessageIdType,
  ProjectId,
  type ProjectId as ProjectIdType,
  UserId,
  type UserId as UserIdType,
} from '@agentchat/protocol';
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
import {
  conversations,
  deliveries,
  machines,
  messageInbox,
  messages,
  sessions,
} from '../db/schema/messaging.js';
import { registerAuth } from '../plugins/auth.js';
import { createAuthorizationService } from '../services/authorization.js';
import { createConversationService } from '../services/conversations.js';
import { createInboxService } from '../services/inbox.js';
import { createMessageService } from '../services/messages.js';
import { registerConversationRoutes } from './conversations.js';
import type { HealthProbe } from './health.js';
import { registerMessageRoutes } from './messages.js';

/** The generated SQL migrations, exactly as the server image will ship them. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** The signing key both the tokens and the guard use. */
const JWT_SECRET = 'j'.repeat(32);

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
let db: NodePgDatabase<typeof schema>;
let databaseName: string;
let app: FastifyInstance;

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

/**
 * Creates a project with one owner.
 *
 * Written directly rather than through `POST /projects`, because project
 * creation is T-107's suite and this one is about what happens inside a
 * project that already exists.
 *
 * @param owner - The first member.
 * @returns The new project's identifier.
 */
async function createProject(owner: UserIdType): Promise<ProjectIdType> {
  const id = ProjectId.generate();
  await db
    .insert(projects)
    .values({ id, slug: `p-${unique()}`, name: 'payments', createdBy: owner });
  await db.insert(projectMembers).values({ projectId: id, userId: owner, role: 'owner' });
  return id;
}

/**
 * Adds a member to a project.
 *
 * @param projectId - The project.
 * @param userId - The person joining.
 */
async function addMember(projectId: ProjectIdType, userId: UserIdType): Promise<void> {
  await db.insert(projectMembers).values({ projectId, userId, role: 'member' });
}

/**
 * Creates an agent and joins it to a project.
 *
 * @param owner - Who owns it.
 * @param name - Its name.
 * @param projectId - The project it participates in.
 * @returns The new agent's identifier.
 */
async function createAgent(
  owner: UserIdType,
  name: string,
  projectId: ProjectIdType,
): Promise<AgentIdType> {
  const id = AgentId.generate();
  await db.insert(agents).values({ id, userId: owner, name });
  await db.insert(agentProjects).values({ agentId: id, projectId });
  return id;
}

/** What a send returns: the status and the parsed body. */
interface SendOutcome {
  readonly statusCode: number;
  readonly payload: string;
  readonly body: Record<string, unknown>;
}

/**
 * Sends a message through `POST /messages`.
 *
 * Through the endpoint rather than the service, because the status code is
 * half of what this suite asserts.
 *
 * @param caller - The authenticated sender's owner.
 * @param body - The request body.
 * @returns The status and the parsed response.
 */
async function send(caller: UserIdType, body: Record<string, unknown>): Promise<SendOutcome> {
  const response = await app.inject({
    method: 'POST',
    url: '/messages',
    headers: { authorization: bearer(caller) },
    payload: body,
  });

  return {
    statusCode: response.statusCode,
    payload: response.payload,
    body: JSON.parse(response.payload) as Record<string, unknown>,
  };
}

/** One page of a conversation, as the endpoint answers it. */
interface ReadOutcome {
  readonly statusCode: number;
  readonly payload: string;
  readonly messages: Record<string, unknown>[];
  readonly nextCursor: string | null;
  readonly error: string | undefined;
}

/**
 * Reads a conversation through `GET /conversations/:id`.
 *
 * @param caller - The authenticated reader.
 * @param conversationId - The thread.
 * @param query - Optional `limit` and `after`.
 * @returns The status, the page, and the error code when there was one.
 */
async function read(
  caller: UserIdType,
  conversationId: string,
  query: Record<string, string | number> = {},
): Promise<ReadOutcome> {
  const search = new URLSearchParams(
    Object.entries(query).map(([key, value]): [string, string] => [key, String(value)]),
  ).toString();

  const response = await app.inject({
    method: 'GET',
    url: `/conversations/${conversationId}${search === '' ? '' : `?${search}`}`,
    headers: { authorization: bearer(caller) },
  });

  const parsed = JSON.parse(response.payload) as Record<string, unknown>;

  return {
    statusCode: response.statusCode,
    payload: response.payload,
    messages: (parsed['messages'] as Record<string, unknown>[]) ?? [],
    nextCursor: (parsed['nextCursor'] as string | null) ?? null,
    error: (parsed['error'] as { code: string } | undefined)?.code,
  };
}

beforeAll(async () => {
  databaseName = `agentchat_t305_${unique()}`;

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

  // The same wiring `app.ts` will hold, with one authorization service shared
  // by both route modules.
  const authorization = createAuthorizationService(db);
  registerMessageRoutes(app, {
    messages: createMessageService(db),
    inbox: createInboxService(db),
  });
  registerConversationRoutes(app, {
    conversations: createConversationService({ db, authorization }),
  });

  await app.ready();
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

describe('a conversation between two agents', () => {
  it('is invisible to a third member of the same project', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');
    const mallory = await createUser('mallory');

    const project = await createProject(alice);
    await addMember(project, bob);
    await addMember(project, mallory);

    const alicesAgent = await createAgent(alice, 'backend', project);
    const bobsAgent = await createAgent(bob, 'frontend', project);
    // Mallory is a full member with a live agent in the project. Nothing about
    // her standing is defective; the only thing she lacks is a part in the
    // conversation.
    const mallorysAgent = await createAgent(mallory, 'ops', project);

    const sent = await send(alice, {
      projectId: project,
      senderAgentId: alicesAgent,
      recipientAgentId: bobsAgent,
      content: 'the deploy key rotates at midnight',
      clientMessageId: `cli-${unique()}`,
    });
    expect(sent.statusCode, sent.payload).toBe(201);

    const conversationId = sent.body['conversationId'] as string;

    // Both parties read it.
    const asAlice = await read(alice, conversationId);
    expect(asAlice.statusCode, asAlice.payload).toBe(200);
    expect(asAlice.messages).toHaveLength(1);
    expect(asAlice.messages[0]?.['content']).toBe('the deploy key rotates at midnight');

    const asBob = await read(bob, conversationId);
    expect(asBob.statusCode, asBob.payload).toBe(200);
    expect(asBob.messages).toHaveLength(1);

    // The property. Not an empty page — a 404, indistinguishable from a thread
    // that does not exist, so the endpoint cannot be used to confirm that two
    // colleagues are talking.
    const asMallory = await read(mallory, conversationId);
    expect(asMallory.statusCode, asMallory.payload).toBe(404);
    expect(asMallory.error).toBe(ErrorCode.NOT_FOUND);
    expect(asMallory.messages).toHaveLength(0);

    // And owning an agent that is in the project does not help: the rule is
    // about the messages, not about the agent.
    expect(mallorysAgent).not.toBe(alicesAgent);
  });

  it('answers a stranger and a member with the same refusal, byte for byte', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');
    const member = await createUser('member');
    const stranger = await createUser('stranger');

    const project = await createProject(alice);
    await addMember(project, bob);
    await addMember(project, member);

    const alicesAgent = await createAgent(alice, 'backend', project);
    const bobsAgent = await createAgent(bob, 'frontend', project);

    const sent = await send(alice, {
      projectId: project,
      senderAgentId: alicesAgent,
      recipientAgentId: bobsAgent,
      content: 'private',
      clientMessageId: `cli-${unique()}`,
    });
    const conversationId = sent.body['conversationId'] as string;

    const asMember = await read(member, conversationId);
    const asStranger = await read(stranger, conversationId);

    expect(asMember.statusCode).toBe(asStranger.statusCode);
    // The envelopes are identical, which is what makes the two cases
    // indistinguishable rather than merely both refused.
    expect(asMember.payload).toBe(asStranger.payload);
  });

  it('hides the messages inside it that the reader is not party to', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');
    const carol = await createUser('carol');

    const project = await createProject(alice);
    await addMember(project, bob);
    await addMember(project, carol);

    const alicesAgent = await createAgent(alice, 'backend', project);
    const bobsAgent = await createAgent(bob, 'frontend', project);
    const carolsAgent = await createAgent(carol, 'infra', project);

    const opened = await send(alice, {
      projectId: project,
      senderAgentId: alicesAgent,
      recipientAgentId: bobsAgent,
      content: 'to bob',
      clientMessageId: `cli-${unique()}`,
    });
    const conversationId = opened.body['conversationId'] as string;

    // Bob is party to the thread, so he may send into it — including to a third
    // agent. Alice is party to the thread but to neither end of *this* message.
    const aside = await send(bob, {
      projectId: project,
      senderAgentId: bobsAgent,
      recipientAgentId: carolsAgent,
      content: 'aside to carol',
      clientMessageId: `cli-${unique()}`,
      conversationId,
    });
    expect(aside.statusCode, aside.payload).toBe(201);

    const asBob = await read(bob, conversationId);
    expect(asBob.messages.map((message) => message['content'])).toStrictEqual([
      'to bob',
      'aside to carol',
    ]);

    // The per-message half of D15: absent, not redacted, and the cursor does
    // not hint that anything was skipped.
    const asAlice = await read(alice, conversationId);
    expect(asAlice.messages.map((message) => message['content'])).toStrictEqual(['to bob']);
    expect(asAlice.nextCursor).toBeNull();

    // Carol is party to the aside, so the thread is readable to her — but only
    // the message she is party to.
    const asCarol = await read(carol, conversationId);
    expect(asCarol.statusCode, asCarol.payload).toBe(200);
    expect(asCarol.messages.map((message) => message['content'])).toStrictEqual(['aside to carol']);
  });

  it('refuses a cursor naming a message the caller may not read', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');
    const carol = await createUser('carol');

    const project = await createProject(alice);
    await addMember(project, bob);
    await addMember(project, carol);

    const alicesAgent = await createAgent(alice, 'backend', project);
    const bobsAgent = await createAgent(bob, 'frontend', project);
    const carolsAgent = await createAgent(carol, 'infra', project);

    const opened = await send(alice, {
      projectId: project,
      senderAgentId: alicesAgent,
      recipientAgentId: bobsAgent,
      content: 'to bob',
      clientMessageId: `cli-${unique()}`,
    });
    const conversationId = opened.body['conversationId'] as string;

    const aside = await send(bob, {
      projectId: project,
      senderAgentId: bobsAgent,
      recipientAgentId: carolsAgent,
      content: 'aside to carol',
      clientMessageId: `cli-${unique()}`,
      conversationId,
    });

    const hidden = aside.body['id'] as string;
    const asAlice = await read(alice, conversationId, { after: hidden });

    // A `BAD_REQUEST` about the cursor rather than a page starting after it:
    // resuming from a message the caller may not read would confirm it exists.
    expect(asAlice.statusCode, asAlice.payload).toBe(400);
    expect(asAlice.error).toBe(ErrorCode.BAD_REQUEST);
  });
});

describe('paging a conversation', () => {
  it('returns a cursor exactly when more readable messages remain', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');

    const project = await createProject(alice);
    await addMember(project, bob);

    const alicesAgent = await createAgent(alice, 'backend', project);
    const bobsAgent = await createAgent(bob, 'frontend', project);

    const first = await send(alice, {
      projectId: project,
      senderAgentId: alicesAgent,
      recipientAgentId: bobsAgent,
      content: 'message 1',
      clientMessageId: `cli-${unique()}`,
    });
    const conversationId = first.body['conversationId'] as string;

    for (let index = 2; index <= 5; index += 1) {
      const outcome = await send(alice, {
        projectId: project,
        senderAgentId: alicesAgent,
        recipientAgentId: bobsAgent,
        content: `message ${index}`,
        clientMessageId: `cli-${unique()}`,
        conversationId,
      });
      expect(outcome.statusCode, outcome.payload).toBe(201);
    }

    const collected: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const page: ReadOutcome = await read(alice, conversationId, {
        limit: 2,
        ...(cursor === null ? {} : { after: cursor }),
      });

      expect(page.statusCode, page.payload).toBe(200);
      expect(page.messages.length).toBeLessThanOrEqual(2);

      collected.push(...page.messages.map((message) => message['content'] as string));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    // Oldest first, every message once, and the cursor went null at the end
    // rather than after an empty extra page.
    expect(collected).toStrictEqual([
      'message 1',
      'message 2',
      'message 3',
      'message 4',
      'message 5',
    ]);
    expect(cursor).toBeNull();
    expect(pages).toBe(3);
  });
});

describe('sending the same message twice', () => {
  it('is 201 then 200, with one message and one identifier', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');

    const project = await createProject(alice);
    await addMember(project, bob);

    const alicesAgent = await createAgent(alice, 'backend', project);
    const bobsAgent = await createAgent(bob, 'frontend', project);

    const body = {
      projectId: project,
      senderAgentId: alicesAgent,
      recipientAgentId: bobsAgent,
      content: 'retried',
      clientMessageId: `cli-${unique()}`,
    };

    const first = await send(alice, body);
    const retry = await send(alice, body);

    expect(first.statusCode, first.payload).toBe(201);
    // The status line is the only thing that differs, which is what lets a
    // client retry a POST whose response it never saw.
    expect(retry.statusCode, retry.payload).toBe(200);
    expect(retry.body['id']).toBe(first.body['id']);
    expect(retry.body['createdAt']).toBe(first.body['createdAt']);

    const conversationId = first.body['conversationId'] as ConversationIdType;
    const page = await read(alice, conversationId as string);
    expect(page.messages).toHaveLength(1);
  });
});

describe('the inbox endpoint', () => {
  it('lists what an agent is owed and clears it on acknowledgement', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');

    const project = await createProject(alice);
    await addMember(project, bob);

    const alicesAgent = await createAgent(alice, 'backend', project);
    const bobsAgent = await createAgent(bob, 'frontend', project);

    const sent = await send(alice, {
      projectId: project,
      senderAgentId: alicesAgent,
      recipientAgentId: bobsAgent,
      content: 'please review',
      clientMessageId: `cli-${unique()}`,
    });
    const messageId = sent.body['id'] as MessageIdType;

    const pending = await app.inject({
      method: 'GET',
      url: `/messages?projectId=${project}&agentId=${bobsAgent}`,
      headers: { authorization: bearer(bob) },
    });

    expect(pending.statusCode, pending.payload).toBe(200);
    const listed = JSON.parse(pending.payload) as {
      items: Record<string, unknown>[];
      nextCursor: string | null;
    };
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.['id']).toBe(messageId);
    expect(listed.nextCursor).toBeNull();

    const acked = await app.inject({
      method: 'POST',
      url: `/messages/${messageId}/ack`,
      headers: { authorization: bearer(bob) },
      payload: { agentId: bobsAgent, projectId: project },
    });
    expect(acked.statusCode, acked.payload).toBe(200);
    expect((JSON.parse(acked.payload) as Record<string, unknown>)['alreadyAcknowledged']).toBe(
      false,
    );

    // Idempotent, and a repeat is a success that says so.
    const again = await app.inject({
      method: 'POST',
      url: `/messages/${messageId}/ack`,
      headers: { authorization: bearer(bob) },
      payload: { agentId: bobsAgent, projectId: project },
    });
    expect(again.statusCode, again.payload).toBe(200);
    expect((JSON.parse(again.payload) as Record<string, unknown>)['alreadyAcknowledged']).toBe(
      true,
    );

    const drained = await app.inject({
      method: 'GET',
      url: `/messages?projectId=${project}&agentId=${bobsAgent}`,
      headers: { authorization: bearer(bob) },
    });
    expect((JSON.parse(drained.payload) as { items: unknown[] }).items).toHaveLength(0);
  });

  it('refuses to list a queue that is not the caller’s', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');

    const project = await createProject(alice);
    await addMember(project, bob);

    const bobsAgent = await createAgent(bob, 'frontend', project);

    const response = await app.inject({
      method: 'GET',
      url: `/messages?projectId=${project}&agentId=${bobsAgent}`,
      headers: { authorization: bearer(alice) },
    });

    expect(response.statusCode, response.payload).toBe(404);
  });
});
