import { describe, expect, it } from 'vitest';

import { ANSI_PALETTE, PLAIN_PALETTE } from './colour.js';
import { HumanWriter, visibleWidth } from './writer.js';

describe('visibleWidth', () => {
  it('ignores ANSI escapes, which is what column alignment depends on', () => {
    expect(visibleWidth(ANSI_PALETTE.red('abc'))).toBe(3);
    expect(visibleWidth('abc')).toBe(3);
  });
});

describe('HumanWriter', () => {
  it('writes nothing at all when nothing was rendered', () => {
    // A command with no result writes zero bytes, rather than a stray newline
    // that a `test -s` or a diff would notice.
    expect(new HumanWriter(PLAIN_PALETTE).toText()).toBe('');
  });

  it('ends the output with exactly one newline', () => {
    const writer = new HumanWriter(PLAIN_PALETTE);
    writer.line('one').line('two');

    expect(writer.toText()).toBe('one\ntwo\n');
  });

  it('does not open with a blank line or double one', () => {
    const writer = new HumanWriter(PLAIN_PALETTE);
    writer.blank().line('a').blank().blank().line('b');

    expect(writer.toText()).toBe('a\n\nb\n');
  });

  it('skips a null field, so optional values need no conditional', () => {
    const writer = new HumanWriter(PLAIN_PALETTE);
    writer.fields([
      ['project', 'payments'],
      ['agent', null],
      ['session', 'ses_1'],
    ]);

    expect(writer.toText()).toBe('project: payments\nsession: ses_1\n');
  });

  it('aligns a table on visible width, not on byte length', () => {
    const writer = new HumanWriter(PLAIN_PALETTE);
    writer.table(
      [
        {
          header: 'name',
          cell: (row: { name: string; state: string }) => ANSI_PALETTE.cyan(row.name),
        },
        { header: 'state', cell: (row: { name: string; state: string }) => row.state },
      ],
      [
        { name: 'a', state: 'online' },
        { name: 'longer', state: 'offline' },
      ],
    );

    const [, first] = writer.toText().split('\n');
    // The escapes add bytes but no columns, so the padding must still line the
    // second column up under `state`.
    expect(visibleWidth(first ?? '')).toBe('longer  online'.length);
  });

  it('prints nothing for an empty table, leaving the caller its own message', () => {
    const writer = new HumanWriter(PLAIN_PALETTE);
    writer.table([{ header: 'name', cell: () => 'x' }], []);

    expect(writer.toText()).toBe('');
  });

  it('aligns definitions without a heading row', () => {
    const writer = new HumanWriter(PLAIN_PALETTE);
    writer.definitions([
      ['--json', 'emit JSON'],
      ['--verbose', 'say more'],
    ]);

    expect(writer.toText()).toBe('--json     emit JSON\n--verbose  say more\n');
  });

  it('never leaves trailing whitespace on a line', () => {
    const writer = new HumanWriter(PLAIN_PALETTE);
    writer.definitions([
      ['--json', ''],
      ['--verbose', 'say more'],
    ]);

    for (const line of writer.toText().split('\n')) {
      expect(line).toBe(line.trimEnd());
    }
  });
});
