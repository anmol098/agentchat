/**
 * Liveness, end to end, on the application a deployment runs (T-041).
 *
 * `server/src/websocket/heartbeat.test.ts` drives the module directly: it hands
 * `createHeartbeat` a fake socket and a fake clock and proves the sweep reaps
 * what it should. That test passed for a week while nothing in the running
 * server ever called `createHeartbeat`, which is the failure this file exists
 * to make impossible.
 *
 * So nothing here is injected except two things that a test may not have: the
 * identity provider, which must not be reached over the network, and the
 * heartbeat's two intervals, because the real ones are twenty and sixty seconds
 * and the property under test is about elapsed time. Everything else is real —
 * a real port, a real WebSocket upgrade, a token minted by the real device
 * flow, a session registered through `POST /sessions`, and a real Postgres that
 * the assertions read straight out of.
 *
 * ## What "silent" means here, and why it has to be simulated this way
 *
 * The peer this feature exists for is not one that refuses to answer — it is
 * one that is *gone*: a laptop that shut its lid, a NAT that dropped its
 * mapping, a process killed with `SIGKILL`. TCP says nothing about any of them,
 * and that silence is the whole problem.
 *
 * A `ws` client cannot decline to answer a ping: RFC 6455 §5.5.2 compliance
 * lives below application code, which is precisely the argument
 * `websocket/heartbeat.ts` makes for using a control frame in the first place.
 * Pausing the client's underlying TCP socket is the faithful simulation: bytes
 * arrive at the machine, nothing reads them, no pong is ever composed, and the
 * server sees exactly what it sees when the peer has vanished.
 *
 * ## The two halves, and why both are asserted
 *
 * A heartbeat that reaps everything passes a test that only watches the silent
 * socket, and a heartbeat that reaps nothing passes a test that only watches
 * the live one. The two sessions run side by side, through the same sweep, for
 * the same duration, and the assertions are about the difference between them.
 */

import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createApp, WEBSOCKET_PATH } from '../src/app.js';
import type { IdentityProvider, ProviderIdentity } from '../src/auth/identity.js';
import { MIN_JWT_SECRET_LENGTH } from '../src/auth/tokens.js';
import { loadConfig } from '../src/config.js';
import { sessions } from '../src/db/schema/messaging.js';
import { SESSION_STATUS } from '../src/services/sessions.js';
import { CloseCode } from '../src/websocket/frames.js';

/** The generated SQL migrations, exactly as the server image will ship them. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

/** The signing key for this run. */
const JWT_SECRET = randomUUID()
  .repeat(2)
  .slice(0, MIN_JWT_SECRET_LENGTH + 8);

/** The provider's own device code, brokered rather than proxied. */
const PROVIDER_DEVICE_CODE = `provider-device-code-${randomUUID()}`;

/** Seconds the stub advertises between polls. The contract's minimum. */
const INTERVAL = 1;

/**
 * How often the sweep runs in this suite. Plan §4.3's twenty seconds, in
 * milliseconds instead, so a test takes a second rather than a minute.
 */
const PING_INTERVAL_MS = 25;

/**
 * How long a socket may be silent here before it is reaped.
 *
 * Twelve sweeps' worth, keeping the real module's ratio — a peer has to miss
 * several consecutive pings, so one slow event-loop turn on a loaded machine
 * cannot reap a socket that is answering. The suite's timeouts below are many
 * multiples of it again.
 */
const PONG_TIMEOUT_MS = 300;

/** How long an assertion about the database waits before it gives up. */
const SETTLE_TIMEOUT_MS = 10_000;

/**
 * RFC 6455's "abnormal closure", as a client observes it.
 *
 * Not a member of `CloseCode`: the server never *sends* 1006 — no endpoint may,
 * per §7.4.1 — it is what a peer reports when the connection went away without
 * a closing handshake, which is exactly what `terminate()` produces and exactly
 * what a reaped socket should look like from the outside.
 */
const ABNORMAL_CLOSURE = 1006;

/** A short unique suffix for names that must not collide between runs. */
const unique = (): string => randomUUID().replaceAll('-', '').slice(0, 12);

let pool: Pool;
let db: NodePgDatabase<Record<string, never>>;
let databaseName: string;
let app: FastifyInstance;

/** Where the listening server is, e.g. `ws://127.0.0.1:54123`. */
let origin: string;

/** The access token the device flow issued. */
let bearer: string;

/** The project the listening agent is in. */
let projectId: string;

/** The agent that listens. */
let agentId: string;

/** Connection string for `databaseName` on the server `DATABASE_URL` names. */
function urlForScratchDatabase(name: string): string {
  const raw = process.env['DATABASE_URL'];
  if (raw === undefined) {
    throw new Error('DATABASE_URL is not set; the global setup should have refused to start.');
  }

  const url = new URL(raw);
  url.pathname = `/${name}`;
  return url.toString();
}

/** An identity provider that approves on the first poll. */
function stubProvider(identity: ProviderIdentity): IdentityProvider {
  return {
    startDeviceAuthorization: () =>
      Promise.resolve({
        deviceCode: PROVIDER_DEVICE_CODE,
        userCode: 'WDJB-MJHT',
        verificationUri: 'https://example.test/device',
        interval: INTERVAL,
        expiresIn: 900,
      }),
    redeemDeviceAuthorization: () => Promise.resolve({ status: 'approved' as const, identity }),
  };
}

/** Sleeps, because the advertised polling interval is a real second. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Sends an authenticated HTTP request, for the setup this suite does over HTTP. */
async function asUser(method: 'POST' | 'GET', url: string, payload?: unknown): Promise<unknown> {
  const response = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${bearer}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

  expect(response.statusCode, `${method} ${url} → ${response.body}`).toBeLessThan(300);
  return response.json();
}

/**
 * Reads a session's status straight from the table.
 *
 * Not through the service: an assertion about what the close path stored should
 * not be mediated by the code that stored it.
 *
 * @param sessionId - The session.
 * @returns Its status.
 */
async function statusOf(sessionId: string): Promise<string> {
  const rows = await db
    .select({ status: sessions.status })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    throw new Error(`No session row for ${sessionId}.`);
  }
  return row.status;
}

/**
 * Waits for a session to reach a status, or fails saying what it reached.
 *
 * Polled rather than awaited on an event, because the write happens in the
 * server's own close handler and there is nothing on the client side to
 * synchronise with — which is the situation a deployment is in too.
 *
 * @param sessionId - The session to watch.
 * @param wanted - The status expected.
 */
async function untilStatus(sessionId: string, wanted: string): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;

  for (;;) {
    const status = await statusOf(sessionId);
    if (status === wanted) {
      return;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `session ${sessionId} was ${status}, not ${wanted}, after ${SETTLE_TIMEOUT_MS}ms`,
      );
    }

    await sleep(20);
  }
}

/** One frame off the wire, as a bag of fields. */
type Frame = Record<string, unknown>;

/** A connected client socket, and the levers this suite pulls on it. */
interface Listener {
  /** The next frame, in order. Rejects rather than hanging. */
  next(): Promise<Frame>;

  /** Sends one client frame. */
  send(frame: unknown): void;

  /**
   * Stops reading the connection, without closing it.
   *
   * The peer that has vanished, faithfully: the TCP connection is still open,
   * bytes still arrive, and nothing on this side will ever look at them — so no
   * pong is composed, at a layer below anything application code could decline
   * to do.
   */
  goSilent(): void;

  /**
   * Starts reading again, so this side can see how the connection ended.
   *
   * A paused socket does not process the peer's disconnection either — that is
   * what pausing means — so the close event a terminated socket produces is
   * only observable once reading resumes. The server had already terminated it
   * by then; this reads the answer rather than provoking it.
   */
  resume(): void;

  /** Resolves when the socket ends, whichever side ended it. */
  ended(): Promise<number>;

  /** Closes from this end, the way a client that is leaving does. */
  close(): void;
}

/** Rejects if a promise has not settled in time, naming what was waited for. */
function within<T>(what: string, promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error(`timed out after ${SETTLE_TIMEOUT_MS}ms waiting for ${what}`));
      }, SETTLE_TIMEOUT_MS).unref();
    }),
  ]);
}

/**
 * Opens a real WebSocket against the listening server.
 *
 * @returns The connected listener, once the upgrade has completed.
 */
function connect(): Promise<Listener> {
  const socket = new WebSocket(`${origin}${WEBSOCKET_PATH}`, {
    headers: { authorization: `Bearer ${bearer}` },
  });

  const received: Frame[] = [];
  const waiting: ((frame: Frame) => void)[] = [];
  const closing: ((code: number) => void)[] = [];
  let closed: number | undefined;

  socket.on('message', (data: Buffer) => {
    const frame = JSON.parse(data.toString('utf8')) as Frame;
    const waiter = waiting.shift();
    if (waiter === undefined) {
      received.push(frame);
    } else {
      waiter(frame);
    }
  });

  socket.on('close', (code: number) => {
    closed = code;
    for (const waiter of closing.splice(0)) {
      waiter(code);
    }
  });

  // A socket the server terminates ends abruptly, which `ws` reports as an
  // error before its close. Swallowed: the close is what is asserted on, and an
  // unhandled 'error' event takes the process down.
  socket.on('error', () => undefined);

  const listener: Listener = {
    next(): Promise<Frame> {
      const buffered = received.shift();
      if (buffered !== undefined) {
        return Promise.resolve(buffered);
      }

      return within(
        'a frame',
        new Promise<Frame>((resolve) => {
          waiting.push(resolve);
        }),
      );
    },

    send(frame: unknown): void {
      socket.send(JSON.stringify(frame));
    },

    goSilent(): void {
      // `ws` exposes the underlying connection as `_socket`. Reaching for it is
      // the point rather than a shortcut: there is no supported way to make a
      // compliant WebSocket implementation stop answering pings, because not
      // answering is not a behaviour a client is allowed to have. Only the
      // transport can be made to go quiet.
      const raw = (socket as unknown as { _socket: Socket })._socket;
      raw.pause();
    },

    resume(): void {
      const raw = (socket as unknown as { _socket: Socket })._socket;
      raw.resume();
    },

    ended(): Promise<number> {
      if (closed !== undefined) {
        return Promise.resolve(closed);
      }

      return within(
        'the socket to end',
        new Promise<number>((resolve) => {
          closing.push(resolve);
        }),
      );
    },

    close(): void {
      socket.close(CloseCode.NORMAL, 'test finished');
    },
  };

  return within(
    'the upgrade',
    new Promise<Listener>((resolve, reject) => {
      socket.on('open', () => {
        resolve(listener);
      });
      socket.on('error', reject);
    }),
  );
}

/**
 * Registers a session and binds a socket to it.
 *
 * @returns The session identifier and the connected listener.
 */
async function listen(): Promise<{ sessionId: string; listener: Listener }> {
  const session = (await asUser('POST', '/sessions', {
    agentId,
    projectId,
    machine: { name: `heartbeat-test-${unique()}` },
    runtime: 'vitest',
    workingDirectory: '/tmp/agentchat-heartbeat',
  })) as { sessionId: string };

  const listener = await connect();
  listener.send({
    type: 'hello',
    sessionId: session.sessionId,
    client: 'agentchat-heartbeat/0.0.0',
  });

  // `ready` is the server's own statement that the socket is bound: the
  // handshake writes it only after the observer's `bound` has returned. Waiting
  // for it means the session under test is genuinely attached to this socket.
  for (;;) {
    const frame = await listener.next();
    if (frame['type'] === 'ready') {
      break;
    }
  }

  expect(await statusOf(session.sessionId)).toBe(SESSION_STATUS.ACTIVE);
  return { sessionId: session.sessionId, listener };
}

beforeAll(async () => {
  databaseName = `agentchat_t041_${unique()}`;

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`create database "${databaseName}"`);
  } finally {
    await admin.end();
  }

  pool = new Pool({ connectionString: urlForScratchDatabase(databaseName) });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  const config = loadConfig({
    DATABASE_URL: urlForScratchDatabase(databaseName),
    HOST: '127.0.0.1',
    PORT: '0',
    LOG_LEVEL: 'warn',
    JWT_SECRET,
    GITHUB_CLIENT_ID: 'Iv1.integrationtest',
    GITHUB_CLIENT_SECRET: `ghs_${randomUUID()}`,
  });

  const identity: ProviderIdentity = {
    subject: `gh-${unique()}`,
    username: `pulse-${unique()}`,
    displayName: 'Heartbeat Tester',
    email: 'pulse@example.com',
  };

  app = createApp({
    config,
    database: { ping: () => pool.query('select 1').then(() => undefined), db },
    logger: pino({ level: 'warn' }, pino.destination({ dest: '/dev/null', sync: true })),
    identityProvider: stubProvider(identity),
    heartbeat: { intervalMs: PING_INTERVAL_MS, timeoutMs: PONG_TIMEOUT_MS },
  });

  await app.listen({ host: config.host, port: config.port });

  const address = app.addresses()[0];
  if (address === undefined) {
    throw new Error('the server reported no address after listening');
  }
  origin = `ws://127.0.0.1:${address.port}`;

  const start = await app.inject({ method: 'POST', url: '/auth/device/start', payload: {} });
  expect(start.statusCode).toBe(200);

  await sleep(INTERVAL * 1000 + 100);

  const poll = await app.inject({
    method: 'POST',
    url: '/auth/device/poll',
    payload: { deviceCode: start.json().deviceCode },
  });

  expect(poll.statusCode, poll.body).toBe(200);
  bearer = poll.json().accessToken;

  const project = (await asUser('POST', '/projects', { name: `Pulse ${unique()}` })) as {
    id: string;
  };
  projectId = project.id;

  const agent = (await asUser('POST', '/agents', { name: `listener-${unique()}` })) as {
    id: string;
  };
  agentId = agent.id;

  await asUser('POST', `/agents/${agentId}/projects`, { projectId });
});

afterAll(async () => {
  // Also an assertion that shutdown terminates. `app.close()` waits for the
  // HTTP server, a WebSocket is a connection it would wait for forever, and the
  // heartbeat's interval is stopped in the same hook — so this teardown hangs
  // rather than fails if either half of the shutdown path regresses.
  await app?.close();
  await pool?.end();

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await admin.end();
  }
});

describe('a socket that stops answering', () => {
  /**
   * The whole path, in one test: silence, a reaped socket, an honest listing.
   *
   * Nothing about it can pass for the wrong reason. Both listeners bind real
   * sessions on the same server and are watched by the same sweep; one of them
   * stops reading its connection and the other does not; and the assertions are
   * that the first is closed and its session marked stale *while the second is
   * still active*. A heartbeat that was not wired at all fails the first half;
   * one that reaped indiscriminately fails the second.
   */
  it('is closed, its session marked stale, and its neighbour left alone', async () => {
    const quiet = await listen();
    const alive = await listen();

    quiet.listener.goSilent();

    // Presence stops lying, and this is the half that needed a service method
    // to exist. The sweeper would have reached the same row on its own — within
    // a minute of the last heartbeat — so what is being measured here is the
    // minute, which is a minute of a listing telling somebody to message an
    // agent that will never answer.
    await untilStatus(quiet.sessionId, SESSION_STATUS.STALE);

    // The neighbour answered every ping in that same window — its `ws`
    // implementation does that below application code — so nothing touched it.
    expect(await statusOf(alive.sessionId)).toBe(SESSION_STATUS.ACTIVE);

    // And the socket itself is gone, destroyed rather than closed politely: the
    // peer has already demonstrated it answers nothing, so there is nobody to
    // complete a closing handshake with. 1006 is RFC 6455's "abnormal closure",
    // which is what happened, and it is what the disconnect logging
    // distinguishes from a listener that chose to leave.
    quiet.listener.resume();
    expect(await quiet.listener.ended()).toBe(ABNORMAL_CLOSURE);

    alive.listener.close();
  });

  it('leaves a session stale rather than ended, so the listener can come back', async () => {
    const quiet = await listen();
    quiet.listener.goSilent();

    await untilStatus(quiet.sessionId, SESSION_STATUS.STALE);

    // `stale` is an inference from silence and a reconnecting listener
    // contradicts it; `ended` is terminal and would refuse the reconnection
    // this is meant to survive. A `POST /sessions/:id/heartbeat` revives it.
    const revived = await app.inject({
      method: 'POST',
      url: `/sessions/${quiet.sessionId}/heartbeat`,
      headers: { authorization: `Bearer ${bearer}` },
    });

    expect(revived.statusCode, revived.body).toBe(200);
    expect(await statusOf(quiet.sessionId)).toBe(SESSION_STATUS.ACTIVE);
  });
});

describe('a listener that says goodbye', () => {
  it('marks its session stale when the socket closes', async () => {
    const { sessionId, listener } = await listen();

    listener.close();
    await listener.ended();

    await untilStatus(sessionId, SESSION_STATUS.STALE);
  });

  it('is not an error when the session was ended first, which is the normal order', async () => {
    const { sessionId, listener } = await listen();

    // `agentchat listen` on `SIGTERM`: end the session, then let the socket go.
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(deleted.statusCode, deleted.body).toBe(200);

    listener.close();
    await listener.ended();

    // The close hook ran against an ended session. If that were a `CONFLICT`,
    // every clean exit would log a failure — and the row would still have to be
    // exactly this, because nothing may write `stale` over `ended`.
    await sleep(PONG_TIMEOUT_MS);
    expect(await statusOf(sessionId)).toBe(SESSION_STATUS.ENDED);
  });
});

describe('a listener that comes back', () => {
  /**
   * The regression this whole task turned on, in the order it actually happens.
   *
   * Wiring the heartbeat made three separately-correct modules fatal in
   * combination: a session is marked `stale` whenever its socket closes, the
   * handshake refused anything but an `active` session with `4403`, and
   * `packages/client` treats `4403` as fatal because only a new registration
   * can fix it. `agentchat listen` registers once, so the first disconnection
   * ended a listener permanently.
   *
   * Every step below is the real thing: a real close, the real close hook
   * writing `stale`, a real message routed while nothing was connected, and a
   * real second socket. A handshake that refused a stale session fails at the
   * `hello`; one that bound without reviving leaves the row `stale` and fails
   * the last assertion.
   */
  it('binds the same session again and is given what arrived while it was away', async () => {
    const first = await listen();

    first.listener.close();
    await first.listener.ended();

    // The state every reconnection starts from, not an exotic one: the close
    // hook marks the session stale the moment the socket goes.
    await untilStatus(first.sessionId, SESSION_STATUS.STALE);

    // Something is said to the agent while it has no socket at all. The inbox
    // owes it a delivery regardless — that is §10.1 — and the replay on the
    // next `hello` is how the debt is paid.
    const sender = (await asUser('POST', '/agents', { name: `sender-${unique()}` })) as {
      id: string;
    };
    await asUser('POST', `/agents/${sender.id}/projects`, { projectId });

    const sent = (await asUser('POST', '/messages', {
      projectId,
      senderAgentId: sender.id,
      recipientAgentId: agentId,
      content: 'said while the listener was away',
      clientMessageId: unique(),
    })) as { id: string };

    // The same session id, from a client that never registered a second one.
    const again = await connect();
    again.send({ type: 'hello', sessionId: first.sessionId, client: 'agentchat-heartbeat/0.0.0' });

    const replayed = await again.next();
    expect(replayed).toMatchObject({
      type: 'message',
      message: { messageId: sent.id, content: 'said while the listener was away' },
    });

    // `ready` after the replay, and `pending` counting it: the handshake
    // completed rather than the socket being closed with 4403.
    expect(await again.next()).toMatchObject({ type: 'ready', pending: 1 });

    // And presence is honest again. A `hello` is evidence that something is
    // connected, so the session it named is `active`, not merely tolerated.
    expect(await statusOf(first.sessionId)).toBe(SESSION_STATUS.ACTIVE);

    again.close();
    await again.ended();
  });

  it('still refuses a session that has ended, which is the case 4403 is for', async () => {
    const { sessionId, listener } = await listen();

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(deleted.statusCode, deleted.body).toBe(200);

    listener.close();
    await listener.ended();

    const again = await connect();
    again.send({ type: 'hello', sessionId, client: 'agentchat-heartbeat/0.0.0' });

    // `ended` is terminal, and this is the negative half of the revival: if a
    // `hello` revived everything, `4403` would mean nothing and a client that
    // stops retrying on it would be wrong to.
    expect(await again.next()).toMatchObject({ type: 'error', code: 'SESSION_INVALID' });
    expect(await again.ended()).toBe(CloseCode.SESSION_INVALID);
  });
});
