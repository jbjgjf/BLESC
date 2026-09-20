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
