/**
 * Every HTTP request and response schema for milestone 1: authentication,
 * projects, invites, agents, and the version handshake (plan §3).
 *
 * ## One definition, two callers
 *
 * A Fastify route parses its body with the request schema and returns a value
 * the response schema accepts; the client method sends a value the request
 * schema accepts and parses the reply with the response schema. Neither side
 * declares a shape of its own, so a change that breaks the other fails to
 * compile rather than failing in production. There are no hand-written
 * duplicate interfaces anywhere.
 *
 * ## What is deliberately missing
 *
 * Sessions and messages. Their semantics — the inbox, agent-scoped acks (D3),
 * fan-out delivery (D2), the `clientMessageId` idempotency key — are settled in
 * the milestone that implements them, and writing their schemas ahead of that
 * would be guessing at contracts six other tasks then have to live with. The
 * WebSocket frames of plan §4 are likewise not here.
 *
 * ## Where the shapes came from
 *
 * Plan §3 lists the endpoints and, for most of them, the field names. Where it
 * is silent — the representation of a user, whether a list is wrapped, what a
 * mutation with no documented response returns — each module's note records the
 * decision and its reasoning, and the pull request for T-201 collects them.
 *
 * @module
 */

export type {
  AddAgentToProjectRequest,
  AddAgentToProjectResponse,
  AgentIdParams,
  AgentProjectParams,
  CreateAgentRequest,
  CreateAgentResponse,
  DeleteAgentResponse,
  ListAgentsResponse,
  RemoveAgentFromProjectResponse,
  RenameAgentRequest,
  RenameAgentResponse,
} from './agents.js';
export {
  AddAgentToProjectRequestSchema,
  AddAgentToProjectResponseSchema,
  AgentIdParamsSchema,
  AgentProjectParamsSchema,
  CreateAgentRequestSchema,
  CreateAgentResponseSchema,
  DeleteAgentResponseSchema,
  ListAgentsResponseSchema,
  RemoveAgentFromProjectResponseSchema,
  RenameAgentRequestSchema,
  RenameAgentResponseSchema,
} from './agents.js';
export type {
  GetCurrentUserResponse,
  LogoutRequest,
  LogoutResponse,
  PollDeviceAuthorizationRequest,
  PollDeviceAuthorizationResponse,
  RefreshTokensRequest,
  RefreshTokensResponse,
  StartDeviceAuthorizationRequest,
  StartDeviceAuthorizationResponse,
} from './auth.js';
export {
  GetCurrentUserResponseSchema,
  LogoutRequestSchema,
  LogoutResponseSchema,
  PollDeviceAuthorizationRequestSchema,
  PollDeviceAuthorizationResponseSchema,
  RefreshTokensRequestSchema,
  RefreshTokensResponseSchema,
  StartDeviceAuthorizationRequestSchema,
  StartDeviceAuthorizationResponseSchema,
} from './auth.js';
export type {
  Agent,
  Project,
  ProjectAgent,
  ProjectMembership,
  ProjectRole,
  User,
  UserSummary,
} from './entities.js';
export {
  AgentSchema,
  PROJECT_ROLES,
  ProjectAgentSchema,
  ProjectMembershipSchema,
  ProjectRoleSchema,
  ProjectSchema,
  UserSchema,
  UserSummarySchema,
} from './entities.js';
export type {
  CreateInviteRequest,
  CreateInviteResponse,
  InviteCodeParams,
  InvitePreviewResponse,
  JoinProjectRequest,
  JoinProjectResponse,
} from './invites.js';
export {
  CreateInviteRequestSchema,
  CreateInviteResponseSchema,
  InviteCodeParamsSchema,
  InvitePreviewResponseSchema,
  JoinProjectRequestSchema,
  JoinProjectResponseSchema,
} from './invites.js';
export type {
  AgentName,
  Count,
  DisplayName,
  DurationSeconds,
  EmptyRequest,
  EmptyResponse,
  InviteCode,
  OpaqueToken,
  ProjectName,
  ProjectSlug,
  SemanticVersion,
  Timestamp,
  UserCode,
  Username,
} from './primitives.js';
export {
  AGENT_NAME_PATTERN,
  AgentNameSchema,
  CountSchema,
  DisplayNameSchema,
  DurationSecondsSchema,
  EmptyRequestSchema,
  EmptyResponseSchema,
  INVITE_CODE_PATTERN,
  InviteCodeSchema,
  OpaqueTokenSchema,
  PROJECT_SLUG_PATTERN,
  ProjectNameSchema,
  ProjectSlugSchema,
  SEMVER_PATTERN_SOURCE,
  SemanticVersionSchema,
  TimestampSchema,
  USERNAME_PATTERN,
  UserCodeSchema,
  UsernameSchema,
} from './primitives.js';
export type {
  CreateProjectRequest,
  CreateProjectResponse,
  GetProjectResponse,
  LeaveProjectRequest,
  LeaveProjectResponse,
  ListProjectAgentsResponse,
  ListProjectsResponse,
  ProjectIdParams,
} from './projects.js';
export {
  CreateProjectRequestSchema,
  CreateProjectResponseSchema,
  GetProjectResponseSchema,
  LeaveProjectRequestSchema,
  LeaveProjectResponseSchema,
  ListProjectAgentsResponseSchema,
  ListProjectsResponseSchema,
  ProjectIdParamsSchema,
} from './projects.js';
export type { ClientVersionHeader, GetVersionResponse } from './version.js';
export {
  CLIENT_VERSION_HEADER,
  ClientVersionHeaderSchema,
  formatClientVersionHeader,
  GetVersionResponseSchema,
} from './version.js';
