/**
 * `client.conversations` — reading one thread (plan §3, D15).
 *
 * One endpoint and one method. It is its own resource rather than a third
 * method on {@link MessagesApi} because it is addressed by a conversation and
 * not by an agent: it needs no project, no agent and no inbox, which is exactly
 * why `agentchat conversation cnv_…` works from a directory that has no
 * repository configuration at all.
 *
 * ## The read is paged, and the caller decides what to do about that
 *
 * Plan §3 writes the response as the thread whole. T-301 measured why it cannot
 * be: a thread has no upper bound and each message in it may be a megabyte
 * (D10), so the read is bounded by a limit and returns `nextCursor`. This method
 * returns exactly one page and follows nothing on the caller's behalf — a
 * client that silently issued twenty requests behind a single call would make a
 * long thread indistinguishable from a slow server. `agentchat conversation`
 * does the following, to a ceiling it documents.
 *
 * ## A page is the caller's view of the thread, not the thread
 *
 * D15 is applied per message inside the server's query rather than as a filter
 * over the page, so a message between two agents the caller owns neither end of
 * is *absent* rather than redacted, and `nextCursor` counts only readable rows.
 * A caller must therefore not read a thread's length out of the number of
 * messages it got back.
 *
 * @module
 */

import type {
  ConversationId as ConversationIdType,
  ReadConversationQuery,
  ReadConversationResponse,
} from '@stackgrid/protocol';
import { ReadConversationQuerySchema, ReadConversationResponseSchema } from '@stackgrid/protocol';

import type { ApiClient, RequestOptions } from '../api.js';
import { parseRequest, signalOf } from '../api.js';

/** Conversation endpoints. Reached as `client.conversations`. */
export class ConversationsApi {
  readonly #api: ApiClient;

  /**
   * @param api - The request pipeline.
   */
  public constructor(api: ApiClient) {
    this.#api = api;
  }

  /**
   * Reads one page of a thread: `GET /conversations/:id`.
   *
   * Messages come back oldest first. Paging is by `after`, which takes the
   * previous page's `nextCursor`; the ordering is by message id, which is
   * chronological because a `msg_` identifier is a UUIDv7, so a caller walking
   * a thread never sorts and never sees a row twice.
   *
   * @param conversationId - The thread to read.
   * @param query - Page size and cursor. Both optional; omitting them asks for
   *   the first page at the server's default size.
   * @param options - Per-call options.
   * @returns The thread, one page of its readable messages, and a cursor which
   *   is `null` when the page reached the end.
   * @throws {ApiError} `NOT_FOUND` when the thread does not exist or holds no
   *   message the caller may read — deliberately one answer for both, so that a
   *   `cnv_` identifier cannot be used to probe for threads between other
   *   people; `BAD_REQUEST` for a malformed `limit` or cursor.
   */
  public async read(
    conversationId: ConversationIdType,
    query: ReadConversationQuery = {},
    options?: RequestOptions,
  ): Promise<ReadConversationResponse> {
    const parsed = parseRequest(ReadConversationQuerySchema, query, 'The conversation page');
    return await this.#api.send({
      method: 'GET',
      path: `/conversations/${conversationId}`,
      auth: 'required',
      query: {
        ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
        ...(parsed.after === undefined ? {} : { after: parsed.after }),
      },
      response: ReadConversationResponseSchema,
      ...signalOf(options),
    });
  }
}
