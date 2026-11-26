import type { Metadata } from "next";
import "./fonts/fonts.css";
import "./globals.css";
import { SidebarShell } from "@/components/SidebarShell";

export const metadata: Metadata = {
  title: "OpsBrain | Dautel Intelligent Operations",
  description: "OpsBrain dashboard: browse, search and capture what the company knows",
  robots: { index: false, follow: false },
};

const THEMES = ["dautel", "mocha", "macchiato", "frappe", "latte"];

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const theme = THEMES.includes(process.env.OPSBRAIN_UI_THEME ?? "") ? process.env.OPSBRAIN_UI_THEME : "dautel";
  return (
    <html
      lang="en"
      data-theme={theme}
      className="h-full antialiased"
      suppressHydrationWarning
    >
      <body className="ob1-graphite-bg min-h-screen flex bg-bg-primary text-text-primary">
        <div className="ob1-brand-signature hidden md:block" aria-hidden="true">
          Dautel Intelligent Operations / OpsBrain
        </div>
        <SidebarShell />
        <main className="flex-1 md:ml-56 min-h-screen pt-12 md:pt-0">
          <div className="mx-auto max-w-7xl px-4 py-4 md:px-8 md:py-8">
            {children}
          </div>
        </main>
      </body>
    </html>
  );
}
