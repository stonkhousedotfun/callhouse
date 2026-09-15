/**
 * App footer, in the layout stonkhouse.fun uses (leekzor/callhouse-site: components/Footer.tsx).
 * Server component: nothing here hydrates.
 *
 * Three rows, in this order:
 *   1. what this is: product, share ticker, collateral, chain, and the vault contract once one is
 *      configured.
 *   2. where to go: the in-app pages first, then the links that leave the app, each marked ↗ and
 *      opening a new tab. Terms and Privacy are external: the documents live on the marketing site
 *      only (lib/site.ts). stonkhouse.fun sits last because it leaves the app entirely.
 *   3. the standing disclaimers. "Not affiliated with Robinhood Markets, Robinhood Assets (Jersey)
 *      Limited or Valorem" is carried word for word on stonkhouse.fun too; if it is reworded,
 *      reword both in paired commits across the two repos.
 */
import Link from "next/link";

import { Container, ExternalLink } from "@/components/ui";
import { EXPLORER_URL, addressUrl } from "@/lib/chain";
import { MARKET, SHARE_TICKER, VAULT } from "@/lib/contracts";
import { DOCS_URL, PRIVACY_URL, SITE_URL, STATUS, TERMS_URL } from "@/lib/site";

const LINK = "rounded-sm text-ink-2 no-underline transition-colors duration-150 hover:text-ink";

/** "docs.stonkhouse.fun" / "stonkhouse.fun" in production; the configured host otherwise. */
const host = (url: string) => url.replace(/^https?:\/\//i, "");

export function Footer() {
  return (
    <footer>
      <Container>
        <div className="grid gap-3.5 border-t border-line pb-12 pt-8 text-[13.5px] text-ink-3">
          <p>
            <span className="font-display font-bold text-ink-2">Stonkhouse</span> · <span className="num">{SHARE_TICKER}</span> ·{" "}
            {MARKET} on Robinhood Chain <span className="num">4663</span>
            {VAULT ? (
              <>
                {" · "}
                <ExternalLink href={addressUrl(VAULT)} arrow className={LINK}>
                  vault contract
                </ExternalLink>
              </>
            ) : null}
          </p>
          <nav aria-label="Footer">
            <ul className="flex flex-wrap gap-x-[18px] gap-y-2">
              <li>
                <Link href="/legal" className={LINK}>
                  Legal
                </Link>
              </li>
              <li>
                <Link href="/docs" className={LINK}>
                  Docs
                </Link>
              </li>
              <li>
                <ExternalLink href={TERMS_URL} arrow className={LINK}>
                  Terms
                </ExternalLink>
              </li>
              <li>
                <ExternalLink href={PRIVACY_URL} arrow className={LINK}>
                  Privacy
                </ExternalLink>
              </li>
              <li>
                <ExternalLink href={EXPLORER_URL} arrow className={LINK}>
                  Explorer
                </ExternalLink>
              </li>
              <li>
                <ExternalLink href={DOCS_URL} arrow className={LINK}>
                  {host(DOCS_URL)}
                </ExternalLink>
              </li>
              <li>
                <ExternalLink href={SITE_URL} arrow className={LINK}>
                  {host(SITE_URL)}
                </ExternalLink>
              </li>
            </ul>
          </nav>
          <p className="max-w-[70em]">
            Not affiliated with Robinhood Markets, Robinhood Assets (Jersey) Limited or Valorem. {STATUS.phase}.{" "}
            {STATUS.auditLine} Nothing here is financial advice or an offer of securities.
          </p>
        </div>
      </Container>
    </footer>
  );
}
