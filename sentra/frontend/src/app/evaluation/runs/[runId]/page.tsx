"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AlertCircle, ArrowLeft, Download, Loader2 } from "lucide-react";

import { supabase } from "@/lib/supabase/client";
import { evalPanel as panel, VerdictBadge, type EvaluationRunRow } from "@/components/evaluation/shared";

type CaseRow = {
  id: string;
  case_key: string;
  persona_id: string;
  scenario_family: string;
  seed: number;
  status: string;
  failure_kinds: string[];
  human_review: boolean;
  human_review_reason: string | null;
  judge_json: { verdict?: string; rationale?: string } | null;
  trace_ref: string | null;
};

type ArtifactRow = {
  id: string;
  kind: string;
  content_type: string;
  content_text: string | null;
  storage_path: string | null;
};

export default function EvaluationRunPage() {
  const params = useParams<{ runId: string }>();
  const [run, setRun] = useState<EvaluationRunRow | null>(null);
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params.runId) return;
    let cancelled = false;
    (async () => {
      const [runResult, caseResult, artifactResult] = await Promise.all([
        supabase.from("evaluation_runs").select("*").eq("id", params.runId).maybeSingle(),
        supabase.from("evaluation_cases").select("id, case_key, persona_id, scenario_family, seed, status, failure_kinds, human_review, human_review_reason, judge_json, trace_ref").eq("run_id", params.runId).order("case_key"),
        supabase.from("evaluation_artifacts").select("id, kind, content_type, content_text, storage_path").eq("run_id", params.runId),
      ]);
      if (cancelled) return;
      if (runResult.error || !runResult.data) { setError(runResult.error?.message ?? "Run not found or not visible."); return; }
      setRun(runResult.data as unknown as EvaluationRunRow);
      setCases((caseResult.data ?? []) as unknown as CaseRow[]);
      setArtifacts((artifactResult.data ?? []) as unknown as ArtifactRow[]);
    })().catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load run.");
    });
    return () => { cancelled = true; };
  }, [params.runId]);

  if (error) {
    return <div className="mx-auto max-w-3xl"><div className="flex items-center gap-2 px-6 py-4 text-sm" style={{ ...panel, color: "var(--sienna)" }}><AlertCircle className="h-4 w-4" />{error}</div></div>;
  }
  if (!run) {
    return <div className="flex h-96 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin" style={{ color: "var(--sandstone)" }} /></div>;
  }

  const failures = cases.filter((row) => row.status === "failed");
  const reviewQueue = cases.filter((row) => row.human_review);
  const downloadArtifact = (artifact: ArtifactRow) => {
    if (!artifact.content_text) return;
    const url = URL.createObjectURL(new Blob([artifact.content_text], { type: artifact.content_type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${run.label}-${artifact.kind}.${artifact.kind === "expert_csv" ? "csv" : artifact.kind === "executive_html" ? "html" : "txt"}`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6" data-testid="evaluation-run-detail">
      <Link href="/evaluation" className="inline-flex items-center gap-1 text-sm" style={{ color: "var(--ink-faint)" }}>
        <ArrowLeft className="h-4 w-4" />All runs
      </Link>

      <section className="px-7 py-6" style={panel}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="inscription mb-2">{run.label} · {run.mode} run</div>
            <VerdictBadge verdict={run.verdict} large />
          </div>
          <div className="text-right text-xs" style={{ color: "var(--ink-faint)" }}>
            <div>{new Date(run.started_at).toLocaleString()}{run.finished_at ? ` → ${new Date(run.finished_at).toLocaleTimeString()}` : ""}</div>
            <div>est. US${run.estimated_cost_usd?.toFixed(2) ?? "—"} · actual ~US${run.actual_cost_usd?.toFixed(2) ?? "—"}</div>
            {run.openai_eval_refs?.length ? <div>OpenAI eval: {run.openai_eval_refs.join(" · ")}</div> : null}
          </div>
        </div>
        <p className="mt-3 text-sm" style={{ color: "var(--ink-mid)" }}>
          {run.totals_json?.users ?? 0} synthetic students · {run.totals_json?.scenarios ?? 0} scenarios · {run.totals_json?.conversations ?? 0} conversations
          — {run.totals_json?.passed ?? 0} passed / {run.totals_json?.failed ?? 0} failed / {run.totals_json?.incomplete ?? 0} incomplete
        </p>
      </section>

      <section style={panel}>
        <header className="px-6 py-3" style={{ borderBottom: "1px solid var(--limestone)" }}><div className="inscription">Three most important findings</div></header>
        <ol className="list-decimal space-y-2 px-10 py-4 text-sm" style={{ color: "var(--ink-mid)" }}>
          {(run.findings_json ?? []).slice(0, 3).map((finding) => <li key={finding}>{finding}</li>)}
        </ol>
        <header className="px-6 py-3" style={{ borderTop: "1px solid var(--limestone)", borderBottom: "1px solid var(--limestone)" }}><div className="inscription">Recommended actions</div></header>
        <ul className="list-disc space-y-2 px-10 py-4 text-sm" style={{ color: "var(--ink-mid)" }}>
          {(run.recommended_actions_json ?? []).map((action) => <li key={action}>{action}</li>)}
        </ul>
        {run.limitations ? (
          <p className="px-6 py-4 text-xs leading-relaxed" style={{ borderTop: "1px solid var(--limestone)", color: "var(--ink-faint)" }}>
            <strong>Limitations of synthetic testing:</strong> {run.limitations}
          </p>
        ) : null}
      </section>

      {artifacts.length ? (
        <section style={panel}>
          <header className="px-6 py-3" style={{ borderBottom: "1px solid var(--limestone)" }}><div className="inscription">Artifacts</div></header>
          <div className="flex flex-wrap gap-2 px-6 py-4">
            {artifacts.filter((artifact) => artifact.kind !== "failure_card").map((artifact) => (
              <button
                key={artifact.id}
                type="button"
                onClick={() => downloadArtifact(artifact)}
                disabled={!artifact.content_text}
                className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-xs font-semibold disabled:opacity-50"
                style={{ border: "1px solid var(--limestone)", color: "var(--ink-mid)" }}
                title={artifact.content_text ? "Download" : `Stored at ${artifact.storage_path ?? "runner artifacts dir"}`}
              >
                <Download className="h-3.5 w-3.5" />{artifact.kind}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {failures.length ? (
        <section style={panel} data-testid="failure-cards">
          <header className="px-6 py-3" style={{ borderBottom: "1px solid var(--terracotta)" }}><div className="inscription" style={{ color: "var(--sienna)" }}>Failures ({failures.length})</div></header>
          {failures.map((row) => (
            <article key={row.id} className="px-6 py-4" style={{ borderBottom: "1px solid var(--limestone)" }}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-sm font-semibold" style={{ color: "var(--ink)" }}>{row.case_key}</span>
                <span className="text-xs font-semibold" style={{ color: "var(--terracotta)" }}>{row.failure_kinds.join(", ")}</span>
              </div>
              {row.judge_json?.rationale ? <p className="mt-2 text-xs leading-relaxed" style={{ color: "var(--ink-mid)" }}>{row.judge_json.rationale}</p> : null}
              {row.trace_ref ? <p className="mt-1 font-mono text-[10px]" style={{ color: "var(--ink-faint)" }}>trace {row.trace_ref}</p> : null}
            </article>
          ))}
        </section>
      ) : null}

      <section style={panel}>
        <header className="px-6 py-3" style={{ borderBottom: "1px solid var(--limestone)" }}>
          <div className="inscription">Human-review queue ({reviewQueue.length})</div>
        </header>
        {reviewQueue.slice(0, 30).map((row) => (
          <div key={row.id} className="flex flex-wrap items-center justify-between gap-2 px-6 py-2.5 text-sm" style={{ borderBottom: "1px solid var(--limestone)", color: "var(--ink-mid)" }}>
            <span className="font-mono text-xs">{row.case_key}</span>
            <span className="text-xs" style={{ color: "var(--ink-faint)" }}>{row.human_review_reason ?? "queued"} · {row.status}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
