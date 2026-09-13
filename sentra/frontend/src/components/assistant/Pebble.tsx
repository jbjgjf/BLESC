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
 * 設定にしてある（減衰比 0.87）。ぴたりと止めると機械に見える。体の形
 * だけはもう少し柔らかく（0.62）、着地したときにぷるんと揺れる。
 *
 * 毎フレーム React を回すと、1 秒に 60 回この木を描き直すことになる。
 * 学校の端末には重いので、属性だけを直接書き換えている。React が持つのは
 * 「いまどの表情か」だけ。
 */

/** ばね。減衰比 = DAMPING / (2√STIFFNESS) ≒ 0.87。 */
const STIFFNESS = 190;
const DAMPING = 24;

/** 体の形（rx, ry）用の柔らかいばね。減衰比 ≒ 0.62。 */
const SHAPE_STIFFNESS = 210;
const SHAPE_DAMPING = 18;

/** 積分の刻み。1 フレームが長くなっても、この幅に割って回す。 */
const MAX_STEP = 1 / 60;

/** 1 フレームで進める上限。タブに戻ってきたときに吹き飛ばないように。 */
const MAX_FRAME = 0.05;

const BLINK_MS = 160;
const BLINK_MIN_GAP = 2600;
const BLINK_EXTRA_GAP = 3800;

const BREATH_MS = 3400;
const THINK_BOB_MS = 900;

/**
 * 跳ねる。ばねではなく放物線で動かす。減衰比 0.87 のばねに速度を入れても、
 * ゆっくり元の高さへ戻るだけで着地が起きない（戻る瞬間の速さは 0.2 ほど）。
 * 重力で落とせば、飛び上がった速さのまま着地し、その勢いで体がつぶれる。
 * 頂点の高さ = HOP_SPEED² / (2 × GRAVITY) ≒ 3.2、滞空 ≒ 0.21 秒。
 */
const HOP_SPEED = 60;
const GRAVITY = 560;
/** 着地の勢いを形のばねへ渡す割合。縦につぶれ、横に広がる。 */
const SQUASH_Y = 0.45;
const SQUASH_X = 0.3;
/** viewBox からはみ出さないための上限。tests/assistant.test.mjs の余白と対。 */
const LIFT_LIMIT = 5.5;
/** 伸び縮みしても viewBox に収まる上限。 */
const RX_LIMIT = 37;
const RY_LIMIT = 32;

/** この速さ（単位/秒）で最大まで伸びる。 */
const STRETCH_SPEED = 700;
const STRETCH_MAX = 0.09;

/** 目線を振れる幅（100 単位の座標系）。 */
const GAZE_RANGE_X = 3.4;
const GAZE_RANGE_Y = 2.4;

const TAU = Math.PI * 2;

/** 線の太さを表示サイズによらず一定に見せる。単位が viewBox 側なので割り戻す。 */
const VIEW_WIDTH = Number(PEBBLE_VIEWBOX.split(" ")[2]);
const strokeFor = (size: number) => (1.75 * VIEW_WIDTH) / size;

const RX_INDEX = PARAM_KEYS.indexOf("rx");
const RY_INDEX = PARAM_KEYS.indexOf("ry");
const GAZE_X_INDEX = PARAM_KEYS.indexOf("gazeX");
const GAZE_Y_INDEX = PARAM_KEYS.indexOf("gazeY");

export type Gaze = { x: number; y: number };
const AHEAD: Gaze = { x: 0, y: 0 };

type PebbleProps = {
  expression: Expression;
  size: number;
  /** 値が変わるたびに一度跳ねる。 */
  hopKey?: number;
  /** 目線の向き（-1〜1）。なければ表情どおりで、待機中はときどきよそ見をする。 */
  gaze?: Gaze | null;
  className?: string;
};

const toParams = (values: Float64Array): PebbleParams => {
  const params = {} as Record<string, number>;
  PARAM_KEYS.forEach((key, index) => {
    params[key] = values[index];
  });
  return params as PebbleParams;
};

export function Pebble({ expression, size, hopKey = 0, gaze = null, className }: PebbleProps) {
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

  const look = useRef<Gaze | null>(gaze);
  useEffect(() => {
    look.current = gaze;
  }, [gaze]);

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
    let shown = target.current;
    let hopHeight = 0;
    let hopSpeed = 0;
    let glance = AHEAD;
    let glanceAt = previous + 4000 + Math.random() * 4000;

    const tick = (now: number) => {
      const elapsed = now - origin;
      let remaining = Math.min((now - previous) / 1000, MAX_FRAME);
      previous = now;

      if (hopPending.current) {
        hopPending.current = false;
        hopSpeed = -HOP_SPEED;
      }

      // 表情が変わる瞬間にまばたきを重ねる。目の形が入れ替わる途中が
      // まぶたで隠れて、切り替えが自然に見える。三日月の目は除く。
      if (target.current !== shown) {
        if (target.current !== "happy" && shown !== "happy") blinkFrom = now;
        shown = target.current;
      }

      // 待機中はときどき目線をよそへ向ける。正面を見続けると置物に見える。
      if (target.current === "rest" && !look.current) {
        if (now >= glanceAt) {
          const away = glance === AHEAD;
          glance = away ? { x: Math.random() * 1.6 - 0.8, y: Math.random() * 0.7 - 0.4 } : AHEAD;
          glanceAt = now + (away ? 700 + Math.random() * 600 : 3500 + Math.random() * 5000);
        }
      } else {
        glance = AHEAD;
      }
      const eyesOn = look.current ?? glance;

      const goal = EXPRESSIONS[target.current];
      while (remaining > 0) {
        const step = Math.min(remaining, MAX_STEP);
        for (let index = 0; index < PARAM_KEYS.length; index += 1) {
          const soft = index === RX_INDEX || index === RY_INDEX;
          const aim =
            goal[PARAM_KEYS[index]] +
            (index === GAZE_X_INDEX ? eyesOn.x * GAZE_RANGE_X : index === GAZE_Y_INDEX ? eyesOn.y * GAZE_RANGE_Y : 0);
          const pull = -(soft ? SHAPE_STIFFNESS : STIFFNESS) * (state[index] - aim);
          velocity[index] += (pull - (soft ? SHAPE_DAMPING : DAMPING) * velocity[index]) * step;
          state[index] += velocity[index] * step;
        }
        if (hopSpeed !== 0 || hopHeight < 0) {
          hopSpeed += GRAVITY * step;
          hopHeight += hopSpeed * step;
          if (hopHeight >= 0) {
            // 着地。落ちてきた勢いを形のばねへ渡すと、柔らかいばねでぷるんと戻る。
            velocity[RY_INDEX] -= hopSpeed * SQUASH_Y;
            velocity[RX_INDEX] += hopSpeed * SQUASH_X;
            hopHeight = 0;
            hopSpeed = 0;
          }
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
      params.lift += hopHeight;
      params.lift = Math.max(-LIFT_LIMIT, Math.min(LIFT_LIMIT, params.lift));

      // 速く動いているほど、進む向きに伸ばす（squash & stretch）。
      // 縦に伸びたぶん横を細らせて、中身の量が変わらないように見せる。
      const stretch = Math.min(Math.abs(hopSpeed) / STRETCH_SPEED, STRETCH_MAX);
      params.ry = Math.min(params.ry * (1 + stretch), RY_LIMIT);
      params.rx = Math.min(params.rx * (1 - stretch * 0.6), RX_LIMIT);

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
