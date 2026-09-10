/**
 * The exit-code contract (plan §6.2).
 *
 * ```text
 * 0  success
 * 1  generic failure
 * 2  usage error
 * 3  authentication required
 * 4  no project or agent context
 * ```
 *
 * These five are a public interface. A shell script, a Makefile, and an agent
 * harness all branch on them, and none of them can read a message. Adding a
 * code is a minor change; changing what one of these means is breaking, exactly
 * as it is for the error codes in `@stackgrid/protocol`.
 *
 * The codes above 1 exist because each one has a *different remedy that can be
 * automated*. A harness seeing 3 re-runs `agentchat login`; seeing 4 it writes
 * a project configuration; seeing 2 it fixes its own invocation and does not
 * retry; seeing 1 it may retry. That is the test a new exit code has to pass,
 * and it is why the mapping below leaves so many error codes on 1.
 *
 * @module
 */

import { ErrorCode } from '@stackgrid/protocol';

/** The exit codes this CLI may return. */
export const ExitCode = Object.freeze({
  /** The command did what was asked. */
  OK: 0,

  /** Something went wrong that none of the codes below describes. */
  FAILURE: 1,

  /**
   * The invocation was wrong: an unknown command or flag, a missing argument,
   * a value that could not be a valid identifier. Retrying it unchanged cannot
   * help.
   */
  USAGE: 2,

  /**
   * Nobody is logged in, or the stored credentials are no longer good. The
   * remedy is `agentchat login`.
   */
  AUTH_REQUIRED: 3,

  /**
   * No project or no agent could be resolved. The remedy is
   * `agentchat project init` or `agentchat agent use`, or the corresponding
   * flag or environment variable.
   */
  NO_CONTEXT: 4,
} as const);

/** The union of every value in {@link ExitCode}. */
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * The exit code for a stable error code.
 *
 * Exhaustive by construction: the `switch` has no `default`, so adding a code
 * to the frozen set in `@stackgrid/protocol` and forgetting it here is a
 * compile error rather than a silent 1.
 *
 * Four mappings are worth their own note.
 *
 * `SERVER_UNREACHABLE` is `1`, and the temptation to give it a code of its own
 * is worth answering rather than ignoring. It is genuinely the most retryable
 * failure the CLI has — but exit `1` already means "may retry", and the test
 * above is a *different* remedy that can be automated, not a different cause.
 * A harness has nothing to do about an unreachable server that it would not do
 * about any other transient failure, and the cause it might want to log is in
 * `error.code`, which T-017 added precisely so that the distinction did not
 * have to be smuggled through a channel one byte wide.
 *
 * `RATE_LIMITED` is `1`, and it is the closest call in this table, because its
 * remedy genuinely *is* automatable and genuinely *is* different: sleep for
 * `Retry-After`, then send the identical request. What defeats it is the
 * channel. An exit code is one small integer and cannot carry the interval,
 * which is the only part of that remedy a harness needs; a harness that read a
 * dedicated exit code would still have to go back to the JSON for the number,
 * and once it is reading the JSON it can read `code` there — which is the
 * stable string, and where T-017 settled that this kind of distinction belongs.
 * Exit `1` already licenses the retry.
 *
 * `BAD_REQUEST` is a *usage* error, not a generic one. It reaches here either
 * because the client validated an argument the user supplied and rejected it,
 * or because the server did — and in both cases the caller passed something
 * wrong and retrying it unchanged will fail identically. That is what 2 means.
 *
 * `AGENT_NOT_IN_PROJECT` is deliberately **not** 4. It is tempting, since the
 * remedy is `agentchat agent join`, but plan §6.2 defines 4 as "no
 * project/agent context" and the protocol documents exit 4 against `NO_PROJECT`
 * and `NO_AGENT` only. Widening a published exit code is a contract change and
 * belongs in the plan first; the hint in `./errors.ts` carries the remedy in
 * the meantime.
 *
 * @param code - A known error code.
 * @returns The exit code to leave the process with.
 */
export function exitCodeForErrorCode(code: ErrorCode): ExitCode {
  switch (code) {
    // The caller sent something invalid, whoever noticed first.
    case ErrorCode.BAD_REQUEST:
      return ExitCode.USAGE;

    // Every route back to "log in again".
    case ErrorCode.AUTH_REQUIRED:
    case ErrorCode.AUTH_PENDING:
    case ErrorCode.DEVICE_CODE_EXPIRED:
      return ExitCode.AUTH_REQUIRED;

    // The two codes plan §6.1 raises locally when context cannot be resolved.
    case ErrorCode.NO_PROJECT:
    case ErrorCode.NO_AGENT:
      return ExitCode.NO_CONTEXT;

    case ErrorCode.FORBIDDEN:
    case ErrorCode.NOT_FOUND:
    case ErrorCode.CONFLICT:
    case ErrorCode.PAYLOAD_TOO_LARGE:
    case ErrorCode.UPGRADE_REQUIRED:
    case ErrorCode.INVITE_INVALID:
    case ErrorCode.AGENT_DELETED:
    case ErrorCode.AGENT_NOT_IN_PROJECT:
    case ErrorCode.SESSION_INVALID:
    case ErrorCode.PROTOCOL_VIOLATION:
    case ErrorCode.INTERNAL:
    case ErrorCode.SERVER_UNREACHABLE:
    case ErrorCode.RATE_LIMITED:
      return ExitCode.FAILURE;
  }
}
