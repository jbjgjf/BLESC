"use client";

/**
 * 危機的記述の目視レビュー（protocol §4.4 / #225）。
 *
 * §4.4 は「権限者が平日10時・16時に目視確認する」と決めているのに、確認を
 * 回す画面が無かった。決まりだけがあって、開く先が無い状態だった。
 *
 * 画面の設計方針が4つある。
 *
 *   1. **機械の判定を判断として見せない。** 左の色は並び順の手がかりで、
 *      辞書に無い言い方で書かれた危機は `none` に落ちる。だから `none` の行も
 *      同じ一覧に並べ、「対応不要」は人が押したときだけ記録される。
 *
 *   2. **本文は開かないと出てこない。** 一覧は本文を持っておらず、開いた
 *      時点でサーバーに「誰がいつ読んだか」が記録される。一覧を眺めることと
 *      日記を読むことを同じ操作にしない。
 *
 *   3. **所見に本文を貼らせない。** 入力欄は短く、上限も添える。引用を貼ると、
 *      アクセス制御の違う2つ目の本文の写しができる。
 *
 *   4. **本文が消えている行も残す。** 撤回や保持期限で本文が無い行は
 *      「読めなかった」として記録する。黙って一覧から消すと、
 *      「その日は誰も書かなかった」と区別がつかない。
 */

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { Icon } from "@/components/ui/Icon";
import { ApiClient } from "@/api/client";
import styles from "./ops.module.css";

type QueueRow = {
  review_id: string;
  entry_id: string;
  research_code: string | null;
  assessed_risk: "none" | "low" | "elevated" | "crisis";
  assessed_reasons: string[];
  status: "pending" | "no_concern" | "escalated" | "unreadable";
  reviewed_at: string | null;
  review_slot: "morning" | "afternoon" | "ad_hoc" | null;
  created_at: string;
  text_available: boolean;
};

type QueueResponse = {
  slot: "morning" | "afternoon" | "ad_hoc";
  enqueued: number;
  counts: { pending: number; crisis: number; elevated: number; no_text: number };
  queue: QueueRow[];
};

const RISK_LABEL: Record<QueueRow["assessed_risk"], string> = {
  crisis: "危機の可能性",
  elevated: "気がかり",
  low: "低",
  none: "機械判定なし",
};

const STATUS_LABEL: Record<QueueRow["status"], string> = {
  pending: "未確認",
  no_concern: "対応不要と判断",
  escalated: "学校担当へ連絡した",
  unreadable: "本文を読めなかった",
};

const SLOT_LABEL: Record<NonNullable<QueueRow["review_slot"]>, string> = {
  morning: "午前の枠（10時）",
  afternoon: "午後の枠（16時）",
  ad_hoc: "枠外",
};

const NOTE_LIMIT = 500;

export default function CrisisTriagePage() {
  const { isLoading, session } = useAuth();

  const [data, setData] = useState<QueueResponse | null>(null);
  const [includeDecided, setIncludeDecided] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [openId, setOpenId] = useState<string | null>(null);
  const [openText, setOpenText] = useState<string | null>(null);
  const [openReason, setOpenReason] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const refresh = useCallback(async () => {
    setProblem(null);
    try {
      const result = await ApiClient.fetch<QueueResponse>(
        `/pilot/triage${includeDecided ? "?include_decided=1" : ""}`,
      );
      setData(result);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "読み込めませんでした。");
    }
  }, [includeDecided]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = async (row: QueueRow) => {
    setBusy(true);
    setProblem(null);
    setOpenText(null);
    setOpenReason(null);
    setNote("");
    try {
      const result = await ApiClient.fetch<{ text: string | null; reason: string | null }>(
        "/pilot/triage",
        { method: "POST", body: JSON.stringify({ action: "read", review_id: row.review_id }) },
      );
      setOpenId(row.review_id);
      setOpenText(result.text);
      setOpenReason(result.reason);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "本文を開けませんでした。");
    } finally {
      setBusy(false);
    }
  };

  const decide = async (reviewId: string, status: "no_concern" | "escalated" | "unreadable") => {
    setBusy(true);
    setProblem(null);
    try {
      await ApiClient.fetch("/pilot/triage", {
        method: "POST",
        body: JSON.stringify({ review_id: reviewId, status, note: note.trim() || undefined }),
      });
      setOpenId(null);
      setOpenText(null);
      setNote("");
      setNotice("記録しました。");
      await refresh();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "記録できませんでした。");
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) {
    return (
      <main className="bl-wrap" style={{ display: "grid", placeItems: "center", minHeight: "50vh" }}>
        <span className="bl-loader" aria-label="読み込み中" />
      </main>
    );
  }

  if (!session) {
    return (
      <main className="bl-wrap bl-stack">
        <p className="bl-notice" role="status">この画面を使うにはサインインが必要です。</p>
      </main>
    );
  }

  return (
    <main className="bl-wrap bl-stack">
      <header className="bl-stack" style={{ gap: 6 }}>
        <p className="bl-eyebrow">運用</p>
        <h1 className="bl-h1">危機的記述の目視レビュー</h1>
        <p className="bl-meta">
          protocol §4.4。原文保存に同意のある記録を、平日の午前・午後に確認します。
          本文を開くと、誰がいつ開いたかが記録されます。
        </p>
        <p className="bl-disclaimer">
          <Icon name="shield" size={15} />
          この画面は夜間・休日の監視を代替しません。blesc は緊急対応を行いません。
          急迫事案は学校の緊急対応手順に従ってください。
        </p>
      </header>

      {notice && <p className="bl-notice" role="status"><Icon name="info" size={19} /> {notice}</p>}
      {problem && <p className="bl-notice bl-notice--watch" role="alert"><Icon name="info" size={19} /> {problem}</p>}

      {data && (
        <section className="bl-card bl-stack">
          <div className="bl-row" style={{ gap: 16, flexWrap: "wrap" }}>
            <span className="bl-micro">いまの枠: <strong>{SLOT_LABEL[data.slot]}</strong></span>
            <span className="bl-micro">未確認: <strong>{data.counts.pending}</strong></span>
            <span className="bl-micro">危機の可能性: <strong>{data.counts.crisis}</strong></span>
            <span className="bl-micro">気がかり: <strong>{data.counts.elevated}</strong></span>
            <span className="bl-micro">本文なし: <strong>{data.counts.no_text}</strong></span>
          </div>
          {data.slot === "ad_hoc" && (
            <p className="bl-micro">
              いまは §4.4 が定める枠の外です。ここで確認したことは「枠外」として記録され、
              定時のレビューを実施した証跡にはなりません。
            </p>
          )}
          <label className="bl-choice">
            <input
              type="checkbox"
              checked={includeDecided}
              onChange={(event) => setIncludeDecided(event.target.checked)}
            />
            判断済みの行も表示する
          </label>
        </section>
      )}

      <section className="bl-card bl-stack">
        <h2 className="bl-h2">待ち行列</h2>
        {!data || data.queue.length === 0 ? (
          <p className="bl-meta">確認を待っている記録はありません。</p>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>参加者ID</th>
                  <th>機械判定</th>
                  <th>状態</th>
                  <th>本文</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.queue.map((row) => (
                  <tr key={row.review_id}>
                    <td className={styles.code}>{row.research_code ?? "—"}</td>
                    <td>
                      {RISK_LABEL[row.assessed_risk]}
                      {row.assessed_reasons.length > 0 && (
                        <span className="bl-micro" style={{ display: "block" }}>
                          {row.assessed_reasons.join(", ")}
                        </span>
                      )}
                    </td>
                    <td>
                      {STATUS_LABEL[row.status]}
                      {row.review_slot && (
                        <span className="bl-micro" style={{ display: "block" }}>
                          {SLOT_LABEL[row.review_slot]}
                        </span>
                      )}
                    </td>
                    <td>{row.text_available ? "あり" : "なし"}</td>
                    <td>
                      <button
                        type="button"
                        className="bl-btn bl-btn--secondary"
                        disabled={busy}
                        onClick={() => void open(row)}
                      >
                        開いて確認する
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {openId && (
        <section className="bl-card bl-stack" aria-live="polite">
          <h2 className="bl-h2">本文</h2>
          {openText ? (
            <pre className={styles.entryText}>{openText}</pre>
          ) : (
            <p className="bl-notice bl-notice--watch" role="status">
              本文を読み出せませんでした（
              {openReason === "no_text"
                ? "撤回または保持期限により削除済み"
                : openReason === "undecryptable"
                  ? "復号できません。鍵の設定を確認してください"
                  : "理由不明"}
              ）。「本文を読めなかった」として記録してください。
            </p>
          )}

          <div>
            <label className="bl-label" htmlFor="note">所見（任意・{NOTE_LIMIT}字まで）</label>
            <textarea
              id="note"
              className="bl-input"
              rows={3}
              maxLength={NOTE_LIMIT}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="何をしたかを書く欄です。"
            />
            <p className="bl-micro">
              <strong>日記の本文は書き写さないでください。</strong>
              ここに引用すると、閲覧権限の違う場所に本文の写しがもう一つできます。
            </p>
          </div>

          <div className="bl-row" style={{ gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              className="bl-btn bl-btn--primary"
              disabled={busy}
              onClick={() => void decide(openId, "escalated")}
            >
              学校担当へ連絡した
            </button>
            <button
              type="button"
              className="bl-btn bl-btn--secondary"
              disabled={busy}
              onClick={() => void decide(openId, "no_concern")}
            >
              対応不要と判断した
            </button>
            <button
              type="button"
              className="bl-btn bl-btn--ghost"
              disabled={busy}
              onClick={() => void decide(openId, "unreadable")}
            >
              本文を読めなかった
            </button>
            <button
              type="button"
              className="bl-btn bl-btn--ghost"
              disabled={busy}
              onClick={() => { setOpenId(null); setOpenText(null); setNote(""); }}
            >
              閉じる（記録しない）
            </button>
          </div>
          <p className="bl-micro">
            「学校担当へ連絡した」は、連絡を済ませてから押してください。
            このボタンは記録であって、通知は送りません（連絡手順は incident-runbook §3）。
          </p>
        </section>
      )}
    </main>
  );
}
