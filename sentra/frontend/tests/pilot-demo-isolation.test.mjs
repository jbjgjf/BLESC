import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { stageDemoView } from "../scripts/stage-demo-view.mjs";

it("refuses demo overrides before reading browser state in a pilot deployment", () => {
  const source = readFileSync("src/lib/demo.ts", "utf8");
  const snapshot = source.slice(source.indexOf("function getSnapshot()"));
  assert.match(snapshot, /NEXT_PUBLIC_PILOT_MODE === "1"\) return false/);
  assert.ok(snapshot.indexOf("NEXT_PUBLIC_PILOT_MODE") < snapshot.indexOf("window.location"));
  assert.ok(snapshot.indexOf("NEXT_PUBLIC_PILOT_MODE") < snapshot.indexOf("window.sessionStorage"));
});

// /demo-view is a prebuilt static export: the runtime check above never runs
// for it, and routing rules cannot close static files reliably (#193). What
// keeps it off a pilot deployment is that the files are not in the build at all,
// so these tests look at what a checkout and a build actually contain.
describe("/demo-view on a pilot deployment", () => {
  it("is not in public/ in a fresh checkout", () => {
    const tracked = execFileSync("git", ["ls-files", "--", "public/demo-view"], { encoding: "utf8" });
    assert.equal(tracked, "", "demo files are committed under public/, where every build serves them");
    execFileSync("git", ["check-ignore", "-q", "public/demo-view/index.html"]);
  });

  it("is staged by the build command, before next build", () => {
    const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
    assert.match(scripts.build, /^node scripts\/stage-demo-view\.mjs && next build$/);
  });

  const withProject = (fn) => {
    const root = mkdtempSync(join(tmpdir(), "demo-view-"));
    try {
      mkdirSync(join(root, "demo-view-export", "educator"), { recursive: true });
      writeFileSync(join(root, "demo-view-export", "index.html"), "demo");
      writeFileSync(join(root, "demo-view-export", "educator.txt"), "demo");
      mkdirSync(join(root, "public"));
      fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("leaves the files out of a pilot build, clearing any left from an earlier build", () => {
    withProject((root) => {
      stageDemoView({ root, pilot: false });
      assert.ok(existsSync(join(root, "public", "demo-view", "index.html")));
      stageDemoView({ root, pilot: true });
      assert.equal(existsSync(join(root, "public", "demo-view")), false);
    });
  });

  it("stages the files for an ordinary build", () => {
    withProject((root) => {
      stageDemoView({ root, pilot: false });
      assert.equal(readFileSync(join(root, "public", "demo-view", "educator.txt"), "utf8"), "demo");
    });
  });
});
