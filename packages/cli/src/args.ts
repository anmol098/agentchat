/**
 * Argument parsing: the option vocabulary, and the two passes over `argv`.
 *
 * ## The parser is Node's
 *
 * `node:util`'s `parseArgs` is the whole dependency. It has been stable since
 * Node 18, this workspace's floor is 22.12, and it does the three things a
 * parser actually has to get right: `--flag=value`, short clusters, and `--` as
 * a terminator. What it does not do is subcommands, help text, or a usage error
 * a human can read — and those are the parts that have to match this CLI's
 * conventions anyway, so a library would have supplied the easy half and left
 * the half that matters.
 *
 * The alternative was `commander` or `yargs`. Both are permissively licensed and
 * either would work. Both were rejected for the same reason: this is the one
 * package in the repository that strangers install globally, `packages/` is MIT
 * so that it can be embedded without anybody auditing a dependency tree, and
 * neither library earns a transitive tree on a program whose parsing needs fit
 * in this file. `yargs` in particular exits the process itself on a bad flag,
 * which would take the exit-code contract in `./exit.ts` out of our hands.
 *
 * ## Two passes, and why
 *
 * `parseArgs` cannot know that `project` in `agentchat project create x` is a
 * command rather than a positional argument, and it cannot validate
 * `--conversation` before it knows the command that declares it. So:
 *
 * 1. {@link splitCommandPath} walks the tokens and peels off the command path,
 *    skipping options and the values of the global options that take one. It
 *    consults the registry, so it stops at the first token that is not a
 *    subcommand of what it has matched so far.
 * 2. {@link parseOptions} runs `parseArgs` in **strict** mode over what is left,
 *    with the global options merged with that command's own. An unknown flag is
 *    a usage error naming the flag, not a silently ignored token.
 *
 * A third, deliberately sloppy pass happens before both, in `./main.ts`:
 * {@link scanOutputFlags} looks for `--json` and friends by raw string match. It
 * exists because `agentchat --json bogus-command` must report its usage error
 * **as JSON on stdout**, and that decision has to be made before the parse that
 * is about to fail.
 *
 * @module
 */

import { parseArgs } from 'node:util';

import { UsageError } from './errors.js';
import { PROGRAM } from './version.js';

/** How an option's value is read. */
export type OptionType = 'boolean' | 'string';

/** One option, as declared by the framework or by a command. */
export interface OptionSpec {
  /** `boolean` for a flag, `string` for one that takes a value. */
  readonly type: OptionType;

  /**
   * A single-character alias.
   *
   * Minted sparingly: a short flag is as public a contract as a long one and
   * there are only twenty-six of them. Only `-h` exists today.
   */
  readonly short?: string;

  /** Whether repeating the option accumulates rather than overwrites. */
  readonly multiple?: boolean;

  /** One line for `--help`, lower case, no trailing full stop. */
  readonly description: string;

  /**
   * What the value is called in help, for a `string` option: `<url>` renders as
   * `--server <url>`. Ignored for a flag.
   */
  readonly placeholder?: string;

  /** Whether to hide this from `--help`. For options kept only for compatibility. */
  readonly hidden?: boolean;
}

/** A set of options, keyed by their long name without the leading dashes. */
export type OptionSpecs = Readonly<Record<string, OptionSpec>>;

/**
 * The options every command has, whether it uses them or not.
 *
 * They are global because a harness sets them once and expects them to work
 * everywhere: a wrapper that appends `--json` to whatever the user typed cannot
 * know which commands opted in. Plan §6.2 says "every read command accepts
 * `--json`"; making it universal is the stricter, simpler promise, and a command
 * with no machine-readable result simply emits nothing.
 */
export const GLOBAL_OPTIONS: OptionSpecs = Object.freeze({
  json: {
    type: 'boolean',
    description: 'emit machine-readable JSON on stdout, including on failure',
  },
  server: {
    type: 'string',
    placeholder: '<url>',
    description: 'the AgentChat server to talk to (also AGENTCHAT_SERVER)',
  },
  color: {
    type: 'boolean',
    description: 'force ANSI colour on, or --no-color to force it off',
  },
  quiet: {
    type: 'boolean',
    description: 'suppress progress and warnings on stderr',
  },
  verbose: {
    type: 'boolean',
    description: 'report causes and detail on stderr',
  },
  help: {
    type: 'boolean',
    short: 'h',
    description: 'show help for this command',
  },
  version: {
    type: 'boolean',
    description: `print the ${PROGRAM} version`,
  },
});

/**
 * The environment variable that supplies each global option's default.
 *
 * Only the ones where an environment variable is meaningful. A flag always wins
 * over its variable; see {@link Args.value}.
 */
export const GLOBAL_OPTION_ENV: Readonly<Record<string, string>> = Object.freeze({
  server: 'AGENTCHAT_SERVER',
});

/** What the raw scan in {@link scanOutputFlags} could determine. */
export interface OutputFlags {
  /** Whether `--json` was asked for. */
  readonly json: boolean;

  /** `true` for `--color`, `false` for `--no-color`, `undefined` for neither. */
  readonly color: boolean | undefined;

  /** Whether `--quiet` was asked for. */
  readonly quiet: boolean;

  /** Whether `--verbose` was asked for. */
  readonly verbose: boolean;
}

/**
 * Finds the output-mode flags without validating anything.
 *
 * Deliberately tolerant, and deliberately run before the real parse. The mode
 * has to be known before the parse because the parse is what may fail: if
 * `agentchat --json nonsense` decided its output mode only after parsing
 * succeeded, its usage error would land on stderr as prose and a harness reading
 * stdout would get an empty stream and an exit code with no explanation. This
 * function is what makes "in JSON mode stdout contains nothing but valid JSON,
 * *including when the command fails*" true for **every** failure, parse errors
 * included.
 *
 * Only exact long-form tokens are matched. `--json=true` and a short cluster are
 * not, because guessing here and guessing differently in `parseArgs` would be
 * worse than the strict parse simply reporting them.
 *
 * @param argv - The arguments after the program name.
 * @returns What could be determined. Anything absent takes its default.
 */
export function scanOutputFlags(argv: readonly string[]): OutputFlags {
  let json = false;
  let color: boolean | undefined;
  let quiet = false;
  let verbose = false;

  for (const token of argv) {
    // Everything after `--` is data, not flags. `agentchat send @bob -- --json`
    // sends the text `--json`.
    if (token === '--') {
      break;
    }
    switch (token) {
      case '--json':
        json = true;
        break;
      case '--no-json':
        json = false;
        break;
      case '--color':
        color = true;
        break;
      case '--no-color':
        color = false;
        break;
      case '--quiet':
      case '-q':
        quiet = true;
        break;
      case '--verbose':
        verbose = true;
        break;
      default:
        break;
    }
  }

  return { json, color, quiet, verbose };
}

/**
 * Whether a token is an option rather than a positional argument.
 *
 * `-` alone is not: it is the conventional name for standard input, and plan
 * §6.2 gives it to `agentchat send <@agent> -`.
 *
 * @param token - One argv entry.
 * @returns `true` for `--flag`, `-f`, and `--flag=value`.
 */
function isOption(token: string): boolean {
  return token.length > 1 && token.startsWith('-');
}

/**
 * Whether an option token consumes the token after it.
 *
 * Only global options are consulted, and that is sufficient: a command's own
 * options can only appear *after* its name, by which point the command path is
 * already settled and this scan has stopped.
 *
 * @param token - An option token, with its leading dashes.
 * @returns `true` if the next token is this option's value.
 */
function takesSeparateValue(token: string): boolean {
  // `--server=url` carries its own value.
  if (token.includes('=')) {
    return false;
  }

  if (token.startsWith('--')) {
    return GLOBAL_OPTIONS[token.slice(2)]?.type === 'string';
  }

  // A short cluster takes a value if its last letter does: `-abc value` gives
  // the value to `c`, which is how `parseArgs` reads it too.
  const last = token.at(-1);
  return Object.values(GLOBAL_OPTIONS).some(
    (spec) => spec.type === 'string' && spec.short === last,
  );
}

/** How one command line divides into a command path and everything else. */
export interface CommandPath {
  /** The command path, outermost first: `['project', 'create']`. */
  readonly path: readonly string[];

  /** Every token that was not part of the command path, in their original order. */
  readonly rest: readonly string[];

  /**
   * The positional token that ended the path, if any.
   *
   * For a resolved command this is its first argument — `@bob` in
   * `agentchat send @bob "hi"` — and means nothing is wrong. For a path that
   * resolved to the root or to a group it is the reason the path stopped, and it
   * is the word a "unknown command" error has to quote. The scan is the only
   * place that knows which token it was, so it says so rather than leaving the
   * caller to work it out from `rest`.
   */
  readonly unmatched: string | undefined;
}

/** What {@link splitCommandPath} consults to know how far the path extends. */
export interface CommandLookup {
  /**
   * Whether a name is a child of a path.
   *
   * @param path - The path matched so far, outermost first.
   * @param name - The candidate next segment.
   * @returns `true` if the path may be extended by that name.
   */
  hasChild(path: readonly string[], name: string): boolean;
}

/**
 * Peels the command path off the front of the arguments.
 *
 * Option tokens are skipped wherever they appear, so `agentchat --json project
 * create x` and `agentchat project --json create x` both resolve to
 * `project create` with `x` left over. That symmetry is worth the scan: a
 * harness assembling a command line from parts should not have to care where it
 * appended `--json`.
 *
 * The path stops at the first positional that is not a child of what has been
 * matched, which is what leaves `x` as an argument to `create` rather than
 * making it a third path segment.
 *
 * @param argv - The arguments after the program name.
 * @param lookup - The registry to ask about children.
 * @returns The path and everything else.
 */
export function splitCommandPath(argv: readonly string[], lookup: CommandLookup): CommandPath {
  const path: string[] = [];
  const rest: string[] = [];
  let unmatched: string | undefined;
  let index = 0;

  for (; index < argv.length; index += 1) {
    const token = argv[index] ?? '';

    if (token === '--') {
      break;
    }

    if (isOption(token)) {
      rest.push(token);
      if (takesSeparateValue(token) && index + 1 < argv.length) {
        index += 1;
        rest.push(argv[index] ?? '');
      }
      continue;
    }

    if (!lookup.hasChild(path, token)) {
      unmatched = token;
      break;
    }
    path.push(token);
  }

  for (; index < argv.length; index += 1) {
    rest.push(argv[index] ?? '');
  }

  return { path, rest, unmatched };
}

/** The value a single option ended up with. */
type OptionValue = string | boolean | (string | boolean)[] | undefined;

/**
 * The parsed arguments for one invocation, with accessors that respect
 * `noUncheckedIndexedAccess`.
 *
 * `parseArgs` hands back a bag typed as "string, boolean, an array of either, or
 * missing", which is honest and unusable. Every command would otherwise repeat
 * the same narrowing, and would repeat it slightly differently. These accessors
 * do it once, and throw a {@link UsageError} — exit 2, with the flag named —
 * rather than returning something surprising.
 */
export class Args {
  readonly #values: Readonly<Record<string, OptionValue>>;
  readonly #env: Readonly<Record<string, string | undefined>>;

  /** The positional arguments, in order, with the command path removed. */
  public readonly positionals: readonly string[];

  /**
   * @param values - What `parseArgs` produced.
   * @param positionals - The positional arguments.
   * @param env - The process environment, consulted by {@link Args.value} for
   *   the options that have one.
   */
  public constructor(
    values: Readonly<Record<string, OptionValue>>,
    positionals: readonly string[],
    env: Readonly<Record<string, string | undefined>>,
  ) {
    this.#values = values;
    this.positionals = positionals;
    this.#env = env;
  }

  /**
   * Reads a boolean option.
   *
   * @param name - The option's long name.
   * @returns Whether it was given, `--no-`-prefixed forms respected.
   */
  public flag(name: string): boolean {
    return this.#values[name] === true;
  }

  /**
   * Reads a boolean option that distinguishes "not given" from "given false".
   *
   * @param name - The option's long name.
   * @returns `true`, `false`, or `undefined` when the flag was absent.
   */
  public tristate(name: string): boolean | undefined {
    const value = this.#values[name];
    return typeof value === 'boolean' ? value : undefined;
  }

  /**
   * Reads a string option, falling back to its environment variable.
   *
   * The flag wins over the variable, always: a variable is ambient
   * configuration and a flag is what the person typed just now.
   *
   * @param name - The option's long name.
   * @returns The value, or `undefined` if neither the flag nor its variable was
   *   set.
   * @throws {UsageError} If the option was given more than once. Silently
   *   keeping the last of two conflicting `--project` flags is how a harness
   *   ends up writing to the wrong project.
   */
  public value(name: string): string | undefined {
    const value = this.#values[name];
    if (Array.isArray(value)) {
      if (value.length > 1) {
        throw new UsageError(`\`--${name}\` was given more than once.`, {
          hint: `Pass \`--${name}\` at most once.`,
        });
      }
      const only = value[0];
      return typeof only === 'string' ? only : undefined;
    }
    if (typeof value === 'string') {
      return value;
    }

    const variable = GLOBAL_OPTION_ENV[name];
    return variable === undefined ? undefined : this.#env[variable];
  }

  /**
   * Reads a repeatable string option.
   *
   * @param name - The option's long name.
   * @returns Every value given, in order. Empty when the option was absent.
   */
  public list(name: string): readonly string[] {
    const value = this.#values[name];
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === 'string');
    }
    return typeof value === 'string' ? [value] : [];
  }

  /**
   * Reads a positional argument that the command requires.
   *
   * @param index - Its zero-based position after the command path.
   * @param what - What it is, for the error: `a project slug`.
   * @param usage - The usage line to show, for the hint.
   * @returns The argument.
   * @throws {UsageError} If it was not supplied.
   */
  public required(index: number, what: string, usage: string): string {
    const value = this.positionals[index];
    if (value === undefined || value === '') {
      throw new UsageError(`Missing ${what}.`, { hint: `Usage: ${usage}` });
    }
    return value;
  }
}

/** Everything `parseArgs` needs, derived from an {@link OptionSpecs}. */
type ParseArgsOptions = Record<string, { type: OptionType; short?: string; multiple?: boolean }>;

/**
 * Translates option specs into `parseArgs` configuration.
 *
 * @param specs - The merged global and command specs.
 * @returns The `options` object for `parseArgs`.
 */
function toParseArgsOptions(specs: OptionSpecs): ParseArgsOptions {
  const options: ParseArgsOptions = {};
  for (const [name, spec] of Object.entries(specs)) {
    options[name] = {
      type: spec.type,
      ...(spec.short === undefined ? {} : { short: spec.short }),
      ...(spec.multiple === undefined ? {} : { multiple: spec.multiple }),
    };
  }
  return options;
}

/** The `code` property Node puts on the errors `parseArgs` throws. */
const PARSE_ERROR_HINTS: Readonly<Record<string, string>> = Object.freeze({
  ERR_PARSE_ARGS_UNKNOWN_OPTION: 'Run the command with `--help` to see the flags it accepts.',
  ERR_PARSE_ARGS_INVALID_OPTION_VALUE:
    'Check whether that flag takes a value; `--help` lists them.',
  ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL: 'Run the command with `--help` to see what it expects.',
});

/**
 * Parses one invocation's options strictly.
 *
 * @param argv - The tokens left after the command path was removed.
 * @param specs - The command's options, already merged with the global ones.
 * @param env - The process environment, for options with a variable.
 * @returns The parsed arguments.
 * @throws {UsageError} For an unknown flag, a missing value, or a value given to
 *   a flag that takes none — exit 2 in every case, because none of them can be
 *   fixed by running the same command again.
 */
export function parseOptions(
  argv: readonly string[],
  specs: OptionSpecs,
  env: Readonly<Record<string, string | undefined>>,
): Args {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: toParseArgsOptions(specs),
      strict: true,
      allowPositionals: true,
      // `--no-color` and `--no-json`. Node has supported this since 22.4 and the
      // engines floor is 22.12, so it needs no fallback.
      allowNegative: true,
    });
    return new Args(values, positionals, env);
  } catch (cause) {
    throw asUsageError(cause);
  }
}

/**
 * Turns whatever `parseArgs` threw into a {@link UsageError}.
 *
 * Node's message is already the best description of what was wrong with the
 * command line — it names the offending token — so it is kept, and only the next
 * step is added. Re-writing it would lose the token.
 *
 * @param cause - The thrown value.
 * @returns A usage error carrying the original as its cause.
 */
function asUsageError(cause: unknown): UsageError {
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause
      ? String((cause as { code: unknown }).code)
      : '';
  const message = cause instanceof Error ? cause.message : String(cause);
  const hint = PARSE_ERROR_HINTS[code];

  return new UsageError(message, {
    cause,
    ...(hint === undefined ? {} : { hint }),
  });
}
