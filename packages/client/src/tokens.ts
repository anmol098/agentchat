/**
 * Refreshing an access token without logging the user out.
 *
 * ## The failure this module exists to prevent
 *
 * The server rotates refresh tokens on every use (plan §7, and the TSDoc on
 * `RefreshTokensResponseSchema`), and presenting a spent one revokes the whole
 * chain. That turns the obvious implementation — "on a 401, refresh" — into a
 * logout bug the moment two requests are in flight:
 *
 * ```text
 * A: GET /projects   → 401      B: GET /agents   → 401
 * A: POST /auth/refresh (token R1) → R2 ✓
 * B: POST /auth/refresh (token R1) → R1 is spent → chain revoked → logged out
 * ```
 *
 * `agentchat status` fanning out three reads at once is enough to hit it, so it
 * is not a theoretical concern. Two mechanisms together close it.
 *
 * **Single flight.** At most one refresh is ever in progress. A second caller
 * arriving while one is running joins it and receives the same result. The
 * in-flight promise is assigned *synchronously*, before the first `await`, so
 * two callers in the same tick cannot both find the slot empty — the bug the
 * naive `if (!inFlight) { await load(); inFlight = … }` still has.
 *
 * **Compare before spending.** A caller that arrives *after* a refresh has
 * finished has no one to join, and its 401 is stale rather than genuine: it was
 * sent with the token that has just been replaced. So before spending anything,
 * a refresh re-reads the store and compares the stored access token with the one
 * whose request actually failed. If they differ, somebody has already refreshed
 * — possibly another process sharing the same store — and the current pair is
 * returned with no network call at all.
 *
 * Together they mean: N concurrent 401s produce exactly one `POST /auth/refresh`
 * and one retry each, whatever the interleaving.
 *
 * @module
 */

import { ErrorCode, ProtocolError } from '@stackgrid/protocol';

import type { CredentialStore, Credentials } from './credentials.js';
import { ApiError } from './errors.js';

/**
 * Redeems a refresh token for a new pair.
 *
 * Supplied by the API layer so this module needs to know nothing about
 * transports or URLs, and so its behaviour can be tested without one.
 *
 * @param refreshToken - The token to redeem.
 * @returns The newly issued pair.
 * @throws {ApiError} `AUTH_REQUIRED` if the token is unknown, expired, or
 *   already rotated.
 */
export type RefreshCall = (refreshToken: string) => Promise<Credentials>;

/** What the client is told when nothing has ever been stored. */
const NOT_LOGGED_IN = 'Not logged in. Run: agentchat login';

/** What the client is told when the stored credentials no longer work. */
const SESSION_EXPIRED = 'Your session has expired. Run: agentchat login';

/**
 * Owns the credential store and serialises refreshes against it.
 *
 * One instance per {@link AgentChatClient}. Two clients sharing a store but not
 * a manager are still safe — that is what the compare-before-spending check
 * covers — but they will each make a refresh call in the worst case, so share
 * the client where you can.
 */
export class TokenManager {
  readonly #store: CredentialStore;
  readonly #refresh: RefreshCall;
  #inFlight: Promise<Credentials> | null = null;

  /**
   * @param store - Where the tokens live.
   * @param refresh - How to redeem a refresh token.
   */
  public constructor(store: CredentialStore, refresh: RefreshCall) {
    this.#store = store;
    this.#refresh = refresh;
  }

  /**
   * The credentials to use for the next request.
   *
   * Read from the store every time rather than cached, so a refresh performed by
   * another process is picked up. See `./credentials.ts`.
   *
   * @returns The stored pair.
   * @throws {ProtocolError} `AUTH_REQUIRED` if nobody has logged in.
   */
  public async require(): Promise<Credentials> {
    const credentials = await this.#store.load();
    if (credentials === null) {
      throw new ProtocolError(ErrorCode.AUTH_REQUIRED, NOT_LOGGED_IN);
    }
    return credentials;
  }

  /**
   * Obtains credentials newer than the ones a request just failed with.
   *
   * Joins a refresh already in progress, short-circuits when the store has
   * already moved on, and otherwise performs exactly one `POST /auth/refresh`.
   *
   * @param spentAccessToken - The access token the failed request carried. This
   *   is what makes a stale 401 distinguishable from a genuine one; passing the
   *   store's *current* token instead would defeat the check.
   * @returns Credentials that are not the ones that just failed.
   * @throws {ProtocolError} `AUTH_REQUIRED` if the refresh token is gone or the
   *   server rejected it. The store is cleared first, so the next command
   *   prompts for a login instead of replaying a revoked token.
   */
  public renew(spentAccessToken: string): Promise<Credentials> {
    // Not `async`: the in-flight slot has to be filled in the same tick the
    // check on it ran, or two callers in one tick both start a refresh. Making
    // this method async would insert a microtask boundary at the call and
    // reintroduce exactly that race.
    const joined = this.#inFlight;
    if (joined !== null) {
      return joined;
    }

    const attempt = this.#renewOnce(spentAccessToken);
    this.#inFlight = attempt;
    return attempt.finally(() => {
      if (this.#inFlight === attempt) {
        this.#inFlight = null;
      }
    });
  }

  /**
   * The body of a refresh, run at most once at a time.
   *
   * @param spentAccessToken - The access token whose request failed.
   * @returns The credentials to retry with.
   * @throws {ProtocolError} `AUTH_REQUIRED` as described on {@link renew}.
   */
  async #renewOnce(spentAccessToken: string): Promise<Credentials> {
    const current = await this.#store.load();
    if (current === null) {
      throw new ProtocolError(ErrorCode.AUTH_REQUIRED, NOT_LOGGED_IN);
    }

    // Somebody else — an earlier refresh on this client, or another process
    // sharing the store — has already replaced the token this request used. The
    // 401 was stale. Spending the refresh token here would revoke the chain.
    if (current.accessToken !== spentAccessToken) {
      return current;
    }

    let renewed: Credentials;
    try {
      renewed = await this.#refresh(current.refreshToken);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === ErrorCode.AUTH_REQUIRED) {
        await this.#store.clear();
        throw new ProtocolError(ErrorCode.AUTH_REQUIRED, SESSION_EXPIRED, { cause });
      }
      throw cause;
    }

    // Persisted before it is used: a process that dies between the server
    // issuing the pair and the store recording it has lost the only copy of a
    // refresh token that has already been rotated.
    await this.#store.save(renewed);
    return renewed;
  }
}
