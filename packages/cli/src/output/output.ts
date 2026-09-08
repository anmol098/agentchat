/**
 * {@link Output} — the single door to stdout, and the reason PRD §39 holds.
 *
 * ## The contract
 *
 * > `stdout` carries machine-consumable output only. Every operational log,
 * > every progress message, every warning goes to `stderr`.
 *
 * An AI coding agent reads this process's stdout to consume messages. One stray
 * log line there corrupts its input, and the failure is silent on our side and
 * baffling on theirs. So the contract is not enforced by review or by
 * convention here; it is enforced by the shape of the types.
 *
 * A command never receives a writable stdout. It returns a {@link View}: the
 * value it wants a machine to read, plus a function that renders the same thing
 * for a human. The framework decides which of the two to write, and writes it.
 * A command that wants to say something operational has exactly one place to
 * say it — the {@link Logger}, which only knows how to reach stderr.
 *
 * ## What stdout looks like
 *
 * In `--json` mode: newline-delimited JSON. One `emit` is one line, one
 * complete JSON value, never coloured and never pretty-printed. Most commands
 * emit exactly once, so their stdout is a single JSON document; `listen` emits
 * per event, which is the NDJSON stream plan §6.3 specifies. A consumer can
 * therefore parse line by line without knowing which kind of command it ran.
 *
 * In human mode: whatever the view rendered, and nothing else.
 *
 * In both modes, a command that produces no result writes nothing at all.
 *
 * @module
 */

import type { Palette } from './colour.js';
import { PLAIN_PALETTE } from './colour.js';
import type { StreamSink } from './streams.js';
import { HumanWriter } from './writer.js';

/**
 * A value that survives `JSON.stringify` unchanged.
 *
 * Commands are typed against this rather than `unknown` so that a `Date`, a
 * `Map`, or a `class` instance sneaking into `--json` output is a compile
 * error rather than a `{}` a consumer has to discover at runtime.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * One unit of command output, in both of its representations.
 *
 * The two must describe the same thing. Where they differ, `json` is the
 * contract — it is what a harness branches on, and changing it is a breaking
 * change to the CLI's public surface, while the human rendering is free to be
 * rearranged for legibility.
 */
export interface View {
  /** What `--json` prints: one complete JSON value. */
  readonly json: JsonValue;

  /**
   * Renders the human form. Never called in `--json` mode.
   *
   * @param writer - Accumulates lines; see {@link HumanWriter}.
   */
  render(writer: HumanWriter): void;
}

/**
 * Builds a {@link View} from its two halves.
 *
 * @param json - The machine-readable value.
 * @param render - How to render it for a human.
 * @returns The view.
 */
export function view(json: JsonValue, render: (writer: HumanWriter) => void): View {
  return { json, render };
}

/** Which representation stdout carries. */
export type OutputMode = 'json' | 'human';

/** Construction options for {@link Output}. */
export interface OutputOptions {
  /** Where results go. */
  readonly sink: StreamSink;

  /** Which representation to write. */
  readonly mode: OutputMode;

  /**
   * Decoration for human mode. Ignored in JSON mode, which is never coloured
   * whatever the environment or the flags say.
   */
  readonly palette: Palette;
}

/** Writes command results, and nothing else, to stdout. */
export class Output {
  readonly #sink: StreamSink;
  readonly #mode: OutputMode;
  readonly #palette: Palette;

  /**
   * @param options - Sink, mode, and palette.
   */
  public constructor(options: OutputOptions) {
    this.#sink = options.sink;
    this.#mode = options.mode;
    this.#palette = options.mode === 'json' ? PLAIN_PALETTE : options.palette;
  }

  /** Which representation this output writes. */
  public get mode(): OutputMode {
    return this.#mode;
  }

  /** Whether `--json` was asked for. */
  public get isJson(): boolean {
    return this.#mode === 'json';
  }

  /**
   * Writes one view to stdout.
   *
   * @param value - What to write.
   * @returns A promise that resolves once the bytes have been flushed — which
   *   is the point at which `listen` may acknowledge a message (plan §6.3).
   * @throws The underlying stream error, including `EPIPE` when the reader has
   *   closed the pipe. See `./streams.ts`.
   */
  public emit(value: View): Promise<void> {
    return this.#sink.write(this.#format(value));
  }

  /**
   * Renders a view without writing it.
   *
   * @param value - The view to render.
   * @returns Exactly the text {@link Output.emit} would write.
   */
  #format(value: View): string {
    if (this.#mode === 'json') {
      return `${JSON.stringify(value.json)}\n`;
    }
    const writer = new HumanWriter(this.#palette);
    value.render(writer);
    return writer.toText();
  }
}
