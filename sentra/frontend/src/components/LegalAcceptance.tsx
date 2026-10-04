"use client";

/**
 * `/legal` の同意欄（#251）。
 *
 * `POST /api/legal/acceptance` は、版と施行日を伴って同意を記録できるように
 * 作られていたが、呼ぶ画面が無かった。施行の決裁が下りた日に「同意を取る
 * 手段が無い」と気付くことになる穴を、ここで塞ぐ。
 *
 * 約束が4つある。
 *
 *   1. **施行の判定を自前で持たない。** 押せるかどうかは、Server Component
 *      が `legalEnactment.ts` の `legalEnacted()` から読んで渡す `enacted` だけで
 *      決まる。この画面が別の根拠で「施行済み」を名乗ると、記録される版と
 *      読んだ書類がずれる。`enacted` は施行日が「到来している」ときだけ true
 *      で、施行日が未来（施行予定）のあいだはボタンを出さない（#282）。
 *      `scheduledDate` は、その理由を表示するためだけに使う。
 *
 *   2. **版はサーバーが決める。** 送るのは文書の種類だけで、版は送らない。
 *      「現在の版に同意済みか」も、GET が返す `current_version` と照らして
 *      判定する。
 *
 *   3. **書類は誰でも読める。** 未ログインでも本文は変わらず読め、同意の
 *      状態の表示だけがログイン後に出る。
 *
 *   4. **研究同意と取り違えさせない。** 押す場所の隣で、毎回そう書く。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { t } from "@/lib/i18n";
import type { LegalAcceptableDocument } from "@/lib/legalEnactment";

const ENDPOINT = "/api/legal/acceptance";

type AcceptanceRow = {
  document_id: string;
  document_version: string;
  effective_date: string | null;
  accepted_at: string;
};

type StatusResponse = {
  enacted: boolean;
  current_version: string;
  effective_date: string | null;
  acceptances: AcceptanceRow[];
};

type LoadState =
  | { kind: "signed_out" }
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; status: StatusResponse };

type ContextValue = {
  enacted: boolean;
  scheduledDate: string | null;
  state: LoadState;
  accessToken: string | null;
  reload: () => Promise<void>;
};

const LegalAcceptanceContext = createContext<ContextValue | null>(null);

function authHeaders(accessToken: string | null): Record<string, string> {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

async function fetchStatus(accessToken: string): Promise<LoadState> {
  try {
    const response = await fetch(ENDPOINT, { headers: authHeaders(accessToken), cache: "no-store" });
    if (!response.ok) return { kind: "failed" };
    return { kind: "ready", status: (await response.json()) as StatusResponse };
  } catch {
    return { kind: "failed" };
  }
}

/**
 * GET を一度だけ読み、文書ごとの欄に配る。`enacted` は Server Component が
 * `legalEnacted()` から読んだ値で、この中では計算しない。
 */
export function LegalAcceptanceProvider({
  enacted,
  scheduledDate = null,
  children,
}: {
  enacted: boolean;
  /** 施行日が決まっていて、まだ来ていないときの施行予定日（#282）。表示専用。 */
  scheduledDate?: string | null;
  children: React.ReactNode;
}) {
  const { session, isLoading } = useAuth();
  const accessToken = session?.access_token ?? null;
  // どのトークンで読んだ結果かを一緒に持つ。ログインし直した直後に、
  // 前のアカウントの同意状態を一瞬でも出さないため。
  const [loaded, setLoaded] = useState<{ token: string; state: LoadState } | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    void fetchStatus(accessToken).then((state) => {
      if (!cancelled) setLoaded({ token: accessToken, state });
    });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  const reload = useCallback(async () => {
    if (!accessToken) return;
    const state = await fetchStatus(accessToken);
    setLoaded({ token: accessToken, state });
  }, [accessToken]);

  const value = useMemo(() => {
    const state: LoadState = isLoading
      ? { kind: "loading" }
      : !accessToken
        ? { kind: "signed_out" }
        : loaded && loaded.token === accessToken
          ? loaded.state
          : { kind: "loading" };
    return { enacted, scheduledDate, state, accessToken, reload };
  }, [enacted, scheduledDate, isLoading, loaded, accessToken, reload]);
  return <LegalAcceptanceContext.Provider value={value}>{children}</LegalAcceptanceContext.Provider>;
}

function formatAcceptedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type SubmitResult = "recorded" | "already_accepted" | "not_enacted" | "not_yet_effective" | "failed";

/** 文書ひとつ分の同意欄。 */
export function LegalAcceptanceControl({ documentId }: { documentId: LegalAcceptableDocument }) {
  const context = useContext(LegalAcceptanceContext);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);

  if (!context) return null;
  const { enacted, scheduledDate, state, accessToken, reload } = context;
  const name = t.legalAcceptance.documentName[documentId];

  const submit = async () => {
    setBusy(true);
    setResult(null);
    let outcome: SubmitResult = "failed";
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(accessToken) },
        body: JSON.stringify({ document_id: documentId }),
      });
      const body = (await response.json().catch(() => ({}))) as { status?: unknown; code?: unknown };
      if (response.ok && body.status === "recorded") outcome = "recorded";
      else if (response.ok && body.status === "already_accepted") outcome = "already_accepted";
      else if (response.status === 409 && body.code === "not_enacted") outcome = "not_enacted";
      else if (response.status === 409 && body.code === "not_yet_effective") outcome = "not_yet_effective";
    } catch {
      outcome = "failed";
    }
    setBusy(false);
    setResult(outcome);
    if (outcome === "recorded" || outcome === "already_accepted") await reload();
  };

  let status: React.ReactNode = null;
  let canAccept = false;
  if (!enacted) {
    status = (
      <p className="bl-body">
        {scheduledDate ? t.legalAcceptance.notYetEffective(scheduledDate) : t.legalAcceptance.notEnacted}
      </p>
    );
  } else if (state.kind === "signed_out") {
    status = <p className="bl-meta">{t.legalAcceptance.signInToSeeStatus}</p>;
  } else if (state.kind === "loading") {
    status = <p className="bl-meta" aria-busy="true">{t.legalAcceptance.loadingStatus}</p>;
  } else if (state.kind === "failed") {
    status = <p className="bl-meta">{t.legalAcceptance.loadFailed}</p>;
  } else {
    const rows = state.status.acceptances.filter((row) => row.document_id === documentId);
    const current = rows.find((row) => row.document_version === state.status.current_version);
    if (current) {
      status = <p className="bl-body">{t.legalAcceptance.accepted(formatAcceptedAt(current.accepted_at))}</p>;
    } else {
      status = (
        <p className="bl-body">
          {rows.length > 0 ? t.legalAcceptance.acceptedEarlierVersion : t.legalAcceptance.notYetAccepted}
        </p>
      );
      canAccept = true;
    }
  }

  const message: Record<SubmitResult, string> = {
    recorded: t.legalAcceptance.recorded,
    already_accepted: t.legalAcceptance.alreadyAccepted,
    not_enacted: t.legalAcceptance.rejectedNotEnacted,
    not_yet_effective: t.legalAcceptance.rejectedNotYetEffective,
    failed: t.legalAcceptance.submitFailed,
  };

  return (
    <section className="bl-card bl-stack" aria-label={t.legalAcceptance.heading} style={{ gap: 10 }}>
      <h3 className="bl-h3">{t.legalAcceptance.heading}</h3>
      {status}
      {canAccept ? (
        <button type="button" className="bl-btn bl-btn--primary" onClick={submit} disabled={busy}>
          {busy ? t.legalAcceptance.submitting : t.legalAcceptance.acceptButton(name)}
        </button>
      ) : null}
      <p className="bl-meta" role="note">{t.legalAcceptance.notResearchConsent}</p>
      {result ? <p className="bl-meta" role="status">{message[result]}</p> : null}
    </section>
  );
}
