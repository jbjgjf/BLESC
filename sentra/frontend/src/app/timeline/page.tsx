"use client";

import { useCallback, useState, useEffect } from "react";
import { ApiClient } from "@/api/client";
import { AnomalyResult } from "@/api/models";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { Loader2, Calendar, AlertCircle } from "lucide-react";
import Link from 'next/link';
import { useStoredUserId } from "@/lib/user";

export default function Timeline() {
  const { userId } = useStoredUserId();
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

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-96">
        <Loader2 className="w-12 h-12 animate-spin text-indigo-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-96 gap-4">
        <AlertCircle className="w-12 h-12 text-red-400" />
        <p className="text-red-600 font-medium">{error}</p>
        <button onClick={loadTimeline} className="text-indigo-600 font-bold hover:underline">Retry</button>
      </div>
    );
  }

  return (
    <div className="space-y-12">
      <header className="space-y-4">
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Calendar className="w-8 h-8 text-indigo-600" />
          <span>Anomaly Timeline</span>
        </h1>
        <p className="text-slate-500">Visualization of hybrid structural deviations measured against the rolling baseline.</p>
      </header>

      {data.length === 0 ? (
        <div className="p-12 text-center bg-white border border-dashed rounded-3xl text-slate-400 font-medium">
          Insufficient data to generate timeline. Keep logging!
        </div>
      ) : (
        <section className="bg-white p-8 rounded-3xl shadow-xl border border-slate-100">
          <div className="h-80 w-full font-mono text-xs">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="day" stroke="#94a3b8" />
                <YAxis stroke="#94a3b8" />
                <Tooltip 
                  contentStyle={{ border: 'none', borderRadius: '1rem', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                  labelStyle={{ fontWeight: 'bold' }}
                />
                <ReferenceLine y={2.0} label="Threshold" stroke="red" strokeDasharray="3 3" />
                <Line 
                  type="monotone" 
                  dataKey="anomaly_score" 
                  stroke="#4f46e5" 
                  strokeWidth={3} 
                  dot={{ r: 4, fill: '#4f46e5', strokeWidth: 2, stroke: '#fff' }}
                  activeDot={{ r: 8, strokeWidth: 0 }}
                  name="Anomaly Score"
                  animationDuration={1500}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="p-6 bg-slate-50 rounded-2xl border border-slate-100">
              <div className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">Status</div>
              <div className="text-2xl font-bold text-indigo-600">Stable</div>
              <div className="text-sm text-slate-500 mt-2">Current score is within the usual structural range.</div>
            </div>
            <div className="p-6 bg-slate-50 rounded-2xl border border-slate-100">
              <div className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">Baseline</div>
              <div className="text-2xl font-bold text-slate-700">7 Days</div>
              <div className="text-sm text-slate-500 mt-2">Computed from stable historical structure.</div>
            </div>
            <div className="p-6 bg-slate-50 rounded-2xl border border-slate-100 shadow-sm border-indigo-100">
              <div className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">Next Step</div>
               <Link href="/insights" className="text-lg font-bold text-indigo-600 block hover:underline">
                 View Insight Details →
               </Link>
              <div className="text-sm text-slate-500 mt-2">Deep-dive into graph evidence.</div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
