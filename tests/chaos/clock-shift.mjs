/**
 * Moves the server process's clock forward, and nothing else.
 *
 * Loaded with `node --import`, so it runs before `server/dist/src/index.js` is
 * evaluated and therefore before anything captures a timestamp.
 *
 * ## Why a test is allowed to do this
 *
 * `ACCESS_TOKEN_TTL_SECONDS` is an hour and is a constant with no environment
 * override, so "the access token expired while the listener was running" is
 * either reached by waiting an hour or it is not tested. T-509's acceptance
 * criteria say it is tested.
 *
 * The substitution is narrow because of a property of the code it runs against.
 * `server/src/services/sessions.ts` measures the entire session lifecycle in
 * *database* time — every timestamp it writes is `now()` and every threshold it
 * compares against is derived from `now()` — and `message_inbox` rows are
 * likewise written and read in database time. The application clock is
 * consulted for one thing: minting and verifying JSON Web Tokens. So a shift
 * expires tokens and leaves presence, staleness, sweeps and the inbox exactly
 * where they were.
 *
 * Nothing is simulated by the shift. The token is genuinely past its `exp`, the
 * server genuinely refuses it, and `@agentchat/client` genuinely spends a
 * refresh token to recover. What is faked is only the passage of an hour.
 *
 * ## It does nothing unless it is told to
 *
 * `AGENTCHAT_CHAOS_CLOCK_SHIFT_MS` absent, unparseable or zero leaves the
 * process with the clock it started with. A hook that guessed would be a hook
 * that silently changed the meaning of every other test in the suite.
 *
 * @module
 */

const raw = process.env['AGENTCHAT_CHAOS_CLOCK_SHIFT_MS'];
const shiftMs = raw === undefined ? 0 : Number.parseInt(raw, 10);

if (Number.isFinite(shiftMs) && shiftMs !== 0) {
  const RealDate = Date;
  const realNow = Date.now.bind(Date);

  /**
   * `Date`, an interval later.
   *
   * A subclass rather than a rewritten global: `instanceof Date` must keep
   * holding, `Date.parse` and `Date.UTC` must keep working, and every explicit
   * construction — `new Date(someTimestamp)` — must be left alone. The only
   * changed behaviours are the two that read the clock: `Date.now()` and
   * `new Date()` with no arguments.
   */
  class ShiftedDate extends RealDate {
    /**
     * @param {...unknown} args - Whatever `Date` was called with.
     */
    constructor(...args) {
      if (args.length === 0) {
        super(realNow() + shiftMs);
        return;
      }
      // @ts-expect-error — forwarding an arbitrary Date signature.
      super(...args);
    }

    /** @returns {number} Milliseconds since the epoch, shifted. */
    static now() {
      return realNow() + shiftMs;
    }
  }

  globalThis.Date = ShiftedDate;
}
