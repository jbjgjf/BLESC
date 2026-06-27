"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, PhoneOff, Radio, RotateCcw, Volume2, Zap } from "lucide-react";
import { useAuth } from "@/lib/auth";

type VoicePhase = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "interrupted" | "error";

type TranscriptItem = {
  id: string;
  role: "user" | "assistant";
  text: string;
  partial: boolean;
};

type RealtimeSessionResponse = {
  client_secret: string;
  expires_at: number | null;
  model: string;
  voice: string;
};

function phaseLabel(phase: VoicePhase) {
  if (phase === "connecting") return "Connecting";
  if (phase === "listening") return "Listening";
  if (phase === "thinking") return "Thinking";
  if (phase === "speaking") return "Speaking";
  if (phase === "interrupted") return "Interrupted";
  if (phase === "error") return "Needs attention";
  return "Ready";
}

function eventText(event: Record<string, unknown>) {
  if (typeof event.delta === "string") return event.delta;
  if (typeof event.transcript === "string") return event.transcript;
  if (typeof event.text === "string") return event.text;
  return "";
}

function upsertTranscript(items: TranscriptItem[], next: TranscriptItem) {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) return [...items, next].slice(-10);
  return items.map((item, itemIndex) => itemIndex === index ? next : item);
}

export function ContinuousVoiceWorkspace() {
  const { session, userId } = useAuth();
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [voice, setVoice] = useState("marin");
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const assistantItemIdRef = useRef<string | null>(null);
  const assistantTextRef = useRef("");

  const cleanup = () => {
    dcRef.current?.close();
    pcRef.current?.close();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    dcRef.current = null;
    pcRef.current = null;
    localStreamRef.current = null;
    assistantItemIdRef.current = null;
    assistantTextRef.current = "";
  };

  useEffect(() => cleanup, []);

  const sendEvent = (event: Record<string, unknown>) => {
    const channel = dcRef.current;
    if (!channel || channel.readyState !== "open") return;
    channel.send(JSON.stringify({ event_id: `blesc_${Date.now()}_${Math.random().toString(16).slice(2)}`, ...event }));
  };

  const handleServerEvent = (raw: MessageEvent) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(String(raw.data)) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = String(event.type ?? "");
    if (type === "error") {
      setError(String((event.error as { message?: unknown } | undefined)?.message ?? "Realtime voice session error."));
      setPhase("error");
      return;
    }
    if (type === "input_audio_buffer.speech_started") {
      setPhase((current) => current === "speaking" ? "interrupted" : "listening");
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
      if (id && assistantTextRef.current.trim()) {
        setTranscripts((items) => upsertTranscript(items, { id, role: "assistant", text: assistantTextRef.current.trim(), partial: false }));
      }
      setPhase("listening");
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const transcript = eventText(event).trim();
      if (!transcript) return;
      const next: TranscriptItem = { id: `user-${Date.now()}`, role: "user", text: transcript, partial: false };
      setTranscripts((items) => [...items, next].slice(-10));
    }
  };

  const start = async () => {
    if (phase !== "idle" && phase !== "error") return;
    if (!session?.access_token) {
      setError("Authentication is required.");
      setPhase("error");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      setError("Realtime voice is not supported in this browser.");
      setPhase("error");
      return;
    }

    cleanup();
    setError(null);
    setPhase("connecting");

    try {
      const tokenResponse = await fetch("/api/voice/realtime-session", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ voice }),
      });
      if (!tokenResponse.ok) {
        const payload = await tokenResponse.json().catch(() => ({})) as { detail?: string };
        throw new Error(payload.detail ?? `Realtime session failed (${tokenResponse.status}).`);
      }
      const token = await tokenResponse.json() as RealtimeSessionResponse;
      setModel(token.model);
      setVoice(token.voice);

      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          setError("Voice connection was interrupted.");
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
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      localStreamRef.current = stream;
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
        pc.addTrack(track, stream);
      });

      const channel = pc.createDataChannel("oai-events");
      dcRef.current = channel;
      channel.addEventListener("open", () => {
        setPhase("listening");
      });
      channel.addEventListener("message", handleServerEvent);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.client_secret}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp ?? "",
      });
      if (!sdpResponse.ok) {
        throw new Error(`Realtime connection failed (${sdpResponse.status}).`);
      }

      await pc.setRemoteDescription({
        type: "answer",
        sdp: await sdpResponse.text(),
      });
    } catch (err) {
      cleanup();
      setError(err instanceof Error ? err.message : "Voice session failed.");
      setPhase("error");
    }
  };

  const stop = () => {
    cleanup();
    setPhase("idle");
  };

  const interrupt = () => {
    sendEvent({ type: "response.cancel" });
    sendEvent({ type: "output_audio_buffer.clear" });
    setPhase("interrupted");
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
  };

  const active = phase !== "idle" && phase !== "error";

  return (
    <main className="voice-workspace">
      <audio ref={audioRef} autoPlay playsInline />
      <section className="voice-stage" data-phase={phase}>
        <div className="voice-stage__status">
          <Radio className="h-4 w-4" />
          <span>{phaseLabel(phase)}</span>
        </div>

        <div className="voice-stage__meter" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>

        <div className="voice-stage__identity">
          <div className="inscription">BLESC Voice</div>
          <h1>{phaseLabel(phase)}</h1>
          <p>{userId}</p>
        </div>

        {error && <div className="voice-stage__error">{error}</div>}

        <div className="voice-controls" aria-label="Voice controls">
          <button type="button" onClick={active ? stop : start} className="voice-control voice-control--primary" data-active={active}>
            {active ? <PhoneOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
          </button>
          <button type="button" onClick={toggleMute} className="voice-control" disabled={!active}>
            {muted ? <MicOff className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
          </button>
          <button type="button" onClick={interrupt} className="voice-control" disabled={!active || phase !== "speaking"}>
            <Zap className="h-5 w-5" />
          </button>
          <button type="button" onClick={() => setTranscripts([])} className="voice-control" disabled={transcripts.length === 0}>
            <RotateCcw className="h-5 w-5" />
          </button>
        </div>
      </section>

      <section className="voice-transcript" aria-live="polite">
        <div className="inscription">Conversation</div>
        {transcripts.length === 0 ? (
          <p className="voice-transcript__empty">No transcript yet.</p>
        ) : (
          <div className="voice-transcript__list">
            {transcripts.map((item) => (
              <div key={item.id} className="voice-transcript__item" data-role={item.role} data-partial={item.partial}>
                <span>{item.role === "user" ? "You" : "BLESC"}</span>
                <p>{item.text}</p>
              </div>
            ))}
          </div>
        )}
        <div className="voice-transcript__meta">
          <span>{model ?? "Realtime"}</span>
          <span>{voice}</span>
        </div>
      </section>
    </main>
  );
}
