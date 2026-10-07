"use client";

/**
 * 自分の記録の振り返り（A-4）。
 *
 * カレンダーと一覧の2つの見方と、気分の推移のグラフ。過去の記録は読むだけで、
 * 書き直した記録には、いつ書き直したかを並べて出す。
 */

import { useMemo, useState, useSyncExternalStore } from "react";
import { MoodTrend } from "@/components/blesc/MoodTrend";
import { MOOD_BY_VALUE, formatDate } from "@/lib/blesc/labels";
import { AS_OF, MY_RECORDS, PROMPTS, readersOfTeacherRecords } from "@/lib/teachers/fixtures";
import { useSchoolSettings } from "@/lib/teachers/store";
import type { TeacherRecord } from "@/lib/teachers/types";
import { MoodLabel, PageHead, ReadersLine, RoleGate, styles, tagLabel } from "@/components/teachers/parts";

const SAVED_KEY = `blesc:my-record:${AS_OF}`;
const subscribe = (notify: () => void) => {
  window.addEventListener("blesc:my-record", notify);
  return () => window.removeEventListener("blesc:my-record", notify);
};
let raw: string | null | undefined;
let today: TeacherRecord | null = null;
const readToday = () => {
  let next: string | null = null;
  try {
    next = window.sessionStorage.getItem(SAVED_KEY);
  } catch {
    next = null;
  }
  if (next === raw) return today;
  raw = next;
  try {
    today = next ? (JSON.parse(next) as TeacherRecord) : null;
  } catch {
    today = null;
  }
  return today;
};

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

function monthGrid(year: number, month: number) {
  const first = new Date(Date.UTC(year, month, 1));
  const start = new Date(first.getTime() - first.getUTCDay() * 86_400_000);
  return Array.from({ length: 42 }, (_, i) => {
    const date = new Date(start.getTime() + i * 86_400_000);
    return { iso: date.toISOString().slice(0, 10), day: date.getUTCDate(), inMonth: date.getUTCMonth() === month };
  });
}

export default function MyRecordsPage() {
  return (
    <RoleGate allow={["homeroom", "manager"]}>
      <MyRecords />
    </RoleGate>
  );
}

function MyRecords() {
  const settings = useSchoolSettings();
  const saved = useSyncExternalStore(subscribe, readToday, () => null);
  const records = useMemo(
    () => [...MY_RECORDS, ...(saved ? [saved] : [])].sort((a, b) => b.date.localeCompare(a.date)),
    [saved],
  );
  const byDate = useMemo(() => new Map(records.map((r) => [r.date, r])), [records]);

  const [view, setView] = useState<"calendar" | "list">("calendar");
  const [month, setMonth] = useState(() => ({ year: Number(AS_OF.slice(0, 4)), month: Number(AS_OF.slice(5, 7)) - 1 }));
  const [selected, setSelected] = useState<string | null>(records[0]?.date ?? null);
  const picked = selected ? byDate.get(selected) ?? null : null;

  const series = [...records].reverse().filter((r) => r.date > "2026-06-12").map(({ date, mood }) => ({ date, mood }));

  return (
    <div className={styles.page}>
      <PageHead kicker="先生自身の記録" title="振り返り" lede="過去の記録は読むだけになっています。書き直した日は、その履歴も見られます。">
        <ReadersLine readers={readersOfTeacherRecords(settings)} subject="これらの記録" />
      </PageHead>

      <section className={styles.section}>
        <h2 className={styles.h2}>気分の推移（直近8週）</h2>
        <MoodTrend series={series} />
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.h2}>記録</h2>
          <span className={styles.spacer} />
          <div className={styles.segmented} role="tablist" aria-label="見方">
            <button type="button" role="tab" aria-selected={view === "calendar"} onClick={() => setView("calendar")}>
              カレンダー
            </button>
            <button type="button" role="tab" aria-selected={view === "list"} onClick={() => setView("list")}>
              一覧
            </button>
          </div>
        </div>

        {view === "calendar" ? (
          <>
            <div className={styles.saveRow}>
              <button type="button" className={styles.linkButton} onClick={() => setMonth((m) => (m.month === 0 ? { year: m.year - 1, month: 11 } : { ...m, month: m.month - 1 }))}>
                前の月
              </button>
              <strong style={{ fontWeight: 500 }}>
                {month.year}年{month.month + 1}月
              </strong>
              <button
                type="button"
                className={styles.linkButton}
                disabled={month.year === Number(AS_OF.slice(0, 4)) && month.month === Number(AS_OF.slice(5, 7)) - 1}
                onClick={() => setMonth((m) => (m.month === 11 ? { year: m.year + 1, month: 0 } : { ...m, month: m.month + 1 }))}
              >
                次の月
              </button>
            </div>
            <div className={styles.calendar}>
              {WEEK.map((w) => (
                <span key={w} className={styles.calendarHead}>
                  {w}
                </span>
              ))}
              {monthGrid(month.year, month.month).map((cell) => {
                const record = byDate.get(cell.iso);
                return (
                  <button
                    key={cell.iso}
                    type="button"
                    className={styles.calendarDay}
                    data-has={record ? "" : undefined}
                    data-outside={cell.inMonth ? undefined : ""}
                    data-selected={selected === cell.iso ? "" : undefined}
                    disabled={!record}
                    onClick={() => setSelected(cell.iso)}
                    aria-label={record ? `${formatDate(cell.iso)}・${MOOD_BY_VALUE[record.mood].label}` : `${formatDate(cell.iso)}・記録なし`}
                  >
                    {cell.day}
                    {record && <span className={styles.calendarMood} style={{ background: MOOD_BY_VALUE[record.mood].color }} />}
                  </button>
                );
              })}
            </div>
            {picked && <RecordDetail record={picked} />}
          </>
        ) : (
          <ol className={styles.records}>
            {records.map((record) => (
              <li key={record.date}>
                <RecordDetail record={record} />
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function RecordDetail({ record }: { record: TeacherRecord }) {
  const prompt = record.promptId ? PROMPTS.find((p) => p.id === record.promptId) : null;
  return (
    <article className={styles.record}>
      <span className={styles.recordDate}>{formatDate(record.date)}</span>
      <div className={styles.recordBody}>
        <div className={styles.recordMeta}>
          <MoodLabel mood={record.mood} />
          {record.tags.map((tag) => (
            <span key={tag} className={styles.tag}>
              #{tagLabel(tag)}
            </span>
          ))}
        </div>
        {prompt && <p className={styles.note}>質問「{prompt.text}」への回答</p>}
        {record.text ? <p className={styles.recordText}>{record.text}</p> : <p className={styles.note}>（気分だけの記録）</p>}
        <p className={styles.note}>
          {record.edits.length > 1
            ? `保存 ${record.edits[0]} → 書き直し ${record.edits.slice(1).join("・")}`
            : `保存 ${record.edits[0]}`}
          {record.date === AS_OF ? "（今日のうちは書き直せます）" : "（読むだけ）"}
        </p>
      </div>
    </article>
  );
}
