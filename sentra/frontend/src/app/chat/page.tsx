"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ApiClient } from "@/api/client";
import { useAuth } from "@/lib/auth";
import { Send } from "lucide-react";
import { VoiceInputButton } from "@/components/VoiceInputButton";
import styles from "./chat.module.css";

type Message = {
  id: string;
  role: "user" | "ai";
  text: string;
  error?: boolean;
  retryText?: string;
};

const STARTERS = [
  "I want to talk about my day",
  "I've been feeling stressed lately",
  "Help me sort out my thoughts",
];

const WAVE_PATHS = [
  "M0,96 C120,64 240,128 360,96 C480,64 600,128 720,96 C840,64 960,128 1080,96 C1200,64 1320,128 1440,96 L1440,200 L0,200 Z",
  "M0,112 C160,80 320,144 480,112 C640,80 800,144 960,112 C1120,80 1280,144 1440,112 L1440,200 L0,200 Z",
  "M0,128 C180,104 360,152 540,128 C720,104 900,152 1080,128 C1260,104 1440,152 1440,128 L1440,200 L0,200 Z",
];

export default function ChatPage() {
  const { userId } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const nearBottomRef = useRef(true);
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  };

  useEffect(() => {
    // Follow the conversation only when the user is already at the bottom,
    // so scrolling up to reread is never interrupted.
    if (nearBottomRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [messages, isThinking]);

  const autoGrow = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 130)}px`;
  };

  const send = useCallback(
    async (rawText: string) => {
      const text = rawText.trim();
      if (!text || isThinking) return;
      nearBottomRef.current = true;
      const userMessage: Message = { id: `u-${Date.now()}`, role: "user", text };
      setMessages((current) => [
        ...current.filter((m) => !(m.error && m.retryText === text)),
        userMessage,
      ]);
      setIsThinking(true);
      try {
        const context = [...messagesRef.current.filter((m) => !m.error), userMessage]
          .slice(-12)
          .map((m) => `${m.role === "user" ? "user" : "assistant"}: ${m.text}`);
        const response = await ApiClient.createChat(userId, text, 5, {
          mode: "general",
          conversationContext: context,
        });
        setMessages((current) => [
          ...current,
          { id: `a-${Date.now()}`, role: "ai", text: response.answer || "…" },
        ]);
      } catch (err) {
        setMessages((current) => [
          ...current,
          {
            id: `e-${Date.now()}`,
            role: "ai",
            error: true,
            retryText: text,
            text: err instanceof Error ? err.message : "Something went wrong.",
          },
        ]);
      } finally {
        setIsThinking(false);
        textareaRef.current?.focus();
      }
    },
    [isThinking, userId],
  );

  const sendFromInput = () => {
    const text = input.trim();
    if (!text || isThinking) return;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    void send(text);
  };

  const retry = (message: Message) => {
    if (!message.retryText || isThinking) return;
    // Drop the failed user bubble + error bubble; send() re-adds the user message.
    setMessages((current) =>
      current.filter((m) => m.id !== message.id && !(m.role === "user" && m.text === message.retryText)),
    );
    void send(message.retryText);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      sendFromInput();
    }
  };

  const insertTranscript = (text: string) => {
    setInput((current) => [current.trim(), text.trim()].filter(Boolean).join(current.trim() ? "\n" : ""));
    requestAnimationFrame(autoGrow);
  };

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <Link href="/" aria-label="Back to home" className={styles.headerHome}>
          <Image src="/flower.png" alt="blesc" width={34} height={34} className={styles.headerFlower} />
          <span className={styles.headerTitle}>blesc</span>
        </Link>
      </header>

      <div ref={scrollRef} className={styles.scroll} onScroll={handleScroll}>
        <div className={styles.thread} aria-live="polite">
          {messages.length === 0 && !isThinking && (
            <div className={styles.empty}>
              <Image src="/flower.png" alt="" width={88} height={88} className={styles.emptyFlower} priority />
              <div className={styles.emptyTitle}>Hi, I&apos;m blesc</div>
              <div className={styles.emptySub}>Whatever&apos;s on your mind — let&apos;s talk about it.</div>
              <div className={styles.starters}>
                {STARTERS.map((starter) => (
                  <button key={starter} type="button" className={styles.starter} onClick={() => void send(starter)}>
                    {starter}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message) =>
            message.role === "user" ? (
              <div key={message.id} className={`${styles.row} ${styles.rowUser}`}>
                <div className={`${styles.bubble} ${styles.bubbleUser}`}>{message.text}</div>
              </div>
            ) : (
              <div key={message.id} className={styles.row}>
                <Image src="/flower.png" alt="" width={32} height={32} className={styles.avatar} />
                <div className={`${styles.bubble} ${styles.bubbleAi} ${message.error ? styles.bubbleError : ""}`}>
                  {message.text}
                  {message.error && message.retryText && (
                    <button type="button" className={styles.retry} onClick={() => retry(message)}>
                      Try again
                    </button>
                  )}
                </div>
              </div>
            ),
          )}

          {isThinking && (
            <div className={styles.row}>
              <Image src="/flower.png" alt="" width={32} height={32} className={styles.avatar} />
              <div className={`${styles.bubble} ${styles.bubbleAi} ${styles.typing}`} aria-label="blesc is thinking">
                <span />
                <span />
                <span />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom blue→clear gradient; waves ripple while thinking */}
      <div className={styles.gradient} aria-hidden="true" />
      <div className={`${styles.waves} ${isThinking ? styles.wavesActive : ""}`} aria-hidden="true">
        {WAVE_PATHS.map((path, i) => (
          <svg
            key={i}
            className={`${styles.wave} ${styles[`wave${i + 1}` as keyof typeof styles]}`}
            viewBox="0 0 2880 200"
            preserveAspectRatio="none"
          >
            <path d={path} style={{ fill: "var(--blue-base)" }} />
            <path d={path} style={{ fill: "var(--blue-base)" }} transform="translate(1440 0)" />
          </svg>
        ))}
      </div>

      <div className={styles.inputWrap}>
        <div className={styles.inputBox}>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            rows={1}
            placeholder="Message blesc…"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              autoGrow();
            }}
            onKeyDown={onKeyDown}
          />
          <div className={styles.voiceSlot}>
            <VoiceInputButton disabled={isThinking} onTranscript={insertTranscript} />
          </div>
          <button
            type="button"
            className={styles.send}
            onClick={sendFromInput}
            disabled={isThinking || !input.trim()}
            aria-label="Send message"
          >
            <svg viewBox="0 0 100 100" className={styles.sendShape} aria-hidden="true">
              <path
                d="M50 10 L90 41 L74 90 L26 90 L10 41 Z"
                fill="currentColor"
                stroke="currentColor"
                strokeWidth="16"
                strokeLinejoin="round"
              />
            </svg>
            <Send size={16} className={styles.sendIcon} />
          </button>
        </div>
      </div>
      <div className={styles.disclaimer}>blesc is not a clinical assessment or an emergency service.</div>
    </div>
  );
}
