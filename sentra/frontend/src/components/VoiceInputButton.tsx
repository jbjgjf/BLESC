"use client";

import { useRef, useState } from "react";
import { Loader2, Mic, Square } from "lucide-react";
import { ApiClient } from "@/api/client";
import { t } from "@/lib/i18n";

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
  const message = error instanceof Error ? error.message : t.voiceInput.error.generic;
  if (message.includes("503") || message.includes("not configured") || message.includes("USE_MOCK_LLM")) {
    return t.voiceInput.error.notConfigured;
  }
  if (message.includes("401") || message.includes("AuthenticationError")) {
    return t.voiceInput.error.auth;
  }
  if (message.includes("429") || message.includes("RateLimitError")) {
    return t.voiceInput.error.rateLimited;
  }
  if (message.includes("415") || message.includes("未対応の形式")) {
    return t.voiceInput.error.unsupportedFormat;
  }
  return message.replace(/^Audio transcription failed/, t.voiceInput.error.transcriptionFailed);
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
      setError(t.voiceInput.error.noRecorder);
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
        setError(t.voiceInput.error.recordingFailed);
        setVoiceState("error");
        cleanupStream();
      };
      recorder.onstop = async () => {
        setVoiceState("transcribing");
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        cleanupStream();
        if (!blob.size) {
          setError(t.voiceInput.error.emptyRecording);
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
      setError(err instanceof Error ? err.message : t.voiceInput.error.permissionDenied);
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
      ? t.voiceInput.labelRecording
      : state === "transcribing"
        ? t.voiceInput.labelTranscribing
        : state === "permission"
          ? t.voiceInput.labelPermission
          : state === "ready"
            ? t.voiceInput.labelReady
            : state === "error"
              ? error ?? t.voiceInput.labelError
              : t.voiceInput.labelIdle;

  return (
    <div className="voice-input">
      <button
        type="button"
        disabled={disabled || busy}
        onClick={recording ? stopRecording : startRecording}
        className="voice-orb"
        data-state={state}
        title={recording ? t.voiceInput.titleStop : t.voiceInput.labelIdle}
        aria-label={recording ? t.voiceInput.ariaStop : t.voiceInput.ariaStart}
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
