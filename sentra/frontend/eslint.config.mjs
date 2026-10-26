/*
 * `eslint-plugin-react-hooks` is pinned to 7.0.1 in `package.json` `overrides`,
 * not here, because the version is what decides which rules exist (#502).
 *
 * `eslint-config-next` depends on it with a caret, so a lockfile refresh moves
 * it on its own. 7.1 added `react-hooks/set-state-in-effect` and
 * `react-hooks/refs`, which error in 15 places this repository already has —
 * `void load()` inside an effect on ten screens, and the lazily-initialised
 * refs in `journal/page.tsx` and `VoiceMode.tsx`. They are not false positives
 * and they are not this pin's business to argue with; they are a React change
 * across twelve files, which CONTRIBUTING §2 says is its own pull request.
 *
 * The pin exists so that #498 — three advisories in `next`, two of them
 * unauthenticated RCE — could ship as a version bump rather than wait behind
 * that refactor. It is temporary by construction: #502 removes it, and until
 * then this file is linting under the 7.0 rule set while the rest of the tree
 * is on 16.4.
 */
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

    /*
     * `public/demo-view` is a static export of another branch's build, checked
     * in as 1035 files of minified chunks. ESLint was reading them, reporting
     * 85 errors from minifier output (`no-this-alias` and friends), and exiting
     * 1 — which stopped `npm run lint` and, because it runs first, meant
     * `npm test` and `npm run build` had not executed in CI at all (#192).
     *
     * Scoped to that directory rather than `public/**`: the rest of `public`
     * holds hand-written assets, and widening the ignore to cover a build
     * artifact would also hide anything anyone puts there later.
     */
    "public/demo-view/**",
  ]),
]);

export default eslintConfig;
