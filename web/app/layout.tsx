import type { Metadata, Viewport } from "next";

import { Nav } from "@/components/Nav";
import Link from "next/link";

import { EXPLORER_URL, addressUrl } from "@/lib/chain";
import { MARKET, SHARE_TICKER, VAULT } from "@/lib/contracts";
import { APP_URL, DOCS_URL, PRIVACY_URL, SITE_URL, TERMS_URL } from "@/lib/site";
import { Providers } from "./providers";
import "./globals.css";

/**
 * `metadataBase` is app.callhouse.finance because that is where this package is served. Relative
 * canonicals and Open Graph URLs resolve against it; without it Next warns and falls back to
 * localhost in a production build.
 *
 * THE robots DECISION — the app is NOT indexed, and that is on purpose. Two reasons, both real:
 *
 *   1. The marketing site at callhouse.finance carries the canonical /legal and /how-it-works copy.
 *      Serving the same disclosures from two domains is duplicate content, and duplicate
 *      content splits which of the two a search engine decides to show. The disclosures should
 *      have one address.
 *   2. This is a restricted perimeter, and the marketing surface is the one whose copy is gated
 *      by scripts/copy-lint.mjs on every build. The page a stranger finds first should be the
 *      page whose wording is checked before it ships.
 *
 * `follow: true` because the links out of here (explorer, the marketing site) are still worth
 * following; it is indexing this domain that we decline. The app is reached by link from
 * callhouse.finance, not by search. app/robots.ts states the same thing as a served robots.txt —
 * the two must be changed together.
 */
export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: "Callhouse — pooled covered calls on Robinhood Chain",
  description:
    "Deposit one tokenised stock, receive vault shares. Each week a keeper writes an Overcall call against it and pays depositors whatever premium actually fills.",
  // Per-page canonicals override this where a route sets one; the default is the app root.
  alternates: { canonical: "/" },
  openGraph: {
    title: "Callhouse — pooled covered calls on Robinhood Chain",
    description:
      "Deposit one tokenised stock, receive vault shares. Each week a keeper writes an Overcall call against it and pays depositors whatever premium actually fills.",
    url: APP_URL,
    siteName: "Callhouse",
    type: "website",
  },
  twitter: { card: "summary_large_image" },
  robots: { index: false, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b0d10",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <Nav />
          <main className="shell">{children}</main>
          <footer className="footer">
            <div className="footer-inner">
              <div>
                Callhouse · {SHARE_TICKER} · {MARKET} on Robinhood Chain 4663
                {VAULT ? (
                  <>
                    {" · "}
                    <a href={addressUrl(VAULT)} target="_blank" rel="noreferrer noopener">
                      vault contract ↗
                    </a>
                  </>
                ) : null}
              </div>
              {/* Second row of links. callhouse.finance sits last because it leaves the app: the
                  in-app destinations come first, then the external ones. Terms and Privacy are
                  external too — the documents live on the marketing site only (lib/site.ts). */}
              <div>
                <Link href="/legal">Legal</Link> · <Link href="/docs">Docs</Link> ·{" "}
                <a href={TERMS_URL} target="_blank" rel="noreferrer noopener">
                  Terms ↗
                </a>{" "}
                ·{" "}
                <a href={PRIVACY_URL} target="_blank" rel="noreferrer noopener">
                  Privacy ↗
                </a>{" "}
                ·{" "}
                <a href={EXPLORER_URL} target="_blank" rel="noreferrer noopener">
                  Explorer ↗
                </a>{" "}
                ·{" "}
                <a href={DOCS_URL} target="_blank" rel="noreferrer noopener">
                  docs.callhouse.finance ↗
                </a>{" "}
                ·{" "}
                <a href={SITE_URL} target="_blank" rel="noreferrer noopener">
                  callhouse.finance ↗
                </a>
              </div>
            </div>
            <div className="footer-inner" style={{ marginTop: 10 }}>
              <div>
                Not affiliated with Robinhood Markets, Robinhood Assets (Jersey) Limited, Overcall
                or Valorem. Nothing here is financial advice or an offer of securities.
              </div>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
