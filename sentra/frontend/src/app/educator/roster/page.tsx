"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowRight, Loader2 } from "lucide-react";

import { ApiClient } from "@/api/client";
import type { EducatorStudentStatus } from "@/api/models";
import { BandChip, SafetyChip, panel } from "@/components/educator/StatusChips";

type Filter = "all" | "flagged" | "inactive";

const BAND_RANK: Record<EducatorStudentStatus["state_band"], number> = { review: 3, watch: 2, unknown: 1, settled: 0 };

function needsAttention(student: EducatorStudentStatus): number {
  const safety = student.safety_level === "crisis" ? 8 : student.safety_level === "elevated" ? 4 : 0;
  return safety + BAND_RANK[student.state_band];
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
  const logged = useRef(false);

  useEffect(() => {
    let cancelled = false;
    ApiClient.getCohortRoster()
      .then((students) => {
        if (cancelled) return;
        setRoster(students);
        setLoadedAt(Date.now());
        setError(null);
        if (!logged.current && students.length) {
          logged.current = true;
          void ApiClient.recordCohortAccess(students, "roster");
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load roster.");
      });
    return () => { cancelled = true; };
  }, []);

  const visible = useMemo(() => {
    if (!roster) return [];
    const filtered = roster.filter((student) =>
      filter === "all" ? true
      : filter === "flagged" ? (student.safety_level === "crisis" || student.safety_level === "elevated" || student.state_band === "review")
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
      <div className="flex flex-wrap gap-2">
        {(["all", "flagged", "inactive"] as Filter[]).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setFilter(option)}
            className="rounded-full px-4 py-1.5 text-xs font-semibold"
            style={{
              border: "1px solid var(--limestone)",
              backgroundColor: filter === option ? "var(--gold)" : "transparent",
              color: filter === option ? "#000" : "var(--ink-mid)",
            }}
          >
            {option === "all" ? `All (${roster.length})` : option === "flagged" ? "Needs attention" : "Inactive"}
          </button>
        ))}
      </div>

      {roster.length === 0 ? (
        <section className="px-8 py-10 text-center text-sm" style={{ ...panel, color: "var(--ink-mid)" }}>
          No students are sharing derived signals with you yet.
        </section>
      ) : visible.length === 0 ? (
        <section className="px-8 py-8 text-center text-sm" style={{ ...panel, color: "var(--ink-faint)" }}>
          No students match this filter.
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
                    ? `Last reflection ${new Date(student.last_active_day).toLocaleDateString()}`
                    : "No reflections yet"}
                  {student.latest_score !== null && Number.isFinite(student.latest_score)
                    ? ` · signal ${student.latest_score.toFixed(2)}`
                    : ""}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <BandChip band={student.state_band} />
                <SafetyChip level={student.safety_level} />
                <ArrowRight className="h-4 w-4" style={{ color: "var(--ink-faint)" }} />
              </div>
            </Link>
          ))}
        </section>
      )}
    </div>
  );
}
