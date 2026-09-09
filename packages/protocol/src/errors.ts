/**
 * The error contract: a frozen set of stable codes, the wire envelope that
 * carries them, and the typed error used to throw one inside a process.
 *
 * ## These codes are a public contract
 *
 * The CLI renders them, `--json` consumers branch on them, and third-party
 * harnesses embed them (`packages/` is MIT precisely so they can). Once a code
 * has shipped:
 *
 * - **Adding** a code is a minor change. Both sides must tolerate codes they do
 *   not know; see {@link ErrorEnvelopeSchema} and plan §12.4.
 * - **Removing or renaming** a code, or changing what it means, is a breaking
 *   change and requires a major version bump. There is no deprecation path
 *   short of that, because a client three versions old is still branching on
 *   the old string.
 *
 * Prefer reusing a coarse code with a precise `message` over minting a new
 * code. A new code is only justified when a caller would take a *different
 * action* on it — which is the test each code below has to pass.
 *
 * @module
 */

import { z } from 'zod';

/**
 * Every error code AgentChat may emit in machine-readable output.
 *
 * Most travel on the wire. Three, marked *Client*, are raised locally and never
 * reach a server — two before a request is made, one when the request could not
 * be delivered — but they are branched on by the same `--json` consumers, so
 * they carry the same stability guarantee and belong in the same frozen set.
 *
 * Frozen at runtime and exhaustive at compile time. The HTTP status noted on
 * each code is the intended mapping for the server; codes marked *client* are
 * produced locally by the CLI and never appear in an HTTP response.
 */
export const ErrorCode = Object.freeze({
  /**
   * The request was malformed: it failed schema validation, or a path or query
   * parameter was not a well-formed identifier. HTTP 400.
   */
  BAD_REQUEST: 'BAD_REQUEST',

  /**
   * No credentials, or credentials that are expired, revoked, or unparseable.
   * The client should refresh once and, failing that, prompt for
   * `agentchat login`. HTTP 401.
   */
  AUTH_REQUIRED: 'AUTH_REQUIRED',

  /**
   * The device authorization is still waiting on the user to approve it in the
   * browser. The client should keep polling at the advertised interval. This is
   * an expected, non-terminal state of the login flow, not a failure. HTTP 428.
   */
  AUTH_PENDING: 'AUTH_PENDING',

  /**
   * The device code has expired or was already redeemed. Polling must stop and
   * the login flow must start again. HTTP 400.
   */
  DEVICE_CODE_EXPIRED: 'DEVICE_CODE_EXPIRED',

  /**
   * The caller is authenticated but not permitted: not a member of the project,
   * not the owner of the agent, not an owner of the project for an
   * owner-only operation, or asking for messages that are neither to nor from
   * one of their own agents. HTTP 403.
   */
  FORBIDDEN: 'FORBIDDEN',

  /**
   * The resource does not exist, or exists and the caller may not be told that
   * it does. The two are deliberately indistinguishable. HTTP 404.
   */
  NOT_FOUND: 'NOT_FOUND',

  /**
   * The request collides with existing state: an agent name already taken by
   * this user, a project slug already in use, a duplicate `clientMessageId`
   * that resolved to a different message. HTTP 409.
   */
  CONFLICT: 'CONFLICT',

  /**
   * The request body exceeded a hard limit — most often message content over
   * 1 MiB of UTF-8 (plan D10). HTTP 413.
   */
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',

  /**
   * The client is older than the server's `minClientVersion`. The client should
   * print the upgrade instruction and exit rather than retrying. HTTP 426; see
   * plan §12.4.
   */
  UPGRADE_REQUIRED: 'UPGRADE_REQUIRED',

  /**
   * The invite code is unknown, revoked, expired, or has no uses left. The
   * cases are one code on purpose: none of them is recoverable by the client,
   * they all end in "ask for a fresh invite", and distinguishing them leaks
   * whether a code ever existed. HTTP 404.
   */
  INVITE_INVALID: 'INVITE_INVALID',

  /**
   * The referenced agent has been soft-deleted (plan D13). Distinct from
   * {@link ErrorCode.NOT_FOUND} because the agent demonstrably existed and the
   * caller may have a stale id cached, so the remedy is different. HTTP 410.
   */
  AGENT_DELETED: 'AGENT_DELETED',

  /**
   * The sender or recipient agent exists but is not a member of the project.
   * Distinct from {@link ErrorCode.FORBIDDEN} because it has a concrete remedy
   * the CLI can print: `agentchat agent join <name>`. HTTP 403.
   */
  AGENT_NOT_IN_PROJECT: 'AGENT_NOT_IN_PROJECT',

  /**
   * The caller is going too fast and this request was refused for that reason
   * alone. Nothing about it was wrong; the same request will succeed later.
   *
   * The remedy is unique in this set: **wait, then send the same request
   * again**, unchanged. Every other refusal asks for something else — fix the
   * request ({@link ErrorCode.BAD_REQUEST}), fix the caller's state
   * ({@link ErrorCode.CONFLICT}), get permission
   * ({@link ErrorCode.FORBIDDEN}), stop ({@link ErrorCode.DEVICE_CODE_EXPIRED},
   * {@link ErrorCode.UPGRADE_REQUIRED}) — or asks for a retry that is a guess
   * rather than an instruction ({@link ErrorCode.INTERNAL},
   * {@link ErrorCode.SERVER_UNREACHABLE}, where nobody has said the request was
   * fine or when to send it again). That is the admission test, and this is the
   * only code that answers it this way.
   *
   * ## How long to wait travels in `Retry-After`, not in this code
   *
   * The envelope carries a code and a message and nothing else, and `message`
   * is documented as unbranchable, so a client that had only this code would
   * have to guess an interval. It does not have to: the response carries
   * `Retry-After` in seconds, exactly as an {@link ErrorCode.AUTH_PENDING}
   * response already does for the device flow.
   *
   * Putting the number in the envelope instead was considered and rejected.
   * `Retry-After` is where HTTP already carries this fact, an intermediary that
   * rate-limits ahead of this server will emit it and cannot be taught to emit
   * a field of ours, and two places to read one number is one place too many.
   *
   * A client should therefore: sleep for `Retry-After` when it is present and
   * parseable, sleep for its own backoff when it is not, and then retry the
   * identical request. It must not treat this as a failure of the operation —
   * a poll loop that gives up here strands a login that would have succeeded.
   *
   * HTTP 429.
   */
  RATE_LIMITED: 'RATE_LIMITED',

  /**
   * A WebSocket `hello` named a session that is unknown, already ended, or owned
   * by somebody else. The client must register a new session before retrying;
   * reconnecting with the same id will not start working. Closes the socket.
   */
  SESSION_INVALID: 'SESSION_INVALID',

  /**
   * A frame was unparseable, or arrived out of order — most often a frame sent
   * before `hello`. Unknown frame *types* are ignored rather than reported, per
   * the additive-only rule in plan §12.4, so this means genuinely malformed
   * traffic. Closes the socket.
   */
  PROTOCOL_VIOLATION: 'PROTOCOL_VIOLATION',

  /**
   * An unhandled fault on the server. The message is deliberately generic;
   * details go to the server log, never to the client. HTTP 500.
   */
  INTERNAL: 'INTERNAL',

  /**
   * *Client.* The request never produced a response at all: DNS failure,
   * connection refused, TLS failure, a timeout, or an abort.
   *
   * Distinct from {@link ErrorCode.INTERNAL} because the two demand opposite
   * responses. An unreachable server says nothing about the request — nobody
   * has looked at it yet — so the answer is to wait and retry, and the fault
   * may well be on this side of the wire. A server that answered `INTERNAL`
   * has looked at the request and broken; retrying the same request usually
   * reproduces it, and the useful action is to report it against the
   * `x-request-id`. Reporting both as `INTERNAL` forces a `--json` consumer to
   * choose one of those behaviours for both.
   *
   * A refused connection and a timeout deliberately share this code. The
   * distinction is not reliably observable — a firewall that drops packets
   * produces a timeout and the same firewall answering `RST` produces a
   * refusal, from one misconfiguration — and the one way they genuinely differ,
   * whether the server may have received the request, still does not change
   * what the caller does: abandoning a request that may never have been sent is
   * not an option, and the send path, where a duplicate would actually matter,
   * is idempotent on `clientMessageId`. The precise cause goes in the `message`
   * and the `cause` chain, per this module's "coarse code, precise message"
   * rule.
   *
   * Never appears in an HTTP response: it means there was no response. CLI
   * exit code 1 — a network fault is not a usage error, an authentication
   * problem, or missing context, and no automated remedy distinguishes it from
   * any other retryable failure (plan §6.2).
   */
  SERVER_UNREACHABLE: 'SERVER_UNREACHABLE',

  /**
   * *Client.* No project could be resolved from `--project`, `AGENTCHAT_PROJECT`,
   * or a `.agentchat/config.json` above the working directory. CLI exit code 4
   * (plan §6.1).
   */
  NO_PROJECT: 'NO_PROJECT',

  /**
   * *Client.* No agent could be resolved from `--agent`, `AGENTCHAT_AGENT`, the
   * per-project default, or the user having exactly one agent in the project.
   * CLI exit code 4 (plan §6.1).
   */
  NO_AGENT: 'NO_AGENT',
} as const);

/**
 * The union of every value in {@link ErrorCode}.
 *
 * Use this for anything AgentChat itself produces. Values arriving off the wire
 * are typed as {@link WireErrorCode} instead, because a newer peer may send a
 * code this build has never heard of.
 */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Every known code as a frozen array, in declaration order.
 *
 * Useful for exhaustiveness tests and for documentation generators. Iteration
 * order is stable but carries no meaning; do not derive severity or HTTP status
 * from the position.
 */
export const ERROR_CODES: readonly ErrorCode[] = Object.freeze(Object.values(ErrorCode));

/**
 * An error code as it appears on the wire: a known {@link ErrorCode}, or any
 * other non-empty string.
 *
 * The widening is deliberate. Plan §12.4 makes protocol changes additive within
 * a major version, so a client talking to a newer server must be able to parse
 * an error whose code it does not recognise — refusing to would turn "a new
 * error code shipped" into "every old client crashes". Editors still complete
 * the known codes. Narrow with {@link isErrorCode} before branching.
 */
export type WireErrorCode = ErrorCode | (string & {});

/**
 * Narrows an arbitrary value to a code this build knows about.
 *
 * @param value - Any value; typically the `code` off a parsed envelope.
 * @returns `true` if `value` is one of {@link ERROR_CODES}.
 */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Strict schema accepting only the codes in {@link ErrorCode}.
 *
 * This is the *outbound* schema: use it to assert that the server never emits a
 * code outside the contract. Do not use it to parse a response, or a client will
 * reject error codes added after it was built — {@link ErrorEnvelopeSchema} is
 * the lenient inbound counterpart.
 */
export const ErrorCodeSchema = z.enum(ErrorCode);

/**
 * The error envelope every failure is reported in, over HTTP and over the
 * WebSocket alike: `{ error: { code, message } }`.
 *
 * `code` is intentionally lenient (see {@link WireErrorCode}) and `message` is
 * human-readable, may change between releases, and must never be branched on.
 * Unknown sibling properties are dropped rather than rejected, which is what
 * makes adding fields to the envelope a non-breaking change.
 */
export const ErrorEnvelopeSchema: z.ZodType<ErrorEnvelope> = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
  }),
});

/**
 * The shape {@link ErrorEnvelopeSchema} parses to.
 *
 * Written out rather than inferred so `code` keeps the known-code completions
 * that {@link WireErrorCode} provides; zod only knows it as a string.
 */
export interface ErrorEnvelope {
  /** The failure. Present on every error response; never on a success. */
  error: {
    /** Stable, branchable. Narrow with {@link isErrorCode} first. */
    code: WireErrorCode;
    /** Human-readable, unstable. Display it; never branch on it. */
    message: string;
  };
}

/**
 * Builds an error envelope.
 *
 * @param code - A code from {@link ErrorCode}. Callers inside this repository
 *   are held to known codes; the wire tolerates more (see {@link WireErrorCode}).
 * @param message - A human-readable explanation. Never include credentials,
 *   tokens, SQL, or stack traces: this string is shown to users and logged by
 *   harnesses.
 * @returns A plain object matching {@link ErrorEnvelopeSchema}.
 */
export function errorEnvelope(code: ErrorCode, message: string): ErrorEnvelope {
  return { error: { code, message } };
}

/**
 * An error carrying a stable {@link ErrorCode}.
 *
 * Subagent protocol §7.3 forbids throwing a bare `Error` across a package
 * boundary, because the receiver then has only a message to match on. Every
 * failure this package raises — and every failure the client and server raise
 * at each other — is one of these.
 */
export class ProtocolError extends Error {
  /**
   * The stable code. Safe to branch on; `message` is not.
   */
  public readonly code: ErrorCode;

  /**
   * @param code - The stable code for this failure.
   * @param message - A human-readable explanation, subject to the same "no
   *   secrets" rule as {@link errorEnvelope}.
   * @param options - Standard error options; pass `cause` to keep the
   *   underlying failure attached.
   */
  public constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProtocolError';
    this.code = code;
  }

  /**
   * Renders this error as the wire envelope.
   *
   * @returns `{ error: { code, message } }` for this error.
   */
  public toEnvelope(): ErrorEnvelope {
    return errorEnvelope(this.code, this.message);
  }
}
