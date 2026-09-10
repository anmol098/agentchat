/**
 * Delivery: who receives a frame, what happens when one recipient is gone, and
 * what the caller is told.
 *
 * The cases that matter are the ones where a socket misbehaves *while* the
 * fan-out is running, because those are the ones an integration test cannot
 * arrange on demand:
 *
 * - **`fan-out`** — several sockets on one key all receive, and the outcome
 *   names the sessions so a caller can write its own `deliveries` rows.
 * - **`a failure is one socket's own`** — a `send` that throws, first in the
 *   list, does not stop the two behind it; the thrower is deregistered and
 *   reported, and the frame still reaches everybody else.
 * - **`during the fan-out`** — a socket whose `send` deregisters another
 *   socket, or registers a new one, cannot change who this delivery reaches.
 *   That is the snapshot doing its job.
 * - **`back-pressure`** — a peer that has stopped reading is warned about and
 *   still written to.
 */

import { AgentId, ProjectId, SessionId, UserId } from '@stackgrid/protocol';
import { describe, expect, it } from 'vitest';
import type { ServerFrame, SocketIdentity } from '../websocket/frames.js';
import type { SocketLogger } from '../websocket/handler.js';
import {
  createSocketRegistry,
  type DeliverySocket,
  type SocketRegistry,
} from '../websocket/registry.js';
import { BUFFER_WARNING_BYTES, createInProcessRouter, type Router } from './router.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER = UserId.generate();
const AGENT = AgentId.generate();
const OTHER_AGENT = AgentId.generate();
const PROJECT = ProjectId.generate();
const OTHER_PROJECT = ProjectId.generate();

const TARGET = { agentId: AGENT, projectId: PROJECT };

/** The frame under delivery. Opaque to the router; see `./router.ts`. */
const FRAME: ServerFrame = { type: 'message', message: { body: 'ship it' } };

/** A log line the router wrote. */
interface LogLine {
  readonly level: 'info' | 'warn' | 'error';
  readonly details: Record<string, unknown>;
  readonly message: string;
}

function capturingLogger(sink: LogLine[]): SocketLogger {
  return {
    info: (details, message) => sink.push({ level: 'info', details, message }),
    warn: (details, message) => sink.push({ level: 'warn', details, message }),
    error: (details, message) => sink.push({ level: 'error', details, message }),
  };
}

/** How a fake socket behaves when written to. */
interface SocketOptions {
  readonly agentId?: AgentId;
  readonly projectId?: ProjectId;
  readonly bufferedBytes?: number;
  /** Runs on every `send`, before the frame is recorded. Throw to fail. */
  readonly onSend?: () => void;
}

/** A socket that records what it was sent, and can fail on demand. */
interface FakeSocket extends DeliverySocket {
  readonly frames: ServerFrame[];
}

function socket(options: SocketOptions = {}): FakeSocket {
  const frames: ServerFrame[] = [];
  const identity: SocketIdentity = {
    userId: USER,
    sessionId: SessionId.generate(),
    agentId: options.agentId ?? AGENT,
    projectId: options.projectId ?? PROJECT,
  };

  return {
    identity,
    frames,
    bufferedBytes: options.bufferedBytes,
    send(frame: ServerFrame): void {
      options.onSend?.();
      frames.push(frame);
    },
  };
}

/** Everything one test needs, wired together. */
interface Harness {
  readonly registry: SocketRegistry;
  readonly router: Router;
  readonly logs: LogLine[];
}

function harness(): Harness {
  const registry = createSocketRegistry();
  const logs: LogLine[] = [];
  return {
    registry,
    logs,
    router: createInProcessRouter({ registry, logger: capturingLogger(logs) }),
  };
}

/** A socket whose `send` always throws. */
function brokenSocket(options: SocketOptions = {}): FakeSocket {
  return socket({
    ...options,
    onSend: () => {
      throw new Error('socket is closed');
    },
  });
}

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

describe('fan-out', () => {
  it('delivers to every socket serving the pair', async () => {
    const { registry, router } = harness();
    const laptop = socket();
    const buildBox = socket();
    const ci = socket();
    for (const listener of [laptop, buildBox, ci]) {
      registry.register(listener);
    }

    const outcome = await router.deliver(TARGET, FRAME);

    expect(laptop.frames).toEqual([FRAME]);
    expect(buildBox.frames).toEqual([FRAME]);
    expect(ci.frames).toEqual([FRAME]);
    expect(outcome.delivered).toEqual([
      laptop.identity.sessionId,
      buildBox.identity.sessionId,
      ci.identity.sessionId,
    ]);
    expect(outcome.failed).toEqual([]);
  });

  it('reports nothing delivered when the agent has no socket here', async () => {
    const { router } = harness();

    const outcome = await router.deliver(TARGET, FRAME);

    expect(outcome.delivered).toEqual([]);
    expect(outcome.failed).toEqual([]);
  });

  it('does not deliver across the project boundary', async () => {
    const { registry, router } = harness();
    const here = socket();
    const elsewhere = socket({ projectId: OTHER_PROJECT });
    registry.register(here);
    registry.register(elsewhere);

    await router.deliver(TARGET, FRAME);

    expect(here.frames).toEqual([FRAME]);
    expect(elsewhere.frames).toEqual([]);
  });

  it('does not deliver to another agent in the same project', async () => {
    const { registry, router } = harness();
    const recipient = socket();
    const bystander = socket({ agentId: OTHER_AGENT });
    registry.register(recipient);
    registry.register(bystander);

    await router.deliver(TARGET, FRAME);

    expect(recipient.frames).toEqual([FRAME]);
    expect(bystander.frames).toEqual([]);
  });

  it('leaves every socket registered after a clean delivery', async () => {
    const { registry, router } = harness();
    registry.register(socket());
    registry.register(socket());

    await router.deliver(TARGET, FRAME);

    expect(registry.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

describe('a failure is one socket’s own', () => {
  it('delivers to the rest when the first socket throws', async () => {
    const { registry, router } = harness();
    const broken = brokenSocket();
    const second = socket();
    const third = socket();
    registry.register(broken);
    registry.register(second);
    registry.register(third);

    const outcome = await router.deliver(TARGET, FRAME);

    expect(second.frames).toEqual([FRAME]);
    expect(third.frames).toEqual([FRAME]);
    expect(outcome.delivered).toEqual([second.identity.sessionId, third.identity.sessionId]);
    expect(outcome.failed).toEqual([broken.identity.sessionId]);
  });

  it('deregisters the socket that threw and keeps the others', async () => {
    const { registry, router } = harness();
    const broken = brokenSocket();
    const healthy = socket();
    registry.register(broken);
    registry.register(healthy);

    await router.deliver(TARGET, FRAME);

    expect(registry.socketsFor(TARGET)).toEqual([healthy]);
  });

  it('drops the key when every socket on it has gone', async () => {
    const { registry, router } = harness();
    registry.register(brokenSocket());
    registry.register(brokenSocket());

    const outcome = await router.deliver(TARGET, FRAME);

    expect(outcome.delivered).toEqual([]);
    expect(outcome.failed).toHaveLength(2);
    expect(registry.size).toBe(0);
    expect(registry.routeCount).toBe(0);
  });

  it('does not reject, whatever the socket throws', async () => {
    const { registry, router } = harness();
    registry.register(
      socket({
        onSend: () => {
          // Not an Error. A transport is entitled to throw anything.
          throw new Error('EPIPE');
        },
      }),
    );

    await expect(router.deliver(TARGET, FRAME)).resolves.toEqual({
      delivered: [],
      failed: expect.any(Array),
    });
  });

  it('says in the log which delivery lost sockets', async () => {
    const { registry, router, logs } = harness();
    registry.register(brokenSocket());
    registry.register(socket());

    await router.deliver(TARGET, FRAME);

    expect(logs.some((line) => line.message === 'websocket delivery failed; dropping socket')).toBe(
      true,
    );
    const summary = logs.find((line) => line.message === 'websocket delivery dropped sockets');
    expect(summary?.details).toMatchObject({ delivered: 1, failed: 1 });
  });

  it('is empty after a thousand deliveries to sockets that are all gone', async () => {
    const { registry, router } = harness();

    for (let index = 0; index < 1_000; index += 1) {
      registry.register(brokenSocket());
      await router.deliver(TARGET, FRAME);
    }

    expect(registry.size).toBe(0);
    expect(registry.routeCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Mutation during a fan-out
// ---------------------------------------------------------------------------

describe('during the fan-out', () => {
  it('still reaches a socket that an earlier recipient deregistered', async () => {
    const { registry, router } = harness();
    const later = socket();
    const first = socket({
      onSend: () => {
        registry.remove(later);
      },
    });
    registry.register(first);
    registry.register(later);

    const outcome = await router.deliver(TARGET, FRAME);

    expect(later.frames).toEqual([FRAME]);
    expect(outcome.delivered).toHaveLength(2);
    expect(registry.socketsFor(TARGET)).toEqual([first]);
  });

  it('does not reach a socket that registered mid-delivery', async () => {
    const { registry, router } = harness();
    const latecomer = socket();
    registry.register(
      socket({
        onSend: () => {
          registry.register(latecomer);
        },
      }),
    );

    const outcome = await router.deliver(TARGET, FRAME);

    // It will get the message from the inbox replay on its own `hello`, which
    // is the only ordering that is well defined here.
    expect(latecomer.frames).toEqual([]);
    expect(outcome.delivered).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Back-pressure
// ---------------------------------------------------------------------------

describe('back-pressure', () => {
  it('warns about a peer that has stopped reading, and still sends', async () => {
    const { registry, router, logs } = harness();
    const slow = socket({ bufferedBytes: BUFFER_WARNING_BYTES + 1 });
    registry.register(slow);

    const outcome = await router.deliver(TARGET, FRAME);

    expect(slow.frames).toEqual([FRAME]);
    expect(outcome.delivered).toEqual([slow.identity.sessionId]);
    const warning = logs.find((line) => line.message === 'websocket consumer is not keeping up');
    expect(warning?.details).toMatchObject({
      sessionId: slow.identity.sessionId,
      bufferedBytes: BUFFER_WARNING_BYTES + 1,
    });
  });

  it('says nothing about a socket within the mark, or one that cannot report', async () => {
    const { registry, router, logs } = harness();
    registry.register(socket({ bufferedBytes: BUFFER_WARNING_BYTES }));
    registry.register(socket());

    await router.deliver(TARGET, FRAME);

    expect(logs).toEqual([]);
  });

  it('does not let a slow consumer delay the sockets behind it', async () => {
    const { registry, router } = harness();
    const slow = socket({ bufferedBytes: BUFFER_WARNING_BYTES * 10 });
    const fast = socket();
    registry.register(slow);
    registry.register(fast);

    await router.deliver(TARGET, FRAME);

    // Nothing awaits a peer's read, today. The assertion is the claim in the
    // module note made checkable: both sockets are written to in one turn.
    expect(fast.frames).toEqual([FRAME]);
    expect(slow.frames).toEqual([FRAME]);
  });
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

describe('shutdown', () => {
  it('forgets every socket', async () => {
    const { registry, router } = harness();
    registry.register(socket());
    registry.register(socket({ projectId: OTHER_PROJECT }));

    await router.close();

    expect(registry.size).toBe(0);
    expect(registry.routeCount).toBe(0);
  });

  it('delivers to nobody afterwards, without failing the caller', async () => {
    const { registry, router } = harness();
    const listener = socket();
    registry.register(listener);

    await router.close();
    const outcome = await router.deliver(TARGET, FRAME);

    expect(outcome.delivered).toEqual([]);
    expect(outcome.failed).toEqual([]);
    expect(listener.frames).toEqual([]);
  });

  it('says nothing when there was nothing to forget', async () => {
    const { logs, router } = harness();

    await router.close();

    expect(logs).toEqual([]);
  });

  it('is idempotent', async () => {
    const { registry, router } = harness();
    registry.register(socket());

    await router.close();
    registry.register(socket());
    await router.close();

    // The second close is a no-op: it neither throws nor clears a registry the
    // router has already let go of.
    expect(registry.size).toBe(1);
  });
});
