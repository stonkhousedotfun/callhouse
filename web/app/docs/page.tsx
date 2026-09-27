import type { Metadata } from "next";
import Link from "next/link";

import { Button, ExternalLink, InfoTip, PageHead, Panel } from "@/components/ui";
import { legacyMarketPath } from "@/app/legacy/routes";
import { addressUrl } from "@/lib/chain";
import { DEFAULT_MARKET, MARKETS, REGISTRY, marketHref } from "@/lib/markets";
import { DOCS_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Docs — StonkHouse",
  description: "How StonkHouse works.",
};

/** The compiled v1 registry provides account/book links; v2 market discovery uses the live API. */
export default function DocsPage() {
  const isV2 = process.env.NEXT_PUBLIC_V2 === "1";
  const v1Href = (ticker: string, section: "account" | "book") =>
    isV2 ? legacyMarketPath(ticker, section) : marketHref(ticker, section);

  return (
    <>
      <PageHead
        eyebrow="Docs"
        title="How this works"
        lede={isV2
          ? "Buy options, write them in Earn, or find your legacy v1 account below."
          : "Use your v1 account to list Stock Token calls, settle, and collect USDG. Use the book to buy or exercise calls."}
      />

      {isV2 ? <Panel as="section" pad="lg" className="grid gap-3">
        <h2 className="text-lg font-bold tracking-[-0.015em]">Current v2</h2>
        <ol className="grid gap-3 text-[15.5px] text-ink-2">
          <li><strong className="text-ink">Buy:</strong> Pick a market, expiry and strike, and buy at the ask.{" "}
            <InfoTip label="About buying">Your total cost, fees included, is the most you can lose. A quote can change before your transaction confirms.</InfoTip></li>
          <li><strong className="text-ink">Sell options:</strong> Lock Stock Tokens for a covered call, or USDG for a cash-secured put where offered, and set an ask.{" "}
            <InfoTip label="About fees">A first sale currently pays 5% of the premium; a resale currently pays nothing. Fees can change after a scheduled notice. Gas is extra.</InfoTip></li>
          <li><strong className="text-ink">Earn:</strong> Deposit USDG into the Earn vault. It&apos;s lent out for interest.</li>
          <li><strong className="text-ink">Manage:</strong> Portfolio shows your positions, orders and balances. Cancel, sell or withdraw from there.</li>
          <li><strong className="text-ink">Settle:</strong> After expiry, a separate on-chain step settles the series. Then check Portfolio for any payout.{" "}
            <InfoTip label="About settlement">That step needs a price from the oracle and can be delayed or disputed.</InfoTip></li>
        </ol>
        <div className="flex flex-wrap gap-3">
          <Button href="/">Explore markets</Button>
          <Button href="/sell" variant="ghost">Sell options</Button>
          <Button href="/earn" variant="ghost">Explore Earn</Button>
          <Button href="/portfolio" variant="ghost">Open Portfolio</Button>
        </div>
      </Panel> : null}

      <Panel as="section" pad="lg" className="mt-4 grid gap-4">
        <div>
          <h2 className="text-lg font-bold tracking-[-0.015em]">{isV2 ? "Legacy v1 accounts and calls" : "Current v1 accounts and calls"}</h2>
          <p className="mt-2 text-[15.5px] text-ink-2">{isV2
            ? "Existing v1 positions can still be settled and withdrawn."
            : "Your v1 account and book let you manage listings, settle expired calls, collect USDG, and exercise calls you hold."}</p>
        </div>
        <ol className="grid gap-3 text-[15.5px] text-ink-2">
          <li>
            <Link href={v1Href(DEFAULT_MARKET.ticker, "account")} className="link font-semibold">
              Account
            </Link>
            — deposit, list, settle and collect USDG. One account per wallet per market.
          </li>
          <li>
            <Link href={v1Href(DEFAULT_MARKET.ticker, "book")} className="link font-semibold">
              Book
            </Link>
            — buy a call, or exercise one you already hold.
          </li>
        </ol>
        <div>
          <Button href={DOCS_URL}>{isV2 ? "Legacy v1 documentation" : "Full v1 documentation"}</Button>
        </div>
      </Panel>

      <Panel as="section" pad="lg" className="mt-4 grid gap-4">
        <h2 className="text-lg font-bold tracking-[-0.015em]">
          {isV2
            ? MARKETS.length === 1 ? "The legacy v1 market" : `The ${MARKETS.length} legacy v1 markets`
            : MARKETS.length === 1 ? "The live market" : `The ${MARKETS.length} live markets`}
        </h2>
        <ul className="grid gap-4">
          {MARKETS.map((m) => (
            <li key={m.ticker} className="grid gap-1.5 border-t border-line pt-4 text-[14px] text-ink-2 first:border-t-0 first:pt-0">
              <p>
                <span className="font-display text-[16.5px] font-bold text-ink">{m.ticker}</span>
                <span className="text-ink-3"> · {m.name}</span>
                {" · "}
                <Link href={v1Href(m.ticker, "account")} className="link">
                  account
                </Link>
                {" · "}
                <Link href={v1Href(m.ticker, "book")} className="link">
                  book
                </Link>
              </p>
              <p className="text-ink-3">
                Factory{" "}
                <ExternalLink href={addressUrl(m.factory)} className="link num [overflow-wrap:anywhere]">
                  {m.factory}
                </ExternalLink>{" "}
                <span className="num">(block {m.deployBlock})</span>
              </p>
              <p className="text-ink-3">
                Stock Token{" "}
                <ExternalLink href={addressUrl(m.asset)} className="link num [overflow-wrap:anywhere]">
                  {m.asset}
                </ExternalLink>
              </p>
            </li>
          ))}
        </ul>
        <p className="text-[12.5px] text-ink-3">
          {isV2 ? "Legacy v1 addresses" : "Addresses"} from the market registry, verified on chain at block <span className="num">{REGISTRY.verifiedAtBlock}</span>.
        </p>
      </Panel>
    </>
  );
}
