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
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
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
      setError("Microphone recording is not supported in this browser.");
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
        setError("Recording failed.");
        setVoiceState("error");
        cleanupStream();
      };
      recorder.onstop = async () => {
        setVoiceState("transcribing");
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        cleanupStream();
        if (!blob.size) {
          setError("No audio was recorded.");
          setVoiceState("error");
          return;
        }
        try {
          const extension = blob.type.includes("mp4") ? "mp4" : "webm";
          const result = await ApiClient.transcribeAudio(new File([blob], `blesc-voice.${extension}`, { type: blob.type || "audio/webm" }));
          if (result.text.trim()) onTranscript(result.text.trim());
          setVoiceState("ready");
        } catch (err) {
          setError(err instanceof Error ? err.message : "Transcription failed.");
          setVoiceState("error");
        }
      };

      recorder.start();
      setVoiceState("recording");
    } catch (err) {
      cleanupStream();
      setError(err instanceof Error ? err.message : "Microphone permission was denied.");
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

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={disabled || busy}
        onClick={recording ? stopRecording : startRecording}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md transition-all disabled:cursor-not-allowed"
        title={recording ? "Stop recording" : "Record voice"}
        style={{
          border: "1px solid var(--limestone)",
          backgroundColor: recording ? "var(--terracotta)" : "var(--ivory-warm)",
          color: recording ? "#ffffff" : "var(--ink)",
        }}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : recording ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
      </button>
      <span className="text-xs" style={{ color: state === "error" ? "var(--sienna)" : "var(--ink-faint)", fontStyle: "italic" }}>
        {state === "recording" && "Recording"}
        {state === "transcribing" && "Transcribing"}
        {state === "permission" && "Allow microphone"}
        {state === "ready" && "Transcript inserted"}
        {state === "error" && (error ?? "Voice input failed")}
      </span>
    </div>
  );
}
