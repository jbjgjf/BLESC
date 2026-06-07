"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiClient } from "@/api/client";
import { AnomalyResult, ExplanationPayload } from "@/api/models";
import { AlertCircle, Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { demoExplanation, demoSubmission } from "@/lib/demoData";

function formatRecord(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

const S = {
  panel: {
    backgroundColor: "var(--ivory)",
    border: "1px solid var(--limestone)",
    boxShadow: "0 1px 3px rgba(42,32,24,0.09), 0 6px 24px rgba(42,32,24,0.05), inset 0 1px 0 rgba(252,244,228,0.85)",
  } as React.CSSProperties,
  displayFont: { fontFamily: "var(--font-cinzel), serif" } as React.CSSProperties,
  bodyFont:    { fontFamily: "var(--font-garamond), serif" } as React.CSSProperties,
};

function SectionHeader({ icon, label }: { icon?: string; label: string }) {
  return (
    <div
      className="flex items-center gap-3 px-5 py-4"
      style={{ borderBottom: "1px solid var(--limestone)" }}
    >
      {icon && <span style={{ color: "var(--gold)" }}>{icon}</span>}
      <span
        style={{
          fontFamily: "var(--font-cinzel), serif",
          fontSize: "0.6rem",
          fontWeight: 600,
          letterSpacing: "0.22em",
          textTransform: "uppercase",
          color: "var(--ink-soft)",
        }}
      >
        {label}
      </span>
    </div>
  );
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

  useEffect(() => { loadInsights(); }, [loadInsights]);

  if (isLoading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Loader2 className="h-7 w-7 animate-spin" style={{ color: "var(--sandstone)" }} />
      </div>
    );
  }

  return (
    <div className="space-y-6">

      {/* Page header */}
      <section
        className="relative px-8 py-7"
        style={{
          ...S.panel,
          backgroundImage: [
            "radial-gradient(ellipse at 4% 50%, rgba(160,72,48,0.07) 0%, transparent 45%)",
            "radial-gradient(ellipse at 96% 50%, rgba(43,89,133,0.06) 0%, transparent 45%)",
            "radial-gradient(ellipse at 50% -10%, rgba(196,150,42,0.09) 0%, transparent 55%)",
            "linear-gradient(180deg, var(--ivory-warm) 0%, var(--ivory) 100%)",
          ].join(","),
        }}
      >
        <div className="meander absolute top-0 left-0 w-full" aria-hidden="true" />
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div
              className="mb-3"
              style={{
                fontFamily: "var(--font-cinzel), serif",
                fontSize: "0.6rem",
                fontWeight: 600,
                letterSpacing: "0.28em",
                textTransform: "uppercase",
                color: "var(--ink-faint)",
              }}
            >
              Inference Ledger
            </div>
            <h1
              className="text-3xl"
              style={{ ...S.displayFont, fontWeight: 700, letterSpacing: "0.04em", color: "var(--ink)" }}
            >
              Hybrid Inference Dossier
            </h1>
            <p
              className="mt-2 max-w-xl text-base leading-relaxed"
              style={{ ...S.bodyFont, color: "var(--ink-mid)", fontStyle: "italic" }}
            >
              The score is explained through rule activations, baseline manifold deviation, and ontological drift.
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
            Participant · {userId}
          </div>
        </div>
      </section>

      {!anomaly ? (
        <div
          className="p-12 text-center text-sm"
          style={{
            border: "1px dashed var(--limestone)",
            backgroundColor: "var(--ivory-warm)",
            color: "var(--ink-faint)",
            fontStyle: "italic",
            ...S.bodyFont,
          }}
        >
          No inference dossier available yet.
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
          {error && (
            <div
              className="flex items-center gap-2 px-5 py-3 text-sm lg:col-span-2"
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

          {/* Left column — score + deviation */}
          <section className="space-y-5">

            {/* Anomaly score stele */}
            <div
              style={{
                backgroundColor: "var(--ivory-warm)",
                border: "1px solid var(--limestone)",
                boxShadow: S.panel.boxShadow,
                backgroundImage: "radial-gradient(ellipse at 50% 0%, rgba(196,150,42,0.08) 0%, transparent 60%)",
              }}
            >
              <div className="meander w-full" style={{ opacity: 0.45 }} aria-hidden="true" />
              <div className="px-6 py-6">
                <div
                  className="mb-2"
                  style={{
                    fontFamily: "var(--font-cinzel), serif",
                    fontSize: "0.55rem",
                    fontWeight: 600,
                    letterSpacing: "0.22em",
                    textTransform: "uppercase",
                    color: "var(--ink-faint)",
                  }}
                >
                  Hybrid Anomaly Score
                </div>
                <div
                  className="text-6xl leading-none"
                  style={{ ...S.displayFont, fontWeight: 700, color: "var(--ink)", letterSpacing: "0.04em" }}
                >
                  {anomaly.anomaly_score.toFixed(2)}
                </div>
                <p
                  className="mt-4 text-sm leading-relaxed"
                  style={{ ...S.bodyFont, color: "var(--ink-mid)", fontStyle: "italic" }}
                >
                  Final hybrid score from rule activations, baseline deviation, and temporal drift.
                </p>
              </div>
            </div>

            {/* Baseline manifold deviation */}
            <div style={S.panel}>
              <SectionHeader icon="⚖" label="Baseline Manifold Deviation" />
              <div>
                {Object.entries(explanation?.baseline_deviation_json?.feature_zscores ?? {})
                  .slice(0, 6)
                  .map(([feature, z]) => (
                    <div
                      key={feature}
                      className="flex items-center justify-between gap-4 px-5 py-3 text-sm"
                      style={{ borderBottom: "1px solid var(--ivory-aged)" }}
                    >
                      <span style={{ ...S.bodyFont, color: "var(--ink-soft)", fontWeight: 500 }}>
                        {feature}
                      </span>
                      <span
                        style={{
                          fontFamily: "monospace",
                          color: "var(--ink-mid)",
                          fontSize: "0.85rem",
                        }}
                      >
                        {Number(z).toFixed(2)}
                      </span>
                    </div>
                  ))}
                {Object.keys(explanation?.baseline_deviation_json?.feature_zscores ?? {}).length === 0 && (
                  <div className="px-5 py-6 text-sm" style={{ color: "var(--ink-faint)", fontStyle: "italic", ...S.bodyFont }}>
                    No deviation metrics.
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Right column — rules, deltas, drift */}
          <section className="space-y-5">

            {/* Rule activations */}
            <div style={S.panel}>
              <SectionHeader icon="⚡" label="Rule Activations" />
              <div>
                {explanation?.triggered_rules_json?.map((rule) => (
                  <div
                    key={rule.rule}
                    className="px-5 py-4"
                    style={{ borderBottom: "1px solid var(--ivory-aged)" }}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div
                        className="font-medium"
                        style={{ ...S.bodyFont, color: "var(--ink)", fontSize: "0.95rem" }}
                      >
                        {rule.rule.replaceAll("_", " ")}
                      </div>
                      <div
                        className="px-3 py-1 text-xs"
                        style={{
                          ...S.displayFont,
                          border: "1px solid var(--limestone)",
                          color: "var(--ink-mid)",
                          fontSize: "0.55rem",
                          letterSpacing: "0.12em",
                          textTransform: "uppercase",
                        }}
                      >
                        weight {rule.weight.toFixed(2)}
                      </div>
                    </div>
                    <p
                      className="mt-2 text-sm leading-relaxed"
                      style={{ ...S.bodyFont, color: "var(--ink-mid)", fontStyle: "italic" }}
                    >
                      {rule.evidence}
                    </p>
                  </div>
                ))}
                {(!explanation || explanation.triggered_rules_json.length === 0) && (
                  <div className="px-5 py-6 text-sm" style={{ color: "var(--ink-faint)", fontStyle: "italic", ...S.bodyFont }}>
                    No rule activations emitted.
                  </div>
                )}
              </div>
            </div>

            {/* Deltas & drift in a 2-column grid */}
            <div className="grid gap-5 md:grid-cols-2">

              {/* Relation deltas */}
              <div style={S.panel}>
                <SectionHeader icon="△" label="Relation Deltas" />
                <details open>
                  <summary
                    className="cursor-pointer px-5 py-3 text-sm transition-all"
                    style={{ ...S.bodyFont, color: "var(--ink-soft)", fontWeight: 500 }}
                  >
                    Delta records
                  </summary>
                  <div style={{ borderTop: "1px solid var(--limestone)" }}>
                    {explanation?.changed_relations_json?.map((rel, idx) => (
                      <pre
                        key={idx}
                        className="overflow-auto px-5 py-3 text-xs leading-5"
                        style={{
                          color: "var(--ink-mid)",
                          borderBottom: "1px solid var(--ivory-aged)",
                          fontFamily: "monospace",
                          backgroundColor: "var(--ivory-warm)",
                        }}
                      >
                        {formatRecord(rel)}
                      </pre>
                    ))}
                    {(!explanation || explanation.changed_relations_json.length === 0) && (
                      <div className="px-5 py-6 text-sm" style={{ color: "var(--ink-faint)", fontStyle: "italic", ...S.bodyFont }}>
                        No relation deltas detected.
                      </div>
                    )}
                  </div>
                </details>
              </div>

              {/* Drift / uncertainty */}
              <div style={S.panel}>
                <SectionHeader icon="◈" label="Drift · Uncertainty" />
                <details style={{ borderBottom: "1px solid var(--limestone)" }} open>
                  <summary
                    className="cursor-pointer px-5 py-3 text-sm transition-all"
                    style={{ ...S.bodyFont, color: "var(--ink-soft)", fontWeight: 500 }}
                  >
                    Protective-factor attenuation
                  </summary>
                  <pre
                    className="overflow-auto px-5 py-3 text-xs leading-5"
                    style={{
                      borderTop: "1px solid var(--limestone)",
                      color: "var(--ink-mid)",
                      fontFamily: "monospace",
                      backgroundColor: "var(--ivory-warm)",
                    }}
                  >
                    {formatRecord(explanation?.protective_decline_json)}
                  </pre>
                </details>
                <details>
                  <summary
                    className="cursor-pointer px-5 py-3 text-sm transition-all"
                    style={{ ...S.bodyFont, color: "var(--ink-soft)", fontWeight: 500 }}
                  >
                    Epistemic uncertainty
                  </summary>
                  <pre
                    className="overflow-auto px-5 py-3 text-xs leading-5"
                    style={{
                      borderTop: "1px solid var(--limestone)",
                      color: "var(--ink-mid)",
                      fontFamily: "monospace",
                      backgroundColor: "var(--ivory-warm)",
                    }}
                  >
                    {formatRecord(explanation?.uncertainty_json)}
                  </pre>
                </details>
              </div>
            </div>

            {/* Relation axioms */}
            <div style={S.panel}>
              <SectionHeader icon="⊢" label="Relation Axioms" />
              <div>
                {explanation?.key_relations?.slice(0, 8).map((rel) => (
                  <div
                    key={`${rel.source_id}-${rel.target_id}-${rel.type}`}
                    className="grid gap-3 px-5 py-3 text-sm"
                    style={{
                      borderBottom: "1px solid var(--ivory-aged)",
                      gridTemplateColumns: "1fr 130px",
                    }}
                  >
                    <div style={{ ...S.bodyFont, color: "var(--ink-soft)", fontWeight: 500 }}>
                      {rel.source_id} {rel.type.replaceAll("_", " ")} {rel.target_id}
                    </div>
                    <div
                      className="text-right"
                      style={{ fontFamily: "monospace", color: "var(--ink-mid)", fontSize: "0.82rem", fontStyle: "italic" }}
                    >
                      conf. {rel.confidence.toFixed(2)}
                    </div>
                  </div>
                ))}
                {(!explanation || explanation.key_relations.length === 0) && (
                  <div className="px-5 py-6 text-sm" style={{ color: "var(--ink-faint)", fontStyle: "italic", ...S.bodyFont }}>
                    No relation axioms available.
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
