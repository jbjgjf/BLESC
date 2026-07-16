"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, Loader2 } from "lucide-react";

import { ApiClient } from "@/api/client";
import type { EducatorStudentStatus } from "@/api/models";
import { panel } from "@/components/educator/StatusChips";

const MIN_COHORT_FOR_BREAKDOWN = 3;

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="px-6 py-5" style={panel}>
      <div className="inscription mb-2">{label}</div>
      <div className="text-4xl font-bold" style={{ color: "var(--ink)" }}>{value}</div>
      {hint ? <div className="mt-1 text-xs" style={{ color: "var(--ink-faint)" }}>{hint}</div> : null}
    </div>
  );
}

export default function EducatorOverviewPage() {
  const [roster, setRoster] = useState<EducatorStudentStatus[] | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    ApiClient.getCohortRoster()
      .then((students) => {
        if (cancelled) return;
        setRoster(students);
        setLoadedAt(Date.now());
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load cohort overview.");
      });
    return () => { cancelled = true; };
  }, []);

  if (error) {
    return (
      <div className="flex items-center gap-2 px-6 py-4 text-sm" style={{ ...panel, color: "var(--sienna)" }}>
        <AlertCircle className="h-4 w-4" />{error}
      </div>
    );
  }
  if (!roster) {
    return (
      <div className="flex h-48 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin" style={{ color: "var(--sandstone)" }} />
      </div>
    );
  }
  if (roster.length === 0) {
    return (
      <section className="px-8 py-10 text-center" style={panel}>
        <h1 className="text-2xl font-bold" style={{ color: "var(--ink)" }}>Cohort overview</h1>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed" style={{ color: "var(--ink-mid)" }}>
          No students are sharing derived signals with you yet. Students appear here after your org admin links
          them to you <em>and</em> they grant consent from their Sharing page.
        </p>
      </section>
    );
  }

  const activeLast7d = roster.filter((student) =>
    student.last_active_day && loadedAt - new Date(student.last_active_day).getTime() <= 7 * 24 * 60 * 60 * 1000,
  ).length;
  const flagged = roster.filter((student) => student.safety_level === "crisis" || student.safety_level === "elevated").length;
  const review = roster.filter((student) => student.state_band === "review").length;
  const suppress = roster.length < MIN_COHORT_FOR_BREAKDOWN;

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Consented students" value={String(roster.length)} />
        <Tile label="Active last 7 days" value={suppress ? "—" : String(activeLast7d)} hint={suppress ? "hidden for small cohorts" : undefined} />
        <Tile label="Open safety flags" value={suppress ? "—" : String(flagged)} hint={suppress ? "hidden for small cohorts" : "crisis or elevated"} />
        <Tile label="In review band" value={suppress ? "—" : String(review)} hint={suppress ? "hidden for small cohorts" : "signal ≥ 2.0"} />
      </div>
      {suppress ? (
        <p className="px-1 text-xs" style={{ color: "var(--ink-faint)" }}>
          Breakdown tiles are suppressed for cohorts smaller than {MIN_COHORT_FOR_BREAKDOWN} students so an
          aggregate can never describe a single person. Use the <Link href="/educator/roster" style={{ color: "var(--gold-deep)", fontWeight: 600 }}>roster</Link> for individual status.
        </p>
      ) : null}
    </div>
  );
}
