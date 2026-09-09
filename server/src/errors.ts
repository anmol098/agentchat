/**
 * The server's side of the frozen error contract.
 *
 * Every failure that leaves this process as an HTTP response passes through
 * {@link toErrorResponse}, which turns an arbitrary thrown value into a status
 * code and an {@link ErrorEnvelope} whose `code` is a member of
 * `packages/protocol`'s frozen {@link ErrorCode} set.
 *
 * ## Why this module exists
 *
 * `app.ts` used to write its codes as string literals, because the server had
 * no dependency on `@agentchat/protocol` and so could not import them. They
 * drifted: the 500 handler emitted `INTERNAL_ERROR`, a code the contract does
 * not contain and no client can branch on (T-015). Literals cannot be checked
 * by anything; imported members can, and are.
 *
 * ## Three layers, deliberately
 *
 * 1. **Compile time.** Nothing here returns a `string`. Every code is an
 *    {@link ErrorCode}, and `errorEnvelope` only accepts one, so a typo does
 *    not compile.
 * 2. **Exhaustiveness.** {@link HTTP_STATUS_BY_ERROR_CODE} is a total
 *    `Record<ErrorCode, number>`. A code added to the contract fails this
 *    build until somebody decides what status it carries, rather than
 *    silently defaulting.
 * 3. **Run time.** {@link assertContractCode} re-checks the code against
 *    `ErrorCodeSchema` — the contract's own strict outbound schema — on the
 *    way out. Types are erased; a cast, a widened generic or a value crossing
 *    a boundary unparsed can still put an off-contract string here. That is a
 *    server bug, and it is reported as one rather than shipped to a client.
 *
 * ## For route authors
 *
 * Throw a `ProtocolError` carrying the code the caller should branch on. The
 * status comes from {@link HTTP_STATUS_BY_ERROR_CODE}; do not set one by hand
 * and do not build an envelope in a handler. Never construct an error code as
 * a string literal — import it from `@agentchat/protocol`.
 *
 * `GET /healthz` is outside all of this on purpose; see the note on
 * `DATABASE_UNAVAILABLE` in `./routes/health.js`.
 *
 * @module
 */

import {
  ErrorCode,
  ErrorCodeSchema,
  type ErrorEnvelope,
  errorEnvelope,
  ProtocolError,
} from '@agentchat/protocol';

/**
 * The message sent for every 5xx.
 *
 * Deliberately uninformative. A stack trace or a driver message tells an
 * attacker about the deployment and tells a legitimate caller nothing they can
 * act on; the request id in the response header links the two views.
 */
export const INTERNAL_ERROR_MESSAGE = 'The server failed to handle this request.';

/** Message used when the underlying error carries none of its own. */
const UNDESCRIBED_REQUEST_MESSAGE = 'The request could not be processed.';

/** A status code below this is not a failure at all. */
const CLIENT_ERROR_FLOOR = 400;

/** The highest status code HTTP defines. */
const HTTP_STATUS_CEILING = 599;

/**
 * Failures at or above this status are the server's own.
 *
 * Exported because `app.ts` decides at which level to log by the same
 * threshold, and two copies of a boundary is one copy too many.
 */
export const SERVER_ERROR_FLOOR = 500;

/**
 * The HTTP status each contract code is reported with.
 *
 * The values come from the per-code documentation in
 * `packages/protocol/src/errors.ts`, which states the intended mapping; this
 * is that prose made executable. Total over {@link ErrorCode} on purpose: a
 * code added to the frozen set stops this project compiling until somebody
 * chooses its status, which is the moment to think about it.
 *
 * Five codes have no HTTP status of their own and map to 500:
 * `SESSION_INVALID` and `PROTOCOL_VIOLATION` close a WebSocket rather than
 * answering a request, and `NO_PROJECT`, `NO_AGENT` and `SERVER_UNREACHABLE`
 * are raised by the client without a server having answered. An HTTP route
 * raising one of those is a server bug, and 500 is what a server bug is.
 *
 * `SERVER_UNREACHABLE` is the sharpest of the five: it means no response was
 * produced at all, so a server that manages to *send* it has contradicted the
 * code it is sending. The entry exists to keep this record total, not because
 * any status is right for it.
 */
export const HTTP_STATUS_BY_ERROR_CODE: Readonly<Record<ErrorCode, number>> = Object.freeze({
  [ErrorCode.BAD_REQUEST]: 400,
  [ErrorCode.AUTH_REQUIRED]: 401,
  [ErrorCode.AUTH_PENDING]: 428,
  [ErrorCode.DEVICE_CODE_EXPIRED]: 400,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.PAYLOAD_TOO_LARGE]: 413,
  [ErrorCode.UPGRADE_REQUIRED]: 426,
  [ErrorCode.INVITE_INVALID]: 404,
  [ErrorCode.AGENT_DELETED]: 410,
  [ErrorCode.AGENT_NOT_IN_PROJECT]: 403,
  [ErrorCode.SESSION_INVALID]: 500,
  [ErrorCode.PROTOCOL_VIOLATION]: 500,
  [ErrorCode.INTERNAL]: 500,
  [ErrorCode.SERVER_UNREACHABLE]: 500,
  [ErrorCode.NO_PROJECT]: 500,
  [ErrorCode.NO_AGENT]: 500,
});

/**
 * Fastify's own error codes, translated into the contract.
 *
 * Fastify rejects a request before any handler runs — a body over the limit, a
 * content type nothing can parse, a URL that will not decode — and attaches its
 * own `FST_ERR_*` string. Passing that string through would put a framework
 * internal where the contract promises a stable code: a client branching on
 * `PAYLOAD_TOO_LARGE` would instead receive `FST_ERR_CTP_BODY_TOO_LARGE`, which
 * appears nowhere in `packages/protocol` and changes when Fastify says so.
 *
 * Only request-time errors are listed. Several `FST_ERR_*` values carry a 4xx
 * status but are raised while routes are being registered
 * (`FST_ERR_ROUTE_MISSING_CONTENT_TYPE`, `FST_ERR_CTP_INSTANCE_ALREADY_STARTED`
 * and friends); those never reach a request, and inventing a caller-facing
 * meaning for them would be fiction. Anything absent falls back by status —
 * see {@link toErrorResponse} — so an unlisted or newly-added Fastify code is
 * still answered from the frozen set.
 *
 * The size limit is the one distinction worth drawing precisely: an oversized
 * body is not a generic bad request when the contract has a code for exactly
 * that, and the CLI's remedy for it (send less) is different from its remedy
 * for a malformed one.
 */
export const ERROR_CODE_BY_FASTIFY_CODE: Readonly<Record<string, ErrorCode>> = Object.freeze({
  // 413. The body exceeded `bodyLimit`; the contract has a code for this.
  FST_ERR_CTP_BODY_TOO_LARGE: ErrorCode.PAYLOAD_TOO_LARGE,

  // 415. No parser is registered for the caller's content type. Coarse code,
  // precise message: `packages/protocol` prefers that over minting a new code
  // nobody would take a different action on.
  FST_ERR_CTP_INVALID_MEDIA_TYPE: ErrorCode.BAD_REQUEST,

  // 400. The body did not arrive in the shape its content type promised.
  FST_ERR_CTP_EMPTY_JSON_BODY: ErrorCode.BAD_REQUEST,
  FST_ERR_CTP_INVALID_JSON_BODY: ErrorCode.BAD_REQUEST,
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: ErrorCode.BAD_REQUEST,

  // 400. Schema validation failed. Route schemas are zod rather than Fastify's
  // own, but a plugin or a future `schema` option raises this.
  FST_ERR_VALIDATION: ErrorCode.BAD_REQUEST,

  // 400/414. The request line itself is unusable: undecodable, or a parameter
  // longer than the router will accept.
  FST_ERR_BAD_URL: ErrorCode.BAD_REQUEST,
  FST_ERR_INVALID_URL: ErrorCode.BAD_REQUEST,
  FST_ERR_MAX_PARAM_LENGTH: ErrorCode.BAD_REQUEST,

  // 404. Reached only if something bypasses the not-found handler in `app.ts`.
  FST_ERR_NOT_FOUND: ErrorCode.NOT_FOUND,
});

/**
 * The contract code used for a 4xx that identified itself only by status.
 *
 * A handler that throws `Object.assign(new Error(...), { statusCode: 403 })`,
 * or any `http-errors`-style object a plugin produces, says what it means
 * through the status and nothing else. These are the inverse of the documented
 * status for each code; statuses with no obvious inverse — 410 and 428 mean
 * `AGENT_DELETED` and `AUTH_PENDING`, which are far too specific to guess —
 * are left out and fall through to `BAD_REQUEST`.
 */
const ERROR_CODE_BY_STATUS: ReadonlyMap<number, ErrorCode> = new Map<number, ErrorCode>([
  [400, ErrorCode.BAD_REQUEST],
  [401, ErrorCode.AUTH_REQUIRED],
  [403, ErrorCode.FORBIDDEN],
  [404, ErrorCode.NOT_FOUND],
  [409, ErrorCode.CONFLICT],
  [413, ErrorCode.PAYLOAD_TOO_LARGE],
  [426, ErrorCode.UPGRADE_REQUIRED],
]);

/** A status and a body, ready to be sent. */
export interface ErrorResponse {
  /** HTTP status for the response. */
  readonly statusCode: number;
  /** The protocol error envelope. */
  readonly body: ErrorEnvelope;
}

/**
 * The properties this module reads off a thrown value.
 *
 * Anything can be thrown, so nothing is assumed: each field is `unknown` and
 * narrowed before use rather than trusted from a cast.
 */
interface ErrorLike {
  readonly statusCode?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
}

/** Views a thrown value as a bag of unknown properties. */
function asErrorLike(value: unknown): ErrorLike {
  return typeof value === 'object' && value !== null ? (value as ErrorLike) : {};
}

/**
 * The outbound gate: the last point at which an off-contract code can be
 * caught rather than shipped.
 *
 * `ErrorCodeSchema` is the frozen set expressed as a schema, and
 * `packages/protocol` documents it as the *outbound* assertion for exactly
 * this use. It is not redundant with the types: `ErrorCode` is erased at run
 * time, so a cast, an `as`, a value deserialised from somewhere, or a code
 * that stops being a member after a contract change all reach here typed
 * correctly and wrong.
 *
 * Failure is a server bug rather than a caller's, so it becomes
 * {@link ErrorCode.INTERNAL} — the drift is reported to the operator through
 * the log and never to the client. This is what makes `INTERNAL_ERROR`, the
 * literal this module was written to remove, unable to reach a client again
 * even if somebody reintroduces it.
 *
 * @param candidate - Any value; typically a code that is already typed as an
 *   {@link ErrorCode} and is being checked anyway.
 * @returns `candidate` when it is a member of the frozen set, and
 *   {@link ErrorCode.INTERNAL} otherwise. Never throws.
 */
export function assertContractCode(candidate: unknown): ErrorCode {
  const parsed = ErrorCodeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : ErrorCode.INTERNAL;
}

/**
 * The status the thrower asked for, if it asked for a usable one.
 *
 * Fastify's own errors and any `http-errors`-style object carry a `statusCode`.
 * It is trusted only as far as being a plausible failure status: `200`, `0`,
 * `NaN` and `"oops"` all mean the thrower did not set one, which is reported as
 * `undefined` here and resolved from the contract instead.
 */
function requestedStatusOf(error: unknown): number | undefined {
  const candidate = asErrorLike(error).statusCode;
  if (typeof candidate !== 'number' || !Number.isInteger(candidate)) {
    return undefined;
  }

  return candidate >= CLIENT_ERROR_FLOOR && candidate <= HTTP_STATUS_CEILING
    ? candidate
    : undefined;
}

/**
 * The contract code for a thrown value, before it is checked.
 *
 * Tried in order: the code a `ProtocolError` states, Fastify's own code
 * translated through {@link ERROR_CODE_BY_FASTIFY_CODE}, then the status. The
 * last of those falls back to `BAD_REQUEST` — the correct thing to say about a
 * 4xx that nobody described further, and, the point of the fallback, a member
 * of the frozen set, so an unrecognised framework code becomes a contract code
 * rather than travelling as itself.
 *
 * A failure that named neither a known code nor a client-error status is the
 * server's own, whatever else it carries.
 *
 * The `ErrorCode` return type is a promise the compiler makes and run time does
 * not keep: `error.code` on a `ProtocolError` is only as good as whoever
 * constructed it. {@link toErrorResponse} passes the result through
 * {@link assertContractCode} before anything is sent.
 */
function contractCodeOf(error: unknown, requestedStatus: number | undefined): ErrorCode {
  if (error instanceof ProtocolError) {
    return error.code;
  }

  const raw = asErrorLike(error).code;
  if (typeof raw === 'string') {
    const mapped: ErrorCode | undefined = ERROR_CODE_BY_FASTIFY_CODE[raw];
    if (mapped !== undefined) {
      return mapped;
    }
  }

  if (requestedStatus === undefined || requestedStatus >= SERVER_ERROR_FLOOR) {
    return ErrorCode.INTERNAL;
  }

  return ERROR_CODE_BY_STATUS.get(requestedStatus) ?? ErrorCode.BAD_REQUEST;
}

/**
 * The human-readable half of the envelope.
 *
 * 4xx are the caller's own fault and describing them is the point: an
 * oversized body, an unsupported media type, a malformed parameter. Fastify's
 * messages for those are already caller-facing. `message` is documented as
 * unstable and must never be branched on, which is why the code beside it is
 * chosen so carefully.
 */
function messageOf(error: unknown): string {
  const message = asErrorLike(error).message;
  return typeof message === 'string' && message !== '' ? message : UNDESCRIBED_REQUEST_MESSAGE;
}

/**
 * Converts any thrown value into the response the client receives.
 *
 * Total: every input produces an envelope whose `code` is a member of the
 * frozen {@link ErrorCode} set, including inputs that are not errors at all.
 *
 * @param error - Whatever was thrown or passed to Fastify's error handler.
 * @returns The status and envelope to send. Never throws.
 */
export function toErrorResponse(error: unknown): ErrorResponse {
  const requestedStatus = requestedStatusOf(error);

  // The gate, and the only place a code is decided. Anything outside the frozen
  // set becomes `INTERNAL`, which resolves to a 500 below: a server bug
  // reported as a server bug, rather than a string no client can find in the
  // contract shipped to that client.
  const code = assertContractCode(contractCodeOf(error, requestedStatus));

  // The thrower's status when it named a usable one, and otherwise the status
  // the contract documents for this code. Every `ErrorCode` has one, so the
  // second branch is a lookup rather than a guess.
  const statusCode = requestedStatus ?? HTTP_STATUS_BY_ERROR_CODE[code];

  if (statusCode >= SERVER_ERROR_FLOOR) {
    // Nothing internal crosses the wire. A stack trace or a driver message
    // tells an attacker about the deployment and tells a legitimate caller
    // nothing they can act on; the request id links the two views.
    return {
      statusCode,
      body: errorEnvelope(ErrorCode.INTERNAL, INTERNAL_ERROR_MESSAGE),
    };
  }

  return { statusCode, body: errorEnvelope(code, messageOf(error)) };
}
