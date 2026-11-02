/**
 * The `?next=` destination is sanitised before it reaches the router (#488).
 *
 * `safeNextPath` is the whole rule, so it is tested as a table. The second
 * block is the part that would regress silently: it reads the two call sites
 * and asserts that neither hands the raw search parameter to `router.replace`
 * again. That is a source check — the kind #288 is right to distrust on its
 * own — so it stands beside the behavioural table, not instead of it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { safeNextPath } from "../src/lib/safeNextPath.ts";

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("a same-origin path is kept", () => {
  it("keeps the paths the three writers actually produce", () => {
    assert.equal(safeNextPath("/"), "/");
    assert.equal(safeNextPath("/journal"), "/journal");
    assert.equal(safeNextPath("/educator/roster?tab=alerts"), "/educator/roster?tab=alerts");
    assert.equal(safeNextPath("/graph#node-3"), "/graph#node-3");
    // `pilotGate` writes this one pre-encoded.
    assert.equal(safeNextPath("/journal"), "/journal");
  });

  it("keeps a path that merely looks unusual but cannot leave the origin", () => {
    assert.equal(safeNextPath("/%5Cevil.example"), "/%5Cevil.example");
    assert.equal(safeNextPath("/a//b"), "/a//b");
  });
});

describe("anything that could leave the origin or run as a scheme is refused", () => {
  it("refuses an absolute URL on another host", () => {
    assert.equal(safeNextPath("https://evil.example"), "/");
    assert.equal(safeNextPath("http://evil.example/login"), "/");
  });

  it("refuses a protocol-relative URL, including the backslash spelling", () => {
    // These begin with a slash, so a `startsWith("/")` test alone lets them by.
    assert.equal(safeNextPath("//evil.example"), "/");
    assert.equal(safeNextPath("/\\evil.example"), "/");
    assert.equal(safeNextPath("//evil.example/journal"), "/");
  });

  it("refuses a scheme, which is the XSS case Next's useRouter reference names", () => {
    assert.equal(safeNextPath("javascript:alert(document.domain)"), "/");
    assert.equal(safeNextPath("JavaScript:alert(1)"), "/");
    assert.equal(safeNextPath("data:text/html,<script>alert(1)</script>"), "/");
    assert.equal(safeNextPath("vbscript:msgbox(1)"), "/");
  });

  it("refuses a relative path, which no writer produces", () => {
    assert.equal(safeNextPath("../journal"), "/");
    assert.equal(safeNextPath("journal"), "/");
  });

  it("refuses a control character rather than trimming and re-testing", () => {
    assert.equal(safeNextPath("\u0009//evil.example"), "/");
    assert.equal(safeNextPath("/\u0000/evil.example"), "/");
    assert.equal(safeNextPath("\u000a/journal"), "/");
  });

  it("falls back for a missing or empty parameter, the way `|| \"/\"` did", () => {
    assert.equal(safeNextPath(null), "/");
    assert.equal(safeNextPath(undefined), "/");
    assert.equal(safeNextPath(""), "/");
  });

  it("honours a caller-supplied fallback", () => {
    assert.equal(safeNextPath("https://evil.example", "/journal"), "/journal");
    assert.equal(safeNextPath(null, "/journal"), "/journal");
  });
});

describe("neither reader goes back to the raw parameter", () => {
  for (const file of ["../src/app/login/page.tsx", "../src/components/AuthShell.tsx"]) {
    it(`${file} routes its \`next\` through safeNextPath`, () => {
      const source = read(file);
      assert.match(source, /safeNextPath\(searchParams\.get\("next"\)\)/);
      assert.doesNotMatch(
        source,
        /router\.replace\(\s*searchParams\.get\("next"\)/,
        "the raw search parameter is being handed to the router again",
      );
    });
  }
});
