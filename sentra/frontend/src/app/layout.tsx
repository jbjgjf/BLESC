import type { Metadata } from "next";
import { Suspense } from "react";
import { Space_Grotesk } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";
import { AuthShell } from "@/components/AuthShell";

const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-space-grotesk" });

export const metadata: Metadata = {
  title: "Sentra",
  description: "Education risk monitoring",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${spaceGrotesk.variable} bg-slate-50 text-slate-900`}>
        <AuthProvider>
          <Suspense fallback={null}>
            <AuthShell>{children}</AuthShell>
          </Suspense>
        </AuthProvider>
      </body>
    </html>
  );
}
