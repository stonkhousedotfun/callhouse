import { permanentRedirect, redirect } from "next/navigation";

import { DEFAULT_MARKET, marketHref } from "@/lib/markets";
import { legacyDefaultPath } from "@/app/legacy/routes";

/**
 * /account is the pre-registry address of the default market's account page. It now lives at
 * /<ticker>/account (app/[ticker]/account/page.tsx); this route sends the old links there with a
 * temporary redirect (307, what `redirect` issues from a server component), temporary because the
 * default market is a choice in lib/markets.ts (DEFAULT_MARKET, which moves to the first live
 * market if the default is paused in the registry), not a permanent fact about the URL.
 */
export default function AccountRedirect() {
  if (process.env.NEXT_PUBLIC_V2 === "1") permanentRedirect(legacyDefaultPath("account"));
  redirect(marketHref(DEFAULT_MARKET.ticker, "account"));
}
