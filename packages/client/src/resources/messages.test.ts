/**
 * `client.messages.send`.
 *
 * The whole of this file is about one thing the rest of the client does not
 * have to think about: a `POST /messages` answers 201 and 200 with the *same
 * body*, and the difference between "I wrote this" and "you had already sent
 * this" exists only on the status line. Every case below would still pass if
 * `duplicate` were hard-coded, except the ones that pin it — so both statuses
 * are asserted, in both directions.
 *
 * @module
 */

import type { SendMessageRequest } from '@agentchat/protocol';
import { AgentId, ConversationId, ErrorCode, MessageId, ProjectId } from '@agentchat/protocol';
import { describe, expect, it } from 'vitest';

import { AgentChatClient } from '../client.js';
import { InMemoryCredentialStore } from '../credentials.js';
import { HttpTransport } from '../http-transport.js';
import type { MockServer as MockServerType } from '../testing/mock-server.js';
import { envelope, MOCK_BASE_URL, MockServer } from '../testing/mock-server.js';

const PROJECT = ProjectId.generate();
const SENDER = AgentId.generate();
const RECIPIENT = AgentId.generate();
const CONVERSATION = ConversationId.generate();
const MESSAGE = MessageId.generate();

const SEND = 'POST /messages';

/** The request every case sends, unless it varies a field. */
const REQUEST: SendMessageRequest = {
  projectId: PROJECT,
  senderAgentId: SENDER,
  recipientAgentId: RECIPIENT,
  content: 'the build is green',
  clientMessageId: '0199a1b2-c3d4-7e5f-8071-8293a4b5c6d7',
};

/** The message the stub commits, as the wire carries it. */
const COMMITTED = {
  id: MESSAGE,
  projectId: PROJECT,
  conversationId: CONVERSATION,
  parentMessageId: null,
  senderAgentId: SENDER,
  recipientAgentId: RECIPIENT,
  content: 'the build is green',
  createdAt: '2026-09-08T12:00:00.000Z',
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

describe('messages.send', () => {
  it('reports a 201 as a message this call wrote', async () => {
    const { client, server } = build();
    server.reply(SEND, { status: 201, body: COMMITTED });

    await expect(client.messages.send(REQUEST)).resolves.toStrictEqual({
      message: COMMITTED,
      duplicate: false,
    });
  });

  it('reports a 200 as the original of a send that had already been accepted', async () => {
    const { client, server } = build();
    server.reply(SEND, { status: 200, body: COMMITTED });

    const outcome = await client.messages.send(REQUEST);

    // The point of the endpoint: the same message, not a second one, and not an
    // error. Only `duplicate` differs from the 201 case above.
    expect(outcome).toStrictEqual({ message: COMMITTED, duplicate: true });
  });

  it('sends the threading fields only when they were given', async () => {
    const { client, server } = build();
    server.reply(SEND, { status: 201, body: COMMITTED });

    await client.messages.send(REQUEST);
    await client.messages.send({ ...REQUEST, parentMessageId: MESSAGE });

    expect(server.calls[0]?.body).toStrictEqual({
      projectId: PROJECT,
      senderAgentId: SENDER,
      recipientAgentId: RECIPIENT,
      content: 'the build is green',
      clientMessageId: '0199a1b2-c3d4-7e5f-8071-8293a4b5c6d7',
    });
    expect(server.calls[1]?.body).toMatchObject({ parentMessageId: MESSAGE });
  });

  it('refuses a malformed identifier here rather than spending a round trip', async () => {
    const { client, server } = build();

    await expect(
      client.messages.send({ ...REQUEST, recipientAgentId: 'backend' as typeof RECIPIENT }),
    ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    expect(server.calls).toHaveLength(0);
  });

  it('raises what the server said when the recipient is not visible', async () => {
    const { client, server } = build();
    server.reply(SEND, { status: 404, body: envelope('NOT_FOUND', 'No such agent.') });

    await expect(client.messages.send(REQUEST)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('does not retry a send of its own accord, because only the caller holds the key', async () => {
    const { client, server } = build();
    server.reply(SEND, { status: 503, body: envelope('INTERNAL', 'Try again.') });

    await expect(client.messages.send(REQUEST)).rejects.toMatchObject({
      code: ErrorCode.INTERNAL,
    });
    expect(server.countOf(SEND)).toBe(1);
  });
});
