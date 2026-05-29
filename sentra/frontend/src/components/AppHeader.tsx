"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, BarChart3, Database, FileText, GitBranch, Search, Settings2 } from "lucide-react";
import { useStoredUserId } from "@/lib/user";

const primaryNav = [
  { href: "/", label: "Today", icon: FileText },
  { href: "/timeline", label: "Timeline", icon: BarChart3 },
  { href: "/graph", label: "Graph", icon: GitBranch },
  { href: "/insights", label: "Insights", icon: Activity },
];

export function AppHeader() {
  const pathname = usePathname();
  const { userId, setUserId } = useStoredUserId();

  return (
    <header className="sticky top-0 z-50 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex min-h-16 max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
        <Link href="/" className="flex items-center gap-3 text-slate-950">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-slate-950 text-white">
            <Activity className="h-5 w-5" />
          </span>
          <span>
            <span className="block text-sm font-semibold leading-4">Sentra</span>
            <span className="block text-xs text-slate-500">Education risk monitoring</span>
          </span>
        </Link>

        <nav className="flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 p-1 text-sm">
          {primaryNav.map((item) => {
            const Icon = item.icon;
            const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2 rounded px-3 py-2 font-medium transition ${
                  isActive ? "bg-white text-slate-950 shadow-sm" : "text-slate-600 hover:bg-white/70 hover:text-slate-950"
                }`}
              >
                <Icon className="h-4 w-4" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-2">
          <button
            type="button"
            className="hidden items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-950 md:flex"
          >
            <Search className="h-4 w-4" />
            Command
          </button>
          <details className="relative">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-950">
              <Settings2 className="h-4 w-4" />
              Context
            </summary>
            <div className="absolute right-0 mt-2 w-72 rounded-lg border border-slate-200 bg-white p-4 shadow-xl">
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                Participant ID
              </label>
              <input
                className="mt-2 h-10 w-full rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:bg-white"
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
                aria-label="Participant ID"
              />
              <Link
                href="/"
                className="mt-3 flex items-center gap-2 rounded-md px-2 py-2 text-sm text-slate-600 transition hover:bg-slate-50 hover:text-slate-950"
              >
                <Database className="h-4 w-4" />
                Advanced records stay contextual
              </Link>
            </div>
          </details>
        </div>
      </div>
    </header>
  );
}
