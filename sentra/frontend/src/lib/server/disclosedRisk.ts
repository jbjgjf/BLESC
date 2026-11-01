import type { SupabaseClient } from "@supabase/supabase-js";
import type { SafetyAssessment } from "@/api/models";
// Relative, with the extension: `tests/disclosed-risk.test.mjs` loads this
// module directly under `node --experimental-strip-types`, which resolves the
// `@/` alias only for type-only imports.
import { fetchAllRows, PAGE_SIZE } from "./pagedSelect.ts";

/** How far back another surface's disclosure keeps shaping this one. */
export const DISCLOSED_RISK_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Refuse rather than page forever.
 *
 * One participant's own safety rows for one day are a few dozen. The
 * pathological case is bounded by `RULES.authenticatedWrite` (600 an hour), so
 * this sits above a full day of a caller doing nothing else.
 */
export const DISCLOSED_RISK_MAX_ROWS = 20_000;

const RISK_ORDER: SafetyAssessment["risk_level"][] = ["none", "low", "elevated", "crisis"];

/** Surfaces are internal constants; anything else must not reach a filter string. */
const SURFACE_NAME = /^[a-z_]+$/;

type AuditRow = { id: string; retrieval_config_json: { risk_level?: string; surface?: string } | null };

/**
 * Highest risk assessed on the student's other surfaces in the last day, so a
 * disclosure written in the Record UI keeps shaping a conversation that never
 * repeats the words.
 *
 * Lives apart from `safety.ts` so it can be tested without the path aliases
 * that module's runtime imports need.
 *
 * #373: this surface's own rows are excluded **in the query, before the row
 * window**. Every chat and voice turn writes an audit row whatever its level,
 * so excluding them after a `limit(20)` meant that a student who chatted twenty
 * turns in a day — the day the carry-over matters most — saw a morning journal
 * crisis silently drop to "none".
 *
 * #529: excluding this surface was not enough, because there is a third one.
 * With the window still capped at twenty rows, twenty *voice* turns at "none"
 * pushed the same morning journal crisis out of a `chat` turn's view — the
 * identical failure, one surface over. The answer wanted here is a maximum over
 * a day, not the most recent rows, so there is no row cap to tune: every
 * matching row in the window is read, in pages, through `fetchAllRows`. A read
 * that cannot be completed is a failure there rather than a shorter list, which
 * is what keeps "could not tell" from arriving as "nothing was disclosed".
 *
 * The filter is `surface IS NULL OR surface <> excluded`, not `NOT (surface =
 * excluded)`: in SQL the latter is NULL for a row with no `surface`, and those
 * rows (journal assessments, until #372) would be dropped with it.
 */
export async function recentDisclosedRisk(
  client: SupabaseClient,
  participantId: string,
  excludeSurface: string,
): Promise<SafetyAssessment["risk_level"]> {
  if (!SURFACE_NAME.test(excludeSurface)) {
    // A programming error, but this function must never cost the student a reply.
    console.error("[safety] invalid surface name; carry-over treated as none", { surface: excludeSurface });
    return "none";
  }
  const since = new Date(Date.now() - DISCLOSED_RISK_WINDOW_MS).toISOString();

  const result = await fetchAllRows<AuditRow>(
    (from, to) =>
      client
        .from("model_runs")
        .select("id, retrieval_config_json", { count: "exact" })
        .eq("participant_id", participantId)
        .eq("artifact_type", "safety_assessment")
        .gte("created_at", since)
        .or(`retrieval_config_json->>surface.is.null,retrieval_config_json->>surface.neq.${excludeSurface}`)
        // Deterministic, primary key last: paging without a total order skips
        // and repeats rows.
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    { pageSize: PAGE_SIZE, maxRows: DISCLOSED_RISK_MAX_ROWS },
  );

  if ("error" in result) {
    // Must not cost the student a reply, so this still answers "none" — but
    // "could not tell" must not look the same as "nothing was disclosed".
    console.error(
      "[safety] could not read other surfaces' assessments; carry-over treated as none",
      { participant: participantId, surface: excludeSurface, error: result.error },
    );
    return "none";
  }

  let highest: SafetyAssessment["risk_level"] = "none";
  for (const row of result.rows) {
    const config = row.retrieval_config_json ?? {};
    // Already excluded by the query; kept so a filter regression cannot make a
    // single elevated turn on this surface stick to the participant for a day.
    if (config.surface === excludeSurface) continue;
    const level = config.risk_level as SafetyAssessment["risk_level"] | undefined;
    if (level && RISK_ORDER.indexOf(level) > RISK_ORDER.indexOf(highest)) highest = level;
  }
  return highest;
}
