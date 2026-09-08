/**
 * The `agentchat` binary, spawned.
 *
 * These are the acceptance tests for T-203, and they are deliberately not unit
 * tests of a formatter. Each one starts a real process, reads file descriptor 1
 * and file descriptor 2 **separately**, and asserts on what each one actually
 * received and on the code the process exited with. A formatter test cannot
 * catch a `console.log` left in a command, a library that writes a deprecation
 * warning to stdout, or a build that emits a banner — and every one of those
 * silently corrupts the input of the AI harness this program exists to feed
 * (PRD §39).
 *
 * The stanza that matters most is repeated on purpose: **stdout is empty, or
 * stdout is JSON**. Never both, never neither, and never something in between,
 * on success or on failure.
 *
 * @module
 */

import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PROTOCOL_VERSION } from '@agentchat/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANSI, buildPackage, parseNdjson, runCli } from './spawn.js';

/** The version this package claims to be, read the way a user would see it. */
const VERSION = '0.1.0';

/**
 * The protocol version, imported rather than written down.
 *
 * Hardcoding it here made this suite fail the moment another change bumped the
 * constant, in a package this one only consumes. The number is not what these
 * tests are about.
 */
const PROTOCOL = PROTOCOL_VERSION;

beforeAll(async () => {
  await buildPackage();
}, 180_000);

describe('the built binary', () => {
  it('runs from dist and reports its version', async () => {
    const run = await runCli(['version']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`agentchat ${VERSION}`);
    expect(run.stderr).toBe('');
  });

  it('answers --version before any command is resolved', async () => {
    const run = await runCli(['--version']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(VERSION);
    expect(run.stderr).toBe('');
  });
});

describe('--json puts nothing but JSON on stdout', () => {
  it('on success', async () => {
    const run = await runCli(['version', '--json']);

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(parseNdjson(run.stdout)).toEqual([{ version: VERSION, protocolVersion: PROTOCOL }]);
  });

  it('on an unknown command', async () => {
    const run = await runCli(['--json', 'nonsense']);

    expect(run.code).toBe(2);
    // The whole point: a consumer branches on failure exactly as it does on
    // success, by parsing one line of stdout.
    expect(parseNdjson(run.stdout)).toEqual([
      {
        error: {
          code: 'BAD_REQUEST',
          message: expect.stringContaining('nonsense') as unknown as string,
          hint: expect.stringContaining('--help') as unknown as string,
        },
      },
    ]);
    // Not duplicated onto stderr: a harness merging the descriptors would
    // otherwise see every failure twice.
    expect(run.stderr).toBe('');
  });

  it('on an unknown flag, which fails during the parse itself', async () => {
    const run = await runCli(['--json', 'version', '--not-a-flag']);

    expect(run.code).toBe(2);
    const [envelope] = parseNdjson(run.stdout);
    expect(envelope).toMatchObject({ error: { code: 'BAD_REQUEST' } });
    expect(run.stderr).toBe('');
  });

  it('on no command at all', async () => {
    const run = await runCli(['--json']);

    expect(run.code).toBe(2);
    expect(parseNdjson(run.stdout)).toHaveLength(1);
    expect(run.stderr).toBe('');
  });

  it('for --help, which is a result like any other', async () => {
    const run = await runCli(['--help', '--json']);

    expect(run.code).toBe(0);
    const [help] = parseNdjson(run.stdout);
    expect(help).toMatchObject({ program: 'agentchat' });
    expect(run.stderr).toBe('');
  });
});

describe('human mode keeps stdout for results only', () => {
  it('writes the error to stderr and leaves stdout completely empty', async () => {
    const run = await runCli(['nonsense']);

    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('error: Unknown command `nonsense`');
    expect(run.stderr).toContain('code: BAD_REQUEST');
    expect(run.stderr).toContain('next: Run `agentchat --help`');
  });

  it('never prints a stack trace', async () => {
    const run = await runCli(['nonsense']);

    expect(run.stderr).not.toContain('    at ');
    expect(run.stderr).not.toContain('.js:');
  });

  it('sends --help to stdout, because the user asked for it', async () => {
    const run = await runCli(['--help']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Usage: agentchat <command>');
    expect(run.stderr).toBe('');
  });
});

describe('exit codes', () => {
  it('is 0 for a command that worked', async () => {
    expect((await runCli(['version'])).code).toBe(0);
  });

  it('is 2 for an unknown command', async () => {
    expect((await runCli(['nope'])).code).toBe(2);
  });

  it('is 2 for an unknown flag', async () => {
    expect((await runCli(['version', '--nope'])).code).toBe(2);
  });

  it('is 2 for a bare invocation with no command', async () => {
    expect((await runCli([])).code).toBe(2);
  });

  it('is 2 for an argument the command does not take', async () => {
    const run = await runCli(['version', 'extra']);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('Unexpected argument `extra`');
  });

  it('is 2 for a server URL that is not a URL', async () => {
    const run = await runCli(['version', '--server', 'not-a-url']);

    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
  });
});

describe('colour', () => {
  it('is absent when stdout is a pipe', async () => {
    const run = await runCli(['version']);

    expect(run.stdout).not.toMatch(ANSI);
  });

  it('appears on a pipe when FORCE_COLOR asks for it', async () => {
    const run = await runCli(['version'], { env: { FORCE_COLOR: '1' } });

    expect(run.stdout).toMatch(ANSI);
  });

  it('stays off under NO_COLOR even when FORCE_COLOR is set', async () => {
    const run = await runCli(['version'], { env: { FORCE_COLOR: '1', NO_COLOR: '1' } });

    expect(run.stdout).not.toMatch(ANSI);
  });

  it('stays off under --no-color', async () => {
    const run = await runCli(['version', '--no-color'], { env: { FORCE_COLOR: '1' } });

    expect(run.stdout).not.toMatch(ANSI);
  });

  it('never reaches JSON output, whatever the environment says', async () => {
    const run = await runCli(['version', '--json', '--color'], { env: { FORCE_COLOR: '1' } });

    expect(run.stdout).not.toMatch(ANSI);
    expect(parseNdjson(run.stdout)).toHaveLength(1);
  });

  it('decorates a human-mode failure on stderr without touching stdout', async () => {
    const run = await runCli(['nonsense'], { env: { FORCE_COLOR: '1' } });

    expect(run.stderr).toMatch(ANSI);
    expect(run.stdout).toBe('');
  });
});

describe('against a server', () => {
  /** Replies for the stub server to give, in the order the tests set them. */
  let respond: (url: string) => { status: number; body: unknown } = () => ({
    status: 200,
    body: {},
  });
  let server: Server;
  let baseUrl = '';

  beforeAll(async () => {
    server = createServer((request, response) => {
      const { status, body } = respond(request.url ?? '');
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
  });

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

  it('reports the server version, with the progress line on stderr', async () => {
    respond = () => ({
      status: 200,
      body: { version: '9.9.9', protocolVersion: PROTOCOL, minClientVersion: '0.1.0' },
    });

    const run = await runCli(['version', '--json', '--server', baseUrl]);

    expect(run.code).toBe(0);
    expect(parseNdjson(run.stdout)).toEqual([
      {
        version: VERSION,
        protocolVersion: PROTOCOL,
        server: { version: '9.9.9', protocolVersion: PROTOCOL, minClientVersion: '0.1.0' },
      },
    ]);
    // The command said what it was doing. It said it on stderr.
    expect(run.stderr).toContain('[agentchat]');
    expect(run.stderr).toContain('Asking');
  });

  it('reads the server URL from AGENTCHAT_SERVER', async () => {
    respond = () => ({
      status: 200,
      body: { version: '9.9.9', protocolVersion: PROTOCOL, minClientVersion: '0.1.0' },
    });

    const run = await runCli(['version', '--json'], { env: { AGENTCHAT_SERVER: baseUrl } });

    expect(run.code).toBe(0);
    expect(parseNdjson(run.stdout)).toHaveLength(1);
  });

  it('exits 3 and keeps stdout clean when the server demands authentication', async () => {
    respond = () => ({
      status: 401,
      body: { error: { code: 'AUTH_REQUIRED', message: 'Your session has expired.' } },
    });

    const run = await runCli(['version', '--server', baseUrl]);

    expect(run.code).toBe(3);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('next: Run `agentchat login`.');
  });

  it('exits 3 in JSON mode with the envelope on stdout and the log still on stderr', async () => {
    respond = () => ({
      status: 401,
      body: { error: { code: 'AUTH_REQUIRED', message: 'Your session has expired.' } },
    });

    const run = await runCli(['version', '--json', '--server', baseUrl]);

    expect(run.code).toBe(3);
    expect(parseNdjson(run.stdout)).toEqual([
      {
        error: {
          code: 'AUTH_REQUIRED',
          message: 'Your session has expired.',
          hint: 'Run `agentchat login`.',
        },
      },
    ]);
    // The progress line is still there. It is on the other descriptor, which is
    // the entire contract: the harness parses stdout and ignores this.
    expect(run.stderr).toContain('[agentchat]');
  });

  it('exits 1 for a server fault', async () => {
    respond = () => ({
      status: 500,
      body: { error: { code: 'INTERNAL', message: 'Something went wrong.' } },
    });

    const run = await runCli(['version', '--json', '--server', baseUrl]);

    expect(run.code).toBe(1);
    expect(parseNdjson(run.stdout)).toMatchObject([{ error: { code: 'INTERNAL' } }]);
  });

  it('reports a code newer than this build exactly as the server sent it', async () => {
    respond = () => ({
      status: 503,
      body: { error: { code: 'RATE_LIMITED', message: 'Slow down.' } },
    });

    const run = await runCli(['version', '--json', '--server', baseUrl]);

    // Exit 1, because `RATE_LIMITED` is not a code this build can reason about
    // and 503 has no more specific mapping — but the string survives intact for
    // a consumer that does know it.
    expect(run.code).toBe(1);
    expect(parseNdjson(run.stdout)).toMatchObject([{ error: { code: 'RATE_LIMITED' } }]);
  });

  it('exits 1 with an actionable hint when the server cannot be reached', async () => {
    // Port 1 on the loopback interface: nothing is listening and nothing will be.
    const run = await runCli(['version', '--json', '--server', 'http://127.0.0.1:1']);

    expect(run.code).toBe(1);
    const [envelope] = parseNdjson(run.stdout) as [{ error: { hint: string } }];
    expect(envelope.error.hint).toContain('network connection');
    expect(run.stderr).not.toContain('    at ');
  });
});
