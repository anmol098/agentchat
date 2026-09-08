/**
 * The three file descriptors, as a seam.
 *
 * Everything this CLI writes goes through a {@link StreamSink}, and every sink
 * is handed to the code that uses it rather than reached for globally. Nothing
 * below `bin.ts` touches `process.stdout`, which is what makes the stream
 * discipline testable in-process as well as by spawning the binary.
 *
 * ## Why there is an input descriptor now (T-207)
 *
 * There were two descriptors until a command needed to ask a question. T-208's
 * `agent delete` prompt had nowhere to take an answer from, so it reached for
 * `process.stdin` directly — the one place below `bin.ts` that touched the
 * process — and said in its own comment that the second confirmation prompt was
 * the moment to do it properly. `agentchat project join` is that second prompt,
 * so {@link CliEnvironment} now carries a {@link InputStream} alongside the two
 * output ones, and {@link StreamSource} is its {@link StreamSink}.
 *
 * The value of the seam is the same as for the output side and is not mainly
 * about tidiness: a test can now answer a prompt, and — more importantly — can
 * drive the *unanswered* case, where the descriptor is closed and the command
 * has to decide what silence means. A prompt that reads a global cannot be
 * tested for that at all without a pseudo-terminal.
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
 * The part of `process.stdin` this package uses.
 *
 * As narrow as {@link OutputStream}, and for the same reason: a test double is
 * an async generator of one line. Node's `process.stdin` satisfies it as it
 * stands — a `Readable` is an async iterable of `Buffer`, and a `Buffer` is a
 * `Uint8Array` — so `bin.ts` passes it through with no adapter.
 *
 * Chunks rather than lines, because that is what the descriptor produces and
 * because a line is a decision: where it ends, what encoding it was in, and
 * whether end-of-input terminates one. {@link StreamSource} makes that decision
 * in exactly one place.
 */
export interface InputStream {
  /**
   * Iterates the chunks as they arrive.
   *
   * @returns An iterator over text or bytes. Completing means end of input.
   */
  [Symbol.asyncIterator](): AsyncIterator<string | Uint8Array>;
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

  /**
   * Where an answer to a prompt comes from.
   *
   * Required rather than optional. An optional descriptor with a
   * `process.stdin` fallback would be the workaround it replaces, wearing an
   * interface: every prompt would still read a global on the path that matters,
   * and the test that proves otherwise would be the one nobody writes.
   */
  readonly stdin: InputStream;

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

/**
 * A readable file descriptor, one line at a time.
 *
 * The counterpart to {@link StreamSink}, and the only place in this package
 * that turns bytes into an answer. Three decisions live here rather than in
 * every command that asks a question.
 *
 * **End of input is not an empty line.** {@link StreamSource.readLine} resolves
 * to `null` when the descriptor closes with nothing left, and to `''` for a line
 * that really was empty — a person pressing Return. A prompt that conflated them
 * would read "nobody is there" as "the user accepted the default", which is the
 * difference between a CI runner declining and a CI runner joining a project.
 * `agentchat project join` depends on telling them apart.
 *
 * **Decoding spans chunks.** A pipe splits wherever it likes, including through
 * a multi-byte character, so the decoder is stateful and kept for the life of
 * the source.
 *
 * **Abort stops the wait.** Nothing else can: a pipe nobody is writing to never
 * resolves, so `Ctrl-C` at a prompt would otherwise hang until the descriptor
 * closed. An aborted read releases the descriptor and answers `null`, which
 * every caller already treats as "no answer".
 */
export class StreamSource {
  readonly #stream: InputStream;
  readonly #decoder = new TextDecoder();
  #iterator: AsyncIterator<string | Uint8Array> | null = null;
  #buffer = '';
  #ended = false;

  /**
   * @param stream - The underlying descriptor, usually `process.stdin`.
   */
  public constructor(stream: InputStream) {
    this.#stream = stream;
  }

  /**
   * Reads up to the next newline.
   *
   * @param signal - Aborted to stop waiting; see the class note.
   * @returns The line without its terminator, or `null` at end of input. A final
   *   line with no newline is still a line.
   */
  public async readLine(signal?: AbortSignal): Promise<string | null> {
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline >= 0) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        // Tolerate CRLF, which is what a Windows terminal and a text-mode pipe
        // both produce, so `y\r` is not a third answer meaning "no".
        return line.endsWith('\r') ? line.slice(0, -1) : line;
      }

      if (this.#ended) {
        const rest = this.#buffer;
        this.#buffer = '';
        return rest === '' ? null : rest;
      }

      const chunk = await this.#next(signal);
      if (chunk === null) {
        this.#ended = true;
        // Flush whatever the decoder was holding: a truncated multi-byte
        // sequence becomes a replacement character rather than vanishing.
        this.#buffer += this.#decoder.decode();
        continue;
      }
      this.#buffer +=
        typeof chunk === 'string' ? chunk : this.#decoder.decode(chunk, { stream: true });
    }
  }

  /**
   * Releases the descriptor.
   *
   * Not optional for `process.stdin`: an iterator left suspended on a pipe keeps
   * the event loop alive, and a command that asked one question would then hang
   * after answering it. Idempotent, and safe on a source that was never read.
   *
   * @returns A promise that resolves once the descriptor has been released.
   */
  public async close(): Promise<void> {
    const iterator = this.#iterator;
    this.#iterator = null;
    this.#ended = true;
    this.#buffer = '';
    await iterator?.return?.();
  }

  /**
   * The next chunk, or `null` at end of input or on abort.
   *
   * @param signal - Aborted to stop waiting.
   * @returns The chunk.
   */
  async #next(signal?: AbortSignal): Promise<string | Uint8Array | null> {
    this.#iterator ??= this.#stream[Symbol.asyncIterator]();
    const iterator = this.#iterator;

    if (signal?.aborted === true) {
      await this.close();
      return null;
    }

    const advance = iterator.next();
    const result = signal === undefined ? await advance : await raceAbort(advance, signal);
    if (result === ABORTED) {
      await this.close();
      return null;
    }
    if (result.done === true) {
      return null;
    }
    return result.value;
  }
}

/** What {@link raceAbort} resolves to when the signal won. */
const ABORTED = Symbol('aborted');

/**
 * Resolves with whichever happens first: the read, or the interrupt.
 *
 * @param pending - The in-flight read.
 * @param signal - The interrupt signal.
 * @returns The read's result, or {@link ABORTED}.
 */
async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  const controller = new AbortController();
  const interrupted = new Promise<typeof ABORTED>((resolve) => {
    signal.addEventListener(
      'abort',
      () => {
        resolve(ABORTED);
      },
      { once: true, signal: controller.signal },
    );
  });

  try {
    return await Promise.race([pending, interrupted]);
  } finally {
    controller.abort();
    // The losing read is still pending against a descriptor this source is about
    // to release; swallowing its rejection keeps an abort from surfacing as an
    // unhandled one.
    void pending.catch(() => undefined);
  }
}
