/**
 * How long to wait before the next reconnect attempt.
 *
 * Plan §5 fixes the shape: exponential, from one second to a thirty-second cap,
 * jittered. The exponent is the obvious half; the jitter is the half that
 * actually matters, and it is worth being explicit about why.
 *
 * ## The failure jitter prevents
 *
 * Every listener that was connected to a server when it went away learns about
 * it at the same instant, because the server going away *is* the event. Without
 * jitter they all wait 1 s, all reconnect together, all fail together, all wait
 * 2 s, and so on: the herd stays in phase forever and every retry wave is a
 * synchronised load spike against a server that is, by hypothesis, already in
 * trouble. Plan §12.5 expects a rolling upgrade to be survivable — sockets
 * drop, clients reconnect, `hello` replays what is pending — and a thundering
 * herd is precisely what would make the restart worse than the outage.
 *
 * ## Equal jitter, not full jitter
 *
 * The delay is drawn uniformly from `[base / 2, base]`, where `base` is the
 * exponential schedule capped at {@link DEFAULT_BACKOFF_POLICY.maxDelayMs}.
 * That is "equal jitter". The alternative, "full jitter", draws from
 * `[0, base]`, which decorrelates slightly better but lets a client roll a
 * near-zero delay and hammer a server that has just refused it. Equal jitter
 * keeps a floor under every wait — the schedule stays recognisably 1 s, 2 s,
 * 4 s — while spreading a herd of listeners over a window that grows with the
 * outage: half a second at the first retry, fifteen seconds once the cap is
 * reached, which is where a large herd would otherwise do the most damage.
 *
 * The cap is never exceeded and the delay is never negative, whatever the
 * attempt number, which is what stops a listener that has been retrying for a
 * week from computing an infinite wait.
 *
 * @module
 */

import { ErrorCode, ProtocolError } from '@agentchat/protocol';

/** The exponential schedule and how much of it is randomised. */
export interface BackoffPolicy {
  /** The base delay before the first retry, in milliseconds. */
  readonly initialDelayMs: number;

  /** The ceiling the exponential schedule is clamped to, in milliseconds. */
  readonly maxDelayMs: number;

  /** What the base delay is multiplied by after each failed attempt. */
  readonly factor: number;

  /**
   * The fraction of the base delay that is randomised, between 0 and 1.
   *
   * `0.5` is equal jitter: half the base is fixed and half is drawn uniformly.
   * `0` disables jitter, which is only ever right in a test that is asserting
   * on the schedule itself — see the module note for why a fleet with no jitter
   * reconnects in lockstep.
   */
  readonly jitterRatio: number;

  /** Source of randomness, injectable so a test can assert an exact delay. */
  readonly random: () => number;
}

/** The policy plan §5 specifies: 1 s, doubling, capped at 30 s, equal jitter. */
export const DEFAULT_BACKOFF_POLICY: BackoffPolicy = Object.freeze({
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  factor: 2,
  jitterRatio: 0.5,
  random: Math.random,
});

/** A caller's partial policy: anything unstated comes from the default. */
export type BackoffOptions = Partial<BackoffPolicy>;

/**
 * Fills a partial policy in from the default and checks it is usable.
 *
 * Validated once, at construction, rather than on every delay: a listener that
 * discovered its backoff was misconfigured on its first disconnection would
 * discover it at the worst possible moment.
 *
 * @param options - The caller's overrides, if any.
 * @returns A complete policy.
 * @throws {ProtocolError} `BAD_REQUEST` if a delay is not a positive finite
 *   number, if the cap is below the initial delay, if the factor is below 1, or
 *   if the jitter ratio is outside `[0, 1]`.
 */
export function resolveBackoffPolicy(options: BackoffOptions = {}): BackoffPolicy {
  const policy: BackoffPolicy = { ...DEFAULT_BACKOFF_POLICY, ...options };

  requirePositive(policy.initialDelayMs, 'initialDelayMs');
  requirePositive(policy.maxDelayMs, 'maxDelayMs');

  if (policy.maxDelayMs < policy.initialDelayMs) {
    throw new ProtocolError(
      ErrorCode.BAD_REQUEST,
      `The backoff cap (${policy.maxDelayMs} ms) must not be below the initial delay (${policy.initialDelayMs} ms).`,
    );
  }
  if (!Number.isFinite(policy.factor) || policy.factor < 1) {
    throw new ProtocolError(
      ErrorCode.BAD_REQUEST,
      `The backoff factor must be a finite number of at least 1, got ${policy.factor}.`,
    );
  }
  if (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1) {
    throw new ProtocolError(
      ErrorCode.BAD_REQUEST,
      `The jitter ratio must be between 0 and 1, got ${policy.jitterRatio}.`,
    );
  }

  return policy;
}

/**
 * Rejects a delay that is not a positive finite number of milliseconds.
 *
 * @param value - The configured delay.
 * @param name - Which option it was, for the message.
 * @throws {ProtocolError} `BAD_REQUEST` if it is not usable.
 */
function requirePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ProtocolError(
      ErrorCode.BAD_REQUEST,
      `The backoff option ${name} must be a positive number of milliseconds, got ${value}.`,
    );
  }
}

/**
 * The delay before a given retry.
 *
 * @param attempt - How many attempts have already failed in this streak, from
 *   zero. Attempt 0 is the wait before the first retry.
 * @param policy - A complete policy, from {@link resolveBackoffPolicy}.
 * @returns Whole milliseconds to wait, never above `maxDelayMs` and never
 *   below `maxDelayMs * (1 - jitterRatio)` once the cap is reached.
 */
export function backoffDelayMs(attempt: number, policy: BackoffPolicy): number {
  // `factor ** attempt` overflows to Infinity for a listener that has been
  // retrying long enough, and `Math.min` is what makes that a capped wait
  // rather than one that never ends.
  const exponential = policy.initialDelayMs * policy.factor ** Math.max(0, attempt);
  const base = Math.min(policy.maxDelayMs, exponential);

  const jittered = base * (1 - policy.jitterRatio) + base * policy.jitterRatio * policy.random();

  // Clamped again after jittering: a `random()` that returns something outside
  // [0, 1) — an injected stub, a hostile polyfill — must not be able to produce
  // a wait above the cap or below zero.
  return Math.round(Math.min(policy.maxDelayMs, Math.max(0, jittered)));
}
