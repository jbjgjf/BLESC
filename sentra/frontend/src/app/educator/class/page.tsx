"use client";

import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { CLASS_BREAKDOWN, CLASS_ROSTER } from "@/lib/blesc/fixtures";
import { BANDS, BAND_ORDER, THEMES } from "@/lib/blesc/labels";
import type { RiskBand } from "@/lib/blesc/types";
import { t } from "@/lib/i18n";
import styles from "./class.module.css";

/** この画面の文言。参照が多いので短く束ねる。 */
const C = t.educatorDemo.class;

export default function ClassPage() {
  const counts = CLASS_ROSTER.reduce(
    (acc, student) => ({ ...acc, [student.band]: (acc[student.band] ?? 0) + 1 }),
    {} as Record<RiskBand, number>,
  );

  const submitted = CLASS_ROSTER.filter((student) => student.missedDays === 0).length;
  const withFollowUp = CLASS_ROSTER.filter((student) => student.hasFollowUp).length;

  return (
    <div className="bl-stack">
      <header style={{ padding: "2px 2px 0" }}>
        <h1 className="bl-h1">{C.title}</h1>
        <p className="bl-meta" style={{ marginTop: 3 }}>
          {C.subtitle("2年A組", CLASS_ROSTER.length)}
        </p>
      </header>

      {/* ── 6-1 クラス全体ヒートマップ ───────────────── */}
      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="grid_view" size={21} />
          <h2 className="bl-h2">{C.heatmapTitle}</h2>
          <span className="bl-spacer" />
          <div className={styles.legend}>
            {BAND_ORDER.slice().reverse().map((band) => (
              <span key={band} className="bl-row" style={{ gap: 6 }}>
                <span className={`bl-dot ${BANDS[band].dot}`} />
                <span className="bl-micro">
                  {BANDS[band].label} {counts[band] ?? 0}
                </span>
              </span>
            ))}
          </div>
        </div>

        <div className={styles.heatmap}>
          {CLASS_ROSTER.map((student) => {
            const meta = BANDS[student.band];
            return (
              <Link
                key={student.id}
                href={`/educator/student/${student.id}`}
                className={styles.cell}
                style={{ background: meta.bg, borderColor: meta.line, color: meta.ink }}
                title={C.cellTitle(student.name, meta.label)}
              >
                <span className={`bl-dot ${meta.dot}`} />
                <span className={styles.cellName}>{student.name}</span>
                {student.missedDays > 0 && (
                  <span className={styles.cellBadge} title={C.missedDays(student.missedDays)}>
                    <Icon name="event_busy" size={13} />
                  </span>
                )}
              </Link>
            );
          })}
        </div>

        <p className="bl-disclaimer" style={{ marginTop: 14 }}>
          <Icon name="info" size={14} />
          {C.heatmapNote}
        </p>
      </section>

      {/* ── クラスの様子 ─────────────────────────────── */}
      <section className="bl-grid bl-grid--3 bl-rise">
        <div className="bl-card">
          <span className="bl-num">{Math.round((submitted / CLASS_ROSTER.length) * 100)}%</span>
          <p className="bl-meta">{C.submittedYesterday}</p>
        </div>
        <div className="bl-card">
          <span className="bl-num">
            {withFollowUp}
            <span className={styles.unit}>{C.personUnit}</span>
          </span>
          <p className="bl-meta">{C.withFollowUp}</p>
        </div>
        <div className="bl-card">
          <span className="bl-num">
            {CLASS_ROSTER.filter((s) => s.status !== "none").length}
            <span className={styles.unit}>{C.personUnit}</span>
          </span>
          <p className="bl-meta">{C.inProgress}</p>
        </div>
      </section>

      {/* ── 6-2 クラス全体分析 ───────────────────────── */}
      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="pie_chart" size={21} />
          <h2 className="bl-h2">{C.breakdownTitle}</h2>
        </div>

        <p className="bl-body" style={{ marginBottom: 16 }}>
          {C.breakdownIntro}
        </p>

        <div className={styles.breakdown}>
          {CLASS_BREAKDOWN.map((item) => {
            const theme = THEMES[item.theme];
            return (
              <div key={item.theme} className={styles.breakRow}>
                <span className="bl-chip bl-chip--tint" style={{ width: "9.5rem" }}>
                  <Icon name={theme.icon} size={17} />
                  {theme.label}
                </span>

                <div className="bl-bar" style={{ flex: 1 }}>
                  <span style={{ width: `${item.share * 100}%` }} />
                </div>

                <span className={styles.share}>{Math.round(item.share * 100)}%</span>

                <span className={styles.delta} data-dir={item.delta > 0 ? "up" : item.delta < 0 ? "down" : "flat"}>
                  <Icon
                    name={item.delta > 0 ? "trending_up" : item.delta < 0 ? "trending_down" : "trending_flat"}
                    size={15}
                  />
                  {item.delta === 0 ? C.noChange : `${item.delta > 0 ? "+" : ""}${Math.round(item.delta * 100)}`}
                </span>
              </div>
            );
          })}
        </div>

        <p className="bl-micro" style={{ marginTop: 14 }}>
          {C.deltaNote}
        </p>
      </section>

      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="lightbulb" size={21} />
          <h2 className="bl-h2">{C.hintsTitle}</h2>
        </div>
        <ul className={styles.hints}>
          {C.hints.map((hint) => (
            <li key={hint}>{hint}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
