/**
 * `client.version` — the compatibility handshake (plan §12.4).
 *
 * `GET /version` is the one endpoint that is unauthenticated on purpose: a
 * client has to be able to discover that it is too old *before* it has
 * credentials to be rejected with, and a self-hoster has to be able to check a
 * deployment with `curl` and no account.
 *
 * The comparison is left to the caller. Deciding what to do about a version
 * mismatch is a user-interface decision — the CLI prints the upgrade line and
 * exits, a hosted integration might page somebody — and semantic version
 * comparison is not something this package should own a second implementation
 * of. What the client guarantees is that the numbers arrive parsed and that a
 * server below this build's `PROTOCOL_VERSION` is visible rather than inferred.
 *
 * @module
 */

import type { GetVersionResponse } from '@agentchat/protocol';
import { GetVersionResponseSchema } from '@agentchat/protocol';

import type { ApiClient, RequestOptions } from '../api.js';
import { signalOf } from '../api.js';

/** The version handshake. Reached as `client.version`. */
export class VersionApi {
  readonly #api: ApiClient;

  /**
   * @param api - The request pipeline.
   */
  public constructor(api: ApiClient) {
    this.#api = api;
  }

  /**
   * What the server is and what it will serve: `GET /version`.
   *
   * Unauthenticated, so this works before login and after a session has
   * expired.
   *
   * @param options - Per-call options.
   * @returns The server's release version, its protocol version, and the oldest
   *   client it will serve.
   * @throws {TransportError} If the server could not be reached at all — which
   *   is what this call is usually being made to find out.
   */
  public get(options?: RequestOptions): Promise<GetVersionResponse> {
    return this.#api.send({
      method: 'GET',
      path: '/version',
      auth: 'none',
      response: GetVersionResponseSchema,
      ...signalOf(options),
    });
  }
}
