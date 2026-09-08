/**
 * Agents and their participation in projects (Plan §2): who an agent is, which
 * person owns it, which projects it can speak in, and the soft delete that lets
 * a name be reused without rewriting history (D13).
 *
 * The precedents this module follows were set by `./identity.ts` and are not
 * restated here: identifiers are the whole prefixed string in `text` with a
 * `CHECK` pinning the prefix, enumerated values are `text` plus a `CHECK` rather
 * than a Postgres `enum`, timestamps are `timestamptz(3)`, column names are
 * spelled out because drizzle's `casing` option is deliberately unset, and every
 * foreign key carries `ON UPDATE CASCADE` with its `ON DELETE` argued
 * individually.
 *
 * ## Why the helpers are copied rather than imported
 *
 * {@link UUIDV7_PATTERN}, {@link idFormatCheck} and {@link instant} exist in
 * `./identity.ts` too. They are private there, and `identity.ts` belongs to a
 * finished task; widening its exports from here would be editing another task's
 * file to save nine lines. The identifier grammar in particular is *already*
 * duplicated on purpose — a `CHECK` is compiled into the database when the
 * migration runs, so a shared constant would only give the illusion that
 * already-migrated databases follow along. If a third schema module appears,
 * extracting these into a module of their own is the right move; note that it
 * cannot live directly under `src/db/schema/`, which `drizzle.config.ts` treats
 * as a directory of models.
 *
 * ## Soft delete, and what it means for each table
 *
 * D13 makes agent deletion a soft delete because `messages.sender_agent_id` and
 * `messages.recipient_agent_id` (T-301) must keep resolving forever: a
 * conversation from March has to stay readable in September even though the
 * agent that wrote half of it is gone. So `agents` rows are never removed, and
 * {@link agents.deletedAt} is the whole of the tombstone.
 *
 * {@link agentProjects} is treated the opposite way — deletion **removes** those
 * rows, as Plan §2 specifies. The asymmetry is deliberate and worth stating,
 * because "soft delete everything" is the reflex:
 *
 * - A participation row is a *capability*, not a record of anything that
 *   happened. It says "this agent may send and receive in this project right
 *   now". Nothing points at it, no message references it, and no view has to
 *   render it after the fact — the history lives in `messages`, which names the
 *   agent directly and never consults this table to be read.
 * - Keeping the rows would make every authorization check carry a second
 *   condition (`agent_projects` row exists **and** the agent is not deleted),
 *   and the day someone writes the check with only the first half is the day a
 *   deleted agent is addressable again. Removing the row makes the safe query
 *   the obvious one.
 * - Restoring a soft-deleted agent is not a v0.1 feature and would not want the
 *   old rows back anyway: an agent revived months later should be re-added to
 *   the projects that still want it, not silently re-granted access to every
 *   project it once had.
 * - It is reversible in the direction that matters. If participation history is
 *   ever wanted, §12.3 allows adding a nullable `removed_at` and stopping the
 *   delete; going the other way — discovering that stale rows have been
 *   accumulating and that half the code forgot to filter them — is the
 *   expensive direction.
 *
 * The remaining consequences of a soft delete are the service layer's (T-109):
 * ending the agent's sessions, deleting its `agent_projects` rows, and refusing
 * it as a recipient. The database's job is to keep the name reusable and the
 * history intact, which is what {@link agents} below does.
 *
 * @module
 */

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  type CheckBuilder,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { projects, users } from './identity.js';

/**
 * A canonical UUIDv7 as the protocol package spells it: lowercase, hyphenated,
 * version nibble `7`, RFC 9562 variant bits.
 *
 * Mirrors `UUIDV7_PATTERN_SOURCE` in `packages/protocol/src/uuidv7.ts`, and the
 * identical constant in `./identity.ts`. See the module note on why it is a
 * copy.
 */
const UUIDV7_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

/**
 * The grammar of an agent name, from Plan §2 and D17.
 *
 * A leading alphanumeric and up to 31 further alphanumerics or hyphens, so the
 * pattern caps the length at 32 characters by itself — there is no companion
 * `char_length` term to drift out of step with it. The first character is
 * pinned because a name is the second half of an address: `@alice/-backend`
 * reads as a flag, and a name that is nothing but hyphens is not addressable at
 * all. A trailing hyphen is permitted; it is ugly, but the plan's expression
 * allows it and narrowing a published grammar is a breaking change, not a
 * tidy-up.
 *
 * This is the same expression `packages/protocol` validates with, duplicated for
 * the reason in the module note.
 */
const AGENT_NAME_PATTERN = '^[a-z0-9][a-z0-9-]{0,31}$';

/**
 * Builds the anchored regular expression an identifier column must match.
 *
 * @param prefix - The type prefix including its underscore, e.g. `'agt_'`.
 * @returns A POSIX regular expression source anchored at both ends.
 */
function idPattern(prefix: string): string {
  return `^${prefix}${UUIDV7_PATTERN}$`;
}

/**
 * A `CHECK` pinning an identifier column to one kind of identifier.
 *
 * @param name - Constraint name, `<table>_<column>_format` by convention.
 * @param column - The column expression to constrain.
 * @param prefix - The type prefix the column accepts, e.g. `'agt_'`.
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
 * A named agent belonging to one user. The second half of an address:
 * `@alice/backend` is `users.username`, a slash, and {@link agents.name}.
 */
export const agents = pgTable(
  'agents',
  {
    /** `agt_` identifier. Minted by the server, never by the database. */
    id: text('id').primaryKey(),

    /**
     * The person who owns this agent.
     *
     * `ON DELETE RESTRICT`, matching {@link projects.createdBy}. Cascading would
     * be actively dangerous here rather than merely undecided: from T-301
     * onwards every message names its sender and recipient agent, so deleting a
     * user's agents by cascade either deletes their messages too — other
     * people's conversations, silently — or fails on the message foreign keys
     * halfway through, whichever T-301 chooses. Neither belongs in a cascade
     * nobody reviewed. v0.1 has no user-deletion flow at all (Plan §3), so
     * `RESTRICT` costs nothing today and forces whoever writes one to soft
     * delete the agents first, deliberately.
     */
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    /**
     * The agent's name, unique per user among live agents. See
     * {@link AGENT_NAME_PATTERN} for the grammar and
     * `agents_user_id_name_live_idx` below for the uniqueness.
     */
    name: text('name').notNull(),

    /** When the agent was registered. */
    createdAt: instant('created_at').notNull().defaultNow(),

    /**
     * When the row last changed.
     *
     * Maintained by Drizzle on the application side rather than by a database
     * trigger. A trigger would also catch hand-written `UPDATE`s, but it is
     * invisible in this file, invisible in `drizzle-kit`'s snapshot, and
     * therefore invisible to the drift check that keeps the committed migration
     * honest — a constraint the schema cannot see is one §12.3 cannot reason
     * about. The column is a diagnostic, not a correctness mechanism; nothing
     * in the protocol depends on it.
     */
    updatedAt: instant('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),

    /**
     * When the agent was soft-deleted, or null while it is live (D13).
     *
     * This column is the entire tombstone. A non-null value means: excluded
     * from discovery and from `@user/agent` resolution, refused as a message
     * recipient, holding no `agent_projects` rows — and, crucially, no longer
     * occupying its name. Every one of those is the service layer's to enforce
     * except the last, which is `agents_user_id_name_live_idx` below.
     *
     * Deliberately **not** a `status` column with a `CHECK`. There are exactly
     * two states and one of them has a timestamp attached; a `status` would
     * store the same fact twice and invite the pair to disagree.
     */
    deletedAt: instant('deleted_at'),
  },
  (table) => [
    idFormatCheck('agents_id_format', table.id, 'agt_'),

    check('agents_name_format', sql`${table.name} ~ ${sql.raw(`'${AGENT_NAME_PATTERN}'`)}`),

    // One live name per user, and no more (D13, Plan §2).
    //
    // The predicate is what makes a soft delete a *release* of the name. A plain
    // `UNIQUE(user_id, name)` would keep the tombstone squatting on it forever,
    // so `agentchat agent create backend` after `agentchat agent delete backend`
    // would fail with a duplicate-key error naming a row the user cannot see.
    //
    // The predicate is `deleted_at is null` and nothing else. Two properties
    // follow, and both are tested:
    //
    //  - Deleted rows are not merely exempt from colliding with live ones; they
    //    are outside the index entirely, so any number of them may share a name.
    //    Create/delete/create/delete leaves three tombstones called `backend`
    //    and no error, which is the only behaviour that does not put a ceiling
    //    on how many times a name can be recycled.
    //  - The index is usable, not just enforcing. Postgres matches a partial
    //    index to a query whose `WHERE` implies the predicate, and every read
    //    path here filters on exactly `deleted_at is null` — name resolution for
    //    `@alice/backend`, and the agent list behind `agentchat agent list`.
    //    That is why there is no separate index on `user_id`: this one already
    //    answers "which agents does this user have", on its leading column, for
    //    the only rows a caller ever wants.
    uniqueIndex('agents_user_id_name_live_idx')
      .on(table.userId, table.name)
      .where(sql`${table.deletedAt} is null`),
  ],
);

/**
 * An agent's participation in a project: the pairing that makes it addressable
 * as `@alice/backend` inside that project, and permitted to send in it.
 *
 * Rows here are removed when the agent is soft-deleted. See the module note for
 * why this table is not soft-deleted alongside {@link agents}.
 */
export const agentProjects = pgTable(
  'agent_projects',
  {
    /**
     * `ON DELETE CASCADE` — **deletes rows.** Participation cannot outlive the
     * agent it grants. This cascade is close to unreachable in v0.1, since D13
     * makes deletion soft and nothing hard-deletes an agent; it is spelled out
     * so that the day something does — an account erasure flow, an operator in
     * `psql` — the result is a tidy removal rather than a foreign-key error at
     * the end of a long transaction.
     */
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade', onUpdate: 'cascade' }),

    /**
     * `ON DELETE CASCADE` — **deletes rows.** Symmetrically: with the project
     * gone there is nothing to participate in. The agent itself, its name and
     * its history in other projects are all untouched, exactly as
     * `project_members` behaves for people.
     */
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade', onUpdate: 'cascade' }),

    /** When the agent joined this project. */
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (table) => [
    // PK(agent_id, project_id) as Plan §2 specifies. It doubles as the index for
    // "which projects is this agent in", the check `agentchat send` performs on
    // the sender.
    primaryKey({ columns: [table.agentId, table.projectId] }),

    // The other direction, which the primary key's column order cannot serve:
    // "which agents are in this project" — `agentchat agents` discovery, and the
    // recipient check on every send.
    index('agent_projects_project_id_idx').on(table.projectId),
  ],
);
