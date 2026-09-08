/**
 * `--help`, in both representations.
 *
 * ## Help is a result
 *
 * `agentchat --help` goes to **stdout** and exits 0. The user asked for the help
 * text; it is what the command produced, and a user who runs `agentchat send
 * --help > send.txt` should get the file they expected. That is not in tension
 * with PRD §39 — the rule is that stdout carries what the command was asked to
 * produce, and here that is the help.
 *
 * Help shown *because something was wrong* is the opposite case. It is
 * commentary on a failure, it goes to stderr, and the exit code is 2. `./main.ts`
 * makes that distinction; this module only builds the views.
 *
 * ## Help in `--json`
 *
 * `agentchat --help --json` emits the command tree as JSON. It costs almost
 * nothing here and it is what lets a harness discover the commands and flags a
 * particular build supports rather than hard-coding a list that a version skew
 * silently invalidates.
 *
 * @module
 */

import type { OptionSpecs } from './args.js';
import { GLOBAL_OPTIONS } from './args.js';
import type { Command, CommandGroup, CommandNode } from './command.js';
import type { JsonValue, View } from './output/output.js';
import { view } from './output/output.js';
import type { HumanWriter } from './output/writer.js';
import { PROGRAM } from './version.js';

/**
 * How an option is written in help: `--server <url>`, `-h, --help`.
 *
 * @param name - The long name, without dashes.
 * @param spec - The option.
 * @returns The left-hand column.
 */
function optionSyntax(name: string, spec: OptionSpecs[string]): string {
  const long = spec.type === 'string' ? `--${name} ${spec.placeholder ?? '<value>'}` : `--${name}`;
  return spec.short === undefined ? `    ${long}` : `-${spec.short}, ${long}`;
}

/**
 * Renders one option section.
 *
 * @param writer - The writer to append to.
 * @param heading - The section heading.
 * @param specs - The options to list.
 */
function renderOptions(writer: HumanWriter, heading: string, specs: OptionSpecs): void {
  const entries = Object.entries(specs).filter(([, spec]) => spec.hidden !== true);
  if (entries.length === 0) {
    return;
  }
  writer.blank();
  writer.line(writer.style.bold(heading));
  writer.definitions(
    entries.map(([name, spec]) => [`  ${optionSyntax(name, spec)}`, spec.description] as const),
  );
}

/**
 * Renders a list of commands as an aligned two-column table.
 *
 * @param writer - The writer to append to.
 * @param heading - The section heading.
 * @param nodes - The commands and groups to list.
 */
function renderCommands(writer: HumanWriter, heading: string, nodes: readonly CommandNode[]): void {
  if (nodes.length === 0) {
    return;
  }
  writer.blank();
  writer.line(writer.style.bold(heading));
  writer.definitions(
    nodes.map((node) => [`  ${writer.style.cyan(node.name)}`, node.summary] as const),
  );
}

/**
 * One command or group, as JSON.
 *
 * @param node - The node to describe.
 * @returns Its name, summary, kind, and — for a group — its children.
 */
function describeNode(node: CommandNode): JsonValue {
  if (node.kind === 'group') {
    return {
      kind: 'group',
      name: node.name,
      summary: node.summary,
      commands: node.children.map(describeNode),
    };
  }
  return {
    kind: 'command',
    name: node.name,
    summary: node.summary,
    options: describeOptions(node.options ?? {}),
  };
}

/**
 * An option set, as JSON.
 *
 * @param specs - The options.
 * @returns One entry per option, hidden ones omitted.
 */
function describeOptions(specs: OptionSpecs): JsonValue {
  return Object.entries(specs)
    .filter(([, spec]) => spec.hidden !== true)
    .map(([name, spec]) => ({
      name,
      type: spec.type,
      description: spec.description,
      ...(spec.short === undefined ? {} : { short: spec.short }),
    }));
}

/**
 * The top-level help: what this program is and what it can do.
 *
 * @param roots - The registered top-level commands and groups.
 * @returns The help view.
 */
export function rootHelp(roots: readonly CommandNode[]): View {
  return view(
    {
      program: PROGRAM,
      commands: roots.map(describeNode),
      globalOptions: describeOptions(GLOBAL_OPTIONS),
    },
    (writer) => {
      writer.line(
        `${writer.style.bold(PROGRAM)} — communication infrastructure for AI coding agents.`,
      );
      writer.blank();
      writer.line(`Usage: ${PROGRAM} <command> [options]`);
      renderCommands(writer, 'Commands', roots);
      renderOptions(writer, 'Global options', GLOBAL_OPTIONS);
      writer.blank();
      writer.line(
        `Run ${writer.style.cyan(`${PROGRAM} <command> --help`)} for a command's own options.`,
      );
    },
  );
}

/**
 * Help for a group: the commands inside it.
 *
 * @param group - The group.
 * @param path - How it was reached, for the usage line.
 * @returns The help view.
 */
export function groupHelp(group: CommandGroup, path: readonly string[]): View {
  const prefix = [PROGRAM, ...path].join(' ');
  return view(
    {
      kind: 'group',
      name: group.name,
      summary: group.summary,
      commands: group.children.map(describeNode),
    },
    (writer) => {
      writer.line(group.summary);
      writer.blank();
      writer.line(`Usage: ${prefix} <command> [options]`);
      renderCommands(writer, 'Commands', group.children);
    },
  );
}

/**
 * Help for one command: what it does, how it is called, what it accepts.
 *
 * @param command - The command.
 * @param path - How it was reached, for the usage line.
 * @returns The help view.
 */
export function commandHelp(command: Command, path: readonly string[]): View {
  const usage = command.usage ?? `${path.join(' ')} [options]`;
  return view(
    {
      kind: 'command',
      name: command.name,
      summary: command.summary,
      usage: `${PROGRAM} ${usage}`,
      options: describeOptions({ ...GLOBAL_OPTIONS, ...command.options }),
    },
    (writer) => {
      writer.line(command.summary);
      writer.blank();
      writer.line(`Usage: ${PROGRAM} ${usage}`);
      for (const paragraph of command.details ?? []) {
        writer.blank();
        writer.line(paragraph);
      }
      renderOptions(writer, 'Options', command.options ?? {});
      renderOptions(writer, 'Global options', GLOBAL_OPTIONS);
    },
  );
}
