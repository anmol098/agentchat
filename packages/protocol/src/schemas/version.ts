/**
 * The version handshake on the wire: the `GET /version` response body and the
 * client header that goes with it (plan §3, §12.4).
 *
 * `../version.js` holds the two constants *this build* is compiled with.
 * This module describes what those constants look like when they travel, which
 * is why the constants and the schemas are in different files: a server reports
 * its own `PROTOCOL_VERSION`, and a client parses whatever number the server
 * actually sent, which may not be the one it was built with. That difference is
 * the entire point of the endpoint.
 *
 * @module
 */

import { z } from 'zod';

import { SEMVER_PATTERN_SOURCE, SemanticVersionSchema } from './primitives.js';

/**
 * `GET /version` response. Unauthenticated — a client has to be able to
 * discover it is too old *before* it has credentials to be rejected with.
 *
 * The three numbers answer three different questions, and conflating them is
 * the mistake this schema exists to prevent:
 *
 * - `version` — which release is running. For display and bug reports.
 * - `protocolVersion` — the shape of the conversation. An integer, and equal
 *   between two peers that can talk at all.
 * - `minClientVersion` — the oldest CLI this server will serve. A client below
 *   it gets `426` with `UPGRADE_REQUIRED` on every other endpoint.
 *
 * A client *newer* than the server is fine: it warns once on stderr and
 * continues, and flags the older server does not understand are best-effort.
 */
export const GetVersionResponseSchema = z.object({
  /** The server's release version, e.g. `0.1.0`. One number for the whole repo. */
  version: SemanticVersionSchema,
  /**
   * The wire protocol the server speaks. Compare against the local
   * `PROTOCOL_VERSION`; they differ only across a major release.
   */
  protocolVersion: z.int().positive(),
  /**
   * The oldest `agentchat` CLI release this server will serve. A client at or
   * above it is accepted; below it, every authenticated request fails with
   * `UPGRADE_REQUIRED` and the CLI must print the upgrade line and exit rather
   * than retry.
   */
  minClientVersion: SemanticVersionSchema,
});

/** `GET /version` response body. */
export type GetVersionResponse = z.infer<typeof GetVersionResponseSchema>;

/**
 * The header the CLI sends on every HTTP request and in the WebSocket `hello`,
 * lowercased because Node normalises incoming header names that way.
 *
 * It is how the server knows whether the caller is below `minClientVersion`;
 * a request without it is served, since a third-party harness embedding
 * `packages/client` is not the `agentchat` CLI and has no version to claim.
 */
export const CLIENT_VERSION_HEADER = 'x-agentchat-client';

/**
 * The value of {@link CLIENT_VERSION_HEADER}: `agentchat/X.Y.Z`.
 *
 * Parsing yields just the version, because the product token is a constant that
 * exists to make the header self-describing in a log and carries no information
 * for the code reading it. A malformed value is a `BAD_REQUEST`; an absent one
 * is not an error at all.
 */
export const ClientVersionHeaderSchema = z
  .string()
  .regex(new RegExp(`^agentchat/${SEMVER_PATTERN_SOURCE}$`), {
    error: 'Expected a client header of the form agentchat/X.Y.Z.',
  })
  .transform((value): string => value.slice('agentchat/'.length));

/** The version announced by {@link CLIENT_VERSION_HEADER}, with the product token stripped. */
export type ClientVersionHeader = z.infer<typeof ClientVersionHeaderSchema>;

/**
 * Renders the value for {@link CLIENT_VERSION_HEADER}.
 *
 * One function so the client and any test fixture produce the same string; a
 * hand-built header that drifts from {@link ClientVersionHeaderSchema} would
 * fail validation on a server that is otherwise willing to serve the caller.
 *
 * @param version - The client's own release version, e.g. `0.1.0`.
 * @returns The header value, e.g. `agentchat/0.1.0`.
 */
export function formatClientVersionHeader(version: string): string {
  return `agentchat/${version}`;
}
