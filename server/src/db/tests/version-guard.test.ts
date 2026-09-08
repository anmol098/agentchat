/**
 * The version guard, tested without a database.
 *
 * Reading the journal and comparing two numbers are pure operations, and the
 * comparison is the part that decides whether a server boots. It gets a table
 * of cases rather than a happy path.
 *
 * These live in `src/db/tests/` for the reason the identity schema tests give:
 * `drizzle.config.ts` treats files directly under `src/db/schema/` as models,
 * and keeping every `src/db` test in one place beneath its own directory keeps
 * that from ever mattering again.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  assertSchemaNotAhead,
  type BundledMigrations,
  describeSchemaVersion,
  MigrationJournalError,
  readBundledMigrations,
  readDatabaseSchemaVersion,
  SchemaAheadError,
  type SchemaQuery,
} from '../version-guard.js';

/** Temporary directories this file made, removed once it is done. */
const scratchDirectories: string[] = [];

/** Writes a migrations directory whose journal holds `entries`. */
function journalFolder(entries: unknown): string {
  const folder = mkdtempSync(join(tmpdir(), 'agentchat-journal-'));
  scratchDirectories.push(folder);
  mkdirSync(join(folder, 'meta'), { recursive: true });
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify(entries), 'utf8');
  return folder;
}

/** A directory with no journal in it at all. */
function emptyFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'agentchat-journal-'));
  scratchDirectories.push(folder);
  return folder;
}

/** A `SchemaQuery` that answers from a script keyed by a substring of the SQL. */
function fakeClient(answers: { present: boolean; version?: unknown }): SchemaQuery {
  return {
    query(text: string): Promise<{ rows: Record<string, unknown>[] }> {
      if (text.includes('to_regclass')) {
        return Promise.resolve({ rows: [{ present: answers.present }] });
      }
      return Promise.resolve({ rows: [{ version: answers.version ?? null }] });
    },
  };
}

/** A bundled-migrations description, without touching the filesystem. */
function bundled(entries: { tag: string; when: number }[]): BundledMigrations {
  const newest = entries.at(-1);
  return {
    folder: '/nowhere',
    entries,
    version: newest?.when ?? null,
    newestTag: newest?.tag ?? null,
  };
}

afterAll(() => {
  for (const folder of scratchDirectories) {
    rmSync(folder, { recursive: true, force: true });
  }
});

describe('reading the bundled migration journal', () => {
  it('reports the highest `when` as the schema version', () => {
    const folder = journalFolder({
      version: '7',
      entries: [
        { idx: 0, when: 1_000, tag: '0000_first' },
        { idx: 1, when: 2_000, tag: '0001_second' },
      ],
    });

    const result = readBundledMigrations(folder);

    expect(result.version).toBe(2_000);
    expect(result.newestTag).toBe('0001_second');
    expect(result.entries).toHaveLength(2);
  });

  it('orders by `when` rather than trusting the file, because the version is a maximum', () => {
    const folder = journalFolder({
      entries: [
        { idx: 0, when: 5_000, tag: '0001_second' },
        { idx: 1, when: 1_000, tag: '0000_first' },
      ],
    });

    const result = readBundledMigrations(folder);

    expect(result.entries.map((entry) => entry.tag)).toEqual(['0000_first', '0001_second']);
    expect(result.version).toBe(5_000);
  });

  it('reports no version for an image that bundles no migrations', () => {
    const result = readBundledMigrations(journalFolder({ entries: [] }));

    expect(result.version).toBeNull();
    expect(result.newestTag).toBeNull();
  });

  it('names the path it looked for when there is no journal', () => {
    const folder = emptyFolder();

    expect(() => readBundledMigrations(folder)).toThrow(MigrationJournalError);
    expect(() => readBundledMigrations(folder)).toThrow(join(folder, 'meta', '_journal.json'));
  });

  it('refuses a journal that is not JSON', () => {
    const folder = mkdtempSync(join(tmpdir(), 'agentchat-journal-'));
    scratchDirectories.push(folder);
    mkdirSync(join(folder, 'meta'), { recursive: true });
    writeFileSync(join(folder, 'meta', '_journal.json'), 'not json at all', 'utf8');

    expect(() => readBundledMigrations(folder)).toThrow(MigrationJournalError);
  });

  it('refuses a journal whose entries are the wrong shape', () => {
    const folder = journalFolder({ entries: [{ tag: '0000_first', when: 'yesterday' }] });

    expect(() => readBundledMigrations(folder)).toThrow(MigrationJournalError);
  });
});

describe('reading the schema version from the database', () => {
  it('is null when the bookkeeping table does not exist yet', async () => {
    await expect(readDatabaseSchemaVersion(fakeClient({ present: false }))).resolves.toBeNull();
  });

  it('is null when the table exists but holds nothing', async () => {
    await expect(
      readDatabaseSchemaVersion(fakeClient({ present: true, version: null })),
    ).resolves.toBeNull();
  });

  it('converts the bigint the driver returns as a string', async () => {
    await expect(
      readDatabaseSchemaVersion(fakeClient({ present: true, version: '1788853816998' })),
    ).resolves.toBe(1_788_853_816_998);
  });

  it('refuses a created_at that is not a usable timestamp', async () => {
    await expect(
      readDatabaseSchemaVersion(fakeClient({ present: true, version: '99999999999999999999' })),
    ).rejects.toThrow(MigrationJournalError);
  });
});

describe('refusing a database that is ahead of the image', () => {
  const image = bundled([
    { tag: '0000_identity', when: 1_000 },
    { tag: '0001_messaging', when: 2_000 },
  ]);

  it('accepts an empty database', () => {
    expect(() => assertSchemaNotAhead({ databaseVersion: null, bundled: image })).not.toThrow();
  });

  it('accepts a database at exactly this image version', () => {
    expect(() => assertSchemaNotAhead({ databaseVersion: 2_000, bundled: image })).not.toThrow();
  });

  it('accepts a database behind this image, which is what migrating is for', () => {
    expect(() => assertSchemaNotAhead({ databaseVersion: 1_000, bundled: image })).not.toThrow();
  });

  it('refuses a database one migration ahead', () => {
    expect(() => assertSchemaNotAhead({ databaseVersion: 2_001, bundled: image })).toThrow(
      SchemaAheadError,
    );
  });

  it('names both versions and the newest migration it knows', () => {
    let thrown: unknown;
    try {
      assertSchemaNotAhead({ databaseVersion: 9_000, bundled: image });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SchemaAheadError);
    const error = thrown as SchemaAheadError;

    expect(error.code).toBe('SCHEMA_AHEAD_OF_BINARY');
    expect(error.databaseVersion).toBe(9_000);
    expect(error.imageVersion).toBe(2_000);
    // The message has to be enough on its own: it is what an operator sees in
    // `docker logs` at the moment a deploy stops.
    expect(error.message).toContain('9000');
    expect(error.message).toContain('2000');
    expect(error.message).toContain('0001_messaging');
    expect(error.message).toContain('AGENTCHAT_ALLOW_SCHEMA_AHEAD');
  });

  it('refuses any migrated database when the image bundles no migrations at all', () => {
    // The pathological rollback: an image built before the first migration
    // existed, pointed at a database that has one.
    expect(() => assertSchemaNotAhead({ databaseVersion: 1, bundled: bundled([]) })).toThrow(
      SchemaAheadError,
    );
  });
});

describe('describing a schema version', () => {
  it('gives the raw number and the date, because each answers a different question', () => {
    expect(describeSchemaVersion(1_788_853_816_998)).toBe(
      '1788853816998 (2026-09-08T07:50:16.998Z)',
    );
  });

  it('says so in words when nothing has been applied', () => {
    expect(describeSchemaVersion(null)).toContain('no migration has been applied');
  });
});
