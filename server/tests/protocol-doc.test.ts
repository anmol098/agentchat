/**
 * `docs/protocol.md` is checked against the code it describes.
 *
 * The protocol reference is the interface to a promise: `packages/protocol` and
 * `packages/client` are MIT so that third parties can implement against them,
 * and a document those people rely on has to be true. A hand-written protocol
 * reference is wrong within a month — not because anybody is careless, but
 * because a schema change and a documentation change are two edits and only one
 * of them is enforced by a compiler.
 *
 * This file is the enforcement. It parses the markdown and asserts, against the
 * live code, every fact in it that a machine can check:
 *
 * - every documented endpoint is one the assembled server registers, and every
 *   registered endpoint is documented;
 * - every JSON example tagged with a schema parses against that schema;
 * - the error-code table is exactly the codes a client can receive over HTTP,
 *   with the statuses the server actually maps them to, and every frozen code
 *   appears somewhere in the document;
 * - the close-code table matches `CloseCode` in both directions;
 * - the documented frame types match the decoder's accepted set and the
 *   `ServerFrame` union;
 * - the `message` frame's documented payload matches {@link MessageEnvelope};
 * - the limits table and the version constants match the constants.
 *
 * ## Why verification rather than generation
 *
 * Most of what an implementer needs from that document is not in the schemas at
 * all: which failures are deliberately indistinguishable and why, what a client
 * must do about duplicates, why `ready` follows the replay, which differences
 * from the plan were decided on purpose. A generator would either omit it —
 * leaving a reference that answers "what are the fields" and none of the
 * questions a client author actually has — or become a template engine whose
 * templates are that prose, unchecked. So the prose is written by hand and the
 * facts inside it are asserted here.
 *
 * ## Two kinds of check, deliberately
 *
 * Some of this is compile-time. `SERVER_FRAME_TYPES` and `MESSAGE_ENVELOPE_KEYS`
 * are typed against the union and the interface they document, with an
 * exhaustiveness witness, so renaming a field in `routing/delivery.ts` fails
 * `pnpm typecheck` before it fails a test — and the failure names this file,
 * which names the document. The rest is run-time, because markdown is.
 *
 * ## What it cannot see
 *
 * Meanings. Repurposing a field while its shape stays identical is invisible
 * here exactly as it is to `scripts/protocol-snapshot.mjs`, and it is still a
 * breaking change. So is prose that describes a remedy incorrectly. Those are
 * review's job; §7.6 of the subagent protocol is what brings them to review.
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import * as protocol from '@stackgrid/protocol';
import { ERROR_CODES, type ErrorCode } from '@stackgrid/protocol';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import pino from 'pino';
import { beforeAll, describe, expect, it } from 'vitest';
import { type AppDatabase, createApp } from '../src/app.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  MIN_JWT_SECRET_LENGTH,
  REFRESH_TOKEN_TTL_SECONDS,
} from '../src/auth/tokens.js';
import { loadConfig } from '../src/config.js';
import { HTTP_STATUS_BY_ERROR_CODE } from '../src/errors.js';
import * as sessionRoutes from '../src/routes/sessions.js';
import type { MessageEnvelope } from '../src/routing/delivery.js';
import {
  DEFAULT_CONVERSATION_LIMIT,
  MAX_CONVERSATION_LIMIT,
} from '../src/services/conversations.js';
import { DEFAULT_PENDING_LIMIT, MAX_PENDING_LIMIT } from '../src/services/inbox.js';
import {
  HEARTBEAT_TIMEOUT_SECONDS,
  STALE_SESSION_LIFETIME_SECONDS,
} from '../src/services/sessions.js';
import {
  AckFrameSchema,
  CLIENT_FRAME_TYPES,
  CloseCode,
  HelloFrameSchema,
  MAX_CLOSE_REASON_BYTES,
  MAX_FRAME_BYTES,
  PingFrameSchema,
  type ServerFrame,
} from '../src/websocket/frames.js';

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/** The reference this file exists to keep true. */
const DOCUMENT_PATH = new URL('../../docs/protocol.md', import.meta.url);

const document = readFileSync(DOCUMENT_PATH, 'utf8');
const lines = document.split('\n');

/**
 * The lines of one `##`/`###` section, by its heading's opening text.
 *
 * Used where a table's shape is not unique in the document — the limits table
 * and the version table are both ``| `NAME` | value |`` — so the assertion has
 * to say which one it means.
 *
 * @param headingPrefix - How the section's heading line starts.
 * @returns The lines after that heading, up to the next heading of the same or
 *   a shallower level.
 * @throws If no heading starts with `headingPrefix`.
 */
function section(headingPrefix: string): string[] {
  const start = lines.findIndex((line) => line.startsWith(headingPrefix));
  if (start === -1) {
    throw new Error(
      `docs/protocol.md has no heading starting "${headingPrefix}". This check reads that section; restore the heading or update this test.`,
    );
  }

  const level = (/^#+/.exec(lines[start] ?? '')?.[0] ?? '#').length;
  const end = lines.findIndex(
    (line, index) =>
      index > start && /^#+ /.test(line) && (/^#+/.exec(line)?.[0] ?? '').length <= level,
  );

  return lines.slice(start + 1, end === -1 ? lines.length : end);
}

/**
 * Every fenced code block, with its info string.
 *
 * @returns One entry per fence, in document order.
 */
function fencedBlocks(): { info: string; body: string }[] {
  const blocks: { info: string; body: string }[] = [];
  let info: string | undefined;
  let body: string[] = [];

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (info === undefined) {
        info = line.slice(3).trim();
        body = [];
      } else {
        blocks.push({ info, body: body.join('\n') });
        info = undefined;
      }
      continue;
    }
    if (info !== undefined) {
      body.push(line);
    }
  }

  return blocks;
}

const blocks = fencedBlocks();

// ---------------------------------------------------------------------------
// Schemas the document may name
// ---------------------------------------------------------------------------

/** The one method this file needs from a schema. */
interface ParsableSchema {
  safeParse(value: unknown): { success: boolean; error?: { message: string } };
}

/**
 * Is this exported value a zod schema?
 *
 * @param value - Any exported value.
 * @returns `true` when it can parse.
 */
function isSchema(value: unknown): value is ParsableSchema {
  return (
    typeof value === 'object' &&
    value !== null &&
    'safeParse' in value &&
    typeof (value as { safeParse: unknown }).safeParse === 'function'
  );
}

/**
 * Everything a ```` ```json Name ```` fence may refer to.
 *
 * `packages/protocol` first, because that is what a third party compiles
 * against. The session shapes and the client frame schemas are added from the
 * server because they have no home in the protocol package yet, and a document
 * that could not show an example of `POST /sessions` would be describing the
 * endpoints it happens to be easy to check.
 */
const schemas = new Map<string, ParsableSchema>();

for (const [name, value] of Object.entries({ ...protocol, ...sessionRoutes })) {
  if (name.endsWith('Schema') && isSchema(value)) {
    schemas.set(name, value);
  }
}
for (const [name, value] of [
  ['HelloFrameSchema', HelloFrameSchema],
  ['AckFrameSchema', AckFrameSchema],
  ['PingFrameSchema', PingFrameSchema],
] as const) {
  schemas.set(name, value);
}

// ---------------------------------------------------------------------------
// Facts the document must agree with
// ---------------------------------------------------------------------------

/**
 * The codes that never travel in an HTTP response.
 *
 * Written out rather than derived, because they cannot be derived: all five map
 * to 500 in `HTTP_STATUS_BY_ERROR_CODE`, which is what a server bug is, not a
 * status any of them is answered with. Two close a WebSocket, two are raised by
 * the CLI before a request is made, and `SERVER_UNREACHABLE` is raised when the
 * request produced no response at all — a code a server could only send by
 * contradicting itself.
 *
 * A code added to the frozen set belongs in the document's table or in this
 * list, and the test below fails until somebody says which — which is the
 * moment to decide.
 */
const NON_HTTP_ERROR_CODES: ReadonlySet<ErrorCode> = new Set([
  'SESSION_INVALID',
  'PROTOCOL_VIOLATION',
  'NO_PROJECT',
  'NO_AGENT',
  'SERVER_UNREACHABLE',
] satisfies ErrorCode[]);

/**
 * The frame types the server may send.
 *
 * `as const satisfies` rather than a type annotation, and the difference is the
 * whole point: an annotation of `ServerFrame['type'][]` would widen every
 * element back to the union, making {@link ServerFrameTypesAreTotal} compare the
 * union with itself and pass for any list at all. `satisfies` checks each member
 * against the union while `as const` keeps the literals, so the witness below
 * has something to subtract.
 */
const SERVER_FRAME_TYPES = [
  'ready',
  'message',
  'pong',
  'error',
] as const satisfies readonly ServerFrame['type'][];

/**
 * Compile-time witness that {@link SERVER_FRAME_TYPES} covers the union.
 *
 * A member added to `ServerFrame` makes this `false`, and the assignment below
 * stops compiling — so `pnpm typecheck` fails before `pnpm test` does, naming
 * this file, which names the document.
 */
type ServerFrameTypesAreTotal =
  Exclude<ServerFrame['type'], (typeof SERVER_FRAME_TYPES)[number]> extends never ? true : false;
const _serverFrameTypesAreTotal: ServerFrameTypesAreTotal = true;

/**
 * The fields a `message` frame's payload carries.
 *
 * Checked against `keyof MessageEnvelope`, so a renamed field in
 * `routing/delivery.ts` fails the compiler here; {@link MessageEnvelopeKeysAreTotal}
 * catches an added one. See {@link SERVER_FRAME_TYPES} on why this is
 * `as const satisfies` and not an annotation.
 */
const MESSAGE_ENVELOPE_KEYS = [
  'messageId',
  'projectId',
  'conversationId',
  'parentMessageId',
  'senderAgentId',
  'sender',
  'recipientAgentId',
  'content',
  'createdAt',
] as const satisfies readonly (keyof MessageEnvelope)[];

/** Compile-time witness that {@link MESSAGE_ENVELOPE_KEYS} covers the interface. */
type MessageEnvelopeKeysAreTotal =
  Exclude<keyof MessageEnvelope, (typeof MESSAGE_ENVELOPE_KEYS)[number]> extends never
    ? true
    : false;
const _messageEnvelopeKeysAreTotal: MessageEnvelopeKeysAreTotal = true;

/** The constants the document's limits table quotes. */
const DOCUMENTED_CONSTANTS: Readonly<Record<string, number>> = {
  MAX_MESSAGE_CONTENT_BYTES: protocol.MAX_MESSAGE_CONTENT_BYTES,
  MAX_CLIENT_MESSAGE_ID_LENGTH: protocol.MAX_CLIENT_MESSAGE_ID_LENGTH,
  MAX_FRAME_BYTES,
  MAX_CLOSE_REASON_BYTES,
  DEFAULT_PENDING_LIMIT,
  MAX_PENDING_LIMIT,
  DEFAULT_CONVERSATION_LIMIT,
  MAX_CONVERSATION_LIMIT,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  HEARTBEAT_TIMEOUT_SECONDS,
  STALE_SESSION_LIFETIME_SECONDS,
};

// ---------------------------------------------------------------------------
// The routes this server actually registers
// ---------------------------------------------------------------------------

const config = loadConfig({
  DATABASE_URL: 'postgres://agentchat:agentchat@localhost:5432/agentchat',
  LOG_LEVEL: 'silent',
  JWT_SECRET: 'j'.repeat(MIN_JWT_SECRET_LENGTH),
  GITHUB_CLIENT_ID: 'protocol-doc-check',
  GITHUB_CLIENT_SECRET: 'protocol-doc-check',
});

/**
 * Parses `printRoutes`' tree into `METHOD /path` strings.
 *
 * Fastify prints one node per line, indented four characters per level, with a
 * node's own label and, when routes terminate there, its methods in
 * parentheses. A route is the concatenation of its ancestors' labels and its
 * own.
 *
 * ## A label is not a path segment
 *
 * The tree is a radix tree, so a node's label is whatever the branch has in
 * common — not necessarily something beginning with `/`. `/me` and `/messages`
 * share the first three characters, so they print as a `/me` node with a child
 * labelled `ssages`, and `commonPrefix: false` does not undo it:
 *
 * ```text
 * ├── /me (GET, HEAD)
 * │   └── ssages (POST, GET, HEAD)
 * │       └── /:id/ack (POST)
 * ```
 *
 * A parser that requires a leading `/` skips that middle line, and then joins
 * the line below it onto the wrong parent — reporting `POST /messages` and
 * `GET /messages` as unregistered and inventing `POST /me/:id/ack`, all four
 * wrong. So labels are taken verbatim and only the concatenation is a path.
 *
 * Intermediate nodes with no methods are pushed onto the stack too. They
 * contribute no route of their own, but every route below them is prefixed by
 * their label, and dropping the line would shift the depths underneath it.
 *
 * `HEAD` is dropped: Fastify adds it to every `GET` on its own, and documenting
 * it would be documenting the framework rather than the protocol.
 *
 * @param tree - The output of `printRoutes({ commonPrefix: false })`.
 * @returns Every registered route, as `METHOD /path`.
 */
function parsePrintedRoutes(tree: string): Set<string> {
  const routes = new Set<string>();
  const stack: string[] = [];

  for (const line of tree.split('\n')) {
    if (line.trim() === '') {
      continue;
    }

    // Greedy indent: the box-drawing characters are disjoint from anything a
    // label can start with, so the first character outside that set opens the
    // label. Methods are optional — an intermediate node has none.
    const match = /^([│├└─ ]*)(\S+?)(?:\s+\(([^)]+)\))?\s*$/u.exec(line);
    if (match === null) {
      continue;
    }

    const [, indent = '', label = '', methods] = match;
    const depth = Math.max(0, Math.floor(indent.length / 4) - 1);
    stack.length = depth;
    stack.push(label);

    if (methods === undefined) {
      continue;
    }

    const path = stack.join('');
    for (const method of methods.split(',').map((value) => value.trim())) {
      if (method !== 'HEAD') {
        routes.add(`${method} ${path}`);
      }
    }
  }

  return routes;
}

describe('parsePrintedRoutes', () => {
  it('joins a radix-split label onto its parent instead of dropping it', () => {
    // Verbatim from this server: `/me` and `/messages` share three
    // characters, so the tree splits mid-segment.
    const tree = [
      '├── /me (GET, HEAD)',
      '│   └── ssages (POST, GET, HEAD)',
      '│       └── /:id/ack (POST)',
    ].join('\n');

    expect([...parsePrintedRoutes(tree)].sort()).toEqual([
      'GET /me',
      'GET /messages',
      'POST /messages',
      'POST /messages/:id/ack',
    ]);
  });

  it('keeps the prefix of an intermediate node that terminates no route', () => {
    const tree = ['├── /projects/:id (GET, HEAD)', '│   └── /invites (POST)'].join('\n');

    expect([...parsePrintedRoutes(tree)].sort()).toEqual([
      'GET /projects/:id',
      'POST /projects/:id/invites',
    ]);
  });
});

let registeredRoutes: Set<string>;

beforeAll(async () => {
  // A Drizzle handle over a pool that is never dialled. `createApp` builds its
  // services over a real handle, and `pg` opens no socket until somebody asks
  // for a connection; nothing here reaches a route, so nothing connects.
  const db: NodePgDatabase<Record<string, never>> = drizzle(
    new Pool({ connectionString: config.databaseUrl }),
  );
  const database: AppDatabase = { ping: () => Promise.resolve(), db };
  const app = createApp({ config, database, logger: pino({ level: 'silent' }) });

  await app.ready();
  registeredRoutes = parsePrintedRoutes(app.printRoutes({ commonPrefix: false }));
  await app.close();
});

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

describe('docs/protocol.md documents the endpoints this server serves', () => {
  /**
   * Endpoint headings are exactly `### METHOD /path`, with the server's own
   * path syntax and no backticks. An endpoint mentioned any other way — as
   * `` `GET /version` `` in the "not served yet" section — is deliberately
   * invisible here, which is what lets the document discuss an endpoint that
   * does not exist.
   */
  const documented = new Set(
    lines
      .map((line) => /^### (GET|POST|PATCH|PUT|DELETE) (\/\S*)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => `${match[1]} ${match[2]}`),
  );

  it('documents every route the assembled application registers', () => {
    const undocumented = [...registeredRoutes].filter((route) => !documented.has(route)).sort();

    expect(
      undocumented,
      'These routes are registered and not documented. Add a "### METHOD /path" section for each to docs/protocol.md.',
    ).toEqual([]);
  });

  it('documents no endpoint the application does not register', () => {
    const invented = [...documented].filter((route) => !registeredRoutes.has(route)).sort();

    expect(
      invented,
      'These endpoints are documented as if served and no route registers them. Remove the section, correct the path, or move it to "What this build does not serve yet" where it is written in backticks rather than as a heading.',
    ).toEqual([]);
  });

  it('documents at least the whole surface, so an empty parse cannot pass', () => {
    // parsePrintedRoutes returning nothing would make both assertions above
    // vacuous. The number is a floor rather than an equality so that adding an
    // endpoint does not fail here as well as in the two checks that matter.
    expect(registeredRoutes.size).toBeGreaterThanOrEqual(20);
    expect(documented.size).toBeGreaterThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

describe('every tagged JSON example parses against its schema', () => {
  const tagged = blocks
    .map((block) => ({ ...block, name: /^json\s+(\w+)$/.exec(block.info)?.[1] }))
    .filter(
      (block): block is { info: string; body: string; name: string } => block.name !== undefined,
    );

  it('tags enough examples to be worth running', () => {
    expect(tagged.length).toBeGreaterThanOrEqual(25);
  });

  it.each(tagged.map((block) => [block.name, block.body] as const))('json %s', (name, body) => {
    const schema = schemas.get(`${name}Schema`);

    expect(
      schema,
      `docs/protocol.md tags an example "json ${name}", but no schema named ${name}Schema is exported by @stackgrid/protocol, server/src/routes/sessions.ts, or server/src/websocket/frames.ts. Fix the tag, or export the schema.`,
    ).toBeDefined();

    const result = schema?.safeParse(JSON.parse(body) as unknown);

    expect(
      result?.success,
      `The "json ${name}" example in docs/protocol.md does not satisfy ${name}Schema: ${result?.error?.message ?? 'unknown'}`,
    ).toBe(true);
  });

  it('parses every untagged JSON example as JSON', () => {
    // An untagged example has no schema to check — the server-to-client frames
    // are TypeScript types rather than zod schemas — but a block that is not
    // JSON at all is a typo nobody would otherwise notice.
    for (const block of blocks.filter((candidate) => candidate.info === 'json')) {
      expect(() => JSON.parse(block.body) as unknown).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe('the error contract in docs/protocol.md matches the frozen set', () => {
  /** Rows of the shape ``| `CODE` | 404 | …``, which only the code table has. */
  const documentedStatuses = new Map<string, number>(
    lines
      .map((line) => /^\|\s*`([A-Z_]+)`\s*\|\s*(\d{3})\s*\|/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [match[1] ?? '', Number(match[2])] as const)
      .filter(([code]) => (ERROR_CODES as readonly string[]).includes(code)),
  );

  it('documents every code a client can receive over HTTP, and no other', () => {
    const expected = ERROR_CODES.filter((code) => !NON_HTTP_ERROR_CODES.has(code)).sort();

    expect(
      [...documentedStatuses.keys()].sort(),
      'The HTTP error-code table in docs/protocol.md §3.1 is out of date. A code added to the frozen set belongs either in that table or in NON_HTTP_ERROR_CODES in this file.',
    ).toEqual(expected);
  });

  it('gives each code the status the server actually maps it to', () => {
    for (const [code, status] of documentedStatuses) {
      expect(status, `docs/protocol.md documents ${code} with the wrong HTTP status.`).toBe(
        HTTP_STATUS_BY_ERROR_CODE[code as ErrorCode],
      );
    }
  });

  it('mentions every frozen code somewhere, including the ones with no status', () => {
    const missing = ERROR_CODES.filter((code) => !document.includes(`\`${code}\``));

    expect(
      missing,
      'These error codes are in the frozen set and appear nowhere in docs/protocol.md. A code nobody documented is a code a client cannot branch on.',
    ).toEqual([]);
  });

  it('names no code that is not in the frozen set', () => {
    // Scoped to the two tables in §3.1, because the prose legitimately mentions
    // DATABASE_UNAVAILABLE — the health check's code, which is deliberately
    // outside the set and documented as such in §11.
    const named = section('### 3.1 ')
      .map((line) => /^\|\s*`([A-Z][A-Z_]+)`\s*\|/.exec(line)?.[1])
      .filter((code): code is string => code !== undefined);

    expect(named.length).toBeGreaterThan(0);
    for (const code of named) {
      expect(
        ERROR_CODES as readonly string[],
        `docs/protocol.md §3.1 documents "${code}", which is not a member of the frozen error set.`,
      ).toContain(code);
    }
  });
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

describe('the WebSocket contract in docs/protocol.md matches the code', () => {
  it('documents exactly the close codes the server closes with', () => {
    const documented = new Map<number, string>(
      lines
        .map((line) => /^\|\s*(\d{4})\s*\|\s*`([A-Z_]+)`\s*\|/.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => [Number(match[1]), match[2] ?? ''] as const),
    );

    const actual = new Map<number, string>(
      Object.entries(CloseCode).map(([name, code]) => [code, name] as const),
    );

    expect(
      [...documented.entries()].sort((a, b) => a[0] - b[0]),
      'The close-code table in docs/protocol.md §9.6 is out of date with CloseCode in server/src/websocket/frames.ts.',
    ).toEqual([...actual.entries()].sort((a, b) => a[0] - b[0]));
  });

  it('documents exactly the client frame types the decoder accepts', () => {
    const documented = section('### 9.3 ')
      .map((line) => /^#### `(\w+)`$/.exec(line)?.[1])
      .filter((type): type is string => type !== undefined)
      .sort();

    expect(
      documented,
      'The client frames documented in docs/protocol.md §9.3 are not the ones decodeFrame accepts.',
    ).toEqual([...CLIENT_FRAME_TYPES].sort());
  });

  it('documents exactly the server frame types the union declares', () => {
    const documented = section('### 9.4 ')
      .map((line) => /^#### `(\w+)`$/.exec(line)?.[1])
      .filter((type): type is string => type !== undefined)
      .sort();

    expect(
      documented,
      'The server frames documented in docs/protocol.md §9.4 are not the members of ServerFrame.',
    ).toEqual([...SERVER_FRAME_TYPES].sort());
  });

  it('shows an example of every server frame it documents', () => {
    const shown = new Set(
      blocks
        .filter((block) => block.info === 'json')
        .map((block) => JSON.parse(block.body) as { type?: unknown })
        .map((value) => value.type)
        .filter((type): type is string => typeof type === 'string'),
    );

    for (const type of SERVER_FRAME_TYPES) {
      expect(shown, `docs/protocol.md §9.4 documents the ${type} frame with no example.`).toContain(
        type,
      );
    }
  });

  it('shows a message frame whose payload is exactly the delivered envelope', () => {
    const frame = blocks
      .filter((block) => block.info === 'json')
      .map((block) => JSON.parse(block.body) as { type?: unknown; message?: unknown })
      .find((value) => value.type === 'message');

    expect(frame?.message).toBeDefined();

    expect(
      Object.keys(frame?.message as Record<string, unknown>).sort(),
      'The message frame example in docs/protocol.md §9.4 does not carry the fields MessageEnvelope does. A client reads this example to learn that the delivered payload says messageId where the HTTP shape says id.',
    ).toEqual([...MESSAGE_ENVELOPE_KEYS].sort());
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('the numbers in docs/protocol.md are the numbers in the code', () => {
  it('quotes the limits correctly', () => {
    const documented = new Map<string, number>(
      section('### 12.1 ')
        .map((line) => /^\|\s*`([A-Z_]+)`\s*\|\s*(\d+)\s*\|/.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => [match[1] ?? '', Number(match[2])] as const),
    );

    expect(
      Object.fromEntries([...documented.entries()].sort()),
      'The limits table in docs/protocol.md §12.1 is out of date.',
    ).toEqual(Object.fromEntries(Object.entries(DOCUMENTED_CONSTANTS).sort()));
  });

  it('quotes the version constants correctly', () => {
    const versions = section('## 2. ');
    const protocolVersion = versions
      .map((line) => /^\|\s*`PROTOCOL_VERSION`\s*\|\s*(\d+)\s*\|/.exec(line)?.[1])
      .find((value) => value !== undefined);
    const minClientVersion = versions
      .map((line) => /^\|\s*`MIN_CLIENT_VERSION`\s*\|\s*(\S+)\s*\|/.exec(line)?.[1])
      .find((value) => value !== undefined);

    expect(Number(protocolVersion), 'docs/protocol.md §2 quotes the wrong PROTOCOL_VERSION.').toBe(
      protocol.PROTOCOL_VERSION,
    );
    expect(minClientVersion, 'docs/protocol.md §2 quotes the wrong MIN_CLIENT_VERSION.').toBe(
      protocol.MIN_CLIENT_VERSION,
    );
  });
});
