#!/usr/bin/env node
/**
 * The `agentchat` executable.
 *
 * Everything process-shaped lives here and nowhere else: the shebang, `argv`,
 * the two descriptors, the signal handlers, and the exit code. Below this file
 * the CLI is a function of its arguments, which is what lets the whole framework
 * be driven from a test without a subprocess — and, more usefully, what lets the
 * acceptance tests drive it *with* one and know they are exercising the same
 * code.
 *
 * ## Three process-level details that are easy to get wrong
 *
 * **`process.exitCode`, never `process.exit()`.** On a pipe, `process.stdout` is
 * asynchronous. `process.exit()` terminates immediately and discards whatever is
 * still buffered, so a command whose entire output is one line of JSON hands its
 * consumer an empty stream and a zero exit — a corruption that looks exactly
 * like success. Assigning `exitCode` lets Node drain first.
 *
 * **`EPIPE` is not a crash.** `agentchat listen --json | head -1` closes the read
 * end while this process is still writing. Node reports that as an `error` event
 * on `process.stdout`, and an unhandled one of those terminates the process with
 * a stack trace about a pipe the user closed deliberately. The handlers below
 * swallow exactly that error and nothing else.
 *
 * **Signals abort work, they do not kill the process.** `SIGINT` aborts the
 * `AbortSignal` every command is given, so an in-flight HTTP request ends now
 * rather than in thirty seconds, and `agentchat listen` gets its chance to close
 * the socket and delete its session (plan §6.3 step 5) before the process ends
 * of its own accord.
 *
 * @module
 */

import process from 'node:process';

import { run } from './main.js';
import { isBrokenPipe } from './output/streams.js';

/**
 * Stops an `EPIPE` on a standard descriptor from terminating the process.
 *
 * @param stream - `process.stdout` or `process.stderr`.
 */
function ignoreBrokenPipe(stream: NodeJS.WriteStream): void {
  stream.on('error', (error: unknown) => {
    if (!isBrokenPipe(error)) {
      throw error;
    }
  });
}

ignoreBrokenPipe(process.stdout);
ignoreBrokenPipe(process.stderr);

const interrupt = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    interrupt.abort(new Error(`Interrupted by ${signal}.`));
  });
}

process.exitCode = await run({
  argv: process.argv.slice(2),
  env: {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
  },
  signal: interrupt.signal,
});
