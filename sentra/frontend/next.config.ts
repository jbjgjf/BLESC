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
  async rewrites() {
    return [
      // /demo-view is a static export of the chat-ui-redesign branch, built by
      // sentra/frontend/scripts/build-demo-view.sh on that branch into
      // public/demo-view. It is not part of this app: fixtures only, demo mode
      // forced on, no API, noindex. Static files are served before rewrites, so
      // these only map clean page URLs onto the exported .html files.
      { source: "/demo-view", destination: "/demo-view/index.html" },
      { source: "/demo-view/:path+", destination: "/demo-view/:path+.html" },
    ];
  },
};

export default nextConfig;
