/**
 * {@link Logger} — everything that is not a result.
 *
 * Progress, connection state, warnings, deprecations, the line telling a user
 * which agent they are listening as: all of it belongs on stderr, in both
 * output modes, always. That is PRD §39, and it is the half of the contract
 * that makes the other half useful — stdout is only trustworthy because there
 * is somewhere else to put everything that would otherwise pollute it.
 *
 * Lines are prefixed `[agentchat]`, as plan §6.3 specifies for `listen`, and
 * applied everywhere so that a user tailing a combined log can tell this
 * process's chatter from their own.
 *
 * ## Levels
 *
 * | Flag        | Level   | What is written                    |
 * |-------------|---------|------------------------------------|
 * | `--quiet`   | `error` | Nothing but failures.              |
 * | (default)   | `info`  | Failures, warnings, progress.      |
 * | `--verbose` | `debug` | Everything, including causes.      |
 *
 * Failures bypass the level entirely; `--quiet` suppresses noise, not news of
 * a command that did not work. Rendering failures is `./failure.ts`'s job.
 *
 * ## Why these methods do not return promises
 *
 * A log line is fire-and-forget by nature, and a `Logger` whose every call had
 * to be awaited would put an `await` in front of a hundred statements that have
 * no ordering requirement. The writes are still real promises underneath, so
 * each one is explicitly discarded with `void` and its rejection swallowed:
 * stderr breaking is not a reason to fail a command that otherwise worked.
 *
 * @module
 */

import type { Palette } from './colour.js';
import type { StreamSink } from './streams.js';

/** How much this process says about what it is doing. */
export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

/** Level ordering: a message is written when its level is at or below the current one. */
const SEVERITY: Readonly<Record<LogLevel, number>> = Object.freeze({
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
});

/** The prefix every operational line carries. */
export const LOG_PREFIX = '[agentchat]';

/** Construction options for {@link Logger}. */
export interface LoggerOptions {
  /** Where operational output goes. Always stderr in production. */
  readonly sink: StreamSink;

  /** The verbosity threshold. */
  readonly level: LogLevel;

  /** Decoration for the prefix and severity words. */
  readonly palette: Palette;
}

/** Writes operational output to stderr. */
export class Logger {
  readonly #sink: StreamSink;
  readonly #level: LogLevel;
  readonly #palette: Palette;

  /**
   * @param options - Sink, level, and palette.
   */
  public constructor(options: LoggerOptions) {
    this.#sink = options.sink;
    this.#level = options.level;
    this.#palette = options.palette;
  }

  /** The threshold in force. */
  public get level(): LogLevel {
    return this.#level;
  }

  /**
   * The decorations stderr is using.
   *
   * Exposed so a caller that builds a multi-line report — the failure renderer,
   * the help text — styles it consistently and writes it in one go.
   */
  public get palette(): Palette {
    return this.#palette;
  }

  /** Whether `--verbose` was given, for callers that can say more when asked. */
  public get isVerbose(): boolean {
    return SEVERITY[this.#level] >= SEVERITY.debug;
  }

  /**
   * Reports progress: what the command is about to do or has just done.
   *
   * @param message - One line, no trailing newline.
   */
  public info(message: string): void {
    this.#emit('info', `${this.#palette.dim(LOG_PREFIX)} ${message}`);
  }

  /**
   * Reports something the user should know but that did not stop the command.
   *
   * @param message - One line, no trailing newline.
   */
  public warn(message: string): void {
    this.#emit(
      'warn',
      `${this.#palette.dim(LOG_PREFIX)} ${this.#palette.yellow('warning:')} ${message}`,
    );
  }

  /**
   * Reports detail that is noise unless something is wrong.
   *
   * @param message - One line, no trailing newline.
   */
  public debug(message: string): void {
    this.#emit('debug', `${this.#palette.dim(`${LOG_PREFIX} debug: ${message}`)}`);
  }

  /**
   * Writes a line to stderr regardless of level, without the prefix.
   *
   * For the failure renderer and for help text, which are the reason the user
   * ran the command rather than commentary on it.
   *
   * @param text - The text to write. A trailing newline is added.
   */
  public raw(text: string): void {
    this.#write(`${text}\n`);
  }

  /**
   * Writes a line if the level allows it.
   *
   * @param level - The line's severity.
   * @param text - The already-decorated line.
   */
  #emit(level: LogLevel, text: string): void {
    if (SEVERITY[this.#level] < SEVERITY[level]) {
      return;
    }
    this.#write(`${text}\n`);
  }

  /**
   * Writes to the sink and discards both the promise and any failure.
   *
   * @param text - The exact bytes to write.
   */
  #write(text: string): void {
    void this.#sink.write(text).catch(() => {
      // stderr is unavailable — a closed pipe, a full disk. There is nowhere
      // left to report that, and it must not turn a successful command into a
      // failed one.
    });
  }
}
