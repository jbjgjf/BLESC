"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiClient } from "@/api/client";
import type { OversightRequest, SharedSupportSummary, StudentAccessRecord } from "@/api/models";
import { useAuth } from "@/lib/auth";
import { Icon } from "@/components/ui/Icon";
import styles from "./sharing.module.css";
import { t } from "@/lib/i18n";

const VIEW_LABELS: Record<string, string> = {
  ...t.sharing.viewLabel,
};

/** 共有されない情報 — 生徒が一目で分かるように明示する。 */
const NOT_SHARED = [
  ...t.sharing.notShared,
];

function statusChip(request: OversightRequest): { label: string; className: string } {
  if (request.roster_status !== "active") return { label: t.sharing.status.inactive, className: "" };
  if (request.consent_status === "active") return { label: t.sharing.status.active, className: "bl-chip--calm" };
  if (request.consent_status === "revoked") return { label: t.sharing.status.revoked, className: "bl-chip--alert" };
  return { label: t.sharing.status.pending, className: "bl-chip--watch" };
}

export default function SharingPage() {
  const { userId } = useAuth();
  const [requests, setRequests] = useState<OversightRequest[] | null>(null);
  const [accessLog, setAccessLog] = useState<StudentAccessRecord[]>([]);
  const [shares, setShares] = useState<SharedSupportSummary[]>([]);
  const [busyShareId, setBusyShareId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busyOrgId, setBusyOrgId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [nextRequests, nextAccessLog, nextShares] = await Promise.all([
        ApiClient.listOversightRequests(userId),
        ApiClient.listEducatorAccess(userId),
        ApiClient.listMySummaryShares(userId).catch(() => []),
      ]);
      setRequests(nextRequests);
      setAccessLog(nextAccessLog);
      setShares(nextShares);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.sharing.loadFailed);
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const revokeShare = async (shareId: string) => {
    setBusyShareId(shareId);
    setError(null);
    try {
      await ApiClient.revokeSummaryShare(shareId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.sharing.revokeFailed);
    } finally {
      setBusyShareId(null);
    }
  };

  const setConsent = async (orgId: string, grant: boolean) => {
    setBusyOrgId(orgId);
    setError(null);
    try {
      if (grant) await ApiClient.grantOversightConsent(userId, orgId);
      else await ApiClient.revokeOversightConsent(userId, orgId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.sharing.updateFailed);
    } finally {
      setBusyOrgId(null);
    }
  };

  return (
    <div className="bl-wrap bl-stack">
      <header style={{ padding: "2px 2px 0" }}>
        <h1 className="bl-h1">{t.sharing.title}</h1>
        <p className="bl-meta" style={{ marginTop: 3 }}>
          {t.sharing.intro}
        </p>
      </header>

      <section className={`${styles.intro} bl-rise`}>
        <Icon name="shield" size={24} />
        <div>
          <h2 className="bl-h3">{t.sharing.scopeTitle}</h2>
          <p className="bl-body" style={{ marginTop: 5 }}>
            {t.sharing.scopeBodyBefore}
            <strong>{t.sharing.scopeBodyEmphasis}</strong>
            {t.sharing.scopeBodyAfter}
          </p>
          <ul className={styles.notShared}>
            {NOT_SHARED.map((item) => (
              <li key={item}>
                <Icon name="lock" size={15} />
                {item}
                {t.sharing.notSharedSuffix}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {error && (
        <div className="bl-notice bl-notice--alert" role="alert">
          <Icon name="error" size={19} fill />
          <span>{error}</span>
        </div>
      )}

      {isLoading && (
        <div className="bl-row" style={{ gap: 10, padding: "0 2px", color: "var(--bl-ink-3)" }}>
          <span className="bl-loader" style={{ width: 20, height: 20, borderWidth: 2 }} />
          <span className="bl-meta">{t.sharing.loading}</span>
        </div>
      )}

      {requests && requests.length === 0 && !isLoading && (
        <div className="bl-card bl-empty">
          <Icon name="shield" size={40} />
          <p className="bl-body">
            {t.sharing.emptyTitle}
            <br />
            {t.sharing.emptyBody}
          </p>
        </div>
      )}

      {requests?.map((request) => {
        const chip = statusChip(request);
        const sharing = request.roster_status === "active" && request.consent_status === "active";
        const busy = busyOrgId === request.org_id;
        return (
          <section key={request.org_id} className={`bl-card ${styles.orgRow} bl-rise`}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="bl-h3">{request.org_name}</div>
              <div className="bl-row" style={{ gap: 9, marginTop: 7, flexWrap: "wrap" }}>
                <span className={`bl-chip ${chip.className}`}>{chip.label}</span>
                {request.granted_at && sharing && (
                  <span className="bl-micro">
                    {t.sharing.grantedSince(
                      new Date(request.granted_at).toLocaleDateString("ja-JP"),
                    )}
                  </span>
                )}
              </div>
            </div>

            {request.roster_status === "active" &&
              (sharing ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConsent(request.org_id, false)}
                  data-testid={`revoke-consent-${request.org_id}`}
                  className={`bl-btn ${styles.stopBtn}`}
                >
                  <Icon name="lock" size={17} />
                  {t.sharing.stop}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConsent(request.org_id, true)}
                  data-testid={`grant-consent-${request.org_id}`}
                  className="bl-btn bl-btn--primary"
                >
                  <Icon name="check" size={18} />
                  {t.sharing.grant}
                </button>
              ))}
          </section>
        );
      })}

      {!isLoading && shares.length > 0 && (
        <section className="bl-card bl-rise" data-testid="summary-shares">
          <div className="bl-card-head">
            <Icon name="summarize" size={21} />
            <h2 className="bl-h2">{t.sharing.sharedSummariesTitle}</h2>
          </div>
          <ul className={styles.log}>
            {shares.map((share) => (
              <li key={share.id}>
                <span>
                  <strong>{share.org_name}</strong>
                  {share.counselor_user_id
                    ? t.sharing.counselorNamed
                    : t.sharing.counselorOrg}
                  {t.sharing.separator}
                  {new Date(share.shared_at).toLocaleDateString("ja-JP")}
                  {t.sharing.separator}
                  {t.sharing.reflectionCount(share.reflection_count)}
                </span>
                {share.status === "active" ? (
                  <button
                    type="button"
                    disabled={busyShareId === share.id}
                    onClick={() => revokeShare(share.id)}
                    data-testid={`revoke-share-${share.id}`}
                    className={`bl-btn bl-btn--sm ${styles.stopBtn}`}
                  >
                    <Icon name="lock" size={15} />
                    {busyShareId === share.id ? t.sharing.stopping : t.sharing.stopShare}
                  </button>
                ) : (
                  <span className="bl-chip">{t.sharing.stopped}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {!isLoading && accessLog.length > 0 && (
        <section className="bl-card bl-rise">
          <div className="bl-card-head">
            <Icon name="visibility" size={21} />
            <h2 className="bl-h2">{t.sharing.accessLogTitle}</h2>
          </div>

          <ul className={styles.log}>
            {accessLog.map((record) => (
              <li key={record.id}>
                <span>
                  <strong>{record.org_name}</strong>
                  {t.sharing.accessedByParticle}
                  {VIEW_LABELS[record.view_type] ?? record.view_type}
                </span>
                <time className="bl-micro">
                  {new Date(record.occurred_at).toLocaleString("ja-JP")}
                </time>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
