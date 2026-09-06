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

/** The configured key, or null when the deployment has none. */
export function rawTextKeyMaterial(): Uint8Array | null {
  const configured = process.env.RESEARCH_RAW_TEXT_KEY;
  if (!configured) return null;
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(configured);
  } catch {
    console.warn("[raw-text] RESEARCH_RAW_TEXT_KEY is not valid base64; raw text will not be retained");
    return null;
  }
  if (bytes.length !== 32) {
    console.warn("[raw-text] RESEARCH_RAW_TEXT_KEY must decode to 32 bytes; raw text will not be retained");
    return null;
  }
  return bytes;
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

/** Retention window for stored text, in days. */
export const RAW_TEXT_RETENTION_DAYS = Number(process.env.RESEARCH_RAW_TEXT_RETENTION_DAYS ?? 180);

export function rawTextExpiryFrom(now: Date = new Date()): string {
  const expiry = new Date(now);
  expiry.setUTCDate(expiry.getUTCDate() + RAW_TEXT_RETENTION_DAYS);
  return expiry.toISOString();
}
