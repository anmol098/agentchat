/**
 * The delivery loop, over a real registry and a real router but a fake inbox.
 *
 * The database claims — that a pending row survives a delivery reaching nobody,
 * that an acknowledgement clears it for every session of the agent — belong to
 * `./delivery.integration.test.ts`, because they are claims about rows. What is
 * proved here is everything that is about *ordering and isolation*, which a
 * database cannot be made to demonstrate on demand:
 *
 * - **fan-out** — two sockets on one key both receive, and each attempt is
 *   recorded against its own session.
 * - **one socket's failure** — a `send` that throws, first in the list, does
 *   not stop the two behind it, and the survivors' bookkeeping still happens.
 * - **registration precedes replay** — proved by delivering *from inside* the
 *   pending read, which is the interleaving the other order would drop.
 * - **replay paging** — three pages of one, in order, with the cursor followed.
 * - **replay stops when the socket does** — a peer that disconnects mid-replay
 *   stops costing queries.
 * - **bookkeeping never fails a delivery** — `recordDelivery` and the handle
 *   lookup are both allowed to throw, and the frames still go out.
 * - **acknowledgement** — a repeat is a success, an unowed message is ignored
 *   rather than closing the socket, and anything else is rethrown.
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
} from '@agentchat/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../services/sessions.js';
import type { ServerFrame, SocketIdentity } from '../websocket/frames.js';
import type { SocketBinding, SocketLogger } from '../websocket/handler.js';
import { createSocketRegistry, type SocketRegistry } from '../websocket/registry.js';
import {
  createDeliveryService,
  type DeliverableMessage,
  type DeliveryInbox,
  type DeliveryService,
  type MessageEnvelope,
  REPLAY_PAGE_SIZE,
  type SenderDirectory,
} from './delivery.js';
import { createInProcessRouter, type Router } from './router.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER = UserId.generate();
const AGENT = AgentId.generate();
const SENDER = AgentId.generate();
const PROJECT = ProjectId.generate();
const CONVERSATION = ConversationId.generate();

/** The handle the fake directory resolves for {@link SENDER}. */
const SENDER_HANDLE = '@alice/backend';

/** A log line the service wrote. */
interface LogLine {
  readonly level: 'info' | 'warn' | 'error';
  readonly details: Record<string, unknown>;
  readonly message: string;
}

function capturingLogger(sink: LogLine[]): SocketLogger {
  return {
    info: (details, message) => sink.push({ level: 'info', details, message }),
    warn: (details, message) => sink.push({ level: 'warn', details, message }),
    error: (details, message) => sink.push({ level: 'error', details, message }),
  };
}

/**
 * A committed message addressed to {@link AGENT}.
 *
 * @param overrides - Fields to change.
 * @returns The message a delivery or a replay would carry.
 */
function message(overrides: Partial<DeliverableMessage> = {}): DeliverableMessage {
  return {
    id: MessageId.generate(),
    projectId: PROJECT,
    conversationId: CONVERSATION,
    parentMessageId: undefined,
    senderAgentId: SENDER,
    recipientAgentId: AGENT,
    content: 'ship it',
    createdAt: new Date('2026-09-08T10:00:00.000Z'),
    ...overrides,
  };
}

/** A socket that records what it was sent, and can fail or close on demand. */
interface FakeSocket extends SocketBinding {
  /** Everything written to it. */
  readonly frames: ServerFrame[];
  /** The envelopes of its `message` frames, in order. */
  readonly envelopes: MessageEnvelope[];
}

/** How a fake socket behaves. */
interface SocketOptions {
  /** Runs on every `send`, before the frame is recorded. Throw to fail. */
  readonly onSend?: (frame: ServerFrame) => void;
}

/**
 * Builds a bound socket for {@link AGENT} in {@link PROJECT}.
 *
 * @param options - How it behaves when written to.
 * @returns The binding, with what it received.
 */
function binding(options: SocketOptions = {}): FakeSocket {
  const frames: ServerFrame[] = [];
  const identity: SocketIdentity = {
    userId: USER,
    sessionId: SessionId.generate(),
    agentId: AGENT,
    projectId: PROJECT,
  };

  const session = {
    id: identity.sessionId,
    agentId: AGENT,
    projectId: PROJECT,
    status: 'active',
  } as unknown as SessionRecord;

  return {
    identity,
    session,
    client: undefined,
    frames,
    get envelopes(): MessageEnvelope[] {
      return frames
        .filter((frame) => frame.type === 'message')
        .map((frame) => frame.message as MessageEnvelope);
    },
    send(frame: ServerFrame): void {
      options.onSend?.(frame);
      frames.push(frame);
    },
    close(): void {
      // The handshake owns closing; nothing here needs it.
    },
  };
}

/** An inbox whose three methods are all controllable. */
interface FakeInbox extends DeliveryInbox {
  /** `(messageId, sessionId)` for every recorded attempt, in call order. */
  readonly recorded: { messageId: string; sessionId: string }[];
  /** Message ids passed to `acknowledge`. */
  readonly acknowledged: string[];
  /** Pages `listPending` will return, in order. */
  readonly pages: { messages: DeliverableMessage[]; nextCursor: MessageId | undefined }[];
  /** The `after` cursor of each `listPending` call. */
  readonly cursors: (MessageId | undefined)[];
}

/** How a fake inbox behaves. */
interface InboxOptions {
  /** Thrown by every `recordDelivery`. */
  readonly recordFails?: Error;
  /** Thrown by every `acknowledge`. */
  readonly ackFails?: Error;
  /** What `acknowledge` reports when it succeeds. */
  readonly alreadyAcknowledged?: boolean;
  /** Runs before each `listPending` resolves, so a test can interleave. */
  readonly beforeListPending?: () => Promise<void> | void;
}

function fakeInbox(options: InboxOptions = {}): FakeInbox {
  const recorded: { messageId: string; sessionId: string }[] = [];
  const acknowledged: string[] = [];
  const pages: { messages: DeliverableMessage[]; nextCursor: MessageId | undefined }[] = [];
  const cursors: (MessageId | undefined)[] = [];

  return {
    recorded,
    acknowledged,
    pages,
    cursors,

    async listPending(request) {
      cursors.push(request.after);
      await options.beforeListPending?.();
      const page = pages.shift() ?? { messages: [], nextCursor: undefined };
      return { messages: page.messages, nextCursor: page.nextCursor };
    },

    async acknowledge(request) {
      acknowledged.push(request.messageId);
      await Promise.resolve();
      if (options.ackFails !== undefined) {
        throw options.ackFails;
      }
      return {
        messageId: request.messageId,
        alreadyAcknowledged: options.alreadyAcknowledged ?? false,
        acknowledgedAt: new Date('2026-09-08T10:00:01.000Z'),
        acknowledgedBySessionId: request.sessionId,
      };
    },

    async recordDelivery(request) {
      if (options.recordFails !== undefined) {
        throw options.recordFails;
      }
      recorded.push({ messageId: request.messageId, sessionId: request.sessionId });
      await Promise.resolve();
    },
  };
}

/** A directory that always knows {@link SENDER}. */
const directory: SenderDirectory = {
  handlesFor: (agentIds) =>
    Promise.resolve(
      new Map(agentIds.filter((id) => id === SENDER).map((id) => [id, SENDER_HANDLE])),
    ),
};

/** A directory that never answers. */
const brokenDirectory: SenderDirectory = {
  handlesFor: () => Promise.reject(new Error('users is unavailable')),
};

/** Everything one test needs, wired the way the application will wire it. */
interface Harness {
  readonly service: DeliveryService;
  readonly registry: SocketRegistry;
  readonly router: Router;
  readonly inbox: FakeInbox;
  readonly logs: LogLine[];
}

/**
 * Builds a delivery service over a real registry and a real router.
 *
 * Real on purpose: the router's per-socket isolation is half of what this
 * module promises, and a fake router would prove the promise against a mock of
 * itself.
 *
 * @param options - How the inbox, the directory and the paging behave.
 * @returns The service and the things to inspect afterwards.
 */
function harness(
  options: InboxOptions & {
    senders?: SenderDirectory;
    replayPageSize?: number;
  } = {},
): Harness {
  const logs: LogLine[] = [];
  const logger = capturingLogger(logs);
  const registry = createSocketRegistry();
  const router = createInProcessRouter({ registry, logger });
  const inbox = fakeInbox(options);

  const service = createDeliveryService({
    router,
    registry,
    inbox,
    senders: options.senders ?? directory,
    logger,
    ...(options.replayPageSize === undefined ? {} : { replayPageSize: options.replayPageSize }),
  });

  return { service, registry, router, inbox, logs };
}

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

describe('fan-out', () => {
  it('reaches every socket for the recipient and records each attempt', async () => {
    const { service, registry, inbox } = harness();
    const first = binding();
    const second = binding();
    registry.register(first);
    registry.register(second);

    const sent = message();
    const report = await service.deliver(sent);

    expect(first.envelopes).toHaveLength(1);
    expect(second.envelopes).toHaveLength(1);
    expect(report.delivered).toStrictEqual([first.identity.sessionId, second.identity.sessionId]);
    expect(report.failed).toStrictEqual([]);
    expect(report.messageId).toBe(sent.id);

    expect(inbox.recorded).toHaveLength(2);
    expect(new Set(inbox.recorded.map((row) => row.sessionId))).toStrictEqual(
      new Set([first.identity.sessionId, second.identity.sessionId]),
    );
    expect(inbox.recorded.every((row) => row.messageId === sent.id)).toBe(true);
  });

  it('addresses the message by its own recipient, not by anything a caller passes', async () => {
    const { service, registry } = harness();
    const mine = binding();
    registry.register(mine);

    // A socket for a different agent in the same project, filed under its own key.
    const other = binding();
    const strangerIdentity = { ...other.identity, agentId: AgentId.generate() };
    registry.register({ ...other, identity: strangerIdentity, send: other.send });

    await service.deliver(message());

    expect(mine.envelopes).toHaveLength(1);
    expect(other.frames).toHaveLength(0);
  });

  it('carries the Plan §4.2 envelope, with the sender handle and an ISO instant', async () => {
    const { service, registry } = harness();
    const socket = binding();
    registry.register(socket);

    const parentMessageId = MessageId.generate();
    const sent = message({ parentMessageId, content: 'with a parent' });
    await service.deliver(sent);

    expect(socket.envelopes[0]).toStrictEqual({
      messageId: sent.id,
      projectId: PROJECT,
      conversationId: CONVERSATION,
      parentMessageId,
      senderAgentId: SENDER,
      sender: SENDER_HANDLE,
      recipientAgentId: AGENT,
      content: 'with a parent',
      createdAt: '2026-09-08T10:00:00.000Z',
    });
  });

  it('omits parentMessageId from the JSON of a thread root rather than sending null', async () => {
    const { service, registry } = harness();
    const socket = binding();
    registry.register(socket);

    await service.deliver(message());

    const encoded = JSON.parse(JSON.stringify(socket.frames[0])) as {
      message: Record<string, unknown>;
    };
    expect('parentMessageId' in encoded.message).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

describe('a failure is one socket’s own', () => {
  it('delivers to the survivors when the first socket throws', async () => {
    const { service, registry, inbox } = harness();
    const broken = binding({
      onSend: () => {
        throw new Error('EPIPE');
      },
    });
    const good = binding();
    const alsoGood = binding();

    registry.register(broken);
    registry.register(good);
    registry.register(alsoGood);

    const report = await service.deliver(message());

    expect(good.envelopes).toHaveLength(1);
    expect(alsoGood.envelopes).toHaveLength(1);
    expect(report.failed).toStrictEqual([broken.identity.sessionId]);
    expect(report.delivered).toStrictEqual([good.identity.sessionId, alsoGood.identity.sessionId]);

    // The thrower is gone; the two that took the frame are still registered.
    expect(registry.size).toBe(2);

    // And bookkeeping happened only for the sockets that actually took it.
    expect(inbox.recorded.map((row) => row.sessionId)).toStrictEqual([
      good.identity.sessionId,
      alsoGood.identity.sessionId,
    ]);
  });

  it('still delivers when every recording fails', async () => {
    const { service, registry, logs } = harness({ recordFails: new Error('deliveries is full') });
    const socket = binding();
    registry.register(socket);

    const report = await service.deliver(message());

    expect(socket.envelopes).toHaveLength(1);
    expect(report.delivered).toStrictEqual([socket.identity.sessionId]);
    expect(logs.some((line) => line.message === 'recording a delivery failed')).toBe(true);
  });

  it('still delivers when the sender handle cannot be resolved', async () => {
    const { service, registry, logs } = harness({ senders: brokenDirectory });
    const socket = binding();
    registry.register(socket);

    await service.deliver(message());

    expect(socket.envelopes[0]?.sender).toBeUndefined();
    expect(socket.envelopes[0]?.content).toBe('ship it');
    expect(logs.some((line) => line.message === 'sender handle lookup failed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Delivery to nobody
// ---------------------------------------------------------------------------

describe('nobody listening', () => {
  it('is an outcome, not a failure: nothing recorded, nothing thrown', async () => {
    const { service, inbox, logs } = harness();

    const report = await service.deliver(message());

    expect(report.delivered).toStrictEqual([]);
    expect(report.failed).toStrictEqual([]);
    expect(inbox.recorded).toStrictEqual([]);

    const line = logs.find((entry) => entry.message.startsWith('message delivered to no live'));
    expect(line?.level).toBe('info');
  });
});

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

describe('replay on handshake', () => {
  it('replays every page in order and returns the count for the ready frame', async () => {
    const { service, inbox } = harness({ replayPageSize: 1 });
    const socket = binding();

    const one = message({ content: 'first' });
    const two = message({ content: 'second' });
    const three = message({ content: 'third' });
    inbox.pages.push(
      { messages: [one], nextCursor: one.id },
      { messages: [two], nextCursor: two.id },
      { messages: [three], nextCursor: undefined },
    );

    const replayed = await service.bound(socket);

    expect(replayed).toBe(3);
    expect(socket.envelopes.map((envelope) => envelope.content)).toStrictEqual([
      'first',
      'second',
      'third',
    ]);

    // The cursor of each page is the `after` of the next request.
    expect(inbox.cursors).toStrictEqual([undefined, one.id, two.id]);

    // Every replayed message is recorded against the session that took it.
    expect(inbox.recorded.map((row) => row.messageId)).toStrictEqual([one.id, two.id, three.id]);
    expect(new Set(inbox.recorded.map((row) => row.sessionId))).toStrictEqual(
      new Set([socket.identity.sessionId]),
    );
  });

  it('replays nothing and reports zero for an agent with an empty queue', async () => {
    const { service, inbox } = harness();
    const socket = binding();

    expect(await service.bound(socket)).toBe(0);
    expect(socket.frames).toStrictEqual([]);
    expect(inbox.recorded).toStrictEqual([]);
  });

  it('reads pages of the inbox default when nothing overrides it', async () => {
    const { service, inbox } = harness();
    const listPending = vi.spyOn(inbox, 'listPending');
    await service.bound(binding());

    expect(listPending.mock.calls[0]?.[0]?.limit).toBe(REPLAY_PAGE_SIZE);
  });

  it('registers the socket before it reads, so a concurrent send is not missed', async () => {
    // The interleaving that decides the order in Plan §4.3. The delivery runs
    // while the replay's first page is still being read: with registration
    // first it reaches the socket, and with registration last it would reach
    // nobody and not be in the page either.
    let deliverDuringRead: Promise<unknown> | undefined;
    const concurrent = message({ content: 'sent mid-handshake' });

    const built = harness({
      beforeListPending: () => {
        deliverDuringRead ??= built.service.deliver(concurrent);
      },
    });

    const socket = binding();
    await built.service.bound(socket);
    await deliverDuringRead;

    expect(socket.envelopes.map((envelope) => envelope.content)).toStrictEqual([
      'sent mid-handshake',
    ]);
  });

  it('stops paging when the socket goes away mid-replay', async () => {
    // `disconnected` is not chained onto the frame queue, so a close can land
    // while a hello is still paging. Reading the rest of a backlog for a peer
    // that has left is a round trip per page spent on nobody.
    const socket = binding();
    const built: Harness = harness({
      beforeListPending: async () => {
        if (built.inbox.cursors.length === 2) {
          await built.service.closed(socket);
        }
      },
      replayPageSize: 1,
    });

    const one = message({ content: 'first' });
    const two = message({ content: 'second' });
    const three = message({ content: 'third' });
    built.inbox.pages.push(
      { messages: [one], nextCursor: one.id },
      { messages: [two], nextCursor: two.id },
      { messages: [three], nextCursor: undefined },
    );

    const replayed = await built.service.bound(socket);

    // Two pages were read; the third was never asked for.
    expect(built.inbox.cursors).toHaveLength(2);
    expect(replayed).toBe(2);
    expect(built.inbox.pages).toHaveLength(1);
  });

  it('drops a socket whose replay cannot be written, without failing the handshake', async () => {
    // A throwing `send` here means the peer left mid-handshake. Letting it out
    // of `bound` would close the socket with an *internal error*: the server
    // blaming itself for a listener that quit. The router already calls this an
    // outcome, and replay agrees with it.
    let written = 0;
    const socket = binding({
      onSend: () => {
        written += 1;
        if (written === 2) {
          throw new Error('EPIPE');
        }
      },
    });

    const { service, registry, inbox, logs } = harness({ replayPageSize: 3 });
    const one = message();
    const two = message();
    const three = message();
    inbox.pages.push(
      { messages: [one, two, three], nextCursor: three.id },
      { messages: [message()], nextCursor: undefined },
    );

    const replayed = await service.bound(socket);

    // Only the frame that was actually written counts, the socket is gone, and
    // the page after it was never asked for.
    expect(replayed).toBe(1);
    expect(registry.size).toBe(0);
    expect(inbox.cursors).toHaveLength(1);
    expect(inbox.recorded.map((row) => row.messageId)).toStrictEqual([one.id]);
    expect(logs.some((line) => line.message === 'websocket replay failed; dropping socket')).toBe(
      true,
    );
  });

  it('leaves the socket registered so a send during the handshake fans out to it', async () => {
    const { service, registry } = harness();
    const socket = binding();

    await service.bound(socket);

    expect(registry.size).toBe(1);
    expect(registry.socketsFor({ agentId: AGENT, projectId: PROJECT })).toStrictEqual([socket]);
  });
});

// ---------------------------------------------------------------------------
// Acknowledgement
// ---------------------------------------------------------------------------

describe('acknowledgement', () => {
  it('clears the message for the agent, naming the session it arrived on', async () => {
    const { service, inbox } = harness();
    const socket = binding();
    const acknowledge = vi.spyOn(inbox, 'acknowledge');
    const id = MessageId.generate();

    await service.acked(socket, id);

    expect(acknowledge).toHaveBeenCalledWith({
      userId: USER,
      agentId: AGENT,
      projectId: PROJECT,
      messageId: id,
      sessionId: socket.identity.sessionId,
    });
  });

  it('treats a repeat as the success it is', async () => {
    const { service, logs } = harness({ alreadyAcknowledged: true });
    const socket = binding();

    await expect(service.acked(socket, MessageId.generate())).resolves.toBeUndefined();
    expect(logs.some((line) => line.message.includes('already cleared'))).toBe(true);
  });

  it('ignores an acknowledgement for a message the agent does not owe', async () => {
    // The socket must survive it: a client that replays its own unsent
    // acknowledgements after a restart is at-least-once working, not an error.
    const { service, logs } = harness({
      ackFails: new ProtocolError(ErrorCode.NOT_FOUND, 'No such message.'),
    });

    await expect(service.acked(binding(), MessageId.generate())).resolves.toBeUndefined();
    expect(logs.some((line) => line.message.includes('does not owe'))).toBe(true);
  });

  it('rethrows anything that is not a missing row', async () => {
    const deleted = new ProtocolError(ErrorCode.AGENT_DELETED, 'That agent was deleted.');
    const { service } = harness({ ackFails: deleted });

    await expect(service.acked(binding(), MessageId.generate())).rejects.toBe(deleted);
  });
});

// ---------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------

describe('close', () => {
  it('deregisters the socket', async () => {
    const { service, registry } = harness();
    const socket = binding();

    await service.bound(socket);
    expect(registry.size).toBe(1);

    await service.closed(socket);
    expect(registry.size).toBe(0);
    expect(registry.routeCount).toBe(0);
  });

  it('is safe twice, and does not disturb a socket that rebound on the same key', async () => {
    const { service, registry } = harness();
    const first = binding();
    await service.bound(first);
    await service.closed(first);

    const second = binding();
    await service.bound(second);

    await service.closed(first);

    expect(registry.socketsFor({ agentId: AGENT, projectId: PROJECT })).toStrictEqual([second]);
  });

  it('does nothing for a socket this service never bound', async () => {
    const { service, registry } = harness();
    const stranger = binding();
    registry.register(stranger);

    await expect(service.closed(stranger)).resolves.toBeUndefined();
    expect(registry.size).toBe(1);
  });

  it('does not stop a later replay on a different socket', async () => {
    const { service, inbox } = harness();
    const first = binding();
    await service.bound(first);
    await service.closed(first);

    const second = binding();
    inbox.pages.push({ messages: [message()], nextCursor: undefined });

    expect(await service.bound(second)).toBe(1);
    expect(second.envelopes).toHaveLength(1);
  });
});
