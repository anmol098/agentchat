/**
 * The messaging half of the data model (Plan §2): the machines agents run on,
 * the listener sessions they open, the conversations they hold, the messages
 * themselves, the agent-scoped inbox that makes delivery at-least-once, and the
 * per-session delivery record that exists only to be looked at when something
 * went wrong.
 *
 * The precedents set by `./identity.ts` and followed by `./agents.ts` hold here
 * too and are not re-argued: identifiers are the whole prefixed string in `text`
 * with a `CHECK` pinning the prefix, enumerated values are `text` plus a `CHECK`
 * rather than a Postgres `enum` (so §12.3 can widen or drop them), timestamps
 * are `timestamptz(3)`, column names are spelled out, `updated_at`-style columns
 * are maintained by Drizzle rather than by a trigger the drift check cannot see,
 * and every foreign key carries `ON UPDATE CASCADE` with its `ON DELETE` argued
 * at the column. The three small helpers below are copied from those modules for
 * the reason stated there: a `CHECK` is compiled into the database when the
 * migration runs, so a shared constant would only give the illusion that
 * already-migrated databases follow along.
 *
 * One precedent is extended rather than merely followed. `./identity.ts` puts a
 * prefix `CHECK` on a table's own id and on `refresh_tokens.machine_id`, the one
 * identifier column it has with no foreign key behind it; here **every**
 * identifier column carries one, foreign key or not. The redundancy is worth two
 * lines each:
 *
 * - A foreign key is implemented as a trigger and can be switched off. `ALTER
 *   TABLE … DISABLE TRIGGER ALL` around a bulk load, and `pg_restore
 *   --disable-triggers`, are ordinary operational moves; a `CHECK` is enforced
 *   through both, so a restore that puts an `agt_` id in a `project_id` column
 *   fails on the spot instead of years later.
 * - It is the column's grammar, visible in `\d messages` next to the type. These
 *   are the tables somebody reads first when they are trying to understand the
 *   product, and `text` on its own tells them nothing.
 *
 * ## The one thing to get right: the inbox is agent-scoped
 *
 * {@link messageInbox} is keyed `(message_id, agent_id)` and carries
 * `project_id` — it is **not** keyed by session, and no amount of convenience
 * should make it so (D3). A session exists for exactly as long as one
 * `agentchat listen` process does: it is created on start-up, ended on Ctrl-C,
 * and a laptop lid closing produces a new one. If "what is still owed to this
 * listener" were recorded against a session, then every message that arrived
 * while nobody was listening — the offline case, which is the entire point of
 * the product — would have no row to be recorded against, and every message
 * delivered to a session that died before acking would be owed to a session
 * that will never come back.
 *
 * Keying on `(agent, project)` instead makes replay a property of the durable
 * identity. `hello` asks one question — "what is pending for this agent in this
 * project?" — and the answer is correct whether the agent has been offline for a
 * week, is reconnecting after a dropped socket, or is running two listeners on
 * two machines at once. An ack from any one session clears the message for all
 * of them (D2 fan-out plus D3 agent-scoped ack), which is what stops the second
 * laptop replaying everything the first already handled.
 *
 * ## The one thing not to mistake for it: `deliveries`
 *
 * {@link deliveries} is keyed by session and looks superficially like the same
 * table. It is diagnostics only, exactly as Plan §2 and §4.3 say. Nothing in the
 * delivery algorithm reads it; `hello` never consults it; an ack writes to it
 * only so an operator can later see which socket a message went down and whether
 * that socket acknowledged it. Three deliberate choices keep it from quietly
 * becoming load-bearing:
 *
 * - It has no index on `session_id`, and no partial index on unacked rows. Those
 *   are precisely the indexes a session-scoped replay would need, so their
 *   absence turns "replay from `deliveries`" into an obvious sequential scan at
 *   review time rather than a plausible-looking query.
 * - Its `acked_at` is not tied to {@link messageInbox.ackedAt} by any
 *   constraint. They answer different questions — "did this socket confirm?"
 *   versus "does this agent still owe an ack?" — and a constraint linking them
 *   would imply the second can be derived from the first, which is the mistake.
 * - It carries no `status`. There is nothing to branch on.
 *
 * ## What the schema does not enforce, on purpose
 *
 * The authorization invariants of Plan §2 — sender owned by the caller, sender
 * and recipient both in the project, reads restricted to the caller's own agents
 * (D15) — span tables and depend on who is asking, so they belong to the service
 * layer (T-303). The one cross-table rule that *is* enforced here is the one a
 * client controls directly: a message's conversation must belong to the
 * message's project. See {@link messages} for why that one is worth a composite
 * foreign key and `parent_message_id` is not.
 *
 * @module
 */

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  type CheckBuilder,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

import { agents } from './agents.js';
import { projects, users } from './identity.js';

/**
 * A canonical UUIDv7 as the protocol package spells it: lowercase, hyphenated,
 * version nibble `7`, RFC 9562 variant bits.
 *
 * Mirrors `UUIDV7_PATTERN_SOURCE` in `packages/protocol/src/uuidv7.ts`, and the
 * identical constants in `./identity.ts` and `./agents.ts`. See the module note
 * on why it is a copy.
 */
const UUIDV7_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

/**
 * The maximum size of a message body, in bytes of UTF-8 (D10).
 *
 * Measured in bytes rather than characters because that is what the limit is
 * for: it bounds what a socket has to carry and what a row occupies, and Plan §2
 * sizes Fastify's `bodyLimit` and the WebSocket `maxPayload` at 2 MiB so one of
 * these plus its JSON envelope fits. `char_length` would let a body of astral
 * characters weigh four times this.
 */
const MAX_CONTENT_BYTES = 1_048_576;

/**
 * Builds the anchored regular expression an identifier column must match.
 *
 * @param prefix - The type prefix including its underscore, e.g. `'msg_'`.
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
 * @param prefix - The type prefix the column accepts, e.g. `'msg_'`.
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
 * A machine somebody runs agents on, named by its hostname.
 *
 * Purely diagnostic: it is what makes `agentchat status` able to say which
 * laptop a session belongs to, and what lets one machine be logged out without
 * disturbing the others (`refresh_tokens.machine_id`). Nothing in the delivery
 * path reads this table.
 *
 * ## The foreign key that is not in this file
 *
 * `refresh_tokens.machine_id` shipped in `0000_identity` with a format `CHECK`
 * and no foreign key, because this table did not exist yet — the expand half of
 * §12.3, recorded there as a debt against T-301. `0002_messaging.sql` pays it
 * with a hand-written `ALTER TABLE … ADD CONSTRAINT
 * refresh_tokens_machine_id_machines_id_fk … ON DELETE SET NULL`, rather than a
 * `.references()` in `./identity.ts`, because that file belongs to a finished
 * task this one does not own.
 *
 * So the database has one constraint drizzle-kit's snapshot does not. That is
 * stable — drizzle diffs the schema files against its own snapshot, and neither
 * mentions the key, so `generate` reports no drift and will never emit a `DROP`
 * for it — but it is a divergence, and the migration says at length how to close
 * it. Anything reading this file for the whole picture of `machines` should read
 * that migration too.
 */
export const machines = pgTable(
  'machines',
  {
    /** `mch_` identifier. Minted by the server, never by the database. */
    id: text('id').primaryKey(),

    /**
     * The person whose machine this is.
     *
     * `ON DELETE RESTRICT`, matching {@link agents.userId} and
     * {@link projects.createdBy}. A cascade would be tempting — a machine record
     * is only diagnostics — but sessions point at machines with a `NOT NULL`
     * column, so a cascade here would either take a person's entire session
     * history with it or fail on that foreign key halfway through a
     * user-deletion transaction. v0.1 has no user-deletion flow at all (Plan
     * §3), so `RESTRICT` costs nothing today and forces whoever writes one to
     * decide out loud.
     */
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    /**
     * The machine's hostname, as the CLI reported it (`POST /sessions` sends
     * `machine: { name }`).
     *
     * Deliberately not validated against a hostname grammar. This is a label a
     * person chose for their own laptop, it is never resolved or connected to,
     * and RFC 1123 would reject perfectly ordinary names — `Anmol's MacBook
     * Pro.local` among them. The only rules are the ones that keep it a usable
     * key: non-empty, and short enough to be an identifier rather than a
     * payload.
     */
    name: text('name').notNull(),

    /** When this machine was first seen. */
    createdAt: instant('created_at').notNull().defaultNow(),

    /**
     * When it was last seen — refreshed whenever a session on it registers or
     * heartbeats.
     *
     * Maintained by Drizzle's `$onUpdate` rather than a trigger, following
     * `agents.updated_at`: a trigger is invisible in this file, in drizzle-kit's
     * snapshot, and therefore to the drift check.
     */
    lastSeenAt: instant('last_seen_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    idFormatCheck('machines_id_format', table.id, 'mch_'),
    idFormatCheck('machines_user_id_format', table.userId, 'usr_'),

    check(
      'machines_name_present',
      sql`char_length(${table.name}) > 0 and char_length(${table.name}) <= 255`,
    ),

    // One row per (person, hostname), which is the only thing that makes this
    // table resolvable at all: `POST /sessions` identifies a machine by name and
    // nothing else, so without this the second `agentchat listen` on a laptop
    // would either mint a second machine row for it or race the first. It also
    // gives that upsert an index to conflict on, and answers "my machines" for
    // `agentchat status` on its leading column.
    //
    // Uniqueness is per user, not global: two people may both call their laptop
    // `mbp`, and a machine belongs to exactly one account.
    unique('machines_user_id_name_key').on(table.userId, table.name),
  ],
);

/**
 * One `agentchat listen` process's registration: this agent, in this project, on
 * this machine, from this working directory.
 *
 * Sessions are **ephemeral by design** — a new one per `listen` invocation — and
 * that fact is the reason {@link messageInbox} is keyed by agent instead. Rows
 * are never removed; `DELETE /sessions/:id` moves `status` to `'ended'` so
 * `agentchat status` and {@link deliveries} keep resolving.
 */
export const sessions = pgTable(
  'sessions',
  {
    /** `ses_` identifier. Quoted back by the client in the WebSocket `hello`. */
    id: text('id').primaryKey(),

    /**
     * The agent this listener speaks for.
     *
     * `ON DELETE RESTRICT`: agents are soft-deleted and never removed (D13), so
     * this reference always resolves; the restriction only bites if something
     * ever hard-deletes an agent, and a session history that outlives its agent
     * would be unreadable rather than merely stale.
     */
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    /**
     * The project this listener is listening in. Half of the routing key: the
     * socket registry is `Map<agentId:projectId, Set<Socket>>` (§4.3).
     *
     * `ON DELETE CASCADE` — **deletes rows.** A session is a live subscription
     * to one project; with the project gone there is nothing to subscribe to and
     * nothing in the row that means anything on its own. The messages it
     * delivered go the same way, by the same cascade, from `messages.project_id`.
     */
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade', onUpdate: 'cascade' }),

    /**
     * The machine the listener is running on.
     *
     * `ON DELETE RESTRICT`, and `NOT NULL` as Plan §2 has it. `SET NULL` — the
     * action {@link machines} takes for a refresh token — is not available for a
     * non-null column, and of the two remaining options a cascade would delete a
     * person's session history to tidy up a diagnostic record. Nothing deletes a
     * machine in v0.1; if something ever does, this stops it silently taking the
     * history with it.
     */
    machineId: text('machine_id')
      .notNull()
      .references(() => machines.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    /**
     * The harness that opened this session: `codex`, `claude-code`, `opencode`,
     * or whatever a future one calls itself.
     *
     * Free-form and nullable. `--runtime` is required of the CLI (D14) and Plan
     * §2 still marks the column optional, so the nullability is the plan's, not
     * an oversight: the column has to accept a row written by something that is
     * not today's CLI. It is never parsed, matched, or branched on — the server
     * does not interpret it any more than it interprets message content.
     */
    runtime: text('runtime'),

    /**
     * The directory the listener was started in, for `agentchat status`. Not
     * interpreted, not resolved, and never touched by the server.
     */
    workingDirectory: text('working_directory').notNull(),

    /** When the session registered. */
    startedAt: instant('started_at').notNull().defaultNow(),

    /**
     * Last heartbeat. The stale sweep compares this against `now()`; see
     * `sessions_stale_sweep_idx`.
     */
    lastSeenAt: instant('last_seen_at').notNull().defaultNow(),

    /** When the session ended, or null while it has not. See the status check. */
    endedAt: instant('ended_at'),

    /**
     * `'active'`, `'stale'`, or `'ended'` (Plan §2): active until 60 s pass with
     * no heartbeat, then stale, then ended on an explicit `DELETE` or after 24 h
     * stale. Presence — the `online` flag in discovery — is "at least one
     * `active` session in this project".
     *
     * Unlike `agents.deleted_at`, which was deliberately *not* given a companion
     * status, three states cannot be encoded in one nullable timestamp, so both
     * this column and {@link sessions.endedAt} exist. `sessions_ended_at_matches_status`
     * below is what stops the pair disagreeing.
     */
    status: text('status').notNull().default('active'),
  },
  (table) => [
    idFormatCheck('sessions_id_format', table.id, 'ses_'),
    idFormatCheck('sessions_agent_id_format', table.agentId, 'agt_'),
    idFormatCheck('sessions_project_id_format', table.projectId, 'prj_'),
    idFormatCheck('sessions_machine_id_format', table.machineId, 'mch_'),

    check('sessions_status_valid', sql`${table.status} in ('active', 'stale', 'ended')`),

    // The two columns describing the end of a session say the same thing, so the
    // database keeps them saying it. Without this, `status = 'ended'` with a null
    // `ended_at` is representable, and every reader then has to pick which of the
    // two to trust.
    check(
      'sessions_ended_at_matches_status',
      sql`(${table.status} = 'ended') = (${table.endedAt} is not null)`,
    ),

    check(
      'sessions_runtime_present_if_set',
      sql`${table.runtime} is null or (char_length(${table.runtime}) > 0 and char_length(${table.runtime}) <= 64)`,
    ),

    check(
      'sessions_working_directory_present',
      sql`char_length(${table.workingDirectory}) > 0 and char_length(${table.workingDirectory}) <= 4096`,
    ),

    // Presence, and the socket registry's warm-up. `GET /projects/:id/agents`
    // asks "which agents in this project have an active session, and how many"
    // for every agent at once, and `POST /messages` asks it of one recipient.
    // Partial on `status = 'active'` because that is the only status either
    // question is ever asked about, and because ended sessions accumulate
    // forever — one row per `listen` invocation, never deleted — while the live
    // set stays small. Postgres matches the partial index to any query whose
    // `WHERE` implies the predicate, so this serves both.
    index('sessions_project_agent_active_idx')
      .on(table.projectId, table.agentId)
      .where(sql`${table.status} = 'active'`),

    // The other direction, which the index above cannot serve from its leading
    // column: "every session of this agent", which is what an agent soft delete
    // has to end (D13, T-109) and what `agentchat status` lists.
    index('sessions_agent_id_idx').on(table.agentId),

    // The heartbeat sweep: `set status='stale' where status='active' and
    // last_seen_at < now() - interval '60 seconds'`, which runs on a timer for
    // the life of the process. Partial for the same reason as above — it is a
    // question only ever asked of active rows — which also keeps the index the
    // size of the live set rather than of the table.
    index('sessions_stale_sweep_idx')
      .on(table.lastSeenAt)
      .where(sql`${table.status} = 'active'`),
  ],
);

/**
 * A conversation thread inside one project. Deliberately almost empty: a
 * conversation is an identity to group messages under, not a document, and the
 * server has no opinion about what it is *about* (PRD §3.7).
 */
export const conversations = pgTable(
  'conversations',
  {
    /** `cnv_` identifier. */
    id: text('id').primaryKey(),

    /**
     * The project this thread belongs to.
     *
     * `ON DELETE CASCADE` — **deletes rows.** A conversation is scoped to a
     * project and cannot be read outside it; the messages in it cascade away
     * with the project too.
     */
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade', onUpdate: 'cascade' }),

    /** When the thread was opened, i.e. when its first message was sent. */
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (table) => [
    idFormatCheck('conversations_id_format', table.id, 'cnv_'),
    idFormatCheck('conversations_project_id_format', table.projectId, 'prj_'),

    // The target of `messages`' composite foreign key. `id` alone is already
    // unique as the primary key, so this adds no new rule about conversations —
    // it exists so that a *message* can name `(conversation_id, project_id)`
    // together and have the database check the pair. See {@link messages}.
    unique('conversations_id_project_id_key').on(table.id, table.projectId),

    // Deleting a project cascades into this table, and an unindexed referencing
    // column makes that a sequential scan. It is also the natural listing —
    // "this project's conversations" — if a route ever wants one.
    index('conversations_project_id_idx').on(table.projectId),
  ],
);

/**
 * A message from one agent to another inside a project.
 *
 * Append-only. Nothing updates a row here and nothing deletes one except a
 * project cascade, which is what lets `messages.id` be treated as an idempotency
 * key by every listener (§4.4) and what makes the ordering guarantee below
 * meaningful.
 *
 * ## Ordering
 *
 * `id` is `msg_` plus a UUIDv7, so ids of this kind sort lexicographically in
 * creation order — a property `./identity.ts` calls out as the reason ids are
 * stored whole. Replay leans on it: ordering the pending set by `message_id`
 * gets chronological order straight out of `message_inbox_pending_idx` with no
 * sort and no join. `created_at` remains the authority for anything a human
 * reads, and `messages_conversation_id_created_at_idx` orders by it.
 */
export const messages = pgTable(
  'messages',
  {
    /** `msg_` identifier. Sorts chronologically; see the table note. */
    id: text('id').primaryKey(),

    /**
     * The project the message was sent in — the security boundary (D15).
     *
     * `ON DELETE CASCADE` — **deletes rows, and this is the largest cascade in
     * the schema.** Deleting a project destroys every message ever sent in it,
     * for every member, along with the inbox and delivery rows that hang off
     * them. That is the intended meaning of deleting a project (only an owner
     * may, D11), and the alternative — orphaned messages nobody can read,
     * addressed to a project that no longer exists — is worse. It is called out
     * here because `DELETE /projects/:id` is one confirmation prompt away from
     * being irreversible.
     */
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade', onUpdate: 'cascade' }),

    /**
     * The thread this message belongs to. Never null: a message with no
     * conversation would have no reply address, so `POST /messages` opens one
     * when the client does not name an existing thread.
     *
     * Constrained by a **composite** foreign key on `(conversation_id,
     * project_id)` rather than a plain one on `conversation_id`; see the table
     * extras below for why.
     */
    conversationId: text('conversation_id').notNull(),

    /**
     * The message this one replies to, from `--reply-to`, or null for the first
     * message in a thread.
     *
     * `ON DELETE SET NULL` — the reply survives its parent. Nothing deletes a
     * message in v0.1 outside a project cascade, and inside one the whole
     * subtree goes anyway, so this is about the day something does: losing a
     * thread's root should flatten the thread, not silently delete every
     * descendant of it.
     *
     * That the parent is in the same conversation is **not** enforced here. It
     * could be, with the same composite-key trick used for `conversation_id`,
     * but the cost lands differently: the parent is a message, so the target
     * index would sit on this table — the one that grows without bound and takes
     * a write on every send — to catch a mistake with a much smaller blast
     * radius than the conversation one (a reply pointer that reads oddly, rather
     * than a message filed into another project's thread). T-303 validates it in
     * the service layer, where the sender's authorization is being checked
     * anyway.
     */
    parentMessageId: text('parent_message_id').references((): AnyPgColumn => messages.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),

    /**
     * The agent that sent it.
     *
     * `ON DELETE RESTRICT`. Agents are soft-deleted and never removed (D13)
     * precisely so this reference keeps resolving: a conversation from March has
     * to stay readable in September even though half of it was written by an
     * agent that no longer exists.
     */
    senderAgentId: text('sender_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    /**
     * The agent it was addressed to. Required — v0.1 is direct agent-to-agent
     * only (D5), and broadcast arrives, if it does, as a nullable column.
     *
     * `ON DELETE RESTRICT`, for the same reason as the sender.
     */
    recipientAgentId: text('recipient_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    /**
     * The message body: opaque UTF-8, at most 1 MiB of it (D10).
     *
     * The upper bound is a `CHECK` on `octet_length` and the *only* rule this
     * column has. In particular an empty body is accepted: the server never
     * interprets content (PRD §3.7, invariants 5 and 6), and a database rule
     * narrower than the protocol schema's would turn a request the API said was
     * valid into a 500. If empty messages are to be refused, `packages/protocol`
     * is where that is decided and a 400 is what it should produce.
     */
    content: text('content').notNull(),

    /**
     * The idempotency key the CLI mints once per `agentchat send` invocation.
     *
     * Unique per sender (see `messages_sender_agent_id_client_message_id_key`),
     * which is what makes a retried `POST /messages` — the network dropped the
     * response, not the request — return the message that already exists instead
     * of creating a second one. Scoped to the sender rather than globally so two
     * clients cannot collide over each other's keys, and so the uniqueness is
     * something a sender can reason about locally.
     *
     * Its grammar belongs to the client and is deliberately not pinned here
     * beyond a length bound: T-302 chooses it in `packages/protocol`, and a
     * `CHECK` written now against a format that does not exist yet would be a
     * guess compiled into every operator's database.
     */
    clientMessageId: text('client_message_id').notNull(),

    /** When the server accepted it. The authority for human-facing ordering. */
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (table) => [
    idFormatCheck('messages_id_format', table.id, 'msg_'),
    idFormatCheck('messages_project_id_format', table.projectId, 'prj_'),
    idFormatCheck('messages_conversation_id_format', table.conversationId, 'cnv_'),
    idFormatCheck('messages_sender_agent_id_format', table.senderAgentId, 'agt_'),
    idFormatCheck('messages_recipient_agent_id_format', table.recipientAgentId, 'agt_'),
    check(
      'messages_parent_message_id_format',
      sql`${table.parentMessageId} is null or ${table.parentMessageId} ~ ${sql.raw(`'${idPattern('msg_')}'`)}`,
    ),

    // The conversation must belong to the same project as the message.
    //
    // This is the one cross-table invariant worth a constraint rather than a
    // service-layer check, because it is the only one a client aims directly:
    // `--conversation <id>` is a raw identifier typed by the caller, and a
    // conversation id from another project would otherwise file a message into a
    // thread its members can see in their conversation view. Everything else in
    // Plan §2's authorization list depends on *who is asking* and cannot be
    // expressed as a constraint at all.
    //
    // It costs one extra unique index on `conversations`, which has one row per
    // thread; the composite key is served on this side by
    // `messages_conversation_id_created_at_idx`, whose leading column it is.
    //
    // `ON DELETE CASCADE` — **deletes rows.** Deleting a thread deletes what is
    // in it; a message whose conversation is gone has no reply address and no
    // route by which anything could read it.
    foreignKey({
      name: 'messages_conversation_id_project_id_fk',
      columns: [table.conversationId, table.projectId],
      foreignColumns: [conversations.id, conversations.projectId],
    })
      .onDelete('cascade')
      .onUpdate('cascade'),

    check(
      'messages_content_within_limit',
      sql`octet_length(${table.content}) <= ${sql.raw(String(MAX_CONTENT_BYTES))}`,
    ),

    check(
      'messages_client_message_id_present',
      sql`char_length(${table.clientMessageId}) > 0 and char_length(${table.clientMessageId}) <= 200`,
    ),

    // "One send, one message" (Plan §2). A retried POST carries the same key and
    // hits this, which is the whole mechanism: the service layer turns the
    // unique violation into the existing row rather than an error.
    unique('messages_sender_agent_id_client_message_id_key').on(
      table.senderAgentId,
      table.clientMessageId,
    ),

    // Hot query 2: `GET /conversations/:id` and `agentchat conversation <id>` —
    // one thread, oldest first. `created_at` is in the index rather than left to
    // a sort, so the scan returns rows already ordered and stops at the limit
    // instead of reading the whole thread to sort it.
    index('messages_conversation_id_created_at_idx').on(table.conversationId, table.createdAt),

    // `GET /messages?projectId=&agentId=&status=all&since=`, behind `agentchat
    // inbox --all`: what has been sent to this agent in this project, newest
    // first, optionally since a timestamp. Without it that route sequentially
    // scans the largest table in the schema. Recipient leads because the same
    // index then also answers it across projects.
    index('messages_recipient_agent_id_project_id_created_at_idx').on(
      table.recipientAgentId,
      table.projectId,
      table.createdAt,
    ),
  ],
);

/**
 * What an agent still owes an acknowledgement for: one row per `(message,
 * recipient agent)`, carrying the project so replay never has to join to find
 * it.
 *
 * **This table is what makes delivery at-least-once**, and it is keyed by agent
 * rather than by session on purpose (D3). See the module note for the argument;
 * the short version is that sessions are created fresh on every `listen`, so a
 * per-session table has nothing to record a message against when nobody is
 * listening — which is exactly the case replay exists for.
 */
export const messageInbox = pgTable(
  'message_inbox',
  {
    /**
     * The message owed.
     *
     * `ON DELETE CASCADE` — **deletes rows.** An inbox entry is a statement
     * about a message; with the message gone (only ever via a project cascade)
     * there is nothing left to deliver.
     */
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade', onUpdate: 'cascade' }),

    /**
     * The agent that owes the acknowledgement — the durable identity replay is
     * keyed on.
     *
     * `ON DELETE RESTRICT`, matching every other agent reference: agents are
     * soft-deleted, so this always resolves. A soft-deleted agent keeps its
     * pending rows; they simply stop being asked for, since the service layer
     * refuses it as a recipient and ends its sessions (T-109).
     */
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    /**
     * The project the message was sent in.
     *
     * Denormalised from `messages.project_id` — Plan §2 puts it here — so that
     * the replay query in §4.3 is answered by one index on this table with no
     * join at all. A listener is bound to one `(agent, project)` pair, so the
     * project is part of the question, not an attribute of the answer.
     *
     * `ON DELETE CASCADE` — **deletes rows**, redundantly with the cascade from
     * `message_id`: both paths lead to the same rows when a project is deleted.
     * Spelled out anyway because a foreign key with no delete action defaults to
     * `NO ACTION`, which would make deleting a project fail on this table
     * depending on the order Postgres happened to fire the triggers in.
     */
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade', onUpdate: 'cascade' }),

    /**
     * `'pending'` until any session of this agent acks it, then `'acked'`
     * forever (D3). Rows are updated in place rather than deleted, so `GET
     * /messages?status=all` can still see them and an operator can tell "never
     * sent" from "sent and acknowledged".
     */
    status: text('status').notNull().default('pending'),

    /** When the ack arrived, or null while the row is pending. */
    ackedAt: instant('acked_at'),

    /**
     * Which session sent the ack, when one did.
     *
     * Diagnostics: it records who cleared the row, and nothing reads it to
     * decide anything. Nullable and `ON DELETE SET NULL` — this must never be
     * mistaken for what makes an ack valid, and losing the session record cannot
     * be allowed to un-ack a message.
     */
    ackedBySessionId: text('acked_by_session_id').references(() => sessions.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.agentId] }),

    idFormatCheck('message_inbox_message_id_format', table.messageId, 'msg_'),
    idFormatCheck('message_inbox_agent_id_format', table.agentId, 'agt_'),
    idFormatCheck('message_inbox_project_id_format', table.projectId, 'prj_'),
    check(
      'message_inbox_acked_by_session_id_format',
      sql`${table.ackedBySessionId} is null or ${table.ackedBySessionId} ~ ${sql.raw(`'${idPattern('ses_')}'`)}`,
    ),

    check('message_inbox_status_valid', sql`${table.status} in ('pending', 'acked')`),

    // `status` and `acked_at` are two spellings of one fact, so they are kept in
    // step. An `'acked'` row with no timestamp, or a `'pending'` row carrying
    // one, is not representable.
    check(
      'message_inbox_acked_at_matches_status',
      sql`(${table.status} = 'acked') = (${table.ackedAt} is not null)`,
    ),

    // A pending row cannot name the session that acked it.
    check(
      'message_inbox_acked_by_requires_ack',
      sql`${table.ackedBySessionId} is null or ${table.status} = 'acked'`,
    ),

    // Hot query 1, and the reason this table exists: the replay in §4.3 —
    // "everything still pending for this agent in this project, oldest first" —
    // run on every `hello`, which is every reconnect of every listener.
    //
    // Three properties, each deliberate:
    //
    //  - Partial on `status = 'pending'`. The pending set is small and bounded
    //    by how far behind a listener is; the acked set grows forever. Postgres
    //    matches a partial index to any query whose `WHERE` implies the
    //    predicate, and the replay's does exactly.
    //  - `(agent_id, project_id)` leading, in that order, because those are the
    //    two equality terms and `agent_id` alone is also a sensible question
    //    ("what does this agent owe anywhere").
    //  - `message_id` last, which supplies the ordering. `msg_` ids are UUIDv7s
    //    behind a fixed-width prefix, so their lexicographic order *is*
    //    chronological order (see {@link messages}); ordering replay by
    //    `message_id` therefore reads the pending set out of this index already
    //    sorted, with no sort node and without touching `messages` for anything
    //    but the join by primary key. `ORDER BY messages.created_at` returns the
    //    same rows and adds a sort over the pending set; both are tested.
    //
    // Note what is *not* here: no index on `project_id` alone. Deleting a
    // project therefore scans this table once — the largest cascade in the
    // schema already rewrites `messages` wholesale, so it is not the place that
    // needs saving, and an extra btree on a table that takes a write per message
    // is a real cost paid on every send.
    index('message_inbox_pending_idx')
      .on(table.agentId, table.projectId, table.messageId)
      .where(sql`${table.status} = 'pending'`),
  ],
);

/**
 * A record that a message was written to one session's socket, and whether that
 * socket acknowledged it.
 *
 * **Diagnostics only** (Plan §2, §4.3). Nothing in the delivery algorithm reads
 * this table: `hello` replays from {@link messageInbox}, an ack clears
 * {@link messageInbox}, and these rows exist so that when someone asks "the
 * message says delivered, so why did the harness never see it?" there is an
 * answer with a session, a machine and a timestamp in it.
 *
 * Rows are written on every fan-out attempt (D2), so one message to an agent
 * running two listeners produces two of them, and a message replayed after a
 * reconnect produces another. Duplicates across sessions are the normal case,
 * which is a second reason this cannot be the basis of replay: there is no such
 * thing as "the" delivery of a message.
 */
export const deliveries = pgTable(
  'deliveries',
  {
    /**
     * The message that was written out.
     *
     * `ON DELETE CASCADE` — **deletes rows.** Diagnostics about a message that
     * no longer exists are not diagnostics.
     */
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade', onUpdate: 'cascade' }),

    /**
     * The session whose socket it was written to.
     *
     * `ON DELETE CASCADE` — **deletes rows.** Unreachable in v0.1: sessions are
     * never deleted, only ended. Spelled out so that a future session-pruning
     * job takes its diagnostics with it rather than failing on this key.
     */
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade', onUpdate: 'cascade' }),

    /** When the frame was handed to the socket. */
    deliveredAt: instant('delivered_at').notNull().defaultNow(),

    /**
     * When this session acked, if it did.
     *
     * Deliberately *not* tied to {@link messageInbox.ackedAt} by any constraint.
     * They answer different questions — "did this socket confirm?" against "does
     * this agent still owe an ack?" — and one is not derivable from the other:
     * an agent's message can be acked by a different session entirely, leaving
     * this row null forever, which is correct and not a defect.
     */
    ackedAt: instant('acked_at'),
  },
  (table) => [
    // PK(message_id, session_id) as Plan §2 specifies. A re-delivery to the same
    // socket updates the row rather than adding one.
    primaryKey({ columns: [table.messageId, table.sessionId] }),

    idFormatCheck('deliveries_message_id_format', table.messageId, 'msg_'),
    idFormatCheck('deliveries_session_id_format', table.sessionId, 'ses_'),

    // No index on `session_id`, and no partial index on `acked_at is null`.
    //
    // Those are exactly the two indexes a session-scoped replay would want, and
    // leaving them out is the point: the moment someone writes "what is this
    // session still owed", the plan is a sequential scan and the review question
    // asks itself. Replay is agent-scoped (D3) and lives in `message_inbox`.
    //
    // The cost is that a future job pruning old sessions scans this table. That
    // job does not exist, and if it is written, an index added alongside it is a
    // deliberate act with a reason attached — which is the state this comment is
    // trying to produce.
  ],
);
