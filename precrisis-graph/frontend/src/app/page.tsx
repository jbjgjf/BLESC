"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiClient } from "@/api/client";
import { Entry, EntrySubmissionResponse, ExtractionRelation, GraphSnapshot } from "@/api/models";
import { AlertCircle, ArrowRight, GitBranch, History, Loader2, Send, Sparkles, Network, TriangleAlert } from "lucide-react";
import { GraphViewer3D } from "@/components/graph/GraphViewer3D";
import { demoEntries, demoGraphSnapshots, demoSubmission } from "@/lib/demoData";
import { useStoredUserId } from "@/lib/user";

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
  const { userId } = useStoredUserId();
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

  const submitGraphSnapshot = lastSubmission?.graph_snapshot ?? null;
  const historyGraphSnapshots = graphSnapshots;
  const submittedGraph = submitGraphSnapshot;
  const graphSummary = lastSubmission?.explanation?.graph_summary_json ?? submittedGraph?.graph_summary_json;
  const keyRelations = lastSubmission?.explanation?.key_relations ?? graphSummary?.key_relations ?? [];
  const temporalDiff = submittedGraph?.temporal_diff_json;

  return (
    <div className="space-y-8">
      {/* Breadcrumb & Header Emoji */}
      <div className="space-y-4">
        <div className="flex items-center gap-1.5 text-xs text-notion-muted">
          <span>Sentra Workspace</span>
          <span>/</span>
          <span className="text-notion-text font-medium">Log</span>
        </div>
        <div className="text-5xl select-none pt-2">📝</div>
        <h1 className="text-4xl font-bold tracking-tight text-notion-text">
          Structural Log Capture
        </h1>
        <p className="max-w-3xl text-sm leading-relaxed text-notion-muted">
          Extract structural graph data from daily journals. Text input is processed, converted to nodes and relationships, and purged for privacy, exposing real-time graph evolution.
        </p>
      </div>

      {/* Main Form & Callout Section */}
      <div className="grid gap-6 md:grid-cols-[1.3fr_0.7fr]">
        <div className="rounded-lg border border-notion-border bg-notion-card-bg p-6 space-y-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-notion-accent">
            <Sparkles className="h-3.5 w-3.5" />
            <span>Structural extraction</span>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="relative">
              <textarea
                className="h-40 w-full resize-none rounded border border-notion-border bg-notion-sidebar-bg/50 p-4 text-sm text-notion-text outline-none transition placeholder:text-notion-muted focus:border-notion-accent focus:bg-notion-card-bg"
                placeholder="Describe structural changes today. Events, status updates, team transitions, supports, stressors..."
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={isSubmitting}
              />
              <div className="absolute bottom-3 right-3 text-[10px] text-notion-muted bg-notion-sidebar-bg px-1.5 py-0.5 rounded border border-notion-border">
                {text.length} chars
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2 rounded border border-red-200/50 bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-400">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting || !text.trim()}
              className="inline-flex items-center gap-2 rounded bg-notion-accent px-4 py-2 text-xs font-semibold text-white transition hover:bg-notion-accent-hover disabled:cursor-not-allowed disabled:bg-notion-border disabled:text-notion-muted"
            >
              {isSubmitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              <span>Run structural extraction</span>
            </button>
          </form>
        </div>

        {/* Notion Callout Block for Pipeline Info */}
        <div className="flex gap-3 rounded-lg border border-notion-border bg-notion-sidebar-bg p-5 text-sm text-notion-text">
          <TriangleAlert className="h-5 w-5 shrink-0 text-notion-accent" />
          <div className="space-y-3">
            <div className="font-semibold text-xs uppercase tracking-wider text-notion-muted">
              Pipeline Status
            </div>
            <ol className="list-decimal pl-4 space-y-1.5 text-xs text-notion-muted">
              <li>Nodes and relations are dynamically identified.</li>
              <li>Graph state is saved; raw text is purged.</li>
              <li>Durable structures drive baseline comparisons.</li>
            </ol>
            <div className="space-y-1 text-[11px] pt-1 border-t border-notion-sidebar-border text-notion-muted">
              <div>
                <span className="font-medium text-notion-text">Live snapshot:</span> response payload
              </div>
              <div>
                <span className="font-medium text-notion-text">History api:</span> /api/graph-snapshots
              </div>
              <div>
                <span className="font-medium text-notion-text">Total records:</span> {isLoading ? "..." : entries.length}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Nodes and Relations Section */}
      {(lastSubmission || graphSnapshots.length > 0) && (
        <div className="grid gap-6 md:grid-cols-2">
          {/* Extracted Nodes */}
          <div className="rounded-lg border border-notion-border bg-notion-card-bg p-6 space-y-4">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-notion-muted">
              <Network className="h-4 w-4 text-notion-accent" />
              <span>Extracted Nodes</span>
            </div>

            <div className="divide-y divide-notion-border border-t border-b border-notion-border">
              {groupedNodes.map((node) => (
                <div key={node.id} className="flex items-center justify-between py-2 text-sm">
                  <div>
                    <span className="inline-block text-[10px] font-semibold bg-notion-select-bg text-notion-muted border border-notion-border px-1.5 py-0.5 rounded uppercase tracking-wider mr-2">
                      {node.category}
                    </span>
                    <span className="font-medium text-notion-text">{node.label}</span>
                  </div>
                  <div className="text-[11px] text-notion-muted">
                    intensity: {node.intensity.toFixed(1)} · confidence: {node.confidence.toFixed(1)}
                  </div>
                </div>
              ))}
              {groupedNodes.length === 0 && (
                <div className="py-6 text-center text-xs text-notion-muted">
                  No nodes extracted.
                </div>
              )}
            </div>
          </div>

          {/* Relations & Summary */}
          <div className="space-y-6">
            <div className="rounded-lg border border-notion-border bg-notion-card-bg p-6 space-y-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-notion-muted">
                <GitBranch className="h-4 w-4 text-notion-accent" />
                <span>Key Relations</span>
              </div>

              <div className="divide-y divide-notion-border border-t border-b border-notion-border">
                {keyRelations.map((relation) => (
                  <div key={`${relation.source_id}-${relation.target_id}-${relation.type}`} className="py-2.5 text-sm">
                    <div className="font-medium text-notion-text">{relationLabel(relation, nodeLabels)}</div>
                    <div className="text-[11px] text-notion-muted">confidence: {relation.confidence.toFixed(1)}</div>
                  </div>
                ))}
                {keyRelations.length === 0 && (
                  <div className="py-6 text-center text-xs text-notion-muted">
                    No relationships extracted.
                  </div>
                )}
              </div>
            </div>

            {/* Local Summary */}
            <div className="rounded-lg border border-notion-border bg-notion-sidebar-bg p-6 space-y-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-notion-muted">
                <ArrowRight className="h-4 w-4 text-notion-accent" />
                <span>Graph Deviation Summary</span>
              </div>
              <div className="space-y-3">
                <div className="text-sm font-semibold text-notion-text">
                  {graphSummary?.summary ?? "No summary available"}
                </div>
                
                <div className="grid grid-cols-3 gap-2 text-center text-xs border-t border-notion-sidebar-border pt-3">
                  <div className="bg-notion-card-bg border border-notion-border p-2 rounded">
                    <div className="text-[10px] uppercase font-semibold text-notion-muted">Nodes</div>
                    <div className="mt-1 font-bold text-sm">{graphSummary?.node_count ?? 0}</div>
                  </div>
                  <div className="bg-notion-card-bg border border-notion-border p-2 rounded">
                    <div className="text-[10px] uppercase font-semibold text-notion-muted">Relations</div>
                    <div className="mt-1 font-bold text-sm">{graphSummary?.relation_count ?? 0}</div>
                  </div>
                  <div className="bg-notion-card-bg border border-notion-border p-2 rounded">
                    <div className="text-[10px] uppercase font-semibold text-notion-muted">Events</div>
                    <div className="mt-1 font-bold text-sm">{graphSummary?.event_count ?? 0}</div>
                  </div>
                </div>

                {temporalDiff && (
                  <div className="rounded border border-notion-accent/20 bg-notion-accent-bg p-3 text-xs text-notion-text">
                    <div className="font-semibold text-notion-accent">Temporal Shift Details</div>
                    <div className="mt-1 text-notion-muted">{temporalDiff.relation_shift_summary}</div>
                    <div className="mt-2 text-[10px]">
                      Protective decline: <span className="font-mono">{JSON.stringify(temporalDiff.protective_decline)}</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 3D Force Graph */}
      <GraphViewer3D
        snapshots={historyGraphSnapshots}
        currentSnapshot={submitGraphSnapshot ?? historyGraphSnapshots.at(-1) ?? null}
        explanation={lastSubmission?.explanation ?? null}
        title="Baseline & Temporal Graph Analysis"
      />

      {/* Recent Entries */}
      <div className="rounded-lg border border-notion-border bg-notion-card-bg p-6 space-y-4">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-notion-muted">
          <History className="h-4.5 w-4.5 text-notion-accent" />
          <span>Recent Logs (Purged Storage Demo)</span>
        </div>
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-notion-accent" />
          </div>
        ) : entries.length === 0 ? (
          <div className="text-center text-xs text-notion-muted py-6">
            No entries found.
          </div>
        ) : (
          <div className="divide-y divide-notion-border border-t border-notion-border">
            {entries.map((entry) => (
              <div key={entry.id} className="py-3 text-xs space-y-1">
                <div className="flex items-center justify-between text-notion-muted text-[10px]">
                  <span className="font-semibold">{new Date(entry.created_at).toLocaleString()}</span>
                  <span className="bg-notion-select-bg px-1 py-0.5 rounded border border-notion-border">
                    {entry.is_masked ? "Purged: raw text removed" : "Retained"}
                  </span>
                </div>
                <p className="text-notion-text leading-relaxed text-sm">
                  {entry.raw_text ?? "Structural representation persisted; raw text is no longer stored."}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
