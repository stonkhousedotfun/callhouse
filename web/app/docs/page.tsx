import type { Metadata } from "next";
import Link from "next/link";

import { Button, ExternalLink, PageHead, Panel } from "@/components/ui";
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
          ? "Explore v2 options and ways to earn, or find your legacy v1 account below."
          : "Use your v1 account to list Stock Token calls, settle, and collect USDG. Use the book to buy or exercise calls."}
      />

      {isV2 ? <Panel as="section" pad="lg" className="grid gap-3">
        <h2 className="text-lg font-bold tracking-[-0.015em]">Current v2</h2>
        <p className="text-[15.5px] text-ink-2">This page describes the current app. The external documentation linked below covers legacy v1 accounts, not v2 trading.</p>
        <ol className="grid gap-3 text-[15.5px] text-ink-2">
          <li><strong className="text-ink">Buy:</strong> Compare live asks by market, expiry, strike, total cost including fees, and max loss. A quote can change before your transaction confirms. The full amount paid can be lost.</li>
          <li><strong className="text-ink">Write:</strong> In Earn, choose an available series and deposit the required Stock Tokens for a covered call, or USDG for a cash-secured put where supported. Set an ask; premium and collateral rent apply only if a buyer fills it. Transactions also cost gas.</li>
          <li><strong className="text-ink">Manage:</strong> Portfolio shows positions, resting orders, and balances. You can cancel an unfilled order, sell an eligible long position, or withdraw a free balance there.</li>
          <li><strong className="text-ink">Settle:</strong> Expiry does not itself complete settlement. A separate on-chain settlement step needs an available oracle result and may be delayed or disputed. Once the series is settled, check Portfolio for a payout to redeem and any balance to withdraw.</li>
        </ol>
        <div className="flex flex-wrap gap-3">
          <Button href="/">Explore markets</Button>
          <Button href="/earn" variant="ghost">Explore Earn</Button>
          <Button href="/portfolio" variant="ghost">Open Portfolio</Button>
        </div>
      </Panel> : null}

      <Panel as="section" pad="lg" className="mt-4 grid gap-4">
        <div>
          <h2 className="text-lg font-bold tracking-[-0.015em]">{isV2 ? "Legacy v1 accounts and calls" : "Current v1 accounts and calls"}</h2>
          <p className="mt-2 text-[15.5px] text-ink-2">{isV2
            ? "These steps describe the old call account and book. Existing v1 positions remain accessible for settlement and withdrawal."
            : "Your v1 account and book let you manage listings, settle expired calls, collect USDG, and exercise calls you hold."}</p>
        </div>
        <ol className="grid gap-3 text-[15.5px] text-ink-2">
          <li>
            <Link href={v1Href(DEFAULT_MARKET.ticker, "account")} className="link font-semibold">
              Account
            </Link>
            — deposit, set how much is for sale, list, settle, collect USDG. One account per wallet per market.
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
