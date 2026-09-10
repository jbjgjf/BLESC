import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * Server-only secrets must not be reachable from a client module (#166).
 *
 * Next.js only inlines `NEXT_PUBLIC_`-prefixed variables into the browser
 * bundle, so a server secret read from a client component is `undefined` at
 * runtime rather than leaked — which is worse in a specific way: the feature
 * quietly stops working and nobody learns that the boundary was crossed. And a
 * later refactor that renames the variable with the public prefix to "fix" it
 * would ship the value.
 *
 * This test reads the source rather than the build output, so it fails in
 * review instead of after a deploy.
 */

const SERVER_ONLY = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "RESEARCH_RAW_TEXT_KEY",
  "PILOT_INVITE_HMAC_KEY",
  "RESEARCH_API_TOKEN",
  "OPENAI_API_KEY",
];

/** Directories whose modules only ever run on the server. */
const SERVER_ROOTS = ["src/app/api", "src/lib/server"];

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe("the secret boundary", () => {
  it("keeps server-only variables out of client modules", async () => {
    const files = await walk("src");
    const offenders = [];

    for (const file of files) {
      if (SERVER_ROOTS.some((root) => file.startsWith(root))) continue;
      const source = await readFile(file, "utf8");
      const isClient = /^\s*["']use client["']/m.test(source);
      if (!isClient) continue;
      for (const name of SERVER_ONLY) {
        if (source.includes(`process.env.${name}`)) offenders.push(`${file}: ${name}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `Server-only variables read from a client module:\n${offenders.join("\n")}`,
    );
  });

  it("keeps them out of anything the client can import from src/lib", async () => {
    // src/lib holds shared modules. One that reads a server secret can be
    // imported by a client component without either file looking wrong on its
    // own, which is how this boundary usually breaks.
    const files = (await walk("src/lib")).filter((file) => !file.startsWith("src/lib/server"));
    const offenders = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const name of SERVER_ONLY) {
        if (source.includes(`process.env.${name}`)) offenders.push(`${file}: ${name}`);
      }
    }

    assert.deepEqual(offenders, [], `Server secrets outside src/lib/server:\n${offenders.join("\n")}`);
  });

  it("names every server-only variable the runbook documents", async () => {
    // The list above and the runbook's inventory have to stay the same list.
    const runbook = await readFile("../../docs/pilot/infrastructure-runbook.md", "utf8");
    for (const name of SERVER_ONLY) {
      assert.ok(runbook.includes(name), `${name} is guarded here but missing from the runbook`);
    }
  });
});
