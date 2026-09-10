/**
 * The pending queue and the acknowledgement that clears it (Plan §4.3, D3).
 *
 * `./messages.ts` makes a message durable and owed. This module is the other
 * half of at-least-once: it answers "what is this agent still owed here?" on
 * every reconnect, and it records the answer "not that one any more".
 *
 * ## Keyed on the agent, never on the session
 *
 * D3 in one sentence: **a message is pending for an `(agent, project)` pair
 * until *any* session of that agent acknowledges it.** Every signature in this
 * file follows from that.
 *
 * The reason is not a preference. A session is one `agentchat listen`
 * invocation; the CLI mints a fresh one every time and never reuses one, so
 * session ids are effectively single-use. A session-scoped queue therefore has
 * no row to write against at the moment that matters most — the recipient is
 * offline, no session exists, and the message still has to be waiting when the
 * next `listen` opens a session that has never been heard of before. Worse, the
 * queue would grow a per-session copy on reconnect and the copies would have to
 * be reconciled by hand. Keying on the agent makes the offline case the *same*
 * case as every other one: the debt is recorded against the identity that
 * outlives the process, and whichever session turns up next inherits it.
 *
 * Two consequences that callers must not paper over:
 *
 * - An agent running two listeners has **one** queue, not two. Both replay the
 *   same backlog (that is D2's fan-out), and the first acknowledgement from
 *   either clears it for both. {@link InboxService.acknowledge} takes the
 *   session only to write it down.
 * - {@link deliveries} is diagnostic. Nothing here reads it to decide anything,
 *   and the schema deliberately withholds the indexes a session-scoped replay
 *   would need so that writing one is visibly the wrong turn.
 *
 * ## Acknowledgement is idempotent, and that is a contract
 *
 * A repeated acknowledgement is a success that wrote nothing, never a
 * `CONFLICT`. Clients retry — an acknowledgement travels over a socket that can
 * drop between the write and the frame that reports it — and, because delivery
 * is at-least-once, a replay of an already-acknowledged message can arrive
 * while the client is still acknowledging the first copy. Both orders have to
 * be safe, so both are:
 *
 * - **Acknowledge, then replay.** The replay was selected from a snapshot taken
 *   before the acknowledgement committed, so the message goes out again. That
 *   is a duplicate, which §4.4 permits and the listener drops by `messageId`.
 *   The second acknowledgement it may send is a no-op here.
 * - **Replay, then acknowledge.** The ordinary path.
 * - **Two acknowledgements at once**, from two sessions of the same agent. The
 *   `UPDATE` carries `status = 'pending'` in its `WHERE`, so under `READ
 *   COMMITTED` the loser blocks on the winner's row lock, re-evaluates against
 *   the *updated* row, matches nothing, and reports `alreadyAcknowledged`. No
 *   lost update, no error, and no explicit lock: this is the one place where
 *   `READ COMMITTED`'s re-check is exactly the semantics wanted.
 *
 * Refusal is reserved for the case that is a real mistake:
 * acknowledging a message that is not owed to this agent in this project. It is
 * answered {@link ErrorCode.NOT_FOUND} — the same answer as a message that does
 * not exist — because distinguishing them would confirm the existence of
 * somebody else's message to whoever guessed its id.
 *
 * ## Ordering: by `message_id`, and why that is not a shortcut
 *
 * Plan §4.3 writes the replay as `ORDER BY created_at`, and `created_at` is the
 * authority for anything a human reads. This module orders by
 * `message_inbox.message_id`, which returns the same rows in the same order for
 * every message this system can produce, and three things make it the better
 * key here:
 *
 * 1. **It is chronological.** A `msg_` id is a fixed-width prefix followed by a
 *    UUIDv7, so lexicographic order *is* creation order. Both the id and
 *    `created_at` are assigned by the server that accepts the send, inside the
 *    transaction that writes the row, so they cannot disagree about which of
 *    two messages that server took first. Where they could drift is between two
 *    server processes with skewed clocks (a v0.2 concern; v0.1 is one process,
 *    D6) — and two messages accepted concurrently by two machines have no true
 *    order for any key to recover. Replay needs a total order consistent with
 *    causality, not a reconstruction of absolute time.
 * 2. **It is free.** `message_inbox_pending_idx` is
 *    `(agent_id, project_id, message_id) WHERE status = 'pending'`, so the
 *    pending set comes out of the index already sorted: no sort node, and
 *    `messages` is touched only by primary key. Ordering by `created_at`
 *    returns the same rows and adds a sort — and, fatally for
 *    {@link ListPendingRequest.limit}, a sort must read the *whole* backlog
 *    before the limit can discard any of it. That is precisely the case the
 *    limit exists for.
 * 3. **It is a cursor.** `created_at` is not unique, so it cannot page without
 *    a tiebreak. `message_id` is the primary key's own half and the index's
 *    trailing column, so {@link ListPendingRequest.after} is a range scan on
 *    the same index that supplied the order.
 *
 * The claim in (1) is asserted rather than believed: the integration suite
 * compares both orderings over a pending set and checks the plan for the
 * absence of a sort.
 *
 * ## What this module does not do
 *
 * It does not deliver. It has no socket, no registry and no callback, for the
 * reason `./messages.ts` gives about its own missing dependencies: an ordering
 * that is structural cannot be forgotten. T-308 reads the pending set, writes
 * the frames, and calls back in with acknowledgements.
 *
 * It does not decide who may listen. The rules live in `./authorization.ts` and
 * are called, never restated.
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
  SessionId,
  type UserId,
} from '@stackgrid/protocol';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { deliveries, messageInbox, messages } from '../db/schema/messaging.js';
import { type AuthorizationService, createAuthorizationService } from './authorization.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * How many pending messages one {@link InboxService.listPending} call returns
 * when the caller does not choose.
 *
 * Chosen against the *size* of a page rather than the number of rows in it.
 * D10 caps content at 1 MiB, so a page is worth up to a hundred megabytes of
 * process memory in the worst case a hostile-but-legal sender could arrange,
 * and every larger default multiplies that. In the case this number is really
 * about — a listener that was offline over lunch — a hundred messages is more
 * than one page of backlog, and a caller that wants the rest asks for it with
 * {@link PendingPage.nextCursor} rather than being handed an unbounded read it
 * never asked for.
 */
export const DEFAULT_PENDING_LIMIT = 100;

/**
 * The largest page {@link InboxService.listPending} will return.
 *
 * A caller asking for more is given this rather than an error: the limit is a
 * property of the server's memory, not a rule about the request, and refusing
 * would make a client's own retry loop the thing that breaks.
 */
export const MAX_PENDING_LIMIT = 500;

/**
 * The pending half of `message_inbox`, spelled with a literal.
 *
 * `message_inbox_pending_idx` is partial on `status = 'pending'`, and Postgres
 * uses a partial index only when it can *prove* the query's `WHERE` implies the
 * index predicate. A bound parameter cannot be proven against a literal in a
 * generic plan, so the predicate is inlined here: the index match then does not
 * depend on whether the planner happened to choose a custom plan for this
 * execution. It is the only literal in the module for exactly that reason.
 */
const PENDING = sql`${messageInbox.status} = 'pending'`;

// ---------------------------------------------------------------------------
// Values a caller receives
// ---------------------------------------------------------------------------

/**
 * A message an agent still owes an acknowledgement for.
 *
 * The same fields `./messages.ts` returns from a send, deliberately: T-305 and
 * T-308 render a message the same way whether it was just accepted or replayed
 * an hour later, and two shapes for one thing would be two renderers. The
 * `@user/agent` handle is not here — it is a join against `users` that only the
 * frame builder needs, and putting it on the replay path would pay for it on
 * every reconnect.
 */
export interface PendingMessage {
  /** The message's identifier (`msg_`). Also the replay cursor. */
  readonly id: MessageId;
  /** The project it was sent in. */
  readonly projectId: ProjectId;
  /** The thread it belongs to. */
  readonly conversationId: ConversationId;
  /** The message it replies to, or `undefined` for a thread root. */
  readonly parentMessageId: MessageId | undefined;
  /** The agent that sent it. */
  readonly senderAgentId: AgentId;
  /** The agent that owes the acknowledgement — the caller's own. */
  readonly recipientAgentId: AgentId;
  /** The content, uninterpreted. */
  readonly content: string;
  /** When the server accepted it. The authority for anything a human reads. */
  readonly createdAt: Date;
}

/**
 * One page of the pending queue.
 *
 * A page rather than a list because the queue has no upper bound: it is however
 * far behind a listener has fallen, and a listener that has been off for a week
 * is exactly the one that must not be answered with an unbounded read.
 */
export interface PendingPage {
  /** The messages, oldest first. At most the effective limit. */
  readonly messages: readonly PendingMessage[];

  /**
   * Where to resume, or `undefined` when this page reached the end of the
   * queue.
   *
   * Exact, not a guess: the page is read one row wider than the limit, so a
   * cursor is present when and only when a further row was seen. A caller
   * draining a backlog passes it back as {@link ListPendingRequest.after} until
   * this is `undefined`.
   */
  readonly nextCursor: MessageId | undefined;
}

/**
 * What an acknowledgement did.
 *
 * Both outcomes are successes. `alreadyAcknowledged` exists so a caller can
 * *report* the difference — a log line, a metric, a test — never so it can
 * treat one of them as a failure.
 */
export interface AcknowledgementResult {
  /** The message that is no longer owed. */
  readonly messageId: MessageId;

  /**
   * `true` when the message was already acknowledged and this call wrote
   * nothing to the queue.
   *
   * A repeat is the expected shape of a retry and of an acknowledgement racing
   * a replay; it is not an error and must never be reported as one.
   */
  readonly alreadyAcknowledged: boolean;

  /**
   * When the acknowledgement that cleared it arrived.
   *
   * The *original* acknowledgement's timestamp on a repeat, not this call's:
   * the queue records when the debt was settled, and a retry does not settle it
   * again.
   */
  readonly acknowledgedAt: Date;

  /**
   * The session recorded as having cleared it, if one was named and is still
   * on record.
   *
   * Diagnostics. It is not what makes the acknowledgement valid — D3 says any
   * session of the agent may clear the queue — and the column is
   * `ON DELETE SET NULL` so that losing a session record can never un-acknowledge
   * a message.
   */
  readonly acknowledgedBySessionId: SessionId | undefined;
}

// ---------------------------------------------------------------------------
// What a caller supplies
// ---------------------------------------------------------------------------

/** Who is asking, for which agent, in which project. */
interface InboxRequest {
  /** The authenticated caller, from `request.requireUser()`. */
  readonly userId: UserId;
  /** The agent whose queue this is. Must be the caller's own, and in the project. */
  readonly agentId: AgentId;
  /** The project the queue is scoped to. Half of the routing key (§4.3). */
  readonly projectId: ProjectId;
}

/** Reading the pending queue: `hello` replay, and `GET /messages?status=pending`. */
export interface ListPendingRequest extends InboxRequest {
  /**
   * How many messages to return. Clamped to {@link MAX_PENDING_LIMIT}; omitted
   * means {@link DEFAULT_PENDING_LIMIT}.
   *
   * A non-integer or a value below one is a caller bug rather than a
   * negotiation, and is refused with {@link ErrorCode.BAD_REQUEST}.
   */
  readonly limit?: number | undefined;

  /**
   * Resume after this message, exclusive.
   *
   * The {@link PendingPage.nextCursor} of the previous page. Ordering is by
   * `message_id`, so this is a range on the same index that supplies the order
   * — see the module note on ordering.
   */
  readonly after?: MessageId | undefined;
}

/** Clearing one message from the queue. */
export interface AcknowledgeRequest extends InboxRequest {
  /** The message being acknowledged. */
  readonly messageId: MessageId;

  /**
   * The session the acknowledgement arrived on, when it arrived on one.
   *
   * Recorded, never consulted. D3 makes the acknowledgement the *agent's*, so
   * this changes nothing about whether it is accepted or what it clears; it is
   * optional because Plan §3 makes it optional on `POST /messages/:id/ack`,
   * where an acknowledgement may come from a plain HTTP client that holds no
   * session at all.
   */
  readonly sessionId?: SessionId | undefined;
}

/** Recording one delivery attempt. Diagnostics; see {@link InboxService.recordDelivery}. */
export interface RecordDeliveryRequest {
  /** The message written to the socket. */
  readonly messageId: MessageId;
  /** The session whose socket it was written to. */
  readonly sessionId: SessionId;
}

// ---------------------------------------------------------------------------
// Database handles
// ---------------------------------------------------------------------------

/**
 * The verbs this module issues.
 *
 * A `Pick` rather than the whole Drizzle handle, following `./authorization.ts`
 * and `./messages.ts`: a pool handle and a transaction handle both satisfy it,
 * a test can wrap it, and the surface is readable without the driver's types.
 */
export type InboxQueryRunner = Pick<PgDatabase<PgQueryResultHKT>, 'select' | 'insert' | 'update'>;

/**
 * A handle that can open a transaction.
 *
 * Needed because an acknowledgement writes to two tables and the caller must
 * not be the one who remembers to group them.
 */
export interface InboxDatabase extends InboxQueryRunner {
  /**
   * Runs `callback` in a transaction, committing on return and rolling back on
   * throw.
   *
   * @typeParam T - What the callback produces.
   * @param callback - The work, over the transaction handle.
   * @returns Whatever the callback returned, once committed.
   */
  transaction<T>(callback: (tx: InboxQueryRunner) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/** The pending queue, and the acknowledgement that clears it. */
export interface InboxService {
  /**
   * Reads what this agent is still owed in this project, oldest first.
   *
   * Run on every `hello`, so it is the hottest read in the system. It is
   * answered from `message_inbox_pending_idx` with no sort — see the module
   * note — and touches `messages` only by primary key.
   *
   * Reading changes nothing: a message stays pending until it is acknowledged,
   * which is what makes a listener that dies mid-replay harmless.
   *
   * @param request - Caller, agent, project, and optional paging.
   * @returns One page of pending messages and a cursor when more remain.
   * @throws {ProtocolError} `BAD_REQUEST` for a malformed `limit`; `NOT_FOUND`
   *   when the caller is not in the project or the agent is not theirs;
   *   `AGENT_DELETED` for their own soft-deleted agent; `AGENT_NOT_IN_PROJECT`
   *   when it is live but not in the project.
   */
  listPending(request: ListPendingRequest): Promise<PendingPage>;

  /**
   * Clears one message from this agent's queue (D3).
   *
   * Idempotent: a message already acknowledged — by this session, by another
   * session of the same agent, or by an earlier attempt of this same call — is
   * reported with `alreadyAcknowledged: true` and nothing is rewritten. That is
   * a success.
   *
   * When a session is named, its `deliveries` row is stamped too. That write is
   * diagnostic and happens on the repeat path as well, because "did *this*
   * socket confirm?" is a different question from "does this agent still owe an
   * acknowledgement?" and only the second one is settled by somebody else.
   *
   * @param request - Caller, agent, project, message, and optionally the
   *   session it arrived on.
   * @returns What the acknowledgement did and when the debt was settled.
   * @throws {ProtocolError} `NOT_FOUND` when the message is not owed to this
   *   agent in this project — including when it does not exist, which is
   *   deliberately the same answer; the authorization codes as for
   *   {@link listPending}.
   */
  acknowledge(request: AcknowledgeRequest): Promise<AcknowledgementResult>;

  /**
   * Records that a message was written to one session's socket.
   *
   * **Diagnostics only.** It answers "the message says delivered, so why did
   * the harness never see it?" with a session, a machine and a timestamp. It
   * does not make a message delivered, it does not make one pending, and
   * nothing in replay or acknowledgement reads what it writes — a call that is
   * lost costs an audit trail and no correctness.
   *
   * Re-delivering to the same socket updates the attempt's timestamp rather
   * than adding a row, per the table's `PK(message_id, session_id)`. Any
   * acknowledgement already stamped on that row is left alone: it happened.
   *
   * There is no authorization argument because there is no caller — the socket
   * was authorized when it bound, and this records what the server itself did.
   *
   * @param request - The message and the session it was written to.
   */
  recordDelivery(request: RecordDeliveryRequest): Promise<void>;
}

/** What {@link createInboxService} may be given besides a database. */
export interface InboxServiceOptions {
  /**
   * Builds the authorization service over a handle.
   *
   * Defaults to {@link createAuthorizationService}. A factory rather than a
   * service because an acknowledgement asserts its rules inside its own
   * transaction, so the handle is not known until that transaction is open.
   * Overriding it is for tests that observe which assertions ran; it is not a
   * way to supply different rules.
   */
  readonly createAuthorization?: (runner: InboxQueryRunner) => AuthorizationService;
}

/** The columns a {@link PendingMessage} is built from. */
const PENDING_COLUMNS = {
  id: messages.id,
  projectId: messages.projectId,
  conversationId: messages.conversationId,
  parentMessageId: messages.parentMessageId,
  senderAgentId: messages.senderAgentId,
  recipientAgentId: messages.recipientAgentId,
  content: messages.content,
  createdAt: messages.createdAt,
};

/** A row shaped by {@link PENDING_COLUMNS}, before branding. */
interface PendingRow {
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
 * Brands a row's identifiers.
 *
 * `unsafeCast` rather than `parse`, as in `./messages.ts`: every column here
 * carries a format `CHECK` in the schema, so the database has already validated
 * what `parse` would re-validate once per replayed message.
 *
 * @param row - The row as the driver returned it.
 * @returns The same values, typed.
 */
function toPendingMessage(row: PendingRow): PendingMessage {
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
 * Resolves the page size for one read.
 *
 * Clamps rather than refuses at the top, because {@link MAX_PENDING_LIMIT} is a
 * fact about this server's memory and not a rule the caller broke. Refuses at
 * the bottom, because a zero, a negative or a fraction is a bug in whatever
 * built the request and quietly turning it into a hundred would hide it.
 *
 * Exported so the clamp can be tested without a database, as `./messages.ts`
 * exports `assertSendable` for the same reason.
 *
 * @param limit - What the caller asked for, if anything.
 * @returns The number of rows to return.
 * @throws {ProtocolError} `BAD_REQUEST` when `limit` is not a positive integer.
 */
export function resolvePendingLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_PENDING_LIMIT;
  }

  if (!Number.isInteger(limit) || limit < 1) {
    throw new ProtocolError(ErrorCode.BAD_REQUEST, 'limit must be a positive integer.');
  }

  return Math.min(limit, MAX_PENDING_LIMIT);
}

/**
 * The queue row for one message, whatever state it is in.
 *
 * Read only after the conditional `UPDATE` matched nothing, to tell the two
 * reasons for that apart: already acknowledged, or never owed to this agent
 * here.
 *
 * @param runner - Transaction handle.
 * @param request - The acknowledgement being resolved.
 * @returns The row, or `undefined` when this agent owes nothing for this
 *   message in this project.
 */
async function selectQueueRow(
  runner: InboxQueryRunner,
  request: AcknowledgeRequest,
): Promise<{ ackedAt: Date | null; ackedBySessionId: string | null } | undefined> {
  const rows = await runner
    .select({
      ackedAt: messageInbox.ackedAt,
      ackedBySessionId: messageInbox.ackedBySessionId,
    })
    .from(messageInbox)
    .where(
      and(
        eq(messageInbox.messageId, request.messageId),
        eq(messageInbox.agentId, request.agentId),
        eq(messageInbox.projectId, request.projectId),
      ),
    )
    .limit(1);

  return rows[0];
}

/**
 * Stamps this session's delivery row as acknowledged.
 *
 * Diagnostics, and written to be incapable of mattering: an `UPDATE` with a
 * primary-key `WHERE` that violates no constraint and matches nothing when the
 * message reached this agent through some other socket — which is the normal
 * case for an acknowledgement over HTTP, and correct rather than a defect (see
 * `deliveries.acked_at` in the schema).
 *
 * It shares the acknowledgement's transaction because the only ways it can fail
 * are the ways the authoritative write fails too, so grouping them buys
 * atomicity for nothing. What must never happen is the reverse — the queue
 * depending on this table — and no read here does.
 *
 * @param runner - Transaction handle.
 * @param messageId - The message acknowledged.
 * @param sessionId - The session that acknowledged it.
 */
async function stampDelivery(
  runner: InboxQueryRunner,
  messageId: MessageId,
  sessionId: SessionId,
): Promise<void> {
  await runner
    .update(deliveries)
    .set({ ackedAt: sql`now()` })
    .where(and(eq(deliveries.messageId, messageId), eq(deliveries.sessionId, sessionId)));
}

/**
 * Builds the inbox service over a database handle.
 *
 * Takes a database rather than a runner because an acknowledgement opens its
 * own transaction; see {@link InboxDatabase}.
 *
 * @param db - A handle that can open transactions.
 * @param options - Overrides, for tests.
 * @returns The service.
 */
export function createInboxService(
  db: InboxDatabase,
  options: InboxServiceOptions = {},
): InboxService {
  const buildAuthorization = options.createAuthorization ?? createAuthorizationService;

  /**
   * The one rule both operations need.
   *
   * `assertOwnAgentInProject` and nothing else — one query, not the send's
   * three. A send names two agents and has to say which of them the caller
   * failed on; the inbox names one, the caller's own, and the same statement
   * that reads it also reads their membership of the project. Splitting it
   * would be a second round trip on the reconnect path buying a distinction
   * nobody can act on differently.
   *
   * @param runner - The handle to read the rules on.
   * @param request - Caller, agent, project.
   */
  async function assertCallerOwnsQueue(
    runner: InboxQueryRunner,
    request: InboxRequest,
  ): Promise<void> {
    await buildAuthorization(runner).assertOwnAgentInProject({
      userId: request.userId,
      projectId: request.projectId,
      agentId: request.agentId,
    });
  }

  return {
    async listPending(request: ListPendingRequest): Promise<PendingPage> {
      // Before the rules, because it costs no round trip and a malformed limit
      // is the caller's own mistake either way.
      const limit = resolvePendingLimit(request.limit);

      // Read on the pool rather than in a transaction: this is a single
      // statement, so a transaction would add a round trip to wrap a snapshot
      // that already exists. The rules are asserted first and separately, which
      // leaves a window in which membership could be revoked between the two —
      // narrower than it looks, since the message it would let through was
      // already committed and owed, and closing it would mean a serialisable
      // transaction on the hottest read in the system.
      await assertCallerOwnsQueue(db, request);

      const conditions = [
        eq(messageInbox.agentId, request.agentId),
        eq(messageInbox.projectId, request.projectId),
        PENDING,
      ];
      if (request.after !== undefined) {
        conditions.push(gt(messageInbox.messageId, request.after));
      }

      // One row wider than the page, so "is there more?" is answered by having
      // seen more rather than by guessing from a full page.
      const rows = await db
        .select(PENDING_COLUMNS)
        .from(messageInbox)
        .innerJoin(messages, eq(messages.id, messageInbox.messageId))
        .where(and(...conditions))
        .orderBy(asc(messageInbox.messageId))
        .limit(limit + 1);

      const page = rows.slice(0, limit).map(toPendingMessage);
      const last = page.at(-1);

      return {
        messages: page,
        nextCursor: rows.length > limit && last !== undefined ? last.id : undefined,
      };
    },

    acknowledge(request: AcknowledgeRequest): Promise<AcknowledgementResult> {
      return db.transaction(async (tx) => {
        await assertCallerOwnsQueue(tx, request);

        // The whole of D3, in one statement. Scoped by `(message, agent,
        // project)` and *not* by session: an acknowledgement from any session of
        // this agent matches this row, which is what makes a second listener
        // able to settle what the first one was sent. `status = 'pending'` in
        // the `WHERE` is what makes a repeat write nothing and what makes two
        // concurrent acknowledgements safe — see the module note.
        const cleared = await tx
          .update(messageInbox)
          .set({
            status: 'acked',
            // The database clock, like `messages.created_at`, so two rows
            // written by two processes are comparable.
            ackedAt: sql`now()`,
            ackedBySessionId: request.sessionId ?? null,
          })
          .where(
            and(
              eq(messageInbox.messageId, request.messageId),
              eq(messageInbox.agentId, request.agentId),
              eq(messageInbox.projectId, request.projectId),
              PENDING,
            ),
          )
          .returning({
            ackedAt: messageInbox.ackedAt,
            ackedBySessionId: messageInbox.ackedBySessionId,
          });

        const row = cleared[0] ?? (await selectQueueRow(tx, request));
        if (row === undefined) {
          // Either no such message, or one addressed to another agent, or one
          // in another project. One answer for all three: a caller who may not
          // acknowledge it may not learn it exists.
          throw new ProtocolError(ErrorCode.NOT_FOUND, 'No such message.');
        }

        if (row.ackedAt === null) {
          // Unreachable: `message_inbox_acked_at_matches_status` makes an
          // `'acked'` row without a timestamp unrepresentable, and the row was
          // read only after an update conditional on `'pending'` matched
          // nothing. Stated rather than asserted away.
          throw new ProtocolError(
            ErrorCode.INTERNAL,
            'An acknowledged inbox row carries no timestamp.',
          );
        }

        // Diagnostics, and last: nothing is written on the refusal path, and
        // the authoritative row is settled before the audit trail describes it.
        // Written on the repeat path too, because a message cleared by another
        // session says nothing about whether *this* socket confirmed.
        if (request.sessionId !== undefined) {
          await stampDelivery(tx, request.messageId, request.sessionId);
        }

        return {
          messageId: request.messageId,
          alreadyAcknowledged: cleared.length === 0,
          acknowledgedAt: row.ackedAt,
          acknowledgedBySessionId:
            row.ackedBySessionId === null ? undefined : SessionId.unsafeCast(row.ackedBySessionId),
        };
      });
    },

    async recordDelivery(request: RecordDeliveryRequest): Promise<void> {
      await db
        .insert(deliveries)
        .values({ messageId: request.messageId, sessionId: request.sessionId })
        .onConflictDoUpdate({
          target: [deliveries.messageId, deliveries.sessionId],
          // `delivered_at` only. A re-delivery is a new attempt, but an
          // acknowledgement already recorded on this row is a fact about the
          // past and is not undone by writing to the socket again.
          set: { deliveredAt: sql`now()` },
        });
    },
  };
}
