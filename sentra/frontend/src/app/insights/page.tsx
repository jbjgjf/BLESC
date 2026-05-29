"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiClient } from "@/api/client";
import { AnomalyResult, ExplanationPayload } from "@/api/models";
import { AlertCircle, Activity, GitBranch, Loader2, Network, ShieldAlert, Shuffle, TriangleAlert } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { demoExplanation, demoSubmission } from "@/lib/demoData";

function formatRecord(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

export default function Insights() {
  const { userId } = useAuth();
  const [anomaly, setAnomaly] = useState<AnomalyResult | null>(null);
  const [explanation, setExplanation] = useState<ExplanationPayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadInsights = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const currentAnomaly = await ApiClient.getAnomaly(userId);
      setAnomaly(currentAnomaly);
      if (currentAnomaly.explanation_id) {
        const detail = await ApiClient.getExplanation(currentAnomaly.explanation_id);
        setExplanation(detail);
      }
    } catch {
      setAnomaly(demoSubmission.anomaly_result ?? null);
      setExplanation(demoExplanation);
      setError("Live insights unavailable. Showing seeded monitoring data.");
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
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <Activity className="h-4 w-4 text-sky-700" />
              Diagnostic evidence
            </div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">Current risk explanation</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              The score is explained through rule hits, baseline deviation, and graph drift. Language models only extract structure; final scoring is deterministic.
            </p>
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            Participant <span className="font-semibold text-slate-950">{userId}</span>
          </div>
        </div>
      </section>

      {!anomaly ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500">
          No anomaly diagnostic available yet.
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-5 py-3 text-sm text-amber-800 lg:col-span-2">
              <AlertCircle className="h-4 w-4" />
              <span>{error}</span>
            </div>
          )}
          <section className="space-y-4">
            <div className="rounded-lg border border-slate-200 bg-white p-5">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Anomaly score</div>
              <div className="mt-3 text-5xl font-semibold text-slate-950">{anomaly.anomaly_score.toFixed(2)}</div>
              <p className="mt-3 text-sm leading-6 text-slate-600">
                Final hybrid score from rules, baseline deviation, and temporal shift.
              </p>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white">
              <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-4 text-sm font-semibold text-slate-950">
                <Shuffle className="h-4 w-4 text-sky-700" />
                Baseline deviation
              </div>
              <div className="divide-y divide-slate-200">
                {Object.entries(explanation?.baseline_deviation_json?.feature_zscores ?? {}).slice(0, 6).map(([feature, z]) => (
                  <div key={feature} className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
                    <span className="font-medium text-slate-950">{feature}</span>
                    <span className="font-mono text-slate-600">{Number(z).toFixed(2)}</span>
                  </div>
                ))}
                {Object.keys(explanation?.baseline_deviation_json?.feature_zscores ?? {}).length === 0 && (
                  <div className="px-5 py-6 text-sm text-slate-500">No deviation metrics.</div>
                )}
              </div>
            </div>
          </section>

          <section className="space-y-4">
            <div className="rounded-lg border border-slate-200 bg-white">
              <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-4 text-sm font-semibold text-slate-950">
                <ShieldAlert className="h-4 w-4 text-amber-600" />
                Triggered rules
              </div>
              <div className="divide-y divide-slate-200">
                {explanation?.triggered_rules_json?.map((rule) => (
                  <div key={rule.rule} className="px-5 py-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="font-medium text-slate-950">{rule.rule.replaceAll("_", " ")}</div>
                      <div className="rounded bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">weight {rule.weight.toFixed(2)}</div>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-slate-600">{rule.evidence}</p>
                  </div>
                ))}
                {(!explanation || explanation.triggered_rules_json.length === 0) && (
                  <div className="px-5 py-6 text-sm text-slate-500">No rule triggers were emitted.</div>
                )}
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-lg border border-slate-200 bg-white">
                <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-4 text-sm font-semibold text-slate-950">
                  <Network className="h-4 w-4 text-sky-700" />
                  Changed relations
                </div>
                <details open>
                  <summary className="cursor-pointer px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                    Structured records
                  </summary>
                  <div className="divide-y divide-slate-200 border-t border-slate-200">
                    {explanation?.changed_relations_json?.map((relation, idx) => (
                      <pre key={idx} className="overflow-auto px-5 py-3 text-xs leading-5 text-slate-700">
                        {formatRecord(relation)}
                      </pre>
                    ))}
                    {(!explanation || explanation.changed_relations_json.length === 0) && (
                      <div className="px-5 py-6 text-sm text-slate-500">No relation changes detected.</div>
                    )}
                  </div>
                </details>
              </div>

              <div className="rounded-lg border border-slate-200 bg-white">
                <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-4 text-sm font-semibold text-slate-950">
                  <TriangleAlert className="h-4 w-4 text-amber-600" />
                  Drift context
                </div>
                <details className="border-b border-slate-200" open>
                  <summary className="cursor-pointer px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                    Protective decline
                  </summary>
                  <pre className="overflow-auto border-t border-slate-200 px-5 py-3 text-xs leading-5 text-slate-700">
                    {formatRecord(explanation?.protective_decline_json)}
                  </pre>
                </details>
                <details>
                  <summary className="cursor-pointer px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                    Uncertainty
                  </summary>
                  <pre className="overflow-auto border-t border-slate-200 px-5 py-3 text-xs leading-5 text-slate-700">
                    {formatRecord(explanation?.uncertainty_json)}
                  </pre>
                </details>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white">
              <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-4 text-sm font-semibold text-slate-950">
                <GitBranch className="h-4 w-4 text-sky-700" />
                Key relations
              </div>
              <div className="divide-y divide-slate-200">
                {explanation?.key_relations?.slice(0, 8).map((relation) => (
                  <div key={`${relation.source_id}-${relation.target_id}-${relation.type}`} className="grid gap-2 px-5 py-3 text-sm md:grid-cols-[1fr_140px]">
                    <div className="font-medium text-slate-950">
                      {relation.source_id} {relation.type.replaceAll("_", " ")} {relation.target_id}
                    </div>
                    <div className="font-mono text-slate-600">confidence {relation.confidence.toFixed(2)}</div>
                  </div>
                ))}
                {(!explanation || explanation.key_relations.length === 0) && (
                  <div className="px-5 py-6 text-sm text-slate-500">No key relations available.</div>
                )}
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
