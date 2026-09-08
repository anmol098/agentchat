/**
 * The identity schema, tested through PostgreSQL rather than through the code
 * that talks to it.
 *
 * Every assertion here is about something the database enforces: a unique
 * index, a foreign key's delete action, a check constraint. An application-level
 * test of the same rules would only prove that this file and the service layer
 * agree, which is not the property anybody needs — the point of a constraint is
 * that it holds for the query somebody writes in six months, in a migration, or
 * by hand in `psql`.
 *
 * It lives in this subdirectory rather than beside `identity.ts` because
 * `drizzle.config.ts` treats every `*.ts` file directly under
 * `src/db/schema/` as a model and executes it during `db:generate`; a test
 * file there breaks migration generation outright. The glob does not descend,
 * so schema tests belong here. T-102 and T-301 should do the same.
 *
 * The suite owns a **freshly created database** rather than the one
 * `DATABASE_URL` points at. That buys three things: the migration is genuinely
 * applied to an empty database, as an operator's first boot will apply it;
 * `DROP`/`CREATE` here cannot disturb another suite's rows (integration tests
 * share one server, see `vitest.config.ts`); and the whole thing disappears
 * afterwards.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { projectInvites, projectMembers, projects, refreshTokens, users } from '../identity.js';

/** The generated SQL migrations, exactly as the server image will ship them. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../../drizzle', import.meta.url));

const schema = { users, projects, projectMembers, projectInvites, refreshTokens };

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
/**
 * Postgres `restrict_violation` — what `ON DELETE RESTRICT` raises.
 *
 * `NO ACTION`, the default action Drizzle would emit if `onDelete` were left
 * off, raises the more general `foreign_key_violation` (23503) instead. Pinning
 * this code is therefore how these tests prove the restriction is deliberate
 * rather than inherited.
 */
const RESTRICT_VIOLATION = '23001';
/** Postgres `check_violation`. */
const CHECK_VIOLATION = '23514';

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
 * chain rather than looking only at the value it was handed. Asserting on the
 * wrapper's message instead would be asserting on the query builder's output,
 * which is not what is under test.
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
 * string of exactly the shape the schema's format checks accept. It is not
 * time-ordered, and nothing here depends on that — ordering is the protocol
 * package's property to guarantee and its own tests' to prove. What matters
 * here is that these are well-formed identifiers and that each call returns a
 * different one.
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
/** A fresh `inv_` identifier. */
const inviteId = (): string => `inv_${uuidv7Shaped()}`;

/** A distinct 64-character lowercase hex string, the shape of a SHA-256 digest. */
const tokenHash = (): string => `${randomUUID()}${randomUUID()}`.replaceAll('-', '');

/** A short unique suffix for names that must not collide between runs. */
const unique = (): string => randomUUID().replaceAll('-', '').slice(0, 12);

/** Ninety days from now, the refresh-token TTL of Plan §7. */
const inNinetyDays = (): Date => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

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
/** Rows in Drizzle's ledger after the first run and after the second. */
let ledgerRowsAfterFirstRun: number;
let ledgerRowsAfterSecondRun: number;
/** A row inserted between the two runs, re-read after the second. */
let survivorUsername: string | undefined;

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

/**
 * Counts the migrations Drizzle has recorded as applied.
 *
 * @returns The number of rows in Drizzle's ledger, or `-1` if it could not be
 * read, so a broken query fails an assertion rather than passing one.
 */
async function ledgerRows(): Promise<number> {
  const ledger = await db.execute<{ count: string }>(
    sql`select count(*)::text as count from drizzle.__drizzle_migrations`,
  );
  return Number(ledger.rows[0]?.count ?? '-1');
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
  databaseName = `agentchat_t101_${unique()}`;

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`create database "${databaseName}"`);
  } finally {
    await admin.end();
  }

  pool = new Pool({ connectionString: urlForScratchDatabase(databaseName) });
  db = drizzle(pool, { schema });

  // The whole migration story, recorded once so the tests below can assert on
  // it in any order: empty, migrated, migrated again.
  tablesBeforeMigration = await tableNames(db);

  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  tablesAfterMigration = await tableNames(db);
  fingerprintAfterFirstRun = await fingerprint(db);
  ledgerRowsAfterFirstRun = await ledgerRows();

  // A row written between the runs: if the second run were to re-execute
  // `CREATE TABLE` — or anything destructive — this would not come back.
  survivorUsername = `survivor-${unique()}`;
  await db.insert(users).values({
    id: userId(),
    githubId: `gh-${unique()}`,
    username: survivorUsername,
    displayName: 'Survivor',
  });

  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  fingerprintAfterSecondRun = await fingerprint(db);

  ledgerRowsAfterSecondRun = await ledgerRows();
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

describe('the identity migration', () => {
  it('applies to a genuinely empty database', () => {
    expect(tablesBeforeMigration).toEqual([]);
    // A superset, not an exact list: `migrate` applies every committed
    // migration, so later ones legitimately add tables this suite knows nothing
    // about (T-102 added `agents` and `agent_projects`). What this test is for
    // is that the identity tables exist after migrating a database that started
    // with nothing in it, which is unaffected by whatever follows them.
    expect(tablesAfterMigration).toEqual(
      expect.arrayContaining([
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
    // ...Drizzle's ledger did not grow, whatever it held after the first run
    // (one row per committed migration, so the number climbs as tasks land)...
    expect(ledgerRowsAfterSecondRun).toBe(ledgerRowsAfterFirstRun);
    // ...and the row written between the two runs is still there.
    const survivors = await db
      .select({ username: users.username })
      .from(users)
      .where(sql`${users.username} = ${survivorUsername}`);
    expect(survivors).toHaveLength(1);
  });
});

describe('unique constraints', () => {
  it('rejects a second user with the same github_id', async () => {
    const githubId = `gh-${unique()}`;
    await db.insert(users).values({
      id: userId(),
      githubId,
      username: `a-${unique()}`,
      displayName: 'First',
    });

    const failure = await rejection(() =>
      db.insert(users).values({
        id: userId(),
        githubId,
        username: `b-${unique()}`,
        displayName: 'Second',
      }),
    );

    expect(failure.code).toBe(UNIQUE_VIOLATION);
    expect(failure.constraint).toBe('users_github_id_unique');
  });

  it('rejects a second user with the same username', async () => {
    const username = `dup-${unique()}`;
    await db.insert(users).values({
      id: userId(),
      githubId: `gh-${unique()}`,
      username,
      displayName: 'First',
    });

    const failure = await rejection(() =>
      db.insert(users).values({
        id: userId(),
        githubId: `gh-${unique()}`,
        username,
        displayName: 'Second',
      }),
    );

    expect(failure.code).toBe(UNIQUE_VIOLATION);
    expect(failure.constraint).toBe('users_username_unique');
  });

  it('rejects a second project with the same slug', async () => {
    const owner = await createUser();
    const slug = `slug-${unique()}`;

    await db.insert(projects).values({ id: projectId(), slug, name: 'First', createdBy: owner });

    const failure = await rejection(() =>
      db.insert(projects).values({ id: projectId(), slug, name: 'Second', createdBy: owner }),
    );

    expect(failure.code).toBe(UNIQUE_VIOLATION);
    expect(failure.constraint).toBe('projects_slug_unique');
  });

  it('rejects a second invite with the same code', async () => {
    const owner = await createUser();
    const project = await createProject(owner);
    const code = `AAAA-${unique().toUpperCase().slice(0, 4)}-ZZZZ`;

    await db.insert(projectInvites).values({
      id: inviteId(),
      projectId: project,
      code,
      createdBy: owner,
      expiresAt: inNinetyDays(),
    });

    const failure = await rejection(() =>
      db.insert(projectInvites).values({
        id: inviteId(),
        projectId: project,
        code,
        createdBy: owner,
        expiresAt: inNinetyDays(),
      }),
    );

    expect(failure.code).toBe(UNIQUE_VIOLATION);
    expect(failure.constraint).toBe('project_invites_code_unique');
  });

  it('rejects a second refresh token with the same hash', async () => {
    const owner = await createUser();
    const hash = tokenHash();

    await db
      .insert(refreshTokens)
      .values({ userId: owner, tokenHash: hash, expiresAt: inNinetyDays() });

    const failure = await rejection(() =>
      db
        .insert(refreshTokens)
        .values({ userId: owner, tokenHash: hash, expiresAt: inNinetyDays() }),
    );

    expect(failure.code).toBe(UNIQUE_VIOLATION);
    expect(failure.constraint).toBe('refresh_tokens_token_hash_unique');
  });
});

describe('deleting a project', () => {
  it('removes its memberships and invites', async () => {
    const owner = await createUser();
    const member = await createUser();
    const project = await createProject(owner);

    await db.insert(projectMembers).values([
      { projectId: project, userId: owner, role: 'owner' },
      { projectId: project, userId: member, role: 'member' },
    ]);
    await db.insert(projectInvites).values({
      id: inviteId(),
      projectId: project,
      code: `INVT-${unique().toUpperCase().slice(0, 4)}-CODE`,
      createdBy: owner,
      expiresAt: inNinetyDays(),
    });

    await db.delete(projects).where(sql`${projects.id} = ${project}`);

    const remainingMembers = await db
      .select()
      .from(projectMembers)
      .where(sql`${projectMembers.projectId} = ${project}`);
    const remainingInvites = await db
      .select()
      .from(projectInvites)
      .where(sql`${projectInvites.projectId} = ${project}`);

    expect(remainingMembers).toEqual([]);
    expect(remainingInvites).toEqual([]);
  });

  it('leaves the people and their credentials untouched', async () => {
    // The rule the cascade design exists to protect: losing a project must
    // never log anybody out or delete an account. There is deliberately no path
    // from `projects` to `users` or to `refresh_tokens`.
    const owner = await createUser();
    const member = await createUser();
    const project = await createProject(owner);
    await db.insert(projectMembers).values([
      { projectId: project, userId: owner, role: 'owner' },
      { projectId: project, userId: member, role: 'member' },
    ]);

    const hash = tokenHash();
    await db
      .insert(refreshTokens)
      .values({ userId: member, tokenHash: hash, expiresAt: inNinetyDays() });

    // The creator's FK is RESTRICT, so the project must be emptied of its
    // creator reference by deleting the project itself, not the user.
    await db.delete(projects).where(sql`${projects.id} = ${project}`);

    const survivingUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`${users.id} in (${owner}, ${member})`);
    const survivingTokens = await db
      .select({ tokenHash: refreshTokens.tokenHash })
      .from(refreshTokens)
      .where(sql`${refreshTokens.tokenHash} = ${hash}`);

    expect(survivingUsers).toHaveLength(2);
    expect(survivingTokens).toHaveLength(1);
  });
});

describe('deleting a user', () => {
  it('takes their memberships and every refresh token with it', async () => {
    const owner = await createUser();
    const leaver = await createUser();
    const project = await createProject(owner);

    await db.insert(projectMembers).values({ projectId: project, userId: leaver, role: 'member' });
    const hash = tokenHash();
    await db
      .insert(refreshTokens)
      .values({ userId: leaver, tokenHash: hash, expiresAt: inNinetyDays() });

    await db.delete(users).where(sql`${users.id} = ${leaver}`);

    const memberships = await db
      .select()
      .from(projectMembers)
      .where(sql`${projectMembers.userId} = ${leaver}`);
    const tokens = await db
      .select()
      .from(refreshTokens)
      .where(sql`${refreshTokens.tokenHash} = ${hash}`);

    // A credential that outlived its account would be a way back in.
    expect(memberships).toEqual([]);
    expect(tokens).toEqual([]);
  });

  it('is refused while they still own a project', async () => {
    const owner = await createUser();
    await createProject(owner);

    const failure = await rejection(() => db.delete(users).where(sql`${users.id} = ${owner}`));

    expect(failure.code).toBe(RESTRICT_VIOLATION);
    expect(failure.constraint).toBe('projects_created_by_users_id_fk');
  });

  it('is refused while an invite they issued still exists', async () => {
    const owner = await createUser();
    const inviter = await createUser();
    const project = await createProject(owner);

    await db.insert(projectInvites).values({
      id: inviteId(),
      projectId: project,
      code: `KEEP-${unique().toUpperCase().slice(0, 4)}-CODE`,
      createdBy: inviter,
      expiresAt: inNinetyDays(),
    });

    const failure = await rejection(() => db.delete(users).where(sql`${users.id} = ${inviter}`));

    expect(failure.code).toBe(RESTRICT_VIOLATION);
    expect(failure.constraint).toBe('project_invites_created_by_users_id_fk');
  });
});

describe('check constraints', () => {
  it('refuses an identifier carrying another kind of prefix', async () => {
    // The safety net that makes storing prefixed ids in `text` safe: a
    // well-formed agent id is still not a user id.
    const failure = await rejection(() =>
      db.insert(users).values({
        id: `agt_${uuidv7Shaped()}`,
        githubId: `gh-${unique()}`,
        username: `x-${unique()}`,
        displayName: 'Wrong kind',
      }),
    );

    expect(failure.code).toBe(CHECK_VIOLATION);
    expect(failure.constraint).toBe('users_id_format');
  });

  it('refuses a username that is not lowercase', async () => {
    const failure = await rejection(() =>
      db.insert(users).values({
        id: userId(),
        githubId: `gh-${unique()}`,
        username: 'Alice',
        displayName: 'Alice',
      }),
    );

    expect(failure.code).toBe(CHECK_VIOLATION);
    expect(failure.constraint).toBe('users_username_format');
  });

  it('refuses a refresh token that is not a SHA-256 digest', async () => {
    const owner = await createUser();

    // 32 bytes of base64url — what a plaintext refresh token actually looks
    // like. The column will not take it.
    const failure = await rejection(() =>
      db.insert(refreshTokens).values({
        userId: owner,
        tokenHash: 'dGhpcy1pcy1hLXBsYWludGV4dC10b2tlbi1ub3QtYS1oYXNo',
        expiresAt: inNinetyDays(),
      }),
    );

    expect(failure.code).toBe(CHECK_VIOLATION);
    expect(failure.constraint).toBe('refresh_tokens_token_hash_is_sha256');
  });

  it('refuses a role outside the two the plan defines', async () => {
    const owner = await createUser();
    const project = await createProject(owner);

    const failure = await rejection(() =>
      db.insert(projectMembers).values({ projectId: project, userId: owner, role: 'admin' }),
    );

    expect(failure.code).toBe(CHECK_VIOLATION);
    expect(failure.constraint).toBe('project_members_role_valid');
  });

  it('refuses a machine id that is not a machine id', async () => {
    // `machine_id` has no foreign key until T-301 creates `machines`. Until
    // then this check is the only thing keeping the column honest.
    const owner = await createUser();

    const failure = await rejection(() =>
      db.insert(refreshTokens).values({
        userId: owner,
        tokenHash: tokenHash(),
        expiresAt: inNinetyDays(),
        machineId: `usr_${uuidv7Shaped()}`,
      }),
    );

    expect(failure.code).toBe(CHECK_VIOLATION);
    expect(failure.constraint).toBe('refresh_tokens_machine_id_format');
  });

  it('accepts a well-formed machine id, so T-301 can add the foreign key', async () => {
    const owner = await createUser();
    await db.insert(refreshTokens).values({
      userId: owner,
      tokenHash: tokenHash(),
      expiresAt: inNinetyDays(),
      machineId: `mch_${uuidv7Shaped()}`,
    });
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
