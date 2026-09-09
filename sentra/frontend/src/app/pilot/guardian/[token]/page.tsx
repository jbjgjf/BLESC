/**
 * 保護者の方が開く確認画面（#164）。
 *
 * この画面だけはログインを求めない。保護者はこのサービスの利用者ではなく、
 * アカウントを作らないと答えられない導線は、結局「生徒の端末で生徒が押す」
 * ことになる — それは保護者の同意ではない。
 *
 * 表示に必要なものはこの Server Component が読む。ブラウザから確認用の
 * GET を投げないのは、トークンを持つ画面をできるだけ薄くするため：
 * ブラウザが行う通信は「答えを送る POST」一度だけになる。
 *
 * 読むのは仮名（参加者ID）と研究名と依頼された項目まで。氏名も、書かれた
 * 内容も、ここには来ない。リンクが転送されている可能性がある以上、この画面が
 * 子どもの身元を明かしてはいけない。
 */

import { loadEnrollmentById, loadStudyById } from "@/lib/server/pilotStore";
import { peekVerification, requestedGrantsOf } from "@/lib/server/guardianStore";
import { guardianHashingConfigured, looksLikeGuardianToken } from "@/lib/server/guardianTokens";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";
import { guardianVerificationStatus } from "@/lib/guardianVerification";
import { GuardianConfirm, type GuardianContext } from "./GuardianConfirm";

export const metadata = {
  title: "保護者の方の確認 | blesc",
  // 確認リンクが検索結果に出ることはないが、万一共有されても辿られないように。
  robots: { index: false, follow: false },
};

/** 使えないトークンは、理由を区別せずに同じ文面を返す（confirm ルートと同じ理由）。 */
const UNUSABLE = "この確認用リンクは使用できません。お子さまにご確認のうえ、新しいリンクをお受け取りください。";

export default async function GuardianVerificationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const service = serviceRoleClient();
  if (!looksLikeGuardianToken(token) || !service || !guardianHashingConfigured()) {
    return <GuardianConfirm token={token} context={null} error={UNUSABLE} />;
  }

  const record = await peekVerification(service, token);
  if (!record) return <GuardianConfirm token={token} context={null} error={UNUSABLE} />;

  const enrollment = await loadEnrollmentById(service, record.enrollment_id);
  const study = enrollment ? await loadStudyById(service, enrollment.study_id) : null;
  const grants = study ? requestedGrantsOf(record, study.consent_document_version) : null;

  const context: GuardianContext = {
    status: guardianVerificationStatus(record),
    research_code: enrollment?.research_code ?? null,
    study_title: study?.title ?? null,
    document_version: grants?.document_version ?? null,
    baseline_days: study?.baseline_days ?? null,
    observation_days: study?.observation_days ?? null,
    optional_grants: grants
      ? (["raw_text_retention", "anonymized_export", "future_fine_tuning"] as const).filter((key) => grants[key])
      : [],
    expires_at: record.expires_at,
  };

  return <GuardianConfirm token={token} context={context} error={null} />;
}
