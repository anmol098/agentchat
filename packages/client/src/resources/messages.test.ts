/**
 * `client.messages`.
 *
 * Two things here are not obvious from the method signatures, and both are the
 * kind of thing a caller gets wrong once and then has a production incident
 * about, so both are pinned:
 *
 * **A `POST /messages` answers 201 and 200 with the *same body*.** The
 * difference between "I wrote this" and "you had already sent this" exists only
 * on the status line. Every send case below would still pass if `duplicate`
 * were hard-coded, except the ones that pin it — so both statuses are asserted,
 * in both directions.
 *
 * **An acknowledgement that changed nothing is a success.** `alreadyAcknowledged`
 * arrives inside a 200, never as an error, because D3 makes a repeat the
 * expected shape of every retry and of every acknowledgement that raced a
 * replay. A client that raised on it would fail constantly and only in
 * deployment.
 *
 * @module
 */

import type { SendMessageRequest } from '@agentchat/protocol';
import {
  AgentId,
  ConversationId,
  ErrorCode,
  MessageId,
  ProjectId,
  SessionId,
} from '@agentchat/protocol';
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

const SESSION = SessionId.generate();

const SEND = 'POST /messages';
const LIST = 'GET /messages';
const ACK = `POST /messages/${MESSAGE}/ack`;

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

/** The stub's answer to an acknowledgement. */
const ACKNOWLEDGED = {
  messageId: MESSAGE,
  alreadyAcknowledged: false,
  acknowledgedAt: '2026-09-09T12:30:00.000Z',
  acknowledgedBySessionId: null,
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

describe('messages.list', () => {
  it('reads the pending queue for one agent in one project', async () => {
    const { client, server } = build();
    server.reply(LIST, { status: 200, body: { items: [COMMITTED], nextCursor: null } });

    await expect(
      client.messages.list({ projectId: PROJECT, agentId: RECIPIENT, status: 'pending' }),
    ).resolves.toStrictEqual({ items: [COMMITTED], nextCursor: null });

    const query = new URL(server.calls[0]?.path ?? '', MOCK_BASE_URL).searchParams;
    expect(query.get('projectId')).toBe(PROJECT);
    expect(query.get('agentId')).toBe(RECIPIENT);
    expect(query.get('status')).toBe('pending');
    // Absent rather than empty: the server's own default is the one that
    // applies, and a client that sent its own would be a second opinion about
    // the page size.
    expect(query.has('limit')).toBe(false);
    expect(query.has('after')).toBe(false);
  });

  it('passes the cursor back as `after`', async () => {
    const { client, server } = build();
    server.reply(LIST, { status: 200, body: { items: [], nextCursor: null } });

    await client.messages.list({
      projectId: PROJECT,
      agentId: RECIPIENT,
      status: 'pending',
      after: MESSAGE,
    });

    expect(new URL(server.calls[0]?.path ?? '', MOCK_BASE_URL).searchParams.get('after')).toBe(
      MESSAGE,
    );
  });

  it('returns the cursor the server sent, so a caller can drain a backlog', async () => {
    const { client, server } = build();
    server.reply(LIST, { status: 200, body: { items: [COMMITTED], nextCursor: MESSAGE } });

    await expect(
      client.messages.list({ projectId: PROJECT, agentId: RECIPIENT, status: 'pending' }),
    ).resolves.toMatchObject({ nextCursor: MESSAGE });
  });

  it('passes a refusal of the historical listing through untouched', async () => {
    const { client, server } = build();
    server.reply(LIST, {
      status: 400,
      body: envelope('BAD_REQUEST', 'the historical listing is not implemented yet.'),
    });

    // Not swallowed and not turned into the pending queue: the caller asked a
    // question the server declined to answer, and only the caller can decide
    // what to say about that.
    await expect(
      client.messages.list({ projectId: PROJECT, agentId: RECIPIENT, status: 'all' }),
    ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
  });
});

describe('messages.acknowledge', () => {
  it('clears one message for an agent in a project', async () => {
    const { client, server } = build();
    server.reply(ACK, { status: 200, body: ACKNOWLEDGED });

    await expect(
      client.messages.acknowledge(MESSAGE, { agentId: RECIPIENT, projectId: PROJECT }),
    ).resolves.toStrictEqual(ACKNOWLEDGED);

    expect(server.calls[0]?.path).toBe(`/messages/${MESSAGE}/ack`);
    expect(server.calls[0]?.body).toStrictEqual({ agentId: RECIPIENT, projectId: PROJECT });
  });

  it('treats a repeat as a result rather than an error', async () => {
    const { client, server } = build();
    server.reply(ACK, {
      status: 200,
      body: { ...ACKNOWLEDGED, alreadyAcknowledged: true },
    });

    const result = await client.messages.acknowledge(MESSAGE, {
      agentId: RECIPIENT,
      projectId: PROJECT,
    });

    // The timestamp is the original acknowledgement's, not this call's: the
    // debt was settled once and a retry does not settle it again.
    expect(result).toMatchObject({
      alreadyAcknowledged: true,
      acknowledgedAt: ACKNOWLEDGED.acknowledgedAt,
    });
  });

  it('sends the session only when one was named', async () => {
    const { client, server } = build();
    server.reply(ACK, { status: 200, body: ACKNOWLEDGED });

    await client.messages.acknowledge(MESSAGE, { agentId: RECIPIENT, projectId: PROJECT });
    await client.messages.acknowledge(MESSAGE, {
      agentId: RECIPIENT,
      projectId: PROJECT,
      sessionId: SESSION,
    });

    expect(server.calls[0]?.body).not.toHaveProperty('sessionId');
    expect(server.calls[1]?.body).toMatchObject({ sessionId: SESSION });
  });

  it('raises what the server said for a message this agent is not owed', async () => {
    const { client, server } = build();
    server.reply(ACK, { status: 404, body: envelope('NOT_FOUND', 'No such message.') });

    await expect(
      client.messages.acknowledge(MESSAGE, { agentId: RECIPIENT, projectId: PROJECT }),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('refuses a malformed agent identifier here rather than spending a round trip', async () => {
    const { client, server } = build();

    await expect(
      client.messages.acknowledge(MESSAGE, {
        agentId: 'backend' as typeof RECIPIENT,
        projectId: PROJECT,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    expect(server.calls).toHaveLength(0);
  });
});
