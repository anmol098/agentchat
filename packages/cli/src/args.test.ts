import { describe, expect, it } from 'vitest';
import type { CommandLookup } from './args.js';
import { GLOBAL_OPTIONS, parseOptions, scanOutputFlags, splitCommandPath } from './args.js';
import { UsageError } from './errors.js';

/** A stand-in registry: `project` has `create` and `list` under it. */
const lookup: CommandLookup = {
  hasChild(path, name) {
    if (path.length === 0) {
      return ['project', 'send', 'version'].includes(name);
    }
    if (path.length === 1 && path[0] === 'project') {
      return ['create', 'list'].includes(name);
    }
    return false;
  },
};

describe('scanOutputFlags', () => {
  it('finds --json wherever it appears', () => {
    expect(scanOutputFlags(['project', 'list', '--json']).json).toBe(true);
    expect(scanOutputFlags(['--json', 'project', 'list']).json).toBe(true);
  });

  it('reads the mode without validating anything', () => {
    // The whole point: this runs before the parse, so that a command line the
    // parse is about to reject still reports its failure as JSON.
    expect(scanOutputFlags(['--json', '--not-a-real-flag', 'nonsense']).json).toBe(true);
  });

  it('distinguishes --color, --no-color, and neither', () => {
    expect(scanOutputFlags(['--color']).color).toBe(true);
    expect(scanOutputFlags(['--no-color']).color).toBe(false);
    expect(scanOutputFlags([]).color).toBeUndefined();
  });

  it('stops at `--`, so a message body cannot change the output mode', () => {
    expect(scanOutputFlags(['send', '@bob', '--', '--json']).json).toBe(false);
  });
});

describe('splitCommandPath', () => {
  it('takes the longest path the registry knows', () => {
    const { path, rest } = splitCommandPath(['project', 'create', 'payments'], lookup);

    expect(path).toEqual(['project', 'create']);
    expect(rest).toEqual(['payments']);
  });

  it('does not mistake an argument for a subcommand', () => {
    const { path, rest } = splitCommandPath(['send', '@bob/backend', 'hello'], lookup);

    expect(path).toEqual(['send']);
    expect(rest).toEqual(['@bob/backend', 'hello']);
  });

  it('finds the command whether the flag came before or after it', () => {
    const before = splitCommandPath(['--json', 'project', 'list'], lookup);
    const after = splitCommandPath(['project', '--json', 'list'], lookup);

    expect(before.path).toEqual(['project', 'list']);
    expect(after.path).toEqual(['project', 'list']);
  });

  it('skips the value of a global option that takes one', () => {
    // Without this, `list` would be read as the value of nothing and `--server`
    // would swallow the command name.
    const { path, rest } = splitCommandPath(
      ['--server', 'https://example.com', 'project', 'list'],
      lookup,
    );

    expect(path).toEqual(['project', 'list']);
    expect(rest).toEqual(['--server', 'https://example.com']);
  });

  it('does not skip a token after `--server=value`', () => {
    const { path } = splitCommandPath(['--server=https://example.com', 'project'], lookup);

    expect(path).toEqual(['project']);
  });

  it('reports the positional that ended the path', () => {
    expect(splitCommandPath(['nonsense'], lookup).unmatched).toBe('nonsense');
    expect(splitCommandPath(['project', 'nope'], lookup).unmatched).toBe('nope');
    expect(splitCommandPath(['project', 'list'], lookup).unmatched).toBeUndefined();
  });

  it('treats `-` as an argument, because plan §6.2 gives it to `send`', () => {
    const { path, rest } = splitCommandPath(['send', '@bob', '-'], lookup);

    expect(path).toEqual(['send']);
    expect(rest).toEqual(['@bob', '-']);
  });

  it('stops at `--` and keeps everything after it', () => {
    const { path, rest } = splitCommandPath(['send', '--', 'project', 'list'], lookup);

    expect(path).toEqual(['send']);
    expect(rest).toEqual(['--', 'project', 'list']);
  });
});

describe('parseOptions', () => {
  const env = { AGENTCHAT_SERVER: 'https://from-the-environment.example' };

  it('rejects an unknown flag as a usage error', () => {
    expect(() => parseOptions(['--nope'], GLOBAL_OPTIONS, {})).toThrow(UsageError);
  });

  it('keeps Node’s message, which names the offending token', () => {
    expect(() => parseOptions(['--nope'], GLOBAL_OPTIONS, {})).toThrow(/--nope/);
  });

  it('supports --no- forms for boolean options', () => {
    expect(parseOptions(['--no-color'], GLOBAL_OPTIONS, {}).tristate('color')).toBe(false);
    expect(parseOptions(['--color'], GLOBAL_OPTIONS, {}).tristate('color')).toBe(true);
    expect(parseOptions([], GLOBAL_OPTIONS, {}).tristate('color')).toBeUndefined();
  });

  it('falls back to the environment variable, and lets the flag win', () => {
    expect(parseOptions([], GLOBAL_OPTIONS, env).value('server')).toBe(
      'https://from-the-environment.example',
    );
    expect(
      parseOptions(['--server', 'https://flag.example'], GLOBAL_OPTIONS, env).value('server'),
    ).toBe('https://flag.example');
  });

  it('refuses a repeated option rather than silently keeping the last', () => {
    // A harness that assembled two `--server` flags by accident must be told,
    // not quietly pointed at whichever one came last. The refusal happens in
    // the parse, so no command is ever handed the collapsed value.
    expect(() =>
      parseOptions(
        ['--server', 'https://a.example', '--server', 'https://b.example'],
        GLOBAL_OPTIONS,
        {},
      ),
    ).toThrow(UsageError);
  });

  it('names the option and quotes both occurrences as they were written', () => {
    expect(() =>
      parseOptions(
        ['--server=https://a.example', '--server', 'https://b.example'],
        GLOBAL_OPTIONS,
        {},
      ),
    ).toThrow(
      '`--server` was given more than once: `--server=https://a.example`, then `--server https://b.example`.',
    );
  });

  it('refuses a repeated flag too, and a flag contradicted by its negation', () => {
    // Value-agnostic on purpose: the parser cannot tell a redundant `--json`
    // from a template that clobbered a default, and `--json --no-json` is a
    // contradiction any boolean exception would have had to answer for anyway.
    expect(() => parseOptions(['--json', '--json'], GLOBAL_OPTIONS, {})).toThrow(UsageError);
    expect(() => parseOptions(['--json', '--no-json'], GLOBAL_OPTIONS, {})).toThrow(
      /`--json` was given more than once/,
    );
  });

  it('groups a short alias with its long form', () => {
    expect(() => parseOptions(['-h', '--help'], GLOBAL_OPTIONS, {})).toThrow(
      /`--help` was given more than once/,
    );
  });

  it('accepts repetition for an option that declares itself repeatable', () => {
    const args = parseOptions(
      ['--label', 'one', '--label', 'two'],
      { label: { type: 'string', multiple: true, description: 'a label' } },
      {},
    );

    expect(args.list('label')).toEqual(['one', 'two']);
  });

  it('still refuses to hand a repeatable option to the single-value accessor', () => {
    // The backstop. `value` is the wrong accessor for a `multiple` option, and
    // returning one arbitrary element would be a worse answer than an error.
    const args = parseOptions(
      ['--label', 'one', '--label', 'two'],
      { label: { type: 'string', multiple: true, description: 'a label' } },
      {},
    );

    expect(() => args.value('label')).toThrow(UsageError);
  });

  it('does not treat a flag disagreeing with its variable as a repetition', () => {
    // Precedence between two sources is defined and deliberate; the same source
    // twice is what has no defined answer.
    expect(
      parseOptions(['--server', 'https://flag.example'], GLOBAL_OPTIONS, env).value('server'),
    ).toBe('https://flag.example');
  });

  it('does not scan past `--`, so a message body is never a duplicate option', () => {
    const args = parseOptions(['--', '--json', '--json'], GLOBAL_OPTIONS, {});

    expect(args.positionals).toEqual(['--json', '--json']);
  });

  it('names what is missing when a required positional is absent', () => {
    const args = parseOptions([], GLOBAL_OPTIONS, {});

    expect(() => args.required(0, 'a project slug', 'project create <slug>')).toThrow(
      /Missing a project slug/,
    );
  });

  it('keeps everything after `--` as positionals', () => {
    const args = parseOptions(['--', '--json'], GLOBAL_OPTIONS, {});

    expect(args.positionals).toEqual(['--json']);
    expect(args.flag('json')).toBe(false);
  });
});
