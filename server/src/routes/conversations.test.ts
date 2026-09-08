/**
 * The conversation route, as a client sees it.
 *
 * The service is a stub here; the rule it applies is proved against a real
 * database in `./conversations.integration.test.ts`, which is where "a project
 * member cannot read a conversation between two other agents" is established.
 * What is under test in this file is the boundary: that the route is
 * authenticated, that it parses two query parameters and nothing else, that it
 * renders the page Plan §3's shape plus the cursor T-301 made necessary, and
 * that a refusal from the access rule arrives at the caller unchanged.
 */

import {
  AgentId,
  ConversationId,
  ErrorCode,
  MessageId,
  ProjectId,
  ProtocolError,
  UserId,
} from '@agentchat/protocol';
import type { FastifyInstance } from 'fastify';
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
  ConversationMessage,
  ConversationPage,
  ConversationService,
  ReadConversationRequest,
} from '../services/conversations.js';
import { ConversationMessageSchema, registerConversationRoutes } from './conversations.js';
import type { HealthProbe } from './health.js';
import { MessageSchema } from './messages.js';

/** The signing key under test. Long enough to be accepted; otherwise arbitrary. */
const SECRET = 's'.repeat(MIN_JWT_SECRET_LENGTH);

/** Fixed clock, so an expiry is a decision rather than a race. */
const NOW = new Date('2026-09-08T12:00:00.000Z');

/** `NOW` in whole seconds, which is the unit the claims use. */
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

const CALLER = UserId.generate();
const PROJECT = ProjectId.generate();
const CONVERSATION = ConversationId.generate();
const SENDER = AgentId.generate();
const RECIPIENT = AgentId.generate();

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

/** A message in a thread, as the service would return one. */
function message(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: MessageId.generate(),
    projectId: PROJECT,
    conversationId: CONVERSATION,
    parentMessageId: undefined,
    senderAgentId: SENDER,
    recipientAgentId: RECIPIENT,
    content: 'the build is green',
    createdAt: NOW,
    ...overrides,
  };
}

/** A page, as the service would return one. */
function page(overrides: Partial<ConversationPage> = {}): ConversationPage {
  return {
    conversation: { id: CONVERSATION, projectId: PROJECT, createdAt: NOW },
    messages: [message()],
    nextCursor: undefined,
    ...overrides,
  };
}

/** The stubbed read, with each call recorded. */
interface ServiceStub {
  readonly service: ConversationService;
  readonly read: ReturnType<typeof vi.fn>;
}

/**
 * Builds a service that answers with one page unless a test says otherwise.
 *
 * @param read - An implementation to substitute.
 * @returns The stub and its spy.
 */
function stubService(read?: ReturnType<typeof vi.fn>): ServiceStub {
  const spy = read ?? vi.fn(async (_request: ReadConversationRequest) => page());
  return { service: { read: spy } as unknown as ConversationService, read: spy };
}

const started: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((app) => app.close()));
});

/**
 * Builds the application with the conversation route on it.
 *
 * @param stub - The service the route calls.
 * @returns The instance.
 */
function buildApp(stub: ServiceStub): FastifyInstance {
  const app = createAppShell({ config, database: reachable, logger: silentLogger() });
  started.push(app);

  registerAuth(app, { jwtSecret: SECRET, now: () => NOW });
  registerConversationRoutes(app, { conversations: stub.service });

  return app;
}

/** The `Authorization` header for an authenticated request. */
function authorized(): Record<string, string> {
  return {
    authorization: `Bearer ${signAccessToken(
      { sub: CALLER, iat: NOW_SECONDS, exp: NOW_SECONDS + ACCESS_TOKEN_TTL_SECONDS },
      SECRET,
    )}`,
  };
}

/** The error envelope a response carries. */
function envelopeOf(payload: string): { code: string; message: string } {
  return (JSON.parse(payload) as { error: { code: string; message: string } }).error;
}

describe('protected by omission', () => {
  it('refuses an anonymous read', async () => {
    const app = buildApp(stubService());

    const response = await app.inject({ method: 'GET', url: `/conversations/${CONVERSATION}` });

    expect(response.statusCode).toBe(401);
    expect(envelopeOf(response.payload).code).toBe(ErrorCode.AUTH_REQUIRED);
  });
});

describe('GET /conversations/:id', () => {
  it('returns the thread, its messages and a null cursor at the end', async () => {
    const app = buildApp(stubService());

    const response = await app.inject({
      method: 'GET',
      url: `/conversations/${CONVERSATION}`,
      headers: authorized(),
    });

    expect(response.statusCode, response.payload).toBe(200);
    const body = JSON.parse(response.payload) as {
      conversation: Record<string, unknown>;
      messages: Record<string, unknown>[];
      nextCursor: unknown;
    };
    expect(body.conversation['id']).toBe(CONVERSATION);
    expect(body.conversation['projectId']).toBe(PROJECT);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.['parentMessageId']).toBeNull();
    expect(body.nextCursor).toBeNull();
  });

  it('returns the cursor when the service says more remain', async () => {
    const last = message();
    const app = buildApp(
      stubService(vi.fn(async () => page({ messages: [last], nextCursor: last.id }))),
    );

    const response = await app.inject({
      method: 'GET',
      url: `/conversations/${CONVERSATION}?limit=1`,
      headers: authorized(),
    });

    expect((JSON.parse(response.payload) as { nextCursor: unknown }).nextCursor).toBe(last.id);
  });

  it('forwards the caller from the token and the paging from the query', async () => {
    const after = MessageId.generate();
    const stub = stubService();
    const app = buildApp(stub);

    await app.inject({
      method: 'GET',
      url: `/conversations/${CONVERSATION}?limit=10&after=${after}`,
      headers: authorized(),
    });

    expect(stub.read).toHaveBeenCalledWith({
      userId: CALLER,
      conversationId: CONVERSATION,
      limit: 10,
      after,
    });
  });

  it('asks for no paging when the caller asked for none', async () => {
    const stub = stubService();
    const app = buildApp(stub);

    await app.inject({
      method: 'GET',
      url: `/conversations/${CONVERSATION}`,
      headers: authorized(),
    });

    const [request] = stub.read.mock.calls[0] as [ReadConversationRequest];
    expect(request.limit).toBeUndefined();
    expect(request.after).toBeUndefined();
  });

  it('refuses a malformed conversation id as a bad request, not a miss', async () => {
    const stub = stubService();
    const app = buildApp(stub);

    const response = await app.inject({
      method: 'GET',
      url: '/conversations/not-a-conversation',
      headers: authorized(),
    });

    expect(response.statusCode).toBe(400);
    expect(envelopeOf(response.payload).code).toBe(ErrorCode.BAD_REQUEST);
    expect(stub.read).not.toHaveBeenCalled();
  });

  it('refuses a limit that is not a whole number before the service is reached', async () => {
    const stub = stubService();
    const app = buildApp(stub);

    const response = await app.inject({
      method: 'GET',
      url: `/conversations/${CONVERSATION}?limit=abc`,
      headers: authorized(),
    });

    expect(response.statusCode).toBe(400);
    expect(stub.read).not.toHaveBeenCalled();
  });

  // The refusal a caller who is not party receives. The route does not decide
  // it and does not dress it up; the integration suite proves who gets it.
  it('passes the access rule refusal through as a 404', async () => {
    const app = buildApp(
      stubService(
        vi.fn(() =>
          Promise.reject(
            new ProtocolError(
              ErrorCode.NOT_FOUND,
              'No such conversation, or none of your agents is party to it.',
            ),
          ),
        ),
      ),
    );

    const response = await app.inject({
      method: 'GET',
      url: `/conversations/${CONVERSATION}`,
      headers: authorized(),
    });

    expect(response.statusCode).toBe(404);
    expect(envelopeOf(response.payload).code).toBe(ErrorCode.NOT_FOUND);
  });
});

// The two route modules declare the message shape separately so that neither
// imports the other; `packages/protocol` will own one copy as soon as the
// messaging schemas are opened. Until then this is what stops them drifting.
describe('the message shape both route modules send', () => {
  it('is the same in `messages.ts` and `conversations.ts`', () => {
    const sample = {
      id: MessageId.generate(),
      projectId: PROJECT,
      conversationId: CONVERSATION,
      parentMessageId: null,
      senderAgentId: SENDER,
      recipientAgentId: RECIPIENT,
      content: 'the build is green',
      createdAt: NOW.toISOString(),
    };

    expect(ConversationMessageSchema.parse(sample)).toStrictEqual(MessageSchema.parse(sample));
    expect(Object.keys(ConversationMessageSchema.shape)).toStrictEqual(
      Object.keys(MessageSchema.shape),
    );
  });
});
