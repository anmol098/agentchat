/**
 * The messaging schema, tested through PostgreSQL rather than through the code
 * that talks to it.
 *
 * Same contract as `./identity.integration.test.ts` and
 * `./agents.integration.test.ts`: every assertion is about something the
 * database itself enforces or the planner itself decides, because a constraint
 * whose only proof is application code is a convention, and an index whose only
 * proof is a comment is a hope.
 *
 * Two centres of gravity:
 *
 * - **`message_inbox` is agent-scoped** (D3). The tests below show that a
 *   message stays pending across the death of the session it was delivered to,
 *   that any one of an agent's sessions can clear it for all of them, and that
 *   `deliveries` — the table that *is* session-scoped — cannot answer the replay
 *   question at all.
 * - **The two hot queries use their indexes.** `EXPLAIN (ANALYZE)` against a
 *   populated table, asserted on the plan Postgres actually chose. An index that
 *   exists and an index that is used are different claims, and only the second
 *   one matters at three in the morning.
 *
 * It lives in this subdirectory rather than beside `messaging.ts` because
 * `drizzle.config.ts` treats every `*.ts` file directly under `src/db/schema/`
 * as a model and executes it during `db:generate`; a test file there breaks
 * migration generation outright. The glob does not descend, so schema tests
 * belong here.
 *
 * The suite owns a **freshly created database**, so the migration is genuinely
 * applied to an empty one and the planner statistics belong to this suite alone.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agents } from '../agents.js';
import { projects, refreshTokens, users } from '../identity.js';
import {
  conversations,
  deliveries,
  machines,
  messageInbox,
  messages,
  sessions,
} from '../messaging.js';

/** The generated SQL migrations, exactly as the server image will ship them. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../../drizzle', import.meta.url));

const schema = {
  users,
  projects,
  refreshTokens,
  agents,
  machines,
  sessions,
  conversations,
  messages,
  messageInbox,
  deliveries,
};

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
/** Postgres `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = '23503';
/** Postgres `check_violation`. */
const CHECK_VIOLATION = '23514';
/** Postgres `restrict_violation` — what `ON DELETE RESTRICT` raises. */
const RESTRICT_VIOLATION = '23001';

/** The message content limit, in bytes of UTF-8 (D10). */
const MAX_CONTENT_BYTES = 1_048_576;

/** The fields of a `pg` error this suite asserts on. */
interface PostgresErrorFields {
  /** SQLSTATE, e.g. `'23505'`. */
  readonly code: string;
  /** Name of the constraint that rejected the statement, when there was one. */
  readonly constraint: string | undefined;
}

/**
 * Narrows a thrown value to the parts of a `pg` error worth asserting on.
 *
 * Drizzle wraps driver failures in a `DrizzleQueryError` whose message is the
 * SQL and whose `cause` is the original `pg` error, so this walks the cause
 * chain rather than looking only at the value it was handed.
 *
 * @param error - The value a rejected query threw.
 * @returns Its SQLSTATE and constraint name.
 * @throws {Error} If nothing in the chain is a `pg` error, so a genuine bug in
 * the test surfaces as itself instead of as a missing constraint.
 */
function postgresErrorOf(error: unknown): PostgresErrorFields {
  let current: unknown = error;

  while (typeof current === 'object' && current !== null) {
    if ('code' in current) {
      const { code, constraint } = current as { code: unknown; constraint?: unknown };
      if (typeof code === 'string') {
        return { code, constraint: typeof constraint === 'string' ? constraint : undefined };
      }
    }
    current = 'cause' in current ? (current as { cause: unknown }).cause : undefined;
  }

  throw new Error(`Expected a PostgreSQL error, got: ${String(error)}`);
}

/**
 * Runs a statement expected to be rejected and returns why it was.
 *
 * @param run - The statement.
 * @returns The SQLSTATE and constraint name of the rejection.
 * @throws {Error} If the statement succeeded.
 */
async function rejection(run: () => Promise<unknown>): Promise<PostgresErrorFields> {
  try {
    await run();
  } catch (error: unknown) {
    return postgresErrorOf(error);
  }
  throw new Error('Expected the database to reject this statement, but it succeeded.');
}

/**
 * A canonically shaped UUIDv7.
 *
 * @returns A fresh canonical-looking UUIDv7 string.
 */
function uuidv7Shaped(): string {
  const random = randomUUID();
  return `${random.slice(0, 14)}7${random.slice(15)}`;
}

/** A fresh `usr_` identifier. */
const userId = (): string => `usr_${uuidv7Shaped()}`;
/** A fresh `prj_` identifier. */
const projectId = (): string => `prj_${uuidv7Shaped()}`;
/** A fresh `agt_` identifier. */
const agentId = (): string => `agt_${uuidv7Shaped()}`;
/** A fresh `mch_` identifier. */
const machineId = (): string => `mch_${uuidv7Shaped()}`;
/** A fresh `ses_` identifier. */
const sessionId = (): string => `ses_${uuidv7Shaped()}`;
/** A fresh `cnv_` identifier. */
const conversationId = (): string => `cnv_${uuidv7Shaped()}`;
/** A fresh `msg_` identifier. */
const messageId = (): string => `msg_${uuidv7Shaped()}`;

/** A short unique suffix for names that must not collide between runs. */
const unique = (): string => randomUUID().replaceAll('-', '').slice(0, 12);

/** Names of the tables in the `public` schema, sorted. */
const TABLE_NAMES_SQL = sql`
  select table_name from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE'
  order by table_name
`;

/**
 * A structural fingerprint of the `public` schema: every column with its type
 * and nullability, every constraint with its definition, every index.
 */
const FINGERPRINT_SQL = sql`
  select json_build_object(
    'columns', (
      select coalesce(json_agg(c order by c->>'t', c->>'n'), '[]'::json)
      from (
        select json_build_object(
          't', table_name, 'n', column_name, 'd', data_type,
          'nullable', is_nullable, 'default', column_default
        ) as c
        from information_schema.columns
        where table_schema = 'public'
      ) columns
    ),
    'constraints', (
      select coalesce(json_agg(c order by c->>'n'), '[]'::json)
      from (
        select json_build_object('n', conname, 'd', pg_get_constraintdef(oid)) as c
        from pg_constraint
        where connamespace = 'public'::regnamespace
      ) constraints
    ),
    'indexes', (
      select coalesce(json_agg(i order by i->>'n'), '[]'::json)
      from (
        select json_build_object('n', indexname, 'd', indexdef) as i
        from pg_indexes where schemaname = 'public'
      ) indexes
    )
  ) as fingerprint
`;

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let databaseName: string;

/** What the empty database contained before the migration ran. */
let tablesBeforeMigration: string[];
/** What it contained after the first run. */
let tablesAfterMigration: string[];
/** Structural fingerprint after the first run and after the second. */
let fingerprintAfterFirstRun: unknown;
let fingerprintAfterSecondRun: unknown;
/** A message inserted between the two runs, re-read after the second. */
let survivorMessageId: string | undefined;

/**
 * Reads the table names in the current connection's `public` schema.
 *
 * @param connection - Database handle to query.
 * @returns Sorted table names.
 */
async function tableNames(connection: NodePgDatabase<typeof schema>): Promise<string[]> {
  const result = await connection.execute<{ table_name: string }>(TABLE_NAMES_SQL);
  return result.rows.map((row) => row.table_name);
}

/**
 * Reads the structural fingerprint of the current connection's `public` schema.
 *
 * @param connection - Database handle to query.
 * @returns An opaque, deeply comparable description of the schema.
 */
async function fingerprint(connection: NodePgDatabase<typeof schema>): Promise<unknown> {
  const result = await connection.execute<{ fingerprint: unknown }>(FINGERPRINT_SQL);
  return result.rows[0]?.fingerprint;
}

/** Connection string for `databaseName` on the server `DATABASE_URL` names. */
function urlForScratchDatabase(name: string): string {
  const raw = process.env['DATABASE_URL'];
  if (raw === undefined) {
    throw new Error('DATABASE_URL is not set; the global setup should have refused to start.');
  }
  const url = new URL(raw);
  url.pathname = `/${name}`;
  return url.toString();
}

beforeAll(async () => {
  databaseName = `agentchat_t301_${unique()}`;

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`create database "${databaseName}"`);
  } finally {
    await admin.end();
  }

  pool = new Pool({ connectionString: urlForScratchDatabase(databaseName) });
  db = drizzle(pool, { schema });

  tablesBeforeMigration = await tableNames(db);

  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  tablesAfterMigration = await tableNames(db);
  fingerprintAfterFirstRun = await fingerprint(db);

  // A row written between the runs: if the second run re-executed `CREATE
  // TABLE`, or anything else destructive, it would not come back.
  const owner = await createUser();
  const project = await createProject(owner);
  const sender = await createAgent(owner);
  const recipient = await createAgent(owner);
  survivorMessageId = await createMessage({ project, sender, recipient });

  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  fingerprintAfterSecondRun = await fingerprint(db);

  await seedForQueryPlans();
}, 120_000);

afterAll(async () => {
  await pool?.end();

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await admin.end();
  }
});

describe('the messaging migration', () => {
  it('applies to a genuinely empty database, on top of the earlier migrations', () => {
    expect(tablesBeforeMigration).toEqual([]);
    expect(tablesAfterMigration).toEqual(
      expect.arrayContaining([
        'conversations',
        'deliveries',
        'machines',
        'message_inbox',
        'messages',
        'sessions',
      ]),
    );
  });

  it('is a no-op when run a second time', async () => {
    // Nothing about the schema moved...
    expect(fingerprintAfterSecondRun).toEqual(fingerprintAfterFirstRun);
    // ...and the message written between the two runs is still there.
    const survivors = await db
      .select({ id: messages.id })
      .from(messages)
      .where(sql`${messages.id} = ${survivorMessageId}`);
    expect(survivors).toHaveLength(1);
  });

  it('pays T-101 back the foreign key it could not declare', async () => {
    // `refresh_tokens.machine_id` shipped nullable with a format check and no
    // foreign key because `machines` did not exist. Asserted against what
    // Postgres stored rather than against the schema file, because this one is
    // hand-written SQL: nothing in `identity.ts` mentions it.
    const result = await db.execute<{ definition: string }>(sql`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conname = 'refresh_tokens_machine_id_machines_id_fk'
    `);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.definition).toContain('FOREIGN KEY (machine_id)');
    expect(result.rows[0]?.definition).toContain('REFERENCES machines(id)');
    expect(result.rows[0]?.definition).toContain('ON UPDATE CASCADE ON DELETE SET NULL');
  });

  it('keeps a session alive when its machine record is deleted', async () => {
    // The point of `SET NULL`: losing a diagnostic must not log anybody out.
    const owner = await createUser();
    const machine = await createMachine(owner);

    await db.insert(refreshTokens).values({
      userId: owner,
      tokenHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 86_400_000),
      machineId: machine,
    });

    await db.delete(machines).where(sql`${machines.id} = ${machine}`);

    const tokens = await db
      .select({ machineId: refreshTokens.machineId })
      .from(refreshTokens)
      .where(sql`${refreshTokens.userId} = ${owner}`);

    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.machineId).toBeNull();
  });
});

describe('message content limit (D10)', () => {
  it('accepts a body of exactly 1 MiB', async () => {
    const context = await createContext();
    await createMessage({ ...context, content: 'a'.repeat(MAX_CONTENT_BYTES) });
  });

  it('refuses a body one byte over', async () => {
    const context = await createContext();

    const failure = await rejection(() =>
      createMessage({ ...context, content: 'a'.repeat(MAX_CONTENT_BYTES + 1) }),
    );

    expect(failure.code).toBe(CHECK_VIOLATION);
    expect(failure.constraint).toBe('messages_content_within_limit');
  });

  it('counts bytes rather than characters', async () => {
    // The limit bounds what a socket carries and what a row occupies, so a
    // body of four-byte characters hits it at a quarter of the character count.
    // A `char_length` check would have let this through at four times the size.
    const context = await createContext();
    const emoji = '😀'; // Four bytes of UTF-8, one code point.
    const overLimit = emoji.repeat(MAX_CONTENT_BYTES / 4 + 1);

    expect(overLimit.length).toBeLessThan(MAX_CONTENT_BYTES);

    const failure = await rejection(() => createMessage({ ...context, content: overLimit }));

    expect(failure.code).toBe(CHECK_VIOLATION);
    expect(failure.constraint).toBe('messages_content_within_limit');
  });

  it('accepts an empty body', async () => {
    // Not an oversight. The server never interprets content, and a database
    // rule narrower than the protocol schema's would turn a request the API
    // called valid into a 500. Whether an empty send is refused is
    // `packages/protocol`'s decision, answered with a 400.
    const context = await createContext();
    await createMessage({ ...context, content: '' });
  });
});

describe('client_message_id, one send one message', () => {
  it('refuses the same key twice from the same sender', async () => {
    // The retried `POST /messages` — the response was lost, not the request.
    const context = await createContext();
    const key = `cmid-${unique()}`;

    await createMessage({ ...context, clientMessageId: key });

    const failure = await rejection(() => createMessage({ ...context, clientMessageId: key }));

    expect(failure.code).toBe(UNIQUE_VIOLATION);
    expect(failure.constraint).toBe('messages_sender_agent_id_client_message_id_key');
  });

  it('allows the same key from a different sender', async () => {
    // Uniqueness is per sender, so two clients cannot collide over each other's
    // keys and a sender can reason about its own without coordination.
    const context = await createContext();
    const otherSender = await createAgent(context.owner);
    const key = `cmid-${unique()}`;

    await createMessage({ ...context, clientMessageId: key });
    await createMessage({ ...context, sender: otherSender, clientMessageId: key });

    const rows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(sql`${messages.clientMessageId} = ${key}`);
    expect(rows).toHaveLength(2);
  });

  it('refuses an empty key', async () => {
    const context = await createContext();

    const failure = await rejection(() => createMessage({ ...context, clientMessageId: '' }));

    expect(failure.code).toBe(CHECK_VIOLATION);
    expect(failure.constraint).toBe('messages_client_message_id_present');
  });
});

describe('enumerated values are checks, not Postgres enums', () => {
  it('stores session status as text so §12.3 can widen it', async () => {
    const result = await db.execute<{ data_type: string }>(sql`
      select data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'sessions' and column_name = 'status'
    `);
    expect(result.rows[0]?.data_type).toBe('text');

    const enums = await db.execute<{ count: string }>(sql`
      select count(*)::text as count from pg_type
      where typnamespace = 'public'::regnamespace and typtype = 'e'
    `);
    expect(enums.rows[0]?.count).toBe('0');
  });

  it.each(['pending', 'acked'])('accepts inbox status %s', async (status) => {
    const context = await createContext();
    const message = await createMessage(context);

    await db.insert(messageInbox).values({
      messageId: message,
      agentId: context.recipient,
      projectId: context.project,
      status,
      ackedAt: status === 'acked' ? new Date() : null,
    });
  });

  it('refuses an inbox status outside the set', async () => {
    const context = await createContext();
    const message = await createMessage(context);

    const failure = await rejection(() =>
      db.insert(messageInbox).values({
        messageId: message,
        agentId: context.recipient,
        projectId: context.project,
        status: 'delivered',
      }),
    );

    expect(failure.code).toBe(CHECK_VIOLATION);
    expect(failure.constraint).toBe('message_inbox_status_valid');
  });

  it.each(['active', 'stale', 'ended'])('accepts session status %s', async (status) => {
    const context = await createContext();
    await createSession(context, {
      status,
      endedAt: status === 'ended' ? new Date() : null,
    });
  });

  it('refuses a session status outside the set', async () => {
    const context = await createContext();

    const failure = await rejection(() => createSession(context, { status: 'connecting' }));

    expect(failure.code).toBe(CHECK_VIOLATION);
    expect(failure.constraint).toBe('sessions_status_valid');
  });

  it('refuses an ended session with no ended_at', async () => {
    const context = await createContext();

    const failure = await rejection(() => createSession(context, { status: 'ended' }));

    expect(failure.code).toBe(CHECK_VIOLATION);
    expect(failure.constraint).toBe('sessions_ended_at_matches_status');
  });

  it('refuses an acked inbox row with no acked_at', async () => {
    const context = await createContext();
    const message = await createMessage(context);

    const failure = await rejection(() =>
      db.insert(messageInbox).values({
        messageId: message,
        agentId: context.recipient,
        projectId: context.project,
        status: 'acked',
      }),
    );

    expect(failure.code).toBe(CHECK_VIOLATION);
    expect(failure.constraint).toBe('message_inbox_acked_at_matches_status');
  });

  it('refuses a pending inbox row that names the session that acked it', async () => {
    const context = await createContext();
    const message = await createMessage(context);
    const session = await createSession(context);

    const failure = await rejection(() =>
      db.insert(messageInbox).values({
        messageId: message,
        agentId: context.recipient,
        projectId: context.project,
        status: 'pending',
        ackedBySessionId: session,
      }),
    );

    expect(failure.code).toBe(CHECK_VIOLATION);
    expect(failure.constraint).toBe('message_inbox_acked_by_requires_ack');
  });
});

describe('the inbox is agent-scoped, not session-scoped (D3)', () => {
  it('keeps a message pending after the session it was delivered to is gone', async () => {
    // The listener crashed before acking. A session-keyed inbox would owe this
    // message to a session that will never come back.
    const context = await createContext();
    const message = await createMessage(context);
    await pend(message, context);

    const session = await createSession(context);
    await db
      .insert(deliveries)
      .values({ messageId: message, sessionId: session, deliveredAt: new Date() });
    await db
      .update(sessions)
      .set({ status: 'ended', endedAt: new Date() })
      .where(sql`${sessions.id} = ${session}`);

    const pending = await pendingFor(context.recipient, context.project);
    expect(pending).toContain(message);
  });

  it('is where a message lands when nobody is listening at all', async () => {
    // The offline case, and the reason a per-session table cannot drive replay:
    // there is no session to key the row on, and the row still has to exist.
    const context = await createContext();
    const message = await createMessage(context);
    await pend(message, context);

    const sessionRows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(sql`${sessions.agentId} = ${context.recipient}`);
    expect(sessionRows).toEqual([]);

    expect(await pendingFor(context.recipient, context.project)).toContain(message);
  });

  it('lets any one session of an agent clear it for all of them', async () => {
    // D2 fan-out plus D3 agent-scoped ack: two listeners on two machines both
    // receive, one acks, and the other does not replay it on reconnect.
    const context = await createContext();
    const message = await createMessage(context);
    await pend(message, context);

    const laptop = await createSession(context);
    const desktop = await createSession(context);
    await db.insert(deliveries).values([
      { messageId: message, sessionId: laptop },
      { messageId: message, sessionId: desktop },
    ]);

    await db
      .update(messageInbox)
      .set({ status: 'acked', ackedAt: new Date(), ackedBySessionId: laptop })
      .where(sql`${messageInbox.messageId} = ${message} and ${messageInbox.status} = 'pending'`);

    expect(await pendingFor(context.recipient, context.project)).not.toContain(message);

    // ...and the desktop's own delivery row is still unacked, which is correct
    // and not a defect: it records that this socket never confirmed, which is
    // exactly the diagnostic it exists for.
    const rows = await db
      .select({ sessionId: deliveries.sessionId, ackedAt: deliveries.ackedAt })
      .from(deliveries)
      .where(sql`${deliveries.messageId} = ${message}`);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.ackedAt === null)).toBe(true);
  });

  it('separates pending by project as well as by agent', async () => {
    // A listener binds to one `(agent, project)` pair, so a message owed in one
    // project must not appear in the replay for another.
    const owner = await createUser();
    const payments = await createProject(owner);
    const platform = await createProject(owner);
    const sender = await createAgent(owner);
    const recipient = await createAgent(owner);

    const inPayments = await createMessage({ project: payments, sender, recipient });
    await pend(inPayments, { project: payments, recipient });

    expect(await pendingFor(recipient, payments)).toContain(inPayments);
    expect(await pendingFor(recipient, platform)).not.toContain(inPayments);
  });

  it('holds one row per (message, agent) and refuses a second', async () => {
    const context = await createContext();
    const message = await createMessage(context);
    await pend(message, context);

    const failure = await rejection(() => pend(message, context));

    expect(failure.code).toBe(UNIQUE_VIOLATION);
    expect(failure.constraint).toBe('message_inbox_message_id_agent_id_pk');
  });

  it('survives the soft delete of the agent that owes the ack', async () => {
    // Agents are soft-deleted (D13), so the RESTRICT reference always resolves
    // and the pending rows stay readable. Refusing the agent as a recipient and
    // ending its sessions is the service layer's job (T-109), not the schema's.
    const context = await createContext();
    const message = await createMessage(context);
    await pend(message, context);

    await db
      .update(agents)
      .set({ deletedAt: new Date() })
      .where(sql`${agents.id} = ${context.recipient}`);

    expect(await pendingFor(context.recipient, context.project)).toContain(message);
  });
});

describe('deliveries are diagnostics only', () => {
  it('has no index that would let it answer the replay question', async () => {
    // The absence is the design. An index on `session_id`, or a partial one on
    // unacked rows, is exactly what a session-scoped replay would need; without
    // them, writing that query produces a sequential scan and the review
    // question asks itself. Replay is `message_inbox`'s job.
    const result = await db.execute<{ indexname: string }>(sql`
      select indexname from pg_indexes
      where schemaname = 'public' and tablename = 'deliveries'
    `);

    expect(result.rows.map((row) => row.indexname)).toEqual([
      'deliveries_message_id_session_id_pk',
    ]);
  });

  it('does not constrain its acked_at against the inbox', async () => {
    // They answer different questions, and one is not derivable from the other:
    // this row can stay null forever while the message is acked by a different
    // session entirely.
    const constraints = await db.execute<{ count: string }>(sql`
      select count(*)::text as count from pg_constraint
      where conrelid = 'public.deliveries'::regclass and contype = 'c'
        and pg_get_constraintdef(oid) ilike '%message_inbox%'
    `);
    expect(constraints.rows[0]?.count).toBe('0');
  });
});

describe('cross-table integrity the client can aim at', () => {
  it('refuses a message filed into another project’s conversation', async () => {
    // `--conversation <id>` is a raw identifier typed by the caller, so this is
    // the one authorization-adjacent rule a constraint can hold on its own.
    const owner = await createUser();
    const payments = await createProject(owner);
    const platform = await createProject(owner);
    const sender = await createAgent(owner);
    const recipient = await createAgent(owner);

    const foreignThread = conversationId();
    await db.insert(conversations).values({ id: foreignThread, projectId: platform });

    const failure = await rejection(() =>
      db.insert(messages).values({
        id: messageId(),
        projectId: payments,
        conversationId: foreignThread,
        senderAgentId: sender,
        recipientAgentId: recipient,
        content: 'wrong project',
        clientMessageId: `cmid-${unique()}`,
      }),
    );

    expect(failure.code).toBe(FOREIGN_KEY_VIOLATION);
    expect(failure.constraint).toBe('messages_conversation_id_project_id_fk');
  });

  it('refuses an identifier carrying another kind of prefix', async () => {
    const context = await createContext();

    const failure = await rejection(() =>
      db.insert(messages).values({
        id: messageId(),
        projectId: context.project,
        conversationId: context.conversation,
        senderAgentId: context.sender,
        // A user id where an agent id belongs: the mistake prefixes exist for.
        recipientAgentId: userId(),
        content: 'wrong kind',
        clientMessageId: `cmid-${unique()}`,
      }),
    );

    expect(failure.code).toBe(CHECK_VIOLATION);
    expect(failure.constraint).toBe('messages_recipient_agent_id_format');
  });

  it('keeps a reply when its parent goes, rather than deleting the subtree', async () => {
    const context = await createContext();
    const parent = await createMessage(context);
    const reply = await createMessage({ ...context, parentMessageId: parent });

    await db.delete(messages).where(sql`${messages.id} = ${parent}`);

    const rows = await db
      .select({ id: messages.id, parentMessageId: messages.parentMessageId })
      .from(messages)
      .where(sql`${messages.id} = ${reply}`);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.parentMessageId).toBeNull();
  });

  it('refuses to delete an agent that ever sent a message', async () => {
    // RESTRICT is what keeps a conversation from March readable in September.
    const context = await createContext();
    await createMessage(context);

    const failure = await rejection(() =>
      db.delete(agents).where(sql`${agents.id} = ${context.sender}`),
    );

    expect(failure.code).toBe(RESTRICT_VIOLATION);
    expect(failure.constraint).toBe('messages_sender_agent_id_agents_id_fk');
  });

  it('gives one machine per person per hostname', async () => {
    // `POST /sessions` identifies a machine by name and nothing else, so
    // without this the second `agentchat listen` on a laptop would mint a
    // second row for it.
    const owner = await createUser();
    const name = `laptop-${unique()}`;

    await db.insert(machines).values({ id: machineId(), userId: owner, name });

    const failure = await rejection(() =>
      db.insert(machines).values({ id: machineId(), userId: owner, name }),
    );

    expect(failure.code).toBe(UNIQUE_VIOLATION);
    expect(failure.constraint).toBe('machines_user_id_name_key');
  });

  it('lets two people call their laptop the same thing', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const name = `mbp-${unique()}`;

    await db.insert(machines).values({ id: machineId(), userId: alice, name });
    await db.insert(machines).values({ id: machineId(), userId: bob, name });
  });

  it('takes a project’s messages, threads, inbox and deliveries with it', async () => {
    // The largest cascade in the schema, spelled out so it is a decision rather
    // than a discovery.
    const context = await createContext();
    const message = await createMessage(context);
    await pend(message, context);
    const session = await createSession(context);
    await db.insert(deliveries).values({ messageId: message, sessionId: session });

    await db.delete(projects).where(sql`${projects.id} = ${context.project}`);

    const remaining = await db.execute<{ messages: string; inbox: string; deliveries: string }>(sql`
      select
        (select count(*)::text from messages where project_id = ${context.project}) as messages,
        (select count(*)::text from message_inbox where project_id = ${context.project}) as inbox,
        (select count(*)::text from deliveries where message_id = ${message}) as deliveries
    `);

    expect(remaining.rows[0]).toEqual({ messages: '0', inbox: '0', deliveries: '0' });

    // The agents that sent and received are untouched: a project is not an
    // identity.
    const survivors = await db
      .select({ id: agents.id })
      .from(agents)
      .where(sql`${agents.id} in (${context.sender}, ${context.recipient})`);
    expect(survivors).toHaveLength(2);
  });
});

describe('the two hot queries use their indexes', () => {
  it('replays the pending inbox from message_inbox_pending_idx, with no sort', async () => {
    // §4.3's `hello`: everything still pending for this agent in this project,
    // oldest first. Ordered by `message_id` because `msg_` ids are UUIDv7s
    // behind a fixed-width prefix, so the index supplies chronological order
    // itself — no sort node, and `messages` is touched only by primary key.
    const plan = await explain(sql`
      select m.id, m.content, m.created_at
      from message_inbox i
      join messages m on m.id = i.message_id
      where i.agent_id = ${plans.recipient}
        and i.project_id = ${plans.project}
        and i.status = 'pending'
      order by i.message_id
    `);

    expect(plan).toContain('message_inbox_pending_idx');
    expect(plan).not.toMatch(/Seq Scan on message_inbox/);
    expect(plan).not.toMatch(/\bSort\b/);
  });

  it('replays in the same order when ordered by messages.created_at', async () => {
    // Plan §4.3 writes the replay as `ORDER BY created_at`. It returns the same
    // rows in the same order and still reads the pending set from the partial
    // index; the difference is a sort node over that small set. Both spellings
    // are correct, and T-303 should prefer the one above.
    const plan = await explain(sql`
      select m.id
      from message_inbox i
      join messages m on m.id = i.message_id
      where i.agent_id = ${plans.recipient}
        and i.project_id = ${plans.project}
        and i.status = 'pending'
      order by m.created_at
    `);

    expect(plan).toContain('message_inbox_pending_idx');
    expect(plan).not.toMatch(/Seq Scan on message_inbox/);

    const byId = await db.execute<{ id: string }>(sql`
      select m.id from message_inbox i join messages m on m.id = i.message_id
      where i.agent_id = ${plans.recipient} and i.project_id = ${plans.project}
        and i.status = 'pending'
      order by i.message_id
    `);
    const byCreatedAt = await db.execute<{ id: string }>(sql`
      select m.id from message_inbox i join messages m on m.id = i.message_id
      where i.agent_id = ${plans.recipient} and i.project_id = ${plans.project}
        and i.status = 'pending'
      order by m.created_at
    `);

    expect(byId.rows.map((row) => row.id)).toEqual(byCreatedAt.rows.map((row) => row.id));
    expect(byId.rows.length).toBe(PENDING_COUNT);
  });

  it('reads a page of a conversation in order from messages_conversation_id_created_at_idx', async () => {
    // `GET /conversations/:id` and `agentchat conversation <id>`, reading a
    // page. `created_at` is the index's second column, so the scan walks the
    // thread in order and stops at the page boundary: no sort, and five buffers
    // rather than one per message in the thread.
    const plan = await explain(sql`
      select id, sender_agent_id, content, created_at
      from messages
      where conversation_id = ${plans.conversation}
      order by created_at
      limit ${sql.raw(String(CONVERSATION_PAGE))}
    `);

    expect(plan).toContain('messages_conversation_id_created_at_idx');
    expect(plan).not.toMatch(/Seq Scan on messages/);
    expect(plan).not.toMatch(/\bSort\b/);
  });

  it('sorts instead when asked for a whole thread at once, which is why the route pages', async () => {
    // The other half of the fact above, asserted rather than assumed, because
    // getting it wrong is how a route ships with a plan nobody predicted.
    //
    // A thread's rows are scattered across the heap — messages are appended in
    // arrival order, interleaved with every other thread in the project — so
    // reading *all* of one means touching about as many heap pages as there are
    // messages in it. Postgres will always gather those with a bitmap scan,
    // which sorts by page and therefore loses `created_at` order, and then sort
    // the result. That is the cheaper plan and it does not stop being the
    // cheaper plan on a bigger table: the index cannot save an unbounded thread
    // read from a sort, and no index could.
    //
    // So the ordering in `messages_conversation_id_created_at_idx` pays only for
    // a bounded read. T-303 should give `GET /conversations/:id` a limit and a
    // cursor rather than returning `messages[]` whole; Plan §3 does not spell
    // one out.
    //
    // Only the sort is asserted. Whether the rows underneath it arrive from a
    // bitmap scan or a sequential one is a matter of how much of the table one
    // thread happens to occupy, and the two cost within a few percent of each
    // other at this size — pinning that would be pinning an accident. What is
    // not an accident is that neither of them is ordered.
    const plan = await explain(sql`
      select id, sender_agent_id, content, created_at
      from messages
      where conversation_id = ${plans.conversation}
      order by created_at
    `);

    expect(plan).toMatch(/\bSort\b/);
    expect(plan).not.toMatch(/Index Scan using messages_conversation_id_created_at_idx/);
  });

  it('answers inbox --all from messages_recipient_agent_id_project_id_created_at_idx', async () => {
    // `GET /messages?projectId=&agentId=&status=all&since=`. Not one of the two
    // the task names, but the alternative is a sequential scan of the largest
    // table in the schema on a command people run casually.
    const plan = await explain(sql`
      select id, sender_agent_id, content, created_at
      from messages
      where recipient_agent_id = ${plans.recipient}
        and project_id = ${plans.project}
      order by created_at desc
      limit 50
    `);

    expect(plan).toContain('messages_recipient_agent_id_project_id_created_at_idx');
    expect(plan).not.toMatch(/Seq Scan on messages/);
    expect(plan).not.toMatch(/\bSort\b/);
  });

  it('finds an agent’s active sessions from the partial presence index', async () => {
    // Presence, behind `GET /projects/:id/agents` and the `online` flag: the
    // index is partial on `status = 'active'`, and Postgres matches it to a
    // query whose `WHERE` implies that predicate. The fixture leaves thousands
    // of ended sessions around it so that reaching for the index is a choice
    // rather than the only thing left; against the single-row table this suite
    // used to build, the same query was a sequential scan and proved nothing.
    const plan = await explain(sql`
      select count(*) from sessions
      where project_id = ${plans.project}
        and agent_id = ${plans.recipient}
        and status = 'active'
    `);

    expect(plan).toContain('sessions_project_agent_active_idx');
    expect(plan).not.toMatch(/Seq Scan on sessions/);
  });

  it('cannot answer the replay question from deliveries without a sequential scan', async () => {
    // The counter-example, asserted rather than asserted-about: the
    // session-scoped spelling of replay has no index to use, which is the
    // property that keeps `deliveries` diagnostic. The fixture gives the table
    // a row per acked message first — a sequential scan of an empty table is
    // not evidence of anything.
    const plan = await explain(sql`
      select message_id from deliveries
      where session_id = ${plans.session} and acked_at is null
    `);

    expect(plan).toMatch(/Seq Scan on deliveries/);
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** How many messages the query-plan fixture inserts. */
const PLAN_MESSAGE_COUNT = 4_000;
/** How many of them are left pending for the fixture's recipient. */
const PENDING_COUNT = 25;
/**
 * How many conversations they are spread across — eight, so each thread holds
 * five hundred messages.
 *
 * The count is load-bearing, not arbitrary. `GET /conversations/:id` reads a
 * bounded page of one thread, and the planner will only walk
 * `messages_conversation_id_created_at_idx` in order — rather than gathering
 * the thread with a bitmap scan and sorting it — when stopping early is worth
 * something, which means the thread has to be several times the page. At forty
 * conversations each thread was a hundred messages, a page was half of it, and
 * the bitmap plan won on cost. See the conversation test for the full argument.
 */
const PLAN_CONVERSATION_COUNT = 8;
/** The page size `GET /conversations/:id` is expected to read a thread in. */
const CONVERSATION_PAGE = 50;
/**
 * How many sessions the fixture leaves behind, nearly all of them ended.
 *
 * One row per `agentchat listen` invocation and none is ever deleted, so this
 * is the shape the table really takes: a large history with a handful of live
 * rows in it. A presence query against a table of one session proves nothing —
 * Postgres would scan it either way — which is exactly what the earlier fixture
 * was doing.
 */
const PLAN_SESSION_COUNT = 5_000;

/** Identifiers the query-plan tests run against. Populated by `seedForQueryPlans`. */
const plans = {
  project: '',
  recipient: '',
  conversation: '',
  session: '',
};

/**
 * A user, a project, two agents, a machine and a conversation: enough to insert
 * a message and a session without repeating six inserts per test.
 */
interface Context {
  readonly owner: string;
  readonly project: string;
  readonly sender: string;
  readonly recipient: string;
  readonly machine: string;
  readonly conversation: string;
}

/**
 * Runs `EXPLAIN (ANALYZE)` and returns the plan as text.
 *
 * `ANALYZE` rather than a plain `EXPLAIN` so the assertion is about the plan
 * that actually executed, with the row counts to prove it did.
 *
 * @param query - The statement to explain.
 * @returns The plan, newline-joined.
 */
async function explain(query: ReturnType<typeof sql>): Promise<string> {
  const result = await db.execute<Record<string, string>>(sql`explain (analyze, buffers) ${query}`);
  return result.rows.map((row) => Object.values(row)[0]).join('\n');
}

/**
 * Inserts a user with fresh unique values.
 *
 * @returns The new user's id.
 */
async function createUser(): Promise<string> {
  const id = userId();
  await db.insert(users).values({
    id,
    githubId: `gh-${unique()}`,
    username: `u-${unique()}`,
    displayName: 'Test User',
  });
  return id;
}

/**
 * Inserts a project owned by `owner`.
 *
 * @param owner - Id of the user recorded as the creator.
 * @returns The new project's id.
 */
async function createProject(owner: string): Promise<string> {
  const id = projectId();
  await db
    .insert(projects)
    .values({ id, slug: `p-${unique()}`, name: 'Test Project', createdBy: owner });
  return id;
}

/**
 * Inserts a live agent owned by `owner`.
 *
 * @param owner - Id of the user who owns it.
 * @returns The new agent's id.
 */
async function createAgent(owner: string): Promise<string> {
  const id = agentId();
  await db.insert(agents).values({ id, userId: owner, name: `a-${unique()}` });
  return id;
}

/**
 * Inserts a machine belonging to `owner`.
 *
 * @param owner - Id of the user whose machine it is.
 * @returns The new machine's id.
 */
async function createMachine(owner: string): Promise<string> {
  const id = machineId();
  await db.insert(machines).values({ id, userId: owner, name: `host-${unique()}` });
  return id;
}

/**
 * Inserts a conversation in `project`.
 *
 * @param project - Id of the project it belongs to.
 * @returns The new conversation's id.
 */
async function createConversation(project: string): Promise<string> {
  const id = conversationId();
  await db.insert(conversations).values({ id, projectId: project });
  return id;
}

/**
 * Builds a complete set of fixtures for one test.
 *
 * @returns Ids for a user, a project, a sender, a recipient, a machine and a
 * conversation, all freshly created and shared with nothing else.
 */
async function createContext(): Promise<Context> {
  const owner = await createUser();
  const project = await createProject(owner);
  return {
    owner,
    project,
    sender: await createAgent(owner),
    recipient: await createAgent(owner),
    machine: await createMachine(owner),
    conversation: await createConversation(project),
  };
}

/**
 * Inserts a message, creating a conversation for it if none was given.
 *
 * @param options - The project, sender and recipient it belongs to, plus any
 * field worth varying per test.
 * @returns The new message's id.
 */
async function createMessage(options: {
  readonly project: string;
  readonly sender: string;
  readonly recipient: string;
  readonly conversation?: string;
  readonly content?: string;
  readonly clientMessageId?: string;
  readonly parentMessageId?: string;
}): Promise<string> {
  const id = messageId();
  await db.insert(messages).values({
    id,
    projectId: options.project,
    conversationId: options.conversation ?? (await createConversation(options.project)),
    parentMessageId: options.parentMessageId ?? null,
    senderAgentId: options.sender,
    recipientAgentId: options.recipient,
    content: options.content ?? 'hello',
    clientMessageId: options.clientMessageId ?? `cmid-${unique()}`,
  });
  return id;
}

/**
 * Inserts a session for a context's recipient agent.
 *
 * @param context - The project, agent and machine it runs on.
 * @param overrides - Status and end timestamp, when a test needs them.
 * @returns The new session's id.
 */
async function createSession(
  context: Pick<Context, 'project' | 'recipient' | 'machine'>,
  overrides: { readonly status?: string; readonly endedAt?: Date | null } = {},
): Promise<string> {
  const id = sessionId();
  await db.insert(sessions).values({
    id,
    agentId: context.recipient,
    projectId: context.project,
    machineId: context.machine,
    runtime: 'claude-code',
    workingDirectory: '/tmp/agentchat',
    status: overrides.status ?? 'active',
    endedAt: overrides.endedAt ?? null,
  });
  return id;
}

/**
 * Files a message as pending for a context's recipient.
 *
 * @param message - The message id.
 * @param context - The project and recipient it is owed to.
 */
async function pend(
  message: string,
  context: Pick<Context, 'project' | 'recipient'>,
): Promise<void> {
  await db.insert(messageInbox).values({
    messageId: message,
    agentId: context.recipient,
    projectId: context.project,
  });
}

/**
 * The replay query of §4.3, run for real.
 *
 * @param agent - The agent the listener speaks for.
 * @param project - The project it is listening in.
 * @returns Ids of the messages still pending, oldest first.
 */
async function pendingFor(agent: string, project: string): Promise<string[]> {
  const result = await db.execute<{ id: string }>(sql`
    select m.id from message_inbox i
    join messages m on m.id = i.message_id
    where i.agent_id = ${agent} and i.project_id = ${project} and i.status = 'pending'
    order by i.message_id
  `);
  return result.rows.map((row) => row.id);
}

/**
 * The id the query-plan fixture gives its `n`th message.
 *
 * A fixed-width hex counter in the UUIDv7 positions: valid against
 * `messages_id_format`, and in the same order as the `created_at` the fixture
 * assigns alongside it.
 *
 * @param n - Which seeded message, from 1.
 * @returns Its `msg_` identifier.
 */
function seededMessageId(n: number): string {
  const hex = n.toString(16);
  return `msg_${hex.padStart(8, '0')}-0000-7000-8000-${hex.padStart(12, '0')}`;
}

/**
 * Populates the tables the `EXPLAIN` tests run against, and puts them into the
 * state a live table is in.
 *
 * Enough rows that a sequential scan is genuinely the cheaper plan for anything
 * the indexes do not cover: an assertion that an index was used against a table
 * of twelve rows proves nothing, because Postgres would have scanned it either
 * way. Every table an `EXPLAIN` test touches is therefore seeded to the shape it
 * takes in production — a few thousand messages, a mostly-acked inbox, a session
 * history with one live row in it, and delivery rows for the sessions that got
 * something.
 *
 * The identifiers are built in SQL rather than round-tripped through the driver
 * so this is a handful of statements instead of twelve thousand. `msg_` ids are
 * generated with a fixed-width hex counter in the UUIDv7 positions, which keeps
 * them both valid against the format checks and in the same order as
 * `created_at` — the property the replay ordering depends on.
 */
async function seedForQueryPlans(): Promise<void> {
  const owner = await createUser();
  const project = await createProject(owner);
  const sender = await createAgent(owner);
  const recipient = await createAgent(owner);
  const bystander = await createAgent(owner);
  const machine = await createMachine(owner);

  const conversationIds: string[] = [];
  for (let index = 0; index < PLAN_CONVERSATION_COUNT; index += 1) {
    conversationIds.push(await createConversation(project));
  }
  const firstConversation = conversationIds[0] ?? '';

  const session = sessionId();
  await db.insert(sessions).values({
    id: session,
    agentId: recipient,
    projectId: project,
    machineId: machine,
    runtime: 'codex',
    workingDirectory: '/tmp/agentchat',
  });

  // The session history that one live session is hiding in. Sessions are
  // created per `listen` invocation and only ever moved to `'ended'`, so a table
  // that has been in service for a while is almost entirely ended rows — which
  // is the whole reason `sessions_project_agent_active_idx` is partial, and the
  // only condition under which asserting that the planner reaches for it means
  // anything.
  await db.execute(sql`
    insert into sessions (
      id, agent_id, project_id, machine_id, runtime, working_directory,
      started_at, last_seen_at, ended_at, status
    )
    select
      'ses_' || lpad(to_hex(g), 8, '0') || '-0000-7000-8000-' || lpad(to_hex(g), 12, '0'),
      case when g % 3 = 0 then ${recipient} else ${bystander} end,
      ${project},
      ${machine},
      'codex',
      '/tmp/agentchat',
      now() - (g * interval '1 minute'),
      now() - (g * interval '1 minute'),
      now() - (g * interval '1 minute'),
      'ended'
    from generate_series(1, ${PLAN_SESSION_COUNT}) as g
  `);

  await db.execute(sql`
    insert into messages (
      id, project_id, conversation_id, sender_agent_id, recipient_agent_id,
      content, client_message_id, created_at
    )
    select
      'msg_' || lpad(to_hex(g), 8, '0') || '-0000-7000-8000-' || lpad(to_hex(g), 12, '0'),
      ${project},
      (array[${sql.join(
        conversationIds.map((id) => sql`${id}`),
        sql`, `,
      )}])[1 + (g % ${PLAN_CONVERSATION_COUNT})],
      ${sender},
      case when g % 2 = 0 then ${recipient} else ${bystander} end,
      'seeded message ' || g,
      'cmid-seed-' || g,
      now() - ((${PLAN_MESSAGE_COUNT} - g) * interval '1 second')
    from generate_series(1, ${PLAN_MESSAGE_COUNT}) as g
  `);

  // One inbox row per message, for whichever agent it was addressed to. All but
  // the last few are acked, which is the steady state: the pending set is
  // bounded by how far behind a listener is, and the acked set grows forever.
  //
  // The cut is a string comparison against a whole seeded id, which is the same
  // ordering the replay index relies on — so the fixture is also a small check
  // that `msg_` ids order the way the schema says they do.
  const lastAcked = seededMessageId(PLAN_MESSAGE_COUNT - PENDING_COUNT * 2);
  await db.execute(sql`
    insert into message_inbox (message_id, agent_id, project_id, status, acked_at)
    select
      id, recipient_agent_id, project_id,
      case when id > ${lastAcked} then 'pending' else 'acked' end,
      case when id > ${lastAcked} then null else now() end
    from messages
    where project_id = ${project}
  `);

  // Delivery rows for every message that was ever written to a socket — the
  // acked ones, spread over the seeded session history. The counter-example test
  // asserts that asking `deliveries` the replay question produces a sequential
  // scan; against an empty table that assertion holds for the wrong reason, so
  // the table is filled first.
  await db.execute(sql`
    with delivered as (
      select
        message_id,
        acked_at,
        1 + (row_number() over (order by message_id) % ${PLAN_SESSION_COUNT}) as session_number
      from message_inbox
      where project_id = ${project} and status = 'acked'
    )
    insert into deliveries (message_id, session_id, delivered_at, acked_at)
    select
      message_id,
      'ses_' || lpad(to_hex(session_number), 8, '0')
        || '-0000-7000-8000-' || lpad(to_hex(session_number), 12, '0'),
      acked_at,
      acked_at
    from delivered
  `);

  // `VACUUM`, not just `ANALYZE`, and this is the difference between two of
  // these tests passing and failing.
  //
  // `ANALYZE` collects row statistics; only `VACUUM` sets the visibility map.
  // A table bulk-loaded milliseconds ago has an empty map, so the planner has to
  // assume every index-only scan will visit the heap for every row — which
  // prices the ordered index scan the replay wants out of contention and leaves
  // a bitmap scan plus a sort as the cheaper plan. Any table that has been in
  // service long enough for autovacuum to have visited it does not look like
  // that, and it is that table these assertions are about. Running `VACUUM` here
  // is not tilting the planner: it is declining to test it against a state no
  // production table stays in for more than a few minutes.
  await db.execute(
    sql`vacuum (analyze) messages, message_inbox, sessions, deliveries, conversations`,
  );

  plans.project = project;
  plans.recipient = recipient;
  plans.conversation = firstConversation;
  plans.session = session;
}
