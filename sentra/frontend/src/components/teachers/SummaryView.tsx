"use client";

/**
 * 面談前サマリー（B-3 / C-3）。
 *
 * 期間を選ぶと、よく出てくる話題・気分の推移・本人の記述の抜粋を出す。
 * ここまでは記録を数えて並べただけで、解釈は入らない。
 *
 * その下の「AIによる要約」は、本番では LLM が書く部分。デモでは LLM を
 * つながないので、同じ制約を満たす定型文で代わりに見せている（画面にも
 * そう書く）。どちらの場合も、出す前に summaryViolations() を通し、
 * 診断・推測・評価の言い回しがあるか、本人の言葉の引用が無ければ出さない。
 */

import { useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { MoodTrend } from "@/components/blesc/MoodTrend";
import { MOOD_BY_VALUE, formatDate } from "@/lib/blesc/labels";
import { AS_OF } from "@/lib/teachers/fixtures";
import { MOOD_LEVEL, buildSummary, summaryViolations, type Summary } from "@/lib/teachers/records";
import type { SelfRecord } from "@/lib/teachers/types";
import { styles, tagLabel } from "./parts";

const PERIODS = [
  { days: 30, label: "直近1か月" },
  { days: 56, label: "直近2か月" },
] as const;

const DAY = 86_400_000;
const daysBefore = (days: number) => new Date(Date.parse(`${AS_OF}T00:00:00Z`) - days * DAY).toISOString().slice(0, 10);

/** 文の最初のひと区切り。引用は本人の言葉の一部をそのまま使う。 */
const firstSentence = (text: string) => {
  const stop = text.indexOf("。");
  return stop > 0 ? text.slice(0, stop) : text;
};

/**
 * デモで「AIによる要約」の代わりに出す文。記録から組み立てるだけで、
 * 良い・悪いの言葉を持たない。本番の LLM の出力も、この形に収まっていなければ
 * 画面に出さない。
 */
function demoNarrative<Tag extends string>(summary: Summary<Tag>, records: ReadonlyArray<SelfRecord<Tag>>): string {
  const topics = summary.topics.slice(0, 2).map((t) => tagLabel(t.tag));
  const levels = summary.moods.map((m) => MOOD_LEVEL[m.mood]);
  const latest = [...records].filter((r) => r.date >= summary.from && r.date <= summary.to && r.text.trim()).sort((a, b) => b.date.localeCompare(a.date))[0];
  const parts = [];
  // 「」は本人の言葉の引用にだけ使う（検査が、記録にそのまま含まれるかを見る）。
  if (topics.length > 0) parts.push(`この期間は${topics.join("と")}のタグが付いた記録が多くありました。`);
  if (levels.length > 0) {
    const label = (level: number) => Object.values(MOOD_BY_VALUE).find((m) => MOOD_LEVEL[m.value] === level)?.label ?? "";
    const high = label(Math.max(...levels));
    const low = label(Math.min(...levels));
    parts.push(high === low ? `気分はいずれも${high}で記録されています。` : `気分は${high}〜${low}の範囲で記録されています。`);
  }
  if (latest) parts.push(`${formatDate(latest.date, false)}の記録には「${firstSentence(latest.text.trim())}」とあります。`);
  return parts.join("");
}

export function SummaryView<Tag extends string>({ records, subject }: { records: ReadonlyArray<SelfRecord<Tag>>; subject: string }) {
  const [days, setDays] = useState<number>(PERIODS[0].days);
  const summary = useMemo(() => buildSummary(records, { from: daysBefore(days - 1), to: AS_OF }), [records, days]);
  const narrative = useMemo(() => demoNarrative(summary, records), [summary, records]);
  const problems = useMemo(() => summaryViolations(narrative, records), [narrative, records]);

  return (
    <div className="bl-stack" style={{ gap: 18 }}>
      <div className={styles.segmented} role="group" aria-label="期間">
        {PERIODS.map((period) => (
          <button key={period.days} type="button" aria-pressed={days === period.days} onClick={() => setDays(period.days)}>
            {period.label}
          </button>
        ))}
      </div>

      {summary.moods.length === 0 ? (
        <p className={styles.note}>この期間に{subject}の記録はありません。</p>
      ) : (
        <>
          <div className="bl-stack" style={{ gap: 8 }}>
            <h3 className={styles.fieldLabel}>よく出てくる話題</h3>
            <dl className={styles.facts}>
              {summary.topics.map((topic) => (
                <div key={topic.tag} style={{ display: "contents" }}>
                  <dt>{tagLabel(topic.tag)}</dt>
                  <dd>{topic.count}回</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="bl-stack" style={{ gap: 8 }}>
            <h3 className={styles.fieldLabel}>気分の推移</h3>
            <MoodTrend series={summary.moods} />
          </div>

          <div className="bl-stack" style={{ gap: 10 }}>
            <h3 className={styles.fieldLabel}>本人の記述の抜粋</h3>
            {summary.excerpts.length === 0 ? (
              <p className={styles.note}>本文のある記録がありません（気分だけの記録です）。</p>
            ) : (
              summary.excerpts.map((excerpt) => (
                <blockquote key={excerpt.date} className={styles.quote}>
                  <span className={styles.quoteDate}>{formatDate(excerpt.date)}</span>
                  {excerpt.text}
                </blockquote>
              ))
            )}
          </div>

          <section className={styles.aiBlock} aria-label="AIによる要約" data-bl-term="AIによる要約">
            <span className={styles.aiLabel}>
              <Icon name="auto_awesome" size={15} />
              AIによる要約（デモでは定型文で代用しています）
            </span>
            {problems.length === 0 ? (
              <p className={styles.recordText}>{narrative}</p>
            ) : (
              <p className={styles.note}>
                要約に、出せない言い回しか、記録に無い引用が含まれていたため表示していません（{problems.length}件）。
              </p>
            )}
            <p className={styles.note}>
              要約は、診断・推測・評価の言い回しを使わず、本人の記述からの引用を必ず含めたものだけを表示します。判断の材料は、上の記録そのものです。
            </p>
          </section>
        </>
      )}
    </div>
  );
}
