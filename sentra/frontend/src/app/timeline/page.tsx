"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ApiClient } from "@/api/client";
import { AnomalyResult } from "@/api/models";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { AlertCircle, ArrowRight, Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth";

const S = {
  panel: {
    backgroundColor: "var(--ivory)",
    border: "1px solid var(--limestone)",
    boxShadow: "0 1px 3px rgba(42,32,24,0.09), 0 6px 24px rgba(42,32,24,0.05), inset 0 1px 0 rgba(252,244,228,0.85)",
  } as React.CSSProperties,
  displayFont: { fontFamily: "var(--font-sans), sans-serif" } as React.CSSProperties,
  bodyFont:    { fontFamily: "var(--font-sans), sans-serif" } as React.CSSProperties,
};

export default function Timeline() {
  const { userId } = useAuth();
  const [data, setData] = useState<AnomalyResult[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTimeline = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const timeline = await ApiClient.getTimeline(userId);
      setData(timeline);
    } catch (err) {
      setData([]);
      setError(err instanceof Error ? err.message : "Live timeline unavailable.");
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => { loadTimeline(); }, [loadTimeline]);

  const latest = data.at(-1);
  const highSignalDays = useMemo(() => data.filter((d) => d.anomaly_score >= 2).length, [data]);
  const status = latest && latest.anomaly_score >= 2 ? "Review Needed" : "Within Baseline";

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
          backgroundColor: "var(--ivory-warm)",
        }}
      >
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div
              className="mb-3"
              style={{
                fontFamily: "var(--font-sans), sans-serif",
                fontSize: "0.6rem",
                fontWeight: 600,
                letterSpacing: "0.28em",
                textTransform: "uppercase",
                color: "var(--ink-faint)",
              }}
            >
              Temporal Drift
            </div>
            <h1
              className="text-3xl"
              style={{ ...S.displayFont, fontWeight: 700, letterSpacing: "0.04em", color: "var(--ink)" }}
            >
              Baseline Deviation Trajectory
            </h1>
            <p
              className="mt-2 max-w-xl text-base leading-relaxed"
              style={{ ...S.bodyFont, color: "var(--ink-mid)", fontStyle: "italic" }}
            >
              Entity-level deviations over time, measured against the participant&apos;s rolling baseline manifold.
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

      {data.length === 0 ? (
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
          Insufficient data to generate a trajectory.
        </div>
      ) : (
        <section style={S.panel}>
          {error && (
            <div
              className="flex items-center gap-2 px-5 py-3 text-sm"
              style={{
                borderBottom: "1px solid var(--sandstone)",
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

          {/* Stat row */}
          <div
            className="grid md:grid-cols-3"
            style={{ borderBottom: "1px solid var(--limestone)" }}
          >
            {/* Inference state */}
            <div
              className="p-5"
              style={{ borderRight: "1px solid var(--limestone)" }}
            >
              <div
                className="mb-2"
                style={{
                  fontFamily: "var(--font-sans), sans-serif",
                  fontSize: "0.55rem",
                  fontWeight: 600,
                  letterSpacing: "0.22em",
                  textTransform: "uppercase",
                  color: "var(--ink-faint)",
                }}
              >
                Inference State
              </div>
              <div
                className="text-xl"
                style={{ ...S.displayFont, fontWeight: 700, color: "var(--ink)" }}
              >
                {status}
              </div>
              <div className="mt-1 text-sm" style={{ ...S.bodyFont, color: "var(--ink-mid)", fontStyle: "italic" }}>
                Latest reflection signal {Number.isFinite(latest?.anomaly_score) ? latest!.anomaly_score.toFixed(2) : "—"}
              </div>
            </div>

            {/* Excursion days */}
            <div
              className="p-5"
              style={{ borderRight: "1px solid var(--limestone)" }}
            >
              <div
                className="mb-2"
                style={{
                  fontFamily: "var(--font-sans), sans-serif",
                  fontSize: "0.55rem",
                  fontWeight: 600,
                  letterSpacing: "0.22em",
                  textTransform: "uppercase",
                  color: "var(--ink-faint)",
                }}
              >
                Excursion Days
              </div>
              <div
                className="text-xl"
                style={{ ...S.displayFont, fontWeight: 700, color: "var(--ink)" }}
              >
                {highSignalDays}
              </div>
              <div className="mt-1 text-sm" style={{ ...S.bodyFont, color: "var(--ink-mid)", fontStyle: "italic" }}>
                Review threshold 2.0
              </div>
            </div>

            {/* Next pass link */}
            <div className="p-5">
              <div
                className="mb-2"
                style={{
                  fontFamily: "var(--font-sans), sans-serif",
                  fontSize: "0.55rem",
                  fontWeight: 600,
                  letterSpacing: "0.22em",
                  textTransform: "uppercase",
                  color: "var(--ink-faint)",
                }}
              >
                Next Inference Pass
              </div>
              <Link
                href="/insights"
                className="inline-flex items-center gap-2 text-sm"
                style={{ ...S.bodyFont, color: "var(--aegean)" }}
              >
                Review Inference Ledger
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>

          {/* Chart */}
          <div className="h-96 w-full p-6 text-xs" style={{ backgroundColor: "var(--ivory)" }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 8, right: 20, left: -20, bottom: 0 }}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="var(--limestone)"
                  opacity={0.8}
                />
                <XAxis
                  dataKey="day"
                  stroke="var(--ink-faint)"
                  tickLine={false}
                  tick={{ fontFamily: "var(--font-sans), sans-serif", fontSize: 10, letterSpacing: 1 }}
                />
                <YAxis
                  stroke="var(--ink-faint)"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontFamily: "var(--font-sans), sans-serif", fontSize: 10 }}
                />
                <Tooltip
                  contentStyle={{
                    border: "1px solid var(--limestone)",
                    backgroundColor: "var(--ivory)",
                    boxShadow: "0 4px 12px rgba(0,0,0,0.05)",
                    fontFamily: "var(--font-sans), sans-serif",
                    fontSize: "13px",
                    color: "var(--ink)",
                    borderRadius: 0,
                  }}
                  labelStyle={{
                    fontFamily: "var(--font-sans), sans-serif",
                    fontSize: "11px",
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    color: "var(--ink-soft)",
                    fontWeight: 700,
                  }}
                />
                <ReferenceLine
                  y={2.0}
                  label={{
                    value: "Review Threshold",
                    fill: "var(--terracotta)",
                    fontSize: 10,
                    fontFamily: "var(--font-sans), sans-serif",
                    letterSpacing: 1,
                  }}
                  stroke="var(--terracotta)"
                  strokeDasharray="5 5"
                  opacity={0.6}
                />
                <Line
                  type="monotone"
                  dataKey="anomaly_score"
                  stroke="var(--aegean)"
                  strokeWidth={2}
                  dot={{ r: 3.5, fill: "var(--aegean)", strokeWidth: 2, stroke: "var(--ivory)" }}
                  activeDot={{ r: 6, strokeWidth: 0, fill: "var(--gold)" }}
                  name="Hybrid reflection signal"
                  animationDuration={900}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}
    </div>
  );
}
