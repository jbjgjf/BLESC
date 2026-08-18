"use client";

import Image from "next/image";
import { Icon } from "@/components/ui/Icon";
import { MoodTrend } from "@/components/blesc/MoodTrend";
import { GUARDIAN_VIEW } from "@/lib/blesc/fixtures";
import { TODAY, addDays, formatDate, relativeDays, weekdayOf } from "@/lib/blesc/labels";
import { MOOD_BY_VALUE } from "@/lib/blesc/labels";
import styles from "./guardian.module.css";

const WEEK = Array.from({ length: 7 }, (_, index) => addDays(TODAY, index - 6));

/**
 * 保護者向けダッシュボード。
 *
 * 表示するのは提出状況と、本人が共有に同意した範囲の情報のみ。日記の本文、
 * 対話型AIとのやりとり、AIの分析結果、リスクの判定はいずれも表示しない。
 */
export default function GuardianPage() {
  const view = GUARDIAN_VIEW;
  const moodByDate = new Map(view.sharedMoodSeries.map((item) => [item.date, item.mood]));

  return (
    <div className="bl-wrap bl-stack">
      <header className={styles.head}>
        <Image src="/flower.png" alt="" width={44} height={44} className={styles.flower} priority />
        <div>
          <h1 className="bl-h1">{view.studentName}さんの記録</h1>
          <p className="bl-meta">{view.className} ・ {formatDate(TODAY)}</p>
        </div>
      </header>

      {/* ── 開示範囲の明示 ───────────────────────────── */}
      <div className="bl-notice bl-rise">
        <Icon name="shield" size={19} />
        <span>{view.scopeNote}</span>
      </div>

      {/* ── 提出状況 ─────────────────────────────────── */}
      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="event_available" size={21} />
          <h2 className="bl-h2">日記の提出状況</h2>
        </div>

        <div className="bl-grid bl-grid--3">
          <div className={styles.stat}>
            <span className="bl-num">{view.stats.streak}</span>
            <span className="bl-meta">連続提出日数</span>
          </div>
          <div className={styles.stat}>
            <span className="bl-num">{view.stats.weekCount}</span>
            <span className="bl-meta">今週の提出</span>
          </div>
          <div className={styles.stat}>
            <span className="bl-num">{Math.round(view.stats.monthRate * 100)}%</span>
            <span className="bl-meta">今月の提出率</span>
          </div>
        </div>

        <div className={styles.week}>
          {WEEK.map((date) => {
            const mood = moodByDate.get(date);
            const submitted = view.stats.submittedDays.includes(date);
            return (
              <div key={date} className={styles.day} data-today={date === TODAY}>
                <span className={styles.dayWeekday}>{weekdayOf(date)}</span>
                <span
                  className={styles.dayDot}
                  data-filled={submitted}
                  style={mood ? { background: MOOD_BY_VALUE[mood].color, borderColor: MOOD_BY_VALUE[mood].color } : undefined}
                />
                <span className={styles.dayLabel}>{new Date(`${date}T00:00:00`).getDate()}</span>
              </div>
            );
          })}
        </div>

        <p className="bl-micro" style={{ marginTop: 14 }}>
          最終提出：{relativeDays(view.stats.lastSubmitted)}
        </p>
      </section>

      {/* ── 共有された気分の推移 ─────────────────────── */}
      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="mood" size={21} />
          <h2 className="bl-h2">気分の記録</h2>
          <span className="bl-chip bl-chip--tint">
            <Icon name="check" size={14} />
            本人が共有に同意
          </span>
        </div>

        <MoodTrend series={view.sharedMoodSeries} />

        <p className="bl-disclaimer" style={{ marginTop: 14 }}>
          <Icon name="medical_information" size={15} />
          これは本人が選んだ「その日の気分」の記録です。心理的な評価や診断ではありません。
        </p>
      </section>

      {/* ── 学校からのお知らせ ───────────────────────── */}
      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="campaign" size={21} />
          <h2 className="bl-h2">学校からのお知らせ</h2>
        </div>

        <div className="bl-stack-s">
          {view.notices.map((notice) => (
            <article key={notice.date} className={styles.notice}>
              <div className="bl-row" style={{ gap: 9, marginBottom: 4 }}>
                <span className="bl-h3">{notice.from}</span>
                <span className="bl-micro">{formatDate(notice.date, false)}</span>
              </div>
              <p className="bl-body" style={{ fontSize: "0.89rem" }}>{notice.text}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ── 表示されない情報 ─────────────────────────── */}
      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="lock" size={21} />
          <h2 className="bl-h2">表示していない情報</h2>
        </div>
        <p className="bl-body" style={{ marginBottom: 14 }}>
          お子さまが安心して記録を続けられるよう、次の情報は保護者の方には表示していません。
        </p>
        <ul className={styles.hidden}>
          {[
            "日記の本文",
            "対話型AIとのやりとりの内容",
            "AIによる分析結果や状態の判定",
            "学校内での支援の検討状況",
          ].map((item) => (
            <li key={item}>
              <Icon name="lock" size={16} />
              {item}
            </li>
          ))}
        </ul>
        <p className="bl-micro" style={{ marginTop: 14 }}>
          気になることがあるときは、担任またはスクールカウンセラーにご相談ください。
        </p>
      </section>
    </div>
  );
}
