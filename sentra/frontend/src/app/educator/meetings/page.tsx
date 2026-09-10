"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { WaveBed } from "@/components/ui/WaveBed";
import { ALL_MEETINGS, CLASS_ROSTER, MEETING_SUPPORT } from "@/lib/blesc/fixtures";
import { TODAY, formatDate, formatDateTime } from "@/lib/blesc/labels";
import { t } from "@/lib/i18n";
import styles from "./meetings.module.css";

/** この画面の文言。参照が多いので短く束ねる。 */
const M = t.educatorDemo.meetings;

export default function MeetingsPage() {
  const params = useSearchParams();
  const preselected = params.get("student");

  const [studentId, setStudentId] = useState(preselected ?? "");
  const [notes, setNotes] = useState("");
  const [impression, setImpression] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [nextNote, setNextNote] = useState("");
  const [saved, setSaved] = useState(false);

  const [supportOpen, setSupportOpen] = useState(false);
  const [supportLoading, setSupportLoading] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  const meetings = useMemo(
    () => [...ALL_MEETINGS].sort((a, b) => b.heldAt.localeCompare(a.heldAt)),
    [],
  );

  const selected = CLASS_ROSTER.find((student) => student.id === studentId);

  const openSupport = () => {
    setSupportOpen(true);
    setSupportLoading(true);
    window.setTimeout(() => setSupportLoading(false), 1400);
  };

  /** AIによる面談内容の要約作成（追加機能）。 */
  const makeSummary = () => {
    setSummaryLoading(true);
    setSummary(null);
    window.setTimeout(() => {
      setSummaryLoading(false);
      setSummary(
        [
          notes.trim() ? M.summaryWithNotes : M.summaryWithoutNotes,
          impression.trim() ? M.summaryImpression(impression.trim()) : "",
          nextAction
            ? M.summaryNextAction(formatDate(nextAction, false))
            : M.summaryNoNextAction,
        ]
          .filter(Boolean)
          .join(" "),
      );
    }, 1600);
  };

  const save = () => {
    if (!studentId || !notes.trim()) return;
    setSaved(true);
    window.setTimeout(() => setSaved(false), 3200);
  };

  return (
    <div className="bl-stack">
      <header style={{ padding: "2px 2px 0" }}>
        <h1 className="bl-h1">{M.title}</h1>
        <p className="bl-meta" style={{ marginTop: 3 }}>
          {M.intro}
        </p>
      </header>

      {/* ── 6-3 面談記録の作成 ───────────────────────── */}
      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="edit_note" size={21} />
          <h2 className="bl-h2">{M.recordTitle}</h2>
        </div>

        <div className="bl-stack">
          <div>
            <label className="bl-label" htmlFor="student">
              <Icon name="person" size={19} />
              {M.student}
              <span className="bl-required">{M.required}</span>
            </label>
            <select
              id="student"
              className={styles.select}
              value={studentId}
              onChange={(event) => {
                setStudentId(event.target.value);
                setSupportOpen(false);
                setSummary(null);
              }}
            >
              <option value="">{M.selectPlaceholder}</option>
              {CLASS_ROSTER.map((student) => (
                <option key={student.id} value={student.id}>
                  {M.studentOption(student.name, student.grade, student.className)}
                </option>
              ))}
            </select>
          </div>

          {selected && (
            <div className={styles.supportBar}>
              <Icon name="auto_awesome" size={20} />
              <span style={{ flex: 1 }}>
                <span className="bl-h3">{M.supportTitle}</span>
                <span className="bl-micro" style={{ display: "block", marginTop: 2 }}>
                  {M.supportHint(selected.name)}
                </span>
              </span>
              <button type="button" className="bl-btn bl-btn--primary bl-btn--sm" onClick={openSupport}>
                {M.makeQuestions}
              </button>
            </div>
          )}

          {/* ── AI面談サポート ─────────────────────── */}
          {supportOpen && selected && (
            <div className={`${styles.support} bl-pop`}>
              <WaveBed active={supportLoading} height={120} />

              <div className={styles.supportHead}>
                <Icon name="auto_awesome" size={20} fill />
                <span className="bl-h3">{M.supportHeading(selected.name)}</span>
                <span className="bl-spacer" />
                <button
                  type="button"
                  className="bl-icon-btn"
                  aria-label={M.close}
                  onClick={() => setSupportOpen(false)}
                >
                  <Icon name="close" size={19} />
                </button>
              </div>

              {supportLoading ? (
                <p className="bl-body" style={{ position: "relative", zIndex: 2 }}>
                  {M.loadingRecords}
                </p>
              ) : (
                <div className={styles.supportBody}>
                  <div>
                    <h4 className={styles.supportLabel}>{M.questionsLabel}</h4>
                    <ol className={styles.questions}>
                      {MEETING_SUPPORT.questions.map((question) => (
                        <li key={question.text}>
                          <span className={styles.questionText}>{question.text}</span>
                          <span className={styles.questionWhy}>{question.rationale}</span>
                        </li>
                      ))}
                    </ol>
                  </div>

                  <div>
                    <h4 className={styles.supportLabel}>{M.contextLabel}</h4>
                    <ul className={styles.bullets}>
                      {MEETING_SUPPORT.context.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>

                  <div className={styles.cautions}>
                    <h4 className={styles.supportLabel}>
                      <Icon name="warning" size={16} fill />
                      {M.cautionsLabel}
                    </h4>
                    <ul className={styles.bullets}>
                      {MEETING_SUPPORT.cautions.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </div>
          )}

          <div>
            <label className="bl-label" htmlFor="notes">
              <Icon name="notes" size={19} />
              {M.notes}
              <span className="bl-required">{M.required}</span>
            </label>
            <textarea
              id="notes"
              className="bl-textarea"
              placeholder={M.notesPlaceholder}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>

          <div>
            <label className="bl-label" htmlFor="impression">
              <Icon name="visibility" size={19} />
              {M.impression}
              <span className="bl-optional">任意</span>
            </label>
            <textarea
              id="impression"
              className="bl-textarea"
              placeholder={M.impressionPlaceholder}
              value={impression}
              onChange={(event) => setImpression(event.target.value)}
            />
          </div>

          <div className="bl-grid bl-grid--2">
            <div>
              <label className="bl-label" htmlFor="nextAction">
                <Icon name="event_note" size={19} />
                {M.nextAction}
                <span className="bl-optional">{M.optional}</span>
              </label>
              <input
                id="nextAction"
                type="date"
                className="bl-input"
                min={TODAY}
                value={nextAction}
                onChange={(event) => setNextAction(event.target.value)}
              />
            </div>
            <div>
              <label className="bl-label" htmlFor="nextNote">
                <Icon name="description" size={19} />
                {M.nextNote}
                <span className="bl-optional">{M.optional}</span>
              </label>
              <input
                id="nextNote"
                type="text"
                className="bl-input"
                placeholder={M.nextNotePlaceholder}
                value={nextNote}
                onChange={(event) => setNextNote(event.target.value)}
              />
            </div>
          </div>

          {/* ── AIによる要約作成（追加機能） ────────── */}
          <div className={styles.summaryBox}>
            <div className="bl-row" style={{ gap: 10, flexWrap: "wrap" }}>
              <Icon name="summarize" size={20} />
              <span className="bl-h3" style={{ flex: 1 }}>{M.summaryTitle}</span>
              <button
                type="button"
                className="bl-btn bl-btn--secondary bl-btn--sm"
                onClick={makeSummary}
                disabled={summaryLoading}
              >
                {summaryLoading ? M.summarising : M.summarise}
              </button>
            </div>

            {summaryLoading && (
              <div className={styles.summaryTyping} aria-label={M.summaryPending}>
                <span />
                <span />
                <span />
              </div>
            )}

            {summary && <p className="bl-body" style={{ marginTop: 11 }}>{summary}</p>}
          </div>

          <div className="bl-row-between" style={{ flexWrap: "wrap", gap: 12 }}>
            <p className="bl-disclaimer">
              <Icon name="lock" size={15} />
              {M.visibility}
            </p>
            <button
              type="button"
              className="bl-btn bl-btn--primary"
              onClick={save}
              disabled={!studentId || !notes.trim()}
            >
              <Icon name="check" size={19} />
              {M.save}
            </button>
          </div>

          {saved && (
            <div className="bl-notice bl-pop" style={{ background: "var(--bl-calm-bg)", borderColor: "var(--bl-calm-line)", color: "var(--bl-calm-ink)" }}>
              <Icon name="check_circle" size={19} fill style={{ color: "var(--bl-calm)" }} />
              {M.saved}
            </div>
          )}
        </div>
      </section>

      {/* ── 6-3 面談記録の一覧 ───────────────────────── */}
      <section className="bl-card bl-rise">
        <div className="bl-card-head">
          <Icon name="history" size={21} />
          <h2 className="bl-h2">{M.historyTitle}</h2>
        </div>

        <div className="bl-stack-s">
          {meetings.map((meeting) => (
            <article key={meeting.id} className={styles.meeting}>
              <div className="bl-row-between" style={{ flexWrap: "wrap", gap: 8 }}>
                <span className="bl-row" style={{ gap: 10 }}>
                  <Link href={`/educator/student/${meeting.studentId}`} className={styles.name}>
                    {meeting.studentName}
                  </Link>
                  <span className="bl-micro">{formatDateTime(meeting.heldAt)}</span>
                </span>
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
                      ? M.followUp.overdue
                      : meeting.followUpState === "done"
                        ? M.followUp.done
                        : M.followUp.ongoing}
                  </span>
                </span>
              </div>

              <p className="bl-body" style={{ fontSize: "0.89rem", marginTop: 9 }}>{meeting.notes}</p>

              {meeting.nextAction && (
                <p className="bl-micro" style={{ marginTop: 8 }}>
                  {M.nextLine(
                    formatDate(meeting.nextAction, false),
                    meeting.nextActionNote,
                  )}
                </p>
              )}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
