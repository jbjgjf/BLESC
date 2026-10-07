import { STAFF } from "@/lib/teachers/fixtures";
import { StaffDetail } from "./StaffDetail";

/**
 * 先生の個別画面。画面そのものは StaffDetail（クライアント側）にある。
 * デモ表示を静的に書き出すときに、どの先生のページを作るかを先に知らせる
 * ため、generateStaticParams をサーバー側のこのファイルに置いている。
 */
export function generateStaticParams() {
  return STAFF.map((member) => ({ staffId: member.id }));
}

export default function StaffDetailPage() {
  return <StaffDetail />;
}
