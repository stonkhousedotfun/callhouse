import type { Metadata, Viewport } from "next";
import { Figtree, Geist_Mono, Schibsted_Grotesk } from "next/font/google";

import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { Container } from "@/components/ui";
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
 * THE robots DECISION — the app is NOT indexed, and that is on purpose. Two reasons, both real:
 *
 *   1. The marketing site at stonkhouse.fun carries the canonical /legal and /how-it-works copy.
 *      Serving the same disclosures from two domains is duplicate content, and duplicate
 *      content splits which of the two a search engine decides to show. The disclosures should
 *      have one address.
 *   2. This is a restricted perimeter, and the marketing surface is the one whose copy is gated
 *      by scripts/copy-lint.mjs on every build. The page a stranger finds first should be the
 *      page whose wording is checked before it ships.
 *
 * `follow: true` because the links out of here (explorer, the marketing site) are still worth
 * following; it is indexing this domain that we decline. The app is reached by link from
 * stonkhouse.fun, not by search. app/robots.ts states the same thing as a served robots.txt —
 * the two must be changed together.
 */
export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: "Stonkhouse — pooled covered calls on Robinhood Chain",
  description:
    "Pooled covered calls on tokenised stocks. The first vault is NVDA; more stocks follow. Each week the vault lists calls and writes them only when a buyer fills. Beta, pending audit.",
  // Per-page canonicals override this where a route sets one; the default is the app root.
  alternates: { canonical: "/" },
  openGraph: {
    title: "Stonkhouse — pooled covered calls on Robinhood Chain",
    description:
      "Pooled covered calls on tokenised stocks. The first vault is NVDA; more stocks follow. Each week the vault lists calls and writes them only when a buyer fills. Beta, pending audit.",
    url: APP_URL,
    siteName: "Stonkhouse",
    type: "website",
  },
  twitter: { card: "summary_large_image" },
  robots: { index: false, follow: true },
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
        <Providers>
          <Nav />
          {/* One 1160px column for every route, the same width as the site's chrome. Pages lay out
              their own head and cards inside it. */}
          <main id="main" className="flex-1">
            <Container className="pb-16 sm:pb-24">{children}</Container>
          </main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
