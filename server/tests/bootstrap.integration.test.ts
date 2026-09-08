import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The entry point, exercised as a process rather than as a module.
 *
 * Startup validation, structured logging on stdout and graceful shutdown on
 * SIGTERM are properties of a *process*: a signal handler that is never
 * installed, or a pool that is never drained, is invisible to a test that
 * imports a function and calls it. So this spawns the real server the way a
 * container would, and talks to it over a socket and a signal.
 */

/** Directory of the `server` workspace, whatever the runner's cwd happens to be. */
const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

/** The entry module, run through tsx so no build step is needed first. */
const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));

/** How long a test waits for an expected log record before giving up. */
const RECORD_TIMEOUT_MS = 20_000;

/** One structured log record. */
type Record_ = Record<string, unknown>;

/** A spawned server and the accumulated output of its two streams. */
interface Spawned {
  readonly child: ChildProcess;
  /** Every JSON record seen on stdout so far, one per line. */
  stdout(): string;
  /** Everything seen on stderr so far, verbatim. */
  stderr(): string;
  /** Resolves with the first stdout record matching `predicate`. */
  waitForRecord(predicate: (record: Record_) => boolean): Promise<Record_>;
  /** Resolves with the exit code once the process terminates. */
  exit(): Promise<number | null>;
}

let running: Spawned | undefined;

/**
 * The authentication variables every spawned process needs since T-019.
 *
 * `loadConfig` requires them, and it is loaded before anything else so that a
 * process fails for the same reasons as the server it is part of. Fixed values
 * rather than the developer's own, so a run does not depend on what happens to
 * be exported.
 */
const AUTH_ENV = {
  JWT_SECRET: 'j'.repeat(32),
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
} as const;

/** Starts `src/index.ts` in its own process with exactly the given environment. */
function startServer(overrides: Record<string, string | undefined>): Spawned {
  const env: NodeJS.ProcessEnv = { ...process.env, ...AUTH_ENV, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
  }

  const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
    cwd: SERVER_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const { stdout, stderr } = child;
  if (stdout === null || stderr === null) {
    throw new Error('The spawned server has no piped stdout/stderr.');
  }

  const records: Record_[] = [];
  const waiters: { matches: (record: Record_) => boolean; resolve: (record: Record_) => void }[] =
    [];
  let pending = '';
  let errorOutput = '';

  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => {
    pending += chunk;

    // Keep any partial trailing line for the next chunk.
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';

    for (const line of lines) {
      if (line.trim() === '') continue;

      let record: Record_;
      try {
        record = JSON.parse(line) as Record_;
      } catch {
        // A non-JSON line on stdout breaks the logging contract on its own;
        // keep it so a failing assertion can show it.
        record = { raw: line };
      }
      records.push(record);

      const unmatched = waiters.filter((waiter) => !waiter.matches(record));
      const matched = waiters.filter((waiter) => waiter.matches(record));
      waiters.length = 0;
      waiters.push(...unmatched);
      for (const waiter of matched) {
        waiter.resolve(record);
      }
    }
  });

  stderr.setEncoding('utf8');
  stderr.on('data', (chunk: string) => {
    errorOutput += chunk;
  });

  const exited = new Promise<number | null>((resolve) => {
    child.once('close', (code) => {
      resolve(code);
    });
  });

  const transcript = (): string => records.map((record) => JSON.stringify(record)).join('\n');

  return {
    child,
    stdout: transcript,
    stderr: () => errorOutput,

    waitForRecord(matches) {
      const seen = records.find(matches);
      if (seen !== undefined) return Promise.resolve(seen);

      return new Promise<Record_>((resolve, reject) => {
        waiters.push({ matches, resolve });
        const timer = setTimeout(() => {
          reject(
            new Error(
              `The server logged no matching record within ${RECORD_TIMEOUT_MS}ms.\n` +
                `stdout:\n${transcript()}\nstderr:\n${errorOutput}`,
            ),
          );
        }, RECORD_TIMEOUT_MS);
        timer.unref();
      });
    },

    exit: () => exited,
  };
}

/** Reads the port out of a `server listening` record. */
function portOf(record: Record_): number {
  const address = record['address'];
  if (typeof address !== 'object' || address === null || !('port' in address)) {
    throw new Error(`The listening record carried no address: ${JSON.stringify(record)}`);
  }

  const { port } = address as { port: unknown };
  if (typeof port !== 'number') {
    throw new Error(`The listening record carried a non-numeric port: ${JSON.stringify(record)}`);
  }

  return port;
}

afterEach(async () => {
  const spawned = running;
  running = undefined;
  if (spawned === undefined) return;

  if (spawned.child.exitCode === null && spawned.child.signalCode === null) {
    spawned.child.kill('SIGKILL');
  }
  await spawned.exit();
});

describe('server process', () => {
  it('starts, serves a healthy /healthz, and shuts down cleanly on SIGTERM', async () => {
    const server = startServer({ HOST: '127.0.0.1', PORT: '0', LOG_LEVEL: 'info' });
    running = server;

    const listening = await server.waitForRecord((record) => record['msg'] === 'server listening');
    const port = portOf(listening);

    // Every record on stdout is a JSON object with a level and a timestamp,
    // which is the whole point: a log reader can query it.
    expect(typeof listening['level']).toBe('number');
    expect(typeof listening['time']).toBe('string');
    expect(listening['name']).toBe('agentchat-server');

    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { 'x-request-id': 'bootstrap-check' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });

    // The request identifier reaches the log, which is what makes a response a
    // caller complains about traceable to the lines it produced.
    const completed = await server.waitForRecord(
      (record) => record['reqId'] === 'bootstrap-check' && record['msg'] === 'request completed',
    );
    expect(completed['res']).toMatchObject({ statusCode: 200 });

    server.child.kill('SIGTERM');

    const shutdown = await server.waitForRecord((record) => record['msg'] === 'shutdown complete');
    expect(shutdown['signal']).toBe('SIGTERM');

    // Exit 0: both the HTTP server and the pool closed, and the process was not
    // put down by this file's own fallback kill.
    await expect(server.exit()).resolves.toBe(0);
  });

  it('refuses to start without DATABASE_URL and says so on stderr', async () => {
    const server = startServer({ DATABASE_URL: undefined, HOST: '127.0.0.1', PORT: '0' });
    running = server;

    await expect(server.exit()).resolves.toBe(1);

    const stderr = server.stderr();
    expect(stderr).toContain('DATABASE_URL');
    expect(stderr).toContain('postgres://');
    // Prose on stderr, not a JSON record on stdout: the log level itself comes
    // from the configuration that just failed to load.
    expect(server.stdout()).not.toContain('DATABASE_URL');
  });

  it('refuses to start without JWT_SECRET, and prints no secret while refusing', async () => {
    // The signing key for every access token this server would issue. HMAC
    // accepts a key of any length and gives a weak one weak security in
    // silence, so a missing or short one has to stop the process here or never.
    const clientSecret = 'ghs_thisisthegithubclientsecretdonotprint';
    const server = startServer({
      JWT_SECRET: undefined,
      GITHUB_CLIENT_SECRET: clientSecret,
      HOST: '127.0.0.1',
      PORT: '0',
    });
    running = server;

    await expect(server.exit()).resolves.toBe(1);

    const stderr = server.stderr();
    expect(stderr).toContain('JWT_SECRET');
    // Actionable: how long it has to be, and how to produce one.
    expect(stderr).toContain('openssl rand -hex 32');
    // And the whole point of naming variables rather than quoting values: this
    // text is what an operator pastes into an issue.
    expect(stderr).not.toContain(clientSecret);
    expect(server.stdout()).not.toContain(clientSecret);
  });

  it('refuses to start without the identity provider credentials', async () => {
    // `createGitHubIdentityProvider` throws on a blank client id, which would
    // otherwise surface as a 500 on the first login of the day rather than as a
    // refusal to start.
    const server = startServer({
      GITHUB_CLIENT_ID: undefined,
      GITHUB_CLIENT_SECRET: undefined,
      HOST: '127.0.0.1',
      PORT: '0',
    });
    running = server;

    await expect(server.exit()).resolves.toBe(1);

    const stderr = server.stderr();
    expect(stderr).toContain('GITHUB_CLIENT_ID');
    expect(stderr).toContain('GITHUB_CLIENT_SECRET');
  });

  it('starts and reports 503 when the database is configured but absent', async () => {
    // Exiting because the database is briefly down leaves an operator with no
    // endpoint to ask what is wrong. Starting and answering 503 tells them, and
    // the server recovers on its own when Postgres comes back.
    const server = startServer({
      DATABASE_URL: 'postgres://agentchat:agentchat@127.0.0.1:1/agentchat',
      HOST: '127.0.0.1',
      PORT: '0',
      DATABASE_CONNECTION_TIMEOUT_MS: '1000',
    });
    running = server;

    const listening = await server.waitForRecord((record) => record['msg'] === 'server listening');
    const response = await fetch(`http://127.0.0.1:${portOf(listening)}/healthz`);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'DATABASE_UNAVAILABLE' } });

    server.child.kill('SIGTERM');
    await expect(server.exit()).resolves.toBe(0);
  });
});
