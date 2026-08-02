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
};

export default nextConfig;
