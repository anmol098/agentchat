/**
 * Turning any thrown value into something both a human and a harness can act
 * on.
 *
 * ## No new vocabulary
 *
 * `@agentchat/protocol` owns the frozen error codes and `@agentchat/client`
 * throws `ProtocolError` subclasses carrying them. This module mints no codes
 * of its own — the set is frozen, and a code the CLI invented would be one
 * neither the server nor a third-party embedder could ever produce. What it
 * adds is the third thing a user needs, which a code and a message together
 * still do not give them: **the next step**.
 *
 * ```text
 * error: No project is configured for this directory.
 *   code: NO_PROJECT
 *   next: Run `agentchat project init <slug>` here, or pass --project.
 * ```
 *
 * A stack trace is never printed. It says nothing to the person who typed the
 * command and it buries the one line that would have helped. `--verbose` prints
 * the cause chain to stderr for the case where the reader is a developer.
 *
 * ## Codes newer than this build
 *
 * A newer server may answer with a code this CLI has never heard of. T-202 made
 * that survivable: `ApiError.code` is always a code this build knows, derived
 * from the HTTP status when necessary, while `ApiError.wireCode` is the string
 * exactly as it arrived. So {@link describeFailure} reports `wireCode` in
 * `--json` — a consumer branching on the stable string sees what the server
 * actually said — and derives the exit code from the known `code`, which is the
 * one this process is able to reason about.
 *
 * ## One class still has no code of its own
 *
 * `TransportError` and `ResponseFormatError` used to share `INTERNAL` and be
 * told apart **by class**, which is invisible to the `--json` consumer this
 * module exists to serve. T-017 split the half that mattered: an unreachable
 * server now carries `SERVER_UNREACHABLE`, and its hint comes from
 * {@link HINTS} like every other code's.
 *
 * `ResponseFormatError` keeps `INTERNAL` and keeps its class check here, and
 * that is not the same overloading. The server *did* answer; it answered in
 * violation of its own contract, which is a server-side fault and what
 * `INTERNAL` means. A caller does what it does with any `INTERNAL` — report it,
 * do not hammer the request — so no code would earn its place. The only thing
 * lost by not having one is a sharper hint, and a hint is not something a
 * consumer branches on, so a class check is exactly the right weight for it.
 *
 * @module
 */

import { ResponseFormatError } from '@agentchat/client';
import type { WireErrorCode } from '@agentchat/protocol';
import { ErrorCode, ProtocolError } from '@agentchat/protocol';

import type { ExitCode } from './exit.js';
import { exitCodeForErrorCode } from './exit.js';

/** Options accepted by {@link CliError}. */
export interface CliErrorOptions extends ErrorOptions {
  /**
   * The next step, as an imperative sentence naming a command where one exists:
   * "Run `agentchat login`." Overrides the generic hint for the code.
   */
  readonly hint?: string;
}

/**
 * A failure raised by the CLI itself, with the remedy attached.
 *
 * Commands throw this rather than a bare `Error` so that the code, the message,
 * and the next step travel together and are rendered identically to a failure
 * the server reported.
 */
export class CliError extends ProtocolError {
  /** The next step, or `undefined` to fall back to the generic hint. */
  public readonly hint: string | undefined;

  /**
   * @param code - A code from the frozen set that describes this failure.
   * @param message - What went wrong, in a sentence, with no credentials in it.
   * @param options - Standard error options plus an optional `hint`.
   */
  public constructor(code: ErrorCode, message: string, options?: CliErrorOptions) {
    super(code, message, options);
    this.name = 'CliError';
    this.hint = options?.hint;
  }
}

/**
 * The invocation was wrong: an unknown command or flag, a missing argument, an
 * argument that cannot be what it claims to be.
 *
 * Carries `BAD_REQUEST`, which is the frozen set's code for "the request was
 * malformed" and which {@link exitCodeForErrorCode} maps to exit 2.
 */
export class UsageError extends CliError {
  /**
   * @param message - What was wrong with the invocation.
   * @param options - Standard error options plus an optional `hint`. Prefer a
   *   hint naming the specific `--help` that would have prevented this.
   */
  public constructor(message: string, options?: CliErrorOptions) {
    super(ErrorCode.BAD_REQUEST, message, options);
    this.name = 'UsageError';
  }
}

/**
 * The generic next step for each known code.
 *
 * A specific hint on the thrown error always wins; these are the fallback for
 * a failure that arrived from the server with nothing but a code. Every entry
 * names a command or a concrete action, because "an error occurred" plus
 * "try again" is two sentences that say nothing.
 */
const HINTS: Readonly<Record<ErrorCode, string>> = Object.freeze({
  [ErrorCode.BAD_REQUEST]: 'Check the arguments; `agentchat <command> --help` lists them.',
  [ErrorCode.AUTH_REQUIRED]: 'Run `agentchat login`.',
  [ErrorCode.AUTH_PENDING]:
    'Approve the sign-in in your browser, then run `agentchat login` again.',
  [ErrorCode.DEVICE_CODE_EXPIRED]: 'The sign-in code expired. Run `agentchat login` again.',
  [ErrorCode.FORBIDDEN]: 'Check you are a member of this project with `agentchat project list`.',
  [ErrorCode.NOT_FOUND]:
    'Check the name or identifier you passed; `agentchat status` shows the resolved context.',
  [ErrorCode.CONFLICT]: 'Something with that name already exists. Choose another.',
  [ErrorCode.PAYLOAD_TOO_LARGE]:
    'Message content is limited to 1 MiB. Send a shorter message, or a link to the content.',
  [ErrorCode.UPGRADE_REQUIRED]:
    'This server requires a newer `agentchat`. Update the CLI and run the command again.',
  [ErrorCode.INVITE_INVALID]: 'Ask whoever invited you for a fresh invite code.',
  [ErrorCode.AGENT_DELETED]:
    'That agent was deleted. Run `agentchat agent list` and use a current one.',
  [ErrorCode.AGENT_NOT_IN_PROJECT]: 'Run `agentchat agent join <name>` to add it to this project.',
  // The only hint in this table that says "the same command, later". Nothing
  // was wrong with the request, so there is nothing to change before retrying;
  // the wait is the whole remedy, and the `Retry-After` header on the response
  // says how long when the server or an intermediary sent one.
  [ErrorCode.RATE_LIMITED]:
    'Wait for the interval the server asked for, then run the same command again.',
  [ErrorCode.SESSION_INVALID]: 'Restart `agentchat listen` to register a new session.',
  [ErrorCode.PROTOCOL_VIOLATION]:
    'Restart `agentchat listen`. If it recurs, the client and server versions disagree.',
  [ErrorCode.INTERNAL]:
    'Try again. If it persists, the server operator has the details in its log.',
  // Deliberately different advice from INTERNAL, which is the reason the code
  // was split out: nobody has looked at this request yet, and the fault may be
  // on this side of the wire, so the first thing to check is local.
  [ErrorCode.SERVER_UNREACHABLE]:
    'Check the server URL and your network connection. `agentchat status` reports reachability.',
  [ErrorCode.NO_PROJECT]:
    'Run `agentchat project init <slug>` in this repository, or pass --project.',
  [ErrorCode.NO_AGENT]: 'Run `agentchat agent use <name>`, or pass --agent.',
});

/** Everything the renderers need to report one failure. */
export interface Failure {
  /**
   * The code to show and to put in `--json`, exactly as it arrived. May be a
   * code this build does not know; see the module note.
   */
  readonly code: WireErrorCode;

  /** The code this build reasoned about, and derived {@link Failure.exit} from. */
  readonly knownCode: ErrorCode;

  /** What went wrong, for a human. Never branched on. */
  readonly message: string;

  /** The next step, or `null` when there is genuinely nothing to suggest. */
  readonly hint: string | null;

  /** The process exit code. */
  readonly exit: ExitCode;

  /** The original thrown value, for `--verbose` and for tests. */
  readonly cause: unknown;
}

/** The message shown when something threw that was not a `ProtocolError`. */
const UNEXPECTED = 'An unexpected internal error occurred.';

/**
 * Describes any thrown value as a {@link Failure}.
 *
 * Total: it never throws and never returns nothing, because it is the last
 * thing between a bug and the user's terminal.
 *
 * @param error - Whatever `run()` caught. Usually a `ProtocolError`, possibly a
 *   `TypeError` from a bug in this CLI, conceivably a thrown string.
 * @returns How to report it.
 */
export function describeFailure(error: unknown): Failure {
  if (!(error instanceof ProtocolError)) {
    return {
      code: ErrorCode.INTERNAL,
      knownCode: ErrorCode.INTERNAL,
      message: UNEXPECTED,
      hint: 'This is a bug in `agentchat`. Re-run with --verbose for the details.',
      exit: exitCodeForErrorCode(ErrorCode.INTERNAL),
      cause: error,
    };
  }

  return {
    code: wireCodeOf(error),
    knownCode: error.code,
    message: error.message,
    hint: hintFor(error),
    exit: exitCodeForErrorCode(error.code),
    cause: error,
  };
}

/**
 * The code as it arrived on the wire, where that differs from the known one.
 *
 * @param error - The failure.
 * @returns `ApiError.wireCode` for a server failure, otherwise the known code.
 */
function wireCodeOf(error: ProtocolError): WireErrorCode {
  // Structural rather than `instanceof ApiError`: `wireCode` is the contract,
  // and a future error class that also carries one should be treated the same.
  if ('wireCode' in error && typeof (error as { wireCode?: unknown }).wireCode === 'string') {
    return (error as { wireCode: string }).wireCode;
  }
  return error.code;
}

/**
 * The next step for one failure.
 *
 * Order: the hint the thrower attached, then the one class whose code does not
 * describe it (see the module note), then the table.
 *
 * @param error - The failure.
 * @returns The hint, or `null` if none applies.
 */
function hintFor(error: ProtocolError): string | null {
  if (error instanceof CliError && error.hint !== undefined) {
    return error.hint;
  }
  if (error instanceof ResponseFormatError) {
    return 'The server answered in a shape this version does not understand. Update `agentchat`.';
  }
  return HINTS[error.code];
}

/**
 * The chain of `cause` messages under an error, outermost first.
 *
 * Printed only under `--verbose`. Messages, never stacks: a stack trace is
 * noise to everyone who did not write this file, and the causes are what
 * actually say where the failure came from.
 *
 * @param error - The thrown value.
 * @returns One line per link in the chain.
 */
export function causeChain(error: unknown): readonly string[] {
  const lines: string[] = [];
  let current: unknown = error;
  // A cycle in a `cause` chain would otherwise loop forever.
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) {
      lines.push(`${current.name}: ${current.message}`);
      current = current.cause;
      continue;
    }
    lines.push(String(current));
    break;
  }
  return lines;
}
