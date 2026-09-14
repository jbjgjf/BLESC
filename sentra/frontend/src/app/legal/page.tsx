import type { Metadata } from "next";
import Link from "next/link";
import { LEGAL_CONTACT, LEGAL_DOCUMENTS } from "@/lib/legalDocuments";

export const metadata: Metadata = {
  title: "書類の確認用草案 | blesc",
  robots: { index: false, follow: false },
};

export default function LegalDraftsPage() {
  return (
    <main className="bl-wrap bl-stack" style={{ paddingBlock: 32 }}>
      <header className="bl-stack">
        <p className="bl-eyebrow">blesc · 確認用草案</p>
        <h1 className="bl-h1">利用・個人情報・研究の書類</h1>
        <p className="bl-notice" role="note">
          以下は未施行・未承認の案です。閲覧しても同意した扱いにはなりません。
          既存の同意記録の文書版を置き換えるものではなく、この案で新たな研究同意を取得しません。
          運用体制・委託条件・削除処理の確認と、必要な法務・研究・学校側の承認後に正式化します。
        </p>
        <nav id="legal-toc" className="bl-stack" aria-label="書類の目次">
          {LEGAL_DOCUMENTS.map((document) => (
            <a key={document.id} href={`#${document.id}`}>{document.title}</a>
          ))}
        </nav>
        <Link href="/login" className="bl-btn bl-btn--ghost">ログイン画面へ</Link>
      </header>
      {LEGAL_DOCUMENTS.map((document) => (
        <article id={document.id} key={document.id} className="bl-card bl-stack" style={{ scrollMarginTop: 24 }}>
          <h2 className="bl-h2">{document.title}</h2>
          <p className="bl-meta">確認用の版：{document.version} ／施行日・承認日：未設定</p>
          {document.sections.map((section) => (
            <section key={section.title} className="bl-stack" style={{ gap: 10 }}>
              <h3 className="bl-h3">{section.title}</h3>
              {section.paragraphs.map((paragraph) => <p className="bl-body" key={paragraph}>{paragraph}</p>)}
            </section>
          ))}
        </article>
      ))}
      <footer className="bl-stack">
        <a href={`mailto:${LEGAL_CONTACT}`}>お問い合わせ：{LEGAL_CONTACT}</a>
        <a href="#legal-toc">書類の目次へ戻る</a>
      </footer>
    </main>
  );
}
