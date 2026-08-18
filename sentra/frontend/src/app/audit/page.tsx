"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiClient } from "@/api/client";
import type { AiAuditEvent, ReflectionAuditTrail } from "@/api/models";
import { useAuth } from "@/lib/auth";
import { Icon } from "@/components/ui/Icon";
import styles from "./audit.module.css";

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  completed:  { label: "完了",     className: "bl-chip--calm" },
  suppressed: { label: "表示を抑制", className: "bl-chip--alert" },
  failed:     { label: "失敗",     className: "bl-chip--alert" },
  error:      { label: "エラー",   className: "bl-chip--alert" },
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
          <dt>提供元 / モデル</dt>
          <dd>{event.provider} ・ {event.model}</dd>
        </div>
        <div>
          <dt>プロンプト版</dt>
          <dd>{event.prompt_version}</dd>
        </div>
        {event.pipeline_version && (
          <div>
            <dt>パイプライン</dt>
            <dd>{event.pipeline_version}</dd>
          </div>
        )}
        {typeof event.temperature === "number" && (
          <div>
            <dt>Temperature</dt>
            <dd>{event.temperature}</dd>
          </div>
        )}
        {event.output_hash && (
          <div className={styles.wide}>
            <dt>出力ハッシュ</dt>
            <dd className={styles.mono}>{event.output_hash}</dd>
          </div>
        )}
      </dl>

      {event.safety_decision && (
        <div className={styles.safety}>
          <div className="bl-row" style={{ gap: 7 }}>
            <Icon name="shield" size={17} fill />
            <span style={{ fontWeight: 700 }}>
              安全性の判定 ・ {event.safety_decision.risk_level}
              {event.safety_decision.escalation_required ? " ・ エスカレーションが必要" : ""}
            </span>
          </div>
          {event.safety_decision.reasons.length > 0 && (
            <p style={{ marginTop: 5 }}>根拠：{event.safety_decision.reasons.join("、")}</p>
          )}
          {event.safety_decision.policy_refs.length > 0 && (
            <p style={{ marginTop: 3, opacity: 0.8 }}>
              ポリシー：{event.safety_decision.policy_refs.join("、")}
            </p>
          )}
        </div>
      )}

      {event.evidence_refs.length > 0 && (
        <div className={styles.evidence}>
          <span className="bl-micro" style={{ fontWeight: 700 }}>根拠の参照</span>
          <ul>
            {event.evidence_refs.map((ref) => (
              <li key={ref} className={styles.mono}>{ref}</li>
            ))}
          </ul>
        </div>
      )}

      {event.error_message && (
        <p role="alert" className={styles.error}>
          エラー：{event.error_message}
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
          <span className="bl-eyebrow">1件の記録の処理履歴</span>
          <div className={`${styles.mono} ${styles.trailId}`}>
            {trail.reflection_id ?? trail.correlation_id}
          </div>
          <div className="bl-micro" style={{ marginTop: 3 }}>
            {trail.event_count}件の処理 ・ {new Date(trail.first_event_at).toLocaleDateString("ja-JP")}
          </div>
        </div>
        <div className="bl-row" style={{ gap: 8, flexWrap: "wrap" }}>
          {trail.has_safety_flag && (
            <span className="bl-chip bl-chip--alert">
              <Icon name="shield" size={14} fill />
              安全性の記録あり
            </span>
          )}
          {trail.has_failure && (
            <span className="bl-chip bl-chip--watch">
              <Icon name="warning" size={14} fill />
              失敗あり
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
        setError(err instanceof Error ? err.message : "処理履歴の読み込みに失敗しました。");
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
        <h1 className="bl-h1">AI処理の記録</h1>
        <p className="bl-meta" style={{ marginTop: 3 }}>
          AIがどう応答を作ったかを、あとから確認できます。
        </p>
      </header>

      <section className={`${styles.intro} bl-rise`}>
        <Icon name="history" size={24} />
        <div style={{ flex: 1 }}>
          <h2 className="bl-h3">処理の内訳をたどれます</h2>
          <p className="bl-body" style={{ marginTop: 5 }}>
            感情の抽出、安全性の判定、根拠の参照、使用したモデルの情報を確認できます。
            表示されるのはハッシュと構造化された情報だけで、日記の本文や認証情報は含まれません。
          </p>

          <form onSubmit={applyFilter} className={styles.filterForm}>
            <input
              type="text"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="記録のIDで絞り込む（任意）"
              aria-label="記録のIDで絞り込む"
              className="bl-input"
            />
            <button type="submit" disabled={isLoading} className="bl-btn bl-btn--primary">
              {isLoading && <span className={styles.spinner} aria-hidden="true" />}
              {appliedFilter ? "検索" : "再読み込み"}
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
          <span className="bl-meta">処理履歴を読み込んでいます…</span>
        </div>
      )}

      {trails && trails.length === 0 && !isLoading && (
        <div className="bl-card bl-empty">
          <Icon name="history" size={40} />
          <p className="bl-body">
            {appliedFilter
              ? `「${appliedFilter}」に一致する処理履歴はありません。`
              : "まだ処理履歴がありません。日記を提出すると記録されます。"}
          </p>
        </div>
      )}

      {trails?.map((trail) => (
        <TrailCard key={trail.correlation_id} trail={trail} />
      ))}
    </div>
  );
}
