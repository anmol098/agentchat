/**
 * Accepting a message (Plan §2, §4.3, §4.4).
 *
 * This is the write half of the product. Everything else — sessions, the
 * registry, `listen` — exists to carry what this module has already made
 * durable. It does four things, in this order, and the order is the design:
 *
 * 1. **Validate what the caller sent**, using nothing but the request. No round
 *    trip, so a 2 MiB body does not cost three queries before it is refused.
 * 2. **Ask the authorization service**, three times (see below).
 * 3. **Resolve the conversation** — inherited from a parent, named explicitly,
 *    or created.
 * 4. **Commit the message row and its inbox row together**, and return.
 *
 * ## Why the commit is the whole point
 *
 * Plan §4.4 opens with "a message row is committed before any delivery attempt",
 * and `message_inbox` is what makes that sentence mean something. A `messages`
 * row on its own records that a message *exists*; the inbox row records that it
 * is *owed to somebody*. Replay on `hello` (§4.3) reads the inbox, not
 * `messages`. So a message committed without its inbox row is a message that
 * exists and will never be delivered — silently, with no error anywhere, and no
 * way for the recipient to discover the loss.
 *
 * The two inserts are therefore in one transaction, and {@link MessageService.send}
 * returns only after it commits. Delivery is not attempted here and this module
 * takes no socket registry, no callback and no delivery dependency: T-308 fans
 * out to live listeners *after* this function has returned, and if it never runs
 * — process killed, every listener dead — the message is still pending in the
 * inbox and the next `hello` replays it. At-least-once is a property of this
 * transaction, not of the delivery code.
 *
 * ## Idempotency is not error handling
 *
 * A repeated `client_message_id` from the same sender returns the original
 * message. Not a `CONFLICT`, not a second row. The CLI generates one
 * `client_message_id` per `agentchat send` invocation (Plan §2) precisely so it
 * can retry a POST whose response it never saw, and a retry that fails is a
 * retry the CLI cannot make: it would have to choose between reporting a
 * failure that did not happen and sending a duplicate.
 *
 * Two paths reach the original, because two things can race:
 *
 * - The ordinary retry, seconds later: a `select` on
 *   `messages_sender_agent_id_client_message_id_key` finds it and nothing is
 *   written.
 * - Two sends in flight at once: both selects miss, both insert, and the unique
 *   index picks a winner. The loser's `insert` raises `23505` — which aborts its
 *   transaction, discarding any conversation it had just created — and it then
 *   reads the winner's row. A `23505` on that constraint is proof the winner
 *   committed, because an uncommitted duplicate would have blocked the insert
 *   rather than failed it, and a rolled-back one would have let it through.
 *
 * `onConflictDoNothing` would have avoided the exception but not the abort: a
 * conversation created moments earlier in the same transaction has to go, and
 * letting the constraint throw is how it goes without a second code path.
 *
 * ## Three authorization calls, not one
 *
 * `authorization.ts` spells the send composite out: the caller must be a member
 * of the project, the sender must pass `assertOwnAgentInProject`, and the
 * recipient must pass `assertAgentInProject`. Three rules with three different
 * remedies — join the project, `agentchat agent join`, ask the recipient's owner
 * to join theirs — and collapsing them into one call with a flag would collapse
 * the remedies too. Owning an agent and that agent being in a project are
 * separate facts; a route that proved one has not proved the other.
 *
 * They run *inside* the transaction, over a service built on the transaction
 * handle, which `authorization.ts` explicitly supports. That narrows the window
 * between deciding a send is allowed and writing it. It does not close it: under
 * `READ COMMITTED` a concurrent `DELETE FROM agent_projects` committing between
 * our select and our insert is invisible to us. Closing it would need
 * `REPEATABLE READ` and a retry loop around a race nobody has observed, for a
 * message that was authorized microseconds before it was written. The honest
 * description is *narrowed*, and it is written here rather than implied.
 *
 * ## Size is checked twice on purpose
 *
 * D10 caps content at 1 MiB of UTF-8. `messages_content_within_limit` enforces
 * it in the database, and this module enforces it before connecting. Neither is
 * redundant. The constraint is the one that cannot be bypassed — by a future
 * route, a repair script, or a `psql` session — and the local check is the one
 * that gives the caller {@link ErrorCode.PAYLOAD_TOO_LARGE} with a byte count
 * instead of a `23514` the error mapper can only render as `INTERNAL`, and that
 * refuses a megabyte before it is pushed through a connection.
 *
 * ## What this module does not decide
 *
 * It does not read messages back. D15 restricts reads to messages where one of
 * the caller's own agents is sender or recipient; the conversation read that
 * rule governs belongs to T-305, and T-301 has already noted it needs a limit
 * and a cursor. D15 does reach one thing here: resolving a parent or an existing
 * conversation *is* a read of somebody's message, so those two lookups apply it
 * rather than settling for "same project", which would let any project member
 * thread a reply into a conversation they are not party to.
 *
 * It does not interpret content (PRD §3.7). Content is bytes with a size limit
 * and no other opinion — not even that it is non-empty, which is why
 * `messages.content` carries a length ceiling and no floor while
 * `machines.name` carries both.
 *
 * @module
 */

import { Buffer } from 'node:buffer';
import {
  AgentId,
  ConversationId,
  ErrorCode,
  MessageId,
  ProjectId,
  ProtocolError,
  type UserId,
} from '@agentchat/protocol';
import { and, eq, or } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { agents } from '../db/schema/agents.js';
import { conversations, messageInbox, messages } from '../db/schema/messaging.js';
import { type AuthorizationService, createAuthorizationService } from './authorization.js';

// ---------------------------------------------------------------------------
// Limits, mirrored from the schema
// ---------------------------------------------------------------------------

/**
 * The content ceiling in bytes of UTF-8 (D10).
 *
 * The same number as `messages_content_within_limit`, deliberately restated
 * rather than imported. A `CHECK` is compiled into the database when its
 * migration runs, so an already-migrated database does not follow a constant
 * this file changes; sharing one would only make it look as though it did.
 * §12.3 governs changing the limit, and it is a two-step change — migration
 * first, then this — not an edit to a shared literal.
 */
export const MAX_CONTENT_BYTES = 1_048_576;

/**
 * The longest `client_message_id` the schema accepts.
 *
 * Mirrors `messages_client_message_id_present` for the same reason as
 * {@link MAX_CONTENT_BYTES}.
 */
export const MAX_CLIENT_MESSAGE_ID_LENGTH = 200;

/**
 * The unique index that makes a retried send safe.
 *
 * Named here because {@link isDuplicateSendViolation} distinguishes it from
 * every other unique violation the send path could raise. Catching `23505`
 * without checking which constraint raised it would turn an unrelated bug into
 * a silent "your message was already sent".
 */
const DUPLICATE_SEND_CONSTRAINT = 'messages_sender_agent_id_client_message_id_key';

/** PostgreSQL's `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

// ---------------------------------------------------------------------------
// Values a caller receives
// ---------------------------------------------------------------------------

/**
 * A committed message, exactly as the row holds it.
 *
 * Returned by {@link MessageService.send} whether the message was written now
 * or written by an earlier attempt, so a caller never has to ask which.
 */
export interface MessageRecord {
  /** The message's identifier (`msg_`). */
  readonly id: MessageId;
  /** The project it was sent in. */
  readonly projectId: ProjectId;
  /** The conversation it belongs to — inherited, named, or created. */
  readonly conversationId: ConversationId;
  /** The message replied to, or `undefined` for a thread root. */
  readonly parentMessageId: MessageId | undefined;
  /** The agent that sent it. Owned by the caller, by construction. */
  readonly senderAgentId: AgentId;
  /** The agent it is addressed to. */
  readonly recipientAgentId: AgentId;
  /** The content, uninterpreted. */
  readonly content: string;
  /** The sender's idempotency key for this send. */
  readonly clientMessageId: string;
  /** When the row was written. */
  readonly createdAt: Date;
}

/**
 * The outcome of a send.
 *
 * `message` is the same shape either way; the two flags describe what the call
 * *did*, which a route may want for a status code and a test always wants.
 */
export interface SendMessageResult {
  /** The committed message. */
  readonly message: MessageRecord;

  /**
   * `true` when this send matched an earlier one and wrote nothing.
   *
   * The message in that case is the original, with its original `id` and
   * `createdAt`. A route may map this to `200` rather than `201`; it must not
   * map it to an error.
   */
  readonly duplicate: boolean;

  /** `true` when this send opened a new conversation. */
  readonly conversationCreated: boolean;
}

// ---------------------------------------------------------------------------
// What a caller supplies
// ---------------------------------------------------------------------------

/**
 * A send, as `POST /messages` states it (Plan §3) plus the authenticated
 * caller.
 *
 * `userId` is not in the body: it comes from `request.requireUser()`. Taking it
 * as a parameter rather than reading it from somewhere is what lets the sender
 * ownership rule be asserted at all.
 */
export interface SendMessageRequest {
  /** The authenticated caller. */
  readonly userId: UserId;
  /** The project the message is sent in. */
  readonly projectId: ProjectId;
  /** The agent sending. Must be the caller's, and in the project. */
  readonly senderAgentId: AgentId;
  /** The agent addressed. Must be in the same project. */
  readonly recipientAgentId: AgentId;
  /** The content. At most {@link MAX_CONTENT_BYTES} bytes of UTF-8. */
  readonly content: string;

  /**
   * The sender's idempotency key, one per `agentchat send` invocation.
   *
   * Repeating it returns the original message. It is opaque to the server: any
   * non-empty string of at most {@link MAX_CLIENT_MESSAGE_ID_LENGTH}
   * characters, unique per sender.
   */
  readonly clientMessageId: string;

  /**
   * An existing conversation to send in.
   *
   * The caller must already be party to it — one of their own agents sent or
   * received a message in it (D15). Omit it to open a new conversation, or use
   * {@link parentMessageId}, which supplies it.
   */
  readonly conversationId?: ConversationId;

  /**
   * The message being replied to (`--reply-to`).
   *
   * The reply inherits its conversation. The parent must be visible to the
   * caller under D15.
   */
  readonly parentMessageId?: MessageId;
}

// ---------------------------------------------------------------------------
// Local validation
// ---------------------------------------------------------------------------

/**
 * Measures content the way `octet_length` does.
 *
 * `String.length` counts UTF-16 code units, so it under-counts every character
 * outside the BMP and over-counts nothing — it would let a 1 MiB limit pass
 * strings the database then rejects with a `23514`. Bytes are the unit D10 is
 * written in and the unit the constraint checks.
 *
 * @param content - The message content.
 * @returns Its length in bytes of UTF-8.
 */
export function contentByteLength(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}

/**
 * Checks what can be checked without a database.
 *
 * Runs before anything else in {@link MessageService.send}. Every rule here
 * depends only on values the caller already holds, so refusing on one of them
 * discloses nothing about the project, the agents, or whether any of them
 * exist — which is why running it before authorization is safe as well as
 * cheap.
 *
 * @param request - The send to validate.
 * @throws {ProtocolError} `PAYLOAD_TOO_LARGE` when content exceeds
 *   {@link MAX_CONTENT_BYTES}; `BAD_REQUEST` when `clientMessageId` is empty or
 *   longer than {@link MAX_CLIENT_MESSAGE_ID_LENGTH}, or when a reply names a
 *   conversation its parent is not in.
 */
export function assertSendable(request: SendMessageRequest): void {
  const bytes = contentByteLength(request.content);
  if (bytes > MAX_CONTENT_BYTES) {
    // The count is in the message because the remedy depends on it: a caller
    // 40 bytes over splits differently from one 40 times over.
    throw new ProtocolError(
      ErrorCode.PAYLOAD_TOO_LARGE,
      `Message content is ${bytes} bytes; the limit is ${MAX_CONTENT_BYTES} bytes of UTF-8.`,
    );
  }

  const key = request.clientMessageId;
  if (key.length === 0 || key.length > MAX_CLIENT_MESSAGE_ID_LENGTH) {
    throw new ProtocolError(
      ErrorCode.BAD_REQUEST,
      `clientMessageId must be 1 to ${MAX_CLIENT_MESSAGE_ID_LENGTH} characters.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Database handles
// ---------------------------------------------------------------------------

/**
 * The reads and writes a send performs.
 *
 * A `Pick` rather than the whole Drizzle handle, for the reason
 * `authorization.ts` gives: the service is handed the two verbs it uses, so a
 * test can wrap them and a reader can see the surface without reading the
 * driver's types.
 */
export type MessageQueryRunner = Pick<PgDatabase<PgQueryResultHKT>, 'select' | 'insert'>;

/**
 * A handle that can open a transaction.
 *
 * The one capability {@link createMessageService} needs beyond
 * {@link MessageQueryRunner}, and the reason the service takes a database
 * rather than any runner: the atomicity of the message and its inbox row is not
 * something a caller can be trusted to arrange.
 */
export interface MessageDatabase extends MessageQueryRunner {
  /**
   * Runs `callback` in a transaction, committing on return and rolling back on
   * throw.
   *
   * @typeParam T - What the callback produces.
   * @param callback - The work, over the transaction handle.
   * @returns Whatever the callback returned, once committed.
   */
  transaction<T>(callback: (tx: MessageQueryRunner) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/** Accepting messages. */
export interface MessageService {
  /**
   * Accepts a message: authorize, resolve a conversation, and commit the
   * message with its inbox row.
   *
   * Returns only after the transaction commits, so a caller that has a
   * {@link SendMessageResult} has a message that survives the process dying
   * before anything is delivered. Delivery is somebody else's call, made after
   * this one returns.
   *
   * Repeating a `clientMessageId` returns the original message with
   * `duplicate: true`. That is a success.
   *
   * @param request - Caller, addressing, content, idempotency key.
   * @returns The committed message and what this call did.
   * @throws {ProtocolError} `PAYLOAD_TOO_LARGE` when content exceeds 1 MiB;
   *   `BAD_REQUEST` for a malformed `clientMessageId` or a reply that
   *   contradicts the conversation it names; `NOT_FOUND` when the caller is not
   *   in the project, an agent is invisible to them, or a named conversation or
   *   parent is not one they are party to; `AGENT_DELETED` and
   *   `AGENT_NOT_IN_PROJECT` from the authorization rules.
   */
  send(request: SendMessageRequest): Promise<SendMessageResult>;
}

/** What {@link createMessageService} may be given besides a database. */
export interface MessageServiceOptions {
  /**
   * Builds the authorization service over a handle.
   *
   * Defaults to {@link createAuthorizationService}. It is a factory rather than
   * a service because the rules are asserted inside the send's transaction, so
   * the handle is not known until the transaction is open. Overriding it is for
   * tests that need to observe which assertions ran; it is not a way to supply
   * different rules.
   */
  readonly createAuthorization?: (runner: MessageQueryRunner) => AuthorizationService;
}

/** The columns a returned message is built from. */
const MESSAGE_COLUMNS = {
  id: messages.id,
  projectId: messages.projectId,
  conversationId: messages.conversationId,
  parentMessageId: messages.parentMessageId,
  senderAgentId: messages.senderAgentId,
  recipientAgentId: messages.recipientAgentId,
  content: messages.content,
  clientMessageId: messages.clientMessageId,
  createdAt: messages.createdAt,
};

/** A row shaped by {@link MESSAGE_COLUMNS}, before branding. */
interface MessageRow {
  readonly id: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly parentMessageId: string | null;
  readonly senderAgentId: string;
  readonly recipientAgentId: string;
  readonly content: string;
  readonly clientMessageId: string;
  readonly createdAt: Date;
}

/**
 * Brands a row's identifiers.
 *
 * `unsafeCast` rather than `parse`: every column here carries a format `CHECK`
 * in the schema, so the database has already validated what `parse` would
 * re-validate on a hot path.
 *
 * @param row - The row as the driver returned it.
 * @returns The same values, typed.
 */
function toRecord(row: MessageRow): MessageRecord {
  return {
    id: MessageId.unsafeCast(row.id),
    projectId: ProjectId.unsafeCast(row.projectId),
    conversationId: ConversationId.unsafeCast(row.conversationId),
    parentMessageId:
      row.parentMessageId === null ? undefined : MessageId.unsafeCast(row.parentMessageId),
    senderAgentId: AgentId.unsafeCast(row.senderAgentId),
    recipientAgentId: AgentId.unsafeCast(row.recipientAgentId),
    content: row.content,
    clientMessageId: row.clientMessageId,
    createdAt: row.createdAt,
  };
}

/**
 * Reports whether an error is the idempotency index refusing a second row.
 *
 * Drizzle wraps driver errors, and `pg` reports a constraint violation with
 * `code` and `constraint` on the error itself, so the chain is walked rather
 * than the top assumed. Matching the constraint name and not merely `23505`
 * keeps an unrelated unique violation — a bug — from being reported to the
 * caller as a successful duplicate send.
 *
 * @param error - Anything thrown by the send transaction.
 * @returns `true` if `messages_sender_agent_id_client_message_id_key` raised it.
 */
function isDuplicateSendViolation(error: unknown): boolean {
  let candidate: unknown = error;

  for (
    let depth = 0;
    depth < 8 && candidate !== null && typeof candidate === 'object';
    depth += 1
  ) {
    const record = candidate as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (record.code === UNIQUE_VIOLATION && record.constraint === DUPLICATE_SEND_CONSTRAINT) {
      return true;
    }
    candidate = record.cause;
  }

  return false;
}

/**
 * Finds an earlier send with this idempotency key.
 *
 * Keyed on `(sender_agent_id, client_message_id)`, which is the unique index,
 * so this is a single-row index lookup. The sender is scoped in because the key
 * is the *sender's*: two agents may pick the same string and neither is a
 * duplicate of the other.
 *
 * @param runner - Database or transaction handle.
 * @param senderAgentId - The sending agent.
 * @param clientMessageId - The idempotency key.
 * @returns The original message, or `undefined` if this send is new.
 */
async function selectByClientMessageId(
  runner: MessageQueryRunner,
  senderAgentId: AgentId,
  clientMessageId: string,
): Promise<MessageRecord | undefined> {
  const rows = await runner
    .select(MESSAGE_COLUMNS)
    .from(messages)
    .where(
      and(eq(messages.senderAgentId, senderAgentId), eq(messages.clientMessageId, clientMessageId)),
    )
    .limit(1);

  const row = rows[0];
  return row === undefined ? undefined : toRecord(row);
}

/**
 * Reads a message the caller is party to.
 *
 * D15 in one query: the message is in the project *and* one of the caller's own
 * agents is its sender or its recipient. The join is on `agents.user_id`, so the
 * rule is in the SQL and a row the caller may not see cannot come back to be
 * filtered afterwards.
 *
 * Liveness is not checked. D15 is about ownership, and an agent soft-deleted
 * yesterday does not retract the caller's standing in a thread it was part of.
 *
 * @param runner - Transaction handle.
 * @param request - The send being resolved, for caller, project and parent.
 * @param messageId - The message to read.
 * @returns The message, or `undefined` when it does not exist, is in another
 *   project, or is not the caller's to see. One answer, deliberately.
 */
async function selectVisibleMessage(
  runner: MessageQueryRunner,
  request: SendMessageRequest,
  messageId: MessageId,
): Promise<MessageRecord | undefined> {
  const rows = await runner
    .select(MESSAGE_COLUMNS)
    .from(messages)
    .innerJoin(
      agents,
      and(
        eq(agents.userId, request.userId),
        or(eq(agents.id, messages.senderAgentId), eq(agents.id, messages.recipientAgentId)),
      ),
    )
    .where(and(eq(messages.id, messageId), eq(messages.projectId, request.projectId)))
    .limit(1);

  const row = rows[0];
  return row === undefined ? undefined : toRecord(row);
}

/**
 * Reports whether the caller is party to a conversation.
 *
 * Asked of `messages` rather than `conversations` because it answers both
 * halves at once. A conversation exists only as the container of its first
 * message — this module is the only writer of `conversations`, and it never
 * commits one without a message in it — so "has a message in this project" *is*
 * "exists in this project", and adding the caller's own agent to the same
 * predicate makes it "and is theirs to join". It rides
 * `messages_conversation_id_created_at_idx`.
 *
 * @param runner - Transaction handle.
 * @param request - The send being resolved, for caller and project.
 * @param conversationId - The conversation named by the caller.
 * @returns `true` when the conversation is in the project and one of the
 *   caller's agents has sent or received in it.
 */
async function callerIsInConversation(
  runner: MessageQueryRunner,
  request: SendMessageRequest,
  conversationId: ConversationId,
): Promise<boolean> {
  const rows = await runner
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(
      agents,
      and(
        eq(agents.userId, request.userId),
        or(eq(agents.id, messages.senderAgentId), eq(agents.id, messages.recipientAgentId)),
      ),
    )
    .where(
      and(eq(messages.conversationId, conversationId), eq(messages.projectId, request.projectId)),
    )
    .limit(1);

  return rows.length > 0;
}

/** Where a message's conversation came from. */
interface ResolvedConversation {
  /** The conversation the message will be written into. */
  readonly id: ConversationId;
  /** `true` when this send opened it. */
  readonly created: boolean;
}

/**
 * Decides which conversation a send belongs to, creating one if it must.
 *
 * Three cases, in precedence order:
 *
 * - **A reply** inherits its parent's conversation. That is what threading *is*;
 *   letting the caller name a different one would produce a reply whose parent
 *   is in another thread, so a request that says both and disagrees is refused
 *   rather than silently resolved in someone's favour.
 * - **A named conversation** is joined, if the caller is party to it.
 * - **Neither** opens a new one.
 *
 * The insert is inside the caller's transaction, so a conversation opened by a
 * send that then fails — including one that loses the idempotency race — is
 * rolled back with it. There are no empty conversations, and
 * {@link callerIsInConversation} depends on that.
 *
 * @param runner - Transaction handle.
 * @param request - The send.
 * @returns The conversation, and whether this call created it.
 * @throws {ProtocolError} `BAD_REQUEST` when a reply names a conversation other
 *   than its parent's; `NOT_FOUND` when the parent or the named conversation is
 *   not the caller's to use.
 */
async function resolveConversation(
  runner: MessageQueryRunner,
  request: SendMessageRequest,
): Promise<ResolvedConversation> {
  const { parentMessageId, conversationId } = request;

  if (parentMessageId !== undefined) {
    const parent = await selectVisibleMessage(runner, request, parentMessageId);
    if (parent === undefined) {
      throw new ProtocolError(ErrorCode.NOT_FOUND, 'No such message.');
    }

    if (conversationId !== undefined && conversationId !== parent.conversationId) {
      throw new ProtocolError(
        ErrorCode.BAD_REQUEST,
        'parentMessageId and conversationId disagree; a reply belongs to its parent conversation.',
      );
    }

    return { id: parent.conversationId, created: false };
  }

  if (conversationId !== undefined) {
    if (!(await callerIsInConversation(runner, request, conversationId))) {
      throw new ProtocolError(ErrorCode.NOT_FOUND, 'No such conversation.');
    }

    return { id: conversationId, created: false };
  }

  const id = ConversationId.generate();
  await runner.insert(conversations).values({ id, projectId: request.projectId });
  return { id, created: true };
}

/**
 * Builds the message service over a database handle.
 *
 * Takes a database rather than a runner because {@link MessageService.send}
 * opens its own transaction: the atomicity of the message and its inbox row is
 * this module's guarantee to make, not the caller's to remember.
 *
 * @param db - A handle that can open transactions.
 * @param options - Overrides, for tests.
 * @returns The service.
 */
export function createMessageService(
  db: MessageDatabase,
  options: MessageServiceOptions = {},
): MessageService {
  const buildAuthorization = options.createAuthorization ?? createAuthorizationService;

  /**
   * The whole send, inside one transaction.
   *
   * @param request - The send.
   * @returns The committed message and what this call did.
   */
  function commitSend(request: SendMessageRequest): Promise<SendMessageResult> {
    return db.transaction(async (tx) => {
      // The composite from `authorization.ts`, over the transaction handle so
      // the rules are read in the same snapshot the writes are made in.
      const authorization = buildAuthorization(tx);

      await authorization.assertProjectMember({
        userId: request.userId,
        projectId: request.projectId,
      });
      await authorization.assertOwnAgentInProject({
        userId: request.userId,
        projectId: request.projectId,
        agentId: request.senderAgentId,
      });
      await authorization.assertAgentInProject({
        userId: request.userId,
        projectId: request.projectId,
        agentId: request.recipientAgentId,
      });

      // Only now. The key is scoped to the sender, so reading it before proving
      // the caller owns the sender would answer "what did agent X send under
      // key K" to anyone who can guess an agent id.
      const existing = await selectByClientMessageId(
        tx,
        request.senderAgentId,
        request.clientMessageId,
      );
      if (existing !== undefined) {
        return { message: existing, duplicate: true, conversationCreated: false };
      }

      const conversation = await resolveConversation(tx, request);

      const inserted = await tx
        .insert(messages)
        .values({
          id: MessageId.generate(),
          projectId: request.projectId,
          conversationId: conversation.id,
          parentMessageId: request.parentMessageId ?? null,
          senderAgentId: request.senderAgentId,
          recipientAgentId: request.recipientAgentId,
          content: request.content,
          clientMessageId: request.clientMessageId,
        })
        .returning(MESSAGE_COLUMNS);

      const row = inserted[0];
      if (row === undefined) {
        // Unreachable: an `insert … returning` that adds a row returns it, and
        // one that does not raises. Stated rather than asserted away, because
        // the alternative is a non-null assertion the linter forbids for
        // exactly this reason.
        throw new ProtocolError(ErrorCode.INTERNAL, 'The message insert returned no row.');
      }

      // The second half of the guarantee. Same transaction, before the return,
      // and before any delivery: a message the recipient is owed, recorded as
      // owed. `status` defaults to `pending`; it is spelled out because this is
      // the row replay reads and the default is not the point being made.
      await tx.insert(messageInbox).values({
        messageId: row.id,
        agentId: request.recipientAgentId,
        projectId: request.projectId,
        status: 'pending',
      });

      return {
        message: toRecord(row),
        duplicate: false,
        conversationCreated: conversation.created,
      };
    });
  }

  return {
    async send(request: SendMessageRequest): Promise<SendMessageResult> {
      assertSendable(request);

      try {
        return await commitSend(request);
      } catch (error: unknown) {
        if (!isDuplicateSendViolation(error)) {
          throw error;
        }

        // We lost the race. The violation is proof the winner committed, so
        // this read finds it; our own transaction — conversation included — is
        // already rolled back.
        const original = await selectByClientMessageId(
          db,
          request.senderAgentId,
          request.clientMessageId,
        );
        if (original === undefined) {
          // The constraint fired and the row it protects is not there. Nothing
          // about the send is knowable at this point, so the original error
          // travels on rather than being smoothed into a success.
          throw error;
        }

        return { message: original, duplicate: true, conversationCreated: false };
      }
    },
  };
}
