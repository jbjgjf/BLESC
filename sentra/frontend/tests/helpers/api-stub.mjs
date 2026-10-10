// Stands in for `src/lib/server/api.ts` under `route-loader.mjs`: the real
// module, with `requireUser()` answering from the test instead of from Supabase.
import { jsonError } from "../../src/lib/server/api.ts";

export * from "../../src/lib/server/api.ts";

export async function requireUser() {
  return globalThis.__testAuth ?? { error: jsonError("Missing Authorization bearer token.", 401) };
}
