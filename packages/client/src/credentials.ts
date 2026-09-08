/**
 * Where the tokens live — as an interface, and nowhere else.
 *
 * This package performs **no filesystem access** (plan §5). It is MIT and meant
 * to be embedded in harnesses, servers, and browsers, none of which agree on
 * what "the config directory" means or on whether one exists. So the client
 * declares what it needs from a credential store and the host supplies it: the
 * `agentchat` CLI with a 0600 file under `~/.agentchat` (T-204), a hosted
 * integration with a row in its own database, a test with
 * {@link InMemoryCredentialStore}.
 *
 * ## The store is the source of truth, not a cache
 *
 * The client reads the store before every authenticated request rather than
 * holding tokens in memory. That is what lets two `agentchat` processes share
 * one account: when one of them rotates the refresh token, the other sees the
 * new pair on its next request instead of spending a token that has already been
 * revoked. See `./tokens.ts` for why that matters so much.
 *
 * An implementation that finds the per-request read expensive may cache
 * internally, but it must return what {@link CredentialStore.save} last wrote —
 * including a `save` made by a different process, if it shares that storage.
 *
 * @module
 */

/**
 * The pair of tokens an authenticated client holds.
 *
 * Both are opaque strings (`OpaqueToken` in the protocol schemas) and neither
 * may ever be logged, printed, or put in an error message.
 */
export interface Credentials {
  /** Short-lived bearer credential, sent on every authenticated request. */
  readonly accessToken: string;

  /**
   * Long-lived credential, **rotated on every use**. The server revokes the
   * whole chain if a spent one is presented again, so a store must never hand
   * back a value older than the last successful {@link CredentialStore.save}.
   */
  readonly refreshToken: string;
}

/**
 * Persistence for {@link Credentials}, implemented by the host application.
 *
 * All three methods are asynchronous so a store backed by a file, a keychain, or
 * a network service needs no adapter. A synchronous implementation returns an
 * already-resolved promise.
 *
 * Implementations must not throw for the ordinary cases: "nobody has logged in"
 * is `load()` resolving to `null`, and clearing an already-empty store is a
 * success. A genuine I/O failure should throw a `ProtocolError`, per subagent
 * protocol §7.3.
 */
export interface CredentialStore {
  /**
   * Reads the current credentials.
   *
   * @returns The stored pair, or `null` when there is none — which the client
   *   surfaces as `AUTH_REQUIRED` rather than as a store failure.
   */
  load(): Promise<Credentials | null>;

  /**
   * Replaces the stored credentials with a newly issued pair.
   *
   * Called after login and after every token refresh. Both tokens change
   * together and must be written atomically: a store that persists the access
   * token and then fails to persist the refresh token has stranded the account
   * until the user logs in again.
   *
   * @param credentials - The pair to persist.
   */
  save(credentials: Credentials): Promise<void>;

  /**
   * Forgets the stored credentials.
   *
   * Called on logout, and by the client when a refresh is definitively rejected
   * — keeping a credential the server has already revoked only guarantees the
   * next command fails the same way.
   */
  clear(): Promise<void>;
}

/**
 * A {@link CredentialStore} that keeps the pair in a variable.
 *
 * For tests, for short-lived processes, and for embedders that obtain tokens
 * some other way and do not want them written anywhere. It is deliberately the
 * only implementation this package ships: anything durable needs a filesystem or
 * a keychain, and this package has neither.
 */
export class InMemoryCredentialStore implements CredentialStore {
  #credentials: Credentials | null;

  /**
   * @param initial - Credentials to start with, or `null` for a logged-out
   *   store.
   */
  public constructor(initial: Credentials | null = null) {
    this.#credentials = initial;
  }

  /** @inheritdoc */
  public load(): Promise<Credentials | null> {
    return Promise.resolve(this.#credentials);
  }

  /** @inheritdoc */
  public save(credentials: Credentials): Promise<void> {
    this.#credentials = credentials;
    return Promise.resolve();
  }

  /** @inheritdoc */
  public clear(): Promise<void> {
    this.#credentials = null;
    return Promise.resolve();
  }
}
