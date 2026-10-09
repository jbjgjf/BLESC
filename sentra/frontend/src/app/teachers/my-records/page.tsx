"use client";

/**
 * 自分の記録・これまで（UI仕様書 4-3 / 3-2）。
 *
 * 月のカレンダーに、記録した日の気分の顔が入る。日を選ぶと、その日の記録
 * （気分・タグ・本文・答えた質問）が下に出る。この画面は本人だけのもので、
 * 管理職が読んだかどうかは出さない。
 */

import { useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { formatDate } from "@/lib/blesc/labels";
import { AS_OF, staffById } from "@/lib/teachers/fixtures";
import { usePersona, useWrittenRecords } from "@/lib/teachers/store";
import type { Persona, TeacherRecord } from "@/lib/teachers/types";
import { AccessGate, MoodMark, RecordItem, styles } from "@/components/teachers/parts";
import { OwnTabs } from "@/components/teachers/OwnTabs";

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
const DAY = 86_400_000;

function monthGrid(year: number, month: number) {
  const first = new Date(Date.UTC(year, month, 1));
  const start = first.getTime() - first.getUTCDay() * DAY;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells = Math.ceil((first.getUTCDay() + last) / 7) * 7;
  return Array.from({ length: cells }, (_, i) => {
    const date = new Date(start + i * DAY);
    return { iso: date.toISOString().slice(0, 10), day: date.getUTCDate(), inMonth: date.getUTCMonth() === month };
  });
}

export default function HistoryPage() {
  return (
    <AccessGate need="write">
      <HistoryFor />
    </AccessGate>
  );
}

function HistoryFor() {
  const persona = usePersona();
  return <History key={persona.id} persona={persona} />;
}

function History({ persona }: { persona: Persona }) {
  const me = staffById(persona.staffId);
  const written = useWrittenRecords(persona.id);
  const byDate = useMemo(() => {
    const map = new Map<string, TeacherRecord>((me?.records ?? []).map((r) => [r.date, r]));
    for (const record of Object.values(written)) map.set(record.date, record);
    return map;
  }, [me, written]);

  const [month, setMonth] = useState({ year: Number(AS_OF.slice(0, 4)), month: Number(AS_OF.slice(5, 7)) - 1 });
  const latest = [...byDate.keys()].sort().at(-1) ?? null;
  const [selected, setSelected] = useState<string | null>(latest);
  const picked = selected ? (byDate.get(selected) ?? null) : null;
  const isCurrentMonth = month.year === Number(AS_OF.slice(0, 4)) && month.month === Number(AS_OF.slice(5, 7)) - 1;

  return (
    <div className={`${styles.page} ${styles.narrow}`}>
      <OwnTabs />

      <div className={styles.row}>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="前の月"
          onClick={() => setMonth((m) => (m.month === 0 ? { year: m.year - 1, month: 11 } : { ...m, month: m.month - 1 }))}
        >
          <Icon name="chevron_left" size={24} />
        </button>
        <h1 className={styles.h2} style={{ minWidth: "7em", textAlign: "center" }}>
          {month.year}年{month.month + 1}月
        </h1>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="次の月"
          disabled={isCurrentMonth}
          style={isCurrentMonth ? { opacity: 0.3 } : undefined}
          onClick={() => setMonth((m) => (m.month === 11 ? { year: m.year + 1, month: 0 } : { ...m, month: m.month + 1 }))}
        >
          <Icon name="chevron_right" size={24} />
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
              data-outside={cell.inMonth ? undefined : "true"}
              data-selected={selected === cell.iso ? "true" : undefined}
              data-today={cell.iso === AS_OF ? "true" : undefined}
              disabled={!record}
              onClick={() => setSelected(cell.iso)}
              aria-label={`${formatDate(cell.iso)}${record ? "" : "・記録なし"}`}
            >
              <span>{cell.day}</span>
              {record && <MoodMark mood={record.mood} size={22} label={false} />}
            </button>
          );
        })}
      </div>

      {picked ? (
        <ol className={styles.records}>
          <RecordItem record={picked} />
        </ol>
      ) : (
        <p className={styles.note}>記録した日を選ぶと、その日の記録が出ます。</p>
      )}
    </div>
  );
}
