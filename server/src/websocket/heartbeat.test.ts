/**
 * The heartbeat: that a live socket is left alone, a dead one is reclaimed, and
 * neither leaves anything behind.
 *
 * Five groups carry the weight:
 *
 * - **`a responsive client`** — the case that must not break. A socket that
 *   answers is pinged forever and never reaped, checked across fifteen minutes
 *   of simulated ticks rather than one, because "does not kill a live socket on
 *   the first sweep" is a much weaker claim than "does not kill a live socket".
 *   The interesting member is the *slow* client, at fifty-nine seconds: one
 *   comparison written `<` instead of `<=` is the difference between a listener
 *   that survives a garbage-collection pause and one that does not.
 * - **`a silent client`** — reaped, and reaped *when* it should be. Asserting
 *   only that it eventually dies would pass for an implementation that killed
 *   it on the first tick, which is the failure that hurts.
 * - **`the close code`** — 1000 and 1006 both end the session and only one is
 *   unusual. Both halves are asserted, because a heartbeat that logged every
 *   `Ctrl-C` as an anomaly would be as useless as one that logged nothing.
 * - **`marking the session stale`** — including the two cases that must not
 *   become noise: a database that refuses, and the ordinary teardown order.
 * - **`nothing outlives the socket`** — the leak and the hang. A thousand
 *   connect/disconnect cycles, and the actual `unref` on the actual interval,
 *   asserted rather than assumed.
 *
 * Time is injected, never faked. A clock the test advances by hand is the seam
 * `./handler.ts` and `../services/sessions.ts` already use, it lets the real
 * sixty-second constant be tested in a millisecond, and it does not require the
 * suite to trust a timer-mocking library about a module whose whole subject is
 * timers.
 */

import { AgentId, MachineId, ProjectId, SessionId, UserId } from '@stackgrid/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { SESSION_STATUS, type SessionRecord } from '../services/sessions.js';
import { CloseCode, type CloseReason, type ServerFrame, type SocketIdentity } from './frames.js';
import type { SocketBinding, SocketLogger } from './handler.js';
import {
  createHeartbeat,
  type HeartbeatService,
  type HeartbeatSocket,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  type SessionStaleMarker,
} from './heartbeat.js';

// ---------------------------------------------------------------------------
// The port really is the transport
// ---------------------------------------------------------------------------

/**
 * `ws`'s `WebSocket` satisfies {@link HeartbeatSocket}.
 *
 * A compile-time assertion, which is the only kind available for a claim about
 * assignability. It is here because `../app.ts` passes a `ws` socket straight
 * into `watch` with no adapter in between: if a `ws` upgrade ever changed
 * `ping`, `terminate`, or the `pong`/`close` overloads of `on`, the first
 * symptom without this line would be a production build that compiles and a
 * heartbeat that silently never fires.
 */
const _wsSatisfiesTheSocketPort: (socket: WebSocket) => HeartbeatSocket = (socket) => socket;
void _wsSatisfiesTheSocketPort;

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/** A socket that records what was done to it and can be made to answer. */
interface FakeSocket extends HeartbeatSocket {
  /** Pings received. */
  readonly pings: () => number;

  /** Whether it has been terminated. */
  readonly terminated: () => number;

  /** Answer the last ping. */
  readonly pong: () => void;

  /** Drop, the way a client closing its tab does. */
  readonly dropped: () => void;
}

/**
 * Builds a socket double.
 *
 * `terminate` fires `close`, because the real one does — `ws` emits `close`
 * with 1006 after a terminate. That fidelity is not decoration: it is what
 * makes the sweep re-enter its own map mid-iteration, which is the only reason
 * the sweep walks a copy.
 *
 * @returns The double.
 */
function fakeSocket(): FakeSocket {
  const pongListeners: (() => void)[] = [];
  const closeListeners: (() => void)[] = [];
  let pings = 0;
  let terminated = 0;

  function fireClose(): void {
    for (const listener of [...closeListeners]) {
      listener();
    }
  }

  return {
    ping(): void {
      pings += 1;
    },

    terminate(): void {
      terminated += 1;
      fireClose();
    },

    on(event: 'pong' | 'close', listener: () => void): unknown {
      if (event === 'pong') {
        pongListeners.push(listener);
      } else {
        closeListeners.push(listener);
      }
      return undefined;
    },

    pings: () => pings,
    terminated: () => terminated,

    pong(): void {
      for (const listener of [...pongListeners]) {
        listener();
      }
    },

    dropped: fireClose,
  };
}

/** One logged line. */
interface LogLine {
  readonly level: 'info' | 'warn' | 'error';
  readonly details: Record<string, unknown>;
  readonly message: string;
}

/** A logger that keeps what it was told. */
function recordingLogger(): SocketLogger & { readonly lines: LogLine[] } {
  const lines: LogLine[] = [];

  return {
    lines,
    info: (details, message): void => {
      lines.push({ level: 'info', details, message });
    },
    warn: (details, message): void => {
      lines.push({ level: 'warn', details, message });
    },
    error: (details, message): void => {
      lines.push({ level: 'error', details, message });
    },
  };
}

const USER = UserId.generate();
const AGENT = AgentId.generate();
const PROJECT = ProjectId.generate();
const SESSION = SessionId.generate();

const SESSION_RECORD: SessionRecord = {
  id: SESSION,
  agentId: AGENT,
  projectId: PROJECT,
  machineId: MachineId.generate(),
  machineName: 'workstation',
  runtime: 'claude-code',
  workingDirectory: '/srv/app',
  startedAt: new Date('2026-09-08T12:00:00.000Z'),
  lastSeenAt: new Date('2026-09-08T12:00:00.000Z'),
  endedAt: null,
  status: SESSION_STATUS.ACTIVE,
};

const IDENTITY: SocketIdentity = {
  userId: USER,
  sessionId: SESSION,
  agentId: AGENT,
  projectId: PROJECT,
};

/**
 * A bound socket, as the `closed` hook receives one.
 *
 * @returns The binding.
 */
function fakeBinding(): SocketBinding {
  return {
    identity: IDENTITY,
    session: SESSION_RECORD,
    client: undefined,
    send: (_frame: ServerFrame): void => {},
    close: (_reason: CloseReason): void => {},
  };
}

/** A stale marker that records its calls. */
function recordingMarker(): SessionStaleMarker & { readonly calls: { sessionId: string }[] } {
  const calls: { sessionId: string }[] = [];

  return {
    calls,
    markStale: (request): Promise<unknown> => {
      calls.push({ sessionId: request.sessionId });
      return Promise.resolve(SESSION_RECORD);
    },
  };
}

// ---------------------------------------------------------------------------
// A clock the test drives
// ---------------------------------------------------------------------------

/** A hand-wound clock. */
interface Clock {
  /** Read it. */
  readonly now: () => number;

  /** Wind it forward. */
  readonly advance: (ms: number) => void;
}

/**
 * Builds a clock starting at zero.
 *
 * @returns The clock.
 */
function clock(): Clock {
  let millis = 0;

  return {
    now: () => millis,
    advance: (ms: number): void => {
      millis += ms;
    },
  };
}

/** Every service a test built, so `afterEach` can stop them all. */
const built: HeartbeatService[] = [];

/**
 * Builds a heartbeat wired to a test's doubles, registered for teardown.
 *
 * @param overrides - Anything the test wants to differ.
 * @returns The service.
 */
function heartbeat(overrides: {
  readonly now?: () => number;
  readonly sessions?: SessionStaleMarker;
  readonly logger?: SocketLogger;
  readonly intervalMs?: number;
}): HeartbeatService {
  const service = createHeartbeat({
    sessions: overrides.sessions ?? recordingMarker(),
    logger: overrides.logger ?? recordingLogger(),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),

    // Long enough that no test's real wall-clock run reaches a tick. Every
    // sweep in this file is called by hand, so a background one firing would
    // only make failures depend on how loaded the machine is.
    intervalMs: overrides.intervalMs ?? 60 * 60 * 1_000,
  });

  built.push(service);
  return service;
}

afterEach(() => {
  for (const service of built.splice(0)) {
    service.stop();
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('a responsive client', () => {
  it('is pinged on every sweep and never reaped', () => {
    const time = clock();
    const service = heartbeat({ now: time.now });
    const socket = fakeSocket();

    service.watch(socket);

    // Forty-five sweeps at the real interval: a quarter of an hour of a healthy
    // listener. One sweep passing says nothing about the forty-fifth.
    for (let tick = 0; tick < 45; tick += 1) {
      time.advance(PING_INTERVAL_MS);
      expect(service.sweep()).toBe(0);
      socket.pong();
    }

    expect(socket.pings()).toBe(45);
    expect(socket.terminated()).toBe(0);
    expect(service.size).toBe(1);
  });

  it('survives answering only just inside the deadline', () => {
    const time = clock();
    const service = heartbeat({ now: time.now });
    const socket = fakeSocket();

    service.watch(socket);

    // A listener that stalled — a long garbage-collection pause, a machine
    // briefly suspended — and answers with one second to spare. Reaping this is
    // an off-by-one in the comparison, and it kills a working listener.
    time.advance(PONG_TIMEOUT_MS - 1_000);

    expect(service.sweep()).toBe(0);
    expect(socket.terminated()).toBe(0);

    socket.pong();

    // And the answer really did reset the clock, rather than merely being
    // received: another almost-full deadline still does not reap it.
    time.advance(PONG_TIMEOUT_MS - 1_000);
    expect(service.sweep()).toBe(0);
    expect(socket.terminated()).toBe(0);
    expect(service.size).toBe(1);
  });

  it('is unaffected by a silent socket dying beside it', () => {
    const time = clock();
    const service = heartbeat({ now: time.now });
    const alive = fakeSocket();
    const dead = fakeSocket();

    service.watch(alive);
    service.watch(dead);

    for (let tick = 0; tick < 3; tick += 1) {
      time.advance(PING_INTERVAL_MS);
      service.sweep();
      alive.pong();
    }

    expect(dead.terminated()).toBe(1);
    expect(alive.terminated()).toBe(0);
    expect(service.size).toBe(1);
  });
});

describe('a silent client', () => {
  it('is terminated once it has been silent for the deadline', () => {
    const time = clock();
    const logger = recordingLogger();
    const service = heartbeat({ now: time.now, logger });
    const socket = fakeSocket();

    service.watch(socket);

    // Two sweeps inside the deadline: pinged, not judged.
    time.advance(PING_INTERVAL_MS);
    expect(service.sweep()).toBe(0);
    time.advance(PING_INTERVAL_MS);
    expect(service.sweep()).toBe(0);

    expect(socket.pings()).toBe(2);
    expect(socket.terminated()).toBe(0);

    // The third lands exactly on sixty seconds of silence.
    time.advance(PING_INTERVAL_MS);
    expect(service.sweep()).toBe(1);

    expect(socket.terminated()).toBe(1);

    // Terminated, not closed: a peer that answers nothing will not complete a
    // closing handshake either, and 1006 is the truth about what happened.
    expect(socket.pings()).toBe(2);

    const warning = logger.lines.find((line) => line.message.includes('heartbeat deadline'));
    expect(warning?.level).toBe('warn');
    expect(warning?.details).toMatchObject({ timeoutMs: PONG_TIMEOUT_MS });
  });

  it('is not terminated early', () => {
    const time = clock();
    const service = heartbeat({ now: time.now });
    const socket = fakeSocket();

    service.watch(socket);

    // One millisecond short of the deadline, however many sweeps it takes to
    // get there. Nothing may die here.
    time.advance(PONG_TIMEOUT_MS - 1);
    expect(service.sweep()).toBe(0);
    expect(socket.terminated()).toBe(0);
    expect(service.size).toBe(1);
  });

  it('is forgotten, and not terminated twice', () => {
    const time = clock();
    const service = heartbeat({ now: time.now });
    const socket = fakeSocket();

    service.watch(socket);
    time.advance(PONG_TIMEOUT_MS);

    expect(service.sweep()).toBe(1);
    expect(service.size).toBe(0);

    // The socket's own `close` event fired during `terminate`, re-entering the
    // map the sweep was walking. Neither that nor the next sweep may touch it
    // again: terminating a descriptor that has since been reused would be a
    // far worse bug than the one being fixed.
    time.advance(PONG_TIMEOUT_MS);
    expect(service.sweep()).toBe(0);
    expect(socket.terminated()).toBe(1);
  });

  it('is reaped even though it never completed a handshake', () => {
    const time = clock();
    const marker = recordingMarker();
    const service = heartbeat({ now: time.now, sessions: marker });
    const socket = fakeSocket();

    // Watched at upgrade, never bound: `hello` never arrived, so no observer
    // hook will ever run for it. It is still a socket this process is holding.
    service.watch(socket);
    time.advance(PONG_TIMEOUT_MS);

    expect(service.sweep()).toBe(1);
    expect(socket.terminated()).toBe(1);

    // And there was no session to mark, so nothing was invented.
    expect(marker.calls).toHaveLength(0);
  });
});

describe('the close code', () => {
  it('reports a deliberate departure without alarm', async () => {
    const logger = recordingLogger();
    const marker = recordingMarker();
    const service = heartbeat({ logger, sessions: marker });

    await service.closed(fakeBinding(), CloseCode.NORMAL);

    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]?.level).toBe('info');
    expect(logger.lines[0]?.details).toMatchObject({ code: CloseCode.NORMAL, sessionId: SESSION });
    expect(marker.calls).toHaveLength(1);
  });

  it.each([
    ['a peer that vanished', 1006],
    ['a hook that threw', CloseCode.INTERNAL_ERROR],
    ['a refused session', CloseCode.SESSION_INVALID],
  ])('reports %s as unusual', async (_name, code) => {
    const logger = recordingLogger();
    const marker = recordingMarker();
    const service = heartbeat({ logger, sessions: marker });

    await service.closed(fakeBinding(), code);

    expect(logger.lines[0]?.level).toBe('warn');
    expect(logger.lines[0]?.details).toMatchObject({ code });

    // The distinction is in the log and nowhere else: both end the session.
    expect(marker.calls).toHaveLength(1);
  });
});

describe('marking the session stale', () => {
  it('takes the session and the user from the binding', async () => {
    const calls: { userId: string; sessionId: string }[] = [];
    const service = heartbeat({
      sessions: {
        markStale: (request): Promise<unknown> => {
          calls.push({ userId: request.userId, sessionId: request.sessionId });
          return Promise.resolve(SESSION_RECORD);
        },
      },
    });

    await service.closed(fakeBinding(), CloseCode.NORMAL);

    // Straight off the binding's identity, which the handshake resolved and
    // validated. Nothing here re-derives who owns the session.
    expect(calls).toEqual([{ userId: USER, sessionId: SESSION }]);
  });

  it('logs a refusal rather than propagating it', async () => {
    const logger = recordingLogger();
    const service = heartbeat({
      logger,
      sessions: {
        markStale: (): Promise<unknown> => Promise.reject(new Error('connection terminated')),
      },
    });

    // Must not reject. There is no socket left to close, and the session
    // sweeper ages an unmarked session on its own within the minute, so a
    // database blip during a disconnect is a slower presence update and not a
    // wrong one.
    await expect(service.closed(fakeBinding(), 1006)).resolves.toBeUndefined();

    const failure = logger.lines.find((line) => line.level === 'error');
    expect(failure?.message).toContain('mark a closed session stale');
    expect(failure?.details).toMatchObject({ sessionId: SESSION });
  });
});

describe('nothing outlives the socket', () => {
  it('forgets a socket that closes on its own', () => {
    const service = heartbeat({});
    const socket = fakeSocket();

    service.watch(socket);
    expect(service.size).toBe(1);

    socket.dropped();
    expect(service.size).toBe(0);
  });

  it('leaks nothing across a thousand connections', () => {
    const time = clock();
    const service = heartbeat({ now: time.now });

    // A single connect/disconnect passing tells you nothing about a process
    // that has been up for a week. Half of these leave cleanly and half are
    // reaped, because those are different removal paths.
    for (let cycle = 0; cycle < 1_000; cycle += 1) {
      const socket = fakeSocket();
      service.watch(socket);

      if (cycle % 2 === 0) {
        socket.dropped();
      } else {
        time.advance(PONG_TIMEOUT_MS);
        service.sweep();
      }
    }

    expect(service.size).toBe(0);
  });

  it('is not resurrected by a pong that arrives after it closed', () => {
    const service = heartbeat({});
    const socket = fakeSocket();

    service.watch(socket);
    socket.dropped();

    // `ws` can deliver a buffered pong after the close has been processed. Were
    // the listener to write the timestamp back unconditionally, it would create
    // a map entry for a dead socket that no `close` will ever fire for again —
    // a permanent leak, and one the sweep would then ping forever.
    socket.pong();

    expect(service.size).toBe(0);
  });

  it('does not hold the process open', () => {
    const setInterval = vi.spyOn(globalThis, 'setInterval');

    // No `intervalMs`, so this is also the assertion that what ships is Plan
    // §4.3's twenty seconds and not whatever a test last passed in.
    createHeartbeat({ sessions: recordingMarker(), logger: recordingLogger() }).stop();

    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), PING_INTERVAL_MS);

    const timer = setInterval.mock.results[0]?.value as NodeJS.Timeout;

    // The assertion the module note promises, made against the real handle
    // rather than assumed from the source. An interval that keeps a reference
    // is a suite that hangs after its last test passes and a shutdown that
    // waits for a timer nobody is waiting on.
    expect(timer.hasRef()).toBe(false);
  });

  it('stops sweeping once stopped', async () => {
    const service = heartbeat({ intervalMs: 1 });
    const socket = fakeSocket();

    service.watch(socket);

    // A real interval this time, because "the timer is wired to the sweep" is
    // the one claim a hand-driven sweep cannot make.
    await vi.waitFor(() => {
      expect(socket.pings()).toBeGreaterThan(0);
    });

    service.stop();
    const atStop = socket.pings();

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(socket.pings()).toBe(atStop);

    // And stopping twice is not an error, because shutdown paths overlap.
    expect(() => {
      service.stop();
    }).not.toThrow();
  });
});
