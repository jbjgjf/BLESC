"use client";

import { useSyncExternalStore } from "react";
import { addDays, TODAY } from "./labels";
import { readDemoFlag } from "@/lib/demo";

/**
 * 試験導入（パイロット）期間。
 *
 * 学校ごとに開始日が変わるので、コードを触らずに環境変数で設定できる。
 *   NEXT_PUBLIC_PILOT_START=2026-09-01   開始日（YYYY-MM-DD）
 *   NEXT_PUBLIC_PILOT_DAYS=30            日数
 *
 * 設定がなければデモ用の既定値を使う。既定値は fixtures の TODAY
 * （2026-08-07）を含む期間にしてあるので、デモでも途中経過が見える。
 */

export const PILOT_DAYS = Number(process.env.NEXT_PUBLIC_PILOT_DAYS) || 30;

export const PILOT_START = process.env.NEXT_PUBLIC_PILOT_START || "2026-08-01";

/** 最終日。開始日を1日目と数えるので、足すのは日数 - 1。 */
export const PILOT_END = addDays(PILOT_START, PILOT_DAYS - 1);

export type PilotProgress = {
  /** 1日目を 1 とした経過日数。開始前は 0、終了後は PILOT_DAYS。 */
  elapsed: number;
  /** 今日を含めた残り日数。終了後は 0。 */
  remaining: number;
  phase: "before" | "during" | "after";
};

const dayNumber = (iso: string) => Math.floor(new Date(`${iso}T00:00:00`).getTime() / 86_400_000);

export function pilotProgress(today: string): PilotProgress {
  const start = dayNumber(PILOT_START);
  const end = dayNumber(PILOT_END);
  const now = dayNumber(today);

  if (now < start) return { elapsed: 0, remaining: PILOT_DAYS, phase: "before" };
  if (now > end) return { elapsed: PILOT_DAYS, remaining: 0, phase: "after" };

  return { elapsed: now - start + 1, remaining: end - now + 1, phase: "during" };
}

/** 期間中の全日付。カレンダーの並びはこの配列から組み立てる。 */
export function pilotDays(): string[] {
  return Array.from({ length: PILOT_DAYS }, (_, index) => addDays(PILOT_START, index));
}

function localTodayISO(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

const subscribe = () => () => {};

/**
 * 今日の日付。
 *
 * サーバーは利用者の端末の日付を知らないので、サーバー側では null を返し、
 * ハイドレーション後に埋める。こうしないと「サーバーの今日」と「端末の今日」
 * がずれた瞬間に表示が食い違う。カレンダーの升目自体は開始日と日数だけで
 * 決まるため、null の間でも普通に描ける（今日の印と残り日数だけ後から出る）。
 *
 * デモモードでは fixtures の TODAY を使う。実日付にすると、画面の他の場所が
 * 8月7日のままなのにカレンダーだけ現実の日付になり、話が合わなくなる。
 */
export function usePilotToday(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => (readDemoFlag() ? TODAY : localTodayISO()),
    () => null,
  );
}
