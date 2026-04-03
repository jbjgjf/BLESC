"use client";

import { useState, useEffect } from "react";
import { ApiClient } from "@/api/client";
import { AnomalyResult, ExplanationPayload } from "@/api/models";
import { Loader2, PieChart, Activity, Info, AlertCircle, TrendingDown, Target, HelpCircle } from "lucide-react";

export default function Insights() {
  const [anomaly, setAnomaly] = useState<AnomalyResult | null>(null);
  const [explanation, setExplanation] = useState<ExplanationPayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const USER_ID = "research_user_01";

  useEffect(() => {
    loadInsights();
  }, []);

  const loadInsights = async () => {
    try {
      const currentAnomaly = await ApiClient.getAnomaly(USER_ID);
      setAnomaly(currentAnomaly);
      if (currentAnomaly.explanation_id) {
          const detail = await ApiClient.getExplanation(currentAnomaly.explanation_id);
          setExplanation(detail);
      }
    } catch (err) {
      setError("Failed to load insights. Make sure you have enough data.");
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
        <div className="flex justify-center items-center h-96">
            <Loader2 className="w-12 h-12 animate-spin text-indigo-500" />
        </div>
    );
  }

  return (
    <div className="space-y-12">
      <header className="space-y-4">
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <PieChart className="w-8 h-8 text-indigo-600" />
          <span>Diagnostic Insights</span>
        </h1>
        <p className="text-slate-500">Decomposition of structural change signals into rule-based evidence and z-score deviations.</p>
      </header>

      {!anomaly ? (
        <div className="p-12 text-center bg-white border border-dashed rounded-3xl text-slate-400 font-medium">
          No anomaly diagnostic available yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left Column: Summary */}
          <div className="lg:col-span-1 space-y-8">
            <section className="bg-indigo-600 p-8 rounded-3xl text-white shadow-xl shadow-indigo-600/20">
              <h2 className="text-xs font-bold uppercase tracking-wider opacity-70 mb-1">Anomaly Score</h2>
              <div className="text-6xl font-black mb-4">{anomaly.anomaly_score.toFixed(1)}</div>
              <p className="text-indigo-100 text-sm leading-relaxed">
                Aggregate divergence from historical baseline. Values above 2.0 indicate significant structural shift.
              </p>
            </section>
            
            <section className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm">
                <h3 className="font-bold mb-4 flex items-center gap-2">
                    <Target className="w-5 h-5 text-indigo-500" />
                    <span>Top Deviations</span>
                </h3>
                <div className="space-y-4">
                    {explanation?.top_features.map((feat) => (
                        <div key={feat} className="space-y-1">
                            <div className="flex justify-between text-xs font-bold text-slate-400 uppercase">
                                <span>{feat}</span>
                                <span>z = {explanation.feature_zscores[feat]?.toFixed(1)}</span>
                            </div>
                            <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                                <div 
                                    className="bg-indigo-500 h-full transition-all duration-1000" 
                                    style={{ width: `${Math.min(100, Math.abs(explanation.feature_zscores[feat] || 0) * 20)}%` }}
                                />
                            </div>
                        </div>
                    ))}
                </div>
            </section>
          </div>

          {/* Right Column: Evidence */}
          <div className="lg:col-span-2 space-y-8">
            <section className="bg-white p-8 rounded-3xl border border-slate-100 shadow-sm">
                <h3 className="text-xl font-bold mb-8 flex items-center gap-2">
                    <Activity className="w-6 h-6 text-indigo-500" />
                    <span>Evidence Summary</span>
                </h3>
                
                <div className="space-y-6">
                    {explanation?.rule_contributions.map((rule, idx) => (
                        <div key={idx} className="flex gap-4 p-6 bg-slate-50 rounded-2xl border-l-4 border-indigo-500">
                             <TrendingDown className="w-6 h-6 text-indigo-400 shrink-0" />
                             <div className="space-y-2">
                                <div className="font-bold text-slate-900 capitalize">{rule.rule.replace('_', ' ')}</div>
                                <div className="text-slate-600 leading-relaxed text-sm">
                                    {rule.evidence}
                                </div>
                             </div>
                        </div>
                    ))}
                    
                    {(!explanation || explanation.rule_contributions.length === 0) && (
                        <div className="p-8 text-center text-slate-400 border border-dashed rounded-2xl italic">
                            No significant rule violations detected for this period.
                        </div>
                    )}
                </div>
                
                <div className="mt-12 flex items-start gap-4 p-4 bg-indigo-50 rounded-2xl text-indigo-700 text-sm">
                    <HelpCircle className="w-5 h-5 shrink-0" />
                    <p>
                        This diagnostic is computed deterministically. High z-scores indicate that your current behavior patterns differ statistically from your "stable" baseline periods.
                    </p>
                </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

