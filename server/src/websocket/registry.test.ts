/**
 * The registry: what it indexes on, that a key holds several sockets, and that
 * nothing survives a disconnect.
 *
 * Three groups carry the weight:
 *
 * - **`indexing`** — the key is the *pair*. A same-named agent in another
 *   project and another agent in the same project are different recipients, and
 *   the tests say so rather than trusting the key builder.
 * - **`removal`** — the interesting cases are not "release works". They are
 *   releasing twice, releasing after a clear, and releasing a handle whose key
 *   has since been reused by a different socket, because those are the three
 *   ways a registration handle removes the wrong thing.
 * - **`no leak under churn`** — a thousand connect/disconnect cycles, driven
 *   through the real handshake from `./handler.ts`, asserting the registry is
 *   empty at the end. A single removal passing tells you nothing about a
 *   process that has been up for a week.
 */

import { AgentId, MachineId, ProjectId, SessionId, UserId } from '@agentchat/protocol';
import { describe, expect, it } from 'vitest';
import { MIN_JWT_SECRET_LENGTH } from '../auth/tokens.js';
import type { AuthenticatedUser } from '../plugins/auth.js';
import {
  type ListSessionsRequest,
  SESSION_STATUS,
  type SessionRecord,
} from '../services/sessions.js';
import type { ServerFrame, SocketIdentity } from './frames.js';
import {
  createWebSocketHandler,
  type FrameSocket,
  type SessionLookup,
  type SocketLogger,
} from './handler.js';
import {
  createSocketRegistry,
  type DeliverySocket,
  type Registration,
  ROUTE_KEY_SEPARATOR,
  routeKey,
  type SocketRegistry,
} from './registry.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER = UserId.generate();
const AGENT = AgentId.generate();
const OTHER_AGENT = AgentId.generate();
const PROJECT = ProjectId.generate();
const OTHER_PROJECT = ProjectId.generate();

/** An identity, defaulting to the agent and project every test routes on. */
function identity(overrides: Partial<SocketIdentity> = {}): SocketIdentity {
  return {
    userId: overrides.userId ?? USER,
    sessionId: overrides.sessionId ?? SessionId.generate(),
    agentId: overrides.agentId ?? AGENT,
    projectId: overrides.projectId ?? PROJECT,
  };
}

/** A socket that records what it was sent. */
interface FakeSocket extends DeliverySocket {
  readonly frames: ServerFrame[];
}

function socket(overrides: Partial<SocketIdentity> = {}): FakeSocket {
  const frames: ServerFrame[] = [];
  return {
    identity: identity(overrides),
    frames,
    send(frame: ServerFrame): void {
      frames.push(frame);
    },
  };
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

describe('routeKey', () => {
  it('is the agent and the project, in that order', () => {
    expect(routeKey({ agentId: AGENT, projectId: PROJECT })).toBe(
      `${AGENT}${ROUTE_KEY_SEPARATOR}${PROJECT}`,
    );
  });

  it('separates the halves unambiguously', () => {
    const key = routeKey({ agentId: AGENT, projectId: PROJECT });
    expect(key.split(ROUTE_KEY_SEPARATOR)).toEqual([AGENT, PROJECT]);
  });

  it('reads the pair off anything carrying one', () => {
    expect(routeKey(identity())).toBe(routeKey({ agentId: AGENT, projectId: PROJECT }));
  });
});

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

describe('indexing', () => {
  it('files a socket under its agent and project', () => {
    const registry = createSocketRegistry();
    const listener = socket();

    registry.register(listener);

    expect(registry.socketsFor({ agentId: AGENT, projectId: PROJECT })).toEqual([listener]);
    expect(registry.size).toBe(1);
    expect(registry.routeCount).toBe(1);
  });

  it('holds several sockets under one key', () => {
    const registry = createSocketRegistry();
    const laptop = socket();
    const buildBox = socket();
    const third = socket();

    registry.register(laptop);
    registry.register(buildBox);
    registry.register(third);

    expect(registry.socketsFor({ agentId: AGENT, projectId: PROJECT })).toEqual([
      laptop,
      buildBox,
      third,
    ]);
    expect(registry.size).toBe(3);
    expect(registry.routeCount).toBe(1);
  });

  it('does not confuse the same agent in another project', () => {
    const registry = createSocketRegistry();
    const here = socket();
    const there = socket({ projectId: OTHER_PROJECT });

    registry.register(here);
    registry.register(there);

    expect(registry.socketsFor({ agentId: AGENT, projectId: PROJECT })).toEqual([here]);
    expect(registry.socketsFor({ agentId: AGENT, projectId: OTHER_PROJECT })).toEqual([there]);
    expect(registry.routeCount).toBe(2);
  });

  it('does not confuse another agent in the same project', () => {
    const registry = createSocketRegistry();
    const mine = socket();
    const theirs = socket({ agentId: OTHER_AGENT });

    registry.register(mine);
    registry.register(theirs);

    expect(registry.socketsFor({ agentId: AGENT, projectId: PROJECT })).toEqual([mine]);
    expect(registry.socketsFor({ agentId: OTHER_AGENT, projectId: PROJECT })).toEqual([theirs]);
  });

  it('answers with nothing for a pair it has never seen', () => {
    const registry = createSocketRegistry();

    expect(registry.socketsFor({ agentId: AGENT, projectId: PROJECT })).toEqual([]);
    expect(registry.size).toBe(0);
    expect(registry.routeCount).toBe(0);
  });

  it('hands out a snapshot, not the live set', () => {
    const registry = createSocketRegistry();
    const first = socket();
    registry.register(first);

    const before = registry.socketsFor({ agentId: AGENT, projectId: PROJECT });
    registry.register(socket());

    expect(before).toEqual([first]);
    expect(registry.socketsFor({ agentId: AGENT, projectId: PROJECT })).toHaveLength(2);
  });

  it('counts one registration for a socket registered twice', () => {
    const registry = createSocketRegistry();
    const listener = socket();

    const first = registry.register(listener);
    registry.register(listener);

    expect(registry.size).toBe(1);
    first.release();
    expect(registry.size).toBe(0);
  });

  it('reports the key a socket was filed under', () => {
    const registry = createSocketRegistry();
    const listener = socket();

    expect(registry.register(listener).key).toBe(routeKey(listener.identity));
  });
});

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

describe('removal', () => {
  it('releasing a registration removes exactly that socket', () => {
    const registry = createSocketRegistry();
    const going = socket();
    const staying = socket();
    const registration = registry.register(going);
    registry.register(staying);

    registration.release();

    expect(registry.socketsFor({ agentId: AGENT, projectId: PROJECT })).toEqual([staying]);
    expect(registry.size).toBe(1);
  });

  it('drops the key once its last socket goes', () => {
    const registry = createSocketRegistry();
    const registration = registry.register(socket());

    registration.release();

    expect(registry.routeCount).toBe(0);
    expect(registry.size).toBe(0);
  });

  it('is idempotent, because an error and a close are two removals for one socket', () => {
    const registry = createSocketRegistry();
    const registration = registry.register(socket());
    registry.register(socket());

    registration.release();
    registration.release();
    registration.release();

    expect(registry.size).toBe(1);
  });

  it('does not disturb a socket that reused the key after it left', () => {
    const registry = createSocketRegistry();
    const first = registry.register(socket());
    first.release();

    const reconnected = socket();
    registry.register(reconnected);
    first.release();

    expect(registry.socketsFor({ agentId: AGENT, projectId: PROJECT })).toEqual([reconnected]);
    expect(registry.routeCount).toBe(1);
  });

  it('removes a socket without its handle', () => {
    const registry = createSocketRegistry();
    const listener = socket();
    registry.register(listener);

    expect(registry.remove(listener)).toBe(true);
    expect(registry.remove(listener)).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('reports a socket it never held as not removed', () => {
    const registry = createSocketRegistry();

    expect(registry.remove(socket())).toBe(false);
  });

  it('leaves a released handle harmless after remove took the socket', () => {
    const registry = createSocketRegistry();
    const listener = socket();
    const registration = registry.register(listener);

    registry.remove(listener);
    registration.release();

    expect(registry.size).toBe(0);
    expect(registry.routeCount).toBe(0);
  });

  it('forgets everything on clear, and says how much', () => {
    const registry = createSocketRegistry();
    const registration = registry.register(socket());
    registry.register(socket({ projectId: OTHER_PROJECT }));

    expect(registry.clear()).toBe(2);
    expect(registry.size).toBe(0);
    expect(registry.routeCount).toBe(0);

    // The shutdown case: connections whose `closed` hook still runs afterwards,
    // and — worse — a listener that reconnects between the clear and the hook.
    const reconnected = socket();
    registry.register(reconnected);
    registration.release();

    expect(registry.size).toBe(1);
    expect(registry.socketsFor({ agentId: AGENT, projectId: PROJECT })).toEqual([reconnected]);
  });

  it('clears an empty registry without complaint', () => {
    const registry = createSocketRegistry();

    expect(registry.clear()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Churn
// ---------------------------------------------------------------------------

/** How many connect/disconnect cycles the leak tests run. */
const CYCLES = 1_000;

describe('no leak under churn', () => {
  it('is empty after a thousand register/release cycles on one key', () => {
    const registry = createSocketRegistry();

    for (let index = 0; index < CYCLES; index += 1) {
      registry.register(socket()).release();
    }

    expect(registry.size).toBe(0);
    expect(registry.routeCount).toBe(0);
  });

  it('is empty after a thousand overlapping cycles across many keys', () => {
    const registry = createSocketRegistry();
    const open: Registration[] = [];

    for (let index = 0; index < CYCLES; index += 1) {
      open.push(
        registry.register(
          socket({
            agentId: index % 2 === 0 ? AGENT : OTHER_AGENT,
            projectId: index % 3 === 0 ? PROJECT : OTHER_PROJECT,
          }),
        ),
      );

      // Keep a few connections open at all times, so the map is never
      // incidentally empty and a key deleted while another socket still held it
      // would show up as a lost recipient rather than as a clean finish.
      const oldest = open.length > 8 ? open.shift() : undefined;
      oldest?.release();
    }

    for (const registration of open) {
      registration.release();
    }

    expect(registry.size).toBe(0);
    expect(registry.routeCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Through the real handshake
// ---------------------------------------------------------------------------

/** A socket the handler can drive. */
function frameSocket(): FrameSocket {
  return {
    send(): void {
      // The handshake's frames are `handler.test.ts`'s subject, not this one's.
    },
    close(): void {
      // Closing is reported back through `disconnected` by the adapter.
    },
  };
}

const SILENT_LOGGER: SocketLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

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

const SESSIONS: SessionLookup = {
  list: (request: ListSessionsRequest): Promise<SessionRecord[]> =>
    Promise.resolve(request.userId === USER ? [SESSION_RECORD] : []),
};

const CALLER: AuthenticatedUser = {
  id: USER,
  issuedAt: new Date('2026-09-08T12:00:00.000Z'),
  expiresAt: new Date('2026-09-08T13:00:00.000Z'),
};

/**
 * Runs one connection through the handshake, registering and releasing on the
 * hooks T-306 built for exactly this.
 *
 * @param registry - The registry under test.
 * @param close - How the connection ends.
 */
async function cycle(
  registry: SocketRegistry,
  close: (connection: { disconnected(code: number): Promise<void> }) => Promise<void>,
): Promise<void> {
  const registrations = new WeakMap<object, Registration>();

  const handler = createWebSocketHandler({
    jwtSecret: 'a'.repeat(MIN_JWT_SECRET_LENGTH),
    sessions: SESSIONS,
    logger: SILENT_LOGGER,
    observer: {
      bound: (binding) => {
        registrations.set(binding, registry.register(binding));
        return 0;
      },
      closed: (binding) => {
        registrations.get(binding)?.release();
      },
    },
  });

  const connection = handler.connect(frameSocket(), CALLER);
  await connection.receive(JSON.stringify({ type: 'hello', sessionId: SESSION }));
  await close(connection);
}

describe('no leak through the handshake', () => {
  it('registers a bound socket and deregisters it when the socket closes', async () => {
    const registry = createSocketRegistry();
    const observed: number[] = [];

    await cycle(registry, async (connection) => {
      observed.push(registry.size);
      await connection.disconnected(1_000);
    });

    expect(observed).toEqual([1]);
    expect(registry.size).toBe(0);
    expect(registry.routeCount).toBe(0);
  });

  it('is empty after a thousand connect/disconnect cycles', async () => {
    const registry = createSocketRegistry();

    for (let index = 0; index < CYCLES; index += 1) {
      await cycle(registry, (connection) => connection.disconnected(1_000));
    }

    expect(registry.size).toBe(0);
    expect(registry.routeCount).toBe(0);
  });

  it('is empty when a connection reports an error and then a close', async () => {
    const registry = createSocketRegistry();

    for (let index = 0; index < 100; index += 1) {
      await cycle(registry, async (connection) => {
        // Both paths a transport takes when a socket fails: `ws` emits `error`
        // and then `close`, and an adapter that reported each of them would
        // deregister twice for one connection.
        await connection.disconnected(1_011);
        await connection.disconnected(1_006);
      });
    }

    expect(registry.size).toBe(0);
    expect(registry.routeCount).toBe(0);
  });
});
