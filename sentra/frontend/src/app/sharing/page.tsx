"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiClient } from "@/api/client";
import type { OversightRequest, StudentAccessRecord } from "@/api/models";
import { useAuth } from "@/lib/auth";
import { Icon } from "@/components/ui/Icon";
import styles from "./sharing.module.css";

const VIEW_LABELS: Record<string, string> = {
  roster: "一覧であなたの状態を確認しました",
  alerts: "あなたを含むアラートを確認しました",
  student_overview: "あなたの詳細画面を開きました",
  alert_ack: "あなたに関するアラートを確認済みにしました",
};

/** 共有されない情報 — 生徒が一目で分かるように明示する。 */
const NOT_SHARED = [
  "日記の本文",
  "対話型AIとのやりとりの内容",
  "あなたが「話したくない」を選んだ内容",
];

function statusChip(request: OversightRequest): { label: string; className: string } {
  if (request.roster_status !== "active") return { label: "申請は無効です", className: "" };
  if (request.consent_status === "active") return { label: "共有中", className: "bl-chip--calm" };
  if (request.consent_status === "revoked") return { label: "共有を停止しました", className: "bl-chip--alert" };
  return { label: "あなたの判断待ち", className: "bl-chip--watch" };
}

export default function SharingPage() {
  const { userId } = useAuth();
  const [requests, setRequests] = useState<OversightRequest[] | null>(null);
  const [accessLog, setAccessLog] = useState<StudentAccessRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busyOrgId, setBusyOrgId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [nextRequests, nextAccessLog] = await Promise.all([
        ApiClient.listOversightRequests(userId),
        ApiClient.listEducatorAccess(userId),
      ]);
      setRequests(nextRequests);
      setAccessLog(nextAccessLog);
    } catch (err) {
      setError(err instanceof Error ? err.message : "共有設定の読み込みに失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const setConsent = async (orgId: string, grant: boolean) => {
    setBusyOrgId(orgId);
    setError(null);
    try {
      if (grant) await ApiClient.grantOversightConsent(userId, orgId);
      else await ApiClient.revokeOversightConsent(userId, orgId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "共有設定の更新に失敗しました。");
    } finally {
      setBusyOrgId(null);
    }
  };

  return (
    <div className="bl-wrap bl-stack">
      <header style={{ padding: "2px 2px 0" }}>
        <h1 className="bl-h1">共有の設定</h1>
        <p className="bl-meta" style={{ marginTop: 3 }}>
          決めるのはあなたです。あなたが「はい」と言うまで、何も共有されません。
        </p>
      </header>

      <section className={`${styles.intro} bl-rise`}>
        <Icon name="shield" size={24} />
        <div>
          <h2 className="bl-h3">共有されるのは、状態のまとめだけです</h2>
          <p className="bl-body" style={{ marginTop: 5 }}>
            ここに表示される学校や団体は、あなたの<strong>状態のまとめ</strong>（状態の区分・傾向・安全に関する記録）
            を見ることを申請しています。閲覧はすべて記録され、下の一覧で確認できます。共有はいつでも止められます。
          </p>
          <ul className={styles.notShared}>
            {NOT_SHARED.map((item) => (
              <li key={item}>
                <Icon name="lock" size={15} />
                {item}は共有されません
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
          <span className="bl-meta">共有設定を読み込んでいます…</span>
        </div>
      )}

      {requests && requests.length === 0 && !isLoading && (
        <div className="bl-card bl-empty">
          <Icon name="shield" size={40} />
          <p className="bl-body">
            いまのところ、共有を申請している学校・団体はありません。
            <br />
            学校がblescを使いはじめると、ここに申請が表示されます。
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
                    {new Date(request.granted_at).toLocaleDateString("ja-JP")}から
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
                  className={`bl-btn ${styles.stopBtn}`}
                >
                  <Icon name="lock" size={17} />
                  共有を止める
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConsent(request.org_id, true)}
                  className="bl-btn bl-btn--primary"
                >
                  <Icon name="check" size={18} />
                  共有を許可する
                </button>
              ))}
          </section>
        );
      })}

      {!isLoading && accessLog.length > 0 && (
        <section className="bl-card bl-rise">
          <div className="bl-card-head">
            <Icon name="visibility" size={21} />
            <h2 className="bl-h2">だれが見たか</h2>
          </div>

          <ul className={styles.log}>
            {accessLog.map((record) => (
              <li key={record.id}>
                <span>
                  <strong>{record.org_name}</strong>が{VIEW_LABELS[record.view_type] ?? record.view_type}
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
