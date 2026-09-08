"use client";

/**
 * 研究への参加導線（#164）。
 *
 * 招待コード → 説明の確認 → 本人の同意 → （未成年なら）保護者の確認 → 参加登録。
 * この画面は順番を「案内」するだけで、強制しているのはサーバー側の状態機械
 * (`advance_pilot_enrollment`) と、収集画面の前に立つ `journal/layout.tsx`。
 * ここで表示を飛ばしても、次の状態には進めない。
 *
 * 画面の設計方針が3つある。
 *
 *   1. **断ることが同意と同じ重さで置かれている。** 「同意しない」は小さな
 *      文字のリンクではなく、同じ大きさのボタン。断ったあとに引き止める文言や
 *      再確認のダイアログは出さない。
 *
 *   2. **待ち状態はエラーではない。** 保護者の確認待ちは正常な一段階なので、
 *      赤い枠にも警告アイコンにもしない。
 *
 *   3. **保護者の確認は、この画面からは絶対に完了しない。** 生徒の端末で
 *      「保護者が同意しました」を押せる導線は存在しない。ここでできるのは
 *      確認用リンクを発行して渡すことだけで、答えるのは別の端末。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { ApiClient, type GuardianStatusResponse, type PilotEnrollmentSummary } from "@/api/client";
import { Icon } from "@/components/ui/Icon";
import { GUARDIAN_STATUS_MESSAGE } from "@/lib/guardianVerification";
import { enrollmentProgress } from "@/lib/pilotEnrollment";

/** 説明文書で個別に選べる項目。研究解析そのものは選択制ではない。 */
const OPTIONAL_GRANTS = [
  {
    key: "raw_text_retention" as const,
    label: "日記の本文を、暗号化したうえで一定期間保管することに同意する",
    detail: "抽出の正確さを人の目で確かめるために使います。期限が来ると自動的に消去されます。",
  },
  {
    key: "anonymized_export" as const,
    label: "個人が特定できない形にしたデータを、研究チーム外と共有することに同意する",
    detail: "氏名・学校名・連絡先は含まれません。",
  },
  {
    key: "future_fine_tuning" as const,
    label: "将来のモデル学習に利用することに同意する",
    detail: "同意しなくても、研究への参加内容は変わりません。",
  },
];

export default function PilotJoinPage() {
  const { userId, user, isLoading } = useAuth();

  const [enrollment, setEnrollment] = useState<PilotEnrollmentSummary | null>(null);
  const [guardian, setGuardian] = useState<GuardianStatusResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const [isMinor, setIsMinor] = useState(true);
  const [assent, setAssent] = useState(false);
  const [optional, setOptional] = useState<Record<string, boolean>>({});
  const [guardianUrl, setGuardianUrl] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!user) return;
    const rows = await ApiClient.pilotEnrollments();
    const live = rows.find((row) => row.state !== "withdrawn" && row.state !== "completed") ?? rows[0] ?? null;
    setEnrollment(live);
    setGuardian(live && live.is_minor ? await ApiClient.guardianStatus(live.id) : null);
    setLoaded(true);
  }, [user]);

  useEffect(() => {
    if (isLoading) return;
    void refresh();
  }, [isLoading, refresh]);

  // 保護者の確認は別の端末で行われるので、この画面には通知が届かない。
  // 待っているあいだだけ、控えめな間隔で状態を見に行く。答えが出たら止める。
  useEffect(() => {
    if (guardian?.status !== "pending") return;
    const timer = setInterval(() => void refresh(), 15000);
    return () => clearInterval(timer);
  }, [guardian?.status, refresh]);

  const step = useMemo(() => {
    if (!enrollment) return "invite" as const;
    if (enrollment.state === "withdrawn") return "withdrawn" as const;
    if (enrollment.state === "account_bound") return "information" as const;
    if (enrollment.state === "information_read") return "assent" as const;
    if (enrollment.state === "participant_assented") return "guardian" as const;
    if (enrollment.state === "guardian_verified") return "finish" as const;
    return "done" as const;
  }, [enrollment]);

  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setNotice(null);
    try {
      const message = await action();
      if (message) setNotice(message);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "うまくいきませんでした。もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  };

  if (isLoading || !loaded) {
    return (
      <main className="bl-wrap" style={{ display: "grid", placeItems: "center", minHeight: "50vh" }}>
        <span className="bl-loader" aria-label="読み込み中" />
      </main>
    );
  }

  return (
    <main className="bl-wrap bl-stack">
      <header className="bl-stack" style={{ gap: 6 }}>
        <p className="bl-eyebrow">研究への参加</p>
        <h1 className="bl-h1">参加の手続き</h1>
        {enrollment ? (
          <p className="bl-meta">
            ステップ {enrollmentProgress(enrollment).step} / {enrollmentProgress(enrollment).total}
            ・参加者ID {enrollment.research_code}
          </p>
        ) : (
          <p className="bl-meta">配布された招待コードを入力してください。</p>
        )}
      </header>

      {notice ? (
        <p className="bl-notice" role="status">
          {notice}
        </p>
      ) : null}

      {step === "invite" ? (
        <section className="bl-card bl-stack">
          <h2 className="bl-h2">招待コード</h2>
          <p className="bl-meta">
            この研究は招待制です。学校から配布されたコードがないと参加できません。
          </p>
          <label className="bl-label" htmlFor="invite-code">
            招待コード
          </label>
          <input
            id="invite-code"
            className="bl-input"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoComplete="off"
            inputMode="text"
            placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
          />
          <fieldset className="bl-stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="bl-label">年齢の区分</legend>
            <label className="bl-choice">
              <input type="radio" name="age" checked={isMinor} onChange={() => setIsMinor(true)} />
              18歳未満（保護者の確認が必要です）
            </label>
            <label className="bl-choice">
              <input type="radio" name="age" checked={!isMinor} onChange={() => setIsMinor(false)} />
              18歳以上
            </label>
            <p className="bl-micro">生年月日は保存しません。保護者の確認が必要かどうかだけを記録します。</p>
          </fieldset>
          <button
            type="button"
            className="bl-btn bl-btn--primary"
            disabled={busy || code.trim().length === 0}
            onClick={() =>
              run(async () => {
                const result = await ApiClient.redeemPilotInvite(userId, code, isMinor);
                return result.outcome === "rejected"
                  ? "このコードは使用できません。配布元に確認してください。"
                  : null;
              })
            }
          >
            確認する
          </button>
        </section>
      ) : null}

      {step === "information" ? (
        <section className="bl-card bl-stack">
          <h2 className="bl-h2">説明を読む</h2>
          <p>
            この研究では、毎日の日記の記録を集めて分析します。研究期間中はAIの応答機能を停止し、
            書いた内容が外部のサービスに送られることはありません。
          </p>
          <p>
            参加はいつでもやめられます。やめても学校の成績や活動には一切影響しません。
          </p>
          <p className="bl-meta">
            くわしい内容は配布された説明文書に記載されています。読み終えてから次に進んでください。
          </p>
          <div className="bl-row" style={{ gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              className="bl-btn bl-btn--primary"
              disabled={busy}
              onClick={() => run(async () => (await ApiClient.advancePilotEnrollment(enrollment!.id, "information_read"), null))}
            >
              読み終えました
            </button>
            <WithdrawButton busy={busy} enrollmentId={enrollment!.id} onDone={refresh} />
          </div>
        </section>
      ) : null}

      {step === "assent" ? (
        <section className="bl-card bl-stack">
          <h2 className="bl-h2">あなたの同意</h2>
          <p className="bl-meta">
            ここで記録するのは、あなた自身の同意です。
            {enrollment?.is_minor ? "保護者の方の確認は、このあと別の画面で行います。" : null}
          </p>

          <label className="bl-choice">
            <input type="checkbox" checked={assent} onChange={(event) => setAssent(event.target.checked)} />
            研究の説明を読み、研究として分析されることに同意します
          </label>

          <h3 className="bl-h3">任意の項目</h3>
          {OPTIONAL_GRANTS.map((grant) => (
            <label key={grant.key} className="bl-choice">
              <input
                type="checkbox"
                checked={optional[grant.key] === true}
                onChange={(event) => setOptional((current) => ({ ...current, [grant.key]: event.target.checked }))}
              />
              <span>
                {grant.label}
                <span className="bl-micro" style={{ display: "block" }}>
                  {grant.detail}
                </span>
              </span>
            </label>
          ))}

          <div className="bl-row" style={{ gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              className="bl-btn bl-btn--primary"
              disabled={busy || !assent}
              onClick={() =>
                run(async () => {
                  await ApiClient.grantConsent(userId, {
                    app_use: true,
                    research_analysis: true,
                    minor_assent: true,
                    raw_text_retention: optional.raw_text_retention === true,
                    anonymized_export: optional.anonymized_export === true,
                    future_fine_tuning: optional.future_fine_tuning === true,
                  });
                  await ApiClient.advancePilotEnrollment(enrollment!.id, "participant_assented");
                  return null;
                })
              }
            >
              同意して次へ
            </button>
            <WithdrawButton busy={busy} enrollmentId={enrollment!.id} onDone={refresh} />
          </div>
        </section>
      ) : null}

      {step === "guardian" ? (
        <section className="bl-card bl-stack">
          <h2 className="bl-h2">保護者の方の確認</h2>
          <p>{guardian ? GUARDIAN_STATUS_MESSAGE[guardian.status] : GUARDIAN_STATUS_MESSAGE.none}</p>

          {guardian?.status === "declined" ? (
            <p className="bl-meta">
              研究担当への連絡先は、配布された説明文書に記載されています。
            </p>
          ) : (
            <>
              <p className="bl-meta">
                下のボタンで確認用リンクを作り、保護者の方に渡してください。
                リンクは保護者の方の端末で開いていただく必要があります。
                <strong>この画面で保護者の同意を代わりに入力することはできません。</strong>
              </p>

              {guardianUrl ? (
                <div className="bl-notice bl-stack" style={{ gap: 6 }}>
                  <span className="bl-label">確認用リンク</span>
                  <code style={{ wordBreak: "break-all" }}>{guardianUrl}</code>
                  <span className="bl-micro">
                    有効期限は72時間です。この画面を離れると再表示できません。必要なら新しく作り直してください。
                  </span>
                </div>
              ) : null}

              <div className="bl-row" style={{ gap: 10, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="bl-btn bl-btn--primary"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const issued = await ApiClient.requestGuardianLink(enrollment!.id, {
                        raw_text_retention: optional.raw_text_retention === true,
                        anonymized_export: optional.anonymized_export === true,
                        future_fine_tuning: optional.future_fine_tuning === true,
                      });
                      setGuardianUrl(issued.url);
                      return null;
                    })
                  }
                >
                  {guardian?.status === "pending" ? "リンクを作り直す" : "確認用リンクを作る"}
                </button>
                <WithdrawButton busy={busy} enrollmentId={enrollment!.id} onDone={refresh} />
              </div>
            </>
          )}
        </section>
      ) : null}

      {step === "finish" ? (
        <section className="bl-card bl-stack">
          <h2 className="bl-h2">参加登録を完了する</h2>
          <p>保護者の方の確認が終わりました。登録を完了すると、収集開始日から日記の画面が使えます。</p>
          <div className="bl-row" style={{ gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              className="bl-btn bl-btn--primary"
              disabled={busy}
              onClick={() => run(async () => (await ApiClient.advancePilotEnrollment(enrollment!.id, "enrolled"), null))}
            >
              登録を完了する
            </button>
            <WithdrawButton busy={busy} enrollmentId={enrollment!.id} onDone={refresh} />
          </div>
        </section>
      ) : null}

      {step === "done" ? (
        <section className="bl-card bl-stack">
          <h2 className="bl-h2">
            {enrollment?.state === "collecting" ? "収集期間中です" : "登録が完了しています"}
          </h2>
          <p className="bl-meta">
            {enrollment?.state === "collecting"
              ? "毎日の記録を続けてください。参加をやめたくなったら、いつでもここから手続きできます。"
              : "収集の開始日になると、日記の画面が使えるようになります。"}
          </p>
          <div className="bl-row" style={{ gap: 10, flexWrap: "wrap" }}>
            {enrollment?.state === "collecting" ? (
              <Link className="bl-btn bl-btn--primary" href="/journal">
                日記を書く
              </Link>
            ) : null}
            <WithdrawButton busy={busy} enrollmentId={enrollment!.id} onDone={refresh} />
          </div>
        </section>
      ) : null}

      {step === "withdrawn" ? (
        <section className="bl-card bl-stack">
          <h2 className="bl-h2">参加を終了しました</h2>
          <p>これまでのご参加ありがとうございました。以降の記録は研究には使われません。</p>
          <p className="bl-meta">
            すでに保存されたデータの削除を希望される場合は、説明文書に記載の研究担当までご連絡ください。
          </p>
        </section>
      ) : null}

      <p className="bl-disclaimer">
        <Icon name="medical_information" size={15} />
        blescは医療的な診断を行いません。困っているときは、身近な大人や相談窓口にご連絡ください。
      </p>
    </main>
  );
}

/**
 * 参加をやめるボタン。
 *
 * どの段階からでも同じ場所に、同じ大きさで出す。確認ダイアログは1回だけで、
 * 「本当に？」を重ねたり、やめる理由を尋ねたりはしない — 理由を聞くこと自体が
 * 圧力になる。
 */
function WithdrawButton({
  busy,
  enrollmentId,
  onDone,
}: {
  busy: boolean;
  enrollmentId: string;
  onDone: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button type="button" className="bl-btn bl-btn--ghost" disabled={busy} onClick={() => setConfirming(true)}>
        参加をやめる
      </button>
    );
  }

  return (
    <span className="bl-row" style={{ gap: 8 }}>
      <button
        type="button"
        className="bl-btn bl-btn--secondary"
        disabled={busy}
        onClick={async () => {
          await ApiClient.advancePilotEnrollment(enrollmentId, "withdrawn");
          await onDone();
        }}
      >
        やめる
      </button>
      <button type="button" className="bl-btn bl-btn--ghost" disabled={busy} onClick={() => setConfirming(false)}>
        戻る
      </button>
    </span>
  );
}
