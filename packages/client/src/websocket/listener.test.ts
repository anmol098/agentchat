import {
  CLIENT_VERSION_HEADER,
  ErrorCode,
  type MessageId,
  MessageId as MessageIds,
  SessionId,
} from '@stackgrid/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { Credentials } from '../credentials.js';
import { InMemoryCredentialStore } from '../credentials.js';
import { ApiError } from '../errors.js';
import { type MockConnection, MockSocketServer, waitFor } from '../testing/mock-socket-server.js';
import { TokenManager } from '../tokens.js';
import type { DeliveredMessage } from './frames.js';
import { WsCloseCode } from './frames.js';
import type { ListenerProblem, ListenerStatus, SessionListenerOptions } from './listener.js';
import { SessionListener } from './listener.js';
import { WebSocketConnector } from './socket.js';

/** The session every listener in this file binds to. */
const SESSION_ID = SessionId.generate();

/**
 * A backoff short enough for a test and with no randomness, so an assertion can
 * name the exact delay. The jitter itself is tested in `./backoff.test.ts`.
 */
const FAST_BACKOFF = { initialDelayMs: 2, maxDelayMs: 8, jitterRatio: 0, random: (): number => 1 };

/** Everything a test needs to drive one listener and watch what it did. */
interface Harness {
  readonly server: MockSocketServer;
  readonly listener: SessionListener;
  readonly store: InMemoryCredentialStore;
  readonly statuses: ListenerStatus[];
  readonly messages: DeliveredMessage[];
  readonly duplicates: MessageId[];
  readonly problems: ListenerProblem[];
  /** The refresh tokens the token manager actually spent. */
  readonly refreshes: string[];
}

/** Listeners to stop when a test finishes, so nothing reconnects into the next one. */
const running: SessionListener[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((listener) => listener.stop()));
});

/**
 * Builds a listener against a scripted server.
 *
 * The real {@link TokenManager} is used rather than a stub: the refresh path
 * under test is the one that spends a rotating refresh token, and a stub that
 * always succeeded would not prove the listener uses the manager that
 * serialises those.
 *
 * @param behaviour - What the server does with each connection.
 * @param options - Listener options to override.
 * @param initial - The credentials to start with, or `null` for logged out.
 * @returns The harness.
 */
function harness(
  behaviour: (connection: MockConnection, index: number) => void,
  options: Partial<SessionListenerOptions> = {},
  initial: Credentials | null = { accessToken: 'at-1', refreshToken: 'rt-1' },
): Harness {
  const server = new MockSocketServer(behaviour);
  const store = new InMemoryCredentialStore(initial);
  const refreshes: string[] = [];
  let issued = 1;

  const tokens = new TokenManager(store, (refreshToken) => {
    refreshes.push(refreshToken);
    if (refreshToken === 'rt-dead') {
      return Promise.reject(new ApiError(401, ErrorCode.AUTH_REQUIRED, 'gone'));
    }
    issued += 1;
    return Promise.resolve({ accessToken: `at-${issued}`, refreshToken: `rt-${issued}` });
  });

  const listener = new SessionListener({
    connector: new WebSocketConnector({
      baseUrl: 'https://chat.example.test',
      webSocketFactory: server.factory,
    }),
    tokens,
    sessionId: SESSION_ID,
    backoff: FAST_BACKOFF,
    handshakeTimeoutMs: 500,
    heartbeat: null,
    ...options,
  });
  running.push(listener);

  const statuses: ListenerStatus[] = [];
  const messages: DeliveredMessage[] = [];
  const duplicates: MessageId[] = [];
  const problems: ListenerProblem[] = [];

  listener.on('status', (status) => statuses.push(status));
  listener.on('message', (message) => messages.push(message));
  listener.on('duplicate', ({ messageId }) => duplicates.push(messageId));
  listener.on('error', (problem) => problems.push(problem));

  return { server, listener, store, statuses, messages, duplicates, problems, refreshes };
}

/**
 * The server behaviour that accepts a connection and completes the handshake.
 *
 * @param pending - Messages to replay before `ready`, per connection index.
 * @returns The behaviour.
 */
function servesHandshake(
  pending: (index: number) => readonly Record<string, unknown>[] = () => [],
): (connection: MockConnection, index: number) => void {
  return (connection, index): void => {
    connection.accept();
    connection.onFrame = (frame): void => {
      if (!isHello(frame)) {
        return;
      }
      const replay = pending(index);
      for (const message of replay) {
        connection.deliver({ type: 'message', message });
      }
      connection.deliver({ type: 'ready', sessionId: SESSION_ID, pending: replay.length });
    };
  };
}

/**
 * Whether a frame is a `hello`.
 *
 * @param frame - The parsed frame.
 * @returns `true` if it is.
 */
function isHello(frame: unknown): boolean {
  return (
    typeof frame === 'object' &&
    frame !== null &&
    (frame as Record<string, unknown>)['type'] === 'hello'
  );
}

/** A message payload with a real identifier and a field this build has no schema for. */
function message(messageId: MessageId, content = 'ship it'): Record<string, unknown> {
  return {
    messageId,
    projectId: 'prj_x',
    sender: '@bob/backend',
    content,
  };
}

/** The states in the order they were reported. */
function states(harnessed: Harness): ListenerStatus['state'][] {
  return harnessed.statuses.map((status) => status.state);
}

describe('SessionListener: connecting', () => {
  it('binds the socket with hello and reports the replayed backlog', async () => {
    const first = MessageIds.generate();
    const test = harness(servesHandshake((index) => (index === 0 ? [message(first)] : [])));

    test.listener.start();
    await waitFor(() => test.listener.state === 'connected', 'the handshake to complete');

    expect(test.server.connection(0).hellos).toEqual([{ type: 'hello', sessionId: SESSION_ID }]);
    expect(test.statuses).toContainEqual({
      state: 'connected',
      sessionId: SESSION_ID,
      pending: 1,
    });
    expect(test.messages.map((entry) => entry.messageId)).toEqual([first]);
  });

  it('puts the client identifier in hello when the embedder supplies one', async () => {
    const test = harness(servesHandshake(), { client: 'agentchat/0.1.0' });

    test.listener.start();
    await waitFor(() => test.listener.state === 'connected', 'the handshake to complete');

    expect(test.server.connection(0).hellos[0]).toMatchObject({ client: 'agentchat/0.1.0' });
  });

  it('announces the client version on the upgrade as well as in hello', async () => {
    const test = harness(servesHandshake(), { client: 'agentchat/0.1.0' });

    test.listener.start();
    await waitFor(() => test.listener.state === 'connected', 'the handshake to complete');

    // The header is the half the server can act on. Protocol §2.2 says the CLI
    // sends it on every HTTP request and an upgrade is one, so the floor the
    // server enforces there reaches this client. `hello` alone arrives after
    // the handshake, too late for anything but a close code.
    expect(test.server.connection(0).headers[CLIENT_VERSION_HEADER]).toBe('agentchat/0.1.0');
  });

  it('sends no client header when the embedder is not the CLI', async () => {
    const test = harness(servesHandshake());

    test.listener.start();
    await waitFor(() => test.listener.state === 'connected', 'the handshake to complete');

    // A harness embedding this package has no version to claim, and the server
    // serves an upgrade without the header rather than refusing it. Sending an
    // invented one would put a third party into a negotiation it is not in.
    expect(test.server.connection(0).headers[CLIENT_VERSION_HEADER]).toBeUndefined();
  });

  it('re-sends the client header on every reconnect, not only the first', async () => {
    const test = harness(
      (connection, index) => {
        servesHandshake()(connection, index);
        if (index === 0) {
          const answer = connection.onFrame;
          connection.onFrame = (frame, self): void => {
            answer?.(frame, self);
            if (isHello(frame)) {
              self.closeWith(WsCloseCode.INTERNAL_ERROR, 'restarting');
            }
          };
        }
      },
      { client: 'agentchat/0.1.0' },
    );

    test.listener.start();
    await waitFor(() => test.server.connectionCount === 2, 'a reconnect');
    await waitFor(() => test.listener.state === 'connected', 'the second handshake');

    // A floor that bound only the first upgrade would be a floor a listener
    // outlives by reconnecting, which is no floor at all.
    for (const connection of test.server.connections) {
      expect(connection.headers[CLIENT_VERSION_HEADER]).toBe('agentchat/0.1.0');
    }
  });

  it('starting twice does not open a second connection', async () => {
    const test = harness(servesHandshake());

    test.listener.start();
    test.listener.start();
    await waitFor(() => test.listener.state === 'connected', 'the handshake to complete');

    expect(test.server.connectionCount).toBe(1);
  });

  it('refuses a session id that is not one', () => {
    expect(() => harness(servesHandshake(), { sessionId: 'not-a-session' })).toThrowError(
      expect.objectContaining({ code: ErrorCode.BAD_REQUEST }),
    );
  });
});

describe('SessionListener: reconnecting', () => {
  it('re-sends hello on every reconnect, which is what makes the server replay', async () => {
    const test = harness((connection, index) => {
      servesHandshake()(connection, index);
      if (index < 2) {
        // Drop the connection once the handshake is complete, the way a server
        // restart does.
        const answer = connection.onFrame;
        connection.onFrame = (frame, self): void => {
          answer?.(frame, self);
          if (isHello(frame)) {
            self.closeWith(WsCloseCode.INTERNAL_ERROR, 'restarting');
          }
        };
      }
    });

    test.listener.start();
    await waitFor(() => test.server.connectionCount === 3, 'three connections');
    await waitFor(() => test.listener.state === 'connected', 'the third handshake');

    // Every socket says hello exactly once. A reconnect that skipped it would
    // come back connected and permanently empty.
    for (const connection of test.server.connections) {
      expect(connection.hellos).toHaveLength(1);
    }
  });

  it('waits the backoff schedule between attempts and reports the delay', async () => {
    const test = harness((connection) => {
      connection.accept();
      connection.onFrame = (frame, self): void => {
        if (isHello(frame)) {
          self.closeWith(WsCloseCode.INTERNAL_ERROR, 'still restarting');
        }
      };
    });

    test.listener.start();
    await waitFor(() => test.server.connectionCount >= 4, 'four attempts');

    const delays = test.statuses
      .filter((status) => status.state === 'reconnecting')
      .map((status) => (status.state === 'reconnecting' ? status.delayMs : -1));

    // 2, 4, 8, then held at the cap. With jitterRatio 0 the schedule is exact;
    // the jitter that spreads a real fleet is asserted in backoff.test.ts.
    expect(delays.slice(0, 4)).toEqual([2, 4, 8, 8]);
  });

  it('starts a new streak once a connection has reached ready', async () => {
    let dropped = 0;
    const test = harness((connection, index) => {
      servesHandshake()(connection, index);
      const answer = connection.onFrame;
      connection.onFrame = (frame, self): void => {
        answer?.(frame, self);
        if (isHello(frame) && dropped < 2) {
          dropped += 1;
          self.closeWith(WsCloseCode.GOING_AWAY, 'upgrading');
        }
      };
    });

    test.listener.start();
    await waitFor(() => test.server.connectionCount >= 3, 'a third connection');
    await waitFor(() => test.listener.state === 'connected', 'a working connection');

    const delays = test.statuses
      .filter((status) => status.state === 'reconnecting')
      .map((status) => (status.state === 'reconnecting' ? status.delayMs : -1));

    // Each drop happened after a successful handshake, so each wait is the
    // first of its own streak rather than inheriting the previous outage's
    // delay. Without the reset a server that dropped a listener once an hour
    // would eventually have it waiting thirty seconds to come back.
    expect(delays).toEqual([2, 2]);
  });

  it('reconnects when a connection opens but never says ready', async () => {
    const test = harness(
      (connection, index) => {
        connection.accept();
        if (index > 0) {
          servesHandshake()(connection, index);
        }
      },
      { handshakeTimeoutMs: 20 },
    );

    test.listener.start();
    await waitFor(() => test.listener.state === 'connected', 'the second connection to bind');

    expect(test.server.connectionCount).toBe(2);
    expect(test.server.connection(0).isClosed).toBe(true);
  });
});

describe('SessionListener: deduplication', () => {
  it('delivers a replayed message once, so a lost acknowledgement is invisible', async () => {
    const replayed = MessageIds.generate();
    const fresh = MessageIds.generate();

    // Connection 0 delivers the message and drops before its ack can land.
    // Connection 1 replays it, exactly as the inbox does for anything pending.
    const test = harness((connection, index) => {
      connection.accept();
      connection.onFrame = (frame, self): void => {
        if (!isHello(frame)) {
          return;
        }
        if (index === 0) {
          self.deliver({ type: 'message', message: message(replayed) });
          self.deliver({ type: 'ready', sessionId: SESSION_ID, pending: 1 });
          self.closeWith(WsCloseCode.ABNORMAL, 'dropped before the ack landed');
          return;
        }
        self.deliver({ type: 'message', message: message(replayed) });
        self.deliver({ type: 'message', message: message(fresh) });
        self.deliver({ type: 'ready', sessionId: SESSION_ID, pending: 2 });
      };
    });

    test.listener.on('message', (delivered) => {
      test.listener.ack(delivered.messageId);
    });
    test.listener.start();
    await waitFor(() => test.messages.length === 2, 'both distinct messages');

    expect(test.messages.map((entry) => entry.messageId)).toEqual([replayed, fresh]);
    expect(test.duplicates).toEqual([replayed]);
  });

  it('suppresses a duplicate arriving on the same connection', async () => {
    const messageId = MessageIds.generate();
    const test = harness((connection) => {
      connection.accept();
      connection.onFrame = (frame, self): void => {
        if (!isHello(frame)) {
          return;
        }
        self.deliver({ type: 'message', message: message(messageId) });
        self.deliver({ type: 'message', message: message(messageId) });
        self.deliver({ type: 'ready', sessionId: SESSION_ID, pending: 1 });
      };
    });

    test.listener.start();
    await waitFor(() => test.listener.state === 'connected', 'the handshake');

    expect(test.messages).toHaveLength(1);
    expect(test.duplicates).toEqual([messageId]);
    expect(test.listener.seenCount).toBe(1);
  });

  it('hands the consumer every field of the payload, including ones it cannot type', async () => {
    const messageId = MessageIds.generate();
    const test = harness((connection) => {
      connection.accept();
      connection.onFrame = (frame, self): void => {
        if (isHello(frame)) {
          self.deliver({
            type: 'message',
            message: { messageId, conversationId: 'cnv_1', somethingNewer: [1, 2] },
          });
          self.deliver({ type: 'ready', sessionId: SESSION_ID, pending: 1 });
        }
      };
    });

    test.listener.start();
    await waitFor(() => test.messages.length === 1, 'the message');

    expect(test.messages[0]).toEqual({
      messageId,
      conversationId: 'cnv_1',
      somethingNewer: [1, 2],
    });
  });
});

describe('SessionListener: acknowledgement', () => {
  it('sends an ack on the connection that delivered the message', async () => {
    const messageId = MessageIds.generate();
    const test = harness((connection) => {
      connection.accept();
      connection.onFrame = (frame, self): void => {
        if (isHello(frame)) {
          self.deliver({ type: 'message', message: message(messageId) });
          self.deliver({ type: 'ready', sessionId: SESSION_ID, pending: 1 });
        }
      };
    });

    test.listener.on('message', (delivered) => {
      expect(test.listener.ack(delivered.messageId)).toBe(true);
    });
    test.listener.start();
    await waitFor(
      () => test.server.connectionCount > 0 && test.server.connection(0).acks.length === 1,
      'the ack',
    );

    expect(test.server.connection(0).acks).toEqual([{ type: 'ack', messageId }]);
  });

  it('refuses to acknowledge when there is no connection to do it on', async () => {
    const test = harness(servesHandshake());

    // Nothing is queued for later: the message is still pending server-side, so
    // the next hello replays it and deduplication keeps that invisible.
    expect(test.listener.ack(MessageIds.generate())).toBe(false);

    test.listener.start();
    await waitFor(() => test.listener.state === 'connected', 'the handshake');
    await test.listener.stop();

    expect(test.listener.ack(MessageIds.generate())).toBe(false);
  });
});

describe('SessionListener: token refresh', () => {
  it('refreshes an expired access token mid-connection and retries without prompting', async () => {
    const test = harness((connection, index) => {
      connection.accept();
      connection.onFrame = (frame, self): void => {
        if (!isHello(frame)) {
          return;
        }
        if (index === 0) {
          // An hour into a run the access token expires; the server closes.
          self.deliver({ type: 'ready', sessionId: SESSION_ID, pending: 0 });
          self.deliver({ type: 'error', code: ErrorCode.AUTH_REQUIRED, message: 'expired' });
          self.closeWith(WsCloseCode.UNAUTHENTICATED, 'token expired');
          return;
        }
        self.deliver({ type: 'ready', sessionId: SESSION_ID, pending: 0 });
      };
    });

    test.listener.start();
    await waitFor(() => test.server.connectionCount === 2, 'a second connection');
    await waitFor(() => test.listener.state === 'connected', 'the reconnect to bind');

    // One refresh, spending exactly the stored refresh token, and the new
    // access token on the retry. No interaction with a user anywhere.
    expect(test.refreshes).toEqual(['rt-1']);
    expect(test.server.connection(1).headers['authorization']).toBe('Bearer at-2');
    await expect(test.store.load()).resolves.toEqual({
      accessToken: 'at-2',
      refreshToken: 'rt-2',
    });
    expect(states(test)).not.toContain('closed');
  });

  it('gives up when a token minted seconds ago is refused as well', async () => {
    const test = harness((connection) => {
      connection.accept();
      connection.onFrame = (frame, self): void => {
        if (isHello(frame)) {
          self.closeWith(WsCloseCode.UNAUTHENTICATED, 'token rejected');
        }
      };
    });

    test.listener.start();
    await waitFor(() => test.listener.state === 'closed', 'the listener to give up');

    // One refresh and one retry, the same budget the HTTP pipeline uses.
    expect(test.refreshes).toEqual(['rt-1']);
    expect(test.server.connectionCount).toBe(2);
    expect(test.statuses.at(-1)).toMatchObject({
      state: 'closed',
      reason: 'unauthenticated',
      error: expect.objectContaining({ code: ErrorCode.AUTH_REQUIRED }),
    });
  });

  it('stops when the refresh token itself is dead', async () => {
    const test = harness(
      (connection) => {
        connection.accept();
        connection.onFrame = (frame, self): void => {
          if (isHello(frame)) {
            self.closeWith(WsCloseCode.UNAUTHENTICATED, 'token rejected');
          }
        };
      },
      {},
      { accessToken: 'at-1', refreshToken: 'rt-dead' },
    );

    test.listener.start();
    await waitFor(() => test.listener.state === 'closed', 'the listener to give up');

    expect(test.statuses.at(-1)).toMatchObject({ state: 'closed', reason: 'unauthenticated' });
    // The manager clears a revoked chain, so the next command asks for a login
    // rather than replaying a dead token.
    await expect(test.store.load()).resolves.toBeNull();
  });

  it('spends one refresh per outage when the upgrade is refused opaquely', async () => {
    // A server that answers the upgrade with HTTP 401 gives the client a bare
    // 1006, indistinguishable from a network failure — so a failure that never
    // opened a socket is worth exactly one refresh, and not one per attempt.
    const test = harness((connection, index) => {
      if (index < 3) {
        connection.refuse();
        return;
      }
      servesHandshake()(connection, index);
    });

    test.listener.start();
    await waitFor(() => test.listener.state === 'connected', 'the eventual connection');

    expect(test.refreshes).toEqual(['rt-1']);
    expect(test.server.connectionCount).toBe(4);
  });

  it('stops immediately when nobody is signed in', async () => {
    const test = harness(servesHandshake(), {}, null);

    test.listener.start();
    await waitFor(() => test.listener.state === 'closed', 'the listener to stop');

    expect(test.server.connectionCount).toBe(0);
    expect(test.statuses.at(-1)).toMatchObject({
      state: 'closed',
      reason: 'unauthenticated',
      error: expect.objectContaining({ code: ErrorCode.AUTH_REQUIRED }),
    });
  });
});

describe('SessionListener: permanent refusal', () => {
  it('stops on an invalid session rather than retrying forever', async () => {
    const test = harness((connection) => {
      connection.accept();
      connection.onFrame = (frame, self): void => {
        if (isHello(frame)) {
          self.deliver({
            type: 'error',
            code: ErrorCode.SESSION_INVALID,
            message: 'No usable session with that id. Start a new listener with: agentchat listen',
          });
          self.closeWith(WsCloseCode.SESSION_INVALID, 'session ended');
        }
      };
    });

    test.listener.start();
    await waitFor(() => test.listener.state === 'closed', 'the listener to give up');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(test.server.connectionCount).toBe(1);
    expect(test.statuses.at(-1)).toMatchObject({
      state: 'closed',
      reason: 'refused',
      // The server's own words, including the remedy, rather than a number.
      error: expect.objectContaining({
        code: ErrorCode.SESSION_INVALID,
        message: expect.stringContaining('agentchat listen'),
      }),
      closure: expect.objectContaining({ code: WsCloseCode.SESSION_INVALID }),
    });
  });

  it.each([
    ['a malformed frame', WsCloseCode.FRAME_MALFORMED, ErrorCode.PROTOCOL_VIOLATION],
    ['an out-of-order frame', WsCloseCode.FRAME_OUT_OF_ORDER, ErrorCode.PROTOCOL_VIOLATION],
    ['an oversize frame', WsCloseCode.FRAME_TOO_LARGE, ErrorCode.PAYLOAD_TOO_LARGE],
  ])('stops on %s and reports a code the caller can branch on', async (_label, close, code) => {
    const test = harness((connection) => {
      connection.accept();
      connection.onFrame = (frame, self): void => {
        if (isHello(frame)) {
          self.closeWith(close, 'refused');
        }
      };
    });

    test.listener.start();
    await waitFor(() => test.listener.state === 'closed', 'the listener to give up');

    expect(test.server.connectionCount).toBe(1);
    expect(test.statuses.at(-1)).toMatchObject({
      state: 'closed',
      reason: 'refused',
      error: expect.objectContaining({ code }),
    });
  });
});

describe('SessionListener: frames it cannot use', () => {
  it('ignores a frame type from a newer server and keeps delivering', async () => {
    const messageId = MessageIds.generate();
    const test = harness((connection) => {
      connection.accept();
      connection.onFrame = (frame, self): void => {
        if (isHello(frame)) {
          self.deliver({ type: 'presence', agentId: 'agt_x', state: 'online' });
          self.deliver({ type: 'message', message: message(messageId) });
          self.deliver({ type: 'ready', sessionId: SESSION_ID, pending: 0 });
        }
      };
    });

    test.listener.start();
    await waitFor(() => test.listener.state === 'connected', 'the handshake');

    // Additive-only: an unknown frame type is not an error and is not reported
    // as one, or every protocol addition becomes a flag day.
    expect(test.problems).toEqual([]);
    expect(test.messages).toHaveLength(1);
  });

  it('reports an unreadable frame without tearing down the connection', async () => {
    const messageId = MessageIds.generate();
    const test = harness((connection) => {
      connection.accept();
      connection.onFrame = (frame, self): void => {
        if (isHello(frame)) {
          self.deliverRaw('{not json at all');
          self.deliver({ type: 'message', message: message(messageId) });
          self.deliver({ type: 'ready', sessionId: SESSION_ID, pending: 0 });
        }
      };
    });

    test.listener.start();
    await waitFor(() => test.listener.state === 'connected', 'the handshake');

    expect(test.problems.map((problem) => problem.phase)).toEqual(['frame']);
    expect(test.server.connectionCount).toBe(1);
    expect(test.messages).toHaveLength(1);
  });

  it('reports a server error frame that does not end the connection', async () => {
    const test = harness((connection) => {
      connection.accept();
      connection.onFrame = (frame, self): void => {
        if (isHello(frame)) {
          self.deliver({ type: 'error', code: ErrorCode.INTERNAL, message: 'delivery failed' });
          self.deliver({ type: 'ready', sessionId: SESSION_ID, pending: 0 });
        }
      };
    });

    test.listener.start();
    await waitFor(() => test.listener.state === 'connected', 'the handshake');

    expect(test.problems.map((problem) => problem.phase)).toEqual(['server']);
  });

  it('survives a handler of its own that throws', async () => {
    const test = harness((connection) => {
      connection.accept();
      connection.onFrame = (frame, self): void => {
        if (isHello(frame)) {
          self.deliver({ type: 'message', message: message(MessageIds.generate()) });
          self.deliver({ type: 'ready', sessionId: SESSION_ID, pending: 1 });
        }
      };
    });

    test.listener.on('message', () => {
      throw new Error('the consumer blew up');
    });
    test.listener.start();
    await waitFor(() => test.listener.state === 'connected', 'the handshake');

    expect(test.problems.map((problem) => problem.phase)).toEqual(['handler']);
    expect(test.listener.state).toBe('connected');
  });
});

describe('SessionListener: liveness', () => {
  it('pings a silent socket and reconnects when nothing answers', async () => {
    const test = harness(
      (connection, index) => {
        connection.accept();
        connection.onFrame = (frame, self): void => {
          if (isHello(frame)) {
            self.deliver({ type: 'ready', sessionId: SESSION_ID, pending: 0 });
          }
          // The second connection answers its ping; the first never does, which
          // is what a half-open socket looks like from this end.
          if (index > 0 && !isHello(frame)) {
            self.deliver({ type: 'pong' });
          }
        };
      },
      { heartbeat: { intervalMs: 10, responseTimeoutMs: 15 } },
    );

    test.listener.start();
    await waitFor(() => test.server.connectionCount === 2, 'a reconnect after the silence');

    expect(test.server.connection(0).framesOfType('ping')).toHaveLength(1);
    expect(test.server.connection(0).isClosed).toBe(true);
    await waitFor(() => test.listener.state === 'connected', 'the replacement connection');
  });
});

describe('SessionListener: stopping', () => {
  it('closes the socket, reports why, and does not reconnect', async () => {
    const test = harness(servesHandshake());

    test.listener.start();
    await waitFor(() => test.listener.state === 'connected', 'the handshake');
    await test.listener.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(test.server.connection(0).isClosed).toBe(true);
    expect(test.server.connectionCount).toBe(1);
    expect(test.statuses.at(-1)).toEqual({
      state: 'closed',
      reason: 'stopped',
      error: null,
      closure: null,
    });
  });

  it('is safe to stop a listener that was never started, or to stop twice', async () => {
    const test = harness(servesHandshake());

    await test.listener.stop();
    test.listener.start();
    await waitFor(() => test.listener.state === 'connected', 'the handshake');
    await test.listener.stop();
    await test.listener.stop();

    expect(test.listener.state).toBe('closed');
  });

  it('stops a reconnect that is waiting out its backoff', async () => {
    const test = harness(
      (connection) => {
        connection.accept();
        connection.onFrame = (frame, self): void => {
          if (isHello(frame)) {
            self.closeWith(WsCloseCode.INTERNAL_ERROR, 'restarting');
          }
        };
      },
      { backoff: { initialDelayMs: 5_000, maxDelayMs: 30_000 } },
    );

    test.listener.start();
    await waitFor(
      () => test.statuses.some((status) => status.state === 'reconnecting'),
      'the first backoff',
    );

    // Waiting out a five-second delay would make `stop` look hung to anyone
    // pressing Ctrl-C.
    const started = Date.now();
    await test.listener.stop();

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(test.listener.state).toBe('closed');
  });

  it('unsubscribes a handler that asked to be removed', async () => {
    const test = harness(servesHandshake());
    const seen: ListenerStatus[] = [];
    const unsubscribe = test.listener.on('status', (status) => seen.push(status));

    unsubscribe();
    test.listener.start();
    await waitFor(() => test.listener.state === 'connected', 'the handshake');

    expect(seen).toEqual([]);
    expect(test.statuses.length).toBeGreaterThan(0);
  });
});
