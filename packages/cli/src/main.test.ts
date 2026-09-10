import { ErrorCode } from '@stackgrid/protocol';
import { describe, expect, it } from 'vitest';

import type { Command, CommandNode } from './command.js';
import { CliError } from './errors.js';
import { ExitCode } from './exit.js';
import { view } from './output/output.js';
import { captureRun } from './testing.js';

/** An ANSI SGR escape, which must never reach a stream that is not a terminal. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`);

/** A command that succeeds, logs on the way, and takes one argument. */
const echo: Command = {
  kind: 'command',
  name: 'echo',
  summary: 'echo its argument',
  usage: 'echo <text>',
  positionals: { min: 1, max: 1 },
  async run(context) {
    context.log.info('about to echo');
    await context.emit(
      view({ text: context.args.positionals[0] ?? '' }, (writer) => {
        writer.line(context.args.positionals[0] ?? '');
      }),
    );
  },
};

/** A command that fails with a code and a remedy. */
const denied: Command = {
  kind: 'command',
  name: 'denied',
  summary: 'always fail',
  run() {
    return Promise.reject(new CliError(ErrorCode.AUTH_REQUIRED, 'Not signed in.'));
  },
};

/** A command that produces nothing at all. */
const silent: Command = {
  kind: 'command',
  name: 'silent',
  summary: 'do nothing visible',
  run() {
    return Promise.resolve();
  },
};

const commands: readonly CommandNode[] = [
  echo,
  denied,
  silent,
  { kind: 'group', name: 'group', summary: 'a namespace', children: [echo] },
];

describe('run', () => {
  it('emits the result and nothing else on stdout', async () => {
    const capture = await captureRun(['echo', 'hello'], { commands });

    expect(capture.code).toBe(ExitCode.OK);
    expect(capture.stdout).toBe('hello\n');
    expect(capture.stderr).toContain('about to echo');
  });

  it('writes nothing to stdout for a command with no result', async () => {
    const capture = await captureRun(['silent', '--json'], { commands });

    expect(capture.code).toBe(ExitCode.OK);
    expect(capture.stdout).toBe('');
  });

  it('puts the failure envelope on stdout in JSON mode and nothing on stderr', async () => {
    const capture = await captureRun(['denied', '--json'], { commands });

    expect(capture.code).toBe(ExitCode.AUTH_REQUIRED);
    expect(JSON.parse(capture.stdout)).toEqual({
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Not signed in.',
        hint: 'Run `agentchat login`.',
      },
    });
    expect(capture.stderr).toBe('');
  });

  it('puts the failure on stderr in human mode and leaves stdout empty', async () => {
    const capture = await captureRun(['denied'], { commands });

    expect(capture.code).toBe(ExitCode.AUTH_REQUIRED);
    expect(capture.stdout).toBe('');
    expect(capture.stderr).toContain('error: Not signed in.');
  });

  it('reports a usage error in the mode the caller asked for, even when the parse failed', async () => {
    const capture = await captureRun(['--json', 'echo', '--nope', 'x'], { commands });

    expect(capture.code).toBe(ExitCode.USAGE);
    expect(JSON.parse(capture.stdout)).toMatchObject({ error: { code: 'BAD_REQUEST' } });
    expect(capture.stderr).toBe('');
  });

  it('rejects too few and too many positionals alike', async () => {
    const few = await captureRun(['echo'], { commands });
    const many = await captureRun(['echo', 'a', 'b'], { commands });

    expect(few.code).toBe(ExitCode.USAGE);
    expect(few.stderr).toContain('needs 1 argument');
    expect(many.code).toBe(ExitCode.USAGE);
    expect(many.stderr).toContain('Unexpected argument `b`');
  });

  it('shows help on stdout when it was asked for and on stderr when it was not', async () => {
    const asked = await captureRun(['--help'], { commands });
    const failed = await captureRun([], { commands });

    expect(asked.code).toBe(ExitCode.OK);
    expect(asked.stdout).toContain('Usage: agentchat');
    expect(asked.stderr).toBe('');

    expect(failed.code).toBe(ExitCode.USAGE);
    expect(failed.stdout).toBe('');
    expect(failed.stderr).toContain('Usage: agentchat');
  });

  it('suppresses the help dump in JSON mode, leaving only the envelope', async () => {
    const capture = await captureRun(['--json'], { commands });

    expect(capture.stderr).toBe('');
    expect(JSON.parse(capture.stdout)).toMatchObject({ error: { code: 'BAD_REQUEST' } });
  });

  it('decides colour per descriptor, not once for the process', async () => {
    // stderr is a pipe here even though stdout is a terminal, so the failure
    // report on it must be plain — a redirected stderr is still a captured one.
    const split = await captureRun(['denied'], { commands, stdoutIsTTY: true, stderrIsTTY: false });
    const both = await captureRun(['denied'], { commands, stdoutIsTTY: true, stderrIsTTY: true });

    expect(split.stderr).not.toMatch(ANSI);
    expect(both.stderr).toMatch(ANSI);
  });

  it('never colours JSON, even on a terminal that forces it', async () => {
    const capture = await captureRun(['denied', '--json'], {
      commands,
      stdoutIsTTY: true,
      env: { FORCE_COLOR: '1' },
    });

    expect(capture.stdout).not.toMatch(ANSI);
    expect(() => JSON.parse(capture.stdout) as unknown).not.toThrow();
  });

  it('runs a subcommand of a group', async () => {
    const capture = await captureRun(['group', 'echo', 'hi', '--json'], { commands });

    expect(capture.code).toBe(ExitCode.OK);
    expect(JSON.parse(capture.stdout)).toEqual({ text: 'hi' });
  });

  it('names the unknown subcommand, not the group', async () => {
    const capture = await captureRun(['group', 'nope'], { commands });

    expect(capture.code).toBe(ExitCode.USAGE);
    expect(capture.stderr).toContain('Unknown command `nope`');
    expect(capture.stderr).toContain('agentchat group');
  });

  it('answers --version with no command, and refuses it with a bad one', async () => {
    const bare = await captureRun(['--version', '--json'], { commands });
    const bogus = await captureRun(['nope', '--version', '--json'], { commands });

    expect(bare.code).toBe(ExitCode.OK);
    expect(JSON.parse(bare.stdout)).toMatchObject({ version: expect.any(String) as unknown });
    expect(bogus.code).toBe(ExitCode.USAGE);
  });
});
