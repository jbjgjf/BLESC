import type { Metadata } from "next";
import { Suspense } from "react";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";
import { AuthShell } from "@/components/AuthShell";

export const metadata: Metadata = {
  title: "BLESC",
  description: "Education risk monitoring",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <Suspense fallback={null}>
            <AuthShell>{children}</AuthShell>
          </Suspense>
        </AuthProvider>
      </body>
    </html>
  );
}

