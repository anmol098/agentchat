/**
 * The migration program: `dist/src/migrate.js`.
 *
 * This is the file the container entrypoint runs, both before serving and for
 * the image's `migrate` subcommand (T-501). Like `index.ts` it is an entry
 * point, which is why it — and not a service module — is allowed to read the
 * environment and install signal handlers.
 *
 * ## The contract it has to keep
 *
 * - Exit **non-zero** on failure. The entrypoint refuses to start the server on
 *   any non-zero status, so this program is what stands between a bad schema
 *   and a server that would serve against it.
 * - Handle **SIGTERM**. An interrupted migration rolls back rather than leaving
 *   a half-applied schema, and the exit status says "signalled" (>128) so the
 *   entrypoint reports a stopped container rather than a failed migration.
 * - Take the **migrations path explicitly**. `drizzle.config.ts` is development
 *   tooling and is not in the image, so the path is resolved from this module's
 *   own location, or overridden with `--migrations` / `MIGRATIONS_DIR`.
 *
 * ## The configuration it asks for
 *
 * On its own, this program loads only {@link loadMigrationConfig}: the
 * connection string and the two variables that shape its own log output. It
 * used to load the server's entire configuration, so that a migration run
 * failed for the same reasons as the server it precedes and a misconfiguration
 * surfaced before traffic arrived. That was cheap when the configuration was
 * barely more than a database URL. Once authentication landed it meant handing
 * a migration container a signing key and an OAuth app's credentials to apply
 * SQL that reads none of them — which broke the rollback verification job, the
 * separate migrate step, and the self-hoster who has not registered an OAuth
 * app yet.
 *
 * The original intent is kept by two paths rather than one blanket rule, and
 * neither of them validates twice with two different answers:
 *
 * - **`--on-boot`**, which says this run is the first half of a server start,
 *   loads the *whole* server configuration. A supervisor that migrates and then
 *   serves still stops on a missing `JWT_SECRET` before the schema moves.
 * - **The image's own boot path** does not pass that flag — the entrypoint
 *   makes the `MIGRATE_ON_BOOT` decision itself and then `exec`s the server as
 *   a separate process. There, `index.ts` validates everything and refuses to
 *   listen, so a misconfigured deployment still fails before it serves traffic.
 *
 * Either way it is one schema: `ServerConfig` extends `MigrationConfig`, so the
 * shared variables have one rule and one message wherever they are read.
 *
 * ## Exit codes
 *
 * They follow `sysexits.h`, as the entrypoint's own `78` does, so an operator
 * or a deploy script can tell "retry this" from "your rollback is wrong".
 *
 * | Code | Meaning | Retry? |
 * |------|---------|--------|
 * | 0    | Applied, or already up to date, or skipped by `MIGRATE_ON_BOOT=false` | — |
 * | 1    | A migration failed. The transaction rolled back. | No |
 * | 65   | The database is newer than this image (`EX_DATAERR`) | Never |
 * | 69   | The database is unreachable or went away, or the lock was held too long (`EX_UNAVAILABLE`) | Yes |
 * | 78   | The configuration, the arguments, or the image itself is wrong (`EX_CONFIG`) | No |
 * | 130  | Interrupted by SIGINT | Yes |
 * | 143  | Interrupted by SIGTERM | Yes |
 *
 * The table is a contract, not documentation: it is what a deploy script
 * branches on, so a code that names the wrong condition is a wrong operational
 * decision rather than a typo. Two of them are easy to get wrong and are worth
 * stating outright.
 *
 * **69 covers the whole of "the database was not there."** Refused, unresolved,
 * timed out, dropped mid-migration, or busy with another instance's run — every
 * one of them is transient, nothing was applied, and the next attempt may well
 * succeed. A managed database briefly unavailable, or a container that starts
 * before its Postgres, must not be told to stop retrying.
 *
 * **78 is for what a human has to change.** A bad flag, a `DATABASE_URL` this
 * program or the server would refuse, an image whose bundled migrations are
 * missing or empty, and a connection string Postgres itself rejects — wrong
 * password, or no such database. All of those fail identically forever, so the
 * code has to say "stop and fix something" rather than invite a restart loop.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pino, { type Logger } from 'pino';
import {
  ConfigurationError,
  loadConfig,
  loadMigrationConfig,
  type MigrationConfig,
} from './config.js';
import {
  MigrationInterruptedError,
  MigrationLockTimeoutError,
  MigrationTargetError,
  MigrationUnavailableError,
  runMigrations,
} from './db/migrate.js';
import { MigrationJournalError, SchemaAheadError } from './db/version-guard.js';

/** Applied, up to date, or deliberately skipped. */
export const EXIT_OK = 0;
/** A migration failed. */
export const EXIT_FAILURE = 1;
/** `EX_DATAERR`: the database is ahead of this image. */
export const EXIT_SCHEMA_AHEAD = 65;
/** `EX_UNAVAILABLE`: the database could not be reached or the lock was busy. */
export const EXIT_UNAVAILABLE = 69;
/** `EX_CONFIG`: the environment, arguments, or image contents are wrong. */
export const EXIT_CONFIG = 78;
/** Interrupted by SIGINT, reported the way a shell reports it. */
export const EXIT_SIGINT = 130;
/** Interrupted by SIGTERM, reported the way a shell reports it. */
export const EXIT_SIGTERM = 143;

/** Values `MIGRATE_ON_BOOT` accepts, matching the entrypoint's own parser. */
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

const USAGE = `Usage: node dist/src/migrate.js [options]

Applies every pending Drizzle migration, once, under a Postgres advisory lock.

Options:
  --migrations <dir>  Directory holding meta/_journal.json and the .sql files.
                      Defaults to MIGRATIONS_DIR, then to the 'drizzle'
                      directory shipped beside this program.
  --on-boot           This run is the first half of a server start: honour
                      MIGRATE_ON_BOOT, and require the server's whole
                      configuration rather than just the part a migration
                      uses. For supervisors other than the container
                      entrypoint, which makes both decisions itself.
  --lock-timeout <ms> How long to wait for the advisory lock. Default 60000.
  --help              Print this and exit.

Environment:
  DATABASE_URL                   Required. PostgreSQL connection string.
  NODE_ENV, LOG_LEVEL            Shape this program's own log output.
  MIGRATIONS_DIR                 Migrations directory; --migrations wins.
  MIGRATE_ON_BOOT                With --on-boot: false skips the run.
  MIGRATION_LOCK_TIMEOUT_MS      Lock wait; --lock-timeout wins.
  AGENTCHAT_ALLOW_SCHEMA_AHEAD   Proceed against a database newer than this
                                 image. For a deliberate rollback only.

JWT_SECRET, GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are not read here: a
schema change uses none of them. The server still requires them, and so does
this program under --on-boot.
`;

/** Thrown for a bad flag or a bad migration-specific variable. */
class UsageError extends Error {
  public readonly code = 'MIGRATE_USAGE_INVALID';

  public constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** What the command line asked for. */
interface Arguments {
  readonly help: boolean;
  readonly onBoot: boolean;
  readonly migrationsFolder: string | undefined;
  readonly lockTimeoutMs: number | undefined;
}

/**
 * Reads the value that follows a flag, or explains that it is missing.
 *
 * An empty value counts as missing. `--migrations ''` is what an unset shell
 * variable expands to, and it would otherwise resolve to the working
 * directory — migrating from wherever the process happens to have been started
 * is exactly the silent wrong-directory failure the unknown-flag check below
 * exists to prevent.
 */
function valueFor(flag: string, argv: readonly string[], index: number): string {
  const value = argv[index];

  if (value === undefined || value.trim() === '' || value.startsWith('--')) {
    throw new UsageError(`${flag} needs a value.`);
  }

  return value;
}

/**
 * Parses the command line.
 *
 * @throws {UsageError} On an unknown flag or a missing value. An unknown flag
 * is refused rather than ignored: a typo in a deploy script that silently
 * migrated the wrong directory would be far worse than a failed deploy.
 */
export function parseArguments(argv: readonly string[]): Arguments {
  let help = false;
  let onBoot = false;
  let migrationsFolder: string | undefined;
  let lockTimeoutMs: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    switch (argument) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--on-boot':
        onBoot = true;
        break;
      case '--migrations':
        index += 1;
        migrationsFolder = valueFor('--migrations', argv, index);
        break;
      case '--lock-timeout':
        index += 1;
        lockTimeoutMs = parseTimeout('--lock-timeout', valueFor('--lock-timeout', argv, index));
        break;
      default:
        throw new UsageError(`Unknown argument '${String(argument)}'. Try --help.`);
    }
  }

  return { help, onBoot, migrationsFolder, lockTimeoutMs };
}

/** Parses a millisecond count from a flag or a variable. */
function parseTimeout(source: string, raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(`${source} must be a whole number of milliseconds (got '${raw}').`);
  }

  return Number(raw);
}

/**
 * Whether migrations should run at boot.
 *
 * Inside the image the entrypoint has already made this decision and does not
 * run this program when the answer is no; this exists for the same program run
 * under systemd or a process manager, and so the rule is testable.
 *
 * @throws {UsageError} On a value that is neither truthy nor falsy. An operator
 * who wrote `MIGRATE_ON_BOOT=no-please` and silently got the default is exactly
 * the person who needed to be told — the entrypoint refuses the same values.
 */
export function migrateOnBoot(env: NodeJS.ProcessEnv): boolean {
  const raw = env['MIGRATE_ON_BOOT']?.trim().toLowerCase();

  if (raw === undefined || raw === '') {
    return true;
  }
  if (TRUTHY.has(raw)) {
    return true;
  }
  if (FALSY.has(raw)) {
    return false;
  }

  throw new UsageError(`MIGRATE_ON_BOOT must be true or false (got '${raw}').`);
}

/** Whether the operator opted in to running against a newer database. */
function allowSchemaAhead(env: NodeJS.ProcessEnv): boolean {
  const raw = env['AGENTCHAT_ALLOW_SCHEMA_AHEAD']?.trim().toLowerCase();

  if (raw === undefined || raw === '') {
    return false;
  }
  if (TRUTHY.has(raw)) {
    return true;
  }
  if (FALSY.has(raw)) {
    return false;
  }

  throw new UsageError(`AGENTCHAT_ALLOW_SCHEMA_AHEAD must be true or false (got '${raw}').`);
}

/** Directories, nearest first, in which the bundled `drizzle/` could sit. */
function candidateMigrationFolders(moduleDirectory: string): string[] {
  // Two layouts have to work from one expression. Compiled, this module is at
  // `<server>/dist/src/migrate.js` and the migrations are two levels up; run
  // through tsx in development it is at `<server>/src/migrate.ts` and they are
  // one level up. Walking outwards and taking the first directory that actually
  // holds a journal covers both without either having to know about the other.
  const folders: string[] = [];
  let directory = moduleDirectory;

  for (let depth = 0; depth < 4; depth += 1) {
    directory = dirname(directory);
    folders.push(join(directory, 'drizzle'));
  }

  return folders;
}

/**
 * Works out where the bundled migrations are.
 *
 * @param moduleDirectory - Directory this module was loaded from.
 * @returns The first candidate that contains `meta/_journal.json`.
 * @throws {MigrationJournalError} If none does. That means the image was built
 * wrong, so it names every path it looked at.
 */
export function resolveMigrationsFolder(moduleDirectory: string): string {
  const candidates = candidateMigrationFolders(moduleDirectory);
  const found = candidates.find((folder) => existsSync(join(folder, 'meta', '_journal.json')));

  if (found === undefined) {
    throw new MigrationJournalError(
      'No bundled migrations found. Looked in:\n' +
        candidates.map((folder) => `  - ${folder}`).join('\n') +
        '\nPass --migrations <dir> or set MIGRATIONS_DIR.',
    );
  }

  return found;
}

/**
 * Maps a thrown value to the exit code that describes it.
 *
 * One line per condition, and no inspection of any error's `cause`: the runner
 * classifies what it catches while it still holds the driver's error, so the
 * only thing left here is the translation from a class to a number. Deciding
 * it twice, in two layers, was how an unreachable database came to exit 1 —
 * the pool's `AggregateError` never became a `MigrationFailedError` at all, so
 * the branch that would have recognised it never ran (T-044).
 */
function exitCodeFor(error: unknown): number {
  if (error instanceof SchemaAheadError) return EXIT_SCHEMA_AHEAD;
  if (error instanceof MigrationUnavailableError) return EXIT_UNAVAILABLE;
  if (error instanceof MigrationLockTimeoutError) return EXIT_UNAVAILABLE;
  if (error instanceof MigrationTargetError) return EXIT_CONFIG;
  if (error instanceof MigrationJournalError) return EXIT_CONFIG;
  if (error instanceof UsageError || error instanceof ConfigurationError) return EXIT_CONFIG;
  return EXIT_FAILURE;
}

/**
 * The logger this program writes through.
 *
 * Not `createLogger` from `app.js`, for two reasons. It takes a `ServerConfig`,
 * and the point of this task is that a migration run is not given one; and
 * importing it would pull the whole HTTP application — Fastify, the routes, the
 * identity provider — into a program that applies SQL and exits.
 *
 * The output is deliberately the same shape as the server's, because the
 * entrypoint interleaves both on one stream: pino JSON on file descriptor 1,
 * ISO timestamps, the same `name` and `env` on every record. What is dropped is
 * `createLogger`'s `redact` of request headers, which has nothing to match
 * here: this program logs migration tags and timings, never a request.
 */
function createMigrationLogger(config: MigrationConfig): Logger {
  return pino(
    {
      level: config.logLevel,
      base: { name: 'agentchat-server', env: config.nodeEnv },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.destination({ dest: 1, sync: true }),
  );
}

/** Everything {@link run} needs, so tests can supply it without a process. */
export interface RunOptions {
  /** Command-line arguments, without `node` and the script path. */
  readonly argv: readonly string[];
  /** Environment to read. */
  readonly env: NodeJS.ProcessEnv;
  /** Directory this module was loaded from, for finding bundled migrations. */
  readonly moduleDirectory: string;
  /** Cancels the run, wired to SIGTERM and SIGINT by {@link main}. */
  readonly signal?: AbortSignal;
  /** Where usage and configuration errors are written. */
  readonly stderr?: (text: string) => void;
  /** Where `--help` is written. */
  readonly stdout?: (text: string) => void;
}

/**
 * Runs the program.
 *
 * Never throws and never touches `process`: it returns the exit code, which is
 * what makes every path here testable, the interrupted one included.
 *
 * @param options - See {@link RunOptions}.
 * @returns The process exit code. See the table at the top of this file.
 */
export async function run(options: RunOptions): Promise<number> {
  const { argv, env, moduleDirectory, signal } = options;
  const stderr = options.stderr ?? ((text: string): void => void process.stderr.write(text));
  const stdout = options.stdout ?? ((text: string): void => void process.stdout.write(text));

  let logger: Logger | undefined;

  try {
    const args = parseArguments(argv);

    if (args.help) {
      stdout(USAGE);
      return EXIT_OK;
    }

    // Loaded before anything else, so a bad environment is reported before a
    // connection is opened. How much of it is required depends on what this run
    // is: `--on-boot` means a server start follows in the same breath, so the
    // whole configuration has to be there before the schema moves. A run on its
    // own — the rollback verification job, a separate migrate step, a
    // self-hoster's first `migrate` — needs only what a migration reads.
    //
    // One schema either way: `ServerConfig` extends `MigrationConfig`, so
    // whichever branch is taken, `DATABASE_URL` is validated by the same rule
    // and shaped by the same code. There is no environment these two could
    // answer differently.
    const config: MigrationConfig = args.onBoot ? loadConfig(env) : loadMigrationConfig(env);
    logger = createMigrationLogger(config);

    if (args.onBoot && !migrateOnBoot(env)) {
      logger.info(
        "MIGRATE_ON_BOOT is false; not applying migrations. Apply them with the image's " +
          '`migrate` subcommand before this version serves traffic.',
      );
      return EXIT_OK;
    }

    // A blank MIGRATIONS_DIR means "unset", as it does for MIGRATE_ON_BOOT: an
    // empty variable in a compose file would otherwise resolve to the working
    // directory and migrate from whatever happens to be there.
    const migrationsDir = env['MIGRATIONS_DIR']?.trim();

    const migrationsFolder = resolve(
      args.migrationsFolder ??
        (migrationsDir === undefined || migrationsDir === ''
          ? resolveMigrationsFolder(moduleDirectory)
          : migrationsDir),
    );

    // Blank means unset here too, on the same reasoning as MIGRATIONS_DIR and
    // MIGRATE_ON_BOOT above: `MIGRATION_LOCK_TIMEOUT_MS=` in a compose file, or
    // an unset variable interpolated into one, is the ordinary way an operator
    // produces an empty string, and refusing to start over it would fail a
    // deploy for a variable nobody meant to set.
    const lockTimeout = env['MIGRATION_LOCK_TIMEOUT_MS']?.trim();

    const lockTimeoutMs =
      args.lockTimeoutMs ??
      (lockTimeout === undefined || lockTimeout === ''
        ? undefined
        : parseTimeout('MIGRATION_LOCK_TIMEOUT_MS', lockTimeout));

    const result = await runMigrations({
      databaseUrl: config.databaseUrl,
      migrationsFolder,
      logger,
      allowSchemaAhead: allowSchemaAhead(env),
      ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }),
      ...(signal === undefined ? {} : { signal }),
    });

    logger.info(
      {
        appliedCount: result.appliedTags.length,
        durationMs: result.durationMs,
        lockWaitMs: result.lockWaitMs,
        applyMs: result.applyMs,
      },
      `migration run finished in ${result.durationMs} ms`,
    );

    return EXIT_OK;
  } catch (error) {
    if (error instanceof MigrationInterruptedError) {
      // Not a failure to report as one. The exit status is what a shell reports
      // for a signalled process, which is exactly what the entrypoint checks
      // before deciding whether to blame a migration for the container stopping.
      logger?.warn({ err: error }, 'migration interrupted; nothing was applied');
      return signal?.reason === 'SIGINT' ? EXIT_SIGINT : EXIT_SIGTERM;
    }

    const code = exitCodeFor(error);

    // Some of these messages are paragraphs written for whoever is standing in
    // front of a stopped deploy — which version to run, which variable to fix.
    // They go to stderr verbatim: an operator reading `docker logs` should not
    // have to unescape a JSON string to find the sentence that helps, and a
    // configuration failure may have happened before there was a logger at all.
    const isForTheOperator =
      error instanceof ConfigurationError ||
      error instanceof UsageError ||
      error instanceof MigrationJournalError ||
      error instanceof MigrationTargetError ||
      error instanceof SchemaAheadError;

    if (isForTheOperator || logger === undefined) {
      stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    }

    if (logger === undefined) {
      return code;
    }

    if (error instanceof SchemaAheadError) {
      // Deliberately without `err`: the paragraph is already on stderr in the
      // shape a human can read, and repeating it as an escaped JSON string with
      // a stack trace only buries it.
      logger.fatal(
        {
          code: error.code,
          databaseSchemaVersion: error.databaseVersion,
          imageSchemaVersion: error.imageVersion,
        },
        'refusing to run: the database schema is newer than this image',
      );
      return code;
    }

    logger.fatal({ err: error }, 'migration run failed');
    return code;
  }
}

/** Whether this module is the program Node was asked to run, rather than an import. */
function isEntrypoint(): boolean {
  const invoked = process.argv[1];
  return invoked !== undefined && pathToFileURL(invoked).href === import.meta.url;
}

/**
 * Wires {@link run} to the process: arguments, environment, and signals.
 *
 * The first SIGTERM asks Postgres to cancel the statement in flight so the
 * migration transaction rolls back. A second one stops waiting for that to be
 * graceful, because an operator pressing Ctrl-C twice has decided.
 */
async function main(): Promise<void> {
  const controller = new AbortController();
  let signalled = false;

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (signalled) {
        process.exit(signal === 'SIGINT' ? EXIT_SIGINT : EXIT_SIGTERM);
      }
      signalled = true;
      controller.abort(signal);
    });
  }

  process.exitCode = await run({
    argv: process.argv.slice(2),
    env: process.env,
    moduleDirectory: dirname(fileURLToPath(import.meta.url)),
    signal: controller.signal,
  });
}

if (isEntrypoint()) {
  await main();
}
