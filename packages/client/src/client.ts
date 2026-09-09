/**
 * {@link AgentChatClient} — what the CLI and every future integration hold.
 *
 * ```ts
 * const client = new AgentChatClient({
 *   baseUrl: 'https://chat.example.com',
 *   credentials: new InMemoryCredentialStore(),
 *   clientVersion: '0.1.0',
 * });
 *
 * const { items } = await client.projects.list();
 * ```
 *
 * ## What is deliberately not here
 *
 * `sessions`. Their schemas do not exist yet — `packages/protocol` omits them
 * until the milestone that settles them — and a method whose request shape had
 * to be invented here would be a contract later tasks then have to live with.
 *
 * `messages` is no longer among them in either direction, and neither is
 * `conversations`. Both stopped being guesses the same way: the server settled
 * the shapes, T-311 moved the send into the protocol package and T-313 moved
 * the inbox listing, the acknowledgement and the thread read, each field for
 * field rather than restated here.
 *
 * `listen()`. It needs {@link Transport.connect}, the WebSocket frames, and a
 * reconnect policy, all of which are T-310. The seam is in place and nothing
 * about adding it changes this file's shape.
 *
 * @module
 */

import { RefreshTokensRequestSchema, RefreshTokensResponseSchema } from '@agentchat/protocol';

import { ApiClient } from './api.js';
import type { CredentialStore, Credentials } from './credentials.js';
import { HttpTransport } from './http-transport.js';
import { AgentsApi } from './resources/agents.js';
import { AuthApi } from './resources/auth.js';
import { ConversationsApi } from './resources/conversations.js';
import { InvitesApi } from './resources/invites.js';
import { MessagesApi } from './resources/messages.js';
import { ProjectsApi } from './resources/projects.js';
import { SessionsApi } from './resources/sessions.js';
import { VersionApi } from './resources/version.js';
import { TokenManager } from './tokens.js';
import type { Transport } from './transport.js';

/** Construction options for {@link AgentChatClient}. */
export interface AgentChatClientOptions {
  /**
   * Where the server lives — `https://chat.example.com`.
   *
   * Required unless {@link AgentChatClientOptions.transport} is supplied, which
   * already knows where it is pointing.
   */
  readonly baseUrl?: string;

  /** Where tokens are read from and written to. */
  readonly credentials: CredentialStore;

  /**
   * This client's own release version, for the `X-AgentChat-Client` header.
   *
   * Omit it and no version header is sent, which the protocol explicitly
   * permits: the header claims to be the `agentchat` CLI at a given version, and
   * a harness embedding this MIT package is not that. Sending a made-up default
   * would be worse than sending nothing — a version below the server's
   * `minClientVersion` earns an `UPGRADE_REQUIRED` on every request, so a
   * placeholder would lock out exactly the embedders this package exists for.
   *
   * The `agentchat` CLI passes its own version here and is therefore covered by
   * the negotiation in plan §12.4.
   *
   * @see {@link CLIENT_VERSION_HEADER}
   */
  readonly clientVersion?: string;

  /**
   * How requests travel. Defaults to a {@link HttpTransport} on `baseUrl`.
   *
   * This is the daemon seam (D1) and the test seam. Supplying one replaces the
   * wire, not the behaviour: authentication, the single refresh, the retry, and
   * error translation stay in the pipeline above it.
   */
  readonly transport?: Transport;

  /**
   * How long one request may take, in milliseconds. Defaults to 30 seconds.
   * Ignored when a `transport` is supplied — it owns its own timeouts.
   */
  readonly timeoutMs?: number;
}

/**
 * The typed AgentChat client.
 *
 * One instance per account per process. Sharing an instance is what lets
 * concurrent commands share a single token refresh; two instances over the same
 * credential store are still correct, but may each refresh once. See
 * `./tokens.ts`.
 */
export class AgentChatClient {
  readonly #api: ApiClient;
  readonly #transport: Transport;
  readonly #tokens: TokenManager;

  /** Device authorization, logout, and `GET /me`. */
  public readonly auth: AuthApi;

  /** Projects, invites into them, and agent discovery. */
  public readonly projects: ProjectsApi;

  /** Redeeming and previewing invite codes. */
  public readonly invites: InvitesApi;

  /** The caller's own agents and their project memberships. */
  public readonly agents: AgentsApi;

  /** Sending a message, reading the inbox, and acknowledging. */
  public readonly messages: MessagesApi;

  /** Reading one thread, a page at a time. */
  public readonly conversations: ConversationsApi;

  /** Registering a listening session, and ending it. */
  public readonly sessions: SessionsApi;

  /** The `GET /version` handshake. */
  public readonly version: VersionApi;

  /**
   * @param options - Server location, credential store, and optional transport.
   * @throws {ProtocolError} `BAD_REQUEST` if neither `transport` nor a valid
   *   absolute `baseUrl` was supplied.
   */
  public constructor(options: AgentChatClientOptions) {
    this.#transport = options.transport ?? buildDefaultTransport(options);

    // The manager needs a way to redeem a refresh token, and redeeming one is
    // itself a call through the pipeline the manager serves. The cycle is broken
    // by the arrow closing over `this`: it is not invoked until the first 401,
    // long after the constructor has assigned `#api`.
    const tokens = new TokenManager(options.credentials, (refreshToken) =>
      this.#redeem(refreshToken),
    );
    this.#tokens = tokens;

    this.#api = new ApiClient({
      transport: this.#transport,
      tokens,
      clientVersion: options.clientVersion ?? null,
    });

    this.auth = new AuthApi(this.#api, options.credentials);
    this.projects = new ProjectsApi(this.#api);
    this.invites = new InvitesApi(this.#api);
    this.agents = new AgentsApi(this.#api);
    this.messages = new MessagesApi(this.#api);
    this.conversations = new ConversationsApi(this.#api);
    this.sessions = new SessionsApi(this.#api);
    this.version = new VersionApi(this.#api);
  }

  /**
   * The transport in use.
   *
   * Exposed so T-310 can ask whether it can listen — `client.transport.connect`
   * — without this class growing a `listen()` that would only throw.
   */
  public get transport(): Transport {
    return this.#transport;
  }

  /**
   * The token manager this client authenticates with.
   *
   * Exposed for the same reason as {@link AgentChatClient.transport}, and for
   * the same caller: `SessionListener` needs somewhere to get an access token
   * and somewhere to renew one, and its `TokenSource` is exactly this class's
   * surface. Handing over the client's own manager rather than letting a caller
   * build a second one over the same store is what keeps a single refresh
   * serialised across both halves of the connection — the manager's
   * single-flight guarantee is per instance, and the server revokes the whole
   * chain when a rotated refresh token is presented twice (`./tokens.ts`).
   */
  public get tokens(): TokenManager {
    return this.#tokens;
  }

  /**
   * Redeems a refresh token: `POST /auth/refresh`.
   *
   * `auth: 'none'` is what stops this recursing. A 401 here means the refresh
   * token is dead, and answering it by refreshing again would loop until the
   * stack ran out.
   *
   * @param refreshToken - The token to spend.
   * @returns The newly issued pair.
   * @throws {ApiError} `AUTH_REQUIRED` if the token is unknown, expired, or
   *   already rotated.
   */
  async #redeem(refreshToken: string): Promise<Credentials> {
    const renewed = await this.#api.send({
      method: 'POST',
      path: '/auth/refresh',
      auth: 'none',
      body: RefreshTokensRequestSchema.parse({ refreshToken }),
      response: RefreshTokensResponseSchema,
    });
    return { accessToken: renewed.accessToken, refreshToken: renewed.refreshToken };
  }
}

/**
 * Builds the default HTTP transport from the client's options.
 *
 * @param options - The client options.
 * @returns A transport pointed at `baseUrl`.
 * @throws {ProtocolError} `BAD_REQUEST` if `baseUrl` is missing or not an
 *   absolute `http:` or `https:` URL.
 */
function buildDefaultTransport(options: AgentChatClientOptions): HttpTransport {
  return new HttpTransport({
    baseUrl: options.baseUrl ?? '',
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}
