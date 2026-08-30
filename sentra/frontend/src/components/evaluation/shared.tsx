import { t } from "@/lib/i18n";

export const evalPanel: React.CSSProperties = {
  backgroundColor: "var(--ivory)",
  border: "1px solid var(--limestone)",
  boxShadow: "0 1px 3px rgba(42,32,24,0.09), 0 6px 24px rgba(42,32,24,0.05)",
};

export type EvaluationRunRow = {
  id: string;
  label: string;
  mode: string;
  status: string;
  verdict: "ready" | "needs_attention" | "incomplete" | null;
  totals_json: Record<string, number>;
  gates_json: Record<string, number>;
  findings_json: string[];
  recommended_actions_json: string[];
  limitations: string | null;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  openai_eval_refs: string[];
  started_at: string;
  finished_at: string | null;
};

const VERDICT_COLORS: Record<string, string> = {
  ready: "var(--aegean)",
  needs_attention: "var(--terracotta)",
  incomplete: "var(--ochre)",
};

export function VerdictBadge({ verdict, large }: { verdict: string | null; large?: boolean }) {
  const key = verdict ?? "running";
  const meta = {
    label: t.evaluation.verdict[key] ?? key,
    color: VERDICT_COLORS[key] ?? "var(--ink-faint)",
  };
  return (
    <span
      data-testid="run-verdict"
      className={`inline-flex items-center rounded-full font-bold ${large ? "px-5 py-1.5 text-lg" : "px-3 py-0.5 text-xs"}`}
      style={{ border: `2px solid ${meta.color}`, color: meta.color }}
    >
      {meta.label}
    </span>
  );
}
