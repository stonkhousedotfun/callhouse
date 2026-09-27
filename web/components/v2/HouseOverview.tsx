"use client";

/**
 * The /house index: one card per market that has a house vault, linking to its page.
 *
 * It exists because `/house` is a GLOBAL route with no nav entry of its own: the nav's Vaults entry
 * opens /vaults, which links here, and `web/components/NavLinks.tsx` keeps Vaults lit on /house and
 * every route under it (its VAULT_ROUTES, the rule "VAULTS IS ONE ENTRY FOR THREE DESTINATIONS").
 * A house vault is per market (HouseVaultFactory deploys one each), so the global index branches
 * per market the way `/sell` → `/sell/[ticker]` does rather than inventing a third shape.
 *
 * NO FIGURES BEYOND THE BOUNDARY ONES. The card shows the epoch it is in and whether a vault exists,
 * and the vault's MARK per share and TVL read from chain -- `nav()`
 * struck at the LAST BOUNDARY, labelled as such, never a live price -- and its cadence. No result and
 * no rate. The per-market page is where settled epochs are listed.
 *
 * NEON: cards in the Neon type scale with a pill cadence badge. While a
 * vault is not quoting yet its card says so in one static line, read from THAT vault's own `protocolAccountsConfirmed`
 * There is no countdown: the zero-delay redeploy arms the launch vaults inside the deploy window, and the
 * old per-MARKET gate line gave a daily and a weekly vault of one market the same arming state.
 *
 * Once a daily vault is listed, daily vaults come first and each weekly card says
 * it is winding down, with the boundary to withdraw at (lib/v2/houseWindDown.ts). A market can then carry two vaults,
 * so a card is keyed by its vault, not its market.
 */
import { EarliestWithdrawalLine } from "@/components/v2/EarliestWithdrawal";
import { TIP_CONTAIN } from "@/components/v2/house/tipContain";
import { HOUSE_ARMING_UNREAD } from "@/components/v2/LaunchCountdown";
import { Button, Chip, InfoTip, Notice, PageHead, Panel, TickerLogo } from "@/components/ui";
import { cn } from "@/lib/cn";
import { fmtUsdg } from "@/lib/format";
import { HOUSE_DISCLOSURE_CAN_LOSE, HOUSE_DISCLOSURE_BOT_QUOTES, houseCadenceBadge, houseExitLine } from "@/lib/v2/houseCopy";
import type { HouseVaultKind } from "@/lib/v2/api-types";
import type { Address } from "viem";

import { useHouse, useHouseVaultReads } from "@/lib/v2/hooks";
import { markPerShare } from "@/lib/v2/houseEpoch";
import { VAULT_MARK_LABEL_UNDATED } from "@/lib/v2/vaultCopy";
import { NOT_READ } from "@/components/v2/VaultHero";
import { dailyFirst, houseWindDownHeadline, houseWindingDown } from "@/lib/v2/houseWindDown";
import { houseVaultHref } from "@/lib/v2/houseVaultSelect";
import { getV2Market } from "@/lib/markets";
import { dailyOffered } from "@/lib/v2/presets";
import { Time } from "@/components/ui/Time";
// The one clamped usdgText. This file's private copy fixed minimumFractionDigits at 2, the same
// latent RangeError that crashed the House pages through houseRows for any caller below 2 places.

function CardFigure({ label, value, read }: { label: string; value: string; read: boolean }) {
  return <div className="min-w-0 px-3.5 py-3">
    <dt className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-3">{label}
      <InfoTip label={`About ${label.toLowerCase()}`} align="start" text={VAULT_MARK_LABEL_UNDATED} /></dt>
    <dd className={cn("mt-1 [overflow-wrap:anywhere]", read ? "num text-[19px] font-semibold leading-tight text-ink" : "text-[15px] font-semibold text-ink-3")}>{value}</dd>
    {read ? <dd className="mt-0.5 text-[12px] text-ink-3">Last close</dd> : null}
  </div>;
}

/**
 * One card's chain figures. A failed read is "not read"; before the first boundary nav() reverts and reads null too.
 * The cadence badge and the exit line come from the /v2/house `kind` (the vault's factory), not from a chain
 * read: an unknown kind is labelled unknown, never defaulted to weekly.
 */
export function HouseCardFigures({ vault, kind, market }: { vault: string; kind?: HouseVaultKind; market?: string }) {
  const reads = useHouseVaultReads(vault as Address);
  const r = reads.data;
  const perShare = r ? markPerShare(r.nav, r.totalSupply) : null;
  // SPCX lists no dailies, so its daily vault's card says "Daily, Fridays only". No market: default.
  const listsDailies = dailyOffered(getV2Market(market)?.v2.overrides);
  const total = r?.nav ?? null;
  return <div className="grid gap-4 text-sm text-ink-2" data-figures="house-card">
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <p className="flex items-center gap-1.5">
        <Chip className="border border-line-2">{houseCadenceBadge(kind, listsDailies)}</Chip>
        <InfoTip label="When withdrawals are paid" align="start" text={houseExitLine(kind, listsDailies)} />
      </p>
      <HouseCardQuoting armed={reads.isError ? null : r?.protocolAccountsConfirmed} market={market} />
    </div>
    {/* through rules (no zero tail; a large total is compact), not houseRows.usdgText. */}
    <dl className="grid grid-cols-2 rounded-md border border-line bg-field [&>div+div]:border-l [&>div+div]:border-line">
      <CardFigure label="Value per share" read={perShare !== null} value={perShare === null ? NOT_READ : `${fmtUsdg(perShare, 4)} USDG`} />
      <CardFigure label="Vault total" read={total !== null} value={total === null ? NOT_READ : `${fmtUsdg(total)} USDG`} />
    </dl>
  </div>;
}

/**
 * Whether THIS vault quotes, from its own `protocolAccountsConfirmed` read. Static copy, no clock. Nothing
 * while the read is in flight; a failed read says so and never reads as quoting.
 */
export function HouseCardQuoting({ armed, market }: { armed: boolean | null | undefined; market?: string }) {
  if (armed === undefined) return null;
  const subject = market ? `The ${market} house vault` : "This house vault";
  return <p className="flex items-start gap-2 text-[13px] leading-snug" data-slot="house-quoting" data-armed={armed === null ? "unread" : String(armed)}>
    <span aria-hidden="true" className={cn("mt-[5px] size-2 shrink-0 rounded-full", armed === true ? "bg-accent" : "bg-warn")} />
    <span>{armed === true ? `${subject} is quoting.` : armed === false ? `${subject} is not quoting yet. Deposits open when it is.` : HOUSE_ARMING_UNREAD}</span>
  </p>;
}

export function HouseOverview() {
  const house = useHouse();
  const items = dailyFirst(house.isError ? [] : house.data?.items ?? []);
  const kinds = items.map((item) => item.kind);

  return <div className={`relative min-w-0 ${TIP_CONTAIN}`}>
    <PageHead eyebrow="House vault" title="Back the house."
      lede="Our bot trades options with the pool's money. Withdrawals are paid at the close: once a day, or once a week for a weekly vault."
      aside={<Notice tone="warn" className="w-fit">
        <p className="flex items-center gap-2 font-semibold text-ink">You can lose money.
          <InfoTip label="About the risks" align="end" text={`${HOUSE_DISCLOSURE_CAN_LOSE} ${HOUSE_DISCLOSURE_BOT_QUOTES}`} />
        </p>
      </Notice>} />
    {house.isError ? <Notice tone="warn" role="status" className="mb-5" title="House vaults are unavailable.">
      We couldn&apos;t load the vaults.
      <Button variant="ghost" size="xs" className="mt-2" onClick={() => void house.refetch()}>Try again</Button>
    </Notice> : null}
    {house.isPending && !house.data ? <Panel role="status">Loading house vaults…</Panel> : items.length ?
      <div className="grid gap-5 md:grid-cols-2">{items.map((item) => <Panel key={item.vault ?? item.market} as="article" className="flex flex-col gap-5">
        <div className="flex items-center gap-3.5">
          <TickerLogo ticker={item.market} className="text-[36px]" />
          <div className="min-w-0">
            <h2 className="font-display text-[22px] font-extrabold leading-tight tracking-[-0.02em]">{item.market}</h2>
            {/* `currentEpoch` is nullable by design (api-schema.ts, houseVaultSchema): "no epoch row
                observed for this vault yet", and the vault is still LISTED when that happens, because
                dropping it would hide a real vault behind a missing row. So the card renders either way.
                `currentEpoch` and its `end` are both nullable by design (api-schema.ts: "no epoch row
                observed" / "Null until observed"). Neither gets a date it does not have; coercing
                either one would put 1970-01-01 on a vault card as though it were a fact.
                No "epoch" in visible copy; the round number meant nothing to a depositor, so it is not shown. */}
            <p className="mt-0.5 text-[13px] text-ink-3">
              {!item.vault ? "No vault is deployed for this market yet."
                : item.currentEpoch === null ? "Not started yet."
                : item.currentEpoch.end === null ? "The next close is not known yet."
                : <>Next close: <Time at={item.currentEpoch.end} market />.</>}
            </p>
          </div>
        </div>
        {item.vault && houseWindingDown(item.kind, kinds)
          ? <p className="-mt-1 rounded-md bg-warn-soft px-3.5 py-2.5 text-[13px] font-semibold text-ink" data-slot="house-wind-down">{houseWindDownHeadline(item.currentEpoch?.end ?? null)}</p>
          : null}
        {item.vault ? <HouseCardFigures vault={item.vault} kind={item.kind} market={item.market} /> : null}
        {item.vault ? <EarliestWithdrawalLine className="-mt-1" value={item.earliestWithdrawal} surface="house" /> : null}
        {/* Each card opens its own vault. Two NVDA cards (weekly and daily) link to two different pages. */}
        <Button href={item.vault ? houseVaultHref(item.market, item.vault) : `/house/${item.market.toLowerCase()}`} className="mt-auto w-full">
          {item.vault ? `Open ${item.market} house vault` : `View ${item.market}`}
        </Button>
      </Panel>)}</div> : !house.isError ? <Panel>No house vault is open yet.</Panel> : null}
  </div>;
}
