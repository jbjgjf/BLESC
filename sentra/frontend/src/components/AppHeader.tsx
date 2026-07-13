"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth";

const primaryNav = [
  { href: "/",      label: "Record" },
  { href: "/voice", label: "Voice" },
  { href: "/graph", label: "Graph" },
  { href: "/support-summary", label: "Summary" },
  { href: "/audit", label: "Audit" },
];

export function AppHeader() {
  const pathname = usePathname();
  const { userId, setUserId, signOut, user } = useAuth();
  const [draftUserId, setDraftUserId] = useState(userId);
  const [cohortOpen, setCohortOpen] = useState(false);

  useEffect(() => { setDraftUserId(userId); }, [userId]);

  const saveParticipantCode = () => {
    if (draftUserId.trim() !== userId) {
      setUserId(draftUserId).catch(() => setDraftUserId(userId));
    }
  };

  return (
    <header
      className="sticky top-0 z-50 backdrop-blur-md"
      style={{
        backgroundColor: "rgba(16, 10, 28, 0.86)",
        borderBottom: "1px solid var(--limestone)",
        boxShadow: "0 6px 28px rgba(76, 29, 149, 0.24)",
      }}
    >
      <div className="meander w-full" aria-hidden="true" />

      <div className="mx-auto flex min-h-[56px] max-w-4xl flex-wrap items-stretch justify-between gap-0 px-0">

        {/* Brand */}
        <Link
          href="/"
          className="flex items-center gap-3 px-6 py-3"
          style={{ borderRight: "1px solid var(--limestone)", color: "var(--ink)", textDecoration: "none" }}
        >
          <span
            className="relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full"
            aria-hidden="true"
            style={{
              background: "radial-gradient(circle at 38% 28%, #31205a 0%, #181027 58%, #0b0713 100%)",
              border: "1px solid rgba(196, 181, 253, 0.42)",
              boxShadow: "0 0 18px rgba(139, 92, 246, 0.45), inset 0 0 10px rgba(255,255,255,0.12)",
            }}
          >
            <Image
              src="/logo-cutout.png"
              className="h-[30px] w-[30px] object-contain"
              alt=""
              width={30}
              height={30}
              priority
            />
          </span>
          <span
            style={{
              fontFamily: "var(--font-sans), sans-serif",
              fontSize: "0.8rem",
              fontWeight: "700",
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: "var(--ink)",
            }}
          >
            BLESC
          </span>
        </Link>

        {/* Nav — 2 items */}
        <nav className="flex items-stretch flex-1">
          {primaryNav.map((item) => {
            const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex flex-col items-center justify-center px-6 py-2 transition-all"
                style={{
                  fontFamily: "var(--font-sans), sans-serif",
                  fontSize: "0.65rem",
                  fontWeight: "600",
                  letterSpacing: "0.18em",
                  textTransform: "uppercase",
                  color: isActive ? "var(--gold)" : "var(--ink-mid)",
                  backgroundColor: isActive ? "rgba(9, 9, 11, 0.04)" : "transparent",
                  borderRight: "1px solid var(--limestone)",
                  borderBottom: isActive ? "2px solid var(--gold)" : "2px solid transparent",
                  textDecoration: "none",
                }}
              >
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>


        {/* Cohort */}
        <div className="relative flex items-center px-4" style={{ borderLeft: "1px solid var(--limestone)" }}>
          <button
            onClick={() => setCohortOpen(!cohortOpen)}
            className="flex items-center gap-2 px-3 py-1.5 transition-all"
            style={{
              fontFamily: "var(--font-sans), sans-serif",
              fontSize: "0.6rem",
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              color: cohortOpen ? "var(--gold)" : "var(--ink-faint)",
              border: "1px solid var(--limestone)",
              backgroundColor: "transparent",
              cursor: "pointer",
            }}
          >
            {userId ? userId.slice(0, 8) + "…" : "Cohort"}
          </button>

          {cohortOpen && (
            <div
              className="absolute right-0 top-full w-64 z-50"
              style={{
                backgroundColor: "var(--ivory)",
                border: "1px solid var(--limestone)",
                borderTop: "none",
                boxShadow: "0 4px 12px rgba(0, 0, 0, 0.05)",
              }}
            >
              <div className="meander w-full" aria-hidden="true" />
              <div className="p-4">
                <div className="inscription mb-2">Participant</div>
                <input
                  className="w-full px-3 py-2 text-sm outline-none"
                  style={{
                    border: "1px solid var(--limestone)",
                    backgroundColor: "var(--ivory-warm)",
                    color: "var(--ink)",
                    fontFamily: "var(--font-sans), sans-serif",
                    fontSize: "0.9rem",
                  }}
                  value={draftUserId}
                  onChange={(e) => setDraftUserId(e.target.value)}
                  onBlur={saveParticipantCode}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                />
                {user?.email && (
                  <div className="mt-2 truncate text-xs" style={{ color: "var(--ink-faint)", fontFamily: "var(--font-sans), sans-serif" }}>
                    {user.email}
                  </div>
                )}
                <button
                  onClick={() => signOut().catch(() => undefined)}
                  className="mt-3 w-full text-left py-1.5 text-sm"
                  style={{
                    color: "var(--ink-mid)",
                    fontFamily: "var(--font-sans), sans-serif",
                    borderTop: "1px solid var(--limestone)",
                    paddingTop: "10px",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  ← Sign out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
