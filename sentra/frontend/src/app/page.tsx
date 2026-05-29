"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ApiClient } from "@/api/client";
import { Entry, EntrySubmissionResponse, ExtractionRelation, GraphSnapshot } from "@/api/models";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  FileText,
  GitBranch,
  History,
  Loader2,
  Network,
  Send,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { demoEntries, demoGraphSnapshots, demoSubmission } from "@/lib/demoData";
import { useAuth } from "@/lib/auth";

function categoryRank(category: string): number {
  const order = ["Protective", "Event", "Behavior", "Trigger", "State"];
  return Math.max(0, order.indexOf(category));
}

function relationLabel(relation: ExtractionRelation, nodeLabels: Map<string, string>): string {
  const source = nodeLabels.get(relation.source_id) ?? relation.source_id;
  const target = nodeLabels.get(relation.target_id) ?? relation.target_id;
  return `${source} ${relation.type.replaceAll("_", " ")} ${target}`;
}

export default function Home() {
  const { userId } = useAuth();
  const [text, setText] = useState("");
  const [entries, setEntries] = useState<Entry[]>(demoEntries);
  const [graphSnapshots, setGraphSnapshots] = useState<GraphSnapshot[]>(demoGraphSnapshots);
  const [lastSubmission, setLastSubmission] = useState<EntrySubmissionResponse | null>(demoSubmission);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadEntries = useCallback(async () => {
    try {
      const data = await ApiClient.getEntries(userId);
      setEntries(data.length > demoEntries.length ? data : demoEntries);
    } catch {
      setEntries(demoEntries);
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  const loadGraphSnapshots = useCallback(async () => {
    try {
      const data = await ApiClient.getGraphSnapshots(userId);
      const hasDenseLiveGraph = data.some((snapshot) => snapshot.nodes_json.length >= 10 && snapshot.relations_json.length >= 10);
      setGraphSnapshots(hasDenseLiveGraph ? data : demoGraphSnapshots);
    } catch {
      setGraphSnapshots(demoGraphSnapshots);
    }
  }, [userId]);

  useEffect(() => {
    loadEntries();
    loadGraphSnapshots();
  }, [loadEntries, loadGraphSnapshots]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;

    setIsSubmitting(true);
    setError(null);
    try {
      const response = await ApiClient.createEntry(userId, text);
      setLastSubmission(response);
      setText("");
      loadEntries();
      loadGraphSnapshots();
    } catch {
      setError("Submission failed. Check backend connection.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const groupedNodes = useMemo(() => {
    const nodes = [...(lastSubmission?.graph_snapshot?.nodes_json ?? [])];
    return nodes.sort((a, b) => categoryRank(a.category) - categoryRank(b.category));
  }, [lastSubmission]);
  const nodeLabels = useMemo(
    () => new Map(groupedNodes.map((node) => [node.id, node.label])),
    [groupedNodes],
  );

  const graphSummary = lastSubmission?.explanation?.graph_summary_json ?? lastSubmission?.graph_snapshot?.graph_summary_json;
  const keyRelations = lastSubmission?.explanation?.key_relations ?? graphSummary?.key_relations ?? [];
  const temporalDiff = lastSubmission?.graph_snapshot?.temporal_diff_json;
  const score = lastSubmission?.anomaly_result?.anomaly_score;
  const topNodes = groupedNodes.slice(0, 5);
  const recentEntries = entries.slice(0, 6);
  const latestDay = lastSubmission?.graph_snapshot?.day ?? graphSnapshots.at(-1)?.day ?? "No snapshot";

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <ShieldCheck className="h-4 w-4 text-sky-700" />
              Daily intake
            </div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">Today&apos;s risk signal</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Capture operational observations, extract durable structure, then remove raw text. The default view shows only what changed; deeper evidence stays one step away.
            </p>
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            Participant <span className="font-semibold text-slate-950">{userId}</span>
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <form onSubmit={handleSubmit} className="rounded-lg border border-slate-200 bg-white p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-950">
            <FileText className="h-4 w-4 text-sky-700" />
            New observation
          </div>
          <textarea
            className="mt-4 h-40 w-full resize-none rounded-md border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-sky-500 focus:bg-white"
            placeholder="Describe attendance changes, outreach, academic pressure, protective support, behavior changes, or transitions observed today."
            value={text}
            onChange={(event) => setText(event.target.value)}
            disabled={isSubmitting}
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-slate-500">{text.length} characters</div>
            <button
              type="submit"
              disabled={isSubmitting || !text.trim()}
              className="inline-flex items-center gap-2 rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Extract structure
            </button>
          </div>
          {error && (
            <div className="mt-4 flex items-center gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              <AlertCircle className="h-4 w-4" />
              <span>{error}</span>
            </div>
          )}
        </form>

        <aside className="rounded-lg border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-slate-950">Latest structural record</div>
            <div className="rounded bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">Text purged</div>
          </div>
          <div className="mt-5 grid grid-cols-3 gap-2">
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs text-slate-500">Nodes</div>
              <div className="mt-1 text-xl font-semibold text-slate-950">{graphSummary?.node_count ?? 0}</div>
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs text-slate-500">Relations</div>
              <div className="mt-1 text-xl font-semibold text-slate-950">{graphSummary?.relation_count ?? 0}</div>
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs text-slate-500">Score</div>
              <div className="mt-1 text-xl font-semibold text-slate-950">{score === undefined ? "--" : score.toFixed(2)}</div>
            </div>
          </div>
          <p className="mt-4 text-sm leading-6 text-slate-600">{graphSummary?.summary ?? "No graph summary available."}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/graph" className="inline-flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-sky-300 hover:text-sky-800">
              Open graph <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href="/insights" className="inline-flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-sky-300 hover:text-sky-800">
              Review evidence <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </aside>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="rounded-lg border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-950">
              <Network className="h-4 w-4 text-sky-700" />
              Structural summary
            </div>
            <div className="text-xs text-slate-500">{latestDay}</div>
          </div>
          <div className="divide-y divide-slate-200">
            {topNodes.map((node) => (
              <div key={node.id} className="grid gap-3 px-5 py-3 text-sm sm:grid-cols-[150px_1fr_170px]">
                <div className="font-semibold text-slate-500">{node.category}</div>
                <div className="font-medium text-slate-950">{node.label}</div>
                <div className="text-slate-500">
                  intensity {node.intensity.toFixed(2)} / confidence {node.confidence.toFixed(2)}
                </div>
              </div>
            ))}
            {topNodes.length === 0 && <div className="px-5 py-8 text-sm text-slate-500">No extracted nodes yet.</div>}
          </div>
          <details className="border-t border-slate-200">
            <summary className="flex cursor-pointer items-center justify-between px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
              Full extracted structure
              <ChevronRight className="h-4 w-4" />
            </summary>
            <div className="divide-y divide-slate-200 border-t border-slate-200">
              {groupedNodes.map((node) => (
                <div key={node.id} className="px-5 py-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-slate-950">{node.label}</span>
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{node.category}</span>
                  </div>
                  {node.category === "Event" && (
                    <div className="mt-1 text-xs text-sky-800">
                      Event{node.duration ? ` / ${node.duration} min` : ""}{node.start_time ? ` / ${new Date(node.start_time).toLocaleString()}` : ""}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </details>
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border border-slate-200 bg-white">
            <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-4 text-sm font-semibold text-slate-950">
              <GitBranch className="h-4 w-4 text-sky-700" />
              Key relations
            </div>
            <div className="divide-y divide-slate-200">
              {keyRelations.slice(0, 4).map((relation) => (
                <div key={`${relation.source_id}-${relation.target_id}-${relation.type}`} className="px-5 py-3 text-sm">
                  <div className="font-medium text-slate-950">{relationLabel(relation, nodeLabels)}</div>
                  <div className="mt-1 text-xs text-slate-500">confidence {relation.confidence.toFixed(2)}</div>
                </div>
              ))}
              {keyRelations.length === 0 && <div className="px-5 py-6 text-sm text-slate-500">No key relations extracted.</div>}
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-950">
              <TriangleAlert className="h-4 w-4 text-amber-600" />
              Drift note
            </div>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              {temporalDiff?.relation_shift_summary ?? "No temporal drift summary available."}
            </p>
            <details className="mt-3">
              <summary className="cursor-pointer text-sm font-semibold text-sky-800">Protective factors and uncertainty</summary>
              <pre className="mt-3 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">
                {JSON.stringify({
                  protective_decline: temporalDiff?.protective_decline ?? {},
                  uncertainty: temporalDiff?.uncertainty ?? {},
                }, null, 2)}
              </pre>
            </details>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white">
        <details>
          <summary className="flex cursor-pointer items-center justify-between px-5 py-4 text-sm font-semibold text-slate-950 hover:bg-slate-50">
            <span className="flex items-center gap-2">
              <History className="h-4 w-4 text-sky-700" />
              Recent intake records
            </span>
            <ChevronRight className="h-4 w-4" />
          </summary>
          {isLoading ? (
            <div className="flex justify-center border-t border-slate-200 py-8">
              <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
            </div>
          ) : recentEntries.length === 0 ? (
            <div className="border-t border-slate-200 px-5 py-8 text-sm text-slate-500">No entries found yet.</div>
          ) : (
            <div className="divide-y divide-slate-200 border-t border-slate-200">
              {recentEntries.map((entry) => (
                <div key={entry.id} className="grid gap-2 px-5 py-3 text-sm md:grid-cols-[220px_160px_1fr]">
                  <div className="font-medium text-slate-950">{new Date(entry.created_at).toLocaleString()}</div>
                  <div className="flex items-center gap-1 text-xs font-semibold text-emerald-700">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {entry.is_masked ? "raw text removed" : "raw text retained"}
                  </div>
                  <div className="text-slate-600">{entry.raw_text ?? "Structural representation persisted."}</div>
                </div>
              ))}
            </div>
          )}
        </details>
      </section>
    </div>
  );
}
