import type { EducatorStudentStatus } from "@/api/models";

export const panel: React.CSSProperties = {
  backgroundColor: "var(--ivory)",
  border: "1px solid var(--limestone)",
  boxShadow: "0 1px 3px rgba(42,32,24,0.09), 0 6px 24px rgba(42,32,24,0.05)",
};

const BAND_STYLES: Record<EducatorStudentStatus["state_band"], { label: string; color: string }> = {
  settled: { label: "Settled", color: "var(--aegean)" },
  watch: { label: "Watch", color: "var(--ochre)" },
  review: { label: "Review", color: "var(--sienna)" },
  unknown: { label: "No data", color: "var(--ink-faint)" },
};

export function BandChip({ band }: { band: EducatorStudentStatus["state_band"] }) {
  const style = BAND_STYLES[band];
  return (
    <span className="rounded-full px-2.5 py-0.5 text-xs font-semibold" style={{ border: `1px solid ${style.color}`, color: style.color }}>
      {style.label}
    </span>
  );
}

export function SafetyChip({ level }: { level: string | null }) {
  if (!level || level === "none" || level === "low") return null;
  const color = level === "crisis" ? "var(--terracotta)" : "var(--sienna)";
  return (
    <span className="rounded-full px-2.5 py-0.5 text-xs font-semibold" style={{ border: `1px solid ${color}`, color }}>
      Safety · {level}
    </span>
  );
}
