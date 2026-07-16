"use client";

import Link from "next/link";

const panel: React.CSSProperties = {
  backgroundColor: "var(--ivory)",
  border: "1px solid var(--limestone)",
  boxShadow: "0 1px 3px rgba(42,32,24,0.09), 0 6px 24px rgba(42,32,24,0.05)",
};

export default function EducatorOverviewPage() {
  return (
    <section className="px-8 py-10 text-center" style={panel}>
      <h1 className="text-2xl font-bold" style={{ color: "var(--ink)" }}>Cohort overview</h1>
      <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed" style={{ color: "var(--ink-mid)" }}>
        Overview tiles appear once students in your roster have consented to sharing derived signals.
        Start with the <Link href="/educator/roster" style={{ color: "var(--gold-deep)", fontWeight: 600 }}>roster</Link> to
        see who has been linked to you.
      </p>
    </section>
  );
}
