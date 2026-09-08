/**
 * Sending a message: the `POST /messages` contract (plan §3, §4.4).
 *
 * ## Why this module exists now
 *
 * `./index.ts` says messages are "deliberately missing", and it was right to
 * say so: T-201 shipped milestone 1 and writing these shapes then would have
 * been guessing at contracts six later tasks had to live with. They are no
 * longer a guess. `server/src/routes/messages.ts` declared them locally in
 * T-305 with an explicit note that they were "written to move verbatim into
 * `packages/protocol/src/schemas/messages.ts` when that package is opened",
 * and T-311 — the CLI's `send`, the first client of the endpoint — is what
 * opens it. Everything below is that move, field for field and comment for
 * comment; nothing here was invented at this end.
 *
 * The server's copies are still where they were. Deleting them means editing a
 * route module this task does not own, so it is left to T-038, which is filed
 * for exactly that. Until then the two are textually identical and this module
 * is the one a client compiles against.
 *
 * ## Only the send half moved
 *
 * The route module also declares the inbox listing and the acknowledgement.
 * They are not here, because moving a schema is a promise to keep it: the
 * listing's `status=all` and `since` are parsed and then *refused* by the
 * server, and publishing that shape from the package third parties embed would
 * advertise a listing this project does not answer. They move when the command
 * that reads them does (`agentchat listen`, T-312), which is the task that will
 * find out what they actually have to say.
 *
 * ## The one thing to know about `clientMessageId`
 *
 * It is the reason a send can be retried. The sender mints one per
 * `agentchat send` invocation and repeats it on every attempt; the server
 * answers a repeat with the *original* message rather than writing a second
 * one, and says which it did on the status line — 201 for a message this call
 * wrote, 200 for one it found. Not `CONFLICT`: a retry that failed would force
 * the caller to choose between reporting a failure that did not happen and
 * sending the message twice.
 *
 * That is why {@link SendMessageResponseSchema} is just the message, with no
 * `duplicate` flag beside it. One fact, one place; a body that also carried the
 * flag would invite a client to branch on the one that contradicts the other.
 * `packages/client`'s `messages.send` surfaces the status as a boolean, which
 * is the only place the two representations meet.
 *
 * @module
 */

import { z } from 'zod';

import { AgentId, ConversationId, MessageId, ProjectId } from '../ids.js';
import { TimestampSchema } from './primitives.js';

/**
 * The content ceiling in bytes of UTF-8 (D10).
 *
 * The same number as the database's `messages_content_within_limit` and as
 * `server/src/services/messages.ts`, deliberately restated rather than shared:
 * a `CHECK` is compiled into the database when its migration runs, so an
 * already-migrated database does not follow a constant this file changes, and
 * sharing one would only make it look as though it did. §12.3 governs changing
 * the limit, and it is a two-step change — migration first, then the code — not
 * an edit to a single literal.
 *
 * It is exported here because a client needs it *before* it sends: refusing a
 * two-megabyte body locally costs nothing, and pushing one through a connection
 * to be refused costs the whole body.
 */
export const MAX_MESSAGE_CONTENT_BYTES = 1_048_576;

/**
 * The longest `clientMessageId` the server accepts, in characters.
 *
 * Mirrors `messages_client_message_id_present` for the same reason as
 * {@link MAX_MESSAGE_CONTENT_BYTES}.
 */
export const MAX_CLIENT_MESSAGE_ID_LENGTH = 200;

/**
 * A message, as every endpoint that returns one renders it.
 *
 * One schema for a send, a replay and a history read, because they are one
 * thing: a client that can display a message it just sent can display one that
 * arrived an hour ago without a second code path. `clientMessageId` is not on
 * it — the only party who knows a message's idempotency key is the sender, who
 * chose it — and neither is anything about delivery, which is the inbox's
 * business and not a property of the message.
 */
export const MessageSchema = z.object({
  /** `msg_` identifier. Idempotency key for every listener (§4.4). */
  id: MessageId.schema,
  /** The project it was sent in — the security boundary (D15). */
  projectId: ProjectId.schema,
  /** The thread it belongs to. */
  conversationId: ConversationId.schema,
  /** The message it replies to, or null for a thread root. */
  parentMessageId: MessageId.schema.nullable(),
  /** The agent that sent it. */
  senderAgentId: AgentId.schema,
  /** The agent it was addressed to. */
  recipientAgentId: AgentId.schema,
  /** The content, uninterpreted (PRD §3.7). */
  content: z.string(),
  /** When the server accepted it. The authority for anything a human reads. */
  createdAt: TimestampSchema,
});

/** A message on the wire. */
export type Message = z.infer<typeof MessageSchema>;

/**
 * `POST /messages` request.
 *
 * `content` and `clientMessageId` are plain strings on purpose. Their limits —
 * {@link MAX_MESSAGE_CONTENT_BYTES} and
 * {@link MAX_CLIENT_MESSAGE_ID_LENGTH} — are enforced by the service, which
 * measures content in *bytes* of UTF-8 rather than in UTF-16 code units and
 * answers `PAYLOAD_TOO_LARGE` with the byte count that tells a caller how much
 * to cut. A `max()` here would answer `BAD_REQUEST` with a different number for
 * the same request, which is worse than not checking. A client that wants to
 * refuse early measures against the constants and says so in its own terms.
 */
export const SendMessageRequestSchema = z.object({
  /** The project to send in. The caller must be a member. */
  projectId: ProjectId.schema,
  /** The agent sending. Must be the caller's own, and in the project. */
  senderAgentId: AgentId.schema,
  /** The agent addressed. Must be in the same project. */
  recipientAgentId: AgentId.schema,
  /** The content. Uninterpreted, and capped by the service. */
  content: z.string(),
  /** One per `agentchat send` invocation. Repeating it returns the original. */
  clientMessageId: z.string(),
  /** An existing thread to send in. The caller must be party to it (D15). */
  conversationId: ConversationId.schema.optional(),
  /** The message being replied to. The reply inherits its conversation. */
  parentMessageId: MessageId.schema.optional(),
});

/** `POST /messages` request body. */
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

/**
 * `POST /messages` response: the committed message.
 *
 * Whether this call wrote it is on the status line — 201 or 200 — rather than
 * in a flag beside it. See the module note.
 */
export const SendMessageResponseSchema = MessageSchema;

/** `POST /messages` response body. */
export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>;
