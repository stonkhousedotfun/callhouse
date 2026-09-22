"use client";

/**
 * The /house index: one card per market that has a house vault, linking to its page.
 *
 * It exists because `/house` is a GLOBAL route with no nav entry of its own: the nav's Vaults entry
 * opens /vaults, which links here, and `web/components/NavLinks.tsx` keeps Vaults lit on /house and
 * every route under it (its VAULT_ROUTES, the rule "VAULTS IS ONE ENTRY FOR THREE DESTINATIONS").
 * A house vault is per market (HouseVaultFactory deploys one each), so the global index branches
 * per market the way `/earn` → `/earn/[ticker]` does rather than inventing a third shape.
 *
 * NO FIGURES BEYOND THE BOUNDARY ONES. The card shows the epoch it is in and whether a vault exists.
 * It shows no NAV, no share price and no result — `HouseVault.currentEpoch` is the RUNNING epoch, so
 * every figure on it is mid-epoch and `houseRows` would return the unavailable message for all of
 * them anyway. The per-market page is where settled epochs are listed.
 */
import { GateLine, HOUSE_COPY, useLaunchGates } from "@/components/v2/LaunchCountdown";
import { Button, Notice, PageHead, Panel } from "@/components/ui";
import { HOUSE_DISCLOSURE_CAN_LOSE, HOUSE_DISCLOSURE_BOT_QUOTES } from "@/lib/v2/houseCopy";
import { formatNewYork } from "@/lib/v2/houseEpoch";
import { useHouse } from "@/lib/v2/hooks";

export function HouseOverview() {
  const house = useHouse();
  const gates = useLaunchGates();
  const items = house.isError ? [] : house.data?.items ?? [];

  return <>
    <PageHead eyebrow="House vault" title="Back the house."
      lede="The house vault quotes StonkHouse's own order book with depositor money. Deposits and withdrawals settle once a week." />
    <Notice tone="warn" className="mb-6">
      <p className="mb-2">{HOUSE_DISCLOSURE_CAN_LOSE}</p>
      <p>{HOUSE_DISCLOSURE_BOT_QUOTES}</p>
    </Notice>
    {house.isError ? <Notice tone="warn" role="status" className="mb-5" title="House vaults are unavailable.">
      The indexer could not answer. This page cannot verify vaults or epochs until data returns.
      <Button variant="ghost" size="xs" className="mt-2" onClick={() => void house.refetch()}>Try again</Button>
    </Notice> : null}
    {house.isPending && !house.data ? <Panel role="status">Loading house vaults…</Panel> : items.length ?
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{items.map((item) => <Panel key={item.market} as="article" className="flex flex-col">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-display text-2xl font-bold">{item.market}</h2>
          {/* `currentEpoch` is nullable by design (api-schema.ts, houseVaultSchema): "no epoch row
              observed for this vault yet", and the vault is still LISTED when that happens, because
              dropping it would hide a real vault behind a missing row. So the card renders either way. */}
          <span className="num text-sm text-ink-2">
            {item.currentEpoch === null ? "No epoch observed" : `Epoch ${item.currentEpoch.id}`}
          </span>
        </div>
        <p className="mt-1 text-sm text-ink-2">
          {!item.vault ? "No vault is deployed for this market yet."
            // `currentEpoch` and its `end` are both nullable by design (api-schema.ts: "no epoch row
            // observed" / "Null until observed"). Neither gets a date it does not have; coercing
            // either one would put 1970-01-01 on a vault card as though it were a fact.
            : item.currentEpoch === null ? "No epoch has been observed for this vault yet."
            : item.currentEpoch.end === null ? "This epoch's end has not been observed yet."
            : `This epoch ends ${formatNewYork(item.currentEpoch.end)}.`}
        </p>
        {item.vault ? <p className="mt-2 text-sm text-ink-2"><GateLine gate={gates.data?.house[item.market]} copy={HOUSE_COPY(item.market)} /></p> : null}
        <Button href={`/house/${item.market.toLowerCase()}`} size="sm" className="mt-5 w-full">
          {item.vault ? `Open ${item.market} house vault` : `View ${item.market}`}
        </Button>
      </Panel>)}</div> : !house.isError ? <Panel>No house vault is open yet.</Panel> : null}
  </>;
}
