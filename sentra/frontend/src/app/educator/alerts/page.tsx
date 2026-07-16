"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2, ShieldAlert } from "lucide-react";

import { ApiClient } from "@/api/client";
import type { CohortAlert } from "@/api/models";
import { panel } from "@/components/educator/StatusChips";

const TYPE_META: Record<CohortAlert["type"], { label: string; color: string }> = {
  safety_crisis: { label: "Safety · crisis", color: "var(--terracotta)" },
  safety_elevated: { label: "Safety · elevated", color: "var(--sienna)" },
  anomaly_spike: { label: "Signal spike", color: "var(--ochre)" },
  inactivity: { label: "Inactivity", color: "var(--ink-faint)" },
};

/**
 * Non-clinical escalation guidance (issue #37). Educators are routed to the
 * school's designated support path — never asked to diagnose or treat.
 */
function CrisisProtocol() {
  return (
    <div className="rounded-md px-4 py-3 text-xs leading-relaxed" style={{ backgroundColor: "rgba(244,63,94,0.06)", border: "1px solid var(--terracotta)", color: "var(--ink-mid)" }}>
      <div className="mb-1 flex items-center gap-2 font-semibold" style={{ color: "var(--sienna)" }}>
        <ShieldAlert className="h-4 w-4" />What to do now
      </div>
      <ol className="list-decimal space-y-1 pl-4">
        <li><strong>Today, in person if possible:</strong> connect this student with your school&apos;s designated support staff (counselor, nurse, or safeguarding lead).</li>
        <li>You don&apos;t need to diagnose or investigate — your role is to make sure a trusted, qualified adult follows up.</li>
        <li>If you believe there is immediate danger, follow your school&apos;s emergency procedure right away.</li>
      </ol>
      <p className="mt-2" style={{ color: "var(--ink-faint)" }}>
        BLESC signals are supportive indicators, not a clinical assessment. Acknowledging below records that you have seen this flag.
      </p>
    </div>
  );
}

export default function EducatorAlertsPage() {
  const [alerts, setAlerts] = useState<CohortAlert[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const logged = useRef(false);

  useEffect(() => {
    let cancelled = false;
    ApiClient.getCohortAlerts()
      .then((next) => {
        if (cancelled) return;
        setAlerts(next);
        setError(null);
        if (!logged.current && next.length) {
          logged.current = true;
          const students = [...new Map(next.map((alert) => [alert.participant_id, alert])).values()];
          void ApiClient.recordCohortAccess(students, "alerts");
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load alerts.");
      });
    return () => { cancelled = true; };
  }, []);

  const acknowledge = async (alert: CohortAlert) => {
    setBusyKey(alert.alert_key);
    try {
      await ApiClient.acknowledgeAlert(alert);
      setAlerts((current) => current?.map((item) =>
        item.alert_key === alert.alert_key ? { ...item, acknowledged: true } : item,
      ) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Acknowledging the alert failed.");
    } finally {
      setBusyKey(null);
    }
  };

  if (error && !alerts) {
    return <div className="flex items-center gap-2 px-6 py-4 text-sm" style={{ ...panel, color: "var(--sienna)" }}><AlertCircle className="h-4 w-4" />{error}</div>;
  }
  if (!alerts) {
    return <div className="flex h-48 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" style={{ color: "var(--sandstone)" }} /></div>;
  }
  if (alerts.length === 0) {
    return (
      <section className="px-8 py-10 text-center text-sm" style={{ ...panel, color: "var(--ink-mid)" }}>
        No alerts right now. Alerts appear when a consented student has a safety flag, a signal spike, or a quiet week.
      </section>
    );
  }

  return (
    <div className="space-y-4">
      {error ? <p role="alert" className="px-1 text-sm" style={{ color: "var(--sienna)" }}>{error}</p> : null}
      {alerts.map((alert) => {
        const meta = TYPE_META[alert.type];
        const isCrisis = alert.type === "safety_crisis";
        return (
          <section key={alert.alert_key} className="space-y-3 px-6 py-5" style={{ ...panel, borderLeft: `3px solid ${meta.color}` }}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="rounded-full px-2.5 py-0.5 text-xs font-semibold" style={{ border: `1px solid ${meta.color}`, color: meta.color }}>
                    {meta.label}
                  </span>
                  <Link href={`/educator/student/${alert.participant_id}`} className="font-mono text-sm font-semibold" style={{ color: "var(--ink)" }}>
                    {alert.code}
                  </Link>
                </div>
                <p className="mt-2 text-sm" style={{ color: "var(--ink-mid)" }}>{alert.detail}</p>
              </div>
              {alert.acknowledged ? (
                <span className="inline-flex items-center gap-1 text-xs font-semibold" style={{ color: "var(--aegean)" }}>
                  <CheckCircle2 className="h-4 w-4" />Acknowledged
                </span>
              ) : (
                <button
                  type="button"
                  disabled={busyKey === alert.alert_key}
                  onClick={() => acknowledge(alert)}
                  className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-60"
                  style={isCrisis
                    ? { backgroundColor: "var(--terracotta)", color: "#fff" }
                    : { border: "1px solid var(--limestone)", color: "var(--ink-mid)" }}
                >
                  {busyKey === alert.alert_key ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlertTriangle className="h-4 w-4" />}
                  {isCrisis ? "Acknowledge crisis flag" : "Mark reviewed"}
                </button>
              )}
            </div>
            {isCrisis && !alert.acknowledged ? <CrisisProtocol /> : null}
          </section>
        );
      })}
    </div>
  );
}
