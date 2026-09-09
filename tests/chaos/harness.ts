/**
 * The chaos harness: the end-to-end suite's world, with the wires exposed.
 *
 * ## What this adds to `tests/e2e/harness.ts`, and what it does not
 *
 * Read `../e2e/harness.ts` first. Its rule — **nothing this project ships is
 * stubbed** — is this suite's rule too, and everything it already provides is
 * imported rather than rewritten: the migration runner, the CLI workspaces, the
 * `agentchat` process runners, the backgrounded listener, the condition waits,
 * and the one documented fake, the identity provider.
 *
 * Three things it deliberately does not provide, because T-314 had no use for
 * them and providing them would have made its server harder to reason about:
 *
 * 1. **A server whose address outlives it.** `startServer` binds port 0 and
 *    reports what it got, which is right for a suite that starts one server and
 *    keeps it. A suite that *kills* the server has to put it back somewhere its
 *    clients can still find it, and `agentchat login` has already written the
 *    old address into a credentials file. {@link startTcpProxy} owns the
 *    client-facing port instead, and a restart is a retarget.
 * 2. **A database connection this process can interfere with.** The server's
 *    `DATABASE_URL` is a fixed read of the environment there. Here it points at
 *    a relay, so "the database went away and came back" is two method calls
 *    rather than a `docker stop` that would disturb every other suite sharing
 *    the container.
 * 3. **Standard input.** `runCli` runs with `stdin` closed, which is correct for
 *    every command T-314 runs. `agentchat send -` reads its body from stdin,
 *    and a 1 MiB body has to arrive that way: a megabyte in `argv` is over
 *    Linux's 128 KiB `MAX_ARG_STRLEN` and the process would not start at all.
 *    {@link runCliWithInput} is `runCli` with a pipe on descriptor 0.
 *
 * ## The second substitution, and why it is time
 *
 * `../e2e/github-redirect.mjs` is the end-to-end suite's only fake. This suite
 * has a second one, `./clock-shift.mjs`, and it is the server process's clock.
 *
 * The alternative is a test that runs for an hour. `ACCESS_TOKEN_TTL_SECONDS`
 * is a constant in `server/src/auth/tokens.ts` with no environment override, so
 * "the access token expired while the listener was running" cannot be reached
 * by waiting, and the acceptance criterion asking for it is not optional.
 *
 * Shifting the server's clock is a narrow substitution because of a property of
 * the code it runs against: `server/src/services/sessions.ts` measures the whole
 * session lifecycle in *database* time — every timestamp it writes is `now()`
 * and every threshold it compares against is derived from `now()` — so moving
 * the application clock forward expires JSON Web Tokens and moves nothing else.
 * Sessions do not go stale, sweeps do not fire early, and nothing about the
 * failure being tested is simulated: the token is genuinely past its `exp`, the
 * server genuinely refuses it, and the client genuinely refreshes.
 *
 * @module
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  type CliRun,
  type CliWorkspace,
  createWorkspace,
  runCli,
  runCliJson,
  waitFor,
} from '../e2e/harness.js';
import { startTcpProxy, type TcpProxy } from './proxy.js';

/** The repository root, wherever the runner happens to have been started. */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The `server` workspace directory. */
const SERVER_DIR = join(REPO_ROOT, 'server');

/** The built server entry point — the file the container image runs. */
const SERVER_ENTRY = join(SERVER_DIR, 'dist', 'src', 'index.js');

/** The built `agentchat` binary, exactly as `package.json`'s `bin` points at it. */
const CLI_BINARY = join(REPO_ROOT, 'packages', 'cli', 'dist', 'bin.js');

/** The `--import` hook that points the server's GitHub calls at the fake. */
const REDIRECT_HOOK = pathToFileURL(join(REPO_ROOT, 'tests', 'e2e', 'github-redirect.mjs')).href;

/** The `--import` hook that moves the server process's clock. See the module note. */
const CLOCK_HOOK = pathToFileURL(join(REPO_ROOT, 'tests', 'chaos', 'clock-shift.mjs')).href;

/**
 * Server configuration that is not under test.
 *
 * The same shape as the end-to-end suite's, with one difference that matters
 * here: `JWT_SECRET` is fixed, and it has to be, because this suite kills the
 * server and starts another one. A secret that changed between the two would
 * invalidate every token in flight and turn "the server restarted" into "every
 * client was logged out", which is not the failure being tested.
 */
const SERVER_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  HOST: '127.0.0.1',
  PORT: '0',
  JWT_SECRET: 'chaos-jwt-secret-that-is-long-enough-for-hs256',
  GITHUB_CLIENT_ID: 'chaos-client-id',
  GITHUB_CLIENT_SECRET: 'chaos-client-secret',
} as const;

/** How long to wait for a server process to report that it is listening. */
const READY_TIMEOUT_MS = 30_000;

/** How long a process is given to exit after a signal before it is killed. */
const EXIT_TIMEOUT_MS = 10_000;

/** pino's level for `warn`; anything at or above it is worth reporting. */
const WARN_LEVEL = 40;

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

/** Turns whatever Fastify reported as an address into a port. */
function portOf(address: unknown): number | undefined {
  if (typeof address === 'object' && address !== null) {
    const port = (address as Record<string, unknown>)['port'];
    if (typeof port === 'number') {
      return port;
    }
  }
  return undefined;
}

/** A server process this suite can kill. */
export interface ChaosServer {
  /** The ephemeral port it bound. What the relay is pointed at. */
  readonly port: number;
  /** Every structured record it has written to stdout. */
  records(): readonly Record<string, unknown>[];
  /** The records it logged at `warn` or worse, rendered. */
  problems(): string;
  /** Whether the process has ended. */
  hasExited(): boolean;
  /**
   * Ends the process and waits for it to go.
   *
   * @param signal - `SIGKILL` for a crash, `SIGTERM` for a shutdown. A crash is
   *   the interesting one: it runs no shutdown path at all, so no connection is
   *   drained, no socket is closed politely and no session is ended, which is
   *   what a killed container does to its clients.
   */
  stop(signal?: NodeJS.Signals): Promise<void>;
}

/** What {@link startServerProcess} needs to know. */
export interface ChaosServerOptions {
  /** Where `../e2e/github-redirect.mjs` should send the server's GitHub calls. */
  readonly identityOrigin: string;
  /** The connection string the server is given. Usually a relay's. */
  readonly databaseUrl: string;
  /**
   * Milliseconds to move the server process's clock forward.
   *
   * Zero, and the hook is not loaded at all. See the module note for what this
   * does and does not affect.
   */
  readonly clockShiftMs?: number;
}

/**
 * Starts the built server as its own process and waits until it is listening.
 *
 * @param options - Identity origin, database, and any clock shift.
 * @returns The running server.
 * @throws If it does not report a listening address before the deadline, with
 *   everything it said on both descriptors attached.
 */
export async function startServerProcess(options: ChaosServerOptions): Promise<ChaosServer> {
  const shift = options.clockShiftMs ?? 0;
  const argv =
    shift === 0
      ? ['--import', REDIRECT_HOOK, SERVER_ENTRY]
      : ['--import', REDIRECT_HOOK, '--import', CLOCK_HOOK, SERVER_ENTRY];

  const child = spawn(process.execPath, argv, {
    cwd: SERVER_DIR,
    env: {
      PATH: process.env['PATH'] ?? '',
      ...SERVER_ENV,
      DATABASE_URL: options.databaseUrl,
      AGENTCHAT_E2E_IDENTITY_ORIGIN: options.identityOrigin,
      AGENTCHAT_CHAOS_CLOCK_SHIFT_MS: String(shift),
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
        : `stdout records:\n${records.map((record) => JSON.stringify(record)).join('\n')}`,
    ]
      .filter((part) => part !== '')
      .join('\n');

  const port = await waitFor(
    'the server to report that it is listening',
    () => {
      const listening = records.find((record) => record['msg'] === 'server listening');
      return listening === undefined ? undefined : portOf(listening['address']);
    },
    { timeoutMs: READY_TIMEOUT_MS, diagnose },
  );

  return {
    port,
    records: () => records,
    problems: () =>
      records
        .filter((record) => typeof record['level'] === 'number' && record['level'] >= WARN_LEVEL)
        .map((record) => JSON.stringify(record))
        .join('\n'),
    hasExited: () => exited !== undefined,
    async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
      if (exited !== undefined) {
        return;
      }
      child.kill(signal);
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

/**
 * Runs one `agentchat` command with something on its standard input.
 *
 * The only reason this exists rather than {@link runCli}: `agentchat send -`
 * reads its body from descriptor 0, and that is the only way a body near the
 * 1 MiB limit can be passed at all — a megabyte in a single `argv` entry
 * exceeds Linux's 128 KiB per-argument limit and `execve` refuses it.
 *
 * @param workspace - Whose configuration to use and where to run.
 * @param argv - Arguments after the program name.
 * @param input - Written to standard input, which is then closed.
 * @param extraEnv - Additional environment.
 * @returns Both descriptors and the exit code, captured separately.
 */
export async function runCliWithInput(
  workspace: CliWorkspace,
  argv: readonly string[],
  input: string,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<CliRun> {
  const child = spawn(process.execPath, [CLI_BINARY, ...argv], {
    cwd: workspace.workDir,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: workspace.configHome,
      XDG_CONFIG_HOME: workspace.configHome,
      NO_COLOR: '1',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
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

  // A body that the command refuses may never be read, and writing a megabyte
  // into a pipe nobody drains ends in EPIPE. That is the command doing its job,
  // not a harness failure, so it is swallowed and the exit code is what speaks.
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(input);

  const code = await new Promise<number | null>((resolve) => {
    child.once('close', resolve);
  });

  return { stdout, stderr, code };
}

export type { CliRun, CliWorkspace, TcpProxy };
export { createWorkspace, runCli, runCliJson, startTcpProxy, waitFor };
