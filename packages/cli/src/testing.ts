/**
 * A process, faked.
 *
 * Lets a test drive {@link run} end to end — argument parsing, dispatch, the
 * error renderer, the exit code — without a subprocess, by supplying the two
 * descriptors as objects that record what was written to them. It is the fast
 * counterpart to the suites under `tests/`, which spawn the real binary and are
 * the ones that actually prove the contract; this exists so that a test of a
 * *branch* does not have to cost a process launch.
 *
 * Exported from the package because every later command will want it. T-204
 * onwards should reach for {@link captureRun} rather than inventing a fourth
 * way to assert on output.
 *
 * @module
 */

import type { CommandNode } from './command.js';
import type { ExitCode } from './exit.js';
import type { RunOptions } from './main.js';
import { run } from './main.js';
import type { OutputStream } from './output/streams.js';

/** A writable descriptor that keeps what it was given. */
export class RecordingStream implements OutputStream {
  /** Everything written, concatenated. */
  public text = '';

  /**
   * @param isTTY - What the code under test should believe about this
   *   descriptor. `false` — a pipe — is the case that matters.
   */
  public constructor(public readonly isTTY: boolean = false) {}

  /** @inheritdoc */
  public write(chunk: string, callback: (error?: Error | null) => void): boolean {
    this.text += chunk;
    // Asynchronously, as a real pipe does. A synchronous callback would let an
    // ordering bug in `emit`-then-acknowledge pass unnoticed.
    queueMicrotask(() => {
      callback(null);
    });
    return true;
  }
}

/** What one faked invocation produced. */
export interface Capture {
  /** Everything written to stdout. */
  readonly stdout: string;

  /** Everything written to stderr. */
  readonly stderr: string;

  /** The exit code {@link run} returned. */
  readonly code: ExitCode;
}

/** How to fake one invocation. */
export interface CaptureOptions {
  /** The commands to dispatch to. Defaults to the ones this build ships. */
  readonly commands?: readonly CommandNode[];

  /** The environment. Defaults to empty, so a developer's shell cannot leak in. */
  readonly env?: Readonly<Record<string, string | undefined>>;

  /** The working directory. Defaults to `/tmp`. */
  readonly cwd?: string;

  /** Whether the fake stdout claims to be a terminal. Defaults to `false`. */
  readonly stdoutIsTTY?: boolean;

  /** Whether the fake stderr claims to be a terminal. Defaults to `false`. */
  readonly stderrIsTTY?: boolean;

  /** Aborted to simulate an interrupt. */
  readonly signal?: AbortSignal;
}

/**
 * Runs the CLI against fake descriptors.
 *
 * @param argv - The arguments after the program name.
 * @param options - The registry and the environment to run against.
 * @returns Both streams and the exit code.
 */
export async function captureRun(
  argv: readonly string[],
  options: CaptureOptions = {},
): Promise<Capture> {
  const stdout = new RecordingStream(options.stdoutIsTTY ?? false);
  const stderr = new RecordingStream(options.stderrIsTTY ?? false);

  const runOptions: RunOptions = {
    argv,
    env: {
      stdout,
      stderr,
      env: options.env ?? {},
      cwd: options.cwd ?? '/tmp',
    },
    ...(options.commands === undefined ? {} : { commands: options.commands }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  const code = await run(runOptions);
  return { stdout: stdout.text, stderr: stderr.text, code };
}
