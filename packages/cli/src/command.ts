/**
 * What a command is, and what it is allowed to touch.
 *
 * ## A command cannot break the stdout contract
 *
 * This is the point of the whole file. A command is handed a
 * {@link CommandContext}, and there is no writable stdout anywhere in it. It has
 * {@link CommandContext.emit}, which takes a {@link View} — a value that is JSON
 * on one side and a rendering on the other — and it has
 * {@link CommandContext.log}, which can only reach stderr. A command that wants
 * to report progress has exactly one place to do it, and that place is not
 * stdout. PRD §39 is therefore not a rule anyone has to remember; it is the only
 * thing the types permit.
 *
 * ## Why `emit` rather than a return value
 *
 * A command returning its result would be tidier for the dozen commands that
 * produce one value. It cannot work for `agentchat listen`, which produces an
 * unbounded stream and — plan §6.3 — must acknowledge each message only *after*
 * the write to stdout has been flushed. `emit` returns a promise that resolves
 * at exactly that moment. One mechanism that serves both means `listen` is an
 * ordinary command rather than the exception that gets its own escape hatch, and
 * an escape hatch out of the output layer is the thing this design exists to
 * prevent.
 *
 * ## Groups
 *
 * `agentchat project create` is a {@link CommandGroup} named `project`
 * containing a {@link Command} named `create`. Groups nest, but plan §6.2 never
 * goes deeper than two, and a third level should be a sign the vocabulary is
 * wrong rather than a reason to add one.
 *
 * @module
 */

import type { Args, OptionSpecs } from './args.js';
import type { Logger } from './output/log.js';
import type { View } from './output/output.js';
import type { CliEnvironment } from './output/streams.js';

/** Everything a command is given, and everything it may reach. */
export interface CommandContext {
  /**
   * Writes one result to stdout, in whichever representation the invocation
   * asked for.
   *
   * @param value - The result, in both of its forms.
   * @returns A promise that resolves once the bytes have reached the operating
   *   system. Await it before acknowledging anything (plan §6.3).
   */
  emit(value: View): Promise<void>;

  /** Whether `--json` was given, for a command whose work differs by mode. */
  readonly isJson: boolean;

  /** Progress, warnings, and detail. Reaches stderr and nowhere else. */
  readonly log: Logger;

  /** The parsed flags and positional arguments. */
  readonly args: Args;

  /** The process this command is running in: streams, environment, cwd. */
  readonly env: CliEnvironment;

  /**
   * Aborted on `SIGINT` or `SIGTERM`.
   *
   * Pass it to every client call. A command that ignores it makes `Ctrl-C` wait
   * for a thirty-second HTTP timeout.
   */
  readonly signal: AbortSignal;
}

/**
 * How many positional arguments a command takes.
 *
 * Declared rather than inferred, and defaulting to none, because `parseArgs`
 * accepts any number of positionals and a command that ignores the extras turns
 * `agentchat agent delete old new` into a silent no-op on the wrong thing. The
 * framework checks the count before the command runs, so every command gets the
 * same message and the same exit code for the same mistake.
 */
export interface Arity {
  /** The fewest that must be given. Defaults to none. */
  readonly min?: number;

  /** The most that may be given, or `'many'` for no limit. Defaults to `min`. */
  readonly max?: number | 'many';
}

/** Something the user can run. */
export interface Command {
  /** Distinguishes this from a {@link CommandGroup}. */
  readonly kind: 'command';

  /** The word the user types. Lower case, hyphenated if it needs to be. */
  readonly name: string;

  /** One line for the command list. Lower case, no trailing full stop. */
  readonly summary: string;

  /**
   * The usage line, without the program name: `send <@user/agent> <text>`.
   * Defaults to the command's own path.
   */
  readonly usage?: string;

  /** Options beyond the global ones. Names must not collide with those. */
  readonly options?: OptionSpecs;

  /** How many positional arguments it takes. Defaults to none at all. */
  readonly positionals?: Arity;

  /** Longer explanation for `--help`, one paragraph per entry. */
  readonly details?: readonly string[];

  /**
   * Does the work.
   *
   * @param context - Output, logging, arguments, environment.
   * @returns A promise that resolves when the command is finished. Resolving is
   *   success and exit 0.
   * @throws {ProtocolError} Anything carrying a stable code. `./errors.ts` turns
   *   it into a rendered failure and `./exit.ts` into an exit code; a command
   *   never decides its own exit code and never writes its own error.
   */
  run(context: CommandContext): Promise<void>;
}

/** A namespace of related commands: `agentchat project …`. */
export interface CommandGroup {
  /** Distinguishes this from a {@link Command}. */
  readonly kind: 'group';

  /** The word the user types. */
  readonly name: string;

  /** One line for the command list. */
  readonly summary: string;

  /** The commands and groups underneath, in the order help should list them. */
  readonly children: readonly CommandNode[];
}

/** Either kind of entry in the command tree. */
export type CommandNode = Command | CommandGroup;

/** The outcome of looking a command path up in the registry. */
export type Resolution =
  | { readonly kind: 'command'; readonly command: Command; readonly path: readonly string[] }
  | { readonly kind: 'group'; readonly group: CommandGroup; readonly path: readonly string[] }
  | { readonly kind: 'root' }
  | { readonly kind: 'unknown'; readonly name: string; readonly path: readonly string[] };

/**
 * The command tree, and the two questions asked of it.
 *
 * Constructed from a list rather than reaching for a module-level singleton, so
 * a test — and the acceptance fixture under `tests/` — can run the entire
 * framework over a registry of its own without the real commands being present.
 * Adding a command in T-204 and after is one entry in `./commands/index.ts`.
 */
export class Registry {
  readonly #roots: readonly CommandNode[];

  /**
   * @param roots - The top-level commands and groups, in help order.
   */
  public constructor(roots: readonly CommandNode[]) {
    this.#roots = roots;
  }

  /** The top-level entries, in help order. */
  public get roots(): readonly CommandNode[] {
    return this.#roots;
  }

  /**
   * Whether a path may be extended by a name.
   *
   * This is what {@link splitCommandPath} asks while it is peeling the command
   * path off the arguments.
   *
   * @param path - The path matched so far.
   * @param name - The candidate next segment.
   * @returns `true` if a child by that name exists.
   */
  public hasChild(path: readonly string[], name: string): boolean {
    return childrenAt(this.#roots, path)?.some((node) => node.name === name) === true;
  }

  /**
   * Looks a command path up.
   *
   * @param path - The path, outermost first. Empty means the root.
   * @returns What was found there. `unknown` names the segment that failed,
   *   which is what the usage error needs to quote.
   */
  public resolve(path: readonly string[]): Resolution {
    if (path.length === 0) {
      return { kind: 'root' };
    }

    let nodes: readonly CommandNode[] = this.#roots;
    let found: CommandNode | undefined;

    for (const [index, name] of path.entries()) {
      found = nodes.find((node) => node.name === name);
      if (found === undefined) {
        return { kind: 'unknown', name, path: path.slice(0, index) };
      }
      if (found.kind === 'group') {
        nodes = found.children;
        continue;
      }
      // A command with path left over: the caller typed a subcommand of
      // something that has none.
      if (index < path.length - 1) {
        return { kind: 'unknown', name: path[index + 1] ?? '', path: path.slice(0, index + 1) };
      }
    }

    if (found === undefined) {
      return { kind: 'root' };
    }
    return found.kind === 'group'
      ? { kind: 'group', group: found, path }
      : { kind: 'command', command: found, path };
  }
}

/**
 * The children at a path, or `undefined` if the path does not name a group.
 *
 * @param roots - The top-level entries.
 * @param path - The path to walk.
 * @returns The child list at that path.
 */
function childrenAt(
  roots: readonly CommandNode[],
  path: readonly string[],
): readonly CommandNode[] | undefined {
  let nodes: readonly CommandNode[] = roots;
  for (const name of path) {
    const next = nodes.find((node) => node.name === name);
    if (next === undefined || next.kind !== 'group') {
      return undefined;
    }
    nodes = next.children;
  }
  return nodes;
}
