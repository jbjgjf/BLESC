"use client";

import { useState, useEffect } from "react";
import { ApiClient } from "@/api/client";
import { Entry } from "@/api/models";
import { Send, History, Loader2, AlertCircle } from "lucide-react";

export default function Home() {
  const [text, setText] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const USER_ID = "research_user_01";

  useEffect(() => {
    loadEntries();
  }, []);

  const loadEntries = async () => {
    try {
      const data = await ApiClient.getEntries(USER_ID);
      setEntries(data);
    } catch (err) {
      setError("Failed to load entries.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;

    setIsSubmitting(true);
    setError(null);
    try {
      await ApiClient.createEntry(USER_ID, text);
      setText("");
      loadEntries();
    } catch (err) {
      setError("Submission failed. Check backend connection.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-12">
      <section className="space-y-4">
        <h1 className="text-3xl font-bold">New Journal Entry</h1>
        <p className="text-slate-500">Log your thoughts and activities to track structural patterns.</p>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="relative group">
            <textarea
              className="w-full h-40 p-6 rounded-2xl border-2 border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none transition-all resize-none shadow-sm"
              placeholder="How are you feeling today? What happened?"
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={isSubmitting}
            />
            <div className="absolute bottom-4 right-4 text-xs font-mono text-slate-400">
              {text.length} chars
            </div>
          </div>
          
          {error && (
            <div className="flex items-center gap-2 p-4 text-sm bg-red-50 text-red-600 rounded-xl border border-red-100 italic font-medium">
              <AlertCircle className="w-4 h-4" />
              <span>{error}</span>
            </div>
          )}
          
          <button
            type="submit"
            disabled={isSubmitting || !text.trim()}
            className="flex items-center justify-center gap-2 w-full sm:w-auto px-8 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white font-semibold rounded-xl transition-all shadow-lg active:scale-95"
          >
            {isSubmitting ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Send className="w-5 h-5" />
            )}
            <span>Submit Entry</span>
          </button>
        </form>
      </section>

      <section className="space-y-6 pt-12 border-t border-slate-200/60">
        <div className="flex items-center gap-2 text-xl font-bold">
          <History className="w-6 h-6 text-slate-400" />
          <h2>Recent History</h2>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-slate-300" />
          </div>
        ) : entries.length === 0 ? (
          <div className="p-8 text-center text-slate-400 bg-white rounded-2xl border border-dashed italic">
            No entries found yet.
          </div>
        ) : (
          <div className="space-y-4">
            {entries.map((entry) => (
              <div key={entry.id} className="p-6 bg-white rounded-2xl border border-slate-200 hover:border-indigo-200 transition-all shadow-sm">
                <div className="text-xs font-mono text-slate-400 mb-2">
                  {new Date(entry.created_at).toLocaleString()}
                </div>
                <p className="text-slate-700 leading-relaxed whitespace-pre-wrap">
                  {entry.raw_text}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
