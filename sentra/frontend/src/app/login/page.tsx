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

  const inputClass =
    "mt-2 h-11 w-full rounded-2xl border px-4 text-sm outline-none transition " +
    "border-[hsl(206,62%,86%)] bg-[hsl(206,80%,97%)] text-[hsl(206,60%,18%)] " +
    "focus:border-[hsl(206,74%,56%)] focus:bg-white";

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <section
        className="w-full max-w-md rounded-3xl border p-7"
        style={{
          borderColor: "hsla(206, 74%, 72%, 0.45)",
          backgroundColor: "hsla(0, 0%, 100%, 0.8)",
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
          boxShadow: "0 10px 40px hsla(206, 60%, 50%, 0.15), inset 0 1px 0 hsla(0, 0%, 100%, 0.7)",
        }}
      >
        <div className="flex items-center gap-3">
          <Image
            src="/flower.png"
            width={40}
            height={40}
            unoptimized
            className="h-10 w-10 shrink-0 object-contain"
            alt="blesc logo"
          />
          <div>
            <h1 className="text-lg font-bold" style={{ color: "hsl(206, 60%, 18%)" }}>blesc</h1>
            <p className="text-sm" style={{ color: "hsl(206, 32%, 36%)" }}>Sign in to continue</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label className="block text-sm font-medium" style={{ color: "hsl(206, 46%, 27%)" }} htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className={inputClass}
            />
          </div>

          <div>
            <label className="block text-sm font-medium" style={{ color: "hsl(206, 46%, 27%)" }} htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              required
              minLength={6}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={inputClass}
            />
          </div>

          {message && (
            <div className="rounded-2xl border px-3 py-2 text-sm" style={{ borderColor: "hsl(36, 80%, 75%)", backgroundColor: "hsl(36, 90%, 95%)", color: "hsl(36, 85%, 26%)" }}>
              {message}
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-full px-4 text-sm font-semibold text-white transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
            style={{
              background: "linear-gradient(160deg, hsl(206, 74%, 60%), hsl(206, 72%, 46%))",
              boxShadow: isSubmitting ? "none" : "0 4px 14px hsla(206, 74%, 55%, 0.4)",
            }}
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
          className="mt-4 w-full cursor-pointer rounded-full px-3 py-2 text-sm font-medium transition hover:bg-[hsla(206,74%,72%,0.15)]"
          style={{ color: "hsl(206, 72%, 40%)" }}
        >
          {mode === "signin" ? "Create an email/password account" : "Use an existing account"}
        </button>
      </section>
    </main>
  );
}
