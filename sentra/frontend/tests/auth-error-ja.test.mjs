import assert from "node:assert/strict";
import { it } from "node:test";
import { localizeAuthError } from "../src/lib/i18n/authError.ts";
import { t } from "../src/lib/i18n/index.ts";

it("keeps known authentication errors in the reviewed catalogue", () => {
  for (const [message, key] of [
    ["Invalid login credentials", "invalidCredentials"],
    ["Email not confirmed", "emailNotConfirmed"],
    ["User already registered", "alreadyRegistered"],
    ["Password should be at least 6 characters", "passwordTooShort"],
    ["Too many requests", "rateLimited"],
    ["Failed to fetch", "network"],
  ]) assert.equal(localizeAuthError(message), t.login.error[key]);
});
it("does not leak unknown provider errors or identifiers into UI", () => {
  for (const raw of ["Database error saving new user", "Unexpected error: internal-token-sentinel", ""]) {
    assert.equal(localizeAuthError(raw), t.login.error.generic);
    assert.doesNotMatch(localizeAuthError(raw), /internal-token-sentinel|Database error/);
  }
});
