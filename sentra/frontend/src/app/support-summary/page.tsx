"use client";

import { useState } from "react";
import { CheckCircle2, Copy, Download, Loader2, ShieldAlert } from "lucide-react";

import { ApiClient } from "@/api/client";
import type { CounselorSupportSummary } from "@/api/models";
import { useAuth } from "@/lib/auth";
import { counselorSummaryToText } from "@/lib/counselor-summary";

const panel: React.CSSProperties = {
  backgroundColor: "var(--ivory)",
  border: "1px solid var(--limestone)",
  boxShadow: "0 1px 3px rgba(42,32,24,0.09), 0 6px 24px rgba(42,32,24,0.05)",
};

export default function SupportSummaryPage() {
  const { userId } = useAuth();
  const [summary, setSummary] = useState<CounselorSupportSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const generate = async () => {
    setIsLoading(true);
    setError(null);
    setCopied(false);
    try {
      setSummary(await ApiClient.generateCounselorSummary(userId, 10));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Summary generation failed.");
    } finally {
      setIsLoading(false);
    }
  };

  const copy = async () => {
    if (!summary) return;
    await navigator.clipboard.writeText(counselorSummaryToText(summary));
    setCopied(true);
  };

  const download = () => {
    if (!summary) return;
    const url = URL.createObjectURL(new Blob([counselorSummaryToText(summary)], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `blesc-support-summary-${summary.date_range.to?.slice(0, 10) ?? "empty"}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const range = summary?.date_range.from && summary.date_range.to
    ? `${new Date(summary.date_range.from).toLocaleDateString()} – ${new Date(summary.date_range.to).toLocaleDateString()}`
    : "No reflection dates available";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <section className="px-8 py-7" style={{ ...panel, backgroundColor: "var(--ivory-warm)" }}>
        <div className="inscription mb-3">Student-controlled sharing</div>
        <h1 className="text-3xl font-bold" style={{ color: "var(--ink)" }}>Supportive reflection summary</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed" style={{ color: "var(--ink-mid)" }}>
          Create a concise preview from recent structured reflections. Raw journal text is excluded, and nothing is shared automatically.
        </p>
        <button
          type="button"
          onClick={generate}
          disabled={isLoading}
          className="mt-5 inline-flex items-center gap-2 rounded-md px-5 py-2.5 font-semibold disabled:opacity-60"
          style={{ backgroundColor: "var(--gold)", color: "#000" }}
        >
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {summary ? "Regenerate preview" : "Generate preview"}
        </button>
        {error ? <p role="alert" className="mt-3 text-sm" style={{ color: "var(--sienna)" }}>{error}</p> : null}
      </section>

      {summary ? (
        <section style={panel}>
          <header className="flex flex-wrap items-start justify-between gap-4 px-7 py-5" style={{ borderBottom: "1px solid var(--limestone)" }}>
            <div>
              <div className="inscription mb-2">Preview before sharing</div>
              <div className="font-semibold" style={{ color: "var(--ink)" }}>{range}</div>
              <div className="mt-1 text-xs" style={{ color: "var(--ink-faint)" }}>{summary.reflection_count} structured reflection{summary.reflection_count === 1 ? "" : "s"}</div>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={copy} className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm" style={{ border: "1px solid var(--limestone)" }}>
                {copied ? <CheckCircle2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{copied ? "Copied" : "Copy"}
              </button>
              <button type="button" onClick={download} className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm" style={{ border: "1px solid var(--limestone)" }}>
                <Download className="h-4 w-4" />Download text
              </button>
            </div>
          </header>

          {summary.safety_flags.length ? (
            <div role="alert" className="px-7 py-5" style={{ borderBottom: "1px solid var(--terracotta)", backgroundColor: "rgba(244,63,94,0.08)" }}>
              <div className="mb-2 flex items-center gap-2 font-semibold" style={{ color: "var(--sienna)" }}><ShieldAlert className="h-5 w-5" />Safety flags in this period</div>
              {summary.safety_flags.map((flag) => <p key={`${flag.event_id}-${flag.timestamp}`} className="text-sm" style={{ color: "var(--ink-mid)" }}>{new Date(flag.timestamp).toLocaleDateString()} · {flag.level} · {flag.reasons.join(", ") || "flag recorded"}</p>)}
            </div>
          ) : null}

          <div className="grid gap-0 md:grid-cols-2">
            {summary.sections.map((section) => (
              <article key={section.key} className="px-7 py-5" style={{ borderBottom: "1px solid var(--limestone)" }}>
                <h2 className="mb-2 font-semibold" style={{ color: "var(--ink)" }}>{section.title}</h2>
                {section.items.length ? <ul className="list-disc space-y-1 pl-5 text-sm" style={{ color: "var(--ink-mid)" }}>{section.items.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="text-sm italic" style={{ color: "var(--ink-faint)" }}>No structured data available.</p>}
              </article>
            ))}
          </div>
          <p className="px-7 py-5 text-xs leading-relaxed" style={{ color: "var(--ink-faint)" }}>{summary.limitations}</p>
        </section>
      ) : null}
    </div>
  );
}
