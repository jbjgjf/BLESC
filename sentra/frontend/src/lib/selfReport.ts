/**
 * The daily fixed self-report (#165).
 *
 * Mirrors `pilot-selfreport-v1` in `docs/pilot/data-dictionary.json`, which is
 * the protocol's machine-readable source. Where the two disagree, the
 * dictionary is right and this is the bug — `tests/self-report.test.mjs` pins
 * the ids, scales, order and anchors so a drift shows up as a failing test
 * rather than as a dataset nobody can pool.
 *
 * Why the items are asked at all: the study measures how people write, and the
 * only reading of the text available during the collection window is the text
 * itself. Scoring a text-derived quantity against another text-derived
 * quantity answers a question about the extractor, not about the participant.
 * These five are the outside measurement.
 *
 * Three rules, all of which have a way of eroding if they are not written
 * down:
 *
 *   1. **The order is fixed and the wording does not change mid-study.**
 *      Re-ordering or rephrasing an item makes week one and week three
 *      incomparable, which is the same kind of damage as changing a scale.
 *
 *   2. **Every item is optional, and a missing answer is missing.** Not 0, not
 *      the midpoint. A default written into the record is a fabricated reading
 *      the analysis cannot distinguish from a real one.
 *
 *   3. **Nothing here is asked twice in different words.** Five items is a
 *      deliberate ceiling: the burden is five minutes a day, and an instrument
 *      that grows every time someone has a hypothesis stops being answerable.
 */

/** The pinned version. Travels with every stored row. */
export const SELF_REPORT_SCHEMA_ID = "pilot-selfreport-v1";

export type LikertItem = {
  id: string;
  kind: "likert_0_10";
  label_ja: string;
  anchors_ja: { low: string; high: string };
  order: number;
};

export type NumberItem = {
  id: string;
  kind: "hours_0_5_step";
  label_ja: string;
  min: number;
  max: number;
  step: number;
  order: number;
};

export type SelfReportItem = LikertItem | NumberItem;

/**
 * The five items.
 *
 * `support_contact` ("誰かに相談できたか") is in the dictionary and is
 * deliberately **not** here. It is marked `DECISION REQUIRED` there, with the
 * research ethics lead named as the decider, because asking the question is
 * itself an intervention that may prompt help-seeking — which would be a good
 * thing to do and a bad thing to do accidentally in the middle of measuring
 * whether help-seeking changes. Implementing it from a guess would settle a
 * question that has not been settled.
 */
export const SELF_REPORT_ITEMS: readonly SelfReportItem[] = [
  {
    id: "mood",
    kind: "likert_0_10",
    label_ja: "今日の気分",
    anchors_ja: { low: "とても悪い", high: "とても良い" },
    order: 1,
  },
  {
    id: "stress",
    kind: "likert_0_10",
    label_ja: "今日のストレス",
    anchors_ja: { low: "まったくない", high: "とても強い" },
    order: 2,
  },
  {
    id: "sleep_quality",
    kind: "likert_0_10",
    label_ja: "昨夜の睡眠の質",
    anchors_ja: { low: "とても悪い", high: "とても良い" },
    order: 3,
  },
  {
    id: "sleep_hours",
    kind: "hours_0_5_step",
    label_ja: "昨夜の睡眠時間",
    min: 0,
    max: 16,
    step: 0.5,
    order: 4,
  },
  {
    id: "event_intensity",
    kind: "likert_0_10",
    label_ja: "今日の出来事の大きさ",
    anchors_ja: { low: "なにもなかった", high: "とても大きい" },
    order: 5,
  },
] as const;

export const SELF_REPORT_ITEM_IDS: readonly string[] = SELF_REPORT_ITEMS.map((item) => item.id);

/** One stored answer. `observed: false` carries no value, ever. */
export type SelfReportAnswer = { value: number; observed: true } | { value: null; observed: false };

export type SelfReportResponses = Record<string, SelfReportAnswer>;

const UNANSWERED: SelfReportAnswer = { value: null, observed: false };

function validAnswer(item: SelfReportItem, raw: unknown): SelfReportAnswer {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return UNANSWERED;

  if (item.kind === "likert_0_10") {
    if (!Number.isInteger(raw) || raw < 0 || raw > 10) return UNANSWERED;
    return { value: raw, observed: true };
  }

  if (raw < item.min || raw > item.max) return UNANSWERED;
  // Snap to the step rather than rejecting a value a slider produced with a
  // floating-point tail. 7.499999999 is a participant answering 7.5.
  const steps = Math.round(raw / item.step);
  const snapped = Number((steps * item.step).toFixed(2));
  if (Math.abs(snapped - raw) > item.step / 2) return UNANSWERED;
  return { value: snapped, observed: true };
}

/**
 * Whatever the client sent, as answers on the pinned schema.
 *
 * **Never throws and never rejects a submission.** An out-of-range value, an
 * item that is not in the schema, a string where a number belongs — all of them
 * become "not answered" rather than an error, because the journal text is the
 * thing that must not be lost (#132) and a malformed rating is not a reason to
 * refuse a participant's writing. What the record says is that the item was not
 * answered, which is true: no valid answer arrived.
 *
 * Unknown keys are dropped, so a client cannot store an item the protocol does
 * not define.
 */
export function normalizeSelfReport(raw: unknown): SelfReportResponses {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const responses: SelfReportResponses = {};

  for (const item of SELF_REPORT_ITEMS) {
    const given = source[item.id];
    // Both shapes are accepted: the bare value a form produces, and the
    // `{ value, observed }` shape this module emits — so a round trip through
    // storage does not change the answers.
    const value =
      given && typeof given === "object" && "value" in (given as Record<string, unknown>)
        ? (given as Record<string, unknown>).value
        : given;
    responses[item.id] = validAnswer(item, value);
  }

  return responses;
}

/** Whether any item was answered. A submission with none is stored as a row of
 *  unanswered items rather than as no row, so "asked and skipped" and "never
 *  asked" stay distinguishable in the dataset. */
export function hasAnyAnswer(responses: SelfReportResponses): boolean {
  return Object.values(responses).some((answer) => answer.observed);
}

/** The export's flat shape: one key per item, null where unanswered. */
export function flattenSelfReport(responses: SelfReportResponses): Record<string, number | null> {
  const flat: Record<string, number | null> = {};
  for (const item of SELF_REPORT_ITEMS) {
    const answer = responses[item.id];
    flat[item.id] = answer?.observed ? answer.value : null;
  }
  return flat;
}
