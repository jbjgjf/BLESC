import type { Metadata } from "next";
import { Suspense } from "react";
import "./globals.css";
import "./blesc.css";
import { AuthProvider } from "@/lib/auth";
import { AuthShell } from "@/components/AuthShell";
import { TransitionProvider } from "@/components/ui/Transition";

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
    <html lang="ja">
      <body>
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

