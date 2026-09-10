/**
 * Deciding what a version mismatch means, on the client's side (plan §12.4).
 *
 * `resources/version.ts` fetches `GET /version` and deliberately stops there:
 * it says the numbers arrive parsed and leaves the comparison alone. This
 * module is the comparison. It is still not the *reaction* — nothing here
 * writes to a stream, exits a process, or throws — because a CLI, a daemon and
 * a hosted integration answer "your client is too old" in three different ways,
 * and a library that picked one of them would be wrong for the other two.
 *
 * What it does own is the arithmetic and the wording, both of which have
 * exactly one correct answer:
 *
 * - **The arithmetic** is `compareSemanticVersions` from `@stackgrid/protocol`,
 *   not a string comparison. `'0.10.0' < '0.9.0'` is true for strings and false
 *   for versions, and that comparison is what decides whether somebody is
 *   locked out of their own server.
 * - **The wording** for a refusal is `upgradeRequiredMessage`, the same
 *   function the server uses to build the sentence it puts in the 426. A client
 *   that probed `/version` first and a client that was refused therefore print
 *   the same instruction, and there is no second copy to drift.
 *
 * ## The three outcomes
 *
 * | Situation | Verdict | What a CLI does |
 * |---|---|---|
 * | client below the server's floor | `client-too-old` | print `message`, exit non-zero |
 * | server release older than this client | `server-older` | print `warning` to stderr **once**, continue |
 * | neither | `compatible` | nothing |
 *
 * The middle row is the additive-only rule seen from the client: a newer client
 * talking to an older server is supported, and options the older server does
 * not recognise are ignored by it rather than rejected. That is best-effort by
 * design, and the warning is what makes it visible instead of mysterious.
 *
 * ## Nothing here hard-codes a protocol number
 *
 * `PROTOCOL_VERSION` is 3 today and may be reset before the first release.
 * {@link CompatibilityInputs} takes the local protocol version as an optional
 * parameter that merely *defaults* to the constant, so a caller can compare
 * against any number and no test in this package encodes the current one.
 *
 * @module
 */

import type { GetVersionResponse } from '@stackgrid/protocol';
import {
  compareSemanticVersions,
  isClientTooOld,
  PROTOCOL_VERSION,
  upgradeRequiredMessage,
} from '@stackgrid/protocol';

/** The client and server agree; nothing needs saying. */
export interface Compatible {
  readonly kind: 'compatible';
}

/**
 * The server will not serve this client until it is upgraded.
 *
 * Every authenticated request from this build answers `426 UPGRADE_REQUIRED`,
 * so there is nothing to retry and nothing to degrade to. A caller that
 * receives this should print {@link ClientTooOld.message} and stop.
 */
export interface ClientTooOld {
  readonly kind: 'client-too-old';
  /** The version this client announces. */
  readonly clientVersion: string;
  /** The floor the server reported. */
  readonly minClientVersion: string;
  /**
   * The instruction to print, verbatim from plan §12.4 and byte-identical to
   * the message the server puts in its own 426.
   */
  readonly message: string;
}

/**
 * The server is an older release than this client. Supported, and worth saying
 * once.
 *
 * Not a failure: within a major version the protocol is additive-only, so an
 * older server ignores fields and frame types it does not know rather than
 * rejecting them. The consequence is that a new option may silently do nothing,
 * which is the thing a user needs told — once, on stderr, and never again.
 */
export interface ServerOlder {
  readonly kind: 'server-older';
  /** The version this client announces. */
  readonly clientVersion: string;
  /** The release the server reported. */
  readonly serverVersion: string;
  /** The single line to write to the error stream. No trailing newline. */
  readonly warning: string;
}

/** What {@link checkCompatibility} concluded. */
export type Compatibility = Compatible | ClientTooOld | ServerOlder;

/** What {@link checkCompatibility} needs to know about this build. */
export interface CompatibilityInputs {
  /**
   * This client's own release version — the one it puts in
   * `X-AgentChat-Client`. Required, because a caller that does not announce a
   * version is not in the negotiation at all and has nothing to compare.
   */
  readonly clientVersion: string;
  /**
   * The protocol this build speaks. Defaults to the protocol package's
   * `PROTOCOL_VERSION`; it is a parameter so that nothing here depends on what
   * that number currently is.
   */
  readonly protocolVersion?: number;
}

/**
 * Builds the one-line warning for an older server.
 *
 * The protocol numbers appear only when they differ, because a line that
 * restates two identical numbers buries the two that are not.
 *
 * @param local - This build's version, and the protocol it speaks.
 * @param server - What `GET /version` answered.
 * @returns One line, no trailing newline, no leading `warning:` prefix — the
 *   caller's own logger owns its prefix and its colours.
 */
export function serverOlderWarning(
  local: Required<CompatibilityInputs>,
  server: GetVersionResponse,
): string {
  const protocols =
    local.protocolVersion === server.protocolVersion
      ? ''
      : ` The server speaks protocol ${String(server.protocolVersion)} and this client speaks ${String(local.protocolVersion)}.`;

  return (
    `The server is agentchat ${server.version} and this client is ${local.clientVersion}.` +
    `${protocols} Options it does not recognise are ignored, so newer flags are best-effort.`
  );
}

/**
 * Compares this build against what a server reported.
 *
 * The order of the checks is the whole contract. Being below the floor is
 * decided first and reported alone: a client that is too old is also, usually,
 * newer than something or older than something else, and telling a user two
 * things when only one of them is actionable is how the actionable one gets
 * missed.
 *
 * The floor is inclusive — a client exactly at `minClientVersion` is
 * compatible — and "server older" is a comparison of *release* versions, which
 * is the axis plan §12.4 states. A protocol difference is reported inside the
 * warning rather than as a verdict of its own, because the server's own
 * `minClientVersion` is the authority on whether the two can talk and this
 * client is not entitled to overrule it.
 *
 * @param local - See {@link CompatibilityInputs}.
 * @param server - The parsed `GET /version` body.
 * @returns What to do about it.
 * @throws {TypeError} If `local.clientVersion` is not a semantic version. The
 *   server's numbers arrived through `GetVersionResponseSchema` and are already
 *   known to parse; this one comes from the caller.
 */
export function checkCompatibility(
  local: CompatibilityInputs,
  server: GetVersionResponse,
): Compatibility {
  const resolved: Required<CompatibilityInputs> = {
    clientVersion: local.clientVersion,
    protocolVersion: local.protocolVersion ?? PROTOCOL_VERSION,
  };

  if (isClientTooOld(resolved.clientVersion, server.minClientVersion)) {
    return {
      kind: 'client-too-old',
      clientVersion: resolved.clientVersion,
      minClientVersion: server.minClientVersion,
      message: upgradeRequiredMessage(server.minClientVersion),
    };
  }

  const olderRelease = compareSemanticVersions(server.version, resolved.clientVersion) < 0;
  const olderProtocol = server.protocolVersion < resolved.protocolVersion;

  if (olderRelease || olderProtocol) {
    return {
      kind: 'server-older',
      clientVersion: resolved.clientVersion,
      serverVersion: server.version,
      warning: serverOlderWarning(resolved, server),
    };
  }

  return { kind: 'compatible' };
}

/** Writes one line to somewhere a human will see it. */
export type WarningSink = (line: string) => void;

/**
 * Wraps a sink so an older server is reported **once** per process.
 *
 * Plan §12.4 says "a one-line warning", singular, and a long-running
 * `agentchat listen` reconnects with backoff — so the naive placement, at the
 * handshake, turns one fact into a line every few seconds and trains the reader
 * to ignore stderr. The de-duplication belongs here rather than at each call
 * site, because there is more than one call site and only one of them has to
 * forget.
 *
 * Repeated only when the sentence itself changes, which happens when the server
 * on the other end has been upgraded mid-run: that is new information and
 * saying it again is correct.
 *
 * @param write - Where the line goes. A CLI passes something that writes to
 *   stderr; `agentchat listen` keeps stdout for message payloads only.
 * @returns A function to hand every {@link Compatibility}. Verdicts other than
 *   `server-older` write nothing — a refusal is not a warning and belongs to
 *   whoever decides to stop.
 */
export function createServerOlderWarner(write: WarningSink): (verdict: Compatibility) => void {
  const said = new Set<string>();

  return (verdict: Compatibility): void => {
    if (verdict.kind !== 'server-older' || said.has(verdict.warning)) {
      return;
    }
    said.add(verdict.warning);
    write(verdict.warning);
  };
}
