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
 * ## Schemas that `packages/protocol` does not own yet
 *
 * T-201 shipped milestone 1 only, and deliberately left sessions and messages
 * out: their semantics are settled by the milestone that implements them. So
 * the request and response shapes below are declared **here**, in zod, against
 * the protocol's own branded id schemas and `TimestampSchema`. They are written
 * to be moved verbatim into `packages/protocol/src/schemas/sessions.ts` when
 * that package is opened; the pull request for this task lists exactly what it
 * owes. Nothing under `packages/` was edited to get this working.
 *
 * ## Wiring
 *
 * {@link registerSessionRoutes} takes its collaborators as arguments and is not
 * called from `app.ts`, which this task does not own — the same arrangement
 * every M1 route module used. See the pull request for the lines that connect
 * it, including the sweeper.
 *
 * @module
 */

import {
  AgentId,
  ErrorCode,
  ProjectId,
  ProtocolError,
  SessionId,
  TimestampSchema,
} from '@agentchat/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { SessionRecord, SessionService } from '../services/sessions.js';
import { SESSION_STATUS } from '../services/sessions.js';

/**
 * Longest hostname accepted, matching the `machines_name_present` check.
 *
 * Restated rather than imported because the check is compiled into the
 * database when the migration runs; a shared constant would only give the
 * illusion that an already-migrated database follows along. The schema module
 * makes the same argument about the same numbers.
 */
const MAX_MACHINE_NAME_LENGTH = 255;

/** Longest runtime accepted, matching `sessions_runtime_present_if_set`. */
const MAX_RUNTIME_LENGTH = 64;

/** Longest working directory accepted, matching `sessions_working_directory_present`. */
const MAX_WORKING_DIRECTORY_LENGTH = 4096;

// ---------------------------------------------------------------------------
// Schemas — see the module note on where these belong
// ---------------------------------------------------------------------------

/** The three lifecycle states, on the wire. */
export const SessionStatusSchema = z.enum([
  SESSION_STATUS.ACTIVE,
  SESSION_STATUS.STALE,
  SESSION_STATUS.ENDED,
]);

/**
 * The machine a listener runs on, as `POST /sessions` names it.
 *
 * A nested object with one field rather than a flat `machineName`, because
 * Plan §3 writes it that way and because a machine will acquire more
 * attributes (an operating system, an architecture) long before it acquires a
 * second identifier. Adding a field to an object is additive; promoting a
 * string to an object is not (§12.4).
 */
export const SessionMachineSchema = z.object({
  /** The hostname, as the CLI read it. Never resolved or connected to. */
  name: z.string().trim().min(1).max(MAX_MACHINE_NAME_LENGTH),
});

/**
 * `POST /sessions` request.
 *
 * `runtime` is **required** (D14). The column behind it is nullable — Plan §2
 * marks it optional, and it must accept rows written by something that is not
 * this CLI — but no request that reaches this server may omit it, and the
 * server never fills it in from an environment variable, a process name or a
 * header. The invoking agent knows its own runtime; anything the server
 * guessed would be wrong metadata presented as authoritative in discovery.
 */
export const RegisterSessionRequestSchema = z.object({
  /** The agent this listener speaks for. Must be the caller's own. */
  agentId: AgentId.schema,
  /** The project it listens in. The agent must already participate in it. */
  projectId: ProjectId.schema,
  /** The machine it runs on. Upserted by `(user, name)`. */
  machine: SessionMachineSchema,
  /** The harness, free-form: `codex`, `claude-code`, `opencode`, … */
  runtime: z.string().trim().min(1).max(MAX_RUNTIME_LENGTH),
  /** Where `listen` was started. Stored verbatim, never interpreted. */
  workingDirectory: z.string().min(1).max(MAX_WORKING_DIRECTORY_LENGTH),
});

/** `POST /sessions` request body. */
export type RegisterSessionRequestBody = z.infer<typeof RegisterSessionRequestSchema>;

/**
 * `POST /sessions` response.
 *
 * Exactly what Plan §3 specifies and nothing more. The client needs the id to
 * put in its WebSocket `hello` and knows every other field already, since it
 * just sent them; adding the whole record here would be a contract this task
 * invented rather than one the plan settled. Fields may be added later without
 * a major version (§12.4), so nothing is foreclosed.
 */
export const RegisterSessionResponseSchema = z.object({
  /** The new session's identifier. Quoted back in the WebSocket `hello`. */
  sessionId: SessionId.schema,
});

/** `POST /sessions` response body. */
export type RegisterSessionResponseBody = z.infer<typeof RegisterSessionResponseSchema>;

/** Path parameters for any route under `/sessions/:id`. */
export const SessionIdParamsSchema = z.object({
  /** The session's identifier, from the URL path. */
  id: SessionId.schema,
});

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

/**
 * `DELETE /sessions/:id` response.
 *
 * `endedAt` is the instant the session *first* ended, not the instant of this
 * call, so a retried teardown and a session the sweeper got to first both
 * report the truth.
 */
export const EndSessionResponseSchema = z.object({
  /** Always `ended`. */
  status: SessionStatusSchema,
  /** When it ended. */
  endedAt: TimestampSchema,
});

/** `DELETE /sessions/:id` response body. */
export type EndSessionResponseBody = z.infer<typeof EndSessionResponseSchema>;

/**
 * One session in a listing.
 *
 * `machineName` rather than a bare `mch_` id: the only reason `machines` exists
 * is so `agentchat status` can say which laptop a session belongs to, and a
 * listing that made the caller resolve that itself would defeat the table.
 */
export const SessionSummarySchema = z.object({
  /** `ses_` identifier. */
  id: SessionId.schema,
  /** The agent this listener speaks for. */
  agentId: AgentId.schema,
  /** The project it listens in. */
  projectId: ProjectId.schema,
  /** The machine's hostname. */
  machineName: z.string(),
  /** The harness that opened it. Null only for rows this API did not write. */
  runtime: z.string().nullable(),
  /** Where `listen` was started. */
  workingDirectory: z.string(),
  /** When it registered. */
  startedAt: TimestampSchema,
  /** Last heartbeat. */
  lastSeenAt: TimestampSchema,
  /** When it ended, or null while it has not. */
  endedAt: TimestampSchema.nullable(),
  /** Where it is in the lifecycle. `active` is the only one that is present. */
  status: SessionStatusSchema,
});

/** One session in a listing. */
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/**
 * `GET /sessions` response.
 *
 * Enveloped, like every other list on this server: a bare array cannot carry a
 * pagination cursor, and §12.4 makes adding one to it a major-version change.
 */
export const ListSessionsResponseSchema = z.object({
  /** The caller's sessions, newest first. */
  items: z.array(SessionSummarySchema),
});

/** `GET /sessions` response body. */
export type ListSessionsResponseBody = z.infer<typeof ListSessionsResponseSchema>;

/**
 * `GET /sessions` query string.
 *
 * Both filters are optional and both only narrow — the listing is scoped to the
 * caller's own agents inside the SQL, so a stranger's `agentId` yields an empty
 * list rather than a refusal that would confirm the id exists.
 */
export const ListSessionsQuerySchema = z.object({
  /** Restrict to one project. */
  projectId: ProjectId.schema.optional(),
  /** Restrict to one agent. */
  agentId: AgentId.schema.optional(),
});

/** `GET /sessions` query parameters. */
export type ListSessionsQuery = z.infer<typeof ListSessionsQuerySchema>;

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
 * Reads an optional boolean from a query string.
 *
 * Query values arrive as strings, so `?includeEnded=false` is truthy to
 * anything that does not look. Only the exact string `true` enables it;
 * anything else, including a missing parameter, leaves it off.
 *
 * @param raw - The raw query object Fastify parsed.
 * @param name - The parameter to read.
 * @returns Whether the flag was set.
 */
function flag(raw: unknown, name: string): boolean {
  if (typeof raw !== 'object' || raw === null) {
    return false;
  }
  return (raw as Record<string, unknown>)[name] === 'true';
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

  app.post('/sessions', async (request: FastifyRequest): Promise<RegisterSessionResponseBody> => {
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

  app.delete('/sessions/:id', async (request: FastifyRequest): Promise<EndSessionResponseBody> => {
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

  app.get('/sessions', async (request: FastifyRequest): Promise<ListSessionsResponseBody> => {
    const caller = request.requireUser();
    const query = parse(ListSessionsQuerySchema, request.query, 'query');

    const found = await sessions.list({
      userId: caller.id,
      projectId: query.projectId,
      agentId: query.agentId,
      includeEnded: flag(request.query, 'includeEnded'),
    });

    return ListSessionsResponseSchema.parse({ items: found.map(toSummary) });
  });
}
