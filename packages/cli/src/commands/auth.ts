/**
 * `agentchat login`, `agentchat logout`, `agentchat whoami` — who this machine
 * is, and how it stops being that.
 *
 * ## Login is a poll with four answers, not two
 *
 * `POST /auth/device/poll` (T-103, plan §7) never returns "not yet" as a success
 * status. It answers with one of five things, and four of them are failures on
 * the wire that mean quite different things to a client:
 *
 * | Server outcome | Wire code             | What this client must do        |
 * | -------------- | --------------------- | ------------------------------- |
 * | approved       | 200                   | save the tokens and stop        |
 * | pending        | `AUTH_PENDING`        | poll again at the same interval |
 * | slow down      | `CONFLICT`            | poll again, *more slowly*       |
 * | denied         | `FORBIDDEN`           | stop; the user said no          |
 * | expired        | `DEVICE_CODE_EXPIRED` | stop; the code timed out        |
 *
 * A client that collapses this to "success or keep trying" hammers a server that
 * has just asked it to back off, and hangs forever after a refusal it read as
 * one more "not yet". Both failure modes are silent. So the mapping is a table
 * ({@link POLL_SIGNAL_BY_CODE}) rather than a chain of `if`s, and
 * {@link pollSignalOf} is the single place that reads it.
 *
 * The `CONFLICT` row is a stand-in. T-020 is filed to mint a code that actually
 * means "you are going too fast"; when it lands, this adopts it by changing one
 * key in that table, and nothing else in this file moves.
 *
 * ## Where the retry timing comes from
 *
 * The server puts it in `Retry-After`, which is where HTTP already carries it —
 * but `ApiClient` throws an `ApiError` built from the status and body only, so
 * by the time the error reaches this file the headers are gone. Hence
 * {@link RetryAfterWatcher}: a transport decorator that remembers the
 * `Retry-After` of the response it just passed through. Reading a header the
 * server actually sent beats guessing a number, and beats parsing it out of a
 * human-readable error message, which is not a contract.
 *
 * When the header is absent, the fallback is RFC 8628's: add five seconds. It is
 * also what the server does to its own interval, so the two stay in step.
 *
 * ## Which stream each thing goes to
 *
 * PRD §39: stdout carries the result, stderr carries everything a human reads
 * along the way. The verification URL and user code are instructions to a
 * person, so in human mode they go to **stderr** — `agentchat login > file`
 * still shows you the code you have to type.
 *
 * A harness cannot scrape prose, so `--json` puts the same facts on **stdout**
 * as an NDJSON record (`{"status":"pending",…}`) ahead of the final
 * `{"status":"authenticated",…}`. Two records, one per line, which is the shape
 * `agentchat listen` already establishes and which the acceptance tests parse.
 *
 * ## Logout revokes before it forgets
 *
 * The local refresh token is the only handle anyone has on the server-side
 * session. Delete it first and a failed revocation leaves a live token that can
 * now never be revoked, under a message saying you are signed out. So the order
 * is: revoke, and only then forget. If revocation fails the credentials stay
 * exactly where they were and the command fails, so the next attempt can still
 * succeed. `--force` is the escape hatch for a server that is never coming back,
 * and it says out loud what it is giving up.
 *
 * ## Login is where a fresh installation learns its server (T-026)
 *
 * These three commands no longer resolve the server URL themselves;
 * `../config.ts` does, for every command. What remains this file's business is
 * the other half: a successful `login` records the address it signed in to, so a
 * self-hoster's instruction to their users is one line —
 *
 * ```sh
 * agentchat login --server https://chat.your-company.example
 * ```
 *
 * — and nothing after it needs the flag. Before, that address was asked for and
 * then discarded, so a `whoami` run immediately afterwards reported that no
 * server was configured. `agentchat setup` (T-403) is a friendlier front door
 * onto the same storage; it is not what makes the CLI usable, because this is.
 *
 * @module
 */

import { setTimeout as sleepFor } from 'node:timers/promises';

import type {
  CredentialStore,
  Credentials,
  Transport,
  TransportRequest,
  TransportResponse,
} from '@agentchat/client';
import { AgentChatClient, ApiError, HttpTransport } from '@agentchat/client';
import type {
  PollDeviceAuthorizationResponse,
  StartDeviceAuthorizationResponse,
  User,
} from '@agentchat/protocol';
import { ErrorCode } from '@agentchat/protocol';

import type { OptionSpecs } from '../args.js';
import type { Command, CommandContext } from '../command.js';
import { rememberServerUrl, requireServer, resolveServer, serverRequestFor } from '../config.js';
import { createCredentialStore, credentialsPath } from '../credentials.js';
import { CliError } from '../errors.js';
import type { JsonValue, View } from '../output/output.js';
import { view } from '../output/output.js';
import { CLI_VERSION, PROGRAM } from '../version.js';

/** Milliseconds in a second, so the arithmetic below reads as arithmetic. */
const MS_PER_SECOND = 1000;

/**
 * What to add to the poll interval when the server says "slow down" but sends
 * no `Retry-After`.
 *
 * RFC 8628 §3.5 specifies exactly this increment for the `slow_down` error, and
 * the server applies the same five seconds to its own copy of the interval, so
 * a client that follows the specification and a server that follows it converge
 * instead of drifting apart.
 */
const SLOW_DOWN_INCREMENT_SECONDS = 5;

/** The shortest gap between two polls, whatever anyone asks for. */
const MINIMUM_POLL_INTERVAL_SECONDS = 1;

/** The header the poll endpoint carries its retry timing in. */
const RETRY_AFTER_HEADER = 'retry-after';

/** How this command sleeps between polls. Injectable so tests need no clock. */
export type Sleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

/**
 * The seams these three commands are built on.
 *
 * Every field has a real default; they exist so a test can drive the whole
 * command — parsing, streams, exit code and all — against a stubbed server
 * without a socket, a home directory, or fifteen minutes of real waiting.
 */
export interface AuthOverrides {
  /** Where credentials live. Defaults to the file store at the documented path. */
  readonly store?: CredentialStore;
  /** How requests are made. Defaults to HTTP against the resolved server. */
  readonly transport?: Transport;
  /** How to wait between polls. Defaults to a real timer. */
  readonly sleep?: Sleep;
  /** The clock the expiry deadline is measured against. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * What one poll response tells this client to do next.
 *
 * Named for the decision rather than for the wire code, which is the point: the
 * loop below branches on the decision, so re-pointing a code at a different
 * decision (T-020) does not touch the loop.
 */
export type PollSignal = 'pending' | 'slow-down' | 'denied' | 'expired' | 'other';

/**
 * The wire code of each poll outcome, and the decision it implies.
 *
 * `CONFLICT` means "slow down" *on this endpoint only*, which is why this table
 * is local to the device flow rather than a general translation of the error
 * set. T-020 will mint a code whose name says that; adopting it means replacing
 * this one key.
 */
const POLL_SIGNAL_BY_CODE: Readonly<Partial<Record<ErrorCode, PollSignal>>> = Object.freeze({
  [ErrorCode.AUTH_PENDING]: 'pending',
  [ErrorCode.CONFLICT]: 'slow-down',
  [ErrorCode.FORBIDDEN]: 'denied',
  [ErrorCode.DEVICE_CODE_EXPIRED]: 'expired',
} as Partial<Record<ErrorCode, PollSignal>>);

/**
 * Classifies what the poll endpoint just answered.
 *
 * Anything that is not a server answer — a dropped connection, a response this
 * build cannot parse — is `other`, and `other` is rethrown rather than absorbed
 * into the loop. A poll loop that swallows unknown failures is a poll loop that
 * spins.
 *
 * @param error - Whatever `pollDeviceAuthorization` rejected with.
 * @returns The decision this client should take.
 */
export function pollSignalOf(error: unknown): PollSignal {
  if (!(error instanceof ApiError)) {
    return 'other';
  }
  return POLL_SIGNAL_BY_CODE[error.code] ?? 'other';
}

/**
 * Reads `Retry-After` as a whole number of seconds in the future.
 *
 * The server sends delta-seconds. An HTTP-date is equally legal in that header
 * and a proxy may rewrite one into the other, so both are read; anything else,
 * and any value already in the past, is `null` and the caller falls back to its
 * own interval rather than to zero.
 *
 * @param headers - The response headers, lower-cased by the transport.
 * @param now - The current time in milliseconds, for the HTTP-date form.
 * @returns Seconds to wait, or `null` if the header said nothing usable.
 */
export function retryAfterSecondsOf(
  headers: Readonly<Record<string, string>>,
  now: () => number = Date.now,
): number | null {
  const raw = headers[RETRY_AFTER_HEADER];
  if (raw === undefined) {
    return null;
  }

  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
  }

  const instant = Date.parse(trimmed);
  if (Number.isNaN(instant)) {
    return null;
  }
  const seconds = Math.ceil((instant - now()) / MS_PER_SECOND);
  return seconds > 0 ? seconds : null;
}

/**
 * A transport that remembers the `Retry-After` of the last response it saw.
 *
 * `ApiClient` turns a 4xx into an `ApiError` carrying the status and the parsed
 * body, and nothing else — the headers do not survive the throw. Wrapping the
 * transport is how the poll loop gets to read a header on a response that
 * became an exception, without `packages/client` growing an API for one caller.
 *
 * Deliberately not a `connect` implementation: `Transport.connect` is optional
 * and the device flow never opens a socket, so this wrapper is for the auth
 * commands and would silently disable WebSocket support anywhere else.
 */
export class RetryAfterWatcher implements Transport {
  readonly #inner: Transport;
  #seconds: number | null = null;

  /**
   * @param inner - The transport that actually performs the request.
   */
  public constructor(inner: Transport) {
    this.#inner = inner;
  }

  /** The `Retry-After` of the most recent response, in seconds, or `null`. */
  public get retryAfterSeconds(): number | null {
    return this.#seconds;
  }

  /** @inheritdoc */
  public async request(request: TransportRequest): Promise<TransportResponse> {
    const response = await this.#inner.request(request);
    this.#seconds = retryAfterSecondsOf(response.headers);
    return response;
  }
}

/**
 * A credential store whose `clear` is recorded rather than performed.
 *
 * `AuthApi.logout` clears the store in a `finally`, so by the time a revocation
 * failure surfaces the tokens would already be gone — and with them any chance
 * of ever revoking that session. Handing the client one of these puts the
 * decision back where it belongs: the removal happens on {@link commit}, which
 * the command calls only once the server has confirmed the revocation.
 */
class DeferredClearStore implements CredentialStore {
  readonly #inner: CredentialStore;
  #requested = false;

  /**
   * @param inner - The store that really holds the credentials.
   */
  public constructor(inner: CredentialStore) {
    this.#inner = inner;
  }

  /** Whether anything asked for the credentials to be removed. */
  public get clearRequested(): boolean {
    return this.#requested;
  }

  /** @inheritdoc */
  public load(): Promise<Credentials | null> {
    return this.#inner.load();
  }

  /** @inheritdoc */
  public save(credentials: Credentials): Promise<void> {
    return this.#inner.save(credentials);
  }

  /** @inheritdoc */
  public clear(): Promise<void> {
    this.#requested = true;
    return Promise.resolve();
  }

  /** Performs the removal that {@link clear} only recorded. */
  public async commit(): Promise<void> {
    if (this.#requested) {
      await this.#inner.clear();
    }
  }
}

/**
 * The credential store for this invocation.
 *
 * The store's permission warning — "this file was readable by other users" —
 * is the whole reason it takes a sink. Left unwired it writes into a callback
 * that discards it, and the one moment a user could learn their token had been
 * exposed passes in silence. Here it is the command's own logger, so the
 * warning lands on stderr like every other warning.
 *
 * @param context - The command context, for the environment and the logger.
 * @param overrides - Test seams.
 * @returns The store.
 */
function storeFor(context: CommandContext, overrides: AuthOverrides): CredentialStore {
  return (
    overrides.store ??
    createCredentialStore({
      path: credentialsPath(context.env.env),
      warn: (message: string): void => {
        context.log.warn(message);
      },
    })
  );
}

/**
 * A client pointed at `server`, using `store` for credentials.
 *
 * @param server - The validated base URL.
 * @param store - The credential store the client reads and writes.
 * @param transport - The transport to use, already wrapped if it needs to be.
 * @returns The client.
 */
function clientFor(store: CredentialStore, transport: Transport): AgentChatClient {
  return new AgentChatClient({
    credentials: store,
    // Always sent, so this process takes part in the compatibility negotiation
    // of plan §12.4 rather than looking like an unidentified caller.
    clientVersion: CLI_VERSION,
    transport,
  });
}

/**
 * The transport for a command that was not given one.
 *
 * @param server - The validated base URL.
 * @param overrides - Test seams.
 * @returns The transport.
 */
function transportFor(server: string, overrides: AuthOverrides): Transport {
  return overrides.transport ?? new HttpTransport({ baseUrl: server });
}

/**
 * The account, as both representations.
 *
 * `createdAt` is left out: it is on the wire because `GET /me` returns the whole
 * account, but nobody asking "who am I" is asking when they signed up, and a
 * timestamp in the human rendering is a line of noise above the two facts that
 * matter.
 *
 * @param user - The account.
 * @returns The JSON object.
 */
function userJson(user: User): JsonValue {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
  };
}

/**
 * The instruction a person has to act on, in both representations.
 *
 * In human mode this is never emitted — it is written to stderr as prose, see
 * the module note. It exists as a view because `--json` needs the same facts on
 * stdout, where a harness can read them.
 *
 * @param start - What `POST /auth/device/start` answered.
 * @returns The view.
 */
export function verificationView(start: StartDeviceAuthorizationResponse): View {
  const json: JsonValue = {
    status: 'pending',
    verificationUri: start.verificationUri,
    userCode: start.userCode,
    interval: start.interval,
    expiresIn: start.expiresIn,
  };

  return view(json, (writer) => {
    writer.line(`Open ${writer.style.bold(start.verificationUri)}`);
    writer.line(`Enter the code ${writer.style.bold(start.userCode)}`);
  });
}

/**
 * The result of a completed sign-in, in both representations.
 *
 * @param user - Who was signed in.
 * @param server - The server they were signed in to.
 * @returns The view.
 */
export function loginView(user: User, server: string): View {
  return view({ status: 'authenticated', user: userJson(user), server }, (writer) => {
    writer.line(`Signed in as ${writer.style.bold(`@${user.username}`)} on ${server}`);
  });
}

/**
 * The result of `whoami`, in both representations.
 *
 * The same `user` and `server` keys as {@link loginView} without the `status`,
 * which only exists there to tell the two records of a login apart.
 *
 * @param user - The account.
 * @param server - The configured server.
 * @returns The view.
 */
export function whoamiView(user: User, server: string): View {
  return view({ user: userJson(user), server }, (writer) => {
    writer.line(`${writer.style.bold(`@${user.username}`)}`);
    writer.fields([
      ['name', user.displayName],
      ['email', user.email],
      ['server', server],
    ]);
  });
}

/**
 * The result of `logout`, in both representations.
 *
 * `revoked` says whether the server-side session is known to be gone — revoked
 * just now, or already invalid when asked. It is not always true: signing out
 * when you were never signed in revokes nothing, and `--force` deliberately
 * gives up on revoking. A caller that cares whether a token is still live on the
 * server reads this key rather than the exit code.
 *
 * @param server - The server the credentials were for.
 * @param revoked - Whether the server-side session is known to be gone.
 * @returns The view.
 */
export function logoutView(server: string, revoked: boolean): View {
  return view({ status: 'signed-out', server, revoked }, (writer) => {
    writer.line(`Signed out of ${server}.`);
    if (!revoked) {
      writer.line('No refresh token was revoked on the server.');
    }
  });
}

/** The sign-in code ran out before anyone approved it. */
function codeExpired(cause?: unknown): CliError {
  return new CliError(
    ErrorCode.DEVICE_CODE_EXPIRED,
    'The sign-in code expired before it was approved, so you are still signed out.',
    {
      ...(cause === undefined ? {} : { cause }),
      hint: `Run \`${PROGRAM} login\` again for a fresh code, and approve it in the browser before it expires.`,
    },
  );
}

/**
 * The user refused the sign-in in the browser.
 *
 * `AUTH_REQUIRED` rather than the `FORBIDDEN` the server sent, because the exit
 * code is the part a harness reads and the honest answer here is 3, "you are not
 * authenticated": nothing about a refused login is a permissions problem with a
 * resource, and `FORBIDDEN`'s standard hint — check your project membership —
 * would send the reader somewhere with no bearing on what happened.
 */
function signInDenied(cause: unknown): CliError {
  return new CliError(
    ErrorCode.AUTH_REQUIRED,
    'The sign-in was denied in the browser, so you are still signed out.',
    {
      cause,
      hint: `Run \`${PROGRAM} login\` again and approve the request, checking you are signed in to the right account in the browser.`,
    },
  );
}

/** The process was interrupted while waiting for the browser. */
function signInCancelled(cause?: unknown): CliError {
  return new CliError(ErrorCode.AUTH_REQUIRED, 'Sign-in was cancelled before it completed.', {
    ...(cause === undefined ? {} : { cause }),
    hint: `Run \`${PROGRAM} login\` again when you are ready to approve it.`,
  });
}

/**
 * There are no credentials on this machine.
 *
 * The two halves are different situations and get different hints. Somebody who
 * has a server configured needs one word — `login`. Somebody who has none is on
 * a fresh installation and needs to be told that the address is a thing they
 * have to be given, which "run login with `--server <url>`" did not say: it
 * named a flag to a reader whose problem was that they had nothing to put in it.
 *
 * @param server - The configured server, or `null` when nothing configures one.
 * @returns The error to throw.
 */
function notSignedIn(server: string | null): CliError {
  if (server === null) {
    return new CliError(
      ErrorCode.AUTH_REQUIRED,
      'You are not signed in, and no AgentChat server is configured.',
      {
        hint: `Run \`${PROGRAM} login --server <url>\` with the address of the AgentChat server you use — ask whoever runs it, or use your own deployment's address if that is you. It is saved, so later commands need no flag.`,
      },
    );
  }
  return new CliError(ErrorCode.AUTH_REQUIRED, `You are not signed in to ${server}.`, {
    hint: `Run \`${PROGRAM} login\`.`,
  });
}

/**
 * Waits, and turns an interruption into a message about signing in.
 *
 * Without this, `Ctrl-C` during the fifteen minutes a device code lives rejects
 * with the interrupt's own error and renders as "an unexpected internal error",
 * which is both untrue and unhelpful.
 *
 * @param sleep - The wait implementation.
 * @param milliseconds - How long to wait.
 * @param signal - The command's abort signal.
 */
async function waitOrCancel(
  sleep: Sleep,
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    throw signInCancelled(signal.reason);
  }
  try {
    await sleep(milliseconds, signal);
  } catch (cause) {
    if (signal.aborted) {
      throw signInCancelled(cause);
    }
    throw cause;
  }
}

/** The default wait: a real timer that an abort cuts short. */
function realSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return sleepFor(milliseconds, undefined, { signal });
}

/** Everything {@link awaitApproval} needs, gathered so its signature stays readable. */
interface ApprovalRequest {
  readonly context: CommandContext;
  readonly client: AgentChatClient;
  readonly watcher: RetryAfterWatcher;
  readonly start: StartDeviceAuthorizationResponse;
  readonly sleep: Sleep;
  readonly now: () => number;
}

/**
 * Polls until the sign-in is decided, one way or another.
 *
 * Three properties this loop keeps, each of which is a bug if it does not:
 *
 * **It waits before the first poll.** The server sets the earliest acceptable
 * poll time to `start + interval` when it issues the code, so polling
 * immediately earns a slow-down — and the user has not had time to type the code
 * anyway.
 *
 * **It ends.** The deadline comes from `expiresIn` and is measured on this
 * machine's clock, so a server that answers "pending" forever still stops this
 * command. Nothing here counts on the server ever sending `expired`.
 *
 * **It never sleeps for zero.** Every wait is at least a second, so no answer,
 * however malformed, turns the loop into a spin against someone's server.
 *
 * @param request - The client, the grant, and the seams.
 * @returns The tokens and the account, once approved.
 * @throws {CliError} `DEVICE_CODE_EXPIRED` at the deadline or on the server's
 *   expiry, `AUTH_REQUIRED` on refusal or interruption.
 */
async function awaitApproval(request: ApprovalRequest): Promise<PollDeviceAuthorizationResponse> {
  const { context, client, watcher, start, sleep, now } = request;
  const deadline = now() + start.expiresIn * MS_PER_SECOND;
  let intervalSeconds = Math.max(start.interval, MINIMUM_POLL_INTERVAL_SECONDS);

  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw codeExpired();
    }

    // Never longer than what is left: an outsized Retry-After should end this
    // command at its deadline with an expiry message, not park it past one.
    await waitOrCancel(sleep, Math.min(intervalSeconds * MS_PER_SECOND, remaining), context.signal);
    if (now() >= deadline) {
      throw codeExpired();
    }

    try {
      return await client.auth.pollDeviceAuthorization(
        { deviceCode: start.deviceCode },
        { signal: context.signal },
      );
    } catch (error) {
      if (context.signal.aborted) {
        throw signInCancelled(error);
      }

      switch (pollSignalOf(error)) {
        case 'pending': {
          intervalSeconds = nextInterval(watcher.retryAfterSeconds ?? intervalSeconds);
          context.log.debug(`Not approved yet; polling again in ${String(intervalSeconds)}s.`);
          break;
        }
        case 'slow-down': {
          intervalSeconds = nextInterval(
            watcher.retryAfterSeconds ?? intervalSeconds + SLOW_DOWN_INCREMENT_SECONDS,
          );
          context.log.info(
            `The server asked for slower polling; waiting ${String(intervalSeconds)}s before the next check.`,
          );
          break;
        }
        case 'denied':
          throw signInDenied(error);
        case 'expired':
          throw codeExpired(error);
        case 'other':
          throw error;
      }
    }
  }
}

/**
 * Clamps a proposed interval to something worth sleeping for.
 *
 * @param seconds - What the server asked for, or what the fallback computed.
 * @returns At least {@link MINIMUM_POLL_INTERVAL_SECONDS}.
 */
function nextInterval(seconds: number): number {
  return Number.isFinite(seconds) && seconds > MINIMUM_POLL_INTERVAL_SECONDS
    ? Math.ceil(seconds)
    : MINIMUM_POLL_INTERVAL_SECONDS;
}

/**
 * Tells the user what to open and what to type.
 *
 * Human mode writes to stderr with {@link Logger.raw} rather than `info`,
 * because this is not progress: `--quiet` suppressing it would leave the command
 * apparently hung, waiting on a code the user was never shown.
 *
 * @param context - The command context.
 * @param start - The grant.
 */
async function announce(
  context: CommandContext,
  start: StartDeviceAuthorizationResponse,
): Promise<void> {
  if (context.isJson) {
    await context.emit(verificationView(start));
    return;
  }

  context.log.raw('');
  context.log.raw(`  Open ${start.verificationUri}`);
  context.log.raw(`  and enter the code  ${start.userCode}`);
  context.log.raw('');
  context.log.info(
    `Waiting for approval; this code expires in ${describeDuration(start.expiresIn)}.`,
  );
}

/**
 * A duration a person can read.
 *
 * @param seconds - The duration.
 * @returns Something like `15 minutes` or `45 seconds`.
 */
function describeDuration(seconds: number): string {
  if (seconds < 90) {
    return `${String(seconds)} seconds`;
  }
  const minutes = Math.round(seconds / 60);
  return `${String(minutes)} minutes`;
}

/**
 * Runs the device flow to completion and stores the result.
 *
 * @param context - The command context.
 * @param overrides - Test seams.
 */
async function login(context: CommandContext, overrides: AuthOverrides): Promise<void> {
  const settled = await requireServer(serverRequestFor(context));
  const server = settled.url;
  const store = storeFor(context, overrides);
  const watcher = new RetryAfterWatcher(transportFor(server, overrides));
  const client = clientFor(store, watcher);

  context.log.debug(`Starting device authorization against ${server}.`);
  const start = await client.auth.startDeviceAuthorization({ signal: context.signal });
  await announce(context, start);

  // `pollDeviceAuthorization` writes the tokens to the store itself, which is
  // why nothing here handles them: the access token never passes through this
  // file, so it cannot end up in a log line by accident.
  const approved = await awaitApproval({
    context,
    client,
    watcher,
    start,
    sleep: overrides.sleep ?? realSleep,
    now: overrides.now ?? Date.now,
  });

  // The address is written down only now, and only because the sign-in worked.
  // Recording it before the poll would leave a machine that abandoned a login
  // configured for a server it was never able to authenticate against, and
  // recording it on failure would make a typo permanent. It is what turns
  // `--server` from something typed on every command into something typed once.
  const recorded = await rememberServerUrl(context.env.env, settled);
  if (recorded !== null) {
    context.log.info(`Recorded ${server} as your AgentChat server in ${recorded}.`);
  }

  await context.emit(loginView(approved.user, server));
}

/** What `logout --force` gives up, said plainly. */
function revocationFailed(server: string, cause: unknown): CliError {
  return new CliError(
    ErrorCode.INTERNAL,
    `${server} did not confirm that your refresh token was revoked, so your credentials have been left in place rather than deleted.`,
    {
      cause,
      hint: `Run \`${PROGRAM} logout\` again once the server is reachable. \`${PROGRAM} logout --force\` deletes the local credentials regardless, which leaves the refresh token valid on the server until it expires and unrevokable from here.`,
    },
  );
}

/**
 * Revokes the refresh token, then removes the local credentials.
 *
 * @param context - The command context.
 * @param overrides - Test seams.
 */
async function logout(context: CommandContext, overrides: AuthOverrides): Promise<void> {
  const { url: server } = await requireServer(serverRequestFor(context));
  const store = storeFor(context, overrides);

  if ((await store.load()) === null) {
    // Idempotent on purpose. A harness that runs `logout` to reach a known state
    // should reach it, not fail because the state was already known.
    context.log.info('No credentials were stored, so there was nothing to revoke.');
    await context.emit(logoutView(server, false));
    return;
  }

  const deferred = new DeferredClearStore(store);
  const client = clientFor(deferred, transportFor(server, overrides));

  try {
    // Resolves both when the server revoked the token and when it reported the
    // token was already invalid, which is the same end state.
    await client.auth.logout({ signal: context.signal });
  } catch (cause) {
    if (!context.args.flag('force')) {
      throw revocationFailed(server, cause);
    }
    context.log.warn(
      `${server} did not confirm the revocation. Removing the local credentials anyway because --force was given; the refresh token stays valid on the server until it expires.`,
    );
    await store.clear();
    await context.emit(logoutView(server, false));
    return;
  }

  await deferred.commit();
  await context.emit(logoutView(server, true));
}

/**
 * Reports the signed-in account and the server it belongs to.
 *
 * The local credentials are checked before the server is resolved, so a machine
 * that has neither answers "you are not signed in" (exit 3) rather than "no
 * server is configured" (exit 2). Exit 3 is the one a harness can act on, and it
 * is true either way.
 *
 * @param context - The command context.
 * @param overrides - Test seams.
 */
async function whoami(context: CommandContext, overrides: AuthOverrides): Promise<void> {
  const store = storeFor(context, overrides);
  if ((await store.load()) === null) {
    throw notSignedIn((await resolveServer(serverRequestFor(context))).url);
  }

  const { url: server } = await requireServer(serverRequestFor(context));
  const client = clientFor(store, transportFor(server, overrides));
  const user = await client.auth.me({ signal: context.signal });
  await context.emit(whoamiView(user, server));
}

/** `--force`, which only `logout` has. */
const LOGOUT_OPTIONS: OptionSpecs = Object.freeze({
  force: {
    type: 'boolean',
    description: 'remove the local credentials even if the server does not confirm revocation',
  },
});

/**
 * Builds `agentchat login`.
 *
 * @param overrides - Test seams; empty in production.
 * @returns The command.
 */
export function createLoginCommand(overrides: AuthOverrides = {}): Command {
  return {
    kind: 'command',
    name: 'login',
    summary: 'sign in to an AgentChat server',
    usage: 'login [--server <url>]',
    details: [
      'Prints a URL and a short code to enter there, then waits for you to approve it.',
      'The URL and code go to stderr so that redirecting stdout does not hide them; with --json they are the first record on stdout instead.',
      'Tokens are written to ~/.config/agentchat/credentials.json with mode 0600.',
      'On success the server is recorded in ~/.config/agentchat/config.json, so --server is needed once and not on every later command.',
    ],

    /** @inheritdoc */
    run(context: CommandContext): Promise<void> {
      return login(context, overrides);
    },
  };
}

/**
 * Builds `agentchat logout`.
 *
 * @param overrides - Test seams; empty in production.
 * @returns The command.
 */
export function createLogoutCommand(overrides: AuthOverrides = {}): Command {
  return {
    kind: 'command',
    name: 'logout',
    summary: 'revoke this machine’s refresh token and forget it',
    usage: 'logout [--server <url>] [--force]',
    options: LOGOUT_OPTIONS,
    details: [
      'Revokes the refresh token on the server first, and removes the local credentials only once that succeeds.',
      'If revocation fails the credentials are kept, so a later attempt can still revoke them; --force deletes them anyway.',
    ],

    /** @inheritdoc */
    run(context: CommandContext): Promise<void> {
      return logout(context, overrides);
    },
  };
}

/**
 * Builds `agentchat whoami`.
 *
 * @param overrides - Test seams; empty in production.
 * @returns The command.
 */
export function createWhoamiCommand(overrides: AuthOverrides = {}): Command {
  return {
    kind: 'command',
    name: 'whoami',
    summary: 'report the signed-in account and the server it is on',
    usage: 'whoami [--server <url>]',
    details: ['Exits 3 when there are no credentials on this machine.'],

    /** @inheritdoc */
    run(context: CommandContext): Promise<void> {
      return whoami(context, overrides);
    },
  };
}

/** `agentchat login`. */
export const loginCommand: Command = createLoginCommand();

/** `agentchat logout`. */
export const logoutCommand: Command = createLogoutCommand();

/** `agentchat whoami`. */
export const whoamiCommand: Command = createWhoamiCommand();
