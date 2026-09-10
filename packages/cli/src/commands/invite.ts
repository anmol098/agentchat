/**
 * `agentchat project revoke-invite <inv_…>` — withdrawing an invite code
 * (protocol §6, T-014).
 *
 * ## Why this is a sibling of `project invite` and not a subcommand of it
 *
 * `agentchat project invite` ships, and `docs/cli.md` documents it. Promoting
 * it to a group so that revocation could live at `project invite revoke` would
 * break that invocation, which is a change to the CLI's public surface and
 * belongs in the implementation plan rather than in a subagent's judgement. So
 * revocation lands beside it as a second leaf of the `project` group, and the
 * group is the right home either way: both routes are `/projects/:id/invites…`
 * and need a project, which a standalone top-level group would have had to
 * carry on every subcommand as `--project`.
 *
 * It lives in its own module rather than in `./project.ts` because that file is
 * already seven subcommands long, and because the argument this one takes has a
 * rule of its own worth stating in one place.
 *
 * ## It takes the identifier, and it will not take the code
 *
 * The argument is an `inv_` identifier, positionally, and there is no `--code`
 * convenience flag. Two reasons, and the second is the load-bearing one:
 *
 * - **A code is a live bearer credential.** Anyone holding it can join the
 *   project. Naming it on a command line writes it into shell history, into
 *   `ps` output for the life of the process, and — were the command to send it
 *   — into every proxy log between here and the server. Putting a credential in
 *   all three places *in order to destroy it* is the wrong trade, which is why
 *   `DELETE /projects/:id/invites/:inviteId` is addressed by row and not by
 *   code in the first place.
 * - **There is no lookup to build it on.** No endpoint turns a code into an
 *   identifier, deliberately: such an endpoint would answer, to anyone holding
 *   a string, whether that string is a live invite. Adding one is a disclosure
 *   decision for the protocol, not something a flag may assume.
 *
 * The identifier itself is not a credential. It names a row, cannot be
 * redeemed, and this route asserts membership of the project before looking it
 * up. It reaches a user from exactly one place — the response to
 * `project invite`, which is why that command now prints it.
 *
 * ## Who may revoke
 *
 * Any member of the project, and any invite of it — the same rule as creating
 * one. T-014 settled it: an invite is not its creator's property but a hole in
 * the perimeter every member lives behind, and revocation is the fail-safe
 * direction. Nothing is enforced here; the server decides, and this module only
 * has to avoid implying a narrower rule in its help text.
 *
 * @module
 */

import type { InviteId, ProjectId } from '@stackgrid/protocol';
import { InviteId as InviteIdKind } from '@stackgrid/protocol';

import type { OptionSpecs } from '../args.js';
import { clientFor } from '../client.js';
import type { Command, CommandContext } from '../command.js';
import type { ResolvedProject } from '../context.js';
import { CONTEXT_OPTIONS, contextRequestFor, projectIdFor, resolveProject } from '../context.js';
import { UsageError } from '../errors.js';
import type { View } from '../output/output.js';
import { view } from '../output/output.js';
import { PROGRAM } from '../version.js';
import type { ProjectOverrides } from './project.js';

/** The usage line, in the two places that have to agree on it. */
const USAGE = 'project revoke-invite <inv_…> [--project <slug|id>]';

/**
 * `--project`, derived from {@link CONTEXT_OPTIONS} rather than restated.
 *
 * The same derivation `./project.ts` makes for its own subcommands, and made
 * from the same source, so the flag's description and the environment variable
 * it names cannot drift between the command that mints an invite and the one
 * that withdraws it. `--agent` is absent: nothing here acts as an agent.
 */
const PROJECT_OPTIONS: OptionSpecs = Object.freeze(
  Object.fromEntries(Object.entries(CONTEXT_OPTIONS).filter(([name]) => name === 'project')),
);

/**
 * Validates the invite identifier before it is spliced into a URL.
 *
 * Rejected here as well as at the server, and that is not redundant: this
 * failure is a {@link UsageError} naming the argument, exit 2, with no request
 * made — the right answer to an identifier that was truncated on its way
 * through a chat client, or to a code passed where an identifier belongs.
 *
 * That last case gets its own hint. Somebody who has the code and not the
 * identifier is not one flag away from success; nothing turns one into the
 * other, and the honest answer is to mint a fresh invite and keep what it
 * prints.
 *
 * @param value - What the user typed.
 * @returns The identifier, branded.
 * @throws {UsageError} Exit 2, before the round trip.
 */
export function requireInviteId(value: string): InviteId {
  const trimmed = value.trim();
  const parsed = InviteIdKind.schema.safeParse(trimmed);
  if (parsed.success) {
    return parsed.data;
  }
  throw new UsageError(
    `\`${value}\` is not an invite identifier (\`${InviteIdKind.prefix}<uuidv7>\`).`,
    {
      hint: `The identifier is what \`${PROGRAM} project invite\` printed beside the code, and it is shown there and nowhere else. An invite code is not accepted here: revoking by code would put a live credential into your shell history and the server's logs. If you no longer have the identifier, mint a fresh invite and let the old code expire.`,
    },
  );
}

/**
 * `project revoke-invite`, in both representations.
 *
 * Shaped like {@link projectJoinedView}'s `{ …, "joined": true }` rather than
 * inventing a second convention for "the thing you asked for happened". The
 * code is deliberately not echoed back: the command was given an identifier
 * precisely so that no credential passed through it, and printing one into the
 * terminal that just revoked it would put it back into the scrollback for
 * nothing.
 *
 * The server's response is empty, so everything here is what the caller already
 * supplied. That is honest — there is nothing else to know about a revoked
 * invite than that it no longer works.
 *
 * @param inviteId - The invite revoked.
 * @param projectId - The project it belonged to.
 * @param project - The resolution that project came from.
 * @returns The view.
 */
export function inviteRevokedView(
  inviteId: InviteId,
  projectId: ProjectId,
  project: ResolvedProject,
): View {
  return view(
    {
      invite: { id: inviteId },
      project: { id: projectId, slug: project.slug },
      revoked: true,
    },
    (writer) => {
      writer.line(`Revoked an invite for ${writer.style.bold(project.slug ?? projectId)}.`);
      writer.fields([['invite', inviteId]]);
      writer.blank();
      writer.line('Its code no longer works. Anyone who tries it is told the invite is invalid.');
      writer.line(
        writer.style.dim(
          'Revoking it again succeeds and changes nothing. Other invites to this project are untouched.',
        ),
      );
    },
  );
}

/**
 * `agentchat project revoke-invite <inv_…>`.
 *
 * The argument is judged before the client is built, so a mistyped identifier
 * costs no round trip and no credential read.
 *
 * There is no confirmation prompt, unlike `project leave`. Revocation is the
 * fail-safe direction — the cost of doing it by mistake is one re-mint, while
 * the cost of a prompt is the seconds between spotting a leaked code and
 * closing it — and it is idempotent, so a repeat is not a hazard to guard
 * against either.
 *
 * @param context - The command context.
 * @param overrides - Test seams.
 * @returns A promise that resolves once the invite has been revoked.
 */
async function revokeProjectInvite(
  context: CommandContext,
  overrides: ProjectOverrides,
): Promise<void> {
  const inviteId = requireInviteId(context.args.required(0, 'an invite identifier', USAGE));

  const client = await clientFor(context, overrides);
  const project = await resolveProject(contextRequestFor(context));
  const projectId = await projectIdFor(client, project, context.signal);

  await client.projects.revokeInvite(projectId, inviteId, { signal: context.signal });
  await context.emit(inviteRevokedView(inviteId, projectId, project));
}

/**
 * Builds `agentchat project revoke-invite`.
 *
 * @param overrides - Test seams; empty in production.
 * @returns The command.
 */
export function createProjectRevokeInviteCommand(overrides: ProjectOverrides = {}): Command {
  return {
    kind: 'command',
    name: 'revoke-invite',
    summary: 'withdraw an invite code, by the identifier that minted it',
    usage: USAGE,
    options: PROJECT_OPTIONS,
    positionals: { min: 1 },
    details: [
      `The identifier is the \`${InviteIdKind.prefix}…\` value \`${PROGRAM} project invite\` printed; it is disclosed there and nowhere else.`,
      'An invite code is not accepted: revoking by code would put a live credential into your shell history and the server’s logs.',
      'Any member may revoke any of the project’s invites, not only the member who minted it.',
      'Revoking twice succeeds and changes nothing, so a retry after a dropped connection is safe.',
    ],

    /** @inheritdoc */
    run(context: CommandContext): Promise<void> {
      return revokeProjectInvite(context, overrides);
    },
  };
}
