/**
 * `@stackgrid/cli` — the `agentchat` command framework.
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
 * ## What is exported, and what is not
 *
 * This file is the package's edge, and `package.json` declares no other entry
 * point. Everything a command needs in order to be one is here: the framework
 * above, the output modes, and the modules a command reaches for before it can
 * act — the credential store ({@link createCredentialStore}), context
 * resolution ({@link resolveContext}), the two configuration files
 * ({@link readUserConfig}, {@link findRepositoryConfig}), and the server
 * resolver ({@link serverRequestFor}, {@link resolveServer},
 * {@link requireServer}).
 *
 * The server resolver is here for the reason the whole of it exists. Its
 * question — which server does this invocation talk to, and where did that
 * answer come from — is asked by every command that opens a socket, and the
 * project has already watched what happens when a command answers it privately:
 * three copies, two of which disagreed about whitespace, and a fourth in the
 * `agent` commands that consulted no built-in default and failed with different
 * words (T-026, T-030). A command supplied to {@link run} from outside this
 * package is a command in exactly that position, so it gets the same function
 * rather than the same opportunity. {@link rememberServerUrl} comes with it —
 * it is the half of the fresh-install flow that makes the failure message's
 * promise ("answer once") true — as do {@link noServerConfigured} and
 * {@link noServerConfiguredText}, which are those words, for a caller that
 * throws and for one that collects.
 *
 * What is *not* here is the point of the list. Each of those modules
 * exists to hide a representation, so the representation stays behind it: the
 * credentials file's mode, name and format version; the path segments the
 * configuration paths are composed from, since the composed paths are the
 * answer anyone wants; the repository-config parser, reachable only through the
 * discovery walk, because parsing that file *is* the credential check and there
 * should be no second door to it; and `FileCredentialStore` itself, because
 * {@link createCredentialStore} is typed by its interface precisely so a
 * keychain can replace the file without a call site changing. `./testing.ts` is
 * absent too — `captureRun` is a test double, and this is what production
 * loads. An internal helper exported by accident becomes something someone
 * depends on.
 *
 * ## One import idiom
 *
 * From outside, through this barrel. From inside, always the defining module by
 * relative path — `./config.js`, never `./index.js`. No module in this package
 * imports its own barrel, and none should start: it would make importing one
 * module an import of all of them, and the cycles would follow.
 *
 * ## Failing
 *
 * Throw. A {@link CliError} carries a stable code and the next step; a
 * {@link UsageError} is the one for a bad invocation. Anything a
 * `@stackgrid/client` call raises is already a `ProtocolError` and needs no
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
export type {
  DiscoveredRepositoryConfig,
  RepositoryConfig,
  ResolvedServer,
  ServerRequest,
  ServerSource,
  SettledServer,
  UserConfig,
} from './config.js';
export {
  defaultAgentFor,
  EMPTY_USER_CONFIG,
  findRepositoryConfig,
  noServerConfigured,
  noServerConfiguredText,
  REPOSITORY_CONFIG_RELATIVE,
  readUserConfig,
  rememberServerUrl,
  repositoryConfigPath,
  requireServer,
  resolveServer,
  SERVER_ENV,
  serverRequestFor,
  userConfigPath,
  withDefaultAgent,
  withoutDefaultAgent,
  writeRepositoryConfig,
  writeUserConfig,
} from './config.js';
export type {
  AgentIdentity,
  AgentSource,
  ContextRequest,
  OwnAgentLookup,
  ProjectSource,
  ResolvedAgent,
  ResolvedContext,
  ResolvedProject,
} from './context.js';
export {
  AGENT_ENV,
  CONTEXT_OPTIONS,
  contextRequestFor,
  describeProject,
  PROJECT_ENV,
  resolveAgent,
  resolveContext,
  resolveProject,
} from './context.js';
export type { FileCredentialStoreOptions, WarnCallback } from './credentials.js';
export { createCredentialStore, credentialsPath } from './credentials.js';
export type { CliErrorOptions, Failure } from './errors.js';
export { CliError, causeChain, describeFailure, UsageError } from './errors.js';
export { ExitCode, exitCodeForErrorCode } from './exit.js';
export { commandHelp, groupHelp, rootHelp } from './help.js';
export type { RunOptions } from './main.js';
export { run } from './main.js';
export * from './output/index.js';
export { CLI_VERSION, PROGRAM } from './version.js';
