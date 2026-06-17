"use client";

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

if (!isSupabaseConfigured) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
}

const configuredSupabaseUrl = supabaseUrl as string;
const configuredSupabaseAnonKey = supabaseAnonKey as string;

console.info("[supabase] url", configuredSupabaseUrl);
console.info("[supabase] auth config", {
  hasUrl: Boolean(configuredSupabaseUrl),
  hasAnonKey: Boolean(configuredSupabaseAnonKey),
  persistSession: true,
  autoRefreshToken: true,
  detectSessionInUrl: true,
});

export const supabase = createClient(configuredSupabaseUrl, configuredSupabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
