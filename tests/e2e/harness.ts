/**
 * The end-to-end harness: real server, real database, real CLI processes.
 *
 * ## Why this suite exists
 *
 * Every other suite in this repository proves one half of a contract against a
 * double of the other half. `packages/cli/tests` spawns the real binary against
 * a stub server; `server/src/routes/*.test.ts` drives the real routes with no
 * client. Both are good tests and neither can answer the only question that
 * matters to a user: *do the two halves describe the same endpoints?*
 *
 * They did not. T-043 records three authentication routes — `GET /me`,
 * `POST /auth/logout`, `POST /auth/refresh` — that have protocol schemas,
 * client methods and five calling commands, and that the server never
 * registered. Every gate was green the whole time, because the stub answered
 * them.
 *
 * That is the gap this file lives in, so the rule here is absolute:
 *
 * > **Nothing this project ships is stubbed.**
 *
 * The server is the built `dist/src/index.js`, started as a process, the way a
 * container starts it. The database is PostgreSQL with the shipped migrations
 * applied by the shipped migration program. The CLI is `dist/bin.js`, spawned,
 * once per command, reading its own configuration files off disk. Messages
 * cross a real socket.
 *
 * The single exception is the identity provider, and it is documented where it
 * is made: `./identity-provider.ts` and `./github-redirect.mjs`. Nobody can
 * approve a browser device flow in a test.
 *
 * ## Waiting, not sleeping
 *
 * These are real processes over real sockets, so every wait in this file is a
 * wait *for a condition* with a deadline — a log record, a listener event, an
 * exit — and never a fixed sleep. A sleep long enough to be reliable on a
 * loaded machine is long enough to make the suite unpleasant, and a sleep short
 * enough to be pleasant is a flake. When a wait does expire, it throws with
 * everything the process said on both descriptors, because a timeout whose
 * message is "timed out" costs a re-run to learn anything from.
 *
 * @module
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The repository root, wherever the runner happens to have been started. */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The `server` workspace directory. */
const SERVER_DIR = join(REPO_ROOT, 'server');

/** The built server entry point — the file the container image runs. */
const SERVER_ENTRY = join(SERVER_DIR, 'dist', 'src', 'index.js');

/** The built migration program, likewise. */
const MIGRATE_ENTRY = join(SERVER_DIR, 'dist', 'src', 'migrate.js');

/** The built `agentchat` binary, exactly as `package.json`'s `bin` points at it. */
const CLI_BINARY = join(REPO_ROOT, 'packages', 'cli', 'dist', 'bin.js');

/** The `--import` hook that points the server's GitHub calls at the fake. */
const REDIRECT_HOOK = pathToFileURL(join(REPO_ROOT, 'tests', 'e2e', 'github-redirect.mjs')).href;

/**
 * Server configuration that is not under test.
 *
 * Fixed values rather than the developer's own, so a run does not depend on
 * what happens to be exported in the shell that started it. The client id and
 * secret are handed to the real GitHub adapter and travel to the fake provider,
 * which ignores them: this suite tests delivery, not OAuth client
 * authentication.
 */
const SERVER_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  HOST: '127.0.0.1',
  // 0 asks the operating system for a free port. Several agents run this suite
  // at once on this project; a fixed port is a collision waiting to happen.
  PORT: '0',
  JWT_SECRET: 'e2e-jwt-secret-that-is-long-enough-for-hs256',
  GITHUB_CLIENT_ID: 'e2e-client-id',
  GITHUB_CLIENT_SECRET: 'e2e-client-secret',
} as const;

/** How long to wait for a process to say the thing that means it is ready. */
const READY_TIMEOUT_MS = 30_000;

/** How long to wait for a listener event before calling the wait failed. */
const EVENT_TIMEOUT_MS = 20_000;

/** How long a process is given to exit after a signal before it is killed. */
const EXIT_TIMEOUT_MS = 10_000;

/** How often a condition is re-checked while waiting for it. */
const POLL_INTERVAL_MS = 25;

/**
 * The connection string every process in the suite uses.
 *
 * `tests/setup/require-database-url.ts` has already refused to let the run
 * start without it, so this never explains itself twice.
 */
function databaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url.trim() === '') {
    throw new Error('DATABASE_URL is unset; the integration project should have refused to start.');
  }
  return url;
}

/** Splits accumulated text into complete lines, keeping the partial tail. */
class LineReader {
  private buffered = '';

  /**
   * Adds a chunk and returns whatever complete lines it finished.
   *
   * @param chunk - Text just read from a descriptor.
   * @returns The lines that are now complete, blank ones dropped.
   */
  push(chunk: string): string[] {
    this.buffered += chunk;
    const parts = this.buffered.split('\n');
    this.buffered = parts.pop() ?? '';
    return parts.filter((line) => line.trim() !== '');
  }
}

/**
 * Polls `condition` until it returns something, or the deadline passes.
 *
 * The condition may be asynchronous, because some of the things this suite
 * waits for are only observable by running another `agentchat` command — "the
 * inbox no longer owes this message" is a process, not a variable.
 *
 * @param what - Named in the failure, so a timeout says what did not happen.
 * @param condition - Returns `undefined` until the thing has happened.
 * @param options - The deadline, and how to describe the state on failure.
 * @returns Whatever the condition returned.
 * @throws If the deadline passes first, with the diagnosis attached.
 */
async function waitFor<T>(
  what: string,
  condition: () => T | undefined | Promise<T | undefined>,
  options: { readonly timeoutMs: number; readonly diagnose?: () => string },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;

  for (;;) {
    const found = await condition();
    if (found !== undefined) {
      return found;
    }
    if (Date.now() >= deadline) {
      const detail = options.diagnose?.() ?? '';
      throw new Error(
        `Timed out after ${String(options.timeoutMs)}ms waiting for ${what}.${detail === '' ? '' : `\n${detail}`}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------

/**
 * Applies the shipped migrations with the shipped migration program.
 *
 * Not `drizzle-kit`: that is development tooling and is not in the image, so a
 * suite that used it would be proving a schema nobody deploys. `dist/src/migrate.js`
 * is what the container entrypoint runs, it is idempotent, and it exits
 * non-zero with a reason when it cannot do its job.
 *
 * @throws If the migration program exits non-zero, with its output attached.
 */
export async function applyMigrations(): Promise<void> {
  const child = spawn(process.execPath, [MIGRATE_ENTRY], {
    cwd: SERVER_DIR,
    env: {
      PATH: process.env['PATH'] ?? '',
      NODE_ENV: SERVER_ENV.NODE_ENV,
      LOG_LEVEL: SERVER_ENV.LOG_LEVEL,
      DATABASE_URL: databaseUrl(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    output += chunk;
  });

  const code = await new Promise<number | null>((resolve) => {
    child.once('close', resolve);
  });

  if (code !== 0) {
    throw new Error(`Migrations failed with exit code ${String(code)}.\n${output}`);
  }
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/** A server process under test. */
export interface RunningServer {
  /** Its base URL, e.g. `http://127.0.0.1:54321`. */
  readonly baseUrl: string;
  /** Everything it has written to stderr. */
  stderr(): string;
  /** Every structured record it has written to stdout. */
  records(): readonly Record<string, unknown>[];
  /**
   * The records the server logged at `warn` or worse, rendered.
   *
   * The single most useful thing to look at when a command fails end to end:
   * the client is told "the server failed to handle this request", by design,
   * and the reason is only ever in the server's own log. Attaching this to a
   * failure is the difference between a fixable report and a re-run.
   */
  problems(): string;
  /** Sends SIGTERM and waits for the process to go. */
  stop(): Promise<void>;
}

/** pino's level for `warn`; anything at or above it is worth reporting. */
const WARN_LEVEL = 40;

/** Turns whatever Fastify reported as an address into a base URL. */
function baseUrlOf(address: unknown): string | undefined {
  if (typeof address === 'string') {
    return address;
  }
  if (typeof address === 'object' && address !== null) {
    const record = address as Record<string, unknown>;
    const host = record['address'];
    const port = record['port'];
    if (typeof host === 'string' && typeof port === 'number') {
      return `http://${host.includes(':') ? `[${host}]` : host}:${String(port)}`;
    }
  }
  return undefined;
}

/**
 * Starts the built server as its own process and waits until it is listening.
 *
 * @param identityOrigin - Where `./github-redirect.mjs` should send the
 *   server's GitHub calls.
 * @returns The running server, with the address it actually bound.
 */
export async function startServer(identityOrigin: string): Promise<RunningServer> {
  const child = spawn(process.execPath, ['--import', REDIRECT_HOOK, SERVER_ENTRY], {
    cwd: SERVER_DIR,
    env: {
      PATH: process.env['PATH'] ?? '',
      ...SERVER_ENV,
      DATABASE_URL: databaseUrl(),
      AGENTCHAT_E2E_IDENTITY_ORIGIN: identityOrigin,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const records: Record<string, unknown>[] = [];
  const lines = new LineReader();
  let errorOutput = '';

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    for (const line of lines.push(chunk)) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === 'object' && parsed !== null) {
          records.push(parsed as Record<string, unknown>);
        }
      } catch {
        // A non-JSON line on the server's stdout is a contract break, but it is
        // not this helper's to report: `server/tests/bootstrap.integration.test.ts`
        // owns that assertion. Keep it visible in diagnostics instead.
        errorOutput += `unparsed stdout line: ${line}\n`;
      }
    }
  });

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    errorOutput += chunk;
  });

  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const exit = new Promise<void>((resolve) => {
    child.once('close', (code, signal) => {
      exited = { code, signal };
      resolve();
    });
  });

  const diagnose = (): string =>
    [
      exited === undefined ? '' : `The server exited early: ${JSON.stringify(exited)}`,
      errorOutput === '' ? '' : `stderr:\n${errorOutput}`,
      records.length === 0
        ? ''
        : `stdout records:\n${records.map((r) => JSON.stringify(r)).join('\n')}`,
    ]
      .filter((part) => part !== '')
      .join('\n');

  const baseUrl = await waitFor(
    'the server to report that it is listening',
    () => {
      const listening = records.find((record) => record['msg'] === 'server listening');
      return listening === undefined ? undefined : baseUrlOf(listening['address']);
    },
    { timeoutMs: READY_TIMEOUT_MS, diagnose },
  );

  return {
    baseUrl,
    stderr: () => errorOutput,
    records: () => records,
    problems: () =>
      records
        .filter((record) => typeof record['level'] === 'number' && record['level'] >= WARN_LEVEL)
        .map((record) => JSON.stringify(record))
        .join('\n'),
    async stop(): Promise<void> {
      if (exited !== undefined) {
        return;
      }
      child.kill('SIGTERM');
      await Promise.race([
        exit,
        new Promise<void>((resolve) => {
          setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, EXIT_TIMEOUT_MS).unref();
        }),
      ]);
    },
  };
}

// ---------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------

/** Where one `agentchat` process keeps its files and what it thinks it is. */
export interface CliWorkspace {
  /** The temporary directory holding both of the below. Removed as a whole. */
  readonly root: string;
  /** `XDG_CONFIG_HOME`: this identity's credentials and user configuration. */
  readonly configHome: string;
  /** The working directory, which is where `.agentchat/config.json` lands. */
  readonly workDir: string;
}

/** What one finished `agentchat` run produced. */
export interface CliRun {
  /** File descriptor 1, verbatim. Message payloads and JSON documents only. */
  readonly stdout: string;
  /** File descriptor 2, verbatim. Everything a human reads. */
  readonly stderr: string;
  /** The exit code, or `null` if a signal ended it. */
  readonly code: number | null;
}

/**
 * The environment an `agentchat` process runs in.
 *
 * Replaces the parent's rather than extending it, apart from `PATH`, which Node
 * needs to re-exec itself. A developer with `AGENTCHAT_SERVER` or `NO_COLOR`
 * exported must not be able to change what this suite asserts.
 */
function cliEnv(
  workspace: CliWorkspace,
  extra: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '',
    HOME: workspace.configHome,
    XDG_CONFIG_HOME: workspace.configHome,
    // Deterministic output regardless of the terminal the suite was started
    // from. Both descriptors are pipes here anyway, so this is belt and braces.
    NO_COLOR: '1',
    ...extra,
  };
}

/**
 * Runs one `agentchat` command to completion.
 *
 * @param workspace - Whose configuration to use and where to run.
 * @param argv - Arguments after the program name.
 * @param extraEnv - Additional environment, e.g. `AGENTCHAT_PROJECT`.
 * @returns Both descriptors and the exit code, captured separately.
 */
export async function runCli(
  workspace: CliWorkspace,
  argv: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<CliRun> {
  const child = spawn(process.execPath, [CLI_BINARY, ...argv], {
    cwd: workspace.workDir,
    env: cliEnv(workspace, extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const code = await new Promise<number | null>((resolve) => {
    child.once('close', resolve);
  });

  return { stdout, stderr, code };
}

/**
 * Runs a `--json` command and returns its document, insisting it succeeded.
 *
 * A failed command's stderr is the most useful thing in the suite when
 * something is wrong end to end, so it is attached rather than summarised.
 *
 * @param workspace - Whose configuration to use and where to run.
 * @param argv - Arguments after the program name; `--json` is added.
 * @param extraEnv - Additional environment.
 * @returns The first JSON document written to stdout.
 * @throws If the command exited non-zero or wrote nothing parseable.
 */
export async function runCliJson<T>(
  workspace: CliWorkspace,
  argv: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<T> {
  const run = await runCli(workspace, ['--json', ...argv], extraEnv);
  const rendered = `\n  argv: ${JSON.stringify(argv)}\n  exit: ${String(run.code)}\n  stdout: ${run.stdout}\n  stderr: ${run.stderr}`;

  if (run.code !== 0) {
    throw new Error(`\`agentchat ${argv.join(' ')}\` failed.${rendered}`);
  }

  const first = run.stdout.split('\n').find((line) => line.trim() !== '');
  if (first === undefined) {
    throw new Error(`\`agentchat ${argv.join(' ')}\` wrote nothing to stdout.${rendered}`);
  }

  try {
    return JSON.parse(first) as T;
  } catch {
    throw new Error(`\`agentchat ${argv.join(' ')}\` wrote unparseable stdout.${rendered}`);
  }
}

/**
 * Creates a config home and a working directory for one identity.
 *
 * Two separate directories, because the CLI keeps two separate things there and
 * the split is load-bearing (`packages/cli/src/config.ts`): credentials and the
 * chosen agent are personal and live under `XDG_CONFIG_HOME`, while
 * `.agentchat/config.json` is committed and lives in the working tree. A suite
 * that pointed both at one directory could not tell the two apart, and would
 * pass if a future change put a token in the repository file.
 *
 * The working directory is a fresh temporary tree, so the walk that looks for
 * `.agentchat/config.json` in parent directories cannot find the repository
 * this suite is running inside.
 *
 * @param prefix - Names the directory, so a leaked one says who left it.
 * @returns The two paths. Remove them with {@link removeWorkspace}.
 */
export async function createWorkspace(prefix: string): Promise<CliWorkspace> {
  const root = await mkdtemp(join(tmpdir(), `agentchat-e2e-${prefix}-`));
  const configHome = join(root, 'config');
  const workDir = join(root, 'repo');
  await mkdir(configHome, { recursive: true });
  await mkdir(workDir, { recursive: true });
  return { root, configHome, workDir };
}

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------

/**
 * One object from `agentchat listen --json`.
 *
 * Deliberately untyped past `event`: the command passes the server's envelope
 * through verbatim so a field a newer server adds reaches the consumer without
 * a CLI release, and a test that projected it onto a fixed shape would be
 * asserting the opposite of that promise.
 */
export type ListenEvent = Record<string, unknown> & { readonly event?: unknown };

/** A backgrounded `agentchat listen --json` process. */
export interface Listener {
  /** Every JSON object it has written to stdout, in order. */
  events(): readonly ListenEvent[];
  /** Only its `message` events. */
  messages(): readonly ListenEvent[];
  /** Everything it has written to stderr. */
  stderr(): string;
  /** Every line written to stdout that was not JSON. Must always be empty. */
  unparsedStdout(): readonly string[];
  /** Resolves with the first event matching `predicate`. */
  waitForEvent(what: string, predicate: (event: ListenEvent) => boolean): Promise<ListenEvent>;
  /** Resolves with the message event carrying `messageId`. */
  waitForMessage(messageId: string): Promise<ListenEvent>;
  /** Whether the process has ended. */
  hasExited(): boolean;
  /** Sends a signal and waits for the process to end. */
  stop(signal?: NodeJS.Signals): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Starts `agentchat listen --json` in the background.
 *
 * stdout and stderr are captured **independently**, which is not an
 * implementation detail: PRD §39 makes "message payloads on stdout and nothing
 * else" the contract every harness integration depends on, and a helper that
 * merged the two descriptors would let this suite pass while that contract was
 * broken.
 *
 * @param workspace - Whose configuration to use and where to run.
 * @param argv - Arguments after `listen`, e.g. `['--runtime', 'e2e']`.
 * @param extraEnv - Additional environment.
 * @returns The running listener. The caller must `stop()` it.
 */
export function startListener(
  workspace: CliWorkspace,
  argv: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): Listener {
  const child: ChildProcess = spawn(process.execPath, [CLI_BINARY, '--json', 'listen', ...argv], {
    cwd: workspace.workDir,
    env: cliEnv(workspace, extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const events: ListenEvent[] = [];
  const unparsed: string[] = [];
  const lines = new LineReader();
  let stderr = '';
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    for (const line of lines.push(chunk)) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === 'object' && parsed !== null) {
          events.push(parsed as ListenEvent);
        } else {
          unparsed.push(line);
        }
      } catch {
        unparsed.push(line);
      }
    }
  });

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => {
      exited = { code, signal };
      resolve(exited);
    });
  });
  // Nothing may reject on an unobserved promise if a test never calls `stop`.
  exit.catch(() => undefined);

  const diagnose = (): string =>
    [
      exited === undefined ? '' : `The listener exited: ${JSON.stringify(exited)}`,
      `events so far:\n${events.map((event) => JSON.stringify(event)).join('\n')}`,
      stderr === '' ? '' : `stderr:\n${stderr}`,
    ]
      .filter((part) => part !== '')
      .join('\n');

  const waitForEvent = (
    what: string,
    predicate: (event: ListenEvent) => boolean,
  ): Promise<ListenEvent> =>
    waitFor(what, () => events.find(predicate), { timeoutMs: EVENT_TIMEOUT_MS, diagnose });

  return {
    events: () => events,
    messages: () => events.filter((event) => event['event'] === 'message'),
    stderr: () => stderr,
    unparsedStdout: () => unparsed,
    waitForEvent,
    waitForMessage: (messageId: string) =>
      waitForEvent(`message ${messageId}`, (event) => event['messageId'] === messageId),
    hasExited: () => exited !== undefined,
    async stop(signal: NodeJS.Signals = 'SIGTERM') {
      if (exited !== undefined) {
        return exited;
      }
      child.kill(signal);
      const forced = await Promise.race([
        exit,
        new Promise<undefined>((resolve) => {
          setTimeout(() => {
            resolve(undefined);
          }, EXIT_TIMEOUT_MS).unref();
        }),
      ]);
      if (forced === undefined) {
        child.kill('SIGKILL');
        return exit;
      }
      return forced;
    },
  };
}

/**
 * Waits until a listener reports that its socket is up.
 *
 * The `connected` status is what makes "the message was sent while somebody was
 * listening" a fact rather than a hope. Tests that need fan-out, and tests that
 * need the *opposite* — a message sent to nobody — both depend on this being an
 * observed event and not an elapsed interval.
 *
 * @param listener - The listener to wait on.
 * @returns The `status` event that reported the connection.
 */
export function waitUntilConnected(listener: Listener): Promise<ListenEvent> {
  return listener.waitForEvent(
    'the listener to report a connected socket',
    (event) => event['event'] === 'status' && event['state'] === 'connected',
  );
}

/** Removes a workspace's temporary directory, ignoring a missing one. */
export async function removeWorkspace(workspace: CliWorkspace): Promise<void> {
  await rm(workspace.root, { recursive: true, force: true });
}

export { waitFor };
