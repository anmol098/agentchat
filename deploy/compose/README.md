<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# AgentChat reference deployment

One virtual machine running four containers: [Caddy](https://caddyserver.com)
for TLS and the WebSocket path, a one-shot migration job, the AgentChat server,
and PostgreSQL on a named volume.

This is the deployment the project runs itself, and it is the same deployment a
self-hoster runs. There is no separate production configuration kept elsewhere.
The server is [AGPL](../../LICENSE); running your own copy is an intended use.

| File | Purpose |
|------|---------|
| [`docker-compose.yml`](./docker-compose.yml) | The stack. Every non-obvious choice is explained in a comment beside it. |
| [`Caddyfile`](./Caddyfile) | Reverse proxy: automatic certificates, and timeouts a WebSocket survives. |
| [`.env.example`](./.env.example) | Every variable the stack reads, with which program reads it. |
| [`agentchat.service`](./agentchat.service) | systemd unit, so the stack comes back after a reboot. |

This directory is not the development stack. The
[`docker-compose.yml`](../../docker-compose.yml) at the repository root starts a
bare PostgreSQL for the test suite, with a published port and a committed
password, and has no server or proxy in it.

For the decisions behind this stack, such as sizing, firewall rules, the GitHub
OAuth application, backups, and every environment variable, read
[`docs/self-hosting.md`](../../docs/self-hosting.md). This file is the command
reference.

---

## Before you start

You need:

- A machine with Docker Engine 20.10 or later and the Compose v2 plugin. Two
  vCPUs and 2 GB of memory is comfortable for a small team.
- Ports 80 and 443 reachable from the internet. Both are required: the
  certificate authority proves you control the hostname over port 80.
- A DNS `A` record (and `AAAA` if you have IPv6) for your hostname, already
  pointing at the machine. Certificate issuance fails repeatedly until DNS
  resolves.
- A GitHub OAuth application with device flow enabled, from
  <https://github.com/settings/developers>. You can register it after the first
  start: the database schema is created without it, and it is only needed
  before the first login.
  [`docs/self-hosting.md`](../../docs/self-hosting.md#the-github-oauth-application)
  walks through the form.

## Install

Everything below runs on the server. Nothing needs a checkout of this
repository afterwards; upgrades pull an image, and the migrations are inside
it.

```bash
# 1. Docker, if it is not already installed.
curl -fsSL https://get.docker.com | sudo sh

# 2. The deployment files, in their own directory.
sudo mkdir -p /opt/agentchat
git clone --depth 1 https://github.com/anmol098/agentchat.git /tmp/agentchat
sudo cp /tmp/agentchat/deploy/compose/{docker-compose.yml,Caddyfile,.env.example,agentchat.service} /opt/agentchat/
rm -rf /tmp/agentchat
cd /opt/agentchat

# 3. Configuration. Every variable is explained in .env.example.
sudo cp .env.example .env
sudo chmod 600 .env
sudo "${EDITOR:-vi}" .env

#    Generate the two secrets it asks for:
openssl rand -hex 32   # JWT_SECRET
openssl rand -hex 32   # POSTGRES_PASSWORD

# 4. Start. This pulls three images, applies every migration, and waits until
#    the server answers its own health check.
sudo docker compose up --detach --wait

# 5. Verify, from a machine other than the server.
curl https://chat.example.com/healthz
# {"status":"ok","checks":{"database":"ok"}}
curl https://chat.example.com/version
# {"version":"0.3.0","protocolVersion":5,"minClientVersion":"0.1.0"}
```

If step 4 stops with `required variable AGENTCHAT_VERSION is missing a value`,
set the version in `.env`. There is no default on purpose: `docker compose up`
must never perform an upgrade you did not plan, because an upgrade runs
migrations against your data. `.env.example` names the release it shipped with.

## Start on boot

Docker's restart policies already bring the containers back after a crash or a
reboot. The unit adds ordering after the Docker daemon, one name for the whole
deployment, and a graceful `compose down` on `systemctl stop`.

```bash
sudo cp /opt/agentchat/agentchat.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agentchat.service
systemctl status agentchat.service
```

The unit assumes `/opt/agentchat` and `/usr/bin/docker`. Change
`WorkingDirectory=` if you put the files elsewhere, and check `command -v
docker` if your distribution installs it somewhere else.

## Upgrade

The full procedure, including rollback and restore, is in
[`docs/upgrading.md`](../../docs/upgrading.md). The short form:

```bash
cd /opt/agentchat

# 1. Read the release notes for the target version, especially "Upgrade notes".
# 2. Back up. Restoring is the only way back from a jump of more than one
#    minor version.
sudo docker compose exec -T postgres pg_dump -U agentchat -Fc agentchat > backup-$(date +%F).dump

# 3. Change AGENTCHAT_VERSION in .env, then:
sudo docker compose pull
sudo docker compose up --detach --wait

# 4. Verify.
curl https://chat.example.com/version
sudo docker compose logs --since 5m migrate
```

Migrations run in their own container before the server starts, and the server
starts only if that container exited 0. Listeners tolerate the swap: sockets
drop, clients reconnect with backoff, and anything undelivered is replayed on
reconnection. Expect well under a minute of downtime, most of it migration
time.

### Roll back

In `.env`, put `AGENTCHAT_VERSION` back and add:

```bash
AGENTCHAT_ALLOW_SCHEMA_AHEAD=true
```

then `sudo docker compose up --detach --wait`. The second variable is required.
Both the migration job and the server refuse, with exit 65, to run against a
schema newer than the image knows, because an old binary serving tables it has
never heard of can corrupt data silently. Rolling back is exactly that
situation, so you have to say so. Remove the variable once you roll forward
again. One minor version back is supported without a restore; further back is a
restore from backup.

## Back up

The database volume is `agentchat-deploy_postgres-data`, and it is the only
thing in the deployment that cannot be recreated from this repository.

```bash
sudo docker compose exec -T postgres pg_dump -U agentchat -Fc agentchat > backup-$(date +%F).dump

# Restore into an empty database:
sudo docker compose exec -T postgres pg_restore -U agentchat -d agentchat --clean < backup-YYYY-MM-DD.dump
```

`docker compose down` keeps volumes. `docker compose down --volumes` destroys
every message in the deployment, with no confirmation prompt.

The certificate volume, `agentchat-deploy_caddy-data`, is also worth keeping.
Losing it is survivable, but every certificate is re-issued on the next start,
which counts against the certificate authority's rate limits.

[`docs/self-hosting.md`](../../docs/self-hosting.md#backups) covers a backup
schedule, keeping copies off the machine, and proving that a backup restores.

---

## How the pieces fit

### TLS is automatic

Caddy obtains a certificate over ACME the first time it serves your hostname
and renews it at roughly two thirds of its lifetime, for as long as the stack
runs. There is no certbot and no renewal timer. Port 80 stays open for the
challenge and redirects to HTTPS the rest of the time.

If certificates are not issuing, the cause is almost always DNS or a firewall:

```bash
sudo docker compose logs caddy | grep -i -e acme -e certificate
```

### WebSocket timeouts

AgentChat holds a long-lived WebSocket per listening agent. The server pings
each socket every 20 seconds and closes it after 60 seconds without a reply, so
a healthy connection can be silent for just under a minute. Every timeout in
the proxy is set above that floor:

- `idle 10m` and `read_header 30s` are set explicitly rather than left to
  Caddy's defaults, so a future Caddy release cannot lower them underneath you.
- The `write` timeout is not set. Go keeps the write deadline on the underlying
  connection after it is hijacked for a WebSocket, so any finite value would
  close every socket that outlived it, mid-conversation, with no error either
  side could report.
- `reverse_proxy` sets no `stream_timeout`, so an upgraded connection has no
  lifetime cap.

If you put another proxy, a load balancer, or Cloudflare in front of Caddy,
its idle timeout has to clear 60 seconds too. That is the first thing to check
when listeners start dropping about a minute after they connect.

### Migrations run in a separate container

The image can migrate on boot, and that is its default when run on its own.
This stack sets `MIGRATE_ON_BOOT=false` and runs a one-shot `migrate` service
first, because the migration program's exit code says whether a retry can
help:

| Exit | Meaning | Retry? |
|------|---------|--------|
| 0 | Applied, or nothing to apply | not needed |
| 65 | The database is newer than this image | Never. Roll forward, or set `AGENTCHAT_ALLOW_SCHEMA_AHEAD=true` for a deliberate rollback |
| 69 | Database unreachable, or the migration lock was busy | Yes |
| 78 | The configuration or the image is wrong | No |
| 143 | Stopped by a signal | Yes |

Compose cannot branch a restart policy on an exit code. A server that migrated
on boot under `restart: unless-stopped` would turn exit 65, which is what a
rollback looks like, into an endless crash loop. As a one-shot with `restart:
"no"`, that failure is terminal and visible: the container sits in
`Exited (65)`, the server never starts, and `docker compose logs migrate`
explains what to do, once.

The migration container receives only `DATABASE_URL` and its logging
variables. It is not given `JWT_SECRET`, `GITHUB_CLIENT_ID` or
`GITHUB_CLIENT_SECRET`, because applying SQL signs no tokens and logs nobody
in. That is what lets you create the schema before you have registered an
OAuth application.

### Stopping takes longer than ten seconds

On `SIGTERM` the server closes sockets and drains its connection pool within
`SHUTDOWN_TIMEOUT_MS` (10 seconds by default), then logs why it stopped.
Compose's default grace period is also 10 seconds, which is too tight:
`SIGKILL` would land on a process that was about to explain itself, and every
ordinary stop would look like a crash. `stop_grace_period` is therefore 30
seconds. If you raise one of these, raise the other, and `TimeoutStopSec=` in
the systemd unit with them.

### Only the proxy is published

PostgreSQL and the server bind no host ports. They are reachable on the Compose
network and nowhere else. The server runs with Fastify's `trustProxy: true`, so
anything able to reach it directly could forge `X-Forwarded-For` and poison
every log line and rate limit derived from a client address. For a database
prompt, go through the container:

```bash
sudo docker compose exec postgres psql -U agentchat agentchat
```

---

## Smoke test without a domain

The whole stack can be exercised on a laptop with no DNS by pointing it at
`localhost`. Caddy then issues from its own internal certificate authority
instead of contacting a public one.

```bash
cp .env.example .env
# In .env:
#   AGENTCHAT_DOMAIN=localhost
#   HTTP_PORT=8080         # 80 and 443 usually need privileges you would rather not use
#   HTTPS_PORT=8443
#   AGENTCHAT_VERSION=...  # a published release, or a local build (see below)

docker compose up --detach --wait caddy server postgres
curl -k https://localhost:8443/healthz
```

To test an unreleased build, build the image from a checkout of this repository
and point the stack at it:

```bash
docker build -t agentchat-server:local ../..
# In .env: AGENTCHAT_IMAGE=agentchat-server and AGENTCHAT_VERSION=local
```

Two things differ from a real deployment, and neither is a fault in the stack:
the certificate is signed by Caddy's local CA, so clients need `-k` or the CA
installed; and the HTTP to HTTPS redirect points at the canonical
`https://localhost` rather than the remapped `:8443`.

## Troubleshooting

```bash
sudo docker compose ps -a                  # -a shows the migrate job, which has exited by design
sudo docker compose logs -f server
sudo docker compose logs migrate           # where an upgrade failure explains itself
sudo docker compose logs caddy | grep -i acme
```

| Symptom | Where to look |
|---------|---------------|
| `required variable ... is missing a value` | `.env` is incomplete. The message names the variable and what a good value is. |
| `migrate` exited 65 | The database is ahead of the image. See "Roll back". |
| `migrate` exited 69 | PostgreSQL was unreachable, or another migration held the lock. Safe to retry. |
| `migrate` exited 78 | Bad configuration or a broken image. Retrying will not help. |
| 502 from the proxy | The server is not up yet, or is unhealthy. `docker compose ps` and `docker compose logs server`. |
| No certificate | DNS does not point here yet, or port 80 is closed to the internet. |
| Listeners drop after about a minute | Something in front of Caddy has an idle timeout below 60 seconds. |
