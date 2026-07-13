"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2, ShieldAlert } from "lucide-react";

import { ApiClient } from "@/api/client";
import type { AiAuditEvent, ReflectionAuditTrail } from "@/api/models";
import { useAuth } from "@/lib/auth";

const panel: React.CSSProperties = {
  backgroundColor: "var(--ivory)",
  border: "1px solid var(--limestone)",
  boxShadow: "0 1px 3px rgba(42,32,24,0.09), 0 6px 24px rgba(42,32,24,0.05)",
};

const STATUS_STYLES: Record<string, { color: string; label: string }> = {
  completed: { color: "var(--aegean)", label: "completed" },
  suppressed: { color: "var(--sienna)", label: "suppressed" },
  failed: { color: "var(--terracotta)", label: "failed" },
  error: { color: "var(--terracotta)", label: "error" },
};

function StatusPill({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? { color: "var(--ink-faint)", label: status };
  return (
    <span className="rounded-full px-2 py-0.5 text-xs font-semibold" style={{ border: `1px solid ${style.color}`, color: style.color }}>
      {style.label}
    </span>
  );
}

function AuditEventRow({ event }: { event: AiAuditEvent }) {
  return (
    <article className="px-6 py-4" style={{ borderBottom: "1px solid var(--limestone)" }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-semibold" style={{ color: "var(--ink)" }}>
          {event.error_message ? <AlertCircle className="h-4 w-4" style={{ color: "var(--terracotta)" }} /> : <CheckCircle2 className="h-4 w-4" style={{ color: "var(--ink-faint)" }} />}
          {event.label}
        </div>
        <div className="flex items-center gap-2">
          <StatusPill status={event.status} />
          <time className="text-xs" style={{ color: "var(--ink-faint)" }}>{new Date(event.occurred_at).toLocaleString()}</time>
        </div>
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2" style={{ color: "var(--ink-mid)" }}>
        <div><dt className="inline font-semibold">Provider / model:</dt> <dd className="inline">{event.provider} · {event.model}</dd></div>
        <div><dt className="inline font-semibold">Prompt version:</dt> <dd className="inline">{event.prompt_version}</dd></div>
        {event.pipeline_version ? <div><dt className="inline font-semibold">Pipeline:</dt> <dd className="inline">{event.pipeline_version}</dd></div> : null}
        {typeof event.temperature === "number" ? <div><dt className="inline font-semibold">Temperature:</dt> <dd className="inline">{event.temperature}</dd></div> : null}
        {event.output_hash ? <div className="sm:col-span-2"><dt className="inline font-semibold">Output hash:</dt> <dd className="inline break-all font-mono">{event.output_hash}</dd></div> : null}
      </dl>

      {event.safety_decision ? (
        <div className="mt-3 rounded-md px-4 py-3 text-xs" style={{ backgroundColor: "rgba(244,63,94,0.06)", border: "1px solid var(--terracotta)" }}>
          <div className="flex items-center gap-2 font-semibold" style={{ color: "var(--sienna)" }}>
            <ShieldAlert className="h-4 w-4" />Safety decision · {event.safety_decision.risk_level}
            {event.safety_decision.escalation_required ? " · escalation required" : ""}
          </div>
          {event.safety_decision.reasons.length ? <p className="mt-1" style={{ color: "var(--ink-mid)" }}>Reasons: {event.safety_decision.reasons.join(", ")}</p> : null}
          {event.safety_decision.policy_refs.length ? <p className="mt-1" style={{ color: "var(--ink-faint)" }}>Policy: {event.safety_decision.policy_refs.join(", ")}</p> : null}
        </div>
      ) : null}

      {event.evidence_refs.length ? (
        <div className="mt-3 text-xs" style={{ color: "var(--ink-faint)" }}>
          <span className="font-semibold" style={{ color: "var(--ink-mid)" }}>Evidence refs:</span>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {event.evidence_refs.map((ref) => <li key={ref} className="break-all">{ref}</li>)}
          </ul>
        </div>
      ) : null}

      {event.error_message ? <p role="alert" className="mt-2 text-xs" style={{ color: "var(--terracotta)" }}>Error: {event.error_message}</p> : null}
    </article>
  );
}

function TrailCard({ trail }: { trail: ReflectionAuditTrail }) {
  return (
    <section style={panel}>
      <header className="flex flex-wrap items-start justify-between gap-3 px-6 py-4" style={{ borderBottom: "1px solid var(--limestone)" }}>
        <div className="min-w-0">
          <div className="inscription mb-1">Reflection audit trail</div>
          <div className="truncate font-mono text-sm font-semibold" style={{ color: "var(--ink)" }}>{trail.reflection_id ?? trail.correlation_id}</div>
          <div className="mt-1 text-xs" style={{ color: "var(--ink-faint)" }}>
            {trail.event_count} event{trail.event_count === 1 ? "" : "s"} · {new Date(trail.first_event_at).toLocaleDateString()}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {trail.has_safety_flag ? (
            <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold" style={{ border: "1px solid var(--sienna)", color: "var(--sienna)" }}>
              <ShieldAlert className="h-3.5 w-3.5" />Safety flag
            </span>
          ) : null}
          {trail.has_failure ? (
            <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold" style={{ border: "1px solid var(--terracotta)", color: "var(--terracotta)" }}>
              <AlertTriangle className="h-3.5 w-3.5" />Failure
            </span>
          ) : null}
        </div>
      </header>
      <div>{trail.events.map((event) => <AuditEventRow key={event.id} event={event} />)}</div>
    </section>
  );
}

export default function AuditPage() {
  const { userId } = useAuth();
  const [trails, setTrails] = useState<ReflectionAuditTrail[] | null>(null);
  const [filter, setFilter] = useState("");
  const [appliedFilter, setAppliedFilter] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (reflectionId?: string) => {
    setIsLoading(true);
    setError(null);
    try {
      setTrails(await ApiClient.getAuditTrails(userId, reflectionId || undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit trails.");
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const applyFilter = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = filter.trim();
    setAppliedFilter(trimmed);
    void load(trimmed);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <section className="px-8 py-7" style={{ ...panel, backgroundColor: "var(--ivory-warm)" }}>
        <div className="inscription mb-3">Reviewer transparency</div>
        <h1 className="text-3xl font-bold" style={{ color: "var(--ink)" }}>AI audit log inspector</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed" style={{ color: "var(--ink-mid)" }}>
          Inspect how each response was produced: extraction, safety decision, evidence references, and model metadata.
          Only hashes and structured metadata are shown — raw journal text and secrets are never included.
        </p>
        <form onSubmit={applyFilter} className="mt-5 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter by reflection id (optional)"
            aria-label="Filter by reflection id"
            className="min-w-0 flex-1 rounded-md px-3 py-2 text-sm"
            style={{ border: "1px solid var(--limestone)", backgroundColor: "var(--ivory)", color: "var(--ink)" }}
          />
          <button type="submit" disabled={isLoading} className="inline-flex items-center gap-2 rounded-md px-5 py-2 font-semibold disabled:opacity-60" style={{ backgroundColor: "var(--gold)", color: "#000" }}>
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {appliedFilter ? "Search" : "Refresh"}
          </button>
        </form>
        {error ? <p role="alert" className="mt-3 text-sm" style={{ color: "var(--sienna)" }}>{error}</p> : null}
      </section>

      {isLoading && !trails ? (
        <div className="flex items-center gap-2 px-2 text-sm" style={{ color: "var(--ink-faint)" }}>
          <Loader2 className="h-4 w-4 animate-spin" />Loading audit trails…
        </div>
      ) : null}

      {trails && trails.length === 0 && !isLoading ? (
        <section className="px-8 py-10 text-center" style={panel}>
          <p className="text-sm" style={{ color: "var(--ink-mid)" }}>
            {appliedFilter ? `No audit events found for reflection "${appliedFilter}".` : "No audit events yet. Submit a reflection to generate an audit trail."}
          </p>
        </section>
      ) : null}

      {trails?.map((trail) => <TrailCard key={trail.correlation_id} trail={trail} />)}
    </div>
  );
}
