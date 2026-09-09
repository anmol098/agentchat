/**
 * Registering and ending a listening session: the two `/sessions` calls a
 * listener makes (plan §3, §6.3).
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
 * The server's copies are still where they were. Deleting them means editing a
 * route module this task does not own, and the two are textually identical
 * until somebody does.
 *
 * ## Only the two calls a listener makes
 *
 * The route module also declares the heartbeat and the listing. They are not
 * here, because moving a schema is a promise to keep it, and neither has a
 * caller yet:
 *
 * - The **heartbeat** is not what keeps a `listen` alive. A listener holds a
 *   socket, and plan §4.3 puts liveness on that socket — the WebSocket ping and
 *   the server's own sweep decide staleness. `POST /sessions/:id/heartbeat` is
 *   for a client that has registered a session without holding a connection,
 *   which nothing in this repository does.
 * - The **listing** has no caller either: `agentchat status` counts sessions
 *   from the discovery row (`GET /projects/:id/agents`), which plan §2 makes
 *   the same fact, and reads it from a request it was already making.
 *
 * They move when something needs them, which is the task that will find out
 * what they actually have to say.
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
