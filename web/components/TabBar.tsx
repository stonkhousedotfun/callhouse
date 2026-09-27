"use client";

/**
 * The phone tab bar: the app's five destinations as a
 * bar fixed to the bottom of the screen below 1024px, where the header drops its link row. From 1024px it is not
 * rendered at all (display:none), and the header's NavLinks carries the same five.
 *
 * ONE LIST. The entries and the rule for which is current come from lib/ui/navEntries.ts, the same module the
 * header reads, so the two can never light different entries for one page.
 *
 * V2 ONLY. The five exist only in v2; v1 keeps its header link row at every width and has no tab bar.
 *
 * Each tab is an icon over a label, at least 44px tall; the current one is --accent-text and carries
 * aria-current="page". The icons are decorative (aria-hidden): the label is the accessible name, and it is always
 * visible, so no aria-label is needed or wanted on the links.
 *
 * THE STICKY BUY BAR SLOT. Trade screens (market page) put a "max loss / Buy" bar directly above the tabs.
 * The slot is an empty element inside the same fixed container, so the bar and the tabs move as one and never
 * overlap; a screen fills it with <StickyBuyBar>, which portals into it and leaves an equal-height spacer in the
 * page so the last of the content is not hidden behind it. The tabs themselves are covered by the footer's spacer
 * (components/Footer.tsx).
 *
 * The bottom padding includes env(safe-area-inset-bottom), so the tabs clear the home indicator on a notched phone.
 *
 * TEST HOOKS: `data-slot` tab-bar / sticky-buy-bar.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";
import { useMounted } from "@/lib/hooks";
import { ALL_MARKETS } from "@/lib/markets";
import { V2_NAV_ENTRIES, activeV2Href } from "@/lib/ui/navEntries";

export const STICKY_BUY_BAR_ID = "sticky-buy-bar";

const ICON_PROPS = {
  "aria-hidden": true,
  width: 22,
  height: 22,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** The mockups' tab icons, keyed by href. */
const ICONS: Readonly<Record<string, ReactNode>> = {
  "/": <svg {...ICON_PROPS}><path d="M4 17l5-6 4 4 7-8" /></svg>,
  "/portfolio": <svg {...ICON_PROPS}><rect x="4" y="5" width="16" height="14" rx="3" /><path d="M4 10h16" /></svg>,
  "/vaults": <svg {...ICON_PROPS}><rect x="4" y="4" width="16" height="16" rx="3" /><circle cx="12" cy="12" r="3" /></svg>,
  "/wins": <svg {...ICON_PROPS}><path d="M8 4h8v5a4 4 0 0 1-8 0Z" /><path d="M12 13v4M8 20h8" /></svg>,
  "/trust/markets": <svg {...ICON_PROPS}><path d="M4 20V10M10 20V4M16 20v-8M22 20H2" /></svg>,
};

/** Presentational half: renders for a given pathname, so it is testable without a router. */
export function TabBarView({ pathname }: { pathname: string | null }) {
  const current = activeV2Href(pathname, ALL_MARKETS.map((market) => market.ticker));
  return (
    <div
      data-slot="tab-bar"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-ground pb-[max(env(safe-area-inset-bottom),8px)] lg:hidden"
    >
      <div id={STICKY_BUY_BAR_ID} data-slot="sticky-buy-bar" />
      <nav aria-label="Tabs">
        <ul className="grid grid-cols-5 px-2 pt-1.5">
          {V2_NAV_ENTRIES.map((entry) => {
            const active = entry.href === current;
            return (
              <li key={entry.href}>
                <Link
                  href={entry.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-11 flex-col items-center justify-center gap-1 rounded-[10px] py-1.5 text-[11px] font-bold no-underline focus-visible:outline-offset-[-2px]",
                    active ? "text-accent-text" : "text-ink-3 hover:text-ink",
                  )}
                >
                  {ICONS[entry.href]}
                  {entry.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

export function TabBar() {
  const pathname = usePathname();
  if (process.env.NEXT_PUBLIC_V2 !== "1") return null;
  return <TabBarView pathname={pathname} />;
}

/**
 * Put `children` in the sticky buy bar slot above the tabs, below 1024px. Renders an in-flow spacer of `height`
 * pixels where it is used, so the page can scroll its last content clear of the bar. Nothing renders on the server
 * or before mount (the slot is a client-side target), and nothing from 1024px, where the order ticket sits in the
 * rail instead.
 */
export function StickyBuyBar({ children, height = 72 }: { children: ReactNode; height?: number }) {
  // false on the server and during hydration, so the first client render matches the server's (no portal). The slot
  // is looked up only after mount: the TabBar (components/Nav.tsx) that renders it is already in the document by then.
  const mounted = useMounted();
  const slot = mounted ? document.getElementById(STICKY_BUY_BAR_ID) : null;
  return (
    <>
      <div aria-hidden="true" className="lg:hidden" style={{ height }} />
      {slot ? createPortal(<div className="border-b border-line px-4 py-3 sm:px-5">{children}</div>, slot) : null}
    </>
  );
}
