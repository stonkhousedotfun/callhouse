/**
 * App chrome, Neon layout (the design's header, as in every screen
 * mockup): brand, the link row, and on the right the theme toggle, the market switcher and the wallet
 * button, over a 1px --line rule.
 *
 * Server component. The client islands are the link list (components/NavLinks.tsx, for the active link and the
 * current market), ThemeToggle, the market switcher (components/MarketSwitcher.tsx, the live markets from
 * lib/markets.ts), ConnectButton, and the phone tab bar (components/TabBar.tsx), which this renders after the header
 * so every page that has the header has the tabs.
 *
 * TWO LAYOUTS FOR THE LINKS.
 *   - v2: from 1024px the five links sit in the header row. Below 1024px the header row drops them (`data-v2`, see
 *     the class list) because the tab bar at the bottom of the screen carries the same five; a second copy scrolling
 *     sideways under the brand would be two navs for one set of doors. The market switcher is dropped below 640px
 *     too, so brand, toggle and wallet stay on one line at 390px; Buy and Markets in the tab bar lead to both markets.
 *   - v1 has no tab bar, so its links keep the full-width row under the brand below 1024px. That row scrolls sideways
 *     rather than wraps, and it is `relative` so the absolutely positioned sr-only note inside the new-tab link
 *     (ExternalLink) is contained by it; without that it escapes to the page and scrolls a 390px screen sideways.
 *
 * The brand points at "/". The closed pooled vault lives under /legacy/vault/nvda on v2.
 *
 * TEST HOOK: `data-slot="topbar"` on the header. The run connects its wallet through it.
 */
import { ConnectButton } from "@/components/ConnectButton";
import { MarketSwitcher } from "@/components/MarketSwitcher";
import { NavLinks } from "@/components/NavLinks";
import { TabBar } from "@/components/TabBar";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Brand, Container } from "@/components/ui";

export function Nav() {
  const v2 = process.env.NEXT_PUBLIC_V2 === "1";
  return (
    <>
      <header data-slot="topbar" className="border-b border-line">
        <Container className="flex flex-wrap items-center gap-x-8 gap-y-2 pb-3 pt-4 lg:py-5">
          <Brand className="order-1" />
          {/*
            THE FADE STAYS; THE HIDDEN SCROLLBAR DOES NOT. `[scrollbar-width:none]` used to sit on
            this element at every width, together with the max-lg fade — so on a phone the links
            past the fold faded out with no scrollbar, no arrow and no chevron. The suppression is
            `lg:` only, where the row does not overflow and there is nothing to hide. The gradient
            is kept: it reads as "there is more this way" once a scrollbar confirms it. On v2 the
            whole row is hidden below lg (`data-v2:max-lg:hidden`), where the tab bar carries the
            links; the scroll row is v1's.
          */}
          <nav
            aria-label="App"
            data-v2={v2 ? "" : undefined}
            className="relative order-3 -mx-4 w-[calc(100%+2rem)] overflow-x-auto px-4 data-v2:max-lg:hidden sm:-mx-5 sm:w-[calc(100%+2.5rem)] sm:px-5 max-lg:[mask-image:linear-gradient(to_right,#000_88%,transparent)] lg:order-2 lg:mx-0 lg:mr-auto lg:w-auto lg:overflow-visible lg:px-0 lg:[scrollbar-width:none] lg:[mask-image:none]"
          >
            <NavLinks />
          </nav>
          <div className="order-2 ml-auto flex items-center gap-2 lg:order-3 lg:ml-0 lg:gap-3">
            <ThemeToggle />
            <div className={v2 ? "max-sm:hidden" : undefined}>
              <MarketSwitcher />
            </div>
            <ConnectButton />
          </div>
        </Container>
      </header>
      <TabBar />
    </>
  );
}
