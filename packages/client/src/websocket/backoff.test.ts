import { ErrorCode } from '@stackgrid/protocol';
import { describe, expect, it } from 'vitest';

import {
  type BackoffPolicy,
  backoffDelayMs,
  DEFAULT_BACKOFF_POLICY,
  resolveBackoffPolicy,
} from './backoff.js';

/**
 * A policy with a fixed random draw, so a test asserts on the schedule rather
 * than on chance.
 *
 * @param draw - What `random()` returns.
 * @param overrides - Anything else to change.
 * @returns The policy.
 */
function policyWith(draw: number, overrides: Partial<BackoffPolicy> = {}): BackoffPolicy {
  return resolveBackoffPolicy({ random: () => draw, ...overrides });
}

describe('resolveBackoffPolicy', () => {
  it('defaults to one second, doubling, capped at thirty', () => {
    const policy = resolveBackoffPolicy();

    expect(policy.initialDelayMs).toBe(1_000);
    expect(policy.maxDelayMs).toBe(30_000);
    expect(policy.factor).toBe(2);
  });

  it.each([
    ['a negative initial delay', { initialDelayMs: -1 }],
    ['a zero initial delay', { initialDelayMs: 0 }],
    ['an infinite cap', { maxDelayMs: Number.POSITIVE_INFINITY }],
    ['a cap below the initial delay', { initialDelayMs: 5_000, maxDelayMs: 1_000 }],
    ['a factor below one', { factor: 0.5 }],
    ['a jitter ratio above one', { jitterRatio: 1.5 }],
    ['a negative jitter ratio', { jitterRatio: -0.1 }],
  ])('refuses %s', (_label, options) => {
    expect(() => resolveBackoffPolicy(options)).toThrowError(
      expect.objectContaining({ code: ErrorCode.BAD_REQUEST }),
    );
  });
});

describe('backoffDelayMs', () => {
  it('doubles the base delay on each attempt', () => {
    // A draw of 1 yields the full base delay, which is the schedule itself.
    const policy = policyWith(1);

    expect([0, 1, 2, 3, 4, 5].map((attempt) => backoffDelayMs(attempt, policy))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
    ]);
  });

  it('never waits longer than the cap, however many attempts have failed', () => {
    const policy = policyWith(1);

    // A listener that has been retrying for a week must still be retrying every
    // thirty seconds, not every 2^600 milliseconds.
    for (const attempt of [10, 100, 1_000, 100_000]) {
      expect(backoffDelayMs(attempt, policy)).toBe(DEFAULT_BACKOFF_POLICY.maxDelayMs);
    }
  });

  it('keeps a floor under the wait, so a refused server is not hammered', () => {
    // The whole point of equal jitter over full jitter: even the unluckiest
    // draw waits half the base delay.
    const policy = policyWith(0);

    expect(backoffDelayMs(0, policy)).toBe(500);
    expect(backoffDelayMs(4, policy)).toBe(8_000);
    expect(backoffDelayMs(50, policy)).toBe(15_000);
  });

  it('spreads a fleet across the whole jitter window', () => {
    // Every listener that lost the same server computes its first delay at the
    // same instant. If they all computed the same number they would reconnect
    // in lockstep and knock it over again; this is the property that stops it.
    const policy = resolveBackoffPolicy();
    const delays = new Set(Array.from({ length: 200 }, () => backoffDelayMs(0, policy)));

    expect(delays.size).toBeGreaterThan(100);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThanOrEqual(1_000);
    }
  });

  it('clamps a random source that answers outside [0, 1)', () => {
    expect(backoffDelayMs(0, policyWith(50))).toBeLessThanOrEqual(
      DEFAULT_BACKOFF_POLICY.maxDelayMs,
    );
    expect(backoffDelayMs(9, policyWith(1_000))).toBe(DEFAULT_BACKOFF_POLICY.maxDelayMs);
    expect(backoffDelayMs(0, policyWith(-50))).toBe(0);
  });

  it('treats a negative attempt as the first one', () => {
    expect(backoffDelayMs(-3, policyWith(1))).toBe(1_000);
  });

  it('can be turned off entirely for a deterministic test', () => {
    const policy = policyWith(0, { jitterRatio: 0 });

    expect(backoffDelayMs(2, policy)).toBe(4_000);
  });
});
