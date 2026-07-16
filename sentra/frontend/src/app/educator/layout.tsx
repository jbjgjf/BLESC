"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { useAuth } from "@/lib/auth";

const sections = [
  { href: "/educator", label: "Overview" },
  { href: "/educator/roster", label: "Roster" },
  { href: "/educator/alerts", label: "Alerts" },
];

/**
 * Role-gated shell for all educator surfaces. UI gating only — the actual
 * enforcement is RLS: a non-educator reaching these routes sees no data.
 */
export default function EducatorLayout({ children }: { children: React.ReactNode }) {
  const { isEducator, isLoading, educatorMemberships } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !isEducator) router.replace("/");
  }, [isEducator, isLoading, router]);

  if (isLoading || !isEducator) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Loader2 className="h-7 w-7 animate-spin" style={{ color: "var(--sandstone)" }} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div
        className="flex flex-wrap items-center justify-between gap-3 px-6 py-4"
        style={{ backgroundColor: "var(--ivory-warm)", border: "1px solid var(--limestone)" }}
      >
        <div>
          <div className="inscription">Educator dashboard</div>
          <div className="mt-1 text-sm font-semibold" style={{ color: "var(--ink)" }}>
            {educatorMemberships.map((membership) => membership.org_name).join(" · ")}
          </div>
        </div>
        <nav className="flex gap-1">
          {sections.map((section) => {
            const isActive = section.href === "/educator"
              ? pathname === "/educator"
              : pathname.startsWith(section.href);
            return (
              <Link
                key={section.href}
                href={section.href}
                className="rounded-md px-3 py-1.5 text-sm font-semibold"
                style={{
                  color: isActive ? "var(--ink)" : "var(--ink-faint)",
                  backgroundColor: isActive ? "var(--ivory)" : "transparent",
                  border: isActive ? "1px solid var(--limestone)" : "1px solid transparent",
                }}
              >
                {section.label}
              </Link>
            );
          })}
        </nav>
      </div>
      <p className="px-1 text-xs" style={{ color: "var(--ink-faint)" }}>
        Derived signals only — journal and chat text is never shown here. Every view is logged and visible to the student.
      </p>
      {children}
    </div>
  );
}
