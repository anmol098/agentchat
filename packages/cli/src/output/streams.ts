/**
 * The two file descriptors, as a seam.
 *
 * Everything this CLI writes goes through a {@link StreamSink}, and every sink
 * is handed to the code that uses it rather than reached for globally. Nothing
 * below `bin.ts` touches `process.stdout`, which is what makes the stream
 * discipline testable in-process as well as by spawning the binary.
 *
 * ## Why writes are awaited
 *
 * `process.stdout.write` on a pipe is asynchronous: it returns `false` when the
 * kernel buffer is full and finishes later. Two consequences shape this module.
 *
 * First, the process must never call `process.exit()`, which discards whatever
 * is still buffered — `bin.ts` sets `process.exitCode` and returns instead.
 *
 * Second, {@link StreamSink.write} resolves only once the write callback has
 * fired. Plan §6.3 requires `agentchat listen` to acknowledge a message *after*
 * it has reached stdout, so that a harness whose pipe died does not lose the
 * message it never received. That guarantee has to exist in the plumbing before
 * the command that needs it is written.
 *
 * ## EPIPE is not a failure
 *
 * `agentchat listen --json | head -1` closes the read end while this process is
 * still writing. That surfaces as `EPIPE`, and the correct response is to stop
 * quietly, not to print a stack trace about a pipe the user closed on purpose.
 * A sink that takes `EPIPE` marks itself {@link StreamSink.closed} and rejects
 * with the original error so the caller can distinguish "written" from "the
 * reader went away"; `main.ts` turns that into a silent exit.
 *
 * @module
 */

/**
 * The part of `process.stdout` this package uses.
 *
 * Narrow on purpose: a test double is four lines, and a command that wanted
 * `columns` or `cork()` would have to widen this deliberately.
 */
export interface OutputStream {
  /**
   * Writes a chunk and invokes the callback once it has been flushed to the
   * operating system.
   *
   * @param chunk - The text to write.
   * @param callback - Invoked with an error, or with nothing on success.
   * @returns `false` when the internal buffer is full, as Node's streams do.
   */
  write(chunk: string, callback: (error?: Error | null) => void): boolean;

  /** Whether this descriptor is attached to a terminal. */
  readonly isTTY?: boolean | undefined;
}

/**
 * Everything the CLI needs from the process it runs in.
 *
 * Passed down from `bin.ts` as one object so `run()` is a function of its
 * arguments, and so a test can supply a whole environment without touching
 * globals or worrying about a parallel test changing `process.env` underneath
 * it.
 */
export interface CliEnvironment {
  /** Where results go. Nothing else may be written here. */
  readonly stdout: OutputStream;

  /** Where logs, warnings, progress, and human-mode errors go. */
  readonly stderr: OutputStream;

  /** The process environment. */
  readonly env: Readonly<Record<string, string | undefined>>;

  /** The working directory, for the commands that resolve context from it. */
  readonly cwd: string;
}

/**
 * Whether an error is the "the reader closed the pipe" error.
 *
 * @param error - Any thrown value.
 * @returns `true` for an `EPIPE` system error.
 */
export function isBrokenPipe(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EPIPE'
  );
}

/** A writable file descriptor, with awaitable writes. */
export class StreamSink {
  readonly #stream: OutputStream;
  #closed = false;

  /**
   * @param stream - The underlying stream, usually `process.stdout` or
   *   `process.stderr`.
   */
  public constructor(stream: OutputStream) {
    this.#stream = stream;
  }

  /** Whether the reader has gone away, so further writes are pointless. */
  public get closed(): boolean {
    return this.#closed;
  }

  /** Whether this descriptor is a terminal. `false` for a pipe or a file. */
  public get isTTY(): boolean {
    return this.#stream.isTTY === true;
  }

  /**
   * Writes text and resolves once it has been flushed.
   *
   * @param text - The exact bytes to write. No newline is appended; callers
   *   include their own.
   * @returns A promise that resolves when the write has completed.
   * @throws The underlying stream error. An `EPIPE` also marks this sink
   *   {@link StreamSink.closed}; see the module note.
   */
  public write(text: string): Promise<void> {
    if (this.#closed || text === '') {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      try {
        this.#stream.write(text, (error) => {
          if (error === undefined || error === null) {
            resolve();
            return;
          }
          if (isBrokenPipe(error)) {
            this.#closed = true;
          }
          reject(error);
        });
      } catch (error) {
        // Node can also throw synchronously once the descriptor is gone.
        if (isBrokenPipe(error)) {
          this.#closed = true;
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
