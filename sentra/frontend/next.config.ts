import type { NextConfig } from "next";

/**
 * デモ表示（blesc.online/demo-view）を書き出すときだけ、静的な書き出しに
 * 切り替える。scripts/build-demo-view.sh が DEMO_VIEW_EXPORT=1 を立てて
 * 呼ぶ。ふだんのビルドと開発サーバーには何も影響しない。
 */
const demoView = process.env.DEMO_VIEW_EXPORT === "1";

const nextConfig: NextConfig = demoView
  ? {
      output: "export",
      basePath: "/demo-view",
      // 静的な書き出しでは画像の最適化サーバーが無いので、そのまま配る。
      images: { unoptimized: true },
    }
  : {};

export default nextConfig;
