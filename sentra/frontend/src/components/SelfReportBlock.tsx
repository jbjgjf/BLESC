"use client";

/**
 * The fixed self-report block, as the participant sees it (#165).
 *
 * Shown only to a participant whose collection window is open. Outside the
 * study this component is not rendered at all, so the ordinary journal screen
 * is unchanged — which is the requirement, not a nicety: adding five sliders to
 * everyone's journal would change what everyone writes, and the non-pilot
 * product is not part of this study.
 *
 * The items, their order and their ranges come from `lib/pilotSelfReport`. This
 * file renders them and holds no opinion about what they are; a scale that
 * disagreed with the server's would be a scale whose stored values mean
 * something other than what the participant was shown.
 *
 * Three things the interaction has to get right, because each one changes the
 * data rather than the experience:
 *
 *   1. **No default position.** A slider that starts at 5 collects 5 from
 *      everyone who does not touch it, and that is indistinguishable in the
 *      table from five hundred people who considered the question and answered
 *      5. Nothing is selected until the participant selects it.
 *
 *   2. **Skipping is a visible, equal option.** 「答えない」 sits in the same
 *      row as the numbers, at the same size. A skip that requires scrolling
 *      past, or that looks like the failure state, is not optional in practice
 *      — and an instrument whose items are answered under mild pressure is
 *      measuring the pressure.
 *
 *   3. **Answering never blocks submitting.** The journal is the thing the
 *      participant came to write. These five questions are the study's, and the
 *      study does not get to hold their entry hostage.
 */

import { SELF_REPORT_ITEMS, type SelfReportItemId } from "@/lib/pilotSelfReport";
import styles from "./SelfReportBlock.module.css";

export type SelfReportValues = Partial<Record<SelfReportItemId, number | null>>;

type Props = {
  values: SelfReportValues;
  onChange: (id: SelfReportItemId, value: number | null) => void;
  disabled?: boolean;
};

/** The points on one item's scale: min, min+step, … max. */
function scalePoints(min: number, max: number, step: number): number[] {
  const points: number[] = [];
  for (let value = min; value <= max + 1e-9; value += step) {
    points.push(Math.round(value / step) * step);
  }
  return points;
}

/** `6.5` reads better as 6.5 and `6` as 6 — never "6.0" on a button. */
function label(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * Above this many points a row of buttons stops being readable and starts being
 * a wall. `sleep_hours` has 33 (0 to 16 by halves), so it renders as a select;
 * the Likert items have 11 and stay as buttons, where the whole scale is
 * visible at once and the endpoints can be labelled.
 */
const MAX_POINTS_AS_BUTTONS = 12;

export function SelfReportBlock({ values, onChange, disabled = false }: Props) {
  return (
    <section className={styles.block} aria-labelledby="self-report-heading">
      <h3 id="self-report-heading" className="bl-label">
        今日の記録
        <span className="bl-optional">すべて任意</span>
      </h3>
      <p className="bl-meta" style={{ marginTop: -4 }}>
        研究のために、毎日おなじ項目をうかがっています。答えたくない項目は「答えない」を
        選んでください。空欄のままでも日記は保存できます。
      </p>

      {SELF_REPORT_ITEMS.map((item) => {
        const selected = values[item.id];
        const points = scalePoints(item.min, item.max, item.step);
        return (
          <fieldset key={item.id} className={styles.item} disabled={disabled}>
            <legend className={styles.itemLabel}>{item.label_ja}</legend>
            {item.anchors_ja && (
              <p className={styles.anchors} aria-hidden="true">
                <span>
                  {item.min}: {item.anchors_ja.min}
                </span>
                <span>
                  {item.max}: {item.anchors_ja.max}
                </span>
              </p>
            )}
            {points.length <= MAX_POINTS_AS_BUTTONS ? (
              <div
                className={styles.scale}
                role="radiogroup"
                aria-label={`${item.label_ja}（${item.min}から${item.max}、または答えない）`}
              >
                {points.map((point) => (
                  <button
                    key={point}
                    type="button"
                    role="radio"
                    // `selected === point` and not a truthiness test: 0 is an
                    // answer on every one of these scales.
                    aria-checked={selected === point}
                    data-selected={selected === point}
                    className={styles.point}
                    onClick={() => onChange(item.id, selected === point ? null : point)}
                  >
                    {label(point)}
                  </button>
                ))}
                <button
                  type="button"
                  role="radio"
                  // Selected only when the participant actually declined, never
                  // when they have not reached the item yet. Both send null —
                  // neither is a reading — but showing a selection they did not
                  // make would tell them they had answered when they had not.
                  aria-checked={selected === null}
                  data-selected={selected === null}
                  className={`${styles.point} ${styles.skip}`}
                  onClick={() => onChange(item.id, null)}
                >
                  答えない
                </button>
              </div>
            ) : (
              <select
                className={styles.select}
                aria-label={item.label_ja}
                // "" is the empty option, which covers both "not reached yet"
                // and "declined". A select cannot show the difference, so the
                // option says 答えない and means both.
                value={selected === null || selected === undefined ? "" : String(selected)}
                onChange={(event) =>
                  onChange(item.id, event.target.value === "" ? null : Number(event.target.value))
                }
              >
                <option value="">答えない</option>
                {points.map((point) => (
                  <option key={point} value={point}>
                    {label(point)} 時間
                  </option>
                ))}
              </select>
            )}
          </fieldset>
        );
      })}
    </section>
  );
}

export default SelfReportBlock;
