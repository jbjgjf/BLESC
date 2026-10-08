import type { SupabaseClient } from "@supabase/supabase-js";
import type { SafetyAssessment } from "@/api/models";

/** Rows of other surfaces' assessments read per call. */
export const DISCLOSED_RISK_ROWS = 20;

/** How far back another surface's disclosure keeps shaping this one. */
export const DISCLOSED_RISK_WINDOW_MS = 24 * 60 * 60 * 1000;

const RISK_ORDER: SafetyAssessment["risk_level"][] = ["none", "low", "elevated", "crisis"];

/** Surfaces are internal constants; anything else must not reach a filter string. */
const SURFACE_NAME = /^[a-z_]+$/;

/**
 * Highest risk assessed on the student's other surfaces in the last day, so a
 * disclosure written in the Record UI keeps shaping a conversation that never
 * repeats the words.
 *
 * Lives apart from `safety.ts` so it can be tested without the path aliases
 * that module's runtime imports need.
 *
 * #373: this surface's own rows are excluded **in the query, before the
 * limit**. Every chat and voice turn writes an audit row whatever its level, so
 * excluding them after `limit(20)` meant that a student who chatted twenty
 * turns in a day — the day the carry-over matters most — saw a morning journal
 * crisis silently drop to "none".
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
  const { data, error } = await client
    .from("model_runs")
    .select("retrieval_config_json")
    .eq("participant_id", participantId)
    .eq("artifact_type", "safety_assessment")
    .gte("created_at", since)
    .or(`retrieval_config_json->>surface.is.null,retrieval_config_json->>surface.neq.${excludeSurface}`)
    .order("created_at", { ascending: false })
    .limit(DISCLOSED_RISK_ROWS);
  if (error || !data) {
    // Must not cost the student a reply, so this still answers "none" — but
    // "could not tell" must not look the same as "nothing was disclosed".
    console.error(
      "[safety] could not read other surfaces' assessments; carry-over treated as none",
      { participant: participantId, surface: excludeSurface, error: error?.message ?? "no data" },
    );
    return "none";
  }

  let highest: SafetyAssessment["risk_level"] = "none";
  for (const row of data) {
    const config = (row.retrieval_config_json ?? {}) as { risk_level?: string; surface?: string };
    // Already excluded by the query; kept so a filter regression cannot make a
    // single elevated turn on this surface stick to the participant for a day.
    if (config.surface === excludeSurface) continue;
    const level = config.risk_level as SafetyAssessment["risk_level"] | undefined;
    if (level && RISK_ORDER.indexOf(level) > RISK_ORDER.indexOf(highest)) highest = level;
  }
  return highest;
}
