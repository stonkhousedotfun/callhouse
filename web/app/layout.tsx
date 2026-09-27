import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";

import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { Container } from "@/components/ui";
import { V2ConfigNotice } from "@/components/v2/RouteViews";
import { DEV_PREVIEW } from "@/lib/devPreview";
import { APP_URL } from "@/lib/site";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import { Providers } from "./providers";
import "./globals.css";

/**
 * Neon type, the same two faces as stonkhouse.fun. next/font downloads them
 * at BUILD time and serves them from this origin, so a visitor's browser never contacts Google; the build itself does
 * need to reach Google Fonts. Each exposes a CSS variable on <html> that app/globals.css maps into font-display /
 * font-body / font-sans (Plus Jakarta Sans) and font-mono (JetBrains Mono).
 *
 * Plus Jakarta Sans 400–800 for all text and headline numbers, JetBrains Mono 400–600 for tabular figures; stay
 * inside those weights. A number people compare down a column uses mono; a number that is the point of the screen
 * uses heavy sans (spec 4).
 */
const sans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
  variable: "--font-plus-jakarta-sans",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-jetbrains-mono",
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
 *      by disclosure policy (nothing checks it automatically now). The page a stranger finds first should be the
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
 * Browser chrome follows the page ground in each colour scheme: the --ground token in app/globals.css, DAY #ffffff
 * and NIGHT #000000, the same pair stonkhouse.fun declares, so moving between the two domains does not flash a
 * different chrome colour. Change them together. (Chrome follows the SYSTEM setting; the in-page toggle cannot move
 * a meta tag the browser has already read.)
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: THEME_INIT_SCRIPT sets data-theme on <html> before React hydrates, on purpose, so the
    // server markup (no attribute) and the client DOM differ in exactly that one attribute.
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        {/* Night/day before first paint (spec 3.1): the stored choice, else the system setting. lib/theme.ts. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="flex min-h-dvh flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-[10px] focus:bg-surface focus:px-3.5 focus:py-2.5 focus:text-sm focus:font-semibold focus:text-ink focus:shadow-lift"
        >
          Skip to content
        </a>
        <Providers>
          <Nav />
          {/* One 1200px content column for every route (Container). Pages lay out
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
