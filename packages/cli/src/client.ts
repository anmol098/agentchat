/**
 * Building the API client a command talks to.
 *
 * Six lines that resolve the server, open the credential store, and construct
 * an {@link AgentChatClient} — and they had been written out privately in four
 * command files before this module existed. T-402 counted the copies and filed
 * T-036 to collapse them; T-036 is still to be done, because collapsing them
 * means editing four files at once and there was always a command task in
 * flight. This module is the home those copies move into, created by the fifth
 * caller rather than becoming the fifth copy.
 *
 * It is worth insisting on, because the drift T-036 predicted had already
 * happened once. Every copy now calls `requireServer` from `./config.ts`, which
 * is T-026's single resolution of the flag-then-variable-then-config walk, but
 * until T-030 `commands/agent.ts` called a private `requireServerUrl` of its
 * own, which resolved the same thing with a different error message and no
 * built-in default. That is exactly the failure mode: four constructions of one
 * client, each of which can quietly disagree about the version header, the
 * credential store, or the warning sink, and nothing fails when they do.
 *
 * ## What the construction is actually saying
 *
 * **The version header is always sent.** A CLI that omitted it would look like
 * an unidentified embedder to the compatibility negotiation of plan §12.4, and
 * would never be told to upgrade.
 *
 * **The credential store's warning sink is wired.** `createCredentialStore`
 * warns about a credentials file with permissions that let other users read it.
 * A construction that passed no sink would discard that warning silently, which
 * is precisely the kind of difference four copies get inconsistently right.
 *
 * **The seams are seams, not configuration.** {@link ClientSeams} exists so a
 * test can drive a whole command — parsing, resolution, both streams, the exit
 * code — against a stubbed transport and an in-memory store, without a socket
 * or a home directory. Production passes nothing.
 *
 * @module
 */

import type { CredentialStore, Transport } from '@agentchat/client';
import { AgentChatClient, HttpTransport } from '@agentchat/client';

import type { CommandContext } from './command.js';
import { requireServer, serverRequestFor } from './config.js';
import { createCredentialStore, credentialsPath } from './credentials.js';
import { CLI_VERSION } from './version.js';

/**
 * The two things a test replaces to run a command without a network or a home
 * directory.
 *
 * Commands extend this with their own seams rather than redeclaring these two,
 * so a later addition here reaches every command at once.
 */
export interface ClientSeams {
  /** Where credentials live. Defaults to the file store at the documented path. */
  readonly store?: CredentialStore;

  /** How requests are made. Defaults to HTTP against the resolved server. */
  readonly transport?: Transport;
}

/**
 * A client pointed at the configured server, authenticating from the
 * credential store.
 *
 * @param context - The command context. Supplies the environment the server and
 *   the credentials path are resolved from, and the sink a permissions warning
 *   is written to.
 * @param seams - Test seams; empty in production.
 * @returns The client.
 * @throws {UsageError} When no server is configured. The message is the one a
 *   fresh installation sees, and it comes from `./config.ts` so that every
 *   command says the same thing.
 */
export async function clientFor(
  context: CommandContext,
  seams: ClientSeams = {},
): Promise<AgentChatClient> {
  const server = await requireServer(serverRequestFor(context));
  const store =
    seams.store ??
    createCredentialStore({
      path: credentialsPath(context.env.env),
      warn: (message: string): void => {
        context.log.warn(message);
      },
    });

  return new AgentChatClient({
    credentials: store,
    // Always sent; see the module note.
    clientVersion: CLI_VERSION,
    transport: seams.transport ?? new HttpTransport({ baseUrl: server.url }),
  });
}
