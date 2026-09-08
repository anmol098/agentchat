/**
 * `@agentchat/protocol` — the shared vocabulary of AgentChat.
 *
 * Identifiers, error codes, the error envelope, and the version constants that
 * let a client and a server agree they can talk to each other. Every other
 * package imports this one; this one imports nothing but zod.
 *
 * That direction is a licence boundary, not a preference. `packages/` is MIT so
 * that any harness or product can embed the client half of AgentChat; `server/`
 * is AGPL. MIT code may be absorbed into an AGPL work, never the reverse, so
 * **nothing in this package may ever import from `server/`**. See LICENSE.
 *
 * @packageDocumentation
 */

export type { Brand } from './branding.js';
export type { ErrorEnvelope, WireErrorCode } from './errors.js';
export {
  ERROR_CODES,
  ErrorCode,
  ErrorCodeSchema,
  ErrorEnvelopeSchema,
  errorEnvelope,
  isErrorCode,
  ProtocolError,
} from './errors.js';
export type { AnyId, IdKind } from './ids.js';
// Each identifier name is both a type (`AgentId` the branded string) and a
// value (`AgentId.parse`, `AgentId.generate`). One re-export carries both.
export {
  AgentId,
  ConversationId,
  ID_KINDS,
  ID_PREFIXES,
  InviteId,
  isAnyId,
  MachineId,
  MessageId,
  ProjectId,
  SessionId,
  UserId,
} from './ids.js';

export {
  isUuidv7,
  UUIDV7_PATTERN_SOURCE,
  uuidv7,
  uuidv7Timestamp,
} from './uuidv7.js';

export { MIN_CLIENT_VERSION, PROTOCOL_VERSION } from './version.js';
