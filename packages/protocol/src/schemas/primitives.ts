/**
 * The small value types the HTTP schemas are built out of: timestamps, semantic
 * versions, the name and slug grammars, invite codes, and opaque credentials.
 *
 * They live in one module because they are shared across endpoint groups and
 * because each of them is a *wire* decision. A grammar that is loose here can
 * never be tightened without breaking a client that relied on the looseness, so
 * each schema below records where its rule comes from: either the
 * implementation plan states it, or this module is where it was first written
 * down and the pull request for T-201 says so.
 *
 * ## Strict on the way in, tolerant on the way out
 *
 * Object schemas built from these are plain `z.object`s, so unknown properties
 * are **stripped rather than rejected**. That is what makes adding a field to a
 * response a non-breaking change under the additive-only rule in plan §12.4:
 * an older client parsing a newer server's body drops what it does not know
 * instead of failing.
 *
 * @module
 */

import { z } from 'zod';

/**
 * An instant, as an ISO 8601 date-time in UTC — `2026-09-08T12:34:56.789Z`.
 *
 * UTC with a literal `Z` rather than an offset, because the only consumer that
 * cares is a renderer converting to local time, and allowing offsets would mean
 * two encodings of the same instant that no longer compare as strings.
 * Fractional seconds are optional.
 */
export const TimestampSchema = z.iso.datetime();

/** An instant on the wire: an ISO 8601 date-time in UTC. */
export type Timestamp = z.infer<typeof TimestampSchema>;

/**
 * Source of {@link SemanticVersionSchema}'s pattern: the official grammar from
 * semver.org, unanchored so it can be embedded.
 *
 * Exported so the CLI can reuse the exact same grammar when it parses its own
 * version rather than writing a second, subtly different one. Do not relax it:
 * `MIN_CLIENT_VERSION` is compared against, and a version that does not parse
 * cannot be compared.
 */
export const SEMVER_PATTERN_SOURCE =
  '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)' +
  '(?:-(?:(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)' +
  '(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?' +
  '(?:\\+(?:[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?';

/**
 * A semantic version with no `v` prefix and no range operator — `1.4.0`,
 * `0.1.0-rc.1`.
 *
 * Used for the release version and `minClientVersion` in the `/version`
 * response, and for the version the CLI announces in its client header.
 */
export const SemanticVersionSchema = z.string().regex(new RegExp(`^${SEMVER_PATTERN_SOURCE}$`), {
  error: 'Expected a semantic version such as 1.4.0.',
});

/** A semantic version string, with no `v` prefix and no range operator. */
export type SemanticVersion = z.infer<typeof SemanticVersionSchema>;

/**
 * The agent-name grammar, stated verbatim in plan §2:
 * `^[a-z0-9][a-z0-9-]{0,31}$`.
 *
 * Lowercase alphanumerics and hyphens, starting with an alphanumeric, at most
 * 32 characters. Names appear in `@alice/backend`, so they may contain neither
 * `@` nor `/`, and they are unambiguously unique per user only because the
 * grammar forbids uppercase in the first place.
 */
export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * An agent name: lowercase alphanumerics and hyphens, 1–32 characters, first
 * character alphanumeric.
 *
 * @see {@link AGENT_NAME_PATTERN} for the grammar and where it comes from.
 */
export const AgentNameSchema = z.string().regex(AGENT_NAME_PATTERN, {
  error:
    'Expected an agent name of 1 to 32 lowercase letters, digits and hyphens, starting with a letter or digit.',
});

/** An agent name, e.g. the `backend` in `@alice/backend`. */
export type AgentName = z.infer<typeof AgentNameSchema>;

/**
 * The project-slug grammar: `^[a-z0-9][a-z0-9-]{0,31}$`.
 *
 * The plan requires a unique `slug` on `projects` and lets `POST /projects`
 * supply one, but never states its shape, so this is deliberately the *same*
 * grammar as {@link AGENT_NAME_PATTERN}. A slug is typed into a shell
 * (`agentchat project init payments`), stored in a committed
 * `.agentchat/config.json`, and read aloud in a stand-up; the constraints that
 * make an agent name safe for those uses make a slug safe for them too, and one
 * grammar is one thing for a user to learn instead of two.
 */
export const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * A project slug: lowercase alphanumerics and hyphens, 1–32 characters, first
 * character alphanumeric.
 *
 * @see {@link PROJECT_SLUG_PATTERN} for the grammar and why it matches the
 *   agent-name grammar.
 */
export const ProjectSlugSchema = z.string().regex(PROJECT_SLUG_PATTERN, {
  error:
    'Expected a project slug of 1 to 32 lowercase letters, digits and hyphens, starting with a letter or digit.',
});

/** A project slug, e.g. `payments`. Unique across the server. */
export type ProjectSlug = z.infer<typeof ProjectSlugSchema>;

/** Longest project display name accepted, in characters. */
const MAX_PROJECT_NAME_LENGTH = 100;

/**
 * A project's human-readable name — `Payments Platform`.
 *
 * Free text, because it is only ever displayed. Bounded so a mistyped paste
 * cannot become a row that every project listing then has to render, and
 * non-empty because a project with a blank name is indistinguishable from every
 * other project with a blank name.
 */
export const ProjectNameSchema = z.string().min(1).max(MAX_PROJECT_NAME_LENGTH);

/** A project's human-readable name. */
export type ProjectName = z.infer<typeof ProjectNameSchema>;

/**
 * The username grammar: `^[a-z0-9][a-z0-9-]{0,38}$`.
 *
 * Plan §2 says `username` is the GitHub login, lowercased, and that
 * `@alice/backend` is `username` + `/` + agent name. The 39-character ceiling
 * and the leading-alphanumeric rule are GitHub's; hyphens are allowed anywhere
 * after the first character, which is slightly looser than GitHub (which
 * forbids consecutive hyphens) because D4 keeps the protocol
 * identity-provider agnostic and that particular restriction is GitHub's alone.
 *
 * What matters to the protocol is that a username contains neither `@` nor `/`,
 * so a handle can be split without ambiguity.
 */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}$/;

/**
 * A user's handle-forming name, lowercase — the `alice` in `@alice/backend`.
 *
 * @see {@link USERNAME_PATTERN} for the grammar and its provenance.
 */
export const UsernameSchema = z.string().regex(USERNAME_PATTERN, {
  error:
    'Expected a username of 1 to 39 lowercase letters, digits and hyphens, starting with a letter or digit.',
});

/** A user's lowercase login name. */
export type Username = z.infer<typeof UsernameSchema>;

/** Longest display name accepted, in characters. */
const MAX_DISPLAY_NAME_LENGTH = 255;

/**
 * A user's display name as shown in `Invited by: Alice` (PRD §27).
 *
 * Free text from the identity provider, so no grammar beyond a length bound.
 */
export const DisplayNameSchema = z.string().min(1).max(MAX_DISPLAY_NAME_LENGTH);

/** A user's display name. */
export type DisplayName = z.infer<typeof DisplayNameSchema>;

/** Longest invite code accepted, in characters. */
const MAX_INVITE_CODE_LENGTH = 64;

/**
 * The invite-code grammar: `^[A-Za-z0-9-]{1,64}$`.
 *
 * Plan §2 gives `ANET-7K4M-Q2P9` as an example — "e.g.", not a specification —
 * so this schema deliberately does **not** freeze the group structure, the
 * length, or the alphabet the server draws from. Minting is the server's
 * business; the protocol only has to guarantee that a code survives a URL path
 * segment intact, which is what forbidding everything outside `[A-Za-z0-9-]`
 * buys.
 *
 * A syntactically valid code that names no invite is an `INVITE_INVALID`, not a
 * validation failure, and the two are indistinguishable to the caller on
 * purpose: rejecting a well-formed unknown code differently from an expired one
 * would leak whether it ever existed.
 */
export const INVITE_CODE_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/**
 * An invite code as typed by a human: `agentchat project join ANET-7K4M-Q2P9`.
 *
 * @see {@link INVITE_CODE_PATTERN} for why this is looser than the example in
 *   the plan.
 */
export const InviteCodeSchema = z.string().regex(INVITE_CODE_PATTERN, {
  error: `Expected an invite code of up to ${MAX_INVITE_CODE_LENGTH} letters, digits and hyphens.`,
});

/** An invite code, as printed by `agentchat project invite` and typed to join. */
export type InviteCode = z.infer<typeof InviteCodeSchema>;

/** Longest opaque credential accepted, in characters. */
const MAX_TOKEN_LENGTH = 4096;

/**
 * An opaque credential: an access token, a refresh token, or a device code.
 *
 * Deliberately structureless. The access token is a JWT today (plan §7) and the
 * refresh token is 32 random bytes, but a client that validated either shape
 * would break the day the server changed how it mints them — and the client's
 * only correct behaviour is to store the string and send it back. The bound
 * exists so a hostile body cannot be unbounded, not to describe the format.
 *
 * Never log a value parsed by this schema.
 */
export const OpaqueTokenSchema = z.string().min(1).max(MAX_TOKEN_LENGTH);

/** An opaque credential string. Never log one. */
export type OpaqueToken = z.infer<typeof OpaqueTokenSchema>;

/** Longest user-facing device code accepted, in characters. */
const MAX_USER_CODE_LENGTH = 64;

/**
 * The short code a user types into the browser during login — `ABCD-1234`.
 *
 * Minted by the identity provider, not by AgentChat, so its shape is not ours
 * to constrain; the CLI prints it verbatim.
 */
export const UserCodeSchema = z.string().min(1).max(MAX_USER_CODE_LENGTH);

/** The short code a user types into the browser during login. */
export type UserCode = z.infer<typeof UserCodeSchema>;

/**
 * A duration in whole seconds, as used by `interval` and `expiresIn`.
 *
 * Seconds rather than milliseconds because that is what OAuth device
 * authorization responses use and what the CLI sleeps for between polls.
 */
export const DurationSecondsSchema = z.int().positive();

/** A duration in whole seconds. */
export type DurationSeconds = z.infer<typeof DurationSecondsSchema>;

/** A count of things, as used by the `sessions` field in agent discovery. */
export const CountSchema = z.int().nonnegative();

/** A non-negative whole number of things. */
export type Count = z.infer<typeof CountSchema>;

/**
 * A request that carries no fields.
 *
 * Endpoints whose plan entry shows no request body use this rather than
 * accepting anything at all, so that a body sent by mistake is dropped instead
 * of being silently meaningful. Routes should parse `body ?? {}`: a `POST` with
 * no body at all is valid for these endpoints.
 *
 * It is a `z.object`, so it strips unknown properties instead of rejecting
 * them; a field added here later is therefore additive (plan §12.4).
 */
export const EmptyRequestSchema = z.object({});

/** A request body with no fields. */
export type EmptyRequest = z.infer<typeof EmptyRequestSchema>;

/**
 * A successful response that carries no fields — the body is `{}`.
 *
 * Used for the mutations whose plan entry shows no response: logout, leaving a
 * project, deleting an agent, and adding or removing an agent's project
 * membership. `{}` rather than `204 No Content` so that every success on this
 * API has a JSON body a fetch-based client can parse unconditionally, and so a
 * later release can add a field without changing the status code.
 */
export const EmptyResponseSchema = z.object({});

/** A success response body with no fields. */
export type EmptyResponse = z.infer<typeof EmptyResponseSchema>;
