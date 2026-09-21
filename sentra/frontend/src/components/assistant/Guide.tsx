"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "@/lib/motion";
import { bubbleShift, dwellMs, easeInOut, glideAt, glideMs, speechFor, spinFor, standingSpot, type Point, type Stand } from "@/lib/assistant/tour";
import type { Expression } from "@/lib/assistant/pebble";
import { Pebble } from "./Pebble";
import styles from "./Guide.module.css";

/**
 * 画面の中を移動する案内役。
 *
 * ランチャーから跳ねていき、示したい場所の横に立ち、そこで話して、戻る。
 * 途中の位置は transform を直接書き換えて進める（Pebble.tsx と同じ理由 —
 * 1 秒に 60 回 React を回すと学校の端末が持たない）。
 *
 * 読み上げには何も足さない。ここで出る言葉は、同じものがパネルの会話にも
 * 残っていて、そちらが live region になっている。二重に読ませないよう、
 * この層はまるごと aria-hidden。
 */

export type Trip = {
  /** 横に立って示す相手。 */
  target: HTMLElement;
  /** 立ったときに話すこと。 */
  text: string;
  /** 着いた瞬間に呼ぶ（枠を出す、押す、など）。 */
  onArrive?: () => void;
};

type Phase = "go" | "stay" | "back";

const RETURN_EXPRESSION: Expression = "rest";

/** 回転の緩急。位置と同じ曲線を使う。 */
const easedSpin = (t: number) => easeInOut(t);

export function Guide({
  trip,
  home,
  size,
  onFinished,
}: {
  trip: Trip | null;
  /** 帰る場所（ランチャーの中心）。押されるたびに測り直す。 */
  home: () => Point | null;
  size: number;
  onFinished: () => void;
}) {
  const reduced = useReducedMotion();
  const shellRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLParagraphElement>(null);
  const bodyRef = useRef<SVGSVGElement>(null);
  const [phase, setPhase] = useState<Phase>("go");
  const [expression, setExpression] = useState<Expression>("listening");
  const [look, setLook] = useState<Stand["look"]>("right");
  const [bubbleSide, setBubbleSide] = useState<Stand["bubble"]>("left");
  const [speaking, setSpeaking] = useState(false);

  // 最新の値をループから読む。ループは trip ごとに一度だけ組み立てる。
  const finish = useRef(onFinished);
  const homeAt = useRef(home);
  useEffect(() => {
    finish.current = onFinished;
    homeAt.current = home;
  });

  useEffect(() => {
    if (!trip) return;
    const shell = shellRef.current;
    if (!shell) return;

    // 回すのは小石だけ。殻ごと回すと、吹き出しまで一緒に回る。
    const place = (point: Point, spin = 0) => {
      shell.style.transform = `translate3d(${point.x - size / 2}px, ${point.y - size / 2}px, 0)`;
      const body = bodyRef.current;
      if (body) body.style.transform = spin === 0 ? "" : `rotate(${spin}deg)`;
      const bubble = bubbleRef.current;
      if (bubble) {
        bubble.style.setProperty("--shift", `${bubbleShift(point.x, bubble.offsetWidth, window.innerWidth)}px`);
      }
    };
    const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
    const spotFor = () => standingSpot(trip.target.getBoundingClientRect(), viewport(), size);

    let stand = spotFor();
    let spot: Point = { x: stand.x, y: stand.y };
    place(homeAt.current() ?? spot);

    let frame = 0;
    let timer = 0;
    let stopped = false;

    // 向きが変わったときだけ React に伝える。毎フレーム渡すと、跳ねている
    // あいだじゅう木を描き直すことになる（位置は transform で直に書く）。
    let shownLook = "";
    let shownBubble = "";
    const syncSides = () => {
      if (stand.look !== shownLook) {
        shownLook = stand.look;
        setLook(stand.look);
      }
      if (stand.bubble !== shownBubble) {
        shownBubble = stand.bubble;
        setBubbleSide(stand.bubble);
      }
    };

    const arrive = () => {
      setPhase("stay");
      // 笑わせない。指しながらにこにこしていると、説明ではなく愛嬌になる。
      setExpression("listening");
      setSpeaking(true);
      trip.onArrive?.();
      // 留まっているあいだ、相手が動いても（スクロール、折り返し）横につく。
      const follow = () => {
        if (stopped) return;
        stand = spotFor();
        spot = { x: stand.x, y: stand.y };
        place(spot);
        syncSides();
        frame = requestAnimationFrame(follow);
      };
      frame = requestAnimationFrame(follow);
      timer = window.setTimeout(goHome, dwellMs(speechFor(trip.text)));
    };

    const goHome = () => {
      if (stopped) return;
      cancelAnimationFrame(frame);
      setSpeaking(false);
      setPhase("back");
      setExpression(RETURN_EXPRESSION);
      const back = homeAt.current();
      if (reduced || !back) {
        finish.current();
        return;
      }
      run(spot, back, () => finish.current());
    };

    /**
     * 滑って移動する。進みながら回り、着く手前で緩んで、ちょうど上を向いて
     * 止まる（回る角度は整数回転なので、最後は必ず元の向きに戻る）。
     */
    const run = (from: Point, to: Point, done: () => void) => {
      const ms = glideMs(from, to);
      const spin = spinFor(from, to);
      const began = performance.now();
      const step = (now: number) => {
        if (stopped) return;
        const t = Math.min((now - began) / ms, 1);
        const point = glideAt(from, to, t);
        // 回転も同じ緩急で。位置だけ緩めると、止まってから回り続けて見える。
        place(point, spin * (point.x - from.x === 0 && point.y - from.y === 0 ? 0 : easedSpin(t)));
        if (t < 1) {
          frame = requestAnimationFrame(step);
          return;
        }
        place(to, 0);
        done();
      };
      frame = requestAnimationFrame(step);
    };

    // 状態を書くのは effect の本体より後にする（React Compiler の
    // set-state-in-effect）。位置を置くのは DOM への書き込みなので、ここで
    // 済ませてよい — 動きを減らす設定のとき、次のフレームを待っていると、
    // 描画が間引かれている端末では隅にいる時間が一拍生まれる。
    if (reduced) {
      // 動かさずに、そこへ現れる。示す仕事は同じだけ果たす。
      place(spot);
      timer = window.setTimeout(() => {
        if (stopped) return;
        syncSides();
        arrive();
      }, 0);
    } else {
      frame = requestAnimationFrame(() => {
        if (stopped) return;
        syncSides();
        setPhase("go");
        setExpression("listening");
        run(homeAt.current() ?? spot, spot, arrive);
      });
    }

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [trip, size, reduced]);

  if (!trip) return null;

  return (
    <div ref={shellRef} className={styles.shell} style={{ width: size, height: size }} aria-hidden="true">
      <Pebble
        ref={bodyRef}
        expression={expression}
        size={size}
        gaze={phase === "stay" ? GAZE[look] : null}
      />
      {speaking && (
        <p ref={bubbleRef} className={styles.bubble} data-side={bubbleSide}>
          {speechFor(trip.text)}
        </p>
      )}
    </div>
  );
}

/** 立った先で、示している相手のほうを見る。 */
const GAZE = {
  left: { x: -0.9, y: 0.1 },
  right: { x: 0.9, y: 0.1 },
  down: { x: 0, y: 0.9 },
} as const;
