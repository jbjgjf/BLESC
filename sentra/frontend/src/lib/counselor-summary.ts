import type { CounselorSupportSummary, CounselorSummarySection } from "@/api/models";

export interface CounselorTimelineEvent {
  event_id: string;
  timestamp: string;
  primary_emotion?: string;
  intensity?: number;
  triggers: string[];
  support_needs: string[];
  protective_factors: string[];
  safety_level: string;
  safety_reasons: string[];
}

function ranked(values: Array<{ value: string; eventId: string }>, limit = 3) {
  const counts = new Map<string, { count: number; ids: Set<string> }>();
  for (const { value, eventId } of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    const current = counts.get(normalized) ?? { count: 0, ids: new Set<string>() };
    current.count += 1;
    current.ids.add(eventId);
    counts.set(normalized, current);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([label, meta]) => ({ label, count: meta.count, ids: [...meta.ids] }));
}

function section(key: CounselorSummarySection["key"], title: string, items: string[], evidenceIds: string[]): CounselorSummarySection {
  return { key, title, items, evidence_event_ids: [...new Set(evidenceIds)] };
}

export function generateCounselorSummary(events: CounselorTimelineEvent[], now = new Date()): CounselorSupportSummary {
  const ordered = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const themes = ranked(ordered.flatMap((event) => event.primary_emotion ? [{ value: event.primary_emotion, eventId: event.event_id }] : []));
  const triggers = ranked(ordered.flatMap((event) => event.triggers.map((value) => ({ value, eventId: event.event_id }))));
  const supports = ranked(ordered.flatMap((event) => event.support_needs.map((value) => ({ value, eventId: event.event_id }))));
  const protective = ranked(ordered.flatMap((event) => event.protective_factors.map((value) => ({ value, eventId: event.event_id }))));
  const intensities = ordered.filter((event) => typeof event.intensity === "number");
  const intensityItems = intensities.length === 0
    ? []
    : intensities.length === 1
      ? [`One structured intensity value is available (${intensities[0].intensity}/5).`]
      : [`Structured intensity ${Number(intensities.at(-1)?.intensity) > Number(intensities[0].intensity) ? "increased" : Number(intensities.at(-1)?.intensity) < Number(intensities[0].intensity) ? "decreased" : "was unchanged"} from ${intensities[0].intensity}/5 to ${intensities.at(-1)?.intensity}/5.`];

  const discussionItems = [
    triggers[0] ? `Discuss how “${triggers[0].label}” has been affecting recent days.` : "Discuss what has felt most important recently.",
    supports[0] ? `Discuss whether “${supports[0].label}” support would be useful.` : "Discuss what kind of support would feel useful now.",
    protective[0] ? `Discuss how to keep “${protective[0].label}” available.` : "Discuss people, places, or routines that feel supportive.",
  ];

  const sections = [
    section("recent_themes", "Recent themes", themes.map((item) => `${item.label} (${item.count} reflection${item.count === 1 ? "" : "s"})`), themes.flatMap((item) => item.ids)),
    section("recurring_triggers", "Recurring triggers", triggers.map((item) => `${item.label} (${item.count})`), triggers.flatMap((item) => item.ids)),
    section("intensity_trend", "Intensity trend", intensityItems, intensities.map((event) => event.event_id)),
    section("support_needs", "Support needs", supports.map((item) => item.label), supports.flatMap((item) => item.ids)),
    section("protective_factors", "Protective factors", protective.map((item) => item.label), protective.flatMap((item) => item.ids)),
    section("suggested_discussion_points", "Suggested discussion points", discussionItems, [...new Set([...triggers, ...supports, ...protective].flatMap((item) => item.ids))]),
  ];
  const safetyFlags = ordered
    .filter((event) => event.safety_level === "crisis" || event.safety_level === "elevated")
    .map((event) => ({ level: event.safety_level, reasons: event.safety_reasons, timestamp: event.timestamp, event_id: event.event_id }));
  const from = ordered[0]?.timestamp ?? null;
  const to = ordered.at(-1)?.timestamp ?? null;

  return {
    summary_id: `support-${from?.slice(0, 10) ?? "empty"}-${to?.slice(0, 10) ?? "empty"}-${ordered.length}`,
    date_range: { from, to },
    reflection_count: ordered.length,
    sections,
    safety_flags: safetyFlags,
    limitations: "This is a supportive summary of structured reflection fields, not a clinical assessment or diagnosis. Review it before choosing whether to share it.",
    generated_at: now.toISOString(),
  };
}

export function counselorSummaryToText(summary: CounselorSupportSummary) {
  const range = summary.date_range.from && summary.date_range.to
    ? `${new Date(summary.date_range.from).toLocaleDateString()} – ${new Date(summary.date_range.to).toLocaleDateString()}`
    : "No reflection dates available";
  const lines = [`Supportive reflection summary`, `${range} · ${summary.reflection_count} reflection${summary.reflection_count === 1 ? "" : "s"}`, ""];
  for (const item of summary.sections) lines.push(item.title, ...(item.items.length ? item.items.map((value) => `- ${value}`) : ["- No structured data available."]), "");
  if (summary.safety_flags.length) lines.push("Safety flags", ...summary.safety_flags.map((flag) => `- ${flag.level}: ${flag.reasons.join(", ") || "flag recorded"}`), "");
  lines.push("Limitation", summary.limitations);
  return lines.join("\n");
}
