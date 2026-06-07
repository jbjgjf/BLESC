"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth";

const primaryNav = [
  { href: "/",         label: "Intake",    sub: "Εἰσαγωγή" },
  { href: "/timeline", label: "Drift",     sub: "Χρόνος" },
  { href: "/graph",    label: "Ontology",  sub: "Ὀντολογία" },
  { href: "/insights", label: "Inference", sub: "Σύνθεσις" },
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
      className="sticky top-0 z-50"
      style={{
        backgroundColor: "var(--ivory-warm)",
        borderBottom: "1px solid var(--limestone)",
        boxShadow: "0 2px 16px rgba(42, 32, 24, 0.09)",
      }}
    >
      {/* Meander frieze at top */}
      <div className="meander w-full" aria-hidden="true" />

      <div className="mx-auto flex min-h-[58px] max-w-7xl flex-wrap items-stretch justify-between gap-0 px-0">

        {/* Brand — left column */}
        <Link
          href="/"
          className="flex items-center gap-3 px-6 py-3"
          style={{
            borderRight: "1px solid var(--limestone)",
            color: "var(--ink)",
            textDecoration: "none",
          }}
        >
          {/* Sigma emblem — coin-like */}
          <div
            className="flex h-9 w-9 items-center justify-center shrink-0"
            style={{
              border: "2px solid var(--gold)",
              color: "var(--gold)",
              fontFamily: "var(--font-cinzel), serif",
              fontSize: "1.1rem",
              fontWeight: "700",
            }}
          >
            Σ
          </div>
          <div>
            <div
              style={{
                fontFamily: "var(--font-cinzel), serif",
                fontSize: "0.85rem",
                fontWeight: "700",
                letterSpacing: "0.22em",
                textTransform: "uppercase",
                color: "var(--ink)",
                lineHeight: 1.2,
              }}
            >
              SENTRA
            </div>
            <div
              style={{
                fontFamily: "var(--font-cinzel), serif",
                fontSize: "0.55rem",
                letterSpacing: "0.2em",
                textTransform: "uppercase",
                color: "var(--ink-faint)",
                lineHeight: 1.2,
              }}
            >
              Education Risk · Monitor
            </div>
          </div>
        </Link>

        {/* Navigation — frieze columns */}
        <nav className="flex items-stretch flex-1">
          {primaryNav.map((item) => {
            const isActive =
              item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex flex-col items-center justify-center px-5 py-2 transition-all min-w-[80px]"
                style={{
                  fontFamily: "var(--font-cinzel), serif",
                  fontSize: "0.65rem",
                  fontWeight: "600",
                  letterSpacing: "0.18em",
                  textTransform: "uppercase",
                  color: isActive ? "var(--gold)" : "var(--ink-mid)",
                  backgroundColor: isActive
                    ? "rgba(196, 150, 42, 0.07)"
                    : "transparent",
                  borderRight: "1px solid var(--limestone)",
                  borderBottom: isActive
                    ? "2px solid var(--gold)"
                    : "2px solid transparent",
                  textDecoration: "none",
                }}
              >
                <span>{item.label}</span>
                <span
                  style={{
                    fontFamily: "var(--font-garamond), serif",
                    fontSize: "0.6rem",
                    fontStyle: "italic",
                    color: isActive ? "var(--gold-deep)" : "var(--ink-faint)",
                    letterSpacing: "0.02em",
                    marginTop: "2px",
                    fontWeight: "400",
                    textTransform: "none",
                  }}
                >
                  {item.sub}
                </span>
              </Link>
            );
          })}
        </nav>

        {/* Cohort control — right column */}
        <div className="relative flex items-center px-4" style={{ borderLeft: "1px solid var(--limestone)" }}>
          <button
            onClick={() => setCohortOpen(!cohortOpen)}
            className="flex items-center gap-2 px-3 py-1.5 transition-all"
            style={{
              fontFamily: "var(--font-cinzel), serif",
              fontSize: "0.6rem",
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: cohortOpen ? "var(--gold)" : "var(--ink-mid)",
              border: "1px solid var(--limestone)",
              backgroundColor: "transparent",
              cursor: "pointer",
            }}
          >
            ⚗ Cohort
          </button>

          {cohortOpen && (
            <div
              className="absolute right-0 top-full mt-0 w-72 z-50"
              style={{
                backgroundColor: "var(--ivory)",
                border: "1px solid var(--limestone)",
                borderTop: "none",
                boxShadow: "0 8px 40px rgba(42, 32, 24, 0.14)",
              }}
            >
              <div className="meander w-full" aria-hidden="true" />
              <div className="p-5">
                <div className="inscription mb-3">Participant Cohort</div>
                <input
                  className="w-full px-3 py-2 text-sm outline-none transition"
                  style={{
                    border: "1px solid var(--limestone)",
                    backgroundColor: "var(--ivory-warm)",
                    color: "var(--ink)",
                    fontFamily: "var(--font-garamond), serif",
                    fontSize: "0.9rem",
                  }}
                  value={draftUserId}
                  onChange={(e) => setDraftUserId(e.target.value)}
                  onBlur={saveParticipantCode}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  aria-label="Participant ID"
                />
                {user?.email && (
                  <div
                    className="mt-3 truncate text-xs"
                    style={{ color: "var(--ink-faint)", fontFamily: "var(--font-garamond), serif" }}
                  >
                    {user.email}
                  </div>
                )}
                <div
                  className="mt-1"
                  style={{ borderTop: "1px solid var(--limestone)", paddingTop: "10px" }}
                >
                  <button
                    onClick={() => signOut().catch(() => undefined)}
                    className="w-full text-left py-1.5 text-sm transition-all"
                    style={{
                      color: "var(--ink-mid)",
                      fontFamily: "var(--font-garamond), serif",
                      fontSize: "0.85rem",
                      cursor: "pointer",
                      background: "none",
                      border: "none",
                      letterSpacing: "0.02em",
                    }}
                  >
                    ← Withdraw from session
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
