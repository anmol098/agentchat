/**
 * The guard on {@link clientFor} being the only place a CLI command builds a
 * client, and on every credential store the CLI opens having somewhere to warn.
 *
 * ## Why this is a source scan and not a behavioural test
 *
 * T-036 collapsed four private client constructions into `./client.ts`, and its
 * last acceptance criterion asks for a test that would fail if a fifth appeared.
 * There is no honest behavioural version of that test. A private copy is a
 * problem precisely because it behaves *the same* on the day it is written; the
 * whole failure mode is that it drifts later, silently, in one of the three ways
 * `./client.ts` documents — the version header, the credential store, the
 * warning sink. A test that waits for the drift is a test that catches it after
 * a release. Nothing observable at the moment the copy lands distinguishes it
 * from the shared call, so the copy itself is the only thing left to assert on.
 *
 * So this reads the source. That is unusual here and worth being honest about
 * its limits:
 *
 * - It catches a copy that names `AgentChatClient` or `createCredentialStore`
 *   directly, which is how all five copies to date were written.
 * - It does not catch a copy reached through a new indirection — a helper in
 *   another module, a factory passed in, a dynamic import. Nothing short of
 *   running every command against a probe could, and the allowlists below are
 *   short enough that a reviewer seeing one grow will ask why.
 * - It asserts the allowlist *exactly*, in both directions. Removing the last
 *   real reason for an exception fails this test too, which is the point: the
 *   list is meant to shrink as easily as it grows.
 *
 * `./version.test.ts` reads `package.json` off disk for a comparable reason, so
 * the shape is not new to this package.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));

/**
 * The two commands that build a client of their own, and the reason each is not
 * a copy of {@link clientFor}. Both are in `./client.ts`'s module note at
 * length; the sentence here is the short form, so that anyone adding a third
 * line has to write one too.
 */
const CLIENT_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  [
    'commands/version.ts',
    'talks to a --server given on the command line, as nobody, with no configuration',
  ],
  ['commands/status.ts', 'must report an unconfigured server as a finding, where clientFor throws'],
]);

/**
 * The files that open a credential store rather than letting `clientFor` open
 * one. Each needs the store *itself* and not merely a client built around one.
 */
const STORE_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  ['commands/auth.ts', 'asks whether any credentials exist before a server is resolved'],
  ['commands/setup.ts', 'the same question, and the delegated commands write through it'],
  ['commands/status.ts', 'reports on the credentials file as one of the things it checks'],
]);

/**
 * Every non-test TypeScript file under `packages/cli/src`, as a path relative to
 * it.
 *
 * Walked rather than listed so that a copy written in a directory that does not
 * exist yet is still scanned. `client.ts` itself is excluded, since it is the
 * one construction all of this exists to protect.
 *
 * @param directory - Where to start.
 * @returns The relative paths, sorted.
 */
function sourceFiles(directory: string = SRC): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      found.push(relative(SRC, full));
    }
  }
  return found.sort();
}

/**
 * The files whose source contains `pattern`.
 *
 * @param pattern - What a construction looks like.
 * @param skip - Files that are the implementation rather than a caller.
 * @returns The relative paths, sorted.
 */
function filesContaining(pattern: string, skip: readonly string[]): readonly string[] {
  return sourceFiles().filter(
    (file) => !skip.includes(file) && readFileSync(join(SRC, file), 'utf8').includes(pattern),
  );
}

describe('one client construction', () => {
  it('is built by clientFor everywhere but the two documented exceptions', () => {
    // Fails in both directions. A sixth private copy adds a file here; deleting
    // the reason one of the exceptions exists removes one, and this fails until
    // the allowlist above is shortened to match.
    expect(filesContaining('new AgentChatClient(', ['client.ts'])).toEqual(
      [...CLIENT_EXCEPTIONS.keys()].sort(),
    );
  });

  it('opens a credential store only where the store itself is needed', () => {
    expect(filesContaining('createCredentialStore({', ['client.ts', 'credentials.ts'])).toEqual(
      [...STORE_EXCEPTIONS.keys()].sort(),
    );
  });

  it('gives every credential store somewhere to warn', () => {
    // The specific silent failure T-036 named: `createCredentialStore` warns
    // about a credentials file other users can read, and a construction that
    // passes no sink discards that warning without a trace. Checked at every
    // call site rather than only in `clientFor`, because the exceptions above
    // are exactly the constructions that could get it wrong on their own.
    const callers = [...filesContaining('createCredentialStore({', ['credentials.ts'])];
    expect(callers).toContain('client.ts');

    for (const file of callers) {
      const source = readFileSync(join(SRC, file), 'utf8');
      for (const [index, line] of source.split('\n').entries()) {
        if (!line.includes('createCredentialStore({')) {
          continue;
        }
        // The options object is a handful of lines; `warn` is the second key in
        // all four call sites. A window rather than a parse, because the thing
        // being defended is that the key is present at all.
        const window = source
          .split('\n')
          .slice(index, index + 8)
          .join('\n');
        expect(window, `${file}:${String(index + 1)} builds a store with no warning sink`).toMatch(
          /\bwarn:/,
        );
      }
    }
  });
});
