/**
 * `client.messages` — sending (plan §3, §4.4).
 *
 * One method today. The reading half — the pending inbox and the
 * acknowledgement that clears it — arrives with the command that needs it
 * (`agentchat listen`), because the server refuses half of what plan §3 offers
 * there and a method that promised the refused half would be a method that
 * cannot work.
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

import type { SendMessageRequest, SendMessageResponse } from '@agentchat/protocol';
import { SendMessageRequestSchema, SendMessageResponseSchema } from '@agentchat/protocol';

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
}
