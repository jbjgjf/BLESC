"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useA11y } from "@/lib/a11y";

/**
 * モーションの共通ユーティリティ。
 *
 * ライブラリは入れていない。ここにあるのは requestAnimationFrame と
 * IntersectionObserver だけで、演出の大半は blesc.css 側の CSS が持つ。
 * 学校の端末でも軽く動くことを優先している。
 *
 * どの関数も「動きを減らす」指定を尊重し、その場合は動きを止めて
 * 最終状態をそのまま出す。指定は 2 か所から来る — OS の「視差効果を
 * 減らす」と、アプリの表示設定。どちらか一方でも立っていれば止める。
 */

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** 描画の外（イベントハンドラなど）から読むとき用。 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  // アプリ側の指定は <html data-bl-motion> に出ている（lib/a11y.ts）。
  // CSS はこれを見て CSS の動きを止めるが、requestAnimationFrame や
  // View Transitions のような JS 側の動きには届かないので、ここでも見る。
  return (
    document.documentElement.dataset.blMotion === "reduced" ||
    window.matchMedia(REDUCED_MOTION).matches
  );
}

function subscribeToMotionPreference(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * 描画中に読む版。サーバーと最初の描画では false を返すので、
 * ハイドレーションはずれない。設定を途中で変えても追従する。
 *
 * 表示設定のほうも購読しているので、案内役に「動きを止めて」と頼んだ
 * 瞬間に、案内役自身の動きも止まる。
 */
export function useReducedMotion(): boolean {
  const system = useSyncExternalStore(
    subscribeToMotionPreference,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
  const { motion } = useA11y();
  return system || motion === "reduced";
}

/**
 * 0 から value まで数える。連続提出日数のように「積み上がった」ことに
 * 意味がある数字にだけ使う。
 *
 * サーバーと最初の描画はどちらも 0 なので、ハイドレーションはずれない。
 */
export function useCountUp(value: number, duration = 900): number {
  const reduced = useReducedMotion();
  const [counted, setCounted] = useState(0);

  useEffect(() => {
    if (reduced || duration <= 0) return;

    let raf = 0;
    const started = performance.now();

    const tick = (now: number) => {
      // rAF が渡すのはフレーム開始時刻なので、スケジュール時に控えた
      // performance.now() より前になることがある。挟まないと 1 フレームだけ
      // 負の値が出る。
      const t = Math.min(1, Math.max(0, (now - started) / duration));
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      setCounted(Math.round(value * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);

    // 背景タブなど、フレームが来ない状況では rAF が動かない。演出が
    // 流れないのは構わないが、数字が 0 のまま残るのは困る（6 日続けた子に
    // 0 と見せることになる）。タイマーで必ず最終値に着地させる。
    const settle = window.setTimeout(() => setCounted(value), duration + 250);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
    };
  }, [value, duration, reduced]);

  // 動かさない設定のときは、そもそも数えずに結果だけ返す。
  return reduced ? value : counted;
}

/**
 * スクロール連動アニメーションを持たないブラウザ向けの .bl-reveal 補完。
 *
 * html[data-bl-reveal="js"] を立ててから監視を始めるので、JS が動かない
 * 環境では CSS 側の隠す指定自体が適用されず、内容が消えたままにならない。
 */
export function useScrollRevealFallback(routeKey: string): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (prefersReducedMotion()) return;
    if (CSS.supports("animation-timeline", "view()")) return;

    document.documentElement.dataset.blReveal = "js";

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          (entry.target as HTMLElement).dataset.revealed = "true";
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.05 },
    );

    document.querySelectorAll(".bl-reveal").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [routeKey]);
}
