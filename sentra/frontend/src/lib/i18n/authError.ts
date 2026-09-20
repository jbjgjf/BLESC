import { t } from "./index.ts";

/** Never surface an unreviewed provider error or English fallback to a student. */
export function localizeAuthError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("invalid login credentials")) return t.login.error.invalidCredentials;
  if (lower.includes("email not confirmed")) return t.login.error.emailNotConfirmed;
  if (lower.includes("user already registered")) return t.login.error.alreadyRegistered;
  if (lower.includes("password should be at least")) return t.login.error.passwordTooShort;
  if (lower.includes("rate limit") || lower.includes("too many")) return t.login.error.rateLimited;
  if (lower.includes("fetch") || lower.includes("network")) return t.login.error.network;
  return t.login.error.generic;
}
