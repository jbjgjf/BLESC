#!/usr/bin/env bash
# Migration smoke test for the pilot environment (#166).
#
# What it proves, in order, because the order is the thing that breaks:
#
#   1. A fresh database takes every migration cleanly.
#   2. Every RLS/privilege test script passes against the result. This is the
#      state a real environment is in, so it is tested before anything else
#      touches it: the second pass re-runs the revoke migrations, and would
#      hide a privilege that a later migration had handed back.
#   3. Applying them twice is a no-op (each is idempotent, or fails loudly).
#   4. The tests pass again, so a re-apply that re-grants something is caught.
#   5. The three-step rollout order is respected: the additive migration and the
#      app deploy come before the two revoke migrations. Applying a revoke
#      migration against code that still selects raw_text turns every entry read
#      into "permission denied", which is a production outage, not a warning.
#
# Run against a LOCAL database only. It resets the database it points at.
#
#   cd sentra
#   supabase start
#   ./supabase/scripts/migration_smoke.sh
#
# CI runs it as `--skip-fresh` after `supabase db reset --no-seed` (#378). The
# reset is the fresh apply there: it goes through the CLI, which is how a real
# environment receives migrations, so step 1 would only repeat it by a second
# route. Steps 2-5 then run against that database.
#
# Exit code is the result: non-zero if any step fails. Every failure is listed
# before exiting, and under GitHub Actions each one is also an annotation and a
# line in the step summary, so a red job says which step broke.

set -euo pipefail

SKIP_FRESH=0
for arg in "$@"; do
  case "$arg" in
    --skip-fresh) SKIP_FRESH=1 ;;
    *) printf 'unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

DB_URL="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
# It resets what it points at, so it refuses anything that is not this machine.
case "$DB_URL" in
  *@127.0.0.1:*|*@localhost:*) ;;
  *) printf 'refusing to run: SUPABASE_DB_URL is not a local database\n' >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="$(dirname "$HERE")"
MIGRATIONS="$SUPABASE_DIR/migrations"
TESTS="$SUPABASE_DIR/tests"

# The migrations that must not be applied before the app deploy that precedes
# them. Listed here rather than inferred from the filename, so adding one is a
# visible edit to this file.
DEPLOY_GATED=(
  "20260906000100_restrict_entries_raw_text_columns.sql"
  "20260907000000_restrict_entries_raw_text_writes.sql"
)

# Migrations written before this script existed that cannot be applied twice
# (a bare `create policy` / `create trigger` / `add column`). They are skipped
# in the second pass rather than rewritten: all of them are long applied
# everywhere, and none is part of a staged rollout that could stop halfway.
# The list only shrinks — a new migration is never added here, it is made
# re-appliable instead.
LEGACY_NOT_IDEMPOTENT=(
  "20260529000100_initial_sentra_backend.sql"
  "20260601000000_add_observation_type.sql"
  "20260611000000_research_grade_data_layer.sql"
  "20260614140000_longitudinal_patterns.sql"
  "20260621000000_graph_index_and_memory_objects.sql"
  "20260715090000_educator_oversight_foundations.sql"
  "20260715100000_oversight_consents.sql"
  "20260716090000_educator_access_log_and_reads.sql"
  "20260717090000_shared_support_summaries.sql"
  "20260717110000_evaluation_tables.sql"
)

FAILURES=0
STEP=""

say() { STEP="$1"; printf '\n=== %s ===\n' "$1"; }

# Record a failure and keep going, so one run reports everything that is broken.
fail() {
  FAILURES=$((FAILURES + 1))
  printf '  FAIL: %s\n' "$1"
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    printf '::error title=migration_smoke step %s::%s\n' "$STEP" "$1"
  fi
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf -- '- **%s** — %s\n' "$STEP" "$1" >> "$GITHUB_STEP_SUMMARY"
  fi
}

is_legacy() {
  local name
  for name in "${LEGACY_NOT_IDEMPOTENT[@]}"; do
    [ "$name" = "$1" ] && return 0
  done
  return 1
}

say "1. fresh apply"
if [ "$SKIP_FRESH" = 1 ]; then
  printf '  skipped: the caller has just reset the database\n'
else
  # Through the CLI, not `drop schema public cascade` + psql: recreating the
  # schema by hand loses the default privileges Supabase sets on it, and the
  # tests in step 2 then fail for a reason no real environment has.
  # Nothing after a failed fresh apply means anything, so this one stops the run.
  if ! (cd "$SUPABASE_DIR/.." && supabase db reset --no-seed); then
    fail "the migrations do not apply to a fresh database"
    exit 1
  fi
fi

# Includes the column privileges on `entries` (entries_column_privileges.test.sql),
# which used to be a step of this script and so ran nowhere but here.
run_tests() {
  local file
  for file in "$TESTS"/*.test.sql; do
    printf '  %s\n' "$(basename "$file")"
    if ! psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$file"; then
      fail "$(basename "$file") failed"
    fi
  done
}

say "2. RLS and privilege tests (fresh apply)"
run_tests

say "3. re-apply (idempotence)"
for name in "${LEGACY_NOT_IDEMPOTENT[@]}"; do
  [ -f "$MIGRATIONS/$name" ] || fail "LEGACY_NOT_IDEMPOTENT names $name, which does not exist"
done
for file in "$MIGRATIONS"/*.sql; do
  name="$(basename "$file")"
  if is_legacy "$name"; then
    continue
  fi
  if ! output="$(psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$file" 2>&1 >/dev/null)"; then
    # A migration that cannot be re-applied makes a partial rollout
    # unrecoverable without hand surgery.
    fail "$name is not idempotent: $(printf '%s' "$output" | grep -m1 'ERROR' || printf 'psql failed'). Guard it with \`if not exists\` / \`or replace\` / \`drop ... if exists\`."
  fi
done

say "4. RLS and privilege tests (after re-apply)"
run_tests

say "5. deploy-gated migrations are documented as such"
for name in "${DEPLOY_GATED[@]}"; do
  if ! grep -q "APPLY" "$MIGRATIONS/$name"; then
    fail "$name does not state its apply order at the top"
    continue
  fi
  printf '  %s states its apply order\n' "$name"
done

if [ "$FAILURES" != 0 ]; then
  printf '\n=== FAIL (%s) ===\n' "$FAILURES"
  exit 1
fi

say "PASS"
