/**
 * A mock AgentChat server, as a `fetch`.
 *
 * The client's whole job is to turn HTTP into typed results, so the thing worth
 * testing is what it does with a given status and body. That is a function from
 * a request to a response, which is exactly what `fetch` is — so the mock server
 * is a `FetchLike` handed to {@link HttpTransport}, and no socket is opened.
 *
 * The point is not speed. It is that every scenario this package has to get
 * right — a 401 on the first call and a 200 on the retry, a refresh token that
 * is accepted once and revokes the chain on reuse, a body that is nearly the
 * right shape — is expressible as a route and is deterministic. Racing real
 * requests against a real server to reproduce a concurrent refresh would be a
 * flaky test of somebody else's code; the integration suite tests the real thing
 * later, against the real server, which is where that belongs.
 *
 * Not part of the built package: `tsconfig.json` excludes this directory, so it
 * is type-checked but never emitted to `dist`.
 *
 * @module
 */

import type { FetchLike } from '../http-transport.js';

/** One recorded request, as the assertions want to read it. */
export interface RecordedRequest {
  /** The HTTP method. */
  readonly method: string;
  /** The path, without the origin but with the query string. */
  readonly path: string;
  /** Request headers, lowercased keys. */
  readonly headers: Readonly<Record<string, string>>;
  /** The parsed JSON body, or `undefined` if there was none. */
  readonly body: unknown;
}

/** What a route decides to answer with. */
export interface MockReply {
  /** The HTTP status. */
  readonly status: number;
  /** The body to serialise, or `undefined` for an empty body. */
  readonly body?: unknown;
  /** A raw body, used verbatim. Takes precedence over `body`. */
  readonly rawBody?: string;
  /** Extra response headers. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Decides what to answer, given the request and how many times this route has
 * already been called.
 *
 * The call count is passed because most of the scenarios worth testing are
 * "fails the first time, succeeds the second".
 */
export type MockRoute = (
  request: RecordedRequest,
  callCount: number,
) => MockReply | Promise<MockReply>;

/** The origin every mock server answers on. */
export const MOCK_BASE_URL = 'https://mock.agentchat.test';

/** An error envelope, in the shape the protocol defines. */
export function envelope(
  code: string,
  message = 'mock failure',
): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

/**
 * A `fetch` that answers from a routing table and records what it was asked.
 *
 * Routes are keyed `"<METHOD> <path>"` with no query string — `"GET /projects"`.
 * A request with no matching route answers `404` with a `NOT_FOUND` envelope,
 * which is a legible failure rather than a hang.
 */
export class MockServer {
  readonly #routes = new Map<string, MockRoute>();
  readonly #calls: RecordedRequest[] = [];
  readonly #counts = new Map<string, number>();

  /** Every request received, in order. */
  public get calls(): readonly RecordedRequest[] {
    return this.#calls;
  }

  /**
   * How many times a route was called.
   *
   * @param key - `"<METHOD> <path>"`, e.g. `"POST /auth/refresh"`.
   * @returns The call count, zero if never called.
   */
  public countOf(key: string): number {
    return this.#counts.get(key) ?? 0;
  }

  /**
   * Registers or replaces a route.
   *
   * @param key - `"<METHOD> <path>"`, e.g. `"GET /projects"`.
   * @param route - What to answer.
   * @returns This server, for chaining.
   */
  public on(key: string, route: MockRoute): this {
    this.#routes.set(key, route);
    return this;
  }

  /**
   * Registers a route that always answers the same thing.
   *
   * @param key - `"<METHOD> <path>"`.
   * @param reply - The fixed reply.
   * @returns This server, for chaining.
   */
  public reply(key: string, reply: MockReply): this {
    return this.on(key, () => reply);
  }

  /**
   * The `fetch` to hand to {@link HttpTransport}.
   *
   * @returns A function with the shape the transport expects.
   */
  public fetch(): FetchLike {
    return async (input, init): Promise<Response> => {
      const url = new URL(input);
      const method = (init.method ?? 'GET').toUpperCase();
      const key = `${method} ${url.pathname}`;

      const recorded: RecordedRequest = {
        method,
        path: `${url.pathname}${url.search}`,
        headers: normaliseHeaders(init.headers),
        body: parseBody(init.body),
      };
      this.#calls.push(recorded);

      const count = this.#counts.get(key) ?? 0;
      this.#counts.set(key, count + 1);

      const route = this.#routes.get(key);
      const reply: MockReply =
        route === undefined
          ? { status: 404, body: envelope('NOT_FOUND', `No mock route for ${key}.`) }
          : await route(recorded, count);

      return toResponse(reply);
    };
  }
}

/**
 * Renders a {@link MockReply} as a `Response`.
 *
 * @param reply - What the route decided.
 * @returns The response the transport will see.
 */
function toResponse(reply: MockReply): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...reply.headers };
  const body = reply.rawBody ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
  return new Response(body.length === 0 ? null : body, { status: reply.status, headers });
}

/**
 * Flattens whatever `fetch` was given as headers into a record.
 *
 * @param headers - The `HeadersInit` from the request.
 * @returns Lowercased header names to values.
 */
function normaliseHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const collected: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    collected[key.toLowerCase()] = value;
  });
  return collected;
}

/**
 * Parses a request body, which this client always sends as a JSON string.
 *
 * @param body - The body from the request init.
 * @returns The parsed value, or `undefined` when there was no body.
 */
function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== 'string' || body.length === 0) {
    return undefined;
  }
  return JSON.parse(body) as unknown;
}
