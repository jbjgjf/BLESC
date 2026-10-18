import type { EducatorObservation, EducatorStudentStatus } from "@/api/models";
import { t } from "@/lib/i18n";
import { describeWritingChange } from "@/lib/writingChangeObservation";
import { hasShowableObservation } from "@/lib/educatorIdentity";

// Re-exported so the screens keep one import for the educator display pieces.
// The functions live in `lib/educatorIdentity.ts`, where the tests can reach them.
export { byNewestObservation, compareByClassAndNumber, hasShowableObservation, studentIdentity } from "@/lib/educatorIdentity";

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

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Draws attention without classifying the student. */
export function AttentionChip({ student }: { student: EducatorStudentStatus }) {
  if (!hasShowableObservation(student)) return null;
  const color = student.safety_level === "crisis" ? "var(--terracotta)" : "var(--sienna)";
  return (
    <span className="rounded-full px-2.5 py-0.5 text-xs font-semibold" style={{ border: `1px solid ${color}`, color }}>
      {t.safety.attentionChip}
    </span>
  );
}

/**
 * A 「書きぶりの変化」 observation (#468): which writing feature moved against
 * the student's own past, which way, when, and on which surface.
 *
 * Deliberately NOT part of `hasShowableObservation`: that predicate drives the
 * 要確認 chip, the flagged filter and the overview tile, which are about the
 * safety layer asking for a person to look. A change in how someone writes is
 * context, not a request to intervene, and counting it there would turn it into
 * the classification the policy removed.
 */
export function WritingChangeLine({ student }: { student: EducatorStudentStatus }) {
  const observation = student.writing_change;
  if (!observation || observation.evidence.length === 0) return null;
  const surface = t.safety.surface[observation.surface] ?? observation.surface;
  return (
    <div className="text-xs leading-relaxed" style={{ color: "var(--ink-mid)" }}>
      <div>
        <span style={{ color: "var(--ink-faint)" }}>{t.writingChange.observationPrefix}</span>
        {observation.evidence.map(describeWritingChange).join(" / ")}
        <span style={{ color: "var(--ink-faint)" }}>
          （{formatTimestamp(observation.observed_at)} · {surface}）
        </span>
      </div>
      <div style={{ color: "var(--ink-faint)" }}>{t.writingChange.basis(observation.baseline_window_days)}</div>
    </div>
  );
}

/**
 * One observation, in the fields the site promises (#466): what kind of
 * expression was matched, when, on which input (ジャーナル／チャット／音声),
 * and the evidence line 「根拠: 記述との一致 / 推論なし」.
 *
 * An observation with no reasons renders the level's wording in place of the
 * kind. That only happens for safety-history rows written before reasons were
 * stored; withholding a safety record has its own risk, so it is shown rather
 * than dropped (see `educator_display_policy.md`, outputs table).
 */
export function ObservationDetail({ observation }: { observation: EducatorObservation }) {
  const surface = observation.surface ? t.safety.surface[observation.surface] ?? observation.surface : null;
  const kind = observation.reasons.length
    ? observation.reasons.map((reason) => t.safety.reason[reason] ?? reason).join(" / ")
    : t.safety.level[observation.level] ?? t.safety.flagRecorded;
  return (
    <div className="text-xs leading-relaxed" style={{ color: "var(--ink-mid)" }}>
      <div>
        <span style={{ color: "var(--ink-faint)" }}>{t.safety.observationPrefix}</span>
        {kind}
        <span style={{ color: "var(--ink-faint)" }}>
          （{formatTimestamp(observation.occurred_at)}
          {surface ? ` · ${surface}` : ""}）
        </span>
      </div>
      <div style={{ color: "var(--ink-faint)" }}>
        {t.safety.observationBasis}
      </div>
    </div>
  );
}

/**
 * The latest observations on a roster row: the safety one, and under it the
 * writing-change one (#468) when both exist.
 */
export function ObservationLine({ student }: { student: EducatorStudentStatus }) {
  if (!hasShowableObservation(student)) return <WritingChangeLine student={student} />;
  return (
    <>
      <ObservationDetail
        observation={{
          level: student.safety_level!,
          reasons: student.safety_reasons,
          surface: student.safety_surface,
          occurred_at: student.safety_at!,
        }}
      />
      <WritingChangeLine student={student} />
    </>
  );
}

/*
 * `BaselineContextLine` stood here: 「基準値の学習中（残り N 日）」 or
 * 「この生徒自身の記録との比較」 under each observation. #466 removed it. It is
 * not one of the fields blesc.jp promises an educator sees, and the baseline
 * fields that fed it are off `EducatorStudentStatus` with it, so the next
 * screen cannot render it by accident.
 */

/** Fixed footer on every educator surface. */
export function NonDiagnosticNotice() {
  return (
    <p className="text-xs" style={{ color: "var(--ink-faint)" }}>
      {t.common.nonDiagnosticNotice}
    </p>
  );
}
