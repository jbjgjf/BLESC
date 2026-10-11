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
 * Which of `keys` have been acknowledged.
 *
 * Asked by key, so the answer does not depend on how many acknowledgements
 * exist for alerts that are no longer on the roster. The log is append-only
 * (#31) and nothing stops the same alert being acknowledged twice, so each
 * chunk is paged until every key in it is accounted for or the rows run out:
 * a pile of duplicates for one key must not hide the row for another.
 */
export async function acknowledgedAlertKeys(
  client: Reader,
  keys: readonly string[],
): Promise<{ acked: Set<string>; error: ReadError | null }> {
  const acked = new Set<string>();
  const wanted = [...new Set(keys)];

  for (let offset = 0; offset < wanted.length; offset += KEY_CHUNK) {
    const chunk = wanted.slice(offset, offset + KEY_CHUNK);
    for (let from = 0; ; from += PAGE) {
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
 * are read to the end however many there are.
 */
export async function readAlertEscalations<Row>(
  client: Reader,
  columns: string,
): Promise<{ rows: Row[]; error: ReadError | null }> {
  const rows: Row[] = [];

  for (let from = 0; ; from += PAGE) {
    const open = await client
      .from("safety_escalations")
      .select(columns)
      .is("acknowledged_at", null)
      .order("detected_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (open.error) return { rows: [], error: open.error };
    const page = (open.data ?? []) as Row[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }

  const closed = await client
    .from("safety_escalations")
    .select(columns)
    .not("acknowledged_at", "is", null)
    .order("detected_at", { ascending: false })
    .limit(ACKNOWLEDGED_ESCALATION_LIMIT);
  if (closed.error) return { rows: [], error: closed.error };
  rows.push(...((closed.data ?? []) as Row[]));

  return { rows, error: null };
}
