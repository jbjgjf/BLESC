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
      // 書き出しの id を、元にしたコミットから決める。既定だと毎回変わり、
      // ファイル名も中身も変わってしまうので、同じコミットから書き出せば
      // 同じものが出てくる（出所を確かめられる。jbjgjf/BLESC#194）。
      generateBuildId: async () => `demo-view-${process.env.DEMO_VIEW_SOURCE_COMMIT ?? "local"}`,
    }
  : {};

export default nextConfig;
