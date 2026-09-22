"use client";

/**
 * Compact native select for the app chrome. V1 keeps its live-market account/book section on
 * switch. V2 searches the known registry markets and lands on the new market page; on
 * /earn/[ticker], it keeps the Earn section. A series id cannot move between underlyings. V1
 * keeps the native select; v2 needs a filterable list for its full ticker set.
 */
import { usePathname, useRouter } from "next/navigation";

import { MarketPicker } from "@/components/v2/MarketPicker";
import { cn } from "@/lib/cn";
import { DEFAULT_MARKET, MARKETS, marketFromPathname, marketHref, v2Markets } from "@/lib/markets";
import { useMarkets } from "@/lib/v2/hooks";
import { marketDirectoryRows, type MarketDirectoryApiState } from "@/lib/v2/marketDirectory";

const SELECT =
  "appearance-none rounded-full border border-line-2 bg-surface py-1.5 pl-3 pr-7 font-body text-[13px] font-semibold leading-none text-ink transition-colors duration-150 hover:bg-surface-2 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/25";

function V2MarketSwitcher({ className }: { className?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const api = useMarkets();
  const apiState: MarketDirectoryApiState = api.isError
    ? { kind: "error" }
    : api.data
      ? { kind: "ready", markets: api.data }
      : { kind: "loading" };
  const markets = marketDirectoryRows(v2Markets(), apiState);
  const segments = pathname?.split("/").filter(Boolean) ?? [];
  const onEarnMarket = segments[0] === "earn" && segments.length === 2;
  const v2Ticker = (onEarnMarket ? segments[1] : segments[0])?.toUpperCase();
  // The v2 control is a search, not a default-market selector. Generic pages have no
  // selected market; preselecting NVDA there made choosing NVDA a no-op.
  const selected = markets.some((market) => market.ticker === v2Ticker) ? v2Ticker ?? "" : "";

  return <MarketPicker key={selected} markets={markets} selected={selected} className={className}
    onSelect={(next) => router.push(`${onEarnMarket ? "/earn" : ""}/${next.toLowerCase()}`)} />;
}

function LegacyMarketSwitcher({ className }: { className?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const here = marketFromPathname(pathname);
  const selected = here?.market.ticker ?? DEFAULT_MARKET.ticker;
  const section = here?.section ?? "account";

  return (
    <label className={cn("relative inline-flex items-center", className)}>
      <span className="sr-only">Market</span>
      <select
        data-slot="market-switcher"
        className={SELECT}
        value={selected}
        onChange={(e) => {
          const next = e.target.value;
          if (next !== selected) router.push(marketHref(next, section));
        }}
      >
        {MARKETS.map((m) => (
          <option key={m.ticker} value={m.ticker}>
            {m.ticker}
          </option>
        ))}
      </select>
      <svg
        width="10"
        height="10"
        viewBox="0 0 14 14"
        aria-hidden="true"
        focusable="false"
        className="pointer-events-none absolute right-2.5 text-ink-3"
      >
        <path fill="currentColor" d="M2.6 5.1 3.7 4 7 7.3 10.3 4l1.1 1.1L7 9.5 2.6 5.1Z" />
      </svg>
    </label>
  );
}

export function MarketSwitcher({ className }: { className?: string }) {
  return process.env.NEXT_PUBLIC_V2 === "1"
    ? <V2MarketSwitcher className={className} />
    : <LegacyMarketSwitcher className={className} />;
}
