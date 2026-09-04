"use client";

import { Icon } from "@/components/ui/Icon";
import { formatDate } from "@/lib/blesc/labels";
import {
  PILOT_DAYS,
  PILOT_END,
  PILOT_START,
  pilotDays,
  pilotProgress,
  usePilotToday,
} from "@/lib/blesc/pilot";
import styles from "./PilotCalendar.module.css";

/**
 * 試験導入期間のカレンダー。
 *
 * 升目は <table> で組んでいる。曜日が列見出しになるので、読み上げ環境では
 * 「8月12日、水曜」のように位置が伝わる。div を並べるとこれが失われる。
 */

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

const weekdayIndex = (iso: string) => new Date(`${iso}T00:00:00`).getDay();

/** 週ごとに区切る。先頭の空白は開始日の曜日ぶん。 */
function toWeeks(days: string[]): Array<Array<string | null>> {
  const cells: Array<string | null> = [
    ...Array<null>(weekdayIndex(days[0])).fill(null),
    ...days,
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  return Array.from({ length: cells.length / 7 }, (_, week) =>
    cells.slice(week * 7, week * 7 + 7),
  );
}

export function PilotCalendar() {
  const today = usePilotToday();
  const days = pilotDays();
  const weeks = toWeeks(days);
  const progress = today ? pilotProgress(today) : null;

  const headline =
    progress === null
      ? " " // ハイドレーション前。数字だけ後から入る
      : progress.phase === "before"
        ? "まもなく開始"
        : progress.phase === "after"
          ? "終了しました"
          : `あと${progress.remaining}日`;

  return (
    <section className="bl-card">
      <div className="bl-card-head">
        <Icon name="calendar_month" size={21} />
        <h2 className="bl-h2">試験導入期間</h2>
      </div>

      <div className={styles.summary}>
        <div>
          <p className="bl-eyebrow">残り</p>
          <p className={`bl-num ${styles.remaining}`} aria-live="polite">
            {headline}
          </p>
        </div>
        <p className="bl-meta">
          {formatDate(PILOT_START, false)} 〜 {formatDate(PILOT_END, false)}
          <br />
          全{PILOT_DAYS}日間
          {progress && progress.phase === "during" && `・${progress.elapsed}日目`}
        </p>
      </div>

      <div
        className="bl-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={PILOT_DAYS}
        aria-valuenow={progress?.elapsed ?? 0}
        aria-label="試験導入期間の進み具合"
      >
        <span style={{ width: `${((progress?.elapsed ?? 0) / PILOT_DAYS) * 100}%` }} />
      </div>

      <table className={styles.calendar}>
        <caption className="bl-sr">
          {formatDate(PILOT_START, false)}から{formatDate(PILOT_END, false)}までの試験導入カレンダー
        </caption>
        <thead>
          <tr>
            {WEEKDAY_LABELS.map((label) => (
              <th key={label} scope="col" className={styles.weekday}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, index) => (
            <tr key={index}>
              {week.map((iso, cell) => {
                if (!iso) return <td key={cell} className={styles.blank} />;

                const isToday = iso === today;
                const state =
                  today === null ? "unknown" : iso < today ? "past" : isToday ? "today" : "future";

                return (
                  <td key={cell} className={styles.cell}>
                    <span
                      className={styles.day}
                      data-state={state}
                      aria-current={isToday ? "date" : undefined}
                    >
                      <span aria-hidden="true">{Number(iso.slice(8, 10))}</span>
                      <span className="bl-sr">
                        {formatDate(iso)}
                        {isToday ? "・今日" : state === "past" ? "・終了" : ""}
                      </span>
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <p className="bl-micro">
        期間が終わっても、記録した日記がすぐに消えることはありません。今後の扱いは学校からお知らせします。
      </p>
    </section>
  );
}
