/**
 * The command registry.
 *
 * One list. A command lands by being added here and nowhere else — the parser
 * reads its options from the entry, help reads its summary from the entry, and
 * dispatch finds it by name in the entry. There is no second place to register
 * anything and no code generation step.
 *
 * ## What is not here yet
 *
 * Plan §6.2 lists roughly a dozen commands. `listen` is the one still missing:
 * it needs the WebSocket wiring on the server before it can be run against
 * anything (T-033, T-312). The polling commands it has a twin relationship with
 * — `inbox`, `conversation`, `ack` — are here, and they are what an agent that
 * cannot hold a process open uses instead.
 *
 * Shipping placeholders for them would be worse than shipping none. A command
 * that exists and fails is indistinguishable, to a harness probing what this
 * build supports, from one that exists and is broken — and `agentchat --help
 * --json` is exactly that probe. An absent command is honest.
 *
 * ## Adding one
 *
 * ```ts
 * export const COMMANDS: readonly CommandNode[] = Object.freeze([
 *   loginCommand,
 *   { kind: 'group', name: 'project', summary: '…', children: [projectListCommand] },
 *   versionCommand,
 * ]);
 * ```
 *
 * Order is help order. Keep `status` first and `version` last: `status` is what
 * someone reading this list is most often looking for — it is the command you
 * run when you do not know which command you need — and `version` is the least
 * interesting entry.
 *
 * @module
 */

import type { CommandNode } from '../command.js';
import { ackCommand } from './ack.js';
import { agentCommand } from './agent.js';
import { agentsCommand } from './agents.js';
import { loginCommand, logoutCommand, whoamiCommand } from './auth.js';
import { conversationCommand } from './conversation.js';
import { inboxCommand } from './inbox.js';
import { projectCommand } from './project.js';
import { sendCommand } from './send.js';
import { statusCommand } from './status.js';
import { versionCommand } from './version.js';

/** Every command this build ships, in the order help lists them. */
export const COMMANDS: readonly CommandNode[] = Object.freeze([
  loginCommand,
  logoutCommand,
  whoamiCommand,
  projectCommand,
  agentCommand,
  // Immediately after the `agent` group, never apart from it: seen side by side
  // the singular and the plural explain each other, and seen apart either one
  // looks like the only agent command there is. See `./agents.ts`.
  agentsCommand,
  // Directly after `agents`, which is the command that produces the address
  // this one takes: discovery answers "who can I talk to", and this is the
  // talking. The pair is the whole product read in order.
  sendCommand,
  // The reading half, in the order somebody uses it: `inbox` says what is
  // waiting, `conversation` opens the thread one of them belongs to, and `ack`
  // clears what has been handled. All three are what an agent that polls uses
  // instead of `listen`, which is why they sit together and directly after the
  // command that produces the messages they read.
  inboxCommand,
  conversationCommand,
  ackCommand,
  statusCommand,
  versionCommand,
]);
