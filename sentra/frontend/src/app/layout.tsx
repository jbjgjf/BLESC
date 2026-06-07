import type { Metadata } from "next";
import { Suspense } from "react";
import { Cinzel, EB_Garamond } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";
import { AuthShell } from "@/components/AuthShell";

const cinzel = Cinzel({
  subsets: ["latin"],
  variable: "--font-cinzel",
  weight: ["400", "600", "700"],
});

const ebGaramond = EB_Garamond({
  subsets: ["latin"],
  variable: "--font-garamond",
  style: ["normal", "italic"],
  weight: ["400", "500", "600", "700"],
});

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
      <body className={`${cinzel.variable} ${ebGaramond.variable}`}>
        <AuthProvider>
          <Suspense fallback={null}>
            <AuthShell>{children}</AuthShell>
          </Suspense>
        </AuthProvider>
      </body>
    </html>
  );
}
