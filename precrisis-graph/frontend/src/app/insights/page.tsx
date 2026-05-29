"use client";

import { useCallback, useState, useEffect } from "react";
import { ApiClient } from "@/api/client";
import { AnomalyResult, ExplanationPayload } from "@/api/models";
import { AlertCircle, Loader2, Network, PieChart, ShieldAlert, Shuffle, TriangleAlert } from "lucide-react";
import { useStoredUserId } from "@/lib/user";

export default function Insights() {
  const { userId } = useStoredUserId();
  const [anomaly, setAnomaly] = useState<AnomalyResult | null>(null);
  const [explanation, setExplanation] = useState<ExplanationPayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadInsights = useCallback(async () => {
    try {
      const currentAnomaly = await ApiClient.getAnomaly(userId);
      setAnomaly(currentAnomaly);
      if (currentAnomaly.explanation_id) {
        const detail = await ApiClient.getExplanation(currentAnomaly.explanation_id);
        setExplanation(detail);
      }
    } catch {
      setError("Failed to load insights. Make sure you have enough data.");
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    loadInsights();
  }, [loadInsights]);

  if (isLoading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-notion-accent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-96 flex-col items-center justify-center gap-4">
        <AlertCircle className="h-10 w-10 text-red-500" />
        <p className="font-medium text-sm text-red-500">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Breadcrumb & Header */}
      <div className="space-y-4">
        <div className="flex items-center gap-1.5 text-xs text-notion-muted">
          <span>Sentra Workspace</span>
          <span>/</span>
          <span className="text-notion-text font-medium">Insights</span>
        </div>
        <div className="text-5xl select-none pt-2">📊</div>
        <h1 className="text-4xl font-bold tracking-tight text-notion-text">
          Diagnostic Insights
        </h1>
        <p className="max-w-3xl text-sm leading-relaxed text-notion-muted">
          Rule hits, baseline deviation, and graph changes. The anomaly score is computed through deterministic hybrid inference over stable historical structures.
        </p>
      </div>

      {!anomaly ? (
        <div className="p-12 text-center border border-dashed border-notion-border rounded-lg text-notion-muted text-sm bg-notion-sidebar-bg/30">
          No anomaly diagnostic available yet.
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-[1fr_1.2fr]">
          {/* Left Column: Core Score & Deviations */}
          <section className="space-y-6">
            {/* Notion Score Block */}
            <div className="rounded-lg border border-notion-border bg-notion-sidebar-bg p-6 space-y-3">
              <div className="text-[10px] font-bold text-notion-muted uppercase tracking-wider">
                Anomaly Score
              </div>
              <div className="text-5xl font-bold text-notion-text">
                {anomaly.anomaly_score.toFixed(2)}
              </div>
              <p className="text-xs text-notion-muted leading-relaxed">
                Calculated dynamically via graph baseline comparison rules. No heuristic judgment is delegated to language models.
              </p>
            </div>

            {/* Baseline Deviation (styled like a Notion Database view) */}
            <div className="rounded-lg border border-notion-border bg-notion-card-bg p-6 space-y-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-notion-muted">
                <Shuffle className="h-4 w-4 text-notion-accent" />
                <span>Baseline Deviations</span>
              </div>
              
              <div className="border border-notion-border rounded overflow-hidden">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-notion-sidebar-bg border-b border-notion-border text-notion-muted">
                      <th className="p-2.5 font-semibold">Feature Metric</th>
                      <th className="p-2.5 font-semibold text-right">Z-Score</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-notion-border">
                    {Object.entries(explanation?.baseline_deviation_json?.feature_zscores ?? {}).slice(0, 5).map(([feature, z]) => (
                      <tr key={feature} className="hover:bg-notion-hover-bg/30">
                        <td className="p-2.5 font-medium text-notion-text">{feature}</td>
                        <td className="p-2.5 text-right font-mono text-notion-text">{Number(z).toFixed(2)}</td>
                      </tr>
                    ))}
                    {Object.keys(explanation?.baseline_deviation_json?.feature_zscores ?? {}).length === 0 && (
                      <tr>
                        <td colSpan={2} className="p-4 text-center text-notion-muted">No deviation metrics.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          {/* Right Column: Triggered Rules & Relationships */}
          <section className="space-y-6">
            {/* Triggered Rules (Callout/List blocks) */}
            <div className="rounded-lg border border-notion-border bg-notion-card-bg p-6 space-y-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-notion-muted">
                <ShieldAlert className="h-4 w-4 text-notion-accent" />
                <span>Triggered Inference Rules</span>
              </div>
              <div className="space-y-3">
                {explanation?.triggered_rules_json?.map((rule) => (
                  <div key={rule.rule} className="rounded border border-notion-border bg-notion-sidebar-bg/40 p-4 text-xs space-y-1.5">
                    <div className="font-semibold text-notion-text">{rule.rule.replaceAll("_", " ")}</div>
                    <p className="text-notion-muted leading-relaxed">{rule.evidence}</p>
                    <div className="text-[10px] text-notion-accent font-semibold pt-1">
                      weight factor: {rule.weight.toFixed(1)}
                    </div>
                  </div>
                ))}
                {(!explanation || explanation.triggered_rules_json.length === 0) && (
                  <div className="text-center text-xs text-notion-muted py-6">
                    No rules were triggered.
                  </div>
                )}
              </div>
            </div>

            {/* Change Logs & Protective Info */}
            <div className="grid gap-4 sm:grid-cols-2">
              {/* Changed Relations */}
              <div className="rounded-lg border border-notion-border bg-notion-card-bg p-6 space-y-3">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-notion-muted">
                  <Network className="h-4 w-4 text-notion-accent" />
                  <span>Changed Relations</span>
                </div>
                <div className="divide-y divide-notion-border border-t border-b border-notion-border">
                  {explanation?.changed_relations_json?.map((relation, idx) => (
                    <div key={idx} className="py-2 text-xs text-notion-text font-mono">
                      {JSON.stringify(relation)}
                    </div>
                  ))}
                  {(!explanation || explanation.changed_relations_json.length === 0) && (
                    <div className="py-4 text-center text-xs text-notion-muted">
                      No structural shifts.
                    </div>
                  )}
                </div>
              </div>

              {/* Protective decline and Uncertainty */}
              <div className="rounded-lg border border-notion-border bg-notion-card-bg p-6 space-y-4">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-notion-muted">
                  <TriangleAlert className="h-4 w-4 text-notion-accent" />
                  <span>Drift Analysis</span>
                </div>
                <div className="space-y-3 text-xs leading-relaxed">
                  <div className="space-y-1">
                    <div className="font-semibold text-notion-text text-[11px]">Protective Decline</div>
                    <div className="bg-notion-sidebar-bg/50 p-2.5 rounded font-mono border border-notion-border text-[10px]">
                      {JSON.stringify(explanation?.protective_decline_json ?? {})}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="font-semibold text-notion-text text-[11px]">Uncertainty Index</div>
                    <div className="bg-notion-sidebar-bg/50 p-2.5 rounded font-mono border border-notion-border text-[10px]">
                      {JSON.stringify(explanation?.uncertainty_json ?? {})}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
