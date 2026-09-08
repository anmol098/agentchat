import { ErrorCode } from '@agentchat/protocol';
import { describe, expect, it } from 'vitest';

import { TransportError } from '../errors.js';
import { MockSocketServer, waitFor } from '../testing/mock-socket-server.js';
import { WsCloseCode } from './frames.js';
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
