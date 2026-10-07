"use client";

/**
 * クラス一覧（B-1）と、記録の検索・絞り込み（B-5）。
 *
 * 並びの既定は出席番号順。「危険度順」は作らない — 並べ替えの選択肢にも置か
 * ない。一覧に出すのは、直近の記録日・気分の小さい推移・「変化あり」の札だけ。
 * 札は本人の自己申告の推移から決まり（lib/teachers/records.ts）、重さの段階は
 * 持たない。
 *
 * 検索は担当クラスの記録の中だけ。全文検索もこの範囲を出ない。
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { CATEGORIES, MOODS, formatDate } from "@/lib/blesc/labels";
import type { EventCategory, Mood } from "@/lib/blesc/types";
import { AS_OF, CLASS_NAME, CLASS_STUDENTS, readersOfStudentRecords } from "@/lib/teachers/fixtures";
import { compareRecentWindows } from "@/lib/teachers/records";
import { useSchoolSettings } from "@/lib/teachers/store";
import {
  ChangeMark,
  ChangeRuleNote,
  LastRecord,
  MoodLabel,
  PageHead,
  ReadersLine,
  RoleGate,
  Sparkline,
  styles,
  tagLabel,
} from "@/components/teachers/parts";

type Sort = "number" | "recent";

export default function ClassPage() {
  return (
    <RoleGate allow={["homeroom"]}>
      <ClassView />
    </RoleGate>
  );
}

function ClassView() {
  const settings = useSchoolSettings();
  const [tab, setTab] = useState<"list" | "search">("list");

  return (
    <div className={styles.page}>
      <PageHead kicker="生徒の記録" title={`${CLASS_NAME}（${CLASS_STUDENTS.length}名）`}>
        <ReadersLine readers={readersOfStudentRecords(settings)} subject="このクラスの記録" />
      </PageHead>

      <div className={styles.segmented} role="tablist" aria-label="表示">
        <button type="button" role="tab" aria-selected={tab === "list"} onClick={() => setTab("list")}>
          一覧
        </button>
        <button type="button" role="tab" aria-selected={tab === "search"} onClick={() => setTab("search")} data-bl-term="記録を探す">
          記録を探す
        </button>
      </div>

      {tab === "list" ? <ClassList /> : <RecordSearch />}
    </div>
  );
}

function ClassList() {
  const [sort, setSort] = useState<Sort>("number");
  const rows = useMemo(() => {
    const withData = CLASS_STUDENTS.map((student) => ({
      student,
      last: student.records.at(-1)?.date ?? null,
      change: compareRecentWindows(student.records, AS_OF),
    }));
    return sort === "number"
      ? withData
      : [...withData].sort((a, b) => (b.last ?? "").localeCompare(a.last ?? "") || a.student.number - b.student.number);
  }, [sort]);

  return (
    <section className={styles.section} style={{ borderTop: 0, paddingTop: 0 }}>
      <div className={styles.sectionHead}>
        <ChangeRuleNote />
        <span className={styles.spacer} />
        <label className={styles.note} data-bl-term="並び">
          並び{" "}
          <select className={styles.input} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="number">出席番号順</option>
            <option value="recent">直近の記録日が新しい順</option>
          </select>
        </label>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">番号</th>
              <th scope="col">名前</th>
              <th scope="col">直近の記録</th>
              <th scope="col">気分（8週）</th>
              <th scope="col">変化</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ student, last, change }) => (
              <tr key={student.id}>
                <td className={styles.num}>{student.number}</td>
                <td>
                  <Link href={`/educator/student/${student.id}`} className={styles.rowLink}>
                    {student.name}
                  </Link>
                </td>
                <td className={styles.muted}><LastRecord date={last} /></td>
                <td>
                  <Sparkline records={student.records} label={student.name} />
                </td>
                <td>
                  <ChangeMark result={change} />
                  {change.status === "insufficient" && <span className={styles.muted}>判定なし</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const PERIODS = [
  { days: 7, label: "直近1週" },
  { days: 28, label: "直近4週" },
  { days: 56, label: "直近8週" },
] as const;

const DAY = 86_400_000;
const since = (days: number) => new Date(Date.parse(`${AS_OF}T00:00:00Z`) - (days - 1) * DAY).toISOString().slice(0, 10);

function RecordSearch() {
  const [days, setDays] = useState<number>(28);
  const [moods, setMoods] = useState<Mood[]>([]);
  const [tags, setTags] = useState<EventCategory[]>([]);
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const from = since(days);
    const words = query.trim().split(/\s+/).filter(Boolean);
    return CLASS_STUDENTS.flatMap((student) =>
      student.records
        .filter(
          (r) =>
            r.date >= from &&
            (moods.length === 0 || moods.includes(r.mood)) &&
            (tags.length === 0 || r.tags.some((t) => tags.includes(t))) &&
            words.every((w) => r.text.includes(w)),
        )
        .map((record) => ({ student, record })),
    ).sort((a, b) => b.record.date.localeCompare(a.record.date) || a.student.number - b.student.number);
  }, [days, moods, tags, query]);

  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  return (
    <section className={styles.section} style={{ borderTop: 0, paddingTop: 0 }}>
      <p className={styles.note}>探せるのは、担当している{CLASS_NAME}の記録だけです。</p>

      <div className="bl-stack" style={{ gap: 14 }}>
        <div className={styles.segmented} role="group" aria-label="期間">
          {PERIODS.map((p) => (
            <button key={p.days} type="button" aria-pressed={days === p.days} onClick={() => setDays(p.days)}>
              {p.label}
            </button>
          ))}
        </div>

        <fieldset className={styles.checks} style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className={styles.fieldLabel} style={{ marginBottom: 6 }}>
            気分
          </legend>
          {MOODS.map((mood) => (
            <label key={mood.value}>
              <input type="checkbox" checked={moods.includes(mood.value)} onChange={() => setMoods((m) => toggle(m, mood.value))} />
              {mood.label}
            </label>
          ))}
        </fieldset>

        <div className="bl-stack" style={{ gap: 6 }}>
          <span className={styles.fieldLabel}>話題</span>
          <div className={styles.tagRow}>
            {CATEGORIES.map((c) => (
              <button key={c.value} type="button" className={styles.tagOption} aria-pressed={tags.includes(c.value)} onClick={() => setTags((t) => toggle(t, c.value))}>
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <label className="bl-stack" style={{ gap: 6, maxWidth: 420 }}>
          <span className={styles.fieldLabel}>本文に含む言葉</span>
          <input className={styles.input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="例：部活" />
        </label>
      </div>

      <p className={styles.note} aria-live="polite">
        {results.length}件
      </p>

      <ol className={styles.records}>
        {results.slice(0, 80).map(({ student, record }) => (
          <li key={`${student.id}-${record.date}`} className={styles.record}>
            <span className={styles.recordDate}>{formatDate(record.date, false)}</span>
            <div className={styles.recordBody}>
              <div className={styles.recordMeta}>
                <Link href={`/educator/student/${student.id}`} className={styles.rowLink}>
                  {student.number} {student.name}
                </Link>
                <MoodLabel mood={record.mood} />
                {record.tags.map((t) => (
                  <span key={t} className={styles.tag}>
                    #{tagLabel(t)}
                  </span>
                ))}
              </div>
              {record.text ? <p className={styles.recordText}>{record.text}</p> : <p className={styles.note}>（気分だけの記録）</p>}
            </div>
          </li>
        ))}
      </ol>
      {results.length > 80 && <p className={styles.note}>新しい80件まで表示しています。条件を足すと絞りこめます。</p>}
    </section>
  );
}
