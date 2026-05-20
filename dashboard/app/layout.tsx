import "./globals.css";
import type { ReactNode } from "react";
import Link from "next/link";
import { AutoRefresh } from "@/components/AutoRefresh";
import { BotStatusBadge } from "@/components/BotStatusBadge";

export const metadata = {
  title: "Ocean-bot",
  description: "Autonomous dev agent",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      {/* suppressHydrationWarning silences Grammarly / browser extensions
          that inject `data-gr-*` attributes onto body before React hydrates.
          Without this, every page logs a hydration mismatch for extension
          users. Safe, we don't rely on body-level SSR/CSR equality. */}
      <body className="min-h-screen font-mono" suppressHydrationWarning>
        <header className="border-b border-line">
          {/* flex-wrap + gap-y so the nav drops to a second row on
              narrow viewports rather than overflowing. Brand stays
              first; nav wraps as one block below at <360px. */}
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm">
            <Link href="/" className="font-bold text-ink">
              🌊 ocean-bot
            </Link>
            {/* flex-wrap is the primary responsive strategy.
                overflow-x-auto + -mx-1/px-1 is the belt-and-braces
                fallback for sub-320px viewports. */}
            <nav className="-mx-1 flex flex-wrap gap-x-4 gap-y-1 overflow-x-auto px-1 text-dim">
              <Link href="/" className="hover:text-ink">overview</Link>
              <Link href="/approvals" className="hover:text-ink">approvals</Link>
              <Link href="/runs" className="hover:text-ink">runs</Link>
              <Link href="/backlog" className="hover:text-ink">backlog</Link>
              <Link href="/budget" className="hover:text-ink">budget</Link>
              <Link href="/settings" className="hover:text-ink">settings</Link>
            </nav>
            <div className="ml-auto">
              <BotStatusBadge />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        <AutoRefresh everyMs={5000} />
      </body>
    </html>
  );
}
