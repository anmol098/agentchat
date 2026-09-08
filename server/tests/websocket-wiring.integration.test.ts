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
 * upgrade, the token is minted by the real device flow, and the message that
 * comes back down the socket was written to a real Postgres by the real message
 * service.
 *
 * ## What "receive a delivered message" means here
 *
 * The message is delivered by the replay half of `routing/delivery.ts`: it is
 * written while the listener is offline and arrives when the listener says
 * `hello`, followed by the `ready` frame carrying the count. That is the whole
 * of Plan §4.3's ordering and it exercises the registry, the observer
 * composition, the inbox and the frame encoder end to end.
 *
 * It is not the *live* fan-out, and that is a statement about the server rather
 * than about this suite. `DeliveryService.deliver` is what pushes a message to
 * an already-connected listener and its only possible caller is the send route,
 * which `createApp` does not register yet and which takes no delivery hook to
 * call it with. Until that seam has an owner, a message sent to a connected
 * agent reaches it on the next reconnect rather than immediately — durable, and
 * a second late. See the pull request.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import { AgentId, ProjectId, SessionId, UserId } from '@agentchat/protocol';
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
import { createMessageService } from '../src/services/messages.js';
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
async function asUser(method: 'POST', url: string, payload: unknown): Promise<unknown> {
  const response = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${bearer}` },
    payload: payload as object,
  });

  expect(response.statusCode, `${method} ${url} → ${response.body}`).toBeLessThan(300);
  return response.json();
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
 * Writes a message to the listening agent, through the real service.
 *
 * Not over HTTP, because `createApp` does not register the send route yet; see
 * the module note. The service is the same one that route would call, opening
 * the same transaction and writing the same `message_inbox` row.
 *
 * @param content - What to send.
 * @returns The committed message's identifier.
 */
async function sendMessage(content: string): Promise<string> {
  const messages = createMessageService(db);

  const result = await messages.send({
    userId: UserId.schema.parse(userId),
    projectId: ProjectId.schema.parse(projectId),
    senderAgentId: AgentId.schema.parse(senderAgentId),
    recipientAgentId: AgentId.schema.parse(recipientAgentId),
    content,
    clientMessageId: `wiring-${unique()}`,
  });

  return result.message.id;
}

/** The signed-in user, needed by the service calls this suite makes directly. */
let userId: string;

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

  const session = (await asUser('POST', '/sessions', {
    agentId: recipientAgentId,
    projectId,
    machine: { name: 'wiring-test' },
    runtime: 'vitest',
    workingDirectory: '/tmp/agentchat-wiring',
  })) as { sessionId: string };
  sessionId = session.sessionId;

  // The user id the direct service calls need. Taken from the row the login
  // wrote rather than from a token claim, so the suite depends on one source.
  const owner = await pool.query<{ id: string }>('select id from users limit 1');
  const row = owner.rows[0];
  if (row === undefined) {
    throw new Error('the device flow did not create a user');
  }
  userId = row.id;
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
