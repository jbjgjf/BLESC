"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Mic, MicOff, X, Zap } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { routesToRealPerson } from "@/lib/safety-assessment";
import styles from "./VoiceMode.module.css";

type VoicePhase = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "interrupted" | "error";

export type VoiceTurn = { role: "user" | "assistant"; text: string };

type TranscriptItem = VoiceTurn & { id: string; partial: boolean };

type RealtimeSessionResponse = {
  client_secret: string;
  expires_at: number | null;
  model: string;
  voice: string;
};

function phaseLabel(phase: VoicePhase) {
  if (phase === "connecting") return "Connecting…";
  if (phase === "listening") return "Listening";
  if (phase === "thinking") return "Thinking";
  if (phase === "speaking") return "Speaking";
  if (phase === "interrupted") return "Interrupted";
  if (phase === "error") return "Needs attention";
  return "Tap to start";
}

function eventText(event: Record<string, unknown>) {
  if (typeof event.delta === "string") return event.delta;
  if (typeof event.transcript === "string") return event.transcript;
  if (typeof event.text === "string") return event.text;
  return "";
}

function upsertTranscript(items: TranscriptItem[], next: TranscriptItem) {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) return [...items, next];
  return items.map((item, itemIndex) => (itemIndex === index ? next : item));
}

/**
 * Full-screen voice conversation, opened from the chat composer.
 *
 * This is the former /voice page's realtime session, moved into the chat as an
 * overlay so voice is a mode of one conversation rather than a second place to
 * talk. On close it hands its transcript back so the turns land in the chat
 * thread the reader was already in.
 *
 * Each settled turn is posted to /api/voice/turn, which assesses it, persists
 * it alongside text chat, and writes the audit row. When the rules layer
 * carries a support response and the model's spoken answer pointed at no real
 * person, that response is injected into the session and spoken — the same
 * deterministic floor text chat has, reaching the student out loud.
 */
export function VoiceMode({ onClose }: { onClose: (turns: VoiceTurn[]) => void }) {
  const { session, userId } = useAuth();
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const assistantItemIdRef = useRef<string | null>(null);
  const assistantTextRef = useRef("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const transcriptsRef = useRef<TranscriptItem[]>([]);
  transcriptsRef.current = transcripts;
  /** The student's last utterance, held until its reply settles. */
  const pendingUserTurnRef = useRef<string | null>(null);
  /** True while the next response is the floor's own injected support text. */
  const injectedRef = useRef(false);

  const cleanup = useCallback(() => {
    dcRef.current?.close();
    pcRef.current?.close();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    dcRef.current = null;
    pcRef.current = null;
    localStreamRef.current = null;
    assistantItemIdRef.current = null;
    assistantTextRef.current = "";
  }, []);

  useEffect(() => cleanup, [cleanup]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [transcripts]);

  const sendEvent = (event: Record<string, unknown>) => {
    const channel = dcRef.current;
    if (!channel || channel.readyState !== "open") return;
    channel.send(JSON.stringify({ event_id: `blesc_${Date.now()}_${Math.random().toString(16).slice(2)}`, ...event }));
  };

  /**
   * The deterministic floor, spoken. Posts the settled turn for assessment and
   * audit; if the rules layer returns a support response that the model's own
   * reply did not already cover, the session is told to say it.
   */
  const reportTurn = useCallback(
    async (message: string, reply: string) => {
      try {
        const response = await fetch("/api/voice/turn", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
          },
          body: JSON.stringify({ participant_code: userId, message, reply }),
        });
        if (!response.ok) return;
        const data = (await response.json()) as { safe_response?: string };
        const safeResponse = data.safe_response?.trim();
        if (!safeResponse || routesToRealPerson(reply)) return;
        sendEvent({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "system",
            content: [{ type: "input_text", text: `Say this to the student now, in your own voice and without preamble: ${safeResponse}` }],
          },
        });
        injectedRef.current = true;
        sendEvent({ type: "response.create" });
      } catch {
        // A failed report must not interrupt the conversation. The gap is
        // logged server-side by its absence rather than surfaced here.
      }
    },
    [session?.access_token, userId],
  );

  const handleServerEvent = (raw: MessageEvent) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(String(raw.data)) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = String(event.type ?? "");
    if (type === "error") {
      setError(String((event.error as { message?: unknown } | undefined)?.message ?? "Voice session error."));
      setPhase("error");
      return;
    }
    if (type === "input_audio_buffer.speech_started") {
      setPhase((current) => (current === "speaking" ? "interrupted" : "listening"));
      return;
    }
    if (type === "input_audio_buffer.speech_stopped") {
      setPhase("thinking");
      return;
    }
    if (type === "response.created") {
      setPhase("speaking");
      assistantItemIdRef.current = `assistant-${Date.now()}`;
      assistantTextRef.current = "";
      return;
    }
    if (type === "response.output_audio_transcript.delta" || type === "response.output_text.delta") {
      const delta = eventText(event);
      if (!delta) return;
      const id = assistantItemIdRef.current ?? `assistant-${Date.now()}`;
      assistantItemIdRef.current = id;
      assistantTextRef.current += delta;
      setTranscripts((items) => upsertTranscript(items, { id, role: "assistant", text: assistantTextRef.current, partial: true }));
      return;
    }
    if (type === "response.output_audio_transcript.done" || type === "response.output_text.done" || type === "response.done") {
      const id = assistantItemIdRef.current;
      const replyText = assistantTextRef.current.trim();
      if (id && replyText) {
        setTranscripts((items) => upsertTranscript(items, { id, role: "assistant", text: replyText, partial: false }));
      }
      setPhase("listening");
      // The pair is settled: report it for assessment and audit. Skipped when
      // the reply was itself the injected support response, so the floor never
      // recurses on its own output.
      const pending = pendingUserTurnRef.current;
      if (pending && replyText && !injectedRef.current) {
        pendingUserTurnRef.current = null;
        void reportTurn(pending, replyText);
      }
      injectedRef.current = false;
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const transcript = eventText(event).trim();
      if (!transcript) return;
      pendingUserTurnRef.current = transcript;
      setTranscripts((items) => [...items, { id: `user-${Date.now()}`, role: "user", text: transcript, partial: false }]);
    }
  };

  const start = async () => {
    if (phase !== "idle" && phase !== "error") return;
    if (!session?.access_token) {
      setError("Please sign in to use voice.");
      setPhase("error");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      setError("Voice is not supported in this browser.");
      setPhase("error");
      return;
    }

    cleanup();
    setError(null);
    setPhase("connecting");

    try {
      const tokenResponse = await fetch("/api/voice/realtime-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice: "marin" }),
      });
      if (!tokenResponse.ok) {
        const payload = (await tokenResponse.json().catch(() => ({}))) as { detail?: string };
        throw new Error(payload.detail ?? `Voice session failed (${tokenResponse.status}).`);
      }
      const token = (await tokenResponse.json()) as RealtimeSessionResponse;

      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          setError("The voice connection dropped.");
          setPhase("error");
        }
      };
      pc.ontrack = (event) => {
        if (audioRef.current) {
          audioRef.current.srcObject = event.streams[0];
          void audioRef.current.play().catch(() => undefined);
        }
      };

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      localStreamRef.current = stream;
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
        pc.addTrack(track, stream);
      });

      const channel = pc.createDataChannel("oai-events");
      dcRef.current = channel;
      channel.addEventListener("open", () => setPhase("listening"));
      channel.addEventListener("message", handleServerEvent);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: { Authorization: `Bearer ${token.client_secret}`, "Content-Type": "application/sdp" },
        body: offer.sdp ?? "",
      });
      if (!sdpResponse.ok) throw new Error(`Voice connection failed (${sdpResponse.status}).`);

      await pc.setRemoteDescription({ type: "answer", sdp: await sdpResponse.text() });
    } catch (err) {
      cleanup();
      setError(err instanceof Error ? err.message : "Voice session failed.");
      setPhase("error");
    }
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
  };

  const close = () => {
    cleanup();
    // Hand back only settled turns; a half-streamed sentence would land in the
    // thread as a fragment.
    onClose(transcriptsRef.current.filter((item) => !item.partial).map(({ role, text }) => ({ role, text })));
  };

  const active = phase !== "idle" && phase !== "error";
  const latest = transcripts[transcripts.length - 1];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // close is stable enough for a dialog that unmounts on exit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Voice conversation">
      <audio ref={audioRef} autoPlay playsInline />

      <button type="button" className={styles.close} onClick={close} aria-label="Close voice mode">
        <X size={20} />
      </button>

      <div className={styles.stage}>
        <div className={`${styles.orb} ${styles[phase]}`} aria-hidden="true">
          <Image src="/flower.png" alt="" width={104} height={104} className={styles.orbFlower} priority />
        </div>
        <div className={styles.phase} aria-live="polite">
          {phaseLabel(phase)}
        </div>
        {error && <div className={styles.error}>{error}</div>}
        {!active && !error && <p className={styles.hint}>Speak naturally — blesc listens and replies out loud.</p>}
      </div>

      <div ref={scrollRef} className={styles.transcript} aria-live="polite">
        {transcripts.map((item) => (
          <div key={item.id} className={`${styles.line} ${item.role === "user" ? styles.lineUser : ""}`}>
            <span className={styles.who}>{item.role === "user" ? "You" : "blesc"}</span>
            <p>{item.text}</p>
          </div>
        ))}
        {!transcripts.length && latest === undefined && <p className={styles.empty} />}
      </div>

      <div className={styles.controls}>
        <button type="button" className={styles.control} onClick={toggleMute} disabled={!active} aria-label={muted ? "Unmute" : "Mute"}>
          {muted ? <MicOff size={20} /> : <Mic size={20} />}
        </button>

        <button
          type="button"
          className={`${styles.primary} ${active ? styles.primaryActive : ""}`}
          onClick={active ? close : start}
          aria-label={active ? "End voice conversation" : "Start voice conversation"}
        >
          {active ? <X size={26} /> : <Mic size={26} />}
        </button>

        <button
          type="button"
          className={styles.control}
          onClick={() => {
            sendEvent({ type: "response.cancel" });
            sendEvent({ type: "output_audio_buffer.clear" });
            setPhase("interrupted");
          }}
          disabled={phase !== "speaking"}
          aria-label="Interrupt"
        >
          <Zap size={20} />
        </button>
      </div>

      <p className={styles.disclaimer}>blesc is not a clinical assessment or an emergency service.</p>
    </div>
  );
}
