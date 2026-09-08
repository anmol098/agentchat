/**
 * {@link HumanWriter} — the only way a command produces human-readable output.
 *
 * It writes nowhere. It accumulates lines and hands them back as one string,
 * which has three consequences worth the indirection:
 *
 * - A command's human rendering is a pure function of its data, so testing it
 *   needs no streams, no spies, and no temporary files.
 * - The whole rendering reaches the descriptor in a single `write`, so a
 *   half-rendered table cannot interleave with a log line from somewhere else.
 * - A command physically cannot write to stdout at the wrong moment, because it
 *   is never handed anything that can. In `--json` mode `render` is not called
 *   at all.
 *
 * The vocabulary is deliberately narrow — lines, label/value fields, and a
 * left-aligned table. Every M2 command's output is one of those three, and a
 * fourth shape should be added here once rather than invented three times in
 * `src/commands/`.
 *
 * @module
 */

import type { Palette } from './colour.js';

/** One column heading plus how to read a cell out of a row. */
export interface Column<TRow> {
  /** The heading, printed in the header row. */
  readonly header: string;

  /**
   * Extracts the cell text for one row.
   *
   * @param row - The row being rendered.
   * @returns The cell's text, already styled if it should be.
   */
  cell(row: TRow): string;
}

/**
 * Visible width of a string, ignoring ANSI escapes.
 *
 * Column alignment has to count characters the terminal draws, not bytes the
 * palette added. Wide (CJK) characters are still counted as one; getting that
 * right needs a Unicode width table, which is not worth a dependency here.
 *
 * @param text - The text to measure.
 * @returns The number of visible characters.
 */
export function visibleWidth(text: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ANSI CSI introducer is the point.
  return text.replace(/\u001B\[[0-9;]*m/g, '').length;
}

/** Accumulates the human rendering of one command's result. */
export class HumanWriter {
  readonly #lines: string[] = [];

  /** The decorations available to this rendering. Neutral when colour is off. */
  public readonly style: Palette;

  /**
   * @param style - The palette to render with.
   */
  public constructor(style: Palette) {
    this.style = style;
  }

  /**
   * Appends one line.
   *
   * @param text - The line's text. Omit it for a blank line.
   * @returns This writer, for chaining.
   */
  public line(text = ''): this {
    this.#lines.push(text);
    return this;
  }

  /**
   * Appends a blank line, unless the output is still empty or already ends in
   * one. Keeps sections separated without leaving a leading or doubled gap when
   * a section turns out to be empty.
   *
   * @returns This writer, for chaining.
   */
  public blank(): this {
    if (this.#lines.length > 0 && this.#lines[this.#lines.length - 1] !== '') {
      this.#lines.push('');
    }
    return this;
  }

  /**
   * Appends aligned `label: value` lines.
   *
   * @param entries - Label and value pairs, in the order to print them. A
   *   `null` value is skipped, so a caller can list optional fields without
   *   building the array conditionally.
   * @returns This writer, for chaining.
   */
  public fields(entries: readonly (readonly [string, string | null])[]): this {
    const present = entries.filter(
      (entry): entry is readonly [string, string] => entry[1] !== null,
    );
    const width = present.reduce((widest, [label]) => Math.max(widest, label.length), 0);
    for (const [label, value] of present) {
      this.#lines.push(`${this.style.dim(`${label}:`.padEnd(width + 1))} ${value}`);
    }
    return this;
  }

  /**
   * Appends a left-aligned table with a header row.
   *
   * Nothing is truncated: a value that does not fit the terminal wraps, which
   * is recoverable, where a silently cut identifier is not.
   *
   * @param columns - The columns, in display order.
   * @param rows - The rows. An empty list prints nothing at all, so a caller
   *   can print its own "no results" line.
   * @returns This writer, for chaining.
   */
  public table<TRow>(columns: readonly Column<TRow>[], rows: readonly TRow[]): this {
    if (rows.length === 0 || columns.length === 0) {
      return this;
    }

    const cells = rows.map((row) => columns.map((column) => column.cell(row)));
    const widths = columns.map((column, index) =>
      cells.reduce(
        (widest, row) => Math.max(widest, visibleWidth(row[index] ?? '')),
        visibleWidth(column.header),
      ),
    );

    const pad = (text: string, index: number): string =>
      text + ' '.repeat(Math.max(0, (widths[index] ?? 0) - visibleWidth(text)));

    this.#lines.push(
      columns
        .map((column, index) => this.style.dim(pad(column.header, index)))
        .join('  ')
        .trimEnd(),
    );
    for (const row of cells) {
      this.#lines.push(row.map(pad).join('  ').trimEnd());
    }
    return this;
  }

  /** Whether anything has been written. */
  public get isEmpty(): boolean {
    return this.#lines.length === 0;
  }

  /**
   * The accumulated rendering.
   *
   * @returns Every line joined by newlines, with a trailing newline, or the
   *   empty string if nothing was written.
   */
  public toText(): string {
    if (this.#lines.length === 0) {
      return '';
    }
    return `${this.#lines.join('\n')}\n`;
  }
}
