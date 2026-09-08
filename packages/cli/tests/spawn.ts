/**
 * Spawning the built binary, and reading each descriptor separately.
 *
 * Every assertion in `./binary.test.ts` and `./framework.test.ts` depends on
 * this file getting one thing right: stdout and stderr are captured
 * **independently**. A helper that merged them, or that used a pseudo-terminal,
 * would make the whole suite pass while the contract it exists to protect was
 * broken — which is precisely the failure mode PRD §39 describes.
 *
 * `child_process.spawn` with piped descriptors gives us that. It also means the
 * child sees `isTTY === false` on both, which is the case that matters: colour
 * must vanish and JSON must stay parseable when the output is going anywhere but
 * a terminal.
 *
 * @module
 */

import { execFile, spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/** The `packages/cli` directory. */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The built executable, exactly as `package.json`'s `bin` field points at it. */
export const BINARY = join(PACKAGE_ROOT, 'dist', 'bin.js');

/** The fixture binary that drives the same framework over failing commands. */
export const FRAMEWORK_FIXTURE = join(PACKAGE_ROOT, 'tests', 'fixtures', 'framework-cli.mjs');

/** What one spawned run produced. */
export interface Run {
  /** Everything written to file descriptor 1, verbatim. */
  readonly stdout: string;

  /** Everything written to file descriptor 2, verbatim. */
  readonly stderr: string;

  /** The process's exit code, or `null` if a signal ended it. */
  readonly code: number | null;

  /** The signal that ended it, if one did. */
  readonly signal: NodeJS.Signals | null;
}

/** How to run one command. */
export interface RunOptions {
  /** The script to run. Defaults to the real `agentchat` binary. */
  readonly script?: string;

  /**
   * Environment for the child.
   *
   * Replaces the parent's rather than extending it, apart from `PATH`, so a
   * developer with `NO_COLOR` or `FORCE_COLOR` exported cannot change what the
   * suite asserts. `PATH` is kept because Node needs it to re-exec itself.
   */
  readonly env?: Readonly<Record<string, string>>;

  /** Written to the child's stdin and then closed. */
  readonly stdin?: string;

  /** The working directory. Defaults to the package root. */
  readonly cwd?: string;
}

/**
 * Ensures `dist` exists and is no older than `src`, building it if it is not.
 *
 * The acceptance criterion is that the binary runs "from a built package", and a
 * suite that imported the TypeScript directly would not be testing that. CI runs
 * `pnpm build` before `pnpm test`, so in CI this finds the binary current and
 * does nothing; the build is here for the developer who edited a file and ran
 * the suite without rebuilding.
 *
 * The freshness check is not an optimisation. `tsc -b` on this project also
 * rebuilds `packages/protocol` and `packages/client`, whose `dist` other test
 * files in this same run are importing — so it must not be invoked while they
 * are, and the only safe time to invoke it is when those files are missing
 * anyway.
 *
 * @returns A promise that resolves once the binary is current.
 * @throws If the build fails, with the compiler's own output attached.
 */
export async function buildPackage(): Promise<void> {
  if (isBinaryCurrent()) {
    return;
  }
  const tsc = join(PACKAGE_ROOT, '..', '..', 'node_modules', '.bin', 'tsc');
  await promisify(execFile)(tsc, ['-b', join(PACKAGE_ROOT, 'tsconfig.json')], {
    cwd: PACKAGE_ROOT,
  });
}

/**
 * Whether the built binary is at least as new as every source file.
 *
 * @returns `false` if `dist/bin.js` is missing or older than any `src` file.
 */
function isBinaryCurrent(): boolean {
  let built: number;
  try {
    built = statSync(BINARY).mtimeMs;
  } catch {
    return false;
  }
  return newestSourceTime(join(PACKAGE_ROOT, 'src')) <= built;
}

/**
 * The modification time of the most recently changed file under a directory.
 *
 * @param directory - Where to look.
 * @returns The newest `mtimeMs`, or `Infinity` if the directory cannot be read,
 *   which forces a rebuild rather than trusting a stale artefact.
 */
function newestSourceTime(directory: string): number {
  try {
    let newest = 0;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      newest = Math.max(
        newest,
        entry.isDirectory() ? newestSourceTime(path) : statSync(path).mtimeMs,
      );
    }
    return newest;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Runs a command and captures each stream on its own.
 *
 * @param argv - The arguments after the program name.
 * @param options - Which script, and the environment to run it in.
 * @returns Both streams and the exit code.
 */
export function runCli(argv: readonly string[], options: RunOptions = {}): Promise<Run> {
  return new Promise<Run>((resolve, reject) => {
    const child = spawn(process.execPath, [options.script ?? BINARY, ...argv], {
      cwd: options.cwd ?? PACKAGE_ROOT,
      env: { PATH: process.env['PATH'] ?? '', ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ stdout, stderr, code, signal });
    });

    child.stdin.end(options.stdin ?? '');
  });
}

/**
 * Parses stdout as newline-delimited JSON, failing loudly if it is not.
 *
 * The assertion this suite is really making. `JSON.parse` on each line is the
 * same thing a harness does, so a stray log line, a colour escape, or a
 * half-written value fails here exactly as it would fail there.
 *
 * @param stdout - What the process wrote to file descriptor 1.
 * @returns One parsed value per line.
 * @throws If any line is not a complete JSON value.
 */
export function parseNdjson(stdout: string): unknown[] {
  if (stdout === '') {
    return [];
  }
  if (!stdout.endsWith('\n')) {
    throw new Error(`stdout did not end with a newline: ${JSON.stringify(stdout)}`);
  }
  return stdout
    .slice(0, -1)
    .split('\n')
    .map((line, index) => {
      try {
        return JSON.parse(line) as unknown;
      } catch (cause) {
        throw new Error(`stdout line ${String(index + 1)} is not JSON: ${JSON.stringify(line)}`, {
          cause,
        });
      }
    });
}

/** The pattern for an ANSI SGR escape, which must never appear on a pipe. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting the CSI introducer is the point.
export const ANSI = /\u001B\[[0-9;]*m/;
