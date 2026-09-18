"use client";

/**
 * The footer's first line: how many markets are live on Robinhood Chain, and the factory link of
 * the market the reader is on (or the default market's on a page that belongs to none). A client
 * island only because "the market the reader is on" is the pathname (lib/markets.ts
 * marketFromPathname); the rest of the footer stays a server component.
 */
import { usePathname } from "next/navigation";

import { ExternalLink } from "@/components/ui";
import { addressUrl } from "@/lib/chain";
import { DEFAULT_MARKET, MARKETS, marketFromPathname } from "@/lib/markets";

export function FooterMarket({ linkClassName }: { linkClassName?: string }) {
  const pathname = usePathname();
  const market = marketFromPathname(pathname)?.market ?? DEFAULT_MARKET;
  const n = MARKETS.length;
  return (
    <>
      <span className="num">{n}</span> {n === 1 ? "market" : "markets"} on Robinhood Chain <span className="num">4663</span>
      {" · "}
      <ExternalLink href={addressUrl(market.factory)} arrow className={linkClassName}>
        {market.ticker} factory
      </ExternalLink>
    </>
  );
}
