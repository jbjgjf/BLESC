#!/usr/bin/env bash
# Executes the SQL the pilot dry run (#168) depends on, against a LOCAL
# database that has every migration applied (#384).
#
#   cd sentra
#   supabase start && supabase db reset --no-seed
#   ./supabase/scripts/dry_run_sql_smoke.sh
#
# The dry run's seed and its reconciliation queries were only ever read, by a
# test that greps the seed as a string. Run for the first time, the seed failed
# on a primary key, its invitations could not be redeemed, and query 6 named a
# column that does not exist. This is the check that would have said so.
#
#   1. The seed and the invitation script apply, twice (both claim to be re-runnable).
#   2. What they leave behind is what the scenario matrix describes, and the
#      invitations behave under the real `redeem_pilot_invitation`.
#   3. All thirteen reconciliation queries execute.
#   4. The educator demo seed applies (docs/educator_oversight.md uses it).
#
# It writes seed rows and leaves them there. Needs `psql` and `node` (>= 24).

set -euo pipefail

DB_URL="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
case "$DB_URL" in
  *@127.0.0.1:*|*@localhost:*) ;;
  *) printf 'refusing to run: SUPABASE_DB_URL is not a local database\n' >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="$(dirname "$HERE")"
FRONTEND_DIR="$(dirname "$SUPABASE_DIR")/frontend"

# A throwaway key: the hashes only have to agree with themselves here. A real
# dry run uses the key of the deployment it targets.
export PILOT_INVITE_HMAC_KEY="${PILOT_INVITE_HMAC_KEY:-$(openssl rand -base64 32)}"

say() { printf '\n=== %s ===\n' "$1"; }
run_sql() { psql "$DB_URL" -v ON_ERROR_STOP=1 -q "$@"; }

say "1. seed and invitations, applied twice"
for pass in first second; do
  run_sql -f "$SUPABASE_DIR/seed/pilot_dry_run.seed.sql"
  (cd "$FRONTEND_DIR" && node --no-warnings scripts/dry-run-invitations.mjs) | run_sql
  printf '  %s pass applied\n' "$pass"
done

say "2. the seeded rows match the matrix and the invitations redeem"
run_sql <<'PSQL'
begin;
do $$
declare
  study constant uuid := '22222222-1111-0000-0000-000000000000';
  n integer;
  result record;
  enrolled_minor boolean;
begin
  select count(*) into n from auth.users where email like 'dryrun-%@pilot.test.local';
  if n <> 10 then raise exception 'FAIL: % dry-run users, expected 10', n; end if;

  select count(*) into n from public.participants where code like 'DRYRUN\_%';
  if n <> 10 then raise exception 'FAIL: % dry-run participants, expected 10', n; end if;

  select count(*) into n from public.pilot_invitations where study_id = study;
  if n <> 10 then raise exception 'FAIL: % invitations, expected 10', n; end if;

  -- Scenarios 2, 6 and 10 are the minors in scenario-matrix.json.
  select count(*) into n from public.pilot_invitations where study_id = study and is_minor;
  if n <> 3 then raise exception 'FAIL: % minor invitations, expected 3', n; end if;

  select count(*) into n from public.pilot_invitations where study_id = study and is_minor is null;
  if n <> 0 then raise exception 'FAIL: % invitations carry no age band', n; end if;

  select count(*) into n from public.dry_run_fixture_text;
  if n <> 13 then raise exception 'FAIL: % fixture passages, expected 13', n; end if;

  if has_table_privilege('authenticated', 'public.dry_run_fixture_text', 'SELECT')
     or has_table_privilege('anon', 'public.dry_run_fixture_text', 'SELECT') then
    raise exception 'FAIL: dry_run_fixture_text is readable through the Data API';
  end if;

  -- Scenario 1: an adult code is accepted and does not ask for a guardian.
  select r.* into result from public.redeem_pilot_invitation(
    (select code_hash from public.pilot_invitations where study_id = study and note = 'dry-run scenario 1'),
    '22222222-0000-0000-0000-000000000001', '22222222-3333-0000-0000-000000000001', 'P-DRY001', null) r;
  if result.outcome <> 'enrolled' then
    raise exception 'FAIL: scenario 1 could not redeem its code (%)', result.outcome;
  end if;
  select is_minor into enrolled_minor from public.pilot_enrollments where id = result.enrollment_id;
  if enrolled_minor then raise exception 'FAIL: scenario 1 (adult) was enrolled as a minor'; end if;

  -- Scenario 2: a minor code enrolls a minor even if the redeemer says otherwise.
  select r.* into result from public.redeem_pilot_invitation(
    (select code_hash from public.pilot_invitations where study_id = study and note = 'dry-run scenario 2'),
    '22222222-0000-0000-0000-000000000002', '22222222-3333-0000-0000-000000000002', 'P-DRY002', false) r;
  select is_minor into enrolled_minor from public.pilot_enrollments where id = result.enrollment_id;
  if result.outcome <> 'enrolled' or not enrolled_minor then
    raise exception 'FAIL: scenario 2 (minor) did not enroll as a minor (%)', result.outcome;
  end if;

  -- Scenario 3: the expired code is refused.
  select r.* into result from public.redeem_pilot_invitation(
    (select code_hash from public.pilot_invitations where study_id = study and note = 'dry-run scenario 3'),
    '22222222-0000-0000-0000-000000000003', '22222222-3333-0000-0000-000000000003', 'P-DRY003', null) r;
  if result.outcome <> 'rejected' then
    raise exception 'FAIL: scenario 3 redeemed an expired code (%)', result.outcome;
  end if;

  -- Scenario 4: a second account cannot reuse a code that allows one redemption.
  select r.* into result from public.redeem_pilot_invitation(
    (select code_hash from public.pilot_invitations where study_id = study and note = 'dry-run scenario 1'),
    '22222222-0000-0000-0000-000000000004', '22222222-3333-0000-0000-000000000004', 'P-DRY004', null) r;
  if result.outcome <> 'rejected' then
    raise exception 'FAIL: a used code was redeemed a second time (%)', result.outcome;
  end if;
end $$;
rollback;
PSQL
printf '  ok\n'

say "3. reconciliation queries"
output="$(psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/scripts/dry_run_reconciliation.sql")"
sections="$(printf '%s\n' "$output" | grep -c '^=== ' || true)"
if [ "$sections" != 13 ]; then
  printf '  FAIL: %s of 13 queries ran\n' "$sections"
  exit 1
fi
printf '  all 13 queries executed\n'

say "4. educator demo seed"
run_sql -f "$SUPABASE_DIR/seed/educator_demo.seed.sql" >/dev/null
printf '  applied\n'

say "PASS"
