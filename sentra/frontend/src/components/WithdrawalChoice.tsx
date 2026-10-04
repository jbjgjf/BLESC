"use client";

/**
 * 研究への参加をやめるときの選択（#224, #263）。
 *
 * `/consent` と `/pilot/join` の両方がこれを出す。撤回は1つの手続きなので、
 * 画面ごとに違う説明をすると、同じことをしているのに片方では本文が消え、
 * 片方では残るように読めてしまう（#263 以前は実際にそうだった）。
 *
 * 押す前に伝えること（#224 の受入基準）:
 *   - どちらを選んでも研究への協力は終わる
 *   - 「いま削除する」で消えるもの、元に戻せないこと
 *   - 削除しても残るもの（本文以外の記録）と、それが研究に使われないこと
 *
 * 残るものの範囲は sentra/docs/research_export_and_pii.md と
 * docs/pilot/withdrawal.md に合わせている。変えるときは3か所を一緒に変える。
 */

export function WithdrawalChoice({
  busy,
  onChoose,
  onCancel,
  cancelLabel = "やめる（撤回しない）",
}: {
  busy: boolean;
  onChoose: (retainedData: "delete" | "keep") => void;
  onCancel: () => void;
  cancelLabel?: string;
}) {
  return (
    <section className="bl-card bl-stack" aria-live="polite" aria-label="保管してある日記の本文をどうしますか">
      <h2 className="bl-h2">保管してある日記の本文をどうしますか</h2>
      <p className="bl-body">
        どちらを選んでも、<strong>研究への協力はここで終わります。</strong>
        これから書くものが研究に使われることはありませんし、残す方を選んでも、
        すでに書いたものが研究の分析やAIの学習に使われることはありません。
        選ぶのは「いま消すかどうか」だけです。
      </p>
      <div className="bl-stack" style={{ gap: 10 }}>
        <button
          type="button"
          className="bl-btn bl-btn--secondary bl-btn--block"
          disabled={busy}
          onClick={() => onChoose("delete")}
        >
          いま削除する
          <span className="bl-micro" style={{ display: "block" }}>
            暗号化して預かっている日記の本文を、すぐに消します。元に戻せません。
          </span>
        </button>
        <button
          type="button"
          className="bl-btn bl-btn--secondary bl-btn--block"
          disabled={busy}
          onClick={() => onChoose("keep")}
        >
          残す
          <span className="bl-micro" style={{ display: "block" }}>
            自分の記録として、保存期間が終わるまで残します。期間が来たら自動で消えます。
          </span>
        </button>
      </div>
      <p className="bl-meta">
        <strong>本文を削除しても残るもの:</strong>
        毎日の自己評定（気分・ストレスなどの数字）、記入にかかった時間などの記録、
        日記から取り出した要素、そして同意と撤回の履歴です。
        これらも撤回した時点から、研究の分析・研究用の書き出し・AIの学習には使われません。
        これらも消してほしい場合は、研究問い合わせ先へご連絡ください。
      </p>
      <button
        type="button"
        className="bl-btn bl-btn--ghost bl-btn--block"
        disabled={busy}
        onClick={onCancel}
      >
        {cancelLabel}
      </button>
    </section>
  );
}
