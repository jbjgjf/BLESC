import type { Metadata } from "next";
import { Suspense } from "react";
import "./globals.css";
import "./blesc.css";
import { AuthProvider } from "@/lib/auth";
import { AuthShell } from "@/components/AuthShell";
import { TransitionProvider } from "@/components/ui/Transition";
import { A11Y_BOOT_SCRIPT } from "@/lib/a11y";

export const metadata: Metadata = {
  title: "blesc",
  description: "生徒の変化に気づき、支援につなげるプラットフォーム",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // 表示設定のスクリプトが描画前に data 属性を足すため、サーバー側の
    // HTML とは必ず差が出る。ここだけ警告を抑える。
    <html lang="ja" suppressHydrationWarning>
      <body>
        {/* 保存済みの表示設定を、最初の描画より前に <html> へ当てる。
            後から当てると既定の見た目が一瞬映ってしまう。 */}
        <script dangerouslySetInnerHTML={{ __html: A11Y_BOOT_SCRIPT }} />
        <AuthProvider>
          <Suspense fallback={null}>
            <TransitionProvider>
              <AuthShell>{children}</AuthShell>
            </TransitionProvider>
          </Suspense>
        </AuthProvider>
      </body>
    </html>
  );
}

