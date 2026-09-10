"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon, type IconName } from "@/components/ui/Icon";
import { CLASS_ROSTER, FOLLOW_UPS, SUBMISSION_ALERTS } from "@/lib/blesc/fixtures";
import { formatDate, formatDateTime, relativeDays } from "@/lib/blesc/labels";
import type { SubmissionAlert } from "@/lib/blesc/types";
import { t } from "@/lib/i18n";
import styles from "./alerts.module.css";

/** この画面の文言。参照が多いので短く束ねる。 */
const A = t.educatorDemo.alerts;

const ALERT_META: Record<SubmissionAlert["kind"], { label: string; icon: IconName }> = {
  missing_3d:    { label: A.kind.missing_3d,    icon: "event_busy" },
  unused_1w:     { label: A.kind.unused_1w,     icon: "visibility" },
  streak_broken: { label: A.kind.streak_broken, icon: "local_fire_department" },
  rate_drop:     { label: A.kind.rate_drop,     icon: "trending_down" },
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
        <h1 className="bl-h1">{A.title}</h1>
        <p className="bl-meta" style={{ marginTop: 3 }}>
          {A.intro}
        </p>
      </header>

      {/* ── 7-5 緊急性が高い可能性のある内容 ─────────── */}
      <section className="bl-stack-s bl-rise">
        <div className="bl-row" style={{ gap: 9, padding: "0 2px" }}>
          <Icon name="priority_high" size={20} fill style={{ color: "var(--bl-alert)" }} />
          <h2 className="bl-h2">{A.urgentTitle}</h2>
          <span className="bl-chip bl-chip--alert">{A.count(urgent.length)}</span>
        </div>

        {urgent.length === 0 ? (
          <div className="bl-card bl-empty">
            <Icon name="check_circle" size={38} />
            <p className="bl-body">{A.urgentEmpty}</p>
          </div>
        ) : (
          urgent.map((student) => (
            <article key={student.id} className={styles.urgentCard}>
              <div className={styles.urgentTop}>
                <span className="bl-chip bl-chip--alert">
                  <Icon name="priority_high" size={15} fill />
                  {A.attention}
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
                <span className="bl-micro" style={{ fontWeight: 700 }}>{A.flowTitle}</span>
                <ol>
                  {A.flow.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ol>
              </div>

              <div className={styles.cardActions}>
                <Link href={`/educator/student/${student.id}`} className="bl-btn bl-btn--primary bl-btn--sm">
                  {A.viewDetail}
                  <Icon name="arrow_forward" size={16} />
                </Link>
                <button
                  type="button"
                  className="bl-btn bl-btn--secondary bl-btn--sm"
                  onClick={() => toggleAck(student.id)}
                >
                  <Icon name={acknowledged.has(student.id) ? "check_circle" : "check"} size={16} fill={acknowledged.has(student.id)} />
                  {acknowledged.has(student.id) ? A.acknowledged : A.acknowledge}
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
          <h2 className="bl-h2">{A.missingTitle}</h2>
          <span className="bl-chip bl-chip--watch">{A.count(SUBMISSION_ALERTS.length)}</span>
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
                  {done ? A.acknowledged : A.acknowledgeShort}
                </button>
              </div>
            );
          })}
        </div>

        <p className="bl-disclaimer" style={{ marginTop: 14 }}>
          <Icon name="info" size={14} />
          {A.missingNote}
        </p>
      </section>

      {/* ── 7-2 フォロー漏れ通知 ─────────────────────── */}
      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="event_repeat" size={21} />
          <h2 className="bl-h2">{A.overdueTitle}</h2>
          {overdueFollowUps.length > 0 && (
            <span className="bl-chip bl-chip--watch">{A.count(overdueFollowUps.length)}</span>
          )}
        </div>

        {overdueFollowUps.length === 0 ? (
          <div className="bl-empty">
            <Icon name="check_circle" size={38} />
            <p className="bl-body">{A.overdueEmpty}</p>
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
                    {item.note}{" "}
                    {A.overdueNote(
                      item.daysSince,
                      item.nextMeeting ? formatDate(item.nextMeeting, false) : A.notScheduled,
                    )}
                  </span>
                </span>
                <Link href={`/educator/meetings?student=${item.studentId}`} className="bl-btn bl-btn--secondary bl-btn--sm">
                  {A.scheduleMeeting}
                </Link>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
