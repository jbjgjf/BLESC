"use client";

import { useEffect, useMemo, useState } from "react";
import { ApiClient } from "@/api/client";
import { Entry, EntrySubmissionResponse, ExtractionNode, ExtractionRelation, GraphSnapshot } from "@/api/models";
import { AlertCircle, ArrowRight, GitBranch, History, Loader2, Send, Sparkles, Network, TriangleAlert } from "lucide-react";
import { GraphViewer3D } from "@/components/graph/GraphViewer3D";

const USER_ID = "research_user_01";

function categoryRank(category: string): number {
  const order = ["Protective", "Event", "Behavior", "Trigger", "State"];
  return Math.max(0, order.indexOf(category));
}

function relationLabel(relation: ExtractionRelation): string {
  return `${relation.source_id} ${relation.type} ${relation.target_id}`;
}

export default function Home() {
  const [text, setText] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [graphSnapshots, setGraphSnapshots] = useState<GraphSnapshot[]>([]);
  const [lastSubmission, setLastSubmission] = useState<EntrySubmissionResponse | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadEntries();
    loadGraphSnapshots();
  }, []);

  const loadEntries = async () => {
    try {
      const data = await ApiClient.getEntries(USER_ID);
      setEntries(data);
    } catch {
      setError("Failed to load entries.");
    } finally {
      setIsLoading(false);
    }
  };

  const loadGraphSnapshots = async () => {
    try {
      const data = await ApiClient.getGraphSnapshots(USER_ID);
      setGraphSnapshots(data);
    } catch {
      // Keep the page functional even if graph history cannot load.
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;

    setIsSubmitting(true);
    setError(null);
    try {
      const response = await ApiClient.createEntry(USER_ID, text);
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

  const submittedGraph = lastSubmission?.graph_snapshot;
  const graphSummary = lastSubmission?.explanation?.graph_summary_json ?? submittedGraph?.graph_summary_json;
  const keyRelations = lastSubmission?.explanation?.key_relations ?? graphSummary?.key_relations ?? [];
  const temporalDiff = submittedGraph?.temporal_diff_json;

  return (
    <div className="space-y-10">
      <section className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-[2rem] border border-slate-200/80 bg-white/80 p-8 shadow-[0_20px_80px_rgba(15,23,42,0.08)] backdrop-blur">
          <div className="inline-flex items-center gap-2 rounded-full border border-cyan-200 bg-cyan-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-cyan-700">
            <Sparkles className="h-3.5 w-3.5" />
            Structural capture
          </div>
          <h1 className="mt-4 max-w-2xl text-4xl font-semibold tracking-tight text-slate-950">
            Extract structure first. Treat text as temporary input.
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-slate-600">
            This pass stores graph structure as the durable representation, removes raw text after extraction, and exposes the local graph plus temporal differences immediately after submission.
          </p>

          <form onSubmit={handleSubmit} className="mt-8 space-y-4">
            <div className="relative">
              <textarea
                className="h-44 w-full resize-none rounded-3xl border border-slate-200 bg-slate-50/80 p-5 text-slate-900 outline-none transition focus:border-cyan-400 focus:bg-white focus:ring-4 focus:ring-cyan-200/40"
                placeholder="Describe the day. Mention events, transitions, support, stressors, and what changed."
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={isSubmitting}
              />
              <div className="absolute bottom-4 right-4 rounded-full bg-white/90 px-3 py-1 text-xs font-medium text-slate-500 shadow-sm">
                {text.length} chars
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                <AlertCircle className="h-4 w-4" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting || !text.trim()}
              className="inline-flex items-center gap-2 rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Submit for graph extraction
            </button>
          </form>
        </div>

        <div className="rounded-[2rem] border border-slate-200/80 bg-slate-950 p-8 text-white shadow-[0_20px_80px_rgba(15,23,42,0.18)]">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-cyan-300">
            <TriangleAlert className="h-4 w-4" />
            Current pipeline
          </div>
          <div className="mt-5 space-y-4 text-sm leading-6 text-slate-300">
            <p>1. Extract nodes and relations.</p>
            <p>2. Persist graph snapshot, then remove raw text.</p>
            <p>3. Run deterministic hybrid inference against baseline and local graph drift.</p>
          </div>
          <div className="mt-8 grid grid-cols-2 gap-3 text-xs">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="text-slate-400">Primary record</div>
              <div className="mt-1 font-semibold">Structural graph</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="text-slate-400">Text retention</div>
              <div className="mt-1 font-semibold">Optional / TTL-bound</div>
            </div>
          </div>
        </div>
      </section>

      {(lastSubmission || graphSnapshots.length > 0) && (
        <section className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
              <Network className="h-4 w-4 text-cyan-600" />
              Extracted structure
            </div>
            <div className="mt-4 grid gap-3">
              {groupedNodes.map((node) => (
                <div key={node.id} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">{node.category}</div>
                      <div className="font-medium text-slate-950">{node.label}</div>
                    </div>
                    <div className="text-right text-xs text-slate-500">
                      <div>intensity {node.intensity.toFixed(2)}</div>
                      <div>confidence {node.confidence.toFixed(2)}</div>
                    </div>
                  </div>
                  {node.category === "Event" && (
                    <div className="mt-2 text-xs text-cyan-700">
                      Event node
                      {node.duration ? ` · ${node.duration} min` : ""}
                      {node.start_time ? ` · starts ${new Date(node.start_time).toLocaleString()}` : ""}
                    </div>
                  )}
                </div>
              ))}
              {groupedNodes.length === 0 && <div className="rounded-2xl border border-dashed border-slate-200 p-6 text-sm text-slate-500">No nodes extracted.</div>}
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
                <GitBranch className="h-4 w-4 text-cyan-600" />
                Key relations
              </div>
              <div className="mt-4 space-y-3">
                {keyRelations.map((relation) => (
                  <div key={`${relation.source_id}-${relation.target_id}-${relation.type}`} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                    <div className="font-medium text-slate-950">{relationLabel(relation)}</div>
                    <div className="mt-1 text-xs text-slate-500">confidence {relation.confidence.toFixed(2)}</div>
                  </div>
                ))}
                {keyRelations.length === 0 && <div className="rounded-2xl border border-dashed border-slate-200 p-6 text-sm text-slate-500">No key relations extracted.</div>}
              </div>
            </div>

            <div className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
                <ArrowRight className="h-4 w-4 text-cyan-600" />
                Local graph summary
              </div>
              <div className="mt-4 rounded-3xl bg-slate-950 p-5 text-white">
                <div className="text-sm text-slate-400">Graph snapshot</div>
                <div className="mt-2 text-2xl font-semibold">{graphSummary?.summary ?? "No summary available"}</div>
                <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
                  <div className="rounded-2xl bg-white/5 p-3">
                    <div className="text-slate-400">Nodes</div>
                    <div className="mt-1 text-lg font-semibold">{graphSummary?.node_count ?? 0}</div>
                  </div>
                  <div className="rounded-2xl bg-white/5 p-3">
                    <div className="text-slate-400">Relations</div>
                    <div className="mt-1 text-lg font-semibold">{graphSummary?.relation_count ?? 0}</div>
                  </div>
                  <div className="rounded-2xl bg-white/5 p-3">
                    <div className="text-slate-400">Events</div>
                    <div className="mt-1 text-lg font-semibold">{graphSummary?.event_count ?? 0}</div>
                  </div>
                </div>
              </div>

              {temporalDiff && (
                <div className="mt-4 rounded-2xl border border-cyan-100 bg-cyan-50/70 p-4 text-sm text-cyan-900">
                  <div className="font-semibold">Temporal graph difference</div>
                  <div className="mt-1">{temporalDiff.relation_shift_summary}</div>
                  <div className="mt-2 text-xs text-cyan-800">Protective decline: {JSON.stringify(temporalDiff.protective_decline)}</div>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      <GraphViewer3D
        snapshots={graphSnapshots}
        currentSnapshot={lastSubmission?.graph_snapshot ?? graphSnapshots.at(-1) ?? null}
        explanation={lastSubmission?.explanation ?? null}
        title="Baseline and temporal graph viewer"
      />

      <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2 text-lg font-semibold text-slate-950">
          <History className="h-5 w-5 text-cyan-600" />
          Recent entries
        </div>
        {isLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-slate-300" />
          </div>
        ) : entries.length === 0 ? (
          <div className="mt-4 rounded-2xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500">
            No entries found yet.
          </div>
        ) : (
          <div className="mt-4 space-y-3">
                {entries.map((entry) => (
              <div key={entry.id} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="text-sm font-medium text-slate-950">{new Date(entry.created_at).toLocaleString()}</div>
                  <div className="text-xs text-slate-500">{entry.is_masked ? "raw text removed after extraction" : "raw text retained"}</div>
                </div>
                <div className="mt-2 text-sm text-slate-600">
                  {entry.raw_text ?? "Structural representation persisted; raw text is no longer stored."}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
