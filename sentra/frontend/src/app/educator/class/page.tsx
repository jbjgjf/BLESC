"use client";

import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { CLASS_BREAKDOWN, CLASS_ROSTER } from "@/lib/blesc/fixtures";
import { THEMES, formatDate, formatDateTime } from "@/lib/blesc/labels";
import type { StudentSummary } from "@/lib/blesc/types";
import { t } from "@/lib/i18n";
import styles from "./class.module.css";

/** この画面の文言。参照が多いので短く束ねる。 */
const C = t.educatorDemo.class;

/**
 * クラス一覧（#175 以前は「ヒートマップ」）。
 *
 * 以前はこの画面が生徒ごとのリスクバンドで各セルを塗り、バンド別の人数を数え、
 * `title` に「名前 ・ 高リスク」と入れていた。`docs/educator_display_policy.md`
 * の規則1に反するので、描画・集計・並び替えの3つとも観測へ置き換えた。
 *
 * 並び順が分類の代わりになりやすい。バンドで並べれば、色を消してもランキングは
 * 残る。ここは観測の時刻順（新しい順）で、同時刻なら名簿順。時刻は生徒について
 * の判断ではなく、いつ何があったかという事実なので、並び順に使ってよい。
 * そして何順かを画面に書く（`rosterOrder`）——書いていない並び順は、読む側が
 * 深刻さの順だと受け取る。
 */

/** 観測のある生徒が先、次に観測が新しい順、最後に名簿順。 */
function byObservation(a: StudentSummary, b: StudentSummary): number {
  const at = a.urgent?.detectedAt ?? "";
  const bt = b.urgent?.detectedAt ?? "";
  if (at !== bt) return bt.localeCompare(at);
  return a.id.localeCompare(b.id);
}

export default function ClassPage() {
  const roster = [...CLASS_ROSTER].sort(byObservation);
  const observed = roster.filter((student) => student.urgent);

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

      {/* ── クラスの一覧 ─────────────────────────────── */}
      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="grid_view" size={21} />
          <h2 className="bl-h2">{C.rosterTitle}</h2>
          <span className="bl-spacer" />
          <span className="bl-micro">{C.observedCount(observed.length)}</span>
        </div>

        <p className="bl-micro" style={{ marginBottom: 12 }}>
          {C.rosterOrder}
        </p>

        <div className={styles.roster}>
          {roster.map((student) => {
            const observation = student.urgent;
            const detail = observation
              ? `${C.observationPrefix}${observation.reasons.join(" / ")}`
              : student.lastEntry
                ? C.lastEntry(formatDate(student.lastEntry))
                : C.neverSubmitted;

            return (
              <Link
                key={student.id}
                href={`/educator/student/${student.id}`}
                className={styles.cell}
                data-observed={observation ? "true" : "false"}
                title={C.cellTitle(student.name, detail)}
              >
                <span className={styles.cellName}>{student.name}</span>

                {observation ? (
                  <>
                    {/* 観測があることは伝えるが、程度は示さない。色で段階を
                        作るとバンドが別名で戻ってくる。 */}
                    <span className={styles.observedChip}>{C.observedChip}</span>
                    <span className={styles.cellDetail}>
                      {C.observationPrefix}
                      {observation.reasons.join(" / ")}
                    </span>
                    <span className={styles.cellMeta}>
                      {formatDateTime(observation.detectedAt)} ・ {C.surface[observation.surface]}
                    </span>
                  </>
                ) : (
                  <span className={styles.cellMeta}>
                    {student.lastEntry ? C.lastEntry(formatDate(student.lastEntry)) : C.neverSubmitted}
                  </span>
                )}

                {student.missedDays > 0 && (
                  <span className={styles.cellBadge}>
                    <Icon name="event_busy" size={13} />
                    {C.missedDays(student.missedDays)}
                  </span>
                )}
              </Link>
            );
          })}
        </div>

        <p className="bl-disclaimer" style={{ marginTop: 14 }}>
          <Icon name="info" size={14} />
          {C.rosterNote}
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

                {/* 話題の割合の増減。以前は上向き矢印を警戒色、下向きを安心色で
                    塗っていたが、それは「増えたら悪い」という評価であって、
                    集計そのものではない。符号付きの数値だけにしてある。 */}
                <span className={styles.delta}>
                  {item.delta === 0 ? C.noChange : `${item.delta > 0 ? "+" : "−"}${Math.abs(Math.round(item.delta * 100))}`}
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
