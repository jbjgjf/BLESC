/**
 * Server-side proxy to the FastAPI research API (#152).
 *
 * The research credential is a secret. It stays in the Next.js server process
 * and never reaches the browser, so the screen talks to this route and this
 * route talks to the backend. Sending the token to the client to save a hop
 * would put a training endpoint's credential in every reader's devtools.
 *
 * Access is an explicit allowlist of Supabase user ids in
 * `RESEARCH_UI_ALLOWED_USER_IDS`. Unset means nobody, not everybody: an
 * endpoint that schedules model training is not one to open by default because
 * a deployment forgot a variable. Per-researcher accounts with a real role
 * claim are the follow-up; an allowlist is small enough to be obviously
 * correct in the meantime.
 *
 * Only the four contract paths are forwarded. A wildcard proxy into the backend
 * would let this route reach every product endpoint with a research credential
 * attached.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const BACKEND_BASE = process.env.RESEARCH_API_BASE_URL || "http://127.0.0.1:8000";

/** The only paths this route will forward, as literal templates. */
const ALLOWED = [
  { method: "POST", pattern: /^runs$/ },
  { method: "GET", pattern: /^runs\/[A-Za-z0-9_-]{1,64}$/ },
  { method: "GET", pattern: /^runs\/[A-Za-z0-9_-]{1,64}\/report$/ },
  { method: "GET", pattern: /^runs\/[A-Za-z0-9_-]{1,64}\/explanations$/ },
];

function allowedUserIds(): string[] {
  return (process.env.RESEARCH_UI_ALLOWED_USER_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function authorizedUserId(request: NextRequest): Promise<string | null> {
  const header = request.headers.get("authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) return null;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;

  const supabase = createClient(url, key);
  const { data, error } = await supabase.auth.getUser(header.slice(7).trim());
  if (error || !data.user) return null;
  return data.user.id;
}

async function forward(request: NextRequest): Promise<NextResponse> {
  const token = process.env.RESEARCH_API_TOKEN;
  if (!token) {
    return NextResponse.json({ detail: "research_api_not_configured" }, { status: 503 });
  }

  const allowed = allowedUserIds();
  const userId = await authorizedUserId(request);
  if (!userId || allowed.length === 0 || !allowed.includes(userId)) {
    return NextResponse.json({ detail: "forbidden" }, { status: 403 });
  }

  const path = (request.nextUrl.searchParams.get("path") || "").replace(/^\/+/, "");
  const permitted = ALLOWED.some(
    (entry) => entry.method === request.method && entry.pattern.test(path),
  );
  if (!permitted) {
    return NextResponse.json({ detail: "path_not_allowed" }, { status: 400 });
  }

  const body = request.method === "POST" ? await request.text() : undefined;
  const response = await fetch(`${BACKEND_BASE}/api/research/world-model/${path}`, {
    method: request.method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body,
    cache: "no-store",
  });

  const text = await response.text();
  return new NextResponse(text, {
    status: response.status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function GET(request: NextRequest) {
  return forward(request);
}

export async function POST(request: NextRequest) {
  return forward(request);
}
