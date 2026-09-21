"use client";

/**
 * ラスクくんの紹介ページ（チームで見るための一時的なもの）。
 *
 * 製品の画面ではない。案内役がどんな顔をして、どう動いて、どこから来た名前
 * なのかを、一枚で見せるだけの場所。役目が済んだら消す。
 *
 * 置き場所は demo-view の書き出しの中。blesc.online/meet-rusk からは、main
 * 側の rewrite でここへ繋いでいる。
 */

import { useEffect, useRef, useState } from "react";
import { Pebble } from "@/components/assistant/Pebble";
import { EXPRESSIONS, type Expression } from "@/lib/assistant/pebble";
import { easeInOut, glideMs, spinFor } from "@/lib/assistant/tour";
import { useReducedMotion } from "@/lib/motion";

const FACES: ReadonlyArray<{ id: Expression; label: string; when: string }> = [
  { id: "rest", label: "待機", when: "呼ばれるまで。ときどきよそ見をします" },
  { id: "listening", label: "聞いている", when: "触れられたとき、打ちこんでいるとき" },
  { id: "thinking", label: "考え中", when: "返事を考えている数百ミリ秒" },
  { id: "bright", label: "できた", when: "案内できたとき。笑いません（弾むだけ）" },
  { id: "oops", label: "分からない", when: "聞き取れなかったとき" },
  { id: "steady", label: "落ち着いて", when: "つらさが混じった言葉を受け取ったとき" },
];

const PALETTE = [
  { name: "上の面", value: "var(--bl-pebble-lit)" },
  { name: "地の色", value: "var(--bl-pebble)" },
  { name: "下の面", value: "var(--bl-pebble-deep)" },
  { name: "影", value: "var(--bl-pebble-shade)" },
  { name: "花びら", value: "var(--bl-pebble-petal)" },
  { name: "目", value: "var(--bl-pebble-eye)" },
];

export default function MeetRusk() {
  const reduced = useReducedMotion();
  const [face, setFace] = useState<Expression>("rest");
  const [hopKey, setHopKey] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const runnerRef = useRef<HTMLDivElement>(null);
  const spinnerRef = useRef<SVGSVGElement>(null);
  const [rolling, setRolling] = useState(false);

  // 「転がってみる」。案内役が画面を移動するときと同じ式を使う。
  useEffect(() => {
    if (!rolling) return;
    const track = trackRef.current;
    const runner = runnerRef.current;
    if (!track || !runner) return;

    const span = track.clientWidth - runner.clientWidth;
    const from = { x: 0, y: 0 };
    const to = { x: span, y: 0 };
    if (reduced) {
      // 動かさずに、向こう側へ置く。状態は次の周で戻す（effect の本体で
      // 書くと、その場でもう一度描き直しが起きる）。
      runner.style.transform = `translate3d(${span}px, 0, 0)`;
      const settle = window.setTimeout(() => setRolling(false), 0);
      return () => window.clearTimeout(settle);
    }

    const ms = glideMs(from, to);
    const spin = spinFor(from, to);
    const began = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min((now - began) / ms, 1);
      const eased = easeInOut(t);
      runner.style.transform = `translate3d(${span * eased}px, 0, 0)`;
      if (spinnerRef.current) spinnerRef.current.style.transform = `rotate(${spin * eased}deg)`;
      if (t < 1) {
        frame = requestAnimationFrame(step);
        return;
      }
      // 端まで行ったら、少し待って戻る。
      window.setTimeout(() => {
        const back = performance.now();
        const home = (now2: number) => {
          const t2 = Math.min((now2 - back) / ms, 1);
          const eased2 = easeInOut(t2);
          runner.style.transform = `translate3d(${span * (1 - eased2)}px, 0, 0)`;
          if (spinnerRef.current) spinnerRef.current.style.transform = `rotate(${-spin * eased2 + spin}deg)`;
          if (t2 < 1) frame = requestAnimationFrame(home);
          else {
            if (spinnerRef.current) spinnerRef.current.style.transform = "";
            setRolling(false);
          }
        };
        frame = requestAnimationFrame(home);
      }, 420);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [rolling, reduced]);

  const params = EXPRESSIONS[face];

  return (
    <main className="meet">
      <header className="hero">
        <div className="heroPebble">
          <Pebble expression={face} size={210} hopKey={hopKey} />
        </div>
        <div>
          <p className="kicker">blesc の案内役</p>
          <h1 className="title">はじめまして、ラスクくんです</h1>
          <p className="lede">
            画面の隅にいて、行きたいページへ連れていったり、画面に出ている言葉の意味を、
            その場所まで行って説明したりします。相談ごとは引き受けません — それは「相談」の
            ページが、同意と記録の仕組みごと引き受けている仕事だからです。
          </p>
          <div className="actions">
            <button type="button" className="bl-btn bl-btn--primary" onClick={() => setHopKey((key) => key + 1)}>
              つついてみる
            </button>
            <button type="button" className="bl-btn bl-btn--secondary" onClick={() => setRolling(true)} disabled={rolling}>
              転がってみる
            </button>
          </div>
        </div>
      </header>

      <section className="panelCard">
        <h2 className="h2">名前のこと</h2>
        <p className="body">
          b<b>l</b>esc の <b>l</b> と、<b>ask</b>（聞く）から。呼ぶときは「ラスクくん」、
          自分で名乗るときは「ラスクです」— 自分に「くん」は付けません。
        </p>
        <p className="mono">b·l·esc ＋ a·s·k → ラスク</p>
      </section>

      <section className="track" ref={trackRef}>
        <div className="runner" ref={runnerRef}>
          <Pebble ref={spinnerRef} expression={rolling ? "listening" : "rest"} size={72} />
        </div>
      </section>

      <section className="panelCard">
        <h2 className="h2">顔は6つ</h2>
        <p className="body">
          絵を描き替えているのではありません。輪郭も目も12個の数字で決まっていて、その数字を
          ばねで引っぱっています。だから途中の姿が全部あって、切り替わる瞬間が見えません。
        </p>
        <ul className="faces">
          {FACES.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="faceBtn"
                data-active={face === item.id ? "" : undefined}
                onClick={() => {
                  setFace(item.id);
                  setHopKey((key) => key + 1);
                }}
              >
                <Pebble expression={item.id} size={64} />
                <span className="faceName">{item.label}</span>
                <span className="faceWhen">{item.when}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="mono">
          いまの数字： rx {params.rx} / ry {params.ry} / 傾き {params.lean}° / 目の幅 {params.eyeRx} / 目の間隔 {params.eyeGap}
        </p>
      </section>

      <section className="panelCard">
        <h2 className="h2">色</h2>
        <p className="body">
          画面の青（ボタンや入力欄）より明るく、少しだけ緑へ振ってあります。同じ色相のまま
          明るくすると、どれだけ陰影を付けてもボタンの仲間に見えてしまうためです。
        </p>
        <ul className="swatches">
          {PALETTE.map((tone) => (
            <li key={tone.name}>
              <span className="chip" style={{ background: tone.value }} />
              {tone.name}
            </li>
          ))}
        </ul>
      </section>

      <section className="panelCard">
        <h2 className="h2">しないこと</h2>
        <ul className="dont">
          <li>笑いません。指しながらにこにこしていると、説明ではなく愛嬌になるので。</li>
          <li>口はありません。顔で気分を採点しているように見せないためです。</li>
          <li>つらさが混じった言葉には、跳ねも回りもしません。落ち着いた顔で、すぐに返します。</li>
          <li>ここで打った言葉は、端末の外に出ません。</li>
        </ul>
      </section>

      <footer className="foot">
        <a className="bl-btn bl-btn--ghost" href="/demo-view">デモ表示へ</a>
        <p className="micro">チームで見るための一時的なページです。固定データ・API なし。</p>
      </footer>

      <style>{`
        .meet {
          max-width: 860px;
          margin: 0 auto;
          padding: 40px 20px 72px;
          display: flex;
          flex-direction: column;
          gap: 22px;
        }
        .hero { display: flex; gap: 28px; align-items: center; flex-wrap: wrap; }
        .heroPebble { flex: none; }
        .kicker { margin: 0 0 4px; font-size: 0.78rem; letter-spacing: 0.08em; color: var(--bl-ink-3); }
        .title { margin: 0 0 10px; font-size: 1.7rem; line-height: 1.35; color: var(--bl-ink); }
        .lede { margin: 0 0 16px; font-size: 0.95rem; line-height: 1.85; color: var(--bl-ink-2); max-width: 46ch; }
        .actions { display: flex; gap: 10px; flex-wrap: wrap; }

        .panelCard {
          background: var(--bl-surface);
          border: 1px solid var(--bl-line);
          border-radius: var(--bl-radius);
          padding: 20px 22px;
        }
        .h2 { margin: 0 0 8px; font-size: 1.05rem; color: var(--bl-ink); }
        .body { margin: 0 0 12px; font-size: 0.92rem; line-height: 1.85; color: var(--bl-ink-2); }
        .mono {
          margin: 10px 0 0; font-size: 0.78rem; color: var(--bl-ink-3);
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        }

        .track {
          position: relative;
          height: 96px;
          border-radius: var(--bl-radius);
          background: linear-gradient(var(--bl-mist), var(--bl-surface));
          border: 1px solid var(--bl-line-soft);
          overflow: hidden;
        }
        .runner { position: absolute; left: 10px; bottom: 10px; width: 72px; height: 72px; }

        .faces { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
        .faceBtn {
          width: 100%; display: grid; grid-template-columns: 64px 1fr; grid-template-rows: auto auto;
          gap: 2px 12px; align-items: center; text-align: left;
          padding: 10px; border-radius: var(--bl-radius-inner); border: 1px solid var(--bl-line-soft);
          background: var(--bl-surface); cursor: pointer;
        }
        .faceBtn:hover { border-color: var(--bl-blue); background: var(--bl-mist); }
        .faceBtn[data-active] { border-color: var(--bl-blue-strong); background: var(--bl-mist); }
        .faceBtn svg { grid-row: span 2; }
        .faceName { font-size: 0.88rem; color: var(--bl-ink); align-self: end; }
        .faceWhen { font-size: 0.74rem; line-height: 1.5; color: var(--bl-ink-3); align-self: start; }

        .swatches { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 14px; font-size: 0.8rem; color: var(--bl-ink-2); }
        .swatches li { display: flex; align-items: center; gap: 7px; }
        .chip { width: 22px; height: 22px; border-radius: 7px; border: 1px solid hsl(var(--bl-hue) 30% 80% / 0.6); }

        .dont { margin: 0; padding-left: 1.1em; font-size: 0.9rem; line-height: 1.9; color: var(--bl-ink-2); }

        .foot { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
        .micro { margin: 0; font-size: 0.74rem; color: var(--bl-ink-3); }

        @media (max-width: 640px) {
          .title { font-size: 1.4rem; }
          .heroPebble svg { width: 150px; height: 150px; }
        }
      `}</style>
    </main>
  );
}
