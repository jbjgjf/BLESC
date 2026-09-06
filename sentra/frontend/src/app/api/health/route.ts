import { NextResponse } from "next/server";
import { openAIKey } from "@/lib/server/api";

export const runtime = "nodejs";

/**
 * A secret-free deployment check for operators. This reports configuration
 * presence and the selected models without exposing credential values.
 */
export async function GET() {
  return NextResponse.json({
    status: "ok",
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    config: {
      supabase_url: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
      supabase_anon_key: Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      supabase_service_role_key: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      openai_api_key: Boolean(openAIKey()),
      mock_llm: process.env.USE_MOCK_LLM?.toLowerCase() === "true",
      extraction_model:
        process.env.OPENAI_EXTRACTION_MODEL || process.env.LLM_MODEL_NAME || "gpt-6-astra",
      extraction_reasoning_effort:
        process.env.OPENAI_EXTRACTION_REASONING_EFFORT || "high",
      chat_model:
        process.env.OPENAI_CHAT_MODEL || process.env.LLM_MODEL_NAME || "gpt-6-astra",
      chat_reasoning_effort: process.env.OPENAI_CHAT_REASONING_EFFORT || "medium",
      external_api_url: Boolean(process.env.NEXT_PUBLIC_API_URL),
    },
  });
}
