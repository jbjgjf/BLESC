"use client";

import { useEffect, useId, useRef } from "react";
import { useReducedMotion } from "@/lib/motion";
import {
  applyBlink,
  bodyPath,
  contactShadow,
  eyeGlints,
  eyePaths,
  sheenEllipse,
  EXPRESSIONS,
  PARAM_KEYS,
  PEBBLE_VIEWBOX,
  PHASE_SWAY,
  shapeRoom,
  sproutPath,
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
/**
 * 着地の勢いを形のばねへ渡す割合。縦につぶれ、横に広がる。
 * 1.1 で縦に最大 8% ほどつぶれる（54px のランチャーで約 1.5px）。0.45 では
 * 3% しかつぶれず、呼吸の揺れ（±1.6%）に埋もれて目に見えなかった。
 */
const SQUASH_Y = 1.1;
const SQUASH_X = 0.75;
/**
 * viewBox からはみ出さないための上限。tests/assistant.test.mjs の余白と対。
 * 芽のぶん頭が高くなったので 5.5 から下げた。跳ねて上がるのは 3.2、呼吸を
 * 足して 3.7 なので、実際の動きはどこも削っていない。
 */
const LIFT_LIMIT = 4.5;
/** この速さ（単位/秒）で最大まで伸びる。 */
const STRETCH_SPEED = 700;
const STRETCH_MAX = 0.09;

/** 目線を振れる幅（100 単位の座標系）。 */
const GAZE_RANGE_X = 3.4;
const GAZE_RANGE_Y = 2.4;

/**
 * 芽の遅れ（wag）。体より軽いので、跳ねるときは置いていかれ、着地では
 * 追い越して戻る。減衰比 ≒ 0.41 — 体（0.87）よりはっきり残す。
 */
const WAG_STIFFNESS = 120;
const WAG_DAMPING = 9;
/** 跳び上がりと着地で芽に渡す勢い（度/秒）。 */
const WAG_ON_HOP = 150;
const WAG_ON_LAND = -190;
/** 呼吸に合わせて芽が振れる幅（度）。 */
const WAG_BREATH = 2.2;
/** これ以上は葉がちぎれて見える。 */
const WAG_LIMIT = 9;

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
  /** 外から figure ごと動かしたいとき（案内役が転がって移動する）。 */
  ref?: React.Ref<SVGSVGElement>;
};

type Parts = {
  body: SVGPathElement | null;
  sprout: SVGPathElement | null;
  shadow: SVGEllipseElement | null;
  sheen: SVGEllipseElement | null;
  left: SVGPathElement | null;
  right: SVGPathElement | null;
  glintL: SVGCircleElement | null;
  glintR: SVGCircleElement | null;
};

/**
 * いまの数値を、そのまま図形へ。
 *
 * 動いているときも止まっているときもここを通す。要素が 8 つあるので、
 * 二か所に書くと必ず片方だけ直し忘れる。
 */
function paint(parts: Parts, params: PebbleParams, phase: number, wag: number): void {
  const eyes = eyePaths(params);
  parts.body?.setAttribute("d", bodyPath(params, phase));
  parts.sprout?.setAttribute("d", sproutPath(params, phase, wag));
  parts.left?.setAttribute("d", eyes.left);
  parts.right?.setAttribute("d", eyes.right);

  const shadow = contactShadow(params);
  if (parts.shadow) {
    parts.shadow.setAttribute("cx", shadow.cx.toFixed(2));
    parts.shadow.setAttribute("cy", shadow.cy.toFixed(2));
    parts.shadow.setAttribute("rx", shadow.rx.toFixed(2));
    parts.shadow.setAttribute("ry", shadow.ry.toFixed(2));
    parts.shadow.setAttribute("opacity", shadow.alpha.toFixed(3));
  }

  const sheen = sheenEllipse(params);
  if (parts.sheen) {
    parts.sheen.setAttribute("cx", sheen.cx.toFixed(2));
    parts.sheen.setAttribute("cy", sheen.cy.toFixed(2));
    parts.sheen.setAttribute("rx", sheen.rx.toFixed(2));
    parts.sheen.setAttribute("ry", sheen.ry.toFixed(2));
  }

  const glints = eyeGlints(params);
  for (const [dot, glint] of [[parts.glintL, glints[0]], [parts.glintR, glints[1]]] as const) {
    if (!dot) continue;
    dot.setAttribute("cx", glint.cx.toFixed(2));
    dot.setAttribute("cy", glint.cy.toFixed(2));
    dot.setAttribute("opacity", glint.opacity.toFixed(3));
  }
}

const toParams = (values: Float64Array): PebbleParams => {
  const params = {} as Record<string, number>;
  PARAM_KEYS.forEach((key, index) => {
    params[key] = values[index];
  });
  return params as PebbleParams;
};

export function Pebble({ expression, size, hopKey = 0, gaze = null, className, ref }: PebbleProps) {
  const reduced = useReducedMotion();
  const bodyRef = useRef<SVGPathElement>(null);
  const sproutRef = useRef<SVGPathElement>(null);
  const shadowRef = useRef<SVGEllipseElement>(null);
  const sheenRef = useRef<SVGEllipseElement>(null);
  const leftRef = useRef<SVGPathElement>(null);
  const rightRef = useRef<SVGPathElement>(null);
  const glintLRef = useRef<SVGCircleElement>(null);
  const glintRRef = useRef<SVGCircleElement>(null);

  // グラデーションの id はページで一意にする。ランチャーとパネルと教員側に
  // 同時に出るので、同じ id だと最後に描いたものへ全部が引き寄せられる。
  const uid = useId().replace(/:/g, "");

  const parts = (): Parts => ({
    body: bodyRef.current,
    sprout: sproutRef.current,
    shadow: shadowRef.current,
    sheen: sheenRef.current,
    left: leftRef.current,
    right: rightRef.current,
    glintL: glintLRef.current,
    glintR: glintRRef.current,
  });

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
    paint(parts(), EXPRESSIONS[expression], 0, 0);
  }, [reduced, expression]);

  useEffect(() => {
    if (reduced) return;

    // ばねの状態はループの中に置く。止めて再開したときは、そのときの
    // 目標から始め直せば足りる（止まっている間は最終形を描いているので、
    // 見た目はつながる）。
    const strokeHalf = strokeFor(size) / 2;
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
    let wag = 0;
    let wagSpeed = 0;

    const tick = (now: number) => {
      const elapsed = now - origin;
      let remaining = Math.min((now - previous) / 1000, MAX_FRAME);
      previous = now;

      if (hopPending.current) {
        hopPending.current = false;
        hopSpeed = -HOP_SPEED;
        // 体が先に上がり、芽は置いていかれて後ろへ倒れる。
        wagSpeed += WAG_ON_HOP;
      }

      // 表情が変わる瞬間にまばたきを重ねる。目の形が入れ替わる途中が
      // まぶたで隠れて、切り替えが自然に見える。
      if (target.current !== shown) {
        blinkFrom = now;
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
            // 芽は逆に、止まった体を追い越して前へ振れる。
            wagSpeed += WAG_ON_LAND;
            hopHeight = 0;
            hopSpeed = 0;
          }
        }
        // 芽は 0 度へ戻ろうとする。体のばねより緩く、長く残る。
        wagSpeed += (-WAG_STIFFNESS * wag - WAG_DAMPING * wagSpeed) * step;
        wag += wagSpeed * step;
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
      const room = shapeRoom(params.lift, strokeHalf);
      params.ry = Math.min(params.ry * (1 + stretch), room.ry);
      params.rx = Math.min(params.rx * (1 - stretch * 0.6), room.rx);

      if (now >= blinkAt) {
        blinkFrom = now;
        blinkAt = now + BLINK_MIN_GAP + Math.random() * BLINK_EXTRA_GAP;
      }
      const since = now - blinkFrom;
      if (since < BLINK_MS) {
        Object.assign(params, applyBlink(params, Math.sin((since / BLINK_MS) * Math.PI)));
      }

      const sway = Math.sin((elapsed / BREATH_MS) * TAU);
      const swing = Math.max(-WAG_LIMIT, Math.min(WAG_LIMIT, wag + sway * WAG_BREATH));
      paint(parts(), params, sway * PHASE_SWAY, swing);

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [reduced, size]);

  // サーバーと最初の描画は表情そのまま。ここが揃っていれば差異は出ない。
  const initial = EXPRESSIONS[expression];
  const initialEyes = eyePaths(initial);
  const initialShadow = contactShadow(initial);
  const initialSheen = sheenEllipse(initial);
  const initialGlints = eyeGlints(initial);

  return (
    <svg
      ref={ref}
      viewBox={PEBBLE_VIEWBOX}
      width={size}
      height={size}
      className={[styles.svg, className].filter(Boolean).join(" ")}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* 石の面。左上が明るく、右下が暗い。単色で塗ると紙に見える。 */}
        <linearGradient id={`${uid}-stone`} x1="0.18" y1="0" x2="0.78" y2="1">
          <stop offset="0" className={styles.stopTop} />
          <stop offset="0.52" className={styles.stopMid} />
          <stop offset="1" className={styles.stopDeep} />
        </linearGradient>
        {/* 花びら。付け根が濃く、先へ行くほど薄い。 */}
        <linearGradient id={`${uid}-sprout`} x1="0.5" y1="1" x2="0.5" y2="0">
          <stop offset="0" className={styles.stopPetalBase} />
          <stop offset="1" className={styles.stopPetalTip} />
        </linearGradient>
        {/* 艶。輪郭のない、にじんだ光にする。 */}
        <radialGradient id={`${uid}-sheen`}>
          <stop offset="0" className={styles.stopSheenCore} />
          <stop offset="0.55" className={styles.stopSheenMid} />
          <stop offset="1" className={styles.stopSheenEdge} />
        </radialGradient>
        {/* 影。中心が濃く、ふちへ消える。ぼかし処理より軽い。 */}
        <radialGradient id={`${uid}-shadow`}>
          <stop offset="0" className={styles.stopShadowCore} />
          <stop offset="0.6" className={styles.stopShadowMid} />
          <stop offset="1" className={styles.stopShadowEdge} />
        </radialGradient>
      </defs>

      {/* 置かれているものとして読ませる、接地の影。浮くと縮んで薄くなる。 */}
      <ellipse
        ref={shadowRef}
        className={styles.shadow}
        cx={initialShadow.cx}
        cy={initialShadow.cy}
        rx={initialShadow.rx}
        ry={initialShadow.ry}
        opacity={initialShadow.alpha}
        fill={`url(#${uid}-shadow)`}
      />

      {/* 芽は体の後ろ。前に出すと、貼りつけた葉に見える。 */}
      <path
        ref={sproutRef}
        d={sproutPath(initial)}
        className={styles.sprout}
        fill={`url(#${uid}-sprout)`}
        strokeWidth={strokeFor(size)}
      />

      <path
        ref={bodyRef}
        d={bodyPath(initial)}
        className={styles.body}
        fill={`url(#${uid}-stone)`}
        strokeWidth={strokeFor(size)}
      />

      <ellipse ref={sheenRef} className={styles.sheen} fill={`url(#${uid}-sheen)`} {...initialSheen} />

      <path ref={leftRef} d={initialEyes.left} className={styles.eye} />
      <path ref={rightRef} d={initialEyes.right} className={styles.eye} />
      <circle ref={glintLRef} className={styles.glint} r="1.35" {...initialGlints[0]} />
      <circle ref={glintRRef} className={styles.glint} r="1.35" {...initialGlints[1]} />
    </svg>
  );
}
