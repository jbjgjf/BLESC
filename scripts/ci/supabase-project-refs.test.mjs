/**
 * No Supabase project ref is committed except the evaluation project (#479).
 *
 * This repository is public. The production project's ref was committed twice —
 * as the CI build's "placeholder" URL and as a test literal — which names the
 * target for anyone reading, and pointed CI's `next build` at production. A
 * real project ref is 20 lowercase letters; the illustrative ones in docs
 * (`your-project-ref`, `abcdefgh`, …) are not, so they do not trip this.
 *
 * The allowlist mirrors `ALLOWED_SUPABASE_HOSTS` in `sentra/eval/src/config.ts`:
 * the dedicated synthetic-evaluation project, documented on purpose.
 *
 *   node --test scripts/ci/supabase-project-refs.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");
const ALLOWED_REFS = new Set(["vkrhcctlbdjlhtbninsd"]);
const PROJECT_HOST = /(?<![a-z0-9-])([a-z]{20})\.supabase\.(?:co|in)(?![a-z0-9-])/g;

export function unexpectedRefs(text) {
  return [...text.matchAll(PROJECT_HOST)].map((match) => match[1]).filter((ref) => !ALLOWED_REFS.has(ref));
}

describe("Supabase project refs in tracked files", () => {
  it("recognises a project host and ignores the illustrative ones", () => {
    const fake = "q".repeat(20);
    assert.deepEqual(unexpectedRefs(`https://${fake}.supabase.co`), [fake]);
    assert.deepEqual(unexpectedRefs("https://vkrhcctlbdjlhtbninsd.supabase.co"), []);
    assert.deepEqual(
      unexpectedRefs("your-project-ref.supabase.co abcdefgh.supabase.co brandnewpilotref.supabase.co"),
      [],
    );
  });

  it("names no project other than the evaluation one", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
    const found = [];
    for (const file of files) {
      let text;
      try {
        text = readFileSync(resolve(ROOT, file), "utf8");
      } catch {
        continue;
      }
      if (text.includes("\0")) continue;
      for (const ref of unexpectedRefs(text)) found.push(`${file}: ${ref}`);
    }
    assert.deepEqual(found, [], "a Supabase project ref is committed; use a .invalid placeholder instead");
  });
});
