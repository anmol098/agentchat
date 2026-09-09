#!/usr/bin/env bash
#
# AgentChat upgrade and rollback verification (Plan §12.3, §12.6 items 2 and 3).
#
# WHAT THIS PROVES, AND WHY IT IS NOT THE MIGRATION LINTER
#
# `scripts/lint-migrations.mjs` reads migration SQL as text and rejects the
# statements that are usually a compatibility break. It says so itself: it
# cannot see a rename spelled as two statements in two files, it cannot tell
# whether a `-- contract-step:` marker is telling the truth, and it never
# executes anything. It is a fast gate over one file at a time.
#
# This script is the other half. It puts a real PostgreSQL in front of the real
# migration runner and asks the only questions that matter to somebody running
# their own server:
#
#   1. Upgrade. Old schema, rows in it, new binary. Did the rows survive the
#      migration byte for byte, and does the schema the previous release reads
#      still exist?
#   2. Rollback. The previous release against the migrated database refuses to
#      start (exit 65, Plan §12.2), names `AGENTCHAT_ALLOW_SCHEMA_AHEAD`, and
#      proceeds when the operator sets it — and then can still read *and write*
#      everything it knew. That last part is the N-1 promise in §12.3, and the
#      only way to check it is to try the writes.
#   3. Skipping versions. `X.Y` → `X.Y+2` in one boot, because §12.3 promises
#      cumulative migrations and nobody upgrades on every release.
#   4. That the checks above can fail. `selftest` builds migrations that break
#      compatibility in the four ways the rules name and requires every one of
#      them to be caught, plus safe migrations that must not be. A green run of
#      a check that cannot fail says nothing.
#
# The comparison is made against the *live catalog* rather than the SQL text,
# so it sees the cumulative result of every migration in the upgrade rather
# than each statement on its own.
#
# WHAT "THE PREVIOUS RELEASE" MEANS HERE
#
# A release's schema is the set of migrations its image bundles: the runner's
# version guard compares the newest journal entry it ships against the newest
# one recorded in the database, and that comparison is the whole guard
# (server/src/db/version-guard.ts). So "the previous release" is modelled as a
# *cut* of the migration journal — the first N entries — applied by the real
# runner. With `--previous-image` the cut is applied by the runner inside that
# image instead, which is what CI does once a release exists to point at.
#
# Before the first release there is no image to run, and the workflow says so
# rather than skipping the whole file: the cut is taken from the working tree
# and every assertion above still runs, on every pull request, from today.
#
# WHAT IT DOES NOT DO
#
# It does not seed through the HTTP API. Every write path is behind GitHub
# OAuth, and there is no way to obtain a token in CI without an OAuth app, so
# seeding is SQL against the previous release's schema. That is a weaker claim
# than "the old server wrote these rows" and it is recorded here rather than
# glossed: what is verified is the database contract, which is what a migration
# can actually break.
#
# LICENSING. This file sits in `scripts/`, which LICENSE and
# scripts/check-licenses.mjs place on the MIT side of the boundary. It only
# ever *invokes* the AGPL server as a separate process — no import, no linkage —
# so the boundary is intact in the direction that matters.
#
# Usage: scripts/upgrade-test.sh [command] [options]. Run with --help.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT
readonly MIGRATIONS_SOURCE="$REPO_ROOT/server/drizzle"
readonly MIGRATOR="$REPO_ROOT/server/dist/src/migrate.js"

# Exit code the runner uses for "the database is newer than this binary"
# (EX_DATAERR, Plan §12.2). Asserted rather than assumed: it is the number an
# operator's deploy script branches on.
readonly EXIT_SCHEMA_AHEAD=65

# Throwaway credentials for a container that lives for the length of one run.
readonly PG_USER=agentchat
readonly PG_PASSWORD=agentchat

POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:18}"
PREVIOUS_IMAGE=""
PREVIOUS_CUT=""
KEEP=false
COMMAND=all

PG_CONTAINER=""
PG_PORT=""
WORK_DIR=""
FAILURES=0

usage() {
    cat <<'USAGE'
Usage: scripts/upgrade-test.sh [command] [options]

Verifies the upgrade and rollback promises in Plan §12.3 and §12.6 against a
real PostgreSQL container and the real migration runner.

Commands:
  all              Every command below, in order. The default.
  upgrade          Previous release's schema, seeded, then the current build.
  rollback         The previous release against the migrated database.
  skip-versions    Two migrations applied in one boot, then rolled back across
                   both.
  selftest         Prove the compatibility assertions still catch a break.

Options:
  --previous-image REF  Run the previous release's side inside this image
                        (`REF migrate`) instead of the local build. This is the
                        real previous release; without it the previous release
                        is modelled from the working tree's journal.
  --previous-cut N      The previous release bundles the first N migrations.
                        Defaults to the image's bundled count when
                        --previous-image is given, otherwise to all but the
                        last one.
  --postgres-image REF  Database image. Default postgres:18, which must track
                        the major in docker-compose.yml.
  --keep                Leave the container running for inspection.
  -h, --help            Print this.

Requires docker, node, and a built server (`pnpm build`). Starts and removes its
own PostgreSQL container on an ephemeral port, so it never touches a database
you are using.
USAGE
}

# --------------------------------------------------------------------------
# Output. Everything operational goes to stderr so a caller can capture the
# verdict without the noise.
# --------------------------------------------------------------------------

log() { printf '%s\n' "$*" >&2; }
section() { printf '\n=== %s\n' "$*" >&2; }
pass() { printf '  ok    %s\n' "$*" >&2; }

fail() {
    printf '  FAIL  %s\n' "$*" >&2
    FAILURES=$((FAILURES + 1))
}

die() {
    printf 'upgrade-test: %s\n' "$*" >&2
    exit 1
}

# --------------------------------------------------------------------------
# Arguments
# --------------------------------------------------------------------------

parse_arguments() {
    if [ $# -gt 0 ]; then
        case "$1" in
            all | upgrade | rollback | skip-versions | selftest)
                COMMAND="$1"
                shift
                ;;
        esac
    fi

    while [ $# -gt 0 ]; do
        case "$1" in
            --previous-image)
                [ $# -ge 2 ] || die "--previous-image needs a value."
                PREVIOUS_IMAGE="$2"
                shift 2
                ;;
            --previous-cut)
                [ $# -ge 2 ] || die "--previous-cut needs a value."
                case "$2" in
                    '' | *[!0-9]*) die "--previous-cut must be a whole number (got '$2')." ;;
                esac
                PREVIOUS_CUT="$2"
                shift 2
                ;;
            --postgres-image)
                [ $# -ge 2 ] || die "--postgres-image needs a value."
                POSTGRES_IMAGE="$2"
                shift 2
                ;;
            --keep)
                KEEP=true
                shift
                ;;
            -h | --help)
                usage
                exit 0
                ;;
            *)
                die "Unknown argument '$1'. Try --help."
                ;;
        esac
    done
}

# --------------------------------------------------------------------------
# The database
# --------------------------------------------------------------------------

cleanup() {
    local status=$?

    if [ -n "$PG_CONTAINER" ] && [ "$KEEP" = true ]; then
        log "kept container $PG_CONTAINER on 127.0.0.1:$PG_PORT (remove it with: docker rm -f $PG_CONTAINER)"
    elif [ -n "$PG_CONTAINER" ]; then
        docker rm --force --volumes "$PG_CONTAINER" >/dev/null 2>&1 || true
    fi

    [ -n "$WORK_DIR" ] && rm -rf "$WORK_DIR"

    return $status
}

start_postgres() {
    # An ephemeral published port, not a fixed one. Several agents work in
    # parallel worktrees on this repository and a hard-coded port turns a second
    # concurrent run into a confusing bind failure — or worse, silently reuses
    # somebody else's database.
    PG_CONTAINER="agentchat-upgrade-test-$$-$RANDOM"
    docker run --detach --name "$PG_CONTAINER" \
        --env "POSTGRES_USER=$PG_USER" \
        --env "POSTGRES_PASSWORD=$PG_PASSWORD" \
        --env "POSTGRES_DB=postgres" \
        --publish 127.0.0.1::5432 \
        "$POSTGRES_IMAGE" >/dev/null

    PG_PORT="$(docker port "$PG_CONTAINER" 5432/tcp | head -n 1 | sed 's/.*://')"
    [ -n "$PG_PORT" ] || die "could not read the published port of $PG_CONTAINER."

    # Readiness is a real query over TCP, and both halves of that are load
    # bearing.
    #
    # The official image initialises the cluster by starting a *temporary*
    # server, running the init scripts against it, and shutting it down before
    # starting the real one. That temporary server listens on the Unix socket
    # and deliberately not on TCP. So a socket-based `pg_isready` can answer
    # "ready" for the server that is about to be stopped, and the next command
    # finds the socket gone — which is exactly how this failed on a CI runner
    # while passing on a developer's machine, where the image was already warm
    # and initialisation had happened on a previous run.
    #
    # A query rather than `pg_isready` because `pg_isready` reports a listening
    # socket, and PostgreSQL listens several seconds before it will answer.
    local attempt=0
    until docker exec "$PG_CONTAINER" \
        psql --host 127.0.0.1 --port 5432 --username "$PG_USER" --dbname postgres \
        --quiet --no-align --tuples-only --command 'SELECT 1' >/dev/null 2>&1; do
        attempt=$((attempt + 1))
        [ "$attempt" -lt 60 ] || die "PostgreSQL in $PG_CONTAINER never became ready."
        sleep 1
    done

    log "postgres ($POSTGRES_IMAGE) ready in $PG_CONTAINER on 127.0.0.1:$PG_PORT"
}

# Runs SQL from stdin against one database. `psql` is reached through the
# container so the host needs no client installed.
sql() {
    # `--host 127.0.0.1` inside the container, for the same reason the readiness
    # check uses TCP: it can only ever reach this container's server, and it
    # cannot be answered by the initialisation server that owns the socket
    # earlier in the container's life.
    docker exec --interactive "$PG_CONTAINER" \
        psql --host 127.0.0.1 --port 5432 --username "$PG_USER" --dbname "$1" \
        --set ON_ERROR_STOP=1 --quiet --no-align --tuples-only --field-separator '|'
}

# A database per scenario, dropped first, so any command is safe to re-run.
reset_database() {
    # WITH (FORCE) because a connection left over from a previous run would
    # otherwise make this script fail on its second invocation rather than its
    # first, which is the least helpful moment to discover it.
    printf 'SET client_min_messages TO warning;\nDROP DATABASE IF EXISTS %s WITH (FORCE);\nCREATE DATABASE %s;\n' "$1" "$1" | sql postgres >/dev/null
}

host_database_url() { printf 'postgres://%s:%s@127.0.0.1:%s/%s' "$PG_USER" "$PG_PASSWORD" "$PG_PORT" "$1"; }
container_database_url() { printf 'postgres://%s:%s@127.0.0.1:5432/%s' "$PG_USER" "$PG_PASSWORD" "$1"; }

# --------------------------------------------------------------------------
# Migration sets
# --------------------------------------------------------------------------

journal_entry_count() {
    node --input-type=commonjs -e '
        const journal = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
        process.stdout.write(String(journal.entries.length));
    ' "$1/meta/_journal.json"
}

# Builds the migration directory a release with `count` migrations would ship:
# the same SQL files, and a journal truncated to its first `count` entries. The
# truncated journal is what makes the version guard treat the runner as older,
# because the guard's notion of "what this binary knows" is exactly the newest
# `when` in the journal beside it.
cut_migrations() {
    local count="$1" destination="$2"

    mkdir -p "$destination/meta"
    cp "$MIGRATIONS_SOURCE"/*.sql "$destination/"
    node --input-type=commonjs -e '
        const fs = require("node:fs");
        const [source, destination, count] = process.argv.slice(1);
        const journal = JSON.parse(fs.readFileSync(source, "utf8"));
        journal.entries = journal.entries.slice(0, Number(count));
        fs.writeFileSync(destination, JSON.stringify(journal, null, 2));
    ' "$MIGRATIONS_SOURCE/meta/_journal.json" "$destination/meta/_journal.json" "$count"
}

# Appends one synthetic migration to a copy of the full set. Used only by
# `selftest`, to construct the breaks the rules are supposed to catch.
append_migration() {
    local destination="$1" tag="$2" sql_file="$3"

    cp "$sql_file" "$destination/$tag.sql"
    node --input-type=commonjs -e '
        const fs = require("node:fs");
        const [path, tag] = process.argv.slice(1);
        const journal = JSON.parse(fs.readFileSync(path, "utf8"));
        const last = journal.entries[journal.entries.length - 1];
        journal.entries.push({
            idx: journal.entries.length,
            version: last.version,
            // Strictly newer than every existing entry: that ordering is what
            // the runner uses to decide what is pending.
            when: last.when + 1000,
            tag,
            breakpoints: true,
        });
        fs.writeFileSync(path, JSON.stringify(journal, null, 2));
    ' "$destination/meta/_journal.json" "$tag"
}

# Runs the migration runner once. `role` picks which binary: `old` may be the
# previous release's image, `new` is always this build.
#
# Output is captured rather than streamed so an assertion can look at the
# message an operator would read. It is echoed on an unexpected status.
run_migrator() {
    local role="$1" database="$2" migrations="$3" allow_ahead="$4"
    local status=0

    : >"$WORK_DIR/runner.log"

    if [ "$role" = old ] && [ -n "$PREVIOUS_IMAGE" ]; then
        # Sharing the database container's network namespace means the URL
        # inside the container is the same one the image would use in a compose
        # stack, and no extra port has to be published for it.
        docker run --rm --network "container:$PG_CONTAINER" \
            --volume "$migrations:/migrations:ro" \
            --env "DATABASE_URL=$(container_database_url "$database")" \
            --env "MIGRATIONS_DIR=/migrations" \
            --env "AGENTCHAT_ALLOW_SCHEMA_AHEAD=$allow_ahead" \
            "$PREVIOUS_IMAGE" migrate >"$WORK_DIR/runner.log" 2>&1 || status=$?
    else
        DATABASE_URL="$(host_database_url "$database")" \
            AGENTCHAT_ALLOW_SCHEMA_AHEAD="$allow_ahead" \
            node "$MIGRATOR" --migrations "$migrations" >"$WORK_DIR/runner.log" 2>&1 || status=$?
    fi

    return $status
}

# Asserts the runner exited with the expected status, and prints its output when
# it did not — an unexplained number is the least useful thing a CI log can hold.
assert_migrator() {
    local expected="$1" label="$2"
    shift 2
    local status=0

    run_migrator "$@" || status=$?

    if [ "$status" -eq "$expected" ]; then
        pass "$label (exit $status)"
        return 0
    fi

    fail "$label: expected exit $expected, got $status"
    sed 's/^/        /' "$WORK_DIR/runner.log" >&2
    return 1
}

applied_migration_count() {
    printf 'SELECT count(*) FROM drizzle.__drizzle_migrations;\n' | sql "$1" | tr -d '[:space:]'
}

# --------------------------------------------------------------------------
# Seed data
#
# One row in every table the given migration cut created, with the identifier
# formats the CHECK constraints demand. `suffix` is two hex digits, which both
# completes a UUIDv7-shaped identifier and makes a second, non-colliding copy of
# the whole graph — that second copy is how the rollback job proves the previous
# release can still *write*, not merely read.
# --------------------------------------------------------------------------

seed_sql() {
    local cut="$1" suffix="$2"

    cat <<SQL
INSERT INTO users (id, github_id, username, display_name, email)
VALUES ('usr_01890000-0000-7000-8000-0000000000$suffix', 'gh-$suffix', 'seed-user-$suffix', 'Seed User $suffix', 'seed-$suffix@example.test');

INSERT INTO projects (id, slug, name, created_by)
VALUES ('prj_01890000-0000-7000-8000-0000000000$suffix', 'seed-project-$suffix', 'Seed Project $suffix', 'usr_01890000-0000-7000-8000-0000000000$suffix');

INSERT INTO project_members (project_id, user_id, role)
VALUES ('prj_01890000-0000-7000-8000-0000000000$suffix', 'usr_01890000-0000-7000-8000-0000000000$suffix', 'owner');

INSERT INTO project_invites (id, project_id, code, created_by, expires_at, max_uses, uses)
VALUES ('inv_01890000-0000-7000-8000-0000000000$suffix', 'prj_01890000-0000-7000-8000-0000000000$suffix', upper('SEEDCODE${suffix}'), 'usr_01890000-0000-7000-8000-0000000000$suffix', now() + interval '7 days', 5, 1);

INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
VALUES ('usr_01890000-0000-7000-8000-0000000000$suffix', md5('seed-$suffix') || md5('token-$suffix'), now() + interval '30 days');
SQL

    if [ "$cut" -ge 2 ]; then
        cat <<SQL
INSERT INTO agents (id, user_id, name)
VALUES ('agt_01890000-0000-7000-8000-0000000000$suffix', 'usr_01890000-0000-7000-8000-0000000000$suffix', 'seed-agent-$suffix');

INSERT INTO agent_projects (agent_id, project_id)
VALUES ('agt_01890000-0000-7000-8000-0000000000$suffix', 'prj_01890000-0000-7000-8000-0000000000$suffix');
SQL
    fi
}

# Status is checked rather than left to `set -e`: every scenario runs inside a
# `||` list, which disables errexit for everything it calls. A seed that failed
# silently would leave the digests comparing two empty databases and every
# assertion downstream would pass while proving nothing.
seed() {
    if seed_sql "$2" "$3" | sql "$1" >"$WORK_DIR/seed.log" 2>&1; then
        return 0
    fi

    fail "seeding the previous release's schema"
    sed 's/^/        /' "$WORK_DIR/seed.log" >&2
    return 1
}

# The previous release's writes, replayed against the migrated schema and rolled
# back. This is the assertion that catches the migration which is invisible to a
# catalog diff and to the linter alike: anything that makes a statement the old
# release still issues fail — a new constraint, a trigger, a narrowed CHECK.
assert_old_writes_still_work() {
    local database="$1" cut="$2" label="$3"

    {
        printf 'BEGIN;\n'
        seed_sql "$cut" b7
        printf 'ROLLBACK;\n'
    } >"$WORK_DIR/replay.sql"

    if sql "$database" <"$WORK_DIR/replay.sql" >"$WORK_DIR/replay.log" 2>&1; then
        pass "$label"
    else
        fail "$label"
        sed 's/^/        /' "$WORK_DIR/replay.log" >&2
    fi
}

# --------------------------------------------------------------------------
# Schema and data comparison
# --------------------------------------------------------------------------

# Every column of every base table in `public`, as
# `table|column|type|is_nullable|default?`. This is the previous release's view
# of the database, taken from the catalog rather than from the SQL that built it,
# so the comparison sees the cumulative effect of an upgrade rather than each
# statement alone.
snapshot_schema() {
    cat <<'SQL' | sql "$1" | sort >"$2"
SELECT c.table_name, c.column_name, c.data_type, c.is_nullable,
       CASE WHEN c.column_default IS NULL THEN 'nodefault' ELSE 'default' END
FROM information_schema.columns c
JOIN information_schema.tables t
  ON t.table_schema = c.table_schema
 AND t.table_name = c.table_name
 AND t.table_type = 'BASE TABLE'
WHERE c.table_schema = 'public';
SQL
}

# A digest of every seeded table, over exactly the columns the previous release
# knows. Restricting to those columns is the point: a column added by the
# upgrade must not change the answer, while a lost, reordered or rewritten row
# must.
digest_data() {
    local database="$1" snapshot="$2" output="$3"

    # `q` carries the SQL string quote as a variable rather than an escape,
    # because mawk — the awk on the CI runner — does not read \x27.
    awk -F'|' -v q="'" '
        { columns[$1] = (columns[$1] == "" ? "" : columns[$1] ", ") "\"" $2 "\"::text" }
        END {
            for (table in columns)
                printf "SELECT %s%s%s, count(*), coalesce(md5(string_agg(r, chr(10) ORDER BY r)), %sempty%s) FROM (SELECT concat_ws(chr(31), %s) AS r FROM \"%s\") s;\n", \
                       q, table, q, q, q, columns[table], table
        }' "$snapshot" |
        sql "$database" | sort >"$output"
}

assert_data_survived() {
    local before="$1" after="$2" label="$3"

    if diff -u "$before" "$after" >"$WORK_DIR/data.diff"; then
        pass "$label ($(wc -l <"$before" | tr -d ' ') tables digested)"
    else
        fail "$label: seeded rows changed across the upgrade"
        sed 's/^/        /' "$WORK_DIR/data.diff" >&2
    fi
}

# The previous release's columns that are still there, restricted to tables
# whose shape survived whole.
#
# An approved contract step removes a column, and the previous release's rows in
# that table can then no longer be digested with the previous release's column
# list — the query would name a column that is gone. Comparing that table over a
# different set of columns instead would be a comparison that quietly means
# something else, so the table is named and excluded, and every other table is
# still compared byte for byte.
surviving_shape() {
    awk -F'|' '
        NR == FNR { present[$1 "." $2] = 1; next }
        { count++; line[count] = $0; owner[count] = $1
          if (!($1 "." $2 in present)) broken[$1] = 1 }
        END { for (i = 1; i <= count; i++) if (!(owner[i] in broken)) print line[i] }
    ' "$2" "$1"
}

# Keeps the digest lines whose table is still in the given snapshot.
digest_for_tables() {
    awk -F'|' 'NR == FNR { keep[$1] = 1; next } ($1 in keep)' "$2" "$1"
}

# The expand/contract rules of Plan §12.3, applied to the two catalog snapshots.
#
# Removals and narrowings are what a contract step legitimately does, so they are
# fatal only when no migration in this upgrade carries a `-- contract-step:`
# marker — the same human assertion the linter checks the *form* of. A new
# NOT NULL column with no default on a table that already existed has no such
# escape: there is no release sequence in which the previous version's INSERT,
# which cannot mention a column it has never heard of, still succeeds.
assert_schema_compatible() {
    local before="$1" after="$2" marker="$3" label="$4"

    if awk -F'|' -v marker="$marker" '
        BEGIN { failed = 0 }
        NR == FNR { old[$1 "." $2] = $0; old_table[$1] = 1; next }
        { new[$1 "." $2] = $0; new_table[$1] = 1 }
        END {
            for (key in old) {
                split(old[key], o, "|")
                if (!(o[1] in new_table)) {
                    if (!(o[1] in reported)) {
                        reported[o[1]] = 1
                        removed("table " o[1] " was dropped")
                    }
                    continue
                }
                if (!(key in new)) { removed("column " key " was dropped"); continue }

                split(new[key], n, "|")
                if (o[3] != n[3]) removed("column " key " changed type: " o[3] " -> " n[3])
                if (o[4] == "YES" && n[4] == "NO") removed("column " key " became NOT NULL")
                if (o[5] == "default" && n[5] == "nodefault") removed("column " key " lost its default")
            }

            for (key in new) {
                split(new[key], n, "|")
                if (!(n[1] in old_table) || (key in old)) continue
                if (n[4] == "NO" && n[5] == "nodefault")
                    breaks("column " key " was added NOT NULL with no default to a table the previous release writes")
            }

            exit failed
        }
        function removed(message) {
            if (marker == "yes") print "  note  approved contract step: " message
            else breaks(message)
        }
        function breaks(message) { print "  FAIL  " message; failed = 1 }
    ' "$before" "$after" >&2; then
        pass "$label"
    else
        fail "$label: the migrated schema breaks the previous release"
    fi
}

# Whether any migration applied by this upgrade claims to be a contract step.
# Coarse on purpose, and the same judgement the linter makes: the marker is a
# human assertion that the expand half already shipped, and nothing mechanical
# can confirm it.
applied_migrations_carry_marker() {
    local from_cut="$1" migrations="$2"
    local tags

    tags="$(node --input-type=commonjs -e '
        const journal = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
        process.stdout.write(journal.entries.slice(Number(process.argv[2])).map((e) => e.tag).join("\n"));
    ' "$migrations/meta/_journal.json" "$from_cut")"

    local tag
    while IFS= read -r tag; do
        [ -n "$tag" ] || continue
        if grep -qiE '^[[:space:]]*--[[:space:]]*contract-step:' "$migrations/$tag.sql"; then
            printf 'yes'
            return 0
        fi
    done <<<"$tags"

    printf 'no'
}

# --------------------------------------------------------------------------
# The scenarios
#
# `verify_upgrade` is the whole pipeline — old release, seed, upgrade, assert —
# parameterised by the cut and the migration set upgraded to. Every command
# below is a call to it, and so is every case in `selftest`, which is what makes
# the self-test a test of the real check rather than of a copy of it.
# --------------------------------------------------------------------------

verify_upgrade() {
    local database="$1" cut="$2" migrations="$3"
    local before_failures=$FAILURES

    reset_database "$database"

    local old_migrations="$WORK_DIR/$database-previous"
    rm -rf "$old_migrations"
    cut_migrations "$cut" "$old_migrations"

    assert_migrator 0 "previous release migrates an empty database to its own schema ($cut of $(journal_entry_count "$migrations"))" \
        old "$database" "$old_migrations" false || return 1

    seed "$database" "$cut" a1 || return 1
    snapshot_schema "$database" "$WORK_DIR/$database-schema-before"
    digest_data "$database" "$WORK_DIR/$database-schema-before" "$WORK_DIR/$database-data-before"

    # An empty seed would make every comparison below trivially true, so the
    # rows are counted before anything is asserted about them.
    local seeded_rows
    seeded_rows="$(awk -F'|' '{ total += $2 } END { print total + 0 }' "$WORK_DIR/$database-data-before")"
    if [ "$seeded_rows" -gt 0 ]; then
        pass "seeded $seeded_rows rows into the previous release's schema"
    else
        fail "the seed wrote no rows, so nothing below would be proving anything"
        return 1
    fi

    local applied_before applied_after
    applied_before="$(applied_migration_count "$database")"

    assert_migrator 0 "current build migrates the previous release's database" \
        new "$database" "$migrations" false || return 1

    applied_after="$(applied_migration_count "$database")"
    if [ "$applied_after" -gt "$applied_before" ]; then
        pass "applied $((applied_after - applied_before)) migration(s) on top of $applied_before"
    else
        fail "the upgrade applied nothing: $applied_before recorded migrations before and after"
    fi

    snapshot_schema "$database" "$WORK_DIR/$database-schema-after"

    # The comparable shape is worked out before the data is compared, so that an
    # approved contract step narrows what can be compared instead of failing the
    # digest with a column that no longer exists.
    surviving_shape "$WORK_DIR/$database-schema-before" "$WORK_DIR/$database-schema-after" \
        >"$WORK_DIR/$database-schema-shared"
    local excluded
    excluded="$(comm -23 \
        <(cut -d'|' -f1 "$WORK_DIR/$database-schema-before" | sort -u) \
        <(cut -d'|' -f1 "$WORK_DIR/$database-schema-shared" | sort -u) | tr '\n' ' ')"
    [ -z "$excluded" ] || log "  note  not comparable after this upgrade, a column they held is gone: $excluded"

    digest_data "$database" "$WORK_DIR/$database-schema-shared" "$WORK_DIR/$database-data-after"
    digest_for_tables "$WORK_DIR/$database-data-before" "$WORK_DIR/$database-schema-shared" \
        >"$WORK_DIR/$database-data-comparable"

    assert_data_survived "$WORK_DIR/$database-data-comparable" "$WORK_DIR/$database-data-after" \
        "seeded rows survived the upgrade unchanged"
    assert_schema_compatible "$WORK_DIR/$database-schema-before" "$WORK_DIR/$database-schema-after" \
        "$(applied_migrations_carry_marker "$cut" "$migrations")" \
        "the migrated schema still satisfies the previous release"

    # Replayed here as well as in the rollback command, because a constraint or
    # a trigger that rejects the previous release's writes changes no column and
    # is therefore invisible to the catalog comparison above.
    assert_old_writes_still_work "$database" "$cut" \
        "the previous release's writes still succeed against the migrated schema"

    [ "$FAILURES" -eq "$before_failures" ]
}

# Plan §12.6 item 3. The previous release, against the database the upgrade just
# migrated. Depends on `verify_upgrade` having run against this database.
verify_rollback() {
    local database="$1" cut="$2"
    local old_migrations="$WORK_DIR/$database-previous"

    # Refusing by default is the behaviour, not an inconvenience: a rollback
    # onto a newer schema is a deliberate act and has to read as one in the
    # deploy configuration (Plan §12.2).
    assert_migrator "$EXIT_SCHEMA_AHEAD" "previous release refuses the migrated database by default" \
        old "$database" "$old_migrations" false

    if grep -q 'AGENTCHAT_ALLOW_SCHEMA_AHEAD' "$WORK_DIR/runner.log"; then
        pass "the refusal names AGENTCHAT_ALLOW_SCHEMA_AHEAD"
    else
        fail "the refusal does not name AGENTCHAT_ALLOW_SCHEMA_AHEAD, so an operator cannot act on it"
        sed 's/^/        /' "$WORK_DIR/runner.log" >&2
    fi

    assert_migrator 0 "previous release accepts the migrated database with the opt-in set" \
        old "$database" "$old_migrations" true

    digest_data "$database" "$WORK_DIR/$database-schema-shared" "$WORK_DIR/$database-data-rollback"
    assert_data_survived "$WORK_DIR/$database-data-comparable" "$WORK_DIR/$database-data-rollback" \
        "the previous release still reads its own rows"

    assert_old_writes_still_work "$database" "$cut" \
        "the previous release can still write every row shape it knows"
}

command_upgrade() {
    section "Upgrade: the previous release's database, migrated by this build"
    verify_upgrade agentchat_upgrade "$PREVIOUS_CUT" "$MIGRATIONS_SOURCE" || true
}

command_rollback() {
    section "Rollback: the previous release against the migrated database"

    # Runs the upgrade first when invoked on its own, because §12.6 defines the
    # rollback job as running after the upgrade job, on its database.
    if [ ! -f "$WORK_DIR/agentchat_upgrade-data-before" ]; then
        verify_upgrade agentchat_upgrade "$PREVIOUS_CUT" "$MIGRATIONS_SOURCE" || return 0
    fi

    verify_rollback agentchat_upgrade "$PREVIOUS_CUT"
}

command_skip_versions() {
    local total
    total="$(journal_entry_count "$MIGRATIONS_SOURCE")"

    if [ "$total" -lt 3 ]; then
        log "skip-versions needs at least three migrations to skip one; the tree has $total."
        return 0
    fi

    section "Skipping versions: $((total - 2)) of $total migrations, upgraded in one boot"
    if verify_upgrade agentchat_skip $((total - 2)) "$MIGRATIONS_SOURCE"; then
        verify_rollback agentchat_skip $((total - 2))
    fi
}

# --------------------------------------------------------------------------
# selftest
#
# Every case below is run through the same `verify_upgrade` the real check uses.
# Half of them are safe migrations that must pass, because the failure that
# actually kills a check like this is the false positive: one that rejects a
# routine `ADD COLUMN` gets worked around, and then it is not a gate any more.
# --------------------------------------------------------------------------

selftest_case() {
    local name="$1" expectation="$2" sql_body="$3"
    local database="agentchat_selftest"
    local migrations="$WORK_DIR/selftest-migrations"
    local before_failures=$FAILURES
    local real_total

    # The cut is the whole real journal, so the upgrade under test is *only* the
    # synthetic migration below. That is what every case is written to describe:
    # each one names one statement and says whether that statement should be
    # caught.
    #
    # It used to be $PREVIOUS_CUT, which put the tree's newest real migration
    # into the upgrade alongside the synthetic one, and that silently disarmed
    # three of these cases the first time a real migration carried a
    # `-- contract-step:` marker. `applied_migrations_carry_marker` is coarse on
    # purpose — one marker anywhere in the applied range excuses every removal in
    # it — so a legitimately marked migration was excusing the *unmarked* drop
    # this case exists to catch, and the self-test reported that a check which
    # could no longer fail was passing. Found in T-060, whose migration is the
    # first real one to carry a marker.
    real_total="$(journal_entry_count "$MIGRATIONS_SOURCE")"

    rm -rf "$migrations"
    cut_migrations "$real_total" "$migrations"
    printf '%s\n' "$sql_body" >"$WORK_DIR/selftest.sql"
    append_migration "$migrations" 9999_selftest "$WORK_DIR/selftest.sql"

    log ""
    log "  case: $name (must $expectation)"

    local outcome=caught
    if verify_upgrade "$database" "$real_total" "$migrations" >/dev/null 2>&1; then
        outcome=passed
    fi

    # The findings the case produced are the check's own output; they are not
    # the run's verdict, so they are discarded and replaced by whether the
    # outcome was the expected one.
    FAILURES=$before_failures

    if [ "$outcome" = "$expectation" ]; then
        pass "$name: $outcome"
    else
        fail "$name: expected the check to have $expectation, but it $outcome"
    fi
}

command_selftest() {
    section "Self-test: prove the compatibility assertions can still fail"

    selftest_case 'a nullable column and a new table' passed "$(
        cat <<'SQL'
ALTER TABLE "users" ADD COLUMN "timezone" text;
CREATE TABLE "user_settings" ("user_id" text PRIMARY KEY NOT NULL, "theme" text NOT NULL);
SQL
    )"

    selftest_case 'a NOT NULL column with a constant default' passed "$(
        cat <<'SQL'
ALTER TABLE "projects" ADD COLUMN "archived" boolean DEFAULT false NOT NULL;
SQL
    )"

    # This pair differs by one comment line and nothing else, which is the point:
    # the marker is what separates a contract step from a break, and it is the
    # only thing that separates them.
    selftest_case 'an unmarked dropped column' caught "$(
        cat <<'SQL'
ALTER TABLE "project_invites" DROP COLUMN "revoked_at";
SQL
    )"

    selftest_case 'an unmarked renamed column' caught "$(
        cat <<'SQL'
ALTER TABLE "projects" RENAME COLUMN "name" TO "title";
SQL
    )"

    # The marker is a human assertion that the previous release stopped reading
    # the column, which is what makes a contract step legal — and it excuses the
    # catalog finding only. It can never excuse a write that fails: if the
    # previous release still inserted this column, the replay above would reject
    # the migration whatever the comment claimed.
    selftest_case 'a dropped column carrying a contract-step marker' passed "$(
        cat <<'SQL'
-- contract-step: v0.1.0 — v0.1.0 stopped reading project_invites.revoked_at
ALTER TABLE "project_invites" DROP COLUMN "revoked_at";
SQL
    )"

    # No marker escape, and deliberately spelled the way it would reach
    # production: add with a default so the statement succeeds on a populated
    # table, then drop the default. Every row is valid, the migration is green,
    # and the previous release's INSERT — which cannot mention the column — now
    # fails on every write. The linter sees two individually reasonable
    # statements; only running them shows the break.
    selftest_case 'a NOT NULL column whose default is then dropped' caught "$(
        cat <<'SQL'
ALTER TABLE "projects" ADD COLUMN "tier" text DEFAULT 'free' NOT NULL;
ALTER TABLE "projects" ALTER COLUMN "tier" DROP DEFAULT;
SQL
    )"

    # A CHECK the previous release's rows and writes cannot satisfy. Invisible
    # to a catalog diff — no column changed — and caught only by replaying the
    # previous release's writes.
    selftest_case 'a constraint the previous release cannot satisfy' caught "$(
        cat <<'SQL'
ALTER TABLE "projects" ADD CONSTRAINT "projects_slug_prefixed" CHECK ("projects"."slug" LIKE 'v2-%') NOT VALID;
SQL
    )"
}

# --------------------------------------------------------------------------

main() {
    parse_arguments "$@"

    command -v docker >/dev/null 2>&1 || die "docker is required."
    command -v node >/dev/null 2>&1 || die "node is required."
    [ -f "$MIGRATOR" ] || die "no migration runner at $MIGRATOR. Run 'pnpm build' first."
    [ -f "$MIGRATIONS_SOURCE/meta/_journal.json" ] || die "no migration journal in $MIGRATIONS_SOURCE."

    WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentchat-upgrade-test.XXXXXX")"
    trap cleanup EXIT

    local total
    total="$(journal_entry_count "$MIGRATIONS_SOURCE")"

    if [ -n "$PREVIOUS_IMAGE" ] && [ -z "$PREVIOUS_CUT" ]; then
        # The previous release's schema is whatever its image bundles, so ask
        # the image rather than assuming it is one migration behind.
        docker run --rm --entrypoint cat "$PREVIOUS_IMAGE" /app/server/drizzle/meta/_journal.json \
            >"$WORK_DIR/previous-journal.json" ||
            die "could not read the migration journal out of $PREVIOUS_IMAGE."
        mkdir -p "$WORK_DIR/previous-image/meta"
        cp "$WORK_DIR/previous-journal.json" "$WORK_DIR/previous-image/meta/_journal.json"
        PREVIOUS_CUT="$(journal_entry_count "$WORK_DIR/previous-image")"
        log "previous release image $PREVIOUS_IMAGE bundles $PREVIOUS_CUT of this tree's $total migrations"
    fi

    [ -n "$PREVIOUS_CUT" ] || PREVIOUS_CUT=$((total - 1))

    if [ "$PREVIOUS_CUT" -lt 1 ] || [ "$PREVIOUS_CUT" -ge "$total" ]; then
        die "--previous-cut must be between 1 and $((total - 1)); got $PREVIOUS_CUT. A previous release that bundles every migration this tree has is not an upgrade."
    fi

    log "repository: $REPO_ROOT"
    log "previous release: first $PREVIOUS_CUT of $total migrations, applied by ${PREVIOUS_IMAGE:-the local build}"

    start_postgres

    case "$COMMAND" in
        upgrade) command_upgrade ;;
        rollback) command_rollback ;;
        skip-versions) command_skip_versions ;;
        selftest) command_selftest ;;
        all)
            command_upgrade
            command_rollback
            command_skip_versions
            command_selftest
            ;;
    esac

    printf '\n' >&2
    if [ "$FAILURES" -ne 0 ]; then
        log "upgrade-test: $FAILURES assertion(s) failed."
        exit 1
    fi

    log "upgrade-test: every assertion passed."
}

main "$@"
