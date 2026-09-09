/**
 * `client.conversations.read`.
 *
 * One endpoint, and the interesting thing about it is the paging Plan §3 does
 * not mention. This file pins the two halves of that: a caller who asks for
 * nothing gets the server's own default rather than one this client invented,
 * and the cursor comes back untouched so a caller can decide for itself how far
 * to walk. Nothing here follows a cursor on the caller's behalf — a client that
 * quietly issued twenty requests behind one call would make a long thread
 * indistinguishable from a slow server.
 *
 * @module
 */

import { ConversationId, ErrorCode, MessageId, ProjectId } from '@agentchat/protocol';
import { describe, expect, it } from 'vitest';

import { AgentChatClient } from '../client.js';
import { InMemoryCredentialStore } from '../credentials.js';
import { HttpTransport } from '../http-transport.js';
import type { MockServer as MockServerType } from '../testing/mock-server.js';
import { envelope, MOCK_BASE_URL, MockServer } from '../testing/mock-server.js';

const PROJECT = ProjectId.generate();
const CONVERSATION = ConversationId.generate();
const MESSAGE = MessageId.generate();

const READ = `GET /conversations/${CONVERSATION}`;

/** The thread the stub answers with. */
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
  senderAgentId: 'agt_0199a1b2-c3d4-7e5f-8071-8293a4b5c6e2',
  recipientAgentId: 'agt_0199a1b2-c3d4-7e5f-8071-8293a4b5c6e1',
  content: 'can you check the retry behaviour?',
  createdAt: '2026-09-09T12:01:00.000Z',
};

/**
 * A signed-in client over a fresh mock server.
 *
 * @returns The client and the server behind it.
 */
function build(): { client: AgentChatClient; server: MockServerType } {
  const server = new MockServer();
  const client = new AgentChatClient({
    credentials: new InMemoryCredentialStore({ accessToken: 'at-1', refreshToken: 'rt-1' }),
    transport: new HttpTransport({ baseUrl: MOCK_BASE_URL, fetch: server.fetch() }),
  });
  return { client, server };
}

describe('conversations.read', () => {
  it('returns the thread, its messages, and the cursor', async () => {
    const { client, server } = build();
    server.reply(READ, {
      status: 200,
      body: { conversation: THREAD, messages: [MESSAGE_BODY], nextCursor: null },
    });

    await expect(client.conversations.read(CONVERSATION)).resolves.toStrictEqual({
      conversation: THREAD,
      messages: [MESSAGE_BODY],
      nextCursor: null,
    });
  });

  it('sends no paging parameters when the caller asked for none', async () => {
    const { client, server } = build();
    server.reply(READ, {
      status: 200,
      body: { conversation: THREAD, messages: [], nextCursor: null },
    });

    await client.conversations.read(CONVERSATION);

    // The server's default is the one that applies. A client that sent a limit
    // of its own would be a second opinion about the page size, in a place
    // nobody would think to look for one.
    expect(server.calls[0]?.path).toBe(`/conversations/${CONVERSATION}`);
  });

  it('passes a cursor and a limit through when they were given', async () => {
    const { client, server } = build();
    server.reply(READ, {
      status: 200,
      body: { conversation: THREAD, messages: [], nextCursor: null },
    });

    await client.conversations.read(CONVERSATION, { after: MESSAGE, limit: 25 });

    const query = new URL(server.calls[0]?.path ?? '', MOCK_BASE_URL).searchParams;
    expect(query.get('after')).toBe(MESSAGE);
    expect(query.get('limit')).toBe('25');
  });

  it('hands the cursor back unfollowed, so the caller decides how far to walk', async () => {
    const { client, server } = build();
    server.reply(READ, {
      status: 200,
      body: { conversation: THREAD, messages: [MESSAGE_BODY], nextCursor: MESSAGE },
    });

    await expect(client.conversations.read(CONVERSATION)).resolves.toMatchObject({
      nextCursor: MESSAGE,
    });
    expect(server.countOf(READ)).toBe(1);
  });

  it('raises what the server said for a thread the caller may not read', async () => {
    const { client, server } = build();
    server.reply(READ, { status: 404, body: envelope('NOT_FOUND', 'No such conversation.') });

    await expect(client.conversations.read(CONVERSATION)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('refuses a malformed cursor here rather than spending a round trip', async () => {
    const { client, server } = build();

    await expect(
      client.conversations.read(CONVERSATION, { after: 'yesterday' as typeof MESSAGE }),
    ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    expect(server.calls).toHaveLength(0);
  });
});
