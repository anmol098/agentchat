/**
 * The messaging shapes, and the three things about them that are decisions
 * rather than transcription.
 *
 * These schemas were moved out of the server's route modules rather than
 * designed here, so most of what they do is uncontroversial and is asserted by
 * the endpoints on both sides of them compiling. What is worth pinning is the
 * handful of places where a reasonable person would have written something
 * else, because those are the places a later edit will quietly "fix":
 *
 * - `status` defaults to `pending` and still admits `all`, which no server
 *   answers yet;
 * - `since` is not on the listing at all;
 * - the acknowledgement takes a `projectId` that Plan §3 does not have.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import { AgentId, ConversationId, MessageId, ProjectId, SessionId } from '../ids.js';
import {
  AcknowledgeMessageRequestSchema,
  AcknowledgeMessageResponseSchema,
  ListMessagesQuerySchema,
  ListMessagesResponseSchema,
  MessageSchema,
} from './messages.js';

const PROJECT = ProjectId.generate();
const AGENT = AgentId.generate();
const OTHER = AgentId.generate();
const MESSAGE = MessageId.generate();
const CONVERSATION = ConversationId.generate();
const SESSION = SessionId.generate();

/** A message exactly as every endpoint that returns one renders it. */
const MESSAGE_BODY = {
  id: MESSAGE,
  projectId: PROJECT,
  conversationId: CONVERSATION,
  parentMessageId: null,
  senderAgentId: OTHER,
  recipientAgentId: AGENT,
  content: 'can you check the retry behaviour?',
  createdAt: '2026-09-09T12:01:00.000Z',
};

describe('ListMessagesQuerySchema', () => {
  it('defaults to the one listing every server answers', () => {
    const parsed = ListMessagesQuerySchema.parse({ projectId: PROJECT, agentId: AGENT });

    expect(parsed.status).toBe('pending');
  });

  it('admits the historical listing, so a refusal can name what is missing', () => {
    // Dropping `all` would leave a client asking for it to be told "expected
    // 'pending'", which is a different and less useful answer than the server's
    // "the historical listing is not implemented yet".
    expect(
      ListMessagesQuerySchema.parse({ projectId: PROJECT, agentId: AGENT, status: 'all' }).status,
    ).toBe('all');
  });

  it('has no `since`, because nothing answers one', () => {
    const parsed = ListMessagesQuerySchema.parse({
      projectId: PROJECT,
      agentId: AGENT,
      since: '2026-09-01T00:00:00.000Z',
    });

    expect(parsed).not.toHaveProperty('since');
  });

  it('coerces a limit off a query string and refuses a nonsensical one', () => {
    expect(
      ListMessagesQuerySchema.parse({ projectId: PROJECT, agentId: AGENT, limit: '25' }).limit,
    ).toBe(25);
    expect(
      ListMessagesQuerySchema.safeParse({ projectId: PROJECT, agentId: AGENT, limit: 0 }).success,
    ).toBe(false);
  });

  it('requires both halves of the routing key', () => {
    expect(ListMessagesQuerySchema.safeParse({ projectId: PROJECT }).success).toBe(false);
    expect(ListMessagesQuerySchema.safeParse({ agentId: AGENT }).success).toBe(false);
  });
});

describe('ListMessagesResponseSchema', () => {
  it('carries the cursor explicitly, so "no more" is not "no paging"', () => {
    const parsed = ListMessagesResponseSchema.parse({
      items: [MESSAGE_BODY],
      nextCursor: null,
    });

    expect(parsed.nextCursor).toBeNull();
    expect(ListMessagesResponseSchema.safeParse({ items: [] }).success).toBe(false);
  });

  it('renders a listed message with the same schema a send returns', () => {
    // One shape for a send, a replay and a history read, because they are one
    // thing. A client that can display one can display all three.
    expect(
      ListMessagesResponseSchema.parse({ items: [MESSAGE_BODY], nextCursor: null }).items[0],
    ).toStrictEqual(MessageSchema.parse(MESSAGE_BODY));
  });
});

describe('AcknowledgeMessageRequestSchema', () => {
  it('requires the project Plan §3 does not have', () => {
    // The inbox is keyed on (agent, project) (D3), so an acknowledgement
    // without a project is not answerable.
    expect(AcknowledgeMessageRequestSchema.safeParse({ agentId: AGENT }).success).toBe(false);
    expect(
      AcknowledgeMessageRequestSchema.safeParse({ agentId: AGENT, projectId: PROJECT }).success,
    ).toBe(true);
  });

  it('leaves the session optional, because a plain HTTP client holds none', () => {
    expect(
      AcknowledgeMessageRequestSchema.parse({
        agentId: AGENT,
        projectId: PROJECT,
        sessionId: SESSION,
      }).sessionId,
    ).toBe(SESSION);
  });
});

describe('AcknowledgeMessageResponseSchema', () => {
  it('reports a repeat as a field rather than leaving it to a status code', () => {
    const parsed = AcknowledgeMessageResponseSchema.parse({
      messageId: MESSAGE,
      alreadyAcknowledged: true,
      acknowledgedAt: '2026-09-09T12:30:00.000Z',
      acknowledgedBySessionId: null,
    });

    expect(parsed.alreadyAcknowledged).toBe(true);
    // Nullable rather than optional: a session that has since been deleted
    // leaves the acknowledgement standing and the reference null.
    expect(parsed.acknowledgedBySessionId).toBeNull();
  });
});
