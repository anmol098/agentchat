/**
 * The seam a daemon slots into (D1, plan §5).
 *
 * v0.1 has no daemon: `agentchat listen` holds its own socket and every other
 * command is a stateless HTTP call. v0.2 may put a long-lived local process
 * between the CLI and the server. This interface is the whole of what would have
 * to change — one implementation swapped for another — and the shape below is
 * chosen so that the swap stays a swap.
 *
 * ## Why a transport carries bytes and not meaning
 *
 * {@link Transport.request} returns the status and the parsed body of whatever
 * came back, **including for 4xx and 5xx**. It does not throw on a failure
 * status, does not know what a token is, and does not know what an error
 * envelope looks like. Everything above it — attaching the bearer token,
 * refreshing on a 401, translating an envelope into a typed error, parsing a
 * body with its schema — lives in `./api.ts` and is shared by every transport.
 *
 * That is the entire argument for the seam. If the transport owned the auth
 * dance, a daemon transport would have to reimplement single-flight refresh and
 * error translation, and the two implementations would drift the first time one
 * of them was fixed. As it is, a daemon transport is a function that puts a
 * request on a socket and reads a response off it.
 *
 * ## The direction the abstraction does not go
 *
 * A transport may not invent requests, retry on its own, or rewrite a response
 * body. It is free to *replace* the `Authorization` header — a daemon holds the
 * credentials, so the caller's header is advisory there — and free to add
 * transport-level headers of its own.
 *
 * ## Frames are `unknown` on purpose
 *
 * {@link Transport.connect} is the listening half. The WebSocket frame schemas
 * do not exist yet: `packages/protocol` deliberately omits them until the
 * milestone that implements messaging settles their semantics, and the
 * WebSocket transport itself is T-310. Typing frames as `unknown` here means
 * T-310 can add the schemas and parse against them without this file changing
 * shape, and means nothing in v0.1 has guessed at a contract six other tasks
 * would then have to live with.
 *
 * @module
 */

/** The HTTP methods the AgentChat API uses. */
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * A value that can appear in a query string.
 *
 * `undefined` means "omit this parameter", so a caller can build a query object
 * with optional fields without filtering it first.
 */
export type QueryValue = string | number | boolean | undefined;

/** One request, fully described, with nothing left for the transport to decide. */
export interface TransportRequest {
  /** The HTTP method. */
  readonly method: HttpMethod;

  /**
   * The path, beginning with `/` and already containing any path parameters —
   * `/projects/prj_018f…/agents`. The transport joins it to its own base.
   */
  readonly path: string;

  /** Query parameters. Entries whose value is `undefined` are omitted. */
  readonly query?: Readonly<Record<string, QueryValue>>;

  /**
   * The request body, to be serialised as JSON. `undefined` sends no body at
   * all, which is not the same as sending `{}`.
   */
  readonly body?: unknown;

  /**
   * Headers to send. Already includes `Authorization` and the client version
   * header where they apply; a transport adds its own on top.
   */
  readonly headers?: Readonly<Record<string, string>>;

  /** Aborts the request when signalled. */
  readonly signal?: AbortSignal;
}

/**
 * What came back, uninterpreted.
 *
 * A failure status is a perfectly ordinary response here. Only
 * {@link TransportError} conditions — nothing came back at all — are thrown.
 */
export interface TransportResponse {
  /** The HTTP status. */
  readonly status: number;

  /** Response headers, lowercased keys. */
  readonly headers: Readonly<Record<string, string>>;

  /**
   * The body parsed as JSON, or `undefined` when the response had no body or a
   * body that was not JSON. It is deliberately `unknown`: nothing has validated
   * it yet.
   */
  readonly body: unknown;
}

/** How a caller identifies itself when opening a connection. */
export interface ConnectOptions {
  /** The path to connect to, beginning with `/` — `/ws` today. */
  readonly path: string;

  /** Headers for the upgrade request, including `Authorization`. */
  readonly headers?: Readonly<Record<string, string>>;

  /** Closes the connection when signalled. */
  readonly signal?: AbortSignal;
}

/**
 * A bidirectional frame stream.
 *
 * Iterating yields frames until the peer closes or {@link Connection.close} is
 * called. Frames are `unknown` in both directions; see the module note.
 */
export interface Connection extends AsyncIterable<unknown> {
  /**
   * Queues a frame for the peer.
   *
   * @param frame - A JSON-serialisable frame.
   * @throws {ProtocolError} If the connection is already closed.
   */
  send(frame: unknown): void;

  /**
   * Closes the connection. Idempotent.
   *
   * @param code - WebSocket close code. Defaults to a normal closure.
   * @param reason - Human-readable reason, never containing credentials.
   */
  close(code?: number, reason?: string): void;
}

/**
 * The one thing that has to be replaced to put something else — a daemon, a
 * recorded fixture, a test double — between the client and the server.
 */
export interface Transport {
  /**
   * Performs one request and returns whatever came back.
   *
   * @param request - The fully described request.
   * @returns The status, headers, and parsed body. A 4xx or 5xx resolves; it
   *   does not reject.
   * @throws {TransportError} If no response was produced at all: connection
   *   failure, timeout, or abort.
   */
  request(request: TransportRequest): Promise<TransportResponse>;

  /**
   * Opens a frame stream, if this transport can.
   *
   * Optional, and absent from {@link HttpTransport}: opening a WebSocket needs a
   * client library this package does not depend on yet, and choosing it is
   * T-310's decision, not this task's. A caller checks for the method rather
   * than catching a "not supported" error, so "this transport cannot listen" is
   * a compile-time fact.
   *
   * @param options - Path, headers, and an abort signal.
   * @returns The open connection.
   * @throws {TransportError} If the connection could not be established.
   */
  connect?(options: ConnectOptions): Promise<Connection>;
}
