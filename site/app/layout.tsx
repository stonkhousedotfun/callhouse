import type { Metadata, Viewport } from "next";

import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";

import { SITE_URL } from "@/lib/site";
import "./globals.css";

/**
 * Root layout for callhouse.xyz.
 *
 * DELIBERATELY ABSENT: a <Providers> wrapper. web/app/layout.tsx has one because the dapp needs
 * wagmi, viem and @tanstack/react-query mounted above every route. This package has none of those
 * as dependencies and must never acquire them — that is the entire point of splitting the two
 * domains. A marketing page that ships a wallet runtime pays for a connect flow it will never
 * offer, and the vault is not deployed yet, so every live figure it could render would be a zero.
 * Nothing under this layout fetches, reads a chain, or holds client state beyond the nav's active
 * link. If a page here ever needs a provider, the page belongs on app.callhouse.xyz.
 *
 * `metadataBase` is callhouse.xyz because that is where this package is served; relative
 * canonicals and Open Graph URLs resolve against it, and without it Next falls back to localhost
 * in a production build.
 *
 * THE robots DECISION — index: true HERE, and index: false in web/app/layout.tsx. The pairing is
 * the point, and the two files have to be changed together:
 *
 *   - This domain carries the canonical /legal, /risks and /how-it-works copy. Serving the same
 *     disclosures from two hostnames is duplicate content, and duplicate content lets a search
 *     engine pick which of the two it shows. The disclosures get one address, and it is this one.
 *   - This is the surface scripts/copy-lint.mjs was written for. The page a stranger finds first
 *     should be the page whose wording is checked on every build.
 *
 * The title template exists so a route only has to name itself: `title: "Risks"` renders
 * "Risks — Callhouse". The default is the full positioning line, used on "/" alone.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Callhouse — pooled covered calls on Robinhood Chain",
    template: "%s — Callhouse",
  },
  description:
    "Deposit one tokenised stock, receive vault shares. Each week a keeper writes an Overcall call against it and pays depositors whatever premium actually fills. A week with no buyer pays zero.",
  // Per-route canonicals override this; the default is the landing page.
  alternates: { canonical: "/" },
  openGraph: {
    // Stated in full rather than inherited: the template above would otherwise leak "%s" into a
    // share card on any route that sets its own title.
    title: "Callhouse — pooled covered calls on Robinhood Chain",
    description:
      "Deposit one tokenised stock, receive vault shares. Each week a keeper writes an Overcall call against it and pays depositors whatever premium actually fills. A week with no buyer pays zero.",
    url: SITE_URL,
    siteName: "Callhouse",
    type: "website",
    // en_GB, not en_US: the copy is British-ish ("tokenised", "labelled") and the product is not
    // available to US persons. <html lang> stays the generic "en" because the pages are not
    // region-targeted content — the locale here only labels the share card.
    locale: "en_GB",
  },
  twitter: { card: "summary_large_image" },
  robots: { index: true, follow: true },
};

/** Matches web/app/layout.tsx exactly. The two domains must not flash different chrome colours. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b0d10",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <main className="shell">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
