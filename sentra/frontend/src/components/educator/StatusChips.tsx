import type { EducatorStudentStatus } from "@/api/models";
import { t } from "@/lib/i18n";
import { describeWritingChange } from "@/lib/writingChangeObservation";

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

/** The observation itself: what was matched, when, on which surface. */
export function ObservationLine({ student }: { student: EducatorStudentStatus }) {
  if (!hasShowableObservation(student)) return <WritingChangeLine student={student} />;
  const surface = student.safety_surface ? t.safety.surface[student.safety_surface] ?? student.safety_surface : null;
  return (
    <>
    {/* #468: the writing-change line sits under the safety one when both exist. */}
    <div className="text-xs leading-relaxed" style={{ color: "var(--ink-mid)" }}>
      <div>
        <span style={{ color: "var(--ink-faint)" }}>{t.safety.observationPrefix}</span>
        {student.safety_reasons.map((reason) => t.safety.reason[reason] ?? reason).join(" / ")}
        <span style={{ color: "var(--ink-faint)" }}>
          （{formatTimestamp(student.safety_at!)}
          {surface ? ` · ${surface}` : ""}）
        </span>
      </div>
      <div style={{ color: "var(--ink-faint)" }}>
        {t.safety.observationBasis}
      </div>
    </div>
    <WritingChangeLine student={student} />
    </>
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
        {t.educator.baseline.learning}
        {typeof student.baseline_days_remaining === "number"
          ? t.educator.baseline.learningRemaining(student.baseline_days_remaining)
          : ""}
        {` · ${t.educator.baseline.learningNote}`}
      </div>
    );
  }
  return (
    <div className="text-xs" style={{ color: "var(--ink-faint)" }}>
      {t.educator.baseline.source[student.baseline_type ?? "user"] ?? t.educator.baseline.source.user}
    </div>
  );
}

/** Fixed footer on every educator surface. */
export function NonDiagnosticNotice() {
  return (
    <p className="text-xs" style={{ color: "var(--ink-faint)" }}>
      {t.common.nonDiagnosticNotice}
    </p>
  );
}
