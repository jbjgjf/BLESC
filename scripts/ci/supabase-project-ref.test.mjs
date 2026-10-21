/**
 * No Supabase project ref but the evaluation project's is committed (#479).
 *
 * The `frontend-build` job used to pass the *production* project's ref as its
 * `NEXT_PUBLIC_SUPABASE_URL` "placeholder", and `sentra/eval/tests/` named the
 * same ref. That put it in a public repository, in every public Actions log
 * (`src/lib/supabase/client.ts:37` prints the configured URL), and aimed a CI
 * build at the project holding participant data.
 *
 * A Supabase project ref is exactly 20 lower-case letters, so that shape is
 * what this looks for. Illustrative hosts stay legible and keep working:
 * `your-project-ref`, `project`, `staging-somewhere`, `brandnewpilotref` and
 * `abcdefgh` are none of them 20 letters, and the dedicated evaluation project
 * is allowed by name.
 *
 * Tracked files only, via `git ls-files`: a ref in an untracked `.env.local` is
 * the point of that file, and `node_modules` is not ours.
 *
 *   node --test scripts/ci/supabase-project-ref.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const REPO = resolve(import.meta.dirname, "../..");

/**
 * Project refs allowed to appear in tracked files, and why.
 *
 * `blesc-synthetic-eval` is the dedicated evaluation project. It is documented
 * in `sentra/docs/synthetic_evaluation.md` and is the one entry in
 * `ALLOWED_SUPABASE_HOSTS` (`sentra/eval/src/config.ts`), so the harness has to
 * be able to name it. It holds synthetic data only.
 */
const ALLOWED_REFS = new Map([["vkrhcctlbdjlhtbninsd", "blesc-synthetic-eval — the dedicated evaluation project"]]);

/** A project ref as Supabase issues them: exactly 20 lower-case letters. */
const PROJECT_REF = /\b([a-z]{20})\.supabase\.(?:co|in)\b/g;

/** Tracked text files, as paths relative to the repository root. */
function trackedFiles() {
  const out = execFileSync("git", ["-C", REPO, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

/** Every `{ file, line, ref }` a tracked file carries. */
function committedRefs() {
  const found = [];
  for (const file of trackedFiles()) {
    // This file names the allowed ref in prose; skip it so the guard cannot
    // report itself.
    if (file === "scripts/ci/supabase-project-ref.test.mjs") continue;
    let text;
    try {
      text = readFileSync(resolve(REPO, file), "utf8");
    } catch {
      continue; // unreadable or a submodule entry
    }
    // Cheap reject before the line-by-line pass: most files have no match.
    if (!text.includes(".supabase.")) continue;
    const lines = text.split("\n");
    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(PROJECT_REF)) {
        found.push({ file, line: index + 1, ref: match[1] });
      }
    }
  }
  return found;
}

describe("committed Supabase project refs", () => {
  it("names no project but the dedicated evaluation one", () => {
    const unexpected = committedRefs().filter((hit) => !ALLOWED_REFS.has(hit.ref));
    assert.deepEqual(
      unexpected,
      [],
      unexpected.length === 0
        ? ""
        : `A Supabase project ref is committed that is not on the allowlist:\n` +
            unexpected.map((hit) => `  ${hit.file}:${hit.line}  ${hit.ref}.supabase.co`).join("\n") +
            `\n\nIf this is a placeholder, use a host that cannot resolve — ` +
            `.invalid is reserved by RFC 2606, which is why ` +
            `sentra/frontend/src/lib/supabase/client.ts falls back to ` +
            `https://unconfigured.invalid. If it names a real project that this ` +
            `repository has to refer to, add it to ALLOWED_REFS in this file ` +
            `with the reason, the way the evaluation project is.`,
    );
  });

  it("still finds the evaluation project, so the search itself is working", () => {
    // Without this, deleting the pattern or the file walk would read as a pass.
    const refs = new Set(committedRefs().map((hit) => hit.ref));
    assert.ok(
      refs.has("vkrhcctlbdjlhtbninsd"),
      "the evaluation project's ref was not found in any tracked file — the search is broken, " +
        "or the ref changed and ALLOWED_REFS needs updating",
    );
  });

  it("would catch a production ref in the CI workflow", () => {
    // The regression itself, as a unit: the shape a 20-letter ref takes in the
    // line `frontend-build` used to carry.
    const line = "      NEXT_PUBLIC_SUPABASE_URL: https://kvcrkveaxlrijhzyayeg.supabase.co";
    const hits = [...line.matchAll(PROJECT_REF)].map((match) => match[1]);
    assert.deepEqual(hits, ["kvcrkveaxlrijhzyayeg"]);
    assert.ok(!ALLOWED_REFS.has(hits[0]));
  });

  it("leaves the illustrative hosts alone", () => {
    for (const host of [
      "your-project-ref.supabase.co", // .env.example
      "project.supabase.co",
      "staging-somewhere.supabase.co", // sentra/eval/tests/provision.test.ts
      "brandnewpilotref.supabase.co",
      "not-on-the-allowlist.supabase.co",
      "abcdefgh.supabase.co",
      "unconfigured.invalid",
      "ci-placeholder.invalid",
    ]) {
      assert.deepEqual([...host.matchAll(PROJECT_REF)], [], host);
    }
  });
});
