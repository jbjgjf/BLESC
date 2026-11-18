import type { SupabaseClient } from "@supabase/supabase-js";
import type { SafetyAssessment } from "@/api/models";

/** How far back another surface's disclosure keeps shaping this one. */
export const DISCLOSED_RISK_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Levels worth carrying, highest first. Each is asked for on its own, so the
 * answer is the highest level present and not "the highest among the latest N".
 */
const CARRIED_LEVELS: SafetyAssessment["risk_level"][] = ["crisis", "elevated", "low"];

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
 *
 * #529: excluding only this surface still left a fixed-size window of the
 * latest rows, so twenty "none" turns on a *third* surface (voice, when called
 * from chat) pushed a morning journal crisis out of it. Every turn writes an
 * audit row, so no window size is safe. The database is now asked, level by
 * level, whether any row at that level exists in the last day — the answer no
 * longer depends on how many other turns there were.
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
  // One row per level, all at once: three short reads instead of one long one
  // whose length was the bug.
  const reads = await Promise.all(
    CARRIED_LEVELS.map((level) =>
      client
        .from("model_runs")
        .select("retrieval_config_json")
        .eq("participant_id", participantId)
        .eq("artifact_type", "safety_assessment")
        .eq("retrieval_config_json->>risk_level", level)
        .gte("created_at", since)
        .or(`retrieval_config_json->>surface.is.null,retrieval_config_json->>surface.neq.${excludeSurface}`)
        .order("created_at", { ascending: false })
        .limit(1),
    ),
  );
  const failed = reads.find(({ error, data }) => error || !data);
  if (failed) {
    // Must not cost the student a reply, so this still answers "none" — but
    // "could not tell" must not look the same as "nothing was disclosed".
    console.error(
      "[safety] could not read other surfaces' assessments; carry-over treated as none",
      { participant: participantId, surface: excludeSurface, error: failed.error?.message ?? "no data" },
    );
    return "none";
  }

  for (const [index, level] of CARRIED_LEVELS.entries()) {
    const found = (reads[index].data ?? []).some((row) => {
      const config = (row.retrieval_config_json ?? {}) as { risk_level?: string; surface?: string };
      // Already excluded by the query; kept so a filter regression cannot make a
      // single elevated turn on this surface stick to the participant for a day.
      return config.surface !== excludeSurface && config.risk_level === level;
    });
    if (found) return level;
  }
  return "none";
}
