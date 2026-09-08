/**
 * The invite routes, over a real Fastify instance and a stubbed service.
 *
 * The sibling of `projects.test.ts`, built the same way and for the same
 * reason: what a route does that has nothing to do with Postgres is which
 * schema each request is parsed against, where the caller's identity comes
 * from, and whether a failure reaches the client as a contract envelope. The
 * app is built by `createAppShell` and guarded by `registerAuth`, so every
 * status asserted here is one a client would actually receive.
 *
 * The service is a stub because what it does to a database is proven against a
 * real one in `invites.integration.test.ts`. What is deliberately *not* stubbed
 * is authentication, because the property this file exists to establish cannot
 * be established anywhere else:
 *
 * **All three invite routes are protected by omission.** None of them declares
 * `config.auth`, so `plugins/auth.ts` treats all three as `required` — the
 * preview included. That is easy to describe in a comment and easy to undo by
 * accident, so it is pinned here as a list of every route in the module. A
 * fourth route added without a thought about credentials joins that list rather
 * than becoming a hole in it, and `PUBLIC_ROUTES` in `app.ts` — T-023's file —
 * is the only place that decision may be reversed.
 *
 * The other property only reachable here is the negative one: that an invite
 * code, being a bearer credential, is never echoed into an error message and so
 * never into the logs between the server and the caller. A stubbed service is
 * what lets a deliberately malformed code reach the parser at all.
 */

import {
  type CreateInviteResponse,
  ErrorCode,
  type InviteCode,
  type InvitePreviewResponse,
  type JoinProjectResponse,
  ProjectId,
  type ProjectId as ProjectIdType,
  ProtocolError,
  UserId,
  type UserId as UserIdType,
} from '@agentchat/protocol';
import type { FastifyInstance } from 'fastify';
import pino, { type Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAppShell } from '../app.js';
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken } from '../auth/tokens.js';
import { loadConfig, type ServerConfig } from '../config.js';
import { registerAuth } from '../plugins/auth.js';
import { INVITE_INVALID_MESSAGE, type InviteService } from '../services/invites.js';
import type { HealthProbe } from './health.js';
import { registerInviteRoutes } from './invites.js';

/** The signing key both the token and the guard use. */
const JWT_SECRET = 'j'.repeat(32);

const config: ServerConfig = loadConfig({
  DATABASE_URL: 'postgres://agentchat:agentchat@localhost:5432/agentchat',
  LOG_LEVEL: 'silent',
  JWT_SECRET,
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
});

/** The health probe `createAppShell` requires; no route under test uses it. */
const database: HealthProbe = { ping: () => Promise.resolve() };

/** A logger that writes nowhere. */
const logger: Logger = pino({ level: 'silent' });

/** The caller every authenticated request below is made as. */
const caller: UserIdType = UserId.generate();

/** The project the stub answers about. */
const projectId: ProjectIdType = ProjectId.generate();

/** The user the stub names as the inviter. */
const inviter: UserIdType = UserId.generate();

/** A well-formed code, in the format the service actually mints. */
const CODE = 'ANET-7K4M-Q2P9';

/** The project both invite responses carry. */
const project = {
  id: projectId,
  slug: 'payments',
  name: 'Payments Platform',
  createdBy: inviter,
  createdAt: new Date('2026-09-08T10:00:00.000Z').toISOString(),
};

/** What the stub service was asked, so a test can assert the route passed it on. */
interface Call {
  readonly method: string;
  readonly userId?: UserIdType;
  readonly projectId?: ProjectIdType;
  readonly code?: InviteCode;
}

let calls: Call[];
let app: FastifyInstance;

/** A bearer header for a user, valid now. */
function bearer(userId: UserIdType): string {
  const iat = Math.floor(Date.now() / 1000);
  return `Bearer ${signAccessToken({ sub: userId, iat, exp: iat + ACCESS_TOKEN_TTL_SECONDS }, JWT_SECRET)}`;
}

/** A service that records what it was asked and answers with fixtures. */
function recordingService(): InviteService {
  return {
    create(userId: UserIdType, id: ProjectIdType): Promise<CreateInviteResponse> {
      calls.push({ method: 'create', userId, projectId: id });
      return Promise.resolve({
        code: CODE,
        expiresAt: new Date('2026-09-15T10:00:00.000Z').toISOString(),
      });
    },
    preview(code: InviteCode): Promise<InvitePreviewResponse> {
      // No user id in the signature. That is the contract this route relies on,
      // and a stub that took one would quietly make the assertion below
      // untestable.
      calls.push({ method: 'preview', code });
      return Promise.resolve({
        project,
        invitedBy: { id: inviter, username: 'alice', displayName: 'Alice' },
      });
    },
    join(userId: UserIdType, code: InviteCode): Promise<JoinProjectResponse> {
      calls.push({ method: 'join', userId, code });
      return Promise.resolve({ project: { ...project, role: 'member' } });
    },
  };
}

/** The error envelope a response carries. */
function envelopeOf(payload: string): { code: string; message: string } {
  const parsed = JSON.parse(payload) as { error: { code: string; message: string } };
  return parsed.error;
}

/** An app whose invite service is the given one. */
function appWith(service: InviteService): FastifyInstance {
  const own = createAppShell({ config, database, logger });
  registerAuth(own, { jwtSecret: JWT_SECRET });
  // `db` is required by the options type and unused: the stub service is what
  // answers, and passing a real handle here would make this a slower version of
  // the integration suite.
  registerInviteRoutes(own, { db: undefined as never, service });
  return own;
}

beforeEach(() => {
  calls = [];
  app = appWith(recordingService());
});

afterEach(async () => {
  await app.close();
});

describe('authentication', () => {
  it('refuses every invite route without a token, the preview included', async () => {
    // Every route this module registers. Plan §3 puts bearer auth on everything
    // but `/auth/device/*` and `/healthz`, and `/invites/:code` is not among
    // the exceptions — it is authorization that the preview relaxes, not
    // authentication.
    const routes = [
      { method: 'POST' as const, url: `/projects/${projectId}/invites` },
      { method: 'GET' as const, url: `/invites/${CODE}` },
      { method: 'POST' as const, url: `/invites/${CODE}/join` },
    ];

    for (const route of routes) {
      const response = await app.inject({ ...route, payload: {} });
      expect(response.statusCode, route.url).toBe(401);
      expect(envelopeOf(response.payload).code, route.url).toBe(ErrorCode.AUTH_REQUIRED);
    }

    // And the service was never consulted, so an anonymous request cannot even
    // be used to time a lookup.
    expect(calls).toStrictEqual([]);
  });

  it('takes the joining caller from the token, never from the request', async () => {
    const impostor = UserId.generate();

    const response = await app.inject({
      method: 'POST',
      url: `/invites/${CODE}/join`,
      headers: { authorization: bearer(caller) },
      // A body naming somebody else, and a code contradicting the path. The
      // handler reads `request.requireUser()` and takes the code from the URL,
      // so neither changes anything — which is the assertion. Redeeming an
      // invite on another user's behalf would be a way to conscript an account
      // into a project it never asked to join.
      payload: { userId: impostor, code: 'ANET-AAAA-AAAA' },
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toStrictEqual([{ method: 'join', userId: caller, code: CODE }]);
  });
});

describe('POST /projects/:id/invites', () => {
  it('passes the authenticated caller and the path project to the service', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/invites`,
      headers: { authorization: bearer(caller) },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toStrictEqual({
      code: CODE,
      expiresAt: '2026-09-15T10:00:00.000Z',
    });
    expect(calls).toStrictEqual([{ method: 'create', userId: caller, projectId }]);
  });

  it('accepts an absent body, since the request has no fields', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/invites`,
      headers: { authorization: bearer(caller) },
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toStrictEqual([{ method: 'create', userId: caller, projectId }]);
  });

  it('ignores fields the contract does not declare rather than honouring them', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/invites`,
      headers: { authorization: bearer(caller) },
      // A client asking for a code that never dies. Expiry and use limits are
      // server policy: `CreateInviteRequestSchema` declares no fields, so these
      // are stripped and the seven-day default stands.
      payload: { expiresIn: null, maxUses: 1000 },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload).expiresAt).toBe('2026-09-15T10:00:00.000Z');
  });

  it('answers a malformed project id with BAD_REQUEST, not NOT_FOUND', async () => {
    // A segment that is not an identifier and a lookup that misses are
    // different mistakes. Answering both 404 would tell a caller their
    // well-formed id was wrong when it was never well-formed.
    const response = await app.inject({
      method: 'POST',
      url: '/projects/not-an-id/invites',
      headers: { authorization: bearer(caller) },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(envelopeOf(response.payload).code).toBe(ErrorCode.BAD_REQUEST);
    expect(calls).toStrictEqual([]);
  });
});

describe('GET /invites/:code', () => {
  it('previews without telling the service who is asking', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/invites/${CODE}`,
      headers: { authorization: bearer(caller) },
    });

    expect(response.statusCode).toBe(200);

    // The recorded call carries no `userId`, because `preview` has nowhere to
    // put one. A handler that started passing the caller through would have to
    // change the service's signature to do it, which is the point of the
    // signature.
    expect(calls).toStrictEqual([{ method: 'preview', code: CODE }]);
  });

  it('returns the project and the inviter, and nothing the caller sent', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/invites/${CODE}`,
      headers: { authorization: bearer(caller) },
    });

    expect(JSON.parse(response.payload)).toStrictEqual({
      project,
      invitedBy: { id: inviter, username: 'alice', displayName: 'Alice' },
    });
  });

  it('passes the code through verbatim, leaving the spelling rule to the service', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/invites/${CODE.toLowerCase()}`,
      headers: { authorization: bearer(caller) },
    });

    expect(response.statusCode).toBe(200);
    // Not upper-cased here: one spelling rule, in the module that owns the
    // lookup. Canonicalising in two places is how they drift apart.
    expect(calls).toStrictEqual([{ method: 'preview', code: CODE.toLowerCase() }]);
  });
});

describe('a code the parser refuses', () => {
  /** Codes that could not be a path segment at all, and so never reach a lookup. */
  const malformed = [
    { what: 'a space', code: 'not%20a%20code' },
    { what: 'a slash-escaped separator', code: 'ANET%2F7K4M' },
    { what: 'a query-ish character', code: 'ANET-7K4M%3Fx' },
    { what: 'punctuation', code: 'ANET_7K4M' },
  ];

  for (const { what, code } of malformed) {
    it(`rejects ${what} with BAD_REQUEST before the service sees it`, async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/invites/${code}`,
        headers: { authorization: bearer(caller) },
      });

      expect(response.statusCode).toBe(400);
      expect(envelopeOf(response.payload).code).toBe(ErrorCode.BAD_REQUEST);
      expect(calls).toStrictEqual([]);
    });
  }

  it('never echoes the code back into the error message', async () => {
    // A code is a bearer credential. Echoing a rejected one puts it in every
    // log, proxy trace and error report between here and the caller — and the
    // one most likely to be rejected is a real code somebody mistyped.
    const response = await app.inject({
      method: 'GET',
      url: '/invites/ANET-7K4M-Q2P9%20',
      headers: { authorization: bearer(caller) },
    });

    expect(response.statusCode).toBe(400);
    expect(envelopeOf(response.payload).message).not.toContain('7K4M');
  });

  it('rejects a malformed code on the join route too', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/invites/not%20a%20code/join',
      headers: { authorization: bearer(caller) },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(envelopeOf(response.payload).code).toBe(ErrorCode.BAD_REQUEST);
    expect(calls).toStrictEqual([]);
  });
});

describe('failures from the service', () => {
  /** A service whose every method refuses with the given error. */
  function failingWith(error: ProtocolError): InviteService {
    return {
      create: () => Promise.reject(error),
      preview: () => Promise.reject(error),
      join: () => Promise.reject(error),
    };
  }

  it('travels as a contract envelope with the status the code maps to', async () => {
    const own = appWith(
      failingWith(new ProtocolError(ErrorCode.INVITE_INVALID, INVITE_INVALID_MESSAGE)),
    );

    try {
      const preview = await own.inject({
        method: 'GET',
        url: `/invites/${CODE}`,
        headers: { authorization: bearer(caller) },
      });

      // `INVITE_INVALID` maps to 404 in `errors.ts`. It is a distinct code from
      // `NOT_FOUND` so a client can print "ask for a fresh invite" rather than
      // "no such project", but it carries the same status so a bad code and an
      // invisible project are indistinguishable from the outside.
      expect(preview.statusCode).toBe(404);
      expect(envelopeOf(preview.payload)).toStrictEqual({
        code: ErrorCode.INVITE_INVALID,
        message: INVITE_INVALID_MESSAGE,
      });
    } finally {
      await own.close();
    }
  });

  it('gives preview and join byte-identical refusals', async () => {
    const own = appWith(
      failingWith(new ProtocolError(ErrorCode.INVITE_INVALID, INVITE_INVALID_MESSAGE)),
    );

    try {
      const preview = await own.inject({
        method: 'GET',
        url: `/invites/${CODE}`,
        headers: { authorization: bearer(caller) },
      });
      const join = await own.inject({
        method: 'POST',
        url: `/invites/${CODE}/join`,
        headers: { authorization: bearer(caller) },
        payload: {},
      });

      // The two endpoints must not disagree about a bad code: if joining
      // refused differently from previewing, a guesser would simply use
      // whichever one talked more.
      expect(join.statusCode).toBe(preview.statusCode);
      expect(envelopeOf(join.payload)).toStrictEqual(envelopeOf(preview.payload));
    } finally {
      await own.close();
    }
  });

  it('does not turn a non-member into an invite error when minting', async () => {
    const own = appWith(
      failingWith(
        new ProtocolError(ErrorCode.NOT_FOUND, 'No such project, or you are not a member of it.'),
      ),
    );

    try {
      const response = await own.inject({
        method: 'POST',
        url: `/projects/${projectId}/invites`,
        headers: { authorization: bearer(caller) },
        payload: {},
      });

      // The refusal the authorization service chose reaches the client
      // unaltered — the same answer `GET /projects/:id` gives a non-member, so
      // minting cannot be used to test whether a project id is real.
      expect(response.statusCode).toBe(404);
      expect(envelopeOf(response.payload).code).toBe(ErrorCode.NOT_FOUND);
    } finally {
      await own.close();
    }
  });
});
