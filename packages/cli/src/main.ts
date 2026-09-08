/**
 * {@link run} — one invocation, start to finish.
 *
 * The order of operations here is the whole contract, so it is worth stating
 * before the code says it less clearly:
 *
 * 1. **Decide the output mode first**, by a tolerant scan of `argv`
 *    ({@link scanOutputFlags}). Before validating anything, before resolving the
 *    command, before anything can fail. A failure that happens later must still
 *    be reported in the mode the caller asked for, and the commonest failure of
 *    all — a mistyped flag — happens during the parse that step 4 performs.
 * 2. Build the two doors: `Output` onto stdout, `Logger` onto stderr. Each picks
 *    up colour from *its own* descriptor, and JSON mode forces stdout plain.
 * 3. Resolve the command path against the registry.
 * 4. Parse the rest strictly, with the global options merged with the command's.
 * 5. Run it, or print help.
 * 6. Catch everything. Describe it, report it, return an exit code.
 *
 * ## `run` returns a code, it does not exit
 *
 * `process.exit()` truncates whatever is still buffered on a pipe, which on a
 * command whose entire purpose is a line of JSON means the consumer gets nothing
 * and a zero exit. So nothing here calls it: `run` returns a number and
 * `./bin.ts` assigns it to `process.exitCode`, which Node applies once the event
 * loop drains and the writes have completed.
 *
 * That is also what lets the whole framework be driven in-process from a test,
 * and what lets the acceptance fixture under `tests/` run a registry of failing
 * commands through the identical path the real binary takes.
 *
 * @module
 */

import { GLOBAL_OPTIONS, parseOptions, scanOutputFlags, splitCommandPath } from './args.js';
import type { Command, CommandContext, CommandNode } from './command.js';
import { Registry } from './command.js';
import { COMMANDS } from './commands/index.js';
import { versionView } from './commands/version.js';
import { describeFailure, UsageError } from './errors.js';
import { ExitCode } from './exit.js';
import { commandHelp, groupHelp, rootHelp } from './help.js';
import { colourEnabled, paletteFor } from './output/colour.js';
import { reportFailure } from './output/failure.js';
import type { LogLevel } from './output/log.js';
import { Logger } from './output/log.js';
import type { View } from './output/output.js';
import { Output } from './output/output.js';
import type { CliEnvironment } from './output/streams.js';
import { isBrokenPipe, StreamSink } from './output/streams.js';
import { HumanWriter } from './output/writer.js';
import { PROGRAM } from './version.js';

/** Everything one invocation needs. */
export interface RunOptions {
  /** The arguments after the program name — `process.argv.slice(2)`. */
  readonly argv: readonly string[];

  /** The streams, environment, and working directory to run against. */
  readonly env: CliEnvironment;

  /**
   * The commands to dispatch to. Defaults to the ones this build ships.
   *
   * Injected rather than imported so a test can exercise the framework over
   * commands designed to fail in specific ways — which is how the exit-code
   * contract is proved end to end from a real process before the commands that
   * would produce those failures naturally have been written.
   */
  readonly commands?: readonly CommandNode[];

  /**
   * Aborted when the user interrupts. `./bin.ts` wires it to `SIGINT` and
   * `SIGTERM`; a caller that has no signals may leave it out.
   */
  readonly signal?: AbortSignal;
}

/**
 * Chooses the stderr verbosity.
 *
 * `--quiet` wins over `--verbose` when someone passes both: the safer reading of
 * a contradiction is the quieter one, since a harness that sets `--quiet`
 * globally and inherits a `--verbose` from a template should not suddenly start
 * receiving debug output.
 *
 * @param flags - The scanned output flags.
 * @returns The level for the {@link Logger}.
 */
function levelFor(flags: { readonly quiet: boolean; readonly verbose: boolean }): LogLevel {
  if (flags.quiet) {
    return 'error';
  }
  return flags.verbose ? 'debug' : 'info';
}

/**
 * Runs one invocation.
 *
 * Never throws and never calls `process.exit`. Every failure — including a bug
 * in this CLI — becomes a rendered report on the correct stream and one of the
 * five codes in {@link ExitCode}.
 *
 * @param options - Arguments, environment, and optionally a registry.
 * @returns The exit code the process should leave with.
 */
export async function run(options: RunOptions): Promise<ExitCode> {
  const flags = scanOutputFlags(options.argv);
  const stdout = new StreamSink(options.env.stdout);
  const stderr = new StreamSink(options.env.stderr);

  // Each descriptor decides for itself. `agentchat status | less` still has a
  // human watching stderr, and `--json` forces stdout plain regardless (see
  // `Output`'s constructor), because a machine's input is not decorated.
  const output = new Output({
    sink: stdout,
    mode: flags.json ? 'json' : 'human',
    palette: paletteFor(
      colourEnabled({ isTTY: stdout.isTTY, env: options.env.env, forced: flags.color }),
    ),
  });
  const logger = new Logger({
    sink: stderr,
    level: levelFor(flags),
    palette: paletteFor(
      colourEnabled({ isTTY: stderr.isTTY, env: options.env.env, forced: flags.color }),
    ),
  });

  try {
    return await dispatch(options, output, logger);
  } catch (error) {
    // The reader closed the pipe: `agentchat listen --json | head -1`. Nothing
    // is wrong and there is nowhere to report it if it were.
    if (isBrokenPipe(error)) {
      return ExitCode.OK;
    }

    const failure = describeFailure(error);
    try {
      await reportFailure(failure, output, logger);
    } catch (reportError) {
      // stdout died while we were explaining that something else died.
      if (!isBrokenPipe(reportError)) {
        throw reportError;
      }
    }
    return failure.exit;
  }
}

/**
 * Resolves the command and runs it.
 *
 * Split from {@link run} so that everything it throws — including the usage
 * errors raised while resolving and parsing — passes through the one catch that
 * knows how to report a failure.
 *
 * @param options - The invocation.
 * @param output - stdout, in the mode already chosen.
 * @param logger - stderr.
 * @returns The exit code for a successful path.
 * @throws {ProtocolError} Anything the parse or the command raises.
 */
async function dispatch(options: RunOptions, output: Output, logger: Logger): Promise<ExitCode> {
  const registry = new Registry(options.commands ?? COMMANDS);
  const { path, rest, unmatched } = splitCommandPath(options.argv, registry);
  const resolved = registry.resolve(path);
  const asked = rest.includes('--help') || rest.includes('-h');

  if (resolved.kind === 'root' || resolved.kind === 'group') {
    // `agentchat --version`, with no command at all. Answered before anything
    // else can fail, because the version is the first thing a bug report asks
    // for and it has to be obtainable from a build that is broken in every
    // other way. `agentchat bogus --version` is deliberately *not* this: an
    // unknown command is still a usage error, whatever else was on the line.
    if (resolved.kind === 'root' && unmatched === undefined && rest.includes('--version')) {
      await output.emit(versionView());
      return ExitCode.OK;
    }

    const help =
      resolved.kind === 'group'
        ? groupHelp(resolved.group, resolved.path)
        : rootHelp(registry.roots);
    const context = [PROGRAM, ...(resolved.kind === 'group' ? resolved.path : [])].join(' ');

    // `--help` at a group or at the root is the result the user asked for, so
    // it goes to stdout and exits 0. Everything below it is a failure, so the
    // same text goes to stderr and stdout stays clean.
    if (asked && unmatched === undefined) {
      await output.emit(help);
      return ExitCode.OK;
    }

    writeHelpTo(logger, output, help);
    if (unmatched !== undefined) {
      throw new UsageError(`Unknown command \`${unmatched}\` for \`${context}\`.`, {
        hint: `Run \`${context} --help\` to see the commands it accepts.`,
      });
    }
    throw new UsageError(
      resolved.kind === 'group' ? `\`${context}\` needs a subcommand.` : 'No command given.',
      { hint: `Run \`${context} --help\` to see the available commands.` },
    );
  }

  // `resolve` reports `unknown` only for a path the scan could not have built,
  // which today means a caller passing `commands` that disagree with `hasChild`.
  if (resolved.kind === 'unknown') {
    throw new UsageError(`Unknown command \`${resolved.name}\`.`, {
      hint: `Run \`${PROGRAM} --help\` to see the available commands.`,
    });
  }

  const { command } = resolved;
  const args = parseOptions(rest, { ...GLOBAL_OPTIONS, ...command.options }, options.env.env);

  if (args.flag('help')) {
    await output.emit(commandHelp(command, resolved.path));
    return ExitCode.OK;
  }
  if (args.flag('version')) {
    await output.emit(versionView());
    return ExitCode.OK;
  }

  checkArity(command, resolved.path, args.positionals);

  const context: CommandContext = {
    emit: (value: View) => output.emit(value),
    isJson: output.isJson,
    log: logger,
    args,
    env: options.env,
    signal: options.signal ?? new AbortController().signal,
  };

  await command.run(context);
  return ExitCode.OK;
}

/**
 * Rejects the wrong number of positional arguments.
 *
 * Checked here, once, rather than in each command, so that a missing argument
 * and a stray one produce the same exit code and the same shape of message
 * everywhere. Both are exit 2: the invocation was wrong, and running it again
 * unchanged will be wrong in the same way.
 *
 * @param command - The command that was resolved.
 * @param path - How it was reached, for the usage line.
 * @param positionals - What was supplied.
 * @throws {UsageError} If there are too few or too many.
 */
function checkArity(
  command: Command,
  path: readonly string[],
  positionals: readonly string[],
): void {
  const min = command.positionals?.min ?? 0;
  const max = command.positionals?.max ?? min;
  const usage = `Usage: ${PROGRAM} ${command.usage ?? path.join(' ')}`;

  if (positionals.length < min) {
    throw new UsageError(
      `\`${[PROGRAM, ...path].join(' ')}\` needs ${min} argument(s); ${positionals.length} given.`,
      { hint: usage },
    );
  }
  if (max !== 'many' && positionals.length > max) {
    throw new UsageError(`Unexpected argument \`${positionals[max] ?? ''}\`.`, { hint: usage });
  }
}

/**
 * Writes help to stderr, because it is accompanying a failure.
 *
 * Not through `Output`: in this situation help is not the result, it is the
 * explanation of why there is no result, and stdout must stay clean — empty in
 * human mode, and carrying nothing but the error envelope in JSON mode.
 *
 * Suppressed under `--json`, where the envelope's `hint` already names the
 * command that would print the help and a screenful of prose on stderr is only
 * noise to a harness that merges the descriptors. Suppressed under `--quiet` for
 * the reason `--quiet` exists.
 *
 * @param logger - stderr.
 * @param output - stdout, consulted only for its mode.
 * @param help - The help view.
 */
function writeHelpTo(logger: Logger, output: Output, help: View): void {
  if (output.isJson || logger.level === 'error') {
    return;
  }
  const writer = new HumanWriter(logger.palette);
  help.render(writer);
  logger.raw(writer.toText().trimEnd());
}
