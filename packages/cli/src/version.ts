/**
 * This CLI's own release version.
 *
 * ## Why a constant and not `package.json`
 *
 * The obvious implementation reads the manifest at runtime. It cannot be used
 * here. `rootDir` is `src`, so `import pkg from '../package.json'` puts the
 * manifest inside `dist` and moves every emitted file down a directory; reading
 * it with `fs` at runtime replaces a compile-time constant with a file the
 * published `files` list does not have to contain and an installer may have
 * pruned. Either way the version becomes a runtime failure mode, and it is
 * consulted on the one code path — the `X-AgentChat-Client` header — that has to
 * work before anything else does.
 *
 * So the version is written here, and `./version.test.ts` fails the build if it
 * ever disagrees with `package.json`. The duplication is real; it is checked.
 *
 * ## What it is used for
 *
 * Two things, both contractual. It is the version in the `X-AgentChat-Client`
 * header, which the server compares against its `minClientVersion` (plan §12.4)
 * — which is why {@link AgentChatClientOptions.clientVersion} is always passed
 * from here and never left to default. And it is what `agentchat version`
 * prints, which is the first thing anyone is asked for in a bug report.
 *
 * @module
 */

/**
 * The `agentchat` release this build is.
 *
 * Semantic version, and the value compared against a server's
 * `minClientVersion`. Must equal the `version` field of this package's
 * `package.json`; `./version.test.ts` enforces that.
 */
export const CLI_VERSION = '0.1.0';

/**
 * The name this program is invoked as.
 *
 * Used in usage lines, hints, and log prefixes so all three say the same word
 * even if the binary is one day renamed.
 */
export const PROGRAM = 'agentchat';
