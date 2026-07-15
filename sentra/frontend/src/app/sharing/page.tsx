"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldCheck, ShieldOff } from "lucide-react";

import { ApiClient } from "@/api/client";
import type { OversightRequest } from "@/api/models";
import { useAuth } from "@/lib/auth";

const panel: React.CSSProperties = {
  backgroundColor: "var(--ivory)",
  border: "1px solid var(--limestone)",
  boxShadow: "0 1px 3px rgba(42,32,24,0.09), 0 6px 24px rgba(42,32,24,0.05)",
};

function statusChip(request: OversightRequest): { label: string; color: string } {
  if (request.roster_status !== "active") return { label: "Request inactive", color: "var(--ink-faint)" };
  if (request.consent_status === "active") return { label: "Sharing derived signals", color: "var(--aegean)" };
  if (request.consent_status === "revoked") return { label: "Sharing stopped", color: "var(--sienna)" };
  return { label: "Awaiting your decision", color: "var(--ochre)" };
}

export default function SharingPage() {
  const { userId } = useAuth();
  const [requests, setRequests] = useState<OversightRequest[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busyOrgId, setBusyOrgId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      setRequests(await ApiClient.listOversightRequests(userId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sharing settings.");
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
      if (grant) {
        await ApiClient.grantOversightConsent(userId, orgId);
      } else {
        await ApiClient.revokeOversightConsent(userId, orgId);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Updating consent failed.");
    } finally {
      setBusyOrgId(null);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <section className="px-8 py-7" style={{ ...panel, backgroundColor: "var(--ivory-warm)" }}>
        <div className="inscription mb-3">You stay in control</div>
        <h1 className="text-3xl font-bold" style={{ color: "var(--ink)" }}>Oversight sharing</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed" style={{ color: "var(--ink-mid)" }}>
          Schools or programs listed here have asked to see your <strong>derived signals only</strong> — state
          bands, trends, and safety flags. Your journal and chat text is never shared, every educator view is
          logged, and you can stop sharing at any time. Nothing is shared until you say yes.
        </p>
        {error ? <p role="alert" className="mt-3 text-sm" style={{ color: "var(--sienna)" }}>{error}</p> : null}
      </section>

      {isLoading ? (
        <div className="flex items-center gap-2 px-2 text-sm" style={{ color: "var(--ink-faint)" }}>
          <Loader2 className="h-4 w-4 animate-spin" />Loading sharing settings…
        </div>
      ) : null}

      {requests && requests.length === 0 && !isLoading ? (
        <section className="px-8 py-10 text-center" style={panel}>
          <p className="text-sm" style={{ color: "var(--ink-mid)" }}>
            No organization has requested oversight access. If your school starts using BLESC, their request
            will appear here for you to approve or decline.
          </p>
        </section>
      ) : null}

      {requests?.map((request) => {
        const chip = statusChip(request);
        const sharing = request.roster_status === "active" && request.consent_status === "active";
        const busy = busyOrgId === request.org_id;
        return (
          <section key={request.org_id} className="flex flex-wrap items-center justify-between gap-4 px-7 py-5" style={panel}>
            <div className="min-w-0">
              <div className="font-semibold" style={{ color: "var(--ink)" }}>{request.org_name}</div>
              <div className="mt-1 flex items-center gap-2 text-xs">
                <span className="rounded-full px-2 py-0.5 font-semibold" style={{ border: `1px solid ${chip.color}`, color: chip.color }}>
                  {chip.label}
                </span>
                {request.granted_at && sharing ? (
                  <span style={{ color: "var(--ink-faint)" }}>since {new Date(request.granted_at).toLocaleDateString()}</span>
                ) : null}
              </div>
            </div>
            {request.roster_status === "active" ? (
              sharing ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConsent(request.org_id, false)}
                  className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-60"
                  style={{ border: "1px solid var(--sienna)", color: "var(--sienna)" }}
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldOff className="h-4 w-4" />}
                  Stop sharing
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConsent(request.org_id, true)}
                  className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-60"
                  style={{ backgroundColor: "var(--gold)", color: "#000" }}
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                  Allow derived signals
                </button>
              )
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
