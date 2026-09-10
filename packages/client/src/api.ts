/**
 * The request pipeline: everything that happens to every request, in one place.
 *
 * Headers, authentication, the one refresh and the one retry, error
 * translation, and schema validation of the response. It sits between the typed
 * methods in `./resources/` and the {@link Transport}, so a second transport
 * inherits all of it without reimplementing any of it.
 *
 * ## Order of operations
 *
 * ```text
 * load credentials (authenticated calls only)
 * attach Authorization and X-AgentChat-Client
 * transport.request(…)
 *   401 on an authenticated call, first attempt only
 *     → TokenManager.renew(the token that just failed)   ← single-flight
 *     → retry once
 * status >= 400  → ApiError carrying the server's stable code
 * status  < 400  → parse the body with the endpoint's protocol schema
 * ```
 *
 * The retry budget is exactly one, per plan §5. There is no backoff and no
 * retry on 5xx: a stateless command that quietly retried a `POST /messages`
 * would risk delivering it twice, and the idempotency key that would make that
 * safe belongs to the messaging milestone. Reconnect backoff is T-310's, on the
 * socket, where it applies to a connection rather than to a mutation.
 *
 * @module
 */

import {
  CLIENT_VERSION_HEADER,
  ErrorCode,
  formatClientVersionHeader,
  ProtocolError,
  SemanticVersionSchema,
} from '@stackgrid/protocol';
import type { z } from 'zod';

import { apiErrorFromResponse, ResponseFormatError } from './errors.js';
import type { TokenManager } from './tokens.js';
import type { HttpMethod, QueryValue, Transport, TransportResponse } from './transport.js';

/**
 * Whether an endpoint needs the caller to be authenticated.
 *
 * `'none'` is not "send the token if we happen to have one": it means no
 * `Authorization` header and no refresh, which is required for
 * `/auth/device/*`, `/version`, and `/auth/refresh` itself. Refreshing in
 * response to a 401 from the refresh endpoint would recurse.
 */
export type AuthRequirement = 'required' | 'none';

/** One typed call, as the resource modules describe it. */
export interface Call<TResponse> {
  /** The HTTP method. */
  readonly method: HttpMethod;

  /** The path, with path parameters already substituted. */
  readonly path: string;

  /** Query parameters, if any. */
  readonly query?: Readonly<Record<string, QueryValue>>;

  /** The request body, already validated against its request schema. */
  readonly body?: unknown;

  /** Whether to authenticate. */
  readonly auth: AuthRequirement;

  /** The protocol schema the response body must satisfy. */
  readonly response: z.ZodType<TResponse>;

  /** Aborts the call when signalled. */
  readonly signal?: AbortSignal;
}

/**
 * A parsed response together with the status that carried it.
 *
 * Almost every endpoint puts its whole answer in the body, which is why
 * {@link ApiClient.send} returns the body alone. `POST /messages` is the
 * exception: 201 means this call wrote the message and 200 means it matched one
 * the sender had already sent, and the *body is identical either way*. The
 * distinction exists nowhere but the status line, deliberately — see
 * `@stackgrid/protocol`'s `schemas/messages.ts` — so a caller that needs it has
 * to be handed the status rather than left to infer it.
 */
export interface Received<TResponse> {
  /** The HTTP status. Always below 400; anything else has already thrown. */
  readonly status: number;

  /** The response body, parsed by the endpoint's protocol schema. */
  readonly body: TResponse;
}

/** Construction options for {@link ApiClient}. */
export interface ApiClientOptions {
  /** How requests actually travel. */
  readonly transport: Transport;

  /** Where credentials live and how refreshes are serialised. */
  readonly tokens: TokenManager;

  /**
   * This client's own release version, for the `X-AgentChat-Client` header, or
   * `null` to send no version header.
   *
   * See {@link AgentChatClientOptions.clientVersion} for why `null` is a real
   * choice and not a degraded one.
   */
  readonly clientVersion: string | null;
}

/**
 * Applies the pipeline to one call at a time.
 *
 * Stateless apart from the {@link TokenManager} it holds; it is safe to issue
 * any number of calls concurrently, which is the case the refresh logic is built
 * for.
 */
export class ApiClient {
  readonly #transport: Transport;
  readonly #tokens: TokenManager;
  readonly #versionHeader: string | null;

  /**
   * @param options - Transport, token manager, and client version.
   */
  public constructor(options: ApiClientOptions) {
    this.#transport = options.transport;
    this.#tokens = options.tokens;
    this.#versionHeader =
      options.clientVersion === null
        ? null
        : formatClientVersionHeader(
            parseRequest(
              SemanticVersionSchema,
              options.clientVersion,
              'The client version for the X-AgentChat-Client header',
            ),
          );
  }

  /**
   * Performs one call and returns its parsed response.
   *
   * @param call - What to send and what shape to expect back.
   * @returns The response body, parsed by the endpoint's protocol schema.
   * @throws {ApiError} If the server answered 4xx or 5xx. `code` is a known
   *   error code; `wireCode` is exactly what the server sent.
   * @throws {ProtocolError} `AUTH_REQUIRED` if the call needs credentials and
   *   there are none, or if a refresh was rejected.
   * @throws {TransportError} If no response was produced at all.
   * @throws {ResponseFormatError} If the body did not match the schema.
   */
  public async send<TResponse>(call: Call<TResponse>): Promise<TResponse> {
    return (await this.exchange(call)).body;
  }

  /**
   * Performs one call and returns its status alongside its parsed response.
   *
   * {@link ApiClient.send} is this with the status dropped, and is what every
   * endpoint whose answer is entirely in its body should use. Reach for this
   * one only where the status is itself part of the answer; see
   * {@link Received}.
   *
   * @param call - What to send and what shape to expect back.
   * @returns The status and the parsed body.
   * @throws {ApiError} If the server answered 4xx or 5xx. `code` is a known
   *   error code; `wireCode` is exactly what the server sent.
   * @throws {ProtocolError} `AUTH_REQUIRED` if the call needs credentials and
   *   there are none, or if a refresh was rejected.
   * @throws {TransportError} If no response was produced at all.
   * @throws {ResponseFormatError} If the body did not match the schema.
   */
  public async exchange<TResponse>(call: Call<TResponse>): Promise<Received<TResponse>> {
    const response = await this.#exchange(call);

    if (response.status >= 400) {
      throw apiErrorFromResponse(response.status, response.body);
    }

    const parsed = call.response.safeParse(response.body ?? {});
    if (!parsed.success) {
      throw new ResponseFormatError(
        `The server's response to ${call.method} ${call.path} did not match the expected shape.`,
        { cause: parsed.error },
      );
    }
    return { status: response.status, body: parsed.data };
  }

  /**
   * Sends the request, refreshing and retrying once on a 401.
   *
   * @param call - The call to perform.
   * @returns The transport response, whatever its status.
   */
  async #exchange<TResponse>(call: Call<TResponse>): Promise<TransportResponse> {
    if (call.auth === 'none') {
      return this.#transport.request({
        method: call.method,
        path: call.path,
        headers: this.#headers(null),
        ...(call.query === undefined ? {} : { query: call.query }),
        ...(call.body === undefined ? {} : { body: call.body }),
        ...(call.signal === undefined ? {} : { signal: call.signal }),
      });
    }

    // Two attempts at most: the original, and one retry after exactly one
    // refresh. A 401 on the retry falls through and becomes AUTH_REQUIRED.
    for (let attempt = 0; ; attempt += 1) {
      const credentials = await this.#tokens.require();
      const response = await this.#transport.request({
        method: call.method,
        path: call.path,
        headers: this.#headers(credentials.accessToken),
        ...(call.query === undefined ? {} : { query: call.query }),
        ...(call.body === undefined ? {} : { body: call.body }),
        ...(call.signal === undefined ? {} : { signal: call.signal }),
      });

      if (response.status !== 401 || attempt > 0) {
        return response;
      }

      // Naming the token that actually failed is what lets the manager tell a
      // genuine 401 from one that raced a refresh another request already did.
      await this.#tokens.renew(credentials.accessToken);
    }
  }

  /**
   * Builds the headers common to every request.
   *
   * @param accessToken - The bearer token, or `null` for an unauthenticated
   *   call.
   * @returns The headers to send.
   */
  #headers(accessToken: string | null): Record<string, string> {
    const headers: Record<string, string> = {};
    if (accessToken !== null) {
      headers['authorization'] = `Bearer ${accessToken}`;
    }
    if (this.#versionHeader !== null) {
      headers[CLIENT_VERSION_HEADER] = this.#versionHeader;
    }
    return headers;
  }
}

/**
 * Per-call options every typed method accepts.
 *
 * One interface rather than a positional argument on each method, so a later
 * addition — an idempotency key, a per-call deadline — is an optional property
 * instead of a new parameter on twenty signatures.
 */
export interface RequestOptions {
  /** Aborts the call when signalled. */
  readonly signal?: AbortSignal;
}

/**
 * Spreads an abort signal into a call only when there is one.
 *
 * `exactOptionalPropertyTypes` is on, so `{ signal: undefined }` is not the same
 * as an absent `signal` and will not type-check against {@link Call}.
 *
 * @param options - The caller's options, if any.
 * @returns Either `{}` or `{ signal }`.
 */
export function signalOf(options?: RequestOptions): { signal?: AbortSignal } {
  return options?.signal === undefined ? {} : { signal: options.signal };
}

/**
 * Validates a value against a protocol schema before it leaves the process.
 *
 * Requests are validated for the same reason responses are: a body the server
 * will reject should fail here, where the message can name the field, rather
 * than as a `BAD_REQUEST` that has cost a round trip. The failure is turned into
 * a {@link ProtocolError} because subagent protocol §7.3 forbids throwing a bare
 * error — a `ZodError` reaching the CLI would have no stable code to render.
 *
 * @param schema - The protocol schema to validate against.
 * @param value - The caller's value.
 * @param what - What is being validated, for the message — "The agent to
 *   create". Never include the value itself: request bodies carry tokens.
 * @returns The parsed value.
 * @throws {ProtocolError} `BAD_REQUEST` if it does not match.
 */
export function parseRequest<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  throw new ProtocolError(ErrorCode.BAD_REQUEST, `${what} is not valid. ${detail}`, {
    cause: parsed.error,
  });
}
