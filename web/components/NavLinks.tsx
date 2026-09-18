"use client";

/**
 * The app nav's link list: a client island in the chrome beside the wallet button and the market
 * switcher. "use client" buys usePathname, for two things: aria-current on the active link, and
 * the market the Account and Book links point at.
 *
 * V1 retains its depositor links. V2 leads with Buy, Portfolio, Earn and Wins.
 *
 * ACCOUNT AND BOOK ARE PER MARKET. Their hrefs are the current market's (/tsla/account when the
 * URL is under /tsla, lib/markets.ts marketFromPathname), and the default market's (/nvda/…) on a
 * page that belongs to no market, so the two links never send a reader to the bare /account and
 * /book redirects. The active test is an exact match on the lowercased pathname: /nvda/account and
 * /nvda/book are separate destinations, and a prefix test would light both at once.
 *
 * One link leaves the app: stonkhouse.fun, the marketing site. It is LAST, it is deliberately not
 * part of the link list (a plain new-tab <a> through ExternalLink, not next/link, because next/link
 * is for routes this app owns and prefetching another origin is meaningless), it is set off by a
 * rule so it does not read as a sixth route, and it is never "active".
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

import { ExternalLink } from "@/components/ui";
import { cn } from "@/lib/cn";
import { ALL_MARKETS, DEFAULT_MARKET, marketFromPathname, marketHref } from "@/lib/markets";
import { SITE_URL } from "@/lib/site";

/* The outline is inset (-2px offset) because the mobile row is an overflow container, which would
   clip an outline drawn outside the link. Same classes as the site's nav. */
const LINK =
  "block whitespace-nowrap rounded-[10px] px-2.5 py-2 text-[15px] font-medium no-underline transition-colors duration-150 focus-visible:outline-offset-[-2px] sm:px-3";
const IDLE = "text-ink-2 hover:bg-surface-2 hover:text-ink";
const ACTIVE = "bg-surface text-ink shadow-soft";

/** "stonkhouse.fun" in production; whatever host a preview build points at otherwise. */
const SITE_HOST = SITE_URL.replace(/^https?:\/\//i, "");

/** A pathname with its trailing slash dropped and lowercased, so the match is on the route, not the spelling. */
function normalise(pathname: string | null): string {
  const p = (pathname ?? "/").toLowerCase();
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

export function NavLinks() {
  const pathname = usePathname();
  const ticker = marketFromPathname(pathname)?.market.ticker ?? DEFAULT_MARKET.ticker;
  const links = process.env.NEXT_PUBLIC_V2 === "1"
    ? [
        { href: "/", label: "Buy" },
        { href: "/portfolio", label: "Portfolio" },
        { href: "/earn", label: "Earn" },
        { href: "/wins", label: "Wins" },
      ]
    : [
        { href: "/", label: "Home" },
        { href: marketHref(ticker, "account"), label: "Account" },
        { href: marketHref(ticker, "book"), label: "Book" },
        { href: "/docs", label: "Docs" },
        { href: "/legal", label: "Legal" },
      ];
  const here = normalise(pathname);
  const onV2Market = ALL_MARKETS.some((market) => {
    const prefix = `/${market.ticker.toLowerCase()}`;
    return here === prefix || here.startsWith(`${prefix}/`) && here !== `${prefix}/account` && here !== `${prefix}/book`;
  });
  return (
    <ul className="flex items-center gap-0.5 sm:gap-1">
      {links.map((link) => {
        const active = here === link.href || (process.env.NEXT_PUBLIC_V2 === "1" && (link.href === "/" ? onV2Market : here.startsWith(`${link.href}/`)));
        return (
          <li key={link.label}>
            <Link href={link.href} aria-current={active ? "page" : undefined} className={cn(LINK, active ? ACTIVE : IDLE)}>
              {link.label}
            </Link>
          </li>
        );
      })}
      <li aria-hidden="true" className="mx-1.5 h-5 w-px shrink-0 bg-line-2" />
      <li>
        <ExternalLink href={SITE_URL} arrow className={cn(LINK, "text-ink-3 hover:bg-surface-2 hover:text-ink")}>
          {SITE_HOST}
        </ExternalLink>
      </li>
    </ul>
  );
}
