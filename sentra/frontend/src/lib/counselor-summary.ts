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
      ? [`記録された強さは1件です（${intensities[0].intensity}/5）。`]
      : [`記録された強さは ${intensities[0].intensity}/5 から ${intensities.at(-1)?.intensity}/5 へ${Number(intensities.at(-1)?.intensity) > Number(intensities[0].intensity) ? "上がっています" : Number(intensities.at(-1)?.intensity) < Number(intensities[0].intensity) ? "下がっています" : "変わっていません"}。`];

  const discussionItems = [
    triggers[0] ? `「${triggers[0].label}」が最近の毎日にどう影響しているか話す。` : "最近いちばん気になっていることを話す。",
    supports[0] ? `「${supports[0].label}」のような支援が役に立ちそうか話す。` : "いまどんな支援があると助かりそうか話す。",
    protective[0] ? `「${protective[0].label}」を続けられるようにする方法を話す。` : "支えになっている人・場所・習慣について話す。",
  ];

  const sections = [
    section("recent_themes", "最近のテーマ", themes.map((item) => `${item.label}（${item.count}件）`), themes.flatMap((item) => item.ids)),
    section("recurring_triggers", "繰り返し現れるきっかけ", triggers.map((item) => `${item.label}（${item.count}件）`), triggers.flatMap((item) => item.ids)),
    section("intensity_trend", "強さの推移", intensityItems, intensities.map((event) => event.event_id)),
    section("support_needs", "必要としている支援", supports.map((item) => item.label), supports.flatMap((item) => item.ids)),
    section("protective_factors", "支えになっていること", protective.map((item) => item.label), protective.flatMap((item) => item.ids)),
    section("suggested_discussion_points", "話し合いたいこと", discussionItems, [...new Set([...triggers, ...supports, ...protective].flatMap((item) => item.ids))]),
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
    limitations: "これは日記の構造化された項目から作成した支援用のまとめであり、診断や臨床的な評価ではありません。共有するかどうかを決める前に、内容を確認してください。",
    generated_at: now.toISOString(),
  };
}

export function counselorSummaryToText(summary: CounselorSupportSummary) {
  const range = summary.date_range.from && summary.date_range.to
    ? `${new Date(summary.date_range.from).toLocaleDateString()} – ${new Date(summary.date_range.to).toLocaleDateString()}`
    : "記録の期間が取得できません";
  const lines = [`支援用のまとめ`, `${range} ・ ${summary.reflection_count}件の記録`, ""];
  for (const item of summary.sections) lines.push(item.title, ...(item.items.length ? item.items.map((value) => `- ${value}`) : ["- 該当する記録はありません。"]), "");
  if (summary.safety_flags.length) lines.push("安全に関する記録", ...summary.safety_flags.map((flag) => `- ${flag.level}: ${flag.reasons.join("、") || "記録あり"}`), "");
  lines.push("この資料について", summary.limitations);
  return lines.join("\n");
}
