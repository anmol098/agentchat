/**
 * Version negotiation between client and server (plan §12.4).
 *
 * Two numbers do two different jobs.
 *
 * {@link PROTOCOL_VERSION} describes the *shape* of the conversation: the frame
 * types, the request and response bodies, the identifier format. It is an
 * integer and it moves only when a change is not additive.
 *
 * {@link MIN_CLIENT_VERSION} describes *compatibility*: the oldest release of
 * the `agentchat` CLI a server built from this source will still serve. It is a
 * semantic version because that is what the user has installed and what the
 * upgrade instruction has to name.
 *
 * The exchange, in full:
 *
 * - The CLI sends `X-AgentChat-Client: agentchat/X.Y.Z` on every request and in
 *   the WebSocket `hello`.
 * - `GET /version` answers `{ version, protocolVersion, minClientVersion }`,
 *   unauthenticated.
 * - A client older than the server's `minClientVersion` gets HTTP 426 with the
 *   {@link ErrorCode.UPGRADE_REQUIRED} code, and prints the upgrade line.
 * - A server older than the client is fine: the CLI warns once on stderr and
 *   continues, and flags the old server does not understand are best-effort.
 *
 * @module
 */

/**
 * The wire protocol this build speaks.
 *
 * Bump it only for a change that an existing peer cannot ignore: a removed or
 * repurposed field, a changed identifier format, a frame whose meaning has
 * shifted. Adding an optional field or a new frame type does **not** bump it,
 * because both sides ignore what they do not recognise — that is the whole
 * additive-only rule, and this integer is what tells you it was respected.
 *
 * ## History
 *
 * - **4** — T-060 narrowed `AGENT_NAME_PATTERN` to the same shape the other two
 *   handles already had: runs of lowercase alphanumerics joined by single
 *   hyphens, no leading or trailing hyphen. `agents_name_format` moved with it
 *   in `server/drizzle/0004_agent_name_single_hyphens.sql`, so the two still
 *   spell one rule.
 *
 *   Unlike 2 and 3 this closes no fault. The pattern and the constraint have
 *   always agreed, and nothing was ever rejected at storage that passed at the
 *   boundary; what moved is the product rule. A name is what a user *says* to
 *   their harness — "check the implementation with alice's backend agent" —
 *   which the harness then resolves against the agent listing, and `backend-`
 *   cannot be said unambiguously, reads as a typo, and makes that resolution
 *   worse for nothing in return. The exact and unspeakable half of an agent's
 *   identity is `agt_<uuidv7>`, which already exists for everything that has to
 *   be precise.
 *
 *   That makes this the first bump taken for a decision rather than a defect,
 *   which is worth naming: the guard does not care why, and the ledger entry
 *   has to carry the argument because the diff cannot.
 * - **3** — T-025 narrowed `PROJECT_SLUG_PATTERN` to the grammar
 *   `projects_slug_format` enforces, so that a slug the protocol accepts is a
 *   slug the database stores. The same defect as 2, in the same shape, for the
 *   other handle a user types; recorded in the same ledger.
 *
 *   The reasoning at 2 applies here word for word — nothing has been released,
 *   no client exists outside this repository — which raises the fair question
 *   of whether bumping again for a second consequence-free break says anything.
 *   It does, and the ledger is why: its keys are prefixed by the version that
 *   accepted them, so `v2` and `v3` keep two decisions taken on two different
 *   days legible as two decisions. Reusing 2 would file this one under an
 *   approval that was granted for something else, which is the one thing this
 *   integer exists to prevent. What number the first public release carries is
 *   still a release decision, and still free.
 * - **2** — T-016 narrowed `USERNAME_PATTERN` to GitHub's actual rule, so that
 *   a name the protocol accepts is a name the database accepts. Recorded in
 *   `scripts/protocol-snapshot.json` under `acceptedBreakingChanges`.
 *
 *   Nothing had been released at 1 and no client exists outside this
 *   repository, so this bump strands nobody; it is the price of the snapshot
 *   guard's acceptance path, which is deliberately the only door. Whether the
 *   first public release should ship at 2 or reset to 1 is a release decision,
 *   and it is free to make right up until that release.
 * - **1** — the first protocol.
 */
export const PROTOCOL_VERSION = 4;

/**
 * The oldest `agentchat` CLI release this build will serve.
 *
 * Raising it strands every user below the new floor until they upgrade, so it
 * moves only when supporting the older client is genuinely impossible, and the
 * release notes have to say so (plan §12.1). `0.1.0` is the first published
 * release; nothing earlier ever existed to support.
 */
export const MIN_CLIENT_VERSION = '0.1.0';

/**
 * The command that installs a current CLI.
 *
 * Named here rather than in the CLI because the *server* is what puts it in
 * front of a user: a client below `minClientVersion` is refused before any of
 * its own code runs, and a refusal that does not carry the remedy is only a
 * status code. The server cannot import the CLI — `packages/` is MIT and
 * `server/` is AGPL, and the arrow points one way — so the one place both
 * halves can agree on this string is this package.
 */
export const UPGRADE_COMMAND = 'npm i -g agentchat@latest';

/**
 * The refusal a client below the server's floor is given, verbatim from plan
 * §12.4.
 *
 * One function, two callers, and that is the point. The server puts this in the
 * `UPGRADE_REQUIRED` envelope, so a client too old to contain this code still
 * receives a sentence naming the remedy; a client that asked `GET /version`
 * first builds the same sentence locally rather than having to be refused to
 * learn it. Two implementations would drift, and the one that drifted would be
 * the one a stranger sees.
 *
 * The floor is a parameter rather than {@link MIN_CLIENT_VERSION} because the
 * number that matters is the one the *server being talked to* reported, which
 * is not necessarily the one this build was compiled with.
 *
 * @param minClientVersion - The oldest release the server will serve.
 * @returns The refusal sentence, ending in the command to run.
 */
export function upgradeRequiredMessage(minClientVersion: string): string {
  return `Server requires agentchat >= ${minClientVersion}. Run: ${UPGRADE_COMMAND}`;
}

/** One parsed semantic version: the three numbers, plus pre-release identifiers. */
interface ParsedVersion {
  readonly numbers: readonly [number, number, number];
  /** Empty for a release. Build metadata is dropped — semver §10 ignores it. */
  readonly prerelease: readonly string[];
}

/**
 * Splits `X.Y.Z[-prerelease][+build]` into something comparable.
 *
 * Returns `null` rather than throwing, so the one caller that decides what an
 * unparseable version means can decide it in one place. See
 * {@link compareSemanticVersions}.
 *
 * @param version - A bare semantic version, no `v` prefix and no range operator.
 * @returns The parsed version, or `null` if it is not one.
 */
function parseSemanticVersion(version: string): ParsedVersion | null {
  const withoutBuild = version.split('+', 1)[0] ?? '';
  const dash = withoutBuild.indexOf('-');
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const prerelease = dash === -1 ? '' : withoutBuild.slice(dash + 1);

  const parts = core.split('.');
  if (parts.length !== 3) {
    return null;
  }

  const numbers: number[] = [];
  for (const part of parts) {
    // `Number('')` is 0 and `Number(' 1')` is 1, so the grammar is checked
    // before the conversion rather than trusted after it.
    if (!/^(?:0|[1-9]\d*)$/.test(part)) {
      return null;
    }
    numbers.push(Number(part));
  }

  if (prerelease !== '' && !/^[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/.test(prerelease)) {
    return null;
  }

  return {
    numbers: [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0],
    prerelease: prerelease === '' ? [] : prerelease.split('.'),
  };
}

/**
 * Compares two pre-release identifier lists by semver §11.
 *
 * @param left - Identifiers from the left version, empty for a release.
 * @param right - Identifiers from the right version, empty for a release.
 * @returns Negative, zero or positive, as `Array.prototype.sort` expects.
 */
function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  // A release outranks any pre-release of the same numbers: 1.0.0 > 1.0.0-rc.1.
  if (left.length === 0 || right.length === 0) {
    if (left.length === right.length) {
      return 0;
    }
    return left.length === 0 ? 1 : -1;
  }

  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const a = left[index] ?? '';
    const b = right[index] ?? '';
    if (a === b) {
      continue;
    }

    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      return Number(a) < Number(b) ? -1 : 1;
    }
    // A numeric identifier always ranks below an alphanumeric one.
    if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    }
    return a < b ? -1 : 1;
  }

  // Everything shared is equal, so the longer list wins: rc.1 < rc.1.1.
  if (left.length === right.length) {
    return 0;
  }
  return left.length < right.length ? -1 : 1;
}

/**
 * Orders two semantic versions by semver §11 precedence.
 *
 * Written here, once, because three callers need it — the server's
 * `minClientVersion` guard, the client's compatibility check, and any embedder
 * doing the same arithmetic — and two of them sit on opposite sides of a licence
 * boundary that forbids the server importing the client.
 *
 * A hand-rolled `<` on version strings is the specific bug this exists to
 * prevent: it makes `0.10.0` older than `0.9.0`, and that is exactly the
 * comparison that decides whether a user is locked out of their own server.
 *
 * Build metadata is ignored (semver §10) and a pre-release ranks below the
 * release it precedes (§11), so `1.0.0-rc.1 < 1.0.0`.
 *
 * @param left - A bare semantic version.
 * @param right - A bare semantic version.
 * @returns Negative if `left` is older, zero if the two are equal in
 *   precedence, positive if `left` is newer.
 * @throws {TypeError} If either string is not a semantic version. Returning
 *   "equal" for something unparseable would silently admit a client the floor
 *   was meant to exclude, so this is a refusal rather than a guess.
 */
export function compareSemanticVersions(left: string, right: string): number {
  const a = parseSemanticVersion(left);
  const b = parseSemanticVersion(right);
  if (a === null || b === null) {
    const bad = a === null ? left : right;
    throw new TypeError(`Not a semantic version: ${JSON.stringify(bad)}.`);
  }

  for (let index = 0; index < 3; index += 1) {
    const x = a.numbers[index] ?? 0;
    const y = b.numbers[index] ?? 0;
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }

  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Whether a client announcing `clientVersion` is below the server's floor.
 *
 * The floor is inclusive: a client *at* `minClientVersion` is served. That is
 * what "minimum" means, and a strict comparison would strand exactly the users
 * who did the upgrade they were told to do.
 *
 * @param clientVersion - The version from the `X-AgentChat-Client` header.
 * @param minClientVersion - The oldest release the server will serve.
 * @returns `true` if the client must upgrade before it is served.
 * @throws {TypeError} If either string is not a semantic version.
 */
export function isClientTooOld(clientVersion: string, minClientVersion: string): boolean {
  return compareSemanticVersions(clientVersion, minClientVersion) < 0;
}
