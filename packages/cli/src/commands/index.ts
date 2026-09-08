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
 * Plan §6.2 lists roughly a dozen commands. Five of them are here, because every
 * other one needs something a later task owns: the project and agent commands
 * need the routes that back them (T-207, T-208), and `listen` needs the
 * WebSocket transport (T-310).
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
import { loginCommand, logoutCommand, whoamiCommand } from './auth.js';
import { statusCommand } from './status.js';
import { versionCommand } from './version.js';

/** Every command this build ships, in the order help lists them. */
export const COMMANDS: readonly CommandNode[] = Object.freeze([
  loginCommand,
  logoutCommand,
  whoamiCommand,
  statusCommand,
  versionCommand,
]);
