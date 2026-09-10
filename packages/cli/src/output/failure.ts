/**
 * Where a failure is written, and in what shape.
 *
 * ## One rule, applied to failures too
 *
 * The result of the command goes to stdout; everything else goes to stderr. A
 * failure is the result of the command when a machine is reading, and
 * commentary on it when a human is. So:
 *
 * | Mode     | stdout                        | stderr                     |
 * |----------|-------------------------------|----------------------------|
 * | `--json` | the error envelope, one line  | nothing (unless --verbose) |
 * | human    | *nothing at all*              | the rendered error         |
 *
 * The consequence that matters: **a `--json` consumer branches on failure
 * exactly as reliably as on success.** It reads one stream, parses one line,
 * and looks for the `error` key — the same envelope the server sends over HTTP
 * and over the WebSocket, so a harness needs one error handler and not two. It
 * is never asked to scrape a human sentence out of stderr, and stdout never
 * carries a half-written success followed by prose.
 *
 * The envelope is not duplicated onto stderr in JSON mode. A harness that
 * merges the two descriptors would otherwise see every failure twice, and the
 * exit code plus the envelope is already the whole story.
 *
 * ## The shape
 *
 * ```json
 * {"error":{"code":"NO_PROJECT","message":"…","hint":"Run `agentchat project init <slug>` here, or pass --project."}}
 * ```
 *
 * `error.code` and `error.message` are exactly `ErrorEnvelopeSchema` from
 * `@stackgrid/protocol`, so this parses with the same schema as a server
 * failure. `hint` is the one addition, and it is additive by design: a consumer
 * that ignores it is unaffected, and the protocol's envelope schema drops
 * unknown siblings rather than rejecting them (plan §12.4).
 *
 * @module
 */

import type { Failure } from '../errors.js';
import { causeChain } from '../errors.js';
import type { Logger } from './log.js';
import type { Output, View } from './output.js';
import { view } from './output.js';
import { HumanWriter } from './writer.js';

/**
 * The rendering of a failure, in both representations.
 *
 * @param failure - What went wrong.
 * @returns A view whose JSON is the error envelope and whose human rendering is
 *   the three-line report. One definition, so the two can never drift.
 */
export function failureView(failure: Failure): View {
  const error: Record<string, string> = {
    code: failure.code,
    message: failure.message,
  };
  if (failure.hint !== null) {
    error['hint'] = failure.hint;
  }

  return view({ error }, (writer) => {
    writer.line(`${writer.style.red('error:')} ${failure.message}`);
    writer.line(`  ${writer.style.dim('code:')} ${failure.code}`);
    if (failure.hint !== null) {
      writer.line(`  ${writer.style.dim('next:')} ${failure.hint}`);
    }
  });
}

/**
 * Writes a failure to whichever stream the mode calls for.
 *
 * @param failure - What went wrong.
 * @param output - stdout, already in the mode the invocation asked for.
 * @param logger - stderr.
 * @returns A promise that resolves once the report has been flushed. Rejects
 *   only if stdout itself is broken, which `main.ts` treats as a silent exit.
 */
export async function reportFailure(
  failure: Failure,
  output: Output,
  logger: Logger,
): Promise<void> {
  if (logger.isVerbose) {
    for (const line of causeChain(failure.cause)) {
      logger.debug(line);
    }
  }

  const report = failureView(failure);

  if (output.isJson) {
    await output.emit(report);
    return;
  }

  // Rendered here rather than through `output`, because in human mode a
  // failure is not a result and stdout must stay empty.
  const writer = new HumanWriter(logger.palette);
  report.render(writer);
  logger.raw(writer.toText().trimEnd());
}
