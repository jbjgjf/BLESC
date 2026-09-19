import type { NextConfig } from "next";

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
    return [
      // /demo-view is a static export of the chat-ui-redesign branch, built by
      // scripts/build-demo-view.sh on that branch into demo-view-export/ and
      // copied into public/ by scripts/stage-demo-view.mjs, except in a pilot
      // build. It is not part of this app: fixtures only, demo mode forced on,
      // no API, noindex. Static files are served before rewrites, so these
      // only map clean page URLs onto the exported .html files.
      { source: "/demo-view", destination: "/demo-view/index.html" },
      { source: "/demo-view/:path+", destination: "/demo-view/:path+.html" },
    ];
  },
};

export default nextConfig;
