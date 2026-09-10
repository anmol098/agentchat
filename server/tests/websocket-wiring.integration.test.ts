/**
 * The WebSocket endpoint, over a real socket, on the application a deployment
 * runs.
 *
 * `websocket/handler.test.ts` drives the handshake through a fake transport,
 * `websocket/registry.test.ts` cycles a thousand connections through a map, and
 * `routing/delivery.integration.test.ts` replays a real inbox through a stub
 * socket. Every one of them calls its own module directly, which is exactly the
 * assumption this file exists to check: **that anything in the running server
 * calls them at all.** Until T-033 nothing did. There was no upgrade handler,
 * no transport dependency and no registry, so four finished modules with a
 * combined coverage in the nineties served no client.
 *
 * So nothing here is injected and nothing is stubbed except the identity
 * provider, which a test may not reach over the network. The server listens on
 * a real port, the client is a real WebSocket that performs a real HTTP
 * upgrade, the token is minted by the real device flow, every message is sent
 * through `POST /messages` with a bearer token, and what comes back down the
 * socket was written to a real Postgres on the way.
 *
 * ## The two ways a message arrives, and why both are here
 *
 * **Live (T-038).** A listener that is already connected receives a message the
 * instant the send commits, with no reconnect and nothing polled. That is the
 * product's headline claim, it is one test — *the live delivery, to a listener
 * that was already connected* — and it is the reason this file exists in its
 * current form. Until T-038 the send route was not registered and
 * `DeliveryService.deliver` had no possible caller, so a message to a connected
 * agent was persisted and pushed to nobody; this suite recorded that in a note
 * where this paragraph now is.
 *
 * The failure it guards is specific and quiet. Registering the routes without
 * the delivery hook gives a server that answers 201, writes every row, and
 * passes every other test in this repository while delivering nothing until the
 * listener happens to reconnect. Only a socket that is already open when the
 * send happens can tell those apart, so this test opens one, waits for `ready`
 * — which is the server's own word for "you are registered and caught up" —
 * and only then sends.
 *
 * **Replayed (T-033).** A message written while nobody is listening arrives on
 * the next `hello`, ahead of the `ready` frame that carries the count: Plan
 * §4.3's ordering, exercising the registry, the observer composition, the inbox
 * and the frame encoder. That path is not made redundant by the live one — it
 * is what makes at-least-once true when the fan-out reaches nobody, and the
 * live test's own second half proves the two compose, by connecting a *second*
 * listener afterwards and watching the same message replay to it.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import { SessionId } from '@stackgrid/protocol';
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
 * How long a frame may take to arrive before the test gives up.
 *
 * Short enough that a socket which will never answer fails with a readable
 * message rather than as a suite-level timeout thirty seconds later, and long
 * enough to survive a busy machine — every wait here is a local round trip plus
 * at most one query.
 */
const FRAME_TIMEOUT_MS = 5_000;

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

/** The project both agents are in. */
let projectId: string;

/** The agent that listens, and the one that writes to it. */
let recipientAgentId: string;
let senderAgentId: string;

/** The recipient's registered session, quoted back in every `hello`. */
let sessionId: string;

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
 * Waits until the recipient owes nothing, read over HTTP.
 *
 * An acknowledgement that arrives on a socket is settled asynchronously and a
 * client's `close()` does not flush it: `ws` hands the frame to the server and
 * returns, the handler's hook is still writing when the close is processed, and
 * a *different* connection opened immediately afterwards can read the instant
 * before the write lands. That is not a server bug — a listener that reconnects
 * into that window is replayed a message it has already acknowledged, which is
 * the duplicate this design accepts (Plan §4.4) — but it is a race a test that
 * asserts an exact backlog would lose at random.
 *
 * So the tests below wait for the acknowledgement to be *observable from
 * another connection* before opening one, which is the condition they actually
 * mean. It reads through `GET /messages`, the third route T-038 registered, so
 * the synchronisation is itself a check that the listing is reachable.
 */
async function untilNothingIsPending(): Promise<void> {
  const deadline = Date.now() + FRAME_TIMEOUT_MS;

  for (;;) {
    const page = (await asUser(
      'GET',
      `/messages?projectId=${projectId}&agentId=${recipientAgentId}`,
    )) as { items: unknown[] };

    if (page.items.length === 0) {
      return;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `the recipient still owes ${page.items.length} message(s) after ${FRAME_TIMEOUT_MS}ms`,
      );
    }

    await sleep(25);
  }
}

/** One frame off the wire, as a bag of fields the assertions pick from. */
type Frame = Record<string, unknown>;

/** Why a socket ended. */
interface Closure {
  readonly code: number;
  readonly reason: string;
}

/** A connected client socket, with the frames it has received. */
interface Listener {
  /** The next frame, in order. Rejects rather than hanging. */
  next(): Promise<Frame>;

  /** Sends one client frame. */
  send(frame: unknown): void;

  /** Closes and resolves with the code and reason the server sent. */
  close(): Promise<Closure>;

  /** Resolves when the server closes, without closing from this end. */
  closed(): Promise<Closure>;
}

/** Rejects if a promise has not settled in time, naming what was waited for. */
function within<T>(what: string, promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error(`timed out after ${FRAME_TIMEOUT_MS}ms waiting for ${what}`));
      }, FRAME_TIMEOUT_MS).unref();
    }),
  ]);
}

/**
 * Opens a real WebSocket against the listening server.
 *
 * @param options - The credential, and where to put it.
 * @returns The connected listener, once the upgrade has completed.
 */
function connect(
  options: { readonly token?: string; readonly credentialIn?: 'header' | 'query' } = {},
): Promise<Listener> {
  const { token = bearer, credentialIn = 'header' } = options;

  const url =
    credentialIn === 'query'
      ? `${origin}${WEBSOCKET_PATH}?access_token=${encodeURIComponent(token)}`
      : `${origin}${WEBSOCKET_PATH}`;

  const socket =
    credentialIn === 'query'
      ? new WebSocket(url)
      : new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });

  const received: Frame[] = [];
  const waiting: ((frame: Frame) => void)[] = [];
  const closing: ((closure: Closure) => void)[] = [];
  let closure: Closure | undefined;

  socket.on('message', (data: Buffer) => {
    const frame = JSON.parse(data.toString('utf8')) as Frame;
    const waiter = waiting.shift();
    if (waiter === undefined) {
      received.push(frame);
    } else {
      waiter(frame);
    }
  });

  socket.on('close', (code: number, reason: Buffer) => {
    closure = { code, reason: reason.toString('utf8') };
    for (const waiter of closing.splice(0)) {
      waiter(closure);
    }
  });

  // A socket that ends abruptly emits an error before its close. Swallowed
  // because the close is what the assertions read, and an unhandled 'error'
  // event on an EventEmitter takes the process down.
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

    closed(): Promise<Closure> {
      if (closure !== undefined) {
        return Promise.resolve(closure);
      }

      return within(
        'the socket to close',
        new Promise<Closure>((resolve) => {
          closing.push(resolve);
        }),
      );
    },

    close(): Promise<Closure> {
      const ended = listener.closed();
      socket.close(CloseCode.NORMAL, 'test finished');
      return ended;
    },
  };

  return within(
    'the upgrade',
    new Promise<Listener>((resolve, reject) => {
      socket.on('open', () => {
        resolve(listener);
      });
      socket.on('unexpected-response', (_request, response: IncomingMessage) => {
        reject(new Error(`upgrade refused with ${response.statusCode}`));
      });
      socket.on('error', reject);
    }),
  );
}

/** What the server answered an upgrade it would not accept with. */
interface Refusal {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: unknown;
}

/**
 * Asks for an upgrade that is expected to fail, and reads the HTTP answer.
 *
 * The answer is the point. A refused upgrade is the one moment the server can
 * still speak HTTP, and `websocket/handler.ts` documents that it should — a
 * client that gets a close code instead cannot tell an expired token from a
 * server that is not there.
 *
 * @param path - The path to ask for, credentials included.
 * @param headers - Request headers, if any.
 * @returns The status, headers and parsed body.
 */
function refusedUpgrade(path: string, headers: Record<string, string> = {}): Promise<Refusal> {
  return within(
    'the refusal',
    new Promise<Refusal>((resolve, reject) => {
      const socket = new WebSocket(`${origin}${path}`, { headers });

      socket.on('open', () => {
        socket.close();
        reject(new Error(`${path} completed an upgrade that should have been refused`));
      });

      socket.on('unexpected-response', (_request, response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: text === '' ? undefined : (JSON.parse(text) as unknown),
          });
        });
      });

      socket.on('error', reject);
    }),
  );
}

/**
 * Sends a message to the listening agent, over HTTP, as a client would.
 *
 * Through the route rather than through `createMessageService`, which is the
 * whole point after T-038: the service commits a row and the *route* is what
 * commits it and then fans it out. A test that called the service directly
 * would pass identically against a server whose send pushes nothing.
 *
 * @param content - What to send.
 * @returns The committed message's identifier.
 */
async function sendMessage(content: string): Promise<string> {
  const sent = (await asUser('POST', '/messages', {
    projectId,
    senderAgentId,
    recipientAgentId,
    content,
    clientMessageId: `wiring-${unique()}`,
  })) as { id: string };

  return sent.id;
}

/**
 * Says `hello` and reads up to the `ready` frame, returning what came first.
 *
 * A socket is registered for delivery by the time `ready` is written — the
 * handshake sends it only after the observer's `bound` has returned — so
 * awaiting it is how a test knows the listener is genuinely connected and not
 * merely upgraded. Anything ahead of it is a replay, handed back so a caller
 * can assert on it or assert that there was none.
 *
 * @param listener - The connected socket.
 * @param session - The session to bind it to.
 * @returns The frames that preceded `ready`, and `ready` itself.
 */
async function helloAndReady(
  listener: Listener,
  session: string,
): Promise<{ replayed: Frame[]; ready: Frame }> {
  listener.send({ type: 'hello', sessionId: session, client: 'agentchat-wiring/0.0.0' });

  const replayed: Frame[] = [];
  for (;;) {
    const frame = await listener.next();
    if (frame['type'] === 'ready') {
      return { replayed, ready: frame };
    }
    replayed.push(frame);
  }
}

/**
 * Registers another session for the listening agent.
 *
 * @returns The new session's identifier.
 */
async function openSession(): Promise<string> {
  const session = (await asUser('POST', '/sessions', {
    agentId: recipientAgentId,
    projectId,
    machine: { name: `wiring-test-${unique()}` },
    runtime: 'vitest',
    workingDirectory: '/tmp/agentchat-wiring',
  })) as { sessionId: string };

  return session.sessionId;
}

beforeAll(async () => {
  databaseName = `agentchat_t033_${unique()}`;

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
    username: `socketeer-${unique()}`,
    displayName: 'Socket Tester',
    email: 'socketeer@example.com',
  };

  app = createApp({
    config,
    database: { ping: () => pool.query('select 1').then(() => undefined), db },
    logger: pino({ level: 'warn' }, pino.destination({ dest: '/dev/null', sync: true })),
    identityProvider: stubProvider(identity),
  });

  await app.listen({ host: config.host, port: config.port });

  const address = app.addresses()[0];
  if (address === undefined) {
    throw new Error('the server reported no address after listening');
  }
  origin = `ws://127.0.0.1:${address.port}`;

  // A real login, so the credential every socket below carries is one this
  // server issued rather than one the test signed for itself.
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

  const project = (await asUser('POST', '/projects', { name: `Sockets ${unique()}` })) as {
    id: string;
  };
  projectId = project.id;

  const recipient = (await asUser('POST', '/agents', { name: `listener-${unique()}` })) as {
    id: string;
  };
  recipientAgentId = recipient.id;

  const sender = (await asUser('POST', '/agents', { name: `writer-${unique()}` })) as {
    id: string;
  };
  senderAgentId = sender.id;

  await asUser('POST', `/agents/${recipientAgentId}/projects`, { projectId });
  await asUser('POST', `/agents/${senderAgentId}/projects`, { projectId });

  sessionId = await openSession();
});

afterAll(async () => {
  // Also the assertion that shutdown terminates: `app.close()` waits for the
  // HTTP server, a WebSocket is a connection it would wait for forever, and
  // this hook would hang rather than fail if the `preClose` hook stopped
  // closing sockets.
  await app?.close();
  await pool?.end();

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await admin.end();
  }
});

describe('a message reaches a listener that is already connected', () => {
  /**
   * The product's headline claim, in one test.
   *
   * Everything about it is arranged so that it can only pass for the right
   * reason:
   *
   * - **The listener connects first, and `ready` is awaited before anything is
   *   sent.** `ready` is the server's own statement that the socket is bound
   *   and caught up — the handshake writes it only after the observer's `bound`
   *   has returned — so there is no window in which the send could have raced
   *   the registration and been picked up as a replay instead. It also asserts
   *   the queue is empty at that moment, so the frame that arrives later cannot
   *   be a leftover from another test in this file.
   * - **The send is an HTTP request with a bearer token**, to the route
   *   `createApp` registers, not a call to `createMessageService`. A test that
   *   called the service directly would pass against a server whose send route
   *   pushes nothing, which is precisely the server this test exists to fail.
   * - **Nothing reconnects, and nothing polls.** The only thing that can put
   *   that frame on this socket is `DeliveryService.deliver`, called by the
   *   send path after the row committed.
   *
   * The second half then shows the two halves of at-least-once composing: the
   * message is deliberately left unacknowledged, a *second* listener connects
   * afterwards, and the same message replays to it. Live delivery does not
   * settle the debt — only an acknowledgement does (D3) — and the last
   * assertion is that acknowledging it on one socket clears it for the agent
   * everywhere.
   */
  it('delivers over HTTP to an open socket, with no reconnect, and replays to the next', async () => {
    const listener = await connect();
    const { replayed, ready } = await helloAndReady(listener, sessionId);

    // Connected, registered, and owed nothing. Whatever arrives from here is
    // this test's own doing.
    expect(replayed).toStrictEqual([]);
    expect(ready).toMatchObject({ type: 'ready', sessionId, pending: 0 });

    const content = `live delivery ${unique()}`;
    const messageId = await sendMessage(content);

    // No reconnect, no `hello`, no poll: the socket that was already open is
    // handed the message the send committed.
    const delivered = await listener.next();
    expect(delivered['type']).toBe('message');
    expect(delivered['message']).toMatchObject({
      messageId,
      projectId,
      senderAgentId,
      recipientAgentId,
      content,
    });

    // Deliberately not acknowledged. A delivered message is still owed until
    // the agent says otherwise, and the rest of this test depends on it.
    const second = await connect();
    const secondSession = await openSession();
    const arrival = await helloAndReady(second, secondSession);

    expect(arrival.ready).toMatchObject({ type: 'ready', sessionId: secondSession, pending: 1 });
    expect(arrival.replayed).toHaveLength(1);
    expect(arrival.replayed[0]?.['message']).toMatchObject({ messageId, content });

    // The debt is the agent's, not a socket's: acknowledging on the second
    // socket settles what the first was delivered live.
    second.send({ type: 'ack', messageId });
    await second.close();
    await untilNothingIsPending();

    const third = await connect();
    const settled = await helloAndReady(third, await openSession());
    expect(settled.replayed).toStrictEqual([]);
    expect(settled.ready).toMatchObject({ type: 'ready', pending: 0 });

    await third.close();
    await listener.close();
  });

  it('does not fail the send when nobody is listening', async () => {
    // The case the whole system is built around, over the registered route: an
    // offline recipient is a 201 and a pending row, never an error, because the
    // message is durable and the fan-out reaching nobody changes nothing about
    // that. A send path that surfaced an empty delivery report as a failure
    // would break every message to an agent that is not running.
    const content = `nobody home ${unique()}`;

    const response = await app.inject({
      method: 'POST',
      url: '/messages',
      headers: { authorization: `Bearer ${bearer}` },
      payload: {
        projectId,
        senderAgentId,
        recipientAgentId,
        content,
        clientMessageId: `wiring-${unique()}`,
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    const messageId = response.json().id;

    // And it is genuinely owed, rather than accepted and dropped.
    const listener = await connect();
    const { replayed } = await helloAndReady(listener, await openSession());
    expect(replayed.map((frame) => (frame['message'] as { content: string }).content)).toContain(
      content,
    );

    await listener.close();

    // Acknowledged over HTTP rather than over the socket, which drains the
    // queue this suite shares for the tests below *and* is the only place the
    // third message route is exercised through `createApp`: D3 makes the debt
    // the agent's, so a client holding no socket at all may settle it.
    const acked = (await asUser('POST', `/messages/${messageId}/ack`, {
      agentId: recipientAgentId,
      projectId,
    })) as { messageId: string; alreadyAcknowledged: boolean };

    expect(acked).toMatchObject({ messageId, alreadyAcknowledged: false });
  });
});

describe('the websocket endpoint is registered', () => {
  it('completes the round trip: connect, hello, receive, acknowledge, disconnect', async () => {
    // Written while nobody is listening, which is the delivery this server
    // promises to keep (Plan §4.4).
    const content = `hello from the wiring suite ${unique()}`;
    const messageId = await sendMessage(content);

    const listener = await connect();
    listener.send({ type: 'hello', sessionId, client: 'agentchat-wiring/0.0.0' });

    // Plan §4.3's ordering: every pending message, then `ready` with the count.
    const delivered = await listener.next();
    expect(delivered['type']).toBe('message');
    expect(delivered['message']).toMatchObject({
      messageId,
      projectId,
      senderAgentId,
      recipientAgentId,
      content,
    });

    const ready = await listener.next();
    expect(ready).toMatchObject({ type: 'ready', sessionId, pending: 1 });

    // The liveness half of the protocol, on the same socket.
    listener.send({ type: 'ping' });
    expect(await listener.next()).toMatchObject({ type: 'pong' });

    // Acknowledged, so the inbox stops replaying it (D3).
    listener.send({ type: 'ack', messageId });

    const closure = await listener.close();
    expect(closure.code).toBe(CloseCode.NORMAL);

    // The acknowledgement outlived the socket that sent it, which is what makes
    // the next assertion mean anything. Waited for rather than assumed; see
    // `untilNothingIsPending` for the race that costs.
    await untilNothingIsPending();

    // The socket is gone, its registration with it, and the acknowledgement it
    // sent survived it: a fresh listener for the same session is owed nothing.
    const reconnected = await connect();
    reconnected.send({ type: 'hello', sessionId });
    expect(await reconnected.next()).toMatchObject({ type: 'ready', sessionId, pending: 0 });

    await reconnected.close();
  });

  it('accepts a token in the query string for clients that cannot set headers', async () => {
    const listener = await connect({ credentialIn: 'query' });
    listener.send({ type: 'hello', sessionId });

    expect(await listener.next()).toMatchObject({ type: 'ready', sessionId });

    await listener.close();
  });

  it('refuses an upgrade with no credential, in HTTP rather than a close code', async () => {
    const refusal = await refusedUpgrade(WEBSOCKET_PATH);

    expect(refusal.statusCode).toBe(401);
    expect(refusal.headers['www-authenticate']).toBe('Bearer');
    expect(refusal.body).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  });

  it('refuses an upgrade whose token does not verify', async () => {
    const refusal = await refusedUpgrade(WEBSOCKET_PATH, {
      authorization: 'Bearer not-a-real-token',
    });

    expect(refusal.statusCode).toBe(401);
    expect(refusal.body).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  });

  it('answers 404 on any other path rather than upgrading it', async () => {
    const refusal = await refusedUpgrade('/not-the-socket', {
      authorization: `Bearer ${bearer}`,
    });

    expect(refusal.statusCode).toBe(404);
    expect(refusal.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('closes a socket whose hello names a session that is not the caller’s', async () => {
    const listener = await connect();
    // A well-formed identifier that names nothing, so the frame passes its
    // schema and is refused by the ownership check rather than by the decoder.
    listener.send({ type: 'hello', sessionId: SessionId.generate() });

    const error = await listener.next();
    expect(error).toMatchObject({ type: 'error', code: 'SESSION_INVALID' });

    const closure = await listener.closed();
    expect(closure.code).toBe(CloseCode.SESSION_INVALID);
  });

  it('refuses a known frame that arrives before the hello', async () => {
    const listener = await connect();
    listener.send({ type: 'ping' });

    expect(await listener.next()).toMatchObject({ type: 'error' });

    const closure = await listener.closed();
    expect(closure.code).toBe(CloseCode.FRAME_OUT_OF_ORDER);
  });

  it('ignores an unknown frame type and still binds afterwards', async () => {
    const listener = await connect();

    // The additive-only rule (Plan §12.4) over a real socket: a newer client's
    // frame is not an error and does not cost it the handshake.
    listener.send({ type: 'telemetry', anything: true });
    listener.send({ type: 'hello', sessionId });

    expect(await listener.next()).toMatchObject({ type: 'ready', sessionId });

    await listener.close();
  });
});
