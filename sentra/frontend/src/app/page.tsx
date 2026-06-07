"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ApiClient } from "@/api/client";
import { Entry, EntrySubmissionResponse, GraphSnapshot } from "@/api/models";
import { AlertCircle, ArrowRight, CheckCircle2, Loader2, Send } from "lucide-react";
import { demoEntries, demoGraphSnapshots, demoSubmission } from "@/lib/demoData";
import { useAuth } from "@/lib/auth";

const categoryColor: Record<string, { bg: string; text: string; border: string }> = {
  Protective: { bg: "rgba(6,182,212,0.12)", text: "#22d3ee", border: "rgba(6,182,212,0.30)" },
  Event:      { bg: "rgba(244,63,94,0.12)",  text: "#fb7185", border: "rgba(244,63,94,0.30)"  },
  Behavior:   { bg: "rgba(139,92,246,0.12)", text: "#a78bfa", border: "rgba(139,92,246,0.30)" },
  Trigger:    { bg: "rgba(236,72,153,0.12)", text: "#f472b6", border: "rgba(236,72,153,0.30)" },
  State:      { bg: "rgba(245,158,11,0.12)", text: "#fbbf24", border: "rgba(245,158,11,0.30)" },
};

/* ── styles ─────────────────────────────────────────────────── */
const panel: React.CSSProperties = {
  backgroundColor: "rgba(15, 14, 21, 0.85)",
  border: "1px solid var(--limestone)",
  boxShadow: "0 4px 30px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.03)",
  backdropFilter: "blur(12px)",
  borderRadius: "8px",
};
const displayFont: React.CSSProperties = { fontFamily: "var(--font-sans), sans-serif" };
const bodyFont: React.CSSProperties    = { fontFamily: "var(--font-sans), sans-serif" };

/* ================================================================
   Page
   ================================================================ */
export default function Home() {
  const { userId } = useAuth();

  const [text, setText] = useState("");
  const [entries, setEntries] = useState<Entry[]>(demoEntries);
  const [graphSnapshots, setGraphSnapshots] = useState<GraphSnapshot[]>(demoGraphSnapshots);
  const [lastSubmission, setLastSubmission] = useState<EntrySubmissionResponse | null>(demoSubmission);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const loadEntries = useCallback(async () => {
    try {
      const data = await ApiClient.getEntries(userId);
      setEntries(data.length > demoEntries.length ? data : demoEntries);
    } catch { setEntries(demoEntries); }
  }, [userId]);

  const loadGraphSnapshots = useCallback(async () => {
    try {
      const data = await ApiClient.getGraphSnapshots(userId);
      const dense = data.some((s) => s.nodes_json.length >= 10 && s.relations_json.length >= 10);
      setGraphSnapshots(dense ? data : demoGraphSnapshots);
    } catch { setGraphSnapshots(demoGraphSnapshots); }
  }, [userId]);

  useEffect(() => { loadEntries(); loadGraphSnapshots(); }, [loadEntries, loadGraphSnapshots]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setIsSubmitting(true);
    setError(null);
    setSubmitted(false);
    try {
      const response = await ApiClient.createEntry(userId, text, "daily");
      setLastSubmission(response);
      setText("");
      setSubmitted(true);
      loadEntries();
      loadGraphSnapshots();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed.");
    } finally {
      setIsSubmitting(false);
    }
  };

  /* Derived data for the diagnostic panel */
  const graphSummary =
    lastSubmission?.explanation?.graph_summary_json ??
    lastSubmission?.graph_snapshot?.graph_summary_json;

  const score = lastSubmission?.anomaly_result?.anomaly_score;

  const topNodes = useMemo(() => {
    const nodes = [...(lastSubmission?.graph_snapshot?.nodes_json ?? [])];
    const order = ["Protective", "Event", "Behavior", "Trigger", "State"];
    return nodes
      .sort((a, b) => Math.max(0, order.indexOf(a.category)) - Math.max(0, order.indexOf(b.category)))
      .slice(0, 5);
  }, [lastSubmission]);

  const recentEntries = entries.slice(0, 5);

  /* ── render ─────────────────────────────────────────────────── */
  return (
    <div
      className="max-w-2xl mx-auto py-10 px-4"
      style={{ ...bodyFont, color: "var(--ink)" }}
    >

      {/* ── Observation input ──────────────────────────────────── */}
      <section style={panel} className="mb-8">
        {/* Fresco header band */}
        <div
          className="relative px-7 py-6"
          style={{
            backgroundColor: "var(--ivory-warm)",
            borderBottom: "1px solid var(--limestone)",
          }}
        >
          <div className="meander absolute top-0 left-0 w-full" style={{ opacity: 0.55 }} aria-hidden="true" />
          <div className="mt-1">
            <div className="inscription mb-2">Daily Observation</div>
            <h1
              className="text-2xl leading-snug"
              style={{ ...displayFont, fontWeight: 700, letterSpacing: "0.04em", color: "var(--ink)" }}
            >
              Record Today
            </h1>
            <p className="mt-1 text-sm" style={{ color: "var(--ink-mid)", fontStyle: "italic" }}>
              Describe what you observed — behaviours, events, changes.
            </p>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-7 py-6 space-y-4">
          <textarea
            className="w-full resize-none p-4 text-base leading-relaxed outline-none transition-all"
            rows={5}
            style={{
              ...bodyFont,
              border: "1px solid var(--limestone)",
              backgroundColor: "var(--ivory-warm)",
              color: "var(--ink)",
              fontSize: "1rem",
            }}
            placeholder="Describe attendance shifts, notable behaviours, interactions, or any changes observed today…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={isSubmitting}
          />

          <div className="flex items-center justify-between">
            {submitted && !error ? (
              <span
                className="flex items-center gap-1.5 text-sm"
                style={{ color: "var(--aegean)", fontStyle: "italic", ...bodyFont }}
              >
                <CheckCircle2 className="h-4 w-4" />
                Recorded.
              </span>
            ) : (
              <span style={{ color: "var(--ink-faint)", fontSize: "0.85rem", fontStyle: "italic" }}>
                {text.length > 0 ? `${text.length} chars` : ""}
              </span>
            )}

            <button
              type="submit"
              disabled={isSubmitting || !text.trim()}
              className="inline-flex items-center gap-2 px-6 py-2.5 transition-all disabled:cursor-not-allowed rounded-md font-semibold cursor-pointer"
              style={{
                ...displayFont,
                backgroundColor: isSubmitting || !text.trim() ? "var(--limestone)" : "var(--gold)",
                color: isSubmitting || !text.trim() ? "var(--ink-faint)" : "#000000",
                border: `1px solid ${isSubmitting || !text.trim() ? "var(--limestone)" : "var(--gold)"}`,
                boxShadow: isSubmitting || !text.trim() ? "none" : "0 0 14px rgba(6, 182, 212, 0.4)",
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                fontSize: "0.62rem",
              }}
            >
              {isSubmitting
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Send className="h-3 w-3" />
              }
              Submit
            </button>
          </div>

          {error && (
            <div
              className="flex items-center gap-2 p-3 text-sm rounded-md"
              style={{
                border: "1px solid var(--terracotta)",
                backgroundColor: "rgba(244, 63, 94, 0.08)",
                color: "var(--sienna)",
                fontStyle: "italic",
                ...bodyFont,
              }}
            >
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}
        </form>
      </section>

      {/* ── Diagnostic result ─────────────────────────────────── */}
      {(score !== undefined || topNodes.length > 0) && (
        <section style={panel} className="mb-8">
          <div
            className="px-7 py-5"
            style={{
              borderBottom: topNodes.length > 0 ? "1px solid var(--limestone)" : "none",
              backgroundColor: "var(--ivory-warm)",
            }}
          >
            <div className="meander w-full mb-4" style={{ opacity: 0.35 }} aria-hidden="true" />
            <div className="flex items-end gap-6">
              {/* Score */}
              <div>
                <div className="inscription mb-1">Diagnostic Score</div>
                <div
                  className="text-5xl leading-none"
                  style={{ ...displayFont, fontWeight: 700, color: "var(--ink)", letterSpacing: "0.02em" }}
                >
                  {score === undefined ? "—" : score.toFixed(2)}
                </div>
              </div>
              {/* Summary */}
              {graphSummary?.summary && (
                <p
                  className="flex-1 text-sm leading-relaxed pb-1"
                  style={{ color: "var(--ink-mid)", fontStyle: "italic", ...bodyFont }}
                >
                  {graphSummary.summary}
                </p>
              )}
            </div>
          </div>

          {/* Entity badges */}
          {topNodes.length > 0 && (
            <div className="px-7 py-5">
              <div className="inscription mb-3">Key Observations</div>
              <div className="flex flex-wrap gap-2">
                {topNodes.map((node) => {
                  const c = categoryColor[node.category] ?? categoryColor.State;
                  return (
                    <span
                      key={node.id}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm"
                      style={{
                        backgroundColor: c.bg,
                        color: c.text,
                        border: `1px solid ${c.border}`,
                        ...bodyFont,
                      }}
                    >
                      <span
                        className="text-xs"
                        style={{
                          ...displayFont,
                          fontSize: "0.5rem",
                          letterSpacing: "0.14em",
                          textTransform: "uppercase",
                          opacity: 0.75,
                        }}
                      >
                        {node.category}
                      </span>
                      {node.label}
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      )}

      {/* ── Graph link ─────────────────────────────────────────── */}
      <Link
        href="/graph"
        className="flex items-center justify-between px-7 py-5 mb-8 group transition-all"
        style={{
          ...panel,
          textDecoration: "none",
          backgroundColor: "var(--ivory-warm)",
        }}
      >
        <div>
          <div className="inscription mb-1">Ontology</div>
          <div
            className="text-base"
            style={{ ...displayFont, fontWeight: 600, color: "var(--ink)", letterSpacing: "0.06em" }}
          >
            View Concept Graph
          </div>
          <p className="mt-0.5 text-sm" style={{ color: "var(--ink-faint)", fontStyle: "italic", ...bodyFont }}>
            {graphSnapshots.length} snapshot{graphSnapshots.length !== 1 ? "s" : ""} · entity relations &amp; temporal drift
          </p>
        </div>
        <ArrowRight
          className="h-5 w-5 shrink-0 transition-transform group-hover:translate-x-1"
          style={{ color: "var(--gold)" }}
        />
      </Link>

      {/* ── Recent entries ─────────────────────────────────────── */}
      {recentEntries.length > 0 && (
        <section>
          <div className="inscription mb-4">Recent Records</div>
          <div style={{ border: "1px solid var(--limestone)", backgroundColor: "var(--ivory)" }}>
            {recentEntries.map((entry, i) => (
              <div
                key={entry.id}
                className="px-6 py-4 flex items-start justify-between gap-4"
                style={{
                  borderBottom: i < recentEntries.length - 1 ? "1px solid var(--ivory-aged)" : "none",
                }}
              >
                <div className="flex-1 min-w-0">
                  <div
                    className="text-xs mb-1"
                    style={{ ...displayFont, color: "var(--ink-faint)", letterSpacing: "0.08em" }}
                  >
                    {new Date(entry.created_at).toLocaleDateString(undefined, {
                      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                    })}
                  </div>
                  <div
                    className="text-sm leading-relaxed truncate"
                    style={{ color: "var(--ink-mid)", ...bodyFont, fontStyle: "italic" }}
                  >
                    {entry.raw_text ?? "Observation recorded."}
                  </div>
                </div>
                <span
                  className="shrink-0 px-2 py-0.5 text-xs"
                  style={{
                    ...displayFont,
                    border: "1px solid var(--limestone)",
                    color: "var(--ink-faint)",
                    fontSize: "0.5rem",
                    letterSpacing: "0.14em",
                    textTransform: "uppercase",
                  }}
                >
                  {entry.observation_type ?? "daily"}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

    </div>
  );
}
