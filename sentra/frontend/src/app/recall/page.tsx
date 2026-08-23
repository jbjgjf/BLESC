"use client";

import { FormEvent, useMemo, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowLeft, Loader2, MessageCircle, Send } from "lucide-react";
import { ApiClient } from "@/api/client";
import { ConversationMemoryObject, ConversationRecallSummary } from "@/api/models";
import { MemoryObjectCard } from "@/components/MemoryObjectCard";
import { ProcessingTimeline } from "@/components/ProcessingTimeline";
import { VoiceInputButton } from "@/components/VoiceInputButton";
import { useAuth } from "@/lib/auth";

type RecallMessage = {
  id: string;
  role: "assistant" | "user";
  content: string;
};

const MAX_USER_TURNS = 30;
const MIN_SUMMARY_TURNS = 6;
const recallSteps = ["記録しています", "これまでの内容を確認しています", "安全性を確認しています", "次の質問を用意しています", "完了"];

const guidedQuestions = [
  "この1日か1週間で、blescに覚えておいてほしいことは何ですか。",
  "そのとき、いちばん強く出てきた気持ちは何でしたか。あとで変わっていても大丈夫です。",
  "その気持ちのきっかけになったこと、強くしたことは何でしたか。",
  "助けになったこと、支えになったこと、少しでも楽になったことはありますか。",
  "状況が変わった瞬間はありましたか。その前後に何がありましたか。",
  "まだ終わっていないこと、もやもやしていること、頭の中で回り続けていることはありますか。",
  "最近の睡眠・食欲・体力・集中はどうでしたか。",
  "学校・家庭・友人・アルバイト・ネット上のことで、関係している出来事はありますか。",
  "信頼できる大人やカウンセラーに分かってもらえるとしたら、どんなことですか。",
  "大事なところを見落とさないために、blescが次に聞くとよい質問は何だと思いますか。",
];

const crisisTerms = [
  "自殺",
  "死にたい",
  "消えたい",
  "殺したい",
  "傷つけたい",
  "suicide",
  "kill myself",
  "want to die",
  "self-harm",
  "hurt myself",
];

const panel: React.CSSProperties = {
  backgroundColor: "#ffffff",
  border: "1px solid var(--limestone)",
  borderRadius: "var(--radius)",
};
const displayFont: React.CSSProperties = { fontFamily: "var(--font-sans), sans-serif" };
const bodyFont: React.CSSProperties = { fontFamily: "var(--font-sans), sans-serif" };

function hasCrisisLanguage(text: string) {
  const normalized = text.toLowerCase();
  return crisisTerms.some((term) => normalized.includes(term));
}

function nextQuestionForTurn(userTurnCount: number) {
  return guidedQuestions[userTurnCount % guidedQuestions.length];
}

export default function RecallWorkspacePage() {
  const { userId } = useAuth();
  const [messages, setMessages] = useState<RecallMessage[]>([
    {
      id: "opening",
      role: "assistant",
      content: guidedQuestions[0],
    },
  ]);
  const [input, setInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [step, setStep] = useState(0);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ConversationRecallSummary | null>(null);
  const [memoryObjects, setMemoryObjects] = useState<ConversationMemoryObject[]>([]);

  const userTurnCount = useMemo(() => messages.filter((message) => message.role === "user").length, [messages]);
  const canSend = input.trim().length > 0 && !isSubmitting && userTurnCount < MAX_USER_TURNS;
  const progressLabel = `${userTurnCount}/${MAX_USER_TURNS} user turns`;
  const sortedMemoryObjects = useMemo(
    () => [...memoryObjects].sort((a, b) => b.effective_importance - a.effective_importance),
    [memoryObjects],
  );

  const refreshSummary = async (force = false) => {
    try {
      const data = await ApiClient.getConversationRecallWithFallback(userId, force);
      setSummary(data);
    } catch (err) {
      console.warn("[recall_workspace] summary refresh failed", err);
    }
    try {
      const objects = await ApiClient.getConversationMemoryObjects(userId);
      setMemoryObjects(objects);
    } catch (err) {
      console.warn("[recall_workspace] memory object refresh failed", err);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSend) return;

    const content = input.trim();
    const userMessage: RecallMessage = { id: `user-${Date.now()}`, role: "user", content };
    const nextUserTurnCount = userTurnCount + 1;
    setMessages((current) => [...current, userMessage]);
    setInput("");
    setIsSubmitting(true);
    setComplete(false);
    setStep(0);
    setError(null);

    let timer: number | null = null;
    try {
      timer = window.setInterval(() => {
        setStep((current) => Math.min(current + 1, recallSteps.length - 2));
      }, 850);

      if (hasCrisisLanguage(content)) {
        const safetyMessage: RecallMessage = {
          id: `assistant-safety-${Date.now()}`,
          role: "assistant",
          content:
            "いますぐの危険がある場合は、緊急の連絡先や、信頼できる大人にすぐ連絡してください。blescは緊急時の相談を受けることはできません。もし答えられそうなら、これだけ教えてください——いま安全な場所にいますか。近くに頼れる人はいますか。",
        };
        setMessages((current) => [...current, safetyMessage]);
      } else {
        const conversationContext = [
          "BLESC 30-turn recall workspace. Use cautious, non-diagnostic language.",
          "Briefly reflect the user's latest answer, avoid clinical certainty, then keep the interview moving.",
          `Current user turn: ${nextUserTurnCount}/${MAX_USER_TURNS}.`,
          `Next guided question candidate: ${nextQuestionForTurn(nextUserTurnCount)}`,
        ];
        const response = await ApiClient.createChat(
          userId,
          content,
          5,
          { mode: "recall_workspace", conversationContext },
        );
        const nextQuestion = nextUserTurnCount >= MAX_USER_TURNS
          ? "That completes the 30-turn window. Review the summary below and consider sharing concerning patterns with a trusted adult or qualified professional."
          : nextQuestionForTurn(nextUserTurnCount);
        const assistantMessage: RecallMessage = {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: `${response.answer}\n\n${nextQuestion}`,
        };
        setMessages((current) => [...current, assistantMessage]);
        setSummary(response.conversation_recall_30 ?? null);
        if (response.conversation_recall_30?.memory_objects?.length) {
          setMemoryObjects(response.conversation_recall_30.memory_objects);
        }
      }

      if (timer) window.clearInterval(timer);
      timer = null;
      setStep(recallSteps.length - 1);
      setComplete(true);
      if (nextUserTurnCount >= MIN_SUMMARY_TURNS) void refreshSummary(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "送信に失敗しました。");
    } finally {
      if (timer) window.clearInterval(timer);
      setIsSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-8" style={{ ...bodyFont, color: "var(--ink)" }}>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/" className="mb-4 inline-flex items-center gap-2 text-sm" style={{ color: "var(--ink-faint)", textDecoration: "none" }}>
            <ArrowLeft className="h-4 w-4" />
            ホームに戻る
          </Link>
          <div className="inscription mb-2">これまでのふりかえり</div>
          <h1 className="text-3xl font-semibold" style={{ ...displayFont, letterSpacing: "0.03em" }}>
            30-Turn Recall Workspace
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed" style={{ color: "var(--ink-mid)", fontStyle: "italic" }}>
            A guided, non-diagnostic interview that records chat turns as user data and summarizes recurring patterns after enough history exists.
          </p>
        </div>
        <div className="rounded-2xl px-4 py-2 text-xs" style={{ border: "1px solid var(--limestone)", color: "var(--ink-faint)" }}>
          {progressLabel}
        </div>
      </header>

      <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div style={panel} className="min-h-[560px] overflow-hidden">
          <div className="border-b px-5 py-4" style={{ borderColor: "var(--limestone)", backgroundColor: "var(--ivory-warm)" }}>
            <div className="flex items-center gap-2">
              <MessageCircle className="h-4 w-4" style={{ color: "var(--gold)" }} />
              <span className="inscription">対話で記録する</span>
            </div>
          </div>

          <div className="max-h-[520px] space-y-4 overflow-y-auto px-5 py-5">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`max-w-[86%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-relaxed ${message.role === "user" ? "ml-auto" : ""}`}
                style={{
                  border: "1px solid var(--limestone)",
                  backgroundColor: message.role === "user" ? "hsla(206, 74%, 72%, 0.22)" : "var(--ivory-warm)",
                  color: message.role === "user" ? "var(--ink)" : "var(--ink-mid)",
                }}
              >
                {message.content}
              </div>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="space-y-3 border-t px-5 py-4" style={{ borderColor: "var(--limestone)" }}>
            <textarea
              className="w-full resize-none rounded-2xl p-4 text-base leading-relaxed outline-none"
              rows={3}
              style={{ ...bodyFont, border: "1px solid var(--limestone)", backgroundColor: "var(--ivory-warm)", color: "var(--ink)" }}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={userTurnCount >= MAX_USER_TURNS ? "30回分の記録が終わりました。" : "いまの質問に答えてください。音声で入力した内容は、送る前に直せます。"}
              disabled={isSubmitting || userTurnCount >= MAX_USER_TURNS}
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <VoiceInputButton disabled={isSubmitting || userTurnCount >= MAX_USER_TURNS} onTranscript={(text) => setInput((current) => [current.trim(), text.trim()].filter(Boolean).join(current.trim() ? "\n" : ""))} />
              <button
                type="submit"
                disabled={!canSend}
                className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-xs font-semibold transition-all disabled:cursor-not-allowed"
                style={{
                  ...displayFont,
                  backgroundColor: canSend ? "var(--gold)" : "var(--limestone)",
                  color: canSend ? "#000" : "var(--ink-faint)",
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                }}
              >
                {isSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                送信
              </button>
            </div>
            <ProcessingTimeline steps={recallSteps} active={isSubmitting} currentStep={step} complete={complete && !error} />
            {error && (
              <div className="flex items-center gap-2 rounded-2xl p-3 text-sm" style={{ border: "1px solid var(--terracotta)", color: "var(--sienna)" }}>
                <AlertCircle className="h-4 w-4 shrink-0" />
                {error}
              </div>
            )}
          </form>
        </div>

        <aside className="space-y-4">
          <div style={panel} className="p-5">
            <div className="inscription mb-3">覚えていること</div>
            {summary?.status === "completed" ? (
              <p className="text-sm leading-relaxed" style={{ color: "var(--ink-mid)", fontStyle: "italic" }}>
                {summary.summary_json.summary}
              </p>
            ) : (
              <p className="text-sm leading-relaxed" style={{ color: "var(--ink-mid)", fontStyle: "italic" }}>
                {`Not enough conversation history. Minimum: ${MIN_SUMMARY_TURNS} turns.`}
              </p>
            )}

            {sortedMemoryObjects.length > 0 && (
              <div className="mt-4 max-h-[420px] space-y-3 overflow-y-auto pr-1">
                {sortedMemoryObjects.map((memoryObject) => (
                  <MemoryObjectCard key={String(memoryObject.memory_id)} memoryObject={memoryObject} />
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={() => void refreshSummary(true)}
              className="mt-4 rounded-2xl px-4 py-2 text-xs font-semibold"
              style={{ ...displayFont, border: "1px solid var(--limestone)", color: "var(--ink)", letterSpacing: "0.12em", textTransform: "uppercase" }}
            >
              まとめを更新
            </button>
          </div>

          <div style={panel} className="p-5">
            <div className="inscription mb-3">プライバシーについて</div>
            <p className="text-sm leading-relaxed" style={{ color: "var(--ink-mid)" }}>
              Chat turns remain user data. Raw audio is discarded after transcription. User-specific mental health content is not uploaded into OpenAI Vector Store.
            </p>
          </div>
        </aside>
      </section>
    </div>
  );
}
