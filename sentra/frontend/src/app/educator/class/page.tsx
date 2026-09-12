"use client";

import { Icon } from "@/components/ui/Icon";
import { CLASS_BREAKDOWN, CLASS_ROSTER } from "@/lib/blesc/fixtures";
import { THEMES, formatDate, formatDateTime, relativeDays } from "@/lib/blesc/labels";
import type { StudentSummary } from "@/lib/blesc/types";
import { t } from "@/lib/i18n";
import styles from "./class.module.css";

/** この画面の文言。参照が多いので短く束ねる。 */
const C = t.educatorDemo.class;

/**
 * クラス全体（デモ）。
 *
 * ここにあったのは、生徒33名をリスクバンドの色で塗ったヒートマップだった
 * （#175）。描画・タイル集計・凡例の3つとも、`docs/educator_display_policy.md`
 * の規則1が禁じている「生徒に紐づく分類の表示」にあたっていた。
 *
 * 作り直した先は、実データ側の教員画面（`/educator`、`/educator/roster`）が
 * すでに従っている形である。
 *
 *   - **観測は根拠と時刻を伴う。** 根拠のない観測は行として出さない。
 *     教員が生徒の記述まで辿れない指摘は、指摘がないより悪い（規則2）。
 *   - **並びは時刻順で、そう明示する。** 判定で並べ替えると、分類は
 *     ソート順という形で画面に戻ってくる（規則1）。
 *   - **名簿は提出の事実だけを持つ。** 色による強調をしない。33名を
 *     等しく並べ、最終提出と未提出日数を出す。
 */

/** 観測を持つ生徒。新しい順。時刻のない観測は、辿れないので出さない。 */
function observedStudents(): StudentSummary[] {
  return CLASS_ROSTER.filter((student) => student.urgent && student.urgent.reasons.length > 0)
    .slice()
    .sort((a, b) => Date.parse(b.urgent!.detectedAt) - Date.parse(a.urgent!.detectedAt));
}

/** 名簿。最終提出の新しい順。未提出の生徒が下に集まる。 */
function rosterByLastEntry(): StudentSummary[] {
  return CLASS_ROSTER.slice().sort((a, b) => {
    if (a.lastEntry === b.lastEntry) return a.name.localeCompare(b.name, "ja");
    if (!a.lastEntry) return 1;
    if (!b.lastEntry) return -1;
    return b.lastEntry.localeCompare(a.lastEntry);
  });
}

export default function ClassPage() {
  const observed = observedStudents();
  const roster = rosterByLastEntry();

  const submitted = CLASS_ROSTER.filter((student) => student.missedDays === 0).length;
  const withFollowUp = CLASS_ROSTER.filter((student) => student.hasFollowUp).length;
  const inProgress = CLASS_ROSTER.filter((student) => student.status !== "none").length;

  return (
    <div className="bl-stack">
      <header style={{ padding: "2px 2px 0" }}>
        <h1 className="bl-h1">{C.title}</h1>
        <p className="bl-meta" style={{ marginTop: 3 }}>
          {C.subtitle("2年A組", CLASS_ROSTER.length)}
        </p>
      </header>

      {/* ── 観測された記述 ───────────────────────────── */}
      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="visibility" size={21} />
          <h2 className="bl-h2">{C.observationsTitle}</h2>
          <span className="bl-spacer" />
          <span className="bl-micro">{C.orderedByTime}</span>
        </div>

        {observed.length === 0 ? (
          <div className="bl-empty">
            <Icon name="check_circle" size={38} />
            <p className="bl-body">{C.observationsEmpty}</p>
          </div>
        ) : (
          <ul className={styles.observations}>
            {observed.map((student) => (
              <li key={student.id} className={styles.observation}>
                <div className={styles.observationHead}>
                  <span className={styles.name}>{student.name}</span>
                  <span className="bl-chip bl-chip--tint">{C.surface[student.urgent!.surface]}</span>
                  <span className="bl-spacer" />
                  <span className="bl-micro">{formatDateTime(student.urgent!.detectedAt)}</span>
                </div>

                <p className="bl-body" style={{ marginTop: 8 }}>
                  {student.urgent!.detail}
                </p>

                <div className={styles.reasons}>
                  <span className="bl-micro" style={{ fontWeight: 700 }}>
                    {C.reasonsLabel}
                  </span>
                  <ul>
                    {student.urgent!.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </div>

                <p className="bl-micro" style={{ marginTop: 8 }}>
                  {C.provenance}
                </p>
              </li>
            ))}
          </ul>
        )}

        <p className="bl-disclaimer" style={{ marginTop: 14 }}>
          <Icon name="info" size={14} />
          {C.observationsNote}
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
            {inProgress}
            <span className={styles.unit}>{C.personUnit}</span>
          </span>
          <p className="bl-meta">{C.inProgress}</p>
        </div>
      </section>

      {/* ── 名簿 ─────────────────────────────────────── */}
      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="groups" size={21} />
          <h2 className="bl-h2">{C.rosterTitle}</h2>
          <span className="bl-spacer" />
          <span className="bl-micro">{C.orderedByLastEntry}</span>
        </div>

        <ul className={styles.roster}>
          {roster.map((student) => (
            <li key={student.id} className={styles.rosterRow}>
              <span className={styles.name}>{student.name}</span>
              <span className="bl-spacer" />
              {student.missedDays > 0 && (
                <span className="bl-chip bl-chip--tint">
                  <Icon name="event_busy" size={14} />
                  {C.missedDays(student.missedDays)}
                </span>
              )}
              <span className="bl-micro" style={{ minWidth: "8.5rem", textAlign: "right" }}>
                {student.lastEntry
                  ? C.lastEntry(formatDate(student.lastEntry, false), relativeDays(student.lastEntry))
                  : C.noEntry}
              </span>
            </li>
          ))}
        </ul>

        <p className="bl-disclaimer" style={{ marginTop: 14 }}>
          <Icon name="info" size={14} />
          {C.rosterNote}
        </p>
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
