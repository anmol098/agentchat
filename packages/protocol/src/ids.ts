/**
 * AgentChat identifiers: a type prefix plus a canonical UUIDv7, e.g.
 * `msg_018f6b1a-9c2e-7f3a-8b4d-5e6f70819a2b`.
 *
 * ## Why prefixes
 *
 * Every identifier in the system is a 36-character hex string; without a prefix
 * a project id and an agent id are indistinguishable in a log line, in a support
 * request, or in a mis-ordered function call. The prefix makes the mistake
 * visible at a glance and rejectable at the boundary. It is part of the wire
 * format: the server stores and returns prefixed strings, and clients send them
 * back verbatim.
 *
 * ## Why the UUID keeps its hyphens
 *
 * The suffix is exactly the canonical RFC 9562 rendering, so `id.slice(4)` is a
 * valid UUID for a Postgres `uuid` column, for `crypto`-adjacent tooling, and
 * for anything that already knows how to parse one. Stripping hyphens would
 * save four bytes and cost that.
 *
 * ## Ordering
 *
 * Because the prefix is fixed-width and the UUIDv7 body is time-ordered,
 * sorting identifiers of the same kind as plain strings sorts them by creation
 * time. `msg_` ids rely on this. See `./uuidv7.js` for the limits of the
 * guarantee.
 *
 * @module
 */

import { z } from "zod";

import type { Brand } from "./branding.js";
import { ErrorCode, ProtocolError } from "./errors.js";
import {
  UUIDV7_PATTERN_SOURCE,
  isUuidv7,
  uuidv7,
  uuidv7Timestamp,
} from "./uuidv7.js";

/**
 * The type prefix for every kind of identifier, keyed by the entity it names.
 *
 * These strings are a public contract: they appear in URLs, in
 * `.agentchat/config.json`, in `--json` output, and in every database row.
 * Changing one is a breaking change with no migration path short of rewriting
 * stored data, so they are frozen here and nowhere else.
 */
export const ID_PREFIXES = Object.freeze({
  /** A person, authenticated through GitHub. */
  user: "usr_",
  /** A project: the boundary for membership, agents, and messages. */
  project: "prj_",
  /** A named agent belonging to one user. */
  agent: "agt_",
  /** A machine an agent runs on, identified by hostname. */
  machine: "mch_",
  /** One `agentchat listen` process's registration. Ephemeral. */
  session: "ses_",
  /** A conversation thread within a project. */
  conversation: "cnv_",
  /** A single message. Sorts chronologically; see the module note. */
  message: "msg_",
  /** A project invite code's identifier (not the human-typed code itself). */
  invite: "inv_",
} as const);

/** Identifies a user. */
export type UserId = Brand<string, "UserId">;
/** Identifies a project. */
export type ProjectId = Brand<string, "ProjectId">;
/** Identifies an agent. */
export type AgentId = Brand<string, "AgentId">;
/** Identifies a machine. */
export type MachineId = Brand<string, "MachineId">;
/** Identifies a listener session. */
export type SessionId = Brand<string, "SessionId">;
/** Identifies a conversation. */
export type ConversationId = Brand<string, "ConversationId">;
/** Identifies a message. Also its idempotency key for delivery (plan §4.4). */
export type MessageId = Brand<string, "MessageId">;
/** Identifies a project invite. */
export type InviteId = Brand<string, "InviteId">;

/**
 * Any AgentChat identifier.
 *
 * Use it for code that genuinely handles identifiers generically — logging,
 * redaction, prefix inspection. It is deliberately useless for anything else:
 * a function that accepts `AnyId` has given up the protection the branded types
 * exist to provide.
 */
export type AnyId =
  | UserId
  | ProjectId
  | AgentId
  | MachineId
  | SessionId
  | ConversationId
  | MessageId
  | InviteId;

/**
 * Everything one kind of identifier can do: mint one, recognise one, parse one,
 * validate one inside a larger schema, and read its creation time.
 *
 * @typeParam TId - The branded string type this kind produces.
 */
export interface IdKind<TId extends string> {
  /** The type prefix, including the trailing underscore, e.g. `"msg_"`. */
  readonly prefix: string;

  /**
   * Mints a new identifier.
   *
   * @returns A fresh identifier of this kind. Ids minted later in the same
   *   process sort after ids minted earlier.
   * @throws {ProtocolError} `INTERNAL` if the platform has no Web Crypto.
   */
  generate(): TId;

  /**
   * Type guard: is this value an identifier of exactly this kind?
   *
   * Another kind's identifier returns `false`, which is the point.
   *
   * @param value - Any value.
   * @returns `true` if `value` is a string with this kind's prefix followed by a
   *   canonical UUIDv7.
   */
  is(value: unknown): value is TId;

  /**
   * Parses an untrusted value into an identifier of this kind.
   *
   * This is the boundary function: use it on anything arriving from HTTP, a
   * WebSocket frame, a config file, an environment variable, or a command-line
   * argument.
   *
   * @param value - Any value.
   * @returns The same string, branded.
   * @throws {ProtocolError} `BAD_REQUEST` if `value` is not a string, carries a
   *   different prefix, or does not end in a canonical UUIDv7. The message names
   *   the expected prefix and echoes at most 64 characters of the input.
   */
  parse(value: unknown): TId;

  /**
   * Brands a string without validating it.
   *
   * For values whose shape is already guaranteed — a column read back from the
   * database, a fixture in a test — where re-validating every row would be
   * wasted work. It is the only sanctioned alternative to writing
   * `as unknown as AgentId`, and it is named to be easy to grep for in review.
   * If the value came from outside the process, use {@link IdKind.parse}.
   *
   * @param value - A string already known to be an identifier of this kind.
   * @returns `value`, branded, whether or not it was actually valid.
   */
  unsafeCast(value: string): TId;

  /**
   * Zod schema accepting this kind of identifier and nothing else.
   *
   * Compose it into request and frame schemas so validation and branding happen
   * in one step at the boundary.
   */
  readonly schema: z.ZodType<TId>;

  /**
   * Reads the creation time embedded in an identifier of this kind.
   *
   * @param value - An identifier of this kind.
   * @returns Milliseconds since the Unix epoch.
   * @throws {ProtocolError} `BAD_REQUEST` if `value` is not an identifier of
   *   this kind.
   */
  timestamp(value: TId): number;
}

/** Longest input echoed back in a parse failure, in characters. */
const MAX_ECHOED_INPUT = 64;

/**
 * Renders an untrusted value for an error message without pasting a megabyte of
 * it into a log.
 *
 * @param value - The offending value.
 * @returns A short, quoted, single-line description.
 */
function describe(value: unknown): string {
  if (typeof value !== "string") {
    return `a ${value === null ? "null" : typeof value}`;
  }
  const text =
    value.length > MAX_ECHOED_INPUT
      ? `${value.slice(0, MAX_ECHOED_INPUT)}…`
      : value;
  return JSON.stringify(text);
}

/**
 * Builds the {@link IdKind} for one prefix.
 *
 * @typeParam TId - The branded type this kind produces.
 * @param prefix - The type prefix, including the trailing underscore.
 * @param label - Human-readable entity name, used in error messages.
 * @returns The kind's frozen operations.
 */
function defineIdKind<TId extends string>(
  prefix: string,
  label: string,
): IdKind<TId> {
  const pattern = new RegExp(`^${prefix}${UUIDV7_PATTERN_SOURCE}$`);
  const expectedLength = prefix.length + 36;

  const is = (value: unknown): value is TId =>
    typeof value === "string" &&
    value.length === expectedLength &&
    pattern.test(value);

  const expected = `${label} id of the form ${prefix}<uuidv7>`;

  const parse = (value: unknown): TId => {
    if (!is(value)) {
      throw new ProtocolError(
        ErrorCode.BAD_REQUEST,
        `Expected ${expected}, got ${describe(value)}.`,
      );
    }
    return value;
  };

  // The regex is the runtime proof that the string satisfies the brand, so this
  // is the single place in the package where a brand is asserted rather than
  // derived. Zod cannot express the brand itself: its output type is `string`.
  const schema = z.string().regex(pattern, {
    error: `Expected ${expected}.`,
  }) as unknown as z.ZodType<TId>;

  return Object.freeze({
    prefix,
    generate: (): TId => `${prefix}${uuidv7()}` as TId,
    is,
    parse,
    unsafeCast: (value: string): TId => value as TId,
    schema,
    timestamp: (value: TId): number => {
      parse(value);
      return uuidv7Timestamp(value.slice(prefix.length));
    },
  });
}

/** Operations on user identifiers (`usr_`). */
export const UserId = defineIdKind<UserId>(ID_PREFIXES.user, "user");
/** Operations on project identifiers (`prj_`). */
export const ProjectId = defineIdKind<ProjectId>(
  ID_PREFIXES.project,
  "project",
);
/** Operations on agent identifiers (`agt_`). */
export const AgentId = defineIdKind<AgentId>(ID_PREFIXES.agent, "agent");
/** Operations on machine identifiers (`mch_`). */
export const MachineId = defineIdKind<MachineId>(
  ID_PREFIXES.machine,
  "machine",
);
/** Operations on session identifiers (`ses_`). */
export const SessionId = defineIdKind<SessionId>(
  ID_PREFIXES.session,
  "session",
);
/** Operations on conversation identifiers (`cnv_`). */
export const ConversationId = defineIdKind<ConversationId>(
  ID_PREFIXES.conversation,
  "conversation",
);
/** Operations on message identifiers (`msg_`). */
export const MessageId = defineIdKind<MessageId>(
  ID_PREFIXES.message,
  "message",
);
/** Operations on invite identifiers (`inv_`). */
export const InviteId = defineIdKind<InviteId>(ID_PREFIXES.invite, "invite");

/**
 * Every identifier kind, keyed the same way as {@link ID_PREFIXES}.
 *
 * For code that must iterate the kinds — exhaustiveness tests, a redactor, a
 * generic parser. Prefer naming the kind you mean everywhere else.
 */
export const ID_KINDS = Object.freeze({
  user: UserId,
  project: ProjectId,
  agent: AgentId,
  machine: MachineId,
  session: SessionId,
  conversation: ConversationId,
  message: MessageId,
  invite: InviteId,
});

/**
 * Reports whether a string is an AgentChat identifier of any known kind.
 *
 * Useful for redaction and diagnostics. It does not tell you *which* kind, and
 * it is not a substitute for parsing with the kind you expect.
 *
 * @param value - Any value.
 * @returns `true` if `value` carries a known prefix and a canonical UUIDv7.
 */
export function isAnyId(value: unknown): value is AnyId {
  if (typeof value !== "string") {
    return false;
  }
  const separator = value.indexOf("_");
  if (separator === -1) {
    return false;
  }
  const prefix = value.slice(0, separator + 1);
  const known = Object.values(ID_PREFIXES).includes(
    prefix as (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES],
  );
  return known && isUuidv7(value.slice(separator + 1));
}
