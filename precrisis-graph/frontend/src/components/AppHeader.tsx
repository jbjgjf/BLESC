"use client";

import Link from "next/link";
import { Activity, Home, LineChart, PieChart } from "lucide-react";
import { useStoredUserId } from "@/lib/user";

export function AppHeader() {
  const { userId, setUserId } = useStoredUserId();

  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-slate-950/90 backdrop-blur">
      <div className="mx-auto flex min-h-16 max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 text-white">
        <Link href="/" className="flex items-center gap-2 text-xl font-bold text-cyan-100">
          <Activity className="h-6 w-6 text-cyan-300" />
          <span>precrisis-graph</span>
        </Link>

        <nav className="flex items-center gap-5 text-sm text-slate-300 sm:gap-8">
          <Link href="/" className="flex items-center gap-1 transition-colors hover:text-cyan-300">
            <Home className="h-4 w-4" />
            <span>Log</span>
          </Link>
          <Link href="/timeline" className="flex items-center gap-1 transition-colors hover:text-cyan-300">
            <LineChart className="h-4 w-4" />
            <span>Timeline</span>
          </Link>
          <Link href="/insights" className="flex items-center gap-1 transition-colors hover:text-cyan-300">
            <PieChart className="h-4 w-4" />
            <span>Insights</span>
          </Link>
        </nav>

        <label className="flex items-center gap-2 text-xs font-medium text-slate-400">
          <span>Participant</span>
          <input
            className="h-9 w-44 rounded-xl border border-white/10 bg-white/10 px-3 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-300"
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            aria-label="Participant ID"
          />
        </label>
      </div>
    </header>
  );
}
