"use client";

import { useSyncExternalStore } from "react";

/**
 * デモモード — ログインを省いて固定データで画面を確認するためのモード。
 *
 * 有効なとき、認証チェックは通るが読み込むのは src/lib/blesc/fixtures.ts の
 * 固定データだけで、Supabase には一切アクセスしない。実データを扱う画面は
 * セッションがないため何も返さず「ログインが必要です」を表示する。
 * したがって有効でも生徒のデータが漏れることはない。
 *
 * 既定値:
 *   - 開発中（next dev）  … 有効。ログインせずにすべての画面を確認できる。
 *   - 本番ビルド          … 無効。通常どおりログインが必要。
 *     デプロイ先でもデモを見せたい場合は NEXT_PUBLIC_DEMO_MODE=1 を設定する。
 *
 * URL で上書きできる:
 *   ?demo=1 … このタブで有効にする
 *   ?demo=0 … このタブで無効にする（ログイン画面を確認したいとき）
 */

const KEY = "blesc:demo";

/** 明示的な指定がないときの既定値。 */
const DEMO_BY_DEFAULT =
  process.env.NODE_ENV === "development" || process.env.NEXT_PUBLIC_DEMO_MODE === "1";

/** タブ内で変化しないので購読するものはない。 */
const subscribe = () => () => {};

/** サーバー描画とハイドレーション時は必ず false（差異を出さないため）。 */
const getServerSnapshot = () => false;

function getSnapshot(): boolean {
  if (typeof window === "undefined") return false;

  const requested = new URLSearchParams(window.location.search).get("demo");
  if (requested === "1") {
    window.sessionStorage.setItem(KEY, "1");
    return true;
  }
  // 既定が有効のときでも ?demo=0 が効くよう、明示的な無効も保存する。
  if (requested === "0") {
    window.sessionStorage.setItem(KEY, "0");
    return false;
  }

  const stored = window.sessionStorage.getItem(KEY);
  if (stored === "1") return true;
  if (stored === "0") return false;
  return DEMO_BY_DEFAULT;
}

/**
 * サーバーと最初のクライアント描画では false を返し、ハイドレーション後に
 * 実際の値になる。リダイレクト判定に使う側は useIsHydrated と併用すること。
 */
export function useDemoMode(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** React 外から読むとき用。 */
export function readDemoFlag(): boolean {
  return getSnapshot();
}
