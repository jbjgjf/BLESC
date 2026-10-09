import { CLASS_ROSTER } from "@/lib/blesc/fixtures";
import { StudentDetail } from "./StudentDetail";

/**
 * 生徒の詳細。画面そのものは StudentDetail（クライアント側）にある。
 *
 * 分けてあるのは、デモ表示（blesc.online/demo-view）を静的に書き出すときに、
 * どの生徒のページを作るかを先に知らせる必要があるため。generateStaticParams
 * はサーバー側のファイルにしか書けない。ふだんのビルドでは、ここに無い生徒の
 * ページもこれまでどおり開ける。
 */
export function generateStaticParams() {
  return CLASS_ROSTER.map((student) => ({ participantId: student.id }));
}

export default function StudentDetailPage() {
  return <StudentDetail />;
}
