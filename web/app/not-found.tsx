import type { Metadata } from "next";
import Link from "next/link";

import { Button, Chip, Panel } from "@/components/ui";
import { DEFAULT_MARKET, marketHref } from "@/lib/markets";

export const metadata: Metadata = {
  title: "Not found — StonkHouse",
  robots: { index: false },
};

/**
 * The 404, including for a market that is not live: /tsla/account is this page until TSLA's
 * registry row is live. Account and Book point at the default market (lib/markets.ts), the same
 * place the bare /account and /book redirects go.
 */
const ROUTES = [
  { href: "/", label: "Home", what: "What StonkHouse is, and which markets are live" },
  { href: marketHref(DEFAULT_MARKET.ticker, "account"), label: "Account", what: "Put stock in. Offer it this week." },
  { href: marketHref(DEFAULT_MARKET.ticker, "book"), label: "Book", what: "Buy this week, or exercise" },
  { href: "/docs", label: "Docs", what: "How this works" },
  { href: "/legal", label: "Legal", what: "Who this is for" },
] as const;

export default function NotFound() {
  return (
    <div className="grid grid-cols-1 items-center gap-10 pt-6 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)] lg:gap-14 lg:pt-14">
      <div>
        <Chip tone="accent" dot>
          <span>
            <span className="num">404</span> · Page not found
          </span>
        </Chip>
        <h1 className="mt-5 text-[length:clamp(36px,5vw,58px)] font-extrabold leading-[1.03] tracking-[-0.035em]">
          There is nothing <span className="text-accent-text">at this address.</span>
        </h1>
        <p className="mt-5 max-w-[34em] text-[17.5px] leading-[1.6] text-ink-2 sm:text-[18.5px]">
          The link is old or mistyped, or it names a market that is not open yet.
        </p>
        <div className="mt-7 flex flex-wrap gap-2.5 sm:gap-3">
          <Button href="/">Home</Button>
          <Button variant="ghost" href={marketHref(DEFAULT_MARKET.ticker, "account")}>
            Account
          </Button>
          <Button variant="ghost" href={marketHref(DEFAULT_MARKET.ticker, "book")}>
            Book
          </Button>
        </div>
      </div>

      <Panel pad="none" className="overflow-hidden">
        <nav aria-labelledby="routes-h">
          <h2 id="routes-h" className="px-[22px] pb-3 pt-5 font-display text-[17px] font-bold tracking-[-0.01em]">
            Pages
          </h2>
          <ul>
            {ROUTES.map((route) => (
              <li key={route.href} className="border-t border-line">
                <Link
                  href={route.href}
                  className="group flex items-center gap-4 px-[22px] py-3.5 no-underline transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-offset-[-2px]"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-2.5">
                      <span className="font-display text-[16.5px] font-bold tracking-[-0.01em] text-ink">
                        {route.label}
                      </span>
                      <span className="num text-[12.5px] text-ink-3">{route.href}</span>
                    </span>
                    <span className="mt-0.5 block text-[14.5px] text-ink-2">{route.what}</span>
                  </span>
                  <span
                    aria-hidden="true"
                    className="text-ink-3 transition-[color,translate] duration-150 group-hover:translate-x-0.5 group-hover:text-accent-text"
                  >
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </Panel>
    </div>
  );
}
