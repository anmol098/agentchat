/**
 * `client.auth` — the device authorization flow, logout, and `GET /me`.
 *
 * ## This group owns the credential store's contents
 *
 * Logging in and logging out are the two moments when credentials appear and
 * disappear, so those two methods write to the store rather than handing tokens
 * back for the caller to remember. A CLI that forgot to persist them would
 * "succeed" at login and then be logged out on the next command; making it
 * impossible to forget is worth the side effect, and the tokens are returned as
 * well for callers that want them.
 *
 * Refreshing is *not* here. It is not something a caller does; it is something
 * that happens to a request. See `../tokens.ts`.
 *
 * @module
 */

import type {
  GetCurrentUserResponse,
  PollDeviceAuthorizationRequest,
  PollDeviceAuthorizationResponse,
  StartDeviceAuthorizationResponse,
} from '@agentchat/protocol';
import {
  ErrorCode,
  GetCurrentUserResponseSchema,
  LogoutRequestSchema,
  LogoutResponseSchema,
  PollDeviceAuthorizationRequestSchema,
  PollDeviceAuthorizationResponseSchema,
  ProtocolError,
  StartDeviceAuthorizationRequestSchema,
  StartDeviceAuthorizationResponseSchema,
} from '@agentchat/protocol';

import type { ApiClient, RequestOptions } from '../api.js';
import { parseRequest, signalOf } from '../api.js';
import type { CredentialStore } from '../credentials.js';

/** Authentication endpoints. Reached as `client.auth`. */
export class AuthApi {
  readonly #api: ApiClient;
  readonly #store: CredentialStore;

  /**
   * @param api - The request pipeline.
   * @param store - Where credentials are persisted.
   */
  public constructor(api: ApiClient, store: CredentialStore) {
    this.#api = api;
    this.#store = store;
  }

  /**
   * Begins a device authorization: `POST /auth/device/start`.
   *
   * Unauthenticated. Print `userCode` and `verificationUri` to the user, then
   * poll {@link AuthApi.pollDeviceAuthorization} every `interval` seconds.
   *
   * @param options - Per-call options.
   * @returns The device code, the user code, where to enter it, and the timings.
   * @throws {ApiError} If the server refused to start a flow.
   */
  public startDeviceAuthorization(
    options?: RequestOptions,
  ): Promise<StartDeviceAuthorizationResponse> {
    return this.#api.send({
      method: 'POST',
      path: '/auth/device/start',
      auth: 'none',
      body: StartDeviceAuthorizationRequestSchema.parse({}),
      response: StartDeviceAuthorizationResponseSchema,
      ...signalOf(options),
    });
  }

  /**
   * Asks whether the user has approved yet: `POST /auth/device/poll`.
   *
   * On approval the returned tokens are written to the credential store before
   * this resolves, so the very next call is authenticated.
   *
   * Unauthenticated, and the two non-terminal outcomes are errors rather than
   * return values, because that is how they travel on the wire: a flow still
   * waiting throws `AUTH_PENDING` — keep polling — and an expired or redeemed
   * code throws `DEVICE_CODE_EXPIRED` — stop, and start again.
   *
   * @param request - The device code from `start`.
   * @param options - Per-call options.
   * @returns The token pair and the account they belong to.
   * @throws {ApiError} `AUTH_PENDING` while the user has not approved;
   *   `DEVICE_CODE_EXPIRED` once the code is dead.
   */
  public async pollDeviceAuthorization(
    request: PollDeviceAuthorizationRequest,
    options?: RequestOptions,
  ): Promise<PollDeviceAuthorizationResponse> {
    const approved = await this.#api.send({
      method: 'POST',
      path: '/auth/device/poll',
      auth: 'none',
      body: parseRequest(
        PollDeviceAuthorizationRequestSchema,
        request,
        'The device authorization to poll for',
      ),
      response: PollDeviceAuthorizationResponseSchema,
      ...signalOf(options),
    });
    await this.#store.save({
      accessToken: approved.accessToken,
      refreshToken: approved.refreshToken,
    });
    return approved;
  }

  /**
   * Revokes the stored refresh token and forgets it: `POST /auth/logout`.
   *
   * The local credentials are cleared whatever the server says, including when
   * the request fails. A logout that left a token on disk because the network
   * was down would be a worse outcome than one that could not tell the server:
   * the access token expires within the hour regardless, and the user asked to
   * be logged out of this machine.
   *
   * Logging out when nothing is stored is a success and makes no request.
   *
   * @param options - Per-call options.
   * @throws {ApiError} If the server failed for any reason other than the
   *   credentials already being invalid, which is treated as success.
   */
  public async logout(options?: RequestOptions): Promise<void> {
    const credentials = await this.#store.load();
    if (credentials === null) {
      return;
    }
    try {
      await this.#api.send({
        method: 'POST',
        path: '/auth/logout',
        auth: 'required',
        body: LogoutRequestSchema.parse({ refreshToken: credentials.refreshToken }),
        response: LogoutResponseSchema,
        ...signalOf(options),
      });
    } catch (cause) {
      const alreadyInvalid =
        cause instanceof ProtocolError && cause.code === ErrorCode.AUTH_REQUIRED;
      if (!alreadyInvalid) {
        throw cause;
      }
    } finally {
      await this.#store.clear();
    }
  }

  /**
   * The authenticated caller's own account: `GET /me`.
   *
   * @param options - Per-call options.
   * @returns The caller's user record, including their email.
   * @throws {ProtocolError} `AUTH_REQUIRED` if nobody is logged in.
   */
  public me(options?: RequestOptions): Promise<GetCurrentUserResponse> {
    return this.#api.send({
      method: 'GET',
      path: '/me',
      auth: 'required',
      response: GetCurrentUserResponseSchema,
      ...signalOf(options),
    });
  }
}
