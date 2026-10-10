/**
 * The newest row per participant, for a whole cohort (#338).
 *
 * The educator roster used to read "the newest 400 rows for everyone" and take
 * the first row it met for each student. The 400 were shared by the cohort, so
 * with fifty students writing daily they covered about eight days, and a
 * student who had stopped writing nine days ago had no row at all: no safety
 * level, no last active day. The students pushed out first were the ones who
 * had gone quiet — after a crisis assessment, exactly the ones to look at.
 *
 * This reads newest-first in pages and stops when every participant has been
 * seen or the rows run out, so the answer does not depend on how much the rest
 * of the cohort wrote. It is a read, not a migration: a `DISTINCT ON` function
 * would do the same in one round trip and can replace this without changing
 * its callers.
 *
 * Taking a client rather than importing one keeps it runnable under node.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

type Reader = Pick<SupabaseClient, "from">;

/** Participant ids per request; they travel in the query string. */
const ID_CHUNK = 100;
/** Rows per request, under PostgREST's default cap of 1000. */
const PAGE = 500;
/**
 * Where reading stops and the caller is told the answer is incomplete. Far
 * beyond a pilot (50 students × 28 days is 1,400 rows), so reaching it means
 * something is wrong, and "no row" must not be what the screen then shows.
 */
const MAX_PAGES_PER_CHUNK = 40;

export const COHORT_READ_INCOMPLETE = "cohort_read_incomplete";

export async function latestRowPerParticipant<Row extends { participant_id: string }>(
  client: Reader,
  options: {
    table: string;
    columns: string;
    participantIds: readonly string[];
    /** Newest first by this column. */
    newestBy: string;
    /** Equality filters, e.g. `{ artifact_type: "safety_assessment" }`. */
    where?: Readonly<Record<string, string>>;
  },
): Promise<{ latest: Map<string, Row>; error: { message: string } | null }> {
  const latest = new Map<string, Row>();
  const ids = [...new Set(options.participantIds)];

  for (let offset = 0; offset < ids.length; offset += ID_CHUNK) {
    const chunk = ids.slice(offset, offset + ID_CHUNK);
    for (let page = 0; ; page += 1) {
      if (page === MAX_PAGES_PER_CHUNK) return { latest, error: { message: COHORT_READ_INCOMPLETE } };

      let query = client.from(options.table).select(options.columns).in("participant_id", chunk);
      for (const [column, value] of Object.entries(options.where ?? {})) query = query.eq(column, value);
      const result = await query
        .order(options.newestBy, { ascending: false })
        // A tie on the ordering column must not let a row slip between pages.
        .order("participant_id", { ascending: true })
        .range(page * PAGE, page * PAGE + PAGE - 1);
      if (result.error) return { latest, error: result.error };

      const rows = (result.data ?? []) as unknown as Row[];
      for (const row of rows) {
        if (!latest.has(row.participant_id)) latest.set(row.participant_id, row);
      }
      if (rows.length < PAGE || chunk.every((id) => latest.has(id))) break;
    }
  }

  return { latest, error: null };
}
