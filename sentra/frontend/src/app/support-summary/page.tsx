"use client";

import { useState } from "react";
import { ApiClient } from "@/api/client";
import type { CounselorSupportSummary } from "@/api/models";
import { useAuth } from "@/lib/auth";
import { counselorSummaryToText } from "@/lib/counselor-summary";
import { Icon } from "@/components/ui/Icon";
import styles from "./summary.module.css";

export default function SupportSummaryPage() {
  const { userId } = useAuth();
  const [summary, setSummary] = useState<CounselorSupportSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const generate = async () => {
    setIsLoading(true);
    setError(null);
    setCopied(false);
    try {
      setSummary(await ApiClient.generateCounselorSummary(userId, 10));
    } catch (err) {
      setError(err instanceof Error ? err.message : "まとめの作成に失敗しました。");
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
      if (succeeded) setCopied(true);
      else setError("コピーできませんでした。「テキストで保存」をお使いください。");
    }
  };

  const download = () => {
    if (!summary) return;
    const url = URL.createObjectURL(
      new Blob([counselorSummaryToText(summary)], { type: "text/plain;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `blesc-support-summary-${summary.date_range.to?.slice(0, 10) ?? "empty"}.txt`;
    anchor.click();
    // Defer revocation: revoking synchronously can abort the download in Safari.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const range =
    summary?.date_range.from && summary.date_range.to
      ? `${new Date(summary.date_range.from).toLocaleDateString("ja-JP")} 〜 ${new Date(summary.date_range.to).toLocaleDateString("ja-JP")}`
      : "記録の期間が取得できません";

  return (
    <div className="bl-wrap bl-stack">
      <header style={{ padding: "2px 2px 0" }}>
        <h1 className="bl-h1">支援サマリー</h1>
        <p className="bl-meta" style={{ marginTop: 3 }}>
          共有するかどうかは、あなたが決めます。
        </p>
      </header>

      <section className={`${styles.intro} bl-rise`}>
        <Icon name="summarize" size={24} />
        <div style={{ flex: 1 }}>
          <h2 className="bl-h3">相談のときに使えるまとめを作れます</h2>
          <p className="bl-body" style={{ marginTop: 5 }}>
            最近の日記の構造化された項目から、短いまとめを作ります。日記の本文は含まれません。
            作っただけでは誰にも共有されません。内容を確認してから、渡すかどうかを決めてください。
          </p>
          <button
            type="button"
            onClick={generate}
            disabled={isLoading}
            className="bl-btn bl-btn--primary"
            style={{ marginTop: 16 }}
          >
            {isLoading && <span className={styles.spinner} aria-hidden="true" />}
            {summary ? "作り直す" : "まとめを作る"}
          </button>
        </div>
      </section>

      {error && (
        <div className="bl-notice bl-notice--alert" role="alert">
          <Icon name="error" size={19} fill />
          <span>{error}</span>
        </div>
      )}

      {summary && (
        <section className="bl-card bl-card--flush bl-rise">
          <header className={styles.head}>
            <div>
              <span className="bl-eyebrow">共有する前に確認してください</span>
              <div className="bl-h3" style={{ marginTop: 4 }}>{range}</div>
              <div className="bl-micro" style={{ marginTop: 2 }}>{summary.reflection_count}件の記録から作成</div>
            </div>
            <div className="bl-row" style={{ gap: 8 }}>
              <button type="button" onClick={copy} className="bl-btn bl-btn--secondary bl-btn--sm">
                <Icon name={copied ? "check_circle" : "description"} size={16} fill={copied} />
                {copied ? "コピーしました" : "コピー"}
              </button>
              <button type="button" onClick={download} className="bl-btn bl-btn--secondary bl-btn--sm">
                <Icon name="description" size={16} />
                テキストで保存
              </button>
            </div>
          </header>

          {summary.safety_flags.length > 0 && (
            <div role="alert" className={styles.flags}>
              <div className="bl-row" style={{ gap: 8, marginBottom: 7 }}>
                <Icon name="shield" size={19} fill />
                <span className="bl-h3">この期間に記録された安全に関する項目</span>
              </div>
              {summary.safety_flags.map((flag) => (
                <p key={`${flag.event_id}-${flag.timestamp}`} className="bl-body" style={{ fontSize: "0.86rem" }}>
                  {new Date(flag.timestamp).toLocaleDateString("ja-JP")} ・ {flag.level} ・{" "}
                  {flag.reasons.join("、") || "記録あり"}
                </p>
              ))}
            </div>
          )}

          <div className={styles.sections}>
            {summary.sections.map((section) => (
              <article key={section.key} className={styles.section}>
                <h2 className="bl-h3">{section.title}</h2>
                {section.items.length ? (
                  <ul className={styles.items}>
                    {section.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.empty}>該当する記録はありません。</p>
                )}
              </article>
            ))}
          </div>

          <p className={styles.limits}>{summary.limitations}</p>
        </section>
      )}
    </div>
  );
}
