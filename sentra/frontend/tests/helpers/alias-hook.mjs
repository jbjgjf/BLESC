/**
 * Resolve the `@/…` import alias for tests.
 *
 * `tsconfig.json` maps `@/*` to `src/*`, and Next's bundler honours it. Node
 * does not: it is a tsconfig convention, not a package-exports one, so a module
 * that imports `@/lib/i18n` at runtime cannot be loaded by `node --test` from a
 * relative path alone. Most of `src/lib` imports relatively and so is already
 * testable; `src/components/graph` does not, which is part of why it had no
 * tests at all (#307).
 *
 * Extensions and directory indexes are resolved against the filesystem, the way
 * the bundler does and Node's ESM resolver deliberately does not.
 *
 * Registered per test file rather than from the `test` script, so the shape of
 * this can be settled once in #307 instead of here.
 */
import { statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

const SRC = resolvePath(import.meta.dirname, "../../src");

/** In bundler order: an exact file wins, then an extension, then a directory index. */
const SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith("@/")) return nextResolve(specifier, context);

  const base = resolvePath(SRC, specifier.slice("@/".length));
  for (const suffix of SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (isFile(candidate)) return nextResolve(pathToFileURL(candidate).href, context);
  }
  throw new Error(`alias-hook: "${specifier}" does not resolve to a file under ${SRC}`);
}
