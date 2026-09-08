/**
 * Invites: mint a code, preview what it opens, redeem it (plan §3 "Projects",
 * D11, PRD §26–§27).
 *
 * ## An invite code is a bearer credential
 *
 * Whoever holds one can become a member of the project it names. Nothing else
 * is asked for and nothing else is checked, so every decision in this file is
 * really a decision about a credential rather than about a row.
 *
 * ### Where the entropy comes from
 *
 * {@link generateInviteCode} draws from `node:crypto`. Never `Math.random`,
 * which is seeded from the process and is predictable to anybody who can watch
 * a few outputs; a code that can be predicted is a project anybody can join.
 * The alphabet has 32 symbols, which divides 256 exactly, so a random byte
 * reduced modulo 32 is uniform — there is no modulo bias to correct and no
 * rejection loop to get wrong. `invites.test.ts` asserts that divisibility so
 * that changing the alphabet cannot silently introduce a skew.
 *
 * ### What the database stores, and why it is not a digest
 *
 * `refresh_tokens` keeps only a SHA-256 of the token it issued, so a copy of
 * that table cannot be replayed. `project_invites.code` holds the code itself.
 * That asymmetry is deliberate:
 *
 * 1. **The column is not this task's to change.** `db/schema/identity.ts`
 *    documents `code` as "the human-typed code, e.g. `ANET-7K4M-Q2P9`", and the
 *    shipped `project_invites_code_canonical` check requires
 *    `code = upper(code)` precisely so a typed code can be upper-cased and
 *    matched exactly once. A digest would satisfy the constraint's letter — a
 *    hex digest upper-cases to 64 legal characters — while making the column
 *    mean something its own documentation denies, and the migration that
 *    renamed it belongs to whoever owns that file.
 * 2. **The two credentials are not comparable in blast radius.** A refresh
 *    token authenticates *as a user*: every project they are in, every agent
 *    they own, renewable for ninety days. An invite grants the lowest privilege
 *    the product has — membership of one project — for seven days, revocably,
 *    and each redemption leaves a `project_members` row with a timestamp on it.
 * 3. **Against the attacker who has this table, the digest buys little.** They
 *    already hold the projects, the memberships and the messages, and can
 *    `insert` themselves a membership row directly rather than bothering to
 *    redeem a code. The narrow case a digest would defend is a stale read-only
 *    dump used against a live server within the seven days an invite lives.
 *
 * That last case is real, and if the column were this task's to migrate the
 * digest would be worth taking: previewing by digest is the same single indexed
 * lookup, and the only functional loss is that a code can never be shown again
 * after it is minted — which nothing in M1 asks for, since
 * {@link CreateInviteResponseSchema} returns the code once and no endpoint
 * lists invites. It is flagged in the pull request rather than done here.
 *
 * ### Every bad code fails the same way
 *
 * Unknown, expired, revoked and exhausted all raise {@link ErrorCode.INVITE_INVALID}
 * with {@link INVITE_INVALID_MESSAGE} — one frozen string, produced by
 * {@link inviteInvalid}, which takes no argument at all. It cannot be passed a
 * reason, so no future edit can leak one. This matters more here than in most
 * places: the preview endpoint answers anybody, so a distinguishable "expired"
 * would turn it into an oracle that confirms a guessed code was once real, and
 * a guessed code that was once real is worth guessing again after a revocation.
 *
 * ## What preview may disclose
 *
 * {@link InviteService.preview} takes no caller. That is the load-bearing part
 * of its signature: a method that is not told who is asking cannot branch on
 * whether they are a member, cannot widen its answer for one, and cannot leak
 * the membership it was never given. What it returns is fixed by
 * {@link InvitePreviewResponseSchema} — the project's identity and the
 * inviter's summary — and is parsed outbound through that schema, so a field
 * added here that the contract does not name fails in this process rather than
 * at a stranger's terminal. No member list, no agents, no counts.
 *
 * The route above it is still authenticated. See `routes/invites.ts`.
 *
 * ## Authorization
 *
 * Creating an invite asks `services/authorization.ts` for
 * `assertProjectMember` and nothing else (D11: any member, not only owners).
 * Joining asks it nothing, because it is the operation that *creates* the
 * membership every other rule is derived from; the code is the credential, and
 * this module is where that is written down.
 *
 * @module
 */

import { randomBytes } from 'node:crypto';

import {
  type CreateInviteResponse,
  CreateInviteResponseSchema,
  ErrorCode,
  type InviteCode,
  InviteId,
  type InvitePreviewResponse,
  InvitePreviewResponseSchema,
  type JoinProjectResponse,
  JoinProjectResponseSchema,
  type ProjectId,
  ProtocolError,
  type UserId,
} from '@agentchat/protocol';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { projectInvites, projectMembers, projects, users } from '../db/schema/identity.js';
import type { AuthorizationService } from './authorization.js';

/**
 * The Drizzle surface this service uses.
 *
 * Narrowed exactly as `ProjectDatabase` is, and carrying `TSchema` for the same
 * reason: `transaction`'s callback mentions the schema, so a handle built with
 * one does not fit a type pinned to the empty schema. Nothing here reads it.
 */
export type InviteDatabase<TSchema extends Record<string, unknown> = Record<string, never>> = Pick<
  NodePgDatabase<TSchema>,
  'select' | 'insert' | 'update' | 'transaction'
>;

/**
 * The symbols an invite code is drawn from: Crockford's base32 alphabet.
 *
 * `I`, `L`, `O` and `U` are absent. The first three because a code is read off
 * a screen and typed into a terminal, often from a chat message or a photograph
 * of one, and `I`/`1`, `O`/`0` are the pairs people get wrong; `U` because
 * excluding it is what stops a random draw from spelling something the sender
 * has to apologise for.
 *
 * Exactly 32 symbols, and 256 is a multiple of 32. See the module note.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The constant first group, so a code is recognisable as one.
 *
 * Plan §2 gives `ANET-7K4M-Q2P9` as the example, and a fixed leading group is
 * what makes a string pasted into a chat window self-identifying: a reader who
 * has never used AgentChat can tell that it is an invite and not a coupon or an
 * order reference. It carries no entropy and is not a secret.
 */
const CODE_PREFIX = 'ANET';

/** Random groups after the prefix. */
const CODE_GROUPS = 2;

/** Symbols per random group. */
const CODE_GROUP_LENGTH = 4;

/**
 * Random symbols in a code: eight, so 40 bits.
 *
 * That is the plan's documented shape rather than a security maximum, and it is
 * adequate for what this credential is. Guessing is blind — every wrong guess
 * gets the same answer as every other, so there is nothing to hill-climb — and
 * a trillion tries at ten thousand requests a second is years of traffic
 * against a code that stops working in a week. Widening it is one constant:
 * `project_invites.code` accepts up to 64 characters, and the protocol's
 * `InviteCodeSchema` deliberately does not pin the grouping.
 */
const CODE_RANDOM_SYMBOLS = CODE_GROUPS * CODE_GROUP_LENGTH;

/** Default life of an invite: seven days (plan §3). */
const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many times a collision is retried before giving up.
 *
 * A collision needs two draws to agree in 40 bits, so this is not a code path
 * anybody will see; it exists because the alternative to retrying is answering
 * a valid request with a 500 because of a coincidence.
 */
const MAX_CODE_ATTEMPTS = 5;

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** The unique constraint on `project_invites.code`, from `0000_identity.sql`. */
const INVITE_CODE_CONSTRAINT = 'project_invites_code_unique';

/**
 * The one thing a caller is ever told about a code that did not work.
 *
 * Frozen, and the sole message {@link inviteInvalid} can produce. See the
 * module note on why unknown, expired, revoked and exhausted are one answer.
 */
export const INVITE_INVALID_MESSAGE =
  'That invite code is not valid. It may have expired or been revoked. ' +
  'Ask whoever invited you for a fresh one.';

/**
 * The refusal every bad code gets.
 *
 * Takes no arguments on purpose: there is no parameter through which a reason,
 * a cause or an identifier could be attached, so the answers to an unknown code
 * and to a revoked one are identical by construction rather than by review.
 *
 * @returns The error to throw.
 */
function inviteInvalid(): ProtocolError {
  return new ProtocolError(ErrorCode.INVITE_INVALID, INVITE_INVALID_MESSAGE);
}

/**
 * Draws one invite code from a cryptographically secure source.
 *
 * `ANET-7K4M-Q2P9`: the constant {@link CODE_PREFIX}, then {@link CODE_GROUPS}
 * groups of {@link CODE_GROUP_LENGTH} symbols from {@link CODE_ALPHABET},
 * hyphen-separated. Upper case, which is what
 * `project_invites_code_canonical` requires so that a typed code can be
 * upper-cased and matched exactly once.
 *
 * @returns A fresh code. Not checked for uniqueness here; the unique index is
 *   what decides that, and {@link createInviteService} retries a collision.
 */
export function generateInviteCode(): InviteCode {
  // One byte per symbol, reduced modulo the alphabet. Unbiased because 32
  // divides 256; see the module note.
  const bytes = randomBytes(CODE_RANDOM_SYMBOLS);
  const symbols = [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length] ?? '');

  const groups: string[] = [CODE_PREFIX];
  for (let group = 0; group < CODE_GROUPS; group += 1) {
    groups.push(symbols.slice(group * CODE_GROUP_LENGTH, (group + 1) * CODE_GROUP_LENGTH).join(''));
  }

  return groups.join('-');
}

/**
 * The canonical spelling of a code a human typed.
 *
 * Upper case and nothing else. `String.prototype.toUpperCase` is
 * locale-independent — `toLocaleUpperCase` is not, and in a Turkish locale it
 * maps `i` to `İ`, which would make a code work on one machine and not on
 * another. The alphabet has no `i` in it, and this still does not rely on that.
 *
 * A code that normalises to something no row holds is simply not found, which
 * is the same answer as every other kind of bad code.
 *
 * @param code - Whatever the caller typed, already shape-validated by the
 *   route against `InviteCodeSchema`.
 * @returns The spelling to look up.
 */
export function canonicalInviteCode(code: string): string {
  return code.toUpperCase();
}

/**
 * Whether a thrown value is the unique violation on `project_invites.code`.
 *
 * Walks the cause chain because Drizzle wraps the driver's error, and matches
 * the constraint by name so a future unique constraint on this table is not
 * mistaken for a code collision and retried pointlessly.
 *
 * @param error - Whatever was thrown.
 * @returns `true` when the code was already taken.
 */
function isCodeCollision(error: unknown): boolean {
  let current: unknown = error;

  while (typeof current === 'object' && current !== null) {
    if ('code' in current) {
      const { code, constraint } = current as { code: unknown; constraint?: unknown };
      if (code === UNIQUE_VIOLATION) {
        return typeof constraint === 'string' && constraint.includes(INVITE_CODE_CONSTRAINT);
      }
    }
    current = 'cause' in current ? (current as { cause: unknown }).cause : undefined;
  }

  return false;
}

/** The invite, its project and its inviter, as one row. */
interface LiveInviteRow {
  readonly inviteId: string;
  readonly projectId: string;
  readonly projectSlug: string;
  readonly projectName: string;
  readonly projectCreatedBy: string;
  readonly projectCreatedAt: Date;
  readonly inviterId: string;
  readonly inviterUsername: string;
  readonly inviterDisplayName: string;
}

/** The columns behind a {@link LiveInviteRow}. */
const LIVE_INVITE_COLUMNS = {
  inviteId: projectInvites.id,
  projectId: projects.id,
  projectSlug: projects.slug,
  projectName: projects.name,
  projectCreatedBy: projects.createdBy,
  projectCreatedAt: projects.createdAt,
  inviterId: users.id,
  inviterUsername: users.username,
  inviterDisplayName: users.displayName,
} as const;

/** Collaborators for {@link createInviteService}. */
export interface InviteServiceOptions<
  TSchema extends Record<string, unknown> = Record<string, never>,
> {
  /** Drizzle handle. See {@link InviteDatabase}. */
  readonly db: InviteDatabase<TSchema>;

  /**
   * The permission matrix.
   *
   * Injected rather than constructed so one application has exactly one of
   * them, as `services/projects.ts` does.
   */
  readonly authorization: AuthorizationService;

  /**
   * The clock, for the seven-day default and the expiry comparison.
   *
   * Overridable so a test can mint an invite and watch it expire without
   * sleeping for a week. Defaults to the wall clock.
   */
  readonly now?: (() => Date) | undefined;
}

/** Invites, with no HTTP in it. */
export interface InviteService {
  /**
   * Mints a code for a project.
   *
   * Any member may (D11). The expiry is seven days from now and the use limit
   * is unlimited-until-expiry, both server policy rather than caller input:
   * `CreateInviteRequestSchema` has no fields, so there is nothing to widen
   * these with and no way for a client to mint a code that never dies.
   *
   * @param userId - The authenticated caller, recorded as `createdBy` and shown
   *   as `invitedBy` in every preview of this code.
   * @param projectId - The project the code opens.
   * @returns The code and when it stops working. The code is returned here and
   *   nowhere else; nothing lists invites.
   * @throws {ProtocolError} `NOT_FOUND` when the caller is not a member of the
   *   project — the same answer `GET /projects/:id` gives, so this endpoint
   *   cannot be used to test whether a project id exists.
   */
  create(userId: UserId, projectId: ProjectId): Promise<CreateInviteResponse>;

  /**
   * Answers what a code would join you to, without joining.
   *
   * Deliberately takes no caller. See the module note: a method that is not
   * told who is asking cannot disclose more to a member than to a stranger.
   *
   * @param code - The code as typed; canonicalised here.
   * @returns The project and who invited you, and nothing else.
   * @throws {ProtocolError} `INVITE_INVALID` for a code that is unknown,
   *   expired, revoked or used up — one answer, see {@link inviteInvalid}.
   */
  preview(code: InviteCode): Promise<InvitePreviewResponse>;

  /**
   * Redeems a code, making the caller a member.
   *
   * Idempotent: a caller who is already in the project is returned their
   * existing membership, with the role they already have, and no use is
   * consumed. They asked to be a member and they are one — a `CONFLICT` would
   * make every client implement a "unless I am already in it" branch, and the
   * second `agentchat project join` after a lost terminal is not an error.
   *
   * Joining never confers ownership; a redeemed code always yields `member`.
   *
   * @param userId - The authenticated caller, who becomes a member.
   * @param code - The code as typed.
   * @returns The project just joined, with the caller's role in it.
   * @throws {ProtocolError} `INVITE_INVALID` for a bad code, whatever kind of
   *   bad it is. Checked before membership, so a revoked code cannot be used to
   *   confirm that its holder is already inside.
   */
  join(userId: UserId, code: InviteCode): Promise<JoinProjectResponse>;
}

/**
 * Builds the invite service.
 *
 * @param options - See {@link InviteServiceOptions}.
 * @returns The service. Holds no state of its own.
 */
export function createInviteService<
  TSchema extends Record<string, unknown> = Record<string, never>,
>(options: InviteServiceOptions<TSchema>): InviteService {
  const { db, authorization } = options;
  const now = options.now ?? ((): Date => new Date());

  /**
   * Finds a redeemable invite, or refuses.
   *
   * Liveness is expressed in the `where` clause rather than tested afterwards,
   * so an expired or revoked invite is not a row this process ever holds: there
   * is no value in scope for a later edit to answer a question with. The three
   * conditions are the three ways an invite stops working, and `max_uses is
   * null` is what "unlimited until expiry" means.
   *
   * @param runner - The database or the transaction in flight.
   * @param code - The code as typed.
   * @returns The invite with its project and inviter.
   * @throws {ProtocolError} `INVITE_INVALID`, always the same one.
   */
  async function requireLiveInvite(
    runner: Pick<InviteDatabase<TSchema>, 'select'>,
    code: InviteCode,
  ): Promise<LiveInviteRow> {
    const rows = await runner
      .select(LIVE_INVITE_COLUMNS)
      .from(projectInvites)
      .innerJoin(projects, eq(projects.id, projectInvites.projectId))
      .innerJoin(users, eq(users.id, projectInvites.createdBy))
      .where(
        and(
          eq(projectInvites.code, canonicalInviteCode(code)),
          isNull(projectInvites.revokedAt),
          sql`${projectInvites.expiresAt} > ${now()}`,
          or(
            isNull(projectInvites.maxUses),
            sql`${projectInvites.uses} < ${projectInvites.maxUses}`,
          ),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      throw inviteInvalid();
    }

    return row;
  }

  /**
   * The wire shape of a project the caller has just been shown or joined.
   *
   * @param row - The invite row, which carries the project columns.
   * @returns The project fields both response schemas share.
   */
  function projectOf(row: LiveInviteRow): {
    id: string;
    slug: string;
    name: string;
    createdBy: string;
    createdAt: string;
  } {
    return {
      id: row.projectId,
      slug: row.projectSlug,
      name: row.projectName,
      createdBy: row.projectCreatedBy,
      createdAt: row.projectCreatedAt.toISOString(),
    };
  }

  return {
    async create(userId: UserId, projectId: ProjectId): Promise<CreateInviteResponse> {
      // Any member (D11). The assertion answers a non-member `NOT_FOUND`, which
      // is what keeps this endpoint from being a way to discover project ids.
      await authorization.assertProjectMember({ userId, projectId });

      const expiresAt = new Date(now().getTime() + DEFAULT_EXPIRY_MS);

      for (let attempt = 1; ; attempt += 1) {
        const code = generateInviteCode();

        try {
          await db.insert(projectInvites).values({
            id: InviteId.generate(),
            projectId,
            code,
            createdBy: userId,
            expiresAt,
            // Explicitly null: unlimited uses until expiry (plan §3). Written
            // rather than left to the column default so that the policy is
            // visible at the one place that sets it.
            maxUses: null,
          });

          return CreateInviteResponseSchema.parse({
            code,
            expiresAt: expiresAt.toISOString(),
          });
        } catch (cause: unknown) {
          if (!isCodeCollision(cause) || attempt >= MAX_CODE_ATTEMPTS) {
            throw cause;
          }
          // Draw again. Nothing about the failed code is reported: it is a
          // coincidence, not something the caller did.
        }
      }
    },

    async preview(code: InviteCode): Promise<InvitePreviewResponse> {
      const invite = await requireLiveInvite(db, code);

      // Parsed outbound through the contract's own schema, so a field this
      // module adds and the contract does not name fails here rather than at a
      // stranger holding a code.
      return InvitePreviewResponseSchema.parse({
        project: projectOf(invite),
        invitedBy: {
          id: invite.inviterId,
          username: invite.inviterUsername,
          displayName: invite.inviterDisplayName,
        },
      });
    },

    async join(userId: UserId, code: InviteCode): Promise<JoinProjectResponse> {
      const membership = await db.transaction(async (tx) => {
        // Validated first, and inside the transaction, so that a code revoked
        // between the check and the write cannot still be redeemed, and so that
        // an existing member learns nothing from a bad code.
        const invite = await requireLiveInvite(tx, code);

        // `do nothing` rather than a read-then-write: two joins racing each
        // other both attempt the insert, and the loser is told it conflicted
        // instead of both believing they were first. An empty result therefore
        // means "already a member", which is the idempotent path.
        const inserted = await tx
          .insert(projectMembers)
          .values({ projectId: invite.projectId, userId, role: 'member' })
          .onConflictDoNothing()
          .returning({ role: projectMembers.role });

        if (inserted[0] === undefined) {
          const existing = await tx
            .select({ role: projectMembers.role })
            .from(projectMembers)
            .where(
              and(
                eq(projectMembers.projectId, invite.projectId),
                eq(projectMembers.userId, userId),
              ),
            )
            .limit(1);

          const row = existing[0];
          if (row === undefined) {
            // The insert conflicted and the row is gone: somebody left the
            // project between the two statements. Not the caller's error and
            // not a state to guess at.
            throw new ProtocolError(
              ErrorCode.CONFLICT,
              'Your membership changed while you were joining. Try again.',
            );
          }

          // Already in. No use is consumed: re-running `agentchat project join`
          // must not eat somebody else's seat.
          return { project: invite, role: row.role };
        }

        // Counted only for a redemption that actually added a member, and
        // counted conditionally so that a `max_uses` invite cannot be
        // over-redeemed by two requests that both read the same count. Nothing
        // sets `max_uses` in M1, so the guard is dormant — it is here because
        // the column exists and the alternative is discovering later that the
        // increment was never atomic. A failure here rolls the membership back
        // with it, which is the whole reason both statements are one
        // transaction.
        const consumed = await tx
          .update(projectInvites)
          .set({ uses: sql`${projectInvites.uses} + 1` })
          .where(
            and(
              eq(projectInvites.id, invite.inviteId),
              or(
                isNull(projectInvites.maxUses),
                sql`${projectInvites.uses} < ${projectInvites.maxUses}`,
              ),
            ),
          )
          .returning({ uses: projectInvites.uses });

        if (consumed[0] === undefined) {
          throw inviteInvalid();
        }

        return { project: invite, role: 'member' };
      });

      return JoinProjectResponseSchema.parse({
        project: { ...projectOf(membership.project), role: membership.role },
      });
    },
  };
}
