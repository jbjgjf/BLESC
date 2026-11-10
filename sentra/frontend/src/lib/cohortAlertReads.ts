/**
 * The two reads behind the educator's alert list that used to stop at a fixed
 * number of rows (#364).
 *
 * Acknowledgements were read as "any 500 `alert_ack` rows", with no order, so
 * once there were more than 500 the set of alerts shown as acknowledged
 * changed from one page load to the next — and there are more than 500,
 * because an alert's key includes the state it was raised from and every new
 * entry mints a new one. Escalations were read as "the newest 200", so an
 * unacknowledged crisis older than the 200th simply left the screen.
 *
 * Both are now asked the question the screen is actually asking. Taking a
 * client rather than importing one keeps this runnable under node, where the
 * tests exercise it against a store with more rows than the old limits.
 *
 * Neither read pages forever (#540). Past `MAX_PAGES` the answer is reported
 * as `ALERT_READ_INCOMPLETE`, the same way `cohortLatestRows.ts` reports
 * `COHORT_READ_INCOMPLETE`, so "could not read it all" never looks like
 * "there is nothing more".
 */

import type { SupabaseClient } from "@supabase/supabase-js";

type Reader = Pick<SupabaseClient, "from">;
type ReadError = { message: string };

/** Keys per request. They travel in the query string, at about 70 bytes each. */
const KEY_CHUNK = 40;
/** Rows per request, under PostgREST's default cap of 1000. */
const PAGE = 500;
/** How many already-acknowledged escalations to keep for context. */
export const ACKNOWLEDGED_ESCALATION_LIMIT = 200;
/**
 * Pages per read (per key chunk for acknowledgements) before the answer is
 * reported as incomplete. 20,000 rows is far beyond a pilot (50 students × 28
 * days), so reaching it means something is wrong, not that the cohort is big.
 */
export const MAX_PAGES = 40;
/** Whole reads of the unacknowledged escalations before a moving set is reported. */
const READ_ATTEMPTS = 2;

/** The error message for an answer that is known to be partial. */
export const ALERT_READ_INCOMPLETE = "alert_read_incomplete";
const incomplete: ReadError = { message: ALERT_READ_INCOMPLETE };

/**
 * Which of `keys` have been acknowledged.
 *
 * Asked by key, so the answer does not depend on how many acknowledgements
 * exist for alerts that are no longer on the roster. The log is append-only
 * (#31) and nothing stops the same alert being acknowledged twice, so each
 * chunk is paged until every key in it is accounted for or the rows run out:
 * a pile of duplicates for one key must not hide the row for another. Because
 * the log only grows, "the rows run out" is not a stopping guarantee on its
 * own, so each chunk is also capped at `MAX_PAGES`.
 */
export async function acknowledgedAlertKeys(
  client: Reader,
  keys: readonly string[],
): Promise<{ acked: Set<string>; error: ReadError | null }> {
  const acked = new Set<string>();
  const wanted = [...new Set(keys)];

  for (let offset = 0; offset < wanted.length; offset += KEY_CHUNK) {
    const chunk = wanted.slice(offset, offset + KEY_CHUNK);
    for (let page = 0; ; page += 1) {
      if (page === MAX_PAGES) return { acked, error: incomplete };
      const from = page * PAGE;
      const result = await client
        .from("educator_access_log")
        .select("metadata")
        .eq("view_type", "alert_ack")
        .in("metadata->>alert_key", chunk)
        .order("occurred_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (result.error) return { acked, error: result.error };

      const rows = (result.data ?? []) as Array<{ metadata: Record<string, unknown> | null }>;
      for (const row of rows) {
        const key = row.metadata?.alert_key;
        if (typeof key === "string" && key) acked.add(key);
      }
      if (rows.length < PAGE || chunk.every((key) => acked.has(key))) break;
    }
  }

  return { acked, error: null };
}

/**
 * Every escalation nobody has acknowledged, and the most recent acknowledged
 * ones.
 *
 * The limit applies only to rows somebody has already dealt with. An
 * unacknowledged escalation is the thing this screen exists to show, so those
 * are read to the end however many there are (up to `MAX_PAGES`).
 *
 * `acknowledged_at is null` changes while it is being paged: an educator who
 * acknowledges one row between two pages moves every later row up by one
 * offset, and the row that was at the start of the next page is never
 * returned (#540). Inserts do the opposite and return a row twice. So, as in
 * `lib/server/pagedSelect.ts`, every page asks for the exact count and
 * compares it with the first one, and rows are checked for a repeated `id`. A
 * mismatch re-reads once; a second mismatch is reported as
 * `ALERT_READ_INCOMPLETE`.
 *
 * An incomplete answer still carries the rows that were read (without
 * duplicates). Every one of them is a real unacknowledged escalation, and the
 * caller decides whether a partial list is better than none — for the alert
 * list it is (see `getCohortAlerts`). Any other read error carries no rows.
 */
export async function readAlertEscalations<Row>(
  client: Reader,
  columns: string,
): Promise<{ rows: Row[]; error: ReadError | null }> {
  let open = await readUnacknowledgedOnce<Row>(client, columns);
  for (let attempt = 1; attempt < READ_ATTEMPTS && open.error === incomplete && !open.capped; attempt += 1) {
    open = await readUnacknowledgedOnce<Row>(client, columns);
  }
  if (open.error && open.error !== incomplete) return { rows: [], error: open.error };
  const rows = open.rows;

  const closed = await client
    .from("safety_escalations")
    .select(columns)
    .not("acknowledged_at", "is", null)
    .order("detected_at", { ascending: false })
    // A tie on `detected_at` must not change which 200 come back.
    .order("id", { ascending: true })
    .limit(ACKNOWLEDGED_ESCALATION_LIMIT);
  if (closed.error) return { rows: [], error: closed.error };
  rows.push(...((closed.data ?? []) as Row[]));

  return { rows, error: open.error };
}

/** The row's `id`, when it has one usable as a key; otherwise null. */
function rowId(row: unknown): string | number | null {
  if (typeof row !== "object" || row === null || !("id" in row)) return null;
  const id = (row as { id: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

/** PostgREST's "Requested range not satisfiable" (HTTP 416). */
function isRangeNotSatisfiable(error: ReadError): boolean {
  return (error as { code?: unknown }).code === "PGRST103";
}

async function readUnacknowledgedOnce<Row>(
  client: Reader,
  columns: string,
): Promise<{ rows: Row[]; error: ReadError | null; capped?: true }> {
  const rows: Row[] = [];
  const seen = new Set<string | number>();
  // From the first response; null if the server did not report a count.
  let expected: number | null = null;
  let moved = false;

  for (let page = 0; ; page += 1) {
    // Re-reading would hit the same ceiling, so this is not retried.
    if (page === MAX_PAGES) return { rows, error: incomplete, capped: true };
    const from = page * PAGE;
    const result = await client
      .from("safety_escalations")
      .select(columns, { count: "exact" })
      .is("acknowledged_at", null)
      .order("detected_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (result.error) {
      // With a count requested, PostgREST answers an offset past the end with
      // 416 / PGRST103. Past the first page that means the set shrank under
      // us (an acknowledgement), which is a moving read, not a failed one.
      if (page > 0 && isRangeNotSatisfiable(result.error)) {
        moved = true;
        break;
      }
      return { rows: [], error: result.error };
    }

    if (typeof result.count === "number") {
      if (expected === null) expected = result.count;
      else if (result.count !== expected) moved = true;
    }
    const batch = (result.data ?? []) as Row[];
    for (const row of batch) {
      const id = rowId(row);
      if (id !== null) {
        if (seen.has(id)) {
          moved = true;
          continue;
        }
        seen.add(id);
      }
      rows.push(row);
    }
    // Stop once the count is met, so a set of exactly PAGE rows does not ask
    // for an empty page beyond its end.
    if (batch.length < PAGE || (expected !== null && seen.size >= expected)) break;
  }

  // A server cap below PAGE ends the loop early; the count says so.
  if (expected !== null && rows.length < expected) moved = true;
  return { rows, error: moved ? incomplete : null };
}
