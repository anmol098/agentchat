import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The direction-aware half of the protocol snapshot guard, run from `pnpm test`.
 *
 * `scripts/protocol-snapshot.mjs` carries its own self-test — every kind of
 * change it classifies, constructed in each direction, asserted against the
 * verdict the script documents — for the same reason
 * `scripts/lint-migrations.mjs` does: the violations a checker exists to stop
 * are absent from the repository, so the only honest way to know it still
 * catches them is to build them on every run.
 *
 * That self-test runs inside `check`, which is what
 * `.github/workflows/protocol.yml` invokes. This file runs it a second time
 * from the unit suite, because `pnpm test` is a required gate on every pull
 * request (docs/subagent-protocol.md section 7.1) and the protocol workflow
 * needs a build first. A change that broke the classifier would otherwise be
 * red only in the slower job.
 *
 * It spawns the script rather than importing it: the file is a CLI that
 * dispatches on `process.argv` at the top level, so importing it would run a
 * command.
 */

const SCRIPT = fileURLToPath(new URL('../../scripts/protocol-snapshot.mjs', import.meta.url));

function runSelfTest(): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, 'selftest'], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('protocol snapshot self-test', () => {
  it('passes every case and reports how many it ran', () => {
    const { status, stdout, stderr } = runSelfTest();

    expect(stderr).toBe('');
    expect(stdout).not.toContain('FAIL');
    expect(status).toBe(0);

    const counted = /\n(\d+) self-test case\(s\) passed\./.exec(stdout);
    expect(counted?.[1]).toBeDefined();
    expect(Number(counted?.[1])).toBeGreaterThan(0);
  });

  /**
   * The four combinations T-039 is about, pinned by name.
   *
   * The verdicts on the right are the whole point of the task: the guard used
   * to answer "breaking" to all four, which demanded a major bump for a
   * response field that could strand nobody and stayed quiet about the
   * direction where a removal actually hurts.
   */
  it.each([
    ['request: a new field arrives required -> breaking'],
    ['response: a new field arrives required -> compatible'],
    ['request: a field is removed -> breaking'],
    ['response: a field is removed -> breaking'],
  ])('covers %s', (expected) => {
    expect(runSelfTest().stdout).toContain(`pass  ${expected}`);
  });

  /**
   * A shape that travels both ways, or that nothing classifies, has to get the
   * strict half of every rule — otherwise the direction rules would be a way of
   * quietly weakening the guard rather than sharpening it.
   */
  it('judges a shape that travels both ways strictly', () => {
    const { stdout } = runSelfTest();
    expect(stdout).toContain('pass  both: a new field arrives required -> breaking');
    expect(stdout).toContain('pass  both: a required field becomes optional -> breaking');
    expect(stdout).toContain('pass  an unclassified root is judged strictly -> breaking');
  });
});
