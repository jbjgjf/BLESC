"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowRight, Loader2 } from "lucide-react";

import { ApiClient } from "@/api/client";
import { t } from "@/lib/i18n";
import type { EducatorStudentStatus } from "@/api/models";
import type { DailySubmissionSummary } from "@/lib/dailySubmissions";
import { AttentionChip, BaselineContextLine, NonDiagnosticNotice, ObservationLine, hasShowableObservation, panel } from "@/components/educator/StatusChips";

type Filter = "all" | "flagged" | "inactive";

// Ordering is by observation only. Ranking by the inferred band would put the
// classification back into the interface through the sort order.

function needsAttention(student: EducatorStudentStatus): number {
  const safety = student.safety_level === "crisis" ? 8 : student.safety_level === "elevated" ? 4 : 0;
  return safety;
}

function isInactive(student: EducatorStudentStatus, referenceTime: number): boolean {
  if (!student.last_active_day) return true;
  return referenceTime - new Date(student.last_active_day).getTime() > 7 * 24 * 60 * 60 * 1000;
}

export default function EducatorRosterPage() {
  const [roster, setRoster] = useState<EducatorStudentStatus[] | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);
  const [submissions, setSubmissions] = useState<DailySubmissionSummary | null>(null);
  const [submissionsError, setSubmissionsError] = useState(false);
  const logged = useRef(false);

  useEffect(() => {
    let cancelled = false;
    ApiClient.getCohortRoster()
      .then((students) => {
        if (cancelled) return;
        setRoster(students);
        setLoadedAt(Date.now());
        setError(null);
        // Its own failure state: a roster that loaded is still worth showing
        // when the submission read is not, and a blank grid would read as
        // "nobody wrote".
        ApiClient.getCohortDailySubmissions(students.map((student) => student.participant_id))
          .then((summary) => { if (!cancelled) setSubmissions(summary); })
          .catch(() => { if (!cancelled) setSubmissionsError(true); });
        if (!logged.current && students.length) {
          logged.current = true;
          void ApiClient.recordCohortAccess(students, "roster");
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t.educator.roster.loadFailed);
      });
    return () => { cancelled = true; };
  }, []);

  const visible = useMemo(() => {
    if (!roster) return [];
    const filtered = roster.filter((student) =>
      filter === "all" ? true
      : filter === "flagged" ? hasShowableObservation(student)
      : isInactive(student, loadedAt),
    );
    return [...filtered].sort((a, b) => needsAttention(b) - needsAttention(a) || a.code.localeCompare(b.code));
  }, [roster, filter, loadedAt]);

  if (error) {
    return <div className="flex items-center gap-2 px-6 py-4 text-sm" style={{ ...panel, color: "var(--sienna)" }}><AlertCircle className="h-4 w-4" />{error}</div>;
  }
  if (!roster) {
    return <div className="flex h-48 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" style={{ color: "var(--sandstone)" }} /></div>;
  }

  return (
    <div className="space-y-4">
      {roster.length > 0 ? (
        <DailySubmissions roster={roster} summary={submissions} failed={submissionsError} />
      ) : null}
      <div className="flex flex-wrap gap-2">
        {(["all", "flagged", "inactive"] as Filter[]).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setFilter(option)}
            className="rounded-full px-4 py-1.5 text-xs font-semibold transition-all"
            style={{
              border: filter === option ? "1px solid transparent" : "1px solid var(--blue-base)",
              background: filter === option ? "var(--blue-base)" : "#ffffff",
              color: "var(--ink)",
              cursor: "pointer",
            }}
          >
            {option === "all"
              ? t.educator.roster.filterAll(roster.length)
              : option === "flagged"
                ? t.educator.roster.filterFlagged
                : t.educator.roster.filterInactive}
          </button>
        ))}
      </div>

      {roster.length === 0 ? (
        <section className="px-8 py-10 text-center text-sm" style={{ ...panel, color: "var(--ink-mid)" }}>
          {t.educator.roster.emptyNoConsent}
        </section>
      ) : visible.length === 0 ? (
        <section className="px-8 py-8 text-center text-sm" style={{ ...panel, color: "var(--ink-faint)" }}>
          {t.educator.roster.emptyNoMatch}
        </section>
      ) : (
        <section style={panel}>
          {visible.map((student) => (
            <Link
              key={student.participant_id}
              href={`/educator/student/${student.participant_id}`}
              className="flex flex-wrap items-center justify-between gap-3 px-6 py-4"
              style={{ borderBottom: "1px solid var(--limestone)", textDecoration: "none" }}
            >
              <div className="min-w-0">
                <div className="font-semibold" style={{ color: "var(--ink)" }}>
                  {student.display_name ?? student.code}
                  <span className="ml-2 font-mono text-xs" style={{ color: "var(--ink-faint)" }}>{student.code}</span>
                </div>
                <div className="mt-1 text-xs" style={{ color: "var(--ink-faint)" }}>
                  {student.last_active_day
                    ? t.educator.roster.lastEntry(new Date(student.last_active_day).toLocaleDateString("ja-JP"))
                    : t.educator.roster.noEntries}
                </div>
                <div className="mt-1.5 space-y-0.5">
                  <ObservationLine student={student} />
                  {hasShowableObservation(student) ? <BaselineContextLine student={student} /> : null}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <AttentionChip student={student} />
                <ArrowRight className="h-4 w-4" style={{ color: "var(--ink-faint)" }} />
              </div>
            </Link>
          ))}
        </section>
      )}
      <NonDiagnosticNotice />
    </div>
  );
}

function shortDay(day: string): string {
  const [, month, date] = day.split("-");
  return `${Number(month)}/${Number(date)}`;
}

function DailySubmissions({
  roster,
  summary,
  failed,
}: {
  roster: EducatorStudentStatus[];
  summary: DailySubmissionSummary | null;
  failed: boolean;
}) {
  const copy = t.educator.roster;
  if (failed) {
    return (
      <section className="flex items-center gap-2 px-6 py-4 text-sm" style={{ ...panel, color: "var(--sienna)" }} data-testid="daily-submissions-error">
        <AlertCircle className="h-4 w-4" />{copy.submissionsLoadFailed}
      </section>
    );
  }
  if (!summary) {
    return (
      <section className="flex h-24 items-center justify-center" style={panel}>
        <Loader2 className="h-5 w-5 animate-spin" style={{ color: "var(--sandstone)" }} />
      </section>
    );
  }
  const students = [...roster].sort((a, b) => (a.display_name ?? a.code).localeCompare(b.display_name ?? b.code, "ja"));
  return (
    <section className="px-6 py-5" style={panel} data-testid="daily-submissions">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold" style={{ color: "var(--ink)" }}>{copy.submissionsTitle}</h2>
        <span className="text-sm font-semibold" style={{ color: "var(--ink)" }} data-testid="daily-submissions-today">
          {copy.submissionsToday(summary.submittedToday, summary.total)}
        </span>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs" style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th scope="col" className="py-1 pr-3 text-left font-normal" style={{ color: "var(--ink-faint)" }} />
              {summary.days.map((day) => (
                <th
                  key={day}
                  scope="col"
                  className="px-1 py-1 text-center font-normal"
                  style={{ color: day === summary.today ? "var(--ink)" : "var(--ink-faint)", fontWeight: day === summary.today ? 600 : 400 }}
                >
                  {shortDay(day)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {students.map((student) => {
              const days = summary.byParticipant.get(student.participant_id);
              return (
                <tr key={student.participant_id} style={{ borderTop: "1px solid var(--limestone)" }} data-testid="daily-submissions-row">
                  <th scope="row" className="max-w-[10rem] truncate py-1.5 pr-3 text-left font-medium" style={{ color: "var(--ink)" }}>
                    {student.display_name ?? student.code}
                  </th>
                  {summary.days.map((day) => {
                    const done = days?.has(day) ?? false;
                    return (
                      <td key={day} className="px-1 py-1.5 text-center" title={`${shortDay(day)} ${done ? copy.submitted : copy.notSubmitted}`}>
                        <span aria-label={done ? copy.submitted : copy.notSubmitted} style={{ color: done ? "var(--ink)" : "var(--ink-faint)" }}>
                          {done ? "●" : "・"}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs" style={{ color: "var(--ink-faint)" }}>{copy.submissionsNote}</p>
    </section>
  );
}
