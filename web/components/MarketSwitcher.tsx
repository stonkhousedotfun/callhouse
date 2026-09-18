"use client";

/**
 * Compact native select for the app chrome. V1 keeps its live-market account/book section on
 * switch. V2 searches the known registry markets and lands on the new market page; on
 * /earn/[ticker], it keeps the Earn section. A series id cannot move between underlyings. V1
 * keeps the native select; v2 needs a filterable list for its full ticker set.
 */
import { useEffect, useId, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { cn } from "@/lib/cn";
import { ALL_MARKETS, DEFAULT_MARKET, MARKETS, marketFromPathname, marketHref } from "@/lib/markets";

const SELECT =
  "appearance-none rounded-full border border-line-2 bg-surface py-1.5 pl-3 pr-7 font-body text-[13px] font-semibold leading-none text-ink transition-colors duration-150 hover:bg-surface-2 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/25";

function matchesMarket(query: string, ticker: string, name: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle === "" || ticker.toLowerCase().includes(needle) || name.toLowerCase().includes(needle);
}

function V2MarketSearch({ selected, onSelect, className }: {
  selected: string; onSelect: (ticker: string) => void; className?: string;
}) {
  const [query, setQuery] = useState(selected);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuLeft, setMenuLeft] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const visibleMarkets = ALL_MARKETS.filter((market) => matchesMarket(query, market.ticker, market.name));

  function positionMenu() {
    const input = inputRef.current;
    const parent = input?.parentElement;
    if (!input || !parent) return;
    const inputRect = input.getBoundingClientRect();
    const menuWidth = Math.min(288, window.innerWidth - 32);
    const centered = inputRect.left + inputRect.width / 2 - menuWidth / 2;
    const clamped = Math.max(16, Math.min(centered, window.innerWidth - menuWidth - 16));
    setMenuLeft(clamped - parent.getBoundingClientRect().left);
  }

  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", positionMenu);
    return () => window.removeEventListener("resize", positionMenu);
  }, [open]);

  function selectV2Market(next: string) {
    setQuery(next);
    setOpen(false);
    onSelect(next);
  }

  return (
    <div className={cn("relative inline-flex items-center", className)}>
      <input
        ref={inputRef}
        data-slot="market-switcher"
        type="search"
        value={query}
        onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); setOpen(true); }}
        onFocus={() => { positionMenu(); setActiveIndex(0); setOpen(true); }}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") { setOpen(false); event.currentTarget.blur(); return; }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (visibleMarkets.length > 0) setActiveIndex((before) =>
              (before + (event.key === "ArrowDown" ? 1 : -1) + visibleMarkets.length) % visibleMarkets.length);
            setOpen(true);
            return;
          }
          if (event.key !== "Enter") return;
          const exact = ALL_MARKETS.find((market) => market.ticker.toLowerCase() === query.trim().toLowerCase());
          const choice = exact ?? visibleMarkets[activeIndex];
          if (choice) { event.preventDefault(); selectV2Market(choice.ticker); }
        }}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && visibleMarkets[activeIndex] ? `${listId}-${activeIndex}` : undefined}
        aria-label="Search markets"
        placeholder="Search markets"
        className={`${SELECT} w-40 pr-3 sm:w-52`}
      />
      {open ? <ul id={listId} role="listbox" aria-label="Markets"
        style={{ left: menuLeft ?? 0 }}
        className="absolute top-full z-50 mt-2 max-h-72 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-md border border-line-2 bg-surface p-1 shadow-lg">
        {visibleMarkets.length ? visibleMarkets.map((market, index) => <li key={market.ticker} id={`${listId}-${index}`} role="option" aria-selected={index === activeIndex}
          onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveIndex(index)} onClick={() => selectV2Market(market.ticker)}
          className={`flex cursor-pointer items-baseline justify-between gap-3 rounded-sm px-3 py-2 text-left hover:bg-surface-2 ${index === activeIndex ? "bg-surface-2" : ""}`}>
            <span className="font-semibold text-ink">{market.ticker}</span><span className="truncate text-xs text-ink-3">{market.name}</span>
        </li>) : <li className="px-3 py-2 text-sm text-ink-3">No markets match that search.</li>}
      </ul> : null}
    </div>
  );
}

export function MarketSwitcher({ className }: { className?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const here = marketFromPathname(pathname);
  const current = here?.market.ticker ?? DEFAULT_MARKET.ticker;
  const section = here?.section ?? "account";
  const v2 = process.env.NEXT_PUBLIC_V2 === "1";
  const markets = v2 ? ALL_MARKETS : MARKETS;
  const segments = pathname?.split("/").filter(Boolean) ?? [];
  const onEarnMarket = v2 && segments[0] === "earn" && segments.length === 2;
  const v2Ticker = (onEarnMarket ? segments[1] : segments[0])?.toUpperCase();
  // The v2 control is a search, not a default-market selector. Generic pages have no
  // selected market; preselecting NVDA there made choosing NVDA a no-op.
  const selected = v2
    ? (markets.some((market) => market.ticker === v2Ticker) ? v2Ticker : "")
    : current;

  if (v2) return <V2MarketSearch key={selected} selected={selected} className={className}
    onSelect={(next) => router.push(`${onEarnMarket ? "/earn" : ""}/${next.toLowerCase()}`)} />;

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
        {markets.map((m) => (
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
