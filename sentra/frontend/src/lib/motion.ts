"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * モーションの共通ユーティリティ。
 *
 * ライブラリは入れていない。ここにあるのは requestAnimationFrame と
 * IntersectionObserver だけで、演出の大半は blesc.css 側の CSS が持つ。
 * 学校の端末でも軽く動くことを優先している。
 *
 * どの関数も「視差効果を減らす」設定を尊重し、その場合は動きを止めて
 * 最終状態をそのまま出す。
 */

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** 描画の外（イベントハンドラなど）から読むとき用。 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(REDUCED_MOTION).matches;
}

function subscribeToMotionPreference(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * 描画中に読む版。サーバーと最初の描画では false を返すので、
 * ハイドレーションはずれない。設定を途中で変えても追従する。
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeToMotionPreference,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
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
