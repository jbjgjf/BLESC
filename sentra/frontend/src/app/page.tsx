"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ApiClient } from "@/api/client";
import { Entry, EntrySubmissionResponse, ExtractionRelation, GraphSnapshot } from "@/api/models";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  GitBranch,
  History,
  Loader2,
  MessageSquare,
  Network,
  Send,
  ShieldCheck,
  TriangleAlert,
  Sparkles,
} from "lucide-react";
import { demoEntries, demoGraphSnapshots, demoSubmission } from "@/lib/demoData";
import { useAuth } from "@/lib/auth";

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

export default function Home() {
  const { userId } = useAuth();
  const [text, setText] = useState("");
  const [entries, setEntries] = useState<Entry[]>(demoEntries);
  const [graphSnapshots, setGraphSnapshots] = useState<GraphSnapshot[]>(demoGraphSnapshots);
  const [lastSubmission, setLastSubmission] = useState<EntrySubmissionResponse | null>(demoSubmission);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Observation Type Selection ("daily" | "rally" | "weekly")
  const [observationType, setObservationType] = useState<"daily" | "rally" | "weekly">("daily");

  // Floating Rally Chat Widget States
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [rallyMessages, setRallyMessages] = useState<Array<{ sender: "user" | "ai"; text: string }>>([
    { sender: "ai", text: "Hello! This is the Rally diagnosis assistant. Let's chat to compile observation details. After 30 rallies, we will run the primary diagnosis." },
  ]);
  const [rallyInput, setRallyInput] = useState("");
  const [rallyCount, setRallyCount] = useState(0);
  const [isRallySubmitting, setIsRallySubmitting] = useState(false);
  const [rallyResult, setRallyResult] = useState<EntrySubmissionResponse | null>(null);

  // Dragging states for Rally Chat Widget
  const [chatPos, setChatPos] = useState({ x: 0, y: 0 });
  const [isDraggingChat, setIsDraggingChat] = useState(false);
  const [dragStartPos, setDragStartPos] = useState({ x: 0, y: 0 });

  const handleChatMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".drag-handle")) {
      setIsDraggingChat(true);
      setDragStartPos({
        x: e.clientX - chatPos.x,
        y: e.clientY - chatPos.y,
      });
      e.preventDefault();
    }
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingChat) return;
      setChatPos({
        x: e.clientX - dragStartPos.x,
        y: e.clientY - dragStartPos.y,
      });
    };
    const handleMouseUp = () => {
      setIsDraggingChat(false);
    };

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
      if (!submitText) {
        setText("");
      }
      loadEntries();
      loadGraphSnapshots();
      return response;
    } catch {
      setError("Submission failed. Check backend connection.");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Handle a single Rally message exchange
  const handleSendRally = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rallyInput.trim() || isRallySubmitting) return;

    const userMsg = rallyInput.trim();
    setRallyInput("");

    // Add user message
    const updatedMessages = [...rallyMessages, { sender: "user" as const, text: userMsg }];
    setRallyMessages(updatedMessages);

    const nextCount = rallyCount + 1;
    setRallyCount(nextCount);

    if (nextCount >= 30) {
      setIsRallySubmitting(true);
      // Compile all user messages into a single text block
      const compiledText = updatedMessages
        .filter((m) => m.sender === "user")
        .map((m) => m.text)
        .join("\n\n");

      try {
        const response = await handleSubmit(undefined, compiledText, "rally");
        if (response) {
          setRallyResult(response);
          setRallyMessages((prev) => [
            ...prev,
            {
              sender: "ai",
              text: `🎉 30 Rallies completed! Primary diagnosis has been generated and saved. Anomaly Score: ${response.anomaly_result?.anomaly_score?.toFixed(2) ?? "--"}. Summary: ${response.explanation?.graph_summary_json?.summary || response.graph_snapshot?.graph_summary_json?.summary || "Observation saved."}`,
            },
          ]);
        }
      } catch {
        setRallyMessages((prev) => [
          ...prev,
          { sender: "ai", text: "❌ Failed to save diagnosis. Please try again." },
        ]);
      } finally {
        setIsRallySubmitting(false);
      }
    } else {
      // Simulate AI response
      setTimeout(() => {
        const randomReply = AI_RALLY_RESPONSES[Math.floor(Math.random() * AI_RALLY_RESPONSES.length)];
        setRallyMessages((prev) => [
          ...prev,
          { sender: "ai", text: `[Rally #${nextCount}] ${randomReply}` },
        ]);
      }, 500);
    }
  };

  const resetRally = () => {
    setRallyMessages([
      { sender: "ai", text: "Hello! This is the Rally diagnosis assistant. Let's chat to compile observation details. After 30 rallies, we will run the primary diagnosis." },
    ]);
    setRallyCount(0);
    setRallyResult(null);
  };

  const groupedNodes = useMemo(() => {
    const nodes = [...(lastSubmission?.graph_snapshot?.nodes_json ?? [])];
    return nodes.sort((a, b) => categoryRank(a.category) - categoryRank(b.category));
  }, [lastSubmission]);

  const nodeLabels = useMemo(
    () => new Map(groupedNodes.map((node) => [node.id, node.label])),
    [groupedNodes],
  );

  const graphSummary = lastSubmission?.explanation?.graph_summary_json ?? lastSubmission?.graph_snapshot?.graph_summary_json;
  const keyRelations = lastSubmission?.explanation?.key_relations ?? graphSummary?.key_relations ?? [];
  const temporalDiff = lastSubmission?.graph_snapshot?.temporal_diff_json;
  const score = lastSubmission?.anomaly_result?.anomaly_score;
  const topNodes = groupedNodes.slice(0, 5);
  const recentEntries = entries.slice(0, 10);
  const latestDay = lastSubmission?.graph_snapshot?.day ?? graphSnapshots.at(-1)?.day ?? "No snapshot";

  return (
    <div className="max-w-4xl mx-auto space-y-8 py-6 px-4 font-sans text-slate-800 antialiased selection:bg-slate-200">
      
      {/* Premium Notion-style minimal header */}
      <header className="pb-4 border-b border-slate-100">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
          <ShieldCheck className="h-4 w-4 text-slate-400" />
          Sentra Assessment Workspace
        </div>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900">Observation Dashboard</h1>
        <p className="mt-1 text-sm text-slate-500 leading-relaxed">
          Capture structural clinical observations, calculate baseline anomalies, and trace temporal risk signals.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <span className="inline-flex items-center rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
            User: {userId}
          </span>
          <span className="inline-flex items-center rounded bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700">
            Supabase Sandbox
          </span>
        </div>
      </header>

      {/* Main Grid: Left Column (Observation intake), Right Column (Minimal Diagnostics Info) */}
      <div className="grid gap-8 md:grid-cols-[1fr_280px] items-start">
        
        {/* Left Area: Notion-like toggle forms & tables */}
        <div className="space-y-6">
          
          {/* New Observation form */}
          <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm transition-all hover:shadow-md">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <FileText className="h-4.5 w-4.5 text-slate-500" />
                New Observation Intake
              </div>
              
              {/* Notion-style Dropdown Selector for Observation Type */}
              <div className="relative">
                <select
                  value={observationType}
                  onChange={(e) => setObservationType(e.target.value as "daily" | "rally" | "weekly")}
                  className="appearance-none bg-slate-50 border border-slate-200 text-xs font-medium text-slate-700 px-3 py-1.5 pr-8 rounded-md outline-none cursor-pointer hover:bg-slate-100 transition-colors"
                >
                  <option value="daily">Daily Intake</option>
                  <option value="rally">Rally (30-round chat)</option>
                  <option value="weekly">Weekly Assessment</option>
                </select>
                <ChevronDown className="absolute right-2.5 top-2.5 h-3 w-3 text-slate-500 pointer-events-none" />
              </div>
            </div>

            {observationType === "rally" ? (
              <div className="mt-4 rounded-md border border-dashed border-slate-200 bg-slate-50 p-6 text-center">
                <Sparkles className="mx-auto h-8 w-8 text-sky-600 animate-pulse" />
                <h3 className="mt-2 text-sm font-semibold text-slate-950">Rally Mode Selected</h3>
                <p className="mt-1 text-xs text-slate-500 max-w-sm mx-auto">
                  Rally mode generates a primary diagnosis after completing a 30-round interview. Use the floating chat button in the bottom right to start your Rally.
                </p>
                <button
                  onClick={() => setIsChatOpen(true)}
                  className="mt-4 inline-flex items-center gap-1.5 rounded bg-slate-900 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 transition"
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                  Open Rally Chat
                </button>
              </div>
            ) : (
              <form onSubmit={(e) => handleSubmit(e)} className="mt-4 space-y-3">
                <textarea
                  className="h-36 w-full resize-none rounded-md border border-slate-200 bg-slate-50 p-3 text-sm leading-relaxed text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-slate-400 focus:bg-white"
                  placeholder={
                    observationType === "weekly"
                      ? "Summarize academic drift, behavioral patterns, interventions, and structural updates observed over the past week."
                      : "Describe attendance shifts, trigger elements, protective factors, or behavioral transitions observed today."
                  }
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  disabled={isSubmitting}
                />
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-400">{text.length} characters</span>
                  <button
                    type="submit"
                    disabled={isSubmitting || !text.trim()}
                    className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-4 py-2 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
                  >
                    {isSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                    Extract & Save
                  </button>
                </div>
                {error && (
                  <div className="flex items-center gap-2 rounded-md bg-rose-50 border border-rose-100 p-2.5 text-xs text-rose-700">
                    <AlertCircle className="h-4 w-4" />
                    <span>{error}</span>
                  </div>
                )}
              </form>
            )}
          </div>

          {/* Collapsible details / Notion Toggles Section */}
          <div className="space-y-3">
            
            {/* Toggle 1: Structural Summary */}
            <details className="group rounded-lg border border-slate-200 bg-white p-4 shadow-sm" open>
              <summary className="flex cursor-pointer items-center justify-between text-sm font-semibold text-slate-900 [&::-webkit-details-marker]:hidden list-none">
                <div className="flex items-center gap-2">
                  <ChevronRight className="h-4 w-4 text-slate-400 transition-transform group-open:rotate-90" />
                  <Network className="h-4 w-4 text-slate-500" />
                  <span>Structural Summary ({latestDay})</span>
                </div>
                <span className="text-xs font-normal text-slate-400">Toggle</span>
              </summary>
              <div className="mt-4 pt-3 border-t border-slate-100 space-y-2">
                <div className="divide-y divide-slate-100">
                  {topNodes.map((node) => (
                    <div key={node.id} className="grid gap-2 py-2.5 text-xs sm:grid-cols-[120px_1fr_150px]">
                      <span className="font-semibold text-slate-400">{node.category}</span>
                      <span className="font-medium text-slate-900">{node.label}</span>
                      <span className="text-slate-400 text-right">
                        int. {node.intensity.toFixed(2)} / conf. {node.confidence.toFixed(2)}
                      </span>
                    </div>
                  ))}
                  {topNodes.length === 0 && <p className="text-xs text-slate-400 py-2">No nodes extracted yet.</p>}
                </div>
              </div>
            </details>

            {/* Toggle 2: Key Relations */}
            <details className="group rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <summary className="flex cursor-pointer items-center justify-between text-sm font-semibold text-slate-900 [&::-webkit-details-marker]:hidden list-none">
                <div className="flex items-center gap-2">
                  <ChevronRight className="h-4 w-4 text-slate-400 transition-transform group-open:rotate-90" />
                  <GitBranch className="h-4 w-4 text-slate-500" />
                  <span>Key Relations</span>
                </div>
                <span className="text-xs font-normal text-slate-400">Toggle</span>
              </summary>
              <div className="mt-4 pt-3 border-t border-slate-100">
                <div className="divide-y divide-slate-100">
                  {keyRelations.slice(0, 5).map((relation) => (
                    <div key={`${relation.source_id}-${relation.target_id}-${relation.type}`} className="py-2 text-xs">
                      <div className="font-semibold text-slate-800">{relationLabel(relation, nodeLabels)}</div>
                      <div className="text-[10px] text-slate-400 mt-0.5">confidence: {relation.confidence.toFixed(2)}</div>
                    </div>
                  ))}
                  {keyRelations.length === 0 && <p className="text-xs text-slate-400 py-2">No key relations extracted.</p>}
                </div>
              </div>
            </details>

            {/* Toggle 3: Drift Note & Protective Factors */}
            <details className="group rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <summary className="flex cursor-pointer items-center justify-between text-sm font-semibold text-slate-900 [&::-webkit-details-marker]:hidden list-none">
                <div className="flex items-center gap-2">
                  <ChevronRight className="h-4 w-4 text-slate-400 transition-transform group-open:rotate-90" />
                  <TriangleAlert className="h-4 w-4 text-slate-500" />
                  <span>Drift Assessment & Uncertainty</span>
                </div>
                <span className="text-xs font-normal text-slate-400">Toggle</span>
              </summary>
              <div className="mt-4 pt-3 border-t border-slate-100 space-y-3">
                <p className="text-xs text-slate-600 leading-relaxed bg-slate-50 p-2.5 rounded border border-slate-100">
                  {temporalDiff?.relation_shift_summary ?? "No temporal drift summary available."}
                </p>
                <div className="text-[11px] text-slate-500 space-y-1">
                  <div><strong>Protective decline ratio:</strong> {JSON.stringify(temporalDiff?.protective_decline ?? {})}</div>
                  <div><strong>Uncertainty details:</strong> {JSON.stringify(temporalDiff?.uncertainty ?? {})}</div>
                </div>
              </div>
            </details>

            {/* Toggle 4: Recent Observation Logs */}
            <details className="group rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <summary className="flex cursor-pointer items-center justify-between text-sm font-semibold text-slate-900 [&::-webkit-details-marker]:hidden list-none">
                <div className="flex items-center gap-2">
                  <ChevronRight className="h-4 w-4 text-slate-400 transition-transform group-open:rotate-90" />
                  <History className="h-4 w-4 text-slate-500" />
                  <span>Recent Observation History</span>
                </div>
                <span className="text-xs font-normal text-slate-400">Toggle</span>
              </summary>
              <div className="mt-4 pt-3 border-t border-slate-100">
                <div className="divide-y divide-slate-100">
                  {recentEntries.map((entry) => (
                    <div key={entry.id} className="py-2.5 text-xs flex justify-between gap-4">
                      <div>
                        <div className="font-semibold text-slate-700">
                          {new Date(entry.created_at).toLocaleString()}
                        </div>
                        <div className="text-slate-400 mt-1 max-w-md break-words font-mono">
                          {entry.raw_text ?? "Structural representation persisted."}
                        </div>
                      </div>
                      <div className="text-right flex flex-col items-end gap-1 select-none">
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-500 uppercase">
                          {entry.observation_type ?? "daily"}
                        </span>
                        <span className="text-[9px] text-emerald-600 flex items-center gap-0.5">
                          <CheckCircle2 className="h-2.5 w-2.5" /> masked
                        </span>
                      </div>
                    </div>
                  ))}
                  {recentEntries.length === 0 && <p className="text-xs text-slate-400 py-2">No historical records found.</p>}
                </div>
              </div>
            </details>
          </div>
        </div>

        {/* Right Sidebar: Minimal Notion Stats */}
        <aside className="space-y-6">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 shadow-sm">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Latest Stats</h3>
            <div className="mt-4 space-y-3">
              <div>
                <span className="text-[10px] text-slate-400 block">Anomaly Score</span>
                <span className="text-2xl font-bold text-slate-900">
                  {score === undefined ? "--" : score.toFixed(2)}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-200">
                <div>
                  <span className="text-[9px] text-slate-400 block">Nodes</span>
                  <span className="text-sm font-semibold text-slate-900">{graphSummary?.node_count ?? 0}</span>
                </div>
                <div>
                  <span className="text-[9px] text-slate-400 block">Relations</span>
                  <span className="text-sm font-semibold text-slate-900">{graphSummary?.relation_count ?? 0}</span>
                </div>
              </div>
            </div>
            
            <p className="mt-4 text-xs text-slate-500 leading-relaxed">
              {graphSummary?.summary ?? "No graph summary available."}
            </p>

            <div className="mt-4 pt-3 border-t border-slate-200 space-y-2">
              <Link href="/graph" className="flex items-center justify-between text-xs text-slate-600 hover:text-slate-900 hover:underline">
                <span>Open interactive graph</span>
                <ArrowRight className="h-3 w-3" />
              </Link>
              <Link href="/insights" className="flex items-center justify-between text-xs text-slate-600 hover:text-slate-900 hover:underline">
                <span>Review detailed evidence</span>
                <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
          </div>
        </aside>
      </div>

      {/* Floating Black Circle Button (C-Circle with blue ring) */}
      <div className="fixed bottom-6 right-6 z-50">
        <button
          onClick={() => setIsChatOpen(!isChatOpen)}
          className="relative w-14 h-14 rounded-full bg-neutral-900 flex items-center justify-center text-white font-semibold text-2xl shadow-xl transition-transform active:scale-95 focus:outline-none ring-4 ring-blue-600 border border-neutral-950 group"
          title="Rally Diagnostic Chat"
          id="rally-chat-launcher"
        >
          <span>C</span>
          {rallyCount > 0 && rallyCount < 30 && (
            <span className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-sky-500 text-[10px] font-bold text-white ring-2 ring-white animate-bounce">
              {rallyCount}
            </span>
          )}
        </button>
      </div>

      {/* Floating Notion-style Chat Popup */}
      {isChatOpen && (
        <div 
          style={{ transform: `translate(${chatPos.x}px, ${chatPos.y}px)` }}
          className="fixed bottom-24 right-6 w-96 max-w-[calc(100vw-2rem)] h-[500px] bg-white border border-slate-200 rounded-xl shadow-2xl flex flex-col z-50 overflow-hidden font-sans"
        >
          
          {/* Header */}
          <div 
            onMouseDown={handleChatMouseDown}
            className="drag-handle bg-slate-950 text-white p-3.5 flex items-center justify-between select-none cursor-grab active:cursor-grabbing"
          >
            <div className="flex items-center gap-2 pointer-events-none">
              <div className="h-2 w-2 rounded-full bg-sky-400 animate-pulse" />
              <span className="text-xs font-bold tracking-wide uppercase">Rally Interview Helper</span>
            </div>
            <div className="text-[10px] text-slate-400 font-semibold bg-slate-900 px-2 py-0.5 rounded pointer-events-none">
              Round {rallyCount} / 30
            </div>
          </div>

          {/* Progress Indicator */}
          <div className="bg-slate-100 h-1.5 w-full">
            <div
              className="bg-sky-500 h-full transition-all duration-300"
              style={{ width: `${Math.min(100, (rallyCount / 30) * 100)}%` }}
            />
          </div>

          {/* Messages Area */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3.5 bg-slate-50">
            {rallyMessages.map((msg, index) => (
              <div
                key={index}
                className={`flex ${msg.sender === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-lg p-2.5 text-xs leading-relaxed ${
                    msg.sender === "user"
                      ? "bg-slate-900 text-white rounded-br-none"
                      : "bg-white border border-slate-200 text-slate-800 rounded-bl-none shadow-sm"
                  }`}
                >
                  {msg.text}
                </div>
              </div>
            ))}
            
            {isRallySubmitting && (
              <div className="flex justify-start">
                <div className="bg-white border border-slate-200 rounded-lg p-3 text-xs text-slate-500 flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin text-sky-600" />
                  Analyzing conversation and generating primary diagnosis...
                </div>
              </div>
            )}
          </div>

          {/* Result Action Area */}
          {rallyResult && (
            <div className="p-3 bg-emerald-50 border-t border-emerald-100 flex items-center justify-between gap-2">
              <span className="text-[11px] text-emerald-800 font-medium">Diagnosis generated & saved.</span>
              <button
                onClick={resetRally}
                className="bg-emerald-700 text-white rounded px-2.5 py-1 text-[10px] font-bold hover:bg-emerald-800 transition"
              >
                Start New Rally
              </button>
            </div>
          )}

          {/* Input Box */}
          <form onSubmit={handleSendRally} className="p-3 border-t border-slate-200 bg-white flex gap-2">
            <input
              type="text"
              className="flex-1 bg-slate-50 border border-slate-200 rounded px-3 py-2 text-xs outline-none focus:bg-white focus:border-slate-400 text-slate-900"
              placeholder={
                rallyCount >= 30
                  ? "Rally completed!"
                  : `Enter round #${rallyCount + 1} reply...`
              }
              value={rallyInput}
              onChange={(e) => setRallyInput(e.target.value)}
              disabled={rallyCount >= 30 || isRallySubmitting}
            />
            <button
              type="submit"
              disabled={!rallyInput.trim() || rallyCount >= 30 || isRallySubmitting}
              className="bg-slate-900 text-white p-2 rounded hover:bg-slate-800 disabled:bg-slate-100 disabled:text-slate-300 transition"
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        </div>
      )}

    </div>
  );
}
