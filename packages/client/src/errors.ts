/**
 * Turning a failure into something a caller can branch on.
 *
 * ## One taxonomy, not two
 *
 * `packages/protocol` already owns the frozen {@link ErrorCode} set and
 * {@link ProtocolError}. This module does not mint a second vocabulary; every
 * error it throws **is** a `ProtocolError`, so a consumer that already knows how
 * to render `AUTH_REQUIRED` from the server renders it identically when the
 * client raises it locally. The three subclasses below say *where* the failure
 * came from — the server, the network, or a response that did not match its
 * schema — as a convenience for code running in this process. They are not the
 * place to encode a distinction a caller must act on: T-017 moved the one that
 * mattered, "the server could not be reached", into the code itself, because a
 * class is invisible to the `--json` consumer on the other side of the process
 * boundary.
 *
 * ## Codes the server knows and this build does not
 *
 * Plan §12.4 makes protocol changes additive, so a newer server may answer with
 * a code that did not exist when this client was compiled. `ProtocolError.code`
 * is typed as a *known* code and cannot hold one of those without lying, so
 * {@link ApiError} keeps the string exactly as it arrived in
 * {@link ApiError.wireCode} and derives `code` from the HTTP status instead.
 * Nothing is lost: a `--json` consumer branching on the stable string reads
 * `wireCode`, and code that only knows how to handle the codes it was built with
 * still gets a sensible one.
 *
 * @module
 */

import type { WireErrorCode } from '@agentchat/protocol';
import { ErrorCode, ErrorEnvelopeSchema, isErrorCode, ProtocolError } from '@agentchat/protocol';

/**
 * The HTTP status each error code is documented to travel on, inverted.
 *
 * Taken verbatim from the TSDoc on {@link ErrorCode}; it is not a new mapping.
 * Used in two places, both of them fallbacks: a response with no parseable
 * envelope, and an envelope whose code this build does not recognise.
 *
 * Statuses whose code is ambiguous are deliberately absent. `403` maps to
 * `FORBIDDEN` rather than `AGENT_NOT_IN_PROJECT` and `404` to `NOT_FOUND` rather
 * than `INVITE_INVALID` because the coarse code is the one that is always true;
 * `410` has only `AGENT_DELETED`, which is too specific to guess from a status
 * alone, so it falls through to `INTERNAL`.
 *
 * `SERVER_UNREACHABLE` can never appear here, for a reason stronger than
 * ambiguity: there is a status to map, so a response arrived, so the server was
 * reachable.
 */
const CODE_BY_STATUS: ReadonlyMap<number, ErrorCode> = new Map<number, ErrorCode>([
  [400, ErrorCode.BAD_REQUEST],
  [401, ErrorCode.AUTH_REQUIRED],
  [403, ErrorCode.FORBIDDEN],
  [404, ErrorCode.NOT_FOUND],
  [409, ErrorCode.CONFLICT],
  [413, ErrorCode.PAYLOAD_TOO_LARGE],
  [426, ErrorCode.UPGRADE_REQUIRED],
  [428, ErrorCode.AUTH_PENDING],
  // 429 has exactly one meaning, and this is the row that matters most in a
  // real deployment: a rate-limiting proxy in front of this server answers an
  // HTML page with no envelope at all, so the status is the only thing there is
  // to read. Falling through to `INTERNAL` would tell the caller "the server
  // broke, report it" about a request the server never faulted on and is
  // willing to serve in a moment.
  [429, ErrorCode.RATE_LIMITED],
]);

/**
 * The known code that best describes an HTTP status.
 *
 * @param status - An HTTP status code.
 * @returns The documented code for that status, or {@link ErrorCode.INTERNAL}
 *   when the status has no unambiguous one.
 */
export function codeForStatus(status: number): ErrorCode {
  return CODE_BY_STATUS.get(status) ?? ErrorCode.INTERNAL;
}

/**
 * A failure the server reported: a non-2xx response, translated.
 *
 * `code` is always a code this build knows and is safe to `switch` on.
 * `wireCode` is what the server actually sent, which is the value to put in
 * `--json` output and the value to compare when a newer server may be involved.
 * For every code this build knows, the two are equal.
 */
export class ApiError extends ProtocolError {
  /** The HTTP status the server answered with. */
  public readonly status: number;

  /**
   * The code exactly as it arrived, which may be one this build has never heard
   * of. See the module note.
   */
  public readonly wireCode: WireErrorCode;

  /**
   * @param status - The HTTP status of the response.
   * @param wireCode - The code as sent by the server.
   * @param message - The server's human-readable message. Displayed, never
   *   branched on.
   * @param options - Standard error options.
   */
  public constructor(
    status: number,
    wireCode: WireErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(isErrorCode(wireCode) ? wireCode : codeForStatus(status), message, options);
    this.name = 'ApiError';
    this.status = status;
    this.wireCode = wireCode;
  }

  /** Whether {@link ApiError.wireCode} is a code this build was compiled with. */
  public get isKnownCode(): boolean {
    return isErrorCode(this.wireCode);
  }
}

/**
 * The request never produced an HTTP response: DNS failure, connection refused,
 * TLS failure, a timeout, or an aborted request.
 *
 * `code` is {@link ErrorCode.SERVER_UNREACHABLE}, which is the whole point of
 * the class: a caller that retries on a network fault must not also retry on a
 * genuine server-side `INTERNAL`, and until T-017 admitted the code that
 * distinction existed only as a JavaScript class — invisible to the `--json`
 * consumers this project is built for. The class remains, because "where did
 * this come from" is still worth asking in-process, but nothing needs to branch
 * on it any more.
 *
 * A refused connection and a timeout share the code deliberately; see its
 * documentation in `@agentchat/protocol` for why. The specific cause is in
 * `message` and in `cause`.
 */
export class TransportError extends ProtocolError {
  /**
   * @param message - What could not be reached, without credentials in it.
   * @param options - Standard error options; pass `cause` to keep the
   *   underlying `TypeError` or `AbortError` attached.
   */
  public constructor(message: string, options?: ErrorOptions) {
    super(ErrorCode.SERVER_UNREACHABLE, message, options);
    this.name = 'TransportError';
  }
}

/**
 * The server answered, but the body did not match the schema for that endpoint.
 *
 * This is never a client bug the caller can fix, and it is never silently
 * tolerated: subagent protocol §7.2 forbids trusting a response shape, so a
 * mismatch is raised rather than cast away. Under the additive-only rule an
 * older client is supposed to *drop* fields it does not know, which the schemas
 * already do — so reaching this error means a field the client requires was
 * missing or the wrong type.
 *
 * `code` stays {@link ErrorCode.INTERNAL}, and that is not the overloading
 * T-017 removed. The server did answer; it answered something that violates its
 * own contract, which is a server-side fault and exactly what `INTERNAL` means.
 * A caller does with it what it does with any `INTERNAL`: reports it rather than
 * hammering the same request.
 */
export class ResponseFormatError extends ProtocolError {
  /**
   * @param message - Which response failed and how, with no body contents in it.
   * @param options - Standard error options; pass the `ZodError` as `cause`.
   */
  public constructor(message: string, options?: ErrorOptions) {
    super(ErrorCode.INTERNAL, message, options);
    this.name = 'ResponseFormatError';
  }
}

/** Fallback message when the server sends a failure with no readable body. */
const UNEXPLAINED = 'The server reported a failure with no readable error body.';

/**
 * Translates a non-2xx response into an {@link ApiError}.
 *
 * A body matching `{ error: { code, message } }` is used as sent. Anything else
 * — an HTML error page from a proxy, an empty body, a JSON object of some other
 * shape — becomes a code derived from the status, because a client that threw a
 * parse error there would replace a legible "403 Forbidden" with an illegible
 * one.
 *
 * @param status - The HTTP status of the response.
 * @param body - The parsed response body, or `undefined` if there was none.
 * @returns The error to throw. Never throws itself.
 */
export function apiErrorFromResponse(status: number, body: unknown): ApiError {
  const envelope = ErrorEnvelopeSchema.safeParse(body);
  if (envelope.success) {
    return new ApiError(status, envelope.data.error.code, envelope.data.error.message);
  }
  return new ApiError(status, codeForStatus(status), UNEXPLAINED);
}
