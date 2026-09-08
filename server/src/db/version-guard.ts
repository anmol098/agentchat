/**
 * The schema version guard: refuses to run a server image against a database
 * that a newer image has already migrated (Plan §12.2).
 *
 * ## What "version" means here
 *
 * There is no version column to read. What exists is Drizzle's bookkeeping
 * table, `drizzle.__drizzle_migrations`, whose `created_at` column holds the
 * `when` timestamp of the journal entry that produced each applied migration.
 * Drizzle's own migrator decides what to apply by comparing each bundled
 * migration's `when` against `max(created_at)` in that table and applying
 * everything strictly greater. So `max(created_at)` *is* the schema version,
 * in the only sense the migrator recognises, and it is monotonic because
 * migrations are forward-only.
 *
 * A binary therefore knows exactly one thing about what it should be serving:
 * the highest `when` in the journal bundled inside its own image. Comparing the
 * two numbers is the whole guard.
 *
 * ## Why the comparison has to happen at all
 *
 * Because Drizzle's rule is "apply everything newer than the newest applied
 * row", a database that is ahead produces *no error at all*: the migrator finds
 * nothing to apply and reports success, and the server then serves against
 * tables, columns and constraints it has never heard of. Writes go through the
 * old code's understanding of the schema. That is the silent corruption Plan
 * §12.2 is about, and it is silent precisely because the happy path looks
 * identical.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/** Schema holding Drizzle's migration bookkeeping table. */
export const MIGRATIONS_SCHEMA = 'drizzle';

/** Table in which Drizzle records every migration it has applied. */
export const MIGRATIONS_TABLE = '__drizzle_migrations';

/**
 * The smallest query surface the guard needs.
 *
 * Declared structurally rather than as `pg.Client` so a unit test can hand in a
 * recorded result set, and so this module never decides where its connection
 * comes from.
 */
export interface SchemaQuery {
  /** Runs a statement and returns its rows. */
  query(text: string): Promise<{ rows: Record<string, unknown>[] }>;
}

/** One entry of a Drizzle migration journal. */
export interface BundledMigration {
  /** File stem of the migration, e.g. `0000_identity`. */
  readonly tag: string;
  /** The journal's `when`: epoch milliseconds, and the schema version it sets. */
  readonly when: number;
}

/** Everything the guard knows about the migrations inside this image. */
export interface BundledMigrations {
  /** Directory the journal was read from. */
  readonly folder: string;
  /** Journal entries, ordered oldest first. */
  readonly entries: readonly BundledMigration[];
  /** Highest `when` among the entries, or `null` when the image bundles none. */
  readonly version: number | null;
  /** Tag of the entry that set {@link version}, or `null`. */
  readonly newestTag: string | null;
}

/**
 * Thrown when the migration journal is absent or does not describe migrations
 * this runner can reason about.
 */
export class MigrationJournalError extends Error {
  /** Stable, machine-readable identifier for this failure. */
  public readonly code = 'MIGRATION_JOURNAL_INVALID';

  public constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = 'MigrationJournalError';
  }
}

/**
 * Thrown when the database has been migrated by a newer build than this one.
 *
 * Carries the two versions so a caller can report them without parsing
 * `message`.
 */
export class SchemaAheadError extends Error {
  /** Stable, machine-readable identifier for this failure. */
  public readonly code = 'SCHEMA_AHEAD_OF_BINARY';

  /** `max(created_at)` found in the database. Never `null` when this throws. */
  public readonly databaseVersion: number;

  /** Highest journal `when` bundled in this image, or `null` when none is. */
  public readonly imageVersion: number | null;

  public constructor(message: string, versions: { database: number; image: number | null }) {
    super(message);
    this.name = 'SchemaAheadError';
    this.databaseVersion = versions.database;
    this.imageVersion = versions.image;
  }
}

/** Shape of `meta/_journal.json`, validated rather than trusted. */
const journalSchema = z.object({
  entries: z.array(
    z.object({
      tag: z.string().min(1),
      when: z.number().int().nonnegative(),
    }),
  ),
});

/**
 * Reads the migration journal bundled beside this image's SQL files.
 *
 * @param folder - Directory holding `meta/_journal.json` and the `.sql` files.
 * @returns The journal's entries and the schema version they add up to.
 * @throws {MigrationJournalError} If the journal is missing, unreadable, not
 * JSON, or does not match the shape Drizzle writes.
 */
export function readBundledMigrations(folder: string): BundledMigrations {
  const journalPath = join(folder, 'meta', '_journal.json');

  let raw: string;
  try {
    raw = readFileSync(journalPath, 'utf8');
  } catch (cause) {
    throw new MigrationJournalError(
      `No migration journal at ${journalPath}. The migrations directory is chosen with ` +
        '--migrations or MIGRATIONS_DIR; inside the server image it is /app/server/drizzle.',
      { cause },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new MigrationJournalError(`${journalPath} is not valid JSON.`, { cause });
  }

  const result = journalSchema.safeParse(parsed);
  if (!result.success) {
    throw new MigrationJournalError(
      `${journalPath} is not a Drizzle migration journal: ` +
        result.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; '),
    );
  }

  // Sorted rather than trusted to be ordered: the version is a maximum, and a
  // journal hand-edited into the wrong order must not change what it is.
  const entries = [...result.data.entries].sort((left, right) => left.when - right.when);
  const newest = entries.at(-1);

  return {
    folder,
    entries,
    version: newest?.when ?? null,
    newestTag: newest?.tag ?? null,
  };
}

/**
 * Reads the schema version recorded in the database.
 *
 * @param client - Connection to query. Needs only `SELECT`.
 * @returns `max(created_at)` from Drizzle's bookkeeping table, or `null` when
 * no migration has ever been applied — an empty database, or one whose
 * `drizzle` schema does not exist yet. The two cases are deliberately not
 * distinguished: both mean "this database is at version zero".
 * @throws Whatever `pg` throws for a failure that is not a missing table.
 */
export async function readDatabaseSchemaVersion(client: SchemaQuery): Promise<number | null> {
  // `to_regclass` answers with NULL instead of raising 42P01 for a table that
  // does not exist, so the fresh-database case costs no error handling and
  // cannot be confused with a permissions failure that happens to look similar.
  const existence = await client.query(
    `select to_regclass('${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}') is not null as present`,
  );

  if (existence.rows[0]?.['present'] !== true) {
    return null;
  }

  const result = await client.query(
    `select max(created_at) as version from ${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`,
  );

  const version = result.rows[0]?.['version'];

  // `created_at` is `bigint`, which node-postgres returns as a string so no
  // precision is lost. Epoch milliseconds are far inside Number's exact integer
  // range, so converting here is safe and keeps the rest of the code arithmetic
  // rather than BigInt.
  if (version === null || version === undefined) {
    return null;
  }

  const parsed = Number(version);
  if (!Number.isSafeInteger(parsed)) {
    throw new MigrationJournalError(
      `${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}.created_at holds ${String(version)}, ` +
        'which is not a usable millisecond timestamp.',
    );
  }

  return parsed;
}

/**
 * Renders a schema version the way an operator should quote it.
 *
 * Both forms are printed: the raw number is what the database stores and what a
 * support conversation can compare exactly, the ISO date is what tells a human
 * which release they are looking at.
 */
export function describeSchemaVersion(version: number | null): string {
  if (version === null) {
    return 'none (no migration has been applied)';
  }

  return `${version} (${new Date(version).toISOString()})`;
}

/** Inputs to {@link assertSchemaNotAhead}. */
export interface SchemaGuardInput {
  /** Version read from the database, from {@link readDatabaseSchemaVersion}. */
  readonly databaseVersion: number | null;
  /** Migrations bundled in this image, from {@link readBundledMigrations}. */
  readonly bundled: BundledMigrations;
}

/**
 * Refuses a database that is ahead of the migrations bundled in this image.
 *
 * @param input - See {@link SchemaGuardInput}.
 * @throws {SchemaAheadError} If the database's schema version is greater than
 * this image's. The message names both versions and the newest migration this
 * image contains, so the operator can pick the release to run.
 */
export function assertSchemaNotAhead(input: SchemaGuardInput): void {
  const { databaseVersion, bundled } = input;

  if (databaseVersion === null) {
    return;
  }

  const imageVersion = bundled.version;
  if (imageVersion !== null && databaseVersion <= imageVersion) {
    return;
  }

  const knownThrough =
    bundled.newestTag === null
      ? '    this image bundles no migrations at all'
      : `    this image knows through: ${describeSchemaVersion(imageVersion)}, tag ${bundled.newestTag}`;

  throw new SchemaAheadError(
    [
      'Refusing to start: the database schema is newer than this server image.',
      '',
      `    database schema version:  ${describeSchemaVersion(databaseVersion)}`,
      knownThrough,
      '',
      'A newer AgentChat version migrated this database. Migrations are forward-only,',
      'so this image cannot vouch for the schema it would be serving: the migrator',
      'would find nothing to apply and report success, and the server would then run',
      'against tables and constraints it does not know exist.',
      '',
      `Run a server image whose bundled migrations reach schema version ${databaseVersion}`,
      'or later — that is the version this database was upgraded to. If you are',
      'deliberately rolling back to this release, check its upgrade notes (a rollback',
      'across one minor version is supported by design, Plan §12.3) and then set',
      'AGENTCHAT_ALLOW_SCHEMA_AHEAD=true to proceed with your eyes open.',
    ].join('\n'),
    { database: databaseVersion, image: imageVersion },
  );
}
