"use client";

import { useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { MoodTrend } from "@/components/blesc/MoodTrend";
import { MoodBloom } from "@/components/blesc/MoodBloom";
import { MY_ENTRIES, MY_STATS } from "@/lib/blesc/fixtures";
import {
  CATEGORY_BY_VALUE,
  MOODS,
  MOOD_BY_VALUE,
  formatDate,
} from "@/lib/blesc/labels";
import type { DiaryEntry, EventCategory, Mood } from "@/lib/blesc/types";
import { t } from "@/lib/i18n";
import styles from "./reflect.module.css";

export default function ReflectPage() {
  const [openId, setOpenId] = useState<string | null>(null);

  /** よく選択している出来事のカテゴリ */
  const categoryCounts = useMemo(() => {
    const counts = new Map<EventCategory, number>();
    for (const entry of MY_ENTRIES) {
      for (const category of entry.categories) {
        counts.set(category, (counts.get(category) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, []);

  const maxCategory = categoryCounts[0]?.[1] ?? 1;

  /** 気分ごとの日数 */
  const moodCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of MY_ENTRIES) {
      counts.set(entry.mood, (counts.get(entry.mood) ?? 0) + 1);
    }
    return counts;
  }, []);

  const series = useMemo(
    () => [...MY_ENTRIES].reverse().map((entry) => ({ date: entry.date, mood: entry.mood })),
    [],
  );

  return (
    <div className="bl-wrap bl-stack">
      <header className={styles.head}>
        <h1 className="bl-h1">{t.reflect.title}</h1>
        <p className="bl-meta">
          {t.reflect.intro(MY_ENTRIES.length)}
        </p>
      </header>

      {/* ── 日ごとの感情の推移 ───────────────────────── */}
      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="monitoring" size={21} />
          <h2 className="bl-h2">{t.reflect.moodTrendTitle}</h2>
        </div>
        <MoodTrend series={series} />
      </section>

      {/* ── 気分の内訳 ─────────────────────────────── */}
      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="mood" size={21} />
          <h2 className="bl-h2">{t.reflect.moodBreakdownTitle}</h2>
        </div>

        <MoodBloom
          counts={Object.fromEntries(MOODS.map((mood) => [mood.value, moodCounts.get(mood.value) ?? 0])) as Record<Mood, number>}
        />
        <p className="bl-micro" style={{ marginTop: 14, textAlign: "center" }}>
          {t.reflect.moodBreakdownNote}
        </p>
      </section>

      {/* ── よく選んでいる出来事 ─────────────────────── */}
      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="calendar_month" size={21} />
          <h2 className="bl-h2">{t.reflect.eventsTitle}</h2>
        </div>

        <div className={styles.catList}>
          {categoryCounts.map(([category, count]) => {
            const meta = CATEGORY_BY_VALUE[category];
            return (
              <div key={category} className={styles.catRow}>
                <span className="bl-chip bl-chip--tint">
                  <Icon name={meta.icon} size={17} />
                  {meta.label}
                </span>
                <div className="bl-bar" style={{ flex: 1 }}>
                  <span style={{ width: `${(count / maxCategory) * 100}%` }} />
                </div>
                <span className={styles.catCount}>{count}回</span>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── 連続記録 ───────────────────────────────── */}
      <section className={`${styles.streak} bl-rise`}>
        <Icon name="local_fire_department" size={30} fill />
        <div>
          <h2 className="bl-h2">{t.reflect.streakTitle(MY_STATS.streak)}</h2>
          <p className="bl-body">
            {t.reflect.streakNote(Math.round(MY_STATS.monthRate * 100))}
          </p>
        </div>
      </section>

      {/* ── 過去の日記 ─────────────────────────────── */}
      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="history" size={21} />
          <h2 className="bl-h2">{t.reflect.pastEntriesTitle}</h2>
        </div>

        <div className="bl-stack-s">
          {MY_ENTRIES.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              open={openId === entry.id}
              onToggle={() => setOpenId((current) => (current === entry.id ? null : entry.id))}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function EntryRow({
  entry,
  open,
  onToggle,
}: {
  entry: DiaryEntry;
  open: boolean;
  onToggle: () => void;
}) {
  const mood = MOOD_BY_VALUE[entry.mood];

  return (
    <article className={styles.entry} data-open={open}>
      <button type="button" className={styles.entryHead} onClick={onToggle} aria-expanded={open}>
        <span className={styles.entryMood} style={{ background: mood.tint, color: mood.color }}>
          <Icon name={mood.icon} size={21} fill />
        </span>
        <span className={styles.entryTitle}>
          <span className="bl-h3">{formatDate(entry.date)}</span>
          <span className="bl-micro">{mood.label}</span>
        </span>
        <span className={styles.entryCats}>
          {entry.categories.map((category) => (
            <span key={category} className="bl-chip bl-chip--tint">
              <Icon name={CATEGORY_BY_VALUE[category].icon} size={15} />
              {CATEGORY_BY_VALUE[category].label}
            </span>
          ))}
        </span>
        <Icon name="expand_more" size={21} className={styles.entryChevron} />
      </button>

      {open && (
        <div className={styles.entryBody}>
          <Field label={t.reflect.fieldNote} icon="edit_note" value={entry.body} />

          {entry.followUp && (
            <div className={styles.followUp}>
              <div className="bl-row" style={{ gap: 7, marginBottom: 9 }}>
                <Icon name="forum" size={18} />
                <span className="bl-h3">この日のblescとのやりとり</span>
              </div>
              <div className={styles.followUpTurns}>
                {entry.followUp.turns.map((turn, index) => (
                  <div
                    key={index}
                    className={`${styles.turn} ${turn.role === "student" ? styles.turnStudent : ""}`}
                  >
                    {turn.text}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function Field({
  label,
  icon,
  value,
}: {
  label: string;
  icon: "notes" | "star" | "psychology_alt" | "edit_note";
  value: string;
}) {
  return (
    <div className={styles.field}>
      <div className={styles.fieldLabel}>
        <Icon name={icon} size={17} />
        {label}
      </div>
      <p className={value ? "bl-body" : styles.fieldEmpty}>{value || t.reflect.fieldEmpty}</p>
    </div>
  );
}
