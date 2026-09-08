/**
 * Opening a socket, and the seam that keeps a WebSocket implementation out of
 * this package's dependencies.
 *
 * ## No dependency
 *
 * Plan §5 says "`ws` for sockets". It is not needed, and adding it would be a
 * cost this package should not pay: `@agentchat/client` is MIT and meant to be
 * embedded in browsers and harnesses, its engine floor is Node 22.12, and every
 * runtime at or above that floor — Node, Deno, Bun, every browser — ships a
 * global `WebSocket`. So {@link nativeWebSocketFactory} uses the one that is
 * already there, and this package's runtime dependencies remain
 * `@agentchat/protocol` and `zod`.
 *
 * Everything platform-specific is behind {@link WebSocketFactory}, which is the
 * whole of what an embedder replaces to use `ws`, a mock, or a recorded
 * fixture. It is four methods wide on purpose: a seam that exposed the DOM
 * `WebSocket` interface would make every test double implement `readyState`,
 * `binaryType`, and three overloads of `addEventListener` before it could
 * refuse a connection.
 *
 * ## Where the credential goes
 *
 * The default factory sends `Authorization: Bearer …` on the upgrade, which is
 * what Plan §3 prefers and what the server reads first. Node's global
 * `WebSocket` accepts request headers; a browser's cannot set any, which is
 * exactly why the server also reads an `access_token` query parameter, and why
 * {@link WebSocketConnectorOptions.credentialsIn} exists. It is `'header'` by
 * default and should stay there wherever headers are possible: a URL ends up in
 * access logs, proxy buffers and error reports, and a header does not.
 *
 * A browser embedder sets `credentialsIn: 'query'`. Nothing auto-detects this,
 * because a wrong guess is a credential in a log file.
 *
 * ## What `connect` resolves to
 *
 * A {@link FrameStream}: the {@link Connection} of `../transport.ts` — an async
 * iterable of frames with `send` and `close` — plus one addition,
 * {@link FrameStream.closure}, which resolves with the close code.
 *
 * That addition is not decoration. The reconnect loop's central decision is
 * whether a closed socket should be retried, refreshed, or given up on, and
 * that decision is made *from the close code*. A `Connection` whose iteration
 * simply ended would leave a listener unable to tell a server restart from a
 * deleted session, and the only remaining answer would be to retry both
 * forever. Any transport that wants to serve a listener — a v0.2 daemon
 * included — has to report how the connection ended.
 *
 * @module
 */

import { ErrorCode, ProtocolError } from '@agentchat/protocol';

import { TransportError } from '../errors.js';
import { normaliseBaseUrl } from '../http-transport.js';
import type { Connection, ConnectOptions } from '../transport.js';
import { WsCloseCode } from './frames.js';

// ---------------------------------------------------------------------------
// The platform seam
// ---------------------------------------------------------------------------

/** The bytes a WebSocket implementation may hand over for one message. */
export type SocketData = string | ArrayBuffer | ArrayBufferView;

/** What a socket reports back to the connection that opened it. */
export interface SocketHandlers {
  /** The upgrade completed and frames may be sent. */
  onOpen(): void;

  /** One message arrived. */
  onData(data: SocketData): void;

  /**
   * The socket is gone, for whatever reason.
   *
   * Must be called exactly once, and must be called even when the upgrade never
   * completed — a factory that reported a failed handshake only through
   * {@link SocketHandlers.onError} would leave a listener waiting forever for a
   * close that never came.
   */
  onClose(code: number, reason: string): void;

  /**
   * Something failed. Informational: the DOM contract fires an error before
   * every abnormal close and gives no detail, so the close is what a caller
   * acts on and this is what it puts in the message.
   */
  onError(error: Error): void;
}

/** How to reach the server, for one attempt. */
export interface OpenSocketOptions {
  /** The absolute `ws:` or `wss:` URL, query string included. */
  readonly url: string;

  /**
   * Headers for the upgrade request. Empty when the caller has put the
   * credential in the query string instead.
   */
  readonly headers: Readonly<Record<string, string>>;
}

/** The handle a connection keeps on an open socket. */
export interface FrameSocket {
  /**
   * Queues one text frame.
   *
   * @param text - The serialised frame.
   */
  send(text: string): void;

  /**
   * Begins a close handshake. Idempotent.
   *
   * @param code - The close code to send.
   * @param reason - A short reason, never containing a credential.
   */
  close(code: number, reason: string): void;
}

/**
 * Opens one socket.
 *
 * @param options - Where to connect and what headers to send.
 * @param handlers - Where to report the socket's lifecycle.
 * @returns The handle to send and close with.
 * @throws {TransportError} If a socket could not be created at all.
 */
export type WebSocketFactory = (
  options: OpenSocketOptions,
  handlers: SocketHandlers,
) => FrameSocket;

/**
 * The subset of the platform `WebSocket` this module uses.
 *
 * Declared structurally rather than referenced from `lib.dom` so that the one
 * cast in this file is narrow and visible. The second constructor argument is
 * `protocols` in the browser and an options object in Node — which is what
 * carries `headers` — so it is typed `unknown` and passed only when there is
 * something to put in it.
 */
interface NativeWebSocket {
  binaryType: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: never) => void): void;
}

/** The platform `WebSocket` constructor, as this module needs to call it. */
type NativeWebSocketConstructor = new (url: string, options?: unknown) => NativeWebSocket;

/** The close reason used when a socket dies without one. */
const NO_CLOSE_REASON = '';

/**
 * The default {@link WebSocketFactory}: the runtime's own global `WebSocket`.
 *
 * Headers are passed as Node's `WebSocket` accepts them, and only when there are
 * any — a browser reads the second argument as a subprotocol list and would
 * reject an object, so an embedder that cannot set headers must be using
 * `credentialsIn: 'query'`, which leaves this empty.
 *
 * @param options - Where to connect and what headers to send.
 * @param handlers - Where to report the socket's lifecycle.
 * @returns The handle to send and close with.
 * @throws {TransportError} If the runtime has no global `WebSocket`, which is
 *   an embedder's cue to supply a factory of its own.
 */
export const nativeWebSocketFactory: WebSocketFactory = (options, handlers) => {
  const candidate: unknown = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof candidate !== 'function') {
    throw new TransportError(
      'This runtime has no global WebSocket. Supply a webSocketFactory to listen from it.',
    );
  }
  const Native = candidate as NativeWebSocketConstructor;

  const headerNames = Object.keys(options.headers);
  const socket =
    headerNames.length === 0
      ? new Native(options.url)
      : new Native(options.url, { headers: options.headers });

  // The server sends text, but a peer is free to send the same JSON as bytes.
  // Asking for an ArrayBuffer rather than the default Blob keeps the decode
  // synchronous; a runtime that does not know the property simply keeps its own.
  socket.binaryType = 'arraybuffer';

  socket.addEventListener('open', () => {
    handlers.onOpen();
  });
  socket.addEventListener('message', (event: { data: SocketData }) => {
    handlers.onData(event.data);
  });
  socket.addEventListener('close', (event: { code?: number; reason?: string }) => {
    handlers.onClose(event.code ?? WsCloseCode.ABNORMAL, event.reason ?? NO_CLOSE_REASON);
  });
  socket.addEventListener('error', () => {
    // The DOM error event carries nothing describable, by design: a page must
    // not be able to probe the network by reading why an upgrade failed. The
    // close that follows is what says anything useful.
    handlers.onError(new TransportError('The WebSocket connection failed.'));
  });

  return {
    send: (text: string): void => {
      socket.send(text);
    },
    close: (code: number, reason: string): void => {
      socket.close(code, reason);
    },
  };
};

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

/** How a connection ended. */
export interface SocketClosure {
  /** The close code, or {@link WsCloseCode.ABNORMAL} if there was none. */
  readonly code: number;

  /** The close reason, possibly empty. */
  readonly reason: string;

  /** Whether this side asked for the close. */
  readonly local: boolean;

  /** The transport failure that preceded it, if any. */
  readonly error: Error | null;
}

/**
 * A {@link Connection} that also reports how it ended.
 *
 * See the module note for why the addition is load-bearing rather than
 * convenient.
 */
export interface FrameStream extends Connection {
  /**
   * Resolves when the connection is over. Never rejects: a closed socket is an
   * outcome, not a failure, and the code says which.
   */
  readonly closure: Promise<SocketClosure>;
}

/** What a {@link FrameStream} can do. Implemented by {@link WebSocketConnector}. */
export interface FrameConnector {
  /**
   * Opens a frame stream.
   *
   * @param options - Path, headers, and an abort signal.
   * @returns The open connection.
   * @throws {TransportError} If the connection could not be established.
   */
  connect(options: ConnectOptions): Promise<FrameStream>;
}

/** Text decoder for binary frames. Stateless, so one instance is enough. */
const UTF8 = new TextDecoder('utf-8', { fatal: false });

/**
 * Turns socket callbacks into an async iterable of parsed frames.
 *
 * A value that is not valid JSON is yielded as the raw string rather than
 * dropped here: deciding what an unreadable frame means belongs to the layer
 * that knows the protocol, and `decodeServerFrame` classifies a bare string as
 * invalid. A transport that silently swallowed it would make the failure
 * invisible.
 */
class SocketStream implements FrameStream {
  readonly #socket: FrameSocket;
  readonly #queue: unknown[] = [];
  readonly #waiting: Array<(result: IteratorResult<unknown>) => void> = [];

  /** Resolves when the upgrade completes, rejects if it never does. */
  public readonly opened: Promise<void>;

  /** @inheritdoc */
  public readonly closure: Promise<SocketClosure>;

  #settleOpen!: () => void;
  #refuseOpen!: (cause: unknown) => void;
  #settleClosure!: (closure: SocketClosure) => void;
  #closed: SocketClosure | null = null;
  #lastError: Error | null = null;

  /**
   * @param factory - How to open the socket. Called from this constructor, once
   *   every internal structure exists, so a factory that reports `open` or a
   *   first frame synchronously — a test double, a replayed fixture — cannot
   *   deliver it into a half-built stream.
   * @param options - Where to connect and what headers to send.
   * @throws {TransportError} If the factory could not create a socket.
   */
  public constructor(factory: WebSocketFactory, options: OpenSocketOptions) {
    this.closure = new Promise<SocketClosure>((resolve) => {
      this.#settleClosure = resolve;
    });
    this.opened = new Promise<void>((resolve, reject) => {
      this.#settleOpen = resolve;
      this.#refuseOpen = reject;
    });

    this.#socket = factory(options, {
      onOpen: (): void => {
        this.#settleOpen();
      },
      onData: (data): void => {
        this.#push(data);
      },
      onClose: (code, reason): void => {
        // Before the upgrade completes this is a refusal and somebody is still
        // waiting on `opened`; afterwards it is an ordinary end of stream and
        // rejecting an already-settled promise does nothing.
        const closure: SocketClosure = { code, reason, local: false, error: this.#lastError };
        this.#refuseOpen(new SocketRefusal(closure));
        this.#finish(closure);
      },
      onError: (error): void => {
        this.#lastError ??= error;
      },
    });
  }

  /** Whether the stream has already ended. */
  public get isClosed(): boolean {
    return this.#closed !== null;
  }

  /**
   * Accepts one message from the socket.
   *
   * @param data - The text or bytes of one frame.
   */
  #push(data: SocketData): void {
    if (this.#closed !== null) {
      return;
    }
    const text = typeof data === 'string' ? data : UTF8.decode(toBytes(data));
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      value = text;
    }

    const waiter = this.#waiting.shift();
    if (waiter === undefined) {
      this.#queue.push(value);
    } else {
      waiter({ value, done: false });
    }
  }

  /**
   * Ends the stream. Idempotent: only the first call is the closure.
   *
   * @param closure - How the connection ended.
   */
  #finish(closure: SocketClosure): void {
    if (this.#closed !== null) {
      return;
    }
    this.#closed = closure;
    this.#settleClosure(this.#closed);

    // Everything already queued is still delivered: frames that arrived before
    // the close are as real as any other, and a replayed message dropped
    // because the socket died a millisecond later would be a message lost by
    // the very mechanism that exists to not lose them.
    for (const waiter of this.#waiting.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  /** @inheritdoc */
  public send(frame: unknown): void {
    if (this.#closed !== null) {
      throw new ProtocolError(
        ErrorCode.INTERNAL,
        'Cannot send on a WebSocket connection that has already closed.',
      );
    }
    this.#socket.send(JSON.stringify(frame));
  }

  /** @inheritdoc */
  public close(code: number = WsCloseCode.NORMAL, reason = ''): void {
    if (this.#closed !== null) {
      return;
    }
    // Settled from this side immediately rather than on the peer's answering
    // close. A close this side asked for is a fact already known, and waiting
    // for a confirmation that a half-open socket will never send is how a
    // shutdown hangs.
    this.#finish({ code, reason, local: true, error: this.#lastError });
    try {
      this.#socket.close(code, reason);
    } catch {
      // A socket that objects to being closed is already gone. There is nothing
      // to report and nothing to do.
    }
  }

  /** @inheritdoc */
  public [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: (): Promise<IteratorResult<unknown>> => {
        if (this.#queue.length > 0) {
          return Promise.resolve({ value: this.#queue.shift(), done: false });
        }
        if (this.#closed !== null) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<unknown>>((resolve) => {
          this.#waiting.push(resolve);
        });
      },

      // `for await` calls `return` when the body breaks or throws. Closing the
      // socket there is what stops a caller that stopped reading from leaving a
      // connection open for the rest of the process's life.
      return: (): Promise<IteratorResult<unknown>> => {
        this.close(WsCloseCode.NORMAL, 'listener stopped reading');
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/**
 * Copies an ArrayBuffer or view into bytes the decoder can read.
 *
 * @param data - Binary frame data.
 * @returns Its bytes.
 */
function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  return ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
}

// ---------------------------------------------------------------------------
// The connector
// ---------------------------------------------------------------------------

/** Where a bearer token is put on the upgrade request. */
export type CredentialPlacement = 'header' | 'query';

/**
 * The query parameter the server reads a token from when there is no
 * `Authorization` header.
 *
 * RFC 6750 §2.3's name, and the server's `ACCESS_TOKEN_QUERY_PARAMETER`.
 */
export const ACCESS_TOKEN_QUERY_PARAMETER = 'access_token';

/** Construction options for {@link WebSocketConnector}. */
export interface WebSocketConnectorOptions {
  /** The server's HTTP origin — `https://chat.example.com`. Scheme is mapped. */
  readonly baseUrl: string;

  /**
   * Where to put the bearer token. `'header'` unless the runtime cannot set
   * headers on an upgrade, which in practice means a browser. See the module
   * note for why this is not detected.
   */
  readonly credentialsIn?: CredentialPlacement;

  /** How to open a socket. Defaults to {@link nativeWebSocketFactory}. */
  readonly webSocketFactory?: WebSocketFactory;
}

/** The default endpoint, per Plan §4. */
export const DEFAULT_WEBSOCKET_PATH = '/ws';

/**
 * Opens WebSocket connections to an AgentChat server.
 *
 * This is the WebSocket half of the transport seam. It knows about URLs,
 * credentials on an upgrade, and framing; it knows nothing about sessions,
 * reconnection, or acknowledgement, all of which live in `./listener.ts` and
 * work against any {@link FrameConnector}.
 */
export class WebSocketConnector implements FrameConnector {
  readonly #origin: string;
  readonly #credentialsIn: CredentialPlacement;
  readonly #factory: WebSocketFactory;

  /**
   * @param options - Server location, credential placement, and socket factory.
   * @throws {ProtocolError} `BAD_REQUEST` if `baseUrl` is not an absolute
   *   `http:` or `https:` URL.
   */
  public constructor(options: WebSocketConnectorOptions) {
    this.#origin = normaliseBaseUrl(options.baseUrl);
    this.#credentialsIn = options.credentialsIn ?? 'header';
    this.#factory = options.webSocketFactory ?? nativeWebSocketFactory;
  }

  /**
   * Opens one connection and waits for the upgrade to complete.
   *
   * @param options - The path, the headers to send, and an abort signal.
   * @returns The stream, already open.
   * @throws {TransportError} If the upgrade failed, was aborted, or the socket
   *   closed before it completed. The close code is on
   *   {@link TransportError.cause} when there was one.
   */
  public async connect(options: ConnectOptions): Promise<FrameStream> {
    const target = this.#target(options);

    let stream: SocketStream;
    try {
      stream = new SocketStream(this.#factory, target);
    } catch (cause) {
      throw connectFailure(cause);
    }

    const aborted = abortRejection(options.signal);
    try {
      await (aborted === null ? stream.opened : Promise.race([stream.opened, aborted]));
    } catch (cause) {
      stream.close(WsCloseCode.NORMAL, 'upgrade abandoned');
      throw connectFailure(cause);
    }

    // The signal keeps its meaning after the upgrade: `ConnectOptions` says it
    // closes the connection, not merely that it cancels the attempt.
    options.signal?.addEventListener(
      'abort',
      () => {
        stream.close(WsCloseCode.NORMAL, 'listener stopped');
      },
      { once: true },
    );

    return stream;
  }

  /**
   * Builds the URL and headers for one attempt.
   *
   * @param options - The caller's connect options.
   * @returns The absolute socket URL and the headers to send with it.
   */
  #target(options: ConnectOptions): { url: string; headers: Record<string, string> } {
    const url = new URL(`${this.#origin}${options.path || DEFAULT_WEBSOCKET_PATH}`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

    const headers: Record<string, string> = { ...options.headers };
    if (this.#credentialsIn === 'query') {
      // Moved rather than copied: a token in both places is a token in a log
      // for no gain, and the server reads the header first regardless.
      const bearer = takeBearer(headers);
      if (bearer !== null) {
        url.searchParams.set(ACCESS_TOKEN_QUERY_PARAMETER, bearer);
      }
    }

    return { url: url.toString(), headers };
  }
}

/** A close that happened before the upgrade completed. */
class SocketRefusal extends Error {
  /** How the socket closed. */
  public readonly closure: SocketClosure;

  /**
   * @param closure - The close code and reason.
   */
  public constructor(closure: SocketClosure) {
    super(`The server closed the connection with code ${closure.code}.`);
    this.name = 'SocketRefusal';
    this.closure = closure;
  }
}

/**
 * The close code behind a failed {@link WebSocketConnector.connect}, when there
 * was one.
 *
 * The reconnect loop needs it: a `4403` at the upgrade is as permanent as a
 * `4403` an hour into a connection, and the only difference is that one of them
 * arrives as a rejected promise.
 *
 * @param error - Anything thrown by `connect`.
 * @returns The closure, or `null` if the failure was not a close.
 */
export function closureOf(error: unknown): SocketClosure | null {
  if (error instanceof TransportError && error.cause instanceof SocketRefusal) {
    return error.cause.closure;
  }
  return error instanceof SocketRefusal ? error.closure : null;
}

/**
 * Wraps whatever went wrong during an upgrade as a transport failure.
 *
 * @param cause - The rejection.
 * @returns The error to throw from `connect`.
 */
function connectFailure(cause: unknown): TransportError {
  if (cause instanceof SocketRefusal) {
    return new TransportError(cause.message, { cause });
  }
  const detail = cause instanceof Error ? cause.message : 'the connection failed';
  return new TransportError(`Could not open a WebSocket to the server: ${detail}`, { cause });
}

/**
 * A promise that rejects when a signal is aborted.
 *
 * @param signal - The caller's signal, if any.
 * @returns The promise, or `null` when there is no signal to watch.
 */
function abortRejection(signal: AbortSignal | undefined): Promise<never> | null {
  if (signal === undefined) {
    return null;
  }
  if (signal.aborted) {
    return Promise.reject(new TransportError('The connection was aborted before it opened.'));
  }
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(new TransportError('The connection was aborted before it opened.'));
      },
      { once: true },
    );
  });
}

/**
 * Removes the bearer token from a header set and returns it.
 *
 * @param headers - Headers, mutated in place.
 * @returns The token, or `null` if there was no bearer header.
 */
function takeBearer(headers: Record<string, string>): string | null {
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() !== 'authorization') {
      continue;
    }
    const value = headers[name] ?? '';
    delete headers[name];
    const match = /^bearer[ \t]+(?<token>\S+)/i.exec(value);
    return match?.groups?.['token'] ?? null;
  }
  return null;
}
