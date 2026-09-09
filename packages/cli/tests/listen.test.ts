/**
 * `agentchat listen`, spawned, against a real socket.
 *
 * This is the acceptance suite for the contract the whole product rests on, and
 * the reason it spawns rather than stubbing a descriptor: **file descriptor 1
 * and file descriptor 2 are read independently** (`./spawn.ts`), from a real
 * process, over real pipes. A helper that merged them — or a pseudo-terminal —
 * would let every assertion here pass while an operational line was landing in
 * the middle of a harness's input. PRD §39 describes exactly that failure, and
 * it is invisible from inside the process.
 *
 * The server here is a real one, too. It answers the four HTTP calls a listener
 * makes and it speaks the WebSocket protocol itself — the handshake, the
 * framing, the masking, the close codes — in about a hundred lines at the
 * bottom of this file, rather than depending on a library. `ws` lives under
 * `server/`, which is AGPL, and nothing under `packages/` may depend on it
 * (see LICENSE); and a mock connector would not exercise the one thing this
 * suite exists to exercise, which is that the bytes come out of the right
 * descriptor of a process that really opened a socket.
 *
 * Every run gets its own `HOME` and its own working directory, so nothing here
 * can read the developer's credentials or their repository configuration.
 *
 * @module
 */

import { Buffer } from 'node:buffer';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ANSI, BINARY, buildPackage, parseNdjson } from './spawn.js';

const PROJECT_ID = 'prj_0199a1b2-c3d4-7e5f-8071-8293a4b5c6d7';
const ME_ID = 'usr_0199a1b2-c3d4-7e5f-8071-8293a4b5c6d8';
const BOB_ID = 'usr_0199a1b2-c3d4-7e5f-8071-8293a4b5c6d9';

const MY_BACKEND = 'agt_0199a1b2-c3d4-7e5f-8071-8293a4b5c6e1';
const BOB_BACKEND = 'agt_0199a1b2-c3d4-7e5f-8071-8293a4b5c6e2';

const SESSION_ID = 'ses_0199a1b2-c3d4-7e5f-8071-8293a4b5c6f0';
const CONVERSATION_ID = 'cnv_0199a1b2-c3d4-7e5f-8071-8293a4b5c6f3';

/** The account the stub server answers for. */
const ME = {
  id: ME_ID,
  username: 'you',
  displayName: 'You Example',
  email: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

/**
 * One row of the project's agent roster.
 *
 * @param id - The agent's id.
 * @param name - The agent's name.
 * @param owner - The account id and username of the owner.
 * @returns The wire representation.
 */
function row(
  id: string,
  name: string,
  owner: { id: string; username: string },
): Record<string, unknown> {
  return {
    agent: {
      id,
      userId: owner.id,
      name,
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
    owner: { ...owner, displayName: `${owner.username} Example` },
    online: true,
    sessions: 1,
  };
}

/** The roster: one agent of mine, one of Bob's. */
const LISTING = [
  row(BOB_BACKEND, 'backend', { id: BOB_ID, username: 'bob' }),
  row(MY_BACKEND, 'backend', { id: ME_ID, username: 'you' }),
];

/** How many messages the fixtures have minted, so identifiers stay distinct. */
let minted = 0;

/**
 * A message envelope, as the server's delivery service builds one.
 *
 * @param content - The message body.
 * @returns The `message` frame's payload.
 */
function envelope(content: string): Record<string, unknown> {
  minted += 1;
  return {
    messageId: `msg_0199a1b2-c3d4-7e5f-8071-8293a4b5c${String(600 + minted)}`,
    projectId: PROJECT_ID,
    conversationId: CONVERSATION_ID,
    senderAgentId: BOB_BACKEND,
    sender: '@bob/backend',
    recipientAgentId: MY_BACKEND,
    content,
    createdAt: '2026-09-09T12:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// A WebSocket server, from the bytes up
// ---------------------------------------------------------------------------

/** RFC 6455's handshake constant. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * The `Sec-WebSocket-Accept` value for a key.
 *
 * @param key - The client's `Sec-WebSocket-Key` header.
 * @returns The base64 digest the client checks.
 */
function acceptFor(key: string): string {
  return createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
}

/**
 * Encodes one unmasked text frame, as a server sends them.
 *
 * @param value - The frame, serialised as JSON.
 * @returns The bytes to write.
 */
function textFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

/**
 * Encodes a close frame.
 *
 * @param code - The close code.
 * @param reason - The reason, which the client reports back.
 * @returns The bytes to write.
 */
function closeFrame(code: number, reason: string): Buffer {
  const body = Buffer.alloc(2 + Buffer.byteLength(reason, 'utf8'));
  body.writeUInt16BE(code, 0);
  body.write(reason, 2, 'utf8');
  return Buffer.concat([Buffer.from([0x88, body.length]), body]);
}

/** One frame taken off a client socket. */
interface Incoming {
  /** The opcode: 1 text, 8 close, 9 ping. */
  readonly opcode: number;

  /** The payload, decoded as UTF-8. */
  readonly text: string;
}

/**
 * Peels complete frames off a buffer, unmasking them.
 *
 * @param buffer - Everything received and not yet consumed.
 * @returns The frames that are complete, and what is left over.
 */
function readFrames(buffer: Buffer): { frames: Incoming[]; rest: Buffer } {
  const frames: Incoming[] = [];
  let rest = buffer;

  for (;;) {
    if (rest.length < 2) {
      return { frames, rest };
    }
    const opcode = (rest[0] ?? 0) & 0x0f;
    const second = rest[1] ?? 0;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (rest.length < 4) {
        return { frames, rest };
      }
      length = rest.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (rest.length < 10) {
        return { frames, rest };
      }
      length = Number(rest.readBigUInt64BE(2));
      offset = 10;
    }

    const maskKey = masked ? rest.subarray(offset, offset + 4) : null;
    if (maskKey !== null) {
      offset += 4;
    }
    if (rest.length < offset + length) {
      return { frames, rest };
    }

    const payload = Buffer.from(rest.subarray(offset, offset + length));
    if (maskKey !== null) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = (payload[index] ?? 0) ^ (maskKey[index % 4] ?? 0);
      }
    }
    frames.push({ opcode, text: payload.toString('utf8') });
    rest = Buffer.from(rest.subarray(offset + length));
  }
}

/** One accepted WebSocket connection, from the server's side. */
class Connection {
  /** Every JSON frame the client sent, in order. */
  public readonly received: Record<string, unknown>[] = [];

  readonly #socket: Socket;
  #buffer: Buffer = Buffer.alloc(0);

  /**
   * @param socket - The upgraded TCP socket.
   */
  public constructor(socket: Socket) {
    this.#socket = socket;
    socket.on('data', (chunk: Buffer) => {
      const { frames, rest } = readFrames(Buffer.concat([this.#buffer, chunk]));
      this.#buffer = rest;
      for (const frame of frames) {
        this.#consume(frame);
      }
    });
    socket.on('error', () => {
      // A client that vanished mid-write. Nothing to report from a fixture.
    });
  }

  /** Every acknowledged message, in order. */
  public get acked(): readonly string[] {
    return this.received
      .filter((frame) => frame['type'] === 'ack')
      .map((frame) => String(frame['messageId']));
  }

  /**
   * Sends one frame to the client.
   *
   * @param value - The frame.
   */
  public send(value: unknown): void {
    this.#socket.write(textFrame(value));
  }

  /**
   * Closes the connection with a code, as a server does.
   *
   * @param code - The close code.
   * @param reason - The reason.
   */
  public close(code: number, reason = ''): void {
    this.#socket.write(closeFrame(code, reason));
    this.#socket.end();
  }

  /**
   * Waits for the client's `hello`.
   *
   * @returns The `hello` frame.
   */
  public async helloed(): Promise<Record<string, unknown>> {
    await until('hello', () => this.received.some((frame) => frame['type'] === 'hello'));
    const hello = this.received.find((frame) => frame['type'] === 'hello');
    if (hello === undefined) {
      throw new Error('No hello.');
    }
    return hello;
  }

  /**
   * Handles one decoded frame.
   *
   * @param frame - What came off the socket.
   */
  #consume(frame: Incoming): void {
    if (frame.opcode === 0x8) {
      this.#socket.end();
      return;
    }
    if (frame.opcode !== 0x1) {
      return;
    }
    const parsed: unknown = JSON.parse(frame.text);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      this.received.push(record);
      if (record['type'] === 'ping') {
        this.send({ type: 'pong' });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;
let root: string;
let connections: Connection[] = [];
let upgrades: string[] = [];

/**
 * Waits until a predicate holds, or fails the test.
 *
 * @param what - Named in the failure.
 * @param predicate - Checked until it is true.
 * @returns When it holds.
 */
async function until(what: string, predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

/**
 * The nth connection the server accepted.
 *
 * @param count - Which one, one-based.
 * @returns The connection once it exists.
 */
async function connection(count: number): Promise<Connection> {
  await until(`connection ${String(count)}`, () => connections.length >= count);
  const found = connections[count - 1];
  if (found === undefined) {
    throw new Error(`No connection ${String(count)}.`);
  }
  return found;
}

beforeAll(async () => {
  await buildPackage();
  root = mkdtempSync(join(tmpdir(), 'agentchat-listen-cli-'));

  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? 'GET';
    const path = (request.url ?? '/').split('?')[0] ?? '/';

    const answer = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };

    // Drained even where the body is not read, so the client's request
    // completes rather than stalling on an unconsumed stream.
    request.resume();

    if (method === 'GET' && path === '/me') {
      answer(200, ME);
      return;
    }
    if (method === 'GET' && path === `/projects/${PROJECT_ID}/agents`) {
      answer(200, { items: LISTING });
      return;
    }
    if (method === 'POST' && path === '/sessions') {
      answer(201, { sessionId: SESSION_ID });
      return;
    }
    if (method === 'DELETE' && path === `/sessions/${SESSION_ID}`) {
      answer(200, { status: 'ended', endedAt: '2026-09-09T13:00:00.000Z' });
      return;
    }
    answer(404, { error: { code: 'NOT_FOUND', message: `No stub for ${method} ${path}.` } });
  });

  server.on('upgrade', (request: IncomingMessage, socket: Socket) => {
    upgrades.push(request.headers.authorization ?? '');
    const key = request.headers['sec-websocket-key'] ?? '';
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptFor(key)}\r\n\r\n`,
    );
    connections.push(new Connection(socket));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}, 180_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
});

beforeEach(() => {
  connections = [];
  upgrades = [];
});

/** A prepared fixture: a fake home and a working directory. */
interface Prepared {
  /** The fake `HOME`. */
  readonly home: string;

  /** Where the command runs. */
  readonly cwd: string;
}

/**
 * Builds one throwaway home, logged in and pointed at the stub server.
 *
 * @returns The paths to run against.
 */
function prepare(): Prepared {
  const base = mkdtempSync(join(root, 'case-'));
  const home = join(base, 'home');
  const cwd = join(base, 'work');
  const configDirectory = join(home, '.config', 'agentchat');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });

  writeFileSync(
    join(configDirectory, 'credentials.json'),
    `${JSON.stringify({ version: 1, accessToken: 'access-token', refreshToken: 'refresh-token' }, null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(configDirectory, 'config.json'),
    `${JSON.stringify({ serverUrl: baseUrl, defaultAgentByProject: {} }, null, 2)}\n`,
    { mode: 0o600 },
  );

  return { home, cwd };
}

/** A listener running in its own process, with each descriptor read on its own. */
interface Running {
  /** The child, for the signal that ends it. */
  readonly child: ChildProcessWithoutNullStreams;

  /** Everything file descriptor 1 has produced so far. */
  stdout(): string;

  /** Everything file descriptor 2 has produced so far. */
  stderr(): string;

  /** Resolves with both streams and the exit code once the child is gone. */
  readonly done: Promise<{ stdout: string; stderr: string; code: number | null }>;
}

/** Every process started by a case, so none can outlive it. */
let running: Running[] = [];

afterEach(async () => {
  for (const process_ of running) {
    process_.child.kill('SIGKILL');
  }
  await Promise.all(running.map((process_) => process_.done.catch(() => undefined)));
  running = [];
});

/**
 * Spawns `agentchat listen` and returns while it is still running.
 *
 * Deliberately not `./spawn.ts`'s `runCli`, which waits for the child to exit:
 * this command does not exit until it is told to, and a case has to feed it
 * frames and read its output while it runs. The descriptors are still piped
 * separately, which is the property that matters.
 *
 * @param argv - The arguments after `listen`.
 * @param prepared - The home and working directory to run in.
 * @returns The running process.
 */
function startListen(argv: readonly string[], prepared: Prepared): Running {
  const child = spawn(process.execPath, [BINARY, 'listen', ...argv], {
    cwd: prepared.cwd,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: prepared.home,
      AGENTCHAT_PROJECT: PROJECT_ID,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    err += chunk;
  });
  child.stdin.end();

  const done = new Promise<{ stdout: string; stderr: string; code: number | null }>(
    (resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({ stdout: out, stderr: err, code });
      });
    },
  );

  const process_: Running = {
    child,
    stdout: () => out,
    stderr: () => err,
    done,
  };
  running.push(process_);
  return process_;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('the stream contract', () => {
  it('puts messages on stdout, operational logs on stderr, and never the reverse', async () => {
    const listener = startListen(['--runtime', 'claude-code'], prepare());
    const socket = await connection(1);
    await socket.helloed();
    socket.send({ type: 'ready', sessionId: SESSION_ID, pending: 0 });
    const message = envelope('Can you verify the idempotency?');
    socket.send({ type: 'message', message });

    await until('the message', () => listener.stdout().includes('Can you verify'));
    listener.child.kill('SIGTERM');
    const run = await listener.done;

    expect(run.code).toBe(0);

    // stdout: the documented block, and nothing else at all.
    expect(run.stdout).toBe(
      [
        '[agentchat message]',
        `id:           ${String(message['messageId'])}`,
        'from:         @bob/backend',
        `conversation: ${CONVERSATION_ID}`,
        `reply:        agentchat send @bob/backend --conversation ${CONVERSATION_ID} "…"`,
        '',
        'Can you verify the idempotency?',
        '',
        '',
      ].join('\n'),
    );
    expect(run.stdout).not.toMatch(ANSI);

    // stderr: everything operational, and no part of a payload.
    expect(run.stderr).toContain('[agentchat]');
    expect(run.stderr).toContain('Listening as @you/backend');
    expect(run.stderr).toContain('Connected.');
    expect(run.stderr).not.toContain('Can you verify');
  });

  it('keeps stdout parseable as NDJSON across a reconnect', async () => {
    const listener = startListen(['--runtime', 'codex', '--json'], prepare());

    const first = await connection(1);
    await first.helloed();
    first.send({ type: 'ready', sessionId: SESSION_ID, pending: 0 });
    const before = envelope('before the drop');
    first.send({ type: 'message', message: before });
    await until('the first message', () => listener.stdout().includes('before the drop'));

    // The server goes away mid-session, exactly as a restart does.
    first.close(1011, 'server restarting');

    const second = await connection(2);
    const hello = await second.helloed();
    second.send({ type: 'ready', sessionId: SESSION_ID, pending: 1 });
    const after = envelope('after the reconnect');
    second.send({ type: 'message', message: after });
    await until('the second message', () => listener.stdout().includes('after the reconnect'));

    listener.child.kill('SIGTERM');
    const run = await listener.done;

    expect(run.code).toBe(0);

    // Every reconnect re-sends `hello`, which is what makes the replay happen.
    expect(hello).toMatchObject({ type: 'hello', sessionId: SESSION_ID });

    // The whole of stdout still parses, line by line, exactly as a harness
    // reads it. A stray log line or a half-written payload fails here.
    const events = parseNdjson(run.stdout) as Record<string, unknown>[];
    expect(events.every((event) => typeof event['event'] === 'string')).toBe(true);

    const messages = events.filter((event) => event['event'] === 'message');
    expect(messages).toStrictEqual([
      { event: 'message', ...before },
      { event: 'message', ...after },
    ]);

    const states = events
      .filter((event) => event['event'] === 'status')
      .map((event) => event['state']);
    expect(states).toContain('connected');
    expect(states).toContain('reconnecting');
    expect(states.at(-1)).toBe('disconnected');

    // The same transitions are on stderr as prose, and none of the JSON is.
    expect(run.stderr).toContain('Connection lost');
    expect(run.stderr).not.toContain('"event"');

    // Both messages were acknowledged, each on the connection it arrived on.
    expect(first.acked).toStrictEqual([before['messageId']]);
    expect(second.acked).toStrictEqual([after['messageId']]);
  });

  it('writes nothing to stdout when the invocation is wrong', async () => {
    const listener = startListen([], prepare());
    const run = await listener.done;

    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('`--runtime` is required');
    expect(connections).toHaveLength(0);
  });
});

describe('acknowledgement over a real socket', () => {
  it('sends an ack for each message by default', async () => {
    const listener = startListen(['--runtime', 'claude-code'], prepare());
    const socket = await connection(1);
    await socket.helloed();
    socket.send({ type: 'ready', sessionId: SESSION_ID, pending: 0 });
    const message = envelope('acknowledge me');
    socket.send({ type: 'message', message });

    await until('the acknowledgement', () => socket.acked.length === 1);
    listener.child.kill('SIGTERM');

    expect((await listener.done).code).toBe(0);
    expect(socket.acked).toStrictEqual([message['messageId']]);
  });

  it('sends none under --no-ack, leaving the message pending', async () => {
    const listener = startListen(['--runtime', 'claude-code', '--no-ack', '--json'], prepare());
    const socket = await connection(1);
    await socket.helloed();
    socket.send({ type: 'ready', sessionId: SESSION_ID, pending: 0 });
    socket.send({ type: 'message', message: envelope('do not acknowledge me') });

    await until('the message', () => listener.stdout().includes('do not acknowledge me'));
    listener.child.kill('SIGTERM');
    const run = await listener.done;

    expect(run.code).toBe(0);
    expect(socket.acked).toStrictEqual([]);
    expect(parseNdjson(run.stdout)[0]).toMatchObject({ event: 'listening', ack: false });
  });
});

describe('a connection that will not come back', () => {
  it('exits 1 on a refused session instead of retrying forever', async () => {
    const listener = startListen(['--runtime', 'claude-code'], prepare());
    const socket = await connection(1);
    await socket.helloed();
    socket.close(4403, 'session is not active');

    const run = await listener.done;

    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('SESSION_INVALID');
    // One attempt, then a stop: nothing backed off against a permanent answer.
    expect(connections).toHaveLength(1);
  });

  it('sends the access token on the upgrade rather than in the URL', async () => {
    const listener = startListen(['--runtime', 'claude-code'], prepare());
    const socket = await connection(1);
    await socket.helloed();
    listener.child.kill('SIGTERM');
    await listener.done;

    expect(upgrades).toStrictEqual(['Bearer access-token']);
  });
});
