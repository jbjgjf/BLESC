"use client";

import { useSyncExternalStore } from "react";

/**
 * 表示設定。
 *
 * OS 側の設定（文字の拡大、視差効果を減らす、ハイコントラスト）は CSS が
 * そのまま拾う。ここで持つのは「OS は変えたくないが、このアプリでは変えたい」
 * 分だけ。学校の共用端末では OS 設定を各自が変えられないことが多いので、
 * アプリ側にも持たせておく必要がある。
 *
 * 値は <html> の data 属性に落とし、見た目の分岐は全て CSS 側で行う。
 */

export type TextSize = "s" | "m" | "l" | "xl";
export type LineMode = "normal" | "relaxed";
export type ContrastMode = "normal" | "high";
export type MotionMode = "system" | "reduced";
export type Typeface = "default" | "ud";

export type A11ySettings = {
  text: TextSize;
  line: LineMode;
  contrast: ContrastMode;
  motion: MotionMode;
  face: Typeface;
};

export const A11Y_KEY = "blesc:a11y";

export const A11Y_DEFAULTS: A11ySettings = {
  text: "m",
  line: "normal",
  contrast: "normal",
  motion: "system",
  face: "default",
};

const listeners = new Set<() => void>();

/**
 * useSyncExternalStore は毎回同じ参照を返す必要があるため、読み出した値を
 * 保持しておき、書き換えたときだけ差し替える。
 */
let cached: A11ySettings | null = null;

function readStorage(): A11ySettings {
  if (typeof window === "undefined") return A11Y_DEFAULTS;
  try {
    const raw = window.localStorage.getItem(A11Y_KEY);
    if (!raw) return A11Y_DEFAULTS;
    return { ...A11Y_DEFAULTS, ...(JSON.parse(raw) as Partial<A11ySettings>) };
  } catch {
    return A11Y_DEFAULTS;
  }
}

function getSnapshot(): A11ySettings {
  if (!cached) cached = readStorage();
  return cached;
}

/** サーバーと初回描画は既定値。直後にクライアントの値へ差し替わる。 */
const getServerSnapshot = () => A11Y_DEFAULTS;

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** <html> に data 属性として反映する。CSS 側の分岐はすべてこれを見る。 */
export function applyA11y(settings: A11ySettings): void {
  const data = document.documentElement.dataset;
  data.blText = settings.text;
  data.blLine = settings.line;
  data.blContrast = settings.contrast;
  data.blMotion = settings.motion;
  data.blFace = settings.face;
}

export function useA11y(): A11ySettings {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function setA11y(patch: Partial<A11ySettings>): void {
  cached = { ...getSnapshot(), ...patch };
  try {
    window.localStorage.setItem(A11Y_KEY, JSON.stringify(cached));
  } catch {
    // プライベートモード等で保存できなくても、その場の表示は変える。
  }
  applyA11y(cached);
  listeners.forEach((notify) => notify());
}

export function resetA11y(): void {
  setA11y(A11Y_DEFAULTS);
}

/**
 * 描画前に data 属性を当てるためのスクリプト。これを <body> の先頭で
 * 実行しないと、既定の見た目が一瞬映ってから設定が適用される。
 */
export const A11Y_BOOT_SCRIPT = `(function(){try{
var s=JSON.parse(localStorage.getItem(${JSON.stringify(A11Y_KEY)})||"{}");
var d=document.documentElement.dataset;
d.blText=s.text||"m";d.blLine=s.line||"normal";d.blContrast=s.contrast||"normal";
d.blMotion=s.motion||"system";d.blFace=s.face||"default";
}catch(e){}})();`;
