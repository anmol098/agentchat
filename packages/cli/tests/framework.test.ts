/**
 * The framework, spawned, over commands that fail on purpose.
 *
 * `./binary.test.ts` proves the real `agentchat` behaves. This file proves the
 * *framework* behaves for the failures the real binary cannot yet produce,
 * because the commands that would produce them belong to T-204 and after. It
 * spawns `./fixtures/framework-cli.mjs`, which imports the built `dist` and
 * hands `run()` a registry of its own; every line between `argv` and the exit
 * code is the same code the real binary runs.
 *
 * Without this, exit 3 and exit 4 would ship untested and the exit-code contract
 * would be a comment.
 *
 * @module
 */

import { spawn } from 'node:child_process';
import { ERROR_CODES } from '@agentchat/protocol';
import { beforeAll, describe, expect, it } from 'vitest';

import { ANSI, buildPackage, FRAMEWORK_FIXTURE, parseNdjson, runCli } from './spawn.js';

/** Runs the fixture binary rather than the real one. */
function runFixture(argv: readonly string[], env?: Readonly<Record<string, string>>) {
  return runCli(argv, { script: FRAMEWORK_FIXTURE, ...(env === undefined ? {} : { env }) });
}

beforeAll(async () => {
  await buildPackage();
}, 180_000);

describe('operational output never touches stdout', () => {
  it('leaves stdout with the one result and stderr with every log line', async () => {
    const run = await runFixture(['noisy']);

    expect(run.code).toBe(0);
    expect(run.stdout).toBe('ok\n');
    expect(run.stderr).toContain('[agentchat] connecting to the server');
    expect(run.stderr).toContain('warning: the server is older than this client');
    expect(run.stderr).toContain('[agentchat] done');
  });

  it('keeps stdout parseable as JSON while stderr is full of chatter', async () => {
    const run = await runFixture(['noisy', '--json']);

    expect(run.code).toBe(0);
    expect(parseNdjson(run.stdout)).toEqual([
      { ok: true, note: 'this line is the only thing on stdout' },
    ]);
    expect(run.stderr.split('\n').length).toBeGreaterThan(2);
  });

  it('hides debug output unless --verbose asks for it', async () => {
    const quiet = await runFixture(['noisy']);
    const loud = await runFixture(['noisy', '--verbose']);

    expect(quiet.stderr).not.toContain('resolved project prj_test');
    expect(loud.stderr).toContain('resolved project prj_test');
    // --verbose changes stderr and nothing else.
    expect(loud.stdout).toBe(quiet.stdout);
  });

  it('silences stderr entirely under --quiet, without losing the result', async () => {
    const run = await runFixture(['noisy', '--quiet', '--json']);

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(parseNdjson(run.stdout)).toHaveLength(1);
  });

  it('emits one JSON value per line for a command that produces many', async () => {
    const run = await runFixture(['stream', '3', '--json']);

    expect(run.code).toBe(0);
    expect(parseNdjson(run.stdout)).toEqual([
      { event: 'tick', index: 0 },
      { event: 'tick', index: 1 },
      { event: 'tick', index: 2 },
    ]);
  });
});

describe('the exit-code contract', () => {
  /**
   * The mapping, written out rather than derived from `exitCodeForErrorCode`.
   *
   * A test that imported the function would agree with it by construction and
   * would keep agreeing after somebody changed it. These numbers are a published
   * interface — a shell script branches on them and cannot read a message — so
   * they are asserted as literals, and changing one has to mean changing this
   * table too.
   */
  const cases: readonly (readonly [string, number])[] = [
    ['BAD_REQUEST', 2],
    ['AUTH_REQUIRED', 3],
    ['AUTH_PENDING', 3],
    ['DEVICE_CODE_EXPIRED', 3],
    ['NO_PROJECT', 4],
    ['NO_AGENT', 4],
    ['FORBIDDEN', 1],
    ['NOT_FOUND', 1],
    ['CONFLICT', 1],
    ['PAYLOAD_TOO_LARGE', 1],
    ['UPGRADE_REQUIRED', 1],
    ['INVITE_INVALID', 1],
    ['AGENT_DELETED', 1],
    ['AGENT_NOT_IN_PROJECT', 1],
    ['SESSION_INVALID', 1],
    ['PROTOCOL_VIOLATION', 1],
    ['INTERNAL', 1],
    ['SERVER_UNREACHABLE', 1],
    ['RATE_LIMITED', 1],
  ];

  it('covers every code in the frozen set', () => {
    // Written-out literals do not stay complete on their own. T-017 added a
    // code and this table did not notice, because a missing row is a test that
    // simply never runs — the quietest way a suite can stop meaning anything.
    // Deriving the *expectations* would defeat the point above; deriving the
    // *coverage* does not.
    expect([...cases].map(([code]) => code).sort()).toEqual([...ERROR_CODES].sort());
  });

  it.each(cases)('exits %s with %i and reports the code on stdout', async (code, expected) => {
    const run = await runFixture(['fail', code, '--json']);

    expect(run.code).toBe(expected);
    expect(parseNdjson(run.stdout)).toMatchObject([{ error: { code } }]);
    expect(run.stderr).toBe('');
  });

  it.each(cases)('exits %s with %i in human mode too, stdout empty', async (code, expected) => {
    const run = await runFixture(['fail', code]);

    expect(run.code).toBe(expected);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain(`code: ${code}`);
  });

  it('offers a next step for every code', async () => {
    for (const [code] of cases) {
      const run = await runFixture(['fail', code, '--json']);
      const [envelope] = parseNdjson(run.stdout) as [{ error: { hint?: string } }];
      expect(envelope.error.hint, `${code} has no hint`).toBeTruthy();
    }
  });

  it('prefers the hint the thrower attached', async () => {
    const run = await runFixture([
      'fail',
      'NO_PROJECT',
      '--hint',
      'Run `agentchat setup`.',
      '--json',
    ]);

    expect(run.code).toBe(4);
    expect(parseNdjson(run.stdout)).toMatchObject([
      { error: { code: 'NO_PROJECT', hint: 'Run `agentchat setup`.' } },
    ]);
  });
});

describe('failures that are not the server’s fault', () => {
  it('turns a bug in the CLI into exit 1 with no stack trace', async () => {
    const run = await runFixture(['crash']);

    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('An unexpected internal error occurred.');
    expect(run.stderr).toContain('code: INTERNAL');
    expect(run.stderr).not.toContain('    at ');
    // The raw message would leak the shape of our internals to a user who can
    // do nothing with it; the hint tells them what to do instead.
    expect(run.stderr).toContain('--verbose');
  });

  it('shows the cause chain under --verbose, still without a stack', async () => {
    const run = await runFixture(['crash', '--verbose']);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('TypeError: Cannot read properties of undefined');
    expect(run.stderr).toContain('the response had no body');
    expect(run.stderr).not.toContain('    at ');
    expect(run.stdout).toBe('');
  });

  it('reports an unreachable server under a different code from a server fault', async () => {
    // The end-to-end form of T-017's acceptance criterion, and the only form
    // that proves it: two real processes, two `--json` streams, no access to a
    // JavaScript class. Before the code existed both of these printed
    // `INTERNAL`, so a harness had to choose one behaviour — retry, or report
    // against the request id — for two situations that want opposite ones.
    const unreachable = await runFixture(['transport', '--json']);
    const faulted = await runFixture(['fail', 'INTERNAL', '--json']);

    type Envelope = { error: { code: string; hint: string } };
    const [reported] = parseNdjson(unreachable.stdout) as [Envelope];
    const [server] = parseNdjson(faulted.stdout) as [Envelope];

    expect(reported.error.code).toBe('SERVER_UNREACHABLE');
    expect(server.error.code).toBe('INTERNAL');
    expect(reported.error.hint).toContain('network connection');
    expect(server.error.hint).not.toBe(reported.error.hint);

    // Distinct codes, deliberately the same exit code: exit 1 already means
    // "may retry", and neither has an automatable remedy the other lacks.
    expect(unreachable.code).toBe(1);
    expect(faulted.code).toBe(1);
  });

  it('tells a user to update when the response could not be parsed', async () => {
    const run = await runFixture(['format', '--json']);

    expect(run.code).toBe(1);
    const [envelope] = parseNdjson(run.stdout) as [{ error: { hint: string } }];
    expect(envelope.error.hint).toContain('Update');
  });

  it('passes through a wire code this build has never heard of', async () => {
    const run = await runFixture(['wire', 'QUOTA_EXCEEDED', '--json']);

    expect(run.code).toBe(1);
    expect(parseNdjson(run.stdout)).toMatchObject([{ error: { code: 'QUOTA_EXCEEDED' } }]);
  });
});

describe('command groups', () => {
  it('runs a subcommand', async () => {
    const run = await runFixture(['group', 'noisy', '--json']);

    expect(run.code).toBe(0);
    expect(parseNdjson(run.stdout)).toHaveLength(1);
  });

  it('accepts a global flag before the group name', async () => {
    const run = await runFixture(['--json', 'group', 'noisy']);

    expect(run.code).toBe(0);
    expect(parseNdjson(run.stdout)).toHaveLength(1);
  });

  it('exits 2 when a group is given with no subcommand', async () => {
    const run = await runFixture(['group']);

    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('needs a subcommand');
  });

  it('names the unknown subcommand rather than the group', async () => {
    const run = await runFixture(['group', 'nope', '--json']);

    expect(run.code).toBe(2);
    const [envelope] = parseNdjson(run.stdout) as [{ error: { message: string } }];
    expect(envelope.error.message).toContain('`nope`');
    expect(envelope.error.message).toContain('agentchat group');
  });

  it('sends group help to stdout when it was asked for', async () => {
    const run = await runFixture(['group', '--help']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('noisy');
    expect(run.stderr).toBe('');
  });
});

describe('a reader that goes away', () => {
  it('exits quietly when the pipe is closed mid-stream', async () => {
    // `head -1` closes the read end after one line. Without the EPIPE handling
    // in `bin.ts` and `streams.ts` this is an unhandled error event and a stack
    // trace about a pipe the user closed on purpose.
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(
        '/bin/sh',
        ['-c', `"${process.execPath}" "${FRAMEWORK_FIXTURE}" stream 5000 --json --quiet | head -1`],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.on('error', reject);
      child.on('close', (status) => {
        expect(stdout).toBe('{"event":"tick","index":0}\n');
        resolve(status);
      });
    });

    expect(code).toBe(0);
  }, 30_000);
});

describe('colour on the fixture, for completeness', () => {
  it('is absent from both descriptors when neither is a terminal', async () => {
    const run = await runFixture(['noisy']);

    expect(run.stdout).not.toMatch(ANSI);
    expect(run.stderr).not.toMatch(ANSI);
  });
});
