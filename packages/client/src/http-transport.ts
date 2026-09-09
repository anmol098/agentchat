/**
 * The direct HTTP transport: v0.1's only one.
 *
 * ## Why `fetch` and not an HTTP library
 *
 * Node has had a global `fetch` since 18 and this workspace's floor is 22.12, so
 * an HTTP client dependency would buy retries and interceptors this package
 * deliberately implements itself — retry-on-401 is exactly one retry with exact
 * semantics (plan §5), and an interceptor stack is the wrong place for it. It
 * would also be a dependency whose licence has to be re-checked on every bump,
 * for a package that is MIT precisely so it can be embedded without anybody
 * having to check. `undici` is already in the runtime; adding a wrapper around
 * it is cost with no benefit.
 *
 * The one thing this module does need is a `fetch` it can be handed rather than
 * the global one, which is how the tests run against a mock server without a
 * socket. That is a constructor option, not a global patch.
 *
 * ## A request has two places it can die, not one
 *
 * `await fetch(…)` settles when the *headers* arrive. Everything after that —
 * the body — is a stream that can fail on its own, from a socket event, long
 * after the promise the obvious `try` wraps has resolved. A transport that
 * guarded only the call would let a connection lost mid-response escape as a
 * bare `TypeError`, past the `catch` written for exactly that event, and reach
 * a `--json` consumer as `INTERNAL`: a code that says "the server broke on your
 * request, do not retry" about a request no server ever finished answering.
 *
 * So both halves raise the same {@link TransportError}, and a caller reading
 * `SERVER_UNREACHABLE` gets the truth in either case (T-054, and `../errors.ts`
 * on why the distinction lives in the code rather than in a class).
 *
 * @module
 */

import { ErrorCode, ProtocolError } from '@agentchat/protocol';

import { TransportError } from './errors.js';
import type { HttpMethod, Transport, TransportRequest, TransportResponse } from './transport.js';

/** How long a single request may take before it is aborted, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** The `fetch` shape this transport needs. Narrower than the global type. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Construction options for {@link HttpTransport}. */
export interface HttpTransportOptions {
  /**
   * Where the server lives — `https://chat.example.com`. A trailing slash is
   * ignored. A path component is kept, so a server mounted under `/api` works.
   */
  readonly baseUrl: string;

  /**
   * How long one request may take, in milliseconds. Defaults to 30 seconds.
   *
   * This is a whole-request deadline, not an idle timeout, and it applies to the
   * HTTP calls only. Long-lived connections are `connect`'s problem and this
   * transport does not implement `connect`.
   */
  readonly timeoutMs?: number;

  /**
   * The `fetch` to use. Defaults to the global one.
   *
   * Injected rather than reached for so tests can supply a mock server and so an
   * embedder can supply a proxy-aware or instrumented implementation without
   * this package growing an option for each.
   */
  readonly fetch?: FetchLike;
}

/**
 * Reads a response body as JSON, tolerantly.
 *
 * A body that is empty or is not JSON yields `undefined` rather than throwing:
 * `{}` is the documented success body for several endpoints, and an HTML error
 * page from a reverse proxy has to become a legible `ApiError` rather than a
 * parse failure. Deciding what a missing body means belongs to the layer above.
 *
 * A body that never finished arriving is the one case that is *not* tolerated
 * here. Returning `undefined` for it would make a connection that died
 * mid-response indistinguishable from one of those documented empty bodies, and
 * the caller would treat a lost request as a success. It is the caller's
 * `catch` that has to hear about it.
 *
 * @param response - The fetch response.
 * @returns The parsed JSON, or `undefined`.
 * @throws Whatever the body stream failed with — a `TypeError` from `fetch`
 *   when the connection was lost before the response was complete.
 */
async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Collects response headers into a plain object with lowercased keys.
 *
 * @param headers - The fetch headers.
 * @returns The headers as a record.
 */
function collectHeaders(headers: Headers): Record<string, string> {
  const collected: Record<string, string> = {};
  headers.forEach((value, key) => {
    collected[key.toLowerCase()] = value;
  });
  return collected;
}

/**
 * Appends the defined query parameters to a URL.
 *
 * @param url - The URL to mutate.
 * @param query - Parameters; `undefined` values are omitted.
 */
function applyQuery(
  url: URL,
  query: Readonly<Record<string, string | number | boolean | undefined>>,
): void {
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
}

/** Methods that never carry a request body. */
const BODYLESS: ReadonlySet<HttpMethod> = new Set<HttpMethod>(['GET']);

/**
 * A {@link Transport} that talks to the server over HTTP with `fetch`.
 *
 * It does not interpret what it carries: a 401 resolves like any other response,
 * and no header it did not receive from the caller is added except `Accept`,
 * `Content-Type`, and whatever the runtime supplies. See `./transport.ts` for
 * why the seam is drawn there.
 */
export class HttpTransport implements Transport {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;

  /**
   * @param options - Base URL, timeout, and optionally the `fetch` to use.
   * @throws {ProtocolError} `BAD_REQUEST` if `baseUrl` is not an absolute
   *   `http:` or `https:` URL.
   */
  public constructor(options: HttpTransportOptions) {
    this.#baseUrl = normaliseBaseUrl(options.baseUrl);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch =
      options.fetch ?? ((input, init): Promise<Response> => globalThis.fetch(input, init));
  }

  /** The base URL this transport was built with, with no trailing slash. */
  public get baseUrl(): string {
    return this.#baseUrl;
  }

  /**
   * Performs one request.
   *
   * @param request - The fully described request.
   * @returns The status, headers, and parsed body, whatever the status was.
   * @throws {TransportError} If the request produced no usable response:
   *   connection failure, timeout, abort, or a connection lost while the
   *   response body was still arriving.
   * @throws {ProtocolError} `BAD_REQUEST` if `path` does not begin with `/`.
   */
  public async request(request: TransportRequest): Promise<TransportResponse> {
    const url = this.#resolve(request.path);
    if (request.query !== undefined) {
      applyQuery(url, request.query);
    }

    const headers: Record<string, string> = { accept: 'application/json', ...request.headers };
    const sendsBody = request.body !== undefined && !BODYLESS.has(request.method);
    if (sendsBody) {
      headers['content-type'] = 'application/json';
    }

    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signal =
      request.signal === undefined ? timeout : AbortSignal.any([timeout, request.signal]);

    let response: Response;
    try {
      response = await this.#fetch(url.toString(), {
        method: request.method,
        headers,
        signal,
        ...(sendsBody ? { body: JSON.stringify(request.body) } : {}),
      });
    } catch (cause) {
      throw this.#unreachable(request, 'failed before a response was received', cause);
    }

    let body: unknown;
    try {
      body = await readJsonBody(response);
    } catch (cause) {
      // The headers arrived, so the `catch` above has already been passed and
      // the request looks like it succeeded. A connection that dies now
      // surfaces on the body stream instead — `fetch` reports it as a
      // `TypeError` from a socket event rather than from the call that was
      // awaited — and the caller needs the same answer it would have had a
      // millisecond earlier: nothing usable arrived, so wait and retry.
      throw this.#unreachable(request, 'received a response that was cut off', cause);
    }

    return {
      status: response.status,
      headers: collectHeaders(response.headers),
      body,
    };
  }

  /**
   * The failure to raise when a request produced nothing a caller can use.
   *
   * Carries {@link ErrorCode.SERVER_UNREACHABLE} whichever half of the exchange
   * broke, because the remedy is identical and because the distinction between
   * "no response" and "half a response" is not one any caller acts on. Neither
   * the headers nor the body is quoted: a request carries a bearer token and an
   * error message is written to logs.
   *
   * @param request - The request that failed, for the method and path.
   * @param what - How far it got, in words that complete "… <what>.".
   * @param cause - Whatever `fetch` or the body stream threw.
   * @returns The error to throw.
   */
  #unreachable(request: TransportRequest, what: string, cause: unknown): TransportError {
    return new TransportError(
      `Could not reach ${this.#baseUrl}: ${request.method} ${request.path} ${what}.`,
      { cause },
    );
  }

  /**
   * Joins a request path to the base URL.
   *
   * @param path - A path beginning with `/`.
   * @returns The absolute URL.
   * @throws {ProtocolError} `BAD_REQUEST` if `path` does not begin with `/`.
   */
  #resolve(path: string): URL {
    if (!path.startsWith('/')) {
      throw new ProtocolError(
        ErrorCode.BAD_REQUEST,
        `Expected a request path beginning with "/", got ${JSON.stringify(path)}.`,
      );
    }
    return new URL(`${this.#baseUrl}${path}`);
  }
}

/**
 * Validates a base URL and strips its trailing slash.
 *
 * Rejecting a non-HTTP URL here rather than at the first request means a
 * mistyped `AGENTCHAT_URL` fails when the client is built, with a message naming
 * the value, instead of surfacing as a connection error much later.
 *
 * @param baseUrl - The configured server URL.
 * @returns The URL with no trailing slash.
 * @throws {ProtocolError} `BAD_REQUEST` if it is not an absolute `http:` or
 *   `https:` URL.
 */
export function normaliseBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ProtocolError(
      ErrorCode.BAD_REQUEST,
      `Expected an absolute server URL such as https://chat.example.com, got ${JSON.stringify(baseUrl)}.`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProtocolError(
      ErrorCode.BAD_REQUEST,
      `Expected a server URL using http or https, got ${JSON.stringify(baseUrl)}.`,
    );
  }
  return parsed.toString().replace(/\/+$/, '');
}
