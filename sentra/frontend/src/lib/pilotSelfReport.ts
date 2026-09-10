/**
 * The fixed self-report block collected alongside every pilot journal entry
 * (#165).
 *
 * The journal text is free-form and the extraction that would read it is
 * switched off during collection (`lib/server/collectionMode.ts`). That leaves
 * the study with no numeric series at all unless the participant is asked
 * directly — so these five items are the only quantitative measurement the
 * pilot takes, and they have to survive being asked 21 times without drifting.
 *
 * Three properties make that possible, and all three are enforced here rather
 * than left to the screen that renders them:
 *
 *   1. **The item set and its order are fixed and versioned.** `SCHEMA_VERSION`
 *      is stored on every row. An item added, removed or reworded is a new
 *      version, so week 1 and week 3 are never silently different instruments.
 *      Presentation order is part of the instrument: moving "stress" above
 *      "mood" changes the answers, so `ITEMS` is ordered and the renderer is
 *      expected to follow it rather than sort by anything of its own.
 *
 *   2. **Every item is optional, and a skip is null.** Never 0, never the
 *      midpoint. A participant who did not answer "how did you sleep" and one
 *      who slept terribly are different observations; writing either as a
 *      number makes them the same one, and no analysis afterwards can separate
 *      them again.
 *
 *   3. **An out-of-range value is rejected, not clamped.** Clamping 11 to 10
 *      invents a reading the participant never gave. A rejected value is
 *      recorded as a rejection (`rejected`) so a client bug that starts sending
 *      11 shows up as a growing rejection count rather than as a cohort that
 *      suddenly reports a maximum mood.
 *
 * The item definitions mirror `docs/pilot/data-dictionary.json`
 * (`daily_self_report`, schema id `pilot-selfreport-v1`). `support_contact` is
 * in that dictionary and is deliberately NOT here: it carries `DECISION
 * REQUIRED` — asking whether a student talked to someone is itself a nudge to
 * talk to someone, and the protocol has not settled whether the pilot may do
 * that. The dictionary says an item in that state must not be implemented from
 * a guess, so it is absent until the ethics lead decides.
 *
 * This module is pure: no network, no database, no environment. It is imported
 * by the submission route (to validate) and by the journal screen (to render),
 * so both agree on what the scale is.
 */

/**
 * Bump this — and add a migration — when the item set, an item's range, or the
 * presentation order changes. Stored on every row so an analysis can tell which
 * instrument produced a number.
 */
export const SELF_REPORT_SCHEMA_VERSION = "pilot-selfreport-v1";

export type SelfReportItemId =
  | "mood"
  | "stress"
  | "sleep_quality"
  | "sleep_hours"
  | "event_intensity";

export type SelfReportItem = {
  id: SelfReportItemId;
  /** Rendered to the participant. Japanese, 敬体, school-appropriate (#116). */
  label_ja: string;
  /** `integer` items step by 1; `number` items by `step`. */
  kind: "integer" | "number";
  /** The scale name recorded in the data dictionary, for the export header. */
  scale: string;
  min: number;
  max: number;
  step: number;
  /** Endpoint labels. Only meaningful for the Likert items. */
  anchors_ja?: { min: string; max: string };
};

/**
 * The instrument, in presentation order.
 *
 * `sleep_hours` sits after `sleep_quality` on purpose: the quality judgement is
 * the one that degrades if the participant has just done arithmetic about their
 * bedtime.
 */
export const SELF_REPORT_ITEMS: readonly SelfReportItem[] = [
  {
    id: "mood",
    label_ja: "今日の気分",
    kind: "integer",
    scale: "likert_0_10",
    min: 0,
    max: 10,
    step: 1,
    anchors_ja: { min: "とても悪い", max: "とても良い" },
  },
  {
    id: "stress",
    label_ja: "今日のストレス",
    kind: "integer",
    scale: "likert_0_10",
    min: 0,
    max: 10,
    step: 1,
    anchors_ja: { min: "まったくない", max: "とても強い" },
  },
  {
    id: "sleep_quality",
    label_ja: "昨夜の睡眠の質",
    kind: "integer",
    scale: "likert_0_10",
    min: 0,
    max: 10,
    step: 1,
    anchors_ja: { min: "とても悪い", max: "とても良い" },
  },
  {
    id: "sleep_hours",
    label_ja: "昨夜の睡眠時間",
    kind: "number",
    scale: "hours_0_5_step",
    min: 0,
    max: 16,
    step: 0.5,
  },
  {
    id: "event_intensity",
    label_ja: "今日の出来事の大きさ",
    kind: "integer",
    scale: "likert_0_10",
    min: 0,
    max: 10,
    step: 1,
    anchors_ja: { min: "なにもなかった", max: "とても大きい" },
  },
] as const;

const ITEMS_BY_ID = new Map(SELF_REPORT_ITEMS.map((item) => [item.id as string, item]));

/** Why a submitted value did not become a stored reading. */
export type SelfReportRejection =
  /** Not a finite number — a string, null-ish, NaN, Infinity. */
  | "not_a_number"
  /** Outside [min, max]. Never clamped. */
  | "out_of_range"
  /** Not on the scale's step (10.3 hours, 4.5 on a 0-10 Likert). */
  | "off_step"
  /** An id that is not part of this schema version. */
  | "unknown_item";

export type SelfReportValues = Record<SelfReportItemId, number | null>;

export type NormalizedSelfReport = {
  schema_version: string;
  /** One key per item, in `SELF_REPORT_ITEMS` order. null means not answered. */
  values: SelfReportValues;
  /** Item ids that carry a number. `values[id] !== null` for exactly these. */
  answered: SelfReportItemId[];
  /**
   * What the client sent that could not be stored, by key. Kept so a broken
   * client is visible in the operations dashboard as rejections rather than
   * as an unexplained rise in skipped items.
   *
   * Holds the *reason*, never the offending value: an item id and a reason are
   * enough to debug a slider, and a free-form value could carry text.
   */
  rejected: Record<string, SelfReportRejection>;
  /** True when nothing at all was answered — every item null. */
  empty: boolean;
};

function emptyValues(): SelfReportValues {
  const values = {} as SelfReportValues;
  for (const item of SELF_REPORT_ITEMS) values[item.id] = null;
  return values;
}

/**
 * Whether `value` lands exactly on one of the scale's points.
 *
 * Done in integer arithmetic. `(x - min) % step` on floats says 7.5 is off a
 * 0.5 step, because 7.5 - 0 is not exactly divisible in binary floating point
 * for every input the browser can produce.
 */
function onStep(value: number, item: SelfReportItem): boolean {
  const steps = (value - item.min) / item.step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

/**
 * Turn whatever the client sent into the row that gets stored.
 *
 * Total: never throws, and always returns a complete value set. A submission
 * whose self-report is entirely malformed still stores its journal text — the
 * text is the participant's, and losing it because a slider misbehaved would be
 * the worse failure (#132).
 */
export function normalizeSelfReport(input: unknown): NormalizedSelfReport {
  const values = emptyValues();
  const rejected: Record<string, SelfReportRejection> = {};

  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
      const item = ITEMS_BY_ID.get(key);
      if (!item) {
        // An id this schema version does not define. Recorded rather than
        // ignored: it is either a client running an older instrument or a
        // caller trying to widen the research record, and both are worth
        // seeing.
        rejected[key] = "unknown_item";
        continue;
      }
      // Not answered. The distinction the whole module exists for, so it is
      // a null and not a rejection.
      if (raw === null || raw === undefined || raw === "") continue;

      const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
      if (!Number.isFinite(value)) {
        rejected[key] = "not_a_number";
        continue;
      }
      if (value < item.min || value > item.max) {
        rejected[key] = "out_of_range";
        continue;
      }
      if (!onStep(value, item)) {
        rejected[key] = "off_step";
        continue;
      }
      // Rounded to the step so 7.499999999 stored as 7.5 rather than as a
      // float the CHECK constraint would then reject.
      values[item.id] = Math.round(value / item.step) * item.step;
    }
  }

  const answered = SELF_REPORT_ITEMS.filter((item) => values[item.id] !== null).map((item) => item.id);
  return {
    schema_version: SELF_REPORT_SCHEMA_VERSION,
    values,
    answered,
    rejected,
    empty: answered.length === 0,
  };
}

/**
 * True when there is something worth storing: an answer, or a rejection that an
 * operator should see.
 *
 * A submission that carried no self-report at all — every non-pilot user, and a
 * pilot participant who skipped the whole block — writes no row. An absent row
 * and a row of five nulls would otherwise be indistinguishable in the export,
 * and they are not the same thing: one means the block was never presented.
 */
export function hasSelfReportContent(report: NormalizedSelfReport): boolean {
  return !report.empty || Object.keys(report.rejected).length > 0;
}
