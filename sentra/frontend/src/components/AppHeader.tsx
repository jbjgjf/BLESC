"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth";

const primaryNav = [
  { href: "/",      label: "Record" },
  { href: "/chat",  label: "Chat" },
  { href: "/voice", label: "Voice" },
  { href: "/graph", label: "Graph" },
  { href: "/support-summary", label: "Summary" },
  { href: "/audit", label: "Audit" },
  { href: "/sharing", label: "Sharing" },
];

const educatorNav = { href: "/educator", label: "Dashboard" };

const aqua = {
  ink: "hsl(206, 60%, 18%)",
  inkMid: "hsl(206, 32%, 36%)",
  inkFaint: "hsl(206, 22%, 50%)",
  border: "hsla(206, 74%, 72%, 0.4)",
  accent: "hsl(206, 72%, 40%)",
};

export function AppHeader() {
  const pathname = usePathname();
  const { userId, setUserId, signOut, user, isEducator } = useAuth();
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
        backgroundColor: "hsla(0, 0%, 100%, 0.78)",
        borderBottom: `1px solid ${aqua.border}`,
        boxShadow: "0 4px 20px hsla(206, 60%, 50%, 0.10)",
      }}
    >
      <div className="mx-auto flex min-h-[56px] max-w-4xl flex-wrap items-stretch justify-between gap-0 px-0">

        {/* Brand */}
        <Link
          href="/"
          className="flex items-center gap-2.5 px-6 py-3"
          style={{ color: aqua.ink, textDecoration: "none" }}
        >
          <Image
            src="/flower.png"
            className="h-[30px] w-[30px] shrink-0 object-contain"
            alt=""
            width={30}
            height={30}
            priority
          />
          <span
            style={{
              fontFamily: "var(--font-sans), sans-serif",
              fontSize: "1rem",
              fontWeight: 700,
              letterSpacing: "-0.01em",
              color: aqua.ink,
            }}
          >
            blesc
          </span>
        </Link>

        {/* Nav */}
        <nav className="flex flex-1 items-stretch justify-center">
          {(isEducator ? [...primaryNav, educatorNav] : primaryNav).map((item) => {
            const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex flex-col items-center justify-center px-4 py-2 transition-all"
                style={{
                  fontFamily: "var(--font-sans), sans-serif",
                  fontSize: "0.68rem",
                  fontWeight: 600,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  color: isActive ? aqua.accent : aqua.inkMid,
                  borderBottom: isActive ? `2px solid ${aqua.accent}` : "2px solid transparent",
                  textDecoration: "none",
                }}
              >
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Cohort */}
        <div className="relative flex items-center px-4">
          <button
            onClick={() => setCohortOpen(!cohortOpen)}
            className="flex items-center gap-2 px-3.5 py-1.5 transition-all"
            style={{
              fontFamily: "var(--font-sans), sans-serif",
              fontSize: "0.6rem",
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              color: cohortOpen ? aqua.accent : aqua.inkFaint,
              border: `1px solid ${aqua.border}`,
              borderRadius: "999px",
              backgroundColor: "hsla(206, 74%, 90%, 0.4)",
              cursor: "pointer",
            }}
          >
            {userId ? userId.slice(0, 8) + "…" : "Cohort"}
          </button>

          {cohortOpen && (
            <div
              className="absolute right-0 top-full z-50 mt-2 w-64"
              style={{
                backgroundColor: "hsla(0, 0%, 100%, 0.92)",
                backdropFilter: "blur(14px)",
                WebkitBackdropFilter: "blur(14px)",
                border: `1px solid ${aqua.border}`,
                borderRadius: "18px",
                boxShadow: "0 10px 32px hsla(206, 60%, 45%, 0.18)",
              }}
            >
              <div className="p-4">
                <div
                  className="mb-2"
                  style={{
                    fontFamily: "var(--font-sans), sans-serif",
                    fontSize: "0.65rem",
                    fontWeight: 600,
                    letterSpacing: "0.15em",
                    textTransform: "uppercase",
                    color: aqua.inkFaint,
                  }}
                >
                  Participant
                </div>
                <input
                  className="w-full px-3 py-2 text-sm outline-none"
                  style={{
                    border: `1px solid ${aqua.border}`,
                    borderRadius: "12px",
                    backgroundColor: "hsl(206, 80%, 97%)",
                    color: aqua.ink,
                    fontFamily: "var(--font-sans), sans-serif",
                    fontSize: "0.9rem",
                  }}
                  value={draftUserId}
                  onChange={(e) => setDraftUserId(e.target.value)}
                  onBlur={saveParticipantCode}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                />
                {user?.email && (
                  <div className="mt-2 truncate text-xs" style={{ color: aqua.inkFaint, fontFamily: "var(--font-sans), sans-serif" }}>
                    {user.email}
                  </div>
                )}
                <button
                  onClick={() => signOut().catch(() => undefined)}
                  className="mt-3 w-full py-1.5 text-left text-sm"
                  style={{
                    color: aqua.inkMid,
                    fontFamily: "var(--font-sans), sans-serif",
                    borderTop: `1px solid ${aqua.border}`,
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
