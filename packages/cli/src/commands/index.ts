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
 * Plan §6.2 lists roughly a dozen commands. Exactly one of them is here, because
 * every other one needs something a later task owns: `login` needs the device
 * flow (T-206), everything authenticated needs the credential file (T-204),
 * everything project-scoped needs context resolution (T-205), and `listen` needs
 * the WebSocket (T-310).
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
 * Order is help order. Keep `version` last; it is the least interesting entry
 * and the list is read top-down by someone looking for something else.
 *
 * @module
 */

import type { CommandNode } from '../command.js';
import { versionCommand } from './version.js';

/** Every command this build ships, in the order help lists them. */
export const COMMANDS: readonly CommandNode[] = Object.freeze([versionCommand]);
