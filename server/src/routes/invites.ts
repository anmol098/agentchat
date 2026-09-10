/**
 * The invite endpoints from plan §3: mint a code, preview it, redeem it.
 *
 * ```text
 * POST   /projects/:id/invites              → { id, code, expiresAt }
 * GET    /invites/:code                     → { project, invitedBy }
 * POST   /invites/:code/join                → { project }
 * DELETE /projects/:id/invites/:inviteId    → {}
 * ```
 *
 * Shaped like `routes/projects.ts`, and for the same reason: a handler parses
 * the request against a schema from `packages/protocol`, calls one method on
 * `services/invites.ts`, and returns what it gets. There is no `select` in this
 * file, no expiry compared to a clock, and no error built from a status.
 *
 * ## These routes are authenticated, including the preview
 *
 * None of them declares `config.auth`, so `plugins/auth.ts` treats all three as
 * `required`. That is the deliberate answer for `GET /invites/:code` rather
 * than an oversight, and it is worth stating because the endpoint is often
 * described as the public one:
 *
 * - **Plan §3 is explicit.** "Bearer token auth on everything except
 *   `/auth/device/*` and `/healthz`." `/version` is named unauthenticated
 *   beside it; `/invites/:code` is not.
 * - **It costs the flow nothing.** PRD §27 has the CLI preview a code and then
 *   offer to join. Joining needs an account, so anybody reaching the preview is
 *   a caller the CLI has already logged in. Requiring the token buys an
 *   identity behind every guess and something to rate-limit on, for a
 *   confirmation prompt that was never going to be reached by a stranger.
 * - **The exception this endpoint really makes is to *authorization*.** It
 *   answers a caller who is a member of nothing, which makes it the one place
 *   in M1 where project data crosses to an outsider. That exception is
 *   declared where it can be enforced rather than described: `InviteService.preview`
 *   takes no user id, so it has nothing to check membership with and nothing to
 *   widen its answer by, and its response is parsed through
 *   `InvitePreviewResponseSchema` on the way out.
 *
 * **T-023 must not add `/invites/:code` to `PUBLIC_ROUTES` in `app.ts`.**
 * Doing so would make a bearer credential redeemable-adjacent to the open
 * internet: the code alone would then be enough to learn a project's name and
 * who is inviting people into it, with no account behind the request and
 * nothing to throttle. If a deployment ever wants that — a web landing page for
 * an invite link is the plausible reason — it is a decision for the file that
 * owns the unauthenticated surface, made once, out loud, and not something this
 * module should be able to grant itself.
 *
 * ## Registration
 *
 * `registerInviteRoutes` is not called from `app.ts` by this task; T-023 owns
 * that file and wires all three M1 route modules. One line is needed there:
 *
 * ```ts
 * registerInviteRoutes(app, { db: database.db });
 * ```
 *
 * Pass the same `authorization` instance as `registerProjectRoutes` if the
 * application keeps one, so a request's cost stays answerable in one place.
 *
 * ## Revoking, and why it is addressed by identifier
 *
 * `DELETE /projects/:id/invites/:inviteId` withdraws a code before it expires.
 * Nothing in this module or the service had to move for it, exactly as T-108
 * predicted: `revoked_at` was already one of the three liveness conditions in
 * the single lookup both preview and join go through, so a revoked code
 * disappears from both the moment the column is set. What was added is the
 * setter, the rule for who may call it, and the identifier in the create
 * response that a caller revokes by.
 *
 * The route takes the invite's `inv_` identifier and not its code, which is the
 * one design decision in the shape:
 *
 * - **A code in a URL is a credential in a log.** Path segments land in access
 *   logs, proxy logs, `Referer` headers and shell history. Spending a live
 *   bearer credential that way in order to destroy it is the wrong trade even
 *   though the window is short — and a mistyped code would revoke somebody
 *   else's invite rather than nothing.
 * - **The permission is about the project, not about the code.** The caller
 *   here is a member acting on their project's invite, not a stranger holding a
 *   credential. Putting the project in the path is what lets `assertProjectMember`
 *   run before anything is looked up, and lets the invite be selected scoped to
 *   that project, so an identifier belonging to a project the caller cannot see
 *   is answered exactly as an invented one is.
 * - **Plan §3 already named this shape.** It is confirmed rather than inherited:
 *   the two points above are why it is right.
 *
 * Who may revoke — any member of the project, whoever minted the invite — is
 * argued on `RevokeInviteResponseSchema` in `packages/protocol` and summarised
 * in `services/invites.ts`. It is not a route-level decision: the handler asks
 * the service, which asks the permission matrix.
 *
 * ## Registration, again
 *
 * The revoke route is registered by the same `registerInviteRoutes` call, so
 * T-023 still needs only the one line quoted above.
 *
 * @module
 */

import {
  CreateInviteRequestSchema,
  type CreateInviteResponse,
  ErrorCode,
  type InviteCode,
  InviteCodeParamsSchema,
  type InvitePreviewResponse,
  JoinProjectRequestSchema,
  type JoinProjectResponse,
  type ProjectId,
  ProjectIdParamsSchema,
  ProjectInviteParamsSchema,
  ProtocolError,
  type RevokeInviteResponse,
} from '@stackgrid/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import {
  type AuthorizationService,
  createAuthorizationService,
} from '../services/authorization.js';
import {
  createInviteService,
  type InviteDatabase,
  type InviteService,
} from '../services/invites.js';

/**
 * Options for {@link registerInviteRoutes}.
 *
 * `TSchema` is carried through for the reason `AppDatabase` carries it: a
 * Drizzle handle's `transaction` mentions the schema, so a handle built with
 * one does not fit a type pinned to the empty schema. Nothing here reads it.
 */
export interface InviteRouteOptions<
  TSchema extends Record<string, unknown> = Record<string, never>,
> {
  /** Drizzle handle the service reads and writes through. */
  readonly db: InviteDatabase<TSchema>;

  /**
   * The permission matrix.
   *
   * Optional so the wiring site is one argument; supplied when an application
   * wants a single instance shared with the other route modules.
   */
  readonly authorization?: AuthorizationService | undefined;

  /**
   * A prebuilt service, for tests that substitute one.
   *
   * Defaults to {@link createInviteService} over `db` and `authorization`,
   * which is what a deployment uses.
   */
  readonly service?: InviteService | undefined;
}

/**
 * Parses a value against a protocol schema.
 *
 * The same helper `routes/projects.ts` uses, for the same reason: a malformed
 * path segment is a `BAD_REQUEST` rather than a lookup that happens to miss.
 *
 * Note what this does *not* do for a code. An invite code that is well-formed
 * but wrong is never a validation failure — `InviteCodeSchema` accepts any run
 * of letters, digits and hyphens precisely so that the lookup, not the parser,
 * decides — so a guessed code and a revoked one both reach the service and both
 * come back `INVITE_INVALID`. Only a code that could not be a path segment at
 * all is rejected here.
 *
 * @param schema - The schema from `packages/protocol` for this endpoint.
 * @param value - Whatever Fastify parsed, which may be `undefined`.
 * @param what - Named in the message: `request body`, `request path`.
 * @returns The validated value.
 * @throws {ProtocolError} `BAD_REQUEST` naming the offending fields. The values
 *   are not echoed; an invite code is a credential and echoing one would put it
 *   in every error log between here and the caller.
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
 * The invite code the URL names, shape-validated only.
 *
 * @param request - The request in flight.
 * @returns The code as typed. Canonicalised by the service, not here: one
 *   spelling rule, in the module that owns the lookup.
 * @throws {ProtocolError} `BAD_REQUEST` when the segment is not a code-shaped
 *   string at all.
 */
function inviteCodeOf(request: FastifyRequest): InviteCode {
  return parse(InviteCodeParamsSchema, request.params, 'request path').code;
}

/**
 * Registers the invite routes.
 *
 * Every one of them is authenticated, the preview included; see the module
 * note.
 *
 * @param app - Fastify instance to add the routes to.
 * @param options - Collaborators; see {@link InviteRouteOptions}.
 */
export function registerInviteRoutes<
  TSchema extends Record<string, unknown> = Record<string, never>,
>(app: FastifyInstance, options: InviteRouteOptions<TSchema>): void {
  const service =
    options.service ??
    createInviteService({
      db: options.db,
      authorization: options.authorization ?? createAuthorizationService(options.db),
    });

  app.post(
    '/projects/:id/invites',
    async (request: FastifyRequest): Promise<CreateInviteResponse> => {
      const { id: userId } = request.requireUser();

      // The body carries no fields, and it is still parsed: a client that sent
      // `{ "expiresIn": 3600 }` must be told the server ignored it rather than
      // left believing it minted a one-hour code.
      parse(CreateInviteRequestSchema, request.body, 'request body');

      return await service.create(userId, projectIdOf(request));
    },
  );

  app.get('/invites/:code', async (request: FastifyRequest): Promise<InvitePreviewResponse> => {
    // The caller is authenticated — the guard saw to that — and is deliberately
    // not passed on. `preview` cannot take a user id, so this handler has
    // nowhere to leak one even if a later edit wanted to.
    return await service.preview(inviteCodeOf(request));
  });

  app.post('/invites/:code/join', async (request: FastifyRequest): Promise<JoinProjectResponse> => {
    const { id: userId } = request.requireUser();
    parse(JoinProjectRequestSchema, request.body, 'request body');

    return await service.join(userId, inviteCodeOf(request));
  });

  // Two identifiers of different kinds in one path, which
  // `ProjectInviteParamsSchema` keeps apart: after parsing, a project id in the
  // invite position is a `BAD_REQUEST` at the boundary rather than a delete
  // that quietly matches nothing and is reported as `NOT_FOUND`.
  //
  // No body is parsed. A `DELETE` carries none, and `RemoveAgentFromProject`
  // is registered the same way.
  app.delete(
    '/projects/:id/invites/:inviteId',
    async (request: FastifyRequest): Promise<RevokeInviteResponse> => {
      const { id: userId } = request.requireUser();
      const { id: projectId, inviteId } = parse(
        ProjectInviteParamsSchema,
        request.params,
        'request path',
      );

      return await service.revoke(userId, projectId, inviteId);
    },
  );
}
