/**
 * The session endpoints from Plan §3: register a listener, heartbeat it, tear
 * it down, and list the caller's own.
 *
 * ```
 * POST   /sessions                 { agentId, projectId, machine:{name}, runtime, workingDirectory } → { sessionId }
 * POST   /sessions/:id/heartbeat   → { status, lastSeenAt }
 * DELETE /sessions/:id             → { status, endedAt }
 * GET    /sessions?projectId=&agentId=  → { items: [ … ] }
 * ```
 *
 * ## Protected by omission (T-019)
 *
 * None of these appear in `app.ts`'s `PUBLIC_ROUTES`, which is the entire
 * mechanism: `plugins/auth.ts` treats a route that said nothing as `required`,
 * so every handler below can call `request.requireUser()` and no handler has to
 * remember to ask for protection. Adding one of these to that set would be the
 * only way to make it public, and it would be visible in one place.
 *
 * ## No business logic here (Protocol §7.3)
 *
 * Each handler parses, calls one method on {@link SessionService}, and shapes
 * the reply. Ownership, staleness, the machine upsert and the transitions all
 * live in `../services/sessions.ts`, so a second entry point — the WebSocket
 * `hello` of T-306, say — gets the same rules by calling the same service
 * rather than by copying a handler.
 *
 * ## Where the schemas live
 *
 * In `packages/protocol`, which is the point: a third party compiles against
 * that package, so a shape only this server knows is a shape nobody can
 * implement against. T-302 wrote them here because milestone 1 had not opened
 * the package for sessions yet, with a note that they were "written to be
 * moved verbatim"; T-312 moved register and end, and T-028 moved the listing
 * once `agentchat status` became its first caller. This module now declares
 * exactly one shape of its own.
 *
 * That one is {@link HeartbeatSessionResponseSchema}, and it stays because
 * nothing calls `POST /sessions/:id/heartbeat`. A listener holds a socket and
 * plan §4.3 puts liveness there. Moving a schema into the protocol package is a
 * promise to keep it, and the task that gives the heartbeat a client is the one
 * that will find out what it has to promise.
 *
 * @module
 */

import type {
  EndSessionResponse,
  ListSessionsResponse,
  RegisterSessionResponse,
  SessionSummary,
} from '@agentchat/protocol';
import {
  EndSessionResponseSchema,
  ErrorCode,
  ListSessionsQuerySchema,
  ListSessionsResponseSchema,
  ProtocolError,
  RegisterSessionRequestSchema,
  RegisterSessionResponseSchema,
  SessionIdParamsSchema,
  SessionStatusSchema,
  SessionSummarySchema,
  TimestampSchema,
} from '@agentchat/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { SessionRecord, SessionService } from '../services/sessions.js';

// ---------------------------------------------------------------------------
// The one schema still declared here — see the module note
// ---------------------------------------------------------------------------

/**
 * `POST /sessions/:id/heartbeat` response.
 *
 * The status is returned because a heartbeat can *change* it: a session that
 * had gone stale is active again, and a listener that has been unreachable for
 * a while wants to know its presence was restored rather than assume it.
 */
export const HeartbeatSessionResponseSchema = z.object({
  /** The session's status after the heartbeat. Always `active` on success. */
  status: SessionStatusSchema,
  /** The heartbeat instant, from the database clock. */
  lastSeenAt: TimestampSchema,
});

/** `POST /sessions/:id/heartbeat` response body. */
export type HeartbeatSessionResponseBody = z.infer<typeof HeartbeatSessionResponseSchema>;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parses one part of a request against a schema.
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
 * Puts a session on the wire.
 *
 * Parsed on the way out, like every other value this server sends: a column
 * that has drifted from the contract is a server bug, and this is where it is
 * caught rather than at a client.
 *
 * @param session - The record the service returned.
 * @returns The summary, validated.
 */
function toSummary(session: SessionRecord): SessionSummary {
  return SessionSummarySchema.parse({
    id: session.id,
    agentId: session.agentId,
    projectId: session.projectId,
    machineName: session.machineName,
    runtime: session.runtime,
    workingDirectory: session.workingDirectory,
    startedAt: session.startedAt.toISOString(),
    lastSeenAt: session.lastSeenAt.toISOString(),
    endedAt: session.endedAt?.toISOString() ?? null,
    status: session.status,
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Options for {@link registerSessionRoutes}. */
export interface SessionRouteOptions {
  /** The session lifecycle. Every rule these handlers apply lives in it. */
  readonly sessions: SessionService;
}

/**
 * Registers the session routes.
 *
 * All four are protected, because none of them is named in `PUBLIC_ROUTES` —
 * see the module note. Registration and teardown are refused for an agent the
 * caller does not own; the service decides that by calling
 * `services/authorization.ts`, not by deriving it here.
 *
 * @param app - Fastify instance to add the routes to.
 * @param options - Collaborators; see {@link SessionRouteOptions}.
 */
export function registerSessionRoutes(app: FastifyInstance, options: SessionRouteOptions): void {
  const { sessions } = options;

  app.post('/sessions', async (request: FastifyRequest): Promise<RegisterSessionResponse> => {
    const caller = request.requireUser();
    const body = parse(RegisterSessionRequestSchema, request.body, 'body');

    const session = await sessions.register({
      userId: caller.id,
      agentId: body.agentId,
      projectId: body.projectId,
      machineName: body.machine.name,
      runtime: body.runtime,
      workingDirectory: body.workingDirectory,
    });

    return RegisterSessionResponseSchema.parse({ sessionId: session.id });
  });

  app.post(
    '/sessions/:id/heartbeat',
    async (request: FastifyRequest): Promise<HeartbeatSessionResponseBody> => {
      const caller = request.requireUser();
      const params = parse(SessionIdParamsSchema, request.params, 'path');

      const session = await sessions.heartbeat({ userId: caller.id, sessionId: params.id });

      return HeartbeatSessionResponseSchema.parse({
        status: session.status,
        lastSeenAt: session.lastSeenAt.toISOString(),
      });
    },
  );

  app.delete('/sessions/:id', async (request: FastifyRequest): Promise<EndSessionResponse> => {
    const caller = request.requireUser();
    const params = parse(SessionIdParamsSchema, request.params, 'path');

    const session = await sessions.end({ userId: caller.id, sessionId: params.id });

    if (session.endedAt === null) {
      // Unreachable: `sessions_ended_at_matches_status` will not store an
      // ended session without the instant. Reported as the server bug it
      // would be rather than sent as a null the schema forbids.
      throw new ProtocolError(ErrorCode.INTERNAL, 'An ended session carried no end instant.');
    }

    return EndSessionResponseSchema.parse({
      status: session.status,
      endedAt: session.endedAt.toISOString(),
    });
  });

  // Diagnostics, and the one route here that answers about sessions the caller
  // did not name. The filters narrow only: the service scopes the statement by
  // a join on the agent's owner, so a stranger's `agentId` produces an empty
  // list. That is deliberate rather than lax — refusing would confirm the id
  // exists, and these rows carry machine names and working directories, which
  // say where somebody works and on what (T-106).
  app.get('/sessions', async (request: FastifyRequest): Promise<ListSessionsResponse> => {
    const caller = request.requireUser();
    const query = parse(ListSessionsQuerySchema, request.query, 'query');

    const found = await sessions.list({
      userId: caller.id,
      projectId: query.projectId,
      agentId: query.agentId,
      includeEnded: query.includeEnded,
    });

    return ListSessionsResponseSchema.parse({ items: found.map(toSummary) });
  });
}
