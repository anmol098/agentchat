/**
 * The token service: what a successful login hands out, and what keeps it
 * alive (Plan §7).
 *
 * Two credentials, with deliberately different properties.
 *
 * - An **access token** is a signed JWT with a one-hour life. It is checked
 *   with a signature verification and nothing else — no database round trip on
 *   the hot path — which is exactly why it is short-lived: a stolen one cannot
 *   be revoked, so the only bound on its usefulness is the clock.
 * - A **refresh token** is 32 random bytes, stored only as a SHA-256 digest,
 *   with a ninety-day life, and it is **rotated on every use**. It is checked
 *   against the database, so it *can* be revoked, which is what makes the whole
 *   scheme recoverable.
 *
 * ## Rotation is only worth having if reuse is detected
 *
 * Rotation alone narrows the window in which a stolen refresh token is useful.
 * It does not detect the theft, and on its own it makes the theft *quieter*:
 * the attacker rotates, the legitimate client's copy silently stops working,
 * and the user re-logs in and blames the network.
 *
 * The detection comes from the one thing rotation guarantees: a refresh token
 * is spent exactly once. So a token that is presented after it has already been
 * spent is, necessarily, a second copy. Either the attacker is replaying the
 * one they stole, or the legitimate client is presenting the one the attacker
 * already spent. **Which of the two is presenting it cannot be determined**,
 * and that is the point: the only safe response is to assume the account is
 * compromised, revoke every refresh token the user holds, and force a fresh
 * login through the identity provider — which the attacker cannot complete.
 *
 * See {@link RefreshTokenReuseError} for what a chain is here, and
 * {@link TokenService.refresh} for how it is detected.
 *
 * ## A logout is not a replay
 *
 * The argument above turns on "spent exactly once", and that is true only of a
 * token revoked by *rotation*. A token revoked by a normal logout was never
 * spent: no successor exists, nothing can be redeemed by anybody, and the
 * client presenting it again is almost always the same client retrying after a
 * dropped connection, a re-run script, or a second press of the button.
 *
 * Answering that with the reuse response was actively harmful, and not only in
 * its wording: it revoked every other session the account had, so a benign
 * retry signed the user out of machines that had done nothing, and logged a
 * replay warning that was simply false (T-050). The row could not say which of
 * the two had happened, so {@link refreshTokens.revokedReason} now records it
 * at the moment of revocation. Every operation that sets `revoked_at` sets the
 * reason in the same statement, so the two cannot disagree.
 *
 * ### Why this leaks nothing (`docs/protocol.md` §3.2)
 *
 * The calm answer for a logged-out token is {@link refreshTokenRejected}, byte
 * for byte — the same rejection an unknown string and an expired token get. It
 * is **not** a gentler third message saying "this session was logged out". Such
 * a message would tell anyone holding a harvested string that the string had
 * once been real, which is precisely the oracle §3.2 forbids, and it would be a
 * new one rather than an existing one.
 *
 * Splitting the *revoked* branch is safe for the mirror-image reason: reaching
 * it at all requires presenting a preimage of a stored SHA-256 of 32 CSPRNG
 * bytes, which nobody guesses at any budget. A caller probing with strings sees
 * the one generic rejection, exactly as before. The fix moves a case **into**
 * the indistinguishable class; it never adds to it.
 *
 * The trade is stated rather than buried: an attacker who holds a stolen
 * refresh token *and* a live access token can call `POST /auth/logout` with it,
 * after which the legitimate client's refresh gets the generic rejection rather
 * than the alarm. That attacker already holds both credentials, so the alarm
 * would arrive too late to prevent anything, and its own doctrine — that two
 * live copies exist — is false once the chain is terminal. The alternative is
 * an alarm that fires on ordinary retries until people learn to ignore it.
 *
 * ## What this module does not do
 *
 * It reads no environment (`config.ts` owns that), builds no HTTP responses
 * (the route does), and logs nothing itself (`onReuseDetected` exists so the
 * caller can). It is a service with its dependencies passed in: a store, a
 * secret, and a clock. That is what makes the whole of it testable without a
 * database and without waiting ninety days for an expiry.
 *
 * @module
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ErrorCode,
  type MachineId,
  ProtocolError,
  type SessionId,
  UserId,
} from '@agentchat/protocol';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { refreshTokens } from '../db/schema/identity.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** One second, in milliseconds. */
const SECOND_MS = 1_000;

/**
 * How long an access token is accepted for, in seconds.
 *
 * One hour, fixed by Plan §7. It is not configurable: an access token cannot be
 * revoked, so this number *is* the blast radius of a stolen one, and an
 * operator who could raise it would be widening that radius without being asked
 * to think about it.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * How long a refresh token is accepted for, in seconds.
 *
 * Ninety days, fixed by Plan §7, and reset on every rotation. A user who runs
 * `agentchat` at least once a quarter therefore never logs in again, and one
 * who abandons a machine has its credential expire on its own.
 */
export const REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * Bytes of entropy in a refresh token. Plan §7 says 32; that is 256 bits, which
 * is not guessable and is not going to become guessable.
 */
export const REFRESH_TOKEN_BYTES = 32;

/**
 * Shortest signing secret this service will start with, in characters.
 *
 * HMAC-SHA256 accepts a key of any length and silently gives a weak one weak
 * security, so nothing downstream would ever report a two-character
 * `JWT_SECRET`. Thirty-two characters is the digest width, and below that the
 * key is the weakest part of the construction.
 */
export const MIN_JWT_SECRET_LENGTH = 32;

/**
 * How far the clock is allowed to be wrong, in seconds, in either direction.
 *
 * Every expiry in this module is a comparison between a time written by one
 * process and a time read by another. The reference deployment runs one server
 * (D6), where that is the same clock; a deployment with two replicas behind a
 * load balancer makes it two, and NTP-synchronised hosts still routinely differ
 * by tens of milliseconds — more when one has just booted.
 *
 * Without a tolerance, a token minted on a host whose clock is a few seconds
 * ahead is rejected as "issued in the future" by its sibling, which presents as
 * an intermittent, unreproducible logout. Sixty seconds is the usual figure. It
 * is applied symmetrically:
 *
 * - an `exp` that has just passed is still honoured for this long, which
 *   lengthens an access token's life by a minute in the worst case — negligible
 *   against an hour;
 * - an `iat` this far in the future is accepted rather than treated as forged.
 */
export const CLOCK_SKEW_TOLERANCE_SECONDS = 60;

/** The JOSE header this service signs, and the only one it will verify. */
const JWT_ALGORITHM = 'HS256';

/** Number of dot-separated parts in a JWS compact serialization. */
const JWT_PART_COUNT = 3;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the service is constructed with a secret it will not sign with.
 *
 * A local class with a stable `code`, matching `config.ts` and `db/client.ts`:
 * this is a misconfiguration found at startup, not a request failure, so it is
 * not a {@link ProtocolError} and never becomes an HTTP response.
 */
export class TokenServiceConfigurationError extends Error {
  /** Stable, machine-readable identifier for this failure. */
  public readonly code = 'TOKEN_SERVICE_CONFIGURATION_INVALID';

  public constructor(message: string) {
    super(message);
    this.name = 'TokenServiceConfigurationError';
  }
}

/**
 * Raised when a refresh token that has already been spent is presented again.
 *
 * ## Why the wire code is `AUTH_REQUIRED`
 *
 * The frozen set has no code for "this credential was replayed", and the codes
 * are a public contract that cannot be added to from inside `server/`. Reusing
 * a *different* frozen code — `FORBIDDEN`, say — is worse than it looks: the
 * shipped client clears its stored credentials only on `AUTH_REQUIRED`
 * (`packages/client/src/tokens.ts`), so any other code leaves it holding a dead
 * refresh token that it will keep presenting, turning the one situation where a
 * fresh login is mandatory into a loop. `packages/protocol` states the same
 * intent in prose: an unknown, expired, or already-rotated refresh token
 * answers `AUTH_REQUIRED`.
 *
 * So the code on the wire is `AUTH_REQUIRED`, and the distinction lives in this
 * class instead: `reason` is a stable discriminator for anything inside the
 * server that needs to tell the two apart — a route deciding what to log, an
 * alert on credential theft — without either of them being reachable through a
 * message match. A dedicated wire code would need an addition to
 * `packages/protocol` *and* a matching change to `packages/client`, both
 * outside this task's paths; see the pull request for T-104.
 *
 * ## What "the whole chain" means
 *
 * A chain is every live refresh token belonging to the user, because that is
 * the finest grain the schema can express: `refresh_tokens` has no lineage
 * column, and the one column that could stand in for a device, `machine_id`, is
 * nullable and unpopulated until T-301 creates `machines`.
 *
 * Revoking per user rather than per device is also the answer that stays
 * correct once lineage exists. A replay proves a credential for this account
 * has escaped; it does not prove *which* copy is the attacker's, and it says
 * nothing about whether the same leak — a synced dotfile, a copied home
 * directory, a shared backup — took the other machines' tokens with it.
 * Narrowing this later is a weakening, and should be argued as one.
 */
export class RefreshTokenReuseError extends ProtocolError {
  /**
   * Stable discriminator for server-internal branching. Never sent to a client;
   * the wire carries {@link ErrorCode.AUTH_REQUIRED} and a message.
   */
  public readonly reason = 'refresh_token_reuse';

  /** The account whose tokens were revoked in response. */
  public readonly userId: UserId;

  /**
   * How many live refresh tokens **this** response revoked.
   *
   * At least one when this attempt is what detected the replay. Zero when the
   * account-wide revocation had already happened for the same incident and
   * another client of that account is only now presenting a token it was still
   * holding: there is nothing left to revoke, and one incident should not be
   * counted twice. Distinguishing those is what
   * {@link RefreshTokenRevocationReason} `'reuse_detected'` is for.
   */
  public readonly revokedCount: number;

  /**
   * @param userId - The account the replayed token belonged to.
   * @param revokedCount - How many live tokens this response revoked; see the
   *   property.
   */
  public constructor(userId: UserId, revokedCount: number) {
    super(
      ErrorCode.AUTH_REQUIRED,
      'This refresh token has already been used. Every session for this account has been ' +
        'revoked as a precaution. Sign in again with: agentchat login',
    );
    this.name = 'RefreshTokenReuseError';
    this.userId = userId;
    this.revokedCount = revokedCount;
  }
}

/**
 * Builds the failure for a refresh token that is unknown or expired.
 *
 * Deliberately one message for both. Telling a caller that a token *existed*
 * but expired, as against never having existed, is free information for anybody
 * probing with harvested strings, and the remedy is identical either way.
 *
 * @returns A `ProtocolError` carrying {@link ErrorCode.AUTH_REQUIRED}.
 */
function refreshTokenRejected(): ProtocolError {
  return new ProtocolError(
    ErrorCode.AUTH_REQUIRED,
    'This refresh token is not valid. Sign in again with: agentchat login',
  );
}

/**
 * Builds the failure for an access token that will not verify.
 *
 * The reason — bad signature, wrong algorithm, malformed, expired — is
 * deliberately not distinguished. The caller does the same thing in every case,
 * and the differences are only useful to somebody probing the verifier.
 *
 * @param detail - Internal detail for the `cause` chain, never for the client.
 * @returns A `ProtocolError` carrying {@link ErrorCode.AUTH_REQUIRED}.
 */
function accessTokenRejected(detail: string): ProtocolError {
  return new ProtocolError(
    ErrorCode.AUTH_REQUIRED,
    'The access token is missing, expired, or not valid.',
    { cause: new Error(detail) },
  );
}

// ---------------------------------------------------------------------------
// Access tokens (JWT, HS256)
// ---------------------------------------------------------------------------

/**
 * The claims an access token carries.
 *
 * Plan §7 specifies `{ sub: usr_…, sid?: ses_… }`; `iat` and `exp` are added
 * because a one-hour expiry has to be written down somewhere, and the token is
 * the only place both sides can read it without a round trip.
 *
 * There is no `iss` and no `aud`. Both exist to stop a token minted for one
 * audience being accepted by another, which requires the two to share a signing
 * key. This key is shared with nothing: one server signs, the same server
 * verifies, and a self-hoster's secret is their own. Adding them would be a
 * constant checked against a constant.
 */
export interface AccessTokenClaims {
  /** Subject: the AgentChat user this token authenticates. */
  readonly sub: UserId;

  /**
   * The session this token was minted inside, when it was minted inside one.
   *
   * **Not preserved across a refresh.** `refresh_tokens` has no column for it,
   * so a rotated access token carries no `sid` even if the original did.
   * Anything that needs a session must resolve it from the request rather than
   * trusting this claim to be present (T-301, T-302).
   */
  readonly sid?: SessionId;

  /** Issued at, in whole seconds since the epoch. */
  readonly iat: number;

  /** Expires at, in whole seconds since the epoch. Exclusive. */
  readonly exp: number;
}

/**
 * The JOSE header, parsed strictly.
 *
 * `alg` is *checked* against the one algorithm this service uses, never used to
 * *choose* one. That distinction is the whole of the algorithm-confusion family
 * of attacks: a verifier that reads `alg` from the token accepts `{"alg":
 * "none"}`, and one that dispatches on it accepts an RS256 public key used as
 * an HMAC secret. Here HS256 is a constant and a token that says anything else
 * is rejected before its signature is even computed.
 */
const JoseHeaderSchema = z.object({
  alg: z.literal(JWT_ALGORITHM),
  typ: z.literal('JWT'),
});

/** The payload as it arrives: shape only, before the identifiers are parsed. */
const AccessTokenPayloadSchema = z.object({
  sub: z.string(),
  sid: z.string().optional(),
  iat: z.int(),
  exp: z.int(),
});

/** The encoded header, computed once. Every token this service signs shares it. */
const ENCODED_HEADER = base64UrlEncode(
  Buffer.from(JSON.stringify({ alg: JWT_ALGORITHM, typ: 'JWT' }), 'utf8'),
);

/**
 * Encodes bytes as base64url without padding, as JOSE requires.
 *
 * @param value - The bytes to encode.
 * @returns The unpadded base64url text.
 */
function base64UrlEncode(value: Buffer): string {
  return value.toString('base64url');
}

/**
 * Computes the HMAC over a signing input.
 *
 * @param secret - The signing key.
 * @param signingInput - `<encoded header>.<encoded payload>`.
 * @returns The signature, base64url encoded.
 */
function signHs256(secret: string, signingInput: string): string {
  return base64UrlEncode(createHmac('sha256', secret).update(signingInput, 'utf8').digest());
}

/**
 * Compares two signatures without leaking where they first differ.
 *
 * `timingSafeEqual` throws on a length mismatch, so the lengths are compared
 * first — which is not a leak, because the length of an HS256 signature is a
 * constant and an attacker already knows it.
 *
 * @param expected - The signature this service computed.
 * @param presented - The signature the caller sent.
 * @returns Whether the two are byte-for-byte equal.
 */
function signaturesMatch(expected: string, presented: string): boolean {
  const expectedBytes = Buffer.from(expected, 'base64url');
  const presentedBytes = Buffer.from(presented, 'base64url');

  return (
    expectedBytes.length === presentedBytes.length && timingSafeEqual(expectedBytes, presentedBytes)
  );
}

/**
 * Decodes one base64url JWT segment as JSON.
 *
 * @param segment - The encoded segment.
 * @returns The parsed value, or `undefined` if it is not decodable JSON.
 */
function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Signs an access token.
 *
 * Exported so the device-flow route (T-103) and the auth plugin (T-105) can
 * mint and check tokens without constructing a whole {@link TokenService},
 * and so this half can be tested without a database.
 *
 * @param claims - Subject, optional session, and the two timestamps.
 * @param secret - The signing key. Not validated here; {@link createTokenService}
 *   is where a weak one is refused.
 * @returns The compact JWS serialization.
 */
export function signAccessToken(claims: AccessTokenClaims, secret: string): string {
  // Built explicitly rather than by spreading `claims`, so a field added to the
  // interface is a compile error here — a decision about the wire — rather than
  // something that silently starts appearing in every token.
  const payload: Record<string, string | number> =
    claims.sid === undefined
      ? { sub: claims.sub, iat: claims.iat, exp: claims.exp }
      : { sub: claims.sub, sid: claims.sid, iat: claims.iat, exp: claims.exp };

  const encodedPayload = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signingInput = `${ENCODED_HEADER}.${encodedPayload}`;

  return `${signingInput}.${signHs256(secret, signingInput)}`;
}

/**
 * Verifies an access token and returns its claims.
 *
 * Order matters: the signature is checked before anything in the payload is
 * believed, so a forged token's contents never reach the identifier parsers or
 * the clock comparison.
 *
 * @param token - The compact JWS serialization presented by the caller.
 * @param secret - The signing key.
 * @param now - The instant to judge expiry against. Defaults to the wall clock.
 * @returns The verified claims.
 * @throws {ProtocolError} `AUTH_REQUIRED` for every failure, with the reason in
 *   the `cause` chain and never in the client-visible message.
 */
export function verifyAccessToken(
  token: string,
  secret: string,
  now: Date = new Date(),
): AccessTokenClaims {
  const parts = token.split('.');
  if (parts.length !== JWT_PART_COUNT) {
    throw accessTokenRejected('not a compact JWS serialization');
  }

  const [encodedHeader, encodedPayload, signature] = parts as [string, string, string];

  const header = JoseHeaderSchema.safeParse(decodeSegment(encodedHeader));
  if (!header.success) {
    throw accessTokenRejected('unsupported or malformed JOSE header');
  }

  if (!signaturesMatch(signHs256(secret, `${encodedHeader}.${encodedPayload}`), signature)) {
    throw accessTokenRejected('signature mismatch');
  }

  const payload = AccessTokenPayloadSchema.safeParse(decodeSegment(encodedPayload));
  if (!payload.success) {
    throw accessTokenRejected('malformed payload');
  }

  const { sub, sid, iat, exp } = payload.data;
  if (!UserId.is(sub)) {
    throw accessTokenRejected('subject is not a user id');
  }
  if (sid !== undefined && !isSessionId(sid)) {
    throw accessTokenRejected('session claim is not a session id');
  }

  const nowSeconds = Math.floor(now.getTime() / SECOND_MS);
  if (nowSeconds >= exp + CLOCK_SKEW_TOLERANCE_SECONDS) {
    throw accessTokenRejected('expired');
  }
  if (iat > nowSeconds + CLOCK_SKEW_TOLERANCE_SECONDS) {
    throw accessTokenRejected('issued in the future');
  }

  return sid === undefined ? { sub, iat, exp } : { sub, sid, iat, exp };
}

/**
 * Narrows a string to a session identifier.
 *
 * A tiny wrapper so the import of `SessionId` stays a type-only import at the
 * call site above and the branded cast happens in exactly one place.
 *
 * @param value - The `sid` claim as it arrived.
 * @returns Whether it is a well-formed `ses_` identifier.
 */
function isSessionId(value: string): value is SessionId {
  return /^ses_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

// ---------------------------------------------------------------------------
// Refresh tokens
// ---------------------------------------------------------------------------

/**
 * Mints the secret half of a refresh token.
 *
 * `randomBytes` rather than `Math.random`: this value is the credential, and a
 * predictable one is no credential at all.
 *
 * @returns 32 bytes of CSPRNG output, base64url encoded (43 characters).
 */
export function generateRefreshToken(): string {
  return base64UrlEncode(randomBytes(REFRESH_TOKEN_BYTES));
}

/**
 * Hashes a refresh token for storage and lookup.
 *
 * The **string as presented** is hashed, not the bytes it decodes to, so that
 * the value stored and the value looked up are produced by the same function
 * applied to the same thing. Hashing the decoded bytes would make two different
 * encodings of one token hash alike, which is a way to accidentally accept a
 * token the client never held.
 *
 * SHA-256 rather than a password hash: this input has 256 bits of uniform
 * entropy, so there is no dictionary to run and nothing for a work factor to
 * buy. It is also what the `refresh_tokens_token_hash_is_sha256` constraint
 * requires — 64 lowercase hex characters — which is the database refusing to
 * hold a plaintext token even if this function were bypassed.
 *
 * @param token - The refresh token exactly as issued or presented.
 * @returns The SHA-256 digest as 64 lowercase hex characters.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * The operations that revoke a refresh token, as recorded on the row.
 *
 * - `'rotated'` — spent at `POST /auth/refresh`, with a successor issued in the
 *   same transaction. Presenting it again is a replay.
 * - `'logout'` — revoked at `POST /auth/logout`. Never spent, no successor,
 *   nothing anybody can redeem. Presenting it again is almost always a retry.
 * - `'reuse_detected'` — revoked as part of the account-wide response to a
 *   replay. The token itself may well have been innocent.
 *
 * Kept in step with the `refresh_tokens_revoked_reason_valid` CHECK. Widening
 * this set means widening that constraint, in a migration, first.
 */
export type RefreshTokenRevocationReason = 'rotated' | 'logout' | 'reuse_detected';

/**
 * The reasons this release knows how to read, for narrowing a stored value.
 *
 * A `Set` rather than a repetition of the union so the two cannot drift.
 */
const REVOCATION_REASONS: ReadonlySet<string> = new Set<RefreshTokenRevocationReason>([
  'rotated',
  'logout',
  'reuse_detected',
]);

/**
 * Narrows the raw `revoked_reason` column to something this release understands.
 *
 * `null` covers three cases that all mean the same thing here: the token is
 * live; the row was revoked before the column existed; the row was revoked by a
 * release that does not write it. An unrecognised string is a *newer* release's
 * reason, and is folded into `null` for the same reason — this release cannot
 * know that it is benign.
 *
 * All of them therefore read as `'rotated'` at the point of use, which is
 * exactly how every revoked row was treated before this column existed. See
 * {@link RefreshTokenRecord.revokedReason}.
 *
 * @param value - The column as stored.
 * @returns The reason, or `null` if this release has no reading for it.
 */
function toRevocationReason(value: string | null): RefreshTokenRevocationReason | null {
  return value !== null && REVOCATION_REASONS.has(value)
    ? (value as RefreshTokenRevocationReason)
    : null;
}

/** One row of `refresh_tokens`, as this module sees it. */
export interface RefreshTokenRecord {
  /** Surrogate key. Server-internal; never crosses the wire. */
  readonly id: string;
  /** The account this token authenticates. */
  readonly userId: UserId;
  /** SHA-256 of the token, lowercase hex. The token itself is never stored. */
  readonly tokenHash: string;
  /** When the token was issued. */
  readonly createdAt: Date;
  /** When it stops being accepted. */
  readonly expiresAt: Date;
  /** When it was revoked, by rotation or by logout; `null` while live. */
  readonly revokedAt: Date | null;
  /**
   * Why it was revoked; `null` while live, and on any row this release cannot
   * read a reason from — see {@link toRevocationReason}.
   *
   * **A `null` here, on a row whose `revokedAt` is set, must be read as
   * `'rotated'`.** That is what a row revoked before this column existed means,
   * what a row revoked by an older image running against this schema means, and
   * what every revoked row was already treated as. Reading it any other way
   * would silence the reuse alarm for exactly the rows least able to vouch for
   * themselves.
   */
  readonly revokedReason: RefreshTokenRevocationReason | null;
  /** The machine it was issued to, once `machines` exists (T-301). */
  readonly machineId: MachineId | null;
}

/** The fields supplied when a refresh token row is created. */
export interface NewRefreshToken {
  /** The account the token authenticates. */
  readonly userId: UserId;
  /** SHA-256 of the token, lowercase hex. */
  readonly tokenHash: string;
  /** When the token was issued. */
  readonly createdAt: Date;
  /** When it stops being accepted. */
  readonly expiresAt: Date;
  /** The machine it belongs to, carried through rotations. */
  readonly machineId: MachineId | null;
}

/**
 * The persistence this service needs, expressed as operations rather than as
 * tables.
 *
 * Narrow on purpose. A service given a whole database handle can be tested only
 * against a database, which for the rotation logic means a real PostgreSQL for
 * every case including the ones that are hard to arrange — a token expiring
 * mid-flight, a replay racing a rotation. The interface is small enough that an
 * in-memory implementation is a few dozen lines, and the SQL that backs it is
 * exercised separately by the integration suite.
 *
 * Every method takes the instant it should use rather than reading a clock, for
 * the same reason.
 */
export interface RefreshTokenWriter {
  /**
   * Atomically spends a refresh token: revokes it and returns it, but only if
   * it was live.
   *
   * This is the compare-and-swap the whole scheme rests on. It must be a single
   * statement whose predicate includes `revoked_at IS NULL`, so that two
   * concurrent callers presenting the same token cannot both succeed — the
   * second one's predicate no longer matches once the first has committed.
   * Implementing it as a read followed by a write reintroduces exactly the race
   * rotation exists to close.
   *
   * It records `'rotated'` as the reason, in the same statement that sets
   * `revoked_at`. The two must never be written separately: a row whose reason
   * disagrees with why it was actually revoked is worse than one with no reason
   * at all, because the reason is what suppresses the reuse alarm.
   *
   * @param tokenHash - SHA-256 of the presented token.
   * @param now - The instant to judge liveness against, and to record as
   *   `revoked_at`.
   * @returns The row as it now stands, or `undefined` if it did not exist, was
   *   already revoked, or had expired. The caller distinguishes those three
   *   with {@link RefreshTokenReader.findByHash}.
   */
  claimForRotation(tokenHash: string, now: Date): Promise<RefreshTokenRecord | undefined>;

  /**
   * Revokes a token if it is live, without caring whether it has expired.
   *
   * Logout, and only logout. It differs from {@link claimForRotation} in
   * tolerating an expired token, because refusing to log out a session that has
   * already lapsed would be a distinction without a difference to the caller.
   *
   * It records `'logout'` as the reason, which is what later spares a retried
   * logout the reuse alarm. The `revoked_at IS NULL` predicate is load-bearing
   * for that: a row already revoked by a rotation cannot be relabelled by a
   * logout arriving afterwards, so the label cannot be laundered.
   *
   * @param tokenHash - SHA-256 of the presented token.
   * @param now - The instant to record as `revoked_at`.
   * @returns Whether a live row was revoked.
   */
  revokeByHash(tokenHash: string, now: Date): Promise<boolean>;

  /**
   * Revokes every live refresh token belonging to one account.
   *
   * The response to a replay. See {@link RefreshTokenReuseError} for why the
   * grain is the account.
   *
   * It records `'reuse_detected'`, which marks the innocent bystanders: a
   * client of the same account that later presents one of these rows is told
   * the account was compromised, truthfully, but does not trigger a second
   * account-wide revocation or a second alert for the one incident.
   *
   * @param userId - Whose tokens to revoke.
   * @param now - The instant to record as `revoked_at`.
   * @returns How many rows were revoked.
   */
  revokeAllForUser(userId: UserId, now: Date): Promise<number>;

  /**
   * Records a newly issued refresh token.
   *
   * @param token - The row to insert. `tokenHash` must be a SHA-256 digest;
   *   the database rejects anything else.
   * @returns The stored row.
   */
  insert(token: NewRefreshToken): Promise<RefreshTokenRecord>;
}

/** Read access, separated so the reuse path can state that it only reads. */
export interface RefreshTokenReader {
  /**
   * Finds a token row by its hash, whatever state it is in.
   *
   * @param tokenHash - SHA-256 of the presented token.
   * @returns The row, or `undefined` if no token with that hash was ever
   *   issued.
   */
  findByHash(tokenHash: string): Promise<RefreshTokenRecord | undefined>;
}

/** Everything the token service needs from storage. */
export interface RefreshTokenStore extends RefreshTokenWriter, RefreshTokenReader {
  /**
   * Runs `work` so that either all of its writes happen or none of them do.
   *
   * Rotation is a revoke *and* an issue, and a failure between the two has two
   * unacceptable outcomes: revoke-then-crash logs the user out while their
   * client still holds a token that looks fine, and issue-then-crash leaves two
   * live tokens, which is the state reuse detection interprets as theft. Both
   * are prevented by there being no moment at which only one of the two has
   * happened.
   *
   * @param work - The unit of work. Throwing from it must roll back.
   * @returns Whatever `work` returned.
   */
  transaction<T>(work: (tx: RefreshTokenWriter & RefreshTokenReader) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// The Drizzle-backed store
// ---------------------------------------------------------------------------

/**
 * The subset of Drizzle's query builder this store uses.
 *
 * Written as a `Pick` of `PgDatabase` rather than of `NodePgDatabase` so that
 * the database handle and a transaction handle — which are different types with
 * different schema generics — both satisfy it.
 */
type QueryRunner = Pick<PgDatabase<PgQueryResultHKT>, 'select' | 'insert' | 'update'>;

/** The row shape Drizzle returns for `refresh_tokens`. */
type RefreshTokenRow = typeof refreshTokens.$inferSelect;

/**
 * Converts a stored row into the service's view of it.
 *
 * The identifiers are parsed rather than cast. The `CHECK` constraints make a
 * malformed one impossible through this application, but a row can also arrive
 * from a migration, a fixture or a hand-written `psql` session, and a branded
 * type asserted without a check is a lie the rest of the server would believe.
 *
 * @param row - The row as Drizzle returned it.
 * @returns The record.
 */
function toRecord(row: RefreshTokenRow): RefreshTokenRecord {
  return {
    id: row.id,
    userId: UserId.parse(row.userId),
    tokenHash: row.tokenHash,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    revokedReason: toRevocationReason(row.revokedReason),
    // `MachineId.parse` is deliberately not called: `machines` does not exist
    // until T-301, the column's own CHECK already pins the `mch_` shape, and
    // this value is carried through rotations rather than interpreted here.
    machineId: row.machineId as MachineId | null,
  };
}

/**
 * The earliest `expires_at` still considered live.
 *
 * @param now - The current instant.
 * @returns `now` less the skew tolerance.
 */
function livenessCutoff(now: Date): Date {
  return new Date(now.getTime() - CLOCK_SKEW_TOLERANCE_SECONDS * SECOND_MS);
}

/**
 * Builds the reader and writer over one Drizzle query runner.
 *
 * Factored out so the database handle and a transaction handle get exactly the
 * same implementation; the only difference between them is which connection the
 * statements run on.
 *
 * @param runner - A Drizzle database or transaction.
 * @returns The store operations bound to that runner.
 */
function operationsOn(runner: QueryRunner): RefreshTokenWriter & RefreshTokenReader {
  return {
    async claimForRotation(tokenHash: string, now: Date): Promise<RefreshTokenRecord | undefined> {
      // One statement. The predicate is the lock: PostgreSQL serialises the two
      // updates on the row, and the loser re-evaluates `revoked_at IS NULL`
      // against the winner's committed value and matches nothing.
      const rows = await runner
        .update(refreshTokens)
        // The reason travels with `revoked_at` in one `SET`, so there is no
        // interval in which the row says it was revoked without saying why.
        .set({ revokedAt: now, revokedReason: 'rotated' })
        .where(
          and(
            eq(refreshTokens.tokenHash, tokenHash),
            isNull(refreshTokens.revokedAt),
            gt(refreshTokens.expiresAt, livenessCutoff(now)),
          ),
        )
        .returning();

      const row = rows[0];
      return row === undefined ? undefined : toRecord(row);
    },

    async revokeByHash(tokenHash: string, now: Date): Promise<boolean> {
      const rows = await runner
        .update(refreshTokens)
        .set({ revokedAt: now, revokedReason: 'logout' })
        .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)))
        .returning({ id: refreshTokens.id });

      return rows.length > 0;
    },

    async revokeAllForUser(userId: UserId, now: Date): Promise<number> {
      const rows = await runner
        .update(refreshTokens)
        .set({ revokedAt: now, revokedReason: 'reuse_detected' })
        .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
        .returning({ id: refreshTokens.id });

      return rows.length;
    },

    async insert(token: NewRefreshToken): Promise<RefreshTokenRecord> {
      const rows = await runner
        .insert(refreshTokens)
        .values({
          userId: token.userId,
          tokenHash: token.tokenHash,
          createdAt: token.createdAt,
          expiresAt: token.expiresAt,
          machineId: token.machineId,
        })
        .returning();

      const row = rows[0];
      if (row === undefined) {
        // `INSERT ... RETURNING` returns the row it inserted or raises. An
        // empty result means the driver contract has been broken, which is not
        // something to paper over with a cast.
        throw new ProtocolError(
          ErrorCode.INTERNAL,
          'The database accepted a refresh token without returning it.',
        );
      }

      return toRecord(row);
    },

    async findByHash(tokenHash: string): Promise<RefreshTokenRecord | undefined> {
      const rows = await runner
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, tokenHash))
        .limit(1);

      const row = rows[0];
      return row === undefined ? undefined : toRecord(row);
    },
  };
}

/**
 * A Drizzle handle that can open a transaction, whatever schema it was built
 * with.
 *
 * `Tx` is inferred from the handle rather than written down. Drizzle gives a
 * transaction a type parameterised by the caller's whole schema, so naming it
 * here would pin this signature to one schema and make the store unusable from
 * any module that built its `drizzle()` handle with a different one — which the
 * integration suite does, deliberately, since it only needs two tables.
 * Constraining `Tx` to {@link QueryRunner} is enough: the store only ever
 * selects, inserts and updates on it.
 */
interface TransactionalRunner<Tx extends QueryRunner> extends QueryRunner {
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
}

/**
 * The Drizzle implementation of {@link RefreshTokenStore}.
 *
 * @param db - The database handle. Its transaction is a real SQL transaction,
 *   which is what makes rotation atomic.
 * @returns A store the token service can be built on.
 */
export function createDrizzleRefreshTokenStore<Tx extends QueryRunner>(
  db: TransactionalRunner<Tx>,
): RefreshTokenStore {
  return {
    ...operationsOn(db),

    transaction<T>(work: (tx: RefreshTokenWriter & RefreshTokenReader) => Promise<T>): Promise<T> {
      // The same operations, bound to the transaction's connection instead of
      // the pool's. Nothing else about them differs.
      return db.transaction((tx) => work(operationsOn(tx)));
    },
  };
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/** A freshly minted pair, plus when each half stops working. */
export interface IssuedTokens {
  /** The signed JWT. */
  readonly accessToken: string;
  /** The refresh token, in plaintext. This is the only time it exists. */
  readonly refreshToken: string;
  /** When {@link accessToken} expires. */
  readonly accessTokenExpiresAt: Date;
  /** When {@link refreshToken} expires, absent a rotation. */
  readonly refreshTokenExpiresAt: Date;
}

/** What a caller supplies to mint a first pair. */
export interface IssueTokensInput {
  /** The account being logged in. */
  readonly userId: UserId;
  /**
   * The session to stamp into the access token, if there is one.
   *
   * Almost always absent: a session is registered after login, so the token
   * that authorises registering it cannot name it. See {@link AccessTokenClaims.sid}.
   */
  readonly sessionId?: SessionId | undefined;
  /** The machine this credential belongs to, once machines exist (T-301). */
  readonly machineId?: MachineId | undefined;
}

/** Options for {@link createTokenService}. */
export interface TokenServiceOptions {
  /** Where refresh tokens live. */
  readonly store: RefreshTokenStore;

  /**
   * The HS256 signing key, from `JWT_SECRET`.
   *
   * Changing it invalidates every outstanding access token, which is the
   * emergency lever when one is believed stolen. Refresh tokens survive it,
   * because they are not signed with anything.
   */
  readonly jwtSecret: string;

  /** Reads the current time. Injected so expiry is testable. */
  readonly now?: (() => Date) | undefined;

  /**
   * Called when a replayed refresh token has caused an account's tokens to be
   * revoked.
   *
   * This module logs nothing itself — it has no logger and should not acquire
   * one — but a credential replay is the single most interesting security event
   * this server can observe, and it must not be reduced to a 401 in an access
   * log. The caller wires this to the request logger.
   *
   * Failures are swallowed: a logger that throws must not turn a handled
   * security response into a 500.
   */
  readonly onReuseDetected?: ((event: RefreshTokenReuseEvent) => void) | undefined;
}

/** What {@link TokenServiceOptions.onReuseDetected} is told. */
export interface RefreshTokenReuseEvent {
  /** The account whose tokens were revoked. */
  readonly userId: UserId;
  /** How many live tokens the revocation covered. */
  readonly revokedCount: number;
  /** When the replayed token had originally been spent. */
  readonly originallyRevokedAt: Date;
}

/** Issuing, rotating and revoking credentials. */
export interface TokenService {
  /**
   * Mints a fresh pair for a user who has just proved who they are.
   *
   * Starts a new chain: nothing the user already holds is revoked, so logging
   * in on a second machine does not sign them out of the first.
   *
   * @param input - Who the tokens are for.
   * @returns The pair. The refresh token is returned in plaintext here and
   *   never again; only its digest is stored.
   */
  issue(input: IssueTokensInput): Promise<IssuedTokens>;

  /**
   * Spends a refresh token and issues its replacement, atomically.
   *
   * @param refreshToken - The token the client is presenting.
   * @returns A new pair.
   * @throws {RefreshTokenReuseError} If the token had already been *spent*, or
   *   belongs to an account already locked down by an earlier detection. In the
   *   first case every live token of that account is revoked before this is
   *   thrown; in the second there is nothing left to revoke.
   * @throws {ProtocolError} `AUTH_REQUIRED` if the token is unknown, expired, or
   *   was revoked by a logout — one message for all three, deliberately. See
   *   the module note on §3.2.
   */
  refresh(refreshToken: string): Promise<IssuedTokens>;

  /**
   * Revokes a refresh token.
   *
   * Idempotent: revoking a token that is already revoked, expired, or unknown
   * is a success, as `LogoutResponseSchema` promises. In particular it does
   * **not** trip reuse detection — logging out twice is a client being careful,
   * not an attack, and answering it by revoking the account's other sessions
   * would be a self-inflicted denial of service.
   *
   * Neither does *redeeming* the logged-out token at {@link refresh}, which is
   * the same client being careful over a connection that dropped. It gets the
   * ordinary rejection; see the module note.
   *
   * @param refreshToken - The token to revoke.
   * @returns Whether a live token was actually revoked. Diagnostic only.
   */
  logout(refreshToken: string): Promise<boolean>;

  /**
   * Verifies an access token against this service's secret and clock.
   *
   * @param accessToken - The bearer credential from the request.
   * @returns The verified claims.
   * @throws {ProtocolError} `AUTH_REQUIRED` for every failure.
   */
  verifyAccessToken(accessToken: string): AccessTokenClaims;
}

/**
 * Builds the token service.
 *
 * @param options - See {@link TokenServiceOptions}.
 * @returns The service.
 * @throws {TokenServiceConfigurationError} If the signing secret is too short
 *   to be worth signing with.
 */
export function createTokenService(options: TokenServiceOptions): TokenService {
  const { store, jwtSecret } = options;

  if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    // The secret itself is never in the message: configuration errors end up in
    // CI logs and issue reports.
    throw new TokenServiceConfigurationError(
      `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters; ` +
        `the configured value is ${jwtSecret.length}. Generate one with: openssl rand -hex 32`,
    );
  }

  const clock = options.now ?? ((): Date => new Date());
  const onReuseDetected = options.onReuseDetected;

  /**
   * Mints an access token and a refresh token row for one user.
   *
   * @param writer - Where to record the refresh token. A transaction during a
   *   rotation, the store itself during a first issue.
   * @param input - Subject, optional session, machine.
   * @param now - The instant both expiries are measured from.
   * @returns The plaintext pair.
   */
  async function mint(
    writer: RefreshTokenWriter,
    input: IssueTokensInput,
    now: Date,
  ): Promise<IssuedTokens> {
    const issuedAtSeconds = Math.floor(now.getTime() / SECOND_MS);
    const accessTokenExpiresAt = new Date((issuedAtSeconds + ACCESS_TOKEN_TTL_SECONDS) * SECOND_MS);
    const refreshTokenExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * SECOND_MS);

    const claims: AccessTokenClaims =
      input.sessionId === undefined
        ? {
            sub: input.userId,
            iat: issuedAtSeconds,
            exp: issuedAtSeconds + ACCESS_TOKEN_TTL_SECONDS,
          }
        : {
            sub: input.userId,
            sid: input.sessionId,
            iat: issuedAtSeconds,
            exp: issuedAtSeconds + ACCESS_TOKEN_TTL_SECONDS,
          };

    const refreshToken = generateRefreshToken();

    await writer.insert({
      userId: input.userId,
      tokenHash: hashRefreshToken(refreshToken),
      createdAt: now,
      expiresAt: refreshTokenExpiresAt,
      machineId: input.machineId ?? null,
    });

    return {
      accessToken: signAccessToken(claims, jwtSecret),
      refreshToken,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
    };
  }

  /**
   * Decides what a token that could not be spent actually was.
   *
   * Reached only when {@link RefreshTokenWriter.claimForRotation} matched
   * nothing, which is true of several different situations. The row is read
   * back to tell them apart:
   *
   * - no row — a string that was never a token here;
   * - a live but expired row — ninety days of not running `agentchat`;
   * - a row revoked by a **logout** — a client retrying a logout it already
   *   completed. Nothing was ever spent and no successor exists, so there is
   *   nothing to alarm about;
   * - a row revoked by a **rotation**, or by a release too old to say — **a
   *   replay**. The token was spent, so a second presentation means a second
   *   copy exists;
   * - a row revoked by an earlier **reuse detection** — a surviving client of
   *   an account that has already been locked down.
   *
   * The first three answer with {@link refreshTokenRejected}, byte for byte.
   * That is the §3.2 property and it is deliberate: see the module note. The
   * last two answer with the alarm, but only the *replay* branch revokes and
   * reports, because the account-wide revocation for that incident has already
   * happened and one incident should not produce one alert per client.
   *
   * The revocation that answers a replay runs in its own transaction and is
   * committed *before* the error is thrown, which is the whole reason this is
   * not done inside the rotation transaction: throwing there would roll the
   * revocation back and leave the attacker's chain alive.
   *
   * @param tokenHash - SHA-256 of the presented token.
   * @param now - The instant this attempt is being judged at.
   * @returns Never; always throws.
   * @throws {RefreshTokenReuseError} For a replay, and for a token already
   *   revoked by an earlier detection.
   * @throws {ProtocolError} `AUTH_REQUIRED` otherwise, with the one generic
   *   message.
   */
  async function rejectUnspendable(tokenHash: string, now: Date): Promise<never> {
    const existing = await store.findByHash(tokenHash);

    if (existing === undefined || existing.revokedAt === null) {
      // Unknown, or known and merely expired. One answer for both; see
      // `refreshTokenRejected`.
      throw refreshTokenRejected();
    }

    if (existing.revokedReason === 'logout') {
      // A retried logout. The chain is terminal — this token was never spent,
      // so no successor exists and nobody, legitimate or otherwise, can redeem
      // anything from it — and the client that sent it is overwhelmingly likely
      // to be the one that logged out.
      //
      // The same generic rejection as an unknown string, character for
      // character, and no revocation and no event: revoking here is what used
      // to sign the account's *other* machines out over a dropped connection.
      throw refreshTokenRejected();
    }

    if (existing.revokedReason === 'reuse_detected') {
      // Already answered. This row was collateral from an earlier detection on
      // this account, so the honest thing to tell its holder is the alarm — the
      // account really was locked down — but there is nothing left to revoke
      // and nothing new to report. Cascading again would multiply one incident
      // into one alert per surviving client.
      throw new RefreshTokenReuseError(existing.userId, 0);
    }

    // `'rotated'`, or `null` from a row this release cannot read a reason from:
    // a row revoked before the column existed, or by an older image running
    // against this schema. Both mean "spent by a rotation", which is how every
    // revoked row was treated before there was a reason at all, so the upgrade
    // changes nothing for them and an ambiguous row still fails towards the
    // alarm rather than away from it.
    const revokedCount = await store.revokeAllForUser(existing.userId, now);

    if (onReuseDetected !== undefined) {
      try {
        onReuseDetected({
          userId: existing.userId,
          revokedCount,
          originallyRevokedAt: existing.revokedAt,
        });
      } catch {
        // A logger that throws must not turn a correctly handled security
        // response into a 500, and must not stop the chain being revoked.
      }
    }

    throw new RefreshTokenReuseError(existing.userId, revokedCount);
  }

  return {
    async issue(input: IssueTokensInput): Promise<IssuedTokens> {
      return await mint(store, input, clock());
    },

    async refresh(refreshToken: string): Promise<IssuedTokens> {
      const tokenHash = hashRefreshToken(refreshToken);
      const now = clock();

      // One transaction covering both halves of the rotation. A crash anywhere
      // inside it rolls back to "the presented token is still live", which is
      // the only safe of the three possible outcomes: the client retries and
      // succeeds. The alternatives — a revoked token with no successor, or two
      // live tokens — respectively log the user out while their credential
      // still looks valid, and manufacture the exact state reuse detection
      // reads as theft.
      const rotated = await store.transaction(async (tx) => {
        const spent = await tx.claimForRotation(tokenHash, now);
        if (spent === undefined) {
          return undefined;
        }

        // The machine follows the chain, so that revoking one laptop stays
        // possible once `machines` exists (T-301) and rotation does not quietly
        // erase which device a credential belongs to.
        return await mint(
          tx,
          { userId: spent.userId, machineId: spent.machineId ?? undefined },
          now,
        );
      });

      return rotated ?? (await rejectUnspendable(tokenHash, now));
    },

    async logout(refreshToken: string): Promise<boolean> {
      return await store.revokeByHash(hashRefreshToken(refreshToken), clock());
    },

    verifyAccessToken(accessToken: string): AccessTokenClaims {
      return verifyAccessToken(accessToken, jwtSecret, clock());
    },
  };
}
