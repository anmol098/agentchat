/**
 * An option given twice, asserted against the spawned binary.
 *
 * The counterpart to `../src/args.test.ts`. These are here rather than only
 * there because the check this file protects was previously dead: it lived in
 * `Args.value`, fired only when `parseArgs` had produced an array, and
 * `parseArgs` produces an array only for an option declared `multiple` — which
 * nothing is. The in-process test that covered it declared `multiple: true` to
 * reach the branch, so it typechecked, passed, and proved nothing about any
 * option the CLI actually has. Only running the real command line the bug report
 * quoted would have caught that, so that is what these do.
 *
 * @module
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Run } from './spawn.js';
import { buildPackage, parseNdjson, runCli } from './spawn.js';

/**
 * A home directory with nothing in it.
 *
 * Every case here fails during the parse, before any file is read, so this is
 * belt and braces: it means a developer's real `~/.config/agentchat` cannot
 * change what these assert even if the failure point ever moves.
 */
const HOME = mkdtempSync(join(tmpdir(), 'agentchat-args-'));

beforeAll(async () => {
  await buildPackage();
}, 180_000);

/**
 * Runs the binary with an empty home.
 *
 * @param argv - The arguments after the program name.
 * @returns Both streams and the exit code.
 */
function run(argv: readonly string[]): Promise<Run> {
  return runCli(argv, { env: { HOME } });
}

describe('an option given twice', () => {
  it('is a usage error naming the option and both values', async () => {
    // Verbatim from the bug report, which resolved to `beta` and said nothing.
    const result = await run(['status', '--project', 'alpha', '--project', 'beta']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('`--project` was given more than once');
    expect(result.stderr).toContain('alpha');
    expect(result.stderr).toContain('beta');
    // Not "the last one won, quietly": nothing resolved, so nothing is reported.
    expect(result.stdout).toBe('');
  });

  it('reports as JSON on stdout when --json was asked for', async () => {
    const result = await run(['status', '--project', 'alpha', '--project', 'beta', '--json']);

    expect(result.code).toBe(2);
    expect(result.stderr).toBe('');
    expect(parseNdjson(result.stdout)).toEqual([
      {
        error: {
          code: 'BAD_REQUEST',
          message:
            '`--project` was given more than once: `--project alpha`, then `--project beta`.',
          hint: expect.stringContaining('at most once') as unknown as string,
        },
      },
    ]);
  });

  it('quotes each occurrence as it was written, which says where each came from', async () => {
    // Two spellings of the same option are the signature of two pieces of a
    // harness contributing one each, and that is the thing worth reporting.
    const result = await run([
      'version',
      '--server=https://from-a-template.example',
      '--server',
      'https://from-the-default.example',
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('`--server=https://from-a-template.example`');
    expect(result.stderr).toContain('`--server https://from-the-default.example`');
  });

  it('catches a flag repeated, and a flag contradicted by its negation', async () => {
    const repeated = await run(['status', '--verbose', '--verbose']);
    const contradicted = await run(['status', '--verbose', '--no-verbose']);

    expect(repeated.code).toBe(2);
    expect(repeated.stderr).toContain('`--verbose` was given more than once');
    expect(contradicted.code).toBe(2);
    // Grouped by the option, not by the spelling: `--no-verbose` is the same
    // option said a second time, and the contradiction is the reason to say so.
    expect(contradicted.stderr).toContain('`--verbose` was given more than once');
  });

  it('catches a short alias and its long form as one option', async () => {
    const result = await run(['status', '-h', '--help']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('`--help` was given more than once');
  });
});

describe('what is not a repeated option', () => {
  it('lets one occurrence through, and resolves it', async () => {
    const result = await run(['status', '--project', 'alpha', '--json']);

    expect(result.code).toBe(0);
    const [report] = parseNdjson(result.stdout) as [{ project: Record<string, unknown> }];
    expect(report.project).toMatchObject({ slug: 'alpha', source: 'flag' });
  });

  it('leaves everything after `--` alone, because it is data', async () => {
    const result = await run(['--', '--project', 'a', '--project', 'b']);

    // It still fails — there is no command — but not for this reason. A message
    // body that happens to contain a flag twice is not a malformed command line.
    expect(result.stderr).not.toContain('more than once');
  });
});
