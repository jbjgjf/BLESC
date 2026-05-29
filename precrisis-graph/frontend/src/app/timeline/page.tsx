"use client";

import { useCallback, useState, useEffect } from "react";
import { ApiClient } from "@/api/client";
import { AnomalyResult } from "@/api/models";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { Loader2, Calendar, AlertCircle } from "lucide-react";
import Link from 'next/link';
import { useStoredUserId } from "@/lib/user";
import { useTheme } from "@/app/context/ThemeContext";

export default function Timeline() {
  const { userId } = useStoredUserId();
  const { theme } = useTheme();
  const [data, setData] = useState<AnomalyResult[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const loadTimeline = useCallback(async () => {
    try {
      const timeline = await ApiClient.getTimeline(userId);
      setData(timeline);
    } catch {
      setError("Failed to load timeline data.");
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    loadTimeline();
  }, [loadTimeline]);

  // Theme-specific colors for Recharts
  const isDark = theme === "dark";
  const axisColor = isDark ? "#9b9b9b" : "#787774";
  const gridColor = isDark ? "#2c2c2c" : "#ededeb";
  const lineColor = isDark ? "#34ebd6" : "#238387";
  const tooltipBg = isDark ? "#202020" : "#ffffff";
  const tooltipBorder = isDark ? "#2c2c2c" : "#ededeb";
  const tooltipTextColor = isDark ? "#e3e3e3" : "#37352f";

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-notion-accent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-96 gap-4">
        <AlertCircle className="w-10 h-10 text-red-500" />
        <p className="text-red-500 font-medium text-sm">{error}</p>
        <button onClick={loadTimeline} className="text-notion-accent font-semibold text-xs hover:underline">Retry</button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Breadcrumb & Header */}
      <div className="space-y-4">
        <div className="flex items-center gap-1.5 text-xs text-notion-muted">
          <span>Sentra Workspace</span>
          <span>/</span>
          <span className="text-notion-text font-medium">Timeline</span>
        </div>
        <div className="text-5xl select-none pt-2">📅</div>
        <h1 className="text-4xl font-bold tracking-tight text-notion-text">
          Anomaly Timeline
        </h1>
        <p className="max-w-3xl text-sm leading-relaxed text-notion-muted">
          Visualization of hybrid structural deviations measured against the rolling baseline. Anomalies indicate a divergence from established stable behavior patterns.
        </p>
      </div>

      {data.length === 0 ? (
        <div className="p-12 text-center border border-dashed border-notion-border rounded-lg text-notion-muted text-sm bg-notion-sidebar-bg/30">
          Insufficient data to generate timeline. Keep logging!
        </div>
      ) : (
        <section className="bg-notion-card-bg p-6 rounded-lg border border-notion-border space-y-6">
          <div className="h-80 w-full text-xs font-mono">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridColor} />
                <XAxis dataKey="day" stroke={axisColor} />
                <YAxis stroke={axisColor} />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: tooltipBg, 
                    border: `1px solid ${tooltipBorder}`,
                    borderRadius: '6px',
                    color: tooltipTextColor
                  }}
                  labelStyle={{ fontWeight: 'bold' }}
                />
                <ReferenceLine y={2.0} label={{ value: "Threshold", fill: "#ef4444", fontSize: 10, position: "top" }} stroke="#ef4444" strokeDasharray="4 4" />
                <Line 
                  type="monotone" 
                  dataKey="anomaly_score" 
                  stroke={lineColor} 
                  strokeWidth={2} 
                  dot={{ r: 4, fill: lineColor, strokeWidth: 1, stroke: isDark ? "#191919" : "#fff" }}
                  activeDot={{ r: 6, strokeWidth: 0 }}
                  name="Anomaly Score"
                  animationDuration={1000}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Properties Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 border-t border-notion-border pt-6">
            <div className="p-4 bg-notion-sidebar-bg rounded border border-notion-sidebar-border">
              <div className="text-[10px] font-bold text-notion-muted uppercase tracking-wider mb-1">Status</div>
              <div className="text-xl font-bold text-notion-accent">Stable</div>
              <div className="text-xs text-notion-muted mt-1.5 leading-relaxed">Current score is within the normal structural range.</div>
            </div>
            <div className="p-4 bg-notion-sidebar-bg rounded border border-notion-sidebar-border">
              <div className="text-[10px] font-bold text-notion-muted uppercase tracking-wider mb-1">Baseline</div>
              <div className="text-xl font-bold text-notion-text">7 Days</div>
              <div className="text-xs text-notion-muted mt-1.5 leading-relaxed">Computed from stable historical structure.</div>
            </div>
            <div className="p-4 bg-notion-sidebar-bg rounded border border-notion-sidebar-border">
              <div className="text-[10px] font-bold text-notion-muted uppercase tracking-wider mb-1">Next Step</div>
               <Link href="/insights" className="text-sm font-bold text-notion-accent block hover:underline">
                 View Insight Details →
               </Link>
              <div className="text-xs text-notion-muted mt-1.5 leading-relaxed">Deep-dive into graph evidence.</div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
