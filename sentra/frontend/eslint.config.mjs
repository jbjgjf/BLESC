import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/*
 * `eslint-plugin-react-hooks` is held at 7.0.1 by an `overrides` entry in
 * package.json. The reason belongs here rather than in the lockfile (#498):
 *
 * `eslint-config-next@16.3.8` asks for `^7.0.0`, so the pin is inside the range
 * it declares — but any lockfile refresh otherwise resolves 7.1.x, and 7.1 ships
 * two rules this repository has never run: `react-hooks/set-state-in-effect` and
 * `react-hooks/refs`. They report 15 errors across 12 files, including
 * `components/VoiceMode.tsx` (the student voice surface, which has no tests —
 * #473) and `app/support-summary/page.tsx`.
 *
 * Those 15 are real React findings, not rule noise, and they are #502's work.
 * Pinning keeps them from being folded silently into a security bump of `next`,
 * which is a different change with a different reviewer. Remove this override in
 * #502, together with the 15 fixes — not before, and not to make CI green.
 */

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
