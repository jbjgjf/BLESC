import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyProbe, healthProblems } from "../scripts/roleplay-preflight.mjs";

describe("classifyProbe", () => {
  it("reads a missing relation as missing", () => {
    assert.equal(classifyProbe(404, { code: "PGRST205" }), "missing");
    assert.equal(classifyProbe(404, { code: "PGRST202" }), "missing");
  });
  it("reads an anon refusal as present (RLS/grants working)", () => {
    assert.equal(classifyProbe(401, { code: "42501" }), "present");
    assert.equal(classifyProbe(200, []), "present");
  });
});

describe("healthProblems", () => {
  const good = { supabase_url: true, supabase_anon_key: true, supabase_service_role_key: true, external_api_url: false, mock_llm: false };
  it("passes a complete config", () => assert.deepEqual(healthProblems(good), []));
  it("blocks on a missing service-role key, since every save would 502", () => {
    assert.match(healthProblems({ ...good, supabase_service_role_key: false })[0], /502/);
  });
  it("blocks on an external API URL", () => {
    assert.equal(healthProblems({ ...good, external_api_url: true }).length, 1);
  });
});
