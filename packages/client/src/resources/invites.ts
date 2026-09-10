/**
 * `client.invites` — the two operations that start from a code.
 *
 * Previewing is what makes PRD §27's confirmation prompt possible: the CLI can
 * print `Project: Payments Platform / Invited by: Alice` and ask before joining,
 * because `GET /invites/:code` answers a caller who is not yet a member of
 * anything. It is still an authenticated endpoint — you have to be a user to
 * join a project — it is only *membership* that is not required.
 *
 * Minting a code is a project operation and lives on `client.projects`.
 *
 * @module
 */

import type { InviteCode, InvitePreviewResponse, JoinProjectResponse } from '@stackgrid/protocol';
import {
  InviteCodeParamsSchema,
  InvitePreviewResponseSchema,
  JoinProjectRequestSchema,
  JoinProjectResponseSchema,
} from '@stackgrid/protocol';

import type { ApiClient, RequestOptions } from '../api.js';
import { parseRequest, signalOf } from '../api.js';

/**
 * Validates an invite code before it is spliced into a URL path.
 *
 * The grammar forbids everything outside `[A-Za-z0-9-]`, so a code that passes
 * needs no escaping and a code that would have needed it is rejected here with a
 * `BAD_REQUEST` rather than becoming a request for some other path.
 *
 * @param code - The code as typed by the user.
 * @returns The same code.
 * @throws {ProtocolError} `BAD_REQUEST` if it is not a well-formed code.
 */
function pathSafeCode(code: InviteCode): string {
  return parseRequest(InviteCodeParamsSchema, { code }, 'The invite code').code;
}

/** Invite endpoints. Reached as `client.invites`. */
export class InvitesApi {
  readonly #api: ApiClient;

  /**
   * @param api - The request pipeline.
   */
  public constructor(api: ApiClient) {
    this.#api = api;
  }

  /**
   * What this code would join you to: `GET /invites/:code`.
   *
   * @param code - The invite code.
   * @param options - Per-call options.
   * @returns The project and who invited you, in the outsider-safe shapes.
   * @throws {ApiError} `INVITE_INVALID` if the code is unknown, revoked,
   *   expired, or used up — the four are one code on purpose.
   * @throws {ProtocolError} `BAD_REQUEST` if the code is malformed.
   */
  public async preview(code: InviteCode, options?: RequestOptions): Promise<InvitePreviewResponse> {
    const path = `/invites/${pathSafeCode(code)}`;
    return await this.#api.send({
      method: 'GET',
      path,
      auth: 'required',
      response: InvitePreviewResponseSchema,
      ...signalOf(options),
    });
  }

  /**
   * Redeems a code: `POST /invites/:code/join`.
   *
   * Joining a project the caller is already in succeeds with their existing
   * role; it is not a `CONFLICT`.
   *
   * @param code - The invite code.
   * @param options - Per-call options.
   * @returns The project just joined, with the caller's role in it.
   * @throws {ApiError} `INVITE_INVALID` if the code no longer works.
   * @throws {ProtocolError} `BAD_REQUEST` if the code is malformed.
   */
  public async join(code: InviteCode, options?: RequestOptions): Promise<JoinProjectResponse> {
    const path = `/invites/${pathSafeCode(code)}/join`;
    return await this.#api.send({
      method: 'POST',
      path,
      auth: 'required',
      body: JoinProjectRequestSchema.parse({}),
      response: JoinProjectResponseSchema,
      ...signalOf(options),
    });
  }
}
