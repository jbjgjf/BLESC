import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { PILOT_CONTACT_EMAIL, PILOT_CONTACT_HREF, PILOT_CONTACT_PRIVACY_NOTICE } from "../src/lib/pilotContact.ts";

it("shows the owner's designated contact in join and guardian flows", () => {
  assert.equal(PILOT_CONTACT_EMAIL, "blesc.jp@gmail.com");
  assert.equal(PILOT_CONTACT_HREF, `mailto:${PILOT_CONTACT_EMAIL}`);
  assert.match(PILOT_CONTACT_PRIVACY_NOTICE, /本文.*確認用リンク/);
  for (const path of ["src/app/pilot/join/page.tsx", "src/app/pilot/guardian/[token]/GuardianConfirm.tsx"]) {
    const source = readFileSync(path, "utf8");
    assert.match(source, /href=\{PILOT_CONTACT_HREF\}/);
    assert.match(source, /PILOT_CONTACT_PRIVACY_NOTICE/);
    assert.doesNotMatch(source, /説明文書に記載の研究担当まで/);
  }
  assert.match(readFileSync("../../docs/pilot/consent-pack.md", "utf8"), /blesc\.jp@gmail\.com/);
});
