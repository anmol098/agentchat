/**
 * The project endpoints from plan §3: list, create, read, leave, and agent
 * discovery.
 *
 * ```text
 * GET  /projects
 * POST /projects                { name, slug? }
 * GET  /projects/:id
 * POST /projects/:id/leave
 * GET  /projects/:id/agents
 * ```
 *
 * ## Every handler is four lines, and that is the design
 *
 * A handler here parses the request against a schema from
 * `packages/protocol`, calls one method on `services/projects.ts`, and returns
 * what it gets. There is no `select` in this file, no role compared to a
 * string, and no error constructed from a status. Protocol §7.3 requires the
 * split; the reason it is worth requiring is that a rule which lives in a
 * handler is a rule the next caller — a WebSocket frame, an admin command —
 * will reimplement slightly differently.
 *
 * ## These routes are protected by omission
 *
 * None of them declares `config.auth`, and that is what makes every one of them
 * require a bearer token. `plugins/auth.ts` treats a route that says nothing as
 * `required`, so the failure mode of forgetting to think about authentication
 * here is a 401 on a route that should have been public — a bug report — rather
 * than an unauthenticated read of somebody's projects. Nothing in this module
 * may be added to `PUBLIC_ROUTES` in `app.ts`.
 *
 * ## Registration
 *
 * `registerProjectRoutes` is not called from `app.ts` by this task. T-023 owns
 * that file and calls all three M1 route modules; three concurrent tasks each
 * editing one line of it is the collision that task exists to prevent. One line
 * is needed there:
 *
 * ```ts
 * registerProjectRoutes(app, { db: database.db });
 * ```
 *
 * Registration order does not matter: the authentication guard is an
 * `onRequest` hook, and Fastify assembles those at ready time rather than at
 * registration (see the note in `plugins/auth.ts`).
 *
 * @module
 */

import {
  CreateProjectRequestSchema,
  type CreateProjectResponse,
  ErrorCode,
  type GetProjectResponse,
  LeaveProjectRequestSchema,
  type LeaveProjectResponse,
  type ListProjectAgentsResponse,
  type ListProjectsResponse,
  type ProjectId,
  ProjectIdParamsSchema,
  ProtocolError,
} from '@stackgrid/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import {
  type AuthorizationService,
  createAuthorizationService,
} from '../services/authorization.js';
import {
  createProjectService,
  type ProjectDatabase,
  type ProjectService,
} from '../services/projects.js';

/**
 * Options for {@link registerProjectRoutes}.
 *
 * `TSchema` is carried through for the reason `AppDatabase` carries it: a
 * Drizzle handle's `transaction` mentions the schema, so a handle built with
 * one does not fit a type pinned to the empty schema. Nothing here reads it.
 */
export interface ProjectRouteOptions<
  TSchema extends Record<string, unknown> = Record<string, never>,
> {
  /** Drizzle handle the service reads and writes through. */
  readonly db: ProjectDatabase<TSchema>;

  /**
   * The permission matrix.
   *
   * Optional so the wiring site is one argument; supplied when an application
   * wants a single instance shared with the other route modules, which is what
   * makes "how many statements does a request cost" answerable in one place.
   */
  readonly authorization?: AuthorizationService | undefined;

  /**
   * A prebuilt service, for tests that substitute one.
   *
   * Defaults to {@link createProjectService} over `db` and `authorization`,
   * which is what a deployment uses.
   */
  readonly service?: ProjectService | undefined;
}

/**
 * Parses a value against a protocol schema.
 *
 * Shared by the body and the path parameters because they fail the same way: a
 * malformed project id in the URL is a `BAD_REQUEST`, not a lookup that happens
 * to miss, and answering it with `NOT_FOUND` would tell a caller their
 * well-formed id was wrong when the truth is that it was not well-formed.
 *
 * @param schema - The schema from `packages/protocol` for this endpoint.
 * @param value - Whatever Fastify parsed, which may be `undefined`.
 * @param what - Named in the message: `request body`, `request path`.
 * @returns The validated value.
 * @throws {ProtocolError} `BAD_REQUEST` naming the offending fields. The
 *   values are not echoed; a caller who sent a field knows what they sent, and
 *   a message that quotes input is a message that can be made to quote
 *   anything.
 */
function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value ?? {});
  if (result.success) {
    return result.data;
  }

  const problems = result.error.issues.map((issue) => {
    const field = issue.path.join('.');
    return field === '' ? issue.message : `${field}: ${issue.message}`;
  });

  throw new ProtocolError(ErrorCode.BAD_REQUEST, `Invalid ${what}. ${problems.join('; ')}`);
}

/**
 * The project the URL names, validated.
 *
 * @param request - The request in flight.
 * @returns The branded identifier.
 * @throws {ProtocolError} `BAD_REQUEST` when the path segment is not a
 *   well-formed project id.
 */
function projectIdOf(request: FastifyRequest): ProjectId {
  return parse(ProjectIdParamsSchema, request.params, 'request path').id;
}

/**
 * Registers the project routes.
 *
 * Every one of them is authenticated; see the module note.
 *
 * @param app - Fastify instance to add the routes to.
 * @param options - Collaborators; see {@link ProjectRouteOptions}.
 */
export function registerProjectRoutes<
  TSchema extends Record<string, unknown> = Record<string, never>,
>(app: FastifyInstance, options: ProjectRouteOptions<TSchema>): void {
  const service =
    options.service ??
    createProjectService({
      db: options.db,
      authorization: options.authorization ?? createAuthorizationService(options.db),
    });

  app.get('/projects', async (request: FastifyRequest): Promise<ListProjectsResponse> => {
    const { id: userId } = request.requireUser();
    return await service.list(userId);
  });

  app.post('/projects', async (request: FastifyRequest): Promise<CreateProjectResponse> => {
    const { id: userId } = request.requireUser();
    const body = parse(CreateProjectRequestSchema, request.body, 'request body');
    return await service.create(userId, body);
  });

  app.get('/projects/:id', async (request: FastifyRequest): Promise<GetProjectResponse> => {
    const { id: userId } = request.requireUser();
    return await service.get(userId, projectIdOf(request));
  });

  app.post(
    '/projects/:id/leave',
    async (request: FastifyRequest): Promise<LeaveProjectResponse> => {
      const { id: userId } = request.requireUser();

      // The body carries no fields, and it is still parsed: `{ "role":
      // "owner" }` sent here must be rejected rather than quietly ignored, or a
      // client author will believe it did something.
      parse(LeaveProjectRequestSchema, request.body, 'request body');

      return await service.leave(userId, projectIdOf(request));
    },
  );

  app.get(
    '/projects/:id/agents',
    async (request: FastifyRequest): Promise<ListProjectAgentsResponse> => {
      const { id: userId } = request.requireUser();
      return await service.listAgents(userId, projectIdOf(request));
    },
  );
}
