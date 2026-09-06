"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Copy, Download, Loader2, Send, ShieldAlert } from "lucide-react";

import { ApiClient } from "@/api/client";
import type { CounselorSupportSummary, OrgCounselor, OversightRequest } from "@/api/models";
import { useAuth } from "@/lib/auth";
import { counselorSummaryToText } from "@/lib/counselor-summary";
import { t } from "@/lib/i18n";

const panel: React.CSSProperties = {
  backgroundColor: "var(--ivory)",
  border: "1px solid var(--limestone)",
};

export default function SupportSummaryPage() {
  const { userId } = useAuth();
  const [summary, setSummary] = useState<CounselorSupportSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [orgs, setOrgs] = useState<OversightRequest[]>([]);
  const [counselors, setCounselors] = useState<OrgCounselor[]>([]);
  const [shareOrgId, setShareOrgId] = useState("");
  const [shareCounselorId, setShareCounselorId] = useState("");
  const [isSharing, setIsSharing] = useState(false);
  const [shared, setShared] = useState(false);

  useEffect(() => {
    let cancelled = false;
    ApiClient.listOversightRequests(userId)
      .then((requests) => {
        if (cancelled) return;
        const active = requests.filter((request) => request.roster_status === "active");
        setOrgs(active);
        if (active.length === 1) setShareOrgId(active[0].org_id);
      })
      .catch(() => undefined); // sharing picker is optional; preview still works
    return () => { cancelled = true; };
  }, [userId]);

  useEffect(() => {
    if (!shareOrgId) { setCounselors([]); return; }
    let cancelled = false;
    ApiClient.listOrgCounselors(shareOrgId)
      .then((next) => { if (!cancelled) setCounselors(next); })
      .catch(() => { if (!cancelled) setCounselors([]); });
    return () => { cancelled = true; };
  }, [shareOrgId]);

  const share = async () => {
    if (!summary || !shareOrgId) return;
    setIsSharing(true);
    setError(null);
    try {
      await ApiClient.shareSupportSummary(userId, summary, shareOrgId, shareCounselorId || null);
      setShared(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.supportSummary.shareFailed);
    } finally {
      setIsSharing(false);
    }
  };

  const generate = async () => {
    setIsLoading(true);
    setError(null);
    setCopied(false);
    setShared(false);
    try {
      setSummary(await ApiClient.generateCounselorSummary(userId, 10));
    } catch (err) {
      setError(err instanceof Error ? err.message : t.supportSummary.generateFailed);
    } finally {
      setIsLoading(false);
    }
  };

  const copy = async () => {
    if (!summary) return;
    const text = counselorSummaryToText(summary);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard API can reject (permission denied, non-secure context); fall back to a hidden textarea.
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const succeeded = document.execCommand("copy");
      textarea.remove();
      if (succeeded) {
        setCopied(true);
      } else {
        setError(t.supportSummary.copyFailed);
      }
    }
  };

  const download = () => {
    if (!summary) return;
    const url = URL.createObjectURL(new Blob([counselorSummaryToText(summary)], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `blesc-support-summary-${summary.date_range.to?.slice(0, 10) ?? "empty"}.txt`;
    anchor.click();
    // Defer revocation: revoking synchronously can abort the download in Safari.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const range = summary?.date_range.from && summary.date_range.to
    ? `${new Date(summary.date_range.from).toLocaleDateString("ja-JP")} – ${new Date(summary.date_range.to).toLocaleDateString("ja-JP")}`
    : t.supportSummary.noDateRange;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <section className="px-8 py-7" style={{ ...panel, backgroundColor: "var(--ivory-warm)" }}>
        <div className="inscription mb-3">{t.supportSummary.eyebrow}</div>
        <h1 className="text-3xl font-bold" style={{ color: "var(--ink)" }}>{t.supportSummary.title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed" style={{ color: "var(--ink-mid)" }}>
          {t.supportSummary.intro}
        </p>
        <button
          type="button"
          onClick={generate}
          disabled={isLoading}
          data-testid="generate-summary"
          className="mt-5 inline-flex items-center gap-2 rounded-full px-5 py-2.5 font-semibold disabled:opacity-60"
          style={{ backgroundColor: "var(--blue-base)", color: "var(--ink)" }}
        >
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {summary ? t.supportSummary.regenerate : t.supportSummary.generate}
        </button>
        {error ? <p role="alert" className="mt-3 text-sm" style={{ color: "var(--sienna)" }}>{error}</p> : null}
      </section>

      {summary ? (
        <section style={panel}>
          <header className="flex flex-wrap items-start justify-between gap-4 px-7 py-5" style={{ borderBottom: "1px solid var(--limestone)" }}>
            <div>
              <div className="inscription mb-2">{t.supportSummary.previewTitle}</div>
              <div className="font-semibold" style={{ color: "var(--ink)" }}>{range}</div>
              <div className="mt-1 text-xs" style={{ color: "var(--ink-faint)" }}>{t.supportSummary.entryCount(summary.reflection_count)}</div>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={copy} data-testid="copy-summary" className="inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm" style={{ border: "1px solid var(--limestone)" }}>
                {copied ? <CheckCircle2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{copied ? t.supportSummary.copied : t.supportSummary.copy}
              </button>
              <button type="button" onClick={download} data-testid="download-summary" className="inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm" style={{ border: "1px solid var(--limestone)" }}>
                <Download className="h-4 w-4" />{t.supportSummary.download}
              </button>
            </div>
          </header>

          {summary.safety_flags.length ? (
            <div role="alert" className="px-7 py-5" style={{ borderBottom: "1px solid var(--terracotta)", backgroundColor: "rgba(244,63,94,0.08)" }}>
              <div className="mb-2 flex items-center gap-2 font-semibold" style={{ color: "var(--sienna)" }}><ShieldAlert className="h-5 w-5" />{t.supportSummary.safetyFlags}</div>
              {summary.safety_flags.map((flag) => (
                <p key={`${flag.event_id}-${flag.timestamp}`} className="text-sm" style={{ color: "var(--ink-mid)" }}>
                  {new Date(flag.timestamp).toLocaleDateString("ja-JP")} · {t.safety.level[flag.level] ?? flag.level}
                  {" · "}
                  {flag.reasons.map((reason) => t.safety.reason[reason] ?? reason).join("、") || t.safety.flagRecorded}
                </p>
              ))}
            </div>
          ) : null}

          <div className="grid gap-0 md:grid-cols-2">
            {summary.sections.map((section) => (
              <article key={section.key} className="px-7 py-5" style={{ borderBottom: "1px solid var(--limestone)" }}>
                <h2 className="mb-2 font-semibold" style={{ color: "var(--ink)" }}>{section.title}</h2>
                {section.items.length ? <ul className="list-disc space-y-1 pl-5 text-sm" style={{ color: "var(--ink-mid)" }}>{section.items.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="text-sm italic" style={{ color: "var(--ink-faint)" }}>{t.supportSummary.noStructuredData}</p>}
              </article>
            ))}
          </div>
          <p className="px-7 py-5 text-xs leading-relaxed" style={{ color: "var(--ink-faint)" }}>{summary.limitations}</p>

          {orgs.length ? (
            <div className="px-7 py-5" style={{ borderTop: "1px solid var(--limestone)", backgroundColor: "var(--ivory-warm)" }}>
              <div className="inscription mb-2">{t.supportSummary.shareTitle}</div>
              <p className="mb-3 text-xs leading-relaxed" style={{ color: "var(--ink-mid)" }}>
                {t.supportSummary.shareIntro}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={shareOrgId}
                  onChange={(event) => { setShareOrgId(event.target.value); setShareCounselorId(""); setShared(false); }}
                  data-testid="share-org-select"
                  aria-label={t.supportSummary.orgLabel}
                  className="rounded-md px-3 py-2 text-sm"
                  style={{ border: "1px solid var(--limestone)", backgroundColor: "var(--ivory)", color: "var(--ink)" }}
                >
                  <option value="">{t.supportSummary.orgPlaceholder}</option>
                  {orgs.map((org) => <option key={org.org_id} value={org.org_id}>{org.org_name}</option>)}
                </select>
                <select
                  value={shareCounselorId}
                  onChange={(event) => { setShareCounselorId(event.target.value); setShared(false); }}
                  data-testid="share-counselor-select"
                  aria-label={t.supportSummary.counselorLabel}
                  disabled={!shareOrgId}
                  className="rounded-md px-3 py-2 text-sm disabled:opacity-50"
                  style={{ border: "1px solid var(--limestone)", backgroundColor: "var(--ivory)", color: "var(--ink)" }}
                >
                  <option value="">{t.supportSummary.counselorAll}</option>
                  {counselors.map((counselor) => (
                    <option key={counselor.counselor_user_id} value={counselor.counselor_user_id}>{counselor.display_label}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={share}
                  disabled={!shareOrgId || isSharing || shared}
                  data-testid="share-summary-submit"
                  className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-60"
                  style={{ backgroundColor: "var(--gold)", color: "#000" }}
                >
                  {isSharing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  {shared ? t.supportSummary.shareDone : t.supportSummary.share}
                </button>
                {shared ? (
                  <span data-testid="share-confirmation" className="inline-flex items-center gap-1 text-sm font-semibold" style={{ color: "var(--aegean)" }}>
                    <CheckCircle2 className="h-4 w-4" />{t.supportSummary.shareConfirmation}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
