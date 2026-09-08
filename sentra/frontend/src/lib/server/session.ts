/**
 * The signed-in user, as a server component sees it (#164).
 *
 * `api.ts` already builds a Supabase client from a request, but it does it for
 * route handlers: its cookie adapter writes refreshed session cookies back,
 * which a React Server Component is not allowed to do. This is the same client
 * with the write half turned into a no-op, so a layout can ask who is signed in
 * without Next throwing on the first token refresh.
 *
 * Why a layout needs to ask at all: every existing gate in this app runs in the
 * browser (`AuthShell`, `educator/layout.tsx`), and a gate that runs in the
 * browser is a gate the browser can decline to run. For research collection
 * that is not good enough — see `pilotGate.ts`.
 */

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient, User } from "@supabase/supabase-js";

export async function supabaseForServerComponent(): Promise<SupabaseClient | null> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) return null;

  const cookieStore = await cookies();
  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      // A server component cannot set cookies. Swallowing the refresh here is
      // safe: the same session is refreshed by the route handlers and by the
      // browser client, both of which can write.
      setAll() {},
    },
  }) as SupabaseClient;
}

/**
 * The user, or null.
 *
 * `getUser` and not `getSession`: the session is whatever the cookie says, and
 * the cookie is supplied by the caller. `getUser` verifies the token with
 * Supabase, which is the difference between "this browser sent something that
 * parses" and "this is a signed-in account" — the whole point of moving the
 * gate to the server.
 */
export async function serverUser(): Promise<{ client: SupabaseClient; user: User } | null> {
  const client = await supabaseForServerComponent();
  if (!client) return null;

  const result = await client.auth.getUser();
  if (result.error || !result.data.user) return null;
  return { client, user: result.data.user };
}
