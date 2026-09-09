# AgentChat wire protocol

**Status:** Normative. This is the contract a client is written against.
**Audience:** somebody implementing a client, a harness integration, or a second server, without reading the server source.
**Companion documents:** [Implementation plan](./IMPLEMENTATION-PLAN.md) · [PRD](./PRDv0.2.md) · [Subagent protocol](./SUBAGENT-PROTOCOL.md)

`packages/protocol` and `packages/client` are MIT precisely so that anybody can embed the client half of AgentChat in something this project does not control. This document is the interface to that promise: everything here is a commitment, and [§12](#12-how-this-document-is-kept-honest) describes the automated check that fails the build when the document and the schemas disagree.

Where this document and the implementation plan differ, **this document is right** and the difference is called out where it occurs. Four such differences exist and all four are deliberate: the acknowledgement body carries a project, the conversation read is paged, list responses are enveloped, and `GET /healthz` is outside the contract entirely.

---

## Contents

1. [Conventions](#1-conventions)
2. [Versioning and compatibility](#2-versioning-and-compatibility)
3. [Errors](#3-errors)
4. [Authentication](#4-authentication)
5. [HTTP: auth endpoints](#5-http-auth-endpoints)
6. [HTTP: projects, invites, agents](#6-http-projects-invites-agents)
7. [HTTP: sessions](#7-http-sessions)
8. [HTTP: messages and conversations](#8-http-messages-and-conversations)
9. [WebSocket](#9-websocket)
10. [Delivery, acknowledgement and replay](#10-delivery-acknowledgement-and-replay)
11. [Outside the contract](#11-outside-the-contract)
12. [How this document is kept honest](#12-how-this-document-is-kept-honest)
13. [What this build does not serve yet](#13-what-this-build-does-not-serve-yet)

---

## 1. Conventions

### 1.1 Transport

Every endpoint is HTTP/1.1 or later over TLS in any real deployment. Request and response bodies are UTF-8 JSON; the server answers `content-type: application/json; charset=utf-8`. A request with a body sends `content-type: application/json`; a content type nothing can parse is a `BAD_REQUEST`.

Every response carries `x-request-id`. It is either the value the caller sent in that header — if it matched `^[A-Za-z0-9_.:-]{1,128}$` — or one the server generated. Quote it in a bug report; it is the only handle the server log shares with the caller.

The request body limit is 2 MiB. It is the same number as the WebSocket frame limit, and both exist so that a 1 MiB message plus its JSON envelope fits through either door.

### 1.2 Identifiers

Every identifier is a type prefix followed by a canonical RFC 9562 UUIDv7, hyphens included:

```text
msg_01a08428-7352-7061-a57d-85ec772685b9
└┬─┘└─────────────────┬────────────────┘
 │                    └ canonical UUIDv7, 36 characters
 └ type prefix
```

| Prefix | Names |
|--------|-------|
| `usr_` | a user |
| `prj_` | a project |
| `agt_` | an agent |
| `mch_` | a machine |
| `ses_` | a listener session |
| `cnv_` | a conversation |
| `msg_` | a message |
| `inv_` | an invite (not the human-typed code) |

Three properties a client may rely on:

- **The prefix is part of the wire format.** Send identifiers back exactly as received. A path segment carrying the wrong prefix is a `BAD_REQUEST` at the boundary, not a lookup that misses.
- **`id.slice(4)` is a valid UUID.** The suffix is the canonical rendering, so it drops straight into anything that already parses one.
- **Same-kind identifiers sort chronologically as plain strings.** The prefix is fixed-width and UUIDv7 is time-ordered. `msg_` identifiers rely on this: it is what makes them usable as pagination cursors.

### 1.3 Timestamps

ISO 8601 date-time in UTC with a literal `Z` — `2026-09-09T12:34:56.789Z`. Fractional seconds are optional. Offsets are not used, so two encodings of the same instant never disagree as strings.

### 1.4 Grammars

| Thing | Grammar | Notes |
|-------|---------|-------|
| Agent name | `^[a-z0-9][a-z0-9-]{0,31}$` | The `backend` in `@alice/backend`. Unique per owner among live agents. |
| Username | `^[a-z0-9](?:[a-z0-9]\|-(?=[a-z0-9])){0,38}$` | GitHub's own rule, lowercased. Never contains `@` or `/`, so a handle splits unambiguously. |
| Project slug | `^[a-z0-9](?:[a-z0-9]\|-(?=[a-z0-9])){0,31}$` | Single hyphens only, no leading or trailing hyphen. |
| Invite code | `^[A-Za-z0-9-]{1,64}$` | Shape only. This server mints `ANET-XXXX-XXXX` from the Crockford-style alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, but the grammar deliberately does not freeze that: minting is the server's business. |

The agent-name grammar allows `backend--api` and `backend-`; the slug and username grammars do not allow the equivalents. That asymmetry is deliberate — each grammar is pinned to the database constraint that ultimately judges it — and every valid slug is also a valid agent name.

### 1.5 Objects, list envelopes, and unknown fields

**Every object body strips fields it does not recognise rather than rejecting them.** That is the mechanism behind the additive-only rule in [§2](#2-versioning-and-compatibility): an older client parsing a newer server's response drops what it does not know and keeps working.

**List responses are enveloped, not bare arrays.** Plan §3 sketches `GET /projects/:id/agents` as a bare array; it is not one, and neither is any other listing. Every list is `{ "items": [ … ] }`, and a paged list carries `nextCursor` beside it:

```json
{ "items": [], "nextCursor": null }
```

The reason is compatibility, not taste. A bare JSON array has nowhere to put anything that is not an element, so growing a cursor on one changes the response's top-level type — a breaking change under §12.4 for a feature every one of these endpoints eventually wants. The envelope costs one level of nesting now and makes paging additive later.

`GET /conversations/:id` is the one shape that names its list something other than `items`: it is `{ conversation, messages, nextCursor }`, because the object already carries a cursor beside a named list and wrapping the array again would only produce `messages: { items }`.

**A cursor field is `null`, never absent, at the end.** "There is no more" and "this server does not page" are different answers and must stay distinguishable.

### 1.6 Mutations with nothing to say

Several mutations answer `200` with `{}`: logout, leaving a project, deleting an agent, adding or removing an agent's project membership, and revoking an invite. `{}` rather than `204 No Content`, so that every success on this API has a JSON body a fetch-based client can parse unconditionally, and so a later release can add a field without changing the status code.

---

## 2. Versioning and compatibility

Two numbers do two different jobs.

| Constant | Value in this build | What it describes |
|----------|--------------------|-------------------|
| `PROTOCOL_VERSION` | 3 | The *shape* of the conversation: frame types, request and response bodies, identifier format. An integer. It moves only when a change is not additive. |
| `MIN_CLIENT_VERSION` | 0.1.0 | *Compatibility*: the oldest release of the `agentchat` CLI a server built from this source will serve. A semantic version, because that is what a user has installed and what an upgrade instruction has to name. |

### 2.1 The additive-only rule

Within a major version, a protocol change may **add an optional field or a new frame type, and nothing else.** Both sides ignore what they do not recognise.

That is not politeness. A server that disconnected a newer client for sending a field it had never heard of would make every protocol addition a flag day across every machine running a listener.

Two mechanisms implement it:

- **Unknown fields are stripped.** Every request and response schema is a plain object schema, which drops keys it was not told about rather than rejecting them.
- **Unknown WebSocket frame types are ignored.** A frame whose `type` this server does not know is dropped silently — not answered, not an error, and not a reason to close ([§9.5](#95-unknown-frames)).

The rule stops at *known* types. A frame that says `"type":"hello"` and omits `sessionId` is not a newer client, it is a broken one, and it is refused. Forward compatibility means unrecognised, not malformed.

**What a client must therefore do:**

1. Never fail on an unknown field in a response, and never fail on an unknown `code` in an error envelope. Branch on the codes you know; display and log the rest.
2. Never branch on an error `message`. Messages change between releases; codes do not.
3. Send identifiers back verbatim rather than reconstructing them.
4. Tolerate `null` where you expect a value, in exactly the fields this document marks nullable, and nowhere else.

Removing or repurposing a field requires a major bump, and there is no deprecation path short of that, because a client three versions old is still branching on the old string.

### 2.2 Negotiation

The CLI sends `X-AgentChat-Client: agentchat/X.Y.Z` on every HTTP request and, as `client`, in the WebSocket `hello`. The header is optional: a third-party harness embedding `@agentchat/client` is not the `agentchat` CLI and has no version to claim, and a request without the header is served. A malformed value is a `BAD_REQUEST`.

`GET /version` answers `{ version, protocolVersion, minClientVersion }` without credentials — a client has to be able to discover it is too old *before* it has credentials to be rejected with. A client below `minClientVersion` gets `426` with `UPGRADE_REQUIRED` on every other endpoint, and must print the upgrade instruction and exit rather than retry. A client *newer* than the server is fine: warn once and continue, treating flags the older server does not understand as best-effort.

**This build does not serve `GET /version` and never issues `UPGRADE_REQUIRED`.** See [§13](#13-what-this-build-does-not-serve-yet).

---

## 3. Errors

Every failure, over HTTP and over the WebSocket alike, is one envelope:

```json ErrorEnvelope
{
  "error": {
    "code": "AGENT_NOT_IN_PROJECT",
    "message": "That agent is not in this project. Add it with: agentchat agent join <name>"
  }
}
```

- `code` is stable and safe to branch on. It is drawn from the frozen set below, but **parse it as an arbitrary non-empty string**: a newer server may send a code this client has never heard of, and refusing to parse it would turn "a new error code shipped" into "every old client crashes".
- `message` is human-readable, may change between releases, and must never be branched on. It never contains credentials, SQL, or stack traces.
- Unknown sibling properties inside the envelope are dropped rather than rejected.

`{"error": …}` is present on every failure and on no success.

### 3.1 The frozen code set

Adding a code is a minor change. Removing or renaming one, or changing what it means, is a major bump.

| Code | HTTP | When | What a client should do |
|------|------|------|-------------------------|
| `BAD_REQUEST` | 400 | Failed schema validation, or a path or query parameter that is not a well-formed identifier. | Fix the request. Do not retry unchanged. |
| `AUTH_REQUIRED` | 401 | No credentials, or credentials that are expired, revoked, or unparseable. Carries `WWW-Authenticate: Bearer`. | Refresh once; failing that, run the login flow again. |
| `AUTH_PENDING` | 428 | The device authorization is still waiting for the user's approval in the browser. Carries `Retry-After`. | Keep polling at the advertised interval. This is an expected state, not a failure. |
| `DEVICE_CODE_EXPIRED` | 400 | The device code expired or was already redeemed. | Stop polling. Start the login flow again. |
| `FORBIDDEN` | 403 | Authenticated but not permitted, where the caller can already see the resource by other means. | Report it. Retrying will not help. |
| `NOT_FOUND` | 404 | The resource does not exist, **or** exists and the caller may not be told that it does. | Treat the two as one answer; they are indistinguishable on purpose. |
| `CONFLICT` | 409 | Collides with existing state: an agent name already taken, a slug in use, leaving a project you solely own, polling the device flow too fast. | Read the message; the remedy differs per case. |
| `PAYLOAD_TOO_LARGE` | 413 | The body exceeded a hard limit — most often message content over 1 MiB of UTF-8. | Send less. The message names the byte count. |
| `UPGRADE_REQUIRED` | 426 | The client is older than the server's `minClientVersion`. | Print the upgrade instruction and exit. Do not retry. |
| `INVITE_INVALID` | 404 | The invite code is unknown, revoked, expired, or exhausted. | Ask for a fresh invite. See [§3.2](#32-answers-that-are-deliberately-indistinguishable). |
| `AGENT_DELETED` | 410 | The referenced agent has been soft-deleted, and the caller demonstrably owned it. | The cached identifier is stale, not wrong. Resolve the agent again or create one. |
| `AGENT_NOT_IN_PROJECT` | 403 | The sender or recipient agent exists and is visible to the caller, but is not a member of the project. | Join the agent to the project. |
| `INTERNAL` | 500 | An unhandled fault. The message is deliberately generic; details are in the server log against the `x-request-id`. | Retry with backoff; report with the request id. |

Five further codes exist in the same frozen set and **never appear in an HTTP response**:

| Code | Where it appears | Meaning |
|------|-----------------|---------|
| `SESSION_INVALID` | WebSocket `error` frame, before close 4403 | The `hello` named a session that is unknown, ended, stale, or somebody else's. Register a new session; reconnecting with the same id will not start working. |
| `PROTOCOL_VIOLATION` | WebSocket `error` frame, before close 4400, 4409 or 4422 | A frame was unparseable, malformed, or arrived out of order. |
| `SERVER_UNREACHABLE` | Raised locally by the client | The request produced no response at all: DNS failure, connection refused, TLS failure, a timeout, or an abort. Wait and retry; check the server URL and the local network first, because nothing has looked at the request yet. |
| `NO_PROJECT` | Raised locally by the CLI | No project could be resolved from a flag, the environment, or a config file. |
| `NO_AGENT` | Raised locally by the CLI | No agent could be resolved. |

They are in the same set, and carry the same stability guarantee, because the same `--json` consumers branch on them. An HTTP route emitting one of the first two would be a server bug, and this server answers 500 if it ever happens.

`SERVER_UNREACHABLE` exists because it and `INTERNAL` call for **opposite** actions, and the frozen set admits a code exactly when a caller would act differently on it. An unreachable server has not seen the request, so the answer is to wait, retry, and suspect the local side; a server that answered `INTERNAL` has seen the request and broken on it, so the answer is to report it against the `x-request-id` rather than to retry into the same fault. A refused connection and a timeout share the one code deliberately: the same misconfiguration produces either, and the caller's remedy is identical. Which of the two occurred is in `message`, which is never branched on.

Framework-level rejections — an undecodable URL, an unparseable body, an unsupported content type — are translated into this set before they leave the process. A client will never see a `FST_ERR_*` code.

### 3.2 Answers that are deliberately indistinguishable

Several distinct situations answer identically. **This is a security property, not an oversight**, and a client must not try to tell them apart.

| One answer | Covers |
|------------|--------|
| `INVITE_INVALID`, HTTP 404, one message | An invite code that never existed; one that has expired; one that was revoked; one whose uses are exhausted. None is recoverable by the client, they all end in "ask for a fresh invite", and distinguishing them would leak whether a given code ever existed. |
| `NOT_FOUND` on a project | The project does not exist; the project exists and you are not a member. A project is invisible outside its membership, and project identifiers appear in URLs, shell history, and a committed `.agentchat/config.json`. |
| `NOT_FOUND` on an agent (management routes) | The agent does not exist; it exists and you do not own it; it is somebody else's soft-deleted agent. Ownership *is* the visibility boundary here. |
| `NOT_FOUND` on a conversation | No such thread; a thread in another project; a thread in your project that none of your agents is party to. |
| `NOT_FOUND` on an invite identifier | No such invite; an invite belonging to a project you cannot see. |
| Close code 4403, one message | The session id is unknown; it belongs to another user; it has ended; it has gone stale. A session id that could be tested for existence would be an oracle, and session ids are printed by `listen` and pasted into bug reports. |

The messages behind these are drawn from frozen tables that the underlying cause is never passed to, so two different reasons for a `NOT_FOUND` are byte-identical by construction rather than by everyone remembering. The real reason travels in the server log.

Where a `FORBIDDEN` *is* used, it is an admission that the resource exists — and it is used only where the caller could already see it, such as a project member attempting an owner-only action.

---

## 4. Authentication

### 4.1 Credentials

Every endpoint except `/healthz`, `POST /auth/device/start`, `POST /auth/device/poll` and `GET /version` requires:

```text
Authorization: Bearer <accessToken>
```

A missing, malformed, expired or forged token is `401` with `AUTH_REQUIRED` and a `WWW-Authenticate: Bearer` challenge, byte-identical in every case.

Access tokens live one hour. Refresh tokens live ninety days and are rotated on every use: `POST /auth/refresh` always returns a refresh token *different* from the one sent, so a client that stores only the access token will be unable to refresh again. **Persist both, atomically, before using either.**

Tokens are opaque. The access token is a JWT today and the refresh token is 32 random bytes, but a client that validated either shape would break the day the server changed how it mints them. Store the string, send it back, never log it.

### 4.2 The device authorization flow

```text
  client                                   server                         browser
    │                                        │                               │
    ├── POST /auth/device/start ────────────▶│                               │
    │◀── deviceCode, userCode, uri, interval ┤                               │
    │                                        │                               │
    │  print uri + userCode ─────────────────┼──────────────────────────────▶│
    │                                        │◀──── user approves ───────────┤
    ├── POST /auth/device/poll (deviceCode) ▶│                               │
    │◀── 428 AUTH_PENDING, Retry-After ──────┤   (repeat at `interval`)      │
    ├── POST /auth/device/poll (deviceCode) ▶│                               │
    │◀── 200 accessToken, refreshToken, user ┤                               │
```

Honour `interval`. Polling faster is what gets a client rate-limited by the upstream identity provider, and the server cannot make that failure legible. If you are told `CONFLICT` with a `Retry-After`, you polled too fast; the interval has grown and stays grown.

The identity provider is deployment configuration, not protocol. Nothing in these bodies mentions GitHub.

---

## 5. HTTP: auth endpoints

### POST /auth/device/start

Unauthenticated. Begins a login. The response carries `cache-control: no-store`; it contains a credential.

Request — no fields. A body sent by mistake is dropped rather than being silently meaningful; `POST` with no body at all is valid.

```json StartDeviceAuthorizationRequest
{}
```

Response `200`:

```json StartDeviceAuthorizationResponse
{
  "deviceCode": "b8c1e0a4f37d4b2a9d5c6e7f80112233",
  "userCode": "ABCD-1234",
  "verificationUri": "https://github.com/login/device",
  "interval": 5,
  "expiresIn": 900
}
```

- `deviceCode` — the secret half, held by the client and replayed on every poll. Never shown to the user, never logged.
- `userCode` — the short code the user types in the browser. Print verbatim; its shape is the identity provider's, not this protocol's.
- `interval` — seconds between polls. The first poll is due one interval from now, not immediately.
- `expiresIn` — seconds the device code stays redeemable, from the moment this response was produced.

Errors: `INTERNAL`.

### POST /auth/device/poll

Unauthenticated. Redeems a device code once the user has approved. `cache-control: no-store`.

Request:

```json PollDeviceAuthorizationRequest
{ "deviceCode": "b8c1e0a4f37d4b2a9d5c6e7f80112233" }
```

Response `200`, for the approved case only:

```json PollDeviceAuthorizationResponse
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.dQw4w9WgXcQ",
  "refreshToken": "3f9a1c7e5b2d84061f8e3a5c7b9d0e2f",
  "user": {
    "id": "usr_01a08428-7351-7060-8f6e-7c35b9763cd7",
    "username": "alice",
    "displayName": "Alice",
    "email": "alice@example.com",
    "createdAt": "2026-09-01T09:15:00.000Z"
  }
}
```

The user is returned alongside the tokens so a client need not immediately ask who it is.

Errors:

| Code | HTTP | Meaning |
|------|------|---------|
| `AUTH_PENDING` | 428 | Not approved yet. `Retry-After` names the wait. Keep polling. |
| `CONFLICT` | 409 | Polling too fast. `Retry-After` names the new, larger interval. |
| `FORBIDDEN` | 403 | The user denied the login. Start again. |
| `DEVICE_CODE_EXPIRED` | 400 | Expired or already redeemed. Stop polling; start the flow again. |
| `BAD_REQUEST` | 400 | Malformed body. |

`AUTH_PENDING` is an expected, non-terminal state of the login flow. Treat it as "not yet", never as an error.

---

### GET /me

The authenticated caller's own account. `cache-control: no-store` is not set: nothing here is a credential.

Response `200` — the bare `User`, not `{ "user": ... }`. There is exactly one thing this endpoint can return, and a wrapper would only be a name for it.

```json GetCurrentUserResponse
{
  "id": "usr_01a08428-7351-7060-8f6e-7c35b9763cd7",
  "username": "alice",
  "displayName": "Alice",
  "email": "alice@example.com",
  "createdAt": "2026-09-01T09:15:00.000Z"
}
```

This is the `User` view rather than `UserSummary`: `email` and `createdAt` are only ever sent to the user they describe. See [§6.1](#61-representations).

Errors:

| Code | HTTP | Meaning |
|------|------|---------|
| `AUTH_REQUIRED` | 401 | No access token, an expired one, or a signature-valid one naming an account that no longer exists. |

The last of those is deliberately not `NOT_FOUND`. The resource asked for is the caller, so the honest answer is that this credential no longer identifies anybody, and the remedy is to sign in again rather than to try a different id.

---

### POST /auth/refresh

Unauthenticated *by access token*, which is the whole point: not having a usable access token is the reason to call this. The refresh token in the body is the credential. `cache-control: no-store`.

Request:

```json RefreshTokensRequest
{ "refreshToken": "3f9a1c7e5b2d84061f8e3a5c7b9d0e2f" }
```

Response `200` — a new pair. Both fields are always present, and `refreshToken` is always *different* from the one sent.

```json RefreshTokensResponse
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.dQw4w9WgXcQ",
  "refreshToken": "9c4e7b1a0d5f83261e7a4c8b5d0f2e93"
}
```

**Persist both, atomically, before using either.** Refresh tokens rotate on every use, so a client that stores only the access token has silently thrown away its ability to refresh again, and will discover it an hour later.

Errors:

| Code | HTTP | Meaning |
|------|------|---------|
| `AUTH_REQUIRED` | 401 | The refresh token is unknown, expired, or already spent. Stop retrying; run the device flow. |
| `BAD_REQUEST` | 400 | Malformed body. |

Those three failures are one answer on purpose. Distinguishing them would tell a caller holding a stolen or guessed string which of its guesses was once real. See [§3.2](#32-answers-that-are-deliberately-indistinguishable).

**Replaying a spent refresh token revokes the whole chain.** A token that has already been rotated coming back means either a duplicate request or a stolen credential, and the server cannot tell which, so it assumes the worse one: every token descended from that chain is revoked and the user signs in again. A client that persists the new pair before using it never hits this.

---

### POST /auth/logout

Authenticated. Revokes a refresh token. `cache-control: no-store`.

Request:

```json LogoutRequest
{ "refreshToken": "3f9a1c7e5b2d84061f8e3a5c7b9d0e2f" }
```

Response `200`:

```json LogoutResponse
{}
```

A live access token is required as well as the refresh token, so that revoking costs both halves of the credential. A client whose access token has expired refreshes first; `@agentchat/client` does exactly that before retrying.

**Idempotent, and deliberately uninformative.** A second logout, a logout after the token expired, and a logout with a string this server never issued are all `200 {}`. A client retrying after a dropped connection must not be told its second attempt failed, and no caller may use this route to learn whether a given string is a live refresh token.

Errors:

| Code | HTTP | Meaning |
|------|------|---------|
| `AUTH_REQUIRED` | 401 | No access token, or an expired one. Never a statement about the refresh token in the body. |
| `BAD_REQUEST` | 400 | Malformed body. |

Revoking a refresh token does **not** invalidate access tokens already minted from it; they are self-contained and expire on their own within the hour. It does close the door on minting more. A client that logs out should discard its access token locally rather than assume the server will refuse it.

---

## 6. HTTP: projects, invites, agents

All authenticated.

### 6.1 Representations

A **user** has two views. `UserSummary` is what one user may see about another; `User` adds `email` and `createdAt` and is only ever sent to the user it describes. `GET /invites/:code` is answered to somebody who is not yet a member of anything, so it carries the narrow shape.

```json UserSummary
{
  "id": "usr_01a08428-7351-7060-8f6e-7c35b9763cd7",
  "username": "alice",
  "displayName": "Alice"
}
```

A **project** likewise has two views. `Project` is safe to show to a stranger holding a valid invite code. `ProjectMembership` adds the calling user's `role` and is returned wherever the caller is known to be a member.

```json ProjectMembership
{
  "id": "prj_01a08428-7352-705d-94b8-290809badcae",
  "slug": "payments",
  "name": "Payments Platform",
  "createdBy": "usr_01a08428-7351-7060-8f6e-7c35b9763cd7",
  "createdAt": "2026-09-01T09:20:00.000Z",
  "role": "owner"
}
```

`role` is `owner` or `member`. The difference is narrow: any member may create and revoke invites, so `owner` gates only renaming and deleting the project itself, and leaving it when you are the last one.

An **agent** is owned by one user and separately *joins* projects, so project membership is not part of its shape.

```json Agent
{
  "id": "agt_01a08428-7352-705e-ae5b-80deaa5243d5",
  "userId": "usr_01a08428-7351-7060-8f6e-7c35b9763cd7",
  "name": "backend",
  "createdAt": "2026-09-01T09:25:00.000Z",
  "updatedAt": "2026-09-01T09:25:00.000Z"
}
```

`updatedAt` equals `createdAt` if the agent has never been renamed. A soft-deleted agent has no representation: it never appears in a listing, and a request naming it answers `AGENT_DELETED`.

### GET /projects

Every project the caller is a member of, with the caller's own role in each. A project the caller has left is absent, not present with no role.

Response `200`:

```json ListProjectsResponse
{
  "items": [
    {
      "id": "prj_01a08428-7352-705d-94b8-290809badcae",
      "slug": "payments",
      "name": "Payments Platform",
      "createdBy": "usr_01a08428-7351-7060-8f6e-7c35b9763cd7",
      "createdAt": "2026-09-01T09:20:00.000Z",
      "role": "owner"
    }
  ]
}
```

Errors: `AUTH_REQUIRED`, `INTERNAL`.

### POST /projects

Request:

```json CreateProjectRequest
{ "name": "Payments Platform", "slug": "payments" }
```

`slug` is optional; when omitted the server derives one from `name`. When supplied it is used verbatim, and a slug already in use is a `CONFLICT` rather than a silently suffixed near-miss — the caller may be about to commit it to `.agentchat/config.json` and needs to know which project that file will resolve to.

Response `200` — `ProjectMembership`, with `role` always `owner`. It is carried by the shared membership shape rather than asserted separately, so a client renders a project list and a freshly created project through one code path.

Errors: `BAD_REQUEST` (name or slug fails its grammar), `CONFLICT` (slug taken), `AUTH_REQUIRED`, `INTERNAL`.

### GET /projects/:id

Response `200` — `ProjectMembership`.

Errors: `BAD_REQUEST` (the path segment is not a well-formed `prj_` id), `NOT_FOUND` (no such project **or** not a member — indistinguishable), `AUTH_REQUIRED`, `INTERNAL`.

### POST /projects/:id/leave

Request: `{}`. Response `200`: `{}`.

Errors: `BAD_REQUEST`, `NOT_FOUND`, `CONFLICT` (you are the only owner; make another member an owner first), `AUTH_REQUIRED`, `INTERNAL`.

### GET /projects/:id/agents

Project agent discovery: who else is here, and are they listening. Includes the caller's own agents; excludes soft-deleted ones.

Response `200`:

```json ListProjectAgentsResponse
{
  "items": [
    {
      "agent": {
        "id": "agt_01a08428-7352-705e-ae5b-80deaa5243d5",
        "userId": "usr_01a08428-7351-7060-8f6e-7c35b9763cd7",
        "name": "backend",
        "createdAt": "2026-09-01T09:25:00.000Z",
        "updatedAt": "2026-09-01T09:25:00.000Z"
      },
      "owner": {
        "id": "usr_01a08428-7351-7060-8f6e-7c35b9763cd7",
        "username": "alice",
        "displayName": "Alice"
      },
      "online": true,
      "sessions": 2,
      "runtimes": ["claude-code", "codex"]
    }
  ]
}
```

`online` is derived, not stored: it means the agent has at least one `active` session in this project. The invariant `online === (sessions > 0)` holds. `sessions` is carried anyway, because "online" alone cannot tell a user that the listener they thought they killed is still running.

`runtimes` is the set of distinct `runtime` values the agent's *active* sessions in this project declared, sorted, with duplicates and unknowns removed. It is presence metadata and belongs with `online`, not inside `agent`: an agent's identity survives changing its harness, and a client that reads a runtime off the agent is treating something that changes tomorrow as part of a name that does not.

Five things follow from that, and a client should rely on all of them:

- **It is a set, not a list of sessions.** Two `claude-code` listeners are one entry, so `runtimes.length` is often smaller than `sessions` and never larger. To ask which listener is which, use `GET /sessions` — which only ever answers about your own.
- **It may be empty for an online agent.** `runtime` is optional on the session row, so a listener that declared none contributes nothing here. Empty means nothing is known, never that nothing is running; that is what `online` is for.
- **The values are uninterpreted.** The server stores whatever `listen --runtime` was given and hands it back verbatim, so a name this document does not mention is a harness released after it. Display it; do not switch on it.
- **Every member of the project sees it.** This is a disclosure, not private metadata: any member who can call this endpoint reads the runtimes of every other member's agents, exactly as they already read `online` and `sessions`. Nothing derives the value — it is the string the operator handed `listen --runtime` — so it discloses precisely what that operator chose to disclose, and a name is worth picking on that basis. `claude-code` names a harness; `alice-laptop-fork-v3` names rather more.
- **No machine is named.** That disclosure is also the whole of it. Discovery says who is reachable and what is running them; which host somebody else's agent runs on is not part of reachability, is not carried in this response, and cannot be recovered from it.

A server older than this field omits the key. Treat that as the empty set.

Errors: `BAD_REQUEST`, `NOT_FOUND`, `AUTH_REQUIRED`, `INTERNAL`.

### POST /projects/:id/invites

Mints an invite code. **Any member may do this, not only an owner.**

Request: `{}`. Expiry (seven days) and unlimited uses are server policy, not caller-supplied; `expiresIn` and `maxUses` are the obvious future fields, and an empty object is what lets them be added without a version bump. A body with fields in it is dropped.

Response `200`:

```json CreateInviteResponse
{
  "id": "inv_01a08428-7352-7062-89e4-2f606b31e611",
  "code": "ANET-7K4M-Q2P9",
  "expiresAt": "2026-09-16T09:30:00.000Z"
}
```

**This is the only place an invite identifier is ever disclosed.** No endpoint lists invites, so a caller that discards `id` has no way to revoke the code it just minted short of the database. The identifier is not a second credential: it names a row, cannot be redeemed, and every route that takes one asserts project membership first.

`id` is *optional in the schema and always sent by this server*. A client may be talking to a server older than the revoke route, which sends only `code` and `expiresAt`; declaring it required would make that pairing fail at the parser rather than at the feature.

Errors: `BAD_REQUEST`, `NOT_FOUND`, `AUTH_REQUIRED`, `INTERNAL`.

### GET /invites/:code

Previews what a code would join you to, so a client can confirm before joining. Authenticated, but answered to somebody who is not a member of the project — which is why it carries the outsider-safe shapes: a project with no role, and a user with no email.

Response `200`:

```json InvitePreviewResponse
{
  "project": {
    "id": "prj_01a08428-7352-705d-94b8-290809badcae",
    "slug": "payments",
    "name": "Payments Platform",
    "createdBy": "usr_01a08428-7351-7060-8f6e-7c35b9763cd7",
    "createdAt": "2026-09-01T09:20:00.000Z"
  },
  "invitedBy": {
    "id": "usr_01a08428-7351-7060-8f6e-7c35b9763cd7",
    "username": "alice",
    "displayName": "Alice"
  }
}
```

Errors: `BAD_REQUEST` (the code is not `[A-Za-z0-9-]{1,64}`), `INVITE_INVALID` (404 — unknown, expired, revoked or exhausted, indistinguishably), `AUTH_REQUIRED`, `INTERNAL`.

### POST /invites/:code/join

Request: `{}`. The code is in the path.

Response `200`:

```json JoinProjectResponse
{
  "project": {
    "id": "prj_01a08428-7352-705d-94b8-290809badcae",
    "slug": "payments",
    "name": "Payments Platform",
    "createdBy": "usr_01a08428-7351-7060-8f6e-7c35b9763cd7",
    "createdAt": "2026-09-01T09:20:00.000Z",
    "role": "member"
  }
}
```

The project comes back so a client can print "joined" without a second round trip. `role` is always `member`; joining never confers ownership. **Joining a project you are already in is a success with your existing role, not a `CONFLICT`** — you asked to be a member and you are one.

Errors: `BAD_REQUEST`, `INVITE_INVALID`, `AUTH_REQUIRED`, `INTERNAL`.

### DELETE /projects/:id/invites/:inviteId

Revokes an invite. **Any member of the project may revoke any of its invites** — the same rule as creating one. An invite is a hole in the project's perimeter and every member bears its consequences equally; a project where any member can open a door and only some can close one has its permissions backwards.

Addressed by identifier rather than by code, because revoking by code would put a live bearer credential into a URL, a proxy log and a shell history in order to destroy it.

Response `200`: `{}`. **Idempotent** — revoking twice succeeds, and the recorded revocation instant stays the first one.

Errors: `BAD_REQUEST` (either identifier malformed, including a project id in the invite position), `NOT_FOUND` (no such invite *of this project*, indistinguishably from one that never existed), `AUTH_REQUIRED`, `INTERNAL`.

### GET /agents

The caller's own agents, never soft-deleted ones. To see another member's agents, use `GET /projects/:id/agents`.

Response `200`:

```json ListAgentsResponse
{
  "items": [
    {
      "id": "agt_01a08428-7352-705e-ae5b-80deaa5243d5",
      "userId": "usr_01a08428-7351-7060-8f6e-7c35b9763cd7",
      "name": "backend",
      "createdAt": "2026-09-01T09:25:00.000Z",
      "updatedAt": "2026-09-01T09:25:00.000Z"
    }
  ]
}
```

Errors: `AUTH_REQUIRED`, `INTERNAL`.

### POST /agents

Request:

```json CreateAgentRequest
{ "name": "backend" }
```

No project: an agent is created and *then* joined to projects, which is what lets one agent participate in several.

Response **`201`** — the created `Agent`.

Errors: `BAD_REQUEST` (name fails the grammar), `CONFLICT` (a live agent of yours already has that name; a name freed by deleting an agent is available again), `AUTH_REQUIRED`, `INTERNAL`.

### PATCH /agents/:id

Request:

```json RenameAgentRequest
{ "name": "backend-api" }
```

`name` is required despite the method being `PATCH`: the endpoint has exactly one field and a patch with nothing in it is a request the server cannot act on.

Response `200` — the whole `Agent`, `updatedAt` bumped, so a client refreshes from the response rather than patching its own copy and hoping the server agreed.

Errors: `BAD_REQUEST`, `NOT_FOUND` (no such agent, or not yours), `AGENT_DELETED`, `CONFLICT`, `AUTH_REQUIRED`, `INTERNAL`.

### DELETE /agents/:id

Soft delete. The agent's `deleted_at` is set, its sessions are ended and its project memberships dropped; historical messages keep referencing it, and the name becomes reusable. A later request naming it answers `AGENT_DELETED`, not `NOT_FOUND`, because the caller demonstrably had a valid identifier and the remedy is different.

Response `200`: `{}`. The deleted agent is not echoed back — a representation of it would only invite a client to keep rendering something that is gone.

Errors: `BAD_REQUEST`, `NOT_FOUND`, `AGENT_DELETED` (already deleted), `AUTH_REQUIRED`, `INTERNAL`.

### POST /agents/:id/projects

Request:

```json AddAgentToProjectRequest
{ "projectId": "prj_01a08428-7352-705d-94b8-290809badcae" }
```

The caller must own the agent **and** be a member of the project. Owning the agent is not enough — that would let anyone add their agent to any project whose identifier they had seen.

Response `200`: `{}`. Idempotent.

Errors: `BAD_REQUEST`, `NOT_FOUND`, `AGENT_DELETED`, `AUTH_REQUIRED`, `INTERNAL`.

### DELETE /agents/:id/projects/:pid

Removes the agent from the project and ends its sessions there. Messages already sent keep referencing it.

Response `200`: `{}`. Idempotent.

Errors: `BAD_REQUEST` (including an agent id in the project position), `NOT_FOUND`, `AGENT_DELETED`, `AUTH_REQUIRED`, `INTERNAL`.

---

## 7. HTTP: sessions

A **session** is one `agentchat listen` process's registration: an agent, in a project, on a machine. It is what a WebSocket binds to, and it is what presence is computed from.

Sessions have three states:

| Status | Meaning |
|--------|---------|
| `active` | Heartbeating. The only status that counts as present. |
| `stale` | Silent for longer than 60 s. Not present. A stale session may not bind a socket. |
| `ended` | Finished, by teardown or by the sweep. Terminal. |

Sessions expire by being swept, not by being told: a listener's process is normally killed rather than shut down, so `DELETE /sessions/:id` is a courtesy. The server sweeps roughly every 20 s, marking `active` sessions with no heartbeat for 60 s as `stale`, and ending sessions silent for 60 s + 24 h.

### POST /sessions

Registers a listener.

```json RegisterSessionRequest
{
  "agentId": "agt_01a08428-7352-705e-ae5b-80deaa5243d5",
  "projectId": "prj_01a08428-7352-705d-94b8-290809badcae",
  "machine": { "name": "alice-laptop" },
  "runtime": "claude-code",
  "workingDirectory": "/Users/alice/src/payments"
}
```

- The agent must be the caller's own and must already be in the project.
- `machine` is a nested object with one field rather than a flat `machineName`, because a machine will acquire more attributes (an operating system, an architecture) long before it acquires a second identifier — and adding a field to an object is additive, while promoting a string to an object is not. Machines are upserted by `(user, hostname)`; the hostname is stored, never resolved or connected to.
- **`runtime` is required**, though the plan marks it optional and the column behind it is nullable. The invoking agent knows its own runtime; anything the server guessed would be wrong metadata presented as authoritative in discovery. Free-form: `codex`, `claude-code`, `opencode`, …
- `workingDirectory` is stored verbatim and never interpreted.

Response `200`:

```json RegisterSessionResponse
{ "sessionId": "ses_01a08428-7352-705f-98c1-53d8ef82d55d" }
```

Exactly this and nothing more: the client needs the identifier for its WebSocket `hello` and already knows every other field, having just sent them. Fields may be added later without a major version.

Errors: `BAD_REQUEST`, `NOT_FOUND` (no such agent or project, or not yours), `AGENT_DELETED`, `AGENT_NOT_IN_PROJECT`, `AUTH_REQUIRED`, `INTERNAL`.

### POST /sessions/:id/heartbeat

The HTTP fallback for liveness. The WebSocket is the primary channel; this exists for a client that holds a session without a socket, or whose socket is between reconnects.

Response `200`:

```json HeartbeatSessionResponse
{ "status": "active", "lastSeenAt": "2026-09-09T12:34:56.789Z" }
```

The status is returned because a heartbeat can *change* it: a session that had gone stale is active again, and a listener that has been unreachable wants to know its presence was restored rather than assume it. `lastSeenAt` comes from the database clock, not the caller's.

Errors: `BAD_REQUEST`, `NOT_FOUND` (no such session, or not one you can use), `CONFLICT` (the session has ended — start a new one), `AUTH_REQUIRED`, `INTERNAL`.

### DELETE /sessions/:id

Ends a session.

Response `200`:

```json EndSessionResponse
{ "status": "ended", "endedAt": "2026-09-09T12:40:00.000Z" }
```

`endedAt` is the instant the session *first* ended, not the instant of this call, so a retried teardown and a session the sweeper got to first both report the truth.

Errors: `BAD_REQUEST`, `NOT_FOUND`, `AUTH_REQUIRED`, `INTERNAL`.

### GET /sessions

Diagnostics. Lists the caller's own sessions, newest first.

Query parameters, all optional and all narrowing only:

| Parameter | Meaning |
|-----------|---------|
| `projectId` | Restrict to one project. |
| `agentId` | Restrict to one agent. |
| `includeEnded` | Include ended sessions. Only the exact string `true` enables it; every other value, `false` included, leaves it off rather than failing the request. |

The listing is scoped to the caller's own agents inside the query, so a stranger's `agentId` yields an empty list rather than a refusal that would confirm the identifier exists. That rule matters more here than on a lookup: agent and project identifiers are printed by every discovery listing, and these rows carry machine names and working directories — which say where somebody works and on what — so a `403` would turn diagnostics into an oracle for which identifiers are real.

Ended sessions are excluded by default because one row accumulates per `listen` invocation and never becomes interesting again.

Response `200`:

```json ListSessionsResponse
{
  "items": [
    {
      "id": "ses_01a08428-7352-705f-98c1-53d8ef82d55d",
      "agentId": "agt_01a08428-7352-705e-ae5b-80deaa5243d5",
      "projectId": "prj_01a08428-7352-705d-94b8-290809badcae",
      "machineName": "alice-laptop",
      "runtime": "claude-code",
      "workingDirectory": "/Users/alice/src/payments",
      "startedAt": "2026-09-09T12:00:00.000Z",
      "lastSeenAt": "2026-09-09T12:34:56.789Z",
      "endedAt": null,
      "status": "active"
    }
  ]
}
```

`machineName` rather than a bare `mch_` identifier: the only reason machines are modelled at all is so a client can say which laptop a session belongs to. `runtime` is nullable only for rows this API did not write.

`status` is the stored lifecycle value, not an `online` boolean. Telling `active` from `stale` is the point of the endpoint: a listener that is registered and has stopped answering is the failure this protocol is debugged for most often, and it looks exactly like a healthy one to anything that only counts. Presence — `online` on a discovery row — is `active` only, and a client computing it from this listing must filter the same way.

This list is enveloped but **not paged**: there is no `nextCursor`. Adding one later is additive, which is the entire reason it is an envelope.

Errors: `BAD_REQUEST`, `AUTH_REQUIRED`, `INTERNAL`.

---

## 8. HTTP: messages and conversations

### 8.1 The message representation

One shape for a send, a replay and a history read, because they are one thing.

```json Message
{
  "id": "msg_01a08428-7352-7061-a57d-85ec772685b9",
  "projectId": "prj_01a08428-7352-705d-94b8-290809badcae",
  "conversationId": "cnv_01a08428-7352-7060-a185-2fa18daa08aa",
  "parentMessageId": null,
  "senderAgentId": "agt_01a08428-7352-705e-ae5b-80deaa5243d5",
  "recipientAgentId": "agt_01a08429-0039-701e-85d7-cb31a2155d1b",
  "content": "The migration is ready for review.",
  "createdAt": "2026-09-09T12:05:00.000Z"
}
```

- `parentMessageId` is `null` for a thread root, never absent.
- `content` is **uninterpreted**. The server never parses, inspects, or reasons about it. There is no schema for it and there never will be.
- `createdAt` is when the server accepted it, and is the authority for anything a human reads.
- `clientMessageId` is deliberately **not** on this shape: the only party who knows a message's idempotency key is the sender, who chose it.

Note that the WebSocket `message` frame carries a *different* payload shape — `messageId` rather than `id`, plus a `sender` handle. See [§9.4](#94-server--client-frames).

### POST /messages

```json SendMessageRequest
{
  "projectId": "prj_01a08428-7352-705d-94b8-290809badcae",
  "senderAgentId": "agt_01a08428-7352-705e-ae5b-80deaa5243d5",
  "recipientAgentId": "agt_01a08429-0039-701e-85d7-cb31a2155d1b",
  "content": "The migration is ready for review.",
  "clientMessageId": "01JB2QK7X8N4V6ZC3T9M5PWRD0",
  "conversationId": "cnv_01a08428-7352-7060-a185-2fa18daa08aa",
  "parentMessageId": "msg_01a08429-0039-701f-ae21-6bfbc59829ff"
}
```

Rules the server applies:

- The caller must be a member of the project.
- `senderAgentId` must be an agent the caller owns, and it must be in the project.
- `recipientAgentId` must be in the same project.
- `conversationId`, if given, must be a thread the caller is party to. `parentMessageId`, if given, must be a message the caller may read; the reply inherits that message's conversation. **If both are given they must agree** — a reply that names a conversation other than its parent's is a `BAD_REQUEST`, refused rather than silently resolved in one field's favour. Neither is required: omit both and the server opens a new thread.
- `content` is capped at 1 048 576 **bytes of UTF-8**, measured in bytes rather than UTF-16 code units. Over the cap is `PAYLOAD_TOO_LARGE`, and the message names the actual byte count, because the remedy depends on it — a caller forty bytes over splits differently from one forty times over. A client that wants to refuse early should measure the same way.
- `clientMessageId` is 1 to 200 characters. Outside that range is a `BAD_REQUEST`.

**Idempotency.** `clientMessageId` is minted once per logical send and repeated on every retry. A repeat returns the **original message**, not an error:

| Status | Meaning |
|--------|---------|
| `201` | This call wrote the message. |
| `200` | The `clientMessageId` matched one this sender had already sent; the body is that original message. |

The status line is the *only* place the difference is reported. There is no `duplicate` flag in the body — one fact in one place, so a client cannot branch on the copy that contradicts the other. Treating a retry as a failure would force a caller to choose between reporting a failure that did not happen and sending the message twice.

**The key is scoped to `(senderAgentId, clientMessageId)`**, and the *rest of the request is not consulted*. Two agents may pick the same string and neither is a duplicate of the other. But a sender that reuses a key for genuinely different content gets `200` and the **original** message back — its new content is silently not sent, and there is no error to notice. So mint a fresh key per distinct message, from something with no reuse risk (a UUID, a ULID), and reuse it only when retrying that same message.

The idempotency lookup happens *after* the caller is proved to own the sending agent, so it cannot be used to ask what some other agent sent under a guessed key.

Response body: `Message`.

Errors: `BAD_REQUEST`, `PAYLOAD_TOO_LARGE`, `NOT_FOUND`, `AGENT_DELETED`, `AGENT_NOT_IN_PROJECT`, `AUTH_REQUIRED`, `INTERNAL`. Notably **not** `CONFLICT`: a send has no collision case, because a repeated idempotency key is answered with the original message rather than refused.

### GET /messages

The inbox: what an agent still owes an acknowledgement for, in one project, oldest first.

| Query parameter | Required | Meaning |
|-----------------|----------|---------|
| `projectId` | yes | Which project's queue. Half of the routing key. |
| `agentId` | yes | Whose queue. Must be an agent the caller owns, in that project. |
| `status` | no | `pending` (the default) or `all`. |
| `limit` | no | Page size. Default 100, clamped to 500. |
| `after` | no | Resume after this `msg_` id, exclusive. A previous page's `nextCursor`. |

The routing key is `(agent, project)` and **not the session**: a message is owed by the *agent*, so one queue answers however many listeners that agent is running, and whichever of them asks.

Response `200`:

```json ListMessagesResponse
{
  "items": [
    {
      "id": "msg_01a08428-7352-7061-a57d-85ec772685b9",
      "projectId": "prj_01a08428-7352-705d-94b8-290809badcae",
      "conversationId": "cnv_01a08428-7352-7060-a185-2fa18daa08aa",
      "parentMessageId": null,
      "senderAgentId": "agt_01a08428-7352-705e-ae5b-80deaa5243d5",
      "recipientAgentId": "agt_01a08429-0039-701e-85d7-cb31a2155d1b",
      "content": "The migration is ready for review.",
      "createdAt": "2026-09-09T12:05:00.000Z"
    }
  ],
  "nextCursor": null
}
```

Ordering is by `msg_` identifier, which is chronological because the suffix is a UUIDv7 assigned in the same transaction that writes the row. It is also the cursor: `createdAt` is not unique and could not page without a tiebreak.

**`status=all` is refused by this build**, with a `BAD_REQUEST` that names which half is missing rather than quietly serving `pending`. The historical listing is specified and unimplemented; a client should surface that difference rather than swallow it. The plan's `since=` filter is likewise parsed only in order to be refused — sending it is a `BAD_REQUEST`, even alongside `status=pending`.

Errors: `BAD_REQUEST` (malformed query, `limit` not a positive integer, `status=all`, or `since` present), `NOT_FOUND`, `AGENT_DELETED`, `AGENT_NOT_IN_PROJECT`, `AUTH_REQUIRED`, `INTERNAL`.

### POST /messages/:id/ack

Clears one message from an agent's queue.

```json AcknowledgeMessageRequest
{
  "agentId": "agt_01a08429-0039-701e-85d7-cb31a2155d1b",
  "projectId": "prj_01a08428-7352-705d-94b8-290809badcae",
  "sessionId": "ses_01a08428-7352-705f-98c1-53d8ef82d55d"
}
```

> **This differs from the implementation plan.** Plan §3 writes the body as `{ agentId, sessionId? }`. **`projectId` is required.** The inbox is keyed on `(agent, project)`, so an acknowledgement without a project is not answerable — and deriving one by reading the message first would mean a read that happens *before* the rule that decides whether the caller may read it. The plan is amended by this document.

`sessionId` is optional because an acknowledgement may come from a plain HTTP client that holds no session at all. The acknowledgement is the *agent's*; the session is recorded for diagnostics and never consulted.

Response `200`:

```json AcknowledgeMessageResponse
{
  "messageId": "msg_01a08428-7352-7061-a57d-85ec772685b9",
  "alreadyAcknowledged": false,
  "acknowledgedAt": "2026-09-09T12:05:30.000Z",
  "acknowledgedBySessionId": "ses_01a08428-7352-705f-98c1-53d8ef82d55d"
}
```

- `alreadyAcknowledged` is **reported, not raised**. A repeat is the expected shape of a retry and of an acknowledgement racing a replay. A client may log the difference and **must never treat it as a failure**; a harness that retries will hit it constantly, by design.
- `acknowledgedAt` is when the debt was *first* settled, so a retry does not appear to settle it again.
- `acknowledgedBySessionId` is `null` when no session was named, or when the one named no longer exists.

Acknowledging a message that is not owed to this agent in this project is `NOT_FOUND` — the same answer as a message that does not exist, so the endpoint cannot confirm somebody else's message to whoever guessed its identifier.

Errors: `BAD_REQUEST`, `NOT_FOUND`, `AGENT_DELETED`, `AGENT_NOT_IN_PROJECT`, `AUTH_REQUIRED`, `INTERNAL`.

### GET /conversations/:id

Reads one thread.

| Query parameter | Meaning |
|-----------------|---------|
| `limit` | Page size. Default 100, clamped to 500. |
| `after` | Resume after this `msg_` id, exclusive. |

> **This differs from the implementation plan.** Plan §3 writes the response as `{ conversation, messages[] }` — the thread whole. **The read is paged and the response carries `nextCursor`.** A thread has no upper bound and each message in it may be a megabyte, so an unbounded read is an unbounded allocation driven by a stranger's sending. Adding a field is additive, and a client written against the plan as it stands still reads a correct first page; a client that wants the thread whole follows the cursor.

Response `200`:

```json ReadConversationResponse
{
  "conversation": {
    "id": "cnv_01a08428-7352-7060-a185-2fa18daa08aa",
    "projectId": "prj_01a08428-7352-705d-94b8-290809badcae",
    "createdAt": "2026-09-09T12:05:00.000Z"
  },
  "messages": [
    {
      "id": "msg_01a08428-7352-7061-a57d-85ec772685b9",
      "projectId": "prj_01a08428-7352-705d-94b8-290809badcae",
      "conversationId": "cnv_01a08428-7352-7060-a185-2fa18daa08aa",
      "parentMessageId": null,
      "senderAgentId": "agt_01a08428-7352-705e-ae5b-80deaa5243d5",
      "recipientAgentId": "agt_01a08429-0039-701e-85d7-cb31a2155d1b",
      "content": "The migration is ready for review.",
      "createdAt": "2026-09-09T12:05:00.000Z"
    }
  ],
  "nextCursor": null
}
```

**A page is the caller's view, not the thread.** A caller may read a message only where one of their own agents is sender or recipient, and that rule is applied per message. A conversation may hold messages between agents the caller owns neither end of; those are **absent from the page rather than redacted**, and `nextCursor` counts only what the caller may read, so paging never reveals the size of what it skipped. **A client must not treat a thread's message count as the thread's length.**

Errors: `BAD_REQUEST`, `NOT_FOUND` (no such thread, a thread in another project, or a thread none of your agents is party to — indistinguishably), `AUTH_REQUIRED`, `INTERNAL`.

---

## 9. WebSocket

### 9.1 Connecting

```text
GET /ws
Authorization: Bearer <accessToken>
```

The upgrade is authenticated before any frame is read. No token, no socket.

**Token in a query string.** Browsers and several WebSocket clients cannot set headers on a socket, so an access token may instead be sent as `?access_token=<token>` — the parameter name from RFC 6750 §2.3. Four things about it:

- **The header wins.** The query parameter is read only when there is no `Authorization` header at all. A present-but-unusable header is a refusal, not a reason to look in the URL.
- The server redacts the parameter before logging the URL, but *your* proxies and access logs will not. Prefer the header wherever you can set one.
- A socket authenticated this way is logged at `warn`, so an operator can see which clients do it.
- Only the access token — never the refresh token — may travel this way. The blast radius of a leaked URL is one hour of one user's sockets.

A refused upgrade that has not yet completed the handshake is answered `401` with `WWW-Authenticate: Bearer`. One that has is closed with `4401`.

### 9.2 The handshake

```text
  client                                    server
    │                                         │
    ├── upgrade with bearer token ───────────▶│  authenticate
    │                                         │
    ├── {"type":"hello","sessionId":"ses_…"} ▶│  bind: session must exist,
    │                                         │        be active, and be yours
    │◀── {"type":"message", …}  (replay 1) ───┤
    │◀── {"type":"message", …}  (replay n) ───┤
    │◀── {"type":"ready","pending":n} ────────┤  you are caught up
    │                                         │
    │◀── {"type":"message", …}  (live) ───────┤
    ├── {"type":"ack","messageId":"msg_…"} ──▶│
    │                                         │
    ├── {"type":"ping"} ─────────────────────▶│
    │◀── {"type":"pong"} ─────────────────────┤
```

**`hello` must be the first frame, and may be sent only once.** Any other known frame before it, or a second `hello`, closes the socket with `4409`.

**The session comes from the frame, never from the token.** An access token may carry a session claim; it is not consulted. The claim does not survive a token refresh, so trusting it would refuse precisely the long-running listeners this system exists for — intermittently, an hour into a run. Nothing is lost: the frame's session is checked against the *token's* user, so naming somebody else's session is refused by ownership.

**Replay precedes `ready`.** `ready` means "you are caught up", so it cannot arrive before the catch-up. Everything the agent still owes an acknowledgement for in this session's project is written to the socket first, and `pending` counts what was written.

### 9.3 Client → server frames

Every frame is a JSON object with a string `type`. Frames may be sent as text or as binary UTF-8 — bytes that are not valid UTF-8 cannot be JSON and are refused.

#### `hello`

```json HelloFrame
{
  "type": "hello",
  "sessionId": "ses_01a08428-7352-705f-98c1-53d8ef82d55d",
  "client": "agentchat/0.1.0"
}
```

`client` is the `X-AgentChat-Client` value, optional, at most 128 characters. It was not in the original frame and an older client will not send it — the additive rule applied to the frame's own schema. It is logged, and nothing else.

#### `ack`

```json AckFrame
{ "type": "ack", "messageId": "msg_01a08428-7352-7061-a57d-85ec772685b9" }
```

Equivalent to `POST /messages/:id/ack` for this socket's agent and project, which the binding already knows — which is why the frame carries neither.

There is no reply frame. An acknowledgement that clears nothing — because another of this agent's listeners already cleared it, or because the agent never owed the message at all — is **ignored, not refused**: closing a socket over the harmless end of at-least-once would punish a client for replaying its own unsent acknowledgements after a restart. A failure that is *not* about the debt, on the other hand — the agent has been deleted, or removed from the project — closes the socket with `1011`.

#### `ping`

```json PingFrame
{ "type": "ping" }
```

Answered with `pong` before anything else the server does with it, so liveness never depends on the rest of the pipeline.

### 9.4 Server → client frames

#### `ready`

```json
{
  "type": "ready",
  "sessionId": "ses_01a08428-7352-705f-98c1-53d8ef82d55d",
  "pending": 3
}
```

The handshake is complete, and `pending` messages were replayed *before* this frame.

#### `message`

```json
{
  "type": "message",
  "message": {
    "messageId": "msg_01a08428-7352-7061-a57d-85ec772685b9",
    "projectId": "prj_01a08428-7352-705d-94b8-290809badcae",
    "conversationId": "cnv_01a08428-7352-7060-a185-2fa18daa08aa",
    "parentMessageId": "msg_01a08429-0039-701f-ae21-6bfbc59829ff",
    "senderAgentId": "agt_01a08428-7352-705e-ae5b-80deaa5243d5",
    "sender": "@alice/backend",
    "recipientAgentId": "agt_01a08429-0039-701e-85d7-cb31a2155d1b",
    "content": "The migration is ready for review.",
    "createdAt": "2026-09-09T12:05:00.000Z"
  }
}
```

**Three things differ from the HTTP `Message` shape, and a client implementer needs all three:**

1. The identifier field is **`messageId`**, not `id`.
2. There is a **`sender`** field — the handle as a human reads it, `@alice/backend`. It is a display convenience joined from two other tables, and it is **absent** when the lookup failed or the sender's owner has gone. A message is never held back because a cosmetic lookup failed, so render `senderAgentId` when `sender` is missing.
3. **`parentMessageId` is omitted entirely for a thread root**, rather than sent as `null` — the opposite of the HTTP shape, which sends `null`. Under the additive-only rule an absent field and a field a reader does not know are indistinguishable, which is why the frame omits it. Treat absent and `null` as the same thing.

The same shape goes out whether a message was accepted a millisecond ago or replayed an hour later.

#### `pong`

```json
{ "type": "pong" }
```

#### `error`

```json
{
  "type": "error",
  "code": "SESSION_INVALID",
  "message": "No usable session with that id. Start a new listener with: agentchat listen --runtime <name>"
}
```

Sent immediately **before** every close this server initiates that names a fault — every row in §9.6 with a contract code — so a client that never reads close codes still learns why. `code` is from the same frozen set as HTTP errors.

The two closes that name no fault carry no `error` frame — the `1000` at shutdown and the `4429` of §9.8. They put their explanation in the close frame's own reason instead: `server is shutting down`, and the back-pressure drop.

### 9.5 Unknown frames

A frame whose `type` this server does not know is **ignored**: not answered, not an error, and not a reason to close. The server logs it once per type, so an operator can see that a newer client is talking to an older server.

`type` is a transport operation and never a meaning. There will never be a `type: "review"`, a `type: "task"`, or a `type: "handoff"`. The server routes bytes between agents and has no view about their content; a semantic frame type would be the server forming one. Adding a transport operation — a new acknowledgement mode, a resume token — is an ordinary additive change. Adding a meaning is not a protocol change at all; it is a different product.

### 9.6 Close codes

| Code | Name | Sent when | Error frame code |
|------|------|-----------|------------------|
| 1000 | `NORMAL` | Orderly shutdown by either side: the server shutting down, or the client leaving. | — |
| 1011 | `INTERNAL_ERROR` | The server failed while handling a frame. | `INTERNAL` |
| 4400 | `FRAME_MALFORMED` | Not UTF-8, not JSON, or not a JSON object with a string `type`. | `PROTOCOL_VIOLATION` |
| 4401 | `UNAUTHENTICATED` | No usable access token on the upgrade request. | `AUTH_REQUIRED` |
| 4403 | `SESSION_INVALID` | `hello` named a session that does not exist, is not the caller's, or is not active. | `SESSION_INVALID` |
| 4409 | `FRAME_OUT_OF_ORDER` | A known frame other than `hello` arrived first, or `hello` arrived twice. | `PROTOCOL_VIOLATION` |
| 4413 | `FRAME_TOO_LARGE` | The frame exceeded the 2 MiB limit. | `PAYLOAD_TOO_LARGE` |
| 4422 | `FRAME_INVALID` | A known frame type whose payload failed its schema. | `PROTOCOL_VIOLATION` |
| 4429 | `BACKLOG_UNREAD` | The peer stopped reading and its unread backlog passed the 16 MiB ceiling (§9.8). | — |

**What each means to a client:**

- **1000** — reconnect. A server restart is the usual cause: nothing to fix locally, and the replay on the next `hello` covers anything missed.
- **1011, `INTERNAL`** — reconnect with backoff. Not your fault, and nothing to fix locally.
- **4400, 4422** — a bug in the client. Fix the frame; reconnecting unchanged will fail identically.
- **4401** — the token is missing, expired or invalid. Refresh or log in, then reconnect.
- **4403** — the session is unusable and **will not become usable**. Register a new session with `POST /sessions` and reconnect with the new identifier. Do not retry the same `hello`.
- **4409** — a bug in the client's handshake ordering.
- **4413** — the frame was too large. Send less.
- **4429** — reconnect, and fix the consumer. The replay covers everything missed, but a listener that still is not reading its socket will be dropped again. See §9.8.

The 44xx numbers are in the 4000–4999 range RFC 6455 reserves for private use, and echo the HTTP status a reader already knows: 4400 reads as 400, 4413 as 413. **The pairing is a mnemonic, not a mapping** — nothing converts between them, and three distinct close codes deliberately share one contract code because a client's *remedy* differs (fix your JSON, send `hello` first, populate the field) while the category it reports to its operator does not.

`4429` is the one 44xx code that names no fault, which is why its contract column is `—` and no `error` frame precedes it. It is in the private-use block because the condition is the server's own and 429 is the status a reader already associates with back-pressure, but nothing you *sent* was wrong, and every code in the frozen set would say otherwise.

**One surprise worth stating.** A frame that exceeds the limit is usually rejected by the transport *while it is still being reassembled*, which closes with RFC 6455's **1009**, not 4413. That is the right trade — the check that matters for availability is the one that refuses the bytes before they are all in memory — but a client must handle 1009 as well as 4413, and both mean "send less".

### 9.7 Liveness

A client sends `ping` on a socket that has been silent and expects *any* frame back — the frame having arrived at all is the liveness signal, so a `message` counts as well as a `pong`. The reference client uses a 20 s idle interval and a 20 s answer window, and bounds the handshake (upgrade, `hello`, replay, `ready`) at 15 s.

This matters more than it looks. A TCP connection whose peer has vanished — a laptop that changed networks, a NAT that dropped its mapping — is not closed and never will be. Without a client-side watchdog a listener sits there looking healthy and receiving nothing, and no close code will ever tell it otherwise.

A session with no heartbeat for 60 s is marked `stale` by the server's sweeper and stops counting as present, and **a stale session may not bind a new socket**. A listener that intends to stay present must therefore keep either the socket's `ping` or `POST /sessions/:id/heartbeat` flowing.

At shutdown the server sends the close handshake with 1000 and a reason of `server is shutting down`, and waits briefly for sockets to drain.

### 9.8 A socket you do not read is closed

**The server will not buffer for you indefinitely.** Delivery writes a frame and returns, so a listener that has stopped reading never slows another one down — it accumulates. There is a ceiling on that accumulation: once more than **16 MiB** is queued for a socket and unread, the server closes it with **4429** and the reason `backlog was not being read; reconnect and unacknowledged messages replay`.

This is not a fault on either side, which is why `4429` carries no error code and no `error` frame, unlike every other 44xx close. A listener stops reading for entirely ordinary reasons — a suspended laptop, a runtime paused at a breakpoint, a harness that stopped consuming its subprocess's output — and the alternative to closing it is a server that runs out of memory and drops every *healthy* listener with it.

**Nothing is lost, and that follows from §10.1 rather than from anything special here.** A message is owed until its inbox row says acknowledged. The frame that trips the ceiling has already been written to the socket, so it is unacknowledged whether or not the peer ever reads it, and everything addressed to the agent after the close is unacknowledged too. All of it is replayed on the next `hello`, and `messageId` deduplication — which you need anyway — makes a re-delivered copy harmless.

**Where the number comes from.** The largest burst the server writes at a listener that *is* reading is one replay page: 100 messages go into the socket before the next page is read. Agent traffic is prose and patches, so an ordinary page is well under a megabyte and a pessimistic one of 64 KiB messages is about 6.5 MiB. 16 MiB leaves roughly two and a half times that headroom, and holds eight frames at the maximum frame size, so no single message and no small burst can reach it. A peer that is merely *slow* drains its buffer between writes and never accumulates at all; only one that has stopped gets there.

**What a client should do.** Read the socket. If you cannot process a message immediately, take it off the socket and queue it yourself — acknowledge it once you have durably taken responsibility for it (§10.2), not on receipt. If you are closed this way, reconnect with backoff — and treat the code as a bug report about your own event loop, because a listener that reconnects and still does not read will be closed again. That is what `4429` is for: `1000` would have told you a server restarted, which has the opposite remedy.

---

## 10. Delivery, acknowledgement and replay

### 10.1 At-least-once, deliberately

**A message is owed until its inbox row says acknowledged. Nothing else reduces that debt** — not a successful `POST /messages`, not a delivery the server recorded, not a socket that was open a moment ago.

Every behaviour people expect to be separate features falls out of that one sentence:

| Situation | What happens |
|-----------|--------------|
| Recipient offline at send time | The fan-out reaches nobody. The row stays pending. The next `hello` replays it. This is not an error path; it is the replay case working. |
| Socket dropped mid-delivery | Same row, same replay. |
| Socket closed for an unread backlog (§9.8) | Same row, same replay. Closing a listener that stopped reading is safe *because* of this table. |
| Listener crashed before acknowledging | Same row, same replay. |
| Acknowledgement lost in flight | Same row, same replay — and the message is delivered a second time. |

The order is fixed and structural: **the message row is committed before any delivery attempt.** A row that is not committed is not visible to a peer re-reading it and would vanish if the process died between the write and its confirmation. A fan-out that fails does not fail the send: the message is durable and the inbox will replay it.

On `hello`, the socket is registered in the delivery registry **before** the replay reads anything. The other order looks tidier and loses messages — a send landing between the replay's snapshot and the registration would reach no socket *and* not be in the page just read, and would sit pending until some later reconnect that may never come. Registering first can only cause a duplicate, which costs nothing.

Replay is paged internally, and each page is written to the socket before the next is read, so a week-old backlog does not become a single unbounded allocation. There is no ceiling on the number of pages: stopping early would strand the remainder.

### 10.2 What a client must do about duplicates

**Duplicates are guaranteed, not exceptional.** A listener that reconnects between a send and its acknowledgement is replayed a message it already has; a listener registered during its own replay receives a concurrent send twice. Nothing on the server tries to prevent this, because machinery to suppress a second copy would trade a harmless duplicate for a possible loss.

So:

1. **Deduplicate by `messageId`.** It is the idempotency key. Keep a bounded set of recently seen identifiers — the reference client keeps a fixed-capacity LRU — and drop a message you have already processed. Do not deduplicate on content, sender, or timestamp.
2. **Acknowledge every copy anyway**, or at least treat `alreadyAcknowledged: true` as success. Acknowledging twice is a no-op; not acknowledging is an unbounded replay.
3. **Make the work the message triggers idempotent**, or gate it behind the deduplication set. The protocol promises at-least-once, not exactly-once, and no client-side trick converts one into the other.
4. **Acknowledge after you have durably taken responsibility**, not on receipt. An acknowledgement is a promise that the message will not be needed again; a listener that acknowledges first and crashes second has lost it, and the server cannot know.

Two acknowledgements arriving at once from two sessions of the same agent are safe: one wins, the other reports `alreadyAcknowledged`, and no update is lost.

### 10.3 The routing key

Delivery is keyed on `(agent, project)`, never on the session. One queue answers however many listeners an agent is running, and whichever of them asks. Two listeners for the same agent in the same project both receive a live message, and either may acknowledge it — after which neither is replayed it.

Within one server process the registry is in memory. Fan-out across several server instances is a later concern and is isolated behind an interface; nothing in this document changes when it lands.

### 10.4 Reconnecting

1. Reconnect with backoff and jitter.
2. If the session is still `active`, `hello` with the same `sessionId`.
3. If the socket was closed with **4403**, the session is gone for good: register a new one with `POST /sessions` and `hello` with that.
4. Expect the replay. Expect duplicates in it. `ready` tells you the backlog is behind you.

A listener that has been disconnected long enough for its session to be swept must register a new session; there is no way to revive one.

---

## 11. Outside the contract

### GET /healthz

Unauthenticated. **Deliberately not part of this protocol**, and not the pattern to copy for anything that is.

It reports whether a process should receive traffic, to an orchestrator deployed alongside it. Its body is a status document rather than the error envelope, its failure code is not in the frozen set, and nothing it returns is a promise to a client that upgrades on its own schedule.

`200` when the database round trip succeeds within 2 s:

```json
{ "status": "ok", "checks": { "database": "ok" } }
```

`503` when it does not:

```json
{
  "status": "error",
  "checks": { "database": "error" },
  "error": { "code": "DATABASE_UNAVAILABLE", "message": "The database is not reachable." }
}
```

`DATABASE_UNAVAILABLE` is **not** a member of the frozen `ErrorCode` set and must never be branched on as though it were. The response carries `cache-control: no-store`: a cached health check is worse than no health check.

Do not use this endpoint for anything a client does. It is for load balancers.

---

## 12. How this document is kept honest

**This document is verified against the schemas, not generated from them, and an automated check fails the build when the two disagree.**

Generation was considered and rejected. Most of what an implementer needs from this file is not in the schemas at all: which failures are indistinguishable and why, what a client must do about duplicates, why `ready` follows the replay, which differences from the plan are deliberate. A generator would either omit that — leaving a reference that answers "what are the fields" and none of the questions a client author actually has — or become a template engine whose templates are this prose, unchecked. So the prose is written by hand and the *facts inside it* are asserted against the live code.

The check is `server/tests/protocol-doc.test.ts`. It runs in `pnpm test`, which is a required gate on every pull request and in CI, so no schema change can merge while this file contradicts it. It parses this markdown and asserts:

| Assertion | Fails when |
|-----------|-----------|
| Every `### METHOD /path` heading names a route the assembled server actually registers, and every registered route has such a heading. | An endpoint is added, removed, renamed, or its method changes. |
| Every fenced block tagged `json <SchemaName>` parses against `<SchemaName>Schema`. | Any example drifts from its schema: a renamed field, a new required field, a changed identifier prefix, a narrowed enum, an example that was wrong to begin with. |
| The error-code table lists exactly the codes a client can receive over HTTP, each with the status the server actually maps it to. | A code is added to or removed from the frozen set, or its status changes. |
| Every frozen error code appears somewhere in the document. | A code ships undocumented. |
| The close-code table matches the server's close codes exactly, in both directions. | A close code is added, removed, or renumbered. |
| The documented client frame types match the decoder's accepted set; the documented server frame types match the `ServerFrame` union. | A frame type is added or renamed. Server frames are checked at compile time as well: the test's list is typed against the union, so `pnpm typecheck` fails first. |
| The `message` frame's documented payload keys match `MessageEnvelope`. | The delivered payload gains, loses, or renames a field. Also compile-time-checked. |
| The limits table matches the constants. | A cap or a page size changes. |
| The version constants quoted in §2 match `PROTOCOL_VERSION` and `MIN_CLIENT_VERSION`. | Either moves. |

Two conventions make that possible, and an author editing this file must keep them:

- **Endpoint headings are exactly `### METHOD /path`**, with the server's own path syntax including `:params` and no backticks. A heading that mentions an endpoint some other way — as `` `GET /version` `` in [§13](#13-what-this-build-does-not-serve-yet), for instance — is deliberately invisible to the check, which is what lets this file discuss an endpoint that is not served.
- **A JSON example that has a schema is tagged with it**: the fence reads ` ```json SendMessageRequest `, naming the exported schema without its `Schema` suffix. Renderers use the first word and ignore the rest, so this costs nothing visually. An example with no schema — the server-to-client frames, whose payloads are TypeScript types rather than zod schemas — is a plain ` ```json ` block and is checked structurally instead.

**What the check cannot see.** It compares shapes and names, not meanings. Repurposing a field while its shape stays identical is invisible to it, exactly as it is invisible to the snapshot guard — and it is still a breaking change requiring a major bump. It also cannot verify the prose: that duplicates are described correctly, that a remedy is the right remedy. Those are review's job, and §7.6 of the subagent protocol is the rule that brings them to review: *a change to the wire protocol updates `docs/protocol.md` in the same pull request.*

**The other half of the guard.** `pnpm protocol:check` compares the live schemas against `scripts/protocol-snapshot.json`, a committed flat map of the wire contract, and fails on anything removed or narrowed. A deliberate break costs a `PROTOCOL_VERSION` bump, an explicit `--accept-breaking`, and a written reason recorded in the snapshot's ledger where a reviewer reads it next to the diff. That guard protects the contract; this document's check protects the description of it. Together they mean a field cannot change quietly, and cannot change loudly without this file changing too.

### 12.1 Limits and constants

| Constant | Value | What it bounds |
|----------|-------|----------------|
| `MAX_MESSAGE_CONTENT_BYTES` | 1048576 | Message content, in bytes of UTF-8. |
| `MAX_CLIENT_MESSAGE_ID_LENGTH` | 200 | `clientMessageId`, in characters. |
| `MAX_FRAME_BYTES` | 2097152 | One WebSocket frame, in bytes. The same number as the HTTP body limit. |
| `MAX_CLOSE_REASON_BYTES` | 123 | The close reason, in bytes of UTF-8. Longer reasons are truncated at a code point boundary. |
| `DEFAULT_PENDING_LIMIT` | 100 | `GET /messages` page size when `limit` is omitted. |
| `MAX_PENDING_LIMIT` | 500 | `GET /messages` page size ceiling. A larger `limit` is clamped, not refused. |
| `DEFAULT_CONVERSATION_LIMIT` | 100 | `GET /conversations/:id` page size when `limit` is omitted. |
| `MAX_CONVERSATION_LIMIT` | 500 | `GET /conversations/:id` page size ceiling. |
| `ACCESS_TOKEN_TTL_SECONDS` | 3600 | Access token lifetime. |
| `REFRESH_TOKEN_TTL_SECONDS` | 7776000 | Refresh token lifetime. |
| `HEARTBEAT_TIMEOUT_SECONDS` | 60 | Silence after which an active session is stale. |
| `STALE_SESSION_LIFETIME_SECONDS` | 86400 | How long a session may stay stale before it is ended. |

---

## 13. What this build does not serve yet

One endpoint is specified — it has a schema in `packages/protocol`, and `@agentchat/client` has a method for it — but **no route in this build answers it**, and a request gets `404` with `NOT_FOUND` from the catch-all handler. It is listed so that a client author is not left to discover it by experiment.

| Endpoint | Consequence for a client |
|----------|--------------------------|
| `GET /version` | Version negotiation cannot be performed against this build. Assume the protocol version you were built against. |

Two related gaps in the same area:

- **`UPGRADE_REQUIRED` is never issued.** The server accepts `X-AgentChat-Client` and does not read it, so no client is refused for being too old. Send the header regardless: it costs nothing and a later build will read it.
- **`GET /messages?status=all` and `since=` are refused**, with a `BAD_REQUEST` naming the missing half. Only the pending queue is answered. See [§8](#get-messages).

Everything else in this document is served by this build, and the check in [§12](#12-how-this-document-is-kept-honest) is what keeps that sentence true.
