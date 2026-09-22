"use client";

import { cn } from "@/lib/cn";
import type { MarketDirectoryRow } from "@/lib/v2/marketDirectory";

/**
 * The market switcher: one button per market in the launch set, the selected one lit. It used to be a
 * search combobox over the whole registry; with two launch markets a search box is a field to type
 * into for no reason (owner 2026-09-22: "get rid of the search bar"). The rows come from
 * marketDirectoryRows(v2Markets(), …), which is already the launch set (lib/markets.ts).
 */
const BUTTON =
  "rounded-full border px-3 py-1.5 font-body text-[13px] font-semibold leading-none transition-colors duration-150 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/25";
const IDLE = "border-line-2 bg-surface text-ink hover:bg-surface-2";
const ACTIVE = "border-accent bg-accent text-accent-ink";

export function MarketPicker({ markets, selected, onSelect, className, ariaLabel = "Markets" }: {
  markets: readonly MarketDirectoryRow[];
  selected: string;
  onSelect: (ticker: string) => void;
  className?: string;
  ariaLabel?: string;
}) {
  return <div role="group" aria-label={ariaLabel} data-slot="market-switcher"
    className={cn("inline-flex items-center gap-1", className)}>
    {markets.map((market) => {
      const active = market.ticker === selected;
      return <button key={market.ticker} type="button" aria-pressed={active}
        onClick={() => { if (!active) onSelect(market.ticker); }}
        className={cn(BUTTON, active ? ACTIVE : IDLE)}>
        {market.ticker}
      </button>;
    })}
  </div>;
}
