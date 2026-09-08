/**
 * Version negotiation between client and server (plan §12.4).
 *
 * Two numbers do two different jobs.
 *
 * {@link PROTOCOL_VERSION} describes the *shape* of the conversation: the frame
 * types, the request and response bodies, the identifier format. It is an
 * integer and it moves only when a change is not additive.
 *
 * {@link MIN_CLIENT_VERSION} describes *compatibility*: the oldest release of
 * the `agentchat` CLI a server built from this source will still serve. It is a
 * semantic version because that is what the user has installed and what the
 * upgrade instruction has to name.
 *
 * The exchange, in full:
 *
 * - The CLI sends `X-AgentChat-Client: agentchat/X.Y.Z` on every request and in
 *   the WebSocket `hello`.
 * - `GET /version` answers `{ version, protocolVersion, minClientVersion }`,
 *   unauthenticated.
 * - A client older than the server's `minClientVersion` gets HTTP 426 with the
 *   {@link ErrorCode.UPGRADE_REQUIRED} code, and prints the upgrade line.
 * - A server older than the client is fine: the CLI warns once on stderr and
 *   continues, and flags the old server does not understand are best-effort.
 *
 * @module
 */

/**
 * The wire protocol this build speaks.
 *
 * Bump it only for a change that an existing peer cannot ignore: a removed or
 * repurposed field, a changed identifier format, a frame whose meaning has
 * shifted. Adding an optional field or a new frame type does **not** bump it,
 * because both sides ignore what they do not recognise — that is the whole
 * additive-only rule, and this integer is what tells you it was respected.
 */
export const PROTOCOL_VERSION = 1;

/**
 * The oldest `agentchat` CLI release this build will serve.
 *
 * Raising it strands every user below the new floor until they upgrade, so it
 * moves only when supporting the older client is genuinely impossible, and the
 * release notes have to say so (plan §12.1). `0.1.0` is the first published
 * release; nothing earlier ever existed to support.
 */
export const MIN_CLIENT_VERSION = '0.1.0';
