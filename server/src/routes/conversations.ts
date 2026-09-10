/**
 * The conversation endpoint from Plan §3: read one thread.
 *
 * ```text
 * GET /conversations/:id  ?limit=&after=   → { conversation, messages[], nextCursor }
 * ```
 *
 * ## What this route does not contain
 *
 * The access rule. D15 — a caller may read messages where one of their own
 * agents is sender or recipient — is the only interesting thing about this
 * endpoint, and it is deliberately not here: it is one expression in
 * `services/authorization.ts` (`messageVisibleToCaller`, plus the
 * `assertConversationParticipant` that decides between a page and a 404), and
 * `services/conversations.ts` applies it to every row of the page it reads. A
 * rule assembled in a handler is a rule the next caller reimplements slightly
 * differently, which for a read rule means a disclosure rather than a bug.
 *
 * So this file parses two query parameters, calls one method, and renders the
 * result.
 *
 * ## The response carries a cursor, which Plan §3 does not mention
 *
 * §3 writes the response as `{ conversation, messages[] }` — the thread whole.
 * T-301 measured why that cannot stand: a thread's rows sit roughly one to a
 * heap page, so an unbounded read is gathered by a bitmap scan and sorted
 * afterwards **at any table size**, and a thread has no upper bound while each
 * message in it may be a megabyte (D10). The read is therefore paged, and the
 * documented shape gains one field: `nextCursor`, null at the end of the
 * thread. Adding a field is additive under §12.4 and a client that ignores it
 * still reads a correct first page. `services/conversations.ts` records the
 * same decision from the other side, and the pull request asks for §3 to be
 * amended rather than leaving the plan and the code disagreeing quietly.
 *
 * ## A page is the caller's view, not the thread
 *
 * D15 is applied per message, exactly as `services/messages.ts` applies it when
 * it resolves a `--reply-to` parent. A conversation may hold messages between
 * agents the caller owns neither end of; those are absent from the page rather
 * than redacted, and `nextCursor` counts only what the caller may read, so
 * paging never reveals the size of what it skipped.
 *
 * ## Protected by omission (T-019)
 *
 * This route declares no `config.auth` and is not named in `PUBLIC_ROUTES`, so
 * `plugins/auth.ts` requires a bearer token on it. It must never be added to
 * that set: the endpoint reads private correspondence, and the only reason a
 * `cnv_` id is not enough to read it is the rule above.
 *
 * ## Wiring
 *
 * {@link registerConversationRoutes} takes its collaborators as arguments and
 * is not called from `app.ts`, which this task does not own. The pull request
 * lists the line that connects it.
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
  TimestampSchema,
} from '@stackgrid/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { ConversationMessage, ConversationService } from '../services/conversations.js';

// ---------------------------------------------------------------------------
// Schemas — `packages/protocol` does not own the messaging shapes yet; see
// `./messages.ts` on where these are written to move to.
// ---------------------------------------------------------------------------

/**
 * A message in a thread, as this endpoint renders it.
 *
 * The same eight fields `./messages.ts` sends for a send and for the inbox.
 * Declared here rather than imported from that module so the two route modules
 * do not depend on each other; they are one schema in `packages/protocol` as
 * soon as that package is opened, and a test in this file asserts they agree in
 * the meantime.
 */
export const ConversationMessageSchema = z.object({
  /** `msg_` identifier. Also this endpoint's cursor. */
  id: MessageId.schema,
  /** The project it was sent in. */
  projectId: ProjectId.schema,
  /** The thread it belongs to. Always the one that was asked for. */
  conversationId: ConversationId.schema,
  /** The message it replies to, or null for a thread root. */
  parentMessageId: MessageId.schema.nullable(),
  /** The agent that sent it. */
  senderAgentId: AgentId.schema,
  /** The agent it was addressed to. */
  recipientAgentId: AgentId.schema,
  /** The content, uninterpreted (PRD §3.7). */
  content: z.string(),
  /** When the server accepted it. */
  createdAt: TimestampSchema,
});

/** The thread itself. Almost empty, because the table is (PRD §3.7). */
export const ConversationSchema = z.object({
  /** `cnv_` identifier. */
  id: ConversationId.schema,
  /** The project the thread belongs to — the boundary it sits behind. */
  projectId: ProjectId.schema,
  /** When the thread was opened, i.e. when its first message was sent. */
  createdAt: TimestampSchema,
});

/** Path parameters for `GET /conversations/:id`. */
export const ConversationIdParamsSchema = z.object({
  /** The conversation's identifier, from the URL path. */
  id: ConversationId.schema,
});

/**
 * `GET /conversations/:id` query string.
 *
 * Both parameters are optional: a caller who asks for nothing gets the first
 * page at the service's default size, which is what makes the paging additive
 * for a client written against Plan §3 as it stands.
 */
export const ReadConversationQuerySchema = z.object({
  /** Page size. Clamped by the service; omitted means its default. */
  limit: z.coerce.number().int().min(1).optional(),
  /** Resume after this message, exclusive. A previous page's `nextCursor`. */
  after: MessageId.schema.optional(),
});

/** `GET /conversations/:id` query parameters. */
export type ReadConversationQuery = z.infer<typeof ReadConversationQuerySchema>;

/**
 * `GET /conversations/:id` response.
 *
 * `messages` is the envelope for the list — D17's `{ items: [...] }` argument
 * is that a bare array cannot grow a cursor, and this object already carries
 * one beside a named list, so wrapping the array a second time would only make
 * `{ conversation, messages: { items } }`.
 */
export const ReadConversationResponseSchema = z.object({
  /** The thread the caller was allowed to read. */
  conversation: ConversationSchema,
  /** The readable messages on this page, oldest first. */
  messages: z.array(ConversationMessageSchema),
  /** Where to resume, or null when this page reached the end of the thread. */
  nextCursor: MessageId.schema.nullable(),
});

/** `GET /conversations/:id` response body. */
export type ReadConversationResponseBody = z.infer<typeof ReadConversationResponseSchema>;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parses one part of a request against a schema.
 *
 * The same helper, and the same reasoning, as `./messages.ts`: a malformed
 * `cnv_` in the path is a `BAD_REQUEST` rather than a `NOT_FOUND`, because the
 * caller's id was not well-formed rather than merely wrong, and no input value
 * is echoed back.
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
 * @param message - The record the service returned.
 * @returns The wire representation.
 */
function toWire(message: ConversationMessage): z.infer<typeof ConversationMessageSchema> {
  return {
    id: message.id,
    projectId: message.projectId,
    conversationId: message.conversationId,
    parentMessageId: message.parentMessageId ?? null,
    senderAgentId: message.senderAgentId,
    recipientAgentId: message.recipientAgentId,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Options for {@link registerConversationRoutes}. */
export interface ConversationRouteOptions {
  /** The paged thread read. It holds the access rule and the ordering. */
  readonly conversations: ConversationService;
}

/**
 * Registers the conversation routes.
 *
 * Authenticated, because it is not named in `PUBLIC_ROUTES`; see the module
 * note.
 *
 * @param app - Fastify instance to add the route to.
 * @param options - Collaborators; see {@link ConversationRouteOptions}.
 */
export function registerConversationRoutes(
  app: FastifyInstance,
  options: ConversationRouteOptions,
): void {
  const { conversations } = options;

  app.get(
    '/conversations/:id',
    async (request: FastifyRequest): Promise<ReadConversationResponseBody> => {
      const caller = request.requireUser();
      const params = parse(ConversationIdParamsSchema, request.params, 'path');
      const query = parse(ReadConversationQuerySchema, request.query, 'query');

      const page = await conversations.read({
        userId: caller.id,
        conversationId: params.id,
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.after === undefined ? {} : { after: query.after }),
      });

      return ReadConversationResponseSchema.parse({
        conversation: {
          id: page.conversation.id,
          projectId: page.conversation.projectId,
          createdAt: page.conversation.createdAt.toISOString(),
        },
        messages: page.messages.map(toWire),
        nextCursor: page.nextCursor ?? null,
      });
    },
  );
}
