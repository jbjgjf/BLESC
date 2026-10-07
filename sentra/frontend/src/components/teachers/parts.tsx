"use client";

/**
 * Blesc for Teachers の画面で共通に使う部品。
 *
 * どれも、記録をそのまま見せるためのもの。判定や段階を描く部品は無い。
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { CATEGORY_BY_VALUE, MOOD_BY_VALUE, formatDate } from "@/lib/blesc/labels";
import type { EventCategory, Mood } from "@/lib/blesc/types";
import { AS_OF, PERSONAS, WORK_TAGS } from "@/lib/teachers/fixtures";
import { MOOD_LEVEL, type ChangeResult, type ChangeSignal } from "@/lib/teachers/records";
import { ROLE_HOME, setTeacherRole, useTeacherRole } from "@/lib/teachers/store";
import type { SelfRecord, TeacherRole, WorkTag } from "@/lib/teachers/types";
import styles from "./teachers.module.css";

export { styles };

const WORK_LABEL = Object.fromEntries(WORK_TAGS.map((t) => [t.value, t.label])) as Record<WorkTag, string>;

/** 生徒の話題・先生の業務、どちらのタグも日本語の名前にする。 */
export function tagLabel(tag: string): string {
  return (CATEGORY_BY_VALUE as Record<string, { label: string } | undefined>)[tag]?.label ?? WORK_LABEL[tag as WorkTag] ?? tag;
}

export function PageHead({ kicker, title, lede, children }: { kicker?: string; title: string; lede?: ReactNode; children?: ReactNode }) {
  return (
    <header className={styles.head}>
      {kicker && <p className={styles.kicker}>{kicker}</p>}
      <h1 className={styles.title}>{title}</h1>
      {lede && <p className={styles.lede}>{lede}</p>}
      {children}
    </header>
  );
}

/* ── 気分の小さい推移（一覧の1行に） ─────────────── */

const DAY = 86_400_000;

/** 直近8週の、週ごとの気分の平均。記録が無い週は抜ける。 */
export function weeklyMoods(records: ReadonlyArray<SelfRecord>, asOf = AS_OF): Array<number | null> {
  const end = Date.parse(`${asOf}T00:00:00Z`);
  return Array.from({ length: 8 }, (_, i) => {
    const hi = end - (7 - i) * 7 * DAY;
    const lo = hi - 7 * DAY;
    const week = records.filter((r) => {
      const t = Date.parse(`${r.date}T00:00:00Z`);
      return t > lo && t <= hi;
    });
    return week.length === 0 ? null : week.reduce((sum, r) => sum + MOOD_LEVEL[r.mood], 0) / week.length;
  });
}

export function Sparkline({ records, label }: { records: ReadonlyArray<SelfRecord>; label: string }) {
  const weeks = weeklyMoods(records);
  const width = 104;
  const height = 26;
  const x = (i: number) => 4 + (i * (width - 8)) / 7;
  const y = (level: number) => 3 + ((5 - level) / 4) * (height - 6);
  const points = weeks.flatMap((level, i) => (level === null ? [] : [{ x: x(i), y: y(level) }]));
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const last = points.at(-1);

  return (
    <svg width={width} height={height} className={styles.spark} role="img" aria-label={`${label}の気分の推移（直近8週）`}>
      {points.length > 1 && <path d={path} className={styles.sparkLine} />}
      {last && <circle cx={last.x} cy={last.y} r={2.4} className={styles.sparkDot} />}
    </svg>
  );
}

/* ── 「変化あり」 ───────────────────────────────── */

/** 一覧に出す札。変化があるときだけ出し、無いときは何も出さない。 */
export function ChangeMark({ result }: { result: ChangeResult }) {
  if (result.status !== "changed") return null;
  return <span className={styles.changed}>変化あり</span>;
}

const SIGNAL_NAME: Record<ChangeSignal["kind"], string> = {
  mood: "気分の平均（5段階）",
  frequency: "記録した日数",
  length: "1件あたりの文字数",
  tags: "よく選ぶタグ（上位3つ）",
};

function signalValue(signal: ChangeSignal): string {
  switch (signal.kind) {
    case "mood":
      return `${signal.before.toFixed(1)} → ${signal.after.toFixed(1)}`;
    case "frequency":
      return `${signal.before}日 → ${signal.after}日`;
    case "length":
      return `${signal.before}字 → ${signal.after}字`;
    case "tags":
      return `${signal.before.map(tagLabel).join("・")} → ${signal.after.map(tagLabel).join("・")}`;
  }
}

/**
 * なぜ「変化あり」なのか。どの数字がどう動いたかを、そのまま見せる。
 * 理由が見えない札は、中身の分からない警告と変わらない。
 */
export function ChangeFacts({ result }: { result: ChangeResult }) {
  if (result.status === "insufficient") {
    return (
      <p className={styles.note}>
        前の4週の記録が{result.previous}件で、比べる元が足りないため、変化は判定していません。
      </p>
    );
  }
  if (result.status === "steady") {
    return (
      <p className={styles.note}>
        直近4週（{result.recent}件）とその前の4週（{result.previous}件）で、決めてある数値を超える変化はありません。
      </p>
    );
  }
  return (
    <div className="bl-stack" style={{ gap: 10 }}>
      <dl className={styles.facts}>
        {result.signals.map((signal) => (
          <div key={signal.kind} style={{ display: "contents" }}>
            <dt>{SIGNAL_NAME[signal.kind]}</dt>
            <dd>{signalValue(signal)}</dd>
          </div>
        ))}
      </dl>
      <p className={styles.note}>
        前の4週 → 直近4週。本人が書いた・選んだものの推移だけを比べています。良し悪しや重さは判定していません。
      </p>
    </div>
  );
}

/** 「変化あり」の決め方。一覧の上に、いつでも読めるように置く。 */
export function ChangeRuleNote() {
  return (
    <details className={styles.note}>
      <summary style={{ cursor: "pointer" }}>「変化あり」の決め方</summary>
      <p className={styles.note} style={{ marginTop: 6 }}>
        直近4週とその前の4週を比べ、次のどれかに当てはまるときに付きます。気分の平均が1段階以上動いた／記録した日数が半分以下か1.5倍以上になり、差が3日以上ある／1件あたりの文字数が半分以下か1.5倍以上になり、差が40字以上ある／よく選ぶタグの上位3つのうち2つ以上が入れ替わった。前の4週の記録が4件未満のときは判定しません。上がる向きの変化にも同じ札が付きます。
      </p>
    </details>
  );
}

/* ── 閲覧者の表示（A-5） ───────────────────────── */

export function ReadersLine({ readers, subject = "この記録" }: { readers: Array<{ name: string; title: string }>; subject?: string }) {
  return (
    <p className={styles.readers} data-bl-term="記録を読める人">
      <span>{subject}を読める人：</span>
      {readers.length === 0 ? (
        <strong>あなただけ</strong>
      ) : (
        readers.map((reader) => (
          <strong key={reader.name}>
            {reader.name}（{reader.title}）
          </strong>
        ))
      )}
    </p>
  );
}

/* ── 記録の並び ───────────────────────────────── */

export function MoodLabel({ mood }: { mood: Mood }) {
  const info = MOOD_BY_VALUE[mood];
  return (
    <span>
      <span className={styles.moodDot} style={{ background: info.color }} aria-hidden="true" />
      {info.label}
    </span>
  );
}

export function RecordList({ records, empty = "この期間の記録はありません。" }: { records: ReadonlyArray<SelfRecord>; empty?: string }) {
  if (records.length === 0) return <p className={styles.note}>{empty}</p>;
  return (
    <ol className={styles.records}>
      {records.map((record) => (
        <li key={record.date} className={styles.record}>
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
            {record.text ? <p className={styles.recordText}>{record.text}</p> : <p className={styles.note}>（気分だけの記録）</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ── タグの推移（週ごと、8週） ─────────────────── */

export function TagTrend({ records, tags }: { records: ReadonlyArray<SelfRecord>; tags: readonly string[] }) {
  const end = Date.parse(`${AS_OF}T00:00:00Z`);
  const weeks = Array.from({ length: 8 }, (_, i) => {
    const hi = end - (7 - i) * 7 * DAY;
    return records.filter((r) => {
      const t = Date.parse(`${r.date}T00:00:00Z`);
      return t > hi - 7 * DAY && t <= hi;
    });
  });
  const max = Math.max(1, ...tags.flatMap((tag) => weeks.map((week) => week.filter((r) => r.tags.includes(tag)).length)));

  return (
    <div className={styles.trend} role="table" aria-label="タグの推移（週ごと、直近8週）">
      <div className={styles.trendRow} role="row">
        <span role="columnheader" />
        {weeks.map((_, i) => (
          <span key={i} role="columnheader" style={{ textAlign: "center" }}>
            {i === 7 ? "今週" : `${7 - i}週前`}
          </span>
        ))}
      </div>
      {tags.map((tag) => (
        <div key={tag} className={styles.trendRow} role="row">
          <span role="rowheader">{tagLabel(tag)}</span>
          {weeks.map((week, i) => {
            const count = week.filter((r) => r.tags.includes(tag)).length;
            return (
              <span
                key={i}
                role="cell"
                className={styles.trendCell}
                title={`${count}回`}
                aria-label={`${count}回`}
                style={{ background: count === 0 ? undefined : `hsl(206 40% ${92 - (count / max) * 42}%)` }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ── 書き出せない画面（C-5） ───────────────────── */

/**
 * 先生の記録・サマリー・メモの画面。CSV・印刷・一括ダウンロードを置かない。
 * 印刷しようとしても、紙には中身ではなくこの理由だけが出る。人事評価に
 * 流用されないための制限で、学校の設定でも外せない。
 */
export function NoExport({ children }: { children: ReactNode }) {
  return (
    <>
      <div className={styles.printable}>{children}</div>
      <div className={styles.printBlocked}>
        この画面の内容は印刷できません。先生の記録・サマリー・面談メモは、人事評価に使われないよう、印刷・CSV出力・一括ダウンロードをしない決まりになっています。
      </div>
    </>
  );
}

export function NoExportNote() {
  return (
    <p className={styles.noExport} data-bl-term="印刷・書き出し">
      先生の記録・サマリー・面談メモは、印刷・CSV出力・一括ダウンロードができません。人事評価に使われないための決まりで、学校の設定でも変えられません。
    </p>
  );
}

/* ── 立場ごとの入口 ───────────────────────────── */

const ROLE_NAME: Record<TeacherRole, string> = { homeroom: "担任", manager: "管理職", admin: "学校管理者" };

/** この画面を開ける立場でなければ、理由だけを出す。デモでは立場を切り替えられる。 */
export function RoleGate({ allow, children }: { allow: TeacherRole[]; children: ReactNode }) {
  const role = useTeacherRole();
  if (allow.includes(role)) return <>{children}</>;
  const needed = allow.map((r) => ROLE_NAME[r]).join("・");
  return (
    <div className={styles.page}>
      <PageHead title="この画面は開けません" lede={`この画面を開けるのは、${needed}の立場の人だけです。いまは${ROLE_NAME[role]}（${PERSONAS[role].name}）として見ています。`} />
      <div className={styles.saveRow}>
        {allow.map((r) => (
          <button key={r} type="button" className="bl-btn bl-btn--secondary" onClick={() => setTeacherRole(r)}>
            {ROLE_NAME[r]}として見る（デモ）
          </button>
        ))}
        <Link href={ROLE_HOME[role]} className={styles.linkButton}>
          戻る
        </Link>
      </div>
    </div>
  );
}

export { ROLE_NAME };
export type { EventCategory };
