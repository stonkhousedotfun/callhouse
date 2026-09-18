import type { Metadata } from "next";

import { MigrationGuide } from "@/components/legacy/MigrationGuide";
import { Button, Notice, PageHead, Panel } from "@/components/ui";
import { LEGACY_MARKETS } from "@/lib/legacy";
import { legacyMarketPath } from "./routes";

export const metadata: Metadata = {
  title: "Legacy v1 — StonkHouse",
  robots: { index: false, follow: true },
};

export default function LegacyPage() {
  return (
    <>
      <PageHead
        eyebrow="Legacy v1"
        title="Move from your v1 account."
        lede="Your old account stays available for settlement and withdrawal. New listings use the v2 marketplace."
        aside={<Button href="/">Explore v2</Button>}
      />
      <Notice tone="info" className="mb-5">
        The steps below read your v1 account on chain. Wait for any active week to expire, then settle, claim USDG,
        withdraw idle Stock Tokens, and choose a new v2 writer setup. Each transaction stays in your wallet.
      </Notice>
      <MigrationGuide />
      <div className="grid gap-4 sm:grid-cols-2">
        <Panel>
          <h2 className="font-display text-xl font-bold">Your v1 account</h2>
          <p className="mt-2 text-ink-2">Review balances, settle an expired listing, claim USDG, and withdraw idle assets.</p>
          <div className="mt-5 flex flex-wrap gap-2">
            {LEGACY_MARKETS.map((market) => (
              <Button key={market.ticker} href={legacyMarketPath(market.ticker, "account")} variant="ghost" size="sm">
                {market.ticker} account
              </Button>
            ))}
          </div>
        </Panel>
        <Panel>
          <h2 className="font-display text-xl font-bold">Your v1 calls</h2>
          <p className="mt-2 text-ink-2">Existing calls and exercise controls remain in the v1 book.</p>
          <div className="mt-5 flex flex-wrap gap-2">
            {LEGACY_MARKETS.map((market) => (
              <Button key={market.ticker} href={legacyMarketPath(market.ticker, "book")} variant="ghost" size="sm">
                {market.ticker} book
              </Button>
            ))}
          </div>
        </Panel>
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        <Button href="/legacy/collect" variant="ghost" size="sm">Collect from the closed vault</Button>
        <Button href="/legacy/activity" variant="ghost" size="sm">Vault activity</Button>
      </div>
    </>
  );
}
