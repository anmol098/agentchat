/**
 * Reading one conversation, a page at a time (Plan §3, D15).
 *
 * `./messages.ts` accepts messages and `./inbox.ts` answers "what does this
 * agent still owe an acknowledgement for". Neither reads a thread back, and
 * this is the module that does: `GET /conversations/:id`, behind
 * `agentchat conversation <id>`.
 *
 * ## Why there is a module here at all
 *
 * The endpoint is one query, and a route could have held it. It does not,
 * because of what the query has to contain. D15 — a caller may read messages
 * where one of their own agents is sender or recipient — has to be *in* the
 * `WHERE` of that query, and a rule assembled inside a route handler is exactly
 * what `./authorization.ts` exists to prevent (its module note; `routes/projects.ts`
 * restates it as "there is no `select` in this file"). So the rule lives in the
 * authorization service, as {@link messageVisibleToCaller} and
 * `assertConversationParticipant`, and this module is the small thing between
 * that rule and a route: it pages, it orders, it maps rows to values. It decides
 * nothing about who may read what.
 *
 * ## The read is paged, and Plan §3 does not say so
 *
 * §3 writes the response as `{ conversation, messages[] }` — the whole thread.
 * T-301 measured why that cannot stand: a thread's rows are scattered roughly
 * one to a heap page, because messages are appended in arrival order interleaved
 * with every other thread in the project, so Postgres gathers them with a bitmap
 * scan and sorts afterwards **at any table size**. No index removes that sort;
 * `messages_conversation_id_created_at_idx` earns its second column only for a
 * *bounded* read. An unbounded thread read is therefore the one query in this
 * system whose cost is set by the size of the thread and by nothing the server
 * can tune — and a thread has no upper bound, while each message in it may be a
 * megabyte (D10).
 *
 * So the read takes a limit and returns a cursor, and the shape gains one
 * optional field: `{ conversation, messages[], nextCursor? }`. Adding a field is
 * additive under §12.4 — a client that ignores it reads the first page and is
 * never wrong about what it holds, where an unbounded read would eventually have
 * failed on the server instead. The plan wants amending to match, which the
 * pull request for T-305 asks for; it is recorded here because this is the file
 * that would otherwise silently disagree with it.
 *
 * ## Ordering and the cursor
 *
 * Oldest first, by `created_at` — the column the index orders and the authority
 * for anything a human reads — with `id` as the tiebreak. `./inbox.ts` orders
 * replay by `message_id` instead, and the difference is not an inconsistency:
 * replay reads `message_inbox_pending_idx`, whose trailing column *is*
 * `message_id`, so ordering by it is free there. Here the index orders by
 * `created_at`, and asking for `id` order instead would throw the index's
 * ordering away for a distinction only two messages accepted in the same
 * microsecond can notice.
 *
 * The cursor is a {@link MessageId} — the last message on the page — rather than
 * an encoded `(timestamp, id)` pair. It costs one primary-key lookup to resume
 * (the page query then ranges on `created_at`), and it buys a cursor a person can
 * read in a URL, a cursor that is checked against the thread rather than trusted,
 * and one cursor type across this module and `./inbox.ts`. The lookup applies
 * D15 as well, so a forged cursor naming a message the caller may not read is
 * refused rather than being allowed to prove that message exists.
 *
 * @module
 */

import {
  AgentId,
  ConversationId,
  ErrorCode,
  MessageId,
  ProjectId,
  ProtocolError,
  type UserId,
} from '@agentchat/protocol';
import { and, asc, eq, gt, or } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { messages } from '../db/schema/messaging.js';
import {
  type AuthorizationService,
  type ConversationRecord,
  createAuthorizationService,
  messageVisibleToCaller,
} from './authorization.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * How many messages a page holds when the caller does not choose.
 *
 * The same number as `./inbox.ts`'s `DEFAULT_PENDING_LIMIT`, for the same
 * reason and deliberately not a different one: D10 caps a message at 1 MiB, so
 * a page is worth up to a hundred megabytes of process memory in the worst case
 * a hostile-but-legal sender could arrange, and every larger default multiplies
 * that. Two limits that mean "one page of messages" and differ would only make
 * a client author guess which endpoint they were reading.
 */
export const DEFAULT_CONVERSATION_LIMIT = 100;

/**
 * The largest page this module will return.
 *
 * A caller asking for more is given this rather than an error, as the inbox
 * does: the ceiling is a property of the server's memory rather than a rule
 * about the request, and refusing would make a client's own paging loop the
 * thing that breaks.
 */
export const MAX_CONVERSATION_LIMIT = 500;

// ---------------------------------------------------------------------------
// Values a caller receives
// ---------------------------------------------------------------------------

/**
 * One message in a thread.
 *
 * The same fields `./messages.ts` returns from a send and `./inbox.ts` returns
 * from a replay, deliberately: a message is rendered the same way whether it
 * was just accepted, replayed an hour later, or read out of history, and three
 * shapes for one thing would be three renderers.
 */
export interface ConversationMessage {
  /** The message's identifier (`msg_`). Also this module's cursor. */
  readonly id: MessageId;
  /** The project it was sent in. */
  readonly projectId: ProjectId;
  /** The thread it belongs to. The one that was asked for. */
  readonly conversationId: ConversationId;
  /** The message it replies to, or `undefined` for a thread root. */
  readonly parentMessageId: MessageId | undefined;
  /** The agent that sent it. */
  readonly senderAgentId: AgentId;
  /** The agent it was addressed to. */
  readonly recipientAgentId: AgentId;
  /** The content, uninterpreted (PRD §3.7). */
  readonly content: string;
  /** When the server accepted it. */
  readonly createdAt: Date;
}

/**
 * One page of a conversation.
 *
 * `messages` holds only what D15 admits, which is not necessarily the whole
 * thread: a conversation can contain messages between agents the caller owns
 * neither end of, and those are absent rather than redacted. The page is
 * therefore "your view of this thread", and that is the only view this API has.
 */
export interface ConversationPage {
  /** The thread, as {@link AuthorizationService.assertConversationParticipant} validated it. */
  readonly conversation: ConversationRecord;

  /** The readable messages, oldest first. At most the effective limit. */
  readonly messages: readonly ConversationMessage[];

  /**
   * Where to resume, or `undefined` when this page reached the end of the
   * thread.
   *
   * Exact rather than a guess: the page is read one row wider than the limit,
   * so a cursor is present when and only when a further readable row was seen.
   * A caller reading a whole thread passes it back as
   * {@link ReadConversationRequest.after} until this is `undefined`.
   */
  readonly nextCursor: MessageId | undefined;
}

// ---------------------------------------------------------------------------
// What a caller supplies
// ---------------------------------------------------------------------------

/** Reading one thread: `GET /conversations/:id`. */
export interface ReadConversationRequest {
  /** The authenticated caller, from `request.requireUser()`. */
  readonly userId: UserId;

  /** The thread to read. */
  readonly conversationId: ConversationId;

  /**
   * How many messages to return. Clamped to {@link MAX_CONVERSATION_LIMIT};
   * omitted means {@link DEFAULT_CONVERSATION_LIMIT}.
   *
   * A non-integer or a value below one is a caller bug rather than a
   * negotiation, and is refused with {@link ErrorCode.BAD_REQUEST}.
   */
  readonly limit?: number | undefined;

  /**
   * Resume after this message, exclusive.
   *
   * The {@link ConversationPage.nextCursor} of the previous page. It must name
   * a message in this thread that the caller may read; anything else is a
   * `BAD_REQUEST` about the cursor, never a hint about the message.
   */
  readonly after?: MessageId | undefined;
}

// ---------------------------------------------------------------------------
// Database handle
// ---------------------------------------------------------------------------

/**
 * The one verb this module issues.
 *
 * A `Pick` rather than the whole Drizzle handle, following `./authorization.ts`
 * and `./messages.ts`: a pool handle and a transaction handle both satisfy it,
 * a test can wrap it, and the surface is readable without the driver's types.
 * Read-only by construction — reading a thread changes nothing about it, and a
 * module that could write would be a surprising place to find a bug.
 */
export type ConversationQueryRunner = Pick<PgDatabase<PgQueryResultHKT>, 'select'>;

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/** Reading conversation history. */
export interface ConversationService {
  /**
   * Reads one page of a thread, oldest first.
   *
   * Two statements after the access rule: the cursor's position when one was
   * given, then the page. Both are answered from
   * `messages_conversation_id_created_at_idx`.
   *
   * @param request - Caller, thread, and optional paging.
   * @returns The thread, the readable messages on this page, and a cursor when
   *   more remain.
   * @throws {ProtocolError} `NOT_FOUND` when the conversation does not exist,
   *   is in a project the caller is not in, or holds nothing they may read —
   *   one answer for all three; `BAD_REQUEST` for a malformed `limit` or a
   *   cursor that is not a readable message in this thread.
   */
  read(request: ReadConversationRequest): Promise<ConversationPage>;
}

/** What {@link createConversationService} needs. */
export interface ConversationServiceOptions {
  /** Drizzle handle the page is read through. */
  readonly db: ConversationQueryRunner;

  /**
   * The permission matrix.
   *
   * Optional so a wiring site is one argument; supplied when an application
   * shares one instance with the other route modules, which is what keeps "how
   * many statements does a request cost" answerable in one place.
   */
  readonly authorization?: AuthorizationService | undefined;
}

/** The columns a {@link ConversationMessage} is built from. */
const MESSAGE_COLUMNS = {
  id: messages.id,
  projectId: messages.projectId,
  conversationId: messages.conversationId,
  parentMessageId: messages.parentMessageId,
  senderAgentId: messages.senderAgentId,
  recipientAgentId: messages.recipientAgentId,
  content: messages.content,
  createdAt: messages.createdAt,
} as const;

/** The shape {@link MESSAGE_COLUMNS} produces. */
interface MessageRow {
  readonly id: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly parentMessageId: string | null;
  readonly senderAgentId: string;
  readonly recipientAgentId: string;
  readonly content: string;
  readonly createdAt: Date;
}

/**
 * Puts a row on the wire.
 *
 * Identifiers are branded without re-parsing, the sanctioned alternative to an
 * `as` cast: they come from columns whose `CHECK` constraints already pin the
 * prefix and the UUIDv7 shape.
 *
 * @param row - The row as Drizzle returned it.
 * @returns The value a caller receives.
 */
function toMessage(row: MessageRow): ConversationMessage {
  return {
    id: MessageId.unsafeCast(row.id),
    projectId: ProjectId.unsafeCast(row.projectId),
    conversationId: ConversationId.unsafeCast(row.conversationId),
    parentMessageId:
      row.parentMessageId === null ? undefined : MessageId.unsafeCast(row.parentMessageId),
    senderAgentId: AgentId.unsafeCast(row.senderAgentId),
    recipientAgentId: AgentId.unsafeCast(row.recipientAgentId),
    content: row.content,
    createdAt: row.createdAt,
  };
}

/**
 * Settles how many rows a page holds.
 *
 * Exported because it is a documented part of the contract — the default and
 * the maximum are what T-305's acceptance criteria call "a documented default
 * and maximum" — and because a route's tests should be able to assert the
 * clamp without a database.
 *
 * @param limit - What the caller asked for, if anything.
 * @returns The effective page size.
 * @throws {ProtocolError} `BAD_REQUEST` when the value is not a whole number of
 *   at least one. A limit of zero is a request for nothing, which is a client
 *   bug rather than an intention worth serving silently.
 */
export function resolveConversationLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_CONVERSATION_LIMIT;
  }

  if (!Number.isInteger(limit) || limit < 1) {
    throw new ProtocolError(ErrorCode.BAD_REQUEST, 'limit must be a whole number of at least 1.');
  }

  return Math.min(limit, MAX_CONVERSATION_LIMIT);
}

/**
 * Builds the conversation read over a database handle.
 *
 * @param options - The handle, and optionally a shared permission matrix.
 * @returns The service.
 */
export function createConversationService(
  options: ConversationServiceOptions,
): ConversationService {
  const { db } = options;
  const authorization = options.authorization ?? createAuthorizationService(db);

  /**
   * Finds where a cursor sits in the thread.
   *
   * The cursor names a message, and the page needs its `created_at` to range
   * on. The lookup carries the thread and D15 in its own `WHERE`, so a cursor
   * that names a message in another thread, or one the caller may not read, is
   * indistinguishable from one that names nothing — and the answer says only
   * that the cursor is unusable.
   *
   * @param userId - The caller.
   * @param conversationId - The thread being read.
   * @param after - The cursor.
   * @returns The instant and id to resume after.
   * @throws {ProtocolError} `BAD_REQUEST` when the cursor is not a readable
   *   message in this thread.
   */
  async function locateCursor(
    userId: UserId,
    conversationId: ConversationId,
    after: MessageId,
  ): Promise<{ createdAt: Date; id: string }> {
    const rows = await db
      .select({ id: messages.id, createdAt: messages.createdAt })
      .from(messages)
      .where(
        and(
          eq(messages.id, after),
          eq(messages.conversationId, conversationId),
          messageVisibleToCaller(userId),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      throw new ProtocolError(
        ErrorCode.BAD_REQUEST,
        'That cursor does not name a message in this conversation.',
      );
    }

    return row;
  }

  return {
    async read(request: ReadConversationRequest): Promise<ConversationPage> {
      // The access rule, before anything is read. It answers NOT_FOUND for a
      // thread that does not exist, one in another project, and one none of the
      // caller's agents is party to — the three cases a project member must not
      // be able to tell apart.
      const conversation = await authorization.assertConversationParticipant({
        userId: request.userId,
        conversationId: request.conversationId,
      });

      const limit = resolveConversationLimit(request.limit);

      const cursor =
        request.after === undefined
          ? undefined
          : await locateCursor(request.userId, request.conversationId, request.after);

      // Keyset paging, written as an `OR` rather than as a row comparison so
      // each half is a plain predicate on a column the index holds: everything
      // strictly later, plus the same instant with a larger id. `created_at` is
      // not unique — nothing stops two messages sharing an instant — so the id
      // tiebreak is what makes the cursor total rather than nearly total.
      const afterCursor =
        cursor === undefined
          ? undefined
          : or(
              gt(messages.createdAt, cursor.createdAt),
              and(eq(messages.createdAt, cursor.createdAt), gt(messages.id, cursor.id)),
            );

      // One row wider than the page, so the cursor reports what was seen rather
      // than what is guessed: `nextCursor` is present exactly when a further
      // readable message exists.
      const rows = await db
        .select(MESSAGE_COLUMNS)
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, request.conversationId),
            messageVisibleToCaller(request.userId),
            afterCursor,
          ),
        )
        .orderBy(asc(messages.createdAt), asc(messages.id))
        .limit(limit + 1);

      const page = rows.slice(0, limit).map(toMessage);
      const more = rows.length > limit;

      return {
        conversation,
        messages: page,
        nextCursor: more ? page.at(-1)?.id : undefined,
      };
    },
  };
}
