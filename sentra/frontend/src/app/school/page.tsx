"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { SCHOOL_STATS } from "@/lib/blesc/fixtures";
import { THEMES } from "@/lib/blesc/labels";
import { t } from "@/lib/i18n";
import styles from "./school.module.css";

/** この画面の文言。参照が多いので短く束ねる。 */
const S = t.educatorDemo.school;

/**
 * 学校全体・学年全体の統計分析（追加機能）。
 *
 * 個人を特定しない集計のみを扱う。人数が minCellSize を下回るセルは
 * 母数が小さく個人が推定されうるため、値を出さずに伏せる。
 */
export default function SchoolPage() {
  const stats = SCHOOL_STATS;
  const [scope, setScope] = useState<"school" | "grade">("school");

  const maxTrend = Math.max(
    ...stats.trendWeeks.flatMap((week) => [week.academic, week.relationships, week.health]),
  );

  return (
    <div className="bl-wrap bl-wrap--wide bl-stack">
      <header className={styles.head}>
        <div>
          <h1 className="bl-h1">{S.title}</h1>
          <p className="bl-meta">{stats.scope} ・ 在籍 {stats.studentCount.toLocaleString()}名</p>
        </div>
        <div className={styles.scopeSwitch}>
          <button
            type="button"
            className="bl-choice"
            aria-pressed={scope === "school"}
            onClick={() => setScope("school")}
          >
            <Icon name="apartment" size={17} />
            {S.wholeSchool}
          </button>
          <button
            type="button"
            className="bl-choice"
            aria-pressed={scope === "grade"}
            onClick={() => setScope("grade")}
          >
            <Icon name="school" size={17} />
            {S.byGrade}
          </button>
        </div>
      </header>

      <div className="bl-notice bl-rise">
        <Icon name="shield" size={19} />
        <span>
          {S.suppressionNote(stats.minCellSize)}
        </span>
      </div>

      {scope === "school" ? (
        <>
          <section className="bl-grid bl-grid--3 bl-rise">
            <div className="bl-card">
              <span className="bl-num">{stats.studentCount.toLocaleString()}</span>
              <p className="bl-meta">{S.studentCount}</p>
            </div>
            <div className="bl-card">
              <span className="bl-num">{Math.round(stats.submissionRate * 100)}%</span>
              <p className="bl-meta">{S.submissionRate}</p>
            </div>
            <div className="bl-card">
              <span className="bl-num">
                6<span className={styles.unit}>{S.gradeUnit}</span>
              </span>
              <p className="bl-meta">{S.gradeCount}</p>
            </div>
          </section>

          {/* ── 学校全体の内訳 ─────────────────────── */}
          <section className="bl-card bl-rise">
            <div className="bl-card-head">
              <Icon name="pie_chart" size={21} />
              <h2 className="bl-h2">{S.breakdownTitle}</h2>
            </div>

            <div className={styles.breakdown}>
              {stats.breakdown.map((item) => (
                <div key={item.theme} className={styles.breakRow}>
                  <span className="bl-chip bl-chip--tint" style={{ width: "10rem" }}>
                    <Icon name={THEMES[item.theme].icon} size={17} />
                    {THEMES[item.theme].label}
                  </span>
                  <div className="bl-bar" style={{ flex: 1 }}>
                    <span style={{ width: `${item.share * 100}%` }} />
                  </div>
                  <span className={styles.share}>{Math.round(item.share * 100)}%</span>
                  <span
                    className={styles.delta}
                    data-dir={item.delta > 0 ? "up" : item.delta < 0 ? "down" : "flat"}
                  >
                    <Icon
                      name={item.delta > 0 ? "trending_up" : item.delta < 0 ? "trending_down" : "trending_flat"}
                      size={15}
                    />
                    {item.delta === 0 ? S.noChange : `${item.delta > 0 ? "+" : ""}${Math.round(item.delta * 100)}`}
                  </span>
                </div>
              ))}
            </div>
          </section>

          {/* ── 週ごとの推移 ───────────────────────── */}
          <section className="bl-card bl-rise">
            <div className="bl-card-head">
              <Icon name="monitoring" size={21} />
              <h2 className="bl-h2">{S.trendTitle}</h2>
              <span className="bl-spacer" />
              <div className={styles.legend}>
                {[
                  { key: "academic", label: S.theme.academic, color: "var(--bl-blue)" },
                  { key: "relationships", label: S.theme.relationships, color: "hsl(172 52% 52%)" },
                  { key: "health", label: S.theme.health, color: "hsl(255 45% 68%)" },
                ].map((item) => (
                  <span key={item.key} className="bl-row" style={{ gap: 6 }}>
                    <span className="bl-dot" style={{ background: item.color }} />
                    <span className="bl-micro">{item.label}</span>
                  </span>
                ))}
              </div>
            </div>

            <div className={styles.chart}>
              {stats.trendWeeks.map((week) => (
                <div key={week.label} className={styles.chartCol}>
                  <div className={styles.bars}>
                    <span
                      style={{ height: `${(week.academic / maxTrend) * 100}%`, background: "var(--bl-blue)" }}
                      title={S.shareTitle(S.theme.academic, Math.round(week.academic * 100))}
                    />
                    <span
                      style={{ height: `${(week.relationships / maxTrend) * 100}%`, background: "hsl(172 52% 52%)" }}
                      title={S.shareTitle(S.theme.relationships, Math.round(week.relationships * 100))}
                    />
                    <span
                      style={{ height: `${(week.health / maxTrend) * 100}%`, background: "hsl(255 45% 68%)" }}
                      title={S.shareTitle(S.theme.health, Math.round(week.health * 100))}
                    />
                  </div>
                  <span className={styles.chartLabel}>{week.label}</span>
                </div>
              ))}
            </div>
          </section>
        </>
      ) : (
        /* ── 学年別 ───────────────────────────────── */
        <section className="bl-card bl-card--flush bl-rise">
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{S.tableGrade}</th>
                  <th scope="col">{S.studentCount}</th>
                  <th scope="col">{S.tableSubmissionRate}</th>
                  <th scope="col">{S.tableTopTheme}</th>
                </tr>
              </thead>
              <tbody>
                {stats.byGrade.map((grade) => {
                  const suppressed = grade.studentCount < stats.minCellSize;
                  return (
                    <tr key={grade.grade}>
                      <th scope="row">{grade.grade}</th>
                      <td className={styles.num}>{S.studentCountValue(grade.studentCount)}</td>
                      <td>
                        {suppressed ? (
                          <span className="bl-micro">{S.suppressed}</span>
                        ) : (
                          <span className={styles.rateCell}>
                            <span className="bl-bar" style={{ width: 110 }}>
                              <span style={{ width: `${grade.submissionRate * 100}%` }} />
                            </span>
                            <span className={styles.num}>{Math.round(grade.submissionRate * 100)}%</span>
                          </span>
                        )}
                      </td>
                      <td>
                        {suppressed ? (
                          <span className="bl-micro">{S.suppressedShort}</span>
                        ) : (
                          <span className="bl-chip bl-chip--tint">
                            <Icon name={THEMES[grade.top].icon} size={15} />
                            {THEMES[grade.top].label}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <p className="bl-disclaimer">
        <Icon name="medical_information" size={15} />
        {S.disclaimer}
      </p>
    </div>
  );
}
