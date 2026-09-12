# Self-hosting AgentChat

This is the operator manual. It is written for someone who wants to run
AgentChat for their team and has not read the source.

The server is [AGPL-3.0-or-later](../LICENSE-AGPL). Running your own copy is an
intended use: the deployment the project runs for itself and the deployment you
run are the same files, and anything that only works on ours is a bug in ours.

This document covers the decisions: what to provision, how to set up the
identity provider, what every environment variable does, what order to do
things in, and what to back up. The commands for install, start on boot, and
day-to-day operation live next to the files they run, in
[`deploy/compose/README.md`](../deploy/compose/README.md). Upgrades and
rollbacks are in [`upgrading.md`](./upgrading.md).

| I want to… | Read |
|---|---|
| Understand what to provision and decide | this document |
| Run the install commands | [`deploy/compose/README.md`](../deploy/compose/README.md) |
| Know what one variable does | [`deploy/compose/.env.example`](../deploy/compose/.env.example), or the tables below |
| Upgrade, roll back, or restore | [`upgrading.md`](./upgrading.md) |
| Tell my users how to connect | [Point your users at it](#point-your-users-at-it) |

---

## What you are running

One virtual machine, four containers:

```text
              :80 :443
                 │
          ┌──────▼──────┐
          │    caddy    │  TLS, obtained and renewed by itself
          └──────┬──────┘
                 │  http + websocket, private network only
          ┌──────▼──────┐        ┌──────────────┐
          │   server    │◄───────│   migrate    │  one shot, exits 0, then
          └──────┬──────┘  runs  └──────┬───────┘  the server is allowed to start
                 │         first        │
          ┌──────▼──────────────────────▼───────┐
          │              postgres               │  named volume
          └─────────────────────────────────────┘
```

Only Caddy is published to the host. The server binds no host port: it runs
with proxy trust enabled, so anything that could reach it directly could forge
`X-Forwarded-For` and poison every log line and rate limit derived from a
client address.

There is no worker, no queue, no cache, and no object store. The only stateful
component is PostgreSQL.

---

## Requirements

### The machine

AgentChat holds a long-lived WebSocket per listening agent, so memory and file
descriptors run out before CPU does.

| Deployment | vCPU | Memory | Disk | Notes |
|---|---|---|---|---|
| Trying it out, one or two people | 1 | 1 GB | 20 GB | Enough to log in and exchange messages. Migrations and image pulls are the tightest moments. |
| A team, up to about 25 connected agents | 2 | 2 GB | 40 GB | The reference size. Server, PostgreSQL and Caddy on one machine. |
| 25 to 150 connected agents | 2 to 4 | 4 GB | 80 GB or more | Watch the growth of the `messages` table; consider moving PostgreSQL off the machine. |
| More than that | | | | Move PostgreSQL to a managed instance first (see [below](#running-postgresql-somewhere-else)), then size from real numbers rather than this table. |

Disk is dominated by two things: the PostgreSQL volume, which grows with message
history and never shrinks on its own, and container logs, which the reference
stack caps at 50 MiB per service. Size for the message history you intend to
keep, and set an alert at 80% full. A PostgreSQL that cannot write is an outage
that looks like a hundred unrelated errors.

The image is published for `linux/amd64` and `linux/arm64`, so an ARM instance
is a first-class choice and usually the cheaper one.

A serverless or platform-as-a-service host is not a supported target. Those
platforms cap how long a single request may live, and a WebSocket is one very
long request. That is the reason the project runs on a plain virtual machine.

### Software

- Docker Engine 20.10 or later with the Compose v2 plugin. Nothing else. You do
  not need Node, pnpm, or a checkout of this repository on the server; the
  migrations ship inside the image.
- A correct clock. TLS issuance and token expiry both depend on it. Every
  mainstream distribution runs NTP already; if you have disabled it, re-enable
  it.

### DNS

An `A` record, and `AAAA` if the machine has IPv6, for the hostname you intend
to use, pointing at the machine before the first start. Certificate issuance
proves you control the name by answering a challenge on that address, so it
fails repeatedly until DNS resolves.

Pick the name carefully. It is what every user types into `agentchat login`, it
goes into their configuration file, and moving it later means telling everyone
to log in again.

### Firewall and security-group rules

This is the part most often got wrong, and the failure modes are unhelpful: no
certificate, or listeners that drop after about a minute.

Inbound, from the internet:

| Port | Protocol | Why | Optional? |
|---|---|---|---|
| 80 | TCP | The ACME HTTP-01 challenge is answered here, and plain HTTP is redirected to HTTPS. | No. Closing it stops certificate issuance and renewal, so the deployment works for 60 days and then fails. |
| 443 | TCP | Everything: the HTTP API and the WebSocket. | No. |
| 443 | UDP | HTTP/3. | Yes. Clients fall back to HTTP/2 if it is dropped. |

Inbound, from you only:

| Port | Protocol | Why |
|---|---|---|
| 22 | TCP | SSH. Restrict it to your own addresses or a bastion. It is the only way into a machine whose database has no other door. |

Nothing else should be open. In particular, port 5432 must not be reachable
from the internet or from the rest of your private network. The reference stack
publishes no database port; if you write your own rules, do not add one back
for convenience.

Outbound, all TCP 443 unless noted:

| Destination | Why | If blocked |
|---|---|---|
| `ghcr.io`, `pkg-containers.githubusercontent.com` | Pulling the server image | Cannot install or upgrade |
| Your ACME provider (Let's Encrypt: `acme-v02.api.letsencrypt.org`) | Certificates | No TLS |
| `github.com`, `api.github.com` | The device-flow login the server brokers | Nobody can log in; everything else keeps working |
| `docker.io`, `registry-1.docker.io` | The Caddy and PostgreSQL images | Cannot install or upgrade |
| UDP 123 (NTP) | Clock | Certificates and tokens misbehave in ways that look like nothing else |

If you run a default-deny egress policy, allow those and nothing more. The
server makes no other outbound connection.

If anything sits in front of Caddy, such as a cloud load balancer, another
reverse proxy, or Cloudflare, its idle timeout must clear 60 seconds, and it
must not impose a maximum lifetime on an upgraded connection. The application
pings each socket every 20 seconds and closes it after 60 seconds without a
reply, so a healthy connection may be silent for just under a minute. An idle
timeout below that presents as a client bug: listeners dropping about a minute
after they connect, reconnect loops, and latency nobody can explain. AWS
Application Load Balancer defaults to 60 seconds, which is exactly on the edge;
raise it to 120 seconds or more.

---

## The GitHub OAuth application

AgentChat does not store passwords. It brokers login to GitHub's OAuth device
flow, which is the flow that suits a command-line tool: the CLI shows a short
code, the person opens a page in a browser and enters it, and the CLI picks up
the result. Nothing in the wire protocol depends on GitHub, but this release
ships only this one provider, so every user of your instance needs a GitHub
account.

You register your own application. It is free and takes about two minutes.

1. Sign in to GitHub as the account or organisation that should own the app.
   For a company instance, prefer an organisation-owned app over a personal
   one: personal apps disappear with the person.
2. Open <https://github.com/settings/developers>, choose OAuth Apps, then New
   OAuth App. For an organisation: Settings, Developer settings, OAuth Apps,
   New OAuth App.
3. Fill in the form:
   - Application name: what your users will see on the authorisation page. Use
     something they will recognise, such as `AgentChat (Acme)`.
   - Homepage URL: `https://chat.your-company.example`, the hostname you chose
     above.
   - Authorization callback URL: required by the form, unused by this flow. Put
     `https://chat.your-company.example`. Nothing is ever redirected there.
   - Enable Device Flow: tick this. An app without it registers fine and then
     fails at every login attempt with an error about the device endpoint being
     unavailable.
4. Register the application. Copy the Client ID into `GITHUB_CLIENT_ID`.
5. Generate a new client secret, copy it into `GITHUB_CLIENT_SECRET`, and store
   it in whatever you use for secrets. GitHub shows it once.

Notes that save time later:

- The client ID is public by design; it appears on the authorisation page. The
  secret is not. Treat it like a password.
- Neither value is needed to create the database schema. You can bring the
  stack up and migrate before you register the app; see
  [first run](#first-run-in-the-order-that-works).
- GitHub may expire secrets on its own schedule. Generating a new one, updating
  `.env`, and restarting the server logs nobody out: the secret authenticates
  your server to GitHub, not users to your server.
- Users who belong to an organisation with OAuth app restrictions may need an
  owner to approve your app before they can sign in.

---

## Every environment variable

The annotated master copy is
[`deploy/compose/.env.example`](../deploy/compose/.env.example), which is the
file you edit and which says which program reads each variable. The tables here
are the reference: what a value means, what happens if it is wrong, and, in the
second table, the variables the reference stack fixes for you that you will
need if you deploy some other way.

Read by: `[server]` the server process, `[migrate]` the one-shot migration
program, `[both]`, `[proxy]` Caddy, `[postgres]` the database container,
`[compose]` resolved by Compose before any container starts.

### Set in `.env`

| Variable | Read by | Required | Default | What it does, and what goes wrong |
|---|---|---|---|---|
| `AGENTCHAT_VERSION` | `[compose]` | Yes | none | The exact release to run, such as `0.3.0`. There is no floating `latest`: Compose refuses to start until you name a version, so `docker compose up` can never perform an unplanned upgrade that runs unreviewed migrations against your data. Changing it is the upgrade. The example file ships pinned to its own release. |
| `AGENTCHAT_IMAGE` | `[compose]` | No | `ghcr.io/anmol098/agentchat-server` | The image repository, no tag. Change it only if you publish your own build. |
| `AGENTCHAT_DOMAIN` | `[proxy]` | Yes | none | The hostname this deployment answers on. Must already resolve to this machine. `localhost` switches Caddy to its own internal CA for a laptop smoke test. |
| `ACME_EMAIL` | `[proxy]` | Yes | none | Contact address for the certificate authority. This is where the mail goes when renewal has been failing for a week and nobody noticed. Use a list, not a person. |
| `HTTP_PORT` / `HTTPS_PORT` | `[proxy]` | No | `80` / `443` | Host ports Caddy binds. Change only if something else owns them. The ACME challenge still needs port 80 reachable from the internet, whatever you map it to locally. |
| `JWT_SECRET` | `[server]` | Yes | none | HS256 signing key for access tokens. At least 32 characters of unguessable text: `openssl rand -hex 32`. See [rotating it](#rotating-the-signing-secret) before you change it. |
| `GITHUB_CLIENT_ID` | `[server]` | Yes | none | Client ID of the OAuth app above. Device flow must be enabled on it. |
| `GITHUB_CLIENT_SECRET` | `[server]` | Yes | none | Client secret of the same app. Authenticates your server to GitHub; never sent to a user. |
| `POSTGRES_PASSWORD` | `[postgres]` `[both]` | Yes | none | Generate with `openssl rand -hex 32`. Hex, because it is interpolated into a connection URL and must not need percent-encoding. Baked into the data directory on first start: editing this line later changes only what the clients send, and they will be refused. To rotate it, run `ALTER USER` inside the database and edit this in the same maintenance window. |
| `POSTGRES_USER` / `POSTGRES_DB` | `[postgres]` | No | `agentchat` / `agentchat` | Also baked in at initialisation. Changing them afterwards points the stack at a database that does not exist. |
| `DATABASE_POOL_MAX` | `[server]` | No | `10` | Pooled connections. Raise only alongside PostgreSQL's own `max_connections`. A migration run takes no pool; it opens one connection and exits. |
| `DATABASE_CONNECTION_TIMEOUT_MS` | `[server]` | No | `5000` | How long to wait for a pooled connection before failing the request. |
| `DATABASE_IDLE_TIMEOUT_MS` | `[server]` | No | `30000` | How long an unused connection stays open. Lower it if you point at a managed database that charges per connection. |
| `MIGRATION_LOCK_TIMEOUT_MS` | `[migrate]` | No | `60000` | How long to wait for the PostgreSQL advisory lock before giving up with exit 69. Raise it if you have a long migration and something that might start two containers at once. |
| `AGENTCHAT_ALLOW_SCHEMA_AHEAD` | `[both]` | No | `false` | Leave it false. Setting it true permits running against a database whose schema is newer than the image. That is what a rollback is, and it is the only reason to set it. See [upgrading.md](./upgrading.md#rolling-back). |
| `LOG_LEVEL` | `[both]` | No | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`. Structured JSON on stdout. `debug` is verbose, not unsafe. |
| `SHUTDOWN_TIMEOUT_MS` | `[server]` | No | `10000` | How long the server may spend closing sockets and draining the pool after `SIGTERM`. It must stay well below `AGENTCHAT_STOP_GRACE_PERIOD`, because it also needs time to log why it stopped. |
| `AGENTCHAT_STOP_GRACE_PERIOD` | `[compose]` | No | `30s` | How long Docker waits after `SIGTERM` before `SIGKILL`. Compose's own default is 10 seconds, the same as the shutdown budget, which guarantees every ordinary stop looks like a crash. Raise this, `SHUTDOWN_TIMEOUT_MS`, and the systemd unit's `TimeoutStopSec=` together. |

### Fixed by the reference stack

You will not find these in `.env`, because the Compose file sets them and a
deployment that changed them would break. They are listed for anyone running
the image under Kubernetes, Nomad, or a hand-written systemd unit, where you
supply them yourself.

| Variable | Default in the image | What you need to know |
|---|---|---|
| `DATABASE_URL` | none, required | `postgres://user:password@host:5432/dbname`. The one variable the migration program needs. The reference stack composes it once from `POSTGRES_*` so the server and the migration job cannot be pointed at different databases. For a managed database, append `?sslmode=require`. |
| `HOST` | `0.0.0.0` | Interface to bind. Do not set `127.0.0.1` in a container: nothing outside can reach it and there is no error saying so. |
| `PORT` | `3000` | The reference stack pins this because the image's built-in health check reads it. `PORT=0` is valid to the server, meaning "ask the OS for a free port", and produces a container that is permanently unhealthy. |
| `NODE_ENV` | `production` | `development`, `test` or `production`. |
| `MIGRATE_ON_BOOT` | `true` in the image, `false` in the reference stack | Whether the container migrates before serving. The reference stack runs migrations as a separate one-shot container instead; [upgrading.md](./upgrading.md#the-migration-exit-codes) explains why. |
| `MIGRATIONS_DIR` | the `drizzle` directory beside the program | Override only if you have deliberately unbundled the migrations. |

Two things are not configurable: the maximum request body (2 MiB, because a
message is capped at 1 MiB and a deployment that raised it would accept
messages the database rejects) and the WebSocket path (`/ws`).

### The credentials split

The migration container is given `DATABASE_URL` and its own logging variables,
and nothing else. It is not given `JWT_SECRET`, `GITHUB_CLIENT_ID` or
`GITHUB_CLIENT_SECRET`, because applying SQL signs no tokens and logs nobody in.

That is what lets you create your database schema before you have registered an
OAuth application, which is the order that works for a first-time self-hoster.
It also means a broken login can never be caused by something the migration
job did.

---

## First run, in the order that works

The full command sequence is in
[`deploy/compose/README.md`](../deploy/compose/README.md#install). What follows
is the order and the decisions, so you know what you are looking at.

1. Provision the machine and point DNS at it. Confirm the name resolves from
   somewhere other than the machine itself before going further. Certificate
   issuance is the first thing to fail otherwise, and it fails on a retry
   schedule that makes it look intermittent.
2. Open the firewall as above: 80 and 443 inbound, SSH restricted.
3. Install Docker, copy the four deployment files into `/opt/agentchat`, and
   copy `.env.example` to `.env`. Set the file to mode `600`; it will hold three
   secrets in plain text.
4. Generate the two secrets (`JWT_SECRET`, `POSTGRES_PASSWORD`) with
   `openssl rand -hex 32`, and fill in `AGENTCHAT_DOMAIN` and `ACME_EMAIL`.
   `AGENTCHAT_VERSION` is already set to the release the file shipped with.
5. Register the OAuth application and fill in the two GitHub variables. You can
   do this now or after step 6; the schema does not need them. You cannot skip
   it: the server refuses to start without them, and it names them.
6. Start the stack. `docker compose up --detach --wait` pulls three images,
   runs every migration in a one-shot container, and returns once the server
   answers its own health check. Expect a minute or two on the first run, most
   of it pulling.
7. Verify from somewhere else, not from the machine.
   `curl https://chat.your-company.example/healthz` should answer
   `{"status":"ok","checks":{"database":"ok"}}`, and `/version` should report
   the release you pinned. From another host this also proves DNS, the
   firewall and the certificate, which rules out three problems in one
   command.
8. Enable the systemd unit so the stack comes back after a reboot.
9. Log in yourself before you tell anybody else about it. You are the first
   user; find the problems first.
10. Take a backup and restore it somewhere. A backup you have never restored is
    a hypothesis. See [backups](#backups).

### Point your users at it

The CLI ships with no default server address. A default would decide which host
receives a person's device authorisation and therefore which host ends up
holding their tokens, so it may only name a host the people shipping the build
control.

The instruction you give your team is two lines, and the second names your
server:

```bash
npm install --global @anmol098/agentchat
agentchat login --server https://chat.your-company.example
```

The package is scoped and the command it installs is `agentchat`. `login`
records the server address in `~/.config/agentchat/config.json`, so no later
command needs the flag. A login that fails or is abandoned records nothing, so
a typo does not become permanent, and `agentchat logout` leaves the address in
place to log back in to.

Tell them it is a one-time login. The access token a login returns lives an
hour, but the CLI redeems the refresh token stored beside it on the first `401`
and retries the request without prompting; `agentchat listen` does the same on
the matching close code. Each redemption rotates the refresh token and starts a
fresh ninety days, so somebody who runs `agentchat` at all in a quarter never
re-authenticates. Do not budget for a daily or hourly re-login.

If a user reports that a command cannot find the server, they logged in
somewhere else or never finished logging in. `agentchat status` shows the
resolved address.

Building your own CLI for your own people, with the address compiled in, is a
one-constant change (`BUILT_IN_SERVER_URL` in `packages/cli/src/config.ts`) and
is a supported thing to do; the CLI is MIT. A built-in default is never written
into user configuration, so changing it later reaches everybody rather than only
people who have never logged in.

---

## Running PostgreSQL somewhere else

The bundled `postgres` service is a real, durable database on a named volume,
and it is a good answer for a team. Move to a managed instance when you want
automated point-in-time recovery, a failover replica, or someone else awake at
3 a.m. for a full disk.

The change is small, because nothing in the server knows where its database is:

1. Create the database and a role that owns it. AgentChat needs ordinary DDL
   rights on its own database (it creates tables, indexes and a `drizzle`
   schema for migration bookkeeping) and no superuser rights.
2. Set `DATABASE_URL` in `.env` to the managed instance, with
   `?sslmode=require`, or `verify-full` with the provider's CA if your client
   can be given the certificate. Do not leave TLS off for a database reached
   over anything but a container network.
3. Delete the `postgres` service from `docker-compose.yml`, along with the
   `depends_on: postgres` entries on `migrate` and `server` and the
   `postgres-data` volume. Also remove the `x-database-url` fragment, so that
   the `DATABASE_URL` you set is the one that is used.
4. Restrict the managed instance's firewall to the AgentChat machine's
   address. A managed database with a public endpoint and a password has one
   credential between the internet and every message your team has sent.
5. Keep `DATABASE_POOL_MAX` within the instance's connection limit. Small
   managed tiers allow far fewer connections than you expect; the default of
   10 is one server's worth, and a connection pooler (PgBouncer, or the
   provider's own) is the answer if you outgrow it, not a bigger number here.

Once the database is managed, its provider's backups replace the schedule
below, but the [restore drill](#prove-the-backup-restores) does not. Run it
anyway.

Pin the major version whatever you do. See [PostgreSQL major
upgrades](./upgrading.md#postgresql-major-version-upgrades) before you let a
provider upgrade automatically.

---

## Backups

The database is the only thing in the deployment that cannot be recreated from
this repository. Everything else, meaning images, configuration and
certificates, is either public or regenerable. Losing the volume loses every
message your team has sent, and there is no undo.

`deploy/compose/README.md` gives the one-off dump and restore commands. What
follows is the part that makes them a backup rather than a good intention.

### A schedule

Nightly, off the machine, with retention. Below is a systemd timer, which needs
nothing that is not already installed; a cron entry doing the same thing is
equally fine.

`/etc/systemd/system/agentchat-backup.service`:

```ini
[Unit]
Description=AgentChat database backup
After=agentchat.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=/opt/agentchat
Environment=BACKUP_DIR=/var/backups/agentchat
ExecStart=/bin/sh -c 'install -d -m 700 "$BACKUP_DIR" && \
  /usr/bin/docker compose exec -T postgres pg_dump -U agentchat -Fc agentchat \
  > "$BACKUP_DIR/agentchat-$(date -u +%%F-%%H%%M).dump"'
ExecStartPost=/bin/sh -c 'find "$BACKUP_DIR" -name "agentchat-*.dump" -mtime +14 -delete'
```

`/etc/systemd/system/agentchat-backup.timer`:

```ini
[Unit]
Description=Nightly AgentChat database backup

[Timer]
OnCalendar=*-*-* 03:20:00 UTC
RandomizedDelaySec=20m
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agentchat-backup.timer
sudo systemctl start agentchat-backup.service   # take one now rather than waiting for 03:20
systemctl list-timers agentchat-backup.timer
```

Four things about that unit are deliberate:

- `-Fc` is the custom format. It compresses, and it lets `pg_restore` pick out
  individual tables during a partial recovery. A plain SQL dump gives you
  neither.
- `pg_dump` is online. It takes a consistent snapshot without blocking writes,
  so 03:20 is a courtesy, not a requirement.
- `Persistent=true` catches up a missed run after the machine was off.
- Retention is on the machine only. Fourteen days of dumps on the same disk as
  the database protects you against a bad migration and against nothing else.

### Get them off the machine

A backup that lives on the machine it backs up is not a backup. Copy each dump
somewhere the AgentChat host cannot delete it: object storage with versioning
or an immutability window, or another machine that pulls with `rsync` over SSH.
Prefer a pull to a push. If the pull credential lives on the backup host, an
attacker on the AgentChat host cannot reach round and erase history.

Dumps contain every message your users have written. Encrypt them at rest, and
give them the same access controls as the database itself.

### Also worth keeping

| What | Why | If you lose it |
|---|---|---|
| `/opt/agentchat/.env` | Three secrets and every setting | Recoverable, except that a new `JWT_SECRET` invalidates every access token, and the PostgreSQL password must match what is baked into the volume |
| The `caddy-data` volume | Certificates, keys, ACME account | Survivable: every certificate is re-issued on the next start, which counts against the authority's rate limits (five duplicates per week) |
| The `postgres-data` volume | The database | This is what the dumps are for. A volume-level snapshot supplements `pg_dump`; it does not replace it, because a filesystem snapshot of a running PostgreSQL is only as good as your storage layer's atomicity guarantees |

`docker compose down` keeps volumes. `docker compose down --volumes` destroys
every message in the deployment, with no confirmation prompt. Take care that a
tidy-up script never grows that flag.

### Prove the backup restores

Once, when you set it up, and then on a calendar reminder; quarterly is enough.
Restore the newest dump into a scratch database, not the live one:

```bash
cd /opt/agentchat
sudo docker compose exec -T postgres createdb -U agentchat restore_test
sudo docker compose exec -T postgres pg_restore -U agentchat -d restore_test \
  < /var/backups/agentchat/agentchat-YYYY-MM-DD-HHMM.dump
sudo docker compose exec -T postgres psql -U agentchat -d restore_test \
  -c 'select count(*) from messages;' -c '\dt'
sudo docker compose exec -T postgres dropdb -U agentchat restore_test
```

You are looking for three things: the restore finishes without errors, the
table list matches the live database, and the message count is roughly what you
expect. What you are testing is that the dump is not empty, not truncated, and
not of the wrong database. All three happen, silently, to people who never
check.

Restoring over the live database is a different and more careful procedure. It
is in [upgrading.md](./upgrading.md#restoring-from-a-backup), because that is
when you will need it.

---

## Rotating the signing secret

`JWT_SECRET` signs and verifies every access token. It is symmetric: the same
value that mints a token verifies it.

Rotating it invalidates every access token in existence, and signs nobody out.
The instant the server restarts, nothing minted under the old secret verifies.
But an access token is only the hour-long half of a credential. The refresh
token beside it is thirty-two random bytes, kept as a hash and signed with
nothing, so a rotation cannot touch it: the CLI redeems it on the first `401`
and retries the request, and `agentchat listen` renews and reconnects on the
matching close code. What a user notices is one command taking an extra round
trip.

Plan around the other direction instead. A rotation ends no session, so on its
own it is not a way to expel somebody or to clear the estate after an
incident. That means revoking refresh tokens, which is a database operation.
Open a prompt [through the PostgreSQL container](../deploy/compose/README.md#only-the-proxy-is-published)
and run:

```sql
UPDATE refresh_tokens SET revoked_at = now() WHERE revoked_at IS NULL;
```

Everyone then has to run `agentchat login` again, which is the cost that keeps
this off a schedule. There are two occasions to touch the secret:

1. The secret is believed stolen: it was pasted into an issue, a CI log, a
   screenshot, or it lived on a machine you no longer trust. Rotate
   immediately. A stolen signing key lets the holder mint a valid token for any
   user, and rotation is the only thing that stops that. Legitimate users keep
   working; they refresh and carry on.
2. You are decommissioning the instance's trust after an incident, and want
   every session to start again. Rotate and revoke, in that order: the
   rotation kills the tokens already issued, the revocation stops the ones that
   would replace them.

The procedure:

```bash
cd /opt/agentchat
openssl rand -hex 32                 # the new value
sudo "${EDITOR:-vi}" .env            # replace JWT_SECRET
sudo docker compose up --detach --wait server
```

Nobody needs to be told about a rotation on its own. If you revoked refresh
tokens as well, tell your users, in the same message, what happened and what to
type:

> The AgentChat server's sessions were revoked, so you have been signed out.
> Run `agentchat login --server https://chat.your-company.example` and approve
> the code. Any `agentchat listen` process should be restarted afterwards.

Rotating the GitHub client secret is the cheap one by comparison: it
authenticates your server to GitHub and nobody's session depends on it.
Generate a new secret in the OAuth app, update `.env`, restart the server, then
delete the old secret on GitHub, in that order, so there is no window where
neither works.

Rotating the database password requires `ALTER USER` inside PostgreSQL and the
matching edit to `.env` in the same maintenance window. The password in the
volume and the password in the connection string have to change together;
editing only `.env` locks the server out of its own database.

---

## Getting the logs off the machine

Everything logs structured JSON to stdout, and Docker's `json-file` driver
collects it. The reference stack caps each service at 50 MiB, as five files of
10 MiB, which is enough to investigate yesterday and not enough to fill the
disk.

That cap is also the problem: your logs are a rolling window on the machine you
would be trying to diagnose. If the machine is gone, or its disk is full, so are
they. Ship them somewhere else before you need them.

The one-line version, which needs nothing but journald and whatever already
collects it:

```yaml
# docker-compose.yml, per service, replacing the json-file block
logging:
  driver: journald
  options:
    tag: "agentchat/{{.Name}}"
```

Then `journalctl -t agentchat/agentchat-deploy-server-1 -f` reads them, and any
ordinary journald forwarder (rsyslog, `systemd-journal-upload`, Vector, the
agent your provider already gives you) ships them. Note the trade: `docker
compose logs` no longer shows anything, because Docker is no longer holding
them.

Alternatively, keep `json-file` and run a collector that tails
`/var/lib/docker/containers/*/*-json.log`: Vector, Fluent Bit, Promtail, or your
provider's agent. Either shape is fine. Having neither is the mistake.

What to keep, whichever you choose:

- The `server` service, always. Every request is one JSON line with a `reqId`,
  a method, a URL, a status and a duration, and every rejection carries a
  stable `code`.
- The `migrate` service. It is a handful of lines per upgrade, and it is where
  an upgrade failure explains itself, once. The message that tells you what to
  do about a failed upgrade is gone the moment the log window rolls.
- `caddy`, for TLS problems and for a request log that survives the server
  being down.

Two cautions. Log lines carry user handles, project and message identifiers, IP
addresses and user agents; they do not carry message content or secrets, and
the code goes out of its way to keep it that way. They are still personal data,
so put them somewhere with access control and a retention limit. And
`LOG_LEVEL=debug` is much more voluminous; turn it on to investigate something
and turn it off again.

---

## Security posture

What the reference deployment already does, so you know what you would be
undoing:

- Only Caddy publishes a port. PostgreSQL and the server are reachable on the
  Compose network and nowhere else.
- The server process runs as uid 1000, not root, and everything under `/app` is
  owned by root and world-readable, so the process cannot rewrite its own code
  or its migrations.
- The runtime image has no package manager, no `curl` and no `wget`. The health
  check is written in Node for that reason.
- HSTS is set for a year. Once a browser has seen it, that hostname is
  HTTPS-only.
- `.env` is excluded by two `.gitignore` files, so the exclusion travels with
  the directory when you copy it to a server.

What is left to you:

- Restrict SSH, and prefer keys to passwords.
- Turn on unattended security updates for the host.
- Keep `.env` at mode 600 and out of any repository.
- Subscribe to this repository's releases, so a security fix reaches you.
- Decide who can `ssh` to the machine. That person can read every message in
  the database, and no application-level control changes that.

---

## What you cannot do yet

Worth knowing before you commit a team to this:

- GitHub is the only identity provider. Nothing in the protocol depends on it,
  but this release ships no other, so every user needs a GitHub account. There
  is no SAML, no OIDC, no LDAP.
- There is no admin interface. No user list, no "remove this person", no usage
  dashboard. Administration is `psql` and the CLI.
- There is no built-in rate limit on message volume, and no quota. A runaway
  agent is bounded by your disk.
- One server, one database, one machine. There is no clustering story and no
  read replica support. Scaling is a bigger machine.
- No message retention or deletion policy. Messages accumulate until you delete
  them yourself.
- Ending one person's session means `psql`. Sessions renew themselves: an
  access token lives one hour, the CLI redeems the ninety-day refresh token
  beside it on the first `401` without prompting, and every use rotates that
  token and starts a fresh ninety days. What expires a session is ninety days
  of not running `agentchat` at all. There is no "sign out this device" and no
  admin revocation; the only lever is the `UPDATE` under [rotating the signing
  secret](#rotating-the-signing-secret), which signs out everybody at once.

---

## When something is wrong

The symptom-to-log table is in
[`deploy/compose/README.md`](../deploy/compose/README.md#troubleshooting) and
is the right first stop. Two things to internalise:

- `docker compose ps -a`, with the `-a`. The `migrate` container has exited by
  design, and without `-a` you cannot see whether it exited 0.
- Listeners dropping after about a minute is almost never AgentChat. It is
  something in front of Caddy with an idle timeout below 60 seconds.

---

## See also

- [`deploy/compose/README.md`](../deploy/compose/README.md): the stack, the
  install commands, and how each piece fits
- [`upgrading.md`](./upgrading.md): the compatibility promise, upgrades,
  rollback, restore, and PostgreSQL major versions
- [`cli.md`](./cli.md): what your users will be running
- [`../LICENSE`](../LICENSE): the split licence and what the AGPL asks of you if
  you modify the server
