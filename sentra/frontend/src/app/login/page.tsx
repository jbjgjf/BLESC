"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [message, setMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSubmitting(true);
    setMessage(null);

    const authRedirectUrl = `${window.location.origin}/login`;
    const result = mode === "signin"
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: authRedirectUrl,
          },
        });

    setIsSubmitting(false);

    if (result.error) {
      setMessage(result.error.message);
      return;
    }

    if (mode === "signup" && !result.data.session) {
      setMessage("Check your email to confirm your account, then sign in.");
      return;
    }

    router.replace(searchParams.get("next") || "/");
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#08070b] px-4 py-10">
      <section className="w-full max-w-md rounded-lg border border-[#22212c] bg-[#0f0e15] p-6 shadow-2xl shadow-black/80">
        <div className="flex items-center gap-3 text-zinc-100">
          <Image
            src="/logo.svg"
            width={40}
            height={40}
            unoptimized
            className="h-10 w-10 object-contain shrink-0"
            alt="BLESC Logo"
          />
          <div>
            <h1 className="text-lg font-semibold text-zinc-100">BLESC</h1>
            <p className="text-sm text-zinc-400">Sign in to continue monitoring</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-zinc-300" htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="mt-2 h-11 w-full rounded-md border border-[#22212c] bg-[#14131d] px-3 text-sm text-white outline-none transition focus:border-cyan-500 focus:bg-[#1b1a26]"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-300" htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              required
              minLength={6}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-2 h-11 w-full rounded-md border border-[#22212c] bg-[#14131d] px-3 text-sm text-white outline-none transition focus:border-cyan-500 focus:bg-[#1b1a26]"
            />
          </div>

          {message && (
            <div className="rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
              {message}
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-cyan-500 px-4 text-sm font-semibold text-black transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500 cursor-pointer"
            style={{ boxShadow: isSubmitting ? "none" : "0 0 14px rgba(6, 182, 212, 0.3)" }}
          >
            {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>

        <button
          type="button"
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setMessage(null);
          }}
          className="mt-4 w-full rounded-md px-3 py-2 text-sm font-medium text-cyan-400 transition hover:bg-cyan-950/30 cursor-pointer"
        >
          {mode === "signin" ? "Create an email/password account" : "Use an existing account"}
        </button>
      </section>
    </main>
  );
}
