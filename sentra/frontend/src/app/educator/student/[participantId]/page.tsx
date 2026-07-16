"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AlertCircle, ArrowLeft, Loader2, ShieldAlert } from "lucide-react";

import { ApiClient } from "@/api/client";
import { BandChip, SafetyChip, panel } from "@/components/educator/StatusChips";

type Overview = Awaited<ReturnType<typeof ApiClient.getStudentOverviewForEducator>>;

export default function EducatorStudentPage() {
  const params = useParams<{ participantId: string }>();
  const participantId = params.participantId;
  const [overview, setOverview] = useState<Overview | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!participantId) return;
    let cancelled = false;
    ApiClient.getStudentOverviewForEducator(participantId)
      .then((next) => { if (!cancelled) setOverview(next); })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load student overview.");
      });
    return () => { cancelled = true; };
  }, [participantId]);

  if (error) {
    return <div className="flex items-center gap-2 px-6 py-4 text-sm" style={{ ...panel, color: "var(--sienna)" }}><AlertCircle className="h-4 w-4" />{error}</div>;
  }
  if (overview === undefined) {
    return <div className="flex h-48 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" style={{ color: "var(--sandstone)" }} /></div>;
  }
  if (overview === null) {
    return (
      <section className="px-8 py-10 text-center text-sm" style={{ ...panel, color: "var(--ink-mid)" }}>
        This student is not sharing derived signals with you (no active roster link and consent).
        <div className="mt-3"><Link href="/educator/roster" style={{ color: "var(--gold-deep)", fontWeight: 600 }}>Back to roster</Link></div>
      </section>
    );
  }

  const { student, signals, themes, safetyRuns } = overview;

  return (
    <div className="space-y-5">
      <Link href="/educator/roster" className="inline-flex items-center gap-1 text-sm" style={{ color: "var(--ink-faint)" }}>
        <ArrowLeft className="h-4 w-4" />Roster
      </Link>

      <section className="flex flex-wrap items-center justify-between gap-3 px-7 py-5" style={panel}>
        <div>
          <div className="inscription mb-1">Student overview · derived data only</div>
          <div className="text-xl font-bold" style={{ color: "var(--ink)" }}>
            {student.display_name ?? student.code}
            <span className="ml-2 font-mono text-xs font-normal" style={{ color: "var(--ink-faint)" }}>{student.code}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <BandChip band={student.state_band} />
          <SafetyChip level={student.safety_level} />
        </div>
      </section>

      {safetyRuns.length ? (
        <section className="px-7 py-5" style={{ ...panel, borderLeft: "3px solid var(--terracotta)" }}>
          <div className="mb-2 flex items-center gap-2 font-semibold" style={{ color: "var(--sienna)" }}>
            <ShieldAlert className="h-4 w-4" />Safety flags
          </div>
          <ul className="space-y-1 text-sm" style={{ color: "var(--ink-mid)" }}>
            {safetyRuns.map((run) => (
              <li key={run.occurred_at}>{new Date(run.occurred_at).toLocaleDateString()} · {run.level}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs" style={{ color: "var(--ink-faint)" }}>
            Route crisis flags through your school&apos;s designated support staff — see the Alerts tab for the protocol.
          </p>
        </section>
      ) : null}

      <div className="grid gap-5 md:grid-cols-2">
        <section style={panel}>
          <header className="px-6 py-4" style={{ borderBottom: "1px solid var(--limestone)" }}>
            <div className="inscription">Recent signals</div>
          </header>
          {signals.length ? (
            <ul>
              {signals.slice(0, 10).map((signal) => (
                <li key={signal.day} className="flex items-center justify-between px-6 py-2.5 text-sm" style={{ borderBottom: "1px solid var(--limestone)", color: "var(--ink-mid)" }}>
                  <span>{new Date(signal.day).toLocaleDateString()}</span>
                  <span className="font-mono">{Number.isFinite(signal.score) ? signal.score!.toFixed(2) : "—"}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-6 py-6 text-sm italic" style={{ color: "var(--ink-faint)" }}>No reflections yet.</p>
          )}
        </section>

        <section style={panel}>
          <header className="px-6 py-4" style={{ borderBottom: "1px solid var(--limestone)" }}>
            <div className="inscription">Recurring themes</div>
          </header>
          {themes.length ? (
            <ul>
              {themes.map((theme) => (
                <li key={theme.label} className="flex items-center justify-between px-6 py-2.5 text-sm" style={{ borderBottom: "1px solid var(--limestone)", color: "var(--ink-mid)" }}>
                  <span>{theme.label}</span>
                  <span className="text-xs" style={{ color: "var(--ink-faint)" }}>{theme.count}×</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-6 py-6 text-sm italic" style={{ color: "var(--ink-faint)" }}>No recurring themes yet.</p>
          )}
          <p className="px-6 py-4 text-xs leading-relaxed" style={{ color: "var(--ink-faint)", borderTop: "1px solid var(--limestone)" }}>
            Theme labels are derived, non-verbatim extractions. For a fuller picture, the student can choose to
            share a counselor-ready summary from their own Summary page — you cannot generate it for them.
          </p>
        </section>
      </div>

      <p className="px-1 text-xs" style={{ color: "var(--ink-faint)" }}>
        This view was recorded in the access log and is visible to the student. Consent can be revoked by the
        student at any time.
      </p>
    </div>
  );
}
