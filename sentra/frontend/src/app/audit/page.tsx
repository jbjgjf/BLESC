"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiClient } from "@/api/client";
import type { AiAuditEvent, ReflectionAuditTrail } from "@/api/models";
import { useAuth } from "@/lib/auth";
import { Icon } from "@/components/ui/Icon";
import styles from "./audit.module.css";
import { t } from "@/lib/i18n";

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  completed:  { label: t.audit.status.completed,  className: "bl-chip--calm" },
  suppressed: { label: t.audit.status.suppressed, className: "bl-chip--alert" },
  failed:     { label: t.audit.status.failed,     className: "bl-chip--alert" },
  error:      { label: t.audit.status.error,      className: "bl-chip--alert" },
};

function StatusPill({ status }: { status: string }) {
  const meta = STATUS_LABELS[status] ?? { label: status, className: "" };
  return <span className={`bl-chip ${meta.className}`}>{meta.label}</span>;
}

function AuditEventRow({ event }: { event: AiAuditEvent }) {
  return (
    <article className={styles.event}>
      <div className={styles.eventHead}>
        <span className="bl-row" style={{ gap: 8 }}>
          <Icon
            name={event.error_message ? "error" : "check_circle"}
            size={18}
            fill
            style={{ color: event.error_message ? "var(--bl-alert)" : "var(--bl-ink-3)" }}
          />
          <span className="bl-h3">{event.label}</span>
        </span>
        <span className="bl-row" style={{ gap: 9 }}>
          <StatusPill status={event.status} />
          <time className="bl-micro">{new Date(event.occurred_at).toLocaleString("ja-JP")}</time>
        </span>
      </div>

      <dl className={styles.meta}>
        <div>
          <dt>{t.audit.providerModel}</dt>
          <dd>
            {event.provider}
            {t.audit.inlineSeparator}
            {event.model}
          </dd>
        </div>
        <div>
          <dt>{t.audit.promptVersion}</dt>
          <dd>{event.prompt_version}</dd>
        </div>
        {event.pipeline_version && (
          <div>
            <dt>{t.audit.pipeline}</dt>
            <dd>{event.pipeline_version}</dd>
          </div>
        )}
        {typeof event.temperature === "number" && (
          <div>
            <dt>{t.audit.temperature}</dt>
            <dd>{event.temperature}</dd>
          </div>
        )}
        {event.output_hash && (
          <div className={styles.wide}>
            <dt>{t.audit.outputHash}</dt>
            <dd className={styles.mono}>{event.output_hash}</dd>
          </div>
        )}
      </dl>

      {event.safety_decision && (
        <div className={styles.safety}>
          <div className="bl-row" style={{ gap: 7 }}>
            <Icon name="shield" size={17} fill />
            <span style={{ fontWeight: 700 }}>
              {t.audit.safetyDecision}
              {t.audit.inlineSeparator}
              {t.safety.level[event.safety_decision.risk_level] ??
                event.safety_decision.risk_level}
              {event.safety_decision.escalation_required
                ? t.audit.escalationRequired
                : ""}
            </span>
          </div>
          {event.safety_decision.reasons.length > 0 && (
            <p style={{ marginTop: 5 }}>
              {t.audit.safetyReasons(
                event.safety_decision.reasons
                  .map((reason) => t.safety.reason[reason] ?? reason)
                  .join(t.audit.listSeparator),
              )}
            </p>
          )}
          {event.safety_decision.policy_refs.length > 0 && (
            <p style={{ marginTop: 3, opacity: 0.8 }}>
              {t.audit.safetyPolicies(
                event.safety_decision.policy_refs.join(t.audit.listSeparator),
              )}
            </p>
          )}
        </div>
      )}

      {event.evidence_refs.length > 0 && (
        <div className={styles.evidence}>
          <span className="bl-micro" style={{ fontWeight: 700 }}>{t.audit.evidenceRefs}</span>
          <ul>
            {event.evidence_refs.map((ref) => (
              <li key={ref} className={styles.mono}>{ref}</li>
            ))}
          </ul>
        </div>
      )}

      {event.error_message && (
        <p role="alert" className={styles.error}>
          {t.audit.errorLine(event.error_message)}
        </p>
      )}
    </article>
  );
}

function TrailCard({ trail }: { trail: ReflectionAuditTrail }) {
  return (
    <section className="bl-card bl-card--flush bl-rise">
      <header className={styles.trailHead}>
        <div style={{ minWidth: 0 }}>
          <span className="bl-eyebrow">{t.audit.trailEyebrow}</span>
          <div className={`${styles.mono} ${styles.trailId}`}>
            {trail.reflection_id ?? trail.correlation_id}
          </div>
          <div className="bl-micro" style={{ marginTop: 3 }}>
            {t.audit.trailSummary(
              trail.event_count,
              new Date(trail.first_event_at).toLocaleDateString("ja-JP"),
            )}
          </div>
        </div>
        <div className="bl-row" style={{ gap: 8, flexWrap: "wrap" }}>
          {trail.has_safety_flag && (
            <span className="bl-chip bl-chip--alert">
              <Icon name="shield" size={14} fill />
              {t.audit.hasSafetyFlag}
            </span>
          )}
          {trail.has_failure && (
            <span className="bl-chip bl-chip--watch">
              <Icon name="warning" size={14} fill />
              {t.audit.hasFailure}
            </span>
          )}
        </div>
      </header>
      <div>
        {trail.events.map((event) => (
          <AuditEventRow key={event.id} event={event} />
        ))}
      </div>
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

  const load = useCallback(
    async (reflectionId?: string) => {
      setIsLoading(true);
      setError(null);
      try {
        setTrails(await ApiClient.getAuditTrails(userId, reflectionId || undefined));
      } catch (err) {
        setError(err instanceof Error ? err.message : t.audit.loadFailed);
      } finally {
        setIsLoading(false);
      }
    },
    [userId],
  );

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
    <div className="bl-wrap bl-stack">
      <header style={{ padding: "2px 2px 0" }}>
        <h1 className="bl-h1">{t.audit.title}</h1>
        <p className="bl-meta" style={{ marginTop: 3 }}>
          {t.audit.intro}
        </p>
      </header>

      <section className={`${styles.intro} bl-rise`}>
        <Icon name="history" size={24} />
        <div style={{ flex: 1 }}>
          <h2 className="bl-h3">{t.audit.scopeTitle}</h2>
          <p className="bl-body" style={{ marginTop: 5 }}>
            {t.audit.scopeBody}
          </p>

          <form onSubmit={applyFilter} className={styles.filterForm}>
            <input
              type="text"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t.audit.filterPlaceholder}
              aria-label={t.audit.filterLabel}
              className="bl-input"
            />
            <button type="submit" disabled={isLoading} className="bl-btn bl-btn--primary">
              {isLoading && <span className={styles.spinner} aria-hidden="true" />}
              {appliedFilter ? t.audit.search : t.audit.reload}
            </button>
          </form>
        </div>
      </section>

      {error && (
        <div className="bl-notice bl-notice--alert" role="alert">
          <Icon name="error" size={19} fill />
          <span>{error}</span>
        </div>
      )}

      {isLoading && !trails && (
        <div className="bl-row" style={{ gap: 10, padding: "0 2px", color: "var(--bl-ink-3)" }}>
          <span className="bl-loader" style={{ width: 20, height: 20, borderWidth: 2 }} />
          <span className="bl-meta">{t.audit.loading}</span>
        </div>
      )}

      {trails && trails.length === 0 && !isLoading && (
        <div className="bl-card bl-empty">
          <Icon name="history" size={40} />
          <p className="bl-body">
            {appliedFilter
              ? t.audit.emptyFiltered(appliedFilter)
              : t.audit.empty}
          </p>
        </div>
      )}

      {trails?.map((trail) => (
        <TrailCard key={trail.correlation_id} trail={trail} />
      ))}
    </div>
  );
}
