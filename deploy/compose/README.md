<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# AgentChat reference deployment

One virtual machine running four containers: [Caddy](https://caddyserver.com)
for TLS and the WebSocket path, a one-shot migration job, the AgentChat server,
and PostgreSQL on a named volume.

This is the deployment the project runs itself, and it is the same thing a
self-hoster runs — there is no separate "real" configuration kept somewhere
else. The server is [AGPL](../../LICENSE): running your own is an explicit goal,
not a tolerated side effect.

| File | What it is |
|------|------------|
| [`docker-compose.yml`](./docker-compose.yml) | The stack. Every non-obvious choice is commented in place. |
| [`Caddyfile`](./Caddyfile) | Reverse proxy: automatic certificates, and the timeouts a WebSocket survives. |
| [`.env.example`](./.env.example) | Every variable this stack reads, with which program reads it. |
| [`agentchat.service`](./agentchat.service) | systemd unit, so the stack comes back after a reboot. |

Not to be confused with [`../../docker-compose.yml`](../../docker-compose.yml)
at the repository root, which starts a bare Postgres for the test suite and has
no server, no proxy, and a committed password.

---

## What you need before you start

- A machine with **Docker Engine 20.10+ and the Compose v2 plugin**. Two
  vCPUs and 2 GB of memory is comfortable for a dogfooding instance.
- **Ports 80 and 443 reachable from the internet.** Both, not just 443: the
  certificate authority proves you control the name over port 80.
- A **DNS `A` record** (and `AAAA` if you have IPv6) for your hostname,
  already pointing at the machine. Certificate issuance fails, loudly and
  repeatedly, until this resolves.
- A **GitHub OAuth app** with device flow enabled, from
  <https://github.com/settings/developers>. You can defer this: the database
  schema is created without it, and it is only needed before the first login.

## Install

Everything below runs on the server. Nothing here needs a checkout of this
repository afterwards — upgrades pull an image, and the migrations are inside
it.

```bash
# 1. Docker, if it is not already there.
curl -fsSL https://get.docker.com | sudo sh

# 2. The deployment files, into their own directory.
sudo mkdir -p /opt/agentchat
git clone --depth 1 https://github.com/anmol098/agentchat.git /tmp/agentchat
sudo cp /tmp/agentchat/deploy/compose/{docker-compose.yml,Caddyfile,.env.example,agentchat.service} /opt/agentchat/
rm -rf /tmp/agentchat
cd /opt/agentchat

# 3. Configuration. Read every comment in .env.example; it says what each
#    variable is for and which of the two programs reads it.
sudo cp .env.example .env
sudo chmod 600 .env
sudo "${EDITOR:-vi}" .env

#    Generate the two secrets it asks for:
openssl rand -hex 32   # JWT_SECRET
openssl rand -hex 32   # POSTGRES_PASSWORD

# 4. Start. This pulls three images, applies every migration, and waits until
#    the server answers its own health check.
sudo docker compose up --detach --wait

# 5. Verify, from anywhere.
curl https://chat.example.com/healthz
# {"status":"ok","checks":{"database":"ok"}}
```

If step 4 stops with `required variable AGENTCHAT_VERSION is missing a value`,
that is the version pin doing its job: there is no floating default, and Compose
will not start anything until you name the release you mean to run.

## Start on boot

Docker's own restart policies already bring containers back after a crash and a
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

## Upgrading

Plan §12.5, in full:

```bash
cd /opt/agentchat

# 1. Read the release notes for the target version, especially "Upgrade notes".
# 2. Back up. Always. Restoring is the only way back from a two-version jump.
sudo docker compose exec -T postgres pg_dump -U agentchat -Fc agentchat > backup-$(date +%F).dump

# 3. Change AGENTCHAT_VERSION in .env, then:
sudo docker compose pull
sudo docker compose up --detach --wait

# 4. Verify.
curl -s https://chat.example.com/version
sudo docker compose logs --since 5m migrate
```

Migrations run in their own container before the server starts, and the server
starts only if that container exited 0. Listeners tolerate the swap: sockets
drop, clients reconnect with backoff, and the `hello` frame replays anything
undelivered (Plan §4.4). Expect well under a minute of downtime, mostly
migration time.

### Rolling back

```bash
# In .env: put AGENTCHAT_VERSION back, and add
AGENTCHAT_ALLOW_SCHEMA_AHEAD=true
```

then `sudo docker compose up --detach --wait`. The second variable is not
optional. Both the migration job and the server refuse, with **exit 65**, to run
against a schema newer than the image knows, because nothing records which
release a migration came from and an old binary serving tables it has never
heard of corrupts data silently. Rolling back is deliberately that case. Remove
the variable once you have rolled forward again. One minor version back is
guaranteed to work (Plan §12.3); further back is a restore from backup.

## Backups

The database volume is `agentchat-deploy_postgres-data` and it is the only thing
here that cannot be recreated from the repository.

```bash
sudo docker compose exec -T postgres pg_dump -U agentchat -Fc agentchat > backup-$(date +%F).dump

# Restore into an empty database:
sudo docker compose exec -T postgres pg_restore -U agentchat -d agentchat --clean < backup-YYYY-MM-DD.dump
```

`docker compose down` keeps volumes. **`docker compose down --volumes` destroys
every message in the deployment** — there is no confirmation prompt.

The certificate volume, `agentchat-deploy_caddy-data`, is worth keeping too.
Losing it is survivable but re-issues every certificate on the next start, which
counts against the certificate authority's rate limits.

---

## Why the pieces are the way they are

### TLS is automatic, and there is no cron job

Caddy obtains a certificate over ACME the first time it serves your hostname,
and renews it at roughly two thirds of its lifetime, for as long as the stack
runs. There is no certbot, no renewal timer, and nothing to forget. Port 80
stays open for the challenge and redirects to HTTPS the rest of the time.

If certificates are not issuing, the answer is almost always DNS or a firewall:

```bash
sudo docker compose logs caddy | grep -i -e acme -e certificate
```

### WebSockets, and the timeouts that are missing on purpose

AgentChat is a long-lived-connection product. It runs on a dedicated instance
rather than a serverless platform for exactly one reason: those cap how long a
request may live, and a WebSocket is one very long request (decision D6). A
short timeout in the proxy would reintroduce the problem the hosting choice was
made to avoid, and it would present as a client bug — dropped listeners,
reconnect loops, latency nobody can explain.

So the floor for every timeout here is the application's own heartbeat (Plan
§4.3): the server pings each socket every 20 s and closes it after 60 s without
a pong. A connection may legitimately be silent for just under a minute.

- `idle 10m` and `read_header 30s` are set explicitly rather than left to
  Caddy's defaults, so a future release cannot lower them underneath you.
- **`write` is deliberately not set.** Go keeps the write deadline on the
  underlying connection after it is hijacked for a WebSocket, so any finite
  value kills every socket that outlives it, mid-conversation, with no error
  either end can report. This is the classic way to break WebSockets behind a
  proxy.
- `reverse_proxy` sets no `stream_timeout`, so an upgraded connection has no
  lifetime cap at all.

If you put another proxy, a load balancer, or Cloudflare in front of this one,
its idle timeout has to clear 60 s too. That is the number to check first when
listeners start dropping about a minute after connecting.

### Migrations are a separate container, not a boot step

The image can migrate on boot, and that is the documented default for other
setups. Here `MIGRATE_ON_BOOT` is false and a one-shot `migrate` service runs
first, because the migration runner's exit codes carry information a restart
policy would otherwise destroy (Plan §12.2):

| Exit | Meaning | Retrying |
|------|---------|----------|
| 0 | Applied, or nothing to apply | — |
| 65 | The database is newer than this image | **Never.** Roll forward, or set `AGENTCHAT_ALLOW_SCHEMA_AHEAD=true` deliberately |
| 69 | Database unreachable, or the advisory lock was busy | Yes |
| 78 | The configuration or the image is wrong | No |
| 143 | Stopped by a signal | Yes |

Compose cannot branch a restart policy on an exit code. A server that migrated
on boot under `restart: unless-stopped` would turn exit 65 — which is what a
rollback looks like, i.e. the most likely upgrade failure — into an endless
crash loop that can never succeed, burying the one message that explains what to
do. As a one-shot with `restart: "no"`, that failure is terminal and legible:
the container sits in `Exited (65)`, the server never starts, and
`docker compose logs migrate` tells you once, clearly, what to do.

The migration container is also given **only** `DATABASE_URL` and its own
logging variables. It is not given `JWT_SECRET`, `GITHUB_CLIENT_ID` or
`GITHUB_CLIENT_SECRET`, because applying SQL signs no tokens and logs nobody in
(T-022). That is what lets you create the schema before you have registered an
OAuth app.

### Stopping the server takes longer than ten seconds

The server closes sockets and drains its connection pool on `SIGTERM`, within
`SHUTDOWN_TIMEOUT_MS` (10 s by default), and then logs why it stopped. Compose's
default grace period is also 10 s, which is too tight: `SIGKILL` would land on a
process that was about to explain itself, and every ordinary stop would look
like a crash. `stop_grace_period` is therefore 30 s. If you raise one of these,
raise the other, and `TimeoutStopSec=` in the systemd unit with them.

### Nothing but the proxy is published

Postgres and the server bind no host ports; they are reachable on the Compose
network and nowhere else. That is not only defence in depth: the server runs
with Fastify's `trustProxy: true`, so anything able to reach it directly could
forge `X-Forwarded-For` and poison every log and rate limit derived from it. For
a database prompt, go through the container:

```bash
sudo docker compose exec postgres psql -U agentchat agentchat
```

---

## Smoke test without a domain

The whole stack can be exercised on a laptop, with the committed configuration
and no DNS, by pointing it at `localhost`. Caddy then issues from its own
internal CA instead of contacting a certificate authority.

```bash
cp .env.example .env
# In .env:
#   AGENTCHAT_DOMAIN=localhost
#   HTTP_PORT=8080         # 80/443 usually need privileges you would rather not use
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

Two things differ from a real deployment and neither is a fault in the stack:
the certificate is signed by Caddy's local CA, so clients need `-k` or the
CA installed; and the HTTP→HTTPS redirect points at the canonical `https://
localhost` rather than the remapped `:8443`.

## Troubleshooting

```bash
sudo docker compose ps -a                  # note -a: the migrate job has exited by design
sudo docker compose logs -f server
sudo docker compose logs migrate           # where an upgrade failure explains itself
sudo docker compose logs caddy | grep -i acme
```

| Symptom | Where to look |
|---------|---------------|
| `required variable ... is missing a value` | `.env` is incomplete. The message names the variable and what a good value is. |
| `migrate` exited 65 | The database is ahead of the image. See "Rolling back". |
| `migrate` exited 69 | Postgres was unreachable, or another migration held the lock. Safe to retry. |
| `migrate` exited 78 | Bad configuration or a broken image. Retrying will not help. |
| 502 from the proxy | The server is not up yet, or is unhealthy. `docker compose ps` and `docker compose logs server`. |
| No certificate | DNS does not point here yet, or port 80 is closed to the internet. |
| Listeners drop after ~1 minute | Something in front of Caddy has an idle timeout below 60 s. |
