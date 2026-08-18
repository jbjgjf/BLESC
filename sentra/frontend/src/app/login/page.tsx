"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { Icon } from "@/components/ui/Icon";
import styles from "./login.module.css";

/** Supabase の英語メッセージを、生徒にも読める日本語に置き換える。 */
function localizeAuthError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("invalid login credentials")) {
    return "メールアドレスまたはパスワードが正しくありません。";
  }
  if (lower.includes("email not confirmed")) {
    return "メールアドレスの確認が完了していません。届いたメールのリンクを開いてください。";
  }
  if (lower.includes("user already registered")) {
    return "このメールアドレスはすでに登録されています。ログインを選んでください。";
  }
  if (lower.includes("password should be at least")) {
    return "パスワードは6文字以上で入力してください。";
  }
  if (lower.includes("rate limit") || lower.includes("too many")) {
    return "試行回数が多すぎます。しばらく待ってからもう一度お試しください。";
  }
  if (lower.includes("fetch") || lower.includes("network")) {
    return "通信に失敗しました。接続を確認してもう一度お試しください。";
  }
  return message;
}

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
    const result =
      mode === "signin"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({
            email,
            password,
            options: { emailRedirectTo: authRedirectUrl },
          });

    setIsSubmitting(false);

    if (result.error) {
      setMessage(localizeAuthError(result.error.message));
      return;
    }

    if (mode === "signup" && !result.data.session) {
      setMessage("確認メールを送りました。メール内のリンクを開いたあと、ログインしてください。");
      return;
    }

    router.replace(searchParams.get("next") || "/");
  };

  return (
    <main className={styles.page}>
      <section className={`${styles.card} bl-pop`}>
        <div className={styles.brand}>
          <Image src="/flower.png" width={44} height={44} unoptimized alt="" className={styles.flower} />
          <div>
            <h1 className="bl-h2">blesc</h1>
            <p className="bl-meta">
              {mode === "signin" ? "ログインしてはじめる" : "アカウントを作成する"}
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className={styles.form}>
          <div>
            <label className="bl-label" htmlFor="email">
              <Icon name="person" size={19} />
              メールアドレス
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="bl-input"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label className="bl-label" htmlFor="password">
              <Icon name="lock" size={19} />
              パスワード
            </label>
            <input
              id="password"
              type="password"
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              required
              minLength={6}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="bl-input"
              placeholder={mode === "signup" ? "6文字以上" : ""}
            />
          </div>

          {message && (
            <div className="bl-notice bl-notice--watch" role="alert">
              <Icon name="info" size={19} />
              <span>{message}</span>
            </div>
          )}

          <button type="submit" disabled={isSubmitting} className="bl-btn bl-btn--primary bl-btn--block bl-btn--lg">
            {isSubmitting && <span className={styles.spinner} aria-hidden="true" />}
            {mode === "signin" ? "ログイン" : "アカウントを作成"}
          </button>
        </form>

        <button
          type="button"
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setMessage(null);
          }}
          className="bl-btn bl-btn--ghost bl-btn--block"
          style={{ marginTop: 10 }}
        >
          {mode === "signin" ? "アカウントをお持ちでない方はこちら" : "すでにアカウントをお持ちの方はこちら"}
        </button>

        <p className="bl-disclaimer" style={{ marginTop: 18, justifyContent: "center" }}>
          <Icon name="shield" size={15} />
          blescは診断や緊急対応を行うものではありません。
        </p>
      </section>
    </main>
  );
}
