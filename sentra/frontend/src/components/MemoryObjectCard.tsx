import { AlertTriangle, Repeat } from "lucide-react";
import { ConversationMemoryObject } from "@/api/models";

const displayFont: React.CSSProperties = { fontFamily: "var(--font-sans), sans-serif" };

function toneColor(dominant: string): string {
  if (dominant === "negative") return "var(--terracotta)";
  if (dominant === "protective") return "var(--gold)";
  return "var(--ink-faint)";
}

function confidenceLabel(score: number): string {
  if (score >= 0.8) return "High confidence";
  if (score >= 0.45) return "Moderate confidence";
  return "Low confidence (no embedding)";
}

export function MemoryObjectCard({ memoryObject }: { memoryObject: ConversationMemoryObject }) {
  const importancePercent = Math.round(Math.max(0, Math.min(1, memoryObject.effective_importance)) * 100);
  const isSuperseded = memoryObject.contradiction_status === "superseded";
  const isFlagged = memoryObject.contradiction_status === "flagged";

  return (
    <div
      className="space-y-2 rounded-md p-4"
      style={{
        border: "1px solid var(--limestone)",
        backgroundColor: "var(--ivory-warm)",
        opacity: isSuperseded ? 0.6 : 1,
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
          style={{ ...displayFont, border: `1px solid ${toneColor(memoryObject.emotional_tone.dominant)}`, color: toneColor(memoryObject.emotional_tone.dominant) }}
        >
          {memoryObject.topic}
        </span>
        {memoryObject.recurrence_count > 0 && (
          <span className="inline-flex items-center gap-1 text-[11px]" style={{ color: "var(--ink-faint)" }}>
            <Repeat className="h-3 w-3" />
            seen {memoryObject.recurrence_count + 1}x
          </span>
        )}
      </div>

      <p className="text-sm leading-relaxed" style={{ color: "var(--ink-mid)" }}>
        {memoryObject.summary}
      </p>

      <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ backgroundColor: "var(--limestone)" }}>
        <div
          className="h-full rounded-full"
          style={{ width: `${importancePercent}%`, backgroundColor: "var(--gold)" }}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]" style={{ color: "var(--ink-faint)" }}>
        <span>Importance {importancePercent}%</span>
        <span>{confidenceLabel(memoryObject.confidence_score)}</span>
      </div>

      {(isSuperseded || isFlagged) && (
        <div
          className="flex items-center gap-2 rounded-md px-3 py-2 text-[11px]"
          style={{ border: "1px solid var(--terracotta)", color: "var(--sienna)" }}
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {isSuperseded ? "Superseded by a more recent, related memory." : "Tension with an earlier related memory on this topic."}
        </div>
      )}
    </div>
  );
}
