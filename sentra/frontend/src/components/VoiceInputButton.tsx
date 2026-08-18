"use client";

import { useRef, useState } from "react";
import { Loader2, Mic, Square } from "lucide-react";
import { ApiClient } from "@/api/client";

type VoiceState = "idle" | "permission" | "recording" | "stopping" | "transcribing" | "ready" | "error";

type VoiceInputButtonProps = {
  disabled?: boolean;
  onTranscript: (text: string) => void;
  onStatusChange?: (status: VoiceState) => void;
};

function preferredMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  for (const type of ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

function voiceErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "音声入力に失敗しました。";
  if (message.includes("503") || message.includes("not configured") || message.includes("USE_MOCK_LLM")) {
    return "サーバー側で音声の文字起こしが設定されていません。";
  }
  if (message.includes("401") || message.includes("AuthenticationError")) {
    return "音声の文字起こしの認証に失敗しました。";
  }
  if (message.includes("429") || message.includes("RateLimitError")) {
    return "音声の文字起こしが混み合っています。少し待ってからお試しください。";
  }
  if (message.includes("415") || message.includes("未対応の形式")) {
    return "このブラウザで録音した形式には対応していません。";
  }
  return message.replace(/^Audio transcription failed/, "文字起こしに失敗");
}

export function VoiceInputButton({ disabled = false, onTranscript, onStatusChange }: VoiceInputButtonProps) {
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  const setVoiceState = (next: VoiceState) => {
    setState(next);
    onStatusChange?.(next);
  };

  const cleanupStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const startRecording = async () => {
    if (disabled || state === "recording") return;
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("このブラウザは音声の録音に対応していません。");
      setVoiceState("error");
      return;
    }

    try {
      setVoiceState("permission");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const mimeType = preferredMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setError("録音に失敗しました。");
        setVoiceState("error");
        cleanupStream();
      };
      recorder.onstop = async () => {
        setVoiceState("transcribing");
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        cleanupStream();
        if (!blob.size) {
          setError("音声が録音されませんでした。");
          setVoiceState("error");
          return;
        }
        try {
          const extension = blob.type.includes("mp4") ? "mp4" : "webm";
          const result = await ApiClient.transcribeAudio(new File([blob], `blesc-voice.${extension}`, { type: blob.type || "audio/webm" }));
          if (result.text.trim()) onTranscript(result.text.trim());
          setVoiceState("ready");
        } catch (err) {
          setError(voiceErrorMessage(err));
          setVoiceState("error");
        }
      };

      recorder.start();
      setVoiceState("recording");
    } catch (err) {
      cleanupStream();
      setError(err instanceof Error ? err.message : "マイクの使用が許可されませんでした。");
      setVoiceState("error");
    }
  };

  const stopRecording = () => {
    if (recorderRef.current?.state === "recording") {
      setVoiceState("stopping");
      recorderRef.current.stop();
    }
  };

  const busy = state === "permission" || state === "stopping" || state === "transcribing";
  const recording = state === "recording";
  const label =
    state === "recording"
      ? "聞いています"
      : state === "transcribing"
        ? "文字にしています"
        : state === "permission"
          ? "マイクを許可してください"
          : state === "ready"
            ? "入力しました"
            : state === "error"
              ? error ?? "音声入力に失敗"
              : "音声で入力";

  return (
    <div className="voice-input">
      <button
        type="button"
        disabled={disabled || busy}
        onClick={recording ? stopRecording : startRecording}
        className="voice-orb"
        data-state={state}
        title={recording ? "録音を止める" : "音声で入力"}
        aria-label={recording ? "音声入力を止める" : "音声入力を始める"}
      >
        <span className="voice-orb__halo" aria-hidden="true" />
        <span className="voice-orb__core">
          {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : recording ? <Square className="h-5 w-5" /> : <Mic className="h-6 w-6" />}
        </span>
      </button>
      <span className="voice-input__label" data-state={state} aria-live="polite">
        {label}
      </span>
    </div>
  );
}
