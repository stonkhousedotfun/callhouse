"use client";

/**
 * The app nav's link list: the whole client island in the chrome besides the wallet button.
 * "use client" buys exactly one thing, usePathname, for aria-current on the active link.
 *
 * The link order is the depositor's journey: land on home, open the vault, watch the cycle, audit
 * the tape, then read the docs and the legal text.
 *
 * One link leaves the app: stonkhouse.fun, the marketing site. It is LAST, it is deliberately
 * not part of LINKS (a plain new-tab <a> through ExternalLink, not next/link, because next/link is
 * for routes this app owns and prefetching another origin is meaningless), it is set off by a rule
 * so it does not read as a seventh route, and it is never "active".
 *
 * Exact-match active test only: /vault/nvda and /vault/nvda/cycle are separate destinations and a
 * prefix test would light both at once.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

import { ExternalLink } from "@/components/ui";
import { cn } from "@/lib/cn";
import { SITE_URL } from "@/lib/site";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/account", label: "Account" },
  { href: "/book", label: "Book" },
  { href: "/docs", label: "Docs" },
  { href: "/legal", label: "Legal" },
] as const;

/* The outline is inset (-2px offset) because the mobile row is an overflow container, which would
   clip an outline drawn outside the link. Same classes as the site's nav. */
const LINK =
  "block whitespace-nowrap rounded-[10px] px-2.5 py-2 text-[15px] font-medium no-underline transition-colors duration-150 focus-visible:outline-offset-[-2px] sm:px-3";
const IDLE = "text-ink-2 hover:bg-surface-2 hover:text-ink";
const ACTIVE = "bg-surface text-ink shadow-soft";

/** "stonkhouse.fun" in production; whatever host a preview build points at otherwise. */
const SITE_HOST = SITE_URL.replace(/^https?:\/\//i, "");

export function NavLinks() {
  const pathname = usePathname();
  return (
    <ul className="flex items-center gap-0.5 sm:gap-1">
      {LINKS.map((link) => {
        const active = pathname === link.href;
        return (
          <li key={link.href}>
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
