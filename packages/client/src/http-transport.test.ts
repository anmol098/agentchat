import { ErrorCode, ProtocolError } from '@stackgrid/protocol';
import { describe, expect, it } from 'vitest';

import { TransportError } from './errors.js';
import { HttpTransport, normaliseBaseUrl } from './http-transport.js';
import { MOCK_BASE_URL, MockServer } from './testing/mock-server.js';
import type { Transport } from './transport.js';

/**
 * A transport pointed at a fresh mock server.
 *
 * @returns The transport and the server it talks to.
 */
function build(): { transport: HttpTransport; server: MockServer } {
  const server = new MockServer();
  return {
    server,
    transport: new HttpTransport({ baseUrl: MOCK_BASE_URL, fetch: server.fetch() }),
  };
}

describe('normaliseBaseUrl', () => {
  it('strips a trailing slash so paths join cleanly', () => {
    expect(normaliseBaseUrl('https://chat.example.com/')).toBe('https://chat.example.com');
  });

  it('keeps a mount path', () => {
    expect(normaliseBaseUrl('https://chat.example.com/api')).toBe('https://chat.example.com/api');
  });

  it('rejects a URL that is not absolute, naming the value', () => {
    expect(() => normaliseBaseUrl('chat.example.com')).toThrow(ProtocolError);
    try {
      normaliseBaseUrl('chat.example.com');
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ErrorCode.BAD_REQUEST);
      expect((error as ProtocolError).message).toContain('chat.example.com');
    }
  });

  it('rejects a scheme that is not http or https', () => {
    expect(() => normaliseBaseUrl('ws://chat.example.com')).toThrow(ProtocolError);
    expect(() => normaliseBaseUrl('file:///etc/passwd')).toThrow(ProtocolError);
  });
});

describe('HttpTransport.request', () => {
  it('returns the status and parsed body without interpreting either', async () => {
    const { transport, server } = build();
    server.reply('GET /version', {
      status: 200,
      body: { version: '1.0.0', protocolVersion: 1, minClientVersion: '0.1.0' },
    });

    const response = await transport.request({ method: 'GET', path: '/version' });

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      version: '1.0.0',
      protocolVersion: 1,
      minClientVersion: '0.1.0',
    });
  });

  it('resolves rather than throwing on a failure status', async () => {
    const { transport, server } = build();
    server.reply('GET /me', {
      status: 401,
      body: { error: { code: 'AUTH_REQUIRED', message: 'x' } },
    });

    const response = await transport.request({ method: 'GET', path: '/me' });
    expect(response.status).toBe(401);
  });

  it("sends the caller's headers and a JSON content type when there is a body", async () => {
    const { transport, server } = build();
    server.reply('POST /agents', { status: 200, body: {} });

    await transport.request({
      method: 'POST',
      path: '/agents',
      headers: { authorization: 'Bearer at-1' },
      body: { name: 'backend' },
    });

    const [call] = server.calls;
    expect(call?.headers['authorization']).toBe('Bearer at-1');
    expect(call?.headers['content-type']).toBe('application/json');
    expect(call?.body).toStrictEqual({ name: 'backend' });
  });

  it('sends no body at all when none was given', async () => {
    const { transport, server } = build();
    server.reply('GET /agents', { status: 200, body: { items: [] } });

    await transport.request({ method: 'GET', path: '/agents' });

    const [call] = server.calls;
    expect(call?.body).toBeUndefined();
    expect(call?.headers['content-type']).toBeUndefined();
  });

  it('appends defined query parameters and drops undefined ones', async () => {
    const { transport, server } = build();
    server.reply('GET /sessions', { status: 200, body: {} });

    await transport.request({
      method: 'GET',
      path: '/sessions',
      query: { projectId: 'prj_1', agentId: undefined, limit: 10, active: true },
    });

    const [call] = server.calls;
    expect(call?.path).toBe('/sessions?projectId=prj_1&limit=10&active=true');
  });

  it('treats an empty body as no body rather than as a parse failure', async () => {
    const { transport, server } = build();
    server.reply('POST /auth/logout', { status: 204 });

    const response = await transport.request({ method: 'POST', path: '/auth/logout' });
    expect(response.body).toBeUndefined();
  });

  it('treats a non-JSON body as no body, so a proxy error page stays legible', async () => {
    const { transport, server } = build();
    server.reply('GET /me', {
      status: 502,
      rawBody: '<html>Bad Gateway</html>',
      headers: { 'content-type': 'text/html' },
    });

    const response = await transport.request({ method: 'GET', path: '/me' });
    expect(response.status).toBe(502);
    expect(response.body).toBeUndefined();
  });

  it('lowercases response header names', async () => {
    const { transport, server } = build();
    server.reply('GET /version', { status: 200, body: {}, headers: { 'X-Request-Id': 'abc' } });

    const response = await transport.request({ method: 'GET', path: '/version' });
    expect(response.headers['x-request-id']).toBe('abc');
  });

  it('turns a connection failure into a TransportError naming no credentials', async () => {
    const transport = new HttpTransport({
      baseUrl: MOCK_BASE_URL,
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });

    await expect(
      transport.request({
        method: 'GET',
        path: '/me',
        headers: { authorization: 'Bearer super-secret' },
      }),
    ).rejects.toThrow(TransportError);

    await transport
      .request({ method: 'GET', path: '/me', headers: { authorization: 'Bearer super-secret' } })
      .catch((error: unknown) => {
        expect((error as Error).message).not.toContain('super-secret');
        expect((error as Error).cause).toBeInstanceOf(TypeError);
      });
  });

  it('turns a connection lost while the body arrives into the same TransportError', async () => {
    // The headers arrived, so `fetch` resolved and the `catch` around it has
    // already been passed. The socket then dies, and the failure surfaces on
    // the body stream instead — a different code path for the same event, and
    // one a caller must be able to answer the same way.
    const transport = new HttpTransport({
      baseUrl: MOCK_BASE_URL,
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"accessToken":'));
                controller.error(new TypeError('terminated'));
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
    });

    await expect(
      transport.request({
        method: 'POST',
        path: '/auth/refresh',
        headers: { authorization: 'Bearer super-secret' },
        body: { refreshToken: 'rt-1' },
      }),
    ).rejects.toThrow(TransportError);
  });

  it('reports a truncated body as SERVER_UNREACHABLE rather than as an empty one', async () => {
    // An empty body is the documented success body of several endpoints, so a
    // body that was cut off must not be allowed to look like one: that would
    // turn a dead connection into a schema failure at best and a silently
    // successful no-op at worst.
    const transport = new HttpTransport({
      baseUrl: MOCK_BASE_URL,
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new TypeError('terminated'));
              },
            }),
            { status: 200 },
          ),
        ),
    });

    await transport
      .request({ method: 'POST', path: '/auth/refresh', body: { refreshToken: 'rt-1' } })
      .then(
        () => {
          expect.unreachable('a body that never arrived resolved as a response');
        },
        (error: unknown) => {
          expect(error).toBeInstanceOf(TransportError);
          expect((error as TransportError).code).toBe(ErrorCode.SERVER_UNREACHABLE);
          expect((error as Error).message).toContain(MOCK_BASE_URL);
          expect((error as Error).cause).toBeInstanceOf(TypeError);
        },
      );
  });

  it('does not put a credential in the message when the body fails to arrive', async () => {
    const transport = new HttpTransport({
      baseUrl: MOCK_BASE_URL,
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new TypeError('terminated'));
              },
            }),
            { status: 200 },
          ),
        ),
    });

    await transport
      .request({
        method: 'POST',
        path: '/auth/refresh',
        headers: { authorization: 'Bearer super-secret' },
        body: { refreshToken: 'super-secret-refresh' },
      })
      .catch((error: unknown) => {
        expect((error as Error).message).not.toContain('super-secret');
      });
  });

  it("aborts when the caller's signal fires", async () => {
    const controller = new AbortController();
    const transport = new HttpTransport({
      baseUrl: MOCK_BASE_URL,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    });

    const pending = transport.request({ method: 'GET', path: '/me', signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toThrow(TransportError);
  });

  it('rejects a path that does not begin with a slash', async () => {
    const { transport } = build();
    await expect(transport.request({ method: 'GET', path: 'me' })).rejects.toThrow(ProtocolError);
  });

  it('does not implement connect: listening needs a WebSocket client this package has not chosen', () => {
    const { transport } = build();
    const seam: Transport = transport;
    expect(seam.connect).toBeUndefined();
  });

  it('exposes the normalised base URL it was built with', () => {
    const transport = new HttpTransport({ baseUrl: `${MOCK_BASE_URL}/` });
    expect(transport.baseUrl).toBe(MOCK_BASE_URL);
  });
});
