/**
 * App chrome, in the Daylight layout stonkhouse.fun uses (stonkhousedotfun/callhouse-site:
 * components/Nav.tsx): brand, the link row, and on the right the two controls in the chrome — the
 * market switcher and the wallet button, where the site has "Open the app".
 *
 * Server component. The three client islands are the link list (components/NavLinks.tsx, for the
 * active link and the current market), the market switcher
 * (components/MarketSwitcher.tsx, the live markets from lib/markets.ts) and ConnectButton. From
 * 960px everything is one row; below it the links drop to their own full-width row under the
 * brand and the controls, and scroll sideways rather than wrap, so the button stays reachable
 * without a menu and every link stays one tap away at 390px. The scroll row is `relative` so the
 * absolutely positioned sr-only note inside the new-tab link (ExternalLink) is contained by it;
 * without that it escapes to the page and scrolls a 390px screen sideways.
 *
 * The brand points at "/". With v2 enabled the app nav starts with Buy; v1 keeps its account and
 * book links. The closed pooled vault lives under /legacy/vault/nvda on v2.
 *
 * TEST HOOK: `data-slot="topbar"` on the header. The W-13 run connects its wallet through it.
 */
import { ConnectButton } from "@/components/ConnectButton";
import { MarketSwitcher } from "@/components/MarketSwitcher";
import { NavLinks } from "@/components/NavLinks";
import { Brand, Container } from "@/components/ui";

export function Nav() {
  return (
    <header data-slot="topbar">
      <Container className="flex flex-wrap items-center gap-x-7 gap-y-2 pb-3 pt-4 lg:py-[22px]">
        <Brand className="order-1" />
        {/*
          THE FADE STAYS; THE HIDDEN SCROLLBAR DOES NOT. `[scrollbar-width:none]` used to sit on
          this element at every width, together with the max-lg fade — so on a phone the links
          past the fold faded out with no scrollbar, no arrow and no chevron. With eight
          destinations that meant Trust and Wins were not merely hard to reach but invisible, and
          a mask that hides the fact that anything is hidden is worse than an honest scrollbar.
          The suppression is now `lg:` only, where the row does not overflow and there is nothing
          to hide. The gradient is kept: it reads as "there is more this way" once a scrollbar
          confirms it, which is the affordance the UX review asked for.
        */}
        <nav
          aria-label="App"
          className="relative order-3 -mx-4 w-[calc(100%+2rem)] overflow-x-auto px-4 sm:-mx-5 sm:w-[calc(100%+2.5rem)] sm:px-5 max-lg:[mask-image:linear-gradient(to_right,#000_88%,transparent)] lg:order-2 lg:mx-0 lg:mr-auto lg:w-auto lg:overflow-visible lg:px-0 lg:[scrollbar-width:none] lg:[mask-image:none]"
        >
          <NavLinks />
        </nav>
        <div className="order-2 ml-auto flex items-center gap-2 lg:order-3 lg:ml-0 lg:gap-3">
          <MarketSwitcher />
          <ConnectButton />
        </div>
      </Container>
    </header>
  );
}
