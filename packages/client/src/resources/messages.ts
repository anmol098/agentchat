/**
 * `client.messages` — sending, reading the inbox, acknowledging (plan §3, §4.4).
 *
 * T-311 shipped {@link MessagesApi.send} alone and said the reading half would
 * arrive with the command that needed it. It has: `agentchat inbox`,
 * `agentchat ack` and the polling half of the product are T-313, and
 * {@link MessagesApi.list} and {@link MessagesApi.acknowledge} are what they
 * are built on.
 *
 * ## `list` can ask for a listing the server may refuse
 *
 * `GET /messages?status=all` is Plan §3's historical listing. A server that has
 * not implemented it answers `BAD_REQUEST` naming which half is missing —
 * deliberately, rather than quietly serving `pending` — and this method passes
 * that failure through untouched. That is the honest translation: the caller
 * asked a question the server declined to answer, and a client that swallowed
 * the refusal and returned the pending queue would be answering a different
 * question than the one it was asked. `agentchat inbox --all` turns it into a
 * sentence a person can act on; `@agentchat/protocol`'s `schemas/messages.ts`
 * records what the enum does and does not promise.
 *
 * ## An acknowledgement that changed nothing is a success
 *
 * {@link AcknowledgeMessageResponse.alreadyAcknowledged} is reported and never
 * raised. A repeat is the expected shape of a retry, of two sessions of one
 * agent (D3), and of an acknowledgement racing a replay, so a harness that
 * retries hits it constantly and by design. Nothing here treats it as an error,
 * and a caller that ignores the flag entirely is still correct.
 *
 * ## Why `send` returns an outcome rather than a message
 *
 * A repeated `clientMessageId` from the same sender is answered with the
 * *original* message: same id, same `createdAt`, no second row. The server says
 * which happened on the status line — 201 wrote it, 200 found it — and the body
 * is byte-identical either way, because one fact belongs in one place and a
 * `duplicate` field beside the message would invite a caller to branch on the
 * one that contradicts the other.
 *
 * A caller still has to be able to tell. A harness that retried a send whose
 * response it never saw wants to know whether its retry was the attempt that
 * landed; a person wants to know why the message they just sent is timestamped
 * four seconds ago. So this is the one place the status becomes a value:
 * {@link SendMessageOutcome.duplicate}. It is never an error, and a caller that
 * ignores it is still correct.
 *
 * @module
 */

import type {
  AcknowledgeMessageRequest,
  AcknowledgeMessageResponse,
  ListMessagesQuery,
  ListMessagesResponse,
  MessageId as MessageIdType,
  SendMessageRequest,
  SendMessageResponse,
} from '@agentchat/protocol';
import {
  AcknowledgeMessageRequestSchema,
  AcknowledgeMessageResponseSchema,
  ListMessagesQuerySchema,
  ListMessagesResponseSchema,
  SendMessageRequestSchema,
  SendMessageResponseSchema,
} from '@agentchat/protocol';

import type { ApiClient, RequestOptions } from '../api.js';
import { parseRequest, signalOf } from '../api.js';

/** What a send did, as well as what it produced. */
export interface SendMessageOutcome {
  /**
   * The committed message.
   *
   * The original when {@link SendMessageOutcome.duplicate} is `true`, with its
   * original identifier and timestamp — not a copy, and not this attempt's.
   */
  readonly message: SendMessageResponse;

  /**
   * `true` when the server matched an earlier send with the same
   * `clientMessageId` and wrote nothing.
   *
   * Reported, never raised: a duplicate is a successful send that happened
   * twice, and the message is delivered exactly once either way.
   */
  readonly duplicate: boolean;
}

/** Message endpoints. Reached as `client.messages`. */
export class MessagesApi {
  readonly #api: ApiClient;

  /**
   * @param api - The request pipeline.
   */
  public constructor(api: ApiClient) {
    this.#api = api;
  }

  /**
   * Sends a message: `POST /messages`.
   *
   * Safe to retry with the same `clientMessageId`; see the module note. The
   * pipeline itself does not retry — a `TransportError` here means the response
   * was never seen, and whether to try again is the caller's decision because
   * only the caller knows whether it is holding the same idempotency key.
   *
   * @param request - The send. `clientMessageId` must be one the caller can
   *   repeat, not one minted per attempt.
   * @param options - Per-call options.
   * @returns The committed message, and whether this call wrote it.
   * @throws {ApiError} `NOT_FOUND` if the recipient, the conversation or the
   *   parent message is not visible to the caller; `FORBIDDEN` if the caller is
   *   not in the project; `AGENT_NOT_IN_PROJECT` if either agent is not;
   *   `PAYLOAD_TOO_LARGE` if the content exceeds the 1 MiB limit (D10).
   * @throws {TransportError} If no response was produced at all. The send may
   *   or may not have been committed — retry with the same `clientMessageId`.
   */
  public async send(
    request: SendMessageRequest,
    options?: RequestOptions,
  ): Promise<SendMessageOutcome> {
    const body = parseRequest(SendMessageRequestSchema, request, 'The message to send');
    const received = await this.#api.exchange({
      method: 'POST',
      path: '/messages',
      auth: 'required',
      body,
      response: SendMessageResponseSchema,
      ...signalOf(options),
    });

    // 201 is the only status that means "written by this call". Anything else
    // below 400 — 200 today — is the server handing back what it already had.
    return { message: received.body, duplicate: received.status !== 201 };
  }

  /**
   * Reads one page of an agent's messages: `GET /messages`.
   *
   * `status: 'pending'` is the replay queue — what this agent still owes an
   * acknowledgement for in this project, oldest first, unchanged by being read.
   * `status: 'all'` is Plan §3's historical listing; see the module note on why
   * a server may refuse it and why that refusal is passed through.
   *
   * Paging is by `after`, which takes the previous page's `nextCursor`. The
   * cursor is a message id and the ordering is by message id, which is
   * chronological because a `msg_` identifier is a UUIDv7 — so a caller
   * draining a backlog never has to sort and never sees a row twice.
   *
   * @param query - Project, agent, which listing, and optional paging. `status`
   *   defaults to `pending`.
   * @param options - Per-call options.
   * @returns One page and a cursor, `null` when the listing was drained.
   * @throws {ApiError} `BAD_REQUEST` for a listing this server does not
   *   implement or a malformed `limit`; `NOT_FOUND` when the caller is not in
   *   the project or the agent is not theirs; `AGENT_DELETED` for their own
   *   soft-deleted agent; `AGENT_NOT_IN_PROJECT` when it is live but not in the
   *   project.
   */
  public async list(
    query: ListMessagesQuery,
    options?: RequestOptions,
  ): Promise<ListMessagesResponse> {
    const parsed = parseRequest(ListMessagesQuerySchema, query, 'The message listing');
    return await this.#api.send({
      method: 'GET',
      path: '/messages',
      auth: 'required',
      query: {
        projectId: parsed.projectId,
        agentId: parsed.agentId,
        status: parsed.status,
        ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
        ...(parsed.after === undefined ? {} : { after: parsed.after }),
      },
      response: ListMessagesResponseSchema,
      ...signalOf(options),
    });
  }

  /**
   * Clears one message from an agent's queue: `POST /messages/:id/ack`.
   *
   * Idempotent, and that is a contract rather than an accident (D3): a message
   * already acknowledged — by this session, by another session of the same
   * agent, or by an earlier attempt of this same call — comes back with
   * `alreadyAcknowledged: true` and nothing is rewritten. That is a **success**,
   * and `acknowledgedAt` is when the debt was first settled rather than when
   * this call asked.
   *
   * Safe to retry for the same reason. The only failure a caller has to handle
   * is `NOT_FOUND`, which means the message is not owed to this agent in this
   * project — including because it does not exist, deliberately the same answer,
   * since a caller who may not acknowledge a message may not learn it exists.
   *
   * @param messageId - The message to acknowledge.
   * @param request - The agent whose queue it clears, the project that queue is
   *   scoped to, and optionally the session it arrived on. The session is
   *   recorded for diagnostics and never consulted.
   * @param options - Per-call options.
   * @returns What the acknowledgement did and when the debt was settled.
   * @throws {ApiError} `NOT_FOUND` when the message is not owed to this agent
   *   in this project; `FORBIDDEN` if the caller is not in the project;
   *   `AGENT_NOT_IN_PROJECT` if the agent is not.
   */
  public async acknowledge(
    messageId: MessageIdType,
    request: AcknowledgeMessageRequest,
    options?: RequestOptions,
  ): Promise<AcknowledgeMessageResponse> {
    const body = parseRequest(
      AcknowledgeMessageRequestSchema,
      request,
      'The acknowledgement to send',
    );
    return await this.#api.send({
      method: 'POST',
      path: `/messages/${messageId}/ack`,
      auth: 'required',
      body,
      response: AcknowledgeMessageResponseSchema,
      ...signalOf(options),
    });
  }
}
