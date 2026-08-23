"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon, type IconName } from "@/components/ui/Icon";
import { CLASS_ROSTER, FOLLOW_UPS, SUBMISSION_ALERTS } from "@/lib/blesc/fixtures";
import { formatDate, formatDateTime, relativeDays } from "@/lib/blesc/labels";
import type { SubmissionAlert } from "@/lib/blesc/types";
import styles from "./alerts.module.css";

const ALERT_META: Record<SubmissionAlert["kind"], { label: string; icon: IconName }> = {
  missing_3d:    { label: "3日以上未提出",   icon: "event_busy" },
  unused_1w:     { label: "1週間未利用",     icon: "visibility" },
  streak_broken: { label: "連続提出が中断",  icon: "local_fire_department" },
  rate_drop:     { label: "提出頻度が低下",  icon: "trending_down" },
};

export default function AlertsPage() {
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());

  const urgent = CLASS_ROSTER.filter((student) => student.urgent);
  const overdueFollowUps = FOLLOW_UPS.filter(
    (item) => item.state === "worsening" || item.nextMeeting === null,
  );

  const toggleAck = (id: string) =>
    setAcknowledged((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="bl-stack">
      <header style={{ padding: "2px 2px 0" }}>
        <h1 className="bl-h1">アラート</h1>
        <p className="bl-meta" style={{ marginTop: 3 }}>
          確認のきっかけとして使ってください。アラートだけで状態を判断しないでください。
        </p>
      </header>

      {/* ── 7-5 緊急性が高い可能性のある内容 ─────────── */}
      <section className="bl-stack-s bl-rise">
        <div className="bl-row" style={{ gap: 9, padding: "0 2px" }}>
          <Icon name="priority_high" size={20} fill style={{ color: "var(--bl-alert)" }} />
          <h2 className="bl-h2">優先度の高いアラート</h2>
          <span className="bl-chip bl-chip--alert">{urgent.length}件</span>
        </div>

        {urgent.length === 0 ? (
          <div className="bl-card bl-empty">
            <Icon name="check_circle" size={38} />
            <p className="bl-body">優先度の高いアラートはありません。</p>
          </div>
        ) : (
          urgent.map((student) => (
            <article key={student.id} className={styles.urgentCard}>
              <div className={styles.urgentTop}>
                <span className="bl-chip bl-chip--alert">
                  <Icon name="priority_high" size={15} fill />
                  要確認
                </span>
                <Link href={`/educator/student/${student.id}`} className={styles.name}>
                  {student.name}
                </Link>
                <span className="bl-micro">
                  {student.grade}{student.className}
                </span>
                <span className="bl-spacer" />
                <span className="bl-micro">{formatDateTime(student.urgent!.detectedAt)}</span>
              </div>

              <p className="bl-body" style={{ marginTop: 10 }}>{student.urgent!.detail}</p>

              <div className={styles.reasons}>
                <span className="bl-micro" style={{ fontWeight: 700 }}>検知の根拠</span>
                <ul>
                  {student.urgent!.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>

              <div className={styles.flow}>
                <span className="bl-micro" style={{ fontWeight: 700 }}>対応の流れ</span>
                <ol>
                  <li>担当教員または指定された支援担当者に通知</li>
                  <li>学校の定める緊急対応フローに沿って状況を確認</li>
                  <li>必要に応じて保健室・スクールカウンセラー・管理職・保護者と連携</li>
                </ol>
              </div>

              <div className={styles.cardActions}>
                <Link href={`/educator/student/${student.id}`} className="bl-btn bl-btn--primary bl-btn--sm">
                  詳細を確認
                  <Icon name="arrow_forward" size={16} />
                </Link>
                <button
                  type="button"
                  className="bl-btn bl-btn--secondary bl-btn--sm"
                  onClick={() => toggleAck(student.id)}
                >
                  <Icon name={acknowledged.has(student.id) ? "check_circle" : "check"} size={16} fill={acknowledged.has(student.id)} />
                  {acknowledged.has(student.id) ? "確認済み" : "確認しました"}
                </button>
              </div>
            </article>
          ))
        )}
      </section>

      {/* ── 6-5 未提出アラート ───────────────────────── */}
      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="event_busy" size={21} />
          <h2 className="bl-h2">日記の未提出</h2>
          <span className="bl-chip bl-chip--watch">{SUBMISSION_ALERTS.length}件</span>
        </div>

        <div className="bl-stack-s">
          {SUBMISSION_ALERTS.map((alert) => {
            const meta = ALERT_META[alert.kind];
            const done = acknowledged.has(alert.studentId);
            return (
              <div key={alert.studentId} className={styles.alertRow} data-done={done}>
                <span className={styles.alertIcon}>
                  <Icon name={meta.icon} size={19} />
                </span>

                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="bl-row" style={{ gap: 9, flexWrap: "wrap" }}>
                    <Link href={`/educator/student/${alert.studentId}`} className={styles.name}>
                      {alert.studentName}
                    </Link>
                    <span className="bl-chip bl-chip--tint">{meta.label}</span>
                  </span>
                  <span className="bl-micro" style={{ display: "block", marginTop: 3 }}>
                    {alert.detail} ・ {formatDate(alert.since, false)}から（{relativeDays(alert.since)}）
                  </span>
                </span>

                <button
                  type="button"
                  className="bl-btn bl-btn--ghost bl-btn--sm"
                  onClick={() => toggleAck(alert.studentId)}
                >
                  <Icon name={done ? "check_circle" : "check"} size={16} fill={done} />
                  {done ? "確認済み" : "確認"}
                </button>
              </div>
            );
          })}
        </div>

        <p className="bl-disclaimer" style={{ marginTop: 14 }}>
          <Icon name="info" size={14} />
          未提出は体調・行事・端末の不調など様々な理由で起こります。声掛けのきっかけとしてお使いください。
        </p>
      </section>

      {/* ── 7-2 フォロー漏れ通知 ─────────────────────── */}
      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="event_repeat" size={21} />
          <h2 className="bl-h2">フォロー漏れ</h2>
          {overdueFollowUps.length > 0 && (
            <span className="bl-chip bl-chip--watch">{overdueFollowUps.length}件</span>
          )}
        </div>

        {overdueFollowUps.length === 0 ? (
          <div className="bl-empty">
            <Icon name="check_circle" size={38} />
            <p className="bl-body">フォロー漏れはありません。</p>
          </div>
        ) : (
          <div className="bl-stack-s">
            {overdueFollowUps.map((item) => (
              <div key={item.studentId} className={styles.alertRow}>
                <span className={styles.alertIcon}>
                  <Icon name="event_repeat" size={19} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <Link href={`/educator/student/${item.studentId}`} className={styles.name}>
                    {item.studentName}
                  </Link>
                  <span className="bl-micro" style={{ display: "block", marginTop: 3 }}>
                    {item.note} 前回面談から{item.daysSince}日、次回は
                    {item.nextMeeting ? formatDate(item.nextMeeting, false) : "未設定"}です。
                  </span>
                </span>
                <Link href={`/educator/meetings?student=${item.studentId}`} className="bl-btn bl-btn--secondary bl-btn--sm">
                  面談を設定
                </Link>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
