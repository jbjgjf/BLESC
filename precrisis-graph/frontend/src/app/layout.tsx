import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Link from 'next/link';
import { Home, LineChart, PieChart, Activity } from 'lucide-react';

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "precrisis-graph",
  description: "Research-oriented journaling and structural change detection",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-slate-50 text-slate-900`}>
        <div className="min-h-screen flex flex-col">
          <header className="border-b bg-white sticky top-0 z-50">
            <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
              <div className="flex items-center gap-2 font-bold text-xl text-indigo-600">
                <Activity className="w-6 h-6" />
                <span>precrisis-graph</span>
              </div>
              <nav className="flex items-center gap-8">
                <Link href="/" className="flex items-center gap-1 hover:text-indigo-600 transition-colors">
                  <Home className="w-4 h-4" />
                  <span>Log</span>
                </Link>
                <Link href="/timeline" className="flex items-center gap-1 hover:text-indigo-600 transition-colors">
                  <LineChart className="w-4 h-4" />
                  <span>Timeline</span>
                </Link>
                <Link href="/insights" className="flex items-center gap-1 hover:text-indigo-600 transition-colors">
                  <PieChart className="w-4 h-4" />
                  <span>Insights</span>
                </Link>
              </nav>
              <div className="text-sm font-medium text-slate-500">
                User: research_user_01
              </div>
            </div>
          </header>
          <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-8">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
