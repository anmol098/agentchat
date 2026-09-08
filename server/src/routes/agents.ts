/**
 * The agent endpoints from Plan §3: `GET /agents`, `POST /agents`,
 * `PATCH /agents/:id`, `DELETE /agents/:id`, `POST /agents/:id/projects` and
 * `DELETE /agents/:id/projects/:pid`.
 *
 * Thin on purpose. Every handler does the same four things and nothing else:
 * parse the path and body with the schemas `packages/protocol` publishes, read
 * the caller from `request.requireUser()`, call one method on
 * `services/agents.ts`, and serialise the answer back through a protocol schema.
 * No handler runs a query, and no handler decides an access rule — those live
 * in `services/agents.ts` and `services/authorization.ts` respectively, which
 * is what makes the rules auditable in one place rather than reconstructible
 * from six.
 *
 * ## Protected by omission (T-019)
 *
 * Not one route here is named in `app.ts`'s `PUBLIC_ROUTES`, and that is the
 * entire authentication story. `plugins/auth.ts` refuses any route that has not
 * declared itself public, so a route added to this module later is protected
 * before its author has thought about it. Nothing in this file mentions
 * authentication, which is the point: there is no line to forget.
 *
 * ## Names are validated before the round trip
 *
 * `AgentNameSchema` in `packages/protocol` is the same grammar as the
 * `agents_name_format` check constraint compiled into the database
 * (`^[a-z0-9][a-z0-9-]{0,31}$`). Parsing the body against it here means a bad
 * name is a `BAD_REQUEST` naming the field, decided in this process, rather
 * than a constraint violation the driver reports after a network hop — and it
 * means the CLI (T-208) enforcing the identical rule client-side is enforcing
 * *the same* rule, not a copy of it, because all three read from one schema.
 *
 * ## Registering these routes
 *
 * This module exports {@link registerAgentRoutes} and stops there. Wiring it on
 * to the application is T-023's, which owns `app.ts`; one line, next to
 * `registerAuthRoutes`:
 *
 * ```ts
 * registerAgentRoutes(app, { agents: createAgentService(database.db) });
 * ```
 *
 * @module
 */

import {
  AddAgentToProjectRequestSchema,
  type AddAgentToProjectResponse,
  AddAgentToProjectResponseSchema,
  type Agent,
  AgentIdParamsSchema,
  AgentProjectParamsSchema,
  AgentSchema,
  CreateAgentRequestSchema,
  type CreateAgentResponse,
  CreateAgentResponseSchema,
  type DeleteAgentResponse,
  DeleteAgentResponseSchema,
  ErrorCode,
  type ListAgentsResponse,
  ListAgentsResponseSchema,
  ProtocolError,
  type RemoveAgentFromProjectResponse,
  RemoveAgentFromProjectResponseSchema,
  RenameAgentRequestSchema,
  type RenameAgentResponse,
  RenameAgentResponseSchema,
} from '@agentchat/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { AgentService } from '../services/agents.js';
import type { AgentRecord } from '../services/authorization.js';

/** The status `POST /agents` answers with. */
const CREATED = 201;

/** Collaborators {@link registerAgentRoutes} needs. */
export interface AgentRouteOptions {
  /** The agent lifecycle; see `services/agents.ts`. */
  readonly agents: AgentService;
}

/**
 * Parses an untrusted value against a protocol schema.
 *
 * Shared by the body and the path because they fail the same way and deserve
 * the same answer: a `BAD_REQUEST` naming the offending fields. The *values*
 * are not echoed — nothing here is a credential, but a route that echoes input
 * into an error message is one refactor away from being a reflection gadget,
 * and the field name is what the caller needs to fix it anyway.
 *
 * @param schema - The schema from `packages/protocol` for this position.
 * @param value - Whatever Fastify parsed.
 * @param what - `'body'` or `'path'`, for the message.
 * @returns The validated value.
 * @throws {ProtocolError} `BAD_REQUEST` naming the offending fields.
 */
function parseOrReject<T>(schema: z.ZodType<T>, value: unknown, what: 'body' | 'path'): T {
  const result = schema.safeParse(value ?? {});
  if (result.success) {
    return result.data;
  }

  const problems = result.error.issues.map((issue) => {
    const field = issue.path.join('.');
    return field === '' ? issue.message : `${field}: ${issue.message}`;
  });

  throw new ProtocolError(ErrorCode.BAD_REQUEST, `Invalid request ${what}. ${problems.join('; ')}`);
}

/**
 * Puts an agent on the wire.
 *
 * `Date`s become the ISO-8601 UTC strings `TimestampSchema` describes, and the
 * result is parsed by `AgentSchema` rather than merely typed as one. Fastify
 * would happily serialise whatever it was handed; this is the point at which a
 * field that should not be on the wire — a `deletedAt` that some future refactor
 * adds to the record — fails loudly here instead of quietly shipping.
 *
 * @param agent - A live agent from the service.
 * @returns The contract representation.
 */
function toWire(agent: AgentRecord): Agent {
  return AgentSchema.parse({
    id: agent.id,
    userId: agent.userId,
    name: agent.name,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  });
}

/**
 * Registers the agent routes.
 *
 * Every one of them requires a bearer token, and none of them says so; see the
 * module note on protection by omission.
 *
 * @param app - Fastify instance to add the routes to.
 * @param options - Collaborators; see {@link AgentRouteOptions}.
 */
export function registerAgentRoutes(app: FastifyInstance, options: AgentRouteOptions): void {
  const { agents } = options;

  // Plan §3: `GET /agents` (mine). Enveloped as `{ items: [...] }` (D17), so a
  // cursor can be added later without a major version.
  app.get('/agents', async (request: FastifyRequest): Promise<ListAgentsResponse> => {
    const { id: userId } = request.requireUser();
    const mine = await agents.list({ userId });

    return ListAgentsResponseSchema.parse({ items: mine.map(toWire) });
  });

  // Plan §3: `POST /agents { name }`. 201 with the created agent, whose `id` is
  // freshly minted even when the name is one the caller freed by deleting an
  // agent — see `services/agents.ts` on why a name is not an identity.
  app.post(
    '/agents',
    async (request: FastifyRequest, reply: FastifyReply): Promise<CreateAgentResponse> => {
      const { id: userId } = request.requireUser();
      const body = parseOrReject(CreateAgentRequestSchema, request.body, 'body');

      const created = await agents.create({ userId, name: body.name });

      reply.code(CREATED);
      return CreateAgentResponseSchema.parse(toWire(created));
    },
  );

  // Plan §3: `PATCH /agents/:id { name }`. The whole agent comes back, bumped
  // `updatedAt` included, so a client refreshes from the response rather than
  // patching its own copy and hoping the server agreed.
  app.patch('/agents/:id', async (request: FastifyRequest): Promise<RenameAgentResponse> => {
    const { id: userId } = request.requireUser();
    const { id } = parseOrReject(AgentIdParamsSchema, request.params, 'path');
    const body = parseOrReject(RenameAgentRequestSchema, request.body, 'body');

    const renamed = await agents.rename({ userId, agentId: id, name: body.name });

    return RenameAgentResponseSchema.parse(toWire(renamed));
  });

  // Plan §3: `DELETE /agents/:id`, the soft delete (D13). The response has no
  // fields on purpose: the agent is gone from every listing and cannot be
  // addressed, so echoing a representation of it would invite a client to keep
  // rendering something that no longer exists.
  app.delete('/agents/:id', async (request: FastifyRequest): Promise<DeleteAgentResponse> => {
    const { id: userId } = request.requireUser();
    const { id } = parseOrReject(AgentIdParamsSchema, request.params, 'path');

    const deletion = await agents.delete({ userId, agentId: id });

    // The three counts in one line. An operator can tell a complete delete from
    // one that found nothing to end, which the empty 200 body cannot say.
    request.log.info(
      {
        agentId: deletion.agentId,
        projectsLeft: deletion.projectsLeft,
        sessionsEnded: deletion.sessionsEnded,
      },
      'agent soft-deleted',
    );

    return DeleteAgentResponseSchema.parse({});
  });

  // Plan §3: `POST /agents/:id/projects { projectId }`. Idempotent, and it needs
  // two rules rather than one — the caller must own the agent *and* be in the
  // project. `services/agents.ts` asserts both.
  app.post(
    '/agents/:id/projects',
    async (request: FastifyRequest): Promise<AddAgentToProjectResponse> => {
      const { id: userId } = request.requireUser();
      const { id } = parseOrReject(AgentIdParamsSchema, request.params, 'path');
      const body = parseOrReject(AddAgentToProjectRequestSchema, request.body, 'body');

      await agents.addToProject({ userId, agentId: id, projectId: body.projectId });

      return AddAgentToProjectResponseSchema.parse({});
    },
  );

  // Plan §3: `DELETE /agents/:id/projects/:pid`. Two identifiers of different
  // kinds in one path, which `AgentProjectParamsSchema` keeps apart: after
  // parsing, an agent id in the project position is a `BAD_REQUEST` rather than
  // a query that quietly matches nothing.
  app.delete(
    '/agents/:id/projects/:pid',
    async (request: FastifyRequest): Promise<RemoveAgentFromProjectResponse> => {
      const { id: userId } = request.requireUser();
      const { id, pid } = parseOrReject(AgentProjectParamsSchema, request.params, 'path');

      const removal = await agents.removeFromProject({ userId, agentId: id, projectId: pid });

      if (removal.sessionsEnded > 0) {
        request.log.info(
          { agentId: id, projectId: pid, sessionsEnded: removal.sessionsEnded },
          'agent removed from project; its sessions there were ended',
        );
      }

      return RemoveAgentFromProjectResponseSchema.parse({});
    },
  );
}
