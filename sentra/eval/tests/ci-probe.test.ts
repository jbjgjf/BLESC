import assert from "node:assert/strict";
import { it } from "node:test";
it("intentional CI failure probe for issue 182; removed after evidence", () => {
  assert.fail("Intentional CI failure probe for #182, never merge this commit");
});
