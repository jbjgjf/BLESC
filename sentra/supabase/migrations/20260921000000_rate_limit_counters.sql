-- Somewhere to count attempts (#234).
--
-- ===========================================================================
-- Additive. One table, its policies and grants. Nothing existing is touched.
-- ===========================================================================
--
-- ## Why a table
--
-- Vercel runs each request in whatever instance is free, and instances share no
-- memory. A counter in a module-level `Map` — the obvious implementation, and
-- the one almost every tutorial shows — counts per instance, so the effective
-- limit is the configured one multiplied by however many instances happen to be
-- warm. That is not a limit; it is a number that looks like one in review.
--
-- The alternatives were a table here or an external store (Upstash, Vercel KV).
-- The table wins for this deployment because the data already has a home, the
-- pilot's traffic is fifty students, and adding a second stateful dependency to
-- a research deployment means one more thing to provision, pay for, rotate and
-- explain in `infrastructure-runbook.md`. If the load ever justifies Redis, the
-- interface in `lib/server/rateLimit.ts` is what changes, not the call sites.
--
-- ## Fixed windows, not a sliding log
--
-- One row per (bucket, window), incremented. A sliding-window log is more
-- accurate at the boundary — 2×limit is possible across two adjacent windows —
-- and costs a row per request rather than per window. For "stop someone
-- hammering the invite check" that accuracy buys nothing, and the row count
-- matters: this table is written on every request to a limited route.
--
-- ## Retention
--
-- Rows are garbage after their window closes. `purge_rate_limit_counters()`
-- deletes anything older than a day and is called by the existing retention
-- cron, so this table does not grow without bound and does not need its own
-- schedule.

create table if not exists public.rate_limit_counters (
  -- `<route>:<identifier>` — see `rateLimit.ts`. The identifier is an IP hash
  -- or a user id, never an address or a raw header.
  bucket text not null,
  -- Start of the fixed window, truncated to the window size.
  window_start timestamptz not null,
  count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (bucket, window_start)
);

create index if not exists rate_limit_counters_window_idx
  on public.rate_limit_counters(window_start);

/*
 * Increment and return the new value, atomically.
 *
 * `insert … on conflict do update` rather than read-then-write: two concurrent
 * requests that both read 4 and both write 5 let a limit of 5 through twice.
 * The conflict form is a single statement, so the database serialises them.
 *
 * SECURITY INVOKER with EXECUTE granted only to `service_role` — the callers
 * are route handlers under the service key, and a definer function reachable by
 * anyone would let a caller inflate somebody else's counter.
 */
create or replace function public.bump_rate_limit(
  p_bucket text,
  p_window_start timestamptz
)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  new_count integer;
begin
  insert into public.rate_limit_counters (bucket, window_start, count, updated_at)
  values (p_bucket, p_window_start, 1, now())
  on conflict (bucket, window_start) do update
    set count = public.rate_limit_counters.count + 1,
        updated_at = now()
  returning count into new_count;
  return new_count;
end;
$$;

-- Revoking from PUBLIC is not enough on Supabase: a stock project grants
-- EXECUTE on every new function in `public` to `anon` and `authenticated`
-- explicitly (see 20260906000000:192).
revoke execute on function public.bump_rate_limit(text, timestamptz) from public, anon, authenticated;
grant execute on function public.bump_rate_limit(text, timestamptz) to service_role;

create or replace function public.purge_rate_limit_counters()
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  purged integer;
begin
  delete from public.rate_limit_counters where window_start < now() - interval '1 day';
  get diagnostics purged = row_count;
  return purged;
end;
$$;

revoke execute on function public.purge_rate_limit_counters() from public, anon, authenticated;
grant execute on function public.purge_rate_limit_counters() to service_role;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.rate_limit_counters enable row level security;

-- Revoke first. Stock Supabase grants every new table to `anon` and
-- `authenticated` before a policy exists, so `grant … to service_role` alone
-- would widen nothing and leave the table open (the lesson of 20260910000000).
revoke all on public.rate_limit_counters from anon, authenticated;

-- No policy for anyone else. Nobody but the limiter has a reason to read this,
-- and a participant who could read it would learn how close they are to a
-- threshold — which is the one piece of information that makes a limit easier
-- to work around.
grant select, insert, update, delete on public.rate_limit_counters to service_role;
