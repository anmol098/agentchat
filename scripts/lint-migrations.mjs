#!/usr/bin/env node
/**
 * AgentChat migration compatibility check.
 *
 * Migrations are forward-only, they ship inside the server image, and they run
 * on boot against databases this project does not control and cannot inspect
 * (Plan section 12.2). Two promises follow from that, and this script is what
 * keeps them:
 *
 *   1. **N-1 compatibility.** Plan section 12.3: every migration must work
 *      against both the release that ships it and the previous minor release,
 *      so an operator who upgrades and regrets it rolls back by starting the
 *      old image, not by restoring last night's dump. There are no down
 *      migrations. A dropped column is gone, and the only remedy left is the
 *      backup.
 *   2. **The upgrade is not an outage.** A migration runs while the operator
 *      watches `docker compose up -d server`. A statement that takes
 *      `ACCESS EXCLUSIVE` on `messages` and holds it for a table scan is not a
 *      slow migration, it is downtime with a progress bar.
 *
 * ## Expand and contract
 *
 * Both promises are kept by the same discipline, and every message this script
 * prints is a variation on it. A schema change that removes or narrows
 * something is split across two releases:
 *
 *   - **Expand**, in release N. Add the new thing. Nothing is removed, nothing
 *     is narrowed, and the *old* code still works because everything it reads
 *     is still there. Both releases can run against this schema, which is what
 *     makes the rollback safe.
 *   - **Migrate**, in release N. New code writes both shapes; a backfill copies
 *     the old into the new. Still nothing removed.
 *   - **Contract**, in release N+1 at the earliest. Now that no supported
 *     release reads the old thing, remove it.
 *
 * Renaming a column is the shortest example. `ALTER TABLE t RENAME a TO b` is
 * one statement and breaks release N-1 the instant it commits, because that
 * release selects `a`. The same change as add-`b` / dual-write / backfill /
 * drop-`a`-next-release costs two releases and never has a moment where a
 * supported version cannot serve.
 *
 * ## What this script enforces
 *
 * Plan section 12.6 item 4 defines the gate: reject `DROP`, `RENAME`,
 * `ALTER … TYPE` and `SET NOT NULL` unless the file carries a
 * `-- contract-step: <release>` marker naming the expand release that came
 * before. That marker is an assertion by a human that the expand half already
 * shipped; this script checks that the assertion was made and is well formed,
 * not that it is true. Nothing can check that it is true.
 *
 * On top of the compatibility rules it enforces the lock rules, because those
 * are what turn a correct migration into an outage. Those have no marker
 * escape, deliberately: for every one of them a non-blocking form exists and is
 * just as short to write, so an escape hatch would only ever be used to skip
 * writing it.
 *
 * ## What this script deliberately does NOT flag
 *
 * A linter that cries wolf gets disabled, so the carve-outs below are as much
 * of the design as the rules:
 *
 *   - **Anything targeting a table created earlier in the same file.** Creating
 *     a table and then indexing it, adding a constraint to it, or dropping a
 *     column from it is safe by construction: no release has ever read it and
 *     it holds no rows.
 *   - **`ADD COLUMN … NOT NULL DEFAULT <constant>`.** This rewrote the whole
 *     table before PostgreSQL 11 and is metadata-only from 11 onward. The
 *     project targets 18. Flagging it would be enforcing a rule that stopped
 *     being true seven majors ago. A *volatile* default still rewrites, and
 *     that is flagged.
 *   - **`DROP NOT NULL`.** Relaxing a constraint cannot break a reader.
 *   - **`ADD CONSTRAINT … FOREIGN KEY`** on an existing table. It takes
 *     `SHARE ROW EXCLUSIVE`, which blocks writers but not readers, and Plan
 *     section 12.3 does not list it. `CHECK`, `UNIQUE` and `PRIMARY KEY` take
 *     `ACCESS EXCLUSIVE` for the same scan and are flagged.
 *   - **Text inside comments, string literals and dollar-quoted bodies.** The
 *     scanner blanks them before any rule runs, so the word DROP in a comment
 *     is a word in a comment.
 *
 * ## What this script CANNOT see
 *
 * Printed as a note on every successful run, because a check whose blind spots
 * are undocumented gets trusted for more than it does:
 *
 *   - **Statements it does not read as text.** A `DO $$ … $$` block, a function
 *     body, or an `EXECUTE` of a concatenated string hides anything at all. The
 *     scanner blanks dollar-quoted bodies rather than guessing at them, and
 *     reports their presence as unanalysable instead of passing them silently.
 *   - **How long a statement takes.** `UPDATE messages SET x = … WHERE id > …`
 *     is bounded, carries no keyword worth flagging, and can still hold a lock
 *     for minutes on a table this project has never seen. Section 12.3's rule
 *     that a backfill is batched, and that one which could exceed ~30 s ships
 *     as a separate `server backfill` command, is a review judgement about row
 *     counts and stays one.
 *   - **Lock queueing.** An `ALTER TABLE` that finishes in a millisecond still
 *     waits behind a long-running read, and everything that arrives behind it
 *     waits too. The mitigation is `lock_timeout` in the migration runner, not
 *     a rule here.
 *   - **Whether the expand half really shipped.** `-- contract-step: v0.3.0`
 *     asserts that release 0.3.0 stopped reading the thing being dropped. Only
 *     a person reading the previous release's source can confirm that.
 *   - **A rename spelled as two statements.** Add `b`, drop `a`, no backfill
 *     between them: each statement is judged on its own, and the drop is caught
 *     for being a drop rather than for being half of a rename.
 *
 * Usage: node scripts/lint-migrations.mjs [check|selftest] [--verbose]
 * Run with --help for the full list.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where the migrations live. A missing directory is a failure, not a pass: a
 * check that quietly succeeds when it finds nothing to check is a check that
 * stops meaning anything the day somebody moves the folder.
 */
const MIGRATIONS_DIR = 'server/drizzle';

/**
 * The marker that turns a destructive statement into an approved contract step.
 *
 * The spelling is fixed by Plan section 12.6 item 4. The release that follows
 * it is the *expand* release — the one that stopped reading whatever is being
 * removed here — so writing the marker means naming a version and being able to
 * point at it, which is the whole reason the marker is a version and not a
 * boolean.
 *
 * Anything after the version is free text and is printed back in the report, so
 * `-- contract-step: v0.3.0 — v0.3.0 stopped reading agents.legacy_name` is the
 * recommended form even though only the version is parsed.
 */
const CONTRACT_MARKER = /^[^\S\n]*--[^\S\n]*contract-step:[^\S\n]*(.*)$/gim;

/** What a release reference has to look like: `v1.2`, `1.2`, `v1.2.3`, `1.2.3`. */
const RELEASE = /^v?\d+\.\d+(?:\.\d+)?$/;

// ---------------------------------------------------------------------------
// Rule catalogue
// ---------------------------------------------------------------------------

/**
 * Whether the `-- contract-step:` marker excuses a finding.
 *
 * `compatibility` findings are about N-1: they remove or narrow something a
 * supported release might still be reading, which is exactly the thing the
 * marker exists to approve.
 *
 * `availability` findings are about locks. They are not excused, because for
 * every one of them there is a non-blocking form that is no harder to write —
 * `CONCURRENTLY`, `NOT VALID`, `USING INDEX`, a nullable column plus a batched
 * backfill. A marker here would not be approving a trade-off, it would be
 * skipping the two words that make the statement safe.
 */
const KIND = {
  'destructive-drop': 'compatibility',
  'destructive-truncate': 'compatibility',
  rename: 'compatibility',
  'column-type-change': 'compatibility',
  'set-not-null': 'compatibility',
  'not-null-without-default': 'compatibility',
  'unbounded-write': 'compatibility',
  'blocking-index': 'availability',
  'blocking-constraint': 'availability',
  'rewriting-default': 'availability',
  'explicit-lock': 'availability',
  'malformed-contract-marker': 'marker',
};

/**
 * Why each finding matters.
 *
 * These are long on purpose. Somebody meets this check at two in the morning,
 * having written a statement that looks entirely ordinary, and needs to
 * understand which promise it breaks — otherwise the next move is to look for
 * the flag that turns the check off.
 */
const WHY = {
  'destructive-drop': [
    'Dropping something removes it for every release at once, and migrations',
    'here are forward-only: there is no down migration to put it back. The',
    'previous minor release is still supported (Plan section 12.3) and an',
    'operator is entitled to roll back onto this schema by starting the old',
    'image. If that release still selects this column, or still names this',
    'constraint in an ON CONFLICT clause, it starts and then fails on the first',
    'request — with the data intact and unreachable, which reads as a far worse',
    'incident than a failed upgrade.',
    '',
    'On a large table the lock is a second problem: DROP COLUMN is quick, but',
    'DROP CONSTRAINT and DROP INDEX take ACCESS EXCLUSIVE, and this runs on boot',
    'while the operator watches.',
  ],
  'destructive-truncate': [
    'TRUNCATE removes every row, takes ACCESS EXCLUSIVE, and is not recoverable',
    'from anything but a backup. Nothing in an upgrade path should be discarding',
    'production rows without a human deciding, per database, that it is time.',
  ],
  rename: [
    'A rename breaks the previous release the instant it commits. That release',
    'selects the old name, and no amount of restarting fixes it, because the old',
    'name no longer exists — so the rollback promise in Plan section 12.3 is',
    'gone and the only way back is a restore. A rename is also invisible to a',
    'reviewer skimming a diff: one word changes and every query against it in a',
    'release nobody is looking at stops working.',
  ],
  'column-type-change': [
    'Changing a type rewrites the table under ACCESS EXCLUSIVE — the whole',
    'table, on boot, while the server is not yet serving — and it narrows what',
    'the column accepts. The previous release still writes the old shape; if the',
    'new type is narrower, its inserts start failing after a rollback.',
    'text -> varchar(64) is not a widening, and neither is bigint -> integer.',
  ],
  'set-not-null': [
    'SET NOT NULL scans the entire table under ACCESS EXCLUSIVE to prove no row',
    'violates it, and from then on rejects the inserts the previous release is',
    'still making. That release does not know the column is required, so after a',
    'rollback every write that omits it fails — a constraint added in good faith',
    'in release N takes down release N-1.',
  ],
  'not-null-without-default': [
    'Plan section 12.3: an added column must be nullable or have a default. A',
    'NOT NULL column with neither cannot be added to a table that already holds',
    'rows — the statement fails outright, on boot, in a database this project',
    'has never seen — and even on an empty table it breaks the previous release,',
    'which inserts without ever mentioning the column.',
  ],
  'unbounded-write': [
    'A backfill with no WHERE clause touches every row in one statement, holds',
    'the locks it takes for the whole of it, and bloats the table by a full copy',
    'of itself. Plan section 12.3 requires backfills to be batched — roughly',
    '5 000 rows per statement — precisely so a boot-time migration cannot hold a',
    'table for minutes; a backfill that could exceed about thirty seconds is',
    'supposed to ship as a separate `server backfill <name>` command called out',
    'in the release notes, not to run while the operator waits.',
    '',
    'An unbounded DELETE is the same problem plus an unrecoverable one: the rows',
    'are gone for the previous release too.',
  ],
  'blocking-index': [
    'A plain CREATE INDEX takes a SHARE lock for the whole build. Reads still',
    'work; every INSERT, UPDATE and DELETE waits. On a table the size of',
    '`messages` that is minutes, and because migrations run on boot the server',
    'is not accepting traffic yet either — so from outside it is simply an',
    'outage, and one that gets longer as the deployment it is protecting grows.',
    '',
    'CREATE INDEX CONCURRENTLY does the same work in two passes without ever',
    'blocking writers. It is slower in wall-clock terms and that is the point.',
  ],
  'blocking-constraint': [
    'Adding a CHECK, UNIQUE or PRIMARY KEY constraint to a table that already',
    'has rows validates it under ACCESS EXCLUSIVE — a lock that blocks readers',
    'as well as writers — for as long as the scan or the index build takes.',
    '',
    'It is also a narrowing: the previous release does not know about the new',
    'constraint and keeps writing rows that violate it, which start failing',
    'after a rollback.',
  ],
  'rewriting-default': [
    'A DEFAULT whose expression is volatile has to be evaluated separately for',
    'every existing row, so PostgreSQL rewrites the entire table under ACCESS',
    'EXCLUSIVE. This is the one case where the modern fast path does not apply:',
    'since PostgreSQL 11 a constant or stable default (a literal, now()) is',
    'stored once as metadata and costs nothing however large the table, but',
    'gen_random_uuid(), random() and nextval() — including the one hiding inside',
    'a `serial` type — are volatile and cost a full rewrite.',
  ],
  'explicit-lock': [
    'LOCK TABLE with no mode named means ACCESS EXCLUSIVE, which blocks every',
    'reader and writer until the migration commits. Migrations run on boot and',
    'are already serialised by the advisory lock described in Plan section 12.2,',
    'so an explicit table lock is not buying isolation — it is only extending',
    'how much of the database is unavailable while the upgrade runs.',
  ],
  'malformed-contract-marker': [
    'The marker is present but does not name a release, so this file claims an',
    'approval it has not actually made. That is worse than having no marker at',
    'all: it looks approved in a diff and excuses nothing. The version is the',
    'entire content of the assertion — it is the release a reviewer opens to',
    'confirm that nothing there still reads what is being removed here.',
  ],
};

/** The concrete way out, printed under the explanation. */
const FIX = {
  'destructive-drop': [
    'Split the change across two releases. In this release, stop reading the',
    'column in `server/` and ship that. In the *next* release, drop it and mark',
    'the migration `-- contract-step: <the release that stopped reading it>`.',
    'If that release has already shipped, add the marker now and name it.',
  ],
  'destructive-truncate': [
    'Delete in bounded batches with a WHERE clause, or ship the cleanup as a',
    '`server backfill <name>` command an operator runs deliberately. If this',
    'really is the contract half of a change whose expand release has shipped,',
    'add `-- contract-step: <release>` and name it.',
  ],
  rename: [
    'Never rename in place. Add the new column, dual-write both from the server',
    'for one release, backfill the old values into the new column, and drop the',
    'old column in a later migration carrying `-- contract-step: <release>`.',
  ],
  'column-type-change': [
    'Add a new column of the new type, backfill it in batches, dual-write for a',
    'release, then drop the old column in a later migration marked',
    '`-- contract-step: <release>`. For a pure widening that genuinely cannot',
    'break the previous release, the marker is still required, so that the',
    'judgement is recorded next to the statement rather than in a review thread.',
  ],
  'set-not-null': [
    'Three steps, across two releases. Now: add',
    '`CHECK (col IS NOT NULL) NOT VALID`, which takes no scan and only applies to',
    'new rows, then `VALIDATE CONSTRAINT`, which scans without ACCESS EXCLUSIVE.',
    'Next release, once nothing writes NULL: `SET NOT NULL` — which is instant,',
    'because the validated CHECK already proves it — under',
    '`-- contract-step: <release>`.',
  ],
  'not-null-without-default': [
    'Give the column a default, or make it nullable. `ADD COLUMN x text NOT NULL',
    "DEFAULT ''` is metadata-only on PostgreSQL 11 and later and is safe here.",
    'If it must be NOT NULL with no default, that is two releases: add it',
    'nullable, backfill, and add the constraint later as a contract step.',
  ],
  'unbounded-write': [
    'Add a WHERE clause that bounds the statement — a key range, or',
    '`WHERE col IS NULL` so repeated runs converge — and repeat it, roughly',
    '5 000 rows at a time. If the whole backfill could take more than about',
    'thirty seconds, move it out of the migration into a `server backfill',
    '<name>` command and say so in the release notes.',
  ],
  'blocking-index': [
    'Write `CREATE INDEX CONCURRENTLY` (add `IF NOT EXISTS`, so that a build',
    'interrupted by a restart can be retried). CONCURRENTLY cannot run inside a',
    'transaction, so the migration has to be a non-transactional one — which is',
    'what Plan section 12.3 already asks for.',
  ],
  'blocking-constraint': [
    'For CHECK and FOREIGN KEY: add it `NOT VALID` first, which takes only a',
    'brief lock and applies to new rows, then `ALTER TABLE … VALIDATE CONSTRAINT`',
    'in the same migration, which scans under a lock that lets writers through.',
    'For UNIQUE and PRIMARY KEY: `CREATE UNIQUE INDEX CONCURRENTLY`, then',
    '`ADD CONSTRAINT … USING INDEX`, which adopts the finished index instead of',
    'building a new one.',
  ],
  'rewriting-default': [
    'Add the column with no default, backfill it in batches, and then',
    '`ALTER COLUMN … SET DEFAULT`, which only affects rows inserted afterwards.',
    'For a `serial` column, add a plain integer column and attach the sequence',
    'the same way.',
  ],
  'explicit-lock': [
    'Remove the LOCK statement. If a specific statement genuinely needs to be',
    'serialised against the application, name the weakest mode that achieves it',
    '(SHARE UPDATE EXCLUSIVE lets readers and writers through) rather than',
    'taking the default.',
  ],
  'malformed-contract-marker': [
    'Write the release the marker is asserting about:',
    '`-- contract-step: v0.3.0 — v0.3.0 stopped reading agents.legacy_name`.',
    'Anything after the version is free text and is printed back in the report.',
  ],
};

// ---------------------------------------------------------------------------
// Scanning SQL without a SQL parser
// ---------------------------------------------------------------------------

const IDENT = String.raw`(?:"[^"]*"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]*"|[A-Za-z_][\w$]*))*`;

/** Build a case-insensitive, global regex from a template with `IDENT` in it. */
const re = (source) => new RegExp(source.replaceAll('IDENT', IDENT), 'gi');

/**
 * Replace everything that is not executable SQL with spaces, preserving every
 * offset and every newline, and record where each statement begins and ends.
 *
 * Blanking rather than deleting is what lets a rule match anywhere in the file
 * and still report an exact line: the offset of a match in the scrubbed text is
 * the offset of the same text in the original.
 *
 * What gets blanked: line comments, (nesting) block comments, single-quoted
 * strings, and dollar-quoted bodies. Double-quoted identifiers are kept,
 * because they are the table and column names every rule needs to read — but
 * the scanner still knows it is inside one, so a `;` or a `--` in a quoted
 * identifier does not end a statement or start a comment.
 *
 * Dollar-quoted bodies are the one place where blanking loses real statements:
 * a `DO $$ … $$` block can contain anything, including an EXECUTE of a string
 * assembled at run time. They are counted and reported as unanalysable rather
 * than passed over in silence.
 */
function scan(sql) {
  const out = new Array(sql.length);
  const statements = [];
  const opaque = [];

  let i = 0;
  let statementStart = 0;
  // Everything outside a statement body so far: leading comments and blanks.
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) out[k] = sql[k] === '\n' ? '\n' : ' ';
  };
  const keep = (from, to) => {
    for (let k = from; k < to; k += 1) out[k] = sql[k];
  };

  while (i < sql.length) {
    const two = sql.slice(i, i + 2);

    if (two === '--') {
      let end = sql.indexOf('\n', i);
      if (end === -1) end = sql.length;
      blank(i, end);
      i = end;
      continue;
    }

    if (two === '/*') {
      let depth = 1;
      let k = i + 2;
      while (k < sql.length && depth > 0) {
        if (sql.slice(k, k + 2) === '/*') {
          depth += 1;
          k += 2;
        } else if (sql.slice(k, k + 2) === '*/') {
          depth -= 1;
          k += 2;
        } else {
          k += 1;
        }
      }
      blank(i, k);
      i = k;
      continue;
    }

    if (sql[i] === "'") {
      let k = i + 1;
      while (k < sql.length) {
        if (sql[k] === '\\') {
          k += 2;
          continue;
        }
        if (sql[k] === "'") {
          // A doubled quote is an escaped quote, not the end of the string.
          if (sql[k + 1] === "'") {
            k += 2;
            continue;
          }
          k += 1;
          break;
        }
        k += 1;
      }
      blank(i, k);
      i = k;
      continue;
    }

    if (sql[i] === '"') {
      let k = sql.indexOf('"', i + 1);
      k = k === -1 ? sql.length : k + 1;
      keep(i, k);
      i = k;
      continue;
    }

    const dollar = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 64));
    if (dollar) {
      const tag = dollar[0];
      let k = sql.indexOf(tag, i + tag.length);
      k = k === -1 ? sql.length : k + tag.length;
      blank(i, k);
      opaque.push({ start: i, end: k });
      i = k;
      continue;
    }

    if (sql[i] === ';') {
      out[i] = ' ';
      statements.push({ start: statementStart, end: i });
      statementStart = i + 1;
      i += 1;
      continue;
    }

    out[i] = sql[i];
    i += 1;
  }

  if (statementStart < sql.length) statements.push({ start: statementStart, end: sql.length });

  const text = out.join('');
  return {
    text,
    opaque,
    statements: statements.filter(({ start, end }) => text.slice(start, end).trim().length > 0),
  };
}

/** Offsets of the start of each line, for turning a match offset into a line. */
function lineIndex(sql) {
  const starts = [0];
  for (let i = 0; i < sql.length; i += 1) if (sql[i] === '\n') starts.push(i + 1);
  return starts;
}

/** 1-based line number of an offset. */
function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** `"public"."users"` -> `users`. Unquoted identifiers fold to lower case. */
function normalizeIdent(raw) {
  const parts = raw.split('.');
  const last = parts[parts.length - 1].trim();
  return last.startsWith('"') ? last.slice(1, -1).toLowerCase() : last.toLowerCase();
}

/**
 * True when `text` contains a NOT NULL that is a column constraint rather than
 * the tail of an `IS NOT NULL` inside a CHECK expression. Without this,
 * `ADD COLUMN x text CHECK (x IS NOT NULL)` — which is nullable and perfectly
 * safe — would be reported as a NOT NULL column with no default.
 */
function hasNotNullConstraint(text) {
  for (const match of text.matchAll(/\bNOT\s+NULL\b/gi)) {
    if (!/\bIS\s*$/i.test(text.slice(0, match.index))) return true;
  }
  return false;
}

/**
 * Functions whose result differs per row, so a DEFAULT using one forces a full
 * table rewrite. Everything else — a literal, now(), current_timestamp — is
 * constant or stable and is stored once as metadata from PostgreSQL 11 onward.
 */
const VOLATILE_DEFAULT =
  /\b(gen_random_uuid|uuid_generate_v[145]|random|clock_timestamp|timeofday|nextval|statement_timestamp)\s*\(/i;

/** Column types that carry an implicit nextval() and therefore rewrite. */
const SERIAL_TYPE = /\b(small|big)?serial\b/i;

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * Examine one statement.
 *
 * `created` is the set of tables created *earlier in this same file*. Every
 * rule consults it, because a statement against a table that did not exist
 * before this migration cannot break a previous release (nothing has read it)
 * and cannot block anything (it holds no rows). That single carve-out is what
 * keeps the check quiet on the migrations this project actually writes, which
 * create a table and then index and constrain it in the same breath.
 */
function analyseStatement(body, base, created, createdIndexes) {
  const findings = [];
  const at = (match, what, code) =>
    findings.push({ code, offset: base + match.index, what, kind: KIND[code] });

  const first = /^\s*([A-Za-z]+)/.exec(body);
  const verb = first ? first[1].toUpperCase() : '';

  // -- CREATE TABLE: the source of the carve-out every other rule reads. -----
  const createTable = re(
    String.raw`^\s*CREATE\s+(?:UNLOGGED\s+|TEMP\w*\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(IDENT)`,
  );
  const created0 = createTable.exec(body);
  if (created0) {
    created.add(normalizeIdent(created0[1]));
    return findings;
  }

  // -- Top-level DROP of a whole object. ------------------------------------
  const dropObject = re(
    String.raw`^\s*DROP\s+(TABLE|INDEX|VIEW|MATERIALIZED\s+VIEW|SEQUENCE|SCHEMA|TYPE|DOMAIN|FUNCTION|PROCEDURE|TRIGGER|RULE|EXTENSION|DATABASE)\b(?:\s+CONCURRENTLY)?(?:\s+IF\s+EXISTS)?\s*(IDENT)?`,
  );
  const dropped = dropObject.exec(body);
  if (dropped) {
    const kind = dropped[1].toUpperCase();
    const name = dropped[2] ? normalizeIdent(dropped[2]) : '';
    const sameFile =
      (kind === 'TABLE' && created.has(name)) || (kind === 'INDEX' && createdIndexes.has(name));
    if (!sameFile) {
      at(dropped, `DROP ${kind}${name ? ` ${name}` : ''}`, 'destructive-drop');
    }
    return findings;
  }

  // -- TRUNCATE. ------------------------------------------------------------
  const truncate = re(String.raw`^\s*TRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?(IDENT)`);
  const truncated = truncate.exec(body);
  if (truncated) {
    if (!created.has(normalizeIdent(truncated[1]))) {
      at(truncated, `TRUNCATE ${normalizeIdent(truncated[1])}`, 'destructive-truncate');
    }
    return findings;
  }

  // -- LOCK TABLE. ----------------------------------------------------------
  const lock = re(String.raw`^\s*LOCK\s+(?:TABLE\s+)?(?:ONLY\s+)?(IDENT)([\s\S]*)`);
  const locked = lock.exec(body);
  if (locked) {
    const mode = /\bIN\s+([A-Z ]+?)\s+MODE\b/i.exec(locked[2]);
    const exclusive = !mode || /ACCESS\s+EXCLUSIVE|^EXCLUSIVE$/i.test(mode[1].trim());
    if (exclusive && !created.has(normalizeIdent(locked[1]))) {
      at(locked, `LOCK ${normalizeIdent(locked[1])}`, 'explicit-lock');
    }
    return findings;
  }

  // -- CREATE INDEX. --------------------------------------------------------
  const createIndex = re(
    String.raw`^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(IDENT\s+)?ON\s+(?:ONLY\s+)?(IDENT)`,
  );
  const index = createIndex.exec(body);
  if (index) {
    const name = index[3] ? normalizeIdent(index[3]) : '';
    if (name) createdIndexes.add(name);
    const table = normalizeIdent(index[4]);
    if (!index[2] && !created.has(table)) {
      at(index, `CREATE INDEX on the pre-existing table ${table}`, 'blocking-index');
    }
    return findings;
  }

  // -- UPDATE / DELETE with no bound. ---------------------------------------
  if (verb === 'UPDATE' || verb === 'DELETE') {
    const target = re(String.raw`^\s*(?:UPDATE|DELETE\s+FROM)\s+(?:ONLY\s+)?(IDENT)`).exec(body);
    if (target && !created.has(normalizeIdent(target[1])) && !/\bWHERE\b/i.test(body)) {
      at(target, `${verb} over every row of ${normalizeIdent(target[1])}`, 'unbounded-write');
    }
    return findings;
  }

  // -- ALTER TABLE, where most of the danger lives. -------------------------
  const alter = re(String.raw`^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(IDENT)`).exec(
    body,
  );
  if (!alter) {
    // ALTER INDEX / ALTER TYPE / ALTER SEQUENCE … RENAME is still a rename.
    const renameOther = re(String.raw`^\s*ALTER\s+\w+\s+IDENT\s+RENAME\b`).exec(body);
    if (renameOther) at(renameOther, 'RENAME', 'rename');
    return findings;
  }

  const table = normalizeIdent(alter[1]);
  if (created.has(table)) return findings;

  for (const match of body.matchAll(re(String.raw`\bRENAME\b`))) {
    at(match, `RENAME on ${table}`, 'rename');
  }

  for (const match of body.matchAll(
    re(String.raw`\bALTER\s+(?:COLUMN\s+)?IDENT\s+(?:SET\s+DATA\s+)?TYPE\b`),
  )) {
    at(match, `column type change on ${table}`, 'column-type-change');
  }

  for (const match of body.matchAll(re(String.raw`\bSET\s+NOT\s+NULL\b`))) {
    at(match, `SET NOT NULL on ${table}`, 'set-not-null');
  }

  // DROP NOT NULL and DROP DEFAULT relax the schema and cannot break a reader,
  // so the negative lookahead below lets them through. Everything else after
  // DROP inside an ALTER TABLE removes something.
  for (const match of body.matchAll(
    re(
      String.raw`\bDROP\s+(?!NOT\s+NULL\b|DEFAULT\b|IDENTITY\b|EXPRESSION\b)(COLUMN\s+|CONSTRAINT\s+)?(?:IF\s+EXISTS\s+)?(IDENT)`,
    ),
  )) {
    const what = (match[1] ?? 'COLUMN ').trim();
    at(match, `DROP ${what} ${normalizeIdent(match[2])} from ${table}`, 'destructive-drop');
  }

  for (const match of body.matchAll(
    re(String.raw`\bADD\s+(?:CONSTRAINT\s+IDENT\s+)?(CHECK|UNIQUE|PRIMARY\s+KEY)\b`),
  )) {
    const kind = match[1].toUpperCase();
    const excused =
      (kind === 'CHECK' && /\bNOT\s+VALID\b/i.test(body)) ||
      (kind !== 'CHECK' && /\bUSING\s+INDEX\b/i.test(body));
    if (!excused) at(match, `ADD ${kind} constraint to ${table}`, 'blocking-constraint');
  }

  for (const match of body.matchAll(
    re(String.raw`\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(IDENT)([\s\S]*)`),
  )) {
    const column = normalizeIdent(match[1]);
    const clause = match[2];
    const dflt = /\bDEFAULT\b([\s\S]{0,200})/i.exec(clause);
    if (hasNotNullConstraint(clause) && !dflt) {
      at(
        match,
        `ADD COLUMN ${column} NOT NULL with no default on ${table}`,
        'not-null-without-default',
      );
    }
    if ((dflt && VOLATILE_DEFAULT.test(dflt[1])) || SERIAL_TYPE.test(clause)) {
      at(match, `ADD COLUMN ${column} with a volatile default on ${table}`, 'rewriting-default');
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Lint one migration, given its text. Exposed separately from the filesystem so
 * the self-test can drive it with constructed SQL and no temporary tree.
 */
export function analyseMigration(file, sql) {
  const { text, statements, opaque } = scan(sql);
  const starts = lineIndex(sql);
  const lines = sql.split('\n');

  // The marker is read from the *original* text, because the scanner blanks
  // comments and the marker is a comment.
  CONTRACT_MARKER.lastIndex = 0;
  const markers = [...sql.matchAll(CONTRACT_MARKER)];
  const raw = markers.map((m) => m[1].trim()).filter((value) => value.length > 0);
  const release = raw.map((value) => value.split(/\s+/)[0]).find((token) => RELEASE.test(token));

  const findings = [];
  if (markers.length > 0 && !release) {
    findings.push({
      code: 'malformed-contract-marker',
      kind: 'marker',
      file,
      line: lineOf(starts, markers[0].index),
      source: lines[lineOf(starts, markers[0].index) - 1].trim(),
      what: raw.length > 0 ? `"${raw[0]}" is not a release` : 'the marker names nothing',
    });
  }

  const created = new Set();
  const createdIndexes = new Set();
  for (const { start, end } of statements) {
    for (const finding of analyseStatement(
      text.slice(start, end),
      start,
      created,
      createdIndexes,
    )) {
      const line = lineOf(starts, finding.offset);
      findings.push({ ...finding, file, line, source: lines[line - 1].trim() });
    }
  }

  // A marker only excuses compatibility findings, and only when it is well
  // formed. Availability findings are never excused: see KIND.
  const excused = [];
  const kept = [];
  for (const finding of findings) {
    if (release && finding.kind === 'compatibility') excused.push({ ...finding, release });
    else kept.push(finding);
  }

  return {
    findings: kept.sort((a, b) => a.line - b.line),
    excused,
    release,
    statements: statements.length,
    opaque: opaque.map((o) => ({ file, line: lineOf(starts, o.start) })),
  };
}

/** Lint every `.sql` file in the migrations directory. */
function analyse(root) {
  const dir = join(root, MIGRATIONS_DIR);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    fail(
      `${MIGRATIONS_DIR}/ does not exist or cannot be read.\n\n` +
        'This check has nothing to check, which is not the same as passing. If the\n' +
        'migrations moved, update MIGRATIONS_DIR in scripts/lint-migrations.mjs.',
    );
  }

  const files = entries.filter((name) => name.endsWith('.sql')).sort();
  const findings = [];
  const excused = [];
  const opaque = [];
  let statements = 0;

  for (const name of files) {
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    const result = analyseMigration(`${MIGRATIONS_DIR}/${name}`, readFileSync(path, 'utf8'));
    findings.push(...result.findings);
    excused.push(...result.excused);
    opaque.push(...result.opaque);
    statements += result.statements;
  }

  return { findings, excused, opaque, files, statements };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * Indent a block of lines, giving the first line a label of its own. Blank
 * lines stay blank rather than becoming a line of trailing spaces, so the
 * paragraph breaks survive a terminal, a CI log and a copy into a pull request.
 */
function block(lines, label, indent) {
  return lines
    .map((line, index) => (line === '' ? '' : `${index === 0 ? label : indent}${line}`))
    .join('\n')
    .concat('\n');
}

function report(findings) {
  for (const item of findings) {
    process.stderr.write(`\nerror[${item.code}]: ${item.file}:${item.line}\n`);
    process.stderr.write(`  ${item.what}\n`);
    process.stderr.write(`\n  ${item.line} | ${item.source}\n\n`);
    process.stderr.write(block(WHY[item.code] ?? [], '  ', '  '));
    process.stderr.write('\n');
    process.stderr.write(block(FIX[item.code] ?? [], '  Fix: ', '       '));
  }
}

const BLIND_SPOTS = [
  'statements assembled at run time — a DO block, a function body, or an',
  'EXECUTE of a concatenated string. Those are counted and listed as',
  'unanalysable rather than parsed or passed over;',
  'how long a bounded statement takes: a batched backfill carries no keyword',
  'worth flagging and can still hold a lock for minutes on a table this',
  'project has never seen. Plan section 12.3 puts backfills over ~30 s in a',
  'separate `server backfill` command, and that stays a review judgement;',
  'lock queueing, where a fast ALTER waits behind a long read and everything',
  'behind it waits too;',
  'whether a `-- contract-step:` marker tells the truth. It asserts that the',
  'named release stopped reading what is removed here; only a person who',
  'opens that release can confirm it.',
];

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

const commands = {
  check(argv) {
    const verbose = argv.includes('--verbose');
    const { findings, excused, opaque, files, statements } = analyse(ROOT);

    report(findings);

    if (findings.length > 0) {
      process.stderr.write(`\n${findings.length} migration problem(s) found.\n`);
      process.stderr.write(
        'These are not style rules. Migrations here are forward-only and run on boot\n' +
          'against databases this project does not control; see Plan sections 12.2 and\n' +
          '12.3 for the compatibility promise each of them keeps.\n',
      );
      process.exit(1);
    }

    process.stdout.write('Migration compatibility OK.\n');
    process.stdout.write(
      `  ${files.length} migration(s), ${statements} statement(s) checked in ${MIGRATIONS_DIR}/\n`,
    );

    if (excused.length > 0) {
      process.stdout.write(
        `\nnote: ${excused.length} destructive statement(s) were approved by a\n` +
          '      `-- contract-step:` marker. The marker is an assertion that the named\n' +
          '      release stopped reading these, which nothing here can verify:\n',
      );
      for (const item of excused) {
        process.stdout.write(
          `        ${item.file}:${item.line} — ${item.what} (contract step for ${item.release})\n`,
        );
      }
    }

    if (opaque.length > 0) {
      process.stdout.write(
        `\nnote: ${opaque.length} dollar-quoted block(s) cannot be analysed. SQL assembled\n` +
          '      inside one is invisible to this check, and to a reviewer skimming the\n' +
          '      diff as well:\n',
      );
      for (const item of opaque) process.stdout.write(`        ${item.file}:${item.line}\n`);
    }

    if (verbose) {
      process.stdout.write('\nnote: this check cannot see\n');
      for (const line of BLIND_SPOTS) process.stdout.write(`        ${line}\n`);
    } else {
      process.stdout.write('\nnote: run with --verbose for what this check cannot see.\n');
    }
  },

  selftest() {
    const results = runSelfTest();
    const failures = results.filter((r) => !r.ok);
    for (const result of results) {
      process.stdout.write(`  ${result.ok ? 'pass' : 'FAIL'}  ${result.name}\n`);
      if (!result.ok) process.stdout.write(`        ${result.detail}\n`);
    }
    if (failures.length > 0) {
      process.stderr.write(
        `\n${failures.length} of ${results.length} self-test case(s) failed.\n` +
          'The migration check is not detecting violations it claims to detect.\n',
      );
      process.exit(1);
    }
    process.stdout.write(`\n${results.length} self-test case(s) passed.\n`);
  },
};

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

/**
 * Prove the check catches each violation it promises to catch, and — just as
 * important — that it stays quiet on the safe statement next to it.
 *
 * A check that has never seen a real violation is not known to work, and the
 * violations this one exists to stop are absent from `server/drizzle/`, which
 * is the point. So they are constructed here, on every run, rather than once by
 * hand in a pull request nobody reads again. The workflow runs this before the
 * real check, so a green job says the checker was capable of failing.
 *
 * Every rule has at least one negative case beside it. Those are the cases that
 * matter most: a false positive is what gets a linter disabled, and the
 * carve-outs they pin down (a same-file table, a stable default, an IS NOT NULL
 * inside a CHECK, a relaxing DROP NOT NULL) are exactly where a naive keyword
 * grep would be wrong.
 */

/** A migration that creates a table, so later cases can target a *new* one. */
const NEW_TABLE =
  'CREATE TABLE "widgets" (\n\t"id" text PRIMARY KEY NOT NULL,\n\t"name" text\n);\n';

/** The three migrations named in the acceptance criteria, spelled out. */
const SAFE_MIGRATION = `${NEW_TABLE}--> statement-breakpoint
CREATE INDEX "widgets_name_idx" ON "widgets" USING btree ("name");--> statement-breakpoint
ALTER TABLE "widgets" ADD CONSTRAINT "widgets_name_present" CHECK (char_length("name") > 0);--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "widget_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "label" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agents_widget_id_idx" ON "agents" USING btree ("widget_id");
`;

const UNSAFE_MIGRATION = `ALTER TABLE "agents" DROP COLUMN "legacy_name";--> statement-breakpoint
CREATE INDEX "agents_name_idx" ON "agents" USING btree ("name");
`;

const CONTRACT_MIGRATION = `-- contract-step: v0.3.0 — v0.3.0 stopped reading agents.legacy_name,
-- which shipped nullable in v0.2.0 and was backfilled into agents.name.
ALTER TABLE "agents" DROP COLUMN "legacy_name";
`;

function runSelfTest() {
  const cases = [
    // -- The three the acceptance criteria name. ---------------------------
    { name: 'a safe migration produces no findings', sql: SAFE_MIGRATION, expect: [] },
    {
      name: 'an unsafe migration is rejected, every violation named',
      sql: UNSAFE_MIGRATION,
      expect: ['blocking-index', 'destructive-drop'],
    },
    {
      name: 'the same drop under a well-formed contract marker is accepted',
      sql: CONTRACT_MIGRATION,
      expect: [],
      excused: 1,
    },

    // -- Destructive statements. -------------------------------------------
    { name: 'DROP TABLE', sql: 'DROP TABLE "agents";\n', expect: ['destructive-drop'] },
    {
      name: 'DROP TABLE IF EXISTS is no safer',
      sql: 'DROP TABLE IF EXISTS "agents";\n',
      expect: ['destructive-drop'],
    },
    { name: 'DROP INDEX', sql: 'DROP INDEX "agents_name_idx";\n', expect: ['destructive-drop'] },
    {
      name: 'DROP CONSTRAINT',
      sql: 'ALTER TABLE "agents" DROP CONSTRAINT "agents_name_format";\n',
      expect: ['destructive-drop'],
    },
    {
      name: 'DROP with the COLUMN keyword left out',
      sql: 'ALTER TABLE "agents" DROP "legacy_name";\n',
      expect: ['destructive-drop'],
    },
    { name: 'TRUNCATE', sql: 'TRUNCATE TABLE "messages";\n', expect: ['destructive-truncate'] },
    {
      name: 'RENAME COLUMN',
      sql: 'ALTER TABLE "agents" RENAME COLUMN "name" TO "handle";\n',
      expect: ['rename'],
    },
    {
      name: 'RENAME TABLE',
      sql: 'ALTER TABLE "agents" RENAME TO "actors";\n',
      expect: ['rename'],
    },
    {
      name: 'ALTER INDEX … RENAME',
      sql: 'ALTER INDEX "agents_name_idx" RENAME TO "agents_handle_idx";\n',
      expect: ['rename'],
    },
    {
      name: 'ALTER COLUMN … TYPE',
      sql: 'ALTER TABLE "agents" ALTER COLUMN "name" TYPE varchar(64);\n',
      expect: ['column-type-change'],
    },
    {
      name: 'ALTER COLUMN … SET DATA TYPE',
      sql: 'ALTER TABLE "agents" ALTER COLUMN "name" SET DATA TYPE varchar(64);\n',
      expect: ['column-type-change'],
    },
    {
      name: 'SET NOT NULL',
      sql: 'ALTER TABLE "agents" ALTER COLUMN "name" SET NOT NULL;\n',
      expect: ['set-not-null'],
    },
    {
      name: 'ADD COLUMN NOT NULL with no default',
      sql: 'ALTER TABLE "agents" ADD COLUMN "kind" text NOT NULL;\n',
      expect: ['not-null-without-default'],
    },
    {
      name: 'an unbounded UPDATE backfill',
      sql: 'UPDATE "messages" SET "content" = \'\';\n',
      expect: ['unbounded-write'],
    },
    {
      name: 'an unbounded DELETE',
      sql: 'DELETE FROM "messages";\n',
      expect: ['unbounded-write'],
    },

    // -- Blocking statements, which no marker excuses. ---------------------
    {
      name: 'CREATE INDEX on an existing table',
      sql: 'CREATE INDEX "messages_x_idx" ON "messages" USING btree ("project_id");\n',
      expect: ['blocking-index'],
    },
    {
      name: 'CREATE UNIQUE INDEX on an existing table',
      sql: 'CREATE UNIQUE INDEX "messages_x_idx" ON "messages" ("project_id");\n',
      expect: ['blocking-index'],
    },
    {
      name: 'ADD CHECK without NOT VALID',
      sql: 'ALTER TABLE "agents" ADD CONSTRAINT "agents_x" CHECK ("name" <> \'\');\n',
      expect: ['blocking-constraint'],
    },
    {
      name: 'ADD UNIQUE without USING INDEX',
      sql: 'ALTER TABLE "agents" ADD CONSTRAINT "agents_x" UNIQUE ("name");\n',
      expect: ['blocking-constraint'],
    },
    {
      name: 'ADD COLUMN with a volatile default',
      sql: 'ALTER TABLE "agents" ADD COLUMN "uid" uuid DEFAULT gen_random_uuid();\n',
      expect: ['rewriting-default'],
    },
    {
      name: 'ADD COLUMN of a serial type',
      sql: 'ALTER TABLE "agents" ADD COLUMN "seq" bigserial;\n',
      expect: ['rewriting-default'],
    },
    {
      name: 'LOCK TABLE with no mode named',
      sql: 'LOCK TABLE "messages";\n',
      expect: ['explicit-lock'],
    },
    {
      name: 'a contract marker does not excuse a blocking index',
      sql: `-- contract-step: v0.3.0\nCREATE INDEX "m_x" ON "messages" ("project_id");\n`,
      expect: ['blocking-index'],
    },

    // -- The marker itself. -------------------------------------------------
    {
      name: 'a marker naming no release is itself a failure',
      sql: '-- contract-step: see the pull request\nALTER TABLE "agents" DROP COLUMN "x";\n',
      expect: ['destructive-drop', 'malformed-contract-marker'],
    },
    {
      name: 'a marker with a bare version and no prose still works',
      sql: '-- contract-step: 0.3\nALTER TABLE "agents" DROP COLUMN "x";\n',
      expect: [],
      excused: 1,
    },
    {
      name: 'a marker excuses the drop but not a blocking index beside it',
      sql: `-- contract-step: v0.3.0\nALTER TABLE "agents" DROP COLUMN "x";\nCREATE INDEX "m_x" ON "messages" ("project_id");\n`,
      expect: ['blocking-index'],
      excused: 1,
    },

    // -- False positives. These are the cases that keep the check usable. --
    {
      name: 'an index on a table created in the same migration is fine',
      sql: `${NEW_TABLE}CREATE INDEX "widgets_name_idx" ON "widgets" ("name");\n`,
      expect: [],
    },
    {
      name: 'a constraint on a table created in the same migration is fine',
      sql: `${NEW_TABLE}ALTER TABLE "widgets" ADD CONSTRAINT "widgets_x" CHECK ("name" <> '');\n`,
      expect: [],
    },
    {
      name: 'dropping a column of a table created in the same migration is fine',
      sql: `${NEW_TABLE}ALTER TABLE "widgets" DROP COLUMN "name";\n`,
      expect: [],
    },
    {
      name: 'a foreign key onto a table created in the same migration is fine',
      sql: `${NEW_TABLE}ALTER TABLE "widgets" ADD CONSTRAINT "widgets_id_fk" FOREIGN KEY ("id") REFERENCES "public"."agents"("id");\n`,
      expect: [],
    },
    {
      name: 'a foreign key on an existing table is not flagged (weaker lock, and 0002 does it)',
      sql: 'ALTER TABLE "refresh_tokens" ADD CONSTRAINT "rt_m_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE set null;\n',
      expect: [],
    },
    {
      name: 'CREATE INDEX CONCURRENTLY on an existing table is fine',
      sql: 'CREATE INDEX CONCURRENTLY "messages_x_idx" ON "messages" ("project_id");\n',
      expect: [],
    },
    {
      name: 'ADD COLUMN NOT NULL with a constant default is fine on PostgreSQL 11+',
      sql: 'ALTER TABLE "agents" ADD COLUMN "kind" text DEFAULT \'agent\' NOT NULL;\n',
      expect: [],
    },
    {
      name: 'ADD COLUMN NOT NULL DEFAULT now() is fine — now() is stable, not volatile',
      sql: 'ALTER TABLE "agents" ADD COLUMN "seen_at" timestamptz DEFAULT now() NOT NULL;\n',
      expect: [],
    },
    {
      name: 'a nullable ADD COLUMN is fine',
      sql: 'ALTER TABLE "agents" ADD COLUMN "note" text;\n',
      expect: [],
    },
    {
      name: 'IS NOT NULL inside a CHECK is not a NOT NULL column',
      sql: 'ALTER TABLE "agents" ADD COLUMN "note" text CHECK ("note" IS NOT NULL OR true);\n',
      expect: [],
    },
    {
      name: 'DROP NOT NULL relaxes and is never flagged',
      sql: 'ALTER TABLE "agents" ALTER COLUMN "name" DROP NOT NULL;\n',
      expect: [],
    },
    {
      name: 'DROP DEFAULT is not flagged',
      sql: 'ALTER TABLE "agents" ALTER COLUMN "name" DROP DEFAULT;\n',
      expect: [],
    },
    {
      name: 'SET DEFAULT is not flagged',
      sql: 'ALTER TABLE "agents" ALTER COLUMN "name" SET DEFAULT \'x\';\n',
      expect: [],
    },
    {
      name: 'ADD CHECK … NOT VALID is the recommended form',
      sql: 'ALTER TABLE "agents" ADD CONSTRAINT "agents_x" CHECK ("name" <> \'\') NOT VALID;\n',
      expect: [],
    },
    {
      name: 'VALIDATE CONSTRAINT is the safe follow-up, not a violation',
      sql: 'ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_x";\n',
      expect: [],
    },
    {
      name: 'ADD UNIQUE … USING INDEX adopts a concurrently built index',
      sql: 'ALTER TABLE "agents" ADD CONSTRAINT "agents_x" UNIQUE USING INDEX "agents_x_idx";\n',
      expect: [],
    },
    {
      name: 'a bounded DELETE is fine',
      sql: 'DELETE FROM "messages" WHERE "created_at" < now() - interval \'90 days\';\n',
      expect: [],
    },
    {
      name: 'a bounded UPDATE is fine',
      sql: 'UPDATE "messages" SET "content" = \'\' WHERE "id" > \'msg_0\';\n',
      expect: [],
    },
    {
      name: 'LOCK … IN SHARE UPDATE EXCLUSIVE MODE lets readers and writers through',
      sql: 'LOCK TABLE "messages" IN SHARE UPDATE EXCLUSIVE MODE;\n',
      expect: [],
    },

    // -- The scanner. -------------------------------------------------------
    {
      name: 'DROP TABLE in a line comment is a word in a comment',
      sql: '-- We are not going to DROP TABLE "agents" here.\nSELECT 1;\n',
      expect: [],
    },
    {
      name: 'DROP TABLE in a block comment is a word in a comment',
      sql: '/* DROP TABLE "agents"; */\nSELECT 1;\n',
      expect: [],
    },
    {
      name: 'DROP TABLE inside a string literal is data',
      sql: 'INSERT INTO "audit" ("what") VALUES (\'DROP TABLE agents\');\n',
      expect: [],
    },
    {
      name: 'a semicolon inside a string does not split the statement',
      sql: 'UPDATE "agents" SET "name" = \'a;b\' WHERE "id" = \'x\';\n',
      expect: [],
    },
    {
      name: 'a doubled quote inside a string does not end it',
      sql: 'UPDATE "agents" SET "name" = \'it\'\'s; fine\' WHERE "id" = \'x\';\n',
      expect: [],
    },
    {
      name: 'a dollar-quoted body is reported as unanalysable, not parsed',
      sql: "DO $$ BEGIN EXECUTE 'DROP TABLE agents'; END $$;\n",
      expect: [],
      opaque: 1,
    },
    {
      name: 'the offending line is the statement, not the file',
      sql: `${NEW_TABLE}\n\n\nALTER TABLE "agents" DROP COLUMN "x";\n`,
      expect: ['destructive-drop'],
      line: 8,
    },
  ];

  const results = [];
  for (const testCase of cases) {
    const result = analyseMigration('fixture.sql', testCase.sql);
    const codes = result.findings.map((f) => f.code).sort();
    const expected = [...testCase.expect].sort();
    const detail = [];

    let ok = codes.join(',') === expected.join(',');
    if (!ok) detail.push(`expected [${expected.join(', ')}], got [${codes.join(', ')}]`);

    if (testCase.excused !== undefined && result.excused.length !== testCase.excused) {
      ok = false;
      detail.push(`expected ${testCase.excused} excused, got ${result.excused.length}`);
    }
    if (testCase.opaque !== undefined && result.opaque.length !== testCase.opaque) {
      ok = false;
      detail.push(`expected ${testCase.opaque} opaque block(s), got ${result.opaque.length}`);
    }
    if (testCase.line !== undefined && result.findings[0]?.line !== testCase.line) {
      ok = false;
      detail.push(`expected line ${testCase.line}, got ${result.findings[0]?.line}`);
    }

    results.push({ name: testCase.name, ok, detail: detail.join('; ') });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// `check` is the default, so continuous integration and a contributor at a
// terminal both get the enforcing behaviour from
// `node scripts/lint-migrations.mjs` with nothing to remember.
const args = process.argv.slice(2);
const named = args.filter((arg) => !arg.startsWith('-'));
const argv = args.filter((arg) => arg.startsWith('-'));
const command = named[0] ?? 'check';

if (command === 'help' || argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`AgentChat migration compatibility check

  check [--verbose]   enforce the compatibility and lock rules over
                      ${MIGRATIONS_DIR}/ (default). --verbose also prints what
                      this check cannot see.
  selftest            construct each violation and prove the check still
                      catches it, and each safe statement beside it and prove
                      the check stays quiet

Migrations are forward-only and run on boot against databases this project does
not control, so a migration that removes or narrows something breaks the
previous minor release with no way back but a backup (Plan section 12.3).

Destructive changes are therefore split across two releases — expand in release
N, contract in N+1 — and the contract half declares itself:

  -- contract-step: v0.3.0 — v0.3.0 stopped reading agents.legacy_name

That marker excuses the compatibility rules (DROP, RENAME, ALTER … TYPE,
SET NOT NULL, TRUNCATE, unbounded backfills). It does not excuse the lock rules
(a non-concurrent index, a validating constraint, a rewriting default, an
explicit table lock), because each of those has a non-blocking form that is no
harder to write.
`);
  process.exit(0);
}

if (!(command in commands)) fail(`unknown command "${command}"; run with --help`);
commands[command](argv);
