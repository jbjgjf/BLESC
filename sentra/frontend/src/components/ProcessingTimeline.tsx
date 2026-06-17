"use client";

import { CheckCircle2, Circle, Loader2 } from "lucide-react";

type ProcessingTimelineProps = {
  steps: string[];
  active: boolean;
  currentStep: number;
  complete?: boolean;
};

export function ProcessingTimeline({ steps, active, currentStep, complete = false }: ProcessingTimelineProps) {
  if (!active && !complete) return null;

  return (
    <div
      className="space-y-2 rounded-md px-4 py-3 text-xs"
      style={{
        border: "1px solid var(--limestone)",
        backgroundColor: "rgba(255,255,255,0.04)",
        color: "var(--ink-mid)",
      }}
    >
      {steps.map((step, index) => {
        const done = complete || index < currentStep;
        const current = active && index === currentStep;
        return (
          <div key={step} className="flex items-center gap-2">
            {done ? (
              <CheckCircle2 className="h-3.5 w-3.5" style={{ color: "var(--aegean)" }} />
            ) : current ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: "var(--gold)" }} />
            ) : (
              <Circle className="h-3.5 w-3.5" style={{ color: "var(--ink-faint)" }} />
            )}
            <span style={{ opacity: done || current ? 1 : 0.55 }}>{step}</span>
          </div>
        );
      })}
    </div>
  );
}
