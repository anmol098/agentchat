/**
 * The socket handshake, every way it can be refused, and the one way it must
 * not be.
 *
 * No transport, no port, no server. The handler talks to a two-method socket
 * interface and is driven by `receive`, so each of these cases is a function
 * call and a pair of assertions about what the client was sent. That is the
 * point of keeping the WebSocket library out of this module: a rejection path
 * that needs a running server usually gets one test, and there are eight of
 * them here.
 *
 * Three groups carry most of the weight:
 *
 * - **`forward compatibility`** — a frame type from a newer client is ignored
 *   and the socket survives it, including before the handshake. Plan §12.4.
 * - **`the session comes from the frame`** — a token carrying a `sid` claim
 *   binds nothing on its own, and a *stale* `sid` does not stop a correct
 *   `hello`. T-302's finding, asserted rather than commented.
 * - **`refusals`** — a session that does not exist, one belonging to somebody
 *   else, and one that has ended are byte-identical on the wire.
 * - **`the outbound bound`** — a peer that has stopped reading is closed before
 *   its backlog can exhaust the process, a peer that is reading is not, the
 *   close carries a code of its own (T-048), and the message that tripped the
 *   bound is still owed afterwards and replayed to the next connection.
 */

import {
  AgentId,
  ErrorCode,
  MachineId,
  MessageId,
  ProjectId,
  SessionId,
  UserId,
} from '@agentchat/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  MIN_JWT_SECRET_LENGTH,
  signAccessToken,
} from '../auth/tokens.js';
import type { AuthenticatedUser } from '../plugins/auth.js';
import { BUFFER_WARNING_BYTES } from '../routing/router.js';
import {
  type ListSessionsRequest,
  SESSION_STATUS,
  type SessionRecord,
  type SessionStatus,
} from '../services/sessions.js';
import { CloseCode, MAX_CLOSE_REASON_BYTES, MAX_FRAME_BYTES, type ServerFrame } from './frames.js';
import {
  ACCESS_TOKEN_QUERY_PARAMETER,
  authenticateUpgrade,
  type ConnectionObserver,
  createWebSocketHandler,
  type FrameSocket,
  MAX_BUFFERED_BYTES,
  REDACTED_TOKEN,
  redactUpgradeUrl,
  type SessionLookup,
  type SocketBinding,
  type SocketLogger,
  UNREAD_CLOSE_REASON,
  type UpgradeAccepted,
  type WebSocketHandler,
} from './handler.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The signing key under test. Long enough to be accepted; otherwise arbitrary. */
const SECRET = 'a'.repeat(MIN_JWT_SECRET_LENGTH);

/** A second valid key nothing under test signs with. */
const OTHER_SECRET = 'b'.repeat(MIN_JWT_SECRET_LENGTH);

/** Fixed clock, so an expiry is a decision rather than a race. */
const NOW = new Date('2026-09-08T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);

const USER = UserId.generate();
const AGENT = AgentId.generate();
const PROJECT = ProjectId.generate();
const SESSION = SessionId.generate();
const STALE_SESSION = SessionId.generate();
const ENDED_SESSION = SessionId.generate();
const STRANGER_SESSION = SessionId.generate();
const MESSAGE = MessageId.generate();

/** A signed access token for `USER`, valid at `NOW`. */
function accessToken(
  overrides: { readonly sub?: UserId; readonly sid?: SessionId; readonly exp?: number } = {},
): string {
  const sub = overrides.sub ?? USER;
  const claims =
    overrides.sid === undefined
      ? { sub, iat: NOW_SECONDS, exp: overrides.exp ?? NOW_SECONDS + ACCESS_TOKEN_TTL_SECONDS }
      : {
          sub,
          sid: overrides.sid,
          iat: NOW_SECONDS,
          exp: overrides.exp ?? NOW_SECONDS + ACCESS_TOKEN_TTL_SECONDS,
        };

  return signAccessToken(claims, SECRET);
}

/** Builds a session record owned by `USER`. */
function sessionRecord(id: SessionId, status: SessionStatus): SessionRecord {
  return {
    id,
    agentId: AGENT,
    projectId: PROJECT,
    machineId: MachineId.generate(),
    machineName: 'workstation',
    runtime: 'claude-code',
    workingDirectory: '/srv/app',
    startedAt: NOW,
    lastSeenAt: NOW,
    endedAt: status === SESSION_STATUS.ENDED ? NOW : null,
    status,
  };
}

/** The sessions `USER` owns in every test below. */
const OWNED: readonly SessionRecord[] = [
  sessionRecord(SESSION, SESSION_STATUS.ACTIVE),
  sessionRecord(STALE_SESSION, SESSION_STATUS.STALE),
  sessionRecord(ENDED_SESSION, SESSION_STATUS.ENDED),
];

/**
 * A lookup that answers with the caller's own sessions and nothing else.
 *
 * `STRANGER_SESSION` stands for a real session belonging to somebody else, and
 * is modelled the way the real query behaves: absent from `USER`'s result,
 * because the ownership scope is in the SQL rather than in a comparison
 * afterwards. Nothing here can accidentally pass an ownership check that the
 * production query would have failed, because there is no check to pass.
 */
function lookup(): SessionLookup {
  return {
    list: (request: ListSessionsRequest): Promise<SessionRecord[]> =>
      Promise.resolve(request.userId === USER ? [...OWNED] : []),
  };
}

/** A socket that records what it was sent instead of writing to a peer. */
interface RecordingSocket extends FrameSocket {
  readonly frames: ServerFrame[];
  readonly closes: { code: number; reason: string }[];
}

function recordingSocket(): RecordingSocket {
  const frames: ServerFrame[] = [];
  const closes: { code: number; reason: string }[] = [];

  return {
    frames,
    closes,
    send(data: string): void {
      frames.push(JSON.parse(data) as ServerFrame);
    },
    close(code: number, reason: string): void {
      closes.push({ code, reason });
    },
  };
}

/**
 * A socket that models a transport buffer as well as recording frames.
 *
 * `bufferedAmount` grows by {@link BufferingSocketOptions.bytesPerFrame} on
 * every write and returns to zero when the peer reads — which is what `drain`
 * means here. The bytes are counted rather than allocated: what is under test is
 * how the handler reacts to the figure the transport reports, and building
 * sixteen megabytes of JSON to move a counter would buy the suite nothing but
 * seconds.
 */
interface BufferingSocket extends RecordingSocket {
  /** Bytes written that the peer has not read. */
  readonly bufferedAmount: number;

  /** The peer read everything. */
  drain(): void;
}

interface BufferingSocketOptions {
  /** What each write adds to the buffer. Defaults to one maximum-size frame. */
  readonly bytesPerFrame?: number;
}

function bufferingSocket(options: BufferingSocketOptions = {}): BufferingSocket {
  const bytesPerFrame = options.bytesPerFrame ?? MAX_FRAME_BYTES;
  const base = recordingSocket();
  let buffered = 0;

  return {
    ...base,
    send(data: string): void {
      base.send(data);
      buffered += bytesPerFrame;
    },
    get bufferedAmount(): number {
      return buffered;
    },
    drain(): void {
      buffered = 0;
    },
  };
}

/** Log lines captured from the handler under test. */
type LogLine = {
  level: 'info' | 'warn' | 'error';
  details: Record<string, unknown>;
  message: string;
};

function capturingLogger(sink: LogLine[]): SocketLogger {
  return {
    info: (details, message) => sink.push({ level: 'info', details, message }),
    warn: (details, message) => sink.push({ level: 'warn', details, message }),
    error: (details, message) => sink.push({ level: 'error', details, message }),
  };
}

/** The caller a valid token yields. */
function authenticated(): AuthenticatedUser {
  return {
    id: USER,
    issuedAt: NOW,
    expiresAt: new Date(NOW.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1_000),
  };
}

/** Everything one test needs, wired together. */
interface Harness {
  readonly handler: WebSocketHandler;
  readonly socket: RecordingSocket;
  readonly logs: LogLine[];
  readonly observer: ConnectionObserver;
  readonly bound: SocketBinding[];
}

let logs: LogLine[];

beforeEach(() => {
  logs = [];
});

function harness(
  overrides: { readonly observer?: ConnectionObserver; readonly sessions?: SessionLookup } = {},
): Harness {
  const bound: SocketBinding[] = [];
  const observer: ConnectionObserver = overrides.observer ?? {
    bound: (binding) => {
      bound.push(binding);
      return 0;
    },
  };

  const handler = createWebSocketHandler({
    jwtSecret: SECRET,
    sessions: overrides.sessions ?? lookup(),
    logger: capturingLogger(logs),
    observer,
    now: () => NOW,
  });

  return { handler, socket: recordingSocket(), logs, observer, bound };
}

/** Connects a socket for `USER` and returns the connection plus its socket. */
function connect(overrides: Parameters<typeof harness>[0] = {}) {
  const built = harness(overrides);
  const connection = built.handler.connect(built.socket, authenticated());
  return { ...built, connection };
}

/** Sends a value as one JSON frame. */
async function send(
  connection: { receive: (raw: string) => Promise<void> },
  value: unknown,
): Promise<void> {
  await connection.receive(JSON.stringify(value));
}

/** The last close a socket recorded. */
function lastClose(socket: RecordingSocket): { code: number; reason: string } {
  const close = socket.closes.at(-1);
  expect(close).toBeDefined();
  return close as { code: number; reason: string };
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe('authenticating an upgrade', () => {
  const options = { jwtSecret: SECRET, now: () => NOW };

  it('accepts a bearer header', () => {
    const decision = authenticateUpgrade(
      { headers: { authorization: `Bearer ${accessToken()}` }, url: '/ws' },
      options,
    );

    expect(decision.outcome).toBe('accepted');
    const accepted = decision as UpgradeAccepted;
    expect(accepted.user.id).toBe(USER);
    expect(accepted.credentialSource).toBe('header');
  });

  it('accepts the scheme case-insensitively, as RFC 7235 requires', () => {
    const decision = authenticateUpgrade(
      { headers: { authorization: `bearer ${accessToken()}` }, url: '/ws' },
      options,
    );

    expect(decision.outcome).toBe('accepted');
  });

  it('falls back to a query parameter for a client that cannot set headers', () => {
    const decision = authenticateUpgrade(
      { headers: {}, url: `/ws?${ACCESS_TOKEN_QUERY_PARAMETER}=${accessToken()}` },
      options,
    );

    expect(decision.outcome).toBe('accepted');
    expect((decision as UpgradeAccepted).credentialSource).toBe('query');
  });

  it('prefers the header, and does not fall back when one is present but unusable', () => {
    // Falling through would mean a client with a broken header and a token in
    // its URL connects anyway, and nobody ever finds out the header was wrong.
    const decision = authenticateUpgrade(
      {
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
        url: `/ws?${ACCESS_TOKEN_QUERY_PARAMETER}=${accessToken()}`,
      },
      options,
    );

    expect(decision.outcome).toBe('refused');
  });

  it('ignores a repeated authorization header rather than picking one', () => {
    const decision = authenticateUpgrade(
      { headers: { authorization: [`Bearer ${accessToken()}`, 'Bearer other'] }, url: '/ws' },
      options,
    );

    expect(decision.outcome).toBe('refused');
  });

  it('refuses an upgrade with no credential at all', () => {
    expect(authenticateUpgrade({ headers: {}, url: '/ws' }, options).outcome).toBe('refused');
  });

  it('refuses an empty query parameter', () => {
    expect(
      authenticateUpgrade({ headers: {}, url: `/ws?${ACCESS_TOKEN_QUERY_PARAMETER}=` }, options)
        .outcome,
    ).toBe('refused');
  });

  it('refuses an expired token', () => {
    const decision = authenticateUpgrade(
      {
        headers: { authorization: `Bearer ${accessToken({ exp: NOW_SECONDS - 3_600 })}` },
        url: '/ws',
      },
      options,
    );

    expect(decision.outcome).toBe('refused');
  });

  it('refuses a token signed with another key', () => {
    const forged = signAccessToken(
      { sub: USER, iat: NOW_SECONDS, exp: NOW_SECONDS + 60 },
      OTHER_SECRET,
    );

    expect(
      authenticateUpgrade({ headers: { authorization: `Bearer ${forged}` }, url: '/ws' }, options)
        .outcome,
    ).toBe('refused');
  });

  it('tells every refusal apart only in the log', () => {
    // The same argument as the 401 in ../plugins/auth.ts: a socket that
    // answered differently for "no token", "expired" and "forged" would sort
    // harvested credentials for whoever asked.
    const refusals = [
      authenticateUpgrade({ headers: {}, url: '/ws' }, options),
      authenticateUpgrade({ headers: { authorization: 'Bearer nonsense' }, url: '/ws' }, options),
      authenticateUpgrade({ headers: { authorization: 'Basic x' }, url: '/ws' }, options),
      authenticateUpgrade(
        {
          headers: { authorization: `Bearer ${accessToken({ exp: NOW_SECONDS - 3_600 })}` },
          url: '/ws',
        },
        options,
      ),
    ];

    const wire = refusals.map((refusal) => {
      expect(refusal.outcome).toBe('refused');
      const { message, code, error } =
        refusal.outcome === 'refused'
          ? { ...refusal.reason }
          : { message: '', code: 0, error: ErrorCode.INTERNAL };
      return JSON.stringify({ message, code, error });
    });

    expect(new Set(wire).size).toBe(1);
    expect(refusals[0]?.outcome === 'refused' && refusals[0].reason.code).toBe(
      CloseCode.UNAUTHENTICATED,
    );
  });

  it('never throws on a url that will not parse', () => {
    expect(() => authenticateUpgrade({ headers: {}, url: 'http://[' }, options)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// A token in a query string
// ---------------------------------------------------------------------------

describe('a token in a query string', () => {
  it('is stripped from a url before it can be logged', () => {
    const redacted = redactUpgradeUrl(`/ws?${ACCESS_TOKEN_QUERY_PARAMETER}=secret.jwt.value&v=1`);

    expect(redacted).not.toContain('secret.jwt.value');
    expect(redacted).toContain(REDACTED_TOKEN);
    expect(redacted).toContain('v=1');
  });

  it('is stripped from every occurrence, not just the first', () => {
    // A url carrying the parameter twice is the shape an attempt to slip a
    // credential past a naive redactor takes.
    const redacted = redactUpgradeUrl(
      `/ws?${ACCESS_TOKEN_QUERY_PARAMETER}=one&${ACCESS_TOKEN_QUERY_PARAMETER}=two`,
    );

    expect(redacted).not.toContain('one');
    expect(redacted).not.toContain('two');
  });

  it('refuses to guess at a url it could not parse', () => {
    expect(redactUpgradeUrl('http://[')).toBe('(unparseable url)');
  });

  it('leaves a url with no token alone', () => {
    expect(redactUpgradeUrl('/ws?v=1')).toBe('/ws?v=1');
  });

  it('is reported at warn, so an operator knows to look at their access log', () => {
    const token = accessToken();
    const { handler } = harness();

    const decision = handler.authenticate({
      headers: {},
      url: `/ws?${ACCESS_TOKEN_QUERY_PARAMETER}=${token}`,
    });

    expect(decision.outcome).toBe('accepted');
    const warning = logs.find((line) => line.level === 'warn');
    expect(warning?.message).toContain('token in the url');
    expect(JSON.stringify(warning)).not.toContain(token);
  });

  it('never reaches a log line, on any path', () => {
    const token = accessToken();
    const { handler } = harness();

    handler.authenticate({
      headers: {},
      url: `/ws?${ACCESS_TOKEN_QUERY_PARAMETER}=${token}`,
    });
    handler.authenticate({
      headers: {},
      url: `/ws?${ACCESS_TOKEN_QUERY_PARAMETER}=${token}&bad=1`,
    });
    handler.authenticate({ headers: {}, url: `/ws?${ACCESS_TOKEN_QUERY_PARAMETER}=not.a.token` });

    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain(token);
    expect(JSON.stringify(logs)).not.toContain('not.a.token');
  });

  it('logs a refused upgrade with the reason and the redacted url', () => {
    const { handler } = harness();

    handler.authenticate({ headers: { authorization: 'Bearer nonsense' }, url: '/ws?v=1' });

    const line = logs.at(-1);
    expect(line?.message).toBe('websocket upgrade rejected');
    expect(line?.details['url']).toBe('/ws?v=1');
  });
});

// ---------------------------------------------------------------------------
// The handshake
// ---------------------------------------------------------------------------

describe('the hello handshake', () => {
  it('binds the socket and answers ready', async () => {
    const { connection, socket, bound } = connect();

    await send(connection, { type: 'hello', sessionId: SESSION });

    expect(socket.closes).toEqual([]);
    expect(socket.frames).toEqual([{ type: 'ready', sessionId: SESSION, pending: 0 }]);
    expect(connection.identity).toEqual({
      userId: USER,
      sessionId: SESSION,
      agentId: AGENT,
      projectId: PROJECT,
    });
    expect(bound).toHaveLength(1);
  });

  it('replays before it reports, per plan §4.3', async () => {
    // The bound hook is where T-308 pushes the pending inbox. Every message it
    // sends must be on the wire before `ready`, or a client that treats `ready`
    // as "your backlog is behind you" is wrong.
    const observer: ConnectionObserver = {
      bound: (binding) => {
        binding.send({ type: 'message', message: { messageId: MESSAGE } });
        binding.send({ type: 'message', message: { messageId: MESSAGE } });
        return 2;
      },
    };
    const { connection, socket } = connect({ observer });

    await send(connection, { type: 'hello', sessionId: SESSION });

    expect(socket.frames.map((frame) => frame.type)).toEqual(['message', 'message', 'ready']);
    expect(socket.frames.at(-1)).toEqual({ type: 'ready', sessionId: SESSION, pending: 2 });
  });

  it('carries the client identifier of plan §12.4 to the binding', async () => {
    const { connection, bound } = connect();

    await send(connection, { type: 'hello', sessionId: SESSION, client: 'agentchat/1.2.3' });

    expect(bound[0]?.client).toBe('agentchat/1.2.3');
  });

  it('gives the binding the registry key of plan §4.3', async () => {
    const { connection, bound } = connect();

    await send(connection, { type: 'hello', sessionId: SESSION });

    expect(bound[0]?.identity.agentId).toBe(AGENT);
    expect(bound[0]?.identity.projectId).toBe(PROJECT);
    expect(bound[0]?.session.status).toBe(SESSION_STATUS.ACTIVE);
  });
});

describe('the session comes from the frame, never from the token', () => {
  it('does not bind a socket whose token carries a session claim', async () => {
    // T-302: the `sid` claim is not preserved across a refresh, so it cannot be
    // the source of truth. A socket that has not said hello is not bound, and
    // an ack on it is refused, however good its token is.
    const { handler, socket } = harness();
    const user: AuthenticatedUser = { ...authenticated(), sessionId: SESSION };
    const connection = handler.connect(socket, user);

    expect(connection.identity).toBeNull();
    await send(connection, { type: 'ack', messageId: MESSAGE });

    expect(lastClose(socket).code).toBe(CloseCode.FRAME_OUT_OF_ORDER);
  });

  it('binds the session the frame names even when the token names another', async () => {
    // The exact shape of the refresh problem: an hour-old listener holds a
    // token whose `sid` is stale or gone. The frame is what is trusted.
    const { handler, socket } = harness();
    const user: AuthenticatedUser = { ...authenticated(), sessionId: ENDED_SESSION };
    const connection = handler.connect(socket, user);

    await send(connection, { type: 'hello', sessionId: SESSION });

    expect(socket.closes).toEqual([]);
    expect(connection.identity?.sessionId).toBe(SESSION);
  });

  it('accepts a token with no session claim at all', async () => {
    const { connection, socket } = connect();

    await send(connection, { type: 'hello', sessionId: SESSION });

    expect(socket.frames.at(-1)?.type).toBe('ready');
  });
});

describe('refusing a hello', () => {
  it('refuses a session that does not exist', async () => {
    const { connection, socket } = connect();

    await send(connection, { type: 'hello', sessionId: SessionId.generate() });

    expect(lastClose(socket).code).toBe(CloseCode.SESSION_INVALID);
  });

  it("refuses another user's session", async () => {
    const { connection, socket } = connect();

    await send(connection, { type: 'hello', sessionId: STRANGER_SESSION });

    expect(lastClose(socket).code).toBe(CloseCode.SESSION_INVALID);
    expect(connection.identity).toBeNull();
  });

  it('refuses a stale session, because only an active one may bind', async () => {
    // T-302: staleness is the sweeper having stopped believing in a listener.
    // Binding one would put messages on a socket presence says is not there.
    const { connection, socket } = connect();

    await send(connection, { type: 'hello', sessionId: STALE_SESSION });

    expect(lastClose(socket).code).toBe(CloseCode.SESSION_INVALID);
  });

  it('refuses an ended session', async () => {
    const { connection, socket } = connect();

    await send(connection, { type: 'hello', sessionId: ENDED_SESSION });

    expect(lastClose(socket).code).toBe(CloseCode.SESSION_INVALID);
  });

  it('answers all four causes identically on the wire', async () => {
    const answers: string[] = [];

    for (const sessionId of [
      SessionId.generate(),
      STRANGER_SESSION,
      STALE_SESSION,
      ENDED_SESSION,
    ]) {
      const { connection, socket } = connect();
      await send(connection, { type: 'hello', sessionId });
      answers.push(JSON.stringify({ frames: socket.frames, closes: socket.closes }));
    }

    expect(new Set(answers).size).toBe(1);
  });

  it('records which cause it actually was, in the log only', async () => {
    const { connection } = connect();

    await send(connection, { type: 'hello', sessionId: STALE_SESSION });

    const closed = logs.find((line) => line.message === 'websocket closed by server');
    expect(String(closed?.details['reason'])).toContain('stale');
  });

  it('sends the error frame before closing', async () => {
    const { connection, socket } = connect();

    await send(connection, { type: 'hello', sessionId: ENDED_SESSION });

    expect(socket.frames).toHaveLength(1);
    expect(socket.frames[0]).toMatchObject({ type: 'error', code: ErrorCode.SESSION_INVALID });
    expect(socket.closes).toHaveLength(1);
  });

  it('closes with 1011 when the session lookup fails', async () => {
    const sessions: SessionLookup = { list: () => Promise.reject(new Error('connection reset')) };
    const { connection, socket } = connect({ sessions });

    await send(connection, { type: 'hello', sessionId: SESSION });

    expect(lastClose(socket).code).toBe(CloseCode.INTERNAL_ERROR);
    expect(socket.frames[0]).toMatchObject({ type: 'error', code: ErrorCode.INTERNAL });
    expect(JSON.stringify(socket.frames)).not.toContain('connection reset');
  });

  it('closes with 1011 when the bind hook fails, rather than reporting ready', async () => {
    const observer: ConnectionObserver = {
      bound: () => {
        throw new Error('registry is full');
      },
    };
    const { connection, socket } = connect({ observer });

    await send(connection, { type: 'hello', sessionId: SESSION });

    expect(lastClose(socket).code).toBe(CloseCode.INTERNAL_ERROR);
    expect(socket.frames.some((frame) => frame.type === 'ready')).toBe(false);
  });
});

describe('frames out of order', () => {
  it('refuses an ack before hello', async () => {
    const { connection, socket } = connect();

    await send(connection, { type: 'ack', messageId: MESSAGE });

    expect(lastClose(socket).code).toBe(CloseCode.FRAME_OUT_OF_ORDER);
    expect(socket.frames[0]).toMatchObject({ code: ErrorCode.PROTOCOL_VIOLATION });
  });

  it('refuses a ping before hello', async () => {
    const { connection, socket } = connect();

    await send(connection, { type: 'ping' });

    expect(lastClose(socket).code).toBe(CloseCode.FRAME_OUT_OF_ORDER);
  });

  it('refuses a second hello on a bound socket', async () => {
    const { connection, socket } = connect();

    await send(connection, { type: 'hello', sessionId: SESSION });
    await send(connection, { type: 'hello', sessionId: SESSION });

    expect(lastClose(socket).code).toBe(CloseCode.FRAME_OUT_OF_ORDER);
  });

  it('handles frames in arrival order even when the handshake is slow', async () => {
    // Without the queue an ack sent immediately after a hello could be handled
    // while the hello was still awaiting the database, and would be refused for
    // arriving before a handshake that was already under way.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sessions: SessionLookup = {
      list: async () => {
        await gate;
        return [...OWNED];
      },
    };
    const acked = vi.fn();
    const { connection, socket } = connect({ sessions, observer: { acked } });

    const first = connection.receive(JSON.stringify({ type: 'hello', sessionId: SESSION }));
    const second = connection.receive(JSON.stringify({ type: 'ack', messageId: MESSAGE }));
    release();
    await Promise.all([first, second]);

    expect(socket.closes).toEqual([]);
    expect(acked).toHaveBeenCalledTimes(1);
  });
});

describe('malformed and oversize frames', () => {
  it('closes with 4400 on malformed JSON', async () => {
    const { connection, socket } = connect();

    await connection.receive('{"type":"hello"');

    expect(lastClose(socket).code).toBe(CloseCode.FRAME_MALFORMED);
    expect(socket.frames[0]).toMatchObject({ type: 'error', code: ErrorCode.PROTOCOL_VIOLATION });
  });

  it('closes with 4413 on an oversize frame, a distinct code', async () => {
    const { connection, socket } = connect();

    await connection.receive('x'.repeat(MAX_FRAME_BYTES + 1));

    expect(lastClose(socket).code).toBe(CloseCode.FRAME_TOO_LARGE);
    expect(socket.frames[0]).toMatchObject({ code: ErrorCode.PAYLOAD_TOO_LARGE });
    expect(CloseCode.FRAME_TOO_LARGE).not.toBe(CloseCode.FRAME_MALFORMED);
  });

  it('closes with 4422 on a known frame missing a required field', async () => {
    const { connection, socket } = connect();

    await send(connection, { type: 'hello' });

    expect(lastClose(socket).code).toBe(CloseCode.FRAME_INVALID);
  });

  it('keeps the close reason inside what a close frame can carry', async () => {
    const { connection, socket } = connect();

    await connection.receive('not json');

    expect(Buffer.byteLength(lastClose(socket).reason, 'utf8')).toBeLessThanOrEqual(123);
  });

  it('stops reading after a close', async () => {
    const { connection, socket } = connect();

    await connection.receive('not json');
    await send(connection, { type: 'hello', sessionId: SESSION });

    expect(socket.closes).toHaveLength(1);
    expect(connection.identity).toBeNull();
  });
});

describe('forward compatibility (plan §12.4)', () => {
  it('ignores an unknown frame type and keeps the socket', async () => {
    const { connection, socket } = connect();

    await send(connection, { type: 'hello', sessionId: SESSION });
    await send(connection, { type: 'resume', cursor: 'abc' });

    expect(socket.closes).toEqual([]);
    expect(socket.frames.map((frame) => frame.type)).toEqual(['ready']);
  });

  it('ignores an unknown frame type sent before hello, and still binds after it', async () => {
    // The subtle case. "The first frame must be hello" is a rule about frames
    // this server knows; applying it to one it does not would make every future
    // frame type a flag day, which is exactly what §12.4 forbids.
    const { connection, socket } = connect();

    await send(connection, { type: 'resume', cursor: 'abc' });
    expect(socket.closes).toEqual([]);

    await send(connection, { type: 'hello', sessionId: SESSION });
    expect(socket.frames.at(-1)).toEqual({ type: 'ready', sessionId: SESSION, pending: 0 });
  });

  it('never answers an unknown frame', async () => {
    const { connection, socket } = connect();

    await send(connection, { type: 'hello', sessionId: SESSION });
    await send(connection, { type: 'resume' });
    await send(connection, { type: 'subscribe', topics: ['x'] });

    expect(socket.frames.map((frame) => frame.type)).toEqual(['ready']);
  });

  it('logs an unknown type once per type, not once per frame', async () => {
    const { connection } = connect();

    await send(connection, { type: 'hello', sessionId: SESSION });
    for (let i = 0; i < 5; i += 1) {
      await send(connection, { type: 'resume' });
    }
    await send(connection, { type: 'subscribe' });

    const ignored = logs.filter((line) => line.message.startsWith('ignoring unknown frame type'));
    expect(ignored).toHaveLength(2);
    expect(ignored.map((line) => line.details['frameType'])).toEqual(['resume', 'subscribe']);
  });

  it('accepts a hello carrying fields this server has never seen', async () => {
    const { connection, socket } = connect();

    await send(connection, {
      type: 'hello',
      sessionId: SESSION,
      resumeToken: 'tok',
      capabilities: ['compression'],
    });

    expect(socket.closes).toEqual([]);
    expect(socket.frames.at(-1)?.type).toBe('ready');
  });

  it('accepts unknown fields on an ack too', async () => {
    const acked = vi.fn();
    const { connection, socket } = connect({ observer: { bound: () => 0, acked } });

    await send(connection, { type: 'hello', sessionId: SESSION });
    await send(connection, { type: 'ack', messageId: MESSAGE, receivedAt: 'now', batch: 3 });

    expect(socket.closes).toEqual([]);
    expect(acked).toHaveBeenCalledWith(expect.anything(), MESSAGE);
  });
});

describe('a bound socket', () => {
  it('answers a ping with a pong', async () => {
    const pinged = vi.fn();
    const { connection, socket } = connect({ observer: { bound: () => 0, pinged } });

    await send(connection, { type: 'hello', sessionId: SESSION });
    await send(connection, { type: 'ping' });

    expect(socket.frames.at(-1)).toEqual({ type: 'pong' });
    expect(pinged).toHaveBeenCalledTimes(1);
  });

  it('answers a ping even with no hooks installed', async () => {
    // Liveness is this module's promise. It must not depend on T-309 having
    // registered anything.
    const { connection, socket } = connect({ observer: {} });

    await send(connection, { type: 'hello', sessionId: SESSION });
    await send(connection, { type: 'ping' });

    expect(socket.frames.at(-1)).toEqual({ type: 'pong' });
  });

  it('forwards an ack', async () => {
    const acked = vi.fn();
    const { connection } = connect({ observer: { bound: () => 0, acked } });

    await send(connection, { type: 'hello', sessionId: SESSION });
    await send(connection, { type: 'ack', messageId: MESSAGE });

    expect(acked).toHaveBeenCalledWith(
      expect.objectContaining({ identity: expect.anything() }),
      MESSAGE,
    );
  });

  it('closes with 1011 when a frame hook throws, and says nothing about why', async () => {
    const observer: ConnectionObserver = {
      bound: () => 0,
      acked: () => {
        throw new Error('inbox table is locked');
      },
    };
    const { connection, socket } = connect({ observer });

    await send(connection, { type: 'hello', sessionId: SESSION });
    await send(connection, { type: 'ack', messageId: MESSAGE });

    expect(lastClose(socket).code).toBe(CloseCode.INTERNAL_ERROR);
    expect(JSON.stringify(socket.frames)).not.toContain('inbox table is locked');
  });

  it('survives a send that throws because the peer has gone', async () => {
    const { handler } = harness();
    const socket = recordingSocket();
    const failing: FrameSocket = {
      send: () => {
        throw new Error('socket is not open');
      },
      close: socket.close.bind(socket),
    };
    const connection = handler.connect(failing, authenticated());

    await expect(send(connection, { type: 'hello', sessionId: SESSION })).resolves.toBeUndefined();
  });
});

describe('closing', () => {
  it('tells the observer once, whichever side closed', async () => {
    const closed = vi.fn();
    const { connection, socket } = connect({ observer: { bound: () => 0, closed } });

    await send(connection, { type: 'hello', sessionId: SESSION });
    await send(connection, { type: 'hello', sessionId: SESSION });
    await connection.disconnected(socket.closes[0]?.code ?? CloseCode.NORMAL);

    expect(closed).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledWith(expect.anything(), CloseCode.FRAME_OUT_OF_ORDER);
  });

  it('tells the observer when the peer disconnects on its own', async () => {
    const closed = vi.fn();
    const { connection } = connect({ observer: { bound: () => 0, closed } });

    await send(connection, { type: 'hello', sessionId: SESSION });
    await connection.disconnected(CloseCode.NORMAL);

    expect(closed).toHaveBeenCalledWith(expect.anything(), CloseCode.NORMAL);
  });

  it('says nothing about a socket that never bound', async () => {
    // There is nothing to deregister and no session to mark stale, and a hook
    // handed a half-built binding is worse than one not called at all.
    const closed = vi.fn();
    const { connection } = connect({ observer: { closed } });

    await send(connection, { type: 'ping' });
    await connection.disconnected(CloseCode.FRAME_OUT_OF_ORDER);

    expect(closed).not.toHaveBeenCalled();
  });

  it('closes the socket only once', async () => {
    const { connection, socket } = connect();

    await send(connection, { type: 'ping' });
    connection.close({
      code: CloseCode.NORMAL,
      error: ErrorCode.INTERNAL,
      message: 'again',
      detail: 'again',
    });

    expect(socket.closes).toHaveLength(1);
  });

  it('keeps a failing close hook from taking anything else down', async () => {
    const observer: ConnectionObserver = {
      bound: () => 0,
      closed: () => {
        throw new Error('registry is gone');
      },
    };
    const { connection } = connect({ observer });

    await send(connection, { type: 'hello', sessionId: SESSION });
    await expect(connection.disconnected(CloseCode.NORMAL)).resolves.toBeUndefined();
    expect(logs.some((line) => line.level === 'error')).toBe(true);
  });

  it('drops a frame sent after the socket is gone instead of throwing', async () => {
    const { connection, socket, bound } = connect();

    await send(connection, { type: 'hello', sessionId: SESSION });
    await connection.disconnected(CloseCode.NORMAL);

    expect(() => bound[0]?.send({ type: 'pong' })).not.toThrow();
    expect(socket.frames.map((frame) => frame.type)).toEqual(['ready']);
  });
});

// ---------------------------------------------------------------------------
// The outbound bound
// ---------------------------------------------------------------------------

describe('the outbound bound', () => {
  /** A delivered frame, distinguishable from the handshake's `ready`. */
  function delivered(): ServerFrame {
    return { type: 'pong' };
  }

  /**
   * Binds a socket and hands back the seam replay and the router deliver through.
   *
   * @param socket - The transport to drive.
   * @returns The bound socket, its connection, and the observer's close spy.
   */
  async function deliverable(socket: FrameSocket) {
    const closed = vi.fn();
    const bound: SocketBinding[] = [];
    const built = harness({
      observer: {
        bound: (binding) => {
          bound.push(binding);
          return 0;
        },
        closed,
      },
    });
    const connection = built.handler.connect(socket, authenticated());
    await send(connection, { type: 'hello', sessionId: SESSION });

    const binding = bound[0];
    expect(binding).toBeDefined();
    return { binding: binding as SocketBinding, connection, closed };
  }

  /** The message ids a socket was sent, in the order it was sent them. */
  function deliveredIds(socket: RecordingSocket): string[] {
    return socket.frames.flatMap((frame) =>
      frame.type === 'message' ? [(frame.message as { readonly id: string }).id] : [],
    );
  }

  /** Delivers frames until the peer's buffer is over the bound. */
  function fill(binding: SocketBinding, socket: BufferingSocket): void {
    while (socket.bufferedAmount <= MAX_BUFFERED_BYTES) {
      binding.send(delivered());
    }
  }

  it('closes a peer whose backlog passes the bound', async () => {
    const socket = bufferingSocket();
    const { binding } = await deliverable(socket);

    fill(binding, socket);

    expect(lastClose(socket)).toEqual({
      code: CloseCode.BACKLOG_UNREAD,
      reason: UNREAD_CLOSE_REASON,
    });
  });

  it('closes with a code of its own, not the one an orderly shutdown uses', async () => {
    // The reason for T-048. A client keeping its own metrics has to be able to
    // separate "somebody restarted the server" from "I stopped reading my
    // socket": the remedies are opposite, and the cause used to travel only in
    // the close reason, which is prose no structured consumer is shown. No
    // `error` frame precedes it either — nothing the client sent was wrong, and
    // the frame would go into the very buffer this close exists to stop growing.
    const socket = bufferingSocket();
    const { binding } = await deliverable(socket);

    fill(binding, socket);

    expect(lastClose(socket).code).toBe(CloseCode.BACKLOG_UNREAD);
    expect(lastClose(socket).code).not.toBe(CloseCode.NORMAL);
    expect(socket.frames.some((frame) => frame.type === 'error')).toBe(false);
  });

  it('leaves a peer that is reading alone, however much it is sent', async () => {
    // The condition is a consumer that has *stopped*, not one that is slow. A
    // peer draining between writes never accumulates, and closing it would
    // punish exactly the listener this bound exists to protect.
    const socket = bufferingSocket();
    const { binding } = await deliverable(socket);

    for (let index = 0; index < 100; index += 1) {
      binding.send(delivered());
      socket.drain();
    }

    expect(socket.closes).toEqual([]);
    expect(socket.frames).toHaveLength(101);
  });

  it('does not let a stalled listener take a healthy one with it', async () => {
    // The failure being fixed is an availability problem for *other* sockets,
    // so the assertion that matters is the one about the other socket.
    const stalled = bufferingSocket();
    const healthy = bufferingSocket();
    const first = await deliverable(stalled);
    const second = await deliverable(healthy);

    fill(first.binding, stalled);
    second.binding.send(delivered());
    healthy.drain();
    second.binding.send(delivered());

    expect(lastClose(stalled).code).toBe(CloseCode.BACKLOG_UNREAD);
    expect(healthy.closes).toEqual([]);
    expect(healthy.frames.map((frame) => frame.type)).toEqual(['ready', 'pong', 'pong']);
  });

  it('writes the frame that trips the bound before it closes', async () => {
    // The order is the whole safety argument. A frame the server decided not to
    // send is a message somebody has to arrange to send later; a frame written
    // and never read is simply still unacknowledged, and replay already covers
    // that case.
    const socket = bufferingSocket();
    const { binding } = await deliverable(socket);

    fill(binding, socket);

    expect(socket.bufferedAmount).toBeGreaterThan(MAX_BUFFERED_BYTES);
    expect(socket.frames.at(-1)?.type).toBe('pong');
    expect(socket.closes).toHaveLength(1);
  });

  it('loses nothing: the close is announced, and later frames are dropped rather than queued', async () => {
    // Delivery is at-least-once and the debt lives in `message_inbox`, so what
    // has to hold here is narrow and checkable. The observer that owns the
    // registration and the inbox is told the socket is gone, and nothing after
    // that reaches the transport — so the message stays unacknowledged, which
    // is what makes the next `hello` replay it.
    const socket = bufferingSocket();
    const { binding, closed } = await deliverable(socket);

    fill(binding, socket);
    const written = socket.frames.length;
    binding.send(delivered());

    expect(closed).toHaveBeenCalledWith(expect.anything(), CloseCode.BACKLOG_UNREAD);
    expect(socket.frames).toHaveLength(written);
    expect(socket.closes).toHaveLength(1);
  });

  it('still owes the message that tripped the bound, and replays it to the next connection', async () => {
    // Closing a listener is safe only because the debt lives in `message_inbox`
    // and is cleared by an `ack` and by nothing else. This models that inbox at
    // the observer seam: the frame that tripped the bound was written, was never
    // acknowledged, and comes back on the next `hello`. A close that lost a
    // message would be a worse bug than anything a close code can buy.
    const owed = new Map<string, ServerFrame>();
    const bindings: SocketBinding[] = [];
    const observer: ConnectionObserver = {
      bound: (binding) => {
        bindings.push(binding);
        for (const frame of owed.values()) {
          binding.send(frame);
        }
        return owed.size;
      },
      acked: (_binding, messageId) => {
        owed.delete(messageId);
      },
    };

    const built = harness({ observer });
    const stalled = bufferingSocket();
    const first = built.handler.connect(stalled, authenticated());
    await send(first, { type: 'hello', sessionId: SESSION });
    const binding = bindings.at(-1) as SocketBinding;

    let tripping = MESSAGE;
    while (stalled.bufferedAmount <= MAX_BUFFERED_BYTES) {
      tripping = MessageId.generate();
      const frame: ServerFrame = { type: 'message', message: { id: tripping } };
      owed.set(tripping, frame);
      binding.send(frame);
    }

    expect(lastClose(stalled).code).toBe(CloseCode.BACKLOG_UNREAD);
    expect(deliveredIds(stalled)).toContain(tripping);

    // The same session on a fresh socket, with room to take the replay.
    const resumed = bufferingSocket({ bytesPerFrame: 1 });
    const second = built.handler.connect(resumed, authenticated());
    await send(second, { type: 'hello', sessionId: SESSION });

    expect(deliveredIds(resumed)).toEqual([...owed.keys()]);
    expect(deliveredIds(resumed)).toContain(tripping);
    expect(resumed.frames.at(-1)).toEqual({
      type: 'ready',
      sessionId: SESSION,
      pending: owed.size,
    });

    // The replay is a debt and not a habit: an `ack` settles it, so a third
    // connection does not see it again. Without this, the assertion above would
    // hold just as well for an observer that replayed unconditionally.
    await send(second, { type: 'ack', messageId: tripping });

    const third = bufferingSocket({ bytesPerFrame: 1 });
    await send(built.handler.connect(third, authenticated()), {
      type: 'hello',
      sessionId: SESSION,
    });

    expect(deliveredIds(third)).not.toContain(tripping);
  });

  it('says so at warn, with the reading, the limit and the listener', async () => {
    // The close code says what happened; this line says how far past the bound
    // the socket got and whose it was, which is what an operator acts on.
    const socket = bufferingSocket();
    const { binding } = await deliverable(socket);

    fill(binding, socket);

    const warning = logs.find(
      (line) => line.level === 'warn' && line.message.includes('is not reading'),
    );

    expect(warning).toBeDefined();
    expect(warning?.details['limitBytes']).toBe(MAX_BUFFERED_BYTES);
    expect(warning?.details['bufferedBytes']).toBeGreaterThan(MAX_BUFFERED_BYTES);
    expect(warning?.details['sessionId']).toBe(SESSION);
    expect(warning?.details['agentId']).toBe(AGENT);
    expect(warning?.details['projectId']).toBe(PROJECT);
  });

  it('is checked on delivered frames and not on the answers this module sends', async () => {
    // `ready`, `pong` and the `error` frame before a close are one small frame
    // each, sent in answer to something the client did. Checking after them
    // would buy nothing except a close that re-enters itself.
    const socket = bufferingSocket({ bytesPerFrame: MAX_BUFFERED_BYTES + 1 });
    const { connection } = await deliverable(socket);

    await send(connection, { type: 'ping' });

    expect(socket.closes).toEqual([]);
    expect(socket.frames.map((frame) => frame.type)).toEqual(['ready', 'pong']);
  });

  it('reports the live buffer to the router rather than a cached one', async () => {
    const socket = bufferingSocket({ bytesPerFrame: 1_024 });
    const { binding } = await deliverable(socket);

    expect(binding.bufferedBytes).toBe(1_024);
    binding.send(delivered());
    expect(binding.bufferedBytes).toBe(2_048);
    socket.drain();
    expect(binding.bufferedBytes).toBe(0);
  });

  it('never closes a transport that does not report queued bytes', async () => {
    // The bound is a safety valve on a figure only the transport can supply. A
    // transport that supplies none is no worse off than before this existed.
    const socket = recordingSocket();
    const { binding } = await deliverable(socket);

    for (let index = 0; index < 50; index += 1) {
      binding.send(delivered());
    }

    expect(binding.bufferedBytes).toBeUndefined();
    expect(socket.closes).toEqual([]);
    expect(socket.frames).toHaveLength(51);
  });

  it('warns before it closes, because the bound is above the router threshold', () => {
    // The two numbers are restated in two modules rather than shared, to keep
    // `router.ts` and `handler.ts` acyclic. This is what keeps them honest.
    expect(MAX_BUFFERED_BYTES).toBeGreaterThan(BUFFER_WARNING_BYTES);
  });

  it('keeps its close reason inside what a close frame will carry', () => {
    // A reason over the limit makes the transport throw as the socket is
    // closing, which is the least recoverable moment there is.
    expect(Buffer.byteLength(UNREAD_CLOSE_REASON, 'utf8')).toBeLessThanOrEqual(
      MAX_CLOSE_REASON_BYTES,
    );
  });
});
