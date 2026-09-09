/**
 * The conversation read's shape.
 *
 * Two things here are decisions and are pinned as such: the response carries a
 * `nextCursor` that Plan §3 does not describe, and its messages are
 * {@link MessageSchema} itself rather than a second declaration of the same
 * eight fields. The second is the one a later edit is most likely to undo, by
 * adding a "conversation message" type that starts identical and drifts.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import { AgentId, ConversationId, MessageId, ProjectId } from '../ids.js';
import { ReadConversationQuerySchema, ReadConversationResponseSchema } from './conversations.js';
import { MessageSchema } from './messages.js';

const PROJECT = ProjectId.generate();
const CONVERSATION = ConversationId.generate();
const MESSAGE = MessageId.generate();

/** The thread. */
const THREAD = {
  id: CONVERSATION,
  projectId: PROJECT,
  createdAt: '2026-09-09T12:00:00.000Z',
};

/** One message in it. */
const MESSAGE_BODY = {
  id: MESSAGE,
  projectId: PROJECT,
  conversationId: CONVERSATION,
  parentMessageId: null,
  senderAgentId: AgentId.generate(),
  recipientAgentId: AgentId.generate(),
  content: 'can you check the retry behaviour?',
  createdAt: '2026-09-09T12:01:00.000Z',
};

describe('ReadConversationQuerySchema', () => {
  it('makes both parameters optional, so a §3-era client still reads a page', () => {
    expect(ReadConversationQuerySchema.parse({})).toStrictEqual({});
  });

  it('coerces a limit off a query string and refuses a request for nothing', () => {
    expect(ReadConversationQuerySchema.parse({ limit: '25' }).limit).toBe(25);
    expect(ReadConversationQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it('takes the cursor as a message identifier, not a timestamp', () => {
    expect(ReadConversationQuerySchema.parse({ after: MESSAGE }).after).toBe(MESSAGE);
    expect(
      ReadConversationQuerySchema.safeParse({ after: '2026-09-09T12:00:00.000Z' }).success,
    ).toBe(false);
  });
});

describe('ReadConversationResponseSchema', () => {
  it('carries a cursor beside the thread', () => {
    const parsed = ReadConversationResponseSchema.parse({
      conversation: THREAD,
      messages: [MESSAGE_BODY],
      nextCursor: MESSAGE,
    });

    expect(parsed.nextCursor).toBe(MESSAGE);
    // Explicitly null at the end, never absent.
    expect(
      ReadConversationResponseSchema.safeParse({ conversation: THREAD, messages: [] }).success,
    ).toBe(false);
  });

  it('renders a thread message with the one message schema', () => {
    const parsed = ReadConversationResponseSchema.parse({
      conversation: THREAD,
      messages: [MESSAGE_BODY],
      nextCursor: null,
    });

    expect(parsed.messages[0]).toStrictEqual(MessageSchema.parse(MESSAGE_BODY));
  });

  it('accepts an empty page, because D15 is applied per message', () => {
    // A thread the caller may open can still hold no message they may read.
    expect(
      ReadConversationResponseSchema.parse({
        conversation: THREAD,
        messages: [],
        nextCursor: null,
      }).messages,
    ).toHaveLength(0);
  });
});
