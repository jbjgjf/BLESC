import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";

it("refuses demo overrides before reading browser state in a pilot deployment", () => {
  const source = readFileSync("src/lib/demo.ts", "utf8");
  const snapshot = source.slice(source.indexOf("function getSnapshot()"));
  assert.match(snapshot, /NEXT_PUBLIC_PILOT_MODE === "1"\) return false/);
  assert.ok(snapshot.indexOf("NEXT_PUBLIC_PILOT_MODE") < snapshot.indexOf("window.location"));
  assert.ok(snapshot.indexOf("NEXT_PUBLIC_PILOT_MODE") < snapshot.indexOf("window.sessionStorage"));
});
