"use client";

import { useState, useEffect } from "react";
import { ApiClient } from "@/api/client";
import { AnomalyResult, ExplanationPayload } from "@/api/models";
import { AlertCircle, Loader2, Network, PieChart, ShieldAlert, Shuffle, TriangleAlert } from "lucide-react";

const USER_ID = "research_user_01";

export default function Insights() {
  const [anomaly, setAnomaly] = useState<AnomalyResult | null>(null);
  const [explanation, setExplanation] = useState<ExplanationPayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadInsights();
  }, []);

  const loadInsights = async () => {
    try {
      const currentAnomaly = await ApiClient.getAnomaly(USER_ID);
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
  };

  if (isLoading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Loader2 className="h-12 w-12 animate-spin text-cyan-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-96 flex-col items-center justify-center gap-4">
        <AlertCircle className="h-12 w-12 text-rose-500" />
        <p className="font-medium text-rose-600">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <header className="rounded-[2rem] border border-slate-200 bg-white p-8 shadow-sm">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
          <PieChart className="h-4 w-4 text-cyan-600" />
          Hybrid structural explanation
        </div>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">Rule hits, baseline deviation, and graph change</h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
          The anomaly score comes from deterministic rules plus baseline deviation plus temporal graph shift. The LLM is only used for extraction.
        </p>
      </header>

      {!anomaly ? (
        <div className="rounded-[2rem] border border-dashed border-slate-200 bg-white p-12 text-center text-slate-500">
          No anomaly diagnostic available yet.
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
          <section className="space-y-6">
            <div className="rounded-[2rem] border border-slate-200 bg-slate-950 p-8 text-white shadow-[0_20px_60px_rgba(15,23,42,0.18)]">
              <div className="text-xs font-semibold uppercase tracking-[0.22em] text-cyan-300">Anomaly score</div>
              <div className="mt-3 text-6xl font-semibold">{anomaly.anomaly_score.toFixed(2)}</div>
              <p className="mt-4 text-sm leading-6 text-slate-300">
                Final score from deterministic hybrid inference. No final judgment is delegated to the LLM.
              </p>
            </div>

            <div className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
                <Shuffle className="h-4 w-4 text-cyan-600" />
                Baseline deviation
              </div>
              <div className="mt-4 space-y-3">
                {Object.entries(explanation?.baseline_deviation_json?.feature_zscores ?? {}).slice(0, 5).map(([feature, z]) => (
                  <div key={feature} className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-slate-950">{feature}</span>
                      <span className="text-slate-500">z = {Number(z).toFixed(2)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="space-y-6">
            <div className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
                <ShieldAlert className="h-4 w-4 text-cyan-600" />
                Triggered rules
              </div>
              <div className="mt-4 space-y-3">
                {explanation?.triggered_rules_json?.map((rule) => (
                  <div key={rule.rule} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <div className="font-medium text-slate-950">{rule.rule.replaceAll("_", " ")}</div>
                    <div className="mt-1 text-sm text-slate-600">{rule.evidence}</div>
                    <div className="mt-2 text-xs text-slate-500">weight {rule.weight.toFixed(2)}</div>
                  </div>
                ))}
                {(!explanation || explanation.triggered_rules_json.length === 0) && (
                  <div className="rounded-2xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-500">
                    No rule triggers were emitted.
                  </div>
                )}
              </div>
            </div>

            <div className="grid gap-6 md:grid-cols-2">
              <div className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
                <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
                  <Network className="h-4 w-4 text-cyan-600" />
                  Changed relations
                </div>
                <div className="mt-4 space-y-3 text-sm">
                  {explanation?.changed_relations_json?.map((relation, idx) => (
                    <div key={idx} className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-slate-700">
                      {JSON.stringify(relation)}
                    </div>
                  ))}
                  {(!explanation || explanation.changed_relations_json.length === 0) && (
                    <div className="rounded-2xl border border-dashed border-slate-200 p-6 text-center text-slate-500">
                      No relation changes detected.
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
                <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
                  <TriangleAlert className="h-4 w-4 text-cyan-600" />
                  Protective decline and uncertainty
                </div>
                <div className="mt-4 space-y-4 text-sm text-slate-700">
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <div className="font-medium text-slate-950">Protective decline</div>
                    <div className="mt-1">{JSON.stringify(explanation?.protective_decline_json ?? {})}</div>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <div className="font-medium text-slate-950">Uncertainty</div>
                    <div className="mt-1">{JSON.stringify(explanation?.uncertainty_json ?? {})}</div>
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

