"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { ApiClient } from "@/api/client";
import { GraphSnapshot } from "@/api/models";
import { GraphViewer3D } from "@/components/graph/GraphViewer3D";
import { demoGraphSnapshots, demoSubmission } from "@/lib/demoData";
import { useAuth } from "@/lib/auth";

const S = {
  panel: {
    backgroundColor: "var(--ivory)",
    border: "1px solid var(--limestone)",
    boxShadow: "0 1px 3px rgba(42,32,24,0.09), 0 6px 24px rgba(42,32,24,0.05), inset 0 1px 0 rgba(252,244,228,0.85)",
  } as React.CSSProperties,
  displayFont: { fontFamily: "var(--font-sans), sans-serif" } as React.CSSProperties,
  bodyFont:    { fontFamily: "var(--font-sans), sans-serif" } as React.CSSProperties,
};

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
      setSnapshots(data.length > 0 ? data : demoGraphSnapshots);
    } catch {
      setSnapshots(demoGraphSnapshots);
      setError("Live graph snapshots unavailable. Showing seeded monitoring data.");
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => { loadSnapshots(); }, [loadSnapshots]);

  const currentSnapshot = snapshots.at(-1) ?? demoSubmission.graph_snapshot;

  return (
    <div className="space-y-6">

      {/* Page header */}
      <section
        className="relative px-8 py-7"
        style={{
          ...S.panel,
          backgroundColor: "var(--ivory-warm)",
        }}
      >
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div
              className="mb-3"
              style={{
                fontFamily: "var(--font-sans), sans-serif",
                fontSize: "0.6rem",
                fontWeight: 600,
                letterSpacing: "0.28em",
                textTransform: "uppercase",
                color: "var(--ink-faint)",
              }}
            >
              Ontology Workspace
            </div>
            <h1
              className="text-3xl"
              style={{ ...S.displayFont, fontWeight: 700, letterSpacing: "0.04em", color: "var(--ink)" }}
            >
              Temporal Ontology Atlas
            </h1>
            <p
              className="mt-2 max-w-xl text-base leading-relaxed"
              style={{ ...S.bodyFont, color: "var(--ink-mid)", fontStyle: "italic" }}
            >
              Inspect extracted entities, relation axioms, and temporal drift across the participant ontology.
            </p>
          </div>
          <div
            className="px-4 py-2 text-xs"
            style={{
              ...S.displayFont,
              border: "1px solid var(--limestone)",
              color: "var(--ink-faint)",
              fontSize: "0.6rem",
              letterSpacing: "0.14em",
              textTransform: "uppercase",
            }}
          >
            {isLoading ? "Loading…" : `${snapshots.length} snapshots`}
          </div>
        </div>

        {error && (
          <div
            className="mt-5 flex items-center gap-2 px-4 py-2.5 text-sm"
            style={{
              border: "1px solid var(--sandstone)",
              backgroundColor: "rgba(196,150,42,0.06)",
              color: "var(--ochre)",
              ...S.bodyFont,
              fontStyle: "italic",
            }}
          >
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </section>

      {isLoading ? (
        <div
          className="flex h-80 items-center justify-center"
          style={S.panel}
        >
          <Loader2 className="h-7 w-7 animate-spin" style={{ color: "var(--sandstone)" }} />
        </div>
      ) : (
        <GraphViewer3D
          snapshots={snapshots}
          currentSnapshot={currentSnapshot}
          explanation={demoSubmission.explanation}
          title="Ontology Graph"
        />
      )}
    </div>
  );
}
