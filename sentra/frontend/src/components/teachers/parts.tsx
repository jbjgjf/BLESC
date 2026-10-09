"use client";

/**
 * Blesc for Teachers の画面で共通に使う部品。
 *
 * 気分は5つの顔のアイコンで見せ、点数にはしない（デザイン原則）。
 * 判定や段階を描く部品は置かない。
 */

import type { ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { CATEGORY_BY_VALUE, MOOD_BY_VALUE, formatDate, relativeDays } from "@/lib/blesc/labels";
import type { Mood } from "@/lib/blesc/types";
import { AS_OF, WORK_TAGS } from "@/lib/teachers/fixtures";
import { schoolDaysUntil } from "@/lib/teachers/records";
import { usePersona } from "@/lib/teachers/store";
import type { Access, SelfRecord } from "@/lib/teachers/types";
import styles from "./teachers.module.css";

export { styles };

const WORK_LABEL = Object.fromEntries(WORK_TAGS.map((t) => [t.value, t.label])) as Record<string, string>;

/** 生徒のタグも先生のタグも、日本語の名前にする。 */
export function tagLabel(tag: string): string {
  return WORK_LABEL[tag] ?? (CATEGORY_BY_VALUE as Record<string, { label: string } | undefined>)[tag]?.label ?? tag;
}

export function PageHead({ kicker, title, children }: { kicker?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <header className={styles.head}>
      {kicker && <p className={styles.kicker}>{kicker}</p>}
      <h1 className={styles.title}>{title}</h1>
      {children}
    </header>
  );
}

/* ── 気分 ─────────────────────────────────────────── */

/** 気分の顔。色はその気分の色（生徒の画面と同じ）。 */
export function MoodMark({ mood, size = 20, label = true }: { mood: Mood; size?: number; label?: boolean }) {
  const info = MOOD_BY_VALUE[mood];
  return (
    <span className={styles.moodMark} style={{ color: info.color }} title={info.label} aria-label={label ? info.label : undefined} role={label ? "img" : undefined}>
      <Icon name={info.icon} size={size} fill weight={500} />
    </span>
  );
}

export function MoodWithLabel({ mood }: { mood: Mood }) {
  return (
    <span className={styles.row} style={{ gap: 6 }}>
      <MoodMark mood={mood} size={22} label={false} />
      {MOOD_BY_VALUE[mood].label}
    </span>
  );
}

/** 記録のない日の印。気分の印と同じ大きさの、点線の丸。 */
function Empty({ size }: { size: number }) {
  return <span className={styles.moodEmpty} style={{ width: size - 6, height: size - 6, margin: 3 }} aria-hidden="true" />;
}

/**
 * 直近の登校日ぶんの気分の並び（一覧は7日、変化の行は14日）。
 * 記録のない日は点線の丸。土日は帰りのHRが無いので並べない。
 */
export function MoodStrip({ records, days, size = 18, name }: { records: ReadonlyArray<SelfRecord>; days: number; size?: number; name: string }) {
  const byDate = new Map(records.map((r) => [r.date, r.mood]));
  const dates = schoolDaysUntil(AS_OF, days);
  const spoken = dates.map((d) => (byDate.has(d) ? MOOD_BY_VALUE[byDate.get(d) as Mood].label : "記録なし")).join("、");
  return (
    <span className={styles.strip} role="img" aria-label={`${name}の直近${days}日の気分：${spoken}`}>
      {dates.map((date) => {
        const mood = byDate.get(date);
        return mood ? (
          <span key={date} title={`${formatDate(date)}・${MOOD_BY_VALUE[mood].label}`}>
            <MoodMark mood={mood} size={size} label={false} />
          </span>
        ) : (
          <span key={date} title={`${formatDate(date)}・記録なし`}>
            <Empty size={size} />
          </span>
        );
      })}
    </span>
  );
}

/** 「最後に記録した日」。折り返すときは日付と「（○日前）」の間でだけ折る。 */
export function LastRecord({ date }: { date: string | null }) {
  if (!date) return <span className={styles.muted}>記録なし</span>;
  return (
    <>
      <span className={styles.nowrap}>{formatDate(date, false)}</span>
      <span className={`${styles.nowrap} ${styles.muted}`}>（{date === AS_OF ? "今日" : relativeDays(date, AS_OF)}）</span>
    </>
  );
}

/* ── 記録の1件 ───────────────────────────────────── */

export function RecordItem({ record, target = false }: { record: SelfRecord; target?: boolean }) {
  return (
    <li id={`rec-${record.date}`} className={styles.record} data-target={target ? "true" : undefined}>
      <span className={styles.recordDate}>
        {formatDate(record.date)}
        <br />
        <span className={styles.small}>{record.time}</span>
      </span>
      <div className={styles.recordBody}>
        <div className={styles.recordMeta}>
          <MoodWithLabel mood={record.mood} />
          {record.tags.map((tag) => (
            <span key={tag} className={styles.tag}>
              #{tagLabel(tag)}
            </span>
          ))}
        </div>
        {record.question && record.text && <p className={styles.recordQuestion}>質問「{record.question}」に答えて</p>}
        {record.text ? <p className={styles.recordText}>{record.text}</p> : <p className={styles.note}>（気分だけの記録）</p>}
      </div>
    </li>
  );
}

/* ── 閲覧者の表示（書く画面に常に出す） ─────────────── */

export function ReadersLine({ readers }: { readers: Array<{ name: string; title: string }> }) {
  return (
    <p className={styles.readers} data-bl-term="この記録を読めるのは">
      この記録を読めるのは：
      {readers.length === 0 ? (
        <strong>あなただけ</strong>
      ) : (
        readers.map((reader, i) => (
          <span key={reader.name}>
            {i > 0 && "、"}
            <strong>{reader.name}</strong>（{reader.title}）
          </span>
        ))
      )}
    </p>
  );
}

/* ── 見る権限 ─────────────────────────────────────── */

/** 権限のないページ（8-4）。存在するかどうかも教えない。 */
export function Forbidden() {
  return (
    <div className={styles.page}>
      <PageHead title="このページは表示できません" />
    </div>
  );
}

export function AccessGate({ need, children }: { need: keyof Access; children: ReactNode }) {
  const persona = usePersona();
  return persona.access[need] ? <>{children}</> : <Forbidden />;
}

/* ── 書き出せない画面（先生の記録） ──────────────── */

/**
 * 先生の記録・要約・面談メモ。印刷しようとしても、紙には中身ではなく
 * この理由だけが出る。人事評価・勤務評定に使わない、という約束のため。
 */
export function NoExport({ children }: { children: ReactNode }) {
  return (
    <>
      <div className={styles.printable}>{children}</div>
      <div className={styles.printBlocked}>
        この画面の内容は印刷できません。先生の記録は、人事評価・勤務評定に使われないよう、印刷・書き出しをしない決まりになっています。
      </div>
    </>
  );
}
