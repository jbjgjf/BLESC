"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, FileText, Loader2, ShieldAlert } from "lucide-react";

import { ApiClient } from "@/api/client";
import type { CounselorSummarySection, EducatorStudentStatus, SharedSupportSummary } from "@/api/models";
import { BandChip, SafetyChip, panel } from "@/components/educator/StatusChips";
import { useAuth } from "@/lib/auth";

const SECTION_ORDER: CounselorSummarySection["key"][] = [
  "recent_themes",
  "recurring_triggers",
  "intensity_trend",
  "support_needs",
  "protective_factors",
  "suggested_discussion_points",
];

/**
 * Counselor route: structured summaries a student explicitly shared.
 * Read access requires all four gates (membership + roster + consent +
 * active share) — enforced in RLS, not here. No raw journal or chat
 * content ever reaches this page.
 */
export default function OversightPage() {
  const { isEducator, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const [shares, setShares] = useState<SharedSupportSummary[] | null>(null);
  const [roster, setRoster] = useState<EducatorStudentStatus[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !isEducator) router.replace("/");
  }, [authLoading, isEducator, router]);

  useEffect(() => {
    if (authLoading || !isEducator) return;
    let cancelled = false;
    Promise.all([ApiClient.counselorListSharedSummaries(), ApiClient.getCohortRoster()])
      .then(([nextShares, nextRoster]) => {
        if (cancelled) return;
        setShares(nextShares);
        setRoster(nextRoster);
        if (nextShares.length) setSelectedId(nextShares[0].id);
        const uniqueParticipants = [...new Set(nextShares.map((share) => share.participant_id))];
        const students = uniqueParticipants
          .map((participantId) => nextRoster.find((row) => row.participant_id === participantId))
          .filter((student): student is EducatorStudentStatus => Boolean(student));
        if (students.length) void ApiClient.recordCohortAccess(students, "roster");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load shared summaries.");
      });
    return () => { cancelled = true; };
  }, [authLoading, isEducator]);

  if (authLoading || !isEducator) {
    return <div className="flex h-96 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin" style={{ color: "var(--sandstone)" }} /></div>;
  }
  if (error) {
    return <div className="mx-auto max-w-4xl"><div className="flex items-center gap-2 px-6 py-4 text-sm" style={{ ...panel, color: "var(--sienna)" }}><AlertCircle className="h-4 w-4" />{error}</div></div>;
  }
  if (!shares) {
    return <div className="flex h-96 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin" style={{ color: "var(--sandstone)" }} /></div>;
  }

  const selected = shares.find((share) => share.id === selectedId) ?? null;
  const selectedStudent = selected ? roster.find((row) => row.participant_id === selected.participant_id) ?? null : null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <section className="px-8 py-6" style={{ ...panel, backgroundColor: "var(--ivory-warm)" }}>
        <div className="inscription mb-2">Counselor handoff · student-controlled</div>
        <h1 className="text-3xl font-bold" style={{ color: "var(--ink)" }}>Shared support summaries</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed" style={{ color: "var(--ink-mid)" }}>
          Students choose exactly which summary snapshot you can see. Raw journal and chat text is never shown, and
          access ends the moment a student revokes the share or their consent.
        </p>
      </section>

      {shares.length === 0 ? (
        <section className="px-8 py-10 text-center text-sm" style={{ ...panel, color: "var(--ink-mid)" }} data-testid="oversight-empty">
          No student has shared a support summary with you yet.
        </section>
      ) : (
        <div className="grid gap-5 md:grid-cols-[280px_1fr]">
          <section style={panel} data-testid="oversight-student-list">
            <header className="px-5 py-3" style={{ borderBottom: "1px solid var(--limestone)" }}>
              <div className="inscription">Assigned students</div>
            </header>
            {shares.map((share) => (
              <button
                key={share.id}
                type="button"
                onClick={() => setSelectedId(share.id)}
                data-testid={`oversight-share-${share.id}`}
                className="block w-full px-5 py-3 text-left text-sm"
                style={{
                  borderBottom: "1px solid var(--limestone)",
                  backgroundColor: share.id === selectedId ? "var(--ivory-warm)" : "transparent",
                  color: "var(--ink)",
                  cursor: "pointer",
                }}
              >
                <span className="font-mono font-semibold">{share.student_code}</span>
                <span className="mt-0.5 block text-xs" style={{ color: "var(--ink-faint)" }}>
                  shared {new Date(share.shared_at).toLocaleDateString()} · {share.reflection_count} reflections
                </span>
              </button>
            ))}
          </section>

          {selected ? (
            <section style={panel} data-testid="oversight-summary">
              <header className="flex flex-wrap items-center justify-between gap-3 px-6 py-4" style={{ borderBottom: "1px solid var(--limestone)" }}>
                <div>
                  <div className="flex items-center gap-2 font-semibold" style={{ color: "var(--ink)" }}>
                    <FileText className="h-4 w-4" />{selected.student_code}
                  </div>
                  <div className="mt-1 text-xs" style={{ color: "var(--ink-faint)" }}>
                    Snapshot shared {new Date(selected.shared_at).toLocaleString()} · evidence ids only, no raw content
                  </div>
                </div>
                {selectedStudent ? (
                  <div className="flex items-center gap-2">
                    <BandChip band={selectedStudent.state_band} />
                    <SafetyChip level={selectedStudent.safety_level} />
                  </div>
                ) : null}
              </header>

              {selected.summary_json.safety_flags?.length ? (
                <div role="alert" className="px-6 py-4" style={{ borderBottom: "1px solid var(--terracotta)", backgroundColor: "rgba(244,63,94,0.07)" }} data-testid="oversight-safety-flags">
                  <div className="mb-1 flex items-center gap-2 font-semibold" style={{ color: "var(--sienna)" }}>
                    <ShieldAlert className="h-4 w-4" />Safety flags in this summary
                  </div>
                  {selected.summary_json.safety_flags.map((flag) => (
                    <p key={`${flag.event_id}-${flag.timestamp}`} className="text-sm" style={{ color: "var(--ink-mid)" }}>
                      {new Date(flag.timestamp).toLocaleDateString()} · {flag.level} · {flag.reasons.join(", ") || "flag recorded"}
                    </p>
                  ))}
                </div>
              ) : null}

              <div className="grid gap-0 md:grid-cols-2">
                {SECTION_ORDER.map((key) => {
                  const section = selected.summary_json.sections?.find((item) => item.key === key);
                  if (!section) return null;
                  return (
                    <article key={key} className="px-6 py-4" style={{ borderBottom: "1px solid var(--limestone)" }}>
                      <h2 className="mb-2 text-sm font-semibold" style={{ color: "var(--ink)" }}>{section.title}</h2>
                      {section.items.length ? (
                        <ul className="list-disc space-y-1 pl-5 text-sm" style={{ color: "var(--ink-mid)" }}>
                          {section.items.map((item) => <li key={item}>{item}</li>)}
                        </ul>
                      ) : (
                        <p className="text-sm italic" style={{ color: "var(--ink-faint)" }}>No structured data.</p>
                      )}
                    </article>
                  );
                })}
              </div>

              {selectedStudent ? (
                <div className="px-6 py-4 text-xs" style={{ borderBottom: "1px solid var(--limestone)", color: "var(--ink-mid)" }}>
                  <span className="font-semibold">Derived trend:</span>{" "}
                  latest signal {Number.isFinite(selectedStudent.latest_score) ? selectedStudent.latest_score!.toFixed(2) : "—"}
                  {" · "}last reflection {selectedStudent.last_active_day ? new Date(selectedStudent.last_active_day).toLocaleDateString() : "—"}
                </div>
              ) : null}

              <p className="px-6 py-4 text-xs leading-relaxed" style={{ color: "var(--ink-faint)" }}>
                {selected.summary_json.limitations} This view is recorded in the access log and is visible to the student.
              </p>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
