// Lint for the synthetic evaluation harness (#368).
//
// This package's defects do not turn anything red; they change the
// evaluation's numbers quietly (#285, #286, #305, #309, #312, #376 …). Several
// were type-correct and would have been caught by a rule: a discarded
// `isEnabled()` result used as a wait (#305) is the floating/thenable family.
//
// Aligned with sentra/frontend/eslint.config.mjs where it applies: the same
// `typescript-eslint` recommended set that `eslint-config-next/typescript`
// spreads. What differs, and why:
// - No Next.js presets (react, jsx-a11y, next/core-web-vitals): there is no UI
//   here. ESLint's own `recommended` stands in for the core rules they bring.
// - `no-unused-vars` / `no-unused-expressions` stay errors. The frontend
//   downgrades them to warnings, and `eslint` exits 0 on warnings, so here
//   they would never stop anything.
// - Type-aware promise rules, which need type information and so only run on
//   the TypeScript in tsconfig.json (src/, tests/).
//
// Not linted from here: scripts/ci/*.mjs (npm-audit-gate.mjs and its test and
// accepted list). They belong to the repository-level `dependency-audit` job,
// sit outside this package — ESLint's flat config ignores files above the
// directory holding the config — and are owned outside the eval harness.
// Linting them needs a config at the repository root, which is a separate
// change to propose rather than one to make from inside sentra/eval.

import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  // Run output; never source.
  globalIgnores(["artifacts/**"]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A promise nobody awaits or handles: its failure is lost and its
      // completion is not waited for. node:test's describe/it return
      // promises the test runner itself tracks; awaiting them is not how
      // node:test is written, so they are declared safe rather than disabled.
      "@typescript-eslint/no-floating-promises": ["error", {
        allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["describe", "it", "test", "suite"] }],
      }],
      // `await` on something that is not a promise waits for nothing — the
      // shape of a "wait" that does not wait.
      "@typescript-eslint/await-thenable": "error",
      // An async function where a void callback is expected: its rejection
      // escapes every handler.
      "@typescript-eslint/no-misused-promises": "error",
      // Underscore-prefixed parameters are the fakes' way of matching a real
      // signature without using every argument.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
]);
