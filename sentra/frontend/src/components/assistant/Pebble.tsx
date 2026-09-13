"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion } from "@/lib/motion";
import {
  applyBlink,
  bodyPath,
  eyePaths,
  EXPRESSIONS,
  PARAM_KEYS,
  PEBBLE_VIEWBOX,
  PHASE_SWAY,
  type Expression,
  type PebbleParams,
} from "@/lib/assistant/pebble";
import styles from "./Pebble.module.css";

/**
 * 小石を描いて、時間を進める部分。
 *
 * 表情のあいだをばねでつなぐ。差し替えではなく引っぱるので、途中の姿が
 * 全部埋まり、切り替えの瞬間が見えない。ばねは少しだけ行き足が残る
 * 設定にしてある（減衰比 0.87）。ぴたりと止めると機械に見える。
 *
 * 毎フレーム React を回すと、1 秒に 60 回この木を描き直すことになる。
 * 学校の端末には重いので、属性だけを直接書き換えている。React が持つのは
 * 「いまどの表情か」だけ。
 */

/** ばね。減衰比 = DAMPING / (2√STIFFNESS) ≒ 0.87。 */
const STIFFNESS = 190;
const DAMPING = 24;

/** 積分の刻み。1 フレームが長くなっても、この幅に割って回す。 */
const MAX_STEP = 1 / 60;

/** 1 フレームで進める上限。タブに戻ってきたときに吹き飛ばないように。 */
const MAX_FRAME = 0.05;

const BLINK_MS = 160;
const BLINK_MIN_GAP = 2600;
const BLINK_EXTRA_GAP = 3800;

const BREATH_MS = 3400;
const THINK_BOB_MS = 900;

/** 跳ねる勢い。lift のばねに速度を入れて、あとは物理に任せる。 */
const HOP_SPEED = 60;
/** viewBox からはみ出さないための上限。tests/assistant.test.mjs の余白と対。 */
const LIFT_LIMIT = 5.5;

const TAU = Math.PI * 2;

/** 線の太さを表示サイズによらず一定に見せる。単位が viewBox 側なので割り戻す。 */
const VIEW_WIDTH = Number(PEBBLE_VIEWBOX.split(" ")[2]);
const strokeFor = (size: number) => (1.75 * VIEW_WIDTH) / size;

const LIFT_INDEX = PARAM_KEYS.indexOf("lift");

type PebbleProps = {
  expression: Expression;
  size: number;
  /** 値が変わるたびに一度跳ねる。 */
  hopKey?: number;
  className?: string;
};

const toParams = (values: Float64Array): PebbleParams => {
  const params = {} as Record<string, number>;
  PARAM_KEYS.forEach((key, index) => {
    params[key] = values[index];
  });
  return params as PebbleParams;
};

export function Pebble({ expression, size, hopKey = 0, className }: PebbleProps) {
  const reduced = useReducedMotion();
  const bodyRef = useRef<SVGPathElement>(null);
  const leftRef = useRef<SVGPathElement>(null);
  const rightRef = useRef<SVGPathElement>(null);

  // ループが毎フレーム読む「目標の表情」。描画中には書かず、確定後に渡す。
  const target = useRef<Expression>(expression);
  useEffect(() => {
    target.current = expression;
  }, [expression]);

  // 跳ねる合図は旗で渡す。hopKey をループの effect の依存に入れると、
  // 跳ねるたびにループが作り直されて経過時間が 0 に戻り、呼吸の位相が飛ぶ。
  // 初回は跳ねない — パネルを開いた瞬間に、それまでの回数ぶん跳ねないように。
  const hopPending = useRef(false);
  const seenHop = useRef<number | null>(null);
  useEffect(() => {
    if (seenHop.current !== null && seenHop.current !== hopKey) hopPending.current = true;
    seenHop.current = hopKey;
  }, [hopKey]);

  // 動きを減らす設定のときは、時間を進めずに最終形だけを描く。
  useEffect(() => {
    if (!reduced) return;
    const params = EXPRESSIONS[expression];
    const eyes = eyePaths(params);
    bodyRef.current?.setAttribute("d", bodyPath(params));
    leftRef.current?.setAttribute("d", eyes.left);
    rightRef.current?.setAttribute("d", eyes.right);
  }, [reduced, expression]);

  useEffect(() => {
    if (reduced) return;

    // ばねの状態はループの中に置く。止めて再開したときは、そのときの
    // 目標から始め直せば足りる（止まっている間は最終形を描いているので、
    // 見た目はつながる）。
    const start = EXPRESSIONS[target.current];
    const state = Float64Array.from(PARAM_KEYS, (key) => start[key]);
    const velocity = new Float64Array(PARAM_KEYS.length);
    let frame = 0;
    let previous = performance.now();
    const origin = previous;

    let blinkAt = previous + BLINK_MIN_GAP + Math.random() * BLINK_EXTRA_GAP;
    let blinkFrom = -Infinity;

    const tick = (now: number) => {
      const elapsed = now - origin;
      let remaining = Math.min((now - previous) / 1000, MAX_FRAME);
      previous = now;

      if (hopPending.current) {
        hopPending.current = false;
        velocity[LIFT_INDEX] = -HOP_SPEED;
      }

      const goal = EXPRESSIONS[target.current];
      while (remaining > 0) {
        const step = Math.min(remaining, MAX_STEP);
        for (let index = 0; index < PARAM_KEYS.length; index += 1) {
          const pull = -STIFFNESS * (state[index] - goal[PARAM_KEYS[index]]);
          velocity[index] += (pull - DAMPING * velocity[index]) * step;
          state[index] += velocity[index] * step;
        }
        remaining -= step;
      }

      const params = toParams(state);

      // 呼吸。ばねの値には混ぜず、描くときだけ足す。混ぜると目標が
      // 揺れ続け、ばねがいつまでも落ち着かない。
      const breath = Math.sin((elapsed / BREATH_MS) * TAU);
      params.rx *= 1 + 0.012 * breath;
      params.ry *= 1 - 0.016 * breath;
      params.lift += breath * 0.5;

      if (target.current === "thinking") {
        params.lift += Math.sin((elapsed / THINK_BOB_MS) * TAU) * 1.1;
      }
      params.lift = Math.max(-LIFT_LIMIT, Math.min(LIFT_LIMIT, params.lift));

      // 三日月の目をまばたきさせても、平たくなるだけで何も起きない。
      if (target.current !== "happy") {
        if (now >= blinkAt) {
          blinkFrom = now;
          blinkAt = now + BLINK_MIN_GAP + Math.random() * BLINK_EXTRA_GAP;
        }
        const since = now - blinkFrom;
        if (since < BLINK_MS) {
          Object.assign(params, applyBlink(params, Math.sin((since / BLINK_MS) * Math.PI)));
        }
      }

      const eyes = eyePaths(params);
      bodyRef.current?.setAttribute("d", bodyPath(params, Math.sin((elapsed / BREATH_MS) * TAU) * PHASE_SWAY));
      leftRef.current?.setAttribute("d", eyes.left);
      rightRef.current?.setAttribute("d", eyes.right);

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [reduced]);

  // サーバーと最初の描画は表情そのまま。ここが揃っていれば差異は出ない。
  const initial = EXPRESSIONS[expression];
  const initialEyes = eyePaths(initial);

  return (
    <svg
      viewBox={PEBBLE_VIEWBOX}
      width={size}
      height={size}
      className={[styles.svg, className].filter(Boolean).join(" ")}
      aria-hidden="true"
      focusable="false"
    >
      <path
        ref={bodyRef}
        d={bodyPath(initial)}
        className={styles.body}
        strokeWidth={strokeFor(size)}
      />
      <path ref={leftRef} d={initialEyes.left} className={styles.eye} />
      <path ref={rightRef} d={initialEyes.right} className={styles.eye} />
    </svg>
  );
}
