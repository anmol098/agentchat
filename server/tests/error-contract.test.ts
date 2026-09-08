import {
  ERROR_CODES,
  ErrorCode,
  ErrorCodeSchema,
  isErrorCode,
  ProtocolError,
} from '@agentchat/protocol';
import type { FastifyInstance, InjectOptions } from 'fastify';
import pino, { type Logger } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppShell, REQUEST_ID_HEADER } from '../src/app.js';
import { loadConfig, type ServerConfig } from '../src/config.js';
import {
  assertContractCode,
  ERROR_CODE_BY_FASTIFY_CODE,
  HTTP_STATUS_BY_ERROR_CODE,
  INTERNAL_ERROR_MESSAGE,
  toErrorResponse,
} from '../src/errors.js';
import type { HealthProbe } from '../src/routes/health.js';

/**
 * The guard on the frozen error contract (T-015).
 *
 * The interesting test here is `every error response answers with a code from
 * the frozen set`. It is written as a sweep rather than a list of expected
 * pairs on purpose: a case-by-case test only covers the failures somebody
 * thought of, and the failure this task exists to fix — the 500 handler
 * emitting `INTERNAL_ERROR`, a code no client can find in the contract — was
 * found by reading rather than by any of the 312 tests that were already
 * passing.
 *
 * The sweep asserts a property of *every* error response the app produces, so
 * it keeps working for routes written after it. Adding a route that leaks a
 * framework code is caught by adding that route to `SCENARIOS`, and the
 * per-scenario expectations below are then documentation rather than coverage.
 *
 * `GET /healthz` is deliberately outside the contract and stays that way; see
 * the note on `DATABASE_UNAVAILABLE` in `server/src/routes/health.ts`. It is
 * covered here by the exemption being *narrow* — the sweep tests every body
 * that is the protocol envelope, and the health body is a status document with
 * `status` and `checks`, which is exactly the distinction T-013 drew.
 */

/** Discards log output; these tests are about responses, not records. */
function silentLogger(): Logger {
  return pino({ level: 'silent' }, { write: () => undefined });
}

const config: ServerConfig = loadConfig({
  DATABASE_URL: 'postgres://agentchat:agentchat@localhost:5432/agentchat',
  LOG_LEVEL: 'silent',
  JWT_SECRET: 'j'.repeat(32),
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
});

/** A probe that always says the database is fine. */
const reachable: HealthProbe = { ping: () => Promise.resolve() };

/** A probe that fails the way `pg` does when nothing is listening. */
const unreachable: HealthProbe = {
  ping: () => Promise.reject(new Error('connect ECONNREFUSED 10.1.2.3:5432')),
};

const started: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((app) => app.close()));
});

/**
 * Builds an app with routes that fail in every way a route can.
 *
 * `app.ts` has no route that accepts a body yet, which is the only reason the
 * framework-code leak was unreachable rather than shipped. These routes are
 * what a milestone 1 route will look like, so the leak is reachable here.
 */
function buildApp(database: HealthProbe = reachable): FastifyInstance {
  // The shell, not `createApp`: this suite is about the error contract, and on
  // an authenticated instance every route below would answer 401 before it
  // could fail in the way the test is about. The contract itself is the
  // shell's — one `setErrorHandler`, one `frameworkErrors`, one not-found
  // handler — so nothing under test moves.
  const app = createAppShell({ config, database, logger: silentLogger() });
  started.push(app);

  // A body-accepting route. The per-route limit is tiny so the oversized-body
  // case does not have to push 2 MiB through `inject`; it raises the same
  // `FST_ERR_CTP_BODY_TOO_LARGE` the configured 2 MiB limit raises.
  app.post('/echo', { bodyLimit: 32 }, (request) => request.body);

  // An unhandled fault: a bug, a driver that threw, a null dereference.
  app.get('/boom', () => {
    throw new Error('a stack trace, a table name, and a connection string');
  });

  // A handler that says what it means through the contract. This is the shape
  // every milestone 1 route should use.
  app.get('/not-in-project', () => {
    throw new ProtocolError(ErrorCode.AGENT_NOT_IN_PROJECT, 'The agent has not joined pilot.');
  });

  // A handler that says what it means through the status alone, the way an
  // `http-errors`-style object from a plugin does.
  app.get('/forbidden', () => {
    throw Object.assign(new Error('Not your project.'), { statusCode: 403 });
  });

  // A handler that invents its own code. Plausible, and off-contract.
  app.get('/invented-code', () => {
    throw Object.assign(new Error('Nope.'), { statusCode: 400, code: 'AGENT_TOO_CHATTY' });
  });

  // A `ProtocolError` whose code has been forced off the contract, which is
  // what a cast, a stale build or a renamed code looks like at run time.
  app.get('/forged-code', () => {
    const error = new ProtocolError(ErrorCode.NOT_FOUND, 'Nothing here.');
    Object.defineProperty(error, 'code', { value: 'INTERNAL_ERROR' });
    throw error;
  });

  return app;
}

/** One request, and what it is meant to prove. */
interface Scenario {
  readonly name: string;
  readonly inject: InjectOptions;
  /** The status the caller should see. */
  readonly status: number;
  /** The contract code the caller should see. */
  readonly code: ErrorCode;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'an unknown route',
    inject: { method: 'GET', url: '/nope' },
    status: 404,
    code: ErrorCode.NOT_FOUND,
  },
  {
    // The router rejects this before a route is matched, so it never reaches
    // the error handler at all. Without `frameworkErrors` in `app.ts` Fastify
    // writes its own body — `{"error":"Bad Request","code":"FST_ERR_BAD_URL",
    // ...}` — straight to the socket, past every hook.
    name: 'a URL that will not decode',
    inject: { method: 'GET', url: '/%zz' },
    status: 400,
    code: ErrorCode.BAD_REQUEST,
  },
  {
    name: 'a method the route does not serve',
    inject: { method: 'DELETE', url: '/healthz' },
    status: 404,
    code: ErrorCode.NOT_FOUND,
  },
  {
    // The case in the task brief: `FST_ERR_CTP_INVALID_MEDIA_TYPE` used to be
    // handed to the client verbatim. (`text/plain` would not do here — Fastify
    // parses that one by default — so this asks for a type nothing handles.)
    name: 'a content type nothing can parse',
    inject: {
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/xml' },
      body: '<hello/>',
    },
    status: 415,
    code: ErrorCode.BAD_REQUEST,
  },
  {
    name: 'a body that is not the JSON it claims to be',
    inject: {
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      body: '{ "not": ',
    },
    status: 400,
    code: ErrorCode.BAD_REQUEST,
  },
  {
    // `PAYLOAD_TOO_LARGE` exists precisely so this is not a generic 400: the
    // caller's remedy is "send less", which is different from "send it right".
    name: 'a body over the limit',
    inject: {
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(256) }),
    },
    status: 413,
    code: ErrorCode.PAYLOAD_TOO_LARGE,
  },
  {
    name: 'an unhandled fault in a handler',
    inject: { method: 'GET', url: '/boom' },
    status: 500,
    code: ErrorCode.INTERNAL,
  },
  {
    name: 'a handler raising a contract error',
    inject: { method: 'GET', url: '/not-in-project' },
    status: 403,
    code: ErrorCode.AGENT_NOT_IN_PROJECT,
  },
  {
    name: 'a handler raising a bare status',
    inject: { method: 'GET', url: '/forbidden' },
    status: 403,
    code: ErrorCode.FORBIDDEN,
  },
  {
    name: 'a handler inventing a code of its own',
    inject: { method: 'GET', url: '/invented-code' },
    status: 400,
    code: ErrorCode.BAD_REQUEST,
  },
  {
    name: 'a contract error whose code has drifted off the contract',
    inject: { method: 'GET', url: '/forged-code' },
    status: 500,
    code: ErrorCode.INTERNAL,
  },
];

/** The protocol envelope is `{ error: { code, message } }` and nothing else. */
function protocolEnvelopeCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }

  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'error') {
    return undefined;
  }

  const error: unknown = (body as { error: unknown }).error;
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const code: unknown = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

describe('every error response answers with a code from the frozen set', () => {
  it.each(SCENARIOS)('$name', async (scenario) => {
    const app = buildApp();

    const response = await app.inject(scenario.inject);
    const code = protocolEnvelopeCode(response.json());

    // The property, asserted for its own sake: whatever this response is, its
    // code is one a client can find in `packages/protocol`.
    expect(ErrorCodeSchema.safeParse(code).success).toBe(true);

    // A framework internal never reaches a caller, whatever the code.
    expect(response.body).not.toContain('FST_ERR');

    // And the caller can always quote an identifier back at an operator.
    expect(response.headers[REQUEST_ID_HEADER]).toBeDefined();

    // And the specific mapping, as documentation of what was decided.
    expect(response.statusCode).toBe(scenario.status);
    expect(code).toBe(scenario.code);
  });

  it('is the whole error surface: no scenario answers 2xx by accident', async () => {
    const app = buildApp();

    const statuses = await Promise.all(
      SCENARIOS.map(async (scenario) => (await app.inject(scenario.inject)).statusCode),
    );

    expect(statuses.every((status) => status >= 400)).toBe(true);
  });

  it('says nothing about the inside of the server behind a 500', async () => {
    const app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/boom' });

    expect(response.json()).toEqual({
      error: { code: ErrorCode.INTERNAL, message: INTERNAL_ERROR_MESSAGE },
    });
    expect(response.body).not.toContain('connection string');
    expect(response.body).not.toContain('table name');
  });

  it('still describes a 4xx, because that is the caller’s to fix', async () => {
    const app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/not-in-project' });

    expect(response.json()).toMatchObject({
      error: {
        code: ErrorCode.AGENT_NOT_IN_PROJECT,
        message: 'The agent has not joined pilot.',
      },
    });
  });

  it('emits INTERNAL, the contract code, and never the INTERNAL_ERROR that drifted', async () => {
    const app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/boom' });

    expect(response.body).not.toContain('INTERNAL_ERROR');
    expect(isErrorCode(response.json<{ error: { code: string } }>().error.code)).toBe(true);
  });
});

describe('the health endpoint keeps its own operational code', () => {
  it('answers with a status document rather than the protocol envelope', async () => {
    const app = buildApp(unreachable);

    const response = await app.inject({ method: 'GET', url: '/healthz' });
    const body: unknown = response.json();

    expect(response.statusCode).toBe(503);
    expect(body).toEqual({
      status: 'error',
      checks: { database: 'error' },
      error: { code: 'DATABASE_UNAVAILABLE', message: 'The database is not reachable.' },
    });

    // The exemption is narrow rather than an exception carved into the sweep:
    // this body is not the protocol envelope, so the frozen-set property was
    // never a claim about it. T-013 §2.
    expect(protocolEnvelopeCode(body)).toBeUndefined();
    expect(isErrorCode('DATABASE_UNAVAILABLE')).toBe(false);
  });
});

describe('toErrorResponse', () => {
  it('answers a value that is not an error at all', () => {
    for (const thrown of [undefined, null, 'a string', 42, { statusCode: 'nonsense' }]) {
      const response = toErrorResponse(thrown);

      expect(response.statusCode).toBe(500);
      expect(response.body.error.code).toBe(ErrorCode.INTERNAL);
    }
  });

  it('refuses a status that is not a failure', () => {
    // A `statusCode` of 200 means the thrower never set one, which makes the
    // failure the server's rather than the caller's.
    expect(toErrorResponse(Object.assign(new Error('x'), { statusCode: 200 })).statusCode).toBe(
      500,
    );
  });

  it('takes the status of a contract error from the contract', () => {
    const response = toErrorResponse(new ProtocolError(ErrorCode.CONFLICT, 'Name taken.'));

    expect(response).toEqual({
      statusCode: HTTP_STATUS_BY_ERROR_CODE[ErrorCode.CONFLICT],
      body: { error: { code: ErrorCode.CONFLICT, message: 'Name taken.' } },
    });
  });

  it('answers a 4xx status the contract has no inverse for', () => {
    // 418 is nobody's contract code, and neither are 405, 422 or 429. The
    // caller still gets a code it can branch on rather than a status alone.
    const response = toErrorResponse(Object.assign(new Error('No coffee.'), { statusCode: 418 }));

    expect(response).toEqual({
      statusCode: 418,
      body: { error: { code: ErrorCode.BAD_REQUEST, message: 'No coffee.' } },
    });
  });

  it('never emits an empty message', () => {
    // A rejection that is not an `Error` at all, which is what a `throw` of a
    // plain object or a driver's own value looks like.
    const response = toErrorResponse({ statusCode: 400 });

    expect(response.body.error.message.length).toBeGreaterThan(0);
  });
});

describe('the contract tables', () => {
  it('gives every code in the frozen set an HTTP status', () => {
    // Compile-time exhaustiveness is the real guarantee; this proves it did
    // not decay into a partial record through a cast.
    for (const code of ERROR_CODES) {
      expect(HTTP_STATUS_BY_ERROR_CODE[code]).toBeGreaterThanOrEqual(400);
    }

    expect(Object.keys(HTTP_STATUS_BY_ERROR_CODE)).toHaveLength(ERROR_CODES.length);
  });

  it('maps every Fastify code onto the frozen set and nothing else', () => {
    for (const [fastifyCode, contractCode] of Object.entries(ERROR_CODE_BY_FASTIFY_CODE)) {
      expect(fastifyCode.startsWith('FST_ERR_')).toBe(true);
      expect(isErrorCode(contractCode)).toBe(true);
    }
  });

  it('turns the code that drifted back into the one the contract has', () => {
    // The literal this whole task exists to remove. Even reintroduced, it
    // cannot reach a client.
    expect(assertContractCode('INTERNAL_ERROR')).toBe(ErrorCode.INTERNAL);
    expect(assertContractCode(ErrorCode.NOT_FOUND)).toBe(ErrorCode.NOT_FOUND);
    expect(assertContractCode(undefined)).toBe(ErrorCode.INTERNAL);
  });
});
