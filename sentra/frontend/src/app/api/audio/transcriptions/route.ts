import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const AUDIO_MAX_BYTES = Number(process.env.OPENAI_TRANSCRIPTION_MAX_BYTES ?? 24 * 1024 * 1024);
const AUDIO_EXTENSIONS = new Set(["webm", "wav", "mp3", "m4a", "mp4", "mpeg", "mpga"]);
const AUDIO_CONTENT_TYPES = new Set([
  "audio/webm",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp4",
  "audio/mpga",
  "audio/m4a",
  "video/webm",
]);

function openAIKey(): string | undefined {
  return process.env["OPENAI_" + "API_KEY"];
}

function audioExtension(filename: string): string {
  return filename.includes(".") ? filename.split(".").pop()?.toLowerCase() ?? "" : "";
}

function audioContentType(contentType: string): string {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export async function POST(request: NextRequest) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ detail: "Audio file is required." }, { status: 422 });
  }
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ detail: "Audio file is required." }, { status: 422 });
  }

  const extension = audioExtension(file.name);
  const contentType = audioContentType(file.type);
  if (!AUDIO_EXTENSIONS.has(extension) && !AUDIO_CONTENT_TYPES.has(contentType)) {
    return NextResponse.json(
      { detail: "Unsupported audio format. Use webm, wav, mp3, mp4, mpeg, mpga, or m4a." },
      { status: 415 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json({ detail: "Audio file is empty." }, { status: 422 });
  }
  if (file.size > AUDIO_MAX_BYTES) {
    return NextResponse.json({ detail: "Audio file is too large." }, { status: 413 });
  }

  const key = openAIKey();
  if (!key || process.env.USE_MOCK_LLM?.toLowerCase() === "true") {
    return NextResponse.json(
      { detail: "Voice transcription is not configured. Set OPENAI_API_KEY and ensure USE_MOCK_LLM is not true." },
      { status: 503 },
    );
  }

  const model = process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe";
  const upstream = new FormData();
  upstream.set("model", model);
  upstream.set("response_format", "json");
  upstream.set("prompt", "Transcribe the student's spoken reflection accurately. Preserve Japanese or English as spoken.");
  upstream.set("file", file, file.name || `recording.${extension || "webm"}`);

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
    },
    body: upstream,
  });

  if (!response.ok) {
    let detail = "Audio transcription failed at provider.";
    try {
      const payload = await response.json() as { error?: { type?: string; message?: string } };
      detail = payload.error?.type
        ? `Audio transcription failed at provider: ${payload.error.type}.`
        : payload.error?.message ?? detail;
    } catch {
      // Keep generic provider failure.
    }
    return NextResponse.json({ detail }, { status: 502 });
  }

  const payload = await response.json() as { text?: string };
  return NextResponse.json({
    text: payload.text ?? "",
    provider: "openai",
    model,
    status: "completed",
  });
}
