import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function openAIKey(): string | undefined {
  return process.env["OPENAI_" + "API_KEY"];
}

export function jsonError(detail: string, status: number, extra: Record<string, JsonValue> = {}) {
  return NextResponse.json({ detail, ...extra }, { status });
}

type ApiAuth = { error: NextResponse } | { client: SupabaseClient };
type ApiUserAuth = { error: NextResponse } | { client: SupabaseClient; user: User };

export async function supabaseForRequest(request: NextRequest): Promise<ApiAuth> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const authorization = request.headers.get("authorization");

  if (!supabaseUrl || !supabaseAnonKey) {
    return { error: jsonError("Supabase is not configured.", 503) };
  }

  if (authorization) {
    const client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: authorization } },
    }) as SupabaseClient;
    return { client };
  }

  const cookieStore = await cookies();
  const client = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          cookieStore.set(name, value, options);
        });
      },
    },
  }) as SupabaseClient;
  return { client };
}

export async function requireUser(request: NextRequest): Promise<ApiUserAuth> {
  const auth = await supabaseForRequest(request);
  if ("error" in auth) return auth;

  const userResult = await auth.client.auth.getUser();
  if (userResult.error || !userResult.data.user) {
    return { error: jsonError("Authentication is required.", 401) };
  }

  return { client: auth.client, user: userResult.data.user };
}

export function isMissingTable(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "PGRST205",
  );
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function providerError(response: Response, fallback: string) {
  try {
    const payload = await response.json() as { error?: { code?: string; type?: string; message?: string } };
    return {
      detail: payload.error?.message ?? fallback,
      code: payload.error?.code ?? payload.error?.type ?? `http_${response.status}`,
    };
  } catch {
    return { detail: fallback, code: `http_${response.status}` };
  }
}
