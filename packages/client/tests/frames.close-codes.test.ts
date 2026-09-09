/**
 * `WsCloseCode` is checked against `docs/protocol.md` §9.6.
 *
 * One wire vocabulary, two tables. `CloseCode` in `server/src/websocket/frames.ts`
 * is the server's; `WsCloseCode` in `../src/websocket/frames.ts` is this
 * client's, transcribed rather than imported because `packages/` is MIT and
 * `server/` is AGPL and that dependency arrow may not point that way at any
 * price (`scripts/check-licenses.mjs` enforces it).
 *
 * Two transcriptions of one vocabulary drift, and this pair already has: T-048
 * added `4429` to the server and to the document and could not reach this side,
 * so the reference client could not name a close code it was being sent. The
 * obvious test — compare the two enums — is the one thing the licence boundary
 * forbids. So the comparison goes through the document instead:
 * `server/tests/protocol-doc.test.ts` pins the server's table to §9.6, this
 * file pins the client's, and the two are thereby pinned to each other with
 * neither side importing the other. §9.6 is also what a third-party implementer
 * reads, so checking against it is not a proxy for the real check — it is the
 * real check.
 *
 * ## The two directions are not symmetric
 *
 * Every row of §9.6 must be a member here, under the same name. That is the
 * direction T-048 broke, and the one a consumer notices.
 *
 * The reverse is weaker, because this client legitimately interprets two codes
 * no server sends: `1001` and `1006` come from an intermediary or from the
 * local WebSocket implementation, and a client that did not know `1006` could
 * not tell a dropped connection from anything else. They are named in
 * {@link LOCALLY_PRODUCED} rather than waved through by a range check, so a
 * third undocumented code — a private-use number minted on this side, which is
 * this same bug running the other way — still fails.
 *
 * ## Why this file is here and not beside `frames.ts`
 *
 * It has to read a file, and `packages/client` cannot. That package compiles
 * with `lib: ["ES2023", "DOM"]` and no Node types precisely so that reaching
 * for `fs` is a compile error: Plan §5 forbids this package filesystem access,
 * because it is meant to be embedded in a browser or a worker. Importing
 * `node:fs` under `src/` fails `pnpm typecheck` with TS2591, which is that rule
 * working and not a rule to weaken.
 *
 * A package's `tests` directory is already a unit-test glob in
 * `vitest.config.ts` and is linted by Biome, but it is type-checked by nothing:
 * `packages/client/tsconfig.test.json` includes only the sources. That is a
 * real hole and is worth stating plainly rather than leaving to be discovered.
 *
 * Closing it is not a chore, which is why T-051 left it alone rather than doing
 * it quietly. It needs three changes in files that task does not own —
 * `rootDir: "."` and this directory in `include`, both of which
 * `packages/cli/tsconfig.test.json` already carries; and `@types/node` as a
 * devDependency of this package with `types: ["node"]`, which it deliberately
 * does not have. The last one is the decision. It is safe as far as it goes,
 * because the *build* project excludes `tests/` and would still reject `node:fs`
 * under `src/`, so the rule above survives — but it puts Node's types one
 * tsconfig away from a package whose whole point is that it does not have them,
 * and somebody should say so on purpose. Until then this file is written as
 * though it were checked (verified by compiling it under exactly those settings)
 * so that turning them on is a no-op rather than a repair.
 *
 * ## What it cannot see
 *
 * Meaning. A row whose remedy prose changed while its code and name stayed put
 * is invisible here, exactly as it is to the server's copy of this check. What
 * each code makes the reconnect loop *do* is asserted beside the code itself,
 * in `../src/websocket/frames.test.ts`.
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WsCloseCode } from '../src/websocket/frames.js';

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/** The reference this file exists to keep this client true to. */
const DOCUMENT_PATH = new URL('../../../docs/protocol.md', import.meta.url);

/**
 * The document's lines.
 *
 * A missing file is a failure and never a skip: a check that quietly stops
 * checking when it cannot find its input is worse than no check, because the
 * suite still reports green.
 */
const lines = ((): string[] => {
  try {
    return readFileSync(DOCUMENT_PATH, 'utf8').split('\n');
  } catch (cause) {
    throw new Error(
      `Could not read docs/protocol.md at ${DOCUMENT_PATH.pathname}. This test compares WsCloseCode against §9.6 of that document, so it needs the repository root and cannot run against packages/client on its own.`,
      { cause },
    );
  }
})();

/**
 * The lines of one section, by how its heading starts.
 *
 * @param headingPrefix - How the heading line begins, e.g. `'### 9.6 '`.
 * @returns Every line after that heading, up to the next heading of the same or
 *   a shallower level.
 * @throws If no heading starts with `headingPrefix`.
 */
function section(headingPrefix: string): string[] {
  const start = lines.findIndex((line) => line.startsWith(headingPrefix));
  if (start === -1) {
    throw new Error(
      `docs/protocol.md has no heading starting "${headingPrefix}". This check reads that section; restore the heading or update this test.`,
    );
  }

  const level = (/^#+/.exec(lines[start] ?? '')?.[0] ?? '#').length;
  const end = lines.findIndex(
    (line, index) =>
      index > start && /^#+ /.test(line) && (/^#+/.exec(line)?.[0] ?? '').length <= level,
  );

  return lines.slice(start + 1, end === -1 ? lines.length : end);
}

/**
 * The close codes §9.6 documents, as code to name.
 *
 * Scoped to that section rather than matched across the whole document, so a
 * table added elsewhere whose first column happens to be four digits cannot
 * quietly join the comparison.
 */
const documented = new Map<number, string>(
  section('### 9.6 ')
    .map((line) => /^\|\s*(\d{4})\s*\|\s*`([A-Z_]+)`\s*\|/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => [Number(match[1]), match[2] ?? ''] as const),
);

/** The close codes this client declares, as code to name. */
const declared = new Map<number, string>(
  Object.entries(WsCloseCode).map(([name, code]) => [code, name] as const),
);

/**
 * The codes this client interprets that no server sends.
 *
 * RFC 6455 §7.4.1 values produced by an intermediary or by the local WebSocket
 * implementation, which is why they are absent from §9.6 — that table documents
 * what this *server* closes with. Written out rather than derived: a rule of
 * "anything below 4000 is fine" would also wave through a code nobody meant to
 * add.
 */
const LOCALLY_PRODUCED: ReadonlyMap<number, string> = new Map([
  [1001, 'GOING_AWAY'],
  [1006, 'ABNORMAL'],
]);

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

describe('WsCloseCode against the close-code table in docs/protocol.md §9.6', () => {
  it('finds the table, so an empty parse cannot satisfy every check below', () => {
    // A renamed heading or a reformatted table would leave `documented` empty
    // and make the rest of this file vacuously true, which is the one failure
    // mode of a test that reads prose.
    expect(
      documented.size,
      'Parsed no rows out of docs/protocol.md §9.6. The heading or the table shape changed; fix the parser above rather than deleting this check.',
    ).toBeGreaterThanOrEqual(8);
  });

  it('names every close code the protocol documents', () => {
    const unnamed = [...documented]
      .filter(([code]) => !declared.has(code))
      .map(([code, name]) => `${code} ${name}`)
      .sort();

    expect(
      unnamed,
      'docs/protocol.md §9.6 documents these close codes and WsCloseCode has no member for them. This is the T-048 divergence again: server/ may not be imported from packages/, so the document is what this client is transcribed from. Add the member under the name the table gives it. Nothing breaks without it — closeDisposition falls an unrecognised code through to `retry` by design — but a consumer of this MIT package then sees a bare number where every other close gives it a case to match on.',
    ).toEqual([]);
  });

  it('gives each of them the name the protocol gives it', () => {
    const misnamed = [...documented]
      .filter(([code, name]) => declared.has(code) && declared.get(code) !== name)
      .map(([code, name]) => `${code}: documented as ${name}, declared as ${declared.get(code)}`)
      .sort();

    expect(
      misnamed,
      'These close codes are declared under a different name from the one docs/protocol.md §9.6 gives them. The name is half the contract: a consumer branching on WsCloseCode.SESSION_INVALID and an operator reading the protocol table have to be talking about the same close.',
    ).toEqual([]);
  });

  it('declares no code the protocol does not document and no transport produces', () => {
    const unexplained = [...declared]
      .filter(([code, name]) => !documented.has(code) && LOCALLY_PRODUCED.get(code) !== name)
      .map(([code, name]) => `${code} ${name}`)
      .sort();

    expect(
      unexplained,
      'These close codes are declared here and are neither documented in docs/protocol.md §9.6 nor one of the RFC 6455 codes a transport produces locally. A private-use code minted on this side is the T-048 divergence running the other way, and no server would ever send it: document it in §9.6 first, because §9 of the subagent protocol forbids one side of a shared contract inventing wire vocabulary. If a transport really does produce it, add it to LOCALLY_PRODUCED above with the reason.',
    ).toEqual([]);
  });
});
