/**
 * The output layer: two streams, two representations, one rule.
 *
 * `./output.ts` is the door to stdout and the place PRD §39 is enforced;
 * `./log.ts` is the door to stderr; `./failure.ts` decides which of the two a
 * failure goes through; `./writer.ts` and `./colour.ts` are how human output is
 * built and decorated; `./streams.ts` is the seam that makes all of it
 * testable without a subprocess.
 *
 * @module
 */

export type { ColourDecision, Palette, Style } from './colour.js';
export { ANSI_PALETTE, colourEnabled, paletteFor, PLAIN_PALETTE } from './colour.js';
export { failureView, reportFailure } from './failure.js';
export type { LoggerOptions, LogLevel } from './log.js';
export { LOG_PREFIX, Logger } from './log.js';
export type { JsonValue, OutputMode, OutputOptions, View } from './output.js';
export { Output, view } from './output.js';
export type { CliEnvironment, OutputStream } from './streams.js';
export { isBrokenPipe, StreamSink } from './streams.js';
export type { Column } from './writer.js';
export { HumanWriter, visibleWidth } from './writer.js';
