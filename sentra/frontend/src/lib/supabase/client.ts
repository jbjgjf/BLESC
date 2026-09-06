"use client";

import { createBrowserClient } from "@supabase/ssr";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

/**
 * Whether the app is allowed to run without Supabase credentials.
 *
 * A deployment without them is broken and should say so at boot rather than
 * one screen at a time, so that case still throws. But this module is imported
 * by `auth.tsx`, which the root layout renders, so throwing here took the whole
 * app down — including demo mode, which reads fixtures and never reaches
 * Supabase at all. A fresh clone could not run the demo #17 asks for without
 * first obtaining credentials it does not use.
 *
 * `next dev` and an explicitly demo-enabled deployment are therefore allowed to
 * start unconfigured. Nothing is silently degraded: `isSupabaseConfigured` stays
 * false, the placeholder host resolves nowhere, and every read reports its own
 * failure the way it already did.
 */
const ALLOW_UNCONFIGURED =
  process.env.NODE_ENV === "development" || process.env.NEXT_PUBLIC_DEMO_MODE === "1";

if (!isSupabaseConfigured && !ALLOW_UNCONFIGURED) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
}

//: `.invalid` is reserved by RFC 2606 and cannot resolve, so an accidental
//: request fails as a network error rather than reaching someone's host.
const configuredSupabaseUrl = supabaseUrl ?? "https://unconfigured.invalid";
const configuredSupabaseAnonKey = supabaseAnonKey ?? "unconfigured";

console.info("[supabase] auth config", {
  configured: isSupabaseConfigured,
  url: isSupabaseConfigured ? configuredSupabaseUrl : "(unconfigured)",
  persistSession: true,
  autoRefreshToken: true,
  detectSessionInUrl: true,
});

export const supabase = createBrowserClient(configuredSupabaseUrl, configuredSupabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
