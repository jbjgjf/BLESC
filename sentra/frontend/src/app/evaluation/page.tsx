"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowRight, Loader2, ShieldCheck } from "lucide-react";

import { supabase } from "@/lib/supabase/client";
import { evalPanel as panel, VerdictBadge, type EvaluationRunRow } from "@/components/evaluation/shared";

export default function EvaluationPage() {
  const [runs, setRuns] = useState<EvaluationRunRow[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const access = await supabase.from("evaluation_access").select("id").eq("status", "active").limit(1);
      if (cancelled) return;
      if (access.error || !access.data?.length) {
        setDenied(true);
        return;
      }
      const result = await supabase
        .from("evaluation_runs")
        .select("id, label, mode, status, verdict, totals_json, gates_json, findings_json, recommended_actions_json, limitations, estimated_cost_usd, actual_cost_usd, openai_eval_refs, started_at, finished_at")
        .order("started_at", { ascending: false })
        .limit(25);
      if (cancelled) return;
      if (result.error) setError(result.error.message);
      else setRuns((result.data ?? []) as unknown as EvaluationRunRow[]);
    })().catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load evaluation runs.");
    });
    return () => { cancelled = true; };
  }, []);

  if (denied) {
    return (
      <div className="mx-auto max-w-3xl">
        <section className="px-8 py-10 text-center" style={panel} data-testid="evaluation-denied">
          <ShieldCheck className="mx-auto mb-3 h-8 w-8" style={{ color: "var(--ink-faint)" }} />
          <p className="text-sm" style={{ color: "var(--ink-mid)" }}>
            Evaluation results are visible to designated reviewers only.
          </p>
        </section>
      </div>
    );
  }
  if (error) {
    return <div className="mx-auto max-w-3xl"><div className="flex items-center gap-2 px-6 py-4 text-sm" style={{ ...panel, color: "var(--sienna)" }}><AlertCircle className="h-4 w-4" />{error}</div></div>;
  }
  if (!runs) {
    return <div className="flex h-96 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin" style={{ color: "var(--sandstone)" }} /></div>;
  }

  const latest = runs[0];

  return (
    <div className="mx-auto max-w-4xl space-y-6" data-testid="evaluation-dashboard">
      <section className="px-8 py-6" style={{ ...panel, backgroundColor: "var(--ivory-warm)" }}>
        <div className="inscription mb-2">Synthetic-user evaluation · no real students</div>
        <h1 className="text-3xl font-bold" style={{ color: "var(--ink)" }}>Is BLESC safe to ship?</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed" style={{ color: "var(--ink-mid)" }}>
          Every run sends synthetic students through the real product — same login, same screens — and checks
          safety, privacy, and consent behavior against hard pass gates.
        </p>
      </section>

      {latest ? (
        <section className="px-7 py-6" style={panel}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="inscription mb-2">Latest run · {latest.label}</div>
              <VerdictBadge verdict={latest.verdict} large />
            </div>
            <Link href={`/evaluation/runs/${latest.id}`} className="inline-flex items-center gap-1 text-sm font-semibold" style={{ color: "var(--gold-deep)" }}>
              Full report <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {[
              ["Critical safety violations", latest.gates_json?.critical_safety_violations],
              ["Missed escalations", latest.gates_json?.missed_escalations],
              ["False escalations", latest.gates_json?.false_escalations],
              ["Unsupported inferences", latest.gates_json?.unsupported_inferences],
              ["Privacy/consent violations", latest.gates_json?.privacy_consent_violations],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-md px-3 py-3 text-center" style={{ border: "1px solid var(--limestone)" }}>
                <div className="text-2xl font-bold" style={{ color: Number(value) > 0 ? "var(--terracotta)" : "var(--ink)" }}>{Number(value ?? 0)}</div>
                <div className="mt-1 text-[11px] leading-tight" style={{ color: "var(--ink-faint)" }}>{label}</div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs" style={{ color: "var(--ink-faint)" }}>
            {latest.totals_json?.users ?? 0} students · {latest.totals_json?.scenarios ?? 0} scenarios · {latest.totals_json?.conversations ?? 0} conversations
            {typeof latest.actual_cost_usd === "number" ? ` · ~US$${latest.actual_cost_usd.toFixed(2)}` : ""}
          </p>
        </section>
      ) : (
        <section className="px-8 py-10 text-center text-sm" style={{ ...panel, color: "var(--ink-mid)" }}>
          No evaluation runs yet. Start one with <code>npm run smoke</code> in <code>sentra/eval</code>.
        </section>
      )}

      {runs.length > 1 ? (
        <section style={panel}>
          <header className="px-6 py-3" style={{ borderBottom: "1px solid var(--limestone)" }}>
            <div className="inscription">Previous runs</div>
          </header>
          {runs.slice(1).map((row) => (
            <Link key={row.id} href={`/evaluation/runs/${row.id}`} className="flex flex-wrap items-center justify-between gap-2 px-6 py-3 text-sm" style={{ borderBottom: "1px solid var(--limestone)", color: "var(--ink)", textDecoration: "none" }}>
              <span className="font-semibold">{row.label}</span>
              <span className="flex items-center gap-3">
                <VerdictBadge verdict={row.verdict} />
                <time className="text-xs" style={{ color: "var(--ink-faint)" }}>{new Date(row.started_at).toLocaleString()}</time>
              </span>
            </Link>
          ))}
        </section>
      ) : null}
    </div>
  );
}
