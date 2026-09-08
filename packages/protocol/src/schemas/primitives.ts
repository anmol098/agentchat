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
 *
 * It is also, character for character, the `agents_name_format` check in
 * `server/src/db/schema/agents.ts`, which embeds this same source string. So
 * unlike the username and slug grammars this one has never disagreed with its
 * storage, and there is nothing here to reconcile: `backend--api` and
 * `backend-` are names the protocol accepts and the database stores. Whether
 * they *should* be is a product question about agent names, and narrowing this
 * pattern to answer it would be a breaking change made for tidiness rather than
 * to close a fault.
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
 * The project-slug grammar: `^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,31}$` — runs
 * of lowercase alphanumerics joined by *single* hyphens, 1–32 characters, with
 * no leading or trailing hyphen.
 *
 * The plan requires a unique `slug` on `projects` and lets `POST /projects`
 * supply one, but never states its shape. The one place the shape *is* stated
 * is the `projects_slug_format` check in `server/src/db/schema/identity.ts`,
 * which spells the same set as `^[a-z0-9]+(-[a-z0-9]+)*$`. That constraint is
 * what a slug is ultimately judged by — it is compiled into the database when
 * the migration runs and no amount of client-side agreement can talk it out of
 * a rejection — so it is the authority this pattern transcribes, and the
 * equivalence of the two spellings is asserted by test rather than argued.
 *
 * ## Why this is no longer the agent-name pattern
 *
 * Until T-025 this was `^[a-z0-9][a-z0-9-]{0,31}$`, {@link AGENT_NAME_PATTERN}
 * character for character, with a doc-comment arguing that "one grammar is one
 * thing for a user to learn instead of two" and a test asserting the two
 * sources were equal. The argument was about ergonomics and it was a reasonable
 * one; what it missed is that the two grammars answer to different authorities.
 * The agent-name pattern is stated verbatim in plan §2 and is transcribed
 * verbatim into `agents_name_format`, so all three agree. The slug pattern was
 * a copy of it made in the absence of a rule, and a copy of the wrong rule:
 * `payments-` and `a--b` satisfied it and were refused by the check constraint,
 * so a caller who sent one passed every client-side check and got a constraint
 * violation from storage — a 500 for a request the server could see was
 * malformed. T-107 hit exactly that and had to re-state the database's grammar
 * in `server/src/services/projects.ts` to answer a `BAD_REQUEST` instead.
 *
 * Keeping the coupling would have meant narrowing the agent-name pattern too,
 * which contradicts the plan, breaks the wire contract a second time, and
 * outlaws `backend--api` — a name nothing has ever rejected — to fix a defect
 * agent names do not have. Equal today is not the same as meaning the same
 * thing: these two are alike because a slug was modelled on a name, not because
 * one rule governs both. They are now stated separately, each pinned to its own
 * database constraint, and each free to move when its own authority moves.
 *
 * What the ergonomic argument was really reaching for survives anyway. Every
 * slug this pattern accepts is still a valid agent name — the accepted set is a
 * strict subset of {@link AGENT_NAME_PATTERN}'s — so nothing a user learns
 * about one misleads them about the other in the direction that matters, and
 * the rule now reads identically to {@link USERNAME_PATTERN}'s, which is the
 * other handle a user types.
 *
 * ## Why the ceiling stays at 32 when the database allows 64
 *
 * The caps disagree on purpose, and only in the safe direction. What has to
 * hold is that a slug the protocol accepts is one the database will store; a
 * protocol ceiling *below* the storage ceiling satisfies that with room to
 * spare, and it is the ceiling a human is actually held to. 32 is what a slug
 * is for: it is typed into a shell (`agentchat project init payments`),
 * committed to `.agentchat/config.json`, and read aloud in a stand-up. Raising
 * it to 64 to make the two numbers match would widen the product's rule to
 * whatever the storage column happened to permit, on no evidence that anyone
 * wants a 64-character slug, and would leave the wire contract with no headroom
 * against the column at all.
 */
export const PROJECT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,31}$/;

/**
 * A project slug: lowercase letters and digits joined by single hyphens, 1–32
 * characters, starting and ending with a letter or digit.
 *
 * @see {@link PROJECT_SLUG_PATTERN} for the grammar, why it is the database's
 *   rule, and why it is no longer the agent-name grammar.
 */
export const ProjectSlugSchema = z.string().regex(PROJECT_SLUG_PATTERN, {
  error:
    'Expected a project slug of 1 to 32 lowercase letters and digits joined by single hyphens, starting and ending with a letter or digit.',
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
 * The username grammar: `^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$` — runs of
 * lowercase alphanumerics joined by *single* hyphens, 1–39 characters, with no
 * leading or trailing hyphen.
 *
 * Plan §2 says `username` is the GitHub login, lowercased, and that
 * `@alice/backend` is `username` + `/` + agent name. It never states the
 * grammar, so this pattern is GitHub's own rule, transcribed: a login "may only
 * contain alphanumeric characters or single hyphens, and cannot begin or end
 * with a hyphen", with a 39-character ceiling. It is the same rule GitHub's
 * signup form applies and the same one the widely embedded
 * `github-username-regex` encodes.
 *
 * It is also, character for character in what it accepts, the
 * `users_username_format` constraint in `server/src/db/schema/identity.ts`,
 * which spells the same set as `^[a-z0-9]+(-[a-z0-9]+)*$` plus
 * `char_length(...) <= 39`. The two spellings are proved equivalent by
 * exhaustive test rather than by reading, because the point of this grammar is
 * that both sides accept exactly the same names.
 *
 * ## Why not the looser pattern that used to be here
 *
 * Until T-016 this was `^[a-z0-9][a-z0-9-]{0,38}$`, which is the agent-name
 * pattern with a bigger ceiling: it forbids a leading hyphen but allows
 * `alice-` and `alice--bob`. Its doc-comment claimed the looseness was a
 * deliberate identity-provider-agnostic choice, on the grounds that only the
 * no-consecutive-hyphens clause was "GitHub's alone". That was not a real
 * distinction — the leading-hyphen rule, the trailing-hyphen rule and the
 * single-hyphen rule are three readings of one sentence in GitHub's validator,
 * and the 39-character ceiling the pattern *did* keep is from the same
 * sentence. Being provider-agnostic about one clause while inheriting the other
 * two is not a policy, it is a transcription error.
 *
 * What the looseness actually bought was a name every client would accept and
 * the database would then refuse, turning a validation error into a constraint
 * violation — a 500 where the user should have been told what is wrong.
 *
 * ## What this does not fix
 *
 * GitHub's rule governs *registration*, not the logins that already exist:
 * `Alice-` (user 2850080) is a live account with a trailing hyphen, predating
 * the current validator. Lowercased, it fails this pattern and the database
 * constraint alike. Narrowing here turns that from a server fault into a clean
 * rejection; it does not let such a user sign in. Doing that would mean
 * widening both sides, and is a product decision, not a schema tidy-up.
 *
 * What matters to the protocol regardless is that a username contains neither
 * `@` nor `/`, so a handle can be split without ambiguity.
 */
export const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;

/**
 * A user's handle-forming name, lowercase — the `alice` in `@alice/backend`.
 *
 * @see {@link USERNAME_PATTERN} for the grammar and its provenance.
 */
export const UsernameSchema = z.string().regex(USERNAME_PATTERN, {
  error:
    'Expected a username of 1 to 39 lowercase letters and digits joined by single hyphens, starting and ending with a letter or digit.',
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

/**
 * Wraps a list response in an object rather than returning a bare array.
 *
 * A bare JSON array has nowhere to put anything that is not an element, so
 * adding a pagination cursor to one later changes the response's top-level
 * type. Under the additive-only compatibility rule (plan §12.4) that is a
 * breaking change requiring a major version, which is a steep price for a
 * feature every one of these endpoints will eventually want: a project's agent
 * list is unbounded in principle, and `GET /messages` is already specified with
 * a limit.
 *
 * The envelope costs one level of nesting now and makes paging additive later.
 * No cursor field is defined yet, because adding an optional field to an object
 * is exactly the change this shape makes safe.
 *
 * @param item Schema for a single element.
 */
export function listResponse<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item) });
}

/** A success response body with no fields. */
export type EmptyResponse = z.infer<typeof EmptyResponseSchema>;
