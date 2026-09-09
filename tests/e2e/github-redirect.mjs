/**
 * The single substitution this suite makes inside the server process.
 *
 * Loaded with `node --import`, so it runs before `server/dist/src/index.js` is
 * evaluated and therefore before `createGitHubIdentityProvider` captures the
 * global `fetch` it will use.
 *
 * ## What it changes
 *
 * Requests to `https://github.com/…` and `https://api.github.com/…` are sent to
 * the loopback provider in `./identity-provider.ts` instead, path and query
 * unchanged. Every other request is untouched — including, importantly, none:
 * this server makes no other outbound HTTP call, so if this hook ever starts
 * rewriting something it should not, the assertion in
 * `./delivery.integration.test.ts` that counts device authorizations is what
 * notices.
 *
 * ## Why the seam is here and not in the server
 *
 * `server/src/app.ts` already has a documented seam for this:
 * `AppOptions.identityProvider`. Using it would mean importing `createApp` and
 * composing the server inside the test process, which would quietly replace the
 * real entry point — `index.ts` — with a reimplementation of it. The signal
 * handlers, the pool wiring, the shutdown ordering and the startup validation
 * are all in that file, and a suite that exists to prove the shipped thing
 * works must run the shipped thing.
 *
 * So the server is started exactly as a container starts it, and the fake is
 * pushed one layer further out: to the network, which is the layer the identity
 * provider actually lives on. Nothing in `server/` is aware this file exists.
 *
 * ## It fails loudly rather than reaching the internet
 *
 * If `AGENTCHAT_E2E_IDENTITY_ORIGIN` is unset, a request to github.com throws
 * instead of being forwarded. A test suite that silently starts talking to a
 * real identity provider is worse than one that breaks: it would be slow,
 * flaky, and dependent on credentials nobody has.
 *
 * @module
 */

/** Hosts whose requests belong to the identity provider. */
const REDIRECTED_ORIGINS = ['https://github.com', 'https://api.github.com'];

/** Where to send them instead. Absent means "fail rather than call out". */
const origin = process.env['AGENTCHAT_E2E_IDENTITY_ORIGIN'];

const realFetch = globalThis.fetch;

/**
 * The target of a fetch call, whatever form it was given in.
 *
 * @param {string | URL | Request} input - The first argument to `fetch`.
 * @returns {string} The absolute URL as a string.
 */
function urlOf(input) {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

globalThis.fetch = (input, init) => {
  const url = urlOf(input);
  const redirected = REDIRECTED_ORIGINS.find((candidate) => url.startsWith(`${candidate}/`));

  if (redirected === undefined) {
    return realFetch(input, init);
  }

  if (origin === undefined || origin.trim() === '') {
    return Promise.reject(
      new Error(
        `Refusing to call ${redirected} from a test: AGENTCHAT_E2E_IDENTITY_ORIGIN is not set, ` +
          'so tests/e2e/github-redirect.mjs has nowhere to send it.',
      ),
    );
  }

  const target = new URL(url);
  return realFetch(`${origin}${target.pathname}${target.search}`, init);
};
