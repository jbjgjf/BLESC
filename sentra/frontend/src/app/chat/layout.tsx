/**
 * 収集期間中はこの画面を出さない（#165）。
 *
 * 判定と理由は `lib/server/collectionOnlyRedirect.ts`。パイロット用デプロイ
 * 以外では何もしない。
 */

import { redirect } from "next/navigation";
import {
  COLLECTION_ONLY_DESTINATION,
  collectionOnlyForCurrentUser,
} from "@/lib/server/collectionOnlyRedirect";

export default async function CollectionGatedLayout({ children }: { children: React.ReactNode }) {
  if (await collectionOnlyForCurrentUser()) redirect(COLLECTION_ONLY_DESTINATION);
  return children;
}
