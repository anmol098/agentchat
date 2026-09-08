/**
 * Authentication endpoints: the device authorization flow, token refresh,
 * logout, and `GET /me` (plan §3 "Auth", §7).
 *
 * ## The shape of the login flow
 *
 * `POST /auth/device/start` hands back a `deviceCode` the CLI keeps and a
 * `userCode` the human types at `verificationUri`. The CLI then polls
 * `POST /auth/device/poll` every `interval` seconds until one of three things
 * happens:
 *
 * - the user has not approved yet — HTTP 428 with `AUTH_PENDING`, which is an
 *   expected state and not a failure, so it has no success schema here;
 * - the code expired or was already redeemed — `DEVICE_CODE_EXPIRED`, and
 *   polling must stop;
 * - approval — {@link PollDeviceAuthorizationResponseSchema}.
 *
 * Only the third case has a body of its own; the other two are ordinary error
 * envelopes. That is why the poll response schema describes success only.
 *
 * ## Nothing here is GitHub-shaped
 *
 * D4 makes GitHub the reference identity provider, not part of the protocol. No
 * schema in this module mentions it, and a self-hoster pointing at a different
 * IdP changes server configuration, not the wire.
 *
 * @module
 */

import { z } from 'zod';

import { UserSchema } from './entities.js';
import { DurationSecondsSchema, OpaqueTokenSchema, UserCodeSchema } from './primitives.js';

/**
 * `POST /auth/device/start` request: no fields.
 *
 * The server knows its own IdP client id (plan §7); the client has nothing to
 * contribute. A scope or an audience would go here if one is ever needed, which
 * is why this is an empty object rather than no schema at all.
 */
export const StartDeviceAuthorizationRequestSchema = z.object({});

/** `POST /auth/device/start` request body. */
export type StartDeviceAuthorizationRequest = z.infer<typeof StartDeviceAuthorizationRequestSchema>;

/**
 * `POST /auth/device/start` response: everything the CLI needs to print the
 * instruction and start polling.
 */
export const StartDeviceAuthorizationResponseSchema = z.object({
  /**
   * The secret half of the authorization, held by the CLI and replayed on every
   * poll. Never shown to the user and never logged.
   */
  deviceCode: OpaqueTokenSchema,
  /** The short code the user types in the browser, e.g. `ABCD-1234`. */
  userCode: UserCodeSchema,
  /** Where the user enters {@link userCode}. Printed verbatim by the CLI. */
  verificationUri: z.url(),
  /**
   * How long to wait between polls, in seconds.
   *
   * Honour it. Polling faster is what gets a client rate-limited by the
   * upstream provider, and the server cannot make that failure legible.
   */
  interval: DurationSecondsSchema,
  /**
   * How long the device code remains redeemable, in seconds, from the moment
   * this response was produced. After it elapses the flow restarts from the
   * beginning.
   */
  expiresIn: DurationSecondsSchema,
});

/** `POST /auth/device/start` response body. */
export type StartDeviceAuthorizationResponse = z.infer<
  typeof StartDeviceAuthorizationResponseSchema
>;

/** `POST /auth/device/poll` request: the device code from `start`. */
export const PollDeviceAuthorizationRequestSchema = z.object({
  /** The `deviceCode` returned by `POST /auth/device/start`. */
  deviceCode: OpaqueTokenSchema,
});

/** `POST /auth/device/poll` request body. */
export type PollDeviceAuthorizationRequest = z.infer<typeof PollDeviceAuthorizationRequestSchema>;

/**
 * `POST /auth/device/poll` response, for the *approved* case only.
 *
 * A poll that is still waiting answers `428` with `AUTH_PENDING`, and an
 * expired or redeemed code answers `400` with `DEVICE_CODE_EXPIRED`; both are
 * ordinary error envelopes, so neither has a schema here. See the module note.
 */
export const PollDeviceAuthorizationResponseSchema = z.object({
  /** Short-lived bearer credential for every authenticated request. */
  accessToken: OpaqueTokenSchema,
  /** Long-lived credential, rotated on every use. Store at mode 0600. */
  refreshToken: OpaqueTokenSchema,
  /** The account the tokens belong to, so the CLI need not immediately call `/me`. */
  user: UserSchema,
});

/** `POST /auth/device/poll` response body for an approved authorization. */
export type PollDeviceAuthorizationResponse = z.infer<typeof PollDeviceAuthorizationResponseSchema>;

/** `POST /auth/refresh` request: the refresh token being redeemed. */
export const RefreshTokensRequestSchema = z.object({
  /** The refresh token most recently issued to this client. */
  refreshToken: OpaqueTokenSchema,
});

/** `POST /auth/refresh` request body. */
export type RefreshTokensRequest = z.infer<typeof RefreshTokensRequestSchema>;

/**
 * `POST /auth/refresh` response: a new pair.
 *
 * `refreshToken` is always present and always *different* from the one sent —
 * plan §7 rotates on every refresh — so a client that stores only the access
 * token will be unable to refresh again. Persist both, atomically, before using
 * either.
 *
 * A refresh token that is unknown, expired, or already rotated answers
 * `AUTH_REQUIRED`; the client must then prompt for `agentchat login` rather
 * than retrying.
 */
export const RefreshTokensResponseSchema = z.object({
  /** The new short-lived bearer credential. */
  accessToken: OpaqueTokenSchema,
  /** The new refresh token. Replaces the one just spent. */
  refreshToken: OpaqueTokenSchema,
});

/** `POST /auth/refresh` response body. */
export type RefreshTokensResponse = z.infer<typeof RefreshTokensResponseSchema>;

/**
 * `POST /auth/logout` request: the refresh token to revoke.
 *
 * The refresh token rather than the access token, because revoking the durable
 * credential is what actually ends the session; the access token expires on its
 * own within the hour.
 */
export const LogoutRequestSchema = z.object({
  /** The refresh token to revoke. Revoking an already-revoked token succeeds. */
  refreshToken: OpaqueTokenSchema,
});

/** `POST /auth/logout` request body. */
export type LogoutRequest = z.infer<typeof LogoutRequestSchema>;

/**
 * `POST /auth/logout` response: no fields.
 *
 * Idempotent by design — logging out twice, or with a token the server has
 * already forgotten, is a success. A client that treated the second call as an
 * error would strand credentials it can no longer use.
 */
export const LogoutResponseSchema = z.object({});

/** `POST /auth/logout` response body. */
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;

/**
 * `GET /me` response: the authenticated caller's own account, unwrapped.
 *
 * The bare user object rather than `{ user }`, because there is exactly one
 * thing this endpoint can return and a wrapper would only be a name for it. The
 * device-poll response wraps its `user` because it carries tokens alongside.
 */
export const GetCurrentUserResponseSchema = UserSchema;

/** `GET /me` response body. */
export type GetCurrentUserResponse = z.infer<typeof GetCurrentUserResponseSchema>;
