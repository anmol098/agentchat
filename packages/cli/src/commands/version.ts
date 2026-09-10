/**
 * `agentchat version` — what this build is, and optionally what the server is.
 *
 * The first command, and deliberately the smallest one that is still real. It
 * exercises every seam the framework has: a view with two representations, the
 * global `--server` option and its environment variable, a real call through
 * `@stackgrid/client`, and the two failure paths that call can take — a server
 * that cannot be reached and a server that answers with an error envelope.
 *
 * ## Why it may talk to a server
 *
 * `GET /version` is the one unauthenticated endpoint (plan §12.4): a client has
 * to be able to discover it is too old before it has credentials to be rejected
 * with, and a self-hoster has to be able to check a deployment without an
 * account. `agentchat version --server https://chat.example.com` is that check,
 * and it is the command to ask someone to run when nothing else works.
 *
 * The server is contacted only when a URL was given — by `--server` or by
 * `AGENTCHAT_SERVER`, both of which are explicit acts. Plain `agentchat version`
 * makes no network call, so it stays instantaneous and works offline, which is
 * what a script embedding it in a diagnostic expects.
 *
 * @module
 */

import { AgentChatClient, InMemoryCredentialStore } from '@stackgrid/client';
import type { GetVersionResponse } from '@stackgrid/protocol';
import { PROTOCOL_VERSION } from '@stackgrid/protocol';

import type { Command, CommandContext } from '../command.js';
import type { JsonValue, View } from '../output/output.js';
import { view } from '../output/output.js';
import { CLI_VERSION, PROGRAM } from '../version.js';

/**
 * The version report, in both representations.
 *
 * The same shape whether or not a server was consulted: `server` is absent
 * rather than null when none was, so a consumer tests for the key it needs
 * instead of distinguishing two kinds of nothing.
 *
 * @param server - What `GET /version` answered, if it was asked.
 * @returns The view.
 */
export function versionView(server?: GetVersionResponse): View {
  const json: JsonValue = {
    version: CLI_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    ...(server === undefined
      ? {}
      : {
          server: {
            version: server.version,
            protocolVersion: server.protocolVersion,
            minClientVersion: server.minClientVersion,
          },
        }),
  };

  return view(json, (writer) => {
    writer.line(`${writer.style.bold(PROGRAM)} ${CLI_VERSION}`);
    writer.fields([
      ['protocol', String(PROTOCOL_VERSION)],
      ['server', server === undefined ? null : server.version],
      ['server protocol', server === undefined ? null : String(server.protocolVersion)],
      ['minimum client', server === undefined ? null : server.minClientVersion],
    ]);
  });
}

/** `agentchat version`. */
export const versionCommand: Command = {
  kind: 'command',
  name: 'version',
  summary: `print the ${PROGRAM} version, and the server's when one is given`,
  usage: 'version [--server <url>]',
  details: [
    'With no --server and no AGENTCHAT_SERVER, this makes no network call.',
    'With one, it also reports the server version, the protocol it speaks, and the oldest client it will serve.',
  ],

  /** @inheritdoc */
  async run(context: CommandContext): Promise<void> {
    const baseUrl = context.args.value('server');
    if (baseUrl === undefined) {
      await context.emit(versionView());
      return;
    }

    context.log.info(`Asking ${baseUrl} for its version…`);
    const client = new AgentChatClient({
      baseUrl,
      credentials: new InMemoryCredentialStore(),
      // Always passed. Omitting it sends no version header at all, which is the
      // right default for an embedder but wrong for the CLI: the header is what
      // puts this process inside the negotiation in plan §12.4.
      clientVersion: CLI_VERSION,
    });

    const server = await client.version.get({ signal: context.signal });
    await context.emit(versionView(server));
  },
};
