"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Database, Loader2 } from "lucide-react";
import { ApiClient } from "@/api/client";
import { GraphSnapshot } from "@/api/models";
import { GraphViewer3D } from "@/components/graph/GraphViewer3D";
import { demoGraphSnapshots, demoSubmission } from "@/lib/demoData";
import { useAuth } from "@/lib/auth";

export default function GraphPage() {
  const { userId } = useAuth();
  const [snapshots, setSnapshots] = useState<GraphSnapshot[]>(demoGraphSnapshots);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadSnapshots = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await ApiClient.getGraphSnapshots(userId);
      const hasDenseLiveGraph = data.some((snapshot) => snapshot.nodes_json.length >= 10 && snapshot.relations_json.length >= 10);
      setSnapshots(hasDenseLiveGraph ? data : demoGraphSnapshots);
    } catch {
      setSnapshots(demoGraphSnapshots);
      setError("Live graph snapshots unavailable. Showing seeded monitoring data.");
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    loadSnapshots();
  }, [loadSnapshots]);

  const currentSnapshot = snapshots.at(-1) ?? demoSubmission.graph_snapshot;

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <Database className="h-4 w-4 text-sky-700" />
              Graph workspace
            </div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">Baseline and temporal structure</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Inspect structural drift without crowding the daily intake flow. Current mode shows the latest record; temporal mode layers snapshots for pattern comparison.
            </p>
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            {isLoading ? "Loading snapshots" : `${snapshots.length} snapshots`}
          </div>
        </div>
        {error && (
          <div className="mt-4 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <AlertCircle className="h-4 w-4" />
            <span>{error}</span>
          </div>
        )}
      </section>

      {isLoading ? (
        <div className="flex h-80 items-center justify-center rounded-lg border border-slate-200 bg-white">
          <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
        </div>
      ) : (
        <GraphViewer3D
          snapshots={snapshots}
          currentSnapshot={currentSnapshot}
          explanation={demoSubmission.explanation}
          title="Structural graph"
        />
      )}
    </div>
  );
}
