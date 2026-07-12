"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ApiClient } from "@/api/client";
import {
  ChatResponse,
  ConsentSnapshot,
  ConversationRecallSummary,
  Entry,
  EntrySubmissionResponse,
  EntryTelemetryPayload,
  FieldTelemetryPayload,
  GraphSnapshot,
  InteractionEventPayload,
} from "@/api/models";
import { AlertCircle, ArrowRight, CheckCircle2, Loader2, MessageCircle, Send, Sparkles } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabase/client";
import { ProcessingTimeline } from "@/components/ProcessingTimeline";
import { VoiceInputButton } from "@/components/VoiceInputButton";

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
const journalSteps = ["Saving observation", "Extracting graph", "Computing reflection signal", "Updating research artifacts", "Done"];
const chatSteps = ["Preparing message", "Retrieving related entries", "Checking BLESC static knowledge", "Generating cautious response", "Done"];

/* ================================================================
   Page
   ================================================================ */
export default function Home() {
  const { userId, participant } = useAuth();
  const [isSafetyDiverted, setIsSafetyDiverted] = useState(false);
  const [safetyMessage, setSafetyMessage] = useState("");
  const [journalText, setJournalText] = useState("");
  const [recallText, setRecallText] = useState("");
  const [chatText, setChatText] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [graphSnapshots, setGraphSnapshots] = useState<GraphSnapshot[]>([]);
  const [lastSubmission, setLastSubmission] = useState<EntrySubmissionResponse | null>(null);
  const [chatResponse, setChatResponse] = useState<ChatResponse | null>(null);
  const [conversationRecall, setConversationRecall] = useState<ConversationRecallSummary | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isChatSubmitting, setIsChatSubmitting] = useState(false);
  const [journalStep, setJournalStep] = useState(0);
  const [chatStep, setChatStep] = useState(0);
  const [journalComplete, setJournalComplete] = useState(false);
  const [chatComplete, setChatComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const telemetryRef = useRef<{
    sessionId: string;
    startedAt: string;
    startedAtMs: number;
    events: InteractionEventPayload[];
    fieldMetrics: Record<string, FieldTelemetryPayload>;
    lastInputAtMs: Record<string, number>;
    previousLength: Record<string, number>;
    fieldOrder: string[];
  }>(createTelemetryState());

  function createTelemetryState() {
    const now = Date.now();
    return {
      sessionId: `entry-${now}-${Math.random().toString(36).slice(2, 10)}`,
      startedAt: new Date(now).toISOString(),
      startedAtMs: now,
      events: [],
      fieldMetrics: {},
      lastInputAtMs: {},
      previousLength: {},
      fieldOrder: [],
    };
  }

  const ensureFieldMetrics = (fieldName: string): FieldTelemetryPayload => {
    const telemetry = telemetryRef.current;
    if (!telemetry.fieldMetrics[fieldName]) {
      telemetry.fieldMetrics[fieldName] = {
        focus_count: 0,
        blur_count: 0,
        input_count: 0,
        deletion_count: 0,
        paste_count: 0,
        revision_count: 0,
        pause_count: 0,
        max_pause_ms: 0,
        active_typing_ms: 0,
      };
    }
    return telemetry.fieldMetrics[fieldName];
  };

  const recordInteraction = (
    fieldName: string,
    eventType: string,
    valueLength?: number,
    selectionStart?: number | null,
    selectionEnd?: number | null,
    metadata: Record<string, string | number | boolean | null> = {},
  ) => {
    const telemetry = telemetryRef.current;
    const now = Date.now();
    telemetry.events.push({
      field_name: fieldName,
      event_type: eventType,
      occurred_at: new Date(now).toISOString(),
      relative_ms: now - telemetry.startedAtMs,
      value_length: valueLength,
      selection_start: selectionStart ?? undefined,
      selection_end: selectionEnd ?? undefined,
      metadata,
    });
    if (telemetry.events.length > 1200) telemetry.events.splice(0, telemetry.events.length - 1200);
  };

  const handleFieldFocus = (fieldName: string, valueLength: number) => {
    const metrics = ensureFieldMetrics(fieldName);
    metrics.focus_count += 1;
    if (!telemetryRef.current.fieldOrder.includes(fieldName)) telemetryRef.current.fieldOrder.push(fieldName);
    recordInteraction(fieldName, "focus", valueLength);
  };

  const handleFieldBlur = (fieldName: string, valueLength: number) => {
    ensureFieldMetrics(fieldName).blur_count += 1;
    recordInteraction(fieldName, "blur", valueLength);
  };

  const handleFieldPaste = (fieldName: string, valueLength: number) => {
    ensureFieldMetrics(fieldName).paste_count += 1;
    recordInteraction(fieldName, "paste", valueLength);
  };

  const handleFieldChange = (
    fieldName: string,
    nextValue: string,
    setValue: (value: string) => void,
    selectionStart: number | null,
    selectionEnd: number | null,
  ) => {
    const telemetry = telemetryRef.current;
    const now = Date.now();
    const metrics = ensureFieldMetrics(fieldName);
    const previousLength = telemetry.previousLength[fieldName] ?? 0;
    const delta = nextValue.length - previousLength;
    const lastInputAt = telemetry.lastInputAtMs[fieldName];
    const pauseMs = lastInputAt ? now - lastInputAt : 0;

    metrics.input_count += 1;
    metrics.last_input_at = new Date(now).toISOString();
    if (!metrics.first_input_at) metrics.first_input_at = metrics.last_input_at;
    if (delta < 0) metrics.deletion_count += 1;
    if (Math.abs(delta) > 1) metrics.revision_count += 1;
    if (pauseMs >= 1500) {
      metrics.pause_count += 1;
      metrics.max_pause_ms = Math.max(metrics.max_pause_ms, pauseMs);
    }
    if (pauseMs > 0 && pauseMs < 1500) metrics.active_typing_ms += pauseMs;

    telemetry.lastInputAtMs[fieldName] = now;
    telemetry.previousLength[fieldName] = nextValue.length;
    recordInteraction(fieldName, "input", nextValue.length, selectionStart, selectionEnd, {
      delta,
      pause_ms: pauseMs,
    });
    setValue(nextValue);
  };

  const buildTelemetryPayload = (): EntryTelemetryPayload => {
    const telemetry = telemetryRef.current;
    const submittedAt = new Date();
    const durationMs = submittedAt.getTime() - telemetry.startedAtMs;
    return {
      session_id: telemetry.sessionId,
      started_at: telemetry.startedAt,
      submitted_at: submittedAt.toISOString(),
      client_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      user_agent: typeof navigator === "undefined" ? undefined : navigator.userAgent,
      events: telemetry.events,
      field_metrics: telemetry.fieldMetrics,
      aggregate_metrics: {
        total_duration_ms: durationMs,
        event_count: telemetry.events.length,
        field_order: telemetry.fieldOrder,
      },
    };
  };

  const loadEntries = useCallback(async () => {
    try {
      const data = await ApiClient.getEntries(userId);
      console.info("[entries] loaded", { count: data.length });
      setEntries(data);
    } catch (err) {
      console.warn("[entries] load failed", err);
      setEntries([]);
    }
  }, [userId]);

  const loadGraphSnapshots = useCallback(async () => {
    try {
      const data = await ApiClient.getGraphSnapshots(userId);
      setGraphSnapshots(data);
    } catch (err) {
      console.warn("[graph-snapshots] load failed", err);
      setGraphSnapshots([]);
    }
  }, [userId]);

  const loadConversationRecall = useCallback(async () => {
    try {
      const data = await ApiClient.getConversationRecallWithFallback(userId);
      setConversationRecall(data);
    } catch (err) {
      console.warn("[conversation_recall_30] load failed", err);
      setConversationRecall(null);
    }
  }, [userId]);

  useEffect(() => { loadEntries(); loadGraphSnapshots(); loadConversationRecall(); }, [loadEntries, loadGraphSnapshots, loadConversationRecall]);

  useEffect(() => {
    if (!participant?.id) return;
    const channel = supabase
      .channel(`entries-${participant.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "entries",
          filter: `participant_id=eq.${participant.id}`,
        },
        () => {
          console.info("[entries] realtime change received");
          void loadEntries();
        },
      )
      .subscribe((status, err) => {
        console.info("[entries] realtime status", { status, error: err ?? null });
      });
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [loadEntries, participant?.id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const combinedText = [journalText, recallText].filter((value) => value.trim()).join("\n\n");
    if (!combinedText.trim()) return;
    setIsSubmitting(true);
    setJournalComplete(false);
    setJournalStep(0);
    setError(null);
    setSubmitted(false);
    let timer: number | null = null;
    try {
      timer = window.setInterval(() => {
        setJournalStep((step) => Math.min(step + 1, journalSteps.length - 2));
      }, 900);
      const consent: ConsentSnapshot = {
        app_use: true,
        research_analysis: true,
        anonymized_export: false,
        future_fine_tuning: false,
        consent_version: "research-consent-v1",
      };
      const response = await ApiClient.createEntry(userId, combinedText, "daily", {
        journal_text: journalText,
        recall_text: recallText,
        telemetry: buildTelemetryPayload(),
        consent,
      });
      window.clearInterval(timer);
      timer = null;
      setJournalStep(journalSteps.length - 1);
      setJournalComplete(true);
      setLastSubmission(response);

      const safetyAssessment = response.extraction.safety_assessment_json;
      if (safetyAssessment?.risk_level === "crisis") {
        setIsSafetyDiverted(true);
        setSafetyMessage(safetyAssessment.safe_response);
      } else {
        setIsSafetyDiverted(false);
        setSafetyMessage("");
      }

      setEntries((current) => [response.entry, ...current.filter((entry) => entry.id !== response.entry.id)]);
      setJournalText("");
      setRecallText("");
      telemetryRef.current = createTelemetryState();
      setSubmitted(true);
      await loadEntries();
      await loadGraphSnapshots();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed.");
    } finally {
      if (timer) window.clearInterval(timer);
      setIsSubmitting(false);
    }
  };

  const handleChatSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatText.trim()) return;
    setIsChatSubmitting(true);
    setChatComplete(false);
    setChatStep(0);
    setChatError(null);
    let timer: number | null = null;
    try {
      timer = window.setInterval(() => {
        setChatStep((step) => Math.min(step + 1, chatSteps.length - 2));
      }, 900);
      const response = await ApiClient.createChat(userId, chatText.trim(), 5);
      window.clearInterval(timer);
      timer = null;
      setChatStep(chatSteps.length - 1);
      setChatComplete(true);
      setChatResponse(response);
      setConversationRecall(response.conversation_recall_30 ?? null);
      setChatText("");
      void loadConversationRecall();
    } catch (err) {
      setChatError(err instanceof Error ? err.message : "Chat failed.");
    } finally {
      if (timer) window.clearInterval(timer);
      setIsChatSubmitting(false);
    }
  };

  const recordTranscriptInteraction = (fieldName: "journal_entry" | "first_recall_30", nextValue: string, previousValue: string) => {
    const now = Date.now();
    const metrics = ensureFieldMetrics(fieldName);
    if (!metrics.first_input_at) metrics.first_input_at = new Date(now).toISOString();
    metrics.last_input_at = new Date(now).toISOString();
    metrics.input_count += 1;
    metrics.revision_count += 1;
    telemetryRef.current.lastInputAtMs[fieldName] = now;
    telemetryRef.current.previousLength[fieldName] = nextValue.length;
    if (!telemetryRef.current.fieldOrder.includes(fieldName)) telemetryRef.current.fieldOrder.push(fieldName);
    recordInteraction(fieldName, "voice_transcript", nextValue.length, null, null, {
      source: "openai_transcription",
      inserted_chars: nextValue.length - previousValue.length,
    });
  };

  const insertTranscript = (target: "journal" | "recall" | "chat", text: string) => {
    const append = (current: string) => [current.trim(), text.trim()].filter(Boolean).join(current.trim() ? "\n" : "");
    if (target === "chat") {
      setChatText((current) => append(current));
    }
    if (target === "recall") {
      setRecallText((current) => {
        const nextValue = append(current);
        recordTranscriptInteraction("first_recall_30", nextValue, current);
        return nextValue;
      });
    }
    if (target === "journal") {
      setJournalText((current) => {
        const nextValue = append(current);
        recordTranscriptInteraction("journal_entry", nextValue, current);
        return nextValue;
      });
    }
  };

  /* Derived data for the reflection signal panel */
  const graphSummary =
    lastSubmission?.explanation?.graph_summary_json ??
    lastSubmission?.graph_snapshot?.graph_summary_json;

  const score = lastSubmission?.anomaly_result?.anomaly_score;
  const reflectionStatus = lastSubmission?.explanation?.baseline_deviation_json?.status;
  const reflectionUnavailable = !lastSubmission || score === undefined || score === null || reflectionStatus === "not_enough_data";

  const topNodes = useMemo(() => {
    const nodes = [...(lastSubmission?.graph_snapshot?.nodes_json ?? [])];
    const order = ["Protective", "Event", "Behavior", "Trigger", "State"];
    return nodes
      .sort((a, b) => Math.max(0, order.indexOf(a.category)) - Math.max(0, order.indexOf(b.category)))
      .slice(0, 5);
  }, [lastSubmission]);

  const reflectionCards = lastSubmission?.extraction.reflection_cards_json ?? [];
  const emotionalState = lastSubmission?.extraction.emotional_state_json;
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
              Two short notes are enough. Sentra keeps the student experience simple while recording research metadata transparently.
            </p>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-7 py-6 space-y-4">
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <label className="inscription block" htmlFor="journal-entry">Journal Entry</label>
              <VoiceInputButton
                disabled={isSubmitting}
                onTranscript={(text) => insertTranscript("journal", text)}
              />
            </div>
            <textarea
              id="journal-entry"
              className="w-full resize-none p-4 text-base leading-relaxed outline-none transition-all"
              rows={5}
              style={{
                ...bodyFont,
                border: "1px solid var(--limestone)",
                backgroundColor: "var(--ivory-warm)",
                color: "var(--ink)",
                fontSize: "1rem",
              }}
              placeholder="Write what happened today, how it felt, or what stood out."
              value={journalText}
              onFocus={() => handleFieldFocus("journal_entry", journalText.length)}
              onBlur={() => handleFieldBlur("journal_entry", journalText.length)}
              onPaste={() => handleFieldPaste("journal_entry", journalText.length)}
              onChange={(e) => handleFieldChange("journal_entry", e.target.value, setJournalText, e.target.selectionStart, e.target.selectionEnd)}
              disabled={isSubmitting}
            />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <label className="inscription block" htmlFor="first-recall">30-First-Recall</label>
              <VoiceInputButton
                disabled={isSubmitting}
                onTranscript={(text) => insertTranscript("recall", text)}
              />
            </div>
            <textarea
              id="first-recall"
              className="w-full resize-none p-4 text-base leading-relaxed outline-none transition-all"
              rows={3}
              style={{
                ...bodyFont,
                border: "1px solid var(--limestone)",
                backgroundColor: "var(--ivory-warm)",
                color: "var(--ink)",
                fontSize: "1rem",
              }}
              placeholder="Without overthinking, write the first thing you remember from the last 30 seconds."
              value={recallText}
              onFocus={() => handleFieldFocus("first_recall_30", recallText.length)}
              onBlur={() => handleFieldBlur("first_recall_30", recallText.length)}
              onPaste={() => handleFieldPaste("first_recall_30", recallText.length)}
              onChange={(e) => handleFieldChange("first_recall_30", e.target.value, setRecallText, e.target.selectionStart, e.target.selectionEnd)}
              disabled={isSubmitting}
            />
          </div>

          <p className="text-xs leading-relaxed" style={{ color: "var(--ink-faint)", fontStyle: "italic" }}>
            Sentra records writing-process metadata such as timing, pauses, edits, and field order for transparent research analysis.
          </p>

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
                {journalText.length + recallText.length > 0 ? `${journalText.length + recallText.length} chars` : ""}
              </span>
            )}

            <button
              type="submit"
              disabled={isSubmitting || !(journalText.trim() || recallText.trim())}
              className="inline-flex items-center gap-2 px-6 py-2.5 transition-all disabled:cursor-not-allowed rounded-md font-semibold cursor-pointer"
              style={{
                ...displayFont,
                backgroundColor: isSubmitting || !(journalText.trim() || recallText.trim()) ? "var(--limestone)" : "var(--gold)",
                color: isSubmitting || !(journalText.trim() || recallText.trim()) ? "var(--ink-faint)" : "#000000",
                border: `1px solid ${isSubmitting || !(journalText.trim() || recallText.trim()) ? "var(--limestone)" : "var(--gold)"}`,
                boxShadow: isSubmitting || !(journalText.trim() || recallText.trim()) ? "none" : "0 0 14px rgba(6, 182, 212, 0.4)",
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

          <ProcessingTimeline
            steps={journalSteps}
            active={isSubmitting}
            currentStep={journalStep}
            complete={journalComplete && submitted && !error}
          />

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

      {isSafetyDiverted && (
        <section
          role="alert"
          aria-live="assertive"
          className="mb-8 px-7 py-6"
          style={{
            ...panel,
            border: "2px solid var(--terracotta)",
            backgroundColor: "rgba(244, 63, 94, 0.10)",
          }}
        >
          <div className="mb-3 flex items-center gap-2">
            <AlertCircle className="h-5 w-5 shrink-0" style={{ color: "var(--sienna)" }} />
            <h2 style={{ ...displayFont, color: "var(--sienna)", fontWeight: 700 }}>
              Immediate human support recommended
            </h2>
          </div>
          <p className="text-sm leading-relaxed" style={{ color: "var(--ink)", ...bodyFont }}>
            {safetyMessage}
          </p>
          <p className="mt-3 text-xs" style={{ color: "var(--ink-mid)", ...bodyFont }}>
            BLESC is not a clinical assessment or an emergency service.
          </p>
        </section>
      )}

      {/* ── Reflection signal result ───────────────────────────── */}
      {lastSubmission && (
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
                <div className="inscription mb-1">Reflection Signal</div>
                <div
                  className={`${reflectionUnavailable ? "text-3xl" : "text-5xl"} leading-none`}
                  style={{ ...displayFont, fontWeight: 700, color: "var(--ink)", letterSpacing: "0.02em" }}
                >
                  {reflectionUnavailable ? "Not enough data" : typeof score === "number" ? score.toFixed(2) : "Not enough data"}
                </div>
                <div className="mt-2 max-w-52 text-xs leading-relaxed" style={{ color: "var(--ink-mid)", ...bodyFont }}>
                  {reflectionUnavailable
                    ? "BLESC needs more personal history before calculating a non-diagnostic signal."
                    : "Non-diagnostic pattern difference. Use it as a prompt to reflect, not as a clinical conclusion."
                  }
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

          {reflectionCards.length > 0 && (
            <div className="px-7 py-5" style={{ borderTop: "1px solid var(--limestone)" }}>
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4" style={{ color: "var(--gold)" }} />
                  <div className="inscription">Reflection Cards</div>
                </div>
                {emotionalState?.safety_classification?.level && (
                  <span
                    className="px-2 py-1 text-xs"
                    style={{
                      ...displayFont,
                      border: "1px solid var(--limestone)",
                      color: emotionalState.safety_classification.level === "crisis" ? "var(--sienna)" : "var(--ink-faint)",
                      backgroundColor: "rgba(255,255,255,0.04)",
                      fontSize: "0.5rem",
                      letterSpacing: "0.14em",
                      textTransform: "uppercase",
                    }}
                  >
                    {emotionalState.safety_classification.level}
                  </span>
                )}
              </div>
              <div className="grid gap-3">
                {reflectionCards.map((card) => (
                  <article
                    key={card.id}
                    className="p-4"
                    style={{
                      border: "1px solid var(--limestone)",
                      backgroundColor: card.status === "suppressed" ? "rgba(244,63,94,0.08)" : "var(--ivory-warm)",
                    }}
                  >
                    <div
                      className="mb-1 text-sm"
                      style={{ ...displayFont, fontWeight: 700, color: "var(--ink)", letterSpacing: "0.04em" }}
                    >
                      {card.title}
                    </div>
                    <p className="text-sm leading-relaxed" style={{ color: "var(--ink-mid)", fontStyle: "italic", ...bodyFont }}>
                      {card.body}
                    </p>
                    <div className="mt-2 text-xs" style={{ color: "var(--ink-faint)", ...bodyFont }}>
                      {card.type.replaceAll("_", " ")} · {card.confidence} confidence
                    </div>
                  </article>
                ))}
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

      {/* ── Conversation recall ───────────────────────────────── */}
      <section style={panel} className="mb-8">
        <div
          className="px-7 py-5"
          style={{ borderBottom: "1px solid var(--limestone)", backgroundColor: "var(--ivory-warm)" }}
        >
          <div className="flex items-center gap-2">
            <MessageCircle className="h-4 w-4" style={{ color: "var(--gold)" }} />
            <div className="inscription">30-Turn Recall</div>
          </div>
          <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--ink-mid)", fontStyle: "italic", ...bodyFont }}>
            {conversationRecall?.status === "completed"
              ? conversationRecall.summary_json.summary
              : "Not enough conversation history."
            }
          </p>
          {conversationRecall?.status === "completed" && (
            <div className="mt-3 flex flex-wrap gap-2">
              {(conversationRecall.summary_json.recurring_topics ?? conversationRecall.summary_json.top_topics ?? []).slice(0, 5).map((topic) => (
                <span
                  key={topic.topic}
                  className="px-2 py-1 text-xs"
                  style={{
                    border: "1px solid var(--limestone)",
                    color: "var(--ink-mid)",
                    backgroundColor: "rgba(255,255,255,0.04)",
                    ...displayFont,
                  }}
                >
                  {topic.topic} · {topic.count}
                </span>
              ))}
            </div>
          )}
          <p className="mt-3 text-xs" style={{ color: "var(--ink-faint)", fontStyle: "italic" }}>
            {conversationRecall
              ? `${conversationRecall.window_turn_count}/${conversationRecall.required_turn_count} minimum turns available`
              : "Conversation summary has not been calculated yet."
            }
          </p>
          <Link
            href="/recall"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex items-center gap-2 rounded-md px-4 py-2 text-xs font-semibold transition-all"
            style={{
              ...displayFont,
              border: "1px solid var(--gold)",
              color: "var(--ink)",
              backgroundColor: "rgba(167,139,250,0.12)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              textDecoration: "none",
            }}
          >
            Open 30-Turn Recall Workspace
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
          <Link
            href="/voice"
            target="_blank"
            rel="noopener noreferrer"
            className="ml-3 mt-4 inline-flex items-center gap-2 rounded-md px-4 py-2 text-xs font-semibold transition-all"
            style={{
              ...displayFont,
              border: "1px solid rgba(34,211,238,0.55)",
              color: "var(--ink)",
              backgroundColor: "rgba(34,211,238,0.10)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              textDecoration: "none",
            }}
          >
            Open Voice Workspace
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
        <form onSubmit={handleChatSubmit} className="px-7 py-5 space-y-3">
          <textarea
            className="w-full resize-none p-4 text-base leading-relaxed outline-none transition-all"
            rows={3}
            style={{
              ...bodyFont,
              border: "1px solid var(--limestone)",
              backgroundColor: "var(--ivory-warm)",
              color: "var(--ink)",
              fontSize: "1rem",
            }}
            placeholder="Ask BLESC to reflect on recent patterns."
            value={chatText}
            onChange={(event) => setChatText(event.target.value)}
            disabled={isChatSubmitting}
          />
          <div className="flex items-center justify-between gap-4">
            <span className="text-xs" style={{ color: "var(--ink-faint)", fontStyle: "italic" }}>
              Chat messages remain user data and are not uploaded to OpenAI Vector Store.
            </span>
            <div className="flex items-center gap-2">
              <VoiceInputButton
                disabled={isChatSubmitting}
                onTranscript={(text) => insertTranscript("chat", text)}
              />
              <button
                type="submit"
                disabled={isChatSubmitting || !chatText.trim()}
                className="inline-flex items-center gap-2 px-5 py-2.5 transition-all disabled:cursor-not-allowed rounded-md font-semibold cursor-pointer"
                style={{
                  ...displayFont,
                  backgroundColor: isChatSubmitting || !chatText.trim() ? "var(--limestone)" : "var(--gold)",
                  color: isChatSubmitting || !chatText.trim() ? "var(--ink-faint)" : "#000000",
                  border: `1px solid ${isChatSubmitting || !chatText.trim() ? "var(--limestone)" : "var(--gold)"}`,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  fontSize: "0.62rem",
                }}
              >
                {isChatSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3 w-3" />}
                Send
              </button>
            </div>
          </div>
          <ProcessingTimeline
            steps={chatSteps}
            active={isChatSubmitting}
            currentStep={chatStep}
            complete={chatComplete && Boolean(chatResponse?.answer) && !chatError}
          />
          {chatError && (
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
              {chatError}
            </div>
          )}
          {chatResponse?.answer && (
            <div
              className="p-4 text-sm leading-relaxed"
              style={{ border: "1px solid var(--limestone)", backgroundColor: "var(--ivory-warm)", color: "var(--ink-mid)" }}
            >
              {chatResponse.answer}
              <div className="mt-3 text-xs" style={{ color: "var(--ink-faint)", fontStyle: "italic" }}>
                Retrieval source: {Object.entries((chatResponse.retrieval_context.retrieval_sources as Record<string, unknown> | undefined) ?? {})
                  .filter(([, value]) => Boolean(value))
                  .map(([key]) => key)
                  .join(", ") || "none"}
              </div>
            </div>
          )}
        </form>
      </section>

      {/* ── Recent entries ─────────────────────────────────────── */}
      <section>
        <div className="inscription mb-4">Recent Records</div>
        <div style={{ border: "1px solid var(--limestone)", backgroundColor: "var(--ivory)" }}>
          {recentEntries.length === 0 ? (
            <div className="px-6 py-4 text-sm" style={{ color: "var(--ink-faint)", fontStyle: "italic" }}>
              No records yet.
            </div>
          ) : recentEntries.map((entry, i) => (
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
            ))
          }
        </div>
      </section>

    </div>
  );
}
