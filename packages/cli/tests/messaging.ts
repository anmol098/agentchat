/**
 * The stub server the three reading commands are spawned against.
 *
 * `agentchat inbox`, `agentchat conversation` and `agentchat ack` share a
 * project, a roster and an account, and each of them needs a throwaway `HOME`
 * with credentials in it. Written once here rather than three times, because
 * three copies of a fixture drift and then two suites quietly stop testing the
 * same server.
 *
 * What it does **not** abstract is the assertions. Every case still spawns the
 * real binary through `./spawn.ts` and reads file descriptors 1 and 2
 * separately; a fixture that captured a merged stream would let the whole suite
 * pass while PRD §39 was broken.
 *
 * @module
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Run } from './spawn.js';
import { runCli } from './spawn.js';

/** The project every case acts in. */
export const PROJECT_ID = 'prj_0199a1b2-c3d4-7e5f-8071-8293a4b5c6d7';

/** The account the stub answers `GET /me` with. */
export const ME_ID = 'usr_0199a1b2-c3d4-7e5f-8071-8293a4b5c6d8';

/** The other person in the project. */
export const ALICE_ID = 'usr_0199a1b2-c3d4-7e5f-8071-8293a4b5c6d9';

/** The caller's own agent, and the recipient of everything below. */
export const MY_BACKEND = 'agt_0199a1b2-c3d4-7e5f-8071-8293a4b5c6e1';

/** Alice's agent, the sender. */
export const ALICE_BACKEND = 'agt_0199a1b2-c3d4-7e5f-8071-8293a4b5c6e2';

/** An agent that is in no roster, standing in for one that was soft deleted. */
export const GHOST_AGENT = 'agt_0199a1b2-c3d4-7e5f-8071-8293a4b5c6e3';

/** The thread everything below belongs to. */
export const CONVERSATION_ID = 'cnv_0199a1b2-c3d4-7e5f-8071-8293a4b5c6f3';

/** A session identifier, for the `--session` case. */
export const SESSION_ID = 'ses_0199a1b2-c3d4-7e5f-8071-8293a4b5c6f9';

/**
 * A message identifier that sorts where its index says.
 *
 * The server orders by identifier and pages on it, so the fixtures have to sort
 * the same way for a cursor assertion to mean anything.
 *
 * @param index - Which message, from 1.
 * @returns A `msg_` identifier.
 */
export function messageId(index: number): string {
  return `msg_0199a1b2-c3d4-7e5f-8071-${String(index).padStart(12, '0')}`;
}

/** The account the stub server answers for. */
export const ME = {
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

/** The roster: one agent of mine, one of Alice's. */
export const ROSTER = [
  row(ALICE_BACKEND, 'backend', { id: ALICE_ID, username: 'alice' }),
  row(MY_BACKEND, 'backend', { id: ME_ID, username: 'you' }),
];

/**
 * A message addressed to my agent, as every endpoint renders it.
 *
 * @param index - Which message, from 1. Decides the identifier and the minute.
 * @param over - Fields to vary.
 * @returns The wire representation.
 */
export function message(
  index: number,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: messageId(index),
    projectId: PROJECT_ID,
    conversationId: CONVERSATION_ID,
    parentMessageId: null,
    senderAgentId: ALICE_BACKEND,
    recipientAgentId: MY_BACKEND,
    content: `message number ${String(index)}`,
    createdAt: `2026-09-09T12:${String(index).padStart(2, '0')}:00.000Z`,
    ...over,
  };
}

/** The thread `CONVERSATION_ID` names. */
export const CONVERSATION = {
  id: CONVERSATION_ID,
  projectId: PROJECT_ID,
  createdAt: '2026-09-09T12:00:00.000Z',
};

/** One request the stub received. */
export interface Received {
  /** `GET` or `POST`. */
  readonly method: string;

  /** The path, without the query string. */
  readonly path: string;

  /** The query string, parsed. */
  readonly query: URLSearchParams;

  /** The request body, parsed as JSON, or `null` when there was none. */
  readonly body: Record<string, unknown> | null;
}

/** One stubbed answer. */
export interface Reply {
  /** The HTTP status. */
  readonly status: number;

  /** The body, serialised as JSON. */
  readonly body: unknown;
}

/** Answers one request, given what has been received so far. */
export type Handler = (received: Received) => Reply;

/** The routes the stub answers, keyed by `METHOD /path`. A `:id` matches any. */
export type Routes = Readonly<Record<string, Reply | Handler>>;

/** A running stub, and everything a case needs to drive it. */
export interface Fixture {
  /** Where the stub is listening. */
  readonly baseUrl: string;

  /** Every request the stub received, in order. */
  readonly received: Received[];

  /** Replaces the route table. */
  setRoutes(routes: Routes): void;

  /** Builds a throwaway home, logged in and pointed at the stub. */
  prepare(): Prepared;

  /** Stops the stub. */
  close(): Promise<void>;
}

/** A prepared invocation environment: a fake home and a working directory. */
export interface Prepared {
  /** The fake `HOME`. */
  readonly home: string;

  /** Where the command runs. */
  readonly cwd: string;
}

/** The listings every case needs, whatever it is testing. */
export function baseRoutes(extra: Routes = {}): Routes {
  return {
    'GET /me': { status: 200, body: ME },
    [`GET /projects/${PROJECT_ID}/agents`]: { status: 200, body: { items: ROSTER } },
    ...extra,
  };
}

/**
 * Reads a request body to the end.
 *
 * @param request - The incoming request.
 * @returns The body as text.
 */
async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Finds the route for one request, allowing `:id` to stand for a path segment.
 *
 * @param routes - The table.
 * @param key - `METHOD /path`.
 * @returns The reply or handler, or `undefined` when nothing matched.
 */
function match(routes: Routes, key: string): Reply | Handler | undefined {
  const exact = routes[key];
  if (exact !== undefined) {
    return exact;
  }
  const segments = key.split('/');
  for (const [pattern, reply] of Object.entries(routes)) {
    const parts = pattern.split('/');
    if (parts.length !== segments.length) {
      continue;
    }
    if (parts.every((part, index) => part === ':id' || part === segments[index])) {
      return reply;
    }
  }
  return undefined;
}

/**
 * Starts a stub server and a temporary root for throwaway homes.
 *
 * @returns The fixture. Call `close` when the suite is done with it.
 */
export async function startFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'agentchat-messaging-cli-'));
  const received: Received[] = [];
  let routes: Routes = baseRoutes();

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://stub');
    const key = `${method} ${url.pathname}`;

    void bodyOf(request).then((text) => {
      received.push({
        method,
        path: url.pathname,
        query: url.searchParams,
        body: text === '' ? null : (JSON.parse(text) as Record<string, unknown>),
      });

      const found = match(routes, key);
      const reply: Reply =
        found === undefined
          ? {
              status: 404,
              body: { error: { code: 'NOT_FOUND', message: `No stub for ${key}.` } },
            }
          : typeof found === 'function'
            ? found(received[received.length - 1] as Received)
            : found;

      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply.body));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  return {
    baseUrl,
    received,
    setRoutes(next: Routes): void {
      routes = next;
      received.length = 0;
    },
    prepare(): Prepared {
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
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

/**
 * Runs one command against a fixture, with the project already in context.
 *
 * @param prepared - The home and working directory to run in.
 * @param argv - The whole command line after the program name.
 * @returns Both streams and the exit code.
 */
export async function runAgainst(prepared: Prepared, argv: readonly string[]): Promise<Run> {
  return await runCli(argv, {
    cwd: prepared.cwd,
    env: { HOME: prepared.home, AGENTCHAT_PROJECT: PROJECT_ID },
  });
}
