# Upgrading AgentChat

This is the operator manual for upgrades. It is written for someone running
their own instance who has not read the source.

Everything here assumes the reference deployment described in
[`self-hosting.md`](./self-hosting.md) and
[`deploy/compose/README.md`](../deploy/compose/README.md): the stack lives in
`/opt/agentchat`, the version is pinned in `.env`, and the database is the
`postgres` service. If you run something else, the shapes still apply. What
matters is which image tag runs and which schema it finds when it starts.

The one thing to know before anything goes wrong: rolling back to an older
release requires an extra variable, `AGENTCHAT_ALLOW_SCHEMA_AHEAD=true`.
Without it the rollback fails every time with exit 65, and it looks exactly
like a compatibility break. It is a missing flag. See [Rolling
back](#rolling-back).

---

## The compatibility promise

One version number covers the whole project. The server, the CLI, the client
library and the protocol are released together as `vX.Y.Z`, so "which CLI works
with which server" has an answer. The promise is:

| | Guaranteed |
|---|---|
| Upgrade one minor version (`1.2` to `1.3`) | Yes. Migrations apply on the way up; no manual step. |
| Upgrade across several minors (`1.2` to `1.6`) | Yes. Migrations are cumulative and each is written against the one before it. |
| Roll back one minor version (`1.3` to `1.2`) | Yes, with `AGENTCHAT_ALLOW_SCHEMA_AHEAD=true`, and without restoring a backup. |
| Roll back more than one minor (`1.6` to `1.2`) | No. That is a restore from backup. |
| Patch releases (`1.3.0` to `1.3.1`) | Both directions, freely. |
| A CLI newer than the server | Works. The CLI prints one warning line to stderr and continues; a flag the old server does not know is ignored. |
| A CLI older than the server's floor | Refused, with an error naming the version to install. Each release states its minimum CLI version. |
| Anything across a major version (`1.x` to `2.0`) | Nothing above is promised. See below. |

Underneath it is a discipline on every schema change: add columns nullable or
with a default, never rename in place, and never drop a column until the
release after the one that stopped reading it. That is what lets the previous
release run against the newer schema at all.

### What a major version may break

A major bump is the only release allowed to break the rules above, and it is
reserved for exactly that. Assume any of these:

- The wire protocol. A field may be removed or repurposed, and a frame type may
  change meaning. Within a major version only additions are permitted, and both
  sides ignore what they do not recognise; across one, that stops holding.
- The minimum CLI version may jump. Users on an older CLI are refused with a
  message naming what to install, so plan to upgrade people before the server,
  not after.
- Environment variables may be renamed, removed, or given new meanings. A major
  upgrade may require editing `.env` before the stack will start.
- Rollback is not guaranteed. A major release may include a migration the
  previous release cannot serve against, in which case the only way back is
  restoring the backup you took first.
- A separate migration step may be required, rather than the schema moving as
  part of the ordinary start.
- Long-running data backfills may ship as their own command, called out in the
  release notes, so that a start does not sit on a table lock for minutes.

A major release links to its own migration guide. Read it in full before you
start, and take the backup as if you will need it.

### What is promised in every release

- Migrations are forward-only. There are no down migrations; going backwards
  means either running the previous image against the newer schema (one minor
  version, with the opt-in) or restoring a dump.
- Migrations ship inside the image. Upgrading never needs a checkout of this
  repository on the server.
- The version you run is pinned by you. There is no floating `latest` tag in
  the reference stack, so `docker compose up` can never quietly upgrade you.
- Release notes carry an "Upgrade notes" section: which migrations are
  included, whether any is long-running, and the minimum CLI version.

---

## Before every upgrade

1. Read the release notes for the target version, and for every version you are
   skipping. The Upgrade notes section is where a long migration or a changed
   variable is announced.
2. Check the minimum CLI version. If it has moved, tell your users to run
   `npm install --global @anmol098/agentchat@latest` before you upgrade the
   server. Otherwise their next command fails with an upgrade message, which
   works but is a worse experience than a heads-up.
3. Take a backup, and know where it is. Not the nightly one from eight hours
   ago; a fresh one, now. It is the only way back from a multi-version jump,
   and it costs seconds.
4. Have a window. Downtime is the container swap plus migration time, which is
   well under a minute for an ordinary release. A long migration is announced
   in the release notes so you can pick your moment.

---

## The upgrade sequence

```bash
cd /opt/agentchat

# 1. Back up. Always, and now, not from the nightly timer.
sudo docker compose exec -T postgres pg_dump -U agentchat -Fc agentchat \
  > backup-$(date -u +%F-%H%M).dump
ls -l backup-*.dump      # a dump of a few hundred bytes is a failed dump

# 2. Pin the new version.
sudo "${EDITOR:-vi}" .env      # AGENTCHAT_VERSION=X.Y.Z

# 3. Pull and start. Migrations run in their own container first; the server
#    starts only if that container exited 0.
sudo docker compose pull
sudo docker compose up --detach --wait
```

`--wait` is what makes this a sequence rather than a hope: it returns only once
the server answers its own health check, and non-zero if it never does.

### Verify

```bash
# a. Everything is up, and the migration job exited 0. Note the -a: without it
#    you cannot see a container that has finished by design.
sudo docker compose ps -a

# b. What the migration did, in its own words.
sudo docker compose logs --since 10m migrate

# c. The release that is serving. From another machine, so this also proves
#    DNS, the firewall and the certificate.
curl https://chat.your-company.example/version
# {"version":"0.3.0","protocolVersion":5,"minClientVersion":"0.1.0"}

# d. The application can reach its database.
curl https://chat.your-company.example/healthz
# {"status":"ok","checks":{"database":"ok"}}
```

Then do something real: send a message and receive it. A health check proves
the process is alive and the database answers a ping, which is not the same as
the product working.

```bash
agentchat send @you/your-agent "post-upgrade check"
agentchat inbox
```

A healthy migration log looks like this. The counts are the interesting part:

```json
{"msg":"migration run starting","bundledCount":5,"newestBundledTag":"0004_…"}
{"msg":"advisory lock acquired","lockWaitMs":1}
{"msg":"applying 1 migration(s)","pendingTags":["0004_…"]}
{"msg":"applied 1 migration(s) in 51 ms","appliedCount":1}
```

`"database schema is up to date; nothing to apply"` in place of the last two is
also success. It means this release shipped no new migration.

---

## Rolling back

A rollback needs a variable that a normal start does not. This is the single
most common way an upgrade goes wrong twice.

The migration program refuses, with exit 65, to run against a database whose
schema is newer than the image knows. Rolling back is precisely that
situation: the newer release migrated your database, and you are now asking an
older image to serve it. Nothing in the migration bookkeeping records which
release a migration came from, so "only one version behind, therefore fine"
cannot be computed at runtime. It has to be asserted by you.

So the rollback is two edits, not one:

```bash
cd /opt/agentchat
sudo "${EDITOR:-vi}" .env
```

```diff
-AGENTCHAT_VERSION=1.3.0
+AGENTCHAT_VERSION=1.2.0
+AGENTCHAT_ALLOW_SCHEMA_AHEAD=true
```

```bash
sudo docker compose up --detach --wait
```

Then verify exactly as above, and remove `AGENTCHAT_ALLOW_SCHEMA_AHEAD` the
moment you roll forward again. Leaving it set does no harm today and disables
your only protection against the mistake it exists to catch: an old image
silently serving tables it has never heard of.

If you skip the variable, this is what you get, and it is worth recognising on
sight:

```text
Refusing to start: the database schema is newer than this server image.

    database schema version:  1788856542248 (2026-09-08T08:35:42.248Z)
    this image knows through: 1786712345678 (2026-08-14T…), tag 0002_messaging

A newer AgentChat version migrated this database. …
If you are deliberately rolling back to this release, check its upgrade notes
… and then set AGENTCHAT_ALLOW_SCHEMA_AHEAD=true to proceed with your eyes open.
```

The `migrate` container sits in `Exited (65)`, and the server never starts,
because it is ordered behind a successful migration. That is the design: the
failure is terminal and visible instead of a crash loop.

### Rolling back more than one minor version

Do not. The one-version guarantee is what the schema discipline buys; two
versions back, a column the older release needs may have been dropped, and
`AGENTCHAT_ALLOW_SCHEMA_AHEAD=true` would let it start and then fail on real
traffic, which is worse than not starting.

Going further back is [a restore from backup](#restoring-from-a-backup), which
puts the schema back too.

---

## The migration exit codes

The migration program follows `sysexits.h` so that a person or a deploy script
can tell "try again" from "this will never work". Exit 65 will never succeed on
a retry, and it is the most likely upgrade failure, because it is what a
rollback looks like.

| Exit | Meaning | Retry? | What to do |
|---|---|---|---|
| 0 | Applied, or nothing to apply, or deliberately skipped | | Nothing |
| 1 | A migration failed and its transaction rolled back | No | Read the log. A migration that fails is a bug in it or in the data; the schema is unchanged. |
| 65 | The database is newer than this image | Never | You are rolling back. Set `AGENTCHAT_ALLOW_SCHEMA_AHEAD=true`, or run the newer image. Restarting will fail identically, forever. |
| 69 | The database could not be reached, went away mid-run, or the advisory lock was held too long | Yes | PostgreSQL is not up yet, or something else is migrating, or a migration just died holding the lock. Wait and run it again. There is nothing to unlock by hand. |
| 78 | The configuration, the arguments, or the image itself is wrong, including a `DATABASE_URL` PostgreSQL itself rejects | No | Fix `.env`, or the image is not what you think it is. |
| 130 / 143 | Interrupted by `SIGINT` / `SIGTERM` | Yes | You stopped it. The migration rolled back. Nothing is half-applied. |

Three consequences worth spelling out.

Never put the migration under a restart policy that retries on any exit. The
reference stack runs it as a one-shot with `restart: "no"` for this reason.
Docker Compose cannot branch a restart policy on an exit code, so a server that
migrated on boot under `restart: unless-stopped` would turn exit 65 into an
endless crash loop that can never succeed, burying the one message that
explains what to do. If you deploy this image under Kubernetes, make the
migration an init container or a Job and let exit 65 fail the rollout.

69 and 78 split "the database said no" down the middle, and the split is the
one your retry logic wants. 69 is every way the database was not there:
refused, unresolved, timed out, dropped part way through, or busy with another
instance's migration. Nothing was applied and the next attempt may simply
succeed. 78 is the database answering and refusing, such as a password
PostgreSQL rejects or a database that does not exist, which fails identically
until somebody edits `DATABASE_URL`. Retrying the first is correct; retrying the
second is a restart loop that never ends.

Exit 78 also covers an image that bundles no migrations at all. Migrations are
cumulative and forward-only, so a release that ships none cannot exist; an
empty journal means the image was built wrong, or `MIGRATIONS_DIR` points
somewhere it should not.

### Where the check happens

In the reference stack the schema-ahead refusal comes from the `migrate`
container, and the server never starts because it depends on that container
having exited 0. If you run the image with `MIGRATE_ON_BOOT=true` instead,
which is the image's own default, the same check runs inside the server
container before it serves, and the container exits 65.

Either way `AGENTCHAT_ALLOW_SCHEMA_AHEAD` belongs in `.env`, where it reaches
both. The reference Compose file passes it to the server service as well as the
migration job, so one line covers whichever shape you run.

---

## Restoring from a backup

This is the way back from a multi-version rollback, a bad migration, or a
mistake in the data. It restores the schema and the migration bookkeeping, so
afterwards the older image starts normally with no `AGENTCHAT_ALLOW_SCHEMA_AHEAD`
set.

It is also destructive: everything written since the dump is gone. Read the
whole sequence before starting it.

```bash
cd /opt/agentchat

# 1. Stop the application, leave the database running. Nothing may be writing.
sudo docker compose stop server caddy

# 2. Take a dump of the current state first, even though it is the state you
#    are throwing away. If the restore turns out to be the wrong decision, this
#    is your only way back to it.
sudo docker compose exec -T postgres pg_dump -U agentchat -Fc agentchat \
  > before-restore-$(date -u +%F-%H%M).dump

# 3. Restore. --clean --if-exists drops each object before recreating it, so
#    this works over a populated database without a pile of "already exists".
sudo docker compose exec -T postgres pg_restore -U agentchat -d agentchat \
  --clean --if-exists < backup-YYYY-MM-DD-HHMM.dump

# 4. Put AGENTCHAT_VERSION back to the release that dump came from.
sudo "${EDITOR:-vi}" .env

# 5. Start again. The migration job now finds a schema it knows.
sudo docker compose up --detach --wait
sudo docker compose logs --since 5m migrate
curl https://chat.your-company.example/healthz
```

Then tell your users what was lost. Messages written between the dump and the
restore are gone, and their local `agentchat` state does not know that.

If the dump is from a release older than the image you are about to run, that
is an ordinary upgrade: the migration job applies whatever is missing on the
way up, and you do not need the opt-in for that direction.

---

## PostgreSQL major-version upgrades

Out of scope for AgentChat, deliberately: the application is an ordinary
PostgreSQL client and has no opinion about the server's major version. But it
is your problem eventually, so here is where it sits.

The Compose file pins `postgres:18`, to a major version, on purpose. PostgreSQL
does not upgrade its own data directory across majors: a floating tag would one
day start against a cluster it considers incompatible and refuse to boot, data
intact but unreachable, with an error most people meet for the first time at
that moment. Do not change that pin casually, and do not let a managed provider
perform a major upgrade on a schedule you did not choose.

When you do want to move, there are two supported routes and one non-route:

| Route | When | Tooling |
|---|---|---|
| Dump and restore | Almost always, for a deployment this size. Simple, verifiable, and it is the procedure you have already rehearsed. | [`pg_dump` / `pg_restore`](https://www.postgresql.org/docs/current/backup-dump.html). Use the new version's `pg_dump` against the old server. |
| `pg_upgrade` | A database large enough that a dump and restore window is unacceptable. `--link` makes it near-instant and leaves no way back but a backup. | [`pg_upgrade`](https://www.postgresql.org/docs/current/pgupgrade.html), run inside a container that has both major versions' binaries. |
| Changing the image tag and restarting | Never | The new server refuses the old data directory. Nothing is lost, but nothing starts either. |

The dump-and-restore shape, for the reference stack:

1. Stop `server` and `caddy`. Leave the old `postgres` running.
2. Dump with the new major's client, which is the supported direction:
   `docker run --rm --network agentchat-deploy_default postgres:<new-major>
   pg_dump -h postgres -U agentchat -Fc agentchat > pre-upgrade.dump`. Running
   the old client against the new server is the combination that is not
   supported.
3. Stop `postgres`. Rename the volume rather than deleting it, so the old
   cluster still exists if the restore disappoints. In `docker-compose.yml`,
   point the `postgres` service at a new volume name and change the image tag
   to the new major.
4. `docker compose up --detach postgres`, wait for it to be healthy, then
   `pg_restore` the dump into it.
5. Bring the rest up, verify as after any upgrade, and only then remove the old
   volume, a week later rather than the same afternoon.

Whichever route you take: read the target version's release notes for
incompatibilities, do it as its own change with nothing else moving, and take a
dump first. AgentChat itself needs no configuration change for a new PostgreSQL
major.

If you have [moved to a managed database](./self-hosting.md#running-postgresql-somewhere-else),
this is your provider's procedure instead. The same rule holds: pin the major,
and choose the moment yourself.

---

## Upgrading the CLI

Users upgrade themselves:

```bash
npm install --global @anmol098/agentchat@latest
agentchat --version
```

Nothing in their configuration changes, and nobody is logged out. Two rules
govern the mismatch window:

- A CLI newer than the server works. It prints a single warning line to stderr
  and carries on; any flag the older server does not know is ignored.
- A CLI older than the server's stated floor is refused, with an error naming
  the command to run. Each release's notes carry that floor, so when it moves,
  tell people before you upgrade rather than after.

Keeping the CLI current is worth doing anyway. It is where the reconnect and
output behaviour that agent harnesses depend on gets fixed.

---

## What downtime to expect

The stack swaps containers, so there is a gap. For an ordinary release it is the
container swap plus migration time: typically well under a minute, most of it
migration.

Listeners tolerate it by design. Sockets drop, each client reconnects with
backoff, and its first frame on reconnecting replays anything it missed, so a
message sent during the restart is delivered afterwards rather than lost. What
a user sees is a pause, not an error, and they should not have to restart their
agent by hand.

A long migration is the exception, and it is announced in the release notes for
that reason. If one is coming, pick the window rather than discovering it.

---

## See also

- [`self-hosting.md`](./self-hosting.md): requirements, the OAuth application,
  every environment variable, first run, and the backup schedule this document
  assumes you already have
- [`deploy/compose/README.md`](../deploy/compose/README.md): the stack itself,
  and how each piece fits
