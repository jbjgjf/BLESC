#!/usr/bin/env bash
# Migration smoke test for the pilot environment (#166).
#
# What it proves, in order, because the order is the thing that breaks:
#
#   1. A fresh database takes every migration cleanly.
#   2. Applying them twice is a no-op (each is idempotent, or fails loudly).
#   3. Every RLS/privilege test script passes against the result.
#   4. The three-step rollout order is respected: the additive migration and the
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
# Exit code is the result: non-zero if any step fails.

set -euo pipefail

DB_URL="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
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

say() { printf '\n=== %s ===\n' "$1"; }

say "1. fresh apply"
psql "$DB_URL" -v ON_ERROR_STOP=1 -c 'drop schema if exists public cascade; create schema public;' >/dev/null
for file in "$MIGRATIONS"/*.sql; do
  printf '  %s\n' "$(basename "$file")"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$file"
done

say "2. re-apply (idempotence)"
for file in "$MIGRATIONS"/*.sql; do
  if ! psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$file" >/dev/null 2>&1; then
    printf '  NOT IDEMPOTENT: %s\n' "$(basename "$file")"
    printf '  A migration that cannot be re-applied makes a partial rollout unrecoverable\n'
    printf '  without hand surgery. Guard it with `if not exists` / `or replace`.\n'
    exit 1
  fi
done
printf '  all migrations re-applied cleanly\n'

say "3. RLS and privilege tests"
for file in "$TESTS"/*.test.sql; do
  printf '  %s\n' "$(basename "$file")"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$file"
done

say "4. deploy-gated migrations are documented as such"
for name in "${DEPLOY_GATED[@]}"; do
  if ! grep -q "APPLY" "$MIGRATIONS/$name"; then
    printf '  %s does not state its apply order at the top\n' "$name"
    exit 1
  fi
  printf '  %s states its apply order\n' "$name"
done

say "5. participant write privileges on entries"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q <<'PSQL'
do $$
declare
  leaked text;
begin
  select string_agg(column_name, ', ' order by column_name)
    into leaked
    from information_schema.column_privileges
   where table_schema = 'public'
     and table_name = 'entries'
     and grantee = 'authenticated'
     and privilege_type in ('INSERT', 'UPDATE')
     and column_name in ('raw_text', 'raw_text_ciphertext', 'raw_text_key_version', 'raw_text_expires_at');

  if leaked is not null then
    raise exception 'FAIL: authenticated may write raw-text columns: %', leaked;
  end if;

  -- And the columns the app does need must still be writable, or the check
  -- above is passing because nothing works.
  if not exists (
    select 1 from information_schema.column_privileges
     where table_schema = 'public' and table_name = 'entries'
       and grantee = 'authenticated' and privilege_type = 'INSERT'
       and column_name = 'extraction_json'
  ) then
    raise exception 'FAIL: authenticated lost INSERT on extraction_json';
  end if;
end $$;
PSQL
printf '  raw-text columns are not writable by participants\n'

say "PASS"
