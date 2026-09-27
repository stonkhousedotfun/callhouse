"use client";

/**
 * The app nav's link list: a client island in the header beside the theme toggle, the market switcher and the wallet
 * button. "use client" buys usePathname, for two things: aria-current on the active link, and the market the v1
 * Account and Book links point at.
 *
 * V2 HAS FIVE: Buy, Portfolio, Vaults, Wins and Markets (the Neon mockups' header). The list and the rule
 * for which one is lit live in lib/ui/navEntries.ts, because the phone tab bar (components/TabBar.tsx) renders the
 * same five below 1024px and the two must agree. In short: Buy is lit on "/" and every market page; Vaults on
 * /vaults and its two vaults (/earn, /house; /lend redirects to /earn), and on Sell options (/sell) Buy is lit;
 * Markets on /trust/markets and the rest of
 * /trust, which redirects there. The history of those choices is in
 * that file's header and in git.
 *
 * Neon look: no pill behind the current link. The current one is --accent-text, the rest --ink-2,
 * 15px semibold, each at least 44px tall.
 *
 * ACCOUNT AND BOOK ARE PER MARKET, and they are V1 entries only. Their hrefs are the current market's
 * (/tsla/account when the URL is under /tsla, lib/markets.ts marketFromPathname), and the default
 * market's (/nvda/…) on a page that belongs to no market, so the two links never send a reader to
 * the bare /account and /book redirects. V1's active test is an exact match on the lowercased
 * pathname: /nvda/account and /nvda/book are separate destinations, and a prefix test would light
 * both at once.
 *
 * No link leaves the app from the top bar (the marketing-site link is gone). The
 * footer still links to stonkhouse.fun.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";
import { ALL_MARKETS, DEFAULT_MARKET, marketFromPathname, marketHref } from "@/lib/markets";
import { V2_NAV_ENTRIES, activeV2Href, normalisePath } from "@/lib/ui/navEntries";

/* The outline is inset (-2px offset) so a focused link's ring is not clipped by its row. */
const LINK =
  "flex min-h-11 items-center whitespace-nowrap rounded-[10px] px-2.5 text-[15px] font-semibold no-underline transition-colors duration-150 focus-visible:outline-offset-[-2px] sm:px-3";
const IDLE = "text-ink-2 hover:text-ink";
const ACTIVE = "text-accent-text";

export function NavLinks() {
  const pathname = usePathname();
  const v2 = process.env.NEXT_PUBLIC_V2 === "1";
  const ticker = marketFromPathname(pathname)?.market.ticker ?? DEFAULT_MARKET.ticker;
  const links = v2
    ? V2_NAV_ENTRIES
    : [
        { href: "/", label: "Home" },
        { href: marketHref(ticker, "account"), label: "Account" },
        { href: marketHref(ticker, "book"), label: "Book" },
        { href: "/docs", label: "Docs" },
        { href: "/legal", label: "Legal" },
      ];
  const here = normalisePath(pathname);
  const current = v2 ? activeV2Href(pathname, ALL_MARKETS.map((market) => market.ticker)) : null;
  return (
    <ul className="flex items-center gap-0.5 sm:gap-1">
      {links.map((link) => {
        const active = v2 ? link.href === current : here === link.href;
        return (
          <li key={link.label}>
            <Link href={link.href} aria-current={active ? "page" : undefined} className={cn(LINK, active ? ACTIVE : IDLE)}>
              {link.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
