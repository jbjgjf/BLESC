import type { Metadata } from "next";
import Link from "next/link";
import { LEGAL_CONTACT, LEGAL_DOCUMENTS } from "@/lib/legalDocuments";
import { legalEffectiveDate, legalEffectiveDateLabel, legalEnactmentState } from "@/lib/legalEnactment";

/**
 * Rendered per request, not prerendered (#282).
 *
 * The version and the date are `NEXT_PUBLIC_*`, which the bundler inlines at
 * build time — those are deployment decisions and being fixed per deployment
 * is correct. **The clock is not.** Whether the declared date has arrived is
 * answered at render time, so a statically prerendered page would keep saying
 * 「施行予定」 after the day came, until somebody happened to redeploy. There is
 * no data fetch here; the cost is rendering a few constant documents.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "書類の確認用草案 | blesc",
  robots: { index: false, follow: false },
};

export default function LegalDraftsPage() {
  // 施行の状態で見出しと注記が切り替わる。「（案）」と「施行済み」を
  // 同じ画面が別々の根拠で名乗らないように、判定は一箇所から取る。
  //
  // 状態は3つある（#282）。「まだ決まっていない」と「決まっているが、まだ
  // その日ではない」は参加者に伝えるべきことが違い、後者には見せられる日付が
  // ある。施行日前に「施行済み」と読める画面を出さないための分岐でもある。
  const state = legalEnactmentState();
  const effectiveDate = legalEffectiveDate();
  const effectiveDateLabel = legalEffectiveDateLabel();

  return (
    <main className="bl-wrap bl-stack" style={{ paddingBlock: 32 }}>
      <header className="bl-stack">
        <p className="bl-eyebrow">blesc · 確認用草案</p>
        <h1 className="bl-h1">利用・個人情報・研究の書類</h1>
        {state === "in_force" ? (
          <p className="bl-notice" role="note">
            以下は {effectiveDate} 施行の規約・プライバシーポリシーです。
            研究参加の同意はこれとは別に取得します（この書類への同意は研究同意ではありません）。
          </p>
        ) : state === "scheduled" ? (
          <p className="bl-notice" role="note">
            以下は {effectiveDate} 施行予定の案です。施行日まではまだ効力がなく、
            閲覧しても同意した扱いにはなりません。施行日より前に同意を記録することもできません。
            研究参加の同意はこれとは別に取得します（この書類への同意は研究同意ではありません）。
          </p>
        ) : (
          <p className="bl-notice" role="note">
            以下は未施行・未承認の案です。閲覧しても同意した扱いにはなりません。
            既存の同意記録の文書版を置き換えるものではなく、この案で新たな研究同意を取得しません。
            運用体制・委託条件・削除処理の確認と、必要な法務・研究・学校側の承認後に正式化します。
          </p>
        )}
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
          <p className="bl-meta">
            版：{document.version}
            {" ／施行日："}
            {effectiveDateLabel}
          </p>
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
