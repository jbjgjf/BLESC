"use client";

import { useSyncExternalStore } from "react";
import Image from "next/image";
import { Icon } from "@/components/ui/Icon";
import { Petal } from "@/components/ui/Petal";
import { TransitionLink } from "@/components/ui/Transition";
import { useCountUp } from "@/lib/motion";
import { CURRENT_STUDENT, MY_ENTRIES, MY_STATS } from "@/lib/blesc/fixtures";
import { MOOD_BY_VALUE, TODAY, addDays, formatDate, relativeDays, weekdayOf } from "@/lib/blesc/labels";
import styles from "./home.module.css";

function greetingFor(hour: number): string {
  if (hour < 5) return "こんばんは";
  if (hour < 11) return "おはよう";
  if (hour < 18) return "こんにちは";
  return "こんばんは";
}

/**
 * The clock is a browser-only value, so it is read through an external store:
 * the server (and the hydrating render) get the neutral greeting, and the real
 * one lands right after. Doing this in an effect would cascade a second render.
 */
const neverChanges = () => () => {};

function useGreeting(): string {
  return useSyncExternalStore(
    neverChanges,
    () => greetingFor(new Date().getHours()),
    () => "こんにちは",
  );
}

/** 直近7日分の提出状況。今日を右端に置く。 */
const WEEK = Array.from({ length: 7 }, (_, index) => addDays(TODAY, index - 6));

export default function TodayPage() {
  const greeting = useGreeting();
  const todayEntry = MY_ENTRIES.find((entry) => entry.date === TODAY);
  const firstName = CURRENT_STUDENT.name.split(" ")[1] ?? CURRENT_STUDENT.name;
  const byDate = new Map(MY_ENTRIES.map((entry) => [entry.date, entry]));

  // 続けてきたこと自体が結果なので、数字は積み上がる様子を見せる。
  const streak = useCountUp(MY_STATS.streak);
  const weekCount = useCountUp(MY_STATS.weekCount);
  const monthRate = useCountUp(Math.round(MY_STATS.monthRate * 100));

  return (
    <div className="bl-wrap bl-stack">
      {/* ── 挨拶 ─────────────────────────────────────────── */}
      <header className={`${styles.hello} bl-rise`}>
        <Image src="/flower.png" alt="" width={52} height={52} className={styles.helloFlower} priority />
        <div>
          <h1 className="bl-h1">
            {greeting}、{firstName}さん
          </h1>
          <p className="bl-meta">
            {formatDate(TODAY)} ・ {CURRENT_STUDENT.grade}
            {CURRENT_STUDENT.className}
          </p>
        </div>
      </header>

      {/* ── 今日の日記 ───────────────────────────────────── */}
      <section className={`${styles.today} bl-rise`} data-done={Boolean(todayEntry)}>
        {todayEntry ? (
          <>
            <div className={styles.todayIcon}>
              <Icon name="check_circle" size={30} fill />
            </div>
            <div className={styles.todayBody}>
              <h2 className="bl-h2">今日の日記は提出済みです</h2>
              <p className="bl-body">{formatDate(todayEntry.date, false)}の記録を保存しました。</p>
            </div>
            <TransitionLink href="/journal" className="bl-btn bl-btn--secondary">
              内容を見る
            </TransitionLink>
          </>
        ) : (
          <>
            <div className={styles.todayIcon}>
              <Icon name="edit_note" size={30} />
            </div>
            <div className={styles.todayBody}>
              <h2 className="bl-h2">今日の日記はまだです</h2>
              <p className="bl-body">今日の気分と出来事を、1分ほどで記録できます。</p>
            </div>
            <TransitionLink href="/journal" className="bl-btn bl-btn--primary bl-btn--lg">
              <Icon name="edit_note" size={19} />
              日記を書く
            </TransitionLink>
          </>
        )}
      </section>

      {/* ── 提出状況 ─────────────────────────────────────── */}
      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="local_fire_department" size={21} fill />
          <h2 className="bl-h2">記録のつづき</h2>
        </div>

        <div className={styles.stats}>
          <div className={styles.stat}>
            <span className="bl-num">{streak}</span>
            <span className="bl-meta">連続提出日数</span>
          </div>
          <div className={styles.stat}>
            <span className="bl-num">{weekCount}</span>
            <span className="bl-meta">今週の提出</span>
          </div>
          <div className={styles.stat}>
            <span className="bl-num">{monthRate}%</span>
            <span className="bl-meta">今月の提出率</span>
          </div>
        </div>

        <div className={`${styles.week} bl-stagger`} style={{ "--bl-step": "45ms" } as React.CSSProperties}>
          {WEEK.map((date) => {
            const entry = byDate.get(date);
            const mood = entry ? MOOD_BY_VALUE[entry.mood] : null;
            const isToday = date === TODAY;
            return (
              <div key={date} className={styles.day} data-today={isToday}>
                <span className={styles.dayWeekday}>{weekdayOf(date)}</span>
                <Petal
                  size={22}
                  color={mood?.color}
                  filled={Boolean(mood)}
                  title={mood ? `${formatDate(date, false)} ${mood.label}` : `${formatDate(date, false)} 未提出`}
                />
                <span className={styles.dayLabel}>
                  {new Date(`${date}T00:00:00`).getDate()}
                </span>
              </div>
            );
          })}
        </div>

        <p className="bl-micro" style={{ marginTop: 14 }}>
          最終提出：{relativeDays(MY_STATS.lastSubmitted)}
        </p>
      </section>

      {/* ── 入口 ─────────────────────────────────────────── */}
      <div className="bl-grid bl-grid--2 bl-reveal">
        <TransitionLink href="/chat" className={`bl-card bl-card--link ${styles.tile}`}>
          <Icon name="chat_bubble" size={26} fill />
          <div>
            <h3 className="bl-h3">blescに相談する</h3>
            <p className="bl-meta">気持ちの整理を手伝います。話したくないことは話さなくて大丈夫です。</p>
          </div>
          <Icon name="chevron_right" size={20} />
        </TransitionLink>

        <TransitionLink href="/reflect" className={`bl-card bl-card--link ${styles.tile}`}>
          <Icon name="insights" size={26} fill />
          <div>
            <h3 className="bl-h3">自分の振り返り</h3>
            <p className="bl-meta">これまでの気分の移り変わりと、よく書いている出来事を見られます。</p>
          </div>
          <Icon name="chevron_right" size={20} />
        </TransitionLink>
      </div>

      {/* ── 最近の日記 ───────────────────────────────────── */}
      <section className="bl-card bl-reveal">
        <div className="bl-card-head">
          <Icon name="history" size={21} />
          <h2 className="bl-h2">最近の日記</h2>
        </div>

        <div className="bl-stack-s">
          {MY_ENTRIES.slice(0, 3).map((entry) => {
            const mood = MOOD_BY_VALUE[entry.mood];
            return (
              <article key={entry.id} className={styles.recent}>
                <span className={styles.recentMood} style={{ background: mood.tint, color: mood.color }}>
                  <Icon name={mood.icon} size={22} fill />
                </span>
                <div className={styles.recentBody}>
                  <div className="bl-row" style={{ gap: 8 }}>
                    <span className="bl-h3">{formatDate(entry.date)}</span>
                    <span className="bl-micro">{mood.label}</span>
                  </div>
                  <p className={`bl-body ${styles.recentText}`}>
                    {entry.body || "（本文なし）"}
                  </p>
                </div>
              </article>
            );
          })}
        </div>

        <TransitionLink href="/reflect" className="bl-btn bl-btn--ghost bl-btn--sm" style={{ marginTop: 12 }}>
          すべて見る
          <Icon name="arrow_forward" size={17} />
        </TransitionLink>
      </section>
    </div>
  );
}
