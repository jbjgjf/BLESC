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
  Loader2,
  Send,
  Sparkles,
  MessageSquare,
} from "lucide-react";
import { demoEntries, demoGraphSnapshots, demoSubmission } from "@/lib/demoData";
import { useAuth } from "@/lib/auth";

/* ── helpers ──────────────────────────────────────────────────── */

function categoryRank(category: string): number {
  const order = ["Protective", "Event", "Behavior", "Trigger", "State"];
  return Math.max(0, order.indexOf(category));
}

function relationLabel(relation: ExtractionRelation, nodeLabels: Map<string, string>): string {
  const source = nodeLabels.get(relation.source_id) ?? relation.source_id;
  const target = nodeLabels.get(relation.target_id) ?? relation.target_id;
  return `${source} ${relation.type.replaceAll("_", " ")} ${target}`;
}

const AI_RALLY_RESPONSES = [
  "Got it. Tell me more about what behavior or changes you've noticed.",
  "How does that impact their academic progress or attendance?",
  "What protective factors or supportive measures are currently in place?",
  "Is there any other trigger or social context you'd like to share?",
  "Interesting. What was the timeline of these observed transitions?",
  "I see. Have there been any outreach efforts made recently?",
  "Thank you for sharing. What else have you observed regarding this event?",
  "Could you describe the intensity of these actions or state?",
];

/* ── shared style helpers ─────────────────────────────────────── */

const S = {
  panel: {
    backgroundColor: "var(--ivory)",
    border: "1px solid var(--limestone)",
    boxShadow: "0 1px 3px rgba(42,32,24,0.09), 0 6px 24px rgba(42,32,24,0.05), inset 0 1px 0 rgba(252,244,228,0.85)",
  } as React.CSSProperties,
  stele: {
    backgroundColor: "var(--ivory-warm)",
    border: "1px solid var(--limestone)",
    boxShadow: "0 2px 8px rgba(42,32,24,0.09), inset 0 1px 0 rgba(252,244,228,0.85)",
  } as React.CSSProperties,
  displayFont: {
    fontFamily: "var(--font-cinzel), serif",
  } as React.CSSProperties,
  bodyFont: {
    fontFamily: "var(--font-garamond), serif",
  } as React.CSSProperties,
};

/* ── category badge colours ───────────────────────────────────── */
const categoryColor: Record<string, string> = {
  Protective: "var(--aegean)",
  Event:      "var(--terracotta)",
  Behavior:   "var(--gold-deep)",
  Trigger:    "var(--sienna)",
  State:      "var(--ink-mid)",
};

/* ================================================================
   Component
   ================================================================ */

export default function Home() {
  const { userId } = useAuth();
  const [text, setText] = useState("");
  const [entries, setEntries] = useState<Entry[]>(demoEntries);
  const [graphSnapshots, setGraphSnapshots] = useState<GraphSnapshot[]>(demoGraphSnapshots);
  const [lastSubmission, setLastSubmission] = useState<EntrySubmissionResponse | null>(demoSubmission);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [observationType, setObservationType] = useState<"daily" | "rally" | "weekly">("daily");

  const [isChatOpen, setIsChatOpen] = useState(false);
  const [rallyMessages, setRallyMessages] = useState<Array<{ sender: "user" | "ai"; text: string }>>([
    { sender: "ai", text: "Greetings. This is the Rally diagnosis assistant. Let us compile observation details through dialogue. After 30 rallies, the primary diagnosis will be rendered." },
  ]);
  const [rallyInput, setRallyInput] = useState("");
  const [rallyCount, setRallyCount] = useState(0);
  const [isRallySubmitting, setIsRallySubmitting] = useState(false);
  const [rallyResult, setRallyResult] = useState<EntrySubmissionResponse | null>(null);

  const [chatPos, setChatPos] = useState({ x: 0, y: 0 });
  const [isDraggingChat, setIsDraggingChat] = useState(false);
  const [dragStartPos, setDragStartPos] = useState({ x: 0, y: 0 });

  const handleChatMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".drag-handle")) {
      setIsDraggingChat(true);
      setDragStartPos({ x: e.clientX - chatPos.x, y: e.clientY - chatPos.y });
      e.preventDefault();
    }
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingChat) return;
      setChatPos({ x: e.clientX - dragStartPos.x, y: e.clientY - dragStartPos.y });
    };
    const handleMouseUp = () => setIsDraggingChat(false);
    if (isDraggingChat) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    }
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDraggingChat, dragStartPos]);

  const loadEntries = useCallback(async () => {
    try {
      const data = await ApiClient.getEntries(userId);
      setEntries(data.length > demoEntries.length ? data : demoEntries);
    } catch {
      setEntries(demoEntries);
    }
  }, [userId]);

  const loadGraphSnapshots = useCallback(async () => {
    try {
      const data = await ApiClient.getGraphSnapshots(userId);
      const hasDenseLiveGraph = data.some(
        (s) => s.nodes_json.length >= 10 && s.relations_json.length >= 10,
      );
      setGraphSnapshots(hasDenseLiveGraph ? data : demoGraphSnapshots);
    } catch {
      setGraphSnapshots(demoGraphSnapshots);
    }
  }, [userId]);

  useEffect(() => { loadEntries(); loadGraphSnapshots(); }, [loadEntries, loadGraphSnapshots]);

  const handleSubmit = async (e?: React.FormEvent, submitText?: string, submitType?: string) => {
    if (e) e.preventDefault();
    const activeText = submitText ?? text;
    const activeType = submitType ?? observationType;
    if (!activeText.trim()) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await ApiClient.createEntry(userId, activeText, activeType);
      setLastSubmission(response);
      if (!submitText) setText("");
      loadEntries();
      loadGraphSnapshots();
      return response;
    } catch (submitError) {
      console.error("[entry-submit] failed", submitError);
      const message = submitError instanceof Error ? submitError.message : "Unknown error";
      setError(`Submission failed: ${message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSendRally = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rallyInput.trim() || isRallySubmitting) return;
    const userMsg = rallyInput.trim();
    setRallyInput("");
    const updatedMessages = [...rallyMessages, { sender: "user" as const, text: userMsg }];
    setRallyMessages(updatedMessages);
    const nextCount = rallyCount + 1;
    setRallyCount(nextCount);
    if (nextCount >= 30) {
      setIsRallySubmitting(true);
      const compiledText = updatedMessages.filter((m) => m.sender === "user").map((m) => m.text).join("\n\n");
      try {
        const response = await handleSubmit(undefined, compiledText, "rally");
        if (response) {
          setRallyResult(response);
          setRallyMessages((prev) => [
            ...prev,
            {
              sender: "ai",
              text: `30 Rallies complete. Primary diagnosis rendered. Anomaly Score: ${response.anomaly_result?.anomaly_score?.toFixed(2) ?? "--"}. ${response.explanation?.graph_summary_json?.summary || response.graph_snapshot?.graph_summary_json?.summary || "Observation preserved."}`,
            },
          ]);
        }
      } catch {
        setRallyMessages((prev) => [...prev, { sender: "ai", text: "The diagnosis could not be rendered. Please retry." }]);
      } finally {
        setIsRallySubmitting(false);
      }
    } else {
      setTimeout(() => {
        const reply = AI_RALLY_RESPONSES[Math.floor(Math.random() * AI_RALLY_RESPONSES.length)];
        setRallyMessages((prev) => [...prev, { sender: "ai", text: `[Rally ${nextCount}] ${reply}` }]);
      }, 500);
    }
  };

  const resetRally = () => {
    setRallyMessages([
      { sender: "ai", text: "Greetings. This is the Rally diagnosis assistant. Let us compile observation details through dialogue. After 30 rallies, the primary diagnosis will be rendered." },
    ]);
    setRallyCount(0);
    setRallyResult(null);
  };

  const groupedNodes = useMemo(() => {
    const nodes = [...(lastSubmission?.graph_snapshot?.nodes_json ?? [])];
    return nodes.sort((a, b) => categoryRank(a.category) - categoryRank(b.category));
  }, [lastSubmission]);

  const nodeLabels = useMemo(
    () => new Map(groupedNodes.map((n) => [n.id, n.label])),
    [groupedNodes],
  );

  const graphSummary = lastSubmission?.explanation?.graph_summary_json ?? lastSubmission?.graph_snapshot?.graph_summary_json;
  const keyRelations = lastSubmission?.explanation?.key_relations ?? graphSummary?.key_relations ?? [];
  const temporalDiff = lastSubmission?.graph_snapshot?.temporal_diff_json;
  const score = lastSubmission?.anomaly_result?.anomaly_score;
  const topNodes = groupedNodes.slice(0, 5);
  const recentEntries = entries.slice(0, 10);
  const latestDay = lastSubmission?.graph_snapshot?.day ?? graphSnapshots.at(-1)?.day ?? "—";

  /* ── render ─────────────────────────────────────────────────── */
  return (
    <div
      className="max-w-4xl mx-auto py-8 px-4 antialiased"
      style={S.bodyFont}
    >

      {/* ── Page header — temple pediment inscription ─────────── */}
      <header className="mb-8">
        {/* Fresco wash band */}
        <div
          className="relative mb-6 px-8 py-6"
          style={{
            backgroundImage: [
              "radial-gradient(ellipse at 5% 50%, rgba(160,72,48,0.07) 0%, transparent 45%)",
              "radial-gradient(ellipse at 95% 50%, rgba(43,89,133,0.06) 0%, transparent 45%)",
              "radial-gradient(ellipse at 50% -10%, rgba(196,150,42,0.10) 0%, transparent 60%)",
              "linear-gradient(180deg, var(--ivory-warm) 0%, var(--ivory) 100%)",
            ].join(","),
            border: "1px solid var(--limestone)",
            borderBottom: "none",
          }}
        >
          {/* Top meander */}
          <div className="meander w-full absolute top-0 left-0" aria-hidden="true" />

          <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="inscription mb-3">Ontology Intake Workbench</div>
              <h1
                className="text-3xl leading-tight"
                style={{ ...S.displayFont, fontWeight: 700, letterSpacing: "0.04em", color: "var(--ink)" }}
              >
                Phenotype Capture Console
              </h1>
              <p
                className="mt-2 text-base leading-relaxed max-w-xl"
                style={{ color: "var(--ink-mid)", fontStyle: "italic" }}
              >
                Capture observations as entities, predicates, and temporal signals for downstream inference.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span
                className="px-3 py-1 text-xs"
                style={{
                  ...S.displayFont,
                  border: "1px solid var(--limestone)",
                  color: "var(--ink-faint)",
                  fontSize: "0.6rem",
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                }}
              >
                {userId}
              </span>
            </div>
          </div>
        </div>
        {/* Bottom double rule */}
        <div style={{ height: 1, background: "var(--limestone)", opacity: 0.8 }} />
        <div style={{ height: 1, background: "var(--gold)", opacity: 0.25, marginTop: 3 }} />
      </header>

      {/* ── Main grid ──────────────────────────────────────────── */}
      <div className="grid gap-8 md:grid-cols-[1fr_260px] items-start">

        {/* Left column */}
        <div className="space-y-5">

          {/* Observation intake panel */}
          <div style={S.panel}>
            {/* Panel header */}
            <div
              className="flex items-center justify-between px-5 py-4"
              style={{ borderBottom: "1px solid var(--limestone)" }}
            >
              <div
                className="inscription"
                style={{ color: "var(--ink-soft)" }}
              >
                Phenomenology Intake
              </div>

              {/* Observation type selector */}
              <div className="relative">
                <select
                  value={observationType}
                  onChange={(e) => setObservationType(e.target.value as "daily" | "rally" | "weekly")}
                  className="appearance-none pr-6 pl-3 py-1.5 text-xs outline-none cursor-pointer transition-all"
                  style={{
                    ...S.displayFont,
                    border: "1px solid var(--limestone)",
                    backgroundColor: "var(--ivory-warm)",
                    color: "var(--ink-soft)",
                    fontSize: "0.6rem",
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                  }}
                >
                  <option value="daily">Daily Phenotype</option>
                  <option value="rally">Diagnostic Rally</option>
                  <option value="weekly">Weekly Synthesis</option>
                </select>
                <span
                  className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-xs"
                  style={{ color: "var(--ink-faint)" }}
                >
                  ▾
                </span>
              </div>
            </div>

            {/* Form body */}
            <div className="px-5 py-5">
              {observationType === "rally" ? (
                <div
                  className="p-6 text-center"
                  style={{
                    border: "1px dashed var(--limestone)",
                    backgroundColor: "var(--ivory-warm)",
                    backgroundImage: "radial-gradient(ellipse at 50% 0%, rgba(196,150,42,0.06) 0%, transparent 70%)",
                  }}
                >
                  <Sparkles
                    className="mx-auto h-7 w-7"
                    style={{ color: "var(--aegean)", opacity: 0.7 }}
                  />
                  <h3
                    className="mt-3 text-sm"
                    style={{ ...S.displayFont, fontWeight: 700, letterSpacing: "0.08em", color: "var(--ink)" }}
                  >
                    Diagnostic Rally
                  </h3>
                  <p
                    className="mt-1 text-sm max-w-sm mx-auto"
                    style={{ color: "var(--ink-mid)", fontStyle: "italic" }}
                  >
                    A 30-round Socratic dialogue compiling observations into a primary inference pass.
                  </p>
                  <button
                    onClick={() => setIsChatOpen(true)}
                    className="mt-4 inline-flex items-center gap-2 px-5 py-2 text-xs transition-all"
                    style={{
                      ...S.displayFont,
                      backgroundColor: "var(--aegean-dark)",
                      color: "var(--ivory)",
                      border: "1px solid var(--aegean)",
                      letterSpacing: "0.14em",
                      textTransform: "uppercase",
                      fontSize: "0.6rem",
                    }}
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                    Open Rally Dialogue
                  </button>
                </div>
              ) : (
                <form onSubmit={(e) => handleSubmit(e)} className="space-y-4">
                  <textarea
                    className="h-36 w-full resize-none p-4 text-sm leading-relaxed outline-none transition-all"
                    style={{
                      ...S.bodyFont,
                      border: "1px solid var(--limestone)",
                      backgroundColor: "var(--ivory-warm)",
                      color: "var(--ink)",
                      fontSize: "0.95rem",
                    }}
                    placeholder={
                      observationType === "weekly"
                        ? "Summarize academic drift, behavioral patterns, interventions, and structural updates observed over the past week…"
                        : "Describe attendance shifts, trigger elements, protective factors, or behavioral transitions observed today…"
                    }
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    disabled={isSubmitting}
                  />
                  <div className="flex items-center justify-between">
                    <span
                      className="text-xs"
                      style={{ color: "var(--ink-faint)", fontStyle: "italic" }}
                    >
                      {text.length} characters
                    </span>
                    <button
                      type="submit"
                      disabled={isSubmitting || !text.trim()}
                      className="inline-flex items-center gap-2 px-5 py-2 text-xs transition-all disabled:cursor-not-allowed"
                      style={{
                        ...S.displayFont,
                        backgroundColor: isSubmitting || !text.trim() ? "var(--limestone)" : "var(--ink)",
                        color: isSubmitting || !text.trim() ? "var(--ink-faint)" : "var(--ivory)",
                        border: `1px solid ${isSubmitting || !text.trim() ? "var(--limestone)" : "var(--ink)"}`,
                        letterSpacing: "0.14em",
                        textTransform: "uppercase",
                        fontSize: "0.6rem",
                      }}
                    >
                      {isSubmitting
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Send className="h-3 w-3" />
                      }
                      Extract Entities
                    </button>
                  </div>
                  {error && (
                    <div
                      className="flex items-center gap-2 p-3 text-sm"
                      style={{
                        border: "1px solid var(--terracotta)",
                        backgroundColor: "rgba(160,72,48,0.06)",
                        color: "var(--sienna)",
                      }}
                    >
                      <AlertCircle className="h-4 w-4 shrink-0" />
                      <span style={{ fontStyle: "italic" }}>{error}</span>
                    </div>
                  )}
                </form>
              )}
            </div>
          </div>

          {/* ── Toggle sections — classical scroll entries ──────── */}
          <div className="space-y-3">

            {/* Toggle: Entity Frame */}
            <details className="group" style={S.panel} open>
              <summary
                className="flex cursor-pointer items-center justify-between px-5 py-4 list-none"
                style={{ borderBottom: "1px solid transparent" }}
              >
                <div className="flex items-center gap-3">
                  <ChevronRight
                    className="h-3.5 w-3.5 transition-transform group-open:rotate-90"
                    style={{ color: "var(--gold)" }}
                  />
                  <span
                    className="inscription"
                    style={{ color: "var(--ink-soft)" }}
                  >
                    Entity Frame
                  </span>
                  <span
                    className="text-xs"
                    style={{ color: "var(--ink-faint)", fontStyle: "italic", ...S.bodyFont }}
                  >
                    — {latestDay}
                  </span>
                </div>
                <span className="inscription" style={{ fontSize: "0.5rem" }}>Toggle</span>
              </summary>
              <div
                className="px-5 pb-4"
                style={{ borderTop: "1px solid var(--limestone)" }}
              >
                {/* Meander strip under section header */}
                <div className="meander w-full mb-3" style={{ opacity: 0.35 }} aria-hidden="true" />
                <div>
                  {topNodes.map((node) => (
                    <div
                      key={node.id}
                      className="grid gap-3 py-3 text-sm"
                      style={{
                        borderBottom: "1px solid var(--ivory-aged)",
                        gridTemplateColumns: "100px 1fr 140px",
                      }}
                    >
                      <span
                        className="text-xs font-semibold uppercase tracking-wider"
                        style={{
                          ...S.displayFont,
                          color: categoryColor[node.category] ?? "var(--ink-mid)",
                          fontSize: "0.55rem",
                          letterSpacing: "0.18em",
                        }}
                      >
                        {node.category}
                      </span>
                      <span style={{ color: "var(--ink)", fontWeight: 500 }}>{node.label}</span>
                      <span
                        className="text-right text-xs"
                        style={{ color: "var(--ink-faint)", fontStyle: "italic" }}
                      >
                        int. {node.intensity.toFixed(2)} · conf. {node.confidence.toFixed(2)}
                      </span>
                    </div>
                  ))}
                  {topNodes.length === 0 && (
                    <p
                      className="py-3 text-sm"
                      style={{ color: "var(--ink-faint)", fontStyle: "italic" }}
                    >
                      No entities extracted yet.
                    </p>
                  )}
                </div>
              </div>
            </details>

            {/* Toggle: Relation Axioms */}
            <details className="group" style={S.panel}>
              <summary className="flex cursor-pointer items-center justify-between px-5 py-4 list-none">
                <div className="flex items-center gap-3">
                  <ChevronRight
                    className="h-3.5 w-3.5 transition-transform group-open:rotate-90"
                    style={{ color: "var(--gold)" }}
                  />
                  <span className="inscription" style={{ color: "var(--ink-soft)" }}>
                    Relation Axioms
                  </span>
                </div>
                <span className="inscription" style={{ fontSize: "0.5rem" }}>Toggle</span>
              </summary>
              <div className="px-5 pb-4" style={{ borderTop: "1px solid var(--limestone)" }}>
                <div className="meander w-full mb-3" style={{ opacity: 0.35 }} aria-hidden="true" />
                <div>
                  {keyRelations.slice(0, 5).map((relation) => (
                    <div
                      key={`${relation.source_id}-${relation.target_id}-${relation.type}`}
                      className="py-3"
                      style={{ borderBottom: "1px solid var(--ivory-aged)" }}
                    >
                      <div
                        className="text-sm font-medium"
                        style={{ color: "var(--ink)", ...S.bodyFont }}
                      >
                        {relationLabel(relation, nodeLabels)}
                      </div>
                      <div
                        className="text-xs mt-1"
                        style={{ color: "var(--ink-faint)", fontStyle: "italic" }}
                      >
                        confidence {relation.confidence.toFixed(2)}
                      </div>
                    </div>
                  ))}
                  {keyRelations.length === 0 && (
                    <p className="py-3 text-sm" style={{ color: "var(--ink-faint)", fontStyle: "italic" }}>
                      No relation axioms extracted.
                    </p>
                  )}
                </div>
              </div>
            </details>

            {/* Toggle: Temporal Drift */}
            <details className="group" style={S.panel}>
              <summary className="flex cursor-pointer items-center justify-between px-5 py-4 list-none">
                <div className="flex items-center gap-3">
                  <ChevronRight
                    className="h-3.5 w-3.5 transition-transform group-open:rotate-90"
                    style={{ color: "var(--gold)" }}
                  />
                  <span className="inscription" style={{ color: "var(--ink-soft)" }}>
                    Temporal Drift · Epistemic Uncertainty
                  </span>
                </div>
                <span className="inscription" style={{ fontSize: "0.5rem" }}>Toggle</span>
              </summary>
              <div className="px-5 pb-4" style={{ borderTop: "1px solid var(--limestone)" }}>
                <div className="meander w-full mb-3" style={{ opacity: 0.35 }} aria-hidden="true" />
                <p
                  className="text-sm leading-relaxed p-3"
                  style={{
                    ...S.bodyFont,
                    color: "var(--ink-soft)",
                    backgroundColor: "var(--ivory-warm)",
                    border: "1px solid var(--ivory-aged)",
                    fontStyle: "italic",
                  }}
                >
                  {temporalDiff?.relation_shift_summary ?? "No temporal drift summary available."}
                </p>
                <div className="mt-3 space-y-1 text-xs" style={{ color: "var(--ink-faint)" }}>
                  <div style={S.bodyFont}>
                    <strong style={{ ...S.displayFont, fontSize: "0.55rem", letterSpacing: "0.1em", textTransform: "uppercase" }}>
                      Protective Decline:
                    </strong>{" "}
                    {JSON.stringify(temporalDiff?.protective_decline ?? {})}
                  </div>
                  <div style={S.bodyFont}>
                    <strong style={{ ...S.displayFont, fontSize: "0.55rem", letterSpacing: "0.1em", textTransform: "uppercase" }}>
                      Uncertainty:
                    </strong>{" "}
                    {JSON.stringify(temporalDiff?.uncertainty ?? {})}
                  </div>
                </div>
              </div>
            </details>

            {/* Toggle: Phenotype Ledger */}
            <details className="group" style={S.panel}>
              <summary className="flex cursor-pointer items-center justify-between px-5 py-4 list-none">
                <div className="flex items-center gap-3">
                  <ChevronRight
                    className="h-3.5 w-3.5 transition-transform group-open:rotate-90"
                    style={{ color: "var(--gold)" }}
                  />
                  <span className="inscription" style={{ color: "var(--ink-soft)" }}>
                    Phenotype Ledger
                  </span>
                </div>
                <span className="inscription" style={{ fontSize: "0.5rem" }}>Toggle</span>
              </summary>
              <div className="px-5 pb-4" style={{ borderTop: "1px solid var(--limestone)" }}>
                <div className="meander w-full mb-3" style={{ opacity: 0.35 }} aria-hidden="true" />
                <div>
                  {recentEntries.map((entry) => (
                    <div
                      key={entry.id}
                      className="py-3 flex justify-between gap-4 text-sm"
                      style={{ borderBottom: "1px solid var(--ivory-aged)" }}
                    >
                      <div>
                        <div
                          className="text-xs font-semibold"
                          style={{ ...S.displayFont, color: "var(--ink-soft)", letterSpacing: "0.06em" }}
                        >
                          {new Date(entry.created_at).toLocaleString()}
                        </div>
                        <div
                          className="mt-1 text-xs max-w-md break-words"
                          style={{ color: "var(--ink-mid)", fontFamily: "monospace", fontStyle: "italic" }}
                        >
                          {entry.raw_text ?? "Entity representation persisted."}
                        </div>
                      </div>
                      <div className="text-right flex flex-col items-end gap-1 shrink-0">
                        <span
                          className="px-2 py-0.5 text-xs uppercase tracking-wider"
                          style={{
                            ...S.displayFont,
                            border: "1px solid var(--limestone)",
                            color: "var(--ink-faint)",
                            fontSize: "0.5rem",
                            letterSpacing: "0.15em",
                          }}
                        >
                          {entry.observation_type ?? "daily"}
                        </span>
                        <span
                          className="text-xs flex items-center gap-1"
                          style={{ color: "var(--aegean)", fontStyle: "italic" }}
                        >
                          <CheckCircle2 className="h-2.5 w-2.5" />
                          masked
                        </span>
                      </div>
                    </div>
                  ))}
                  {recentEntries.length === 0 && (
                    <p className="py-3 text-sm" style={{ color: "var(--ink-faint)", fontStyle: "italic" }}>
                      No historical records found.
                    </p>
                  )}
                </div>
              </div>
            </details>

          </div>
        </div>

        {/* ── Right sidebar — stele metrics ──────────────────────── */}
        <aside className="space-y-5">
          <div style={S.stele}>
            {/* Stele header */}
            <div
              className="px-5 py-4"
              style={{ borderBottom: "1px solid var(--limestone)" }}
            >
              <div className="meander w-full mb-3" style={{ opacity: 0.4 }} aria-hidden="true" />
              <div className="inscription">Inference Metrics</div>
            </div>

            <div className="px-5 py-4 space-y-4">
              {/* Anomaly score — monumental display */}
              <div>
                <span
                  className="text-xs block mb-1"
                  style={{ color: "var(--ink-faint)", fontStyle: "italic", ...S.bodyFont }}
                >
                  Hybrid Anomaly Score
                </span>
                <span
                  className="text-4xl block"
                  style={{
                    ...S.displayFont,
                    fontWeight: 700,
                    color: "var(--ink)",
                    letterSpacing: "0.04em",
                  }}
                >
                  {score === undefined ? "—" : score.toFixed(2)}
                </span>
              </div>

              {/* Node / relation counts */}
              <div
                className="grid grid-cols-2 gap-3 pt-3"
                style={{ borderTop: "1px solid var(--limestone)" }}
              >
                <div>
                  <span className="text-xs block" style={{ color: "var(--ink-faint)", ...S.bodyFont, fontStyle: "italic" }}>
                    Nodes
                  </span>
                  <span
                    className="text-xl"
                    style={{ ...S.displayFont, fontWeight: 600, color: "var(--ink)" }}
                  >
                    {graphSummary?.node_count ?? 0}
                  </span>
                </div>
                <div>
                  <span className="text-xs block" style={{ color: "var(--ink-faint)", ...S.bodyFont, fontStyle: "italic" }}>
                    Relations
                  </span>
                  <span
                    className="text-xl"
                    style={{ ...S.displayFont, fontWeight: 600, color: "var(--ink)" }}
                  >
                    {graphSummary?.relation_count ?? 0}
                  </span>
                </div>
              </div>

              {/* Summary */}
              {graphSummary?.summary && (
                <p
                  className="text-sm leading-relaxed pt-3"
                  style={{
                    ...S.bodyFont,
                    color: "var(--ink-mid)",
                    borderTop: "1px solid var(--limestone)",
                    fontStyle: "italic",
                  }}
                >
                  {graphSummary.summary}
                </p>
              )}

              {/* Navigation links */}
              <div
                className="pt-3 space-y-2"
                style={{ borderTop: "1px solid var(--limestone)" }}
              >
                <Link
                  href="/graph"
                  className="flex items-center justify-between text-sm transition-all"
                  style={{ color: "var(--aegean)", ...S.bodyFont }}
                >
                  <span>Open Ontology Atlas</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
                <Link
                  href="/insights"
                  className="flex items-center justify-between text-sm transition-all"
                  style={{ color: "var(--aegean)", ...S.bodyFont }}
                >
                  <span>Review Inference Ledger</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            </div>
          </div>
        </aside>
      </div>

      {/* ── Rally launcher — ancient coin button ─────────────────── */}
      <div className="fixed bottom-6 right-6 z-50">
        <button
          onClick={() => setIsChatOpen(!isChatOpen)}
          className="relative flex items-center justify-center transition-transform active:scale-95 focus:outline-none"
          style={{
            width: "56px",
            height: "56px",
            borderRadius: "50%",
            backgroundColor: "var(--aegean-dark)",
            border: "2px solid var(--gold)",
            color: "var(--gold)",
            fontFamily: "var(--font-cinzel), serif",
            fontSize: "1.2rem",
            fontWeight: "700",
            boxShadow: "0 4px 20px rgba(29,61,92,0.35), inset 0 1px 0 rgba(196,150,42,0.2)",
          }}
          title="Rally Diagnostic Dialogue"
          id="rally-chat-launcher"
        >
          <span>C</span>
          {rallyCount > 0 && rallyCount < 30 && (
            <span
              className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center text-xs font-bold"
              style={{
                borderRadius: "50%",
                backgroundColor: "var(--gold)",
                color: "var(--ink)",
                fontFamily: "var(--font-cinzel), serif",
                fontSize: "0.6rem",
                border: "2px solid var(--ivory)",
              }}
            >
              {rallyCount}
            </span>
          )}
        </button>
      </div>

      {/* ── Rally chat popup — unrolled scroll ───────────────────── */}
      {isChatOpen && (
        <div
          style={{
            transform: `translate(${chatPos.x}px, ${chatPos.y}px)`,
            position: "fixed",
            bottom: "96px",
            right: "24px",
            width: "384px",
            maxWidth: "calc(100vw - 2rem)",
            height: "500px",
            backgroundColor: "var(--ivory)",
            border: "1px solid var(--limestone)",
            boxShadow: "0 16px 60px rgba(29,61,92,0.20), 0 4px 16px rgba(42,32,24,0.12)",
            zIndex: 50,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* Header */}
          <div
            className="drag-handle flex items-center justify-between px-4 py-3 select-none cursor-grab active:cursor-grabbing"
            onMouseDown={handleChatMouseDown}
            style={{
              backgroundColor: "var(--aegean-dark)",
              borderBottom: "1px solid var(--aegean)",
            }}
          >
            <div className="flex items-center gap-2 pointer-events-none">
              <div
                className="h-2 w-2"
                style={{ borderRadius: "50%", backgroundColor: "var(--gold)", opacity: 0.8 }}
              />
              <span
                style={{
                  fontFamily: "var(--font-cinzel), serif",
                  fontSize: "0.6rem",
                  fontWeight: 700,
                  letterSpacing: "0.2em",
                  textTransform: "uppercase",
                  color: "var(--ivory)",
                }}
              >
                Rally Dialogue
              </span>
            </div>
            <div
              className="pointer-events-none"
              style={{
                fontFamily: "var(--font-cinzel), serif",
                fontSize: "0.55rem",
                letterSpacing: "0.12em",
                color: "rgba(196,150,42,0.9)",
                textTransform: "uppercase",
              }}
            >
              Round {rallyCount} / 30
            </div>
          </div>

          {/* Progress track */}
          <div style={{ backgroundColor: "var(--ivory-aged)", height: "3px" }}>
            <div
              style={{
                backgroundColor: "var(--gold)",
                height: "100%",
                width: `${Math.min(100, (rallyCount / 30) * 100)}%`,
                transition: "width 0.3s",
              }}
            />
          </div>

          {/* Messages */}
          <div
            className="flex-1 overflow-y-auto p-4 space-y-3"
            style={{
              backgroundColor: "var(--ivory-warm)",
              backgroundImage: "radial-gradient(ellipse at 50% 0%, rgba(196,150,42,0.05) 0%, transparent 60%)",
            }}
          >
            {rallyMessages.map((msg, i) => (
              <div key={i} className={`flex ${msg.sender === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className="max-w-[85%] px-3 py-2 text-sm leading-relaxed"
                  style={{
                    fontFamily: "var(--font-garamond), serif",
                    fontSize: "0.9rem",
                    ...(msg.sender === "user"
                      ? {
                          backgroundColor: "var(--aegean-dark)",
                          color: "var(--ivory)",
                          border: "1px solid var(--aegean)",
                        }
                      : {
                          backgroundColor: "var(--ivory)",
                          color: "var(--ink-soft)",
                          border: "1px solid var(--limestone)",
                          fontStyle: "italic",
                        }),
                  }}
                >
                  {msg.text}
                </div>
              </div>
            ))}
            {isRallySubmitting && (
              <div className="flex justify-start">
                <div
                  className="px-3 py-2 text-sm flex items-center gap-2"
                  style={{
                    backgroundColor: "var(--ivory)",
                    border: "1px solid var(--limestone)",
                    color: "var(--ink-mid)",
                    fontStyle: "italic",
                    ...S.bodyFont,
                  }}
                >
                  <Loader2 className="h-4 w-4 animate-spin" style={{ color: "var(--gold)" }} />
                  Rendering primary diagnosis…
                </div>
              </div>
            )}
          </div>

          {/* Diagnosis complete banner */}
          {rallyResult && (
            <div
              className="px-4 py-3 flex items-center justify-between gap-2"
              style={{
                backgroundColor: "rgba(43,89,133,0.08)",
                borderTop: "1px solid var(--aegean)",
              }}
            >
              <span className="text-xs" style={{ color: "var(--aegean-dark)", ...S.bodyFont, fontStyle: "italic" }}>
                Diagnosis rendered and preserved.
              </span>
              <button
                onClick={resetRally}
                className="px-3 py-1 text-xs transition"
                style={{
                  ...S.displayFont,
                  backgroundColor: "var(--aegean-dark)",
                  color: "var(--ivory)",
                  border: "1px solid var(--aegean)",
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  fontSize: "0.55rem",
                }}
              >
                New Rally
              </button>
            </div>
          )}

          {/* Input */}
          <form
            onSubmit={handleSendRally}
            className="flex gap-2 px-3 py-3"
            style={{ borderTop: "1px solid var(--limestone)", backgroundColor: "var(--ivory)" }}
          >
            <input
              type="text"
              className="flex-1 px-3 py-2 text-sm outline-none transition"
              style={{
                ...S.bodyFont,
                border: "1px solid var(--limestone)",
                backgroundColor: "var(--ivory-warm)",
                color: "var(--ink)",
                fontSize: "0.9rem",
              }}
              placeholder={rallyCount >= 30 ? "Rally complete." : `Round ${rallyCount + 1} — enter your observation…`}
              value={rallyInput}
              onChange={(e) => setRallyInput(e.target.value)}
              disabled={rallyCount >= 30 || isRallySubmitting}
            />
            <button
              type="submit"
              disabled={!rallyInput.trim() || rallyCount >= 30 || isRallySubmitting}
              className="px-3 py-2 transition-all disabled:opacity-40"
              style={{
                backgroundColor: "var(--ink)",
                color: "var(--ivory)",
                border: "1px solid var(--ink)",
              }}
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
