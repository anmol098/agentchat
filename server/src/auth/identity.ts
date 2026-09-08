/**
 * The identity-provider seam: what a login needs, in RFC 8628's vocabulary and
 * nobody's product name.
 *
 * ## Why this is its own module
 *
 * Plan §7 states that "nothing in the protocol depends on GitHub", and D4 makes
 * GitHub the *reference* provider rather than part of the contract. A promise
 * like that is worth what enforces it. Keeping these declarations in
 * `./github.ts` would have made every consumer of a login import a module named
 * after one provider, so "nothing assumes GitHub" would have been true only of
 * the identifiers and false of the import graph — the sort of distinction that
 * survives exactly until the next person adds a second consumer.
 *
 * So the seam lives here and `./github.ts` implements it. `routes/auth.ts`
 * imports this module and never that one; a self-hoster pointing at a different
 * provider writes a second implementation of {@link IdentityProvider} and
 * changes one line of wiring in `index.ts`. No route, no schema, no error code
 * and no test moves.
 *
 * ## The vocabulary is the RFC's
 *
 * Device code, user code, authorization pending, slow down, expired, denied:
 * every name below comes from RFC 8628, which GitHub implements rather than
 * defines. That is what lets the four ordinary outcomes stay four distinct
 * things all the way out to four distinct error codes on the wire, instead of
 * being flattened into "not yet" by a provider-shaped abstraction.
 *
 * @module
 */

/**
 * Seconds a client must add to its polling interval on `slow_down`.
 *
 * RFC 8628 §3.5: on that error the client "MUST increase the time between
 * polling requests by 5 seconds". It lives here rather than in a provider
 * implementation because it is the RFC's number, not any one provider's, and
 * both the provider adapter and the route's own rate limiter apply it.
 */
export const SLOW_DOWN_INCREMENT_SECONDS = 5;

/**
 * Polling interval assumed when a provider states none, in seconds.
 *
 * RFC 8628 §3.2 makes `interval` optional and specifies 5 seconds as its
 * default.
 */
export const DEFAULT_INTERVAL_SECONDS = 5;

/**
 * The device authorization grant, in the vocabulary of RFC 8628 rather than of
 * any one provider.
 */
export interface DeviceAuthorizationGrant {
  /**
   * The provider's device code: the secret half of the authorization.
   *
   * **This never leaves the server.** `routes/auth.ts` keeps it alongside its
   * own device code and replays it upstream; the client is given an AgentChat
   * credential instead, so nothing on the wire is provider-shaped. Never log
   * this value.
   */
  readonly deviceCode: string;

  /** The short code the human types in the browser, e.g. `ABCD-1234`. */
  readonly userCode: string;

  /** Where the human enters {@link userCode}. */
  readonly verificationUri: string;

  /** Seconds to wait between polls, at minimum. */
  readonly interval: number;

  /** Seconds until {@link deviceCode} stops being redeemable. */
  readonly expiresIn: number;
}

/**
 * A person as the identity provider describes them, normalised for storage.
 *
 * Deliberately not a database row and deliberately not a GitHub profile: four
 * fields any OAuth-shaped provider can supply, in the form the `users` table
 * accepts.
 */
export interface ProviderIdentity {
  /**
   * The provider's stable identifier for this person. Stored in the column
   * plan §2 names `users.github_id`, whose name is the schema's and not this
   * module's business.
   *
   * The subject rather than the login, because a login can be renamed and
   * handed to somebody else while the subject cannot.
   */
  readonly subject: string;

  /**
   * The handle-forming name, **lowercased** by the provider adapter so no
   * caller has to remember to (plan §2; the `users_username_format` check
   * rejects anything else).
   */
  readonly username: string;

  /** Human-readable name for display. Falls back to the login when unset. */
  readonly displayName: string;

  /** Primary email, or `null` when the provider exposes none. */
  readonly email: string | null;
}

/**
 * The state of a device authorization when it was last polled.
 *
 * Five states, each of which a caller acts on differently — which is precisely
 * why they are distinguished rather than collapsed into "not yet".
 */
export type DeviceAuthorizationOutcome =
  /** The user approved. This is the only outcome carrying an identity. */
  | { readonly status: 'approved'; readonly identity: ProviderIdentity }
  /** Still waiting on the user. Poll again at the current interval. */
  | { readonly status: 'pending' }
  /** Polled too fast. Poll again no sooner than `interval` seconds. */
  | { readonly status: 'slow_down'; readonly interval: number }
  /** The user refused. Terminal; the flow must not be retried silently. */
  | { readonly status: 'denied' }
  /** The device code expired or was already redeemed. Terminal. */
  | { readonly status: 'expired' };

/**
 * The identity provider seam: everything the login flow needs, and nothing
 * about how it is satisfied.
 *
 * Implementations must not throw for the ordinary outcomes above. A thrown
 * `ProtocolError` means the *provider* failed — it was unreachable, answered
 * nonsense, or refused the server's own credentials — which is a server fault
 * and is reported as `INTERNAL`.
 */
export interface IdentityProvider {
  /**
   * Begins a device authorization.
   *
   * @param signal - Aborts the upstream call; an implementation's own timeout
   *   applies regardless.
   * @returns The grant to show the user and to poll with.
   * @throws {ProtocolError} `INTERNAL` if the provider is unreachable,
   *   misconfigured, or answered something unparseable.
   */
  startDeviceAuthorization(signal?: AbortSignal): Promise<DeviceAuthorizationGrant>;

  /**
   * Asks whether a device authorization has been approved yet.
   *
   * @param deviceCode - The provider's device code from
   *   {@link DeviceAuthorizationGrant.deviceCode}. A credential; never log it.
   * @param signal - Aborts the upstream call.
   * @returns What the provider said, as a {@link DeviceAuthorizationOutcome}.
   * @throws {ProtocolError} `INTERNAL` for a provider or configuration failure,
   *   never for one of the four ordinary outcomes.
   */
  redeemDeviceAuthorization(
    deviceCode: string,
    signal?: AbortSignal,
  ): Promise<DeviceAuthorizationOutcome>;
}
