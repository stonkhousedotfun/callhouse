/**
 * The app's five destinations and which one is current. One list, read by two renderers: the header's
 * link row (components/NavLinks.tsx, from 1024px) and the phone tab bar (components/TabBar.tsx, below it). Keeping
 * the list and the active rule here means the two can never disagree about where the reader is.
 *
 * THE FIVE (the header and tab bar): Options, Portfolio, Vaults, Wins, Markets.
 *
 *   - Options is lit on "/", on every market page (/nvda, /nvda/<series>) except the v1 per-market account and book, and
 *     on Sell options (/sell, /sell/<ticker>): the market pages link it, it is the other side of the same trade, and
 *     it is not a vault.
 *   - Vaults stands for /vaults and its two vaults: /earn (the USDG lending vault) and /house. /lend redirects to /earn
 *     and stays listed so a reader who lands on it mid-redirect still sees Vaults lit.
 *   - Markets is the market status page, /trust/markets. /trust itself permanently redirects there
 *     and /trust/burns is the only other page under it, so the whole /trust section lights Markets:
 *     it is the nav's only door into that section, and a page with no entry lit leaves the reader lost.
 *
 * Matching is on the lowercased pathname with trailing slashes dropped, so /Wins/ and /wins are one route.
 */
export type NavEntry = { href: string; label: string };

export const V2_NAV_ENTRIES: readonly NavEntry[] = [
  { href: "/", label: "Options" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/vaults", label: "Vaults" },
  { href: "/wins", label: "Wins" },
  { href: "/trust/markets", label: "Markets" },
];

/** Extra routes an entry stands for, beyond its own href and the paths under it. */
const ALSO: Readonly<Record<string, readonly string[]>> = {
  "/vaults": ["/earn", "/lend", "/house"],
  "/trust/markets": ["/trust"],
};

/** A pathname with its trailing slash dropped and lowercased, so the match is on the route, not the spelling. */
export function normalisePath(pathname: string | null | undefined): string {
  const p = (pathname ?? "/").toLowerCase();
  return p.length > 1 ? p.replace(/\/+$/, "") || "/" : p;
}

const under = (here: string, route: string) => here === route || here.startsWith(`${route}/`);

/**
 * The href of the v2 entry that is current at `pathname`, or null when none is (a page outside the five, such as
 * /docs). `marketTickers` are the lowercase-insensitive tickers whose pages light Buy.
 */
export function activeV2Href(pathname: string | null | undefined, marketTickers: readonly string[]): string | null {
  const here = normalisePath(pathname);
  if (here === "/" || under(here, "/sell")) return "/";
  const onMarket = marketTickers.some((ticker) => {
    const prefix = `/${ticker.toLowerCase()}`;
    return under(here, prefix) && here !== `${prefix}/account` && here !== `${prefix}/book`;
  });
  if (onMarket) return "/";
  for (const entry of V2_NAV_ENTRIES) {
    if (entry.href === "/") continue;
    if ([entry.href, ...(ALSO[entry.href] ?? [])].some((route) => under(here, route))) return entry.href;
  }
  return null;
}
