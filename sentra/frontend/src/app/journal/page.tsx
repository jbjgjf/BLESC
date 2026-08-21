"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Icon } from "@/components/ui/Icon";
import { FlowerBloom } from "@/components/ui/FlowerBloom";
import { TransitionLink } from "@/components/ui/Transition";
import { WaveBed } from "@/components/ui/WaveBed";
import { useCountUp } from "@/lib/motion";
import { CATEGORIES, MOODS, TODAY, formatDate } from "@/lib/blesc/labels";
import type { EventCategory, Mood } from "@/lib/blesc/types";
import styles from "./journal.module.css";

/* ── 4-6 対話型AIサポートの台本 ─────────────────────────────
   AIは問い詰めるためのものではない。どの設問にも「答えたくない」
   「分からない」を用意し、いつでも終了できる。 */

type Step = {
  id: string;
  question: string;
  /** 選択式なら選択肢、自由記述なら null */
  choices: string[] | null;
  placeholder?: string;
};

const STEPS: Step[] = [
  {
    id: "topic",
    question: "特に気になった出来事はありましたか。",
    choices: [
      "勉強や課題",
      "友人関係",
      "部活動",
      "家庭",
      "体調や睡眠",
      "まだ整理できない",
      "話したくない",
    ],
  },
  {
    id: "detail",
    question: "どのようなことがありましたか。話せる範囲で記録してください。",
    choices: null,
    placeholder: "書ける範囲で大丈夫です",
  },
  {
    id: "duration",
    question: "そのように感じる出来事は今日だけでしたか。それとも最近も続いていますか。",
    choices: ["今日だけ", "数日前から続いている", "以前から続いている", "分からない", "答えたくない"],
  },
];

/** これ以上聞かずに終える回答 */
const STOP_ANSWERS = new Set(["話したくない", "まだ整理できない", "答えたくない"]);

type Turn = { role: "ai" | "student"; text: string };

/**
 * 入力は 1 問ずつ出す。長い一枚のフォームは、しんどい日ほど「全部埋めないと
 * いけない」という圧になる。ひとつ答えれば次に進めるほうが、書き始めやすい。
 */
type FormStep = "mood" | "events" | "note";

const FORM_STEPS: FormStep[] = ["mood", "events", "note"];

const STEP_TITLE: Record<FormStep, string> = {
  mood: "今日の気分",
  events: "今日あった出来事",
  note: "今日のこと",
};

export default function JournalPage() {
  const [mood, setMood] = useState<Mood | null>(null);
  const [categories, setCategories] = useState<EventCategory[]>([]);
  const [body, setBody] = useState("");
  const [showErrors, setShowErrors] = useState(false);

  const [phase, setPhase] = useState<"form" | "followup" | "done">("form");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [thinking, setThinking] = useState(false);
  const [detailDraft, setDetailDraft] = useState("");

  const [step, setStep] = useState<FormStep>("mood");
  const stepRef = useRef<HTMLFieldSetElement>(null);
  const advanceTimer = useRef<number | null>(null);
  const isFirstRender = useRef(true);

  const followUpRef = useRef<HTMLDivElement>(null);
  const moodError = showErrors && mood === null;
  const categoryError = showErrors && categories.length === 0;

  // 進んだ先を読み上げてもらうため、切り替わったときだけ焦点を移す。
  // 最初の表示で動かすと、開いた瞬間に読み上げが走ってしまう。
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    stepRef.current?.focus();
  }, [step]);

  useEffect(() => () => {
    if (advanceTimer.current) window.clearTimeout(advanceTimer.current);
  }, []);

  /**
   * 自動で進む予約を取り消す。手で操作したのに、あとから予約が発火して
   * 画面が勝手に戻る — という事故を防ぐ。
   */
  const clearAdvance = () => {
    if (advanceTimer.current) {
      window.clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
  };

  /** 気分は 1 つだけ選ぶので、選んだ手ごたえが見えたら自動で次へ進む。 */
  const chooseMood = (value: Mood) => {
    setMood(value);
    setShowErrors(false);
    clearAdvance();
    advanceTimer.current = window.setTimeout(() => setStep("events"), 300);
  };

  const goNext = () => {
    clearAdvance();
    if (step === "mood") {
      if (mood === null) {
        setShowErrors(true);
        return;
      }
      setStep("events");
      return;
    }
    if (step === "events") {
      if (categories.length === 0) {
        setShowErrors(true);
        return;
      }
      setStep("note");
    }
  };

  const goBack = () => {
    clearAdvance();
    setShowErrors(false);
    setStep((current) => (current === "note" ? "events" : "mood"));
  };

  const toggleCategory = (value: EventCategory) => {
    setCategories((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    );
  };

  /** 日記の内容から、AIによる補足が必要かを判定する（4-7）。 */
  const needsFollowUp = useCallback(() => {
    if (mood === "hard" || mood === "low") return true;
    // 本文が短いと、日記だけでは背景を把握できない
    const written = body.trim();
    return written.length > 0 && written.length < 24;
  }, [body, mood]);

  const askStep = useCallback((index: number) => {
    const step = STEPS[index];
    if (!step) {
      setPhase("done");
      return;
    }
    setThinking(true);
    window.setTimeout(() => {
      setThinking(false);
      setStepIndex(index);
      setTurns((current) => [...current, { role: "ai", text: step.question }]);
    }, 1100);
  }, []);

  const submit = () => {
    // ここへ来る前に止まるはずだが、戻って消した場合に備えて設問まで戻す。
    if (mood === null) {
      setShowErrors(true);
      setStep("mood");
      return;
    }
    if (categories.length === 0) {
      setShowErrors(true);
      setStep("events");
      return;
    }
    if (needsFollowUp()) {
      setPhase("followup");
      askStep(0);
    } else {
      setPhase("done");
    }
  };

  const answer = (text: string) => {
    setTurns((current) => [...current, { role: "student", text }]);
    setDetailDraft("");
    if (STOP_ANSWERS.has(text)) {
      window.setTimeout(() => {
        setTurns((current) => [
          ...current,
          { role: "ai", text: "わかりました。話したくなったら、いつでも聞かせてください。" },
        ]);
        window.setTimeout(() => setPhase("done"), 900);
      }, 700);
      return;
    }
    askStep(stepIndex + 1);
  };

  useEffect(() => {
    if (phase === "followup") {
      followUpRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [phase, turns, thinking]);

  const currentStep = STEPS[stepIndex];
  const awaitingAnswer =
    phase === "followup" && !thinking && turns.length > 0 && turns[turns.length - 1].role === "ai";

  /* ── 提出完了 ─────────────────────────────────────── */
  if (phase === "done") return <DoneScreen />;

  /* ── 入力フォーム（1問ずつ） ───────────────────────── */
  const formStepIndex = FORM_STEPS.indexOf(step);
  const isNoteStep = step === "note";

  return (
    <div className="bl-wrap bl-stack">
      <header className={styles.head}>
        <h1 className="bl-h1">今日の日記</h1>
        <p className="bl-meta">{formatDate(TODAY)}</p>
      </header>

      {phase === "form" && (
        <>
          <div className={styles.progress}>
            <div
              className={styles.progressTrack}
              role="progressbar"
              aria-valuemin={1}
              aria-valuemax={FORM_STEPS.length}
              aria-valuenow={formStepIndex + 1}
              aria-label="入力の進み具合"
            >
              {FORM_STEPS.map((name, index) => (
                <span key={name} className={styles.progressSeg} data-done={index <= formStepIndex} />
              ))}
            </div>
            <span className="bl-micro">
              {formStepIndex + 1} / {FORM_STEPS.length}
            </span>
          </div>

          {/* key を変えて作り直すことで、設問ごとに入り込む動きがつく。 */}
          <fieldset
            key={step}
            ref={stepRef}
            tabIndex={-1}
            aria-label={STEP_TITLE[step]}
            className={`bl-card ${styles.step} bl-rise`}
          >
            {step === "mood" && (
              <>
                {/* ── 4-2 感情（必須） ─────────────────── */}
                <div className="bl-label">
                  <Icon name="mood" size={20} />
                  今日の気分
                  <span className="bl-required">必須</span>
                </div>
                <p className="bl-meta" style={{ marginTop: -4, marginBottom: 11 }}>
                  いちばん近いものをひとつ選んでください。
                </p>

                <div className={styles.moods} role="radiogroup" aria-label="今日の気分">
                  {MOODS.map((option) => {
                    const selected = mood === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-label={option.label}
                        className={styles.mood}
                        data-selected={selected}
                        style={
                          selected
                            ? { background: option.tint, borderColor: option.color, color: option.color }
                            : undefined
                        }
                        onClick={() => chooseMood(option.value)}
                      >
                        <Icon name={option.icon} size={34} fill={selected} />
                        <span>{option.label}</span>
                      </button>
                    );
                  })}
                </div>
                {moodError && (
                  <p role="alert" className={styles.error}>
                    <Icon name="error" size={16} fill />
                    今日の気分を選んでください。
                  </p>
                )}
              </>
            )}

            {step === "events" && (
              <>
                {/* ── 4-3 出来事（必須） ───────────────── */}
                <div className="bl-label">
                  <Icon name="calendar_month" size={20} />
                  今日あった出来事
                  <span className="bl-required">必須</span>
                </div>
                <p className="bl-meta" style={{ marginTop: -4, marginBottom: 11 }}>
                  あてはまるものをすべて選べます。
                </p>

                <div className={styles.categories}>
                  {CATEGORIES.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className="bl-choice"
                      aria-pressed={categories.includes(option.value)}
                      onClick={() => {
                        toggleCategory(option.value);
                        setShowErrors(false);
                      }}
                    >
                      <Icon name={option.icon} size={19} fill={categories.includes(option.value)} />
                      {option.label}
                    </button>
                  ))}
                </div>
                {categoryError && (
                  <p role="alert" className={styles.error}>
                    <Icon name="error" size={16} fill />
                    出来事を1つ以上選んでください。
                  </p>
                )}
              </>
            )}

            {step === "note" && (
              <>
                {/* ── 4-1 記述項目（任意） ─────────────── */}
                <label className="bl-label" htmlFor="body">
                  <Icon name="edit_note" size={20} />
                  今日のこと
                  <span className="bl-optional">任意</span>
                </label>
                <p className="bl-meta" style={{ marginTop: -4, marginBottom: 11 }}>
                  あったこと、印象に残ったこと、悩んでいること — 書きたいことだけ、自由に書いてください。
                </p>
                <textarea
                  id="body"
                  className={`bl-textarea ${styles.bodyInput}`}
                  placeholder="どんな一日でしたか"
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                />
                <p className="bl-micro" style={{ marginTop: 9 }}>
                  書きたくないことは、書かなくて大丈夫です。
                </p>
              </>
            )}
          </fieldset>

          <div className={styles.stepBar}>
            <p className="bl-disclaimer">
              <Icon name="lock" size={15} />
              日記は先生に全文が見えるわけではありません。
            </p>

            <div className={styles.stepNav}>
              {formStepIndex > 0 && (
                <button type="button" className="bl-btn bl-btn--ghost" onClick={goBack}>
                  <Icon name="arrow_back" size={18} />
                  戻る
                </button>
              )}

              {isNoteStep ? (
                <button type="button" className="bl-btn bl-btn--primary bl-btn--lg" onClick={submit}>
                  <Icon name="check" size={20} />
                  {body.trim() ? "日記を提出する" : "書かずに提出する"}
                </button>
              ) : (
                <button type="button" className="bl-btn bl-btn--primary bl-btn--lg" onClick={goNext}>
                  次へ
                  <Icon name="arrow_forward" size={18} />
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── 4-6 対話型AIサポート ─────────────────── */}
      {phase === "followup" && (
        <section ref={followUpRef} className={`${styles.followUp} bl-pop`}>
          <WaveBed active={thinking} height={140} />

          <div className={styles.followUpHead}>
            <Image src="/flower.png" alt="" width={30} height={30} />
            <div>
              <h2 className="bl-h3">もう少しだけ教えてください</h2>
              <p className="bl-micro">答えたくない質問は飛ばして大丈夫です。</p>
            </div>
            <button
              type="button"
              className="bl-icon-btn"
              aria-label="ここで終える"
              onClick={() => setPhase("done")}
            >
              <Icon name="close" size={20} />
            </button>
          </div>

          <div className={styles.turns}>
            {turns.map((turn, index) => (
              <div
                key={`${turn.role}-${index}`}
                className={`${styles.turn} ${turn.role === "student" ? styles.turnStudent : ""} bl-pop`}
              >
                {turn.text}
              </div>
            ))}

            {thinking && (
              <div className={`${styles.turn} ${styles.typing}`} aria-label="blescが考えています">
                <span />
                <span />
                <span />
              </div>
            )}
          </div>

          {awaitingAnswer && currentStep && (
            <div className={styles.answers}>
              {currentStep.choices ? (
                currentStep.choices.map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    className="bl-choice"
                    onClick={() => answer(choice)}
                  >
                    {choice}
                  </button>
                ))
              ) : (
                <div className={styles.answerInput}>
                  <textarea
                    className="bl-textarea"
                    rows={2}
                    placeholder={currentStep.placeholder}
                    value={detailDraft}
                    onChange={(event) => setDetailDraft(event.target.value)}
                  />
                  <div className="bl-row" style={{ justifyContent: "flex-end", gap: 8 }}>
                    <button
                      type="button"
                      className="bl-btn bl-btn--ghost bl-btn--sm"
                      onClick={() => answer("答えたくない")}
                    >
                      答えたくない
                    </button>
                    <button
                      type="button"
                      className="bl-btn bl-btn--primary bl-btn--sm"
                      disabled={!detailDraft.trim()}
                      onClick={() => answer(detailDraft.trim())}
                    >
                      <Icon name="send" size={16} />
                      送信
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * 提出できたことを受け止める画面。書けた日にだけ出るので、ここだけは
 * はっきり喜んでよい — 花が一枚ずつ開き、続いた日数が積み上がる。
 */
function DoneScreen() {
  const streak = useCountUp(7, 1100);
  const weekly = useCountUp(6, 1100);

  return (
    <div className="bl-wrap">
      <section className={styles.done}>
        <div className={styles.doneFlower}>
          <FlowerBloom size={84} />
        </div>

        <h1 className="bl-h1 bl-rise" style={{ animationDelay: "480ms" }}>
          今日の日記を記録しました
        </h1>
        <p className="bl-body bl-rise" style={{ animationDelay: "560ms" }}>
          {formatDate(TODAY)}の記録です。書いてくれてありがとう。
        </p>

        <div className={`${styles.doneStats} bl-rise`} style={{ animationDelay: "660ms" }}>
          <div>
            <span className="bl-num">{streak}</span>
            <span className="bl-meta">連続提出日数</span>
          </div>
          <div>
            <span className="bl-num">{weekly}</span>
            <span className="bl-meta">今週の提出</span>
          </div>
        </div>

        <div className={`${styles.doneActions} bl-rise`} style={{ animationDelay: "760ms" }}>
          <TransitionLink href="/" className="bl-btn bl-btn--primary">
            <Icon name="home" size={19} />
            ホームに戻る
          </TransitionLink>
          <TransitionLink href="/chat" className="bl-btn bl-btn--secondary">
            <Icon name="chat_bubble" size={19} />
            もう少し話す
          </TransitionLink>
        </div>
      </section>
    </div>
  );
}
