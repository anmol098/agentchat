/**
 * A process, faked.
 *
 * Lets a test drive {@link run} end to end — argument parsing, dispatch, the
 * error renderer, the exit code — without a subprocess, by supplying the three
 * descriptors as objects: two that record what was written to them, and one that
 * answers a prompt from a script ({@link ScriptedInput}). It is the fast
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
import type { InputStream, OutputStream } from './output/streams.js';

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

/**
 * A readable descriptor that answers from a fixed script.
 *
 * The default is the empty string, which is a *closed* descriptor rather than a
 * silent one: it ends immediately, so a command that prompts sees end of input
 * and declines. That is the right default — a test that did not think about
 * stdin is a test running without a person at the keyboard — and it is also the
 * case that most needs covering, since it is what a CI runner has.
 */
export class ScriptedInput implements InputStream {
  /**
   * @param text - Everything the descriptor will produce, delivered as one
   *   chunk. Include the newline a line-oriented reader is waiting for.
   */
  public constructor(public readonly text: string = '') {}

  /** @inheritdoc */
  public async *[Symbol.asyncIterator](): AsyncIterator<string> {
    if (this.text !== '') {
      // `await` so the read is asynchronous, as a real descriptor's is: a
      // synchronous answer would let an ordering bug in a prompt pass unnoticed.
      await Promise.resolve();
      yield this.text;
    }
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

  /**
   * What standard input produces, or an {@link InputStream} for a test that
   * needs to control the chunking. Defaults to nothing at all, which is a closed
   * descriptor: a prompt sees end of input and declines.
   */
  readonly stdin?: string | InputStream;

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
      stdin: typeof options.stdin === 'object' ? options.stdin : new ScriptedInput(options.stdin),
      env: options.env ?? {},
      cwd: options.cwd ?? '/tmp',
    },
    ...(options.commands === undefined ? {} : { commands: options.commands }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  const code = await run(runOptions);
  return { stdout: stdout.text, stderr: stderr.text, code };
}
