/**
 * The parts of the session lifecycle that are decisions rather than statements.
 *
 * The thresholds, the failure table, and the sweeper's timer — the last of
 * which is worth a suite of its own precisely because it is the thing standing
 * between "a listener was killed" and "the listener stops being reported as
 * online". Everything that is a query is proved against a real database in
 * `./sessions.integration.test.ts`; asserting SQL against a mock would assert
 * the mock.
 */

import { ErrorCode } from '@stackgrid/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HTTP_STATUS_BY_ERROR_CODE } from '../errors.js';
import {
  HEARTBEAT_TIMEOUT_SECONDS,
  SESSION_END_AFTER_SECONDS,
  SESSION_FAILURE_MESSAGES,
  SESSION_STATUS,
  SESSION_SWEEP_INTERVAL_MS,
  type SessionService,
  STALE_SESSION_LIFETIME_SECONDS,
  type SweepResult,
  startSessionSweeper,
} from './sessions.js';

/** A service whose only real method is `sweep`; the sweeper needs no other. */
function sweepingService(sweep: () => Promise<SweepResult>): SessionService {
  const unreachable = (name: string) => (): never => {
    throw new Error(`The sweeper must not call ${name}.`);
  };

  return {
    register: unreachable('register'),
    heartbeat: unreachable('heartbeat'),
    end: unreachable('end'),
    list: unreachable('list'),
    sweep,
  } as unknown as SessionService;
}

/** Nothing moved. */
const NOTHING: SweepResult = { markedStale: 0, ended: 0 };

describe('the thresholds', () => {
  it('is stale after the sixty seconds plan §2 specifies', () => {
    expect(HEARTBEAT_TIMEOUT_SECONDS).toBe(60);
  });

  it('is ended after a day of staleness, measured from the last heartbeat', () => {
    // There is no `stale_at` column, so "stale for a day" has to be expressed
    // against `last_seen_at`: staleness begins sixty seconds after it, so a day
    // of staleness ends a day and a minute after it. The identity, not the
    // literal, is what is asserted — if either threshold is retuned this still
    // has to hold.
    expect(STALE_SESSION_LIFETIME_SECONDS).toBe(24 * 60 * 60);
    expect(SESSION_END_AFTER_SECONDS).toBe(
      HEARTBEAT_TIMEOUT_SECONDS + STALE_SESSION_LIFETIME_SECONDS,
    );
  });

  it('sweeps often enough that a stale listener is noticed well within the threshold', () => {
    // Otherwise presence would be honest only on average: a session could
    // qualify as stale a moment after a pass and wait most of a minute to be
    // told so, which is the whole window discovery would be lying in.
    expect(SESSION_SWEEP_INTERVAL_MS).toBeLessThan(HEARTBEAT_TIMEOUT_SECONDS * 1000);
  });

  it('names the three statuses the database check permits', () => {
    expect(Object.values(SESSION_STATUS)).toEqual(['active', 'stale', 'ended']);
  });
});

describe('the failure table', () => {
  it('carries a message for every code a session rule may answer with', () => {
    // Total by construction — the type is a `Record` over the union — so this
    // asserts the values are usable rather than merely present.
    for (const message of Object.values(SESSION_FAILURE_MESSAGES)) {
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it('tells a caller whose session has ended what to do instead', () => {
    // A code without a remedy is a dead end for the CLI, which has to print
    // something. This is the one failure with an obvious next step.
    expect(SESSION_FAILURE_MESSAGES[ErrorCode.CONFLICT]).toContain('agentchat listen');
    expect(SESSION_FAILURE_MESSAGES[ErrorCode.CONFLICT]).toContain('--runtime');
  });

  it('says nothing about *why* a session could not be found', () => {
    // Somebody else's session and an imaginary one share this string, which is
    // what stops the endpoint being an id oracle. See the disclosure test in
    // the integration suite.
    const message = SESSION_FAILURE_MESSAGES[ErrorCode.NOT_FOUND];
    expect(message).not.toMatch(/belongs|owner|another|exists/i);
  });

  it('maps its codes onto the statuses a client will actually see', () => {
    expect(HTTP_STATUS_BY_ERROR_CODE[ErrorCode.NOT_FOUND]).toBe(404);
    expect(HTTP_STATUS_BY_ERROR_CODE[ErrorCode.CONFLICT]).toBe(409);
    expect(HTTP_STATUS_BY_ERROR_CODE[ErrorCode.INTERNAL]).toBe(500);
  });
});

describe('the sweeper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not sweep before the first interval elapses', () => {
    const sweep = vi.fn(async () => NOTHING);
    const sweeper = startSessionSweeper({ sessions: sweepingService(sweep) });

    expect(sweep).not.toHaveBeenCalled();

    vi.advanceTimersByTime(SESSION_SWEEP_INTERVAL_MS - 1);
    expect(sweep).not.toHaveBeenCalled();

    sweeper.stop();
  });

  it('sweeps on every interval', async () => {
    const sweep = vi.fn(async () => NOTHING);
    const sweeper = startSessionSweeper({ sessions: sweepingService(sweep), intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(3000);
    expect(sweep).toHaveBeenCalledTimes(3);

    sweeper.stop();
  });

  it('stops when told to, so a process can exit', async () => {
    const sweep = vi.fn(async () => NOTHING);
    const sweeper = startSessionSweeper({ sessions: sweepingService(sweep), intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);
    expect(sweep).toHaveBeenCalledTimes(1);

    sweeper.stop();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('can be stopped more than once', async () => {
    const sweeper = startSessionSweeper({
      sessions: sweepingService(async () => NOTHING),
      intervalMs: 1000,
    });

    sweeper.stop();
    expect(() => {
      sweeper.stop();
    }).not.toThrow();

    await vi.advanceTimersByTimeAsync(5000);
  });

  it('never runs two passes at once', async () => {
    // Two overlapping passes would be two sweepers inside one process. The
    // statements survive that — see `createSessionService` — but arranging it
    // on a timer would be arranging it for no reason, and a slow pass would
    // otherwise stack up one pass per tick indefinitely.
    let running = 0;
    let overlapped = false;

    const sweeper = startSessionSweeper({
      intervalMs: 1000,
      sessions: sweepingService(async () => {
        running += 1;
        if (running > 1) {
          overlapped = true;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 5000);
        });
        running -= 1;
        return NOTHING;
      }),
    });

    await vi.advanceTimersByTimeAsync(20_000);

    expect(overlapped).toBe(false);
    sweeper.stop();
  });

  it('reports a pass that moved rows, and stays quiet about one that did not', async () => {
    const onSwept = vi.fn();
    const results: SweepResult[] = [
      { markedStale: 2, ended: 1 },
      NOTHING,
      { markedStale: 0, ended: 3 },
    ];
    let pass = 0;

    const sweeper = startSessionSweeper({
      intervalMs: 1000,
      observer: { onSwept },
      sessions: sweepingService(async () => results[pass++] ?? NOTHING),
    });

    await vi.advanceTimersByTimeAsync(3000);

    // A log line per idle pass, three times a minute, forever, would drown the
    // ones that mean something.
    expect(onSwept).toHaveBeenCalledTimes(2);
    expect(onSwept).toHaveBeenNthCalledWith(1, { markedStale: 2, ended: 1 });
    expect(onSwept).toHaveBeenNthCalledWith(2, { markedStale: 0, ended: 3 });

    sweeper.stop();
  });

  it('survives a failed pass and keeps sweeping', async () => {
    // A failure here is a database blip, not a reason to stop expiring
    // sessions: the next pass repeats exactly the same work, because the
    // statements are idempotent. Rethrowing into a timer callback would take
    // the process down instead.
    const onFailed = vi.fn();
    let pass = 0;

    const sweeper = startSessionSweeper({
      intervalMs: 1000,
      observer: { onFailed },
      sessions: sweepingService(() => {
        pass += 1;
        return pass === 1
          ? Promise.reject(new Error('connection terminated unexpectedly'))
          : Promise.resolve(NOTHING);
      }),
    });

    await vi.advanceTimersByTimeAsync(3000);

    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(pass).toBe(3);

    sweeper.stop();
  });

  it('needs no observer at all', async () => {
    const sweeper = startSessionSweeper({
      intervalMs: 1000,
      sessions: sweepingService(() => Promise.reject(new Error('still nothing to attach to'))),
    });

    // The failure has nowhere to be reported and must still not escape into
    // the timer callback, where nothing could catch it.
    await expect(vi.advanceTimersByTimeAsync(3000)).resolves.not.toThrow();

    sweeper.stop();
  });
});
