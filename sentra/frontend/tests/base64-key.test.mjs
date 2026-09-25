import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { KEY_RULES, base64KeyAdvice, readBase64Key } from "../src/lib/server/base64Key.ts";
import { configChecks, blockingGaps } from "../src/lib/server/opsConfig.ts";
import { rawTextKeyMaterial } from "../src/lib/server/rawTextCrypto.ts";
import { inviteHmacKey } from "../src/lib/server/inviteCodes.ts";
import { guardianHmacKey } from "../src/lib/server/guardianTokens.ts";
import { recipientHashKey } from "../src/lib/server/safetyEscalation.ts";

/**
 * Reading a base64 key, and the two ways it used to go wrong (#255).
 *
 * The version this replaced wrapped `Buffer.from(value, "base64")` in a
 * `try`/`catch` in five places, and `opsConfig.ts` restated the length rule as
 * "32 or more" for every key including the one that needs exactly 32. Both
 * defects are invisible in review — the code reads as if it validates — so the
 * tests here are written to fail if either comes back, not to describe the
 * happy path.
 */

const KEYS = [
  "RESEARCH_RAW_TEXT_KEY",
  "SAFETY_RECIPIENT_HASH_KEY",
  "PILOT_INVITE_HMAC_KEY",
  "PILOT_GUARDIAN_HMAC_KEY",
];

const saved = new Map(KEYS.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** `openssl rand -hex 32`, which is what an operator reaches for. */
const HEX_32 = "9f2c4e7a1b8d0356f9e2c4a7b1d8e0365f2a9c4e7b1d8a0f3c6e9b2d5a8f1c4e";
/** `openssl rand -base64 32`, which is what the documents ask for. */
const BASE64_32 = bytes(32).toString("base64");

/**
 * Key material that looks like key material.
 *
 * Not `Buffer.alloc(n)`: an all-zero 48-byte buffer base64-encodes to 64 `A`s,
 * which is a string of hex digits, and `readBase64Key` would — correctly —
 * call it a hex key. A buffer with no entropy in it is not a key, and using
 * one as a fixture tests the heuristic against the one input it is allowed to
 * be wrong about.
 */
function bytes(length) {
  return Buffer.from(Array.from({ length }, (_, i) => (i * 97 + 41) % 256));
}

describe("readBase64Key", () => {
  it("rejects what Buffer.from would have accepted in silence", () => {
    // The premise, asserted rather than assumed: this call is why the old
    // `catch` blocks were unreachable. If a future Node makes it throw, the
    // rest of this file is testing something that can no longer happen and
    // whoever sees this fail should know that.
    assert.doesNotThrow(() => Buffer.from("not base64 at all!!!", "base64"));
    assert.ok(
      Buffer.from("not base64 at all!!!", "base64").length > 0,
      "Buffer.from drops the invalid characters and decodes the rest",
    );

    // Long enough that the garbage survives the length check: each of these
    // decodes to well over 32 bytes once the invalid characters are dropped,
    // so the length check — all that used to be running — accepts every one.
    for (const value of [
      `${BASE64_32} ${BASE64_32}`,
      `sk_live_${BASE64_32}!!!${BASE64_32}`,
      `${BASE64_32}\n${BASE64_32}`.replace(/=/g, "%"),
    ]) {
      assert.ok(
        Buffer.from(value, "base64").length >= 32,
        "the fixture has to be one the old length check would have accepted",
      );
      const result = readBase64Key(value, { minBytes: 32 });
      assert.equal(result.ok, false, `${JSON.stringify(value)} must not read as a key`);
      assert.equal(result.problem, "not_base64");
    }
  });

  it("names a hex key as a hex key rather than as a length problem", () => {
    // 64 hex characters are all inside the base64 alphabet, so this decodes
    // cleanly to 48 bytes. Nothing about the decode says it is wrong; the only
    // honest answer is the one that names the format.
    assert.equal(Buffer.from(HEX_32, "base64").length, 48);

    for (const rule of [{ bytes: 32 }, { minBytes: 32 }]) {
      const result = readBase64Key(HEX_32, rule);
      assert.equal(result.ok, false);
      assert.equal(result.problem, "looks_like_hex");
    }

    assert.match(base64KeyAdvice("looks_like_hex"), /openssl rand -base64/);
  });

  it("separates absent from malformed", () => {
    assert.equal(readBase64Key(undefined, { minBytes: 32 }).problem, "absent");
    assert.equal(readBase64Key("   ", { minBytes: 32 }).problem, "absent");
    assert.equal(readBase64Key("!!!!", { minBytes: 32 }).problem, "not_base64");
    assert.equal(readBase64Key(bytes(16).toString("base64"), { minBytes: 32 }).problem, "wrong_length");
  });

  it("holds exact and minimum rules apart", () => {
    const fortyEight = bytes(48).toString("base64");
    assert.equal(readBase64Key(fortyEight, { minBytes: 32 }).ok, true, "48 is at least 32");
    assert.equal(readBase64Key(fortyEight, { bytes: 32 }).ok, false, "48 is not 32");
    assert.equal(readBase64Key(fortyEight, { bytes: 32 }).problem, "wrong_length");
  });

  it("forgives a pasted newline and unpadded base64url, and nothing inside the value", () => {
    assert.equal(readBase64Key(`  ${BASE64_32}\n`, { bytes: 32 }).ok, true);

    const urlUnpadded = bytes(32).toString("base64url");
    assert.ok(!urlUnpadded.includes("="), "base64url is written without padding");
    assert.equal(readBase64Key(urlUnpadded, { bytes: 32 }).ok, true);

    const withQuotes = `"${BASE64_32}"`;
    assert.equal(readBase64Key(withQuotes, { bytes: 32 }).ok, false, "quotes are not silently dropped");
  });

  it("gives back the bytes the key is, not a copy of the string", () => {
    const result = readBase64Key(BASE64_32, { bytes: 32 });
    assert.equal(result.ok, true);
    assert.equal(result.bytes.length, 32);
    assert.deepEqual(Uint8Array.from(result.bytes), Uint8Array.from(bytes(32)));
  });
});

describe("the deployment self-check and the code that reads the key", () => {
  const check = (name) => configChecks().find((row) => row.name === name);

  /** Each key's self-check row, paired with the function that actually loads it. */
  const PAIRS = [
    { name: "RESEARCH_RAW_TEXT_KEY", load: rawTextKeyMaterial },
    { name: "SAFETY_RECIPIENT_HASH_KEY", load: recipientHashKey },
    { name: "PILOT_INVITE_HMAC_KEY", load: inviteHmacKey },
  ];

  it("agrees, for every value either of them might be handed", () => {
    // The bug was a disagreement, so this is the assertion that matters: not
    // "the check is right about this value" but "the check and the loader
    // cannot say different things". A future edit to one side alone fails here.
    const VALUES = [
      undefined,
      "",
      HEX_32,
      BASE64_32,
      bytes(16).toString("base64"),
      bytes(48).toString("base64"),
      "not base64 at all!!!",
    ];

    for (const { name, load } of PAIRS) {
      for (const value of VALUES) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;

        assert.equal(
          check(name).valid,
          load() !== null,
          `${name}: the ops report and the loader disagree about ${JSON.stringify(value)}`,
        );
      }
    }
  });

  it("does not report a hex RESEARCH_RAW_TEXT_KEY as healthy", () => {
    // The whole failure, end to end. Before #255 this row read `valid: true`
    // while `rawTextKeyMaterial()` returned null — so no journal text was
    // retained, the §4.4 review queue stayed permanently empty, and the
    // operator's own diagnostic said the deployment was fine.
    process.env.RESEARCH_RAW_TEXT_KEY = HEX_32;

    const row = check("RESEARCH_RAW_TEXT_KEY");
    assert.equal(row.configured, true, "somebody did set it");
    assert.equal(row.valid, false, "48 bytes is not a 32-byte AES key");
    assert.equal(rawTextKeyMaterial(), null, "and the loader refuses it too");
    assert.match(row.consequence, /hex/, "the report says what is wrong with it");

    // The same 48 bytes written as real base64 are still not an AES-256 key.
    // This is the half of the disagreement that lived in `opsConfig.ts`: it
    // asked for "32 or more" where the algorithm takes 32 and nothing else.
    process.env.RESEARCH_RAW_TEXT_KEY = bytes(48).toString("base64");
    assert.equal(rawTextKeyMaterial(), null, "AES-256 takes exactly 32 bytes");
    assert.equal(check("RESEARCH_RAW_TEXT_KEY").valid, false, "and the report must say so");
  });

  it("raises an unusable invite key as a blocking gap", () => {
    // This row used to be `Boolean(process.env.PILOT_INVITE_HMAC_KEY)`, so a
    // value `inviteHmacKey()` refuses left the deployment reading as ready
    // while no invitation code could be issued or redeemed.
    process.env.PILOT_INVITE_HMAC_KEY = bytes(16).toString("base64");
    assert.equal(inviteHmacKey(), null);
    assert.ok(
      blockingGaps().some((gap) => gap.name === "PILOT_INVITE_HMAC_KEY"),
      "a key that cannot hash a code is a blocking gap",
    );

    process.env.PILOT_INVITE_HMAC_KEY = BASE64_32;
    assert.ok(!blockingGaps().some((gap) => gap.name === "PILOT_INVITE_HMAC_KEY"));
  });

  it("still carries neither the value nor its length into the report", () => {
    const sentinel = "SENTINEL-c0ffee-do-not-leak";
    for (const name of KEYS) process.env[name] = sentinel;

    const serialized = JSON.stringify(configChecks());
    assert.ok(!serialized.includes(sentinel), "a secret's value reached the ops report");
    assert.ok(!serialized.includes(String(sentinel.length)), "the report leaked a secret's length");
  });
});

describe("the guardian key", () => {
  it("is refused in the same shapes as the others", () => {
    // Not in `configChecks()` — the ops report does not have a row for it —
    // but it is loaded through the same rule, and a guardian link verified
    // under a mistyped key is a parent's consent recorded against nothing.
    process.env.PILOT_GUARDIAN_HMAC_KEY = HEX_32;
    assert.equal(guardianHmacKey(), null);

    process.env.PILOT_GUARDIAN_HMAC_KEY = BASE64_32;
    assert.notEqual(guardianHmacKey(), null);
    assert.equal(guardianHmacKey().length, 32);
  });

  it("shares one rule with the invitation key rather than restating it", () => {
    assert.deepEqual(KEY_RULES.PILOT_GUARDIAN_HMAC_KEY, KEY_RULES.PILOT_INVITE_HMAC_KEY);
    assert.deepEqual(KEY_RULES.RESEARCH_RAW_TEXT_KEY, { bytes: 32 });
  });
});
