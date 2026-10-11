import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveApiBaseUrl } from "../src/lib/apiBaseUrl.ts";

/**
 * Where the browser sends journal text (#345). On a pilot build it must be the
 * route handlers behind the collection-only gate, whatever the deployment's
 * environment says.
 */
describe("resolveApiBaseUrl", () => {
  const FASTAPI = "https://sentra-backend.example.com";

  it("keeps a pilot build on /api even when a backend URL is set, and says it did", () => {
    assert.deepEqual(resolveApiBaseUrl({ pilotMode: "1", apiUrl: FASTAPI }), { baseUrl: "/api", ignoredApiUrl: true });
  });

  it("honours the backend URL outside the pilot: local development and evaluation", () => {
    assert.deepEqual(resolveApiBaseUrl({ pilotMode: undefined, apiUrl: FASTAPI }), { baseUrl: FASTAPI, ignoredApiUrl: false });
    assert.deepEqual(resolveApiBaseUrl({ pilotMode: "", apiUrl: "http://localhost:8000/api" }), {
      baseUrl: "http://localhost:8000/api",
      ignoredApiUrl: false,
    });
  });

  it("reads pilot mode the way the rest of the build does: only the string 1", () => {
    for (const pilotMode of ["0", "true", "yes"]) {
      assert.equal(resolveApiBaseUrl({ pilotMode, apiUrl: FASTAPI }).baseUrl, FASTAPI, pilotMode);
    }
  });

  it("uses /api when nothing is set, with nothing to warn about", () => {
    for (const apiUrl of [undefined, "", "   "]) {
      for (const pilotMode of [undefined, "1"]) {
        assert.deepEqual(resolveApiBaseUrl({ pilotMode, apiUrl }), { baseUrl: "/api", ignoredApiUrl: false });
      }
    }
  });
});
