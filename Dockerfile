# syntax=docker/dockerfile:1

# AgentChat server image.
#
# This is the artefact both the reference deployment and every self-hoster
# runs. It is built once per release and promoted between environments rather
# than rebuilt per environment (Plan §12.1), so everything an operator needs to
# upgrade — including the SQL migrations — lives inside it. `docker compose
# pull server && docker compose up -d server` must never require a checkout of
# this repository (Plan §12.2).
#
#   docker build -t agentchat-server .
#   docker run --rm -e DATABASE_URL=postgres://... -p 3000:3000 agentchat-server
#   docker run --rm -e DATABASE_URL=postgres://... agentchat-server migrate
#
# Multi-arch release build:
#
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -t ghcr.io/<org>/agentchat-server:X.Y.Z --push .
#
# Licensing: this image combines AGPL-3.0-or-later code (`server/`) with MIT
# code (`packages/`), which is the direction the licence boundary allows. The
# combined work is conveyed under the AGPL, so the licence texts are copied to
# /app and a recipient of the image has them without a checkout (see LICENSE).

# ---------------------------------------------------------------------------
# Base image
# ---------------------------------------------------------------------------
# Node 24 rather than 22: the workspace declares `engines.node >= 22.12`, which
# leaves the 22 and 24 LTS lines, and `.nvmrc` pins local development to 24
# (Plan §1). Running the image on the same major that developers and CI use
# means a bug reproduces in all three places. The patch version is pinned
# exactly, in keeping with `save-exact=true` in `.npmrc`: a floating `node:24`
# would drift under a released tag and make an image un-reproducible.
#
# The digest pins that tag to an immutable manifest *index*, so it still
# resolves per-platform for amd64 and arm64 while removing the risk of the tag
# being repointed. Update the tag and the digest together.
#
# bookworm-slim rather than alpine: `pg` and `drizzle-orm` are pure JavaScript
# today, but glibc is what upstream Node builds and tests against, and a musl
# surprise in a transitive native dependency would surface in an operator's
# production rather than in CI. The size difference is not worth that risk for
# a server other people self-host.
ARG NODE_VERSION=24.20.0
ARG NODE_IMAGE=node:${NODE_VERSION}-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

FROM ${NODE_IMAGE} AS base

# Corepack activates the exact pnpm named by the root `packageManager` field,
# so the image is built by the same package manager version as CI and as
# developers use.
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN corepack enable
WORKDIR /workspace


# ---------------------------------------------------------------------------
# Stage 1 — manifests
# ---------------------------------------------------------------------------
# Layer ordering is the whole point of this stage. A dependency install must be
# invalidated by a change to a manifest or the lockfile and by nothing else; if
# a source edit invalidated it, every commit would reinstall 130-odd packages.
#
# The obvious way is to COPY each `package.json` by name, but this is a
# workspace whose members are globbed (`packages/*`), so that list goes stale
# the day `packages/client` lands and the failure is an opaque
# ERR_PNPM_OUTDATED_LOCKFILE. Instead this stage copies everything and prunes
# to just the files pnpm reads. The stage re-runs on every source change, but
# it is one `find`, and BuildKit keys the *next* stage's COPY on the content
# this one produces — identical unless a manifest really changed. So the
# install below stays cached.
FROM base AS manifests
WORKDIR /repo
COPY . .
#
# `-exec` rather than a pipe into `while read`: /bin/sh here is dash, which has
# no `pipefail`, so a `find` that failed mid-way would be swallowed by the exit
# status of the loop and produce a half-populated manifest tree.
RUN set -eu; \
    mkdir -p /manifests; \
    find . -name node_modules -prune -o \
        \( -name package.json \
        -o -name pnpm-lock.yaml \
        -o -name pnpm-workspace.yaml \
        -o -name .npmrc \) \
        -exec sh -eu -c 'mkdir -p "/manifests/$(dirname "$1")" && cp "$1" "/manifests/$1"' _ {} \;


# ---------------------------------------------------------------------------
# Stage 2 — build dependencies
# ---------------------------------------------------------------------------
# The full workspace install, development dependencies included: TypeScript has
# to compile somewhere. None of it reaches the runtime image.
FROM base AS deps
COPY --from=manifests /manifests/ ./
RUN pnpm install --frozen-lockfile


# ---------------------------------------------------------------------------
# Stage 3 — production dependencies
# ---------------------------------------------------------------------------
# The node_modules the runtime image actually ships. Separate from the build
# install so that no development dependency can reach production by accident,
# and built from the manifests alone so it is invalidated only by a manifest or
# lockfile change.
#
# This is `pnpm install --frozen-lockfile --prod` rather than `pnpm deploy`,
# which deserves an explanation because `pnpm deploy` is the tool ostensibly
# built for this job.
#
# `pnpm deploy` produces a single self-contained directory, which is a nicer
# shape than a workspace. But pnpm 10 refuses a modern deploy unless the
# workspace sets `inject-workspace-packages=true` (ERR_PNPM_DEPLOY_NONINJECTED_
# WORKSPACE), and that setting lives in the root manifest, which this task does
# not own; setting it on the command line instead fails with
# ERR_PNPM_LOCKFILE_CONFIG_MISMATCH, because the committed lockfile was
# resolved without it. That leaves `--legacy`, and the legacy implementation
# ignores the shared lockfile — it re-resolves every transitive range against
# the registry (proved here: `--legacy --offline` fails with
# ERR_PNPM_NO_OFFLINE_META because a frozen install never populated a metadata
# cache). For a release artefact that §12.1 promises is built once and promoted
# unchanged, "the lockfile decides what is in the image" is worth more than a
# tidier directory layout.
#
# So the workspace layout is preserved into the runtime image instead. pnpm's
# symlinks are relative — `server/node_modules/fastify` points at
# `../../node_modules/.pnpm/…`, and a workspace dependency such as
# `@agentchat/protocol` points at `../../packages/protocol` — so they resolve
# as long as the tree keeps its shape, which the COPYs below preserve. That is
# also why the server's own dependency on `packages/protocol` needs no special
# handling here: it is a link in a tree that is copied whole, not a package to
# be found and bundled.
FROM base AS prod-deps
COPY --from=manifests /manifests/ ./
RUN pnpm install --frozen-lockfile --prod


# ---------------------------------------------------------------------------
# Stage 4 — build
# ---------------------------------------------------------------------------
FROM deps AS build

COPY . .

# Compile, then shape the output into exactly what the runtime image copies.
# One instruction because these three steps have one product between them, and
# because a builder layer boundary here would buy nothing: none of this is
# shipped.
#
# 1. `pnpm --recursive` rather than a `--filter` on the server: the server's
#    dependency on `packages/protocol` is landing separately, and a recursive
#    build is correct both before and after that, in topological order, with no
#    list to keep in step.
#
# 2. `server/drizzle/` holds the SQL migrations that ship inside the image
#    (Plan §12.2). The first migration is being generated by the schema task
#    and may not exist on this branch yet, and `COPY` of a missing path is a
#    hard build error. Creating it here makes the runtime `COPY --from=build`
#    below correct whether the directory is absent, empty, or full — and lets
#    the entrypoint decide at run time what an empty one means, rather than
#    failing the build over it.
#
# 3. Type declarations and the incremental build database are compiler
#    artefacts, not runtime code. Source maps stay: they carry no source text,
#    cost a couple of hundred kilobytes, and are the difference between a
#    production stack trace that names `src/routes/health.ts:118` and one that
#    names a column offset in a compiled file.
RUN set -eu; \
    pnpm --recursive --if-present run build; \
    mkdir -p /workspace/server/drizzle; \
    for dir in /workspace/server/dist /workspace/packages/*/dist; do \
        [ -d "$dir" ] || continue; \
        find "$dir" \( -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.tsbuildinfo' \) -delete; \
    done


# ---------------------------------------------------------------------------
# Stage 5 — runtime
# ---------------------------------------------------------------------------
# Built from the base *image*, not from the `base` stage, so pnpm and the
# workspace never enter it.
FROM ${NODE_IMAGE} AS runtime

ARG AGENTCHAT_VERSION=0.0.0
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="agentchat-server" \
      org.opencontainers.image.description="AgentChat server: HTTP API, WebSocket routing, and persistence." \
      org.opencontainers.image.url="https://github.com/anmol098/agentchat" \
      org.opencontainers.image.source="https://github.com/anmol098/agentchat" \
      org.opencontainers.image.documentation="https://github.com/anmol098/agentchat/blob/main/docs/IMPLEMENTATION-PLAN.md" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later AND MIT" \
      org.opencontainers.image.version="${AGENTCHAT_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}"

# npm, npx, corepack and yarn ship with the Node image and have no business in
# a production runtime: they are a package manager, a network client, and an
# arbitrary-code-execution path, inside an image whose only job is to run one
# already-installed program. The assertion afterwards turns a future base image
# that relocates them into a build failure rather than a silent regression of
# this promise. It is written as an `if` rather than `! command -v npm`, which
# looks equivalent but is exempt from `set -e` and so would only ever be
# checked for whichever name happened to be last.
RUN set -eux; \
    rm -rf \
        /usr/local/lib/node_modules/npm \
        /usr/local/lib/node_modules/corepack \
        /usr/local/bin/npm \
        /usr/local/bin/npx \
        /usr/local/bin/corepack \
        /usr/local/bin/yarn \
        /usr/local/bin/yarnpkg \
        /opt/yarn-*; \
    for manager in npm npx pnpm yarn yarnpkg corepack; do \
        if command -v "$manager" >/dev/null 2>&1; then \
            echo "package manager '$manager' survived the cleanup" >&2; \
            exit 1; \
        fi; \
    done

WORKDIR /app

# Defaults an operator may override. `HOST` must be 0.0.0.0 or the server binds
# a loopback interface nothing outside the container can reach; `PORT` matches
# the server's own default and the health check below reads it.
# `MIGRATE_ON_BOOT` defaults to enabled, per Plan §12.2 — the documented
# upgrade path is `docker compose up -d server` and nothing else.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    MIGRATE_ON_BOOT=true \
    NODE_OPTIONS=--enable-source-maps

# The workspace's shape is reproduced under /app because pnpm's symlinks are
# relative to it (see the prod-deps stage). Dependencies come from prod-deps,
# which has manifests and node_modules and no source at all; compiled output
# comes from `build`. Nothing copies a `src` directory, and the two sources are
# disjoint, so there is no path by which one could smuggle the other's files
# in.
#
# Everything under /app is owned by root and world-readable. The process runs
# as `node`, so it cannot rewrite its own code or its migrations.
COPY --from=prod-deps --chown=root:root /workspace/node_modules ./node_modules
COPY --from=prod-deps --chown=root:root /workspace/packages ./packages
COPY --from=prod-deps --chown=root:root /workspace/server/node_modules ./server/node_modules
COPY --from=prod-deps --chown=root:root /workspace/server/package.json ./server/package.json

# `packages/protocol` is named explicitly rather than globbed because the
# licence boundary fixes it: `server` (AGPL) may depend on `protocol` (MIT) and
# on nothing else under `packages/` (see LICENSE). A second name appearing here
# would be a licensing bug, not a maintenance oversight.
COPY --from=build --chown=root:root /workspace/packages/protocol/dist ./packages/protocol/dist

COPY --from=build --chown=root:root /workspace/server/dist/src ./server/dist/src
COPY --from=build --chown=root:root /workspace/server/drizzle ./server/drizzle

# The AGPL requires the licence to travel with the work, and an operator who
# pulled an image should not need a checkout to read the terms they are running
# under.
COPY --chown=root:root LICENSE LICENSE-AGPL LICENSE-MIT ./

WORKDIR /app/server

# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
# Written inline rather than checked in as a script because this task owns
# `Dockerfile` and `.dockerignore` and nothing else.
#
# The script `exec`s node on every path that ends in a long-running process.
# That is not a style point: PID 1 is what receives the signals Docker and
# Kubernetes send, and `server/src/index.ts` installs SIGTERM and SIGINT
# handlers for a graceful shutdown that closes the HTTP server before the
# database pool. If a shell stayed PID 1, those signals would arrive at the
# shell — which as PID 1 ignores the ones it has no trap for — and every
# deployment restart would end in the orchestrator's SIGKILL and exit 137.
COPY <<'ENTRYPOINT' /usr/local/bin/agentchat-entrypoint
#!/bin/sh
#
# Usage:
#   agentchat-entrypoint serve      start the HTTP server (default)
#   agentchat-entrypoint migrate    apply pending migrations and exit
#   agentchat-entrypoint <cmd> ...  run something else inside this image
set -eu

APP_DIR=/app/server
SERVER_ENTRY="$APP_DIR/dist/src/index.js"
MIGRATIONS_DIR="$APP_DIR/drizzle"

# Where the migration runner is expected to live. Writing it is task T-502's
# job: `server/src/migrate.ts`, compiled by `tsc` to this path. It should take
# the advisory lock, apply everything in $MIGRATIONS_DIR not yet recorded in
# __drizzle_migrations, and exit non-zero on failure (Plan §12.2). It needs no
# new dependency: drizzle-orm's node-postgres migrator is already in this
# image, whereas drizzle-kit is a development dependency and is not.
MIGRATOR_ENTRY="$APP_DIR/dist/src/migrate.js"

log() { printf 'agentchat-entrypoint: %s\n' "$*" >&2; }

# 78 is EX_CONFIG from sysexits.h — "the image or its configuration is wrong" —
# as distinct from 1, which the server itself uses for a runtime failure.
die() { log "$*"; exit 78; }

# True when the image actually bundles migrations. Until the schema task lands
# `server/drizzle/`, this directory exists and is empty.
has_migrations() {
    [ -d "$MIGRATIONS_DIR" ] || return 1
    [ -n "$(find "$MIGRATIONS_DIR" -name '*.sql' -print -quit 2>/dev/null)" ]
}

require_migrator() {
    [ -f "$MIGRATOR_ENTRY" ] || die \
"no migration runner in this image (expected $MIGRATOR_ENTRY).
    This image predates the migration runner (task T-502). It can serve, but it
    cannot apply migrations. Do not work around this by setting
    MIGRATE_ON_BOOT=false unless you have applied them another way."
}

# Reads MIGRATE_ON_BOOT. An unrecognised value is an error rather than a silent
# fallback: an operator who wrote MIGRATE_ON_BOOT=no-please and got the default
# is exactly the person who needed to be told.
boot_migrations_enabled() {
    value="$(printf '%s' "${MIGRATE_ON_BOOT:-true}" | tr '[:upper:]' '[:lower:]')"
    case "$value" in
        1 | true | yes | on) return 0 ;;
        0 | false | no | off) return 1 ;;
        *) die "MIGRATE_ON_BOOT must be true or false (got '${MIGRATE_ON_BOOT:-}')." ;;
    esac
}

# Runs the migrator as a child rather than with exec, because the server has to
# start afterwards. A shell waiting on a child is the one window in which this
# script is PID 1, so the trap forwards SIGTERM to the migration instead of
# letting a stop request hang until the orchestrator's SIGKILL.
run_migrations() {
    migrate_pid=''
    forward() { [ -n "$migrate_pid" ] && kill -TERM "$migrate_pid" 2>/dev/null || true; }
    trap forward TERM INT

    log "applying migrations from $MIGRATIONS_DIR"
    node "$MIGRATOR_ENTRY" &
    migrate_pid=$!

    status=0
    wait "$migrate_pid" || status=$?
    trap - TERM INT

    # A status above 128 means the migration was signalled — either directly,
    # or because `wait` was interrupted by the SIGTERM the trap just forwarded.
    # Reporting that as "migrations failed" would send an operator hunting for
    # a bad migration when what actually happened is that they stopped the
    # container.
    if [ "$status" -gt 128 ]; then
        log "interrupted while migrating (signal $((status - 128))); not starting the server"
        exit "$status"
    fi

    [ "$status" -eq 0 ] || {
        log "migrations failed with exit $status; refusing to start the server"
        exit "$status"
    }
    log "migrations applied"
}

serve() {
    if boot_migrations_enabled; then
        if has_migrations; then
            require_migrator
            run_migrations
        else
            # Not a failure. An image that bundles no migrations has nothing to
            # apply, and refusing to start over it would make every build made
            # before the first migration unusable. The dangerous combination —
            # real migrations and no runner to apply them — is caught above.
            log "MIGRATE_ON_BOOT is enabled but this image bundles no migrations; nothing to apply"
        fi
    else
        log "MIGRATE_ON_BOOT is disabled; starting without applying migrations"
    fi

    [ -f "$SERVER_ENTRY" ] || die "server entrypoint missing: $SERVER_ENTRY"
    exec node "$SERVER_ENTRY"
}

case "${1:-serve}" in
    serve)
        serve
        ;;
    migrate)
        require_migrator
        shift
        exec node "$MIGRATOR_ENTRY" "$@"
        ;;
    help | --help | -h)
        sed -n '3,6p' "$0"
        ;;
    *)
        exec "$@"
        ;;
esac
ENTRYPOINT

# The health check is the one a load balancer would run: GET /healthz, which
# performs a real query against PostgreSQL and answers 503 when it cannot
# (server/src/routes/health.ts). `node` is the HTTP client because this image
# deliberately has neither curl nor wget.
COPY <<'HEALTHCHECK_SCRIPT' /usr/local/bin/agentchat-healthcheck
#!/bin/sh
set -eu
exec node --input-type=module -e '
const port = process.env.PORT ?? "3000";
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 3000);
try {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
} finally {
  clearTimeout(timer);
}
'
HEALTHCHECK_SCRIPT

RUN chmod 0755 /usr/local/bin/agentchat-entrypoint /usr/local/bin/agentchat-healthcheck

# uid/gid 1000 is the `node` user the base image already creates. A dedicated
# user would gain nothing over it and would renumber the filesystem for anyone
# who has already mounted a volume by uid.
#
# Written numerically rather than as `node` because a Kubernetes pod with
# `runAsNonRoot: true` refuses to start an image whose USER is a name: the
# kubelet cannot resolve it against the image's /etc/passwd, so it cannot prove
# the user is not root and fails closed.
USER 1000:1000

EXPOSE 3000

STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["agentchat-healthcheck"]

ENTRYPOINT ["/usr/local/bin/agentchat-entrypoint"]
CMD ["serve"]
