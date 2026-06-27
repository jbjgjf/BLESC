import { NextRequest, NextResponse } from "next/server";
import { fetchWithTimeout, jsonError, openAIKey, providerError, requireUser, sha256 } from "@/lib/server/api";

export const runtime = "nodejs";
export const maxDuration = 30;

type VoiceRequest = {
  voice?: string;
};

const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";
const REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || "marin";
const ALLOWED_VOICES = new Set(["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"]);

export async function POST(request: NextRequest) {
  const auth = await requireUser(request);
  if ("error" in auth) return auth.error;

  const key = openAIKey();
  if (!key || process.env.USE_MOCK_LLM?.toLowerCase() === "true") {
    return jsonError("Realtime voice is not configured. Set OPENAI_API_KEY and ensure USE_MOCK_LLM is not true.", 503);
  }

  const payload = await request.json().catch(() => ({})) as VoiceRequest;
  const requestedVoice = payload.voice && ALLOWED_VOICES.has(payload.voice) ? payload.voice : REALTIME_VOICE;
  const safetyIdentifier = await sha256(auth.user.id);

  const response = await fetchWithTimeout("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": safetyIdentifier,
    },
    body: JSON.stringify({
      expires_after: {
        anchor: "created_at",
        seconds: 600,
      },
      session: {
        type: "realtime",
        model: REALTIME_MODEL,
        output_modalities: ["audio"],
        instructions: [
          "You are BLESC Voice, a natural, brief, non-diagnostic reflection companion for students.",
          "Keep turns short and conversational.",
          "Do not diagnose, treat, predict risk, or replace trusted adults, guardians, school counselors, emergency services, or licensed professionals.",
          "If the student mentions imminent danger or self-harm, calmly direct them to emergency services or a trusted adult immediately.",
        ].join(" "),
        audio: {
          input: {
            transcription: {
              model: process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe",
            },
            turn_detection: {
              type: "semantic_vad",
              interrupt_response: true,
              create_response: true,
            },
          },
          output: {
            voice: requestedVoice,
          },
        },
      },
    }),
  }, Number(process.env.OPENAI_REALTIME_TIMEOUT_MS ?? 20000));

  if (!response.ok) {
    const error = await providerError(response, "Realtime session creation failed.");
    return jsonError(error.detail, response.status === 429 ? 429 : 502, { code: error.code });
  }

  const data = await response.json() as { value?: string; expires_at?: number; session?: unknown };
  if (!data.value) return jsonError("Realtime session response did not include a client secret.", 502);

  return NextResponse.json({
    client_secret: data.value,
    expires_at: data.expires_at ?? null,
    session: data.session ?? null,
    model: REALTIME_MODEL,
    voice: requestedVoice,
  });
}
