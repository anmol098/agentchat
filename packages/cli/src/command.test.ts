import { describe, expect, it } from 'vitest';

import type { Command, CommandGroup, CommandNode } from './command.js';
import { Registry } from './command.js';

/** A command with no behaviour; only its shape is under test here. */
function stub(name: string): Command {
  return {
    kind: 'command',
    name,
    summary: `the ${name} command`,
    run: () => Promise.resolve(),
  };
}

const project: CommandGroup = {
  kind: 'group',
  name: 'project',
  summary: 'projects',
  children: [stub('list'), stub('create')],
};

const roots: readonly CommandNode[] = [stub('version'), project];
const registry = new Registry(roots);

describe('Registry.hasChild', () => {
  it('answers for the root and for a group', () => {
    expect(registry.hasChild([], 'version')).toBe(true);
    expect(registry.hasChild([], 'project')).toBe(true);
    expect(registry.hasChild([], 'nope')).toBe(false);
    expect(registry.hasChild(['project'], 'create')).toBe(true);
    expect(registry.hasChild(['project'], 'nope')).toBe(false);
  });

  it('says no beneath a command, which has no children', () => {
    expect(registry.hasChild(['version'], 'anything')).toBe(false);
  });
});

describe('Registry.resolve', () => {
  it('finds a top-level command', () => {
    expect(registry.resolve(['version'])).toMatchObject({ kind: 'command' });
  });

  it('finds a nested command and remembers how it was reached', () => {
    const resolved = registry.resolve(['project', 'create']);

    expect(resolved).toMatchObject({ kind: 'command', path: ['project', 'create'] });
  });

  it('reports a group as a group, not as a command', () => {
    expect(registry.resolve(['project'])).toMatchObject({ kind: 'group' });
  });

  it('reports the root for an empty path', () => {
    expect(registry.resolve([])).toEqual({ kind: 'root' });
  });

  it('names the segment that failed, and where it failed', () => {
    expect(registry.resolve(['nope'])).toEqual({ kind: 'unknown', name: 'nope', path: [] });
    expect(registry.resolve(['project', 'nope'])).toEqual({
      kind: 'unknown',
      name: 'nope',
      path: ['project'],
    });
  });

  it('refuses a subcommand of a command', () => {
    expect(registry.resolve(['version', 'extra'])).toEqual({
      kind: 'unknown',
      name: 'extra',
      path: ['version'],
    });
  });
});
