import Link from "next/link";
import { researchDocumentNotice } from "@/lib/legalNotices";

/**
 * A review link is not consent to a draft, nor evidence it was presented as the
 * live version. The wording follows the research documents' own enactment
 * switch (`legalNotices.ts`), so it stops calling them a draft when they are not.
 */
export function LegalDraftNotice({ audience = "research" }: { audience?: "research" | "guardian" }) {
  const notice = researchDocumentNotice(audience);
  return (
    <aside className="bl-card bl-stack" role="note">
      <p className="bl-meta">{notice.note}</p>
      <Link href={`/legal#${audience}`} target="_blank" rel="noopener noreferrer">
        {notice.link}
      </Link>
    </aside>
  );
}
