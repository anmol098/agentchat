#!/usr/bin/env node
/**
 * A second `agentchat` binary, built from the same framework, whose commands
 * fail on purpose.
 *
 * ## Why this exists
 *
 * The acceptance criterion that matters most is that a *spawned process* keeps
 * stdout clean and returns the right exit code, in every mode, including when it
 * fails. Proving it for exit 0 and exit 2 needs nothing but the real binary.
 * Proving it for 3 (`AUTH_REQUIRED`) and 4 (`NO_PROJECT`, `NO_AGENT`) needs a
 * command that can produce those, and this build ships none: credentials are
 * T-204, the device flow is T-206, and project and agent resolution is T-205.
 *
 * The choice was between shipping a hidden `--selftest` command to real users,
 * waiting for three other tasks before the exit-code contract is tested at all,
 * or this. This file imports the *built* `dist/index.js`, hands `run()` a
 * registry of its own, and is spawned as a real process with real file
 * descriptors. Every line of framework code between `argv` and the exit code is
 * the same one the real binary runs; only the registry differs. When T-204 and
 * after land, their commands get tested on their own behaviour and this file
 * keeps testing the framework's.
 *
 * It lives under `tests/` and is never published: `package.json` ships `dist`
 * only.
 *
 * ## The commands
 *
 * ```text
 * noisy            log at every level on stderr, then emit one result
 * stream <n>       emit n results, for NDJSON and EPIPE
 * fail <CODE>      throw a CliError carrying that stable code
 * crash            throw a TypeError, i.e. a bug in the CLI
 * transport        throw the client's TransportError
 * format           throw the client's ResponseFormatError
 * wire <CODE>      throw an ApiError whose wire code this build does not know
 * ```
 *
 * @module
 */

import process from 'node:process';

import { ApiError, ResponseFormatError, TransportError } from '@stackgrid/client';
import { isErrorCode } from '@stackgrid/protocol';

import { CliError, run, UsageError, view } from '../../dist/index.js';

/** Logs at every level, then produces a result. Proves the streams stay apart. */
const noisy = {
  kind: 'command',
  name: 'noisy',
  summary: 'log to stderr at every level, then emit one result',
  async run(context) {
    context.log.info('connecting to the server');
    context.log.warn('the server is older than this client');
    context.log.debug('resolved project prj_test');
    context.log.info('connected');
    await context.emit(
      view({ ok: true, note: 'this line is the only thing on stdout' }, (writer) => {
        writer.line('ok');
      }),
    );
    context.log.info('done');
  },
};

/** Emits many results, for NDJSON framing and for the broken-pipe path. */
const stream = {
  kind: 'command',
  name: 'stream',
  summary: 'emit several results in sequence',
  usage: 'stream <count>',
  positionals: { min: 1, max: 1 },
  async run(context) {
    const count = Number.parseInt(context.args.required(0, 'a count', 'stream <count>'), 10);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new UsageError('The count must be a non-negative integer.');
    }
    for (let index = 0; index < count; index += 1) {
      context.log.info(`emitting ${String(index)}`);
      await context.emit(
        view({ event: 'tick', index }, (writer) => {
          writer.line(`tick ${String(index)}`);
        }),
      );
    }
  },
};

/** Throws a `CliError` carrying whichever stable code was asked for. */
const fail = {
  kind: 'command',
  name: 'fail',
  summary: 'throw a CliError with the given stable code',
  usage: 'fail <CODE>',
  positionals: { min: 1, max: 1 },
  options: {
    hint: { type: 'string', placeholder: '<text>', description: 'override the generic next step' },
  },
  run(context) {
    const code = context.args.required(0, 'an error code', 'fail <CODE>');
    if (!isErrorCode(code)) {
      throw new UsageError(`\`${code}\` is not a code this build knows.`);
    }
    const hint = context.args.value('hint');
    throw new CliError(code, `Deliberate ${code} from the test fixture.`, {
      ...(hint === undefined ? {} : { hint }),
    });
  },
};

/** Throws something that is not a `ProtocolError` at all: a bug in the CLI. */
const crash = {
  kind: 'command',
  name: 'crash',
  summary: 'throw a TypeError, as a bug in the CLI would',
  run() {
    // A cause chain, so a `--verbose` run has something to print.
    throw new TypeError('Cannot read properties of undefined (reading "id")', {
      cause: new Error('the response had no body'),
    });
  },
};

/** The server could not be reached. Carries `SERVER_UNREACHABLE` (T-017). */
const transport = {
  kind: 'command',
  name: 'transport',
  summary: 'throw the client TransportError',
  run() {
    throw new TransportError('Could not reach https://chat.example.com: GET /version failed.', {
      cause: new Error('connect ECONNREFUSED 127.0.0.1:443'),
    });
  },
};

/** The server answered something this build cannot parse. `INTERNAL`: it did answer. */
const format = {
  kind: 'command',
  name: 'format',
  summary: 'throw the client ResponseFormatError',
  run() {
    throw new ResponseFormatError('GET /version: `protocolVersion` was missing.');
  },
};

/** A server failure whose code is newer than this build. Proves `wireCode` survives. */
const wire = {
  kind: 'command',
  name: 'wire',
  summary: 'throw an ApiError carrying a code this build does not know',
  usage: 'wire <CODE>',
  positionals: { min: 1, max: 1 },
  run(context) {
    const code = context.args.required(0, 'a wire code', 'wire <CODE>');
    throw new ApiError(503, code, 'The server reported something newer than this client.');
  },
};

/** A group, so the group-resolution paths are reachable from a spawned process. */
const group = {
  kind: 'group',
  name: 'group',
  summary: 'a nested namespace',
  children: [noisy, fail],
};

process.exitCode = await run({
  argv: process.argv.slice(2),
  env: {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
  },
  commands: [noisy, stream, fail, crash, transport, format, wire, group],
});
