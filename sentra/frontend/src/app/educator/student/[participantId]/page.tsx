"use client";

import Link from "next/link";
import { notFound, useParams } from "next/navigation";
import { Icon, type IconName } from "@/components/ui/Icon";
import { BandChip, TrendChip } from "@/components/blesc/BandChip";
import { MoodTrend } from "@/components/blesc/MoodTrend";
import { FOLLOW_UPS, getStudentDetail } from "@/lib/blesc/fixtures";
import {
  CATEGORY_BY_VALUE,
  STATUSES,
  THEMES,
  formatDate,
  formatDateTime,
  relativeDays,
} from "@/lib/blesc/labels";
import type { SupportAction } from "@/lib/blesc/types";
import styles from "./student.module.css";

const ACTION_META: Record<SupportAction["kind"], { icon: IconName; tone: string }> = {
  ai_detect:   { icon: "auto_awesome",    tone: "alert" },
  meeting:     { icon: "forum",           tone: "blue" },
  guardian:    { icon: "family_restroom", tone: "blue" },
  counselor:   { icon: "support_agent",   tone: "blue" },
  observation: { icon: "visibility",      tone: "neutral" },
  improvement: { icon: "trending_down",   tone: "calm" },
};

export default function StudentDetailPage() {
  const params = useParams<{ participantId: string }>();
  const participantId = params.participantId;
  const student = getStudentDetail(participantId);
  if (!student) notFound();

  const followUp = FOLLOW_UPS.find((item) => item.studentId === participantId);
  const maxCategory = Math.max(1, ...student.categoryCounts.map((item) => item.count));

  return (
    <div className="bl-stack">
      <Link href="/educator/roster" className={styles.back}>
        <Icon name="arrow_back" size={18} />
        生徒一覧
      </Link>

      {/* ── 見出し ───────────────────────────────────── */}
      <header className={styles.head}>
        <div className={styles.identity}>
          <span className={styles.avatar}>
            <Icon name="person" size={26} fill />
          </span>
          <div>
            <h1 className="bl-h1">{student.name}</h1>
            <p className="bl-meta">
              {student.grade}{student.className} ・ 担当 {student.teacher}
            </p>
          </div>
        </div>

        <div className={styles.headChips}>
          <BandChip band={student.band} />
          <TrendChip trend={student.trend} />
          <span className="bl-chip bl-chip--tint">
            <Icon name={STATUSES[student.status].icon} size={15} />
            {STATUSES[student.status].label}
          </span>
        </div>
      </header>

      {/* ── 7-5 緊急性が高い可能性のある内容 ─────────── */}
      {student.urgent && (
        <section className={`${styles.urgent} bl-rise`}>
          <Icon name="priority_high" size={22} fill />
          <div style={{ flex: 1 }}>
            <h2 className="bl-h3">早急な確認が必要な可能性があります</h2>
            <p className="bl-body" style={{ marginTop: 4 }}>{student.urgent.detail}</p>
            <ul className={styles.reasons}>
              {student.urgent.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            <p className="bl-micro" style={{ marginTop: 8 }}>
              {formatDateTime(student.urgent.detectedAt)} ・ 出典：
              {student.urgent.surface === "diary" ? "日記本文" : "対話型AIとのやりとり"}
            </p>
          </div>
        </section>
      )}

      {/* ── 5-3 感情の推移 ───────────────────────────── */}
      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="monitoring" size={21} />
          <h2 className="bl-h2">感情の推移</h2>
          <span className="bl-spacer" />
          <span className="bl-micro">最終提出 {relativeDays(student.lastEntry)}</span>
        </div>
        <MoodTrend series={student.moodSeries} />
      </section>

      <div className="bl-grid bl-grid--2">
        {/* ── 出来事カテゴリの傾向 ─────────────────── */}
        <section className="bl-card bl-rise">
          <div className="bl-card-head">
            <Icon name="calendar_month" size={21} />
            <h2 className="bl-h2">出来事の傾向</h2>
          </div>

          <div className="bl-stack-s">
            {student.categoryCounts
              .filter((item) => item.count > 0)
              .map((item) => {
                const meta = CATEGORY_BY_VALUE[item.category];
                return (
                  <div key={item.category} className={styles.catRow}>
                    <span className="bl-chip bl-chip--tint" style={{ width: "8.4rem" }}>
                      <Icon name={meta.icon} size={16} />
                      {meta.label}
                    </span>
                    <div className="bl-bar" style={{ flex: 1 }}>
                      <span style={{ width: `${(item.count / maxCategory) * 100}%` }} />
                    </div>
                    <span className={styles.catCount}>{item.count}</span>
                  </div>
                );
              })}
          </div>
        </section>

        {/* ── 5-2 AIによる分析観点 ─────────────────── */}
        <section className="bl-card bl-rise">
          <div className="bl-card-head">
            <Icon name="auto_awesome" size={21} />
            <h2 className="bl-h2">注目されている観点</h2>
          </div>

          {student.topThemes.length === 0 ? (
            <p className="bl-body">現在、特に注目されている観点はありません。</p>
          ) : (
            <div className="bl-row" style={{ flexWrap: "wrap", gap: 8 }}>
              {student.topThemes.map((theme) => (
                <span key={theme} className="bl-chip bl-chip--tint">
                  <Icon name={THEMES[theme].icon} size={16} />
                  {THEMES[theme].label}
                </span>
              ))}
            </div>
          )}

          <p className="bl-disclaimer" style={{ marginTop: 14 }}>
            <Icon name="medical_information" size={14} />
            AIは診断を行いません。教員が状況を確認するための補助です。
          </p>
        </section>
      </div>

      {/* ── 6-6 AIタイムライン ───────────────────────── */}
      {student.timeline.length > 0 && (
        <section className="bl-card bl-rise">
          <div className="bl-card-head">
            <Icon name="timeline" size={21} />
            <h2 className="bl-h2">AIタイムライン</h2>
          </div>
          <p className="bl-body" style={{ marginBottom: 18 }}>
            すべての日記と対話を読まなくても、変化の要点を追えるようにまとめています。
          </p>

          <ol className={styles.timeline}>
            {student.timeline.map((item) => (
              <li key={item.date} className={styles.timelineItem} data-dir={item.direction}>
                <span className={styles.timelineDot} />
                <span className={styles.timelineDate}>{formatDate(item.date, false)}</span>
                <span className={styles.timelineText}>
                  {item.text}
                  <span className={styles.timelineSource}>
                    <Icon
                      name={
                        item.source === "followup"
                          ? "forum"
                          : item.source === "submission"
                            ? "event_busy"
                            : "edit_note"
                      }
                      size={13}
                    />
                    {item.source === "followup" ? "対話" : item.source === "submission" ? "提出状況" : "日記"}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* ── 4-7 / 5-3 対話型AIによる補足の要約 ───────── */}
      {student.followUpSummaries.length > 0 && (
        <section className="bl-card bl-rise">
          <div className="bl-card-head">
            <Icon name="forum" size={21} />
            <h2 className="bl-h2">対話型AIによる補足</h2>
          </div>

          <div className="bl-stack-s">
            {student.followUpSummaries.map((item) => (
              <div key={item.date} className={styles.summaryRow}>
                <span className={styles.summaryDate}>{formatDate(item.date, false)}</span>
                <p className="bl-body" style={{ fontSize: "0.89rem" }}>{item.summary}</p>
              </div>
            ))}
          </div>

          <p className="bl-disclaimer" style={{ marginTop: 14 }}>
            <Icon name="shield" size={14} />
            会話の全文は表示されません。生徒が「話したくない」を選んだ内容は記録されていません。
          </p>
        </section>
      )}

      {/* ── 7-3 支援アクション提案 ───────────────────── */}
      {student.suggestions.length > 0 && (
        <section className="bl-card bl-rise">
          <div className="bl-card-head">
            <Icon name="lightbulb" size={21} />
            <h2 className="bl-h2">検討できる支援</h2>
          </div>
          <p className="bl-body" style={{ marginBottom: 16 }}>
            AIが判断を代替するものではありません。次の一手を考えるための材料です。
          </p>

          <div className="bl-grid bl-grid--2">
            {student.suggestions.map((suggestion) => (
              <div key={suggestion.theme} className={styles.suggestion}>
                <div className="bl-row" style={{ gap: 8, marginBottom: 10 }}>
                  <Icon name={THEMES[suggestion.theme].icon} size={19} />
                  <span className="bl-h3">{THEMES[suggestion.theme].label}</span>
                </div>
                <ul className={styles.actionList}>
                  {suggestion.actions.map((action) => (
                    <li key={action}>
                      <Icon name="check" size={15} />
                      {action}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── 7-2 フォローアップ管理 ───────────────────── */}
      {followUp && (
        <section className={`${styles.followUp} bl-rise`} data-state={followUp.state}>
          <Icon name="event_repeat" size={24} />
          <div style={{ flex: 1 }}>
            <h2 className="bl-h3">{followUp.note}</h2>
            <p className="bl-meta" style={{ marginTop: 3 }}>
              前回面談 {formatDate(followUp.lastMeeting, false)}（{followUp.daysSince}日前）
              {followUp.nextMeeting
                ? ` ・ 次回 ${formatDate(followUp.nextMeeting, false)}`
                : " ・ 次回未設定"}
            </p>
          </div>
          <Link
            href={`/educator/meetings?student=${student.id}`}
            className="bl-btn bl-btn--secondary bl-btn--sm"
          >
            面談を記録
          </Link>
        </section>
      )}

      {/* ── 6-3 面談記録 ─────────────────────────────── */}
      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="event_note" size={21} />
          <h2 className="bl-h2">面談記録</h2>
          <span className="bl-spacer" />
          <Link
            href={`/educator/meetings?student=${student.id}`}
            className="bl-btn bl-btn--secondary bl-btn--sm"
          >
            <Icon name="add" size={16} />
            記録する
          </Link>
        </div>

        {student.meetings.length === 0 ? (
          <div className="bl-empty">
            <Icon name="event_note" size={38} />
            <p className="bl-body">まだ面談の記録がありません。</p>
          </div>
        ) : (
          <div className="bl-stack-s">
            {student.meetings.map((meeting) => (
              <article key={meeting.id} className={styles.meeting}>
                <div className="bl-row-between" style={{ marginBottom: 10 }}>
                  <span className="bl-h3">{formatDateTime(meeting.heldAt)}</span>
                  <span className="bl-row" style={{ gap: 8 }}>
                    <span className="bl-micro">{meeting.teacher}</span>
                    <span
                      className={`bl-chip ${
                        meeting.followUpState === "overdue"
                          ? "bl-chip--alert"
                          : meeting.followUpState === "done"
                            ? "bl-chip--calm"
                            : "bl-chip--tint"
                      }`}
                    >
                      {meeting.followUpState === "overdue"
                        ? "フォロー未実施"
                        : meeting.followUpState === "done"
                          ? "対応済み"
                          : "フォロー中"}
                    </span>
                  </span>
                </div>

                <MeetingField label="面談メモ" value={meeting.notes} />
                <MeetingField label="生徒の様子" value={meeting.impression} />
                {meeting.nextAction && (
                  <MeetingField
                    label="次回対応予定"
                    value={`${formatDate(meeting.nextAction, false)} ｜ ${meeting.nextActionNote}`}
                  />
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      {/* ── 7-4 対応履歴タイムライン ─────────────────── */}
      {student.actions.length > 0 && (
        <section className="bl-card bl-rise">
          <div className="bl-card-head">
            <Icon name="history" size={21} />
            <h2 className="bl-h2">対応履歴</h2>
          </div>
          <p className="bl-body" style={{ marginBottom: 18 }}>
            AIの検知と教員の対応をまとめて確認できます。引き継ぎや対応の重複を防ぐために使えます。
          </p>

          <ol className={styles.actions}>
            {student.actions.map((action) => (
              <li key={action.id} className={styles.actionRow} data-tone={ACTION_META[action.kind].tone}>
                <span className={styles.actionIcon}>
                  <Icon name={ACTION_META[action.kind].icon} size={18} fill />
                </span>
                <span className={styles.actionDate}>{formatDate(action.date, false)}</span>
                <span className={styles.actionText}>{action.text}</span>
                <span className="bl-micro">{action.actor}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <p className="bl-disclaimer">
        <Icon name="shield" size={15} />
        この画面の閲覧は記録され、生徒本人が確認できます。日記の本文は表示されません。
      </p>
    </div>
  );
}

function MeetingField({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.meetingField}>
      <span className={styles.meetingLabel}>{label}</span>
      <p className="bl-body" style={{ fontSize: "0.89rem" }}>{value}</p>
    </div>
  );
}
