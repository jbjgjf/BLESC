"use client";

import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { TrendChip } from "@/components/blesc/BandChip";
import { CLASS_ROSTER, FOLLOW_UPS, SUBMISSION_ALERTS } from "@/lib/blesc/fixtures";
import { BANDS, STATUSES, THEMES, formatDate, formatDateTime, relativeDays } from "@/lib/blesc/labels";
import type { RiskBand } from "@/lib/blesc/types";
import styles from "./educator.module.css";

const BAND_TILES: Array<{ band: RiskBand; hint: string }> = [
  { band: "alert", hint: "優先的に確認" },
  { band: "watch", hint: "様子を見る" },
  { band: "calm", hint: "大きな変化なし" },
];

export default function EducatorHome() {
  const counts = CLASS_ROSTER.reduce(
    (acc, student) => ({ ...acc, [student.band]: (acc[student.band] ?? 0) + 1 }),
    {} as Record<RiskBand, number>,
  );

  const attention = CLASS_ROSTER.filter((student) => student.band !== "calm").sort(
    (a, b) => (a.band === "alert" ? 0 : 1) - (b.band === "alert" ? 0 : 1),
  );

  const urgent = CLASS_ROSTER.filter((student) => student.urgent);
  const overdue = FOLLOW_UPS.filter((item) => item.state === "worsening" || item.nextMeeting === null);

  return (
    <div className="bl-stack">
      <header className={styles.head}>
        <div>
          <h1 className="bl-h1">2年A組</h1>
          <p className="bl-meta">担当：山本 直樹 ・ 在籍 {CLASS_ROSTER.length}名</p>
        </div>
        <Link href="/educator/roster" className="bl-btn bl-btn--secondary">
          <Icon name="groups" size={19} />
          生徒一覧
        </Link>
      </header>

      {/* ── 7-5 緊急性が高い可能性のある内容 ─────────── */}
      {urgent.length > 0 && (
        <section className={`${styles.urgent} bl-rise`}>
          <div className={styles.urgentHead}>
            <Icon name="priority_high" size={24} fill />
            <div>
              <h2 className="bl-h2">早急な確認が必要な可能性があります</h2>
              <p className="bl-body">学校の定める緊急対応フローに沿って状況を確認してください。</p>
            </div>
          </div>

          {urgent.map((student) => (
            <article key={student.id} className={styles.urgentCard}>
              <div className="bl-row-between">
                <Link href={`/educator/student/${student.id}`} className={styles.urgentName}>
                  {student.name}
                  <Icon name="chevron_right" size={18} />
                </Link>
                <span className="bl-micro">{formatDateTime(student.urgent!.detectedAt)}</span>
              </div>

              <p className="bl-body" style={{ marginTop: 6 }}>{student.urgent!.detail}</p>

              <div className={styles.reasons}>
                <span className="bl-micro" style={{ fontWeight: 700 }}>検知の根拠</span>
                <ul>
                  {student.urgent!.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>

              <p className="bl-disclaimer" style={{ marginTop: 10 }}>
                <Icon name="info" size={14} />
                出典：{student.urgent!.surface === "diary" ? "日記本文" : "対話型AIとのやりとり"}
              </p>
            </article>
          ))}
        </section>
      )}

      {/* ── 5-1 状態の内訳 ───────────────────────────── */}
      <section className="bl-grid bl-grid--3 bl-rise">
        {BAND_TILES.map(({ band, hint }) => {
          const meta = BANDS[band];
          return (
            <Link
              key={band}
              href={`/educator/roster?band=${band}`}
              className={styles.bandTile}
              style={{ background: meta.bg, borderColor: meta.line }}
            >
              <span className="bl-row" style={{ gap: 8 }}>
                <span className={`bl-dot ${meta.dot}`} />
                <span style={{ color: meta.ink, fontWeight: 700, fontSize: "0.88rem" }}>{meta.label}</span>
              </span>
              <span className="bl-num" style={{ color: meta.ink }}>
                {counts[band] ?? 0}
                <span className={styles.bandUnit}>名</span>
              </span>
              <span className="bl-micro">{hint}</span>
            </Link>
          );
        })}
      </section>

      <div className="bl-grid bl-grid--2">
        {/* ── 要確認の生徒 ─────────────────────────── */}
        <section className="bl-card bl-rise">
          <div className="bl-card-head">
            <Icon name="visibility" size={21} />
            <h2 className="bl-h2">確認したい生徒</h2>
          </div>

          <div className="bl-stack-s">
            {attention.map((student) => (
              <Link key={student.id} href={`/educator/student/${student.id}`} className={styles.studentRow}>
                <span className={`bl-dot ${BANDS[student.band].dot}`} />
                <span className={styles.studentName}>{student.name}</span>
                <span className={styles.studentThemes}>
                  {student.topThemes.slice(0, 2).map((theme) => (
                    <span key={theme} className="bl-chip bl-chip--tint">
                      <Icon name={THEMES[theme].icon} size={14} />
                      {THEMES[theme].label}
                    </span>
                  ))}
                </span>
                <TrendChip trend={student.trend} />
                <Icon name="chevron_right" size={19} className={styles.rowChevron} />
              </Link>
            ))}
          </div>
        </section>

        {/* ── 6-5 未提出アラート ───────────────────── */}
        <section className="bl-card bl-rise">
          <div className="bl-card-head">
            <Icon name="event_busy" size={21} />
            <h2 className="bl-h2">日記の未提出</h2>
            <span className="bl-spacer" />
            <Link href="/educator/alerts" className="bl-btn bl-btn--ghost bl-btn--sm">
              すべて
              <Icon name="arrow_forward" size={16} />
            </Link>
          </div>

          <div className="bl-stack-s">
            {SUBMISSION_ALERTS.slice(0, 4).map((alert) => (
              <div key={alert.studentId} className={styles.alertRow}>
                <Icon name="event_busy" size={19} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="bl-h3">{alert.studentName}</span>
                  <span className="bl-micro" style={{ display: "block" }}>{alert.detail}</span>
                </span>
                <span className="bl-micro">{relativeDays(alert.since)}</span>
              </div>
            ))}
          </div>

          <p className="bl-disclaimer" style={{ marginTop: 12 }}>
            <Icon name="info" size={14} />
            未提出だけで状態を判断せず、声掛けのきっかけとして使ってください。
          </p>
        </section>
      </div>

      {/* ── 7-2 フォローアップ管理 ───────────────────── */}
      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="event_repeat" size={21} />
          <h2 className="bl-h2">フォローアップ</h2>
          {overdue.length > 0 && (
            <span className="bl-chip bl-chip--watch">
              <Icon name="warning" size={14} fill />
              {overdue.length}件 要対応
            </span>
          )}
        </div>

        <div className="bl-stack-s">
          {FOLLOW_UPS.map((item) => (
            <div key={item.studentId} className={styles.followRow}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="bl-row" style={{ gap: 9 }}>
                  <Link href={`/educator/student/${item.studentId}`} className={styles.studentName}>
                    {item.studentName}
                  </Link>
                  <span className="bl-micro">
                    前回面談 {formatDate(item.lastMeeting, false)}（{item.daysSince}日前）
                  </span>
                </span>
                <span className="bl-body" style={{ fontSize: "0.87rem", display: "block", marginTop: 2 }}>
                  {item.note}
                </span>
              </span>

              <span
                className={`bl-chip ${
                  item.state === "worsening"
                    ? "bl-chip--alert"
                    : item.state === "improving"
                      ? "bl-chip--calm"
                      : ""
                }`}
              >
                <Icon
                  name={
                    item.state === "worsening"
                      ? "trending_up"
                      : item.state === "improving"
                        ? "trending_down"
                        : "trending_flat"
                  }
                  size={15}
                />
                {item.state === "worsening" ? "改善なし" : item.state === "improving" ? "改善傾向" : "変化なし"}
              </span>

              <span className={styles.nextMeeting}>
                {item.nextMeeting ? (
                  <>
                    <Icon name="event_note" size={16} />
                    次回 {formatDate(item.nextMeeting, false)}
                  </>
                ) : (
                  <>
                    <Icon name="priority_high" size={16} />
                    未設定
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* ── 対応ステータスの内訳 ─────────────────────── */}
      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="donut_large" size={21} />
          <h2 className="bl-h2">対応ステータス</h2>
        </div>
        <div className={styles.statusList}>
          {(Object.keys(STATUSES) as Array<keyof typeof STATUSES>).map((status) => {
            const count = CLASS_ROSTER.filter((student) => student.status === status).length;
            if (count === 0) return null;
            return (
              <span key={status} className="bl-chip bl-chip--tint">
                <Icon name={STATUSES[status].icon} size={16} />
                {STATUSES[status].label}
                <strong style={{ marginLeft: 2 }}>{count}</strong>
              </span>
            );
          })}
        </div>
      </section>
    </div>
  );
}
