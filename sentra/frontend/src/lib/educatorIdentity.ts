/**
 * How a student is named on an educator screen: クラス and 出席番号, never the
 * student's name (#466).
 *
 * blesc.jp promises 「先生に表示されるのは、クラス、出席番号、観測された表現の
 * 種類、時刻だけです。」 Until #466 the educator screens showed
 * `display_name ?? code` — the student's name, or failing that an internal id.
 *
 * When the school has not set a class or number yet, the placeholder says so.
 * It does not fall back to the name, and it does not fall back to `code`
 * either: an internal id on a teacher's screen invites someone to start
 * keeping a table of which id is which student, which is a name list by
 * another route.
 *
 * Kept out of `StatusChips.tsx` so the tests can import it: Node's type
 * stripping reads `.ts`, not JSX.
 */

import type { EducatorStudentStatus } from "@/api/models";
import { t } from "./i18n/index.ts";

type Placement = Pick<EducatorStudentStatus, "class_label" | "attendance_number">;

function classOf(student: Placement): string | null {
  return student.class_label?.trim() || null;
}

function numberOf(student: Placement): number | null {
  return typeof student.attendance_number === "number" && Number.isFinite(student.attendance_number)
    ? student.attendance_number
    : null;
}

export function studentIdentity(student: Placement): string {
  const classLabel = classOf(student);
  const number = numberOf(student);
  if (classLabel && number !== null) return t.educator.identity.classAndNumber(classLabel, number);
  if (classLabel) return t.educator.identity.classOnly(classLabel);
  if (number !== null) return t.educator.identity.numberOnly(number);
  return t.educator.identity.unset;
}

/**
 * Class, then attendance number. Students with no class set go last;
 * `participant_id` keeps the order stable without reading anything that
 * identifies the student.
 */
export function compareByClassAndNumber(
  a: Placement & Pick<EducatorStudentStatus, "participant_id">,
  b: Placement & Pick<EducatorStudentStatus, "participant_id">,
): number {
  const classA = classOf(a);
  const classB = classOf(b);
  if (classA !== classB) {
    if (classA === null) return 1;
    if (classB === null) return -1;
    const byClass = classA.localeCompare(classB, "ja", { numeric: true });
    if (byClass !== 0) return byClass;
  }
  const numberA = numberOf(a) ?? Number.POSITIVE_INFINITY;
  const numberB = numberOf(b) ?? Number.POSITIVE_INFINITY;
  if (numberA !== numberB) return numberA < numberB ? -1 : 1;
  return a.participant_id.localeCompare(b.participant_id);
}

/**
 * Whether this student has anything an educator should be shown at all.
 *
 * An observation without reasons cannot be traced back to something the
 * student actually wrote, so it is not rendered — a flag an educator cannot
 * explain is worse than no flag. (Moved here from `StatusChips.tsx` in #466 so
 * the ordering below and its tests can use it.)
 */
export function hasShowableObservation(
  student: Pick<EducatorStudentStatus, "safety_level" | "safety_reasons" | "safety_at">,
): boolean {
  if (!student.safety_level || student.safety_level === "none") return false;
  return student.safety_reasons.length > 0 && Boolean(student.safety_at);
}

/**
 * The order of every educator list (#466): newest observation first; students
 * with no showable observation after them, by class and number.
 *
 * Never by an inferred band (`educator_display_policy.md` rule 1).
 */
export function byNewestObservation(a: EducatorStudentStatus, b: EducatorStudentStatus): number {
  const aShown = hasShowableObservation(a);
  const bShown = hasShowableObservation(b);
  if (aShown && bShown) {
    const byTime = (b.safety_at ?? "").localeCompare(a.safety_at ?? "");
    if (byTime !== 0) return byTime;
  } else if (aShown !== bShown) {
    return aShown ? -1 : 1;
  }
  return compareByClassAndNumber(a, b);
}
