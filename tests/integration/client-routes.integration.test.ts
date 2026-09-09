/**
 * Every route `@agentchat/client` calls is a route the server serves.
 *
 * ## The check that would have caught T-043
 *
 * Three endpoints had protocol schemas, had client methods, were called by
 * shipped commands, and did not exist. Every gate passed: the protocol snapshot
 * checks shapes and not routes; the client suite drives a stub that answers
 * whatever the client asks for; the server suite drives the routes the server
 * registers, so it cannot notice one that was never written; and typechecking
 * sees a string. Nothing in the repository related "what the client calls" to
 * "what the server answers", so nothing could fail.
 *
 * This does. It reads the call sites out of the client's own source, then asks
 * a running server for each one and fails on the unmatched-route response. It
 * needs no list to be kept up to date, because the list *is* the client: a
 * method added with no route fails here on the commit that adds it, and a route
 * deleted under a client that still calls it fails on the commit that deletes
 * it.
 *
 * ## Why it reads the source
 *
 * A client method is a function; there is no registry to enumerate at runtime,
 * and adding one so this test could read it would be building a mechanism to
 * satisfy a test. The call sites are uniform — `method:` then `path:` inside a
 * single `#api.send({ … })` — and the scan is guarded against the way a source
 * scan usually rots: {@link EXPECTED_AT_LEAST} fails the test if the regex
 * silently stops matching, so a formatting change breaks this loudly rather
 * than turning it into a test that checks nothing.
 *
 * ## Why the oracle is an authenticated request
 *
 * A request that matches no route is answered by the not-found handler, which
 * declares no `auth` stance and is therefore protected like everything else —
 * so an *unauthenticated* probe cannot tell "this route does not exist" from
 * "you are not signed in". Both are the same 401. With a real token the two
 * separate cleanly, and the unmatched case is the one distinctive response in
 * `app.ts`.
 *
 * @module
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryCredentialStore } from '@agentchat/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ServerFixture, startServer } from './server-fixture.js';

/** Where the client declares its calls. */
const CLIENT_SOURCE = fileURLToPath(new URL('../../packages/client/src', import.meta.url));

/**
 * The fewest call sites a healthy scan finds.
 *
 * A source scan that quietly matches nothing is worse than no check at all,
 * because it is a green tick over an unasked question. This is comfortably
 * below the count today and above zero; if biome ever reformats these calls,
 * this fails and says so.
 */
const EXPECTED_AT_LEAST = 20;

/**
 * Routes the client calls that the server does not serve **yet**, each with the
 * task that will fix it.
 *
 * This is not a way to silence the check. An entry here fails the test the
 * moment the route starts working, so a stale exemption cannot outlive the fix
 * it names — the allowlist empties itself.
 *
 * It is empty, and the emptying is the point: `GET /version` sat here because
 * `server/src/routes/version.ts` was complete, tested, named in `PUBLIC_ROUTES`
 * and registered by nobody. T-041 registered it, and this entry failed on the
 * next run rather than waiting for somebody to remember it.
 */
const KNOWN_MISSING = new Map<string, string>();

/** One call the client makes. */
interface ClientCall {
  readonly method: string;
  /** The path with `${…}` interpolations left in, for the failure message. */
  readonly template: string;
  /** The path with interpolations replaced by a routable segment. */
  readonly probe: string;
  /** Where it is declared, for the failure message. */
  readonly where: string;
}

/** Every `.ts` file under a directory tree, excluding tests. */
function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Reads every `#api.send` call site out of the client's source.
 *
 * Handles both shapes the client uses: the path written inline, and the path
 * hoisted into a `const path` immediately above the call — the two invite
 * methods do the latter because they run the code through an escaper first.
 *
 * @returns One entry per call site.
 */
function clientCalls(): ClientCall[] {
  const calls: ClientCall[] = [];

  for (const file of sourceFiles(CLIENT_SOURCE)) {
    const text = readFileSync(file, 'utf8');
    const where = file.slice(CLIENT_SOURCE.length + 1);

    const methods = /method:\s*'(?<method>[A-Z]+)'\s*,/g;
    let match = methods.exec(text);

    while (match !== null) {
      const method = match.groups?.['method'] ?? '';
      const after = text.slice(match.index, match.index + 200);

      // `path: '/x'` or `path: \`/x/${y}\`` on the following line.
      const inline = /path:\s*(?<quote>['`])(?<path>[^'`]*)\k<quote>\s*,/.exec(after);

      // …or `path,`, referring to a const declared just above the call.
      const hoisted = /path\s*,/.test(after)
        ? /.*const path = (?<quote>['`])(?<path>[^'`]*)\k<quote>/s.exec(text.slice(0, match.index))
        : null;

      const template = inline?.groups?.['path'] ?? hoisted?.groups?.['path'];

      if (template?.startsWith('/')) {
        calls.push({
          method,
          template,
          // Fastify matches a `:param` against any single segment, so the
          // value only has to be a segment. Whether the id is well formed is
          // the route's business and not this test's; anything other than the
          // unmatched-route answer means the route is there.
          probe: template.replaceAll(/\$\{[^}]*\}/g, 'probe'),
          where,
        });
      }

      match = methods.exec(text);
    }
  }

  return calls;
}

let server: ServerFixture;
let accessToken: string;

beforeAll(async () => {
  server = await startServer();

  const store = new InMemoryCredentialStore();
  await server.login(store);
  const credentials = await store.load();
  if (credentials === null) {
    throw new Error('the device flow issued nothing');
  }
  accessToken = credentials.accessToken;
}, 60_000);

afterAll(async () => {
  await server?.close();
});

/**
 * Asks the server for one path and reports whether it matched a route.
 *
 * @param call - The call site to probe.
 * @returns Whether the server answered with the unmatched-route response.
 */
async function isUnrouted(call: ClientCall): Promise<boolean> {
  const carriesBody = call.method !== 'GET' && call.method !== 'DELETE';

  const response = await server.app.inject({
    method: call.method as 'GET',
    url: call.probe,
    headers: { authorization: `Bearer ${accessToken}` },

    // An empty body every route will reject on its merits rather than on its
    // absence. The question here is only whether the router found anything.
    ...(carriesBody ? { payload: {} } : {}),
  });

  if (response.statusCode !== 404) {
    return false;
  }

  const body = response.json() as { error?: { code?: string; message?: string } };

  // A route that exists may legitimately answer `NOT_FOUND` — "no such
  // project". Only `app.ts`'s not-found handler phrases it this way.
  return (
    body.error?.code === 'NOT_FOUND' && /^Route .* does not exist\.$/.test(body.error.message ?? '')
  );
}

describe('every route the client calls', () => {
  it('finds the call sites it is supposed to be checking', () => {
    const calls = clientCalls();

    expect(calls.length).toBeGreaterThanOrEqual(EXPECTED_AT_LEAST);

    // The three T-043 was filed for, named explicitly. If the scan ever stops
    // seeing these, this test has stopped being the check it claims to be.
    const seen = calls.map((call) => `${call.method} ${call.template}`);
    expect(seen).toContain('GET /me');
    expect(seen).toContain('POST /auth/refresh');
    expect(seen).toContain('POST /auth/logout');
  });

  it('is a route the server actually serves', async () => {
    const missing: string[] = [];

    for (const call of clientCalls()) {
      const name = `${call.method} ${call.template}`;
      if (await isUnrouted(call)) {
        const task = KNOWN_MISSING.get(`${call.method} ${call.template}`);
        if (task === undefined) {
          missing.push(`${name}  (${call.where}) — the client calls this; nothing serves it`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('has no exemption left standing for a route that now works', async () => {
    const fixed: string[] = [];

    for (const call of clientCalls()) {
      const name = `${call.method} ${call.template}`;
      if (KNOWN_MISSING.has(name) && !(await isUnrouted(call))) {
        fixed.push(`${name} — now served; drop it from KNOWN_MISSING`);
      }
    }

    expect(fixed).toEqual([]);
  });
});
