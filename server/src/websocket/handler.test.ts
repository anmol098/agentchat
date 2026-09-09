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
  CLIENT_VERSION_HEADER,
  ErrorCode,
  formatClientVersionHeader,
  MachineId,
  MessageId,
  MIN_CLIENT_VERSION,
  ProjectId,
  ProtocolError,
  SessionId,
  upgradeRequiredMessage,
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
  type SessionOwnerRequest,
  type SessionRecord,
  type SessionStatus,
} from '../services/sessions.js';
import { CloseCode, MAX_CLOSE_REASON_BYTES, MAX_FRAME_BYTES, type ServerFrame } from './frames.js';
import {
  ACCESS_TOKEN_QUERY_PARAMETER,
  authenticateUpgrade,
  type BackPressureOptions,
  type ConnectionObserver,
  createWebSocketHandler,
  type FrameSocket,
  MAX_BUFFERED_BYTES,
  REDACTED_TOKEN,
  redactUpgradeUrl,
  type SessionLookup,
  type SocketBinding,
  type SocketLogger,
  STALLED_REPLAY_CLOSE_REASON,
  UNREAD_CLOSE_REASON,
  type UpgradeAccepted,
  type UpgradeRefused,
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
 *
 * `heartbeat` models the service's own contract: `stale` and `active` alike
 * come back `active`, and an ended session is a `CONFLICT` rather than a
 * revival.
 */
function lookup(): SessionLookup {
  return {
    list: (request: ListSessionsRequest): Promise<SessionRecord[]> =>
      Promise.resolve(request.userId === USER ? [...OWNED] : []),

    heartbeat: (request: SessionOwnerRequest): Promise<SessionRecord> => {
      const session = OWNED.find((candidate) => candidate.id === request.sessionId);
      if (session === undefined || request.userId !== USER) {
        return Promise.reject(new ProtocolError(ErrorCode.NOT_FOUND, 'No such session.'));
      }
      if (session.status === SESSION_STATUS.ENDED) {
        return Promise.reject(new ProtocolError(ErrorCode.CONFLICT, 'Session has ended.'));
      }
      return Promise.resolve({ ...session, status: SESSION_STATUS.ACTIVE });
    },
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

  /** The peer read everything, or `bytes` of it. */
  drain(bytes?: number): void;
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
    drain(bytes?: number): void {
      buffered = bytes === undefined ? 0 : Math.max(0, buffered - bytes);
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
  overrides: {
    readonly observer?: ConnectionObserver;
    readonly sessions?: SessionLookup;
    readonly backPressure?: BackPressureOptions;
  } = {},
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
    ...(overrides.backPressure === undefined ? {} : { backPressure: overrides.backPressure }),
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
// The client version floor (T-042)
// ---------------------------------------------------------------------------

describe('the version floor on an upgrade', () => {
  /** A floor with room either side of it, so "older" and "newer" are both real. */
  const FLOOR = '1.2.3';

  const options = { jwtSecret: SECRET, now: () => NOW, minClientVersion: FLOOR };

  /**
   * One upgrade request announcing `client`, with a valid token.
   *
   * The token is valid throughout so that a refusal can only be the floor's.
   *
   * @param client - The `X-AgentChat-Client` value, verbatim. Omit for none.
   * @returns The request to decide.
   */
  function upgrade(client?: string | string[]) {
    return {
      headers: {
        authorization: `Bearer ${accessToken()}`,
        ...(client === undefined ? {} : { [CLIENT_VERSION_HEADER]: client }),
      },
      url: '/ws',
    };
  }

  /**
   * The refusal from a decision, or a failure if it was not one.
   *
   * @param decision - What `authenticateUpgrade` returned.
   * @returns Its reason.
   */
  function refusal(decision: ReturnType<typeof authenticateUpgrade>): UpgradeRefused['reason'] {
    expect(decision.outcome).toBe('refused');
    return (decision as UpgradeRefused).reason;
  }

  it('refuses a client below the floor', () => {
    const reason = refusal(
      authenticateUpgrade(upgrade(formatClientVersionHeader('0.0.1')), options),
    );

    expect(reason.error).toBe(ErrorCode.UPGRADE_REQUIRED);
  });

  it('names the same floor and the same remedy the HTTP guard names', () => {
    // Not a re-implementation of the sentence: the point is that both doors
    // read it out of `@agentchat/protocol`, so there is one string and it
    // cannot drift. Two different messages for one rule is worse than one
    // message in one place.
    const reason = refusal(
      authenticateUpgrade(upgrade(formatClientVersionHeader('1.0.0')), options),
    );

    expect(reason.message).toBe(upgradeRequiredMessage(FLOOR));
    expect(reason.message).toContain(FLOOR);
    expect(reason.message).toContain('npm i -g agentchat@latest');
  });

  it('serves a client at the floor, because that is what a minimum is', () => {
    // A strict comparison here would strand exactly the users who did the
    // upgrade they were told to do.
    expect(authenticateUpgrade(upgrade(formatClientVersionHeader(FLOOR)), options).outcome).toBe(
      'accepted',
    );
  });

  it('serves a client above the floor', () => {
    expect(authenticateUpgrade(upgrade(formatClientVersionHeader('9.9.9')), options).outcome).toBe(
      'accepted',
    );
  });

  it('serves an upgrade that announces no client at all', () => {
    // A third-party harness embedding @agentchat/client is not the agentchat
    // CLI and has no release to claim; a browser cannot set a header on a
    // WebSocket at all. The floor exists to tell a CLI user to upgrade, not to
    // gate the API — and this matches what the HTTP guard does with an absent
    // header.
    expect(authenticateUpgrade(upgrade(), options).outcome).toBe('accepted');
  });

  it('refuses a malformed identifier rather than treating it as absent', () => {
    // Otherwise "I claim to be 0.0.1" in a shape this server cannot compare
    // would buy passage past the floor that an honest claim would not.
    for (const malformed of ['0.0.1', 'agentchat/', 'agentchat/1', 'agentchat 1.2.3', '']) {
      const reason = refusal(authenticateUpgrade(upgrade(malformed), options));
      expect(reason.error).toBe(ErrorCode.BAD_REQUEST);
      expect(reason.message).toContain(CLIENT_VERSION_HEADER);
    }
  });

  it('refuses a repeated header rather than picking one of the claims', () => {
    const reason = refusal(
      authenticateUpgrade(
        upgrade([formatClientVersionHeader('9.9.9'), formatClientVersionHeader('0.0.1')]),
        options,
      ),
    );

    expect(reason.error).toBe(ErrorCode.BAD_REQUEST);
  });

  it('compares versions by precedence, not as strings', () => {
    // The bug this exists to prevent: a string comparison makes 0.10.0 older
    // than 0.9.0, and that is exactly the comparison deciding whether somebody
    // is locked out of their own server.
    const nine = { ...options, minClientVersion: '0.9.0' };

    expect(authenticateUpgrade(upgrade(formatClientVersionHeader('0.10.0')), nine).outcome).toBe(
      'accepted',
    );
    expect(authenticateUpgrade(upgrade(formatClientVersionHeader('0.8.9')), nine).outcome).toBe(
      'refused',
    );
  });

  it('ranks a pre-release below the release it precedes', () => {
    const reason = refusal(
      authenticateUpgrade(upgrade(formatClientVersionHeader(`${FLOOR}-rc.1`)), options),
    );

    expect(reason.error).toBe(ErrorCode.UPGRADE_REQUIRED);
  });

  it('answers "upgrade" and not "unauthenticated" to a client that is both', () => {
    // T-041's ordering, applied to the other door. A CLI three releases old
    // usually has an expired token as well; both answers are true and only one
    // of them names a remedy, so the floor is checked before the credential is
    // even read.
    const reason = refusal(
      authenticateUpgrade(
        { headers: { [CLIENT_VERSION_HEADER]: formatClientVersionHeader('0.0.1') }, url: '/ws' },
        options,
      ),
    );

    expect(reason.error).toBe(ErrorCode.UPGRADE_REQUIRED);
    expect(reason.error).not.toBe(ErrorCode.AUTH_REQUIRED);
  });

  it('carries no close code, because it is always answerable in HTTP', () => {
    // The refusal is decided from the upgrade *request*, so it is decided
    // while 426 is still sayable. There is no close code in ./frames.ts that
    // means "upgrade", and an absent one is honest where a borrowed one — 4401
    // above all — would say something the client would act on wrongly.
    const reason = refusal(
      authenticateUpgrade(upgrade(formatClientVersionHeader('0.0.1')), options),
    );

    expect(reason.code).toBeUndefined();
    expect(reason.detail).toContain('0.0.1');
  });

  it('defaults to the shipped floor when none is configured', () => {
    // What ../app.ts gets by passing nothing.
    const shipped = { jwtSecret: SECRET, now: () => NOW };
    const reason = refusal(
      authenticateUpgrade(upgrade(formatClientVersionHeader('0.0.1')), shipped),
    );

    expect(reason.message).toBe(upgradeRequiredMessage(MIN_CLIENT_VERSION));
  });

  it('logs the refusal with its code, so an operator can see which rule bit', () => {
    // The 426 only ever reaches the person being refused. An operator whose
    // users have suddenly stopped connecting has this line and nothing else.
    const handler = createWebSocketHandler({
      jwtSecret: SECRET,
      sessions: lookup(),
      logger: capturingLogger(logs),
      now: () => NOW,
      minClientVersion: FLOOR,
    });

    expect(handler.authenticate(upgrade(formatClientVersionHeader('0.0.1'))).outcome).toBe(
      'refused',
    );

    const line = logs.at(-1);
    expect(line?.message).toBe('websocket upgrade rejected');
    expect(line?.details['code']).toBe(ErrorCode.UPGRADE_REQUIRED);
  });

  it('does not put the version claim in the way of a socket it should serve', () => {
    const handler = createWebSocketHandler({
      jwtSecret: SECRET,
      sessions: lookup(),
      logger: capturingLogger(logs),
      now: () => NOW,
      minClientVersion: FLOOR,
    });

    expect(handler.authenticate(upgrade(formatClientVersionHeader('1.2.4'))).outcome).toBe(
      'accepted',
    );
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

  it('revives a stale session rather than refusing it', async () => {
    // T-041: staleness says nothing is connected *right now*, and this frame is
    // the evidence against that. Refusing it ended a listener at its first
    // disconnect, because the heartbeat marks a session stale on every close
    // and the client treats 4403 as fatal.
    const { connection, socket } = connect();

    await send(connection, { type: 'hello', sessionId: STALE_SESSION });

    expect(socket.closes).toHaveLength(0);
    expect(socket.frames[0]).toMatchObject({ type: 'ready', sessionId: STALE_SESSION });
    expect(connection.identity?.sessionId).toBe(STALE_SESSION);
  });

  it('binds the revived record, so a bound socket is never stale', async () => {
    let bound: SocketBinding | undefined;
    const { connection } = connect({
      observer: {
        bound: (binding: SocketBinding): Promise<number> => {
          bound = binding;
          return Promise.resolve(0);
        },
      },
    });

    await send(connection, { type: 'hello', sessionId: STALE_SESSION });

    expect(bound?.session.status).toBe(SESSION_STATUS.ACTIVE);
  });

  it('refuses a stale session it cannot revive, without leaking why', async () => {
    // The session ending between the read and the revival — the sweeper's doing
    // or the client's own DELETE racing its reconnect. `ended` is terminal
    // whichever way it got there.
    const sessions: SessionLookup = {
      ...lookup(),
      heartbeat: () => Promise.reject(new ProtocolError(ErrorCode.CONFLICT, 'Session has ended.')),
    };
    const { connection, socket } = connect({ sessions });

    await send(connection, { type: 'hello', sessionId: STALE_SESSION });

    expect(lastClose(socket).code).toBe(CloseCode.SESSION_INVALID);
    expect(socket.frames[0]).toMatchObject({ type: 'error', code: ErrorCode.SESSION_INVALID });
  });

  it('refuses an ended session', async () => {
    const { connection, socket } = connect();

    await send(connection, { type: 'hello', sessionId: ENDED_SESSION });

    expect(lastClose(socket).code).toBe(CloseCode.SESSION_INVALID);
  });

  it('answers all three causes identically on the wire', async () => {
    // A stale session is no longer among them: it binds. What is left is an id
    // that does not exist, one belonging to somebody else, and one that ended,
    // and none of those may be told apart by a caller guessing at ids.
    const answers: string[] = [];

    for (const sessionId of [SessionId.generate(), STRANGER_SESSION, ENDED_SESSION]) {
      const { connection, socket } = connect();
      await send(connection, { type: 'hello', sessionId });
      answers.push(JSON.stringify({ frames: socket.frames, closes: socket.closes }));
    }

    expect(new Set(answers).size).toBe(1);
  });

  it('records which cause it actually was, in the log only', async () => {
    const { connection } = connect();

    await send(connection, { type: 'hello', sessionId: ENDED_SESSION });

    const closed = logs.find((line) => line.message === 'websocket closed by server');
    expect(String(closed?.details['reason'])).toContain('ended');
  });

  it('sends the error frame before closing', async () => {
    const { connection, socket } = connect();

    await send(connection, { type: 'hello', sessionId: ENDED_SESSION });

    expect(socket.frames).toHaveLength(1);
    expect(socket.frames[0]).toMatchObject({ type: 'error', code: ErrorCode.SESSION_INVALID });
    expect(socket.closes).toHaveLength(1);
  });

  it('closes with 1011 when the session lookup fails', async () => {
    const sessions: SessionLookup = {
      ...lookup(),
      list: () => Promise.reject(new Error('connection reset')),
    };
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
      ...lookup(),
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
    expect(Buffer.byteLength(STALLED_REPLAY_CLOSE_REASON, 'utf8')).toBeLessThanOrEqual(
      MAX_CLOSE_REASON_BYTES,
    );
  });
});

// ---------------------------------------------------------------------------
// The drain a bulk writer waits on
// ---------------------------------------------------------------------------

describe('waiting for the peer to read', () => {
  /**
   * Binds a socket with back-pressure numbers a test can finish inside.
   *
   * The defaults are a 2 MiB mark, a 25 ms poll and a 30 s deadline, which are
   * production numbers rather than test ones.
   *
   * @param socket - The transport to drive.
   * @param backPressure - What to override.
   * @returns The bound socket and its connection.
   */
  async function bindWith(socket: FrameSocket, backPressure: BackPressureOptions) {
    const bound: SocketBinding[] = [];
    const built = harness({
      backPressure,
      observer: {
        bound: (binding) => {
          bound.push(binding);
          return 0;
        },
      },
    });
    const connection = built.handler.connect(socket, authenticated());
    await send(connection, { type: 'hello', sessionId: SESSION });

    const binding = bound[0];
    expect(binding).toBeDefined();
    return { binding: binding as SocketBinding, connection };
  }

  it('resolves at once for a socket that is under the mark', async () => {
    // The path every healthy listener takes, and the reason waiting per frame
    // costs an ordinary replay nothing: no timer is scheduled at all.
    const socket = bufferingSocket({ bytesPerFrame: 1_024 });
    const { binding } = await bindWith(socket, { resumeBytes: 4_096, pollIntervalMs: 1 });

    binding.send({ type: 'pong' });

    await expect(binding.drain?.()).resolves.toBe('ready');
  });

  it('resolves for a transport that does not report queued bytes', async () => {
    // Same posture as the bound itself: a figure only the transport can supply
    // buys nothing when the transport supplies none, and a writer must not
    // block forever waiting for one.
    const { binding } = await bindWith(recordingSocket(), { pollIntervalMs: 1 });

    await expect(binding.drain?.()).resolves.toBe('ready');
  });

  it('waits until the peer has read enough, then lets the writer continue', async () => {
    const socket = bufferingSocket({ bytesPerFrame: 1_000 });
    const { binding } = await bindWith(socket, {
      resumeBytes: 2_000,
      pollIntervalMs: 1,
      stallTimeoutMs: 5_000,
    });

    for (let index = 0; index < 10; index += 1) {
      binding.send({ type: 'pong' });
    }
    expect(socket.bufferedAmount).toBeGreaterThan(2_000);

    const waiting = binding.drain?.();
    let settled = false;
    void waiting?.then(() => {
      settled = true;
    });

    // Still over the mark several polls later, so still waiting. Without this
    // the test would pass against a drain that never waited for anything.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    socket.drain();
    await expect(waiting).resolves.toBe('ready');
  });

  it('waits as long as a slow peer keeps reading', async () => {
    // Progress and not patience is what is measured. This peer takes many times
    // the deadline to get under the mark and is never given up on, because it
    // never stops.
    const socket = bufferingSocket({ bytesPerFrame: 1_000 });
    const { binding } = await bindWith(socket, {
      resumeBytes: 1_000,
      pollIntervalMs: 1,
      stallTimeoutMs: 100,
    });

    for (let index = 0; index < 20; index += 1) {
      binding.send({ type: 'pong' });
    }

    // A tenth of the deadline between reads, and a fortieth of the buffer read
    // each time: many times the deadline to finish, and never a pause in it.
    const reader = setInterval(() => {
      socket.drain(500);
    }, 10);

    try {
      await expect(binding.drain?.()).resolves.toBe('ready');
    } finally {
      clearInterval(reader);
    }

    expect(socket.closes).toEqual([]);
  });

  it('closes a peer that reads nothing at all, with a reason of its own', async () => {
    // The half of T-032 that waiting must not undo: a consumer that has stopped
    // is still closed and the process is still protected. What changes is only
    // *which* condition catches it — no progress, rather than a byte count a
    // waiting writer can no longer reach.
    const socket = bufferingSocket({ bytesPerFrame: 1_000 });
    const { binding } = await bindWith(socket, {
      resumeBytes: 500,
      pollIntervalMs: 1,
      stallTimeoutMs: 5,
    });

    binding.send({ type: 'pong' });

    await expect(binding.drain?.()).resolves.toBe('closed');
    expect(lastClose(socket)).toEqual({
      code: CloseCode.BACKLOG_UNREAD,
      reason: STALLED_REPLAY_CLOSE_REASON,
    });
  });

  it('stays legible to an operator as a different event from an unread backlog', async () => {
    // The two share a close code because a client's remedy is the same: read
    // your socket, then reconnect. They are not the same event to whoever reads
    // the logs — one is a fan-out that outran a peer, the other a replay the
    // peer stopped taking — so neither the reason nor the log line is shared.
    const socket = bufferingSocket({ bytesPerFrame: 1_000 });
    const { binding } = await bindWith(socket, {
      resumeBytes: 500,
      pollIntervalMs: 1,
      stallTimeoutMs: 5,
    });

    binding.send({ type: 'pong' });
    await binding.drain?.();

    const warning = logs.find((line) => line.level === 'warn');
    expect(warning?.message).toBe(
      'websocket peer stopped reading during replay; closing it rather than waiting forever',
    );
    expect(warning?.details).toMatchObject({
      sessionId: SESSION,
      bufferedBytes: socket.bufferedAmount,
      resumeBytes: 500,
    });
    expect(STALLED_REPLAY_CLOSE_REASON).not.toBe(UNREAD_CLOSE_REASON);
  });

  it('says the socket is gone rather than waiting on one that has closed', async () => {
    const socket = bufferingSocket({ bytesPerFrame: 1_000 });
    const { binding, connection } = await bindWith(socket, {
      resumeBytes: 100,
      pollIntervalMs: 1,
      stallTimeoutMs: 5_000,
    });

    binding.send({ type: 'pong' });
    await connection.disconnected(CloseCode.NORMAL);

    await expect(binding.drain?.()).resolves.toBe('closed');
  });

  it('notices a close that happens while it is waiting', async () => {
    const socket = bufferingSocket({ bytesPerFrame: 1_000 });
    const { binding, connection } = await bindWith(socket, {
      resumeBytes: 100,
      pollIntervalMs: 1,
      stallTimeoutMs: 5_000,
    });

    binding.send({ type: 'pong' });
    const waiting = binding.drain?.();
    await connection.disconnected(CloseCode.NORMAL);

    await expect(waiting).resolves.toBe('closed');
  });
});
