/**
 * The 「書きぶりの変化」 observation, as the educator surface receives it (#468).
 *
 * Written by `supabaseWriter` into `writing_change_observations` when a
 * student's journal entry moved, on some writing feature, two of their own
 * standard deviations from their own last fourteen writing days. This module is
 * the read side: it turns a stored row into something a screen can render, and
 * refuses rows it cannot explain.
 *
 * What an educator gets is the same shape as the safety observation beside it:
 * what was observed, when, on which surface, and on what basis. Never the text,
 * never a z-score, never a band (`docs/educator_display_policy.md`, rules 1–3).
 * The wording says what changed relative to the student's own past and stops
 * there; it does not say what the change means, because nothing measured that.
 *
 * Kept apart from `api/client.ts` and the educator pages on purpose. Those are
 * being reworked separately, and the parse and the wording are the parts with
 * rules worth testing (`tests/writing-change-observation.test.mjs`).
 */

import { WRITING_CHANGE_FEATURES, type WritingChange, type WritingChangeFeature } from "./writingDynamics.ts";
import { t } from "./i18n/index.ts";

export const WRITING_CHANGE_OBSERVATION_KIND = "writing_change";

export type WritingChangeObservation = {
  kind: typeof WRITING_CHANGE_OBSERVATION_KIND;
  observed_at: string;
  /** Which screen: "journal". */
  surface: string;
  /** Which field on it: "journal_entry". */
  field_name: string;
  /** What moved, and which way. Never empty — see `parseWritingChangeObservation`. */
  evidence: WritingChange[];
  /** How many of the student's own days the comparison rested on. */
  baseline_days: number;
};

/**
 * A stored row, or null when it cannot be shown.
 *
 * Rule 2 applied on read as well as on write: a row whose evidence is empty or
 * names nothing this version knows how to describe is not an observation an
 * educator can trace, so it is dropped rather than rendered as a bare chip. The
 * database enforces a non-empty array; this enforces that every item in it is
 * one the wording below can say.
 */
export function parseWritingChangeObservation(row: unknown): WritingChangeObservation | null {
  if (!row || typeof row !== "object") return null;
  const candidate = row as Record<string, unknown>;
  if (candidate.kind !== WRITING_CHANGE_OBSERVATION_KIND) return null;
  if (typeof candidate.observed_at !== "string" || Number.isNaN(new Date(candidate.observed_at).getTime())) return null;
  const evidence = (Array.isArray(candidate.evidence) ? candidate.evidence : [])
    .filter((item): item is { feature: WritingChangeFeature; direction: "higher" | "lower" } => {
      const value = item as Record<string, unknown> | null;
      return (
        !!value &&
        (WRITING_CHANGE_FEATURES as readonly string[]).includes(String(value.feature)) &&
        (value.direction === "higher" || value.direction === "lower")
      );
    })
    .map(({ feature, direction }) => ({ feature, direction }));
  if (evidence.length === 0) return null;
  return {
    kind: WRITING_CHANGE_OBSERVATION_KIND,
    observed_at: candidate.observed_at,
    surface: typeof candidate.surface === "string" ? candidate.surface : "journal",
    field_name: typeof candidate.field_name === "string" ? candidate.field_name : "journal_entry",
    evidence,
    baseline_days: typeof candidate.baseline_days === "number" ? candidate.baseline_days : 0,
  };
}

/** One evidence item in words, e.g. 「いちばん長い手の止まりが、ふだんより長い」. */
export function describeWritingChange(change: WritingChange): string {
  return t.writingChange.evidence[change.feature][change.direction];
}

/** The latest showable observation per participant, from rows newest first. */
export function latestWritingChangeByParticipant(
  rows: Array<Record<string, unknown>>,
): Map<string, WritingChangeObservation> {
  const latest = new Map<string, WritingChangeObservation>();
  for (const row of rows) {
    const participantId = typeof row.participant_id === "string" ? row.participant_id : null;
    if (!participantId || latest.has(participantId)) continue;
    const parsed = parseWritingChangeObservation(row);
    if (parsed) latest.set(participantId, parsed);
  }
  return latest;
}
