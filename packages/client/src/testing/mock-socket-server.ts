/**
 * A mock AgentChat WebSocket server, as a {@link WebSocketFactory}.
 *
 * The same argument as `./mock-server.ts` makes for `fetch`. What is worth
 * testing about a reconnecting listener is what it does when a server behaves
 * in a particular way — closes with `4401` after the handshake, replays a
 * message whose acknowledgement was lost, goes away three times and then comes
 * back — and every one of those is a script, not a network. Written as a
 * script it is deterministic and takes microseconds; raced against a real
 * server it is a flake waiting for a slow CI machine.
 *
 * The listener under test cannot tell the difference: it is given a
 * {@link WebSocketConnector} built on this factory, so it exercises its own URL
 * building, header placement, framing, and every branch of its reconnect loop.
 * The real socket is tested by the end-to-end suite, against the real server,
 * which is where that belongs.
 *
 * Not part of the built package: `tsconfig.json` excludes this directory, so it
 * is type-checked but never emitted to `dist`.
 *
 * @module
 */

import { WsCloseCode } from '../websocket/frames.js';
import type {
  FrameSocket,
  OpenSocketOptions,
  SocketHandlers,
  WebSocketFactory,
} from '../websocket/socket.js';

/** One connection the listener opened, and the levers a test pulls on it. */
export class MockConnection {
  /** The absolute URL the listener connected to, query string included. */
  public readonly url: string;

  /** The headers it sent on the upgrade. */
  public readonly headers: Readonly<Record<string, string>>;

  /** Every frame the listener sent, parsed, in order. */
  public readonly received: unknown[] = [];

  /** Called for each frame the listener sends, so a test can answer it. */
  public onFrame: ((frame: unknown, connection: MockConnection) => void) | null = null;

  readonly #handlers: SocketHandlers;
  #open = false;
  #closed = false;

  /**
   * @param options - Where the listener connected and what it sent.
   * @param handlers - Where to report this connection's lifecycle.
   */
  public constructor(options: OpenSocketOptions, handlers: SocketHandlers) {
    this.url = options.url;
    this.headers = { ...options.headers };
    this.#handlers = handlers;
  }

  /** Whether the upgrade has been accepted. */
  public get isOpen(): boolean {
    return this.#open && !this.#closed;
  }

  /** Whether this connection has ended. */
  public get isClosed(): boolean {
    return this.#closed;
  }

  /** The `hello` frames received on this connection. Should always be one. */
  public get hellos(): Record<string, unknown>[] {
    return this.framesOfType('hello');
  }

  /** The `ack` frames received on this connection. */
  public get acks(): Record<string, unknown>[] {
    return this.framesOfType('ack');
  }

  /**
   * The frames of one type this connection received.
   *
   * @param type - The frame type to filter on.
   * @returns Those frames, in order.
   */
  public framesOfType(type: string): Record<string, unknown>[] {
    return this.received.filter(
      (frame): frame is Record<string, unknown> =>
        typeof frame === 'object' &&
        frame !== null &&
        (frame as Record<string, unknown>)['type'] === type,
    );
  }

  /** Accepts the upgrade. */
  public accept(): void {
    if (this.#open || this.#closed) {
      return;
    }
    this.#open = true;
    this.#handlers.onOpen();
  }

  /**
   * Sends one server frame.
   *
   * @param frame - The frame, serialised as JSON.
   */
  public deliver(frame: unknown): void {
    this.deliverRaw(JSON.stringify(frame));
  }

  /**
   * Sends whatever text is given, valid or not.
   *
   * @param text - The exact bytes to deliver.
   */
  public deliverRaw(text: string): void {
    if (!this.#closed) {
      this.#handlers.onData(text);
    }
  }

  /**
   * Closes the connection from the server's side.
   *
   * @param code - The close code. Defaults to a normal closure.
   * @param reason - The close reason.
   */
  public closeWith(code: number = WsCloseCode.NORMAL, reason = ''): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#handlers.onClose(code, reason);
  }

  /**
   * Refuses the upgrade the way a browser reports one: an error, then an
   * opaque `1006`. This is what an HTTP 401 on the upgrade looks like from the
   * client's side, and the reason the listener cannot simply read a status.
   */
  public refuse(): void {
    this.#handlers.onError(new Error('connection failed'));
    this.closeWith(WsCloseCode.ABNORMAL, '');
  }

  /** The socket handle handed to the listener. */
  public get socket(): FrameSocket {
    return {
      send: (text: string): void => {
        if (this.#closed) {
          throw new Error('send on a closed mock socket');
        }
        let frame: unknown;
        try {
          frame = JSON.parse(text) as unknown;
        } catch {
          frame = text;
        }
        this.received.push(frame);
        this.onFrame?.(frame, this);
      },
      close: (code: number, reason: string): void => {
        // A real peer answers a close with a close. Reporting it back is what
        // lets a test see a locally-initiated shutdown end the stream.
        this.closeWith(code, reason);
      },
    };
  }
}

/** What a test does with each new connection. */
export type MockSocketBehaviour = (connection: MockConnection, index: number) => void;

/**
 * A scripted server the listener connects to.
 *
 * The behaviour runs synchronously as the connection is created, which is when
 * a real server would be deciding whether to accept the upgrade. Answering
 * `hello` is done from {@link MockConnection.onFrame}, because that is when a
 * real server would answer it.
 */
export class MockSocketServer {
  /** Every connection, in the order the listener opened them. */
  public readonly connections: MockConnection[] = [];

  readonly #behaviour: MockSocketBehaviour;

  /**
   * @param behaviour - What to do with each connection.
   */
  public constructor(behaviour: MockSocketBehaviour) {
    this.#behaviour = behaviour;
  }

  /** How many times the listener has connected. */
  public get connectionCount(): number {
    return this.connections.length;
  }

  /**
   * The nth connection.
   *
   * @param index - Zero-based, negative counting from the end.
   * @returns That connection.
   * @throws {Error} If there is no such connection, which is a clearer failure
   *   than an assertion on `undefined`.
   */
  public connection(index: number): MockConnection {
    const at = index < 0 ? this.connections.length + index : index;
    const connection = this.connections[at];
    if (connection === undefined) {
      throw new Error(`No connection at index ${index}; there are ${this.connections.length}.`);
    }
    return connection;
  }

  /** The factory to hand to a {@link WebSocketConnector}. */
  public get factory(): WebSocketFactory {
    return (options, handlers): FrameSocket => {
      const connection = new MockConnection(options, handlers);
      this.connections.push(connection);
      this.#behaviour(connection, this.connections.length - 1);
      return connection.socket;
    };
  }
}

/**
 * Answers a `hello` the way the server does: replay, then `ready`.
 *
 * @param pending - The messages to replay before `ready`.
 * @returns A frame handler for {@link MockConnection.onFrame}.
 */
export function respondToHello(
  pending: readonly Record<string, unknown>[] = [],
): (frame: unknown, connection: MockConnection) => void {
  return (frame, connection): void => {
    if (!isFrameOfType(frame, 'hello')) {
      return;
    }
    for (const message of pending) {
      connection.deliver({ type: 'message', message });
    }
    connection.deliver({
      type: 'ready',
      sessionId: (frame as Record<string, unknown>)['sessionId'],
      pending: pending.length,
    });
  };
}

/**
 * Whether a frame is of a given type.
 *
 * @param frame - The parsed frame.
 * @param type - The type to test for.
 * @returns `true` if it matches.
 */
export function isFrameOfType(frame: unknown, type: string): boolean {
  return (
    typeof frame === 'object' &&
    frame !== null &&
    (frame as Record<string, unknown>)['type'] === type
  );
}

/**
 * Waits until a condition holds.
 *
 * Polling rather than a timer the test controls: the listener's own waits are
 * real timers configured down to a few milliseconds, so a test that advanced a
 * fake clock would be asserting on the clock rather than on the listener.
 *
 * @param predicate - What to wait for.
 * @param description - What to say if it never happens.
 * @param timeoutMs - How long to wait before giving up.
 * @returns When the condition holds.
 * @throws {Error} If it does not hold in time.
 */
export async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
