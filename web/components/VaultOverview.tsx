"use client";

/**
 * Live vault glance: collateral, this week's terms, and the sale window. Lives on /vault/nvda,
 * not on `/` — the app home is the product landing, this is the vault.
 *
 * Test hooks: `data-slot="this-week"`, `data-slot="strike-expiry"`, `data-slot="this-week-fill-note"`.
 */
import Link from "next/link";

import { useKeeperOrderBook } from "@/components/CyclePricing";
import { CycleTapeInline } from "@/components/CycleTape";
import { GuardBadges, VaultPhaseBadge } from "@/components/PhaseBadge";
import { PositionSplit } from "@/components/PositionSplit";
import { Card, CardHead, CardTitle, Row, Rows, Stat, Unit } from "@/components/ui";
import { MARKET, MAX_LISTINGS_PER_CYCLE, SHARE_TICKER, VAULT } from "@/lib/contracts";
import { hasOnChainListing, shouldAskFeed, windowClosed, type CycleListingState } from "@/lib/cycleNotices";
import { CYCLE_TERMS_LABELS, cycleTerms } from "@/lib/cycleTerms";
import { WAD, fmtAsset, fmtCountdown, fmtUsdg, multiplierIsActive, shortHash, toNvdaEq, tvlUsdg } from "@/lib/format";
import { collateralSplit, useNow, useOrderStatus, useVaultSnapshot } from "@/lib/hooks";
import { fillableForTerms } from "@/lib/orderFillable";

export function VaultOverview() {
  const { data: v } = useVaultSnapshot();
  const nowSeconds = useNow();

  // Share price is collateral only, in raw 18-decimal units. Premium is not folded into it:
  // USDG accrues per share and is claimed separately (see UsdgClaim).
  const pps =
    v.totalAssets !== undefined && v.totalSupply !== undefined && v.totalSupply > 0n
      ? (v.totalAssets * WAD) / v.totalSupply
      : undefined;

  const tvl = tvlUsdg(v.totalAssets, v.spotUsdg);

  // Locked collateral is "sold": under write on fill every contract the vault has written was
  // bought in the same transaction, so there is no unsold inventory to draw.
  const split = collateralSplit(v);

  // THIS WEEK'S TERMS (lib/cycleTerms.ts), null while nothing is armed. The order figures exist only
  // while the vault is Listed with a live listing hash and the sale window open. Contracts left to
  // buy is Seaport's count for the vault's hash, read here with the same getOrderStatus call the
  // cycle page makes; while that has no answer, the checked feed row's `remaining` for the hash
  // (app/api/keeper/orders computes it from its own getOrderStatus read), or 0 when the route
  // reports that hash sold out, cancelled or expired. With neither, lib/orderFillable.ts gives no
  // count and the three order rows show "—" with a note: never the whole listing, which overstates
  // what is left after any fill. The feed query shares the cycle page's cache key
  // (components/CyclePricing.tsx useKeeperOrderBook).
  const baseListingState: CycleListingState = {
    vaultConfigured: VAULT !== undefined,
    phase: v.phase,
    listingHash: v.listingHash,
    listingAmount: v.listingAmount,
    seaportStatus: undefined,
    cycleExerciseTs: v.cycleExerciseTs,
    nowSeconds,
  };
  const liveListing = hasOnChainListing(baseListingState);
  const orderOpen = v.phase === 1 && liveListing && nowSeconds > 0 && !windowClosed(baseListingState);
  const { data: orderStatus, isLoading: orderStatusLoading } = useOrderStatus(orderOpen ? v.listingHash : undefined);
  // useOrderStatus fills every field or none.
  const seaportStatus =
    orderStatus?.isCancelled !== undefined && orderStatus.totalFilled !== undefined && orderStatus.totalSize !== undefined
      ? { isCancelled: orderStatus.isCancelled, totalFilled: orderStatus.totalFilled, totalSize: orderStatus.totalSize }
      : undefined;
  const listingState: CycleListingState = { ...baseListingState, seaportStatus };
  const askFeed = orderOpen && shouldAskFeed(listingState);
  const feed = useKeeperOrderBook(v.listingHash, askFeed);
  const feedBook = askFeed ? feed.data : undefined;
  const fillable = orderOpen
    ? fillableForTerms({
        phase: v.phase,
        listingHash: v.listingHash,
        listingAmount: v.listingAmount,
        windowClosed: false,
        seaportStatus,
        rows: feedBook?.listings,
        closed: feedBook?.closed,
      })
    : undefined;
  const fillableUnread = orderOpen && fillable === undefined && !orderStatusLoading && !(askFeed && feed.isLoading);
  const terms = cycleTerms(v, { fillableContracts: fillable?.contracts });

  return (
    <Card lift className="grid gap-6">
          <CardHead className="mb-0!">
            <CardTitle className="text-[22px]!">
              {SHARE_TICKER} vault
              {v.symbol && v.symbol !== SHARE_TICKER ? ` · on-chain symbol ${v.symbol}` : ""}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-1.5">
              <VaultPhaseBadge snapshot={v} nowSeconds={nowSeconds} />
              <GuardBadges snapshot={v} />
            </div>
          </CardHead>

          <div className="grid grid-cols-1 gap-3 min-[680px]:grid-cols-3">
            <Stat
              className="rounded-md bg-surface-2 p-4 sm:p-5"
              label="Collateral"
              value={fmtAsset(v.totalAssets)}
              unit={MARKET}
              sub={tvl === undefined ? "spot unavailable" : `${fmtUsdg(tvl)} USDG at feed spot`}
            />
            <Stat
              className="rounded-md bg-surface-2 p-4 sm:p-5"
              label="Shares"
              value={fmtAsset(v.totalSupply)}
              unit={SHARE_TICKER}
              sub={pps === undefined ? "—" : `${fmtAsset(pps, 6)} ${MARKET} per share`}
            />
            <Stat
              className="rounded-md bg-surface-2 p-4 sm:p-5"
              label="This week's strike"
              value={
                terms !== null
                  ? terms.strikeFmt
                  : v.cycleStrikeUsdg && v.cycleStrikeUsdg > 0n && v.phase !== 0
                    ? fmtUsdg(v.cycleStrikeUsdg)
                    : "—"
              }
              unit="USDG"
              sub={
                v.phase === undefined ? (
                  "—"
                ) : v.phase === 0 ? (
                  "nothing armed this cycle"
                ) : (
                  <>
                    <span className="block">
                      {`${(v.contractsWritten ?? 0n).toString()} calls sold this week${
                        v.capacity !== undefined && v.phase === 1 ? ` · capacity for ${v.capacity.toString()} more` : ""
                      }`}
                    </span>
                    {terms !== null ? (
                      <span data-slot="strike-expiry" className="block">
                        {CYCLE_TERMS_LABELS.expiry} {terms.expiryEastern}
                      </span>
                    ) : null}
                  </>
                )
              }
            />
          </div>

          <div>
            <PositionSplit idle={split.idle} sold={split.sold} assigned={split.assigned} />
            <p className="mt-3 max-w-[60em] text-[12.5px] leading-[1.55] text-ink-3">
              Every contract the vault has written was sold in the same transaction that wrote it, so there is no unsold
              inventory: the vault can only ever be assigned on what it was paid for.
            </p>

            {multiplierIsActive(v.uiMultiplier) ? (
              <div className="mt-2 max-w-[60em] text-[12.5px] leading-[1.55] text-ink-3">
                The Stock Token reports a uiMultiplier other than 1.0. Display-only {MARKET}-eq of the
                collateral: <span className="num text-ink-2">{fmtAsset(toNvdaEq(v.totalAssets, v.uiMultiplier))}</span>. Share maths uses the
                raw balance above.
              </div>
            ) : null}
          </div>

          <div className="min-w-0 border-t border-line pt-6" data-slot="this-week">
              <h3 className="mb-1.5 text-base font-bold tracking-[-0.01em]">
                This week
              </h3>
              <Rows>
                <Row k="Vault cycle" v={<>#{v.cycleNumber ?? "—"}</>} />
                {terms !== null ? (
                  <>
                    <Row
                      k={CYCLE_TERMS_LABELS.strike}
                      v={
                        <>
                          {terms.strikeFmt} <Unit>USDG</Unit>
                        </>
                      }
                    />
                    <Row
                      title="The option's exercise time, snapshotted by the vault when the cycle was armed: the week's NYSE close. The vault refuses every fill from this moment."
                      k={CYCLE_TERMS_LABELS.exercise}
                      v={
                        <>
                          <span className="whitespace-nowrap">{terms.exerciseUtc}</span> ·{" "}
                          <span className="whitespace-nowrap">{terms.exerciseEastern}</span>
                        </>
                      }
                    />
                    <Row
                      title="The option's expiry, 24 hours after the exercise time, from the vault's snapshot."
                      k={CYCLE_TERMS_LABELS.expiry}
                      v={
                        <>
                          <span className="whitespace-nowrap">{terms.expiryUtc}</span> ·{" "}
                          <span className="whitespace-nowrap">{terms.expiryEastern}</span>
                        </>
                      }
                    />
                    {liveListing && terms.unitPrice6 !== undefined ? (
                      <Row
                        k={CYCLE_TERMS_LABELS.unitPrice}
                        v={
                          <>
                            {terms.unitPriceFmt} <Unit>USDG</Unit>
                          </>
                        }
                      />
                    ) : null}
                    {orderOpen ? (
                      <>
                        <Row k={CYCLE_TERMS_LABELS.fillableContracts} v={terms.fillableContractsFmt} />
                        <Row
                          title="Price per contract times contracts left to buy: the order as it stands. If nobody buys, the vault receives nothing."
                          k={CYCLE_TERMS_LABELS.orderGrossIfAllFill}
                          v={
                            terms.orderGrossIfAllFill6 === undefined ? (
                              "—"
                            ) : (
                              <>
                                {terms.orderGrossIfAllFillFmt} <Unit>USDG</Unit>
                              </>
                            )
                          }
                        />
                        <Row
                          title="policy().protocolFeeBps of that total, rounded down as the vault rounds it. The vault charges the fee once, at harvest, on the week's whole premium."
                          k={CYCLE_TERMS_LABELS.orderFeeIfAllFill}
                          v={
                            terms.orderFeeIfAllFill6 === undefined ? (
                              "—"
                            ) : (
                              <>
                                {terms.orderFeeIfAllFillFmt} <Unit>USDG</Unit>
                              </>
                            )
                          }
                        />
                      </>
                    ) : null}
                  </>
                ) : null}
                <Row
                  k="Order hash"
                  v={
                    v.listingHash === undefined
                      ? "—"
                      : /^0x0+$/.test(v.listingHash)
                        ? "no live listing"
                        : (
                            <Link href="/vault/nvda/cycle" className="link text-accent-text">{shortHash(v.listingHash)}</Link>
                          )
                  }
                />
                <Row
                  k="Listings authorised"
                  v={
                    <>
                      {v.listingsThisCycle === undefined ? "—" : v.listingsThisCycle} / {MAX_LISTINGS_PER_CYCLE}
                    </>
                  }
                />
                {terms !== null ? (
                  <>
                    <Row
                      k="Until the exercise deadline"
                      v={nowSeconds === 0 ? "—" : fmtCountdown(terms.exerciseTs, nowSeconds)}
                    />
                    <Row k="Until expiry" v={nowSeconds === 0 ? "—" : fmtCountdown(terms.expiryTs, nowSeconds)} />
                  </>
                ) : (
                  <CycleTapeInline snapshot={v} />
                )}
              </Rows>
              {fillableUnread ? (
                <p data-slot="this-week-fill-note" className="mt-2 text-[12.5px] leading-[1.55] text-ink-3">
                  Seaport&apos;s fill count for this order could not be read, and the order feed did not give one, so
                  contracts left to buy and the two figures after it are not shown.{" "}
                  <Link href="/vault/nvda/cycle" className="link">The cycle page</Link> has the order itself.
                </p>
              ) : null}
          </div>

          <div className="flex flex-wrap gap-3 border-t border-line pt-6">
            <Link href="/vault/nvda/cycle" className="link font-semibold text-accent-text">
              This week&apos;s call · buy it
              <span aria-hidden="true"> →</span>
            </Link>
          </div>
        </Card>
  );
}
