/**
 * App chrome, in the Daylight layout stonkhouse.fun uses (stonkhousedotfun/callhouse-site:
 * components/Nav.tsx): brand, the link row, and on the right the one control in the chrome — here
 * the wallet button rather than "Open the app".
 *
 * Server component. The two client islands are the link list (components/NavLinks.tsx, for the
 * active link) and ConnectButton. From 960px everything is one row; below it the links drop to
 * their own full-width row under the brand and the wallet button, and scroll sideways rather than
 * wrap, so the button stays reachable without a menu and every link stays one tap away at 390px.
 * The scroll row is `relative` so the absolutely positioned sr-only note inside the new-tab link
 * (ExternalLink) is contained by it; without that it escapes to the page and scrolls a 390px screen
 * sideways.
 *
 * The brand points at "/". Inside the app, home is the product landing; the NVDA vault is
 * /vault/nvda. The link row ends with stonkhouse.fun for anyone who wants the marketing site.
 *
 * TEST HOOK: `data-slot="topbar"` on the header. The W-13 run connects its wallet through it.
 */
import { ConnectButton } from "@/components/ConnectButton";
import { NavLinks } from "@/components/NavLinks";
import { Brand, Container } from "@/components/ui";

export function Nav() {
  return (
    <header data-slot="topbar">
      <Container className="flex flex-wrap items-center gap-x-7 gap-y-2 pb-3 pt-4 lg:py-[22px]">
        <Brand className="order-1" />
        <nav
          aria-label="App"
          className="relative order-3 -mx-4 w-[calc(100%+2rem)] overflow-x-auto px-4 [scrollbar-width:none] sm:-mx-5 sm:w-[calc(100%+2.5rem)] sm:px-5 max-lg:[mask-image:linear-gradient(to_right,#000_88%,transparent)] lg:order-2 lg:mx-0 lg:mr-auto lg:w-auto lg:overflow-visible lg:px-0 lg:[mask-image:none]"
        >
          <NavLinks />
        </nav>
        <div className="order-2 ml-auto lg:order-3 lg:ml-0">
          <ConnectButton />
        </div>
      </Container>
    </header>
  );
}
