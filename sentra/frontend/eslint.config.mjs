import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // public/demo-view is a static export of another branch, committed as a
    // build artifact (#194). Linting minified chunks produced 85 errors from
    // the minifier's output rather than from anything anyone wrote, which held
    // the whole frontend job — tests and build included — behind a red lint.
    // Scoped to that one directory so the rest of public/ stays linted.
    "public/demo-view/**",
  ]),
]);

export default eslintConfig;
