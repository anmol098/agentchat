/**
 * The identity half of the data model (Plan §2): who someone is, which
 * projects they belong to, how they are invited into one, and how their
 * session is kept alive.
 *
 * This is the first schema module in the project, so a few decisions here bind
 * every table that follows. They are collected under "Precedents" below rather
 * than left to be inferred from the code.
 *
 * ## Precedents
 *
 * ### Identifiers are stored as the prefixed string, in `text`
 *
 * An AgentChat identifier is `usr_` + a canonical UUIDv7
 * (`packages/protocol/src/ids.ts`). The suffix alone would fit a native `uuid`
 * column in 16 bytes instead of 40, and the prefix could be pasted back on when
 * a row is read. That option was rejected:
 *
 * - The protocol package already states that the server stores prefixed
 *   strings, and that a second spelling of one id must not exist because two
 *   spellings "compare unequal as Map keys, in Sets, and in string columns".
 *   Splitting the id in half at the storage layer creates exactly that second
 *   spelling, and the only thing keeping the two in sync would be a
 *   reconstruction step repeated in every mapper, every hand-written query and
 *   every ad-hoc `psql` session.
 * - Reconstruction is prefix-blind. `'agt_' || id` compiles just as happily as
 *   `'usr_' || id`, so a copy-paste mistake produces a well-formed identifier
 *   for the wrong kind of thing — the precise failure the prefixes exist to
 *   prevent.
 * - A `uuid` foreign key cannot express what kind of thing it points at. With
 *   the prefix stored, every id column carries a `CHECK` pinning its prefix
 *   (see {@link idFormatCheck}), so putting an agent id in a user column is
 *   rejected by the database rather than by a code review.
 * - Ordering is unaffected. Every id of one kind shares a fixed-width prefix
 *   and puts its hyphens in the same places, so lexicographic order over the
 *   full string is the same order as over the UUID alone — which for UUIDv7 is
 *   creation order, the property `msg_` ids depend on (Plan §2, T-301).
 *
 * The cost is 24 bytes per id and slightly larger btrees. That is the right
 * trade at this scale (D9), and it is not a decision that would be painful to
 * revisit: §12.3's expand-and-contract works on a column whose values are
 * self-describing far more easily than on one whose meaning lives in code.
 *
 * A server-internal surrogate key that is *not* an AgentChat identifier — one
 * with no prefix in `ID_PREFIXES` and no appearance on the wire — is a native
 * `uuid` instead. {@link refreshTokens.id} is the only one so far.
 *
 * ### Enumerated values are `text` with a `CHECK`, not a Postgres `enum`
 *
 * Both express "one of these strings". They differ under §12.3: a `CHECK` can
 * be widened, replaced `NOT VALID` and then validated without rewriting the
 * table, and dropped outright, so an expand step and a later contract step are
 * both routine. A value added to a Postgres enum type can never be removed, so
 * a mistake in one is permanent for the life of the database. T-102 and T-301
 * should follow this for `sessions.status` and `message_inbox.status`.
 *
 * ### `ON UPDATE CASCADE` everywhere, `ON DELETE` decided per relationship
 *
 * An identifier is minted once and never changes, so the update action is inert
 * in practice. It is spelled out anyway because the alternative — leaving it to
 * default to `NO ACTION` — turns a hypothetical id correction into a
 * referential-integrity failure rather than a propagated change, and there is
 * no reason to prefer that. The delete action carries all the real meaning and
 * is argued individually at each column below.
 *
 * ### Timestamps are `timestamptz(3)`
 *
 * Time zone aware because a self-hosted server and its operator are rarely in
 * the same one, and millisecond precision because that is exactly what a
 * JavaScript `Date` can represent. Postgres would otherwise store microseconds
 * that no reader can round-trip, so a value written and read back would not
 * equal itself.
 *
 * ### The identifier grammar is duplicated here, deliberately
 *
 * {@link UUIDV7_PATTERN} mirrors `UUIDV7_PATTERN_SOURCE` in
 * `packages/protocol`. It is copied rather than imported because a `CHECK`
 * constraint is compiled into the database when the migration runs, not when
 * the server starts: importing the constant would only give the illusion that
 * the two stay in step, since changing it in the package would leave every
 * already-migrated database exactly as it was. The copy is small and anchored
 * to one constant; if the protocol package ever changes the grammar, this
 * constant changes with it *and* a migration replaces the constraints.
 *
 * @module
 */

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  type CheckBuilder,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * A canonical UUIDv7 as the protocol package spells it: lowercase, hyphenated,
 * version nibble `7`, RFC 9562 variant bits.
 *
 * Mirrors `UUIDV7_PATTERN_SOURCE` in `packages/protocol/src/uuidv7.ts`. See the
 * module note on why it is a copy.
 */
const UUIDV7_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

/**
 * Builds the anchored regular expression an identifier column must match.
 *
 * @param prefix - The type prefix including its underscore, e.g. `'usr_'`.
 * @returns A POSIX regular expression source anchored at both ends.
 */
function idPattern(prefix: string): string {
  return `^${prefix}${UUIDV7_PATTERN}$`;
}

/**
 * A `CHECK` pinning an identifier column to one kind of identifier.
 *
 * This is what makes storing the prefix worthwhile: with it, a column declared
 * to hold user ids cannot hold an agent id, whatever the application layer
 * believes. Without it, `text` would be a bag of strings.
 *
 * @param name - Constraint name, `<table>_<column>_format` by convention.
 * @param column - The column expression to constrain.
 * @param prefix - The type prefix the column accepts, e.g. `'usr_'`.
 * @returns A check-constraint builder for a table's extra config.
 */
function idFormatCheck(name: string, column: AnyPgColumn, prefix: string): CheckBuilder {
  // `sql.raw` for the pattern: a bound parameter would be serialised into the
  // generated migration as a placeholder with nothing to fill it. The pattern
  // contains no quote characters, so there is nothing to escape.
  return check(name, sql`${column} ~ ${sql.raw(`'${idPattern(prefix)}'`)}`);
}

/**
 * A column holding a timestamp, to the precision JavaScript can represent.
 *
 * @param name - The column name in the database.
 * @returns A `timestamptz(3)` column builder.
 */
function instant(name: string) {
  return timestamp(name, { withTimezone: true, precision: 3, mode: 'date' });
}

/**
 * A person, established through GitHub's device flow (D4) and thereafter
 * identified by AgentChat's own id.
 */
export const users = pgTable(
  'users',
  {
    /** `usr_` identifier. Minted by the server, never by the database. */
    id: text('id').primaryKey(),

    /**
     * The identity provider's subject for this person: GitHub's numeric user
     * id, as a string.
     *
     * `text` rather than `bigint` because the value is opaque — only ever
     * compared for equality, never summed, ordered or arithmetically
     * manipulated — and because a self-hoster may register a different OAuth
     * app or, later, a different provider entirely; the plan is explicit that
     * "nothing in the protocol depends on GitHub" (§7). A provider whose
     * subject is not an integer would otherwise force a type change, which
     * §12.3 makes a two-release affair. It also avoids `pg` returning `int8` as
     * a string and something down the line comparing it to a number.
     */
    githubId: text('github_id').notNull().unique(),

    /**
     * GitHub login, lowercased. Half of an agent address: `@alice/backend` is
     * this column, a slash, and `agents.name`.
     */
    username: text('username').notNull().unique(),

    /**
     * Human-readable name for display. GitHub's `name` field is frequently
     * null, in which case the service layer stores the login; this column is
     * never null so no reader has to implement that fallback a second time.
     */
    displayName: text('display_name').notNull(),

    /** Primary email, when GitHub exposes one. Never used for delivery. */
    email: text('email'),

    /** When the account was first created here, not on GitHub. */
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (table) => [
    idFormatCheck('users_id_format', table.id, 'usr_'),

    // Lowercase is enforced by the pattern rather than by a `lower()`
    // comparison: a username that differs only in case is a different string
    // to the unique index, so allowing mixed case would let `Alice` and `alice`
    // both exist and make `@alice/backend` ambiguous. The shape — alphanumeric
    // runs joined by single hyphens, 1-39 characters — is GitHub's own rule.
    check(
      'users_username_format',
      sql`${table.username} ~ ${sql.raw("'^[a-z0-9]+(-[a-z0-9]+)*$'")} and char_length(${table.username}) <= 39`,
    ),

    // An empty string and NULL must not both mean "no value"; readers would
    // have to test for two things and one of them would eventually be missed.
    check('users_display_name_present', sql`char_length(${table.displayName}) > 0`),
    check(
      'users_email_present_if_set',
      sql`${table.email} is null or char_length(${table.email}) > 0`,
    ),
  ],
);

/** A project: the boundary for membership, agents, and messages. */
export const projects = pgTable(
  'projects',
  {
    /** `prj_` identifier. */
    id: text('id').primaryKey(),

    /** URL-safe short name, unique across the server. */
    slug: text('slug').notNull().unique(),

    /** Display name, chosen by the creator. */
    name: text('name').notNull(),

    /**
     * The member who created the project.
     *
     * `ON DELETE RESTRICT`: a project outlives the person who happened to type
     * `agentchat project create`. Every other member's agents, conversations
     * and history hang off it, so cascading a user deletion into it would
     * destroy other people's data, and nulling it would need a nullable column
     * the plan does not have. v0.1 has no user-deletion flow at all (Plan §3),
     * so `RESTRICT` costs nothing today and forces whoever designs one to make
     * this call out loud instead of discovering it in production.
     */
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    /** When the project was created. */
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (table) => [
    idFormatCheck('projects_id_format', table.id, 'prj_'),

    // Same grammar as a username, for the same reason: a slug appears in URLs
    // and in the committed `.agentchat/config.json` (D12), where a case
    // difference would silently point two clones at what looks like one
    // project.
    check(
      'projects_slug_format',
      sql`${table.slug} ~ ${sql.raw("'^[a-z0-9]+(-[a-z0-9]+)*$'")} and char_length(${table.slug}) <= 64`,
    ),
    check(
      'projects_name_present',
      sql`char_length(${table.name}) > 0 and char_length(${table.name}) <= 200`,
    ),
  ],
);

/** Membership of a user in a project, and their role in it. */
export const projectMembers = pgTable(
  'project_members',
  {
    /**
     * `ON DELETE CASCADE` — **deletes rows.** A membership is a statement about
     * a project; with the project gone there is nothing for it to be about.
     * Nothing a member would expect to keep lives in this row: their account,
     * their agents and their credentials are all elsewhere and all survive.
     */
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade', onUpdate: 'cascade' }),

    /**
     * `ON DELETE CASCADE` — **deletes rows.** Symmetrically, a membership
     * cannot outlive the person it names. Leaving it would strand a row
     * pointing at nobody and count a ghost towards the project's member list.
     */
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),

    /** `'owner'` or `'member'`. Owners may rename or delete the project (D11). */
    role: text('role').notNull(),

    /** When this user joined. */
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.userId] }),

    // The primary key indexes (project_id, user_id) in that order, which
    // answers "who is in this project" but not "which projects am I in" — the
    // query behind `GET /projects`, run on every `agentchat` invocation that
    // resolves a project.
    index('project_members_user_id_idx').on(table.userId),

    check('project_members_role_valid', sql`${table.role} in ('owner', 'member')`),
  ],
);

/**
 * An invite code for a project. Any member may create one (D11); the default
 * expiry is seven days.
 */
export const projectInvites = pgTable(
  'project_invites',
  {
    /** `inv_` identifier. Distinct from {@link projectInvites.code}. */
    id: text('id').primaryKey(),

    /**
     * `ON DELETE CASCADE` — **deletes rows.** An invite is a way into one
     * project. When the project is gone the code can never be redeemed, so
     * keeping the row would only preserve a code that answers 404.
     */
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade', onUpdate: 'cascade' }),

    /**
     * The human-typed code, e.g. `ANET-7K4M-Q2P9`. Unique across the server
     * because `GET /invites/:code` resolves it without a project (Plan §3).
     */
    code: text('code').notNull().unique(),

    /**
     * Who issued it, shown as `invitedBy` in the invite preview (Plan §3).
     *
     * `ON DELETE RESTRICT`, matching {@link projects.createdBy}: the preview
     * promises an inviter, and there is no user-deletion flow to reason about
     * yet.
     */
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    /** After this instant the code is refused. Not null: every invite expires. */
    expiresAt: instant('expires_at').notNull(),

    /** Redemption limit, or null for unlimited until expiry. */
    maxUses: integer('max_uses'),

    /** Redemptions so far. */
    uses: integer('uses').notNull().default(0),

    /** Set when a member revokes the code before it expires. */
    revokedAt: instant('revoked_at'),
  },
  (table) => [
    idFormatCheck('project_invites_id_format', table.id, 'inv_'),

    // The grouping in the example above is not pinned: the plan gives it as an
    // example, and a CHECK that disagreed with the generator would be an
    // expensive way to find out. What is pinned is the part lookups depend on —
    // one canonical spelling, so `GET /invites/:code` can upper-case whatever
    // the user typed and match exactly one row.
    check(
      'project_invites_code_canonical',
      sql`${table.code} = upper(${table.code}) and char_length(${table.code}) between 8 and 64`,
    ),

    check('project_invites_uses_non_negative', sql`${table.uses} >= 0`),
    check(
      'project_invites_max_uses_positive',
      sql`${table.maxUses} is null or ${table.maxUses} > 0`,
    ),

    // "List this project's invites", the only listing query for this table.
    index('project_invites_project_id_idx').on(table.projectId),
  ],
);

/**
 * A refresh token: 32 random bytes handed to one client, kept here only as a
 * SHA-256 digest, rotated on every use, with a 90-day TTL (Plan §7).
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    /**
     * Surrogate key, and the one identifier in this module that is not an
     * AgentChat identifier: there is no `ID_PREFIXES` entry for a refresh
     * token, and no endpoint returns one — a client holds the token itself, not
     * a reference to this row. A native `uuid` is therefore the right type, and
     * the database can mint it. If a refresh-token id ever needs to cross the
     * wire, add a prefix to the protocol package first and migrate this column;
     * do not invent one here.
     */
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * `ON DELETE CASCADE` — **deletes rows, and this cascade is the point.** A
     * credential that outlives the account it authenticates is a way back into
     * a deleted user's data. Deleting the user must invalidate every session
     * they hold, on every machine, in the same transaction.
     */
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),

    /**
     * The SHA-256 of the token, lowercase hex. **The token itself is never
     * stored**, so a copy of this table cannot be replayed against the server.
     *
     * The `refresh_tokens_token_hash_is_sha256` constraint below is what makes
     * that more than a promise: a value that is not 64 lowercase hex characters
     * is rejected by the database, so the plaintext form — 32 random bytes in
     * whatever encoding the caller reached for — cannot be written here by
     * accident.
     */
    tokenHash: text('token_hash').notNull().unique(),

    /** When the token was issued. */
    createdAt: instant('created_at').notNull().defaultNow(),

    /** When it stops being accepted. 90 days after issue (Plan §7). */
    expiresAt: instant('expires_at').notNull(),

    /** Set on rotation or logout. A revoked token is kept for audit, not use. */
    revokedAt: instant('revoked_at'),

    /**
     * Why the row was revoked: `'rotated'`, `'logout'`, or `'reuse_detected'`.
     * `NULL` while the token is live, and also on any row revoked before this
     * column existed.
     *
     * Without it `revoked_at` alone has to answer a question it cannot: a token
     * spent by rotation and a token revoked by a normal logout are the same row
     * afterwards, so presenting either one at `POST /auth/refresh` was answered
     * as credential theft — the account's other sessions revoked, and a false
     * `refresh token replayed` warning logged (T-050). The distinction has to be
     * *recorded* when the row is revoked; every way of inferring it later is
     * wrong in some case, and the task file argues each one.
     *
     * **`NULL` reads as `'rotated'`**, which is what makes this expand step safe
     * in both directions under §12.3. Rows revoked before the upgrade carry
     * `NULL`, and so do rows an N-1 image revokes against this schema, since
     * that image does not know the column exists. Reading `NULL` as `'rotated'`
     * gives both exactly today's behaviour, and fails towards an alarm that may
     * be spurious rather than towards one that is silently suppressed.
     *
     * That is also why the pairing invariant `(revoked_at IS NULL) =
     * (revoked_reason IS NULL)` is **not** written here: it would reject release
     * N-1's writes, which set `revoked_at` and nothing else. It is a contract
     * step for a later release, after a backfill, and belongs with the change
     * that stops treating `NULL` as `'rotated'`.
     */
    revokedReason: text('revoked_reason'),

    /**
     * The machine this token was issued to, for `agentchat status` and for
     * revoking one laptop without logging out the others.
     *
     * Declared with no foreign key on purpose: `machines` does not exist until
     * T-301. This is the expand half of §12.3 — a nullable column, holding
     * nothing until there is something to point at. **T-301 must add the
     * constraint**, `REFERENCES machines(id) ON DELETE SET NULL`: losing a
     * machine record is a diagnostic loss and must not log anybody out. Until
     * then the format check below is the only thing standing between this
     * column and an arbitrary string.
     */
    machineId: text('machine_id'),
  },
  (table) => [
    // 64 lowercase hex characters and nothing else. See `tokenHash`.
    check(
      'refresh_tokens_token_hash_is_sha256',
      sql`${table.tokenHash} ~ ${sql.raw("'^[0-9a-f]{64}$'")}`,
    ),

    check(
      'refresh_tokens_machine_id_format',
      sql`${table.machineId} is null or ${table.machineId} ~ ${sql.raw(`'${idPattern('mch_')}'`)}`,
    ),

    // `text` with a CHECK rather than a Postgres enum, per the module
    // precedent: this set is expected to grow — a device revocation and an
    // administrative revocation are both plausible — and a value added to an
    // enum type can never be taken back out.
    //
    // NULL is admitted on purpose and is not a gap. See `revokedReason`: it is
    // both "live" and "revoked by something that predates this column", and
    // collapsing the two would need the pairing constraint that release N-1
    // cannot satisfy.
    check(
      'refresh_tokens_revoked_reason_valid',
      sql`${table.revokedReason} is null or ${table.revokedReason} in ('rotated', 'logout', 'reuse_detected')`,
    ),

    // "Log me out everywhere", and the rotation path's lookup of a user's live
    // tokens. The unique constraint on token_hash already indexes the
    // single-token lookup that `POST /auth/refresh` performs.
    index('refresh_tokens_user_id_idx').on(table.userId),

    // Expiry sweep. Without it, pruning scans the whole table.
    index('refresh_tokens_expires_at_idx').on(table.expiresAt),
  ],
);
