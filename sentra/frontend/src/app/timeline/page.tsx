"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ApiClient } from "@/api/client";
import { AnomalyResult } from "@/api/models";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { AlertCircle, ArrowRight, BarChart3, Loader2 } from "lucide-react";
import { useStoredUserId } from "@/lib/user";
import { demoGraphSnapshots } from "@/lib/demoData";

const demoTimeline: AnomalyResult[] = demoGraphSnapshots.map((snapshot, index) => ({
  id: 7000 + index,
  user_id: snapshot.user_id,
  day: snapshot.day,
  anomaly_score: [0.82, 1.08, 1.42, 1.37][index] ?? 1,
  z_scores_json: {},
  explanation_id: index === demoGraphSnapshots.length - 1 ? 1204 : undefined,
  created_at: snapshot.created_at,
}));

export default function Timeline() {
  const { userId } = useStoredUserId();
  const [data, setData] = useState<AnomalyResult[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTimeline = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const timeline = await ApiClient.getTimeline(userId);
      setData(timeline.length > 0 ? timeline : demoTimeline);
    } catch {
      setData(demoTimeline);
      setError("Live timeline unavailable. Showing seeded monitoring data.");
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    loadTimeline();
  }, [loadTimeline]);

  const latest = data.at(-1);
  const highSignalDays = useMemo(() => data.filter((item) => item.anomaly_score >= 2).length, [data]);
  const status = latest && latest.anomaly_score >= 2 ? "Review needed" : "Within baseline";

  if (isLoading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <BarChart3 className="h-4 w-4 text-sky-700" />
              Risk trend
            </div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">Anomaly timeline</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Structural deviations over time, measured against the participant&apos;s rolling baseline.
            </p>
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            Participant <span className="font-semibold text-slate-950">{userId}</span>
          </div>
        </div>
      </section>

      {data.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500">
          Insufficient data to generate a timeline.
        </div>
      ) : (
        <section className="rounded-lg border border-slate-200 bg-white">
          {error && (
            <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-5 py-3 text-sm text-amber-800">
              <AlertCircle className="h-4 w-4" />
              <span>{error}</span>
            </div>
          )}
          <div className="grid gap-0 border-b border-slate-200 md:grid-cols-3">
            <div className="border-b border-slate-200 p-5 md:border-b-0 md:border-r">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Status</div>
              <div className="mt-2 text-xl font-semibold text-slate-950">{status}</div>
              <div className="mt-1 text-sm text-slate-600">Latest score {latest?.anomaly_score.toFixed(2) ?? "--"}</div>
            </div>
            <div className="border-b border-slate-200 p-5 md:border-b-0 md:border-r">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">High-signal days</div>
              <div className="mt-2 text-xl font-semibold text-slate-950">{highSignalDays}</div>
              <div className="mt-1 text-sm text-slate-600">Threshold is 2.0</div>
            </div>
            <div className="p-5">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Next action</div>
              <Link href="/insights" className="mt-2 inline-flex items-center gap-2 text-sm font-semibold text-sky-800 hover:underline">
                Review diagnostic evidence <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
          <div className="h-96 w-full p-5 text-xs">
            <ResponsiveContainer width="100%" height="100%" minWidth={300} minHeight={300}>
              <LineChart data={data} margin={{ top: 8, right: 18, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                <XAxis dataKey="day" stroke="#64748b" tickLine={false} />
                <YAxis stroke="#64748b" tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{ border: "1px solid #e2e8f0", borderRadius: "6px", boxShadow: "0 12px 30px rgba(15,23,42,0.08)" }}
                  labelStyle={{ fontWeight: 700 }}
                />
                <ReferenceLine y={2.0} label={{ value: "Review threshold", fill: "#b45309", fontSize: 11 }} stroke="#f59e0b" strokeDasharray="4 4" />
                <Line
                  type="monotone"
                  dataKey="anomaly_score"
                  stroke="#0369a1"
                  strokeWidth={2}
                  dot={{ r: 3, fill: "#0369a1", strokeWidth: 2, stroke: "#fff" }}
                  activeDot={{ r: 6, strokeWidth: 0 }}
                  name="Anomaly score"
                  animationDuration={800}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}
    </div>
  );
}
