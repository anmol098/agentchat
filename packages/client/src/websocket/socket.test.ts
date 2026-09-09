import { ErrorCode } from '@agentchat/protocol';
import { describe, expect, it } from 'vitest';

import { TransportError } from '../errors.js';
import { MockSocketServer, waitFor } from '../testing/mock-socket-server.js';
import { WsCloseCode } from './frames.js';
import type { FrameSocket, SocketHandlers, WebSocketFactory } from './socket.js';
import { ACCESS_TOKEN_QUERY_PARAMETER, closureOf, WebSocketConnector } from './socket.js';

/** The origin every connector in this file points at. */
const BASE_URL = 'https://chat.example.test';

/** A bearer header, as the listener supplies one. */
const AUTHORIZED = { authorization: 'Bearer at-1' } as const;

describe('WebSocketConnector.connect', () => {
  it('maps the http origin onto a websocket scheme', async () => {
    const server = new MockSocketServer((connection) => {
      connection.accept();
    });
    const connector = new WebSocketConnector({
      baseUrl: BASE_URL,
      webSocketFactory: server.factory,
    });

    const stream = await connector.connect({ path: '/ws', headers: AUTHORIZED });
    stream.close();

    expect(server.connection(0).url).toBe('wss://chat.example.test/ws');
  });

  it('uses ws for a plaintext origin', async () => {
    const server = new MockSocketServer((connection) => {
      connection.accept();
    });
    const connector = new WebSocketConnector({
      baseUrl: 'http://localhost:8080',
      webSocketFactory: server.factory,
    });

    const stream = await connector.connect({ path: '/ws', headers: AUTHORIZED });
    stream.close();

    expect(server.connection(0).url).toBe('ws://localhost:8080/ws');
  });

  it('sends the credential as a header by default', async () => {
    const server = new MockSocketServer((connection) => {
      connection.accept();
    });
    const connector = new WebSocketConnector({
      baseUrl: BASE_URL,
      webSocketFactory: server.factory,
    });

    const stream = await connector.connect({ path: '/ws', headers: AUTHORIZED });
    stream.close();

    expect(server.connection(0).headers['authorization']).toBe('Bearer at-1');
    expect(server.connection(0).url).not.toContain('at-1');
  });

  it('moves the credential into the query string for a client that cannot set headers', async () => {
    const server = new MockSocketServer((connection) => {
      connection.accept();
    });
    const connector = new WebSocketConnector({
      baseUrl: BASE_URL,
      credentialsIn: 'query',
      webSocketFactory: server.factory,
    });

    const stream = await connector.connect({ path: '/ws', headers: AUTHORIZED });
    stream.close();

    const connection = server.connection(0);
    // Moved, not copied: a token in both places is a token in a log for nothing.
    expect(connection.headers['authorization']).toBeUndefined();
    expect(new URL(connection.url).searchParams.get(ACCESS_TOKEN_QUERY_PARAMETER)).toBe('at-1');
  });

  it('rejects with the close code when the upgrade is refused', async () => {
    const server = new MockSocketServer((connection) => {
      connection.closeWith(WsCloseCode.SESSION_INVALID, 'no such session');
    });
    const connector = new WebSocketConnector({
      baseUrl: BASE_URL,
      webSocketFactory: server.factory,
    });

    const failure = await connector
      .connect({ path: '/ws', headers: AUTHORIZED })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TransportError);
    // The reconnect loop cannot tell permanent from transient without this.
    expect(closureOf(failure)?.code).toBe(WsCloseCode.SESSION_INVALID);
  });

  it('reports no closure for a failure that was not a close', () => {
    expect(closureOf(new TransportError('nothing to do with a socket'))).toBeNull();
    expect(closureOf('not even an error')).toBeNull();
  });

  it('refuses to open when the runtime has no WebSocket and none was supplied', async () => {
    const connector = new WebSocketConnector({ baseUrl: BASE_URL });
    const original = (globalThis as { WebSocket?: unknown }).WebSocket;
    delete (globalThis as { WebSocket?: unknown }).WebSocket;

    try {
      await expect(connector.connect({ path: '/ws', headers: AUTHORIZED })).rejects.toBeInstanceOf(
        TransportError,
      );
    } finally {
      (globalThis as { WebSocket?: unknown }).WebSocket = original;
    }
  });

  it('refuses a base url that is not an absolute http origin', () => {
    expect(() => new WebSocketConnector({ baseUrl: 'chat.example.test' })).toThrowError(
      expect.objectContaining({ code: ErrorCode.BAD_REQUEST }),
    );
  });
});

describe('the frame stream', () => {
  it('yields parsed frames in order and ends when the peer closes', async () => {
    const server = new MockSocketServer((connection) => {
      connection.accept();
    });
    const connector = new WebSocketConnector({
      baseUrl: BASE_URL,
      webSocketFactory: server.factory,
    });
    const stream = await connector.connect({ path: '/ws', headers: AUTHORIZED });

    const connection = server.connection(0);
    connection.deliver({ type: 'pong' });
    connection.deliver({ type: 'ready', sessionId: 'ses_x', pending: 0 });
    connection.closeWith(WsCloseCode.INTERNAL_ERROR, 'boom');

    const frames: unknown[] = [];
    for await (const frame of stream) {
      frames.push(frame);
    }

    // Frames that arrived before the close are as real as any other.
    expect(frames).toEqual([{ type: 'pong' }, { type: 'ready', sessionId: 'ses_x', pending: 0 }]);
    await expect(stream.closure).resolves.toMatchObject({
      code: WsCloseCode.INTERNAL_ERROR,
      reason: 'boom',
      local: false,
    });
  });

  it('yields unparseable data rather than swallowing it', async () => {
    const server = new MockSocketServer((connection) => {
      connection.accept();
    });
    const connector = new WebSocketConnector({
      baseUrl: BASE_URL,
      webSocketFactory: server.factory,
    });
    const stream = await connector.connect({ path: '/ws', headers: AUTHORIZED });

    server.connection(0).deliverRaw('{not json');
    server.connection(0).closeWith();

    const frames: unknown[] = [];
    for await (const frame of stream) {
      frames.push(frame);
    }

    expect(frames).toEqual(['{not json']);
  });

  it('reports a local close as local, without waiting for the peer', async () => {
    const server = new MockSocketServer((connection) => {
      connection.accept();
    });
    const connector = new WebSocketConnector({
      baseUrl: BASE_URL,
      webSocketFactory: server.factory,
    });
    const stream = await connector.connect({ path: '/ws', headers: AUTHORIZED });

    stream.close(WsCloseCode.NORMAL, 'listener stopped');

    await expect(stream.closure).resolves.toMatchObject({
      local: true,
      reason: 'listener stopped',
    });
    expect(() => stream.send({ type: 'ping' })).toThrowError(
      expect.objectContaining({ code: ErrorCode.INTERNAL }),
    );
  });

  it('closes the socket when the caller stops reading', async () => {
    const server = new MockSocketServer((connection) => {
      connection.accept();
    });
    const connector = new WebSocketConnector({
      baseUrl: BASE_URL,
      webSocketFactory: server.factory,
    });
    const stream = await connector.connect({ path: '/ws', headers: AUTHORIZED });

    server.connection(0).deliver({ type: 'pong' });
    for await (const _frame of stream) {
      break;
    }

    expect(server.connection(0).isClosed).toBe(true);
  });

  it('closes the connection when the caller aborts', async () => {
    const server = new MockSocketServer((connection) => {
      connection.accept();
    });
    const connector = new WebSocketConnector({
      baseUrl: BASE_URL,
      webSocketFactory: server.factory,
    });
    const controller = new AbortController();

    const stream = await connector.connect({
      path: '/ws',
      headers: AUTHORIZED,
      signal: controller.signal,
    });
    controller.abort();

    await waitFor(() => server.connection(0).isClosed, 'the socket to close');
    await expect(stream.closure).resolves.toMatchObject({ local: true });
  });
});

describe('a runtime that reports a refused upgrade through onError alone', () => {
  /** A socket handle for a connection that never existed. */
  const DEAD_SOCKET: FrameSocket = {
    send: (): void => {
      throw new Error('send on a socket that never opened');
    },
    close: (): void => {
      // Nothing to close, and nothing to report: a close from here would be the
      // very callback the runtime under test does not make.
    },
  };

  /**
   * A factory that breaks the {@link SocketHandlers.onClose} contract the way
   * Node 22's global `WebSocket` breaks it: `error` on a refused upgrade, and
   * no `close` ever.
   *
   * Hand-written rather than driven from the real socket on purpose. The
   * runtime difference is real — against a TCP listener that accepts and then
   * resets, Node 22.23.2 fires `error` alone where Node 24.20.0 fires `error`
   * then `close` with `1006` — but a test that depended on it would be green on
   * one version of Node and red on another, and a suite that is red for reasons
   * nobody can act on teaches everyone to ignore a red build. The contract
   * violation is the thing worth pinning, and it holds on any runtime.
   *
   * @param _options - Ignored; the handshake never gets far enough to use them.
   * @param handlers - Where the refusal is reported.
   * @returns A handle that can do nothing, because there is no socket.
   */
  const errorOnlyFactory: WebSocketFactory = (_options, handlers) => {
    queueMicrotask(() => {
      handlers.onError(new Error('connection failed'));
    });
    return DEAD_SOCKET;
  };

  it('fails the connect instead of waiting for a close that never comes', async () => {
    const connector = new WebSocketConnector({
      baseUrl: BASE_URL,
      webSocketFactory: errorOnlyFactory,
    });

    const failure = await connector
      .connect({ path: '/ws', headers: AUTHORIZED })
      .catch((error: unknown) => error);

    // Before the fix this promise never settled at all. The reconnect loop
    // awaited it, the event loop emptied, and the listener exited 13 silently.
    expect(failure).toBeInstanceOf(TransportError);
    // A refusal has no close frame to carry a code, so `1006` is the only
    // honest answer, and it is the one the reconnect loop already spends a
    // refresh on.
    expect(closureOf(failure)?.code).toBe(WsCloseCode.ABNORMAL);
    expect(closureOf(failure)?.error?.message).toBe('connection failed');
  });

  it('lets the next attempt connect, rather than stopping the loop at the first', async () => {
    const server = new MockSocketServer((connection) => {
      connection.accept();
    });
    let attempts = 0;
    const flakyFactory: WebSocketFactory = (options, handlers) => {
      attempts += 1;
      return attempts === 1
        ? errorOnlyFactory(options, handlers)
        : server.factory(options, handlers);
    };
    const connector = new WebSocketConnector({
      baseUrl: BASE_URL,
      webSocketFactory: flakyFactory,
    });

    await expect(connector.connect({ path: '/ws', headers: AUTHORIZED })).rejects.toBeInstanceOf(
      TransportError,
    );
    const stream = await connector.connect({ path: '/ws', headers: AUTHORIZED });
    stream.close();

    expect(attempts).toBe(2);
  });

  it('closes exactly once on a runtime that sends the close as well', async () => {
    const captured: SocketHandlers[] = [];
    const connector = new WebSocketConnector({
      baseUrl: BASE_URL,
      webSocketFactory: (options, handlers): FrameSocket => {
        captured.push(handlers);
        return errorOnlyFactory(options, handlers);
      },
    });

    const failure = await connector
      .connect({ path: '/ws', headers: AUTHORIZED })
      .catch((error: unknown) => error);
    const closure = closureOf(failure);

    // Node 24 does follow the error with a close. Two callbacks must still be
    // one closure, or a listener counts one failed attempt as two and the
    // reason it prints comes from whichever arrived last.
    captured[0]?.onClose(WsCloseCode.SESSION_INVALID, 'a close nobody should see');

    expect(failure).toBeInstanceOf(TransportError);
    expect(closure?.code).toBe(WsCloseCode.ABNORMAL);
    // The later close did not overwrite it, and did not add a second one.
    expect(closureOf(failure)).toBe(closure);
    expect(closure?.reason).toBe('');
  });

  it('still reports the close code when the error arrives after the upgrade', async () => {
    const captured: SocketHandlers[] = [];
    const connector = new WebSocketConnector({
      baseUrl: BASE_URL,
      webSocketFactory: (_options, handlers): FrameSocket => {
        captured.push(handlers);
        queueMicrotask(() => {
          handlers.onOpen();
        });
        return DEAD_SOCKET;
      },
    });

    const stream = await connector.connect({ path: '/ws', headers: AUTHORIZED });
    // The DOM contract's ordinary case: an error precedes an abnormal close on
    // a socket that did open. Settling from the error there would throw away
    // the one code the reconnect loop makes its decision from.
    captured[0]?.onError(new Error('connection failed'));
    captured[0]?.onClose(WsCloseCode.SESSION_INVALID, 'no such session');

    await expect(stream.closure).resolves.toMatchObject({
      code: WsCloseCode.SESSION_INVALID,
      reason: 'no such session',
    });
  });
});
