/**
 * The message endpoints from Plan §3: send, read the inbox, acknowledge.
 *
 * ```text
 * POST /messages          { projectId, senderAgentId, recipientAgentId, content,
 *                           conversationId?, parentMessageId?, clientMessageId }
 * GET  /messages          ?projectId=&agentId=&status=pending&limit=&after=
 * POST /messages/:id/ack  { agentId, projectId, sessionId? }
 * ```
 *
 * ## A handler parses, calls, and formats
 *
 * Nothing here decides anything. Authorization is three assertions inside
 * `services/messages.ts`, the 1 MiB content cap is checked there and again by
 * `messages_content_within_limit`, idempotency is a unique index, and the
 * acknowledgement rule is D3 inside `services/inbox.ts`. Re-checking any of
 * them here would be a second copy that a WebSocket frame or an admin command
 * would not go through. Protocol §7.3 requires the split; `routes/projects.ts`
 * gives the reason at length.
 *
 * ## A duplicate send is a success
 *
 * `POST /messages` answers **201** when it wrote a message and **200** when the
 * `clientMessageId` matched one the sender had already sent — the same body
 * either way, the original message. Not a `CONFLICT`: the CLI mints one
 * `clientMessageId` per `agentchat send` and retries the POST whose response it
 * never saw, so a retry that failed would force it to choose between reporting
 * a failure that did not happen and sending the message twice. The status line
 * is where the difference is reported, because it is the one place a client
 * cannot mistake for content. `services/messages.ts` states the same rule from
 * the other side.
 *
 * ## Protected by omission (T-019)
 *
 * None of these routes declares `config.auth` and none is named in
 * `PUBLIC_ROUTES`, which is the whole mechanism: `plugins/auth.ts` treats a
 * route that said nothing as `required`. The failure mode of forgetting to
 * think about authentication here is a 401 on a route that should have been
 * public — a bug report — rather than an unauthenticated read of somebody's
 * messages. Nothing in this module may be added to that set.
 *
 * ## Schemas that `packages/protocol` does not own yet
 *
 * T-201 shipped milestone 1 and deliberately left messages out, so the shapes
 * below are declared here in zod over the protocol's branded id schemas and
 * `TimestampSchema`, exactly as `./sessions.ts` did for its own. They are
 * written to move verbatim into `packages/protocol/src/schemas/messages.ts`
 * when that package is opened. Nothing under `packages/` was edited to get this
 * working.
 *
 * ## Two places where this file disagrees with Plan §3, out loud
 *
 * - **`POST /messages/:id/ack` takes a `projectId`.** §3 writes the body as
 *   `{ agentId, sessionId? }`, but the inbox is keyed on `(agent, project)`
 *   (D3, `message_inbox_pending_idx`), so an acknowledgement without a project
 *   is not answerable — and deriving one by reading the message first would
 *   mean a read that happens before the rule that decides whether the caller
 *   may read it. The plan wants amending.
 * - **`status=all` and `since=` are refused.** §3 offers them; no service
 *   answers them. `services/inbox.ts` implements the pending queue only, and
 *   the historical listing has its own index waiting for it
 *   (`messages_recipient_agent_id_project_id_created_at_idx`) and no owner. A
 *   route cannot invent it without putting a `select` here, so the request is
 *   refused with a message that says which half is missing rather than being
 *   quietly served as `pending`.
 *
 * ## Wiring
 *
 * {@link registerMessageRoutes} takes its collaborators as arguments and is not
 * called from `app.ts`, which this task does not own — the arrangement every
 * route module before it used. The pull request lists the lines that connect
 * it.
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
  TimestampSchema,
} from '@agentchat/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { InboxService, PendingMessage } from '../services/inbox.js';
import type { MessageRecord, MessageService } from '../services/messages.js';

/** A message was written by this request. */
const CREATED = 201;

// ---------------------------------------------------------------------------
// Schemas — see the module note on where these belong
// ---------------------------------------------------------------------------

/**
 * A message, as every endpoint that returns one renders it.
 *
 * One schema for a send, a replay and a history read, because they are one
 * thing: a client that can display a message it just sent can display one that
 * arrived an hour ago without a second code path. `clientMessageId` is not on
 * it — the only party who knows a message's idempotency key is the sender, who
 * chose it — and neither is anything about delivery, which is
 * `message_inbox`'s business and not a property of the message.
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
 * `content` and `clientMessageId` are plain strings here on purpose. Their
 * limits — 1 MiB of UTF-8 (D10) and 200 characters — belong to
 * `services/messages.ts`, which measures content in *bytes* rather than in
 * UTF-16 code units and answers `PAYLOAD_TOO_LARGE` with the byte count that
 * tells a caller how much to cut. A `max()` here would answer `BAD_REQUEST`
 * with a different number for the same request, which is worse than not
 * checking.
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
export type SendMessageRequestBody = z.infer<typeof SendMessageRequestSchema>;

/**
 * `POST /messages` response: the committed message.
 *
 * Whether this call wrote it is on the status line — 201 or 200 — rather than
 * in a flag beside it. One fact, one place; a body that also carried
 * `duplicate` would invite a client to branch on the one the other contradicts.
 */
export const SendMessageResponseSchema = MessageSchema;

/** `POST /messages` response body. */
export type SendMessageResponseBody = z.infer<typeof SendMessageResponseSchema>;

/**
 * The two listings Plan §3 offers.
 *
 * `all` is parsed and then refused; see the module note. It is in the enum
 * rather than out of it so that asking for it is answered with what is missing,
 * not with "expected 'pending'".
 */
export const MessageListStatusSchema = z.enum(['pending', 'all']);

/** `GET /messages` query string. */
export const ListMessagesQuerySchema = z.object({
  /** Which project's queue. Half of the routing key (§4.3). */
  projectId: ProjectId.schema,
  /** Whose queue. Must be the caller's own agent, in that project. */
  agentId: AgentId.schema,
  /** `pending` — the default and, today, the only listing that is answered. */
  status: MessageListStatusSchema.default('pending'),
  /** Page size. Clamped by the service; omitted means its default. */
  limit: z.coerce.number().int().min(1).optional(),
  /** Resume after this message, exclusive. A previous page's `nextCursor`. */
  after: MessageId.schema.optional(),
  /** Plan §3's history filter. Parsed so it can be refused explicitly. */
  since: TimestampSchema.optional(),
});

/** `GET /messages` query parameters. */
export type ListMessagesQuery = z.infer<typeof ListMessagesQuerySchema>;

/**
 * `GET /messages` response.
 *
 * Enveloped, like every list on this server (D17): a bare array cannot grow a
 * cursor without a major version, and this one needed the cursor immediately.
 * `nextCursor` is explicitly null at the end of the queue rather than absent,
 * so "there is no more" and "this server does not page" are different answers
 * on the wire.
 */
export const ListMessagesResponseSchema = z.object({
  /** The pending messages, oldest first. At most the effective limit. */
  items: z.array(MessageSchema),
  /** Where to resume, or null when the queue was drained. */
  nextCursor: MessageId.schema.nullable(),
});

/** `GET /messages` response body. */
export type ListMessagesResponseBody = z.infer<typeof ListMessagesResponseSchema>;

/** Path parameters for `POST /messages/:id/ack`. */
export const MessageIdParamsSchema = z.object({
  /** The message's identifier, from the URL path. */
  id: MessageId.schema,
});

/**
 * `POST /messages/:id/ack` request.
 *
 * `projectId` is not in Plan §3 and is required here; see the module note.
 * `sessionId` is optional because an acknowledgement may come from a plain HTTP
 * client that holds no session at all — D3 makes the acknowledgement the
 * *agent's*, and the session is recorded for diagnostics and never consulted.
 */
export const AcknowledgeMessageRequestSchema = z.object({
  /** The agent whose queue this clears. Must be the caller's own. */
  agentId: AgentId.schema,
  /** The project the queue is scoped to. */
  projectId: ProjectId.schema,
  /** The session it arrived on, when it arrived on one. Diagnostics only. */
  sessionId: SessionId.schema.optional(),
});

/** `POST /messages/:id/ack` request body. */
export type AcknowledgeMessageRequestBody = z.infer<typeof AcknowledgeMessageRequestSchema>;

/**
 * `POST /messages/:id/ack` response.
 *
 * `alreadyAcknowledged` is reported, not raised. A repeat is the expected shape
 * of a retry and of an acknowledgement racing a replay; a client may log the
 * difference and must never treat it as a failure. `acknowledgedAt` is when the
 * debt was *first* settled, so a retry does not appear to settle it again.
 */
export const AcknowledgeMessageResponseSchema = z.object({
  /** The message that is no longer owed. */
  messageId: MessageId.schema,
  /** True when this call wrote nothing because the debt was already settled. */
  alreadyAcknowledged: z.boolean(),
  /** When the acknowledgement that cleared it arrived. */
  acknowledgedAt: TimestampSchema,
  /** The session recorded as having cleared it, if one was named and survives. */
  acknowledgedBySessionId: SessionId.schema.nullable(),
});

/** `POST /messages/:id/ack` response body. */
export type AcknowledgeMessageResponseBody = z.infer<typeof AcknowledgeMessageResponseSchema>;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parses one part of a request against a schema.
 *
 * Shared by body, path and query because they fail the same way: a malformed
 * id in a URL is a `BAD_REQUEST`, not a lookup that happens to miss, and
 * answering it `NOT_FOUND` would tell a caller their well-formed id was wrong
 * when the truth is that it was not well-formed. Values are never echoed; a
 * caller who sent a field knows what they sent, and a message that quotes input
 * is a message that can be made to quote anything.
 *
 * @param schema - The schema for this endpoint.
 * @param value - Whatever Fastify parsed, which may be `undefined`.
 * @param part - Named in the failure so a caller knows where to look.
 * @returns The validated value.
 * @throws {ProtocolError} `BAD_REQUEST` naming the offending fields.
 */
function parse<T>(schema: z.ZodType<T>, value: unknown, part: string): T {
  const result = schema.safeParse(value ?? {});
  if (result.success) {
    return result.data;
  }

  const problems = result.error.issues.map((issue) => {
    const field = issue.path.join('.');
    return field === '' ? issue.message : `${field}: ${issue.message}`;
  });

  throw new ProtocolError(ErrorCode.BAD_REQUEST, `Invalid request ${part}. ${problems.join('; ')}`);
}

/**
 * Puts a message on the wire.
 *
 * Parsed on the way out, like every other value this server sends: a column
 * that has drifted from the contract is a server bug, and this is where it is
 * caught rather than at a client. Takes the two record shapes the services
 * produce — a send's and a replay's — because they agree on every field this
 * schema names.
 *
 * @param message - The record a service returned.
 * @returns The wire representation, validated.
 */
function toWire(message: MessageRecord | PendingMessage): Message {
  return MessageSchema.parse({
    id: message.id,
    projectId: message.projectId,
    conversationId: message.conversationId,
    parentMessageId: message.parentMessageId ?? null,
    senderAgentId: message.senderAgentId,
    recipientAgentId: message.recipientAgentId,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Options for {@link registerMessageRoutes}. */
export interface MessageRouteOptions {
  /** Accepting messages. Every rule a send applies lives in it. */
  readonly messages: MessageService;

  /** The pending queue and the acknowledgement that clears it. */
  readonly inbox: InboxService;
}

/**
 * Registers the message routes.
 *
 * All three are authenticated; see the module note on protection by omission.
 *
 * @param app - Fastify instance to add the routes to.
 * @param options - Collaborators; see {@link MessageRouteOptions}.
 */
export function registerMessageRoutes(app: FastifyInstance, options: MessageRouteOptions): void {
  const { messages, inbox } = options;

  app.post(
    '/messages',
    async (request: FastifyRequest, reply: FastifyReply): Promise<SendMessageResponseBody> => {
      const caller = request.requireUser();
      const body = parse(SendMessageRequestSchema, request.body, 'body');

      const result = await messages.send({
        userId: caller.id,
        projectId: body.projectId,
        senderAgentId: body.senderAgentId,
        recipientAgentId: body.recipientAgentId,
        content: body.content,
        clientMessageId: body.clientMessageId,
        ...(body.conversationId === undefined ? {} : { conversationId: body.conversationId }),
        ...(body.parentMessageId === undefined ? {} : { parentMessageId: body.parentMessageId }),
      });

      // The only branch in this file, and it chooses a status code rather than
      // a body: 201 for a message this call wrote, 200 for the original of a
      // send that had already been accepted.
      if (!result.duplicate) {
        reply.code(CREATED);
      }

      return SendMessageResponseSchema.parse(toWire(result.message));
    },
  );

  app.get('/messages', async (request: FastifyRequest): Promise<ListMessagesResponseBody> => {
    const caller = request.requireUser();
    const query = parse(ListMessagesQuerySchema, request.query, 'query');

    // Refused rather than approximated; see the module note. Saying which half
    // is missing is the difference between a client author waiting for the
    // endpoint and one debugging why `--all` shows only unread messages.
    if (query.status === 'all' || query.since !== undefined) {
      throw new ProtocolError(
        ErrorCode.BAD_REQUEST,
        'This server answers status=pending only; the historical listing (status=all, since) is not implemented yet.',
      );
    }

    const page = await inbox.listPending({
      userId: caller.id,
      agentId: query.agentId,
      projectId: query.projectId,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.after === undefined ? {} : { after: query.after }),
    });

    return ListMessagesResponseSchema.parse({
      items: page.messages.map(toWire),
      nextCursor: page.nextCursor ?? null,
    });
  });

  app.post(
    '/messages/:id/ack',
    async (request: FastifyRequest): Promise<AcknowledgeMessageResponseBody> => {
      const caller = request.requireUser();
      const params = parse(MessageIdParamsSchema, request.params, 'path');
      const body = parse(AcknowledgeMessageRequestSchema, request.body, 'body');

      const result = await inbox.acknowledge({
        userId: caller.id,
        agentId: body.agentId,
        projectId: body.projectId,
        messageId: params.id,
        ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
      });

      return AcknowledgeMessageResponseSchema.parse({
        messageId: result.messageId,
        alreadyAcknowledged: result.alreadyAcknowledged,
        acknowledgedAt: result.acknowledgedAt.toISOString(),
        acknowledgedBySessionId: result.acknowledgedBySessionId ?? null,
      });
    },
  );
}
