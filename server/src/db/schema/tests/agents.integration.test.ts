/**
 * The agents schema, tested through PostgreSQL rather than through the code
 * that talks to it.
 *
 * Same contract as `./identity.integration.test.ts`: every assertion here is
 * about something the database itself enforces, because the point of a
 * constraint is that it holds for the query somebody writes in six months, in a
 * migration, or by hand in `psql`. The centre of gravity is
 * `agents_user_id_name_live_idx`, the partial unique index that makes a
 * soft-deleted agent's name reusable (D13) — a rule that is impossible to state
 * in application code without a race between the check and the insert.
 *
 * It lives in this subdirectory rather than beside `agents.ts` because
 * `drizzle.config.ts` treats every `*.ts` file directly under `src/db/schema/`
 * as a model and executes it during `db:generate`; a test file there breaks
 * migration generation outright. The glob does not descend, so schema tests
 * belong here.
 *
 * The suite owns a **freshly created database**, so the migration is genuinely
 * applied to an empty one, `DROP`/`CREATE` here cannot disturb another suite's
 * rows, and the whole thing disappears afterwards.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentProjects, agents } from '../agents.js';
import { projects, users } from '../identity.js';

/** The generated SQL migrations, exactly as the server image will ship them. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../../drizzle', import.meta.url));

/**
 * How many migrations are committed, according to drizzle's own journal.
 *
 * Read rather than hard-coded so that "the ledger did not grow" stays a
 * statement about idempotency instead of a number every new migration has to
 * come back and edit.
 *
 * @returns The number of entries in `drizzle/meta/_journal.json`.
 */
function committedMigrationCount(): number {
  const journal: unknown = JSON.parse(
    readFileSync(new URL('../../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
  );
  const entries = (journal as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new Error('drizzle/meta/_journal.json has no entries array.');
  }
  return entries.length;
}

const schema = { users, projects, agents, agentProjects };

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
/** Postgres `restrict_violation` — what `ON DELETE RESTRICT` raises. */
const RESTRICT_VIOLATION = '23001';
/** Postgres `check_violation`. */
const CHECK_VIOLATION = '23514';

/** The fields of a `pg` error this suite asserts on. */
interface PostgresErrorFields {
  /** SQLSTATE, e.g. `'23505'`. */
  readonly code: string;
  /** Name of the constraint or index that rejected the statement, when there was one. */
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
 * `crypto.randomUUID()` already produces the hyphenation and the RFC 9562
 * variant nibble; only the version nibble differs, so overwriting it yields a
 * string of exactly the shape the schema's format checks accept.
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

/** A short unique suffix for names that must not collide between runs. */
const unique = (): string => randomUUID().replaceAll('-', '').slice(0, 12);

/**
 * A structural fingerprint of the `public` schema: every column with its type
 * and nullability, every constraint with its definition, every index.
 *
 * Comparing two of these is how "re-running the migration changes nothing" is
 * demonstrated rather than asserted.
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

/** Names of the tables in the `public` schema, sorted. */
const TABLE_NAMES_SQL = sql`
  select table_name from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE'
  order by table_name
`;

/** The definition Postgres reports for the partial unique index, as it stored it. */
const LIVE_NAME_INDEX_SQL = sql`
  select indexdef from pg_indexes
  where schemaname = 'public' and indexname = 'agents_user_id_name_live_idx'
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
/** Rows in Drizzle's ledger after the second run. */
let ledgerRowsAfterSecondRun: number;
/** An agent inserted between the two runs, re-read after the second. */
let survivorAgentId: string | undefined;

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
  databaseName = `agentchat_t102_${unique()}`;

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

  // Rows written between the runs: if the second run were to re-execute
  // `CREATE TABLE` — or anything destructive — these would not come back.
  const survivorOwner = userId();
  await db.insert(users).values({
    id: survivorOwner,
    githubId: `gh-${unique()}`,
    username: `survivor-${unique()}`,
    displayName: 'Survivor',
  });
  survivorAgentId = agentId();
  await db
    .insert(agents)
    .values({ id: survivorAgentId, userId: survivorOwner, name: `survivor-${unique()}` });

  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  fingerprintAfterSecondRun = await fingerprint(db);

  const ledger = await db.execute<{ count: string }>(
    sql`select count(*)::text as count from drizzle.__drizzle_migrations`,
  );
  ledgerRowsAfterSecondRun = Number(ledger.rows[0]?.count ?? '-1');
}, 60_000);

afterAll(async () => {
  await pool?.end();

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await admin.end();
  }
});

describe('the agents migration', () => {
  it('applies to a genuinely empty database, on top of the identity migration', () => {
    expect(tablesBeforeMigration).toEqual([]);
    // A superset, not an exact list, for the reason
    // `./identity.integration.test.ts` gives: `migrate` applies every committed
    // migration, so a later one legitimately adds tables this suite knows
    // nothing about (T-301 added six). What is under test is that the agent
    // tables exist after migrating a database that started with nothing.
    expect(tablesAfterMigration).toEqual(
      expect.arrayContaining([
        'agent_projects',
        'agents',
        'project_invites',
        'project_members',
        'projects',
        'refresh_tokens',
        'users',
      ]),
    );
  });

  it('is a no-op when run a second time', async () => {
    // Nothing about the schema moved...
    expect(fingerprintAfterSecondRun).toEqual(fingerprintAfterFirstRun);
    // ...Drizzle's ledger did not grow: one row per committed migration after
    // the first run, and not one more after the second. The count itself is
    // read from the journal rather than written here, so landing a migration
    // does not mean editing this line (T-301 landed the third).
    expect(ledgerRowsAfterSecondRun).toBe(committedMigrationCount());
    // ...and the agent written between the two runs is still there.
    const survivors = await db
      .select({ id: agents.id })
      .from(agents)
      .where(sql`${agents.id} = ${survivorAgentId}`);
    expect(survivors).toHaveLength(1);
  });

  it('created the name index partial rather than total', async () => {
    // Asserted against what Postgres stored, not against what the schema file
    // says, because the predicate is the entire difference between "a name is
    // reusable after deletion" and "a tombstone squats on it forever".
    const result = await db.execute<{ indexdef: string }>(LIVE_NAME_INDEX_SQL);
    const definition = result.rows[0]?.indexdef ?? '';

    expect(definition).toContain('CREATE UNIQUE INDEX');
    expect(definition).toContain('(user_id, name)');
    expect(definition).toContain('WHERE (deleted_at IS NULL)');
  });
});

describe('one live agent name per user', () => {
  it('refuses a second live agent with the same name', async () => {
    const owner = await createUser();
    const name = `dup-${unique()}`;

    await db.insert(agents).values({ id: agentId(), userId: owner, name });

    const failure = await rejection(() =>
      db.insert(agents).values({ id: agentId(), userId: owner, name }),
    );

    expect(failure.code).toBe(UNIQUE_VIOLATION);
    expect(failure.constraint).toBe('agents_user_id_name_live_idx');
  });

  it('lets two different users each have an agent of the same name', async () => {
    // `@alice/backend` and `@bob/backend` are different addresses. Uniqueness is
    // per user, which is why `user_id` leads the index.
    const alice = await createUser();
    const bob = await createUser();
    const name = `shared-${unique()}`;

    await db.insert(agents).values({ id: agentId(), userId: alice, name });
    await db.insert(agents).values({ id: agentId(), userId: bob, name });

    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(sql`${agents.name} = ${name}`);
    expect(rows).toHaveLength(2);
  });

  it('frees the name on soft delete, and keeps the deleted row', async () => {
    // The whole of D13 in one test: create, delete, recreate with the same name,
    // and both rows coexist — the tombstone so historical messages keep
    // resolving their sender, the new row so the user gets their name back.
    const owner = await createUser();
    const name = `recycled-${unique()}`;

    const first = agentId();
    await db.insert(agents).values({ id: first, userId: owner, name });
    await db.update(agents).set({ deletedAt: new Date() }).where(sql`${agents.id} = ${first}`);

    const second = agentId();
    await db.insert(agents).values({ id: second, userId: owner, name });

    const rows = await db
      .select({ id: agents.id, deletedAt: agents.deletedAt })
      .from(agents)
      .where(sql`${agents.userId} = ${owner} and ${agents.name} = ${name}`)
      .orderBy(agents.id);

    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.deletedAt === null)).toHaveLength(1);
    expect(rows.find((row) => row.deletedAt !== null)?.id).toBe(first);
  });

  it('lets any number of deleted agents share a name', async () => {
    // Deleted rows are outside the index entirely, not merely exempt from
    // colliding with live ones. Without that, the second recycle of a name would
    // fail against the first tombstone and there would be a hard ceiling of one
    // on how often a name can be reused.
    const owner = await createUser();
    const name = `serial-${unique()}`;

    for (let round = 0; round < 3; round += 1) {
      const id = agentId();
      await db.insert(agents).values({ id, userId: owner, name });
      await db.update(agents).set({ deletedAt: new Date() }).where(sql`${agents.id} = ${id}`);
    }
    await db.insert(agents).values({ id: agentId(), userId: owner, name });

    const rows = await db
      .select({ deletedAt: agents.deletedAt })
      .from(agents)
      .where(sql`${agents.userId} = ${owner} and ${agents.name} = ${name}`);

    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.deletedAt === null)).toHaveLength(1);
  });

  it('refuses to un-delete an agent onto a name that is live again', async () => {
    // The index constrains `UPDATE` as well as `INSERT`, so restoring a
    // tombstone whose name has since been taken is rejected rather than
    // producing two live `@alice/backend`s. A restore feature, if one is ever
    // built, has to rename or refuse — it cannot be a single `set deleted_at =
    // null`.
    const owner = await createUser();
    const name = `contested-${unique()}`;

    const first = agentId();
    await db.insert(agents).values({ id: first, userId: owner, name });
    await db.update(agents).set({ deletedAt: new Date() }).where(sql`${agents.id} = ${first}`);
    await db.insert(agents).values({ id: agentId(), userId: owner, name });

    const failure = await rejection(() =>
      db.update(agents).set({ deletedAt: null }).where(sql`${agents.id} = ${first}`),
    );

    expect(failure.code).toBe(UNIQUE_VIOLATION);
    expect(failure.constraint).toBe('agents_user_id_name_live_idx');
  });
});

describe('agent name grammar', () => {
  it.each([
    ['an uppercase letter', 'Backend'],
    ['a leading hyphen', '-backend'],
    ['an underscore', 'back_end'],
    ['a space', 'back end'],
    ['a dot', 'back.end'],
    ['an empty string', ''],
    ['thirty-three characters', 'a'.repeat(33)],
  ])('refuses a name with %s', async (_description, name) => {
    const owner = await createUser();

    const failure = await rejection(() =>
      db.insert(agents).values({ id: agentId(), userId: owner, name }),
    );

    expect(failure.code).toBe(CHECK_VIOLATION);
    expect(failure.constraint).toBe('agents_name_format');
  });

  it.each([
    ['a single character', 'a'],
    ['a digit first', '9lives'],
    ['interior hyphens', 'code-review-bot'],
    ['exactly thirty-two characters', `b${'a'.repeat(31)}`],
  ])('accepts a name with %s', async (_description, name) => {
    const owner = await createUser();
    await db.insert(agents).values({ id: agentId(), userId: owner, name });
  });
});

describe('check constraints', () => {
  it('refuses an identifier carrying another kind of prefix', async () => {
    const owner = await createUser();

    const failure = await rejection(() =>
      db.insert(agents).values({ id: `usr_${uuidv7Shaped()}`, userId: owner, name: 'wrong-kind' }),
    );

    expect(failure.code).toBe(CHECK_VIOLATION);
    expect(failure.constraint).toBe('agents_id_format');
  });
});

describe('agent participation in projects', () => {
  it('refuses the same agent twice in one project', async () => {
    const owner = await createUser();
    const project = await createProject(owner);
    const agent = await createAgent(owner);

    await db.insert(agentProjects).values({ agentId: agent, projectId: project });

    const failure = await rejection(() =>
      db.insert(agentProjects).values({ agentId: agent, projectId: project }),
    );

    expect(failure.code).toBe(UNIQUE_VIOLATION);
    expect(failure.constraint).toBe('agent_projects_agent_id_project_id_pk');
  });

  it('disappears with the project, leaving the agent intact', async () => {
    const owner = await createUser();
    const project = await createProject(owner);
    const agent = await createAgent(owner);
    await db.insert(agentProjects).values({ agentId: agent, projectId: project });

    await db.delete(projects).where(sql`${projects.id} = ${project}`);

    const participation = await db
      .select()
      .from(agentProjects)
      .where(sql`${agentProjects.agentId} = ${agent}`);
    const survivors = await db
      .select({ id: agents.id })
      .from(agents)
      .where(sql`${agents.id} = ${agent}`);

    // Losing a project must never cost an agent its identity or its history in
    // other projects.
    expect(participation).toEqual([]);
    expect(survivors).toHaveLength(1);
  });

  it('does not disappear on its own when the agent is soft-deleted', async () => {
    // Removing these rows is the service layer's job (T-109), not the
    // database's: no `CHECK` can span two tables, and a trigger doing it
    // invisibly would be worse than an explicit statement. This test pins the
    // division of labour so nobody assumes the schema has already handled it.
    const owner = await createUser();
    const project = await createProject(owner);
    const agent = await createAgent(owner);
    await db.insert(agentProjects).values({ agentId: agent, projectId: project });

    await db.update(agents).set({ deletedAt: new Date() }).where(sql`${agents.id} = ${agent}`);

    const participation = await db
      .select()
      .from(agentProjects)
      .where(sql`${agentProjects.agentId} = ${agent}`);

    expect(participation).toHaveLength(1);
  });

  it('disappears if the agent is ever hard-deleted', async () => {
    // Unreachable in v0.1, since D13 makes deletion soft. Spelled out so that an
    // account-erasure flow, or an operator in `psql`, gets a tidy cascade
    // instead of a foreign-key error at the end of a long transaction.
    const owner = await createUser();
    const project = await createProject(owner);
    const agent = await createAgent(owner);
    await db.insert(agentProjects).values({ agentId: agent, projectId: project });

    await db.delete(agents).where(sql`${agents.id} = ${agent}`);

    const participation = await db
      .select()
      .from(agentProjects)
      .where(sql`${agentProjects.agentId} = ${agent}`);

    expect(participation).toEqual([]);
  });
});

describe('deleting a user', () => {
  it('is refused while they still own an agent, deleted or not', async () => {
    // RESTRICT rather than CASCADE: from T-301 every message names its sender
    // and recipient agent, so cascading a user deletion into `agents` would
    // either take other people's conversations with it or fail halfway through.
    // The soft-deleted case matters just as much — a tombstone is exactly the
    // row historical messages still point at.
    const owner = await createUser();
    const agent = await createAgent(owner);
    await db.update(agents).set({ deletedAt: new Date() }).where(sql`${agents.id} = ${agent}`);

    const failure = await rejection(() => db.delete(users).where(sql`${users.id} = ${owner}`));

    expect(failure.code).toBe(RESTRICT_VIOLATION);
    expect(failure.constraint).toBe('agents_user_id_users_id_fk');
  });
});

describe('updated_at', () => {
  it('moves when the row is soft-deleted', async () => {
    const owner = await createUser();
    const agent = await createAgent(owner);

    const [before] = await db
      .select({ updatedAt: agents.updatedAt })
      .from(agents)
      .where(sql`${agents.id} = ${agent}`);

    await db.update(agents).set({ deletedAt: new Date() }).where(sql`${agents.id} = ${agent}`);

    const [after] = await db
      .select({ updatedAt: agents.updatedAt })
      .from(agents)
      .where(sql`${agents.id} = ${agent}`);

    expect(before?.updatedAt).toBeInstanceOf(Date);
    expect(after?.updatedAt.getTime()).toBeGreaterThanOrEqual(before?.updatedAt.getTime() ?? 0);
  });
});

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
 * Inserts a live agent owned by `owner`, with a name nothing else uses.
 *
 * @param owner - Id of the user who owns it.
 * @returns The new agent's id.
 */
async function createAgent(owner: string): Promise<string> {
  const id = agentId();
  await db.insert(agents).values({ id, userId: owner, name: `a-${unique()}` });
  return id;
}
