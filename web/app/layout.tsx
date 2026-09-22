import type { Metadata, Viewport } from "next";
import { Figtree, Geist_Mono, Schibsted_Grotesk } from "next/font/google";

import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { Container } from "@/components/ui";
import { V2ConfigNotice } from "@/components/v2/RouteViews";
import { DEV_PREVIEW } from "@/lib/devPreview";
import { APP_URL } from "@/lib/site";
import { Providers } from "./providers";
import "./globals.css";

/**
 * Daylight type, the same three faces as stonkhouse.fun (stonkhousedotfun/callhouse-site:
 * app/layout.tsx). next/font downloads them at BUILD time and serves them from this origin, so a
 * visitor's browser never contacts Google; the build itself does need to reach Google Fonts. Each
 * exposes a CSS variable on <html> that app/globals.css maps into font-display / font-body /
 * font-mono.
 *
 * Schibsted Grotesk 500–800 for display, Figtree 400–700 for body, Geist Mono 400–600 for every
 * number; stay inside those weights.
 */
const display = Schibsted_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-schibsted-grotesk",
});

const body = Figtree({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-figtree",
});

const mono = Geist_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-geist-mono",
});

/**
 * `metadataBase` is app.stonkhouse.fun because that is where this package is served. Relative
 * canonicals and Open Graph URLs resolve against it; without it Next warns and falls back to
 * localhost in a production build.
 *
 * With v1 (the default), the app is not indexed. Two reasons shaped that decision:
 *
 *   1. The marketing site at stonkhouse.fun carries the canonical /legal and /how-it-works copy.
 *      Serving the same disclosures from two domains is duplicate content, and duplicate
 *      content splits which of the two a search engine decides to show. The disclosures should
 *      have one address.
 *   2. This is a restricted perimeter, and the marketing surface is the one whose copy is gated
 *      by disclosure policy (copy-lint enforced this until it was removed on 2026-09-21; nothing checks it now). The page a stranger finds first should be the
 *      page whose wording is checked before it ships.
 *
 * With NEXT_PUBLIC_V2=1 outside a dev preview, public buyer pages opt into indexing in their
 * own metadata and app/robots.ts exposes those routes. Private and legacy pages remain noindex.
 */
export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: process.env.NEXT_PUBLIC_V2 === "1" ? "StonkHouse — buy an outcome" : "StonkHouse — let your stonks work for you",
  description:
    process.env.NEXT_PUBLIC_V2 === "1"
      ? "Explore Stock Token options with a known maximum loss before you buy."
      : "Put your Stock Tokens in. Each week someone can pay you for the chance to buy them at a set price. If they don't, you keep the stock.",
  // Per-page canonicals override this where a route sets one; the default is the app root.
  alternates: { canonical: "/" },
  openGraph: {
    title: process.env.NEXT_PUBLIC_V2 === "1" ? "StonkHouse — buy an outcome" : "StonkHouse — let your stonks work for you",
    description:
      process.env.NEXT_PUBLIC_V2 === "1"
        ? "Explore Stock Token options with a known maximum loss before you buy."
        : "Put your Stock Tokens in. Each week someone can pay you for the chance to buy them at a set price. If they don't, you keep the stock.",
    url: APP_URL,
    siteName: "StonkHouse",
    type: "website",
  },
  twitter: { card: "summary_large_image" },
  robots: { index: false, follow: !DEV_PREVIEW },
};

/**
 * Browser chrome follows the page ground in each colour scheme: the --ground token in
 * app/globals.css, light and dark, the same pair stonkhouse.fun declares, so moving between the
 * two domains does not flash a different chrome colour. Change them together.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f8f6" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1511" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body className="flex min-h-dvh flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-[10px] focus:bg-surface focus:px-3.5 focus:py-2.5 focus:text-sm focus:font-semibold focus:text-ink focus:shadow-lift"
        >
          Skip to content
        </a>
        {DEV_PREVIEW ? (
          <aside aria-label="Development preview" className="border-b border-amber-400 bg-amber-100 text-amber-950">
            <Container className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <strong className="shrink-0 rounded-full bg-amber-950 px-2.5 py-0.5 text-xs tracking-wide text-amber-50">DEV PREVIEW</strong>
              <span>Testing environment. Transactions may use real assets on Robinhood Chain. Review before signing.</span>
            </Container>
          </aside>
        ) : null}
        <Providers>
          <Nav />
          {/* One 1160px column for every route, the same width as the site's chrome. Pages lay out
              their own head and cards inside it. */}
          <main id="main" className="flex-1">
            <Container className="pb-16 sm:pb-24">
              {process.env.NEXT_PUBLIC_V2 === "1" ? <V2ConfigNotice /> : null}
              {children}
            </Container>
          </main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
