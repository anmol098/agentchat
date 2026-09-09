/**
 * T-053, from both halves at once: a replay big enough to cross the socket
 * ceiling still reaches `ready`.
 *
 * ## Why this test is not in either of the two files it covers
 *
 * The defect lived between two modules that were each correct on their own.
 * `../websocket/handler.ts` bounds what an unread socket may hold;
 * `./delivery.ts` bounds what a replay reads at a time. Neither bound implies
 * the other, and the failure was exactly the gap between them: a page is a
 * hundred rows and D10 allows a megabyte each, so a replay could write 100 MiB
 * at a 16 MiB ceiling. So the real handshake and the real delivery service are
 * wired together here, over a real registry and a real router, with only the
 * inbox and the transport faked.
 *
 * ## The buffer is counted, not allocated
 *
 * The socket below adds {@link MAX_MESSAGE_CONTENT_BYTES} to its
 * `bufferedAmount` per frame instead of carrying seventeen megabytes of JSON.
 * What is under test is how the two modules react to the figure a transport
 * reports — the arithmetic between a page, a frame and a ceiling — and building
 * the bytes to move a counter would buy the suite nothing but seconds. The real
 * reproduction with real megabytes is T-509's
 * `tests/chaos/limits.integration.test.ts`.
 *
 * ## The control matters as much as the fix
 *
 * `drain` is optional on {@link SocketBinding}, so the same scenario can be run
 * against a binding that does not have one. That is the defect, reproduced: the
 * replay outruns the socket, the ceiling closes it partway through, and `ready`
 * never arrives. Without that case a passing test would prove only that the
 * numbers in this file are small.
 */

import {
  AgentId,
  ConversationId,
  MAX_MESSAGE_CONTENT_BYTES,
  MachineId,
  MessageId,
  ProjectId,
  SessionId,
  UserId,
} from '@agentchat/protocol';
import { describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_TTL_SECONDS, MIN_JWT_SECRET_LENGTH } from '../auth/tokens.js';
import type { AuthenticatedUser } from '../plugins/auth.js';
import {
  type ListSessionsRequest,
  SESSION_STATUS,
  type SessionRecord,
} from '../services/sessions.js';
import { CloseCode, type ServerFrame } from '../websocket/frames.js';
import {
  createWebSocketHandler,
  type FrameSocket,
  MAX_BUFFERED_BYTES,
  type SessionLookup,
  type SocketBinding,
  type SocketLogger,
  STALLED_REPLAY_CLOSE_REASON,
} from '../websocket/handler.js';
import { createSocketRegistry } from '../websocket/registry.js';
import {
  createDeliveryService,
  type DeliverableMessage,
  type DeliveryInbox,
  type SenderDirectory,
} from './delivery.js';
import { createInProcessRouter } from './router.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECRET = 'a'.repeat(MIN_JWT_SECRET_LENGTH);
const NOW = new Date('2026-09-09T12:00:00.000Z');

const USER = UserId.generate();
const AGENT = AgentId.generate();
const SENDER = AgentId.generate();
const PROJECT = ProjectId.generate();
const CONVERSATION = ConversationId.generate();
const SESSION = SessionId.generate();

/**
 * The reproduction from the task, exactly: seventeen messages of a megabyte.
 *
 * Sixteen fit under {@link MAX_BUFFERED_BYTES} and the seventeenth does not,
 * which is the smallest backlog that used to be unreplayable.
 */
const BACKLOG = 17;

/** A log line one of the two modules wrote. */
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

function authenticated(): AuthenticatedUser {
  return {
    id: USER,
    issuedAt: NOW,
    expiresAt: new Date(NOW.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1_000),
  };
}

/** A lookup that owns exactly {@link SESSION}, active. */
function lookup(): SessionLookup {
  const session: SessionRecord = {
    id: SESSION,
    agentId: AGENT,
    projectId: PROJECT,
    machineId: MachineId.generate(),
    machineName: 'workstation',
    runtime: 'claude-code',
    workingDirectory: '/srv/app',
    startedAt: NOW,
    lastSeenAt: NOW,
    endedAt: null,
    status: SESSION_STATUS.ACTIVE,
  };

  return {
    list: (request: ListSessionsRequest): Promise<SessionRecord[]> =>
      Promise.resolve(request.userId === USER ? [session] : []),
    heartbeat: (): Promise<SessionRecord> => Promise.resolve(session),
  };
}

/** A message owed to {@link AGENT}. Its content is short; see the module note. */
function message(): DeliverableMessage {
  return {
    id: MessageId.generate(),
    projectId: PROJECT,
    conversationId: CONVERSATION,
    parentMessageId: undefined,
    senderAgentId: SENDER,
    recipientAgentId: AGENT,
    content: 'a patch',
    createdAt: NOW,
  };
}

/** A directory that always knows the sender. */
const directory: SenderDirectory = {
  handlesFor: (agentIds) =>
    Promise.resolve(new Map(agentIds.map((id) => [id, '@alice/backend'] as const))),
};

/**
 * An inbox holding one page of pending messages.
 *
 * One page on purpose: the defect is *inside* a page, so a fix that only waited
 * between pages would pass a multi-page test and fail this one.
 *
 * @param owed - The messages the agent is owed, oldest first.
 * @returns The inbox, and the ids it will hand out.
 */
function pendingInbox(owed: readonly DeliverableMessage[]): DeliveryInbox {
  let served = false;

  return {
    listPending: () => {
      const page = served ? [] : [...owed];
      served = true;
      return Promise.resolve({ messages: page, nextCursor: undefined });
    },
    acknowledge: () => Promise.reject(new Error('nothing is acknowledged in this test')),
    recordDelivery: () => Promise.resolve(),
  };
}

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

/** A socket that models a peer reading at a bounded rate. */
interface PeerSocket extends FrameSocket {
  /** The frames it was written, decoded. */
  readonly frames: ServerFrame[];
  /** Closes it recorded, in order. */
  readonly closes: { code: number; reason: string }[];
  /** The largest `bufferedAmount` it ever reported. */
  readonly peakBuffered: number;
  /** Stops the reader's timer, whatever state it is in. */
  dispose(): void;
}

interface PeerOptions {
  /** Bytes each frame adds to the buffer. Defaults to D10's maximum message. */
  readonly bytesPerFrame?: number;

  /** Bytes the peer reads per tick. Defaults to two frames. */
  readonly bytesPerTick?: number;

  /** How often the peer reads. Defaults to a millisecond. */
  readonly tickMs?: number;
}

/**
 * A transport whose peer reads on a timer.
 *
 * The reading is a real timer rather than a hook on `send`, because the thing
 * being tested is precisely the relationship between two independent speeds:
 * how fast the replay writes, and how fast the peer drains. A peer that drained
 * inside `send` would make every writer look correct.
 *
 * @param options - The frame size, and how fast the peer reads.
 * @returns The socket, and the controls a test needs.
 */
function peerSocket(options: PeerOptions = {}): PeerSocket {
  const bytesPerFrame = options.bytesPerFrame ?? MAX_MESSAGE_CONTENT_BYTES;
  const bytesPerTick = options.bytesPerTick ?? 2 * MAX_MESSAGE_CONTENT_BYTES;
  const frames: ServerFrame[] = [];
  const closes: { code: number; reason: string }[] = [];

  let buffered = 0;
  let peak = 0;

  const timer = setInterval(() => {
    buffered = Math.max(0, buffered - bytesPerTick);
  }, options.tickMs ?? 1);

  return {
    frames,
    closes,
    get peakBuffered(): number {
      return peak;
    },
    get bufferedAmount(): number {
      return buffered;
    },
    send(data: string): void {
      frames.push(JSON.parse(data) as ServerFrame);
      buffered += bytesPerFrame;
      peak = Math.max(peak, buffered);
    },
    close(code: number, reason: string): void {
      closes.push({ code, reason });
    },
    dispose(): void {
      clearInterval(timer);
    },
  };
}

// ---------------------------------------------------------------------------
// The wiring
// ---------------------------------------------------------------------------

interface ScenarioOptions {
  /** How the peer behaves. */
  readonly peer?: PeerOptions;

  /** Strips `drain` from the binding, reproducing the state before T-053. */
  readonly withoutBackPressure?: boolean;

  /** Overrides for the handler's back-pressure numbers. */
  readonly stallTimeoutMs?: number;
}

/**
 * The real handshake, the real delivery service, and a peer.
 *
 * @param owed - What the agent is owed when it says `hello`.
 * @param options - How the peer behaves and whether the binding has a drain.
 * @returns The socket and the log, once the handshake has run to completion.
 */
async function handshake(owed: readonly DeliverableMessage[], options: ScenarioOptions = {}) {
  const logs: LogLine[] = [];
  const logger = capturingLogger(logs);
  const registry = createSocketRegistry();
  const router = createInProcessRouter({ registry, logger });

  const delivery = createDeliveryService({
    router,
    registry,
    inbox: pendingInbox(owed),
    senders: directory,
    logger,
  });

  const handler = createWebSocketHandler({
    jwtSecret: SECRET,
    sessions: lookup(),
    logger,
    now: () => NOW,
    backPressure: {
      // A millisecond, so a paused replay resumes at the peer's pace rather
      // than at the production interval's.
      pollIntervalMs: 1,
      ...(options.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: options.stallTimeoutMs }),
    },
    observer: {
      bound: (binding) =>
        delivery.bound(options.withoutBackPressure === true ? withoutDrain(binding) : binding),
      closed: (binding) => delivery.closed(binding),
    },
  });

  const socket = peerSocket(options.peer);
  const connection = handler.connect(socket, authenticated());

  try {
    await connection.receive(JSON.stringify({ type: 'hello', sessionId: SESSION }));
  } finally {
    socket.dispose();
  }

  return { socket, logs };
}

/**
 * The same binding with no `drain`, which is what delivery saw before T-053.
 *
 * Not a mock of the defect: `drain` is optional on {@link SocketBinding}, and a
 * caller that finds it missing genuinely has no back-pressure. This is that
 * documented case, exercised.
 *
 * @param binding - The real binding from the handshake.
 * @returns It, without its drain.
 */
function withoutDrain(binding: SocketBinding): SocketBinding {
  return {
    identity: binding.identity,
    session: binding.session,
    client: binding.client,
    send: (frame) => {
      binding.send(frame);
    },
    close: (reason) => {
      binding.close(reason);
    },
    get bufferedBytes(): number | undefined {
      return binding.bufferedBytes;
    },
  };
}

/** The `ready` frame a socket was sent, if it ever got one. */
function readyFrame(socket: PeerSocket): ServerFrame | undefined {
  return socket.frames.find((frame) => frame.type === 'ready');
}

/** How many `message` frames a socket was sent. */
function delivered(socket: PeerSocket): number {
  return socket.frames.filter((frame) => frame.type === 'message').length;
}

// ---------------------------------------------------------------------------
// The defect
// ---------------------------------------------------------------------------

describe('a backlog larger than the socket ceiling', () => {
  const owed = Array.from({ length: BACKLOG }, () => message());

  it('is replayed in full and the handshake reaches ready', async () => {
    const { socket } = await handshake(owed);

    // The whole claim of T-053. `ready` means "you are caught up" (§9.2), and
    // it is the frame a listener with this backlog never used to see.
    expect(readyFrame(socket)).toEqual({ type: 'ready', sessionId: SESSION, pending: BACKLOG });
    expect(delivered(socket)).toBe(BACKLOG);
    expect(socket.closes).toEqual([]);
  });

  it('never approaches the ceiling, however far past it the backlog is', async () => {
    // Seventeen megabytes went through a socket that is never allowed to hold
    // four, which is the property that makes the size of the backlog irrelevant:
    // the bound is on the writer, not on the total.
    const { socket } = await handshake(owed);

    expect(socket.peakBuffered).toBeLessThanOrEqual(MAX_BUFFERED_BYTES);
    expect(socket.peakBuffered).toBeLessThan(BACKLOG * MAX_MESSAGE_CONTENT_BYTES);
  });

  it('holds for a backlog far larger still, at the same peak', async () => {
    // Ten times the ceiling. If the fix were a threshold rather than a wait,
    // this is the test that would find the new threshold.
    const huge = Array.from({ length: 160 }, () => message());
    const { socket } = await handshake(huge);

    expect(readyFrame(socket)).toEqual({ type: 'ready', sessionId: SESSION, pending: 160 });
    expect(socket.peakBuffered).toBeLessThanOrEqual(MAX_BUFFERED_BYTES);
  });

  it('was closed before ready when the replay had no back-pressure to wait on', async () => {
    // The defect itself, so that the tests above are known to be testing
    // something. A replay that writes as fast as its loop runs fills the buffer
    // faster than any peer drains it, and the ceiling closes the socket in the
    // middle of the first page — before `ready`, which is what made the state
    // permanent: nothing was acknowledged, so the next attempt was identical.
    const { socket } = await handshake(owed, { withoutBackPressure: true });

    expect(socket.closes).toEqual([
      { code: CloseCode.BACKLOG_UNREAD, reason: expect.stringContaining('backlog') },
    ]);
    expect(readyFrame(socket)).toBeUndefined();

    // The seventeenth frame is the one that trips the bound, and it is written
    // before the buffer is measured — so the close follows a full page here.
    // The page after it is where the frames start disappearing.
    const { socket: larger } = await handshake(
      Array.from({ length: 160 }, () => message()),
      { withoutBackPressure: true },
    );
    expect(readyFrame(larger)).toBeUndefined();
    expect(delivered(larger)).toBeLessThan(160);
  });
});

// ---------------------------------------------------------------------------
// The other half of T-032, which has to keep working
// ---------------------------------------------------------------------------

describe('a peer that stops reading during its own replay', () => {
  const owed = Array.from({ length: BACKLOG }, () => message());

  it('is closed rather than waited on forever', async () => {
    const { socket, logs } = await handshake(owed, {
      // Reads nothing, ever. The one case waiting must not turn into a hang.
      peer: { bytesPerTick: 0 },
      stallTimeoutMs: 5,
    });

    expect(socket.closes).toEqual([
      { code: CloseCode.BACKLOG_UNREAD, reason: STALLED_REPLAY_CLOSE_REASON },
    ]);
    expect(readyFrame(socket)).toBeUndefined();

    // Legible as its own event: an operator sees a replay abandoned, not a
    // fan-out that outran somebody, even though the client sees one code.
    expect(
      logs.some(
        (line) =>
          line.level === 'warn' &&
          line.message ===
            'websocket peer stopped reading during replay; closing it rather than waiting forever',
      ),
    ).toBe(true);
  });

  it('stops the replay rather than reading pages for a socket that is gone', async () => {
    const { socket, logs } = await handshake(owed, {
      peer: { bytesPerTick: 0 },
      stallTimeoutMs: 5,
    });

    // Every message is still owed — none was acknowledged — so the next `hello`
    // replays the lot. What must not happen is the loop writing on past a close.
    expect(delivered(socket)).toBeLessThan(BACKLOG);
    expect(
      logs.some(
        (line) =>
          line.message === 'websocket closed while its replay waited for it to be read; stopping',
      ),
    ).toBe(true);
  });

  it('waits as long as a slow peer needs, as long as it is still reading', async () => {
    // The distinction the ceiling has always drawn: slow is fine, stopped is
    // not. A peer reading an eighth of a frame per tick takes many times the
    // stall deadline to finish and is never closed, because it never stops.
    const { socket } = await handshake(owed, {
      peer: { bytesPerTick: MAX_MESSAGE_CONTENT_BYTES / 8 },
      stallTimeoutMs: 50,
    });

    expect(socket.closes).toEqual([]);
    expect(readyFrame(socket)).toEqual({ type: 'ready', sessionId: SESSION, pending: BACKLOG });
  });
});
