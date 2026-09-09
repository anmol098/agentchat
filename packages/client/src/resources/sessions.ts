/**
 * `client.sessions` — registering a listener and tearing it down (plan §3, §6.3).
 *
 * Two methods, which are the two calls `agentchat listen` makes around the
 * socket it holds:
 *
 * ```ts
 * const { sessionId } = await client.sessions.register({ … });
 * // … hold a WebSocket bound to that session …
 * await client.sessions.end(sessionId);
 * ```
 *
 * ## Why there is no heartbeat here
 *
 * `POST /sessions/:id/heartbeat` exists, and a listener does not call it. Plan
 * §4.3 puts liveness on the socket: the connection pings, and the server's
 * sweep ages a session that stops answering. A client that also heartbeated
 * over HTTP would be asserting presence from a second place, and the two could
 * disagree — a process whose socket is dead but whose timer still fires would
 * report itself online. The socket is the honest signal, because it is the
 * thing a message is actually delivered over.
 *
 * ## `end` is best-effort by nature, and this method does not hide that
 *
 * A session is torn down at the end of a process that is, in the ordinary case,
 * being interrupted. The call can fail — the network is gone, the server is
 * restarting, the user pressed `Ctrl-C` twice — and the session is not
 * orphaned when it does: `sessions.sweep` ends anything that stops
 * heartbeating, which is exactly what a killed listener does. So this method
 * throws like any other, and the decision to treat that as a warning rather
 * than a failure belongs to the caller who knows it is shutting down.
 *
 * @module
 */

import type { EndSessionResponse, RegisterSessionRequest, SessionId } from '@agentchat/protocol';
import {
  EndSessionResponseSchema,
  RegisterSessionRequestSchema,
  RegisterSessionResponseSchema,
  SessionId as SessionIdKind,
} from '@agentchat/protocol';

import type { ApiClient, RequestOptions } from '../api.js';
import { parseRequest, signalOf } from '../api.js';

/** Session endpoints. Reached as `client.sessions`. */
export class SessionsApi {
  readonly #api: ApiClient;

  /**
   * @param api - The request pipeline.
   */
  public constructor(api: ApiClient) {
    this.#api = api;
  }

  /**
   * Registers a listening session: `POST /sessions`.
   *
   * @param request - The agent, the project, the machine, the runtime and the
   *   working directory. `runtime` is required and is never guessed (D14).
   * @param options - Per-call options.
   * @returns The new session's identifier, to quote in the WebSocket `hello`.
   * @throws {ApiError} `FORBIDDEN` if the agent is not the caller's own;
   *   `AGENT_NOT_IN_PROJECT` if it does not participate in the project;
   *   `NOT_FOUND` if either does not exist.
   * @throws {ProtocolError} `BAD_REQUEST` if the request is not valid, checked
   *   here before it costs a round trip.
   * @throws {TransportError} If no response was produced at all.
   */
  public async register(
    request: RegisterSessionRequest,
    options?: RequestOptions,
  ): Promise<SessionId> {
    const body = parseRequest(RegisterSessionRequestSchema, request, 'The session to register');
    const registered = await this.#api.send({
      method: 'POST',
      path: '/sessions',
      auth: 'required',
      body,
      response: RegisterSessionResponseSchema,
      ...signalOf(options),
    });
    return registered.sessionId;
  }

  /**
   * Ends a session: `DELETE /sessions/:id`.
   *
   * Idempotent at the server: a session that has already ended reports the
   * instant it *first* ended rather than refusing, so a teardown that raced the
   * staleness sweep is not an error.
   *
   * @param sessionId - The session to end. Must be one of the caller's own.
   * @param options - Per-call options.
   * @returns The status and the instant it ended.
   * @throws {ApiError} `FORBIDDEN` if the session belongs to another user;
   *   `NOT_FOUND` if there is no such session.
   * @throws {ProtocolError} `BAD_REQUEST` if `sessionId` is not a session
   *   identifier.
   * @throws {TransportError} If no response was produced at all.
   */
  public end(sessionId: SessionId | string, options?: RequestOptions): Promise<EndSessionResponse> {
    const id = parseRequest(SessionIdKind.schema, sessionId, 'The session to end');
    return this.#api.send({
      method: 'DELETE',
      path: `/sessions/${id}`,
      auth: 'required',
      response: EndSessionResponseSchema,
      ...signalOf(options),
    });
  }
}
