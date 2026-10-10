/**
 * Lets `node --test` import an API route handler and call it.
 *
 * A route file imports through the `@/` alias and without extensions, which the
 * bundler resolves and Node does not, and it builds its own service-role client
 * from the environment and authenticates against Supabase. This registers a
 * resolver for the first two, and swaps `serviceRoleClient()` and
 * `requireUser()` for whatever the test set with `setServiceClient()` and
 * `setSignedInUser()`, so a handler can be exercised against
 * `fake-supabase.mjs` instead of being read as text. Everything else in the
 * route, and everything it imports, is the real code.
 *
 * Import it before the route:
 *
 *   import { setServiceClient } from "./helpers/route-loader.mjs";
 *   const { POST } = await import("../src/app/api/…/route.ts");
 */

import { statSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = resolvePath(import.meta.dirname, "../../src");
const SUFFIXES = ["", ".ts", ".tsx", "/index.ts"];
const stub = (name) => pathToFileURL(resolvePath(import.meta.dirname, name)).href;
const STUBS = new Map([
  [resolvePath(SRC, "lib/server/supabaseWriter.ts"), stub("service-client-stub.mjs")],
  [resolvePath(SRC, "lib/server/api.ts"), stub("api-stub.mjs")],
]);

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function onDisk(base) {
  for (const suffix of SUFFIXES) {
    if (isFile(`${base}${suffix}`)) return `${base}${suffix}`;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    let base = null;
    if (specifier.startsWith("@/")) {
      base = resolvePath(SRC, specifier.slice(2));
    } else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      const parent = fileURLToPath(context.parentURL);
      if (parent.startsWith(SRC)) base = resolvePath(dirname(parent), specifier);
    }
    // `next` has no exports map, so its subpaths need their extension spelled out.
    if (/^next\/[a-z]+$/.test(specifier)) return nextResolve(`${specifier}.js`, context);
    if (base === null) return nextResolve(specifier, context);

    const file = onDisk(base);
    if (!file) throw new Error(`route-loader: "${specifier}" does not resolve to a file`);
    // `?real` is how a stub reaches the module it stands in for.
    const real = context.parentURL?.endsWith("-stub.mjs");
    if (!real && STUBS.has(file)) return { url: STUBS.get(file), shortCircuit: true };
    return nextResolve(pathToFileURL(file).href, context);
  },
});

/** The client every `serviceRoleClient()` call returns from now on; null for "not configured". */
export function setServiceClient(client) {
  globalThis.__testServiceClient = client;
}

/**
 * Who `requireUser()` finds. `client` is the caller's own (RLS-bound) client in
 * the app; here it is whatever the test passes. Null signs the caller out.
 */
export function setSignedInUser(user, client = null) {
  globalThis.__testAuth = user ? { user, client } : null;
}
