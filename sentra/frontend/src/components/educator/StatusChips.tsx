import type { EducatorStudentStatus } from "@/api/models";

export const panel: React.CSSProperties = {
  backgroundColor: "var(--ivory)",
  border: "1px solid var(--limestone)",
  borderRadius: "var(--radius)",
  overflow: "hidden",
};

/**
 * The educator surface shows OBSERVATIONS, never a risk classification.
 *
 * "The student wrote a direct statement about self-harm at 22:14" is a fact
 * and needs no clinical validation. "Risk: high" is an inference about a
 * minor's internal state, and at school-level prevalence its positive
 * predictive value is poor no matter how good the model becomes — at 5%
 * prevalence, a classifier at 80% sensitivity and 90% specificity flags 135
 * students in a school of 1000 and is wrong about 95 of them. Better models
 * move that number; they do not fix it. The band was removed rather than
 * tuned. See docs/educator_display_policy.md.
 */

/** How the deterministic safety layer describes what it matched. */
const REASON_LABELS: Record<string, string> = {
  self_harm_or_suicide_risk: "自傷・自殺に関する直接的な表現",
  possible_self_harm_or_suicide_risk: "自傷に関連する表現",
  possible_suicide_risk: "生きることへの否定的な表現",
  ambiguous_withdrawal_signal: "「消えたい」など離脱を示唆する曖昧な表現",
  inability_to_stay_safe: "安全を保てないという表現",
  abuse_or_violence_disclosure: "暴力・虐待の開示",
  imminent_violence_risk: "他害の切迫を示す表現",
  possible_violence_risk: "他害に関連する表現",
  concealment_request_related_to_harm: "危害に関する秘匿の依頼",
  distress_without_explicit_danger: "苦痛の表現（危険の明示なし）",
  risk_disclosed_on_another_surface: "別の画面での開示を引き継ぎ",
};

const SURFACE_LABELS: Record<string, string> = {
  journal: "ジャーナル",
  chat: "チャット",
  voice: "音声",
};

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * Whether this student has anything an educator should be shown at all.
 *
 * An observation without reasons cannot be traced back to something the
 * student actually wrote, so it is not rendered — a flag an educator cannot
 * explain is worse than no flag.
 */
export function hasShowableObservation(student: EducatorStudentStatus): boolean {
  if (!student.safety_level || student.safety_level === "none") return false;
  return student.safety_reasons.length > 0 && Boolean(student.safety_at);
}

/** Draws attention without classifying the student. */
export function AttentionChip({ student }: { student: EducatorStudentStatus }) {
  if (!hasShowableObservation(student)) return null;
  const color = student.safety_level === "crisis" ? "var(--terracotta)" : "var(--sienna)";
  return (
    <span className="rounded-full px-2.5 py-0.5 text-xs font-semibold" style={{ border: `1px solid ${color}`, color }}>
      要確認
    </span>
  );
}

/** The observation itself: what was matched, when, on which surface. */
export function ObservationLine({ student }: { student: EducatorStudentStatus }) {
  if (!hasShowableObservation(student)) return null;
  const surface = student.safety_surface ? SURFACE_LABELS[student.safety_surface] ?? student.safety_surface : null;
  return (
    <div className="text-xs leading-relaxed" style={{ color: "var(--ink-mid)" }}>
      <div>
        <span style={{ color: "var(--ink-faint)" }}>観測: </span>
        {student.safety_reasons.map((reason) => REASON_LABELS[reason] ?? reason).join(" / ")}
        <span style={{ color: "var(--ink-faint)" }}>
          （{formatTimestamp(student.safety_at!)}
          {surface ? ` · ${surface}` : ""}）
        </span>
      </div>
      <div style={{ color: "var(--ink-faint)" }}>
        └ 根拠: safety.py の決定的マッチ / 推論なし
      </div>
    </div>
  );
}

/**
 * Context relative to the student's own history — shown ONLY once their
 * baseline is their own. During the ramp-up the comparison is against guessed
 * population statistics, so the line would look like evidence while carrying
 * none.
 */
export function BaselineContextLine({ student }: { student: EducatorStudentStatus }) {
  if (student.baseline_is_provisional) {
    return (
      <div className="text-xs" style={{ color: "var(--ink-faint)" }}>
        基準値の学習中
        {typeof student.baseline_days_remaining === "number" ? `（残り ${student.baseline_days_remaining} 日）` : ""}
        · この期間は比較を表示しません
      </div>
    );
  }
  return (
    <div className="text-xs" style={{ color: "var(--ink-faint)" }}>
      └ baseline_type: {student.baseline_type ?? "user"}
    </div>
  );
}

/** Fixed footer on every educator surface. */
export function NonDiagnosticNotice() {
  return (
    <p className="text-xs" style={{ color: "var(--ink-faint)" }}>
      本ツールは診断を行いません。表示されるのは観測された記述とその時刻のみで、リスクの判定ではありません。
    </p>
  );
}
