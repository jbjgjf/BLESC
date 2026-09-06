import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

const modulePath = "../src/lib/server/rawTextCrypto.ts";

/** A fresh 32-byte key, base64, as the env var expects. */
const testKey = Buffer.from(new Uint8Array(32).map((_, index) => index + 1)).toString("base64");

/**
 * The module reads `process.env` on every call, so the env can be changed
 * between cases without reimporting — but the retention-days constant is read
 * at module load, so that one case imports with a cache-busting query.
 */
const load = () => import(modulePath);

afterEach(() => {
  delete process.env.RESEARCH_RAW_TEXT_KEY;
});

describe("rawTextKeyMaterial", () => {
  it("reports no key when the variable is unset", async () => {
    const { rawTextRetentionConfigured, rawTextKeyMaterial } = await load();
    assert.equal(rawTextKeyMaterial(), null);
    assert.equal(rawTextRetentionConfigured(), false);
  });

  it("rejects a key that is not 32 bytes", async () => {
    process.env.RESEARCH_RAW_TEXT_KEY = Buffer.from("too short").toString("base64");
    const { rawTextKeyMaterial } = await load();
    assert.equal(rawTextKeyMaterial(), null);
  });

  it("accepts a 32-byte key", async () => {
    process.env.RESEARCH_RAW_TEXT_KEY = testKey;
    const { rawTextKeyMaterial, rawTextRetentionConfigured } = await load();
    assert.equal(rawTextKeyMaterial()?.length, 32);
    assert.equal(rawTextRetentionConfigured(), true);
  });
});

describe("encryptRawText", () => {
  it("stores nothing when no key is configured", async () => {
    // The failure direction that matters: a deployment missing its key retains
    // no research text rather than retaining it in the clear (#131).
    const { encryptRawText } = await load();
    assert.equal(await encryptRawText("今日は部活で失敗した"), null);
  });

  it("round-trips through decryptRawText", async () => {
    process.env.RESEARCH_RAW_TEXT_KEY = testKey;
    const { encryptRawText, decryptRawText } = await load();
    const plaintext = "Journal entry:\n今日は部活で失敗した\n\n30-first-recall:\n明日の練習のこと";
    const sealed = await encryptRawText(plaintext);
    assert.ok(sealed);
    assert.equal(sealed.key_version, "raw-text-aesgcm-v1");
    assert.equal(await decryptRawText(sealed.ciphertext), plaintext);
  });

  it("never stores the plaintext in the ciphertext", async () => {
    process.env.RESEARCH_RAW_TEXT_KEY = testKey;
    const { encryptRawText } = await load();
    const plaintext = "今日は部活で失敗した";
    const sealed = await encryptRawText(plaintext);
    assert.ok(sealed);
    const decoded = Buffer.from(sealed.ciphertext, "base64").toString("utf8");
    assert.equal(decoded.includes(plaintext), false);
  });

  it("produces a different value each time for the same text", async () => {
    // A deterministic ciphertext would tell anyone who can read the column
    // that two entries were identical, without needing the key.
    process.env.RESEARCH_RAW_TEXT_KEY = testKey;
    const { encryptRawText } = await load();
    const first = await encryptRawText("同じ文章");
    const second = await encryptRawText("同じ文章");
    assert.notEqual(first.ciphertext, second.ciphertext);
  });
});

describe("decryptRawText", () => {
  it("returns null rather than throwing on a value that will not open", async () => {
    process.env.RESEARCH_RAW_TEXT_KEY = testKey;
    const { decryptRawText } = await load();
    assert.equal(await decryptRawText("not-base64-at-all!!"), null);
    assert.equal(await decryptRawText(Buffer.from("short").toString("base64")), null);
  });

  it("returns null under a different key", async () => {
    process.env.RESEARCH_RAW_TEXT_KEY = testKey;
    const { encryptRawText } = await load();
    const sealed = await encryptRawText("秘密の日記");

    process.env.RESEARCH_RAW_TEXT_KEY = Buffer.from(
      new Uint8Array(32).map((_, index) => 200 - index),
    ).toString("base64");
    const { decryptRawText } = await load();
    assert.equal(await decryptRawText(sealed.ciphertext), null);
  });
});

describe("rawTextExpiryFrom", () => {
  it("sets an expiry the purge job can act on", async () => {
    const { rawTextExpiryFrom, RAW_TEXT_RETENTION_DAYS } = await load();
    const now = new Date("2026-09-06T00:00:00.000Z");
    const expiry = new Date(rawTextExpiryFrom(now));
    const days = Math.round((expiry.getTime() - now.getTime()) / 86_400_000);
    assert.equal(days, RAW_TEXT_RETENTION_DAYS);
    assert.ok(expiry > now);
  });
});
