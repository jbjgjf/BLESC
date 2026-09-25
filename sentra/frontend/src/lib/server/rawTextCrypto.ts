/**
 * Encryption for retained journal text (#131).
 *
 * The `entries.raw_text` column has existed since the first migration and has
 * never held anything: both write paths hard-coded `raw_text: null` with a
 * comment about a TTL window no code implemented. So human evaluation of
 * extraction accuracy had no text to evaluate against.
 *
 * Retaining it plainly is not the answer either. What lands in the database is
 * AES-256-GCM ciphertext under a key held in the environment, so the column is
 * unreadable to anyone with database access alone — a Supabase dashboard
 * session, a leaked connection string, a backup. Reading it takes the key and
 * the `research_reader` role, which are held by different things.
 *
 * The key is 32 bytes, base64, in `RESEARCH_RAW_TEXT_KEY`. When it is unset,
 * `encryptRawText` returns null and the writer stores nothing: the failure
 * direction for a misconfigured deployment is "no research text", never
 * "plaintext".
 */

import { KEY_RULES, readBase64Key } from "./base64Key.ts";

const KEY_VERSION = "raw-text-aesgcm-v1";
const IV_BYTES = 12;

export type EncryptedRawText = {
  ciphertext: string;
  key_version: string;
};

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64"));
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * The configured key, or null when the deployment has none.
 *
 * The decoding rule is `base64Key.ts`'s, not a local one (#255). The version
 * this replaced wrapped `Buffer.from(…, "base64")` in a `try`/`catch` that
 * could not run — that call drops characters outside the alphabet rather than
 * throwing — so "somebody pasted 64 hex characters" arrived here as 48 clean
 * bytes and was refused by the length check alone, with a message about a
 * length rather than about the format. It is the format that is wrong, and the
 * operator's self-check was reporting the same value as healthy.
 */
export function rawTextKeyMaterial(): Uint8Array | null {
  const result = readBase64Key(process.env.RESEARCH_RAW_TEXT_KEY, KEY_RULES.RESEARCH_RAW_TEXT_KEY);
  if (!result.ok) {
    if (result.problem !== "absent") {
      console.warn(
        `[raw-text] RESEARCH_RAW_TEXT_KEY is unusable (${result.problem}); raw text will not be retained`,
      );
    }
    return null;
  }
  return Uint8Array.from(result.bytes);
}

export function rawTextRetentionConfigured(): boolean {
  return rawTextKeyMaterial() !== null;
}

async function importKey(material: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", material as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * Encrypt for storage. The IV is random per call and prefixed to the
 * ciphertext, so the same text submitted twice does not produce the same
 * column value — otherwise the column leaks "these two entries are identical"
 * to anyone who can read it without the key.
 */
export async function encryptRawText(plaintext: string): Promise<EncryptedRawText | null> {
  const material = rawTextKeyMaterial();
  if (!material) return null;
  const key = await importKey(material);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(plaintext);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, encoded as BufferSource),
  );
  const packed = new Uint8Array(iv.length + sealed.length);
  packed.set(iv, 0);
  packed.set(sealed, iv.length);
  return { ciphertext: encodeBase64(packed), key_version: KEY_VERSION };
}

/**
 * Decrypt for the research export path. Returns null rather than throwing on a
 * value that will not open — a rotated key, a truncated column — because one
 * unreadable row should not abort an export of the rest.
 */
export async function decryptRawText(ciphertext: string): Promise<string | null> {
  const material = rawTextKeyMaterial();
  if (!material) return null;
  try {
    const packed = decodeBase64(ciphertext);
    if (packed.length <= IV_BYTES) return null;
    const key = await importKey(material);
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: packed.slice(0, IV_BYTES) as BufferSource },
      key,
      packed.slice(IV_BYTES) as BufferSource,
    );
    return new TextDecoder().decode(opened);
  } catch {
    return null;
  }
}

/** New retained text may never outlive the 90-day policy. Overrides may shorten it. */
export function normalizeRawTextRetentionDays(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value.trim())) return 90;
  const days = Number(value);
  return Number.isSafeInteger(days) && days > 0 ? Math.min(days, 90) : 90;
}

export const RAW_TEXT_RETENTION_DAYS = normalizeRawTextRetentionDays(process.env.RESEARCH_RAW_TEXT_RETENTION_DAYS);

export function rawTextExpiryFrom(now: Date = new Date()): string {
  const expiry = new Date(now);
  expiry.setUTCDate(expiry.getUTCDate() + RAW_TEXT_RETENTION_DAYS);
  return expiry.toISOString();
}
