"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ApiClient, EntryNotPersistedError } from "@/api/client";
import { Icon } from "@/components/ui/Icon";
import { FlowerBloom } from "@/components/ui/FlowerBloom";
import { TransitionLink } from "@/components/ui/Transition";
import { WaveBed } from "@/components/ui/WaveBed";
import { useCountUp } from "@/lib/motion";
import { useAuth } from "@/lib/auth";
import { useDemoMode } from "@/lib/demo";
import { CATEGORIES, MOODS, TODAY, formatDate } from "@/lib/blesc/labels";
import { EntryTelemetryCollector, clientTimeZone, newSessionId } from "@/lib/telemetry";
import { EMPTY_STATS, type JournalStats } from "@/lib/journalStats";
import type { EventCategory, Mood } from "@/lib/blesc/types";
import { SelfReportBlock, type SelfReportValues } from "@/components/SelfReportBlock";
import type { SelfReportItemId } from "@/lib/pilotSelfReport";
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

/**
 * 追加質問の台本の version。回答は probe_id と一緒にこの値を保存するので、
 * あとで文面を変えても、保存済みの回答がどの問いに対するものか分かる（#133）。
 */
const PROBE_VERSION = "followup-script-v1";

/** これ以上聞かずに終える回答 */
const STOP_ANSWERS = new Set(["話したくない", "まだ整理できない", "答えたくない"]);

type Turn = { role: "ai" | "student"; text: string };

/**
 * 入力は 1 問ずつ出す。長い一枚のフォームは、しんどい日ほど「全部埋めないと
 * いけない」という圧になる。ひとつ答えれば次に進めるほうが、書き始めやすい。
 */
type FormStep = "recall" | "mood" | "events" | "note";

const FORM_STEPS: FormStep[] = ["recall", "mood", "events", "note"];

const STEP_TITLE: Record<FormStep, string> = {
  recall: "まず思い浮かぶこと",
  mood: "今日の気分",
  events: "今日あった出来事",
  note: "今日のこと",
};

export default function JournalPage() {
  const { userId } = useAuth();
  const demo = useDemoMode();
  const [recallText, setRecallText] = useState("");
  const [mood, setMood] = useState<Mood | null>(null);
  const [categories, setCategories] = useState<EventCategory[]>([]);
  const [body, setBody] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [phase, setPhase] = useState<"form" | "followup" | "done">("form");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [thinking, setThinking] = useState(false);
  const [detailDraft, setDetailDraft] = useState("");

  const [step, setStep] = useState<FormStep>("recall");
  const stepRef = useRef<HTMLFieldSetElement>(null);
  const advanceTimer = useRef<number | null>(null);
  const isFirstRender = useRef(true);

  /**
   * 保存された日記の id（#132 / #133）。
   *
   * null のあいだは「まだどこにも残っていない」。完了画面へ進む条件も、
   * 追加質問の回答を保存する宛先も、これが取れていることに依存する。
   */
  const [entryId, setEntryId] = useState<string | null>(null);
  const [entrySessionId, setEntrySessionId] = useState<string | null>(null);

  /**
   * 研究の収集期間中かどうかと、固定自己評定の回答（#165）。
   *
   * 表示の判断にだけ使う。保存するかどうかはサーバーが自分で判定するので
   * （`lib/server/collectionMode.ts`）、ここが false になっても
   * 「研究対象でない人の回答が保存される」は起こらない。
   */
  const [collecting, setCollecting] = useState(false);
  const [selfReport, setSelfReport] = useState<SelfReportValues>({});

  /**
   * サーバーがこの提出について実際に使った判定（#165）。
   *
   * `collecting` は画面を描くための先読みで、確認が終わる前に提出されたり
   * 問い合わせが失敗したりすると false のままになる。追加質問を出すかどうかを
   * それで決めると、サーバーが収集期間中と判定した提出に追加質問が出てしまう。
   *
   * 保存の応答に入っている `collection_only` は、その提出について実際に使われた
   * 答えなので、ここだけは先読みではなくこちらを見る。state ではなく ref なのは、
   * await の直後に同じ関数の中で読むから。
   */
  const serverCollectionOnly = useRef<boolean | null>(null);

  /**
   * 提出ごとに1つ振る id。再試行しても同じ値を送るので、サーバー側で
   * 同じ提出だと分かり、二重に保存されない（#132）。
   */
  const submissionIdRef = useRef<string>("");
  if (!submissionIdRef.current) submissionIdRef.current = newSessionId();

  /**
   * 入力の計測（#135）。内容そのものは持たない — 時刻と文字数だけ。
   * ref に置くのは、計測のたびに再描画させないため。
   */
  const telemetryRef = useRef<EntryTelemetryCollector | null>(null);
  if (!telemetryRef.current) telemetryRef.current = new EntryTelemetryCollector();
  const telemetry = telemetryRef.current;

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

  // どの設問にどれだけ留まったかは、記入の負荷を見るための最小限の指標。
  const previousStep = useRef<FormStep>("recall");
  useEffect(() => {
    if (previousStep.current !== step) {
      telemetry.step(previousStep.current, step);
      previousStep.current = step;
    }
  }, [step, telemetry]);

  useEffect(() => () => {
    if (advanceTimer.current) window.clearTimeout(advanceTimer.current);
  }, []);

  /**
   * 収集期間中かどうかを一度だけ確認する（#165）。
   *
   * デモでは問い合わせない。デモは Supabase に触れないので、答えは常に
   * 「収集期間ではない」であり、研究の項目はデモ画面に出ない。
   */
  useEffect(() => {
    if (demo) return;
    let cancelled = false;
    void ApiClient.isCollecting().then((open) => {
      if (!cancelled) setCollecting(open);
    });
    return () => {
      cancelled = true;
    };
  }, [demo]);

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
    telemetry.select("mood", 1);
    setShowErrors(false);
    clearAdvance();
    advanceTimer.current = window.setTimeout(() => setStep("events"), 300);
  };

  const goNext = () => {
    clearAdvance();
    if (step === "recall") {
      setStep("mood");
      return;
    }
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
    setStep((current) => {
      if (current === "note") return "events";
      if (current === "events") return "mood";
      return "recall";
    });
  };

  const toggleCategory = (value: EventCategory) => {
    setCategories((current) => {
      const next = current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value];
      // 何個選ばれているかだけを記録する。どれを選んだかは送らない。
      telemetry.select("event_categories", next.length);
      return next;
    });
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

  /**
   * 日記を保存する（#132 / #135）。
   *
   * 以前はここが `try { await createEntry(...) } catch { return false }` で、
   * `createEntry` が失敗を投げずに console に出すだけだったので、DBに何も
   * 書けていなくても必ず true が返っていた。生徒には「記録しました」と出て、
   * 書いたものは消えていた。
   *
   * いまは保存できた entry の id が返ったときだけ成功とする。失敗したら
   * 入力はそのまま画面に残り、同じ submission id で再試行できる — 同じ id
   * なので、再試行が二重保存になることはない。
   */
  const persistJournal = async (): Promise<boolean> => {
    // デモは Supabase に触れないので、保存の成否という概念がない。
    if (demo) return true;

    const moodLabel = MOODS.find((option) => option.value === mood)?.label ?? "未選択";
    const categoryLabels = CATEGORIES
      .filter((option) => categories.includes(option.value))
      .map((option) => option.label)
      .join("、");
    const journalText = [
      `気分: ${moodLabel}`,
      `出来事: ${categoryLabels}`,
      `日記: ${body.trim() || "本文なし"}`,
    ].join("\n");

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const result = await ApiClient.createEntry(userId, journalText, "daily", {
        journal_text: journalText,
        recall_text: recallText.trim(),
        client_submission_id: submissionIdRef.current,
        // 収集期間中だけ送る。期間外は項目そのものを出していないので、
        // 送るべき回答が存在しない（#165）。
        self_report: collecting ? selfReport : undefined,
        telemetry: telemetry.finalize({
          timeZone: clientTimeZone(),
          userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent,
        }),
      });
      serverCollectionOnly.current = result.collection_only ?? null;
      const savedId = result.supabase_sync?.entry_id ?? null;
      if (!savedId) {
        // createEntry は id なしでは返らない契約だが、契約を二重に確かめる。
        // ここを通り抜けると、また「保存できていないのに完了画面」になる。
        setSubmitError("日記を保存できませんでした。もう一度お試しください。");
        return false;
      }
      setEntryId(savedId);
      setEntrySessionId(result.supabase_sync?.entry_session_id ?? null);
      return true;
    } catch (error) {
      const message =
        error instanceof EntryNotPersistedError
          ? "日記を保存できませんでした。書いた内容は画面に残っています。もう一度お試しください。"
          : error instanceof Error
            ? `日記を保存できませんでした（${error.message}）`
            : "日記を保存できませんでした。";
      telemetry.submitFailed(error instanceof Error ? error.name : "unknown");
      setSubmitError(message);
      return false;
    } finally {
      setIsSubmitting(false);
    }
  };

  const submit = async () => {
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
    if (!(await persistJournal())) return;

    // 収集期間中は追加質問を出さない（#165）。
    //
    // 追加質問は「つらい日」「本文が短い日」に出る適応的なもので、それ自体が
    // 介入になる。問いかけられた人は、翌日の日記を問いかけられた人として書く。
    // 書き方を測る研究が、同時に書き方へ介入することはできない。
    //
    // 出さないことが第一の制御で、サーバー側の拒否はその裏づけ。ここを通り
    // 抜けても回答は研究記録に入らない。
    //
    // 判断にはサーバーの答えを優先する。`collecting` は問い合わせが終わるまで
    // false なので、それだけで決めると「先読みが間に合わなかった提出」に
    // 追加質問が出る。サーバーの答えが無いのは Supabase 未設定などの場合で、
    // そのときだけ先読みに落とす。
    const collectionOnly = serverCollectionOnly.current ?? collecting;
    if (needsFollowUp() && !collectionOnly) {
      setPhase("followup");
      askStep(0);
    } else {
      setPhase("done");
    }
  };

  /**
   * 追加質問の回答を1問ずつ保存する（#133）。
   *
   * まとめて最後に送らないのは、この対話が途中で閉じられる前提のものだから。
   * 途中で終わったセッションこそ、それまでの回答が残っている必要がある。
   *
   * 保存に失敗しても対話は止めない。生徒から見れば追加質問は「答えなくても
   * いい」ものなので、保存エラーで会話を中断させるほうが害が大きい。
   */
  const saveFollowup = useCallback(
    async (
      probe: Step,
      probeIndex: number,
      outcome: "answered" | "declined" | "stopped" | "abandoned",
      answerText: string | null,
    ) => {
      if (demo || !entryId) return;
      try {
        await ApiClient.saveFollowupResponse(userId, {
          entry_id: entryId,
          entry_session_id: entrySessionId,
          probe_id: probe.id,
          probe_index: probeIndex,
          probe_version: PROBE_VERSION,
          question_text: probe.question,
          answer_kind: outcome === "abandoned" ? "none" : probe.choices ? "choice" : "free_text",
          answer_text: answerText,
          outcome,
          answered_at: new Date().toISOString(),
        });
      } catch (error) {
        console.warn("[journal] follow-up answer was not saved", error);
      }
    },
    [demo, entryId, entrySessionId, userId],
  );

  const answer = (text: string) => {
    const probe = STEPS[stepIndex];
    setTurns((current) => [...current, { role: "student", text }]);
    setDetailDraft("");
    const stopping = STOP_ANSWERS.has(text);
    if (probe) {
      // 「答えたくない」は無回答ではなく、ひとつの回答。区別して残す。
      void saveFollowup(probe, stepIndex, stopping ? "declined" : "answered", text);
    }
    if (stopping) {
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

  /**
   * 閉じるボタンで対話を終える。表示中だった問いは「中断」として記録する
   * ので、答えなかったのか、そこで閉じたのかが後から区別できる（#133）。
   */
  const endFollowUp = () => {
    if (currentStep && awaitingAnswer) void saveFollowup(currentStep, stepIndex, "abandoned", null);
    setPhase("done");
  };

  /* ── 提出完了 ─────────────────────────────────────── */
  if (phase === "done") return <DoneScreen userId={userId} demo={demo} />;

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

            {step === "recall" && (
              <>
                <label className="bl-label" htmlFor="recall">
                  <Icon name="psychology" size={20} />
                  まず思い浮かぶこと
                  <span className="bl-optional">任意</span>
                </label>
                <p className="bl-meta" style={{ marginTop: -4, marginBottom: 11 }}>
                  30秒くらい、考え込まずに最初に浮かんだことをそのまま書いてください。
                </p>
                <textarea
                  id="recall"
                  className={`bl-textarea ${styles.bodyInput}`}
                  rows={3}
                  placeholder="いま頭に浮かんでいること"
                  value={recallText}
                  onFocus={() => telemetry.focus("first_recall_30")}
                  onBlur={() => telemetry.blur("first_recall_30")}
                  onPaste={(event) => telemetry.paste("first_recall_30", event.clipboardData.getData("text").length)}
                  onChange={(event) => {
                    setRecallText(event.target.value);
                    // 渡すのは長さと選択位置だけ。本文そのものは計測に入れない。
                    telemetry.input("first_recall_30", event.target.value.length, {
                      start: event.target.selectionStart ?? undefined,
                      end: event.target.selectionEnd ?? undefined,
                    });
                  }}
                />
                <p className="bl-micro" style={{ marginTop: 9 }}>
                  正解はありません。書かずに次へ進んでも大丈夫です。
                </p>
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
                  onFocus={() => telemetry.focus("journal_entry")}
                  onBlur={() => telemetry.blur("journal_entry")}
                  onPaste={(event) => telemetry.paste("journal_entry", event.clipboardData.getData("text").length)}
                  onChange={(event) => {
                    setBody(event.target.value);
                    telemetry.input("journal_entry", event.target.value.length, {
                      start: event.target.selectionStart ?? undefined,
                      end: event.target.selectionEnd ?? undefined,
                    });
                  }}
                />
                <p className="bl-micro" style={{ marginTop: 9 }}>
                  書きたくないことは、書かなくて大丈夫です。
                </p>

                {/* 研究の固定自己評定（#165）。収集期間中の参加者にだけ出す。
                    通常利用の日記画面はこれまでどおり変わらない。 */}
                {collecting && (
                  <SelfReportBlock
                    values={selfReport}
                    disabled={isSubmitting}
                    onChange={(id: SelfReportItemId, value: number | null) =>
                      setSelfReport((current) => ({ ...current, [id]: value }))
                    }
                  />
                )}
              </>
            )}
          </fieldset>

          <div className={styles.stepBar}>
            {/* 保存に失敗したことを、生徒に見える形で出す（#132）。
                入力は消していないので、そのまま再試行できる。 */}
            {submitError && (
              <div role="alert" className={styles.saveFailure}>
                <p className={styles.error}>
                  <Icon name="error" size={16} fill />
                  {submitError}
                </p>
                <button
                  type="button"
                  className="bl-btn bl-btn--secondary bl-btn--sm"
                  disabled={isSubmitting}
                  onClick={() => void submit()}
                >
                  {/* アイコンは自前のサブセットフォントなので、すでに使われて
                      いる字形から選ぶ。追加すると欠字になる。 */}
                  <Icon name="send" size={16} />
                  もう一度保存する
                </button>
              </div>
            )}
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
                <button
                  type="button"
                  className="bl-btn bl-btn--primary bl-btn--lg"
                  disabled={isSubmitting}
                  onClick={() => void submit()}
                >
                  <Icon name="check" size={20} />
                  {isSubmitting ? "保存中…" : body.trim() ? "日記を提出する" : "書かずに提出する"}
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
              onClick={endFollowUp}
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

/** デモ画面で見せる固定値。実データの経路とは完全に分けてある（#133）。 */
const DEMO_STATS: JournalStats = { streak: 7, weekly: 6, totalDays: 24 };

/**
 * 提出できたことを受け止める画面。書けた日にだけ出るので、ここだけは
 * はっきり喜んでよい — 花が一枚ずつ開き、続いた日数が積み上がる。
 *
 * 数字は本人の提出履歴から出す。以前は `useCountUp(7)` / `useCountUp(6)` と
 * 直接書かれていて、初めて提出した生徒にも「連続提出日数 7」と表示していた
 * （#133）。デモは上の固定値、実データは DB — 混ざらないように経路を分ける。
 */
function DoneScreen({ userId, demo }: { userId: string; demo: boolean }) {
  const [stats, setStats] = useState<JournalStats>(demo ? DEMO_STATS : EMPTY_STATS);

  useEffect(() => {
    if (demo) return;
    let cancelled = false;
    void ApiClient.getJournalStats(userId).then((loaded) => {
      if (!cancelled) setStats(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [demo, userId]);

  const streak = useCountUp(stats.streak, 1100);
  const weekly = useCountUp(stats.weekly, 1100);

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
