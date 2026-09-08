#!/usr/bin/env node
/**
 * AgentChat protocol snapshot.
 *
 * `packages/protocol` is MIT so that anybody can embed the wire contract in a
 * harness this project does not control and cannot fix. Plan section 12.4 is
 * the promise that makes that safe: within a major version, protocol changes
 * are **additive only** — new optional fields and new frame types, never a
 * removed or narrowed one. This script is what enforces it.
 *
 * Usage: node scripts/protocol-snapshot.mjs <command> [options]
 * Run with no arguments for help.
 *
 * ## How it works
 *
 * `scripts/protocol-snapshot.json` is a committed record of the contract as it
 * stood the last time somebody accepted it. `check` rebuilds that record from
 * the live schemas and compares the two. Every difference is classified as
 * breaking (a field removed or narrowed) or compatible (a field added, a
 * constraint relaxed). Breaking differences fail the build and name the field.
 *
 * ## Why the snapshot is a flat map and not a JSON Schema document
 *
 * "Stable" is the whole job. A snapshot that churns on things that are not
 * contract changes gets regenerated reflexively, and a file people regenerate
 * without reading is a file that no longer means anything. So the snapshot is
 * deliberately *not* the shape zod hands back:
 *
 * - **One fact per line.** Every entry is `path -> scalar`, so a removed field
 *   is a removed line that names it, and a review diff is readable.
 * - **Sorted keys.** Reordering the fields of a `z.object`, or the modules in
 *   `schemas/index.ts`, changes nothing.
 * - **No arrays, anywhere.** `required` and `enum` are order-insensitive in
 *   JSON Schema, so they are flattened to one entry per member; inserting an
 *   error code in the middle of the list therefore adds one line instead of
 *   rewriting every line after it. Union branches are keyed by a digest of
 *   their own content rather than by position, for the same reason. The one
 *   place order genuinely means something — a tuple's `prefixItems` — keeps
 *   its index.
 * - **No arrays also settles the formatter.** Biome collapses a short JSON
 *   array onto one line and leaves objects expanded, so a snapshot containing
 *   arrays would drift between what this script writes and what
 *   `pnpm format:check` demands. With objects only, `JSON.stringify(x, null, 2)`
 *   is already Biome-formatted.
 *
 * ## How a deliberate breaking change is approved
 *
 * A check with no escape hatch gets deleted the first time somebody genuinely
 * needs a major bump, so there is one — but it costs three visible things, and
 * none of them can be done quietly in a diff:
 *
 * 1. `PROTOCOL_VERSION` in `packages/protocol/src/version.ts` must go up. That
 *    is the constant plan section 12.4 already defines for exactly this, and
 *    `update --accept-breaking` refuses to run until it has moved.
 * 2. `--accept-breaking` must be passed explicitly, together with a
 *    `--reason "…"` a human has to write.
 * 3. The reason, the version, and every broken path land in the snapshot's
 *    `acceptedBreakingChanges` ledger, in plain English, where a reviewer reads
 *    them next to the contract diff itself.
 *
 * Plain `update` refuses to write a snapshot that contains a breaking change at
 * all. That is the important half: the reflexive "just regenerate it" reflex
 * cannot launder a break, it can only carry an addition.
 *
 * ## What this can and cannot see
 *
 * It compares what the schemas *accept*, so it catches a field that vanished, a
 * field that became required, a pattern that changed, an enum that lost a
 * member, a bound that tightened. It cannot see a change in what a field
 * *means* while its shape stays identical — repurposing `role: "owner"` to mean
 * something new is a breaking change no serialiser can detect, and it is still
 * a major bump. It also only knows about schemas this package exports; a shape
 * declared privately somewhere else is invisible here, which is one more reason
 * nothing outside `packages/protocol` declares wire shapes.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_FILE = join(ROOT, 'scripts/protocol-snapshot.json');
const PROTOCOL_DIR = join(ROOT, 'packages/protocol');
const PROTOCOL_ENTRY = join(PROTOCOL_DIR, 'dist/index.js');
const VERSION_SOURCE = 'packages/protocol/src/version.ts';

/** Bumped only if the *shape of this file* changes, so a stale one is obvious. */
const SNAPSHOT_FORMAT = 1;

/**
 * Exports hoisted out of the contract map into their own snapshot fields.
 *
 * `PROTOCOL_VERSION` is the approval signal for a breaking change, so it must
 * not be compared as though it were part of the contract — a bump is the
 * opposite of a violation. `MIN_CLIENT_VERSION` is release metadata that moves
 * on its own schedule and would otherwise read as "a constant changed:
 * breaking".
 */
const HOISTED_EXPORTS = new Set(['PROTOCOL_VERSION', 'MIN_CLIENT_VERSION']);

/**
 * JSON Schema keywords whose array value is a set: order carries no meaning, so
 * members are keyed by themselves rather than by position.
 */
const SET_VALUED_KEYWORDS = new Set(['required', 'enum', 'type', 'examples']);

/**
 * JSON Schema keywords whose array value is a set of *sub-schemas*. Members are
 * keyed by a digest of their content so that adding one branch does not
 * renumber the others.
 */
const BRANCH_KEYWORDS = new Set(['anyOf', 'oneOf', 'allOf']);

/**
 * Keywords that only ever make a schema accept *less*. Adding one to a field,
 * or removing one from it, is therefore a narrowing or a widening respectively,
 * whatever the field is.
 */
const CONSTRAINT_KEYWORDS = new Set([
  'additionalProperties',
  'const',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
  'multipleOf',
  'pattern',
  'type',
  'uniqueItems',
]);

/** Constraints whose *increase* narrows the accepted set. */
const LOWER_BOUND_KEYWORDS = new Set([
  'exclusiveMinimum',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
]);

/** Constraints whose *decrease* narrows the accepted set. */
const UPPER_BOUND_KEYWORDS = new Set([
  'exclusiveMaximum',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
]);

/** How deep the walker will follow a nested exported object before giving up. */
const MAX_EXPORT_DEPTH = 8;

const MAJOR_BUMP = 'Requires a MAJOR version bump.';
const MINOR_BUMP = 'Additive: no protocol version bump needed.';

// ---------------------------------------------------------------------------
// Loading the live protocol package
// ---------------------------------------------------------------------------

/**
 * Import the built protocol package and the copy of zod it was built against.
 *
 * The package is read from `dist/`, not from source: this script has no
 * TypeScript loader and the repository already builds before it tests. zod is
 * resolved relative to `packages/protocol` rather than from here, because it is
 * that package's dependency and this script is not allowed to have any.
 */
async function loadProtocol() {
  if (!existsSync(PROTOCOL_ENTRY)) {
    fail(
      `${relative(ROOT, PROTOCOL_ENTRY)} does not exist. Run \`pnpm build\` first; this script reads the built package, not the TypeScript source.`,
    );
  }

  const requireFromProtocol = createRequire(join(PROTOCOL_DIR, 'package.json'));
  let zod;
  try {
    zod = await import(pathToFileURL(requireFromProtocol.resolve('zod')).href);
  } catch (error) {
    fail(`cannot resolve zod from packages/protocol: ${error.message}`);
  }

  const protocol = await import(pathToFileURL(PROTOCOL_ENTRY).href);
  return { zod, protocol };
}

// ---------------------------------------------------------------------------
// Building the contract map
// ---------------------------------------------------------------------------

/** Escape a value used as one `/`-separated path segment. */
function segment(value) {
  return String(value).replace(/%/g, '%25').replace(/\//g, '%2F');
}

/** Stable JSON for hashing: object keys sorted, everything else as-is. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** A short content address, used to key union branches by what they are. */
function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 8);
}

function isZodSchema(value) {
  return typeof value === 'object' && value !== null && '_zod' in value;
}

function isScalar(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

/** Flatten one JSON Schema array value according to what its keyword means. */
function flattenArray(items, path, keyword, out) {
  if (items.length === 0) {
    out[path] = [];
    return;
  }

  if (SET_VALUED_KEYWORDS.has(keyword) && items.every(isScalar)) {
    for (const item of items) {
      // `required` names fields that exist elsewhere in the map, so repeating
      // the name as the value would be noise; the marker reads better in a diff.
      out[`${path}/${segment(item)}`] = keyword === 'required' ? true : item;
    }
    return;
  }

  if (BRANCH_KEYWORDS.has(keyword)) {
    for (const item of items) flattenNode(item, `${path}/${digest(item)}`, out);
    return;
  }

  // Everything else — `prefixItems` above all — is genuinely ordered.
  for (const [index, item] of items.entries()) flattenNode(item, `${path}/${index}`, out);
}

/** Flatten a JSON Schema node into `path -> scalar` entries. */
function flattenNode(node, path, out) {
  if (node === null || typeof node !== 'object') {
    out[path] = node;
    return;
  }
  if (Array.isArray(node)) {
    flattenArray(node, path, path.slice(path.lastIndexOf('/') + 1), out);
    return;
  }

  for (const key of Object.keys(node).sort()) {
    const value = node[key];
    const childPath = `${path}/${segment(key)}`;
    if (Array.isArray(value)) flattenArray(value, childPath, key, out);
    else flattenNode(value, childPath, out);
  }
}

/**
 * Describe one exported value.
 *
 * Functions and classes are skipped: they are the package's TypeScript surface,
 * which a consumer's own compiler already guards, and this file is about what
 * goes over the wire. Everything else — schemas, frozen enums, the exported
 * patterns, the header name — is contract.
 */
function describeExport(value, path, out, zod, depth = 0) {
  if (typeof value === 'function') return;

  if (depth > MAX_EXPORT_DEPTH) {
    fail(`${path}: exported value nests deeper than ${MAX_EXPORT_DEPTH} levels`);
  }

  if (isZodSchema(value)) {
    let jsonSchema;
    try {
      // `io: 'input'` describes what a peer may *send*, which is the only
      // question compatibility asks. It is also the only mode that survives a
      // schema carrying a transform, which `output` refuses to represent.
      jsonSchema = zod.toJSONSchema(value, { io: 'input' });
    } catch (error) {
      fail(
        `${path}: this schema cannot be serialised (${error.message}). A wire schema that JSON Schema cannot describe is a schema no third party can implement against; express it in terms JSON Schema has, or the snapshot stops covering it.`,
      );
    }
    // Identical on every entry, so it lives once at the top of the file.
    delete jsonSchema.$schema;
    flattenNode(jsonSchema, path, out);
    return;
  }

  if (value instanceof RegExp) {
    out[`${path}/pattern`] = value.source;
    out[`${path}/flags`] = value.flags;
    return;
  }

  if (isScalar(value) || value === undefined) {
    out[path] = value ?? null;
    return;
  }

  if (Array.isArray(value)) {
    // Every exported array in this package is a frozen set whose order is
    // documented as meaningless (ERROR_CODES, PROJECT_ROLES), so key by member.
    if (value.every(isScalar)) {
      for (const item of value) out[`${path}/${segment(item)}`] = item;
      return;
    }
    for (const [index, item] of value.entries()) {
      describeExport(item, `${path}/${index}`, out, zod, depth + 1);
    }
    return;
  }

  for (const key of Object.keys(value).sort()) {
    describeExport(value[key], `${path}/${segment(key)}`, out, zod, depth + 1);
  }
}

/**
 * Build the whole contract map from the live package.
 *
 * Sorted by path at the end rather than relying on insertion order: that is
 * what makes reordering the fields of a `z.object`, or the export blocks in
 * `schemas/index.ts`, produce no diff at all.
 */
function buildContract(protocol, zod) {
  const contract = {};
  for (const name of Object.keys(protocol).sort()) {
    if (HOISTED_EXPORTS.has(name)) continue;
    describeExport(protocol[name], segment(name), contract, zod);
  }
  return sortKeys(contract);
}

/** Build the snapshot document that gets written to disk. */
function buildSnapshot(protocol, zod, acceptedBreakingChanges) {
  return {
    $comment:
      'Generated by scripts/protocol-snapshot.mjs. Do not edit by hand: run `node scripts/protocol-snapshot.mjs update`. Each entry under "contract" is one fact about the wire protocol; removing or narrowing one is a breaking change under plan section 12.4.',
    format: SNAPSHOT_FORMAT,
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    protocolVersion: protocol.PROTOCOL_VERSION,
    minClientVersion: protocol.MIN_CLIENT_VERSION,
    acceptedBreakingChanges,
    contract: buildContract(protocol, zod),
  };
}

// ---------------------------------------------------------------------------
// Reading the committed snapshot
// ---------------------------------------------------------------------------

function readSnapshot() {
  if (!existsSync(SNAPSHOT_FILE)) {
    fail(
      `${relative(ROOT, SNAPSHOT_FILE)} does not exist. Create it with \`node scripts/protocol-snapshot.mjs update\`.`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8'));
  } catch (error) {
    fail(`${relative(ROOT, SNAPSHOT_FILE)} is not valid JSON: ${error.message}`);
  }

  if (parsed.format !== SNAPSHOT_FORMAT) {
    fail(
      `${relative(ROOT, SNAPSHOT_FILE)} is format ${parsed.format}, but this script writes format ${SNAPSHOT_FORMAT}. The two cannot be compared; regenerate the snapshot deliberately and review the whole diff.`,
    );
  }
  return parsed;
}

function writeSnapshot(snapshot) {
  writeFileSync(SNAPSHOT_FILE, `${JSON.stringify(snapshot, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Comparing two contract maps
// ---------------------------------------------------------------------------

/**
 * Every `<prefix>/properties/<field>` boundary in a path, outermost first.
 *
 * Used to report "the field went away" once, rather than reporting each of the
 * eight lines that described it.
 */
function propertyRoots(path) {
  const parts = path.split('/');
  const roots = [];
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (parts[i] === 'properties') roots.push(parts.slice(0, i + 2).join('/'));
  }
  return roots;
}

function coversSubtree(keys, prefix) {
  return keys.has(prefix) || [...keys].some((key) => key.startsWith(`${prefix}/`));
}

/**
 * If `path` sits inside a subtree that is wholly absent from `others`, return
 * the outermost such subtree — the thing that was actually added or removed.
 */
function vanishedRoot(path, others) {
  const exportName = path.split('/')[0];
  if (!coversSubtree(others, exportName)) return { root: exportName, kind: 'export' };
  for (const root of propertyRoots(path)) {
    if (!coversSubtree(others, root)) return { root, kind: 'field' };
  }
  return null;
}

/** Split `<object path>/required/<field>` into its parts, or return null. */
function requiredEntry(path) {
  const parts = path.split('/');
  if (parts.length < 3 || parts[parts.length - 2] !== 'required') return null;
  return {
    objectPath: parts.slice(0, parts.length - 2).join('/'),
    field: parts[parts.length - 1],
  };
}

function lastKeyword(path) {
  const parts = path.split('/');
  // A set member is keyed by its own value, so the keyword is one further up.
  return parts[parts.length - 1];
}

/**
 * Classify every difference between two contract maps.
 *
 * Returns findings, each `{ breaking, path, summary, detail }`. Conservative by
 * construction: anything this function cannot prove is a widening is reported
 * as breaking, because the cost of a false alarm is a conversation and the cost
 * of a miss is a stranded client.
 */
function compareContracts(before, after) {
  const oldKeys = new Set(Object.keys(before));
  const newKeys = new Set(Object.keys(after));
  const findings = [];
  const reported = new Set();

  const add = (breaking, path, summary, detail) => {
    const id = `${path} ${summary}`;
    if (reported.has(id)) return;
    reported.add(id);
    findings.push({ breaking, path, summary, detail });
  };

  for (const path of oldKeys) {
    if (newKeys.has(path)) continue;

    const gone = vanishedRoot(path, newKeys);
    if (gone) {
      if (gone.kind === 'export') {
        add(
          true,
          gone.root,
          'export removed',
          'Every client built against this snapshot still imports it. Removing an exported part of the contract strands them.',
        );
      } else {
        add(
          true,
          gone.root,
          'field removed',
          'A peer built against this snapshot still sends this field, or still reads it and now finds it missing.',
        );
      }
      continue;
    }

    const required = requiredEntry(path);
    if (required) {
      // A field that was deleted outright also stops being required. That is
      // one event, not two, and reporting it twice would file half of a
      // breaking change under "compatible".
      if (!coversSubtree(newKeys, `${required.objectPath}/properties/${required.field}`)) continue;
      add(
        false,
        path,
        `field "${required.field}" is no longer required`,
        'Making a field optional accepts everything it accepted before.',
      );
      continue;
    }

    const keyword = lastKeyword(path);
    if (CONSTRAINT_KEYWORDS.has(keyword)) {
      add(
        false,
        path,
        `constraint "${keyword}" removed`,
        'Dropping a constraint widens what is accepted; nothing that used to be valid stopped being valid.',
      );
      continue;
    }

    const parts = path.split('/');
    if (parts.length >= 2 && parts[parts.length - 2] === 'enum') {
      add(
        true,
        path,
        `enum value "${parts[parts.length - 1]}" removed`,
        'A peer that still sends this value is now rejected, and one that still branches on it is now dead code.',
      );
      continue;
    }

    add(
      true,
      path,
      'contract entry removed',
      'This entry described something a peer may rely on, and it is gone.',
    );
  }

  for (const path of newKeys) {
    if (oldKeys.has(path)) continue;

    const required = requiredEntry(path);
    if (required) {
      const property = `${required.objectPath}/properties/${required.field}`;
      // A brand-new field is reported once, at the field itself, where the
      // verdict already accounts for whether it arrived required.
      if (!coversSubtree(oldKeys, property) && coversSubtree(newKeys, property)) continue;
      add(
        true,
        path,
        `optional field "${required.field}" is now required`,
        'A peer that legitimately omitted this field is now rejected. Add it as optional instead, or bump the major version.',
      );
      continue;
    }

    const fresh = vanishedRoot(path, oldKeys);
    if (fresh) {
      if (fresh.kind === 'export') {
        add(
          false,
          fresh.root,
          'export added',
          'New exports are additive; nobody depended on it yet.',
        );
        continue;
      }
      // `<object>/properties/<field>` — is the object now demanding it?
      const parts = fresh.root.split('/');
      const field = parts[parts.length - 1];
      const requiredNow = newKeys.has(
        `${parts.slice(0, parts.length - 2).join('/')}/required/${field}`,
      );
      add(
        requiredNow,
        fresh.root,
        requiredNow ? `new field "${field}" is required` : 'optional field added',
        requiredNow
          ? 'A peer built against this snapshot does not know to send this field, so every request it makes is now rejected. Make it optional instead, or bump the major version.'
          : 'Object schemas strip properties they do not know, so an older peer ignores this field rather than failing on it (plan section 12.4).',
      );
      continue;
    }

    const keyword = lastKeyword(path);
    if (CONSTRAINT_KEYWORDS.has(keyword)) {
      add(
        true,
        path,
        `constraint "${keyword}" added`,
        'A value a peer may already be sending is now rejected. Adding a constraint to a shipped field is a narrowing.',
      );
      continue;
    }

    const parts = path.split('/');
    if (parts.length >= 2 && parts[parts.length - 2] === 'enum') {
      add(
        false,
        path,
        `enum value "${parts[parts.length - 1]}" added`,
        'Both sides must tolerate values they do not recognise, so a new member is additive.',
      );
      continue;
    }

    if (parts.length >= 2 && BRANCH_KEYWORDS.has(parts[parts.length - 2])) {
      const branch = parts[parts.length - 2];
      add(
        branch === 'allOf',
        path,
        `${branch} branch added`,
        branch === 'allOf'
          ? 'Another allOf branch is one more condition every value must satisfy: a narrowing.'
          : 'One more alternative accepts everything the union accepted before.',
      );
      continue;
    }

    add(false, path, 'contract entry added', 'Additions are the additive-only case.');
  }

  for (const path of oldKeys) {
    if (!newKeys.has(path)) continue;
    const from = before[path];
    const to = after[path];
    if (canonicalJson(from) === canonicalJson(to)) continue;

    const keyword = lastKeyword(path);
    const rendered = `${JSON.stringify(from)} -> ${JSON.stringify(to)}`;

    if (LOWER_BOUND_KEYWORDS.has(keyword) && typeof from === 'number' && typeof to === 'number') {
      add(
        to > from,
        path,
        `"${keyword}" ${to > from ? 'raised' : 'lowered'}: ${rendered}`,
        to > from
          ? 'Values a peer may already be sending are now too small or too short.'
          : 'A lower floor accepts everything the old one accepted.',
      );
      continue;
    }
    if (UPPER_BOUND_KEYWORDS.has(keyword) && typeof from === 'number' && typeof to === 'number') {
      add(
        to < from,
        path,
        `"${keyword}" ${to < from ? 'lowered' : 'raised'}: ${rendered}`,
        to < from
          ? 'Values a peer may already be sending are now too large or too long.'
          : 'A higher ceiling accepts everything the old one accepted.',
      );
      continue;
    }
    if (keyword === 'pattern') {
      add(
        true,
        path,
        'pattern changed',
        'No checker can prove one regular expression accepts everything another one did, so any change to a shipped grammar is treated as a narrowing. If it genuinely only loosens the grammar, that is still a judgement a human has to record.',
      );
      continue;
    }

    add(
      true,
      path,
      `value changed: ${rendered}`,
      'A peer built against this snapshot expects the old value.',
    );
  }

  findings.sort((a, b) => a.path.localeCompare(b.path) || a.summary.localeCompare(b.summary));
  return findings;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function wrap(text, indent) {
  const width = 100 - indent.length;
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => `${indent}${l}`).join('\n');
}

function reportFindings(findings, stream) {
  const breaking = findings.filter((f) => f.breaking);
  const compatible = findings.filter((f) => !f.breaking);

  if (breaking.length) {
    stream.write(`\nBREAKING (${breaking.length}) — ${MAJOR_BUMP}\n\n`);
    for (const f of breaking) {
      stream.write(`  ${f.path}\n`);
      stream.write(`    ${f.summary}\n`);
      stream.write(`${wrap(f.detail, '      ')}\n\n`);
    }
  }

  if (compatible.length) {
    stream.write(`\nCOMPATIBLE (${compatible.length}) — ${MINOR_BUMP}\n\n`);
    for (const f of compatible) {
      stream.write(`  ${f.path}\n`);
      stream.write(`    ${f.summary}\n`);
    }
    stream.write('\n');
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const commands = {
  /**
   * Compare the live schemas with the committed snapshot. The CI gate.
   */
  async check() {
    const { zod, protocol } = await loadProtocol();
    const committed = readSnapshot();
    const current = buildSnapshot(protocol, zod, committed.acceptedBreakingChanges ?? {});
    const findings = compareContracts(committed.contract, current.contract);

    const entries = Object.keys(current.contract).length;
    process.stdout.write(
      `Protocol snapshot: ${relative(ROOT, SNAPSHOT_FILE)} (${entries} contract entries, PROTOCOL_VERSION ${current.protocolVersion})\n`,
    );

    if (findings.length === 0) {
      if (committed.protocolVersion !== current.protocolVersion) {
        process.stdout.write(
          `\nPROTOCOL_VERSION moved to ${current.protocolVersion} with no contract change. Refresh the snapshot: node scripts/protocol-snapshot.mjs update\n`,
        );
        process.exit(1);
      }
      process.stdout.write('Protocol snapshot OK: the wire contract is unchanged.\n');
      return;
    }

    reportFindings(findings, process.stdout);

    const breaking = findings.filter((f) => f.breaking);
    if (breaking.length === 0) {
      process.stderr.write(
        'error: the wire contract changed and the snapshot is out of date.\n\n' +
          'Every change above is additive, so this is only a stale file. Refresh it and commit it\n' +
          'with the change that caused it:\n\n' +
          '  node scripts/protocol-snapshot.mjs update\n',
      );
      process.exit(1);
    }

    process.stderr.write(
      `error: ${breaking.length} breaking change(s) to the wire protocol.\n\n` +
        `${wrap(
          `packages/protocol is MIT so third parties can embed it, and plan section 12.4 promises them that within a major version the protocol only ever gains optional fields and frame types. Each change above breaks a client this project does not control and cannot fix.`,
          '  ',
        )}\n\n` +
        '  If this was a mistake, keep the field: add the new one alongside it as optional.\n\n' +
        '  If it is deliberate, it is a major release, and that has to be recorded:\n\n' +
        `    1. raise PROTOCOL_VERSION in ${VERSION_SOURCE} (currently ${current.protocolVersion})\n` +
        '    2. node scripts/protocol-snapshot.mjs update --accept-breaking --reason "why"\n' +
        '    3. say the same thing in the release notes (plan section 12.1)\n',
    );
    process.exit(1);
  },

  /**
   * Rewrite the snapshot. Refuses to record a breaking change without an
   * explicit, reasoned, version-bumped acceptance.
   */
  async update(argv) {
    const { zod, protocol } = await loadProtocol();
    const accept = has(argv, 'accept-breaking');
    const reason = flag(argv, 'reason');

    const committed = existsSync(SNAPSHOT_FILE) ? readSnapshot() : null;
    const ledger = { ...(committed?.acceptedBreakingChanges ?? {}) };
    const current = buildSnapshot(protocol, zod, ledger);

    if (!committed) {
      writeSnapshot(current);
      process.stdout.write(
        `Wrote ${relative(ROOT, SNAPSHOT_FILE)}: ${Object.keys(current.contract).length} contract entries.\n`,
      );
      return;
    }

    const findings = compareContracts(committed.contract, current.contract);
    const breaking = findings.filter((f) => f.breaking);

    if (breaking.length === 0) {
      if (accept) fail('--accept-breaking was passed, but nothing in the contract broke.');
      writeSnapshot(current);
      reportFindings(findings, process.stdout);
      process.stdout.write(
        `Wrote ${relative(ROOT, SNAPSHOT_FILE)}: ${findings.length} compatible change(s).\n`,
      );
      return;
    }

    reportFindings(findings, process.stdout);

    if (!accept) {
      process.stderr.write(
        `error: refusing to write a snapshot that drops or narrows ${breaking.length} part(s) of the wire contract.\n\n` +
          `${wrap(
            'Regenerating a snapshot must never be the cheap way past this. If the break was accidental, fix the schema. If it is deliberate it is a major release: raise PROTOCOL_VERSION and say why, so the acceptance is in the diff a reviewer reads.',
            '  ',
          )}\n\n` +
          `  1. raise PROTOCOL_VERSION in ${VERSION_SOURCE} (currently ${current.protocolVersion})\n` +
          '  2. node scripts/protocol-snapshot.mjs update --accept-breaking --reason "why"\n',
      );
      process.exit(1);
    }

    if (!reason) fail('--accept-breaking requires --reason "<why this break is worth it>"');

    if (current.protocolVersion <= committed.protocolVersion) {
      fail(
        `a breaking change requires a major bump, but PROTOCOL_VERSION is still ${current.protocolVersion}. Raise it in ${VERSION_SOURCE} first.`,
      );
    }

    for (const f of breaking) {
      ledger[`v${current.protocolVersion} ${f.path}`] = {
        change: f.summary,
        reason,
        acceptedOn: new Date().toISOString().slice(0, 10),
      };
    }
    current.acceptedBreakingChanges = sortKeys(ledger);
    writeSnapshot(current);

    process.stdout.write(
      `\nWrote ${relative(ROOT, SNAPSHOT_FILE)} at PROTOCOL_VERSION ${current.protocolVersion}, ` +
        `recording ${breaking.length} accepted breaking change(s).\n` +
        'The release notes must carry the same explanation (plan section 12.1).\n',
    );
  },
};

function sortKeys(object) {
  const sorted = {};
  for (const key of Object.keys(object).sort()) sorted[key] = object[key];
  return sorted;
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function flag(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

function has(argv, name) {
  return argv.includes(`--${name}`);
}

const [, , command, ...argv] = process.argv;

if (!command || command === 'help' || command === '--help') {
  process.stdout.write(`AgentChat protocol snapshot (plan sections 12.4 and 12.6)

  check                                      fail on a removed or narrowed field (CI gate)
  update                                     refresh the snapshot after an additive change
  update --accept-breaking --reason "…"      record a deliberate break; needs PROTOCOL_VERSION bumped

Snapshot: scripts/protocol-snapshot.json
Reads:    packages/protocol/dist — run \`pnpm build\` first.
`);
  process.exit(command ? 0 : 1);
}

if (!(command in commands)) fail(`unknown command "${command}"; run with --help`);
await commands[command](argv);
