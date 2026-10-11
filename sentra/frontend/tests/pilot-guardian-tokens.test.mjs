/**
 * Guardian verification tokens: the keyed hash and the link (#383).
 *
 * A guardian's confirmation is the only way a minor enters the study, and the
 * token is the only thing that identifies the guardian. `guardianTokens.ts`
 * states three properties in its header — the database never holds a token, no
 * key means nobody is verified, and a token is never "corrected" — and until
 * now a comment was all that held them.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  TOKEN_PREFIX_LENGTH,
  generateGuardianToken,
  guardianHashingConfigured,
  guardianHmacKey,
  guardianTokenPrefix,
  guardianVerificationUrl,
  hashGuardianToken,
  looksLikeGuardianToken,
} from "../src/lib/server/guardianTokens.ts";

const KEY_A = Buffer.alloc(32, 3).toString("base64");
const KEY_B = Buffer.alloc(32, 4).toString("base64");

let warn;
beforeEach(() => {
  warn = console.warn;
  console.warn = () => {};
});
afterEach(() => {
  console.warn = warn;
  delete process.env.PILOT_GUARDIAN_HMAC_KEY;
  delete process.env.NEXT_PUBLIC_SITE_URL;
});

describe("a deployment without a usable key verifies nobody", () => {
  it("hashes nothing when the key is absent", () => {
    const token = generateGuardianToken();
    assert.equal(guardianHmacKey(), null);
    assert.equal(guardianHashingConfigured(), false);
    assert.equal(hashGuardianToken(token), null);
  });

  it("hashes nothing when the key decodes to fewer than 32 bytes", () => {
    process.env.PILOT_GUARDIAN_HMAC_KEY = Buffer.alloc(31, 3).toString("base64");
    assert.equal(guardianHmacKey(), null);
    assert.equal(guardianHashingConfigured(), false);
    assert.equal(hashGuardianToken(generateGuardianToken()), null);
  });

  it("accepts a 32-byte key", () => {
    process.env.PILOT_GUARDIAN_HMAC_KEY = KEY_A;
    assert.equal(guardianHmacKey().length, 32);
    assert.equal(guardianHashingConfigured(), true);
  });
});

describe("hashGuardianToken", () => {
  it("is stable for one token and different for another", () => {
    process.env.PILOT_GUARDIAN_HMAC_KEY = KEY_A;
    const token = generateGuardianToken();
    assert.match(hashGuardianToken(token), /^[0-9a-f]{64}$/);
    assert.equal(hashGuardianToken(token), hashGuardianToken(token));
    assert.notEqual(hashGuardianToken(token), hashGuardianToken(generateGuardianToken()));
  });

  it("changes with the key, so rotating it invalidates every outstanding link", () => {
    const token = generateGuardianToken();
    process.env.PILOT_GUARDIAN_HMAC_KEY = KEY_A;
    const under_a = hashGuardianToken(token);
    process.env.PILOT_GUARDIAN_HMAC_KEY = KEY_B;
    assert.notEqual(hashGuardianToken(token), under_a);
  });

  it("does not absorb a change of case, a trimmed character or added whitespace", () => {
    // The opposite of `normalizeInviteCode`, on purpose: an invitation is
    // typed by a person, this arrives in a link. A token that still matched
    // after being altered would be a token with fewer than 256 bits.
    process.env.PILOT_GUARDIAN_HMAC_KEY = KEY_A;
    const token = "aB".repeat(21) + "c"; // 43 characters, mixed case
    const hash = hashGuardianToken(token);

    assert.notEqual(hashGuardianToken(token.toUpperCase()), hash);
    assert.notEqual(hashGuardianToken(token.toLowerCase()), hash);
    assert.notEqual(hashGuardianToken(token.slice(0, -1)), hash);
    assert.equal(hashGuardianToken(` ${token}`), null);
    assert.equal(hashGuardianToken(`${token}\n`), null);
  });

  it("refuses anything that is not token-shaped before computing a hash", () => {
    process.env.PILOT_GUARDIAN_HMAC_KEY = KEY_A;
    for (const value of ["", "short", "a".repeat(39), "a".repeat(65), "a".repeat(42) + "+", "a".repeat(42) + "/"]) {
      assert.equal(hashGuardianToken(value), null, `hashed ${JSON.stringify(value)}`);
    }
    for (const value of [null, undefined, 42, {}, ["a".repeat(43)]]) {
      assert.equal(looksLikeGuardianToken(value), false);
    }
  });
});

describe("generateGuardianToken", () => {
  it("returns 43 base64url characters that pass the shape check, never the same twice", () => {
    const tokens = Array.from({ length: 200 }, () => generateGuardianToken());
    for (const token of tokens) {
      assert.match(token, /^[A-Za-z0-9_-]{43}$/);
      assert.ok(looksLikeGuardianToken(token));
    }
    assert.equal(new Set(tokens).size, tokens.length);
  });

  it("has a prefix too short to present as a token", () => {
    const token = generateGuardianToken();
    assert.equal(guardianTokenPrefix(token), token.slice(0, TOKEN_PREFIX_LENGTH));
    assert.equal(looksLikeGuardianToken(guardianTokenPrefix(token)), false);
  });
});

describe("guardianVerificationUrl", () => {
  const token = "abc_DEF-123".padEnd(43, "x");

  it("is built from NEXT_PUBLIC_SITE_URL", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://pilot.example";
    assert.equal(guardianVerificationUrl(token), `https://pilot.example/pilot/guardian/${token}`);
  });

  it("does not double the slash when the site URL ends with one", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://pilot.example/";
    assert.equal(guardianVerificationUrl(token), `https://pilot.example/pilot/guardian/${token}`);
  });

  it("is a bare path when no site URL is configured", () => {
    // Takes a token and nothing else: there is no request, and so no Host
    // header, for it to read an origin from.
    assert.equal(guardianVerificationUrl.length, 1);
    assert.equal(guardianVerificationUrl(token), `/pilot/guardian/${token}`);
  });

  it("encodes whatever it is given into one path segment", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://pilot.example";
    assert.equal(
      guardianVerificationUrl("a/b?c#d e"),
      "https://pilot.example/pilot/guardian/a%2Fb%3Fc%23d%20e",
    );
  });
});
