/**
 * 404 for app.callhouse.finance. Modelled on callhouse.finance's app/not-found.tsx: a way back, not
 * a content page. A lost visitor gets the three places most people come here for (the vault,
 * deposits, the weekly history) as buttons, and beside them every route this app has, so an old or
 * mistyped link still lands somewhere useful. The layout supplies the nav, footer and Container.
 *
 * Server component. No wallet code, no chain reads, no client state.
 *
 * The route list mirrors components/NavLinks.tsx (same labels, same order). If a route is added or
 * removed, change both.
 */
import type { Metadata } from "next";
import Link from "next/link";

import { Button, Chip, Panel } from "@/components/ui";

export const metadata: Metadata = {
  title: "Not found — Callhouse",
  robots: { index: false },
};

const ROUTES = [
  { href: "/", label: "Vault", what: "The vault at a glance: this week, and last week realized" },
  { href: "/vault/nvda", label: "Deposit", what: "Deposit, withdraw, and claim USDG" },
  { href: "/vault/nvda/cycle", label: "Cycle", what: "This week's call, and where to buy it" },
  { href: "/activity", label: "Activity", what: "Every week, including the zeros" },
  { href: "/docs", label: "Docs", what: "How the weekly cycle works, and what can go wrong" },
  { href: "/legal", label: "Legal", what: "Who this is for, and what the collateral actually is" },
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
          The link is old or mistyped. This app has six pages: the vault, deposits and withdrawals,
          this week&apos;s call, the history of every week, the docs and the legal text. Pick
          one, or go back to the vault.
        </p>
        <div className="mt-7 flex flex-wrap gap-2.5 sm:gap-3">
          <Button href="/">Back to the vault</Button>
          <Button variant="ghost" href="/vault/nvda">
            Deposit
          </Button>
          <Button variant="ghost" href="/activity">
            Activity
          </Button>
        </div>
      </div>

      <Panel pad="none" className="overflow-hidden">
        <nav aria-labelledby="routes-h">
          <h2 id="routes-h" className="px-[22px] pb-3 pt-5 font-display text-[17px] font-bold tracking-[-0.01em]">
            Every page in this app
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
