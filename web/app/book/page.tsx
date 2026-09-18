import { permanentRedirect, redirect } from "next/navigation";

import { DEFAULT_MARKET, marketHref } from "@/lib/markets";
import { legacyDefaultPath } from "@/app/legacy/routes";

/**
 * /book is the pre-registry address of the default market's book. It now lives at /<ticker>/book
 * (app/[ticker]/book/page.tsx); a temporary redirect keeps the old links (and the retired pooled
 * cycle page's redirect, app/vault/nvda/cycle) working. See app/account/page.tsx.
 */
export default function BookRedirect() {
  if (process.env.NEXT_PUBLIC_V2 === "1") permanentRedirect(legacyDefaultPath("book"));
  redirect(marketHref(DEFAULT_MARKET.ticker, "book"));
}
