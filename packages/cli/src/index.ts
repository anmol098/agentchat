/**
 * `@agentchat/cli` — the `agentchat` command framework.
 *
 * The executable is `./bin.ts`; this module is the framework it runs on, and
 * everything a command needs in order to be one.
 *
 * ## The contract this package exists to keep
 *
 * > `stdout` carries machine-consumable output only. Every operational log,
 * > every progress message, every warning goes to `stderr`. (PRD §39)
 *
 * An AI coding agent reads this process's stdout to consume messages, and one
 * stray log line there corrupts its input silently. So the rule is enforced by
 * the types rather than by review: a command receives a {@link CommandContext},
 * a context has no writable stdout in it, and the only two doors out are
 * {@link CommandContext.emit} — which takes a {@link View} and writes a result —
 * and {@link CommandContext.log}, which can only reach stderr.
 *
 * ## Writing a command
 *
 * ```ts
 * export const whoamiCommand: Command = {
 *   kind: 'command',
 *   name: 'whoami',
 *   summary: 'show the signed-in account',
 *   async run(context) {
 *     context.log.info('Checking credentials…');          // stderr, always
 *     const me = await client.auth.me({ signal: context.signal });
 *     await context.emit(view({ handle: me.handle }, (w) => {
 *       w.fields([['handle', me.handle]]);
 *     }));                                                 // stdout, both modes
 *   },
 * };
 * ```
 *
 * Then add it to `./commands/index.ts`. It gets `--json`, `--quiet`,
 * `--verbose`, `--color`, `--help`, colour that disappears when piped, an error
 * renderer, and an exit code, without doing anything.
 *
 * ## Failing
 *
 * Throw. A {@link CliError} carries a stable code and the next step; a
 * {@link UsageError} is the one for a bad invocation. Anything a
 * `@agentchat/client` call raises is already a `ProtocolError` and needs no
 * translation. `./errors.ts` describes it, `./exit.ts` maps it to one of the five
 * exit codes, and `./output/failure.ts` puts it on the right stream in the right
 * shape. A command never writes an error and never picks an exit code.
 *
 * @packageDocumentation
 */

export type {
  CommandLookup,
  CommandPath,
  OptionSpec,
  OptionSpecs,
  OptionType,
  OutputFlags,
} from './args.js';
export {
  Args,
  GLOBAL_OPTION_ENV,
  GLOBAL_OPTIONS,
  parseOptions,
  scanOutputFlags,
  splitCommandPath,
} from './args.js';
export type { Command, CommandContext, CommandGroup, CommandNode, Resolution } from './command.js';
export { Registry } from './command.js';
export { COMMANDS } from './commands/index.js';
export { versionCommand, versionView } from './commands/version.js';
export type { CliErrorOptions, Failure } from './errors.js';
export { CliError, causeChain, describeFailure, UsageError } from './errors.js';
export { ExitCode, exitCodeForErrorCode } from './exit.js';
export { commandHelp, groupHelp, rootHelp } from './help.js';
export type { RunOptions } from './main.js';
export { run } from './main.js';
export * from './output/index.js';
export { CLI_VERSION, PROGRAM } from './version.js';
