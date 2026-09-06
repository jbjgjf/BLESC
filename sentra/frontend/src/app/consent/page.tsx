"use client";

/**
 * 研究利用への同意（#134）。
 *
 * この画面ができるまで、同意は「既定でオン」だった。日記画面は consent を
 * 一度も送らず、サーバー側の既定値が `research_analysis: true` だったので、
 * 一度も説明を読んでいない生徒の記録が研究データとして蓄積され、しかも
 * `consent_records` には「同意した」という行が残っていた。
 *
 * ここでの原則:
 *   - 説明を読んでからでないとチェックできない。
 *   - 項目ごとに別々のチェック。まとめて「同意する」ボタンは置かない。
 *   - 本人の同意と保護者の同意は別の欄。片方だけでは研究利用に進めない。
 *   - いつでも撤回でき、撤回すると保存済みの本文はその場で削除される。
 */

import { useCallback, useEffect, useState } from "react";
import { ApiClient } from "@/api/client";
import { Icon } from "@/components/ui/Icon";
import { useAuth } from "@/lib/auth";
import { useDemoMode } from "@/lib/demo";
import { CONSENT_DOCUMENT_VERSION, NO_CONSENT, researchUseAllowed, type ConsentState } from "@/lib/consent";
import styles from "./consent.module.css";

type GrantKey =
  | "research_analysis"
  | "raw_text_retention"
  | "anonymized_export"
  | "future_fine_tuning";

const GRANTS: Array<{ key: GrantKey; label: string; detail: string }> = [
  {
    key: "research_analysis",
    label: "書いた内容を研究の分析に使うことに同意します",
    detail:
      "日記から取り出した要素（出来事・気持ち・そのつながり）を、研究の分析対象にします。同意しなくても、アプリは今までどおり使えます。",
  },
  {
    key: "raw_text_retention",
    label: "日記の本文を、一定期間そのまま保管することに同意します",
    detail:
      "AIの読み取りが合っているかを人が確かめるために、本文を暗号化して保管します。先生は読めません。保管期間を過ぎたら自動で消えます。",
  },
  {
    key: "anonymized_export",
    label: "個人が分からない形にしたデータを、研究成果として外部に出すことに同意します",
    detail: "名前・学校名など、あなたが特定できる情報を取り除いたうえで集計します。",
  },
  {
    key: "future_fine_tuning",
    label: "将来のモデルの学習に使うことに同意します",
    detail: "今回の研究とは別に、今後のAIの改善に使う場合があります。ここだけ同意しないこともできます。",
  },
];

export default function ConsentPage() {
  const { userId } = useAuth();
  const demo = useDemoMode();

  const [stored, setStored] = useState<ConsentState>(NO_CONSENT);
  const [checked, setChecked] = useState<Record<GrantKey, boolean>>({
    research_analysis: false,
    raw_text_retention: false,
    anonymized_export: false,
    future_fine_tuning: false,
  });
  const [assent, setAssent] = useState(false);
  const [guardian, setGuardian] = useState(false);
  const [readDocument, setReadDocument] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (demo) return;
    const current = await ApiClient.getConsent(userId);
    setStored(current);
    setChecked({
      research_analysis: current.research_analysis,
      raw_text_retention: current.raw_text_retention,
      anonymized_export: current.anonymized_export,
      future_fine_tuning: current.future_fine_tuning,
    });
    setAssent(current.minor_assent);
    setGuardian(current.guardian_consent);
  }, [demo, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const active = researchUseAllowed(stored);

  // 研究利用に同意するなら、本人と保護者の両方が要る。サーバー側でも同じ
  // 条件で弾くが、押せてしまうボタンを置かないほうが分かりやすい。
  const canSubmit =
    readDocument && (!checked.research_analysis || (assent && guardian)) && !busy;

  const save = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await ApiClient.grantConsent(userId, {
        app_use: true,
        research_analysis: checked.research_analysis,
        raw_text_retention: checked.raw_text_retention,
        anonymized_export: checked.anonymized_export,
        future_fine_tuning: checked.future_fine_tuning,
        minor_assent: assent,
        guardian_consent: guardian,
        document_version: CONSENT_DOCUMENT_VERSION,
      });
      setStored(next);
      setMessage("同意の内容を記録しました。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "同意を記録できませんでした。");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await ApiClient.revokeConsent(userId);
      setStored(next);
      setChecked({
        research_analysis: false,
        raw_text_retention: false,
        anonymized_export: false,
        future_fine_tuning: false,
      });
      setAssent(false);
      setGuardian(false);
      setMessage("同意を撤回しました。保管していた日記の本文は削除されました。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "同意を撤回できませんでした。");
    } finally {
      setBusy(false);
    }
  };

  if (demo) {
    return (
      <div className="bl-wrap bl-stack">
        <h1 className="bl-h1">研究への協力について</h1>
        <p className="bl-body">デモモードでは同意の記録は行いません。</p>
      </div>
    );
  }

  return (
    <div className="bl-wrap bl-stack">
      <header>
        <h1 className="bl-h1">研究への協力について</h1>
        <p className="bl-meta">説明文書 {CONSENT_DOCUMENT_VERSION}</p>
      </header>

      <section className="bl-card bl-stack">
        <h2 className="bl-h3">何のための研究か</h2>
        <p className="bl-body">
          この研究は、日々の記録から気持ちの変化のパターンを読み取る方法を確かめるものです。
          協力するかどうかは自由で、断っても、あとから撤回しても、アプリの使い方や学校での扱いは
          いっさい変わりません。
        </p>
        <h2 className="bl-h3">預かるもの</h2>
        <p className="bl-body">
          日記から取り出した要素と、その日の記入にかかった時間などの記録です。
          本文そのものは、下の「本文の保管」に同意した場合にかぎり、暗号化して一定期間だけ預かります。
          先生が本文を読むことはありません。
        </p>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={readDocument}
            onChange={(event) => setReadDocument(event.target.checked)}
          />
          <span>上の説明を読みました。</span>
        </label>
      </section>

      <section className="bl-card bl-stack">
        <h2 className="bl-h3">同意する項目を選ぶ</h2>
        <p className="bl-meta">ひとつずつ選べます。選ばなかった項目には同意していない扱いになります。</p>
        {GRANTS.map((grant) => (
          <label key={grant.key} className={styles.check}>
            <input
              type="checkbox"
              checked={checked[grant.key]}
              disabled={!readDocument}
              onChange={(event) =>
                setChecked((current) => ({ ...current, [grant.key]: event.target.checked }))
              }
            />
            <span>
              <strong>{grant.label}</strong>
              <span className="bl-meta">{grant.detail}</span>
            </span>
          </label>
        ))}
      </section>

      <section className="bl-card bl-stack">
        <h2 className="bl-h3">同意する人</h2>
        <p className="bl-meta">
          研究利用には、本人の同意と保護者の同意の両方が必要です。どちらか一方だけでは記録できません。
        </p>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={assent}
            disabled={!readDocument}
            onChange={(event) => setAssent(event.target.checked)}
          />
          <span>本人が同意します。</span>
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={guardian}
            disabled={!readDocument}
            onChange={(event) => setGuardian(event.target.checked)}
          />
          <span>保護者が同意しました。</span>
        </label>
      </section>

      {error && (
        <p role="alert" className={styles.error}>
          <Icon name="error" size={16} fill />
          {error}
        </p>
      )}
      {message && <p className="bl-body">{message}</p>}

      <div className="bl-row" style={{ gap: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          className="bl-btn bl-btn--primary"
          disabled={!canSubmit}
          onClick={() => void save()}
        >
          <Icon name="check" size={18} />
          この内容で記録する
        </button>
        <button
          type="button"
          className="bl-btn bl-btn--ghost"
          disabled={busy || stored.status === "revoked"}
          onClick={() => void revoke()}
        >
          同意を撤回する
        </button>
      </div>

      <p className="bl-meta">
        現在の状態: {active ? "研究利用に同意済み" : "研究利用には同意していません"}
        {stored.granted_at ? `（記録日時 ${new Date(stored.granted_at).toLocaleString("ja-JP")}）` : ""}
        {stored.revoked_at ? `／撤回日時 ${new Date(stored.revoked_at).toLocaleString("ja-JP")}` : ""}
      </p>
    </div>
  );
}
