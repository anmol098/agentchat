/**
 * `WsCloseCode` is checked against `docs/protocol.md` §9.6.
 *
 * ## What this file guarded before, and what it guards now
 *
 * T-051 wrote it when there were two transcriptions of one wire vocabulary —
 * `CloseCode` in `server/src/websocket/frames.ts` and `WsCloseCode` here — and
 * the obvious test, comparing the two enums, was the one thing the licence
 * boundary forbids. So the comparison went through the document instead:
 * `server/tests/protocol-doc.test.ts` pinned the server's table to §9.6 and this
 * file pinned the client's, and the two were thereby pinned to each other with
 * neither importing the other.
 *
 * T-052 removed the transcription. The vocabulary now lives once, in
 * `@stackgrid/protocol`, and `WsCloseCode` is that table spread together with
 * {@link LocalCloseCode}. Divergence by omission — the T-048 failure, where a
 * code was added to one table and not the other — is no longer possible.
 *
 * This file is not therefore redundant, and deleting it would give up three
 * things the move does not cover:
 *
 * 1. **The shared table is still only pinned to the document by a test.** The
 *    move made one table instead of two; it did not make the table agree with
 *    the prose a third-party implementer actually reads. `protocol:check`
 *    guards the *shape* of the vocabulary and has no idea what §9.6 says.
 * 2. **This is the pin taken from the MIT side.** The server's copy of this
 *    check is the other one, and the two are deliberately independent: an agent
 *    working under `packages/` cannot run, read or fix an AGPL test, so a check
 *    that only existed there would be a check this half could not rely on.
 * 3. **{@link LocalCloseCode} is a new place for the same bug.** It is the
 *    client's own private table, small and undocumented in §9.6 on purpose, and
 *    nothing but the last assertion here stops a third code being added to it.
 *    That is the T-048 divergence with a new home.
 *
 * ## The two directions are not symmetric
 *
 * Every row of §9.6 must be a member of `WsCloseCode`, under the same name.
 *
 * The reverse is weaker, because this client legitimately interprets two codes
 * no server sends: `1001` and `1006` come from an intermediary or from the local
 * WebSocket implementation, and a client that did not know `1006` could not tell
 * a dropped connection from anything else. They are named in
 * {@link LOCALLY_PRODUCED} rather than waved through by a range check, and
 * written out here rather than read from `LocalCloseCode` — reading them from
 * the table under test would make the assertion agree with whatever that table
 * said, which is not an assertion. So a third undocumented code minted on this
 * side still fails.
 *
 * The last check runs that split the other way: neither of those two codes may
 * appear in the *shared* table, because the shared table is what the server
 * closes with and a server sending `1006` would be claiming a connection had
 * dropped while it was talking.
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
 * Closing it is not a chore, which is why T-051 left it alone and T-052 did too.
 * It needs three changes in files neither task owns — `rootDir: "."` and this
 * directory in `include`, both of which `packages/cli/tsconfig.test.json`
 * already carries; and `@types/node` as a devDependency of this package with
 * `types: ["node"]`, which it deliberately does not have. The last one is the
 * decision. It is safe as far as it goes, because the *build* project excludes
 * `tests/` and would still reject `node:fs` under `src/`, so the rule above
 * survives — but it puts Node's types one tsconfig away from a package whose
 * whole point is that it does not have them, and somebody should say so on
 * purpose. Until then this file is written as though it were checked so that
 * turning them on is a no-op rather than a repair.
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
import { CloseCode } from '@stackgrid/protocol';
import { describe, expect, it } from 'vitest';
import { LocalCloseCode, WsCloseCode } from '../src/websocket/frames.js';

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

/** Every close code this client interprets, as code to name. */
const declared = new Map<number, string>(
  Object.entries(WsCloseCode).map(([name, code]) => [code, name] as const),
);

/**
 * The codes this client interprets that no server sends.
 *
 * RFC 6455 §7.4.1 values produced by an intermediary or by the local WebSocket
 * implementation, which is why they are absent from §9.6 — that table documents
 * what this *server* closes with.
 *
 * Written out rather than imported from {@link LocalCloseCode}: an assertion
 * that reads its expectation out of the table it is checking agrees with
 * whatever that table says. A rule of "anything below 4000 is fine" would fail
 * the same way, one level up.
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
      'docs/protocol.md §9.6 documents these close codes and WsCloseCode has no member for them. Since T-052 the shared table in @stackgrid/protocol is spread into WsCloseCode, so the usual cause is that the code was written into the document and never into that table — add it there. This is the check taken from the MIT side; server/tests/protocol-doc.test.ts is the other one, and neither can see the other.',
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
      "These close codes are declared here and are neither documented in docs/protocol.md §9.6 nor one of the RFC 6455 codes a transport produces locally. Almost certainly one was added to LocalCloseCode, which is this client's private table and the one place the T-048 divergence can still happen: a code no server sends and no document describes. If a server really does send it, it belongs in the shared table in @stackgrid/protocol and in §9.6 — §9 of the subagent protocol forbids one side of a shared contract inventing wire vocabulary. If a transport really does produce it, add it to LOCALLY_PRODUCED above with the reason.",
    ).toEqual([]);
  });

  it('keeps the locally produced codes out of the shared table', () => {
    const leaked = [...LOCALLY_PRODUCED]
      .filter(([code]) => (Object.values(CloseCode) as number[]).includes(code))
      .map(([code, name]) => `${code} ${name}`)
      .sort();

    expect(
      leaked,
      'These codes are produced by a browser or a socket library and are now in the shared table in @stackgrid/protocol, which is the set the *server* closes with. A server sending 1006 would be claiming the connection had dropped while it was still talking. Keep them in LocalCloseCode, where they say who produces them.',
    ).toEqual([]);
  });
});
