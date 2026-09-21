import type { NextConfig } from "next";

/**
 * Whether this build is the dedicated research deployment.
 *
 * Read at build time, not per request: `NEXT_PUBLIC_PILOT_MODE` is inlined into
 * the bundle anyway, and a config that changed shape between requests would be
 * harder to reason about than one that is fixed per deployment.
 */
const PILOT_MODE = process.env.NEXT_PUBLIC_PILOT_MODE === "1";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      {
        // Voice became a mode inside the chat composer. A real 308 here rather
        // than redirect() inside a page: redirects are checked before the
        // filesystem, so this reaches clients without JavaScript and crawlers,
        // which the RSC-payload redirect a static page produces does not.
        source: "/voice",
        destination: "/chat",
        permanent: true,
      },
    ];
  },
  async headers() {
    // Nothing to help navigate on a deployment that does not serve it.
    if (PILOT_MODE) return [];
    return [
      {
        // The demo's client navigations fetch <page>.txt with an `RSC: 1`
        // header, which Vercel answers from <page>.txt.rsc (twins the build
        // script writes). A plain static file carries no flight content type,
        // and the router falls back to a full page load without one.
        source: "/demo-view/:path*",
        has: [{ type: "header", key: "rsc" }],
        headers: [{ key: "Content-Type", value: "text/x-component" }],
      },
    ];
  },
  async rewrites() {
    /*
     * On the dedicated pilot deployment, /demo-view does not exist (#193).
     *
     * `src/lib/demo.ts` refuses URL and session demo overrides when
     * `NEXT_PUBLIC_PILOT_MODE=1`, but that guard only covers screens rendered by
     * this app's bundle. `public/demo-view` is a static export of another
     * branch with demo mode baked in, and a deployment's environment variables
     * cannot reach into somebody else's build output. So the same URL a
     * participant, a guardian or a school is given also served a complete,
     * fixture-backed demo UI.
     *
     * `beforeFiles` is what makes this work. Next checks it at step 4 of
     * routing, ahead of "static files from the public directory" at step 5
     * (see the rewrites reference in the installed docs). An `afterFiles`
     * rewrite — the plain-array form used below — would be too late: the
     * static file would already have been served.
     *
     * Rewritten to a path that does not exist, which produces the app's own
     * 404. Not a redirect: a redirect would tell whoever probed the URL that
     * the artifact is somewhere, and a 404 is the honest answer for a
     * deployment that does not serve it.
     */
    if (PILOT_MODE) {
      return {
        beforeFiles: [{ source: "/demo-view/:path*", destination: "/_pilot_not_found" }],
        afterFiles: [],
        fallback: [],
      };
    }

    return [
      // /demo-view is a static export of the chat-ui-redesign branch, built by
      // sentra/frontend/scripts/build-demo-view.sh on that branch into
      // public/demo-view. It is not part of this app: fixtures only, demo mode
      // forced on, no API, noindex. Static files are served before rewrites, so
      // these only map clean page URLs onto the exported .html files.
      //
      // The script is checked in here too, so the procedure survives the source
      // branch (#194) — it refuses to run outside it, because the export needs
      // a `DEMO_VIEW_EXPORT` branch this config does not have. What is actually
      // committed came from the commit named in public/demo-view/BUILD_INFO.json.
      { source: "/demo-view", destination: "/demo-view/index.html" },
      { source: "/demo-view/:path+", destination: "/demo-view/:path+.html" },

      // 案内役（ラスクくん）の紹介ページ。中身は同じ書き出しの中にあり、
      // ここでは短い URL を繋いでいるだけ。チームに見せるための一時的な
      // ページなので、役目が済んだらこの1行ごと消す。パイロットでは上の
      // beforeFiles が /demo-view を閉じているため、ここも 404 になる。
      { source: "/meet-rusk", destination: "/demo-view/meet-rusk.html" },
    ];
  },
};

export default nextConfig;
