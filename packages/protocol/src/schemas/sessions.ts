/**
 * Registering a listening session, ending it, and listing what is running
 * (plan §3, §6.3).
 *
 * ## Why this module exists now
 *
 * `./index.ts` said sessions were "deliberately missing", and it was right to:
 * T-201 shipped milestone 1, and writing these shapes then would have been
 * guessing at a lifecycle four later tasks had to live with. They are no longer
 * a guess. `server/src/routes/sessions.ts` declared them locally in T-302 with
 * an explicit note that they were "written to be moved verbatim into
 * `packages/protocol/src/schemas/sessions.ts` when that package is opened", and
 * `agentchat listen` (T-312) — the first client of the endpoint — is what opens
 * it. Everything below is that move, field for field and comment for comment;
 * nothing here was invented at this end.
 *
 * ## The listing moved here in T-028, and the heartbeat did not
 *
 * Moving a schema is a promise to keep it, so each half moves when something
 * needs it.
 *
 * - The **listing** now has a caller. `agentchat status` used to count sessions
 *   from the discovery row (`GET /projects/:id/agents`), which plan §2 makes
 *   the same fact and which it read from a request it was already making. That
 *   count is exact and it is not enough: the failure this product is debugged
 *   for is a listener that is registered and not receiving, and answering it
 *   needs the machine, the runtime, the working directory, the age and the
 *   identifier — a count of one and a count of one look identical whether the
 *   listener is healthy or wedged. {@link SessionSummarySchema} is that detail.
 * - The **heartbeat** still has none. A listener holds a socket, and plan §4.3
 *   puts liveness on that socket — the WebSocket ping and the server's own
 *   sweep decide staleness. `POST /sessions/:id/heartbeat` is for a client that
 *   has registered a session without holding a connection, which nothing in
 *   this repository does. Its schema stays in the route module until one
 *   appears, and that task is what will find out what it has to say.
 *
 * ## `runtime` is required, and nothing guesses it
 *
 * Decision D14. The column behind it is nullable — plan §2 marks it optional,
 * and it must accept rows written by something that is not this CLI — but no
 * request that reaches the server may omit it, and the server never fills it in
 * from an environment variable, a process name, or a header. The invoking agent
 * knows its own runtime; anything guessed would be wrong metadata presented as
 * authoritative in discovery, which is worse than an absent field because
 * nobody can tell it apart from a fact.
 *
 * @module
 */

import { z } from 'zod';

import { AgentId, ProjectId, SessionId } from '../ids.js';
import { TimestampSchema } from './primitives.js';

/**
 * Longest machine name accepted, matching the `machines_name_present` check.
 *
 * Restated rather than shared with the database for the same reason as
 * {@link MAX_MESSAGE_CONTENT_BYTES} in `./messages.ts`: a `CHECK` is compiled
 * into the database when its migration runs, so an already-migrated database
 * does not follow a constant this file changes, and sharing one would only make
 * it look as though it did.
 */
export const MAX_MACHINE_NAME_LENGTH = 255;

/** Longest runtime accepted, matching `sessions_runtime_present_if_set`. */
export const MAX_RUNTIME_LENGTH = 64;

/** Longest working directory accepted, matching `sessions_working_directory_present`. */
export const MAX_WORKING_DIRECTORY_LENGTH = 4096;

/** The three lifecycle states, on the wire. */
export const SessionStatusSchema = z.enum(['active', 'stale', 'ended']);

/** Where a session is in its lifecycle. */
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/**
 * The machine a listener runs on, as `POST /sessions` names it.
 *
 * A nested object with one field rather than a flat `machineName`, because
 * plan §3 writes it that way and because a machine will acquire more attributes
 * (an operating system, an architecture) long before it acquires a second
 * identifier. Adding a field to an object is additive; promoting a string to an
 * object is not (§12.4).
 */
export const SessionMachineSchema = z.object({
  /** The hostname, as the CLI read it. Never resolved or connected to. */
  name: z.string().trim().min(1).max(MAX_MACHINE_NAME_LENGTH),
});

/** The machine a session runs on. */
export type SessionMachine = z.infer<typeof SessionMachineSchema>;

/**
 * `POST /sessions` request.
 *
 * See the module note on `runtime`.
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
export type RegisterSessionRequest = z.infer<typeof RegisterSessionRequestSchema>;

/**
 * `POST /sessions` response.
 *
 * Exactly what plan §3 specifies and nothing more. The client needs the id to
 * put in its WebSocket `hello` and knows every other field already, since it
 * just sent them; returning the whole record would be a contract this endpoint
 * invented rather than one the plan settled. Fields may be added later without
 * a major version (§12.4), so nothing is foreclosed.
 */
export const RegisterSessionResponseSchema = z.object({
  /** The new session's identifier. Quoted back in the WebSocket `hello`. */
  sessionId: SessionId.schema,
});

/** `POST /sessions` response body. */
export type RegisterSessionResponse = z.infer<typeof RegisterSessionResponseSchema>;

/** Path parameters for any route under `/sessions/:id`. */
export const SessionIdParamsSchema = z.object({
  /** The session's identifier, from the URL path. */
  id: SessionId.schema,
});

/** `/sessions/:id` path parameters. */
export type SessionIdParams = z.infer<typeof SessionIdParamsSchema>;

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
export type EndSessionResponse = z.infer<typeof EndSessionResponseSchema>;

/**
 * One session in a listing.
 *
 * `machineName` rather than a bare `mch_` id: the only reason `machines` is
 * modelled at all is so a client can say which laptop a session belongs to, and
 * a listing that made the caller resolve that itself would defeat the table.
 *
 * Nothing here is derived. `status` is the stored lifecycle value rather than
 * an "online" boolean the server computed, because telling `active` from
 * `stale` is the whole diagnostic value of this endpoint: a listener that has
 * gone quiet is the failure people run `agentchat status` to explain, and
 * collapsing the two would erase exactly the distinction they came for.
 */
export const SessionSummarySchema = z.object({
  /** `ses_` identifier. `listen` prints it on stderr, so it is quotable. */
  id: SessionId.schema,
  /** The agent this listener speaks for. */
  agentId: AgentId.schema,
  /** The project it listens in. */
  projectId: ProjectId.schema,
  /** The machine's hostname, as the CLI reported it. */
  machineName: z.string(),
  /** The harness that opened it. Null only for rows this API did not write. */
  runtime: z.string().nullable(),
  /** Where `listen` was started. Stored verbatim, never interpreted. */
  workingDirectory: z.string(),
  /** When it registered. */
  startedAt: TimestampSchema,
  /** Last heartbeat. What staleness is measured from. */
  lastSeenAt: TimestampSchema,
  /** When it ended, or null while it has not. */
  endedAt: TimestampSchema.nullable(),
  /** Where it is in the lifecycle. `active` is the only one that is present. */
  status: SessionStatusSchema,
});

/** One session in a listing. */
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/**
 * `GET /sessions` query string.
 *
 * Both filters are optional and both only narrow. The listing is scoped to the
 * caller's own agents inside the SQL, so a stranger's `agentId` yields an empty
 * list rather than a refusal. That is T-106's disclosure rule applied to a
 * listing instead of a lookup, and it matters more here than there: agent and
 * project ids are printed by every discovery listing, so an endpoint that
 * answered "forbidden" for somebody else's would confirm which of them exist —
 * and it would do it while holding machine names, working directories and
 * runtimes, which say where a stranger works and on what.
 *
 * ## Why `includeEnded` accepts a string as well as a boolean
 *
 * One schema is parsed from two directions. A client passes `true`; a query
 * string can only carry `"true"`, and `Boolean("false")` is `true`, so a plain
 * coercion would turn `?includeEnded=false` into the opposite of what it says.
 * Only the boolean `true` and the exact string `"true"` enable it. Anything
 * else — `?includeEnded=yes` — leaves it off rather than failing the request:
 * this is the endpoint someone reaches for when things are already broken, and
 * a diagnostics filter that answers 400 is a worse answer than one that
 * declines to widen.
 */
export const ListSessionsQuerySchema = z.object({
  /** Restrict to one project. */
  projectId: ProjectId.schema.optional(),
  /** Restrict to one agent. */
  agentId: AgentId.schema.optional(),
  /**
   * Include sessions that have already ended. Off by default.
   *
   * One row accumulates per `listen` invocation and never becomes interesting
   * again, so a listing that included them would bury the live ones somebody is
   * actually asking about.
   */
  includeEnded: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((value) => value === true || value === 'true'),
});

/** `GET /sessions` query parameters, as a caller writes them. */
export type ListSessionsQuery = z.input<typeof ListSessionsQuerySchema>;

/** `GET /sessions` query parameters, after parsing. `includeEnded` is decided. */
export type ParsedListSessionsQuery = z.infer<typeof ListSessionsQuerySchema>;

/**
 * `GET /sessions` response.
 *
 * Enveloped, like every list this protocol describes (D17): a bare array cannot
 * grow a cursor without a major version. This one is deliberately not paged — a
 * person has as many sessions as they have running listeners — and the envelope
 * is what keeps adding a cursor later additive rather than breaking.
 */
export const ListSessionsResponseSchema = z.object({
  /** The caller's sessions, newest first. */
  items: z.array(SessionSummarySchema),
});

/** `GET /sessions` response body. */
export type ListSessionsResponse = z.infer<typeof ListSessionsResponseSchema>;
