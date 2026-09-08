/**
 * Projects: create one, list the caller's, read one, rename one, leave one, and
 * discover the agents inside one (plan §3 "Projects", PRD §21, D11).
 *
 * ## What this module is, and what it is not
 *
 * It is the business logic. `routes/projects.ts` parses a request, calls one
 * method here, and formats what comes back; every rule about who may do what
 * and what a project row is allowed to become lives in this file. Protocol
 * §7.3 requires that split, and it is what stops a second caller — a future
 * WebSocket frame, an admin command, a background job — from reimplementing
 * half a rule.
 *
 * It is **not** the place where access rules are decided. Those belong to
 * `services/authorization.ts` (T-106), which owns the whole permission matrix.
 * Every method below opens by calling one of its assertions and then uses the
 * row that assertion returns; none of them re-selects the project afterwards
 * and none of them writes an `if` about a role. Two reasons, and the second is
 * the load-bearing one:
 *
 * 1. The assertion has already read the project *through the membership row*,
 *    so a second read is a wasted round trip on the hot path.
 * 2. Re-reading is how the not-found/forbidden distinction gets undone. T-106
 *    answers a non-member with `NOT_FOUND` — deliberately, because project ids
 *    sit in URLs, shell history and the committed `.agentchat/config.json`
 *    (D12), so any other answer makes `GET /projects/:id` an oracle for which
 *    ids exist. A handler that selected the project first and checked
 *    membership second would leak exactly that, through timing if not through
 *    the body. Here membership *is* the read.
 *
 * ## Slugs
 *
 * A slug is the handle a human types and a repository commits, so it is
 * derived once, at creation, and never moves again — {@link ProjectService.rename}
 * changes the display name and leaves the slug alone. Deriving it is
 * {@link deriveProjectSlug}; the rules are there.
 *
 * A slug already in use is a {@link ErrorCode.CONFLICT}, never a silently
 * suffixed near-miss. `payments-2` is not what the caller asked for, and the
 * caller is about to write whatever they get into a file their whole team
 * clones: handing them a name they did not choose, for a project they may well
 * have meant to join rather than create, is worse than telling them.
 *
 * @module
 */

import {
  type CreateProjectRequest,
  type CreateProjectResponse,
  CreateProjectResponseSchema,
  ErrorCode,
  type GetProjectResponse,
  GetProjectResponseSchema,
  type LeaveProjectResponse,
  LeaveProjectResponseSchema,
  type ListProjectAgentsResponse,
  ListProjectAgentsResponseSchema,
  type ListProjectsResponse,
  ListProjectsResponseSchema,
  ProjectId,
  type ProjectName,
  ProtocolError,
  type UserId,
} from '@agentchat/protocol';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { agentProjects, agents } from '../db/schema/agents.js';
import { projectMembers, projects, users } from '../db/schema/identity.js';
import { sessions } from '../db/schema/messaging.js';
import type { AuthorizationService, ProjectAccess } from './authorization.js';

/**
 * The Drizzle surface this service uses.
 *
 * Narrowed the way `routes/auth.ts` narrows its own, so the service cannot
 * quietly acquire a dependency on the pool. `transaction` is here because two
 * of the operations below are multi-statement and must not be observable
 * half-done.
 *
 * `TSchema` is carried through rather than pinned to the empty schema, exactly
 * as `AppDatabase` in `app.ts` carries it, and for a reason that is not
 * cosmetic: `transaction`'s callback parameter mentions the schema, so the
 * method is invariant in it and a handle built with `drizzle(pool, { schema })`
 * does not fit a type pinned to `Record<string, never>`. Nothing here uses the
 * relational query API; the parameter exists only so that passing a real
 * application's handle type-checks.
 */
export type ProjectDatabase<TSchema extends Record<string, unknown> = Record<string, never>> = Pick<
  NodePgDatabase<TSchema>,
  'select' | 'insert' | 'delete' | 'update' | 'transaction'
>;

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** The unique constraint on `projects.slug`, from `0000_identity.sql`. */
const PROJECT_SLUG_CONSTRAINT = 'projects_slug_unique';

/** Longest slug the protocol's `ProjectSlugSchema` accepts, in characters. */
const MAX_PROJECT_SLUG_LENGTH = 32;

/**
 * The session status that counts as presence.
 *
 * Plan §2 defines online as "the agent has at least one `active` session in
 * this project" — `stale` and `ended` are both absences, and a stale session is
 * an absence the listener has not noticed yet.
 */
const ACTIVE_SESSION_STATUS = 'active';

/**
 * The slug grammar the **database** enforces:
 * `^[a-z0-9]+(-[a-z0-9]+)*$`, from the `projects_slug_format` check.
 *
 * This is deliberately stricter than the protocol's `ProjectSlugSchema`
 * (`^[a-z0-9][a-z0-9-]{0,31}$`), and the difference is real rather than
 * cosmetic: `a--b` and `payments-` satisfy the protocol pattern and violate the
 * check constraint. Without this, a caller who supplied one of those would
 * receive a 500 from a constraint violation — a server error for a request the
 * server can see is malformed — instead of a `BAD_REQUEST` naming the rule.
 *
 * The two patterns disagreeing is a defect in the contract, not in this file;
 * `packages/protocol` belongs to another task and tightening it there is the
 * real fix. Until then this is the narrower of the two, checked here, where the
 * caller can still be told something useful.
 */
const STORABLE_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Strips the combining marks NFKD decomposition leaves behind. */
const COMBINING_MARKS = /\p{M}+/gu;

/** Any run of characters a slug may not contain. */
const NON_SLUG_RUN = /[^a-z0-9]+/g;

/** Leading hyphens, which a slug may not start with. */
const LEADING_HYPHENS = /^-+/;

/** Trailing hyphens, which a slug may not end with. */
const TRAILING_HYPHENS = /-+$/;

/**
 * Derives a URL-safe slug from a project's display name.
 *
 * The rules, in order:
 *
 * 1. **Decompose and drop the accents.** `Café Solo` becomes `cafe-solo`
 *    rather than `caf-solo`. NFKD splits `é` into `e` plus a combining acute,
 *    and dropping the mark keeps the letter — the alternative loses it, and a
 *    user who names a project in their own language should not get a slug with
 *    holes in it.
 * 2. **Lowercase**, because the grammar is lowercase and because a slug that
 *    differed only in case from another would point two clones of one
 *    repository at what looks like the same project.
 * 3. **Every run of anything else becomes one hyphen.** A run, not a character:
 *    `Payments — Platform` is `payments-platform`, not `payments----platform`.
 *    Consecutive hyphens are what the database's own check rejects.
 * 4. **Trim hyphens from both ends**, then truncate to
 *    {@link MAX_PROJECT_SLUG_LENGTH}, then trim the end again — truncation can
 *    land mid-hyphen and would otherwise produce a trailing one.
 *
 * The result satisfies both {@link STORABLE_SLUG_PATTERN} and the protocol's
 * `ProjectSlugSchema` by construction, which is asserted rather than assumed in
 * `projects.test.ts`.
 *
 * @param name - The display name the caller chose.
 * @returns The slug, or `undefined` when the name contains nothing a slug may
 *   be made of — `日本語`, `!!!`, `   `. That is not a failure of this function
 *   and it is not something to paper over with a random string: the caller is
 *   asked for an explicit slug, because the one thing worse than no handle is a
 *   handle nobody can guess or remember.
 */
export function deriveProjectSlug(name: string): string | undefined {
  const unaccented = name.normalize('NFKD').replaceAll(COMBINING_MARKS, '');
  const hyphenated = unaccented.toLowerCase().replaceAll(NON_SLUG_RUN, '-');
  const trimmed = hyphenated.replace(LEADING_HYPHENS, '').replace(TRAILING_HYPHENS, '');
  const bounded = trimmed.slice(0, MAX_PROJECT_SLUG_LENGTH).replace(TRAILING_HYPHENS, '');

  return bounded === '' ? undefined : bounded;
}

/**
 * Chooses the slug a new project is created with.
 *
 * An explicit slug is used verbatim — never normalised, never corrected. The
 * caller is about to commit it (D12), so a slug that comes back different from
 * the one they sent is a silent disagreement between their file and the server.
 *
 * @param request - The create request.
 * @returns The slug to store.
 * @throws {ProtocolError} `BAD_REQUEST` when no slug can be derived from the
 *   name, or when the slug given cannot be stored. Both messages name the
 *   remedy rather than restating the grammar.
 */
export function chooseProjectSlug(request: CreateProjectRequest): string {
  const slug = request.slug ?? deriveProjectSlug(request.name);

  if (slug === undefined) {
    throw new ProtocolError(
      ErrorCode.BAD_REQUEST,
      'No URL-safe slug could be derived from that name. ' +
        'Choose one yourself by sending "slug" alongside "name".',
    );
  }

  if (!STORABLE_SLUG_PATTERN.test(slug)) {
    throw new ProtocolError(
      ErrorCode.BAD_REQUEST,
      `"${slug}" is not a usable project slug. Use lowercase letters and digits ` +
        'joined by single hyphens, starting and ending with a letter or digit.',
    );
  }

  return slug;
}

/**
 * Whether a thrown value is the unique violation on `projects.slug`.
 *
 * Walks the cause chain because Drizzle wraps the driver's error, and matches
 * the constraint name so that a future unique constraint on this table is not
 * mistaken for this one and reported as a slug collision.
 *
 * @param error - Whatever was thrown.
 * @returns `true` when the slug was already taken.
 */
function isSlugCollision(error: unknown): boolean {
  let current: unknown = error;

  while (typeof current === 'object' && current !== null) {
    if ('code' in current) {
      const { code, constraint } = current as { code: unknown; constraint?: unknown };
      if (code === UNIQUE_VIOLATION) {
        return typeof constraint === 'string' && constraint.includes(PROJECT_SLUG_CONSTRAINT);
      }
    }
    current = 'cause' in current ? (current as { cause: unknown }).cause : undefined;
  }

  return false;
}

/** A `projects` row joined to the caller's `project_members` row. */
interface MembershipRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly role: string;
}

/** The columns behind every {@link MembershipRow}. */
const MEMBERSHIP_COLUMNS = {
  id: projects.id,
  slug: projects.slug,
  name: projects.name,
  createdBy: projects.createdBy,
  createdAt: projects.createdAt,
  role: projectMembers.role,
} as const;

/**
 * Turns a project and a role into the wire shape.
 *
 * Parsed outbound through the contract's own schema, like every other value
 * this server sends: a column that drifts from `ProjectMembershipSchema` fails
 * here, in this process, rather than at a client that cannot fix it.
 */
function toMembership(row: MembershipRow): CreateProjectResponse {
  return CreateProjectResponseSchema.parse({
    id: row.id,
    slug: row.slug,
    name: row.name,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    role: row.role,
  });
}

/** The same, for the value an authorization assertion hands back. */
function membershipOf(access: ProjectAccess): GetProjectResponse {
  return GetProjectResponseSchema.parse({
    id: access.project.id,
    slug: access.project.slug,
    name: access.project.name,
    createdBy: access.project.createdBy,
    createdAt: access.project.createdAt.toISOString(),
    role: access.role,
  });
}

/** Collaborators for {@link createProjectService}. */
export interface ProjectServiceOptions<
  TSchema extends Record<string, unknown> = Record<string, never>,
> {
  /** Drizzle handle. See {@link ProjectDatabase}. */
  readonly db: ProjectDatabase<TSchema>;

  /**
   * The permission matrix.
   *
   * Injected rather than constructed here so that there is exactly one of them
   * per application and a test can count the statements it issues.
   */
  readonly authorization: AuthorizationService;
}

/** Projects, with no HTTP in it. */
export interface ProjectService {
  /**
   * Lists the projects the caller belongs to, each with their role in it.
   *
   * No assertion is called because there is no resource to assert about:
   * membership is the filter, expressed in the `from` clause rather than in a
   * predicate applied afterwards, so the query is structurally unable to
   * return a project the caller is not in.
   *
   * @param userId - The authenticated caller.
   * @returns Every membership, oldest project first.
   */
  list(userId: UserId): Promise<ListProjectsResponse>;

  /**
   * Creates a project and makes the caller its owner.
   *
   * Both rows are written in one transaction. A project with no members is
   * unreachable by anybody — including its creator — and unrenameable and
   * undeletable forever, so the two statements are one operation or neither.
   *
   * @param userId - The authenticated caller, who becomes the owner.
   * @param request - Name, and optionally the slug.
   * @returns The project, with `role: 'owner'`.
   * @throws {ProtocolError} `BAD_REQUEST` when no slug can be derived or the
   *   one given cannot be stored; `CONFLICT` when the slug is taken.
   */
  create(userId: UserId, request: CreateProjectRequest): Promise<CreateProjectResponse>;

  /**
   * Reads one project.
   *
   * @param userId - The authenticated caller.
   * @param projectId - The project.
   * @returns The project, with the caller's role.
   * @throws {ProtocolError} `NOT_FOUND` when the project does not exist or the
   *   caller is not a member. One answer, on purpose.
   */
  get(userId: UserId, projectId: ProjectId): Promise<GetProjectResponse>;

  /**
   * Renames a project.
   *
   * Owners only (D11), and the display name only: the slug is what a
   * repository committed and what a teammate typed, and moving it would break
   * both to make a cosmetic change.
   *
   * There is no HTTP route for this yet — plan §3 lists no `PATCH
   * /projects/:id` and `packages/protocol` therefore defines no schema for one
   * — so this is the rule, written and enforced and tested, waiting for the
   * endpoint. See the pull request for T-107.
   *
   * @param userId - The authenticated caller.
   * @param projectId - The project.
   * @param name - The new display name.
   * @returns The project as it now stands, with the caller's role.
   * @throws {ProtocolError} `NOT_FOUND` when the caller is not a member;
   *   `FORBIDDEN` when they are a member but not an owner.
   */
  rename(userId: UserId, projectId: ProjectId, name: ProjectName): Promise<GetProjectResponse>;

  /**
   * Removes the caller from a project.
   *
   * @param userId - The authenticated caller.
   * @param projectId - The project.
   * @returns The empty body.
   * @throws {ProtocolError} `NOT_FOUND` when the caller is not a member;
   *   `CONFLICT`, explaining why, when they are its only owner.
   */
  leave(userId: UserId, projectId: ProjectId): Promise<LeaveProjectResponse>;

  /**
   * Lists the agents in a project: who else is here, and are they listening
   * (PRD §21).
   *
   * @param userId - The authenticated caller.
   * @param projectId - The project.
   * @returns Every live agent participating, with its owner and its presence.
   * @throws {ProtocolError} `NOT_FOUND` when the caller is not a member.
   */
  listAgents(userId: UserId, projectId: ProjectId): Promise<ListProjectAgentsResponse>;
}

/**
 * Builds the project service.
 *
 * @param options - See {@link ProjectServiceOptions}.
 * @returns The service. Holds no state of its own.
 */
export function createProjectService<
  TSchema extends Record<string, unknown> = Record<string, never>,
>(options: ProjectServiceOptions<TSchema>): ProjectService {
  const { db, authorization } = options;

  return {
    async list(userId: UserId): Promise<ListProjectsResponse> {
      // Driven from `project_members`, not from `projects` with a filter, for
      // the reason `selectProjectAccess` gives in the authorization service:
      // the membership is in the shape of the query rather than in a condition
      // somebody could later move or drop.
      const rows = await db
        .select(MEMBERSHIP_COLUMNS)
        .from(projectMembers)
        .innerJoin(projects, eq(projects.id, projectMembers.projectId))
        .where(eq(projectMembers.userId, userId))
        // Ordered by slug because it is unique, so the order is total and
        // stable across calls — a list whose order changes between two
        // identical requests is one no client can render without flicker.
        .orderBy(projects.slug);

      return ListProjectsResponseSchema.parse({ items: rows.map(toMembership) });
    },

    async create(userId: UserId, request: CreateProjectRequest): Promise<CreateProjectResponse> {
      const slug = chooseProjectSlug(request);
      const id = ProjectId.generate();

      try {
        const row = await db.transaction(async (tx) => {
          const inserted = await tx
            .insert(projects)
            .values({ id, slug, name: request.name, createdBy: userId })
            .returning();

          const project = inserted[0];
          if (project === undefined) {
            throw new ProtocolError(ErrorCode.INTERNAL, 'The project insert returned no row.');
          }

          // The creator is the owner. Not a default a later statement could
          // fail to apply, and not something the caller may ask for: D11 gives
          // owners the rename and the delete, and a project whose creator is
          // only a member is one nobody can administer.
          await tx.insert(projectMembers).values({ projectId: id, userId, role: 'owner' });

          return project;
        });

        return toMembership({ ...row, role: 'owner' });
      } catch (cause: unknown) {
        if (isSlugCollision(cause)) {
          // Not suffixed into a near-miss. See the module note: the caller may
          // well have meant the project that already holds this slug, and
          // handing them a second one called `payments-2` would hide that.
          throw new ProtocolError(
            ErrorCode.CONFLICT,
            `The slug "${slug}" is already in use. Choose another, or join the ` +
              'existing project with an invite from one of its members.',
            { cause },
          );
        }
        throw cause;
      }
    },

    async get(userId: UserId, projectId: ProjectId): Promise<GetProjectResponse> {
      // One statement, and it is the authorization check. Nothing below reads
      // the project again; see the module note on why a second read is how the
      // not-found answer gets undone.
      return membershipOf(await authorization.assertProjectMember({ userId, projectId }));
    },

    async rename(
      userId: UserId,
      projectId: ProjectId,
      name: ProjectName,
    ): Promise<GetProjectResponse> {
      const access = await authorization.assertProjectOwner({ userId, projectId });

      const updated = await db
        .update(projects)
        .set({ name })
        .where(eq(projects.id, projectId))
        .returning();

      const row = updated[0];
      if (row === undefined) {
        // The assertion just read this row inside the same request. Its
        // disappearance is a concurrent delete, not a caller error.
        throw new ProtocolError(ErrorCode.NOT_FOUND, 'That project no longer exists.');
      }

      return toMembership({ ...row, role: access.role });
    },

    async leave(userId: UserId, projectId: ProjectId): Promise<LeaveProjectResponse> {
      // Throws `CONFLICT` for the last owner, with the message T-106 wrote:
      // "You are the only owner of this project. Make another member an owner
      // before you leave." It says why, and what to do, rather than only no.
      await authorization.assertCanLeaveProject({ userId, projectId });

      await db.transaction(async (tx) => {
        // The caller's agents stop participating at the same instant the
        // caller stops being a member.
        //
        // This is not in the plan and it is not cosmetic. `agent_projects` is
        // what makes an agent addressable inside a project, and the recipient
        // rule (`assertAgentInProject`) asks whether the *agent* participates,
        // not whether its owner is still around — correctly, since a recipient
        // is usually somebody else's agent. Leaving the rows behind would
        // therefore keep `@alice/backend` addressable, and deliverable to, in
        // a project Alice can no longer see or send in. That is a leak, and it
        // is one nothing downstream could catch.
        //
        // Scoped to this user's own agents: nobody else's participation is
        // touched, and the agents themselves, their names and their history in
        // every other project are untouched too.
        const owned = tx.select({ id: agents.id }).from(agents).where(eq(agents.userId, userId));

        await tx
          .delete(agentProjects)
          .where(
            and(eq(agentProjects.projectId, projectId), inArray(agentProjects.agentId, owned)),
          );

        await tx
          .delete(projectMembers)
          .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
      });

      return LeaveProjectResponseSchema.parse({});
    },

    async listAgents(userId: UserId, projectId: ProjectId): Promise<ListProjectAgentsResponse> {
      await authorization.assertProjectMember({ userId, projectId });

      const rows = await db
        .select({
          id: agents.id,
          userId: agents.userId,
          name: agents.name,
          createdAt: agents.createdAt,
          updatedAt: agents.updatedAt,
          ownerId: users.id,
          ownerUsername: users.username,
          ownerDisplayName: users.displayName,
          // `count` of a left-joined column counts matched rows and yields 0
          // when there were none, which is exactly presence. Cast to `int`
          // because `count(*)` is a `bigint` and the driver hands those over as
          // strings, which `CountSchema` would then reject at the boundary.
          sessions: sql<number>`count(${sessions.id})::int`,
        })
        .from(agentProjects)
        .innerJoin(
          agents,
          // The tombstone is applied in the join, not in a `where` a later
          // edit could reorder: a soft-deleted agent is absent from discovery
          // (D13), and that is not negotiable per row.
          and(eq(agents.id, agentProjects.agentId), sql`${agents.deletedAt} is null`),
        )
        .innerJoin(users, eq(users.id, agents.userId))
        // Only agents whose owner is still a member. Belt and braces beside the
        // cleanup in `leave` above: discovery answers "who else is in this
        // project", and somebody who has left is not.
        .innerJoin(
          projectMembers,
          and(
            eq(projectMembers.projectId, agentProjects.projectId),
            eq(projectMembers.userId, agents.userId),
          ),
        )
        .leftJoin(
          sessions,
          and(
            eq(sessions.agentId, agents.id),
            eq(sessions.projectId, agentProjects.projectId),
            eq(sessions.status, ACTIVE_SESSION_STATUS),
          ),
        )
        .where(eq(agentProjects.projectId, projectId))
        .groupBy(agents.id, users.id)
        // Total and stable: a user has at most one live agent of a given name,
        // and usernames are unique.
        .orderBy(users.username, agents.name);

      return ListProjectAgentsResponseSchema.parse({
        items: rows.map((row) => ({
          agent: {
            id: row.id,
            userId: row.userId,
            name: row.name,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          },
          owner: {
            id: row.ownerId,
            username: row.ownerUsername,
            displayName: row.ownerDisplayName,
          },
          // Derived from the count rather than stored, per plan §2, so the two
          // cannot disagree: `online === (sessions > 0)` holds by construction.
          online: row.sessions > 0,
          sessions: row.sessions,
        })),
      });
    },
  };
}
