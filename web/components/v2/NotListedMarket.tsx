import { Notice, PageHead, Panel } from "@/components/ui";
import { NOT_LISTED_LABEL } from "@/lib/v2/marketAccess";

/** Deliberately contains no links, forms, wallet controls or other trade affordances. */
export function NotListedMarket({ ticker }: { ticker: string }) {
  return <>
    <PageHead eyebrow={`${ticker} market`} title={NOT_LISTED_LABEL}
      lede="This market is in the StonkHouse registry, but it is not open for trading." />
    <Panel><p className="text-ink-2">Check back after this market has been listed and enabled.</p></Panel>
  </>;
}

export function MarketAccessPending({ ticker }: { ticker: string }) {
  return <>
    <PageHead eyebrow={`${ticker} market`} title="Checking market availability"
      lede="Confirming that this market is enabled before showing any trading controls." />
    <Panel role="status" className="animate-pulse">Checking market status…</Panel>
  </>;
}

export function MarketAccessUnavailable({ ticker }: { ticker: string }) {
  return <>
    <PageHead eyebrow={`${ticker} market`} title="Market status unavailable"
      lede="Trading controls stay hidden until the market's enabled status can be confirmed." />
    <Notice tone="warn" role="status">The indexer and on-chain status check are unavailable. Try again shortly.</Notice>
  </>;
}
