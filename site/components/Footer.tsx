/**
 * Footer for callhouse.xyz. Server component — there is nothing here to hydrate, and this
 * package has no client runtime to spend on a row of links.
 *
 * The markup is web/app/layout.tsx's footer (.footer / .footer-inner, same type scale, same
 * separators) so the bottom of the two domains matches. Three rows, in this order:
 *
 *   1. what this is — product, share ticker, collateral, chain.
 *   2. where to go  — the four disclosure pages and the explainer first, then the two links that
 *                     leave this domain. Legal leads because it is the row's reason for existing;
 *                     Terms and Privacy follow it because they are the documents /legal cites.
 *   3. the standing disclaimers, carried word for word from the dapp's footer. They are copied
 *      rather than shared: site/ builds with no dependency on web/. If one is reworded, reword
 *      both in the same commit, or the same sentence reads two ways on two hostnames.
 *
 * DELIBERATELY ABSENT: the dapp's "vault contract ↗" link. The vault is not deployed, lib/site.ts
 * carries no address for it, and a footer link to nothing is worse than no link.
 *
 * ALSO DELIBERATELY ABSENT: a link to the source repository. It may not be public, and a dead
 * "source" link in a footer reads as a withdrawn claim. What a reader actually needs from that
 * link is the audit status, so the last row states it outright instead: the contracts in this
 * repository have not been audited. That line is not in the dapp's footer; it belongs here,
 * where people read before they deposit.
 */
import Link from "next/link";

import { APP_URL, CHAIN_ID, CHAIN_NAME, EXPLORER_URL, MARKET, SHARE_TICKER } from "@/lib/site";

export function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div>
          Callhouse · {SHARE_TICKER} · {MARKET} on {CHAIN_NAME} {CHAIN_ID}
        </div>
        {/* In-site routes are next/link. The last two are plain anchors on other origins, and
            they carry `.ext`, which is what draws the ↗ the dapp's footer hardcodes — do not add
            a second glyph to the label. */}
        <div>
          <Link href="/legal">Legal</Link> · <Link href="/terms">Terms</Link> ·{" "}
          <Link href="/privacy">Privacy</Link> · <Link href="/risks">Risks</Link> ·{" "}
          <Link href="/how-it-works">How it works</Link> ·{" "}
          <a className="ext" href={APP_URL} target="_blank" rel="noreferrer noopener">
            app.callhouse.xyz
          </a>{" "}
          ·{" "}
          <a className="ext" href={EXPLORER_URL} target="_blank" rel="noreferrer noopener">
            Explorer
          </a>
        </div>
      </div>
      <div className="footer-inner" style={{ marginTop: 10 }}>
        <div>
          Not affiliated with Robinhood Markets, Robinhood Assets (Jersey) Limited, Overcall or
          Valorem. Nothing here is financial advice or an offer of securities.
        </div>
      </div>
      <div className="footer-inner" style={{ marginTop: 6 }}>
        <div>The contracts in this repository have not been audited.</div>
      </div>
    </footer>
  );
}
