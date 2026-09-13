"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { DisplaySettings } from "@/components/a11y/DisplaySettings";
import { useTransitionNavigate } from "@/components/ui/Transition";
import { resetA11y, setA11y, useA11y } from "@/lib/a11y";
import { useReducedMotion } from "@/lib/motion";
import { assessSafety } from "@/lib/safety-assessment";
import { pilotProgress, usePilotToday } from "@/lib/blesc/pilot";
import {
  routeIntent,
  SUGGESTIONS,
  type AssistantAction,
  type AssistantOffer,
  type AssistantReply,
} from "@/lib/assistant/intents";
import type { Expression } from "@/lib/assistant/pebble";
import { HANDOFF_KEY } from "@/lib/assistant/handoff";
import { Pebble } from "./Pebble";
import styles from "./Assistant.module.css";

/**
 * 画面の隅にいる案内役。
 *
 * できることは 2 つだけ — ページを開くことと、見え方を変えること。
 * 悩みを聞く役は持たせていない。それは /chat が同意と記録の仕組みごと
 * 引き受けている仕事で、ここに 2 つ目の窓口を作ると、相談の中身が
 * どこにも残らないまま漏れていく。気持ちの話だと分かった時点で渡す。
 *
 * 置き場所は AuthShell。ページの外側にいるので、案内して画面が変わっても
 * 会話はそのまま残る。
 */

const PANEL_MAX = 18;

/** 返事を出すまでの間。打った言葉が画面に出るのを見てから次に進むため。 */
const BEAT_MS = 240;

/** 表情を rest に戻すまで。 */
const SETTLE_MS = 2400;

/** この幅より狭いとパネルが画面をほぼ覆う。案内したら閉じて道を空ける。 */
const NARROW = "(max-width: 640px)";

/** 閉じる動きの長さ。CSS の panel-out と揃える。 */
const EXIT_MS = 180;

/** 打つ手が止まってから、目線を戻すまで。 */
const TYPING_IDLE_MS = 900;

/**
 * 目線の向き（-1〜1）。ランチャーはパネルの右下にいるので、パネルを見るとき
 * は左上、入力欄を見るときは左。パネルの中の小石は入力欄を見下ろす。
 */
const LOOK_AT_PANEL = { x: -0.6, y: -0.7 };
const LOOK_AT_INPUT = { x: -0.95, y: -0.3 };
const LOOK_DOWN_AT_INPUT = { x: 0.15, y: 1 };

type Entry = {
  id: string;
  role: "student" | "pebble";
  text: string;
  offers?: readonly AssistantOffer[];
  calm?: boolean;
};

let sequence = 0;
const nextId = () => `a${(sequence += 1)}`;

export function Assistant() {
  const pathname = usePathname();
  const navigate = useTransitionNavigate();
  const settings = useA11y();
  const reduced = useReducedMotion();
  const today = usePilotToday();

  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState("");
  const [expression, setExpression] = useState<Expression>("rest");
  const [hopKey, setHopKey] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // 指やカーソルが乗っている、またはフォーカスがある。小石がこちらを向く。
  const [attending, setAttending] = useState(false);
  // 閉じる動きの最中。見た目はまだ出ているが、操作の上ではもう閉じている。
  const [closing, setClosing] = useState(false);
  const [typing, setTyping] = useState(false);
  const expanded = open && !closing;

  const panelId = useId();
  const launcherRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const timers = useRef(new Set<number>());
  const settleTimer = useRef(0);
  const exitTimer = useRef(0);
  const typingTimer = useRef(0);

  const later = useCallback((run: () => void, delay: number) => {
    const id = window.setTimeout(() => {
      timers.current.delete(id);
      run();
    }, delay);
    timers.current.add(id);
  }, []);

  /**
   * 少し経ったら待機の顔に戻す。
   * 予約は常に 1 つだけにする。返事が続いたとき、前の返事の予約が残って
   * いると、新しい表情を途中で打ち消してしまう。
   */
  const settle = useCallback(() => {
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => setExpression("rest"), SETTLE_MS);
  }, []);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(window.clearTimeout);
      window.clearTimeout(settleTimer.current);
      window.clearTimeout(exitTimer.current);
      window.clearTimeout(typingTimer.current);
    };
  }, []);

  // 開いたら入力へ、閉じたらランチャーへ。閉じたあと行き場を失わないように。
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const close = useCallback(() => {
    launcherRef.current?.focus();
    window.clearTimeout(exitTimer.current);
    if (reduced) {
      setOpen(false);
      return;
    }
    // フォーカスとボタンの状態はすぐに戻し、見た目だけ縮む動きを見せてから
    // 消す。読み上げには、押した瞬間に閉じたと伝わる。
    setClosing(true);
    exitTimer.current = window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, EXIT_MS);
  }, [reduced]);

  const openPanel = useCallback(() => {
    window.clearTimeout(exitTimer.current);
    setClosing(false);
    setOpen(true);
    // パネルを放り出すように一度跳ねる。
    setHopKey((key) => key + 1);
    // 閉じかけを開き直したときは open が変わらず effect が走らないので、ここでも入れる。
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // 表示設定のダイアログが開いているときの Esc は、ダイアログが自分で
      // 受けて閉じる。ここでも拾うとパネルまで閉じ、フォーカスの戻り先を
      // ダイアログと奪い合う。
      if (event.key === "Escape" && !settingsOpen) close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [expanded, close, settingsOpen]);

  // 会話が伸びたら最後まで送る。
  useEffect(() => {
    const thread = threadRef.current;
    if (thread) thread.scrollTo({ top: thread.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [entries, reduced]);

  const run = useCallback(
    (action: AssistantAction) => {
      switch (action.kind) {
        case "navigate":
          navigate(action.href);
          // 狭い画面ではパネルが行き先を隠す。案内したら引っ込む。
          if (window.matchMedia(NARROW).matches) close();
          break;
        case "display":
          setA11y(action.patch);
          break;
        case "reset-display":
          resetA11y();
          break;
        case "open-settings":
          setSettingsOpen(true);
          break;
        case "handoff":
          // 打った言葉は URL に載せない。相談ページが一度だけ読んで消す。
          try {
            window.sessionStorage.setItem(HANDOFF_KEY, action.text);
          } catch {
            // 保存できなくても移動はする。下書きが引き継がれないだけ。
          }
          navigate("/chat");
          if (window.matchMedia(NARROW).matches) close();
          break;
      }
    },
    [navigate, close],
  );

  const respond = useCallback(
    (reply: AssistantReply) => {
      setEntries((current) =>
        [...current, { id: nextId(), role: "pebble" as const, text: reply.say, offers: reply.offers, calm: reply.calm }].slice(-PANEL_MAX),
      );
      setExpression(reply.expression);
      // 落ち着けたい場面で跳ねさせない。
      if (!reply.calm) setHopKey((key) => key + 1);
      reply.actions.forEach(run);
      settle();
      setBusy(false);
    },
    [run, settle],
  );

  const ask = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text || busy) return;

      setEntries((current) => [...current, { id: nextId(), role: "student" as const, text }].slice(-PANEL_MAX));
      setDraft("");
      setBusy(true);
      setExpression("thinking");

      const reply = routeIntent(text, {
        pathname,
        settings,
        pilot: today ? pilotProgress(today) : null,
        safety: assessSafety(text),
        turn: entries.filter((entry) => entry.role === "student").length,
      });

      // 間を置くのは、打った言葉が画面に出て、小石が反応するのを
      // 見てから画面が変わるようにするため。動きを減らす設定の人には
      // ただの遅延でしかないので、そのまま返す。
      if (reduced) respond(reply);
      else later(() => respond(reply), BEAT_MS);
    },
    [busy, pathname, settings, today, reduced, respond, later, entries],
  );

  const act = useCallback(
    (offer: AssistantOffer) => {
      if (offer.action.kind === "help") {
        respond(routeIntent("使い方", { pathname, settings, pilot: null, safety: assessSafety(""), turn: 0 }));
        return;
      }
      run(offer.action);
      setHopKey((key) => key + 1);
      setExpression("happy");
      settle();
    },
    [run, respond, pathname, settings, settle],
  );

  return (
    <>
      <button
        type="button"
        ref={launcherRef}
        className={styles.launcher}
        data-bl-assistant=""
        onPointerEnter={() => setAttending(true)}
        onPointerLeave={() => setAttending(false)}
        onFocus={() => setAttending(true)}
        onBlur={() => setAttending(false)}
        aria-expanded={expanded}
        aria-controls={panelId}
        aria-label={expanded ? "blescの案内役を閉じる" : "blescの案内役を開く"}
        onClick={() => (expanded ? close() : openPanel())}
      >
        <Pebble
          expression={expanded || attending ? "listening" : expression}
          size={54}
          hopKey={hopKey}
          gaze={expanded ? (typing ? LOOK_AT_INPUT : LOOK_AT_PANEL) : null}
        />
      </button>

      <div
        id={panelId}
        className={styles.panel}
        role="dialog"
        aria-label="blescの案内役"
        hidden={!open}
        data-closing={closing ? "" : undefined}
      >
        <div className={styles.head}>
          <Pebble
            expression={expression}
            size={30}
            hopKey={hopKey}
            gaze={typing ? LOOK_DOWN_AT_INPUT : null}
            className={styles.headPebble}
          />
          <div>
            <p className={styles.headName}>blescの案内役</p>
            <p className={styles.headRole}>ページの移動と、見え方の調整</p>
          </div>
          <button type="button" className={`bl-icon-btn ${styles.close}`} onClick={close} aria-label="閉じる">
            <Icon name="close" size={20} />
          </button>
        </div>

        <div className={styles.thread} ref={threadRef} role="log" aria-live="polite">
          {entries.length === 0 ? (
            <div className={styles.intro}>
              <p className={styles.introText}>
                行きたいページや、読みにくいところを教えてください。
              </p>
              <ul className={styles.suggestions}>
                {SUGGESTIONS.map((suggestion, index) => (
                  <li key={suggestion.label} style={{ "--i": index } as React.CSSProperties}>
                    <button
                      type="button"
                      className="bl-choice"
                      onClick={() => {
                        ask(suggestion.label);
                        inputRef.current?.focus();
                      }}
                    >
                      <Icon name={suggestion.icon} size={17} />
                      {suggestion.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            entries.map((entry) => (
              <div key={entry.id} className={styles.turn} data-role={entry.role}>
                <p className={styles.bubble} data-calm={entry.calm ? "true" : undefined}>
                  {entry.text}
                </p>
                {entry.offers && entry.offers.length > 0 && (
                  <ul className={styles.offers}>
                    {entry.offers.map((offer, index) => (
                      <li key={offer.label} style={{ "--i": index } as React.CSSProperties}>
                        <button type="button" className="bl-choice" onClick={() => act(offer)}>
                          <Icon name={offer.icon} size={17} />
                          {offer.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))
          )}
        </div>

        {/* 注記は入力欄の上に置く。入力欄をパネルの下の角に接させないと、
            角の丸みが入力欄のピルと同心にならない。 */}
        <p className={styles.note}>ここでの言葉は端末の外に出ません。相談は「相談」のページで。</p>

        <form
          className={styles.foot}
          onSubmit={(event) => {
            event.preventDefault();
            ask(draft);
          }}
        >
          <input
            ref={inputRef}
            className={styles.input}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              // 打っている間は、小石が入力欄を見る。
              setTyping(true);
              window.clearTimeout(typingTimer.current);
              typingTimer.current = window.setTimeout(() => setTyping(false), TYPING_IDLE_MS);
            }}
            placeholder="日記、文字を大きく…"
            aria-label="案内役に伝えたいこと"
            enterKeyHint="send"
            autoComplete="off"
          />
          <button type="submit" className={styles.send} disabled={!draft.trim() || busy} aria-label="送信">
            <svg viewBox="0 0 100 100" className={styles.sendShape} aria-hidden="true">
              <path
                d="M50 10 L90 41 L74 90 L26 90 L10 41 Z"
                fill="currentColor"
                stroke="currentColor"
                strokeWidth="16"
                strokeLinejoin="round"
              />
            </svg>
            <Icon name="arrow_forward" size={16} className={styles.sendIcon} />
          </button>
        </form>

      </div>

      <DisplaySettings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}
