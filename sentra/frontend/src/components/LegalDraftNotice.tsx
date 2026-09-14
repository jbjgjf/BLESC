import Link from "next/link";

/** A review link is not consent to a draft, nor evidence it was presented as the live version. */
export function LegalDraftNotice({ audience = "research" }: { audience?: "research" | "guardian" }) {
  return (
    <aside className="bl-card bl-stack" role="note">
      <p className="bl-meta">
        改訂書類は確認用草案です。既存の同意文書の版とは異なり、この草案の閲覧を同意として記録しません。
      </p>
      <Link href={`/legal#${audience}`} target="_blank" rel="noopener noreferrer">
        {audience === "guardian" ? "保護者向け説明・確認の改訂案を読む（別タブ）" : "研究説明・同意の改訂案を読む（別タブ）"}
      </Link>
    </aside>
  );
}
