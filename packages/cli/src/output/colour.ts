/**
 * Colour: when it is used, and how it disappears.
 *
 * ## The decision
 *
 * Decoration is a courtesy to a human at a terminal and a hazard to everything
 * else — an ANSI escape in a captured string breaks an equality assertion, a
 * log grep, and a JSON parser alike. So the default is "colour only when we can
 * see a terminal on the stream we are writing to", and every override points
 * one way or the other explicitly:
 *
 * 1. `--color` / `--no-color` on the command line win outright.
 * 2. `NO_COLOR` set to any non-empty value disables colour, per no-color.org.
 * 3. `FORCE_COLOR` enables it, except for the documented `FORCE_COLOR=0`.
 * 4. `TERM=dumb` disables it.
 * 5. Otherwise: colour if that stream is a TTY.
 *
 * Each stream decides for itself, because `agentchat status | less` still has a
 * human watching stderr, and `agentchat status > file` still deserves a
 * readable progress line. The one thing the rules cannot reach is `--json`
 * output, which is never coloured whatever the environment says: stdout in JSON
 * mode is a machine's input, and that is not negotiable (PRD §39).
 *
 * ## Why not a dependency
 *
 * A palette of six SGR pairs is fifteen lines. Pulling in a colour library
 * would add a dependency to the one package in this repository that strangers
 * install globally, in exchange for code shorter than its own README.
 *
 * @module
 */

/** Wraps text in one decoration, or returns it unchanged when colour is off. */
export type Style = (text: string) => string;

/**
 * The decorations this CLI uses.
 *
 * Deliberately small. Six styles is enough vocabulary for a command-line tool
 * and few enough that output stays legible on a light terminal, a dark one, and
 * a screen reader.
 */
export interface Palette {
  /** Emphasis: headings, the subject of a line. */
  readonly bold: Style;
  /** De-emphasis: labels, hints, anything a scanner should skip. */
  readonly dim: Style;
  /** Failure. */
  readonly red: Style;
  /** Warning. */
  readonly yellow: Style;
  /** Success. */
  readonly green: Style;
  /** Identifiers and commands the reader might copy. */
  readonly cyan: Style;
}

/** Text passed through untouched. */
const plain: Style = (text) => text;

/** The palette used when colour is disabled: every style is the identity. */
export const PLAIN_PALETTE: Palette = Object.freeze({
  bold: plain,
  dim: plain,
  red: plain,
  yellow: plain,
  green: plain,
  cyan: plain,
});

/**
 * Builds a style from an SGR parameter.
 *
 * @param open - The SGR parameter that turns the attribute on.
 * @param close - The SGR parameter that turns it off again.
 * @returns A style function.
 */
function sgr(open: number, close: number): Style {
  const prefix = `\u001B[${String(open)}m`;
  const suffix = `\u001B[${String(close)}m`;
  return (text) => `${prefix}${text}${suffix}`;
}

/**
 * The palette used when colour is enabled.
 *
 * Each style closes with the specific reset for its attribute rather than
 * `\u001B[0m`, so nesting `bold(red(x))` does not lose the outer decoration.
 */
export const ANSI_PALETTE: Palette = Object.freeze({
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  red: sgr(31, 39),
  yellow: sgr(33, 39),
  green: sgr(32, 39),
  cyan: sgr(36, 39),
});

/**
 * @param enabled - Whether colour is on.
 * @returns {@link ANSI_PALETTE} or {@link PLAIN_PALETTE}.
 */
export function paletteFor(enabled: boolean): Palette {
  return enabled ? ANSI_PALETTE : PLAIN_PALETTE;
}

/** Inputs to the colour decision for one stream. */
export interface ColourDecision {
  /** Whether that stream is attached to a terminal. */
  readonly isTTY: boolean;

  /** The process environment. */
  readonly env: Readonly<Record<string, string | undefined>>;

  /**
   * What `--color` or `--no-color` asked for, or `undefined` if neither was
   * given. An explicit choice overrides every environment signal.
   */
  readonly forced?: boolean | undefined;
}

/**
 * Decides whether to colour one stream.
 *
 * @param decision - The stream's TTY state, the environment, and any explicit
 *   flag.
 * @returns `true` if output on that stream may carry ANSI escapes.
 */
export function colourEnabled(decision: ColourDecision): boolean {
  if (decision.forced !== undefined) {
    return decision.forced;
  }

  const noColour = decision.env['NO_COLOR'];
  if (noColour !== undefined && noColour !== '') {
    return false;
  }

  const forceColour = decision.env['FORCE_COLOR'];
  if (forceColour !== undefined && forceColour !== '' && forceColour !== '0') {
    return true;
  }

  if (decision.env['TERM'] === 'dumb') {
    return false;
  }

  return decision.isTTY;
}
