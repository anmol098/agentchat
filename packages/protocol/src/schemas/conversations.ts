/**
 * Reading one thread: the `GET /conversations/:id` contract (plan §3, D15).
 *
 * ## Where this came from
 *
 * `server/src/routes/conversations.ts` declared these shapes locally in T-305
 * with a note saying they belonged in `packages/protocol` "as soon as that
 * package is opened", and that its own `ConversationMessageSchema` was "the
 * same eight fields `./messages.ts` sends for a send and for the inbox",
 * declared twice only so two route modules would not depend on each other.
 * T-313 — `agentchat conversation`, the first client of the endpoint — is what
 * opens it, so the duplicate collapses here: this module has no message schema
 * of its own and reuses {@link MessageSchema}. The server's copies are still
 * where they were; deleting them means editing route modules this task does not
 * own, and T-038 is filed for exactly that.
 *
 * ## The response carries a cursor, which Plan §3 does not mention
 *
 * §3 writes the response as `{ conversation, messages[] }` — the thread whole.
 * T-301 measured why that cannot stand: a thread's rows sit roughly one to a
 * heap page, so an unbounded read is gathered by a bitmap scan and sorted
 * afterwards at any table size, and a thread has no upper bound while each
 * message in it may be a megabyte (D10). The read is therefore paged and the
 * shape gains {@link ReadConversationResponseSchema.shape.nextCursor}, null at
 * the end of the thread. Adding a field is additive under §12.4, and a client
 * written against §3 as it stands still reads a correct first page.
 *
 * A client that wants the thread whole follows the cursor. `agentchat
 * conversation` does exactly that, up to a ceiling it documents, and says so
 * rather than truncating quietly.
 *
 * ## A page is the caller's view, not the thread
 *
 * D15 is applied per message by the server. A conversation may hold messages
 * between agents the caller owns neither end of; those are absent from the page
 * rather than redacted, and `nextCursor` counts only what the caller may read,
 * so paging never reveals the size of what it skipped. A client must therefore
 * not treat a thread's message count as the thread's length.
 *
 * @module
 */

import { z } from 'zod';

import { ConversationId, MessageId, ProjectId } from '../ids.js';
import { MessageSchema } from './messages.js';
import { TimestampSchema } from './primitives.js';

/** The thread itself. Almost empty, because the table is (PRD §3.7). */
export const ConversationSchema = z.object({
  /** `cnv_` identifier. */
  id: ConversationId.schema,
  /** The project the thread belongs to — the boundary it sits behind. */
  projectId: ProjectId.schema,
  /** When the thread was opened, i.e. when its first message was sent. */
  createdAt: TimestampSchema,
});

/** A thread, as the wire carries it. */
export type Conversation = z.infer<typeof ConversationSchema>;

/** Path parameters for `GET /conversations/:id`. */
export const ConversationIdParamsSchema = z.object({
  /** The conversation's identifier, from the URL path. */
  id: ConversationId.schema,
});

/** `GET /conversations/:id` path parameters. */
export type ConversationIdParams = z.infer<typeof ConversationIdParamsSchema>;

/**
 * `GET /conversations/:id` query string.
 *
 * Both parameters are optional: a caller who asks for nothing gets the first
 * page at the server's default size, which is what makes the paging additive
 * for a client written against Plan §3 as it stands.
 */
export const ReadConversationQuerySchema = z.object({
  /** Page size. Clamped by the server; omitted means its default. */
  limit: z.coerce.number().int().min(1).optional(),
  /** Resume after this message, exclusive. A previous page's `nextCursor`. */
  after: MessageId.schema.optional(),
});

/** `GET /conversations/:id` query parameters. */
export type ReadConversationQuery = z.infer<typeof ReadConversationQuerySchema>;

/**
 * `GET /conversations/:id` response.
 *
 * `messages` is the envelope for the list — D17's argument is that a bare array
 * cannot grow a cursor, and this object already carries one beside a named
 * list, so wrapping the array a second time would only make
 * `{ conversation, messages: { items } }`.
 */
export const ReadConversationResponseSchema = z.object({
  /** The thread the caller was allowed to read. */
  conversation: ConversationSchema,
  /** The readable messages on this page, oldest first. */
  messages: z.array(MessageSchema),
  /** Where to resume, or null when this page reached the end of the thread. */
  nextCursor: MessageId.schema.nullable(),
});

/** `GET /conversations/:id` response body. */
export type ReadConversationResponse = z.infer<typeof ReadConversationResponseSchema>;
