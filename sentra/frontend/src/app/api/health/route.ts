import { NextRequest, NextResponse } from "next/server";
import { openAIKey, requireUser } from "@/lib/server/api";
import { authorizedOperators } from "@/lib/server/pilotOperator";

// Route Handlers are uncached by default in this Next version, so this reads
// the running deployment's env on every request rather than a build snapshot.
export const runtime = "nodejs";

/**
 * Liveness for everyone, the deployment's self-report for operators (#245).
 *
 * Anyone gets `status` and `environment`, always with a 200: uptime checks read
 * this, and a change here that turned their probe red would quietly switch
 * monitoring off. The rest — which credentials are set, the commit, the models —
 * goes only to a signed-in account in `PILOT_OPERATOR_USER_IDS`, the same
 * allowlist the other operator surfaces use. No credentials are revealed even
 * then (booleans only), but the set of booleans is itself the configuration:
 * `supabase_service_role_key: true` says this process can get past row-level
 * security, and a commit says exactly which public source is running.
 *
 * An operator session rather than a shared secret: there is no new secret to
 * provision, and an operator can open the URL in a signed-in browser. Anything
 * short of a recognised operator gets the public answer, not a 401 or 404, so
 * the response does not say whether a detailed one exists. With no operators
 * configured, nobody gets the detail — closed, as `cronAuth.ts` is.
 *
 * A missing key here is the usual reason chat answers with its fallback
 * sentence instead of a model reply.
 */
export async function GET(request: NextRequest) {
  const environment = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown";
  const publicAnswer = NextResponse.json({ status: "ok", environment });

  if (!(await isOperator(request))) return publicAnswer;

  return NextResponse.json({
    status: "ok",
    environment,
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

async function isOperator(request: NextRequest): Promise<boolean> {
  const operators = authorizedOperators();
  // Skips the session lookup entirely when nobody could qualify.
  if (operators.size === 0) return false;
  try {
    const auth = await requireUser(request);
    return !("error" in auth) && operators.has(auth.user.id);
  } catch {
    // A failing auth lookup must not turn the liveness probe into a 500.
    return false;
  }
}
