import { Notice, PageHead, Panel } from "@/components/ui";
import { NOT_LISTED_LABEL } from "@/lib/v2/marketAccess";

/** Deliberately contains no links, forms, wallet controls or other trade affordances. */
export function NotListedMarket({ ticker }: { ticker: string }) {
  return <PageHead eyebrow={`${ticker} market`} title={NOT_LISTED_LABEL} lede="This market is not open for trading yet." />;
}

export function MarketAccessPending({ ticker }: { ticker: string }) {
  return <>
    <PageHead eyebrow={`${ticker} market`} title="Checking market availability" />
    <Panel role="status" className="animate-pulse">Checking market status…</Panel>
  </>;
}

export function MarketAccessUnavailable({ ticker }: { ticker: string }) {
  return <>
    <PageHead eyebrow={`${ticker} market`} title="Market status unavailable" />
    <Notice tone="warn" role="status">We couldn&apos;t confirm this market is open, so trading is hidden. Try again shortly.</Notice>
  </>;
}
