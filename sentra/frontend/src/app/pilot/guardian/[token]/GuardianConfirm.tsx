"use client";

/**
 * 保護者の方が実際に答える画面（#164）。
 *
 * 表示内容は Server Component が読んで渡す。ここが行う通信は「答えを送る」
 * 一度だけで、その答えはサーバー側で単一使用のトークンと引き換えに記録される。
 *
 * 設計上の約束が3つある。
 *
 *   1. **同意と不同意を同じ大きさで並べる。** 「同意しない」が小さい・薄い・
 *      下にある、という配置はそれ自体が圧力になる。押したあとに引き止める
 *      文言も、理由を尋ねる欄も出さない。
 *
 *   2. **お子さまの氏名も、書いた内容も出さない。** 出すのは研究名と参加者ID
 *      （仮名）だけ。リンクが転送されている可能性がある以上、この画面が身元を
 *      明かしてはいけない。
 *
 *   3. **答えは一度だけ。** 二度目に開いた場合は「回答済みです」と表示する。
 */

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import type { GuardianVerificationStatus } from "@/lib/guardianVerification";

export type GuardianContext = {
  status: GuardianVerificationStatus;
  research_code: string | null;
  study_title: string | null;
  document_version: string | null;
  baseline_days: number | null;
  observation_days: number | null;
  optional_grants: readonly string[];
  expires_at: string | null;
};

const OPTIONAL_LABELS: Record<string, string> = {
  raw_text_retention: "日記の本文を、暗号化したうえで一定期間保管する",
  anonymized_export: "個人が特定できない形にしたデータを、研究チーム外と共有する",
  future_fine_tuning: "将来のモデル学習に利用する",
};

export function GuardianConfirm({
  token,
  context,
  error: initialError,
}: {
  token: string;
  context: GuardianContext | null;
  error: string | null;
}) {
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState<"confirmed" | "declined" | null>(
    context?.status === "confirmed" || context?.status === "declined" ? context.status : null,
  );

  const answer = async (decision: "confirmed" | "declined") => {
    setBusy(true);
    setError(null);
    const response = await fetch("/api/pilot/guardian/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, decision }),
    });
    const body = await response.json().catch(() => ({}));
    setBusy(false);

    if (!response.ok) {
      setError(typeof body.detail === "string" ? body.detail : "回答を記録できませんでした。");
      return;
    }
    setAnswered(body.decision === "declined" ? "declined" : "confirmed");
  };

  if (error || !context) {
    return (
      <main className="bl-wrap bl-stack">
        <h1 className="bl-h1">確認用リンク</h1>
        <p className="bl-notice">{error ?? "この確認用リンクは使用できません。"}</p>
        <p className="bl-meta">
          お手数ですが、お子さまに新しいリンクの発行をお伝えください。ご不明な点は、学校から配布された
          説明文書に記載の研究担当までご連絡ください。
        </p>
      </main>
    );
  }

  if (context.status === "expired") {
    return (
      <main className="bl-wrap bl-stack">
        <h1 className="bl-h1">確認用リンク</h1>
        <p className="bl-notice">このリンクは有効期限が切れています。</p>
        <p className="bl-meta">お子さまに新しいリンクの発行をお伝えください。</p>
      </main>
    );
  }

  if (answered) {
    return (
      <main className="bl-wrap bl-stack">
        <h1 className="bl-h1">{answered === "confirmed" ? "確認が完了しました" : "回答を受け付けました"}</h1>
        <p>
          {answered === "confirmed"
            ? "ご確認ありがとうございました。この画面は閉じていただいて構いません。"
            : "同意されない旨を記録しました。お子さまの研究への参加は始まりません。この画面は閉じていただいて構いません。"}
        </p>
        <p className="bl-meta">
          {answered === "confirmed"
            ? "参加の取りやめは、研究期間中いつでもお申し出いただけます。"
            : "学校での活動や成績に影響することはありません。"}
        </p>
      </main>
    );
  }

  return (
    <main className="bl-wrap bl-stack">
      <header className="bl-stack" style={{ gap: 6 }}>
        <p className="bl-eyebrow">保護者の方へ</p>
        <h1 className="bl-h1">研究参加へのご確認</h1>
        <p className="bl-meta">
          {context.study_title ?? "研究"}
          {context.research_code ? `・参加者ID ${context.research_code}` : null}
        </p>
      </header>

      <section className="bl-card bl-stack">
        <h2 className="bl-h2">お願いしていること</h2>
        <p>
          お子さまご本人は、この研究への参加に同意されています。保護者の方のご確認をもって、参加の登録が
          完了します。
        </p>
        {context.baseline_days && context.observation_days ? (
          <p className="bl-meta">
            期間は{context.baseline_days + context.observation_days}日間です。毎日5分ほど、その日の出来事を
            記録していただきます。研究期間中はAIの応答機能を停止しており、書かれた内容が外部のサービスに
            送られることはありません。
          </p>
        ) : null}

        <h3 className="bl-h3">お子さまが選択された任意の項目</h3>
        {context.optional_grants.length === 0 ? (
          <p className="bl-meta">任意の項目は選択されていません。</p>
        ) : (
          <ul className="bl-stack" style={{ gap: 6 }}>
            {context.optional_grants.map((key) => (
              <li key={key}>{OPTIONAL_LABELS[key] ?? key}</li>
            ))}
          </ul>
        )}

        <p className="bl-micro">
          説明文書のバージョン: {context.document_version ?? "—"}
          {context.expires_at
            ? `／このリンクの有効期限: ${new Date(context.expires_at).toLocaleString("ja-JP")}`
            : null}
        </p>
      </section>

      <section className="bl-card bl-stack">
        <h2 className="bl-h2">ご回答</h2>
        <p className="bl-meta">
          どちらを選ばれても、学校での活動や成績に影響することはありません。判断に迷われる場合は、
          回答せずに研究担当へご連絡ください。
        </p>
        <div className="bl-row" style={{ gap: 10, flexWrap: "wrap" }}>
          <button type="button" className="bl-btn bl-btn--primary" disabled={busy} onClick={() => answer("confirmed")}>
            参加に同意します
          </button>
          <button type="button" className="bl-btn bl-btn--secondary" disabled={busy} onClick={() => answer("declined")}>
            参加に同意しません
          </button>
        </div>
      </section>

      <p className="bl-disclaimer">
        <Icon name="medical_information" size={15} />
        blescは医療的な診断を行いません。
      </p>
    </main>
  );
}
