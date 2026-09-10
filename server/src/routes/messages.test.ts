/**
 * The message routes, as a client sees them.
 *
 * Every case goes through `createAppShell` plus the real `registerAuth`, so
 * what is asserted is the response a caller actually receives — status, code
 * and envelope — rather than the value a handler returned. The services are
 * stubs: what they implement is proved against a real database in
 * `../services/messages.integration.test.ts` and
 * `../services/inbox.integration.test.ts`, and what is under test here is the
 * boundary. Three properties in particular:
 *
 *  - **A duplicate send is 200, a fresh send is 201.** T-303 settled that a
 *    repeated `clientMessageId` is a success returning the original message;
 *    this suite is where the status code that reports it is pinned, because a
 *    `CONFLICT` here would break the CLI's retry.
 *  - **Protected by omission (T-019).** None of the three routes appears in
 *    `PUBLIC_ROUTES`, so all three are guarded.
 *  - **The route re-checks nothing.** A refusal raised by a service arrives
 *    with its own code intact rather than being translated.
 */

import {
  AgentId,
  ConversationId,
  ErrorCode,
  MessageId,
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
  AcknowledgeRequest,
  InboxService,
  ListPendingRequest,
  PendingMessage,
} from '../services/inbox.js';
import type { MessageRecord, MessageService, SendMessageRequest } from '../services/messages.js';
import type { HealthProbe } from './health.js';
import { registerMessageRoutes } from './messages.js';

/** The signing key under test. Long enough to be accepted; otherwise arbitrary. */
const SECRET = 's'.repeat(MIN_JWT_SECRET_LENGTH);

/** Fixed clock, so an expiry is a decision rather than a race. */
const NOW = new Date('2026-09-08T12:00:00.000Z');

/** `NOW` in whole seconds, which is the unit the claims use. */
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

const CALLER = UserId.generate();
const PROJECT = ProjectId.generate();
const SENDER = AgentId.generate();
const RECIPIENT = AgentId.generate();
const CONVERSATION = ConversationId.generate();

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

/** A committed message, as the send service would return one. */
function messageRecord(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: MessageId.generate(),
    projectId: PROJECT,
    conversationId: CONVERSATION,
    parentMessageId: undefined,
    senderAgentId: SENDER,
    recipientAgentId: RECIPIENT,
    content: 'the build is green',
    clientMessageId: 'cli-0001',
    createdAt: NOW,
    ...overrides,
  };
}

/** A pending message, as the inbox would replay one. */
function pendingMessage(overrides: Partial<PendingMessage> = {}): PendingMessage {
  return {
    id: MessageId.generate(),
    projectId: PROJECT,
    conversationId: CONVERSATION,
    parentMessageId: undefined,
    senderAgentId: SENDER,
    recipientAgentId: RECIPIENT,
    content: 'still waiting',
    createdAt: NOW,
    ...overrides,
  };
}

/** A body `POST /messages` accepts. */
function sendBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: PROJECT,
    senderAgentId: SENDER,
    recipientAgentId: RECIPIENT,
    content: 'the build is green',
    clientMessageId: 'cli-0001',
    ...overrides,
  };
}

/** The stubbed services, with each call recorded. */
interface ServiceStubs {
  readonly messages: MessageService;
  readonly inbox: InboxService;
  readonly send: ReturnType<typeof vi.fn>;
  readonly listPending: ReturnType<typeof vi.fn>;
  readonly acknowledge: ReturnType<typeof vi.fn>;
}

/**
 * Builds services whose methods succeed unless a test says otherwise.
 *
 * @param overrides - Implementations to substitute.
 * @returns The stubs and their spies.
 */
function stubServices(overrides: Record<string, unknown> = {}): ServiceStubs {
  const send = vi.fn(async (_request: SendMessageRequest) => ({
    message: messageRecord(),
    duplicate: false,
    conversationCreated: true,
  }));

  const listPending = vi.fn(async (_request: ListPendingRequest) => ({
    messages: [pendingMessage()],
    nextCursor: undefined,
  }));

  const acknowledge = vi.fn(async (request: AcknowledgeRequest) => ({
    messageId: request.messageId,
    alreadyAcknowledged: false,
    acknowledgedAt: NOW,
    acknowledgedBySessionId: request.sessionId,
  }));

  const stubs = { send, listPending, acknowledge, ...overrides };

  return {
    messages: { send: stubs.send } as unknown as MessageService,
    inbox: {
      listPending: stubs.listPending,
      acknowledge: stubs.acknowledge,
      recordDelivery: async () => undefined,
    } as unknown as InboxService,
    send: stubs.send as ReturnType<typeof vi.fn>,
    listPending: stubs.listPending as ReturnType<typeof vi.fn>,
    acknowledge: stubs.acknowledge as ReturnType<typeof vi.fn>,
  };
}

const started: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((app) => app.close()));
});

/**
 * Builds the application with the message routes on it.
 *
 * The shell rather than `createApp`, because `createApp` registers the auth
 * plugin itself and a second `registerAuth` on one instance is a duplicate
 * decorator. `registerAuth` runs before the routes so its `onRoute` hook covers
 * them, exactly as the wiring in `app.ts` arranges.
 *
 * @param stubs - The services the routes call.
 * @returns The instance.
 */
function buildApp(stubs: ServiceStubs): FastifyInstance {
  const app = createAppShell({ config, database: reachable, logger: silentLogger() });
  started.push(app);

  registerAuth(app, { jwtSecret: SECRET, now: () => NOW });
  registerMessageRoutes(app, { messages: stubs.messages, inbox: stubs.inbox });

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

/** The error envelope a response carries. */
function envelopeOf(payload: string): { code: string; message: string } {
  return (JSON.parse(payload) as { error: { code: string; message: string } }).error;
}

describe('protected by omission', () => {
  // Three routes, no `config.auth` on any of them, and none named in
  // `PUBLIC_ROUTES`. That is the whole mechanism, and this is the assertion
  // that would fail if one of them were ever added to that set.
  const anonymous: InjectOptions[] = [
    { method: 'POST', url: '/messages', payload: sendBody() },
    { method: 'GET', url: `/messages?projectId=${PROJECT}&agentId=${RECIPIENT}` },
    {
      method: 'POST',
      url: `/messages/${MessageId.generate()}/ack`,
      payload: { agentId: RECIPIENT, projectId: PROJECT },
    },
  ];

  it.each(anonymous)('refuses $method $url without a token', async (options) => {
    const app = buildApp(stubServices());

    const response = await app.inject(options);

    expect(response.statusCode).toBe(401);
    expect(envelopeOf(response.payload).code).toBe(ErrorCode.AUTH_REQUIRED);
  });
});

describe('POST /messages', () => {
  it('answers 201 with the committed message when it wrote one', async () => {
    const stubs = stubServices();
    const app = buildApp(stubs);

    const response = await app.inject({
      method: 'POST',
      url: '/messages',
      headers: authorized(),
      payload: sendBody(),
    });

    expect(response.statusCode, response.payload).toBe(201);
    const body = JSON.parse(response.payload) as Record<string, unknown>;
    expect(body['conversationId']).toBe(CONVERSATION);
    expect(body['content']).toBe('the build is green');
    expect(body['createdAt']).toBe(NOW.toISOString());
    // A thread root reports its absent parent as null rather than omitting it.
    expect(body['parentMessageId']).toBeNull();
  });

  // The property T-303 asked for by name: a repeated `clientMessageId` is a
  // success. The CLI retries a POST whose response it never saw, and a
  // CONFLICT here would force it to choose between reporting a failure that
  // did not happen and sending the message twice.
  it('answers 200 with the original message when the send was a duplicate', async () => {
    const original = messageRecord({ content: 'sent once' });
    const stubs = stubServices({
      send: vi.fn(async () => ({
        message: original,
        duplicate: true,
        conversationCreated: false,
      })),
    });
    const app = buildApp(stubs);

    const response = await app.inject({
      method: 'POST',
      url: '/messages',
      headers: authorized(),
      payload: sendBody(),
    });

    expect(response.statusCode, response.payload).toBe(200);
    expect((JSON.parse(response.payload) as Record<string, unknown>)['id']).toBe(original.id);
  });

  it('passes the caller from the token rather than from the body', async () => {
    const stubs = stubServices();
    const app = buildApp(stubs);

    await app.inject({
      method: 'POST',
      url: '/messages',
      headers: authorized(),
      // A body that tries to name somebody else. The field is not in the
      // schema, so it is dropped; the assertion is that the service saw the
      // authenticated caller and nothing else.
      payload: sendBody({ userId: UserId.generate() }),
    });

    expect(stubs.send).toHaveBeenCalledWith(expect.objectContaining({ userId: CALLER }));
  });

  it('forwards a reply without inventing a conversation for it', async () => {
    const parent = MessageId.generate();
    const stubs = stubServices();
    const app = buildApp(stubs);

    await app.inject({
      method: 'POST',
      url: '/messages',
      headers: authorized(),
      payload: sendBody({ parentMessageId: parent }),
    });

    const [request] = stubs.send.mock.calls[0] as [SendMessageRequest];
    expect(request.parentMessageId).toBe(parent);
    expect(request.conversationId).toBeUndefined();
  });

  it('refuses a malformed agent id before the service is reached', async () => {
    const stubs = stubServices();
    const app = buildApp(stubs);

    const response = await app.inject({
      method: 'POST',
      url: '/messages',
      headers: authorized(),
      payload: sendBody({ senderAgentId: 'not-an-agent' }),
    });

    expect(response.statusCode).toBe(400);
    expect(envelopeOf(response.payload).code).toBe(ErrorCode.BAD_REQUEST);
    expect(stubs.send).not.toHaveBeenCalled();
  });

  // Size is the service's decision, not the schema's: it measures bytes of
  // UTF-8 and answers with the count. The route must not pre-empt it with a
  // BAD_REQUEST about a different number.
  it('lets the service answer PAYLOAD_TOO_LARGE for oversize content', async () => {
    const stubs = stubServices({
      send: vi.fn(() =>
        Promise.reject(
          new ProtocolError(
            ErrorCode.PAYLOAD_TOO_LARGE,
            'Message content is 1048600 bytes; the limit is 1048576 bytes of UTF-8.',
          ),
        ),
      ),
    });
    const app = buildApp(stubs);

    const response = await app.inject({
      method: 'POST',
      url: '/messages',
      headers: authorized(),
      payload: sendBody({ content: 'x'.repeat(10) }),
    });

    expect(response.statusCode).toBe(413);
    expect(envelopeOf(response.payload).code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
  });

  it('passes AGENT_NOT_IN_PROJECT through with its remedy intact', async () => {
    const stubs = stubServices({
      send: vi.fn(() =>
        Promise.reject(
          new ProtocolError(
            ErrorCode.AGENT_NOT_IN_PROJECT,
            'That agent is not in this project. Add it with: agentchat agent join <name>',
          ),
        ),
      ),
    });
    const app = buildApp(stubs);

    const response = await app.inject({
      method: 'POST',
      url: '/messages',
      headers: authorized(),
      payload: sendBody(),
    });

    expect(response.statusCode).toBe(403);
    expect(envelopeOf(response.payload).code).toBe(ErrorCode.AGENT_NOT_IN_PROJECT);
    expect(envelopeOf(response.payload).message).toContain('agentchat agent join');
  });
});

describe('GET /messages', () => {
  it('envelopes the pending page and reports the end of the queue as null', async () => {
    const stubs = stubServices();
    const app = buildApp(stubs);

    const response = await app.inject({
      method: 'GET',
      url: `/messages?projectId=${PROJECT}&agentId=${RECIPIENT}`,
      headers: authorized(),
    });

    expect(response.statusCode, response.payload).toBe(200);
    const body = JSON.parse(response.payload) as { items: unknown[]; nextCursor: unknown };
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).toBeNull();
  });

  it('returns the cursor when the service says more remain', async () => {
    const cursor = MessageId.generate();
    const stubs = stubServices({
      listPending: vi.fn(async () => ({
        messages: [pendingMessage({ id: cursor })],
        nextCursor: cursor,
      })),
    });
    const app = buildApp(stubs);

    const response = await app.inject({
      method: 'GET',
      url: `/messages?projectId=${PROJECT}&agentId=${RECIPIENT}&limit=1`,
      headers: authorized(),
    });

    expect((JSON.parse(response.payload) as { nextCursor: unknown }).nextCursor).toBe(cursor);
  });

  it('forwards limit and after as the paging the service expects', async () => {
    const after = MessageId.generate();
    const stubs = stubServices();
    const app = buildApp(stubs);

    await app.inject({
      method: 'GET',
      url: `/messages?projectId=${PROJECT}&agentId=${RECIPIENT}&limit=25&after=${after}`,
      headers: authorized(),
    });

    expect(stubs.listPending).toHaveBeenCalledWith(
      expect.objectContaining({ userId: CALLER, limit: 25, after }),
    );
  });

  it('defaults to the pending listing when no status is given', async () => {
    const stubs = stubServices();
    const app = buildApp(stubs);

    const response = await app.inject({
      method: 'GET',
      url: `/messages?projectId=${PROJECT}&agentId=${RECIPIENT}`,
      headers: authorized(),
    });

    expect(response.statusCode).toBe(200);
    expect(stubs.listPending).toHaveBeenCalledTimes(1);
  });

  // Plan §3 offers `status=all` and `since=`; no service answers them. Refusing
  // with a message that says so is the difference between a client author
  // waiting for the endpoint and one debugging why `--all` shows only unread
  // messages.
  it.each([
    ['status=all', `status=all`],
    ['since', `since=${NOW.toISOString()}`],
  ])('refuses the unimplemented %s listing rather than serving pending', async (_name, extra) => {
    const stubs = stubServices();
    const app = buildApp(stubs);

    const response = await app.inject({
      method: 'GET',
      url: `/messages?projectId=${PROJECT}&agentId=${RECIPIENT}&${extra}`,
      headers: authorized(),
    });

    expect(response.statusCode).toBe(400);
    expect(envelopeOf(response.payload).code).toBe(ErrorCode.BAD_REQUEST);
    expect(envelopeOf(response.payload).message).toContain('status=pending');
    expect(stubs.listPending).not.toHaveBeenCalled();
  });

  it('requires the project and the agent, which are the routing key', async () => {
    const stubs = stubServices();
    const app = buildApp(stubs);

    const response = await app.inject({
      method: 'GET',
      url: `/messages?projectId=${PROJECT}`,
      headers: authorized(),
    });

    expect(response.statusCode).toBe(400);
    expect(stubs.listPending).not.toHaveBeenCalled();
  });
});

describe('POST /messages/:id/ack', () => {
  it('reports a first acknowledgement', async () => {
    const messageId = MessageId.generate();
    const sessionId = SessionId.generate();
    const stubs = stubServices();
    const app = buildApp(stubs);

    const response = await app.inject({
      method: 'POST',
      url: `/messages/${messageId}/ack`,
      headers: authorized(),
      payload: { agentId: RECIPIENT, projectId: PROJECT, sessionId },
    });

    expect(response.statusCode, response.payload).toBe(200);
    const body = JSON.parse(response.payload) as Record<string, unknown>;
    expect(body['messageId']).toBe(messageId);
    expect(body['alreadyAcknowledged']).toBe(false);
    expect(body['acknowledgedBySessionId']).toBe(sessionId);
  });

  // A repeat is the expected shape of a retry and of an acknowledgement racing
  // a replay. It is reported, never raised.
  it('answers 200 for a repeated acknowledgement', async () => {
    const messageId = MessageId.generate();
    const stubs = stubServices({
      acknowledge: vi.fn(async () => ({
        messageId,
        alreadyAcknowledged: true,
        acknowledgedAt: NOW,
        acknowledgedBySessionId: undefined,
      })),
    });
    const app = buildApp(stubs);

    const response = await app.inject({
      method: 'POST',
      url: `/messages/${messageId}/ack`,
      headers: authorized(),
      payload: { agentId: RECIPIENT, projectId: PROJECT },
    });

    expect(response.statusCode, response.payload).toBe(200);
    const body = JSON.parse(response.payload) as Record<string, unknown>;
    expect(body['alreadyAcknowledged']).toBe(true);
    expect(body['acknowledgedBySessionId']).toBeNull();
  });

  it('refuses an acknowledgement that names no project', async () => {
    const stubs = stubServices();
    const app = buildApp(stubs);

    const response = await app.inject({
      method: 'POST',
      url: `/messages/${MessageId.generate()}/ack`,
      headers: authorized(),
      payload: { agentId: RECIPIENT },
    });

    expect(response.statusCode).toBe(400);
    expect(stubs.acknowledge).not.toHaveBeenCalled();
  });

  it('refuses a malformed message id in the path as a bad request, not a miss', async () => {
    const stubs = stubServices();
    const app = buildApp(stubs);

    const response = await app.inject({
      method: 'POST',
      url: '/messages/not-a-message/ack',
      headers: authorized(),
      payload: { agentId: RECIPIENT, projectId: PROJECT },
    });

    expect(response.statusCode).toBe(400);
    expect(envelopeOf(response.payload).code).toBe(ErrorCode.BAD_REQUEST);
  });

  it('passes a refusal from the inbox through unchanged', async () => {
    const stubs = stubServices({
      acknowledge: vi.fn(() =>
        Promise.reject(new ProtocolError(ErrorCode.NOT_FOUND, 'No such message.')),
      ),
    });
    const app = buildApp(stubs);

    const response = await app.inject({
      method: 'POST',
      url: `/messages/${MessageId.generate()}/ack`,
      headers: authorized(),
      payload: { agentId: RECIPIENT, projectId: PROJECT },
    });

    expect(response.statusCode).toBe(404);
    expect(envelopeOf(response.payload).code).toBe(ErrorCode.NOT_FOUND);
  });
});
