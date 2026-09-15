"use client";

import { useQuery } from "@tanstack/react-query";
import type { Hex } from "viem";

import { Card, CardHead, CardMeta, CardTitle, Notice, Row, Rows, Unit } from "@/components/ui";
import { fetchKeeperOrderBook } from "@/lib/api";
import { VAULT } from "@/lib/contracts";
import { keeperPricingFigures, type ReportedTime } from "@/lib/cycleTerms";
import type { ListingRow } from "@/lib/listing";

import {
  askWords,
  chainTimeLabel,
  fairValueLabel,
  modeWords,
  pricingSourceNote,
  unavailableWords,
  type CyclePricingFeed,
} from "./CyclePricingWords";

export type { CyclePricingFeed } from "./CyclePricingWords";

/**
 * The order feed (app/api/keeper/orders), under one query key for every page that reads it, so
 * the home page and the cycle page share a cache entry for the same vault and listing hash. The
 * caller decides when it is worth asking (lib/cycleNotices.ts shouldAskFeed on the cycle page).
 */
export function useKeeperOrderBook(listingHash: Hex | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["keeper-orders", VAULT ?? "none", listingHash ?? "none"],
    enabled,
    refetchInterval: 30_000,
    queryFn: fetchKeeperOrderBook,
  });
}

/**
 * "How the keeper priced this week": the keeper's pricing report for the vault's live order, as
 * lib/cycleTerms.ts keeperPricingFigures parses it from the checked feed row.
 *
 * WHAT THIS IS NOT. Nothing here is read from the chain or can be checked against it: the delta,
 * the implied volatility and the market fair value come from the keeper's delayed market data
 * (Cboe's delayed quotes when the report's source is "cboe-delayed", and only then named so) as
 * the keeper saw them. The vault enforces only its premium floor and its strike band, so the card
 * says that, and when the report's strike or ask differs from the vault's own figures it says the
 * vault's figures are the ones that count. Implied volatility is printed as a decimal, never a percentage.
 * A missing or unreadable report is one muted line, not an error: the order is fillable without it.
 * The line says why there is none (the order is finished, the feed could not be read or is not
 * serving the order, or the report itself did not parse), because "no report yet" on a sold-out
 * week reads as if no order existed.
 *
 * The sentences that depend on the report (mode, what set the ask, the source note, the reason
 * market data was not usable) live in components/CyclePricingWords.ts, which never echoes keeper
 * free text and names Cboe only when the report's source is Cboe's.
 *
 * TEST HOOKS: `data-slot` cycle-pricing (the rows' wrapper), pricing-note, pricing-mismatch and
 * pricing-unavailable. Rows are found by their label like every other ledger row.
 */
export type CyclePricingProps = {
  /** The checked feed row for the vault's listingHash, when the feed served one. */
  listing: ListingRow | undefined;
  /** Why there is no row, when there is none. Ignored while `listing` is set. */
  feed: CyclePricingFeed;
  /** The vault's cycleStrikeUsdg and its listing's unit price, to flag a report that disagrees. */
  vaultStrike6: bigint | undefined;
  vaultUnitPrice6: bigint | undefined;
};

const MUTED_LINE = "rounded-md bg-surface-2 px-4 py-3.5 text-[14.5px] leading-[1.55] text-ink-2";
const NOTE = "mt-4 border-t border-line pt-4 text-[12.5px] leading-[1.55] text-ink-3";

function usdg(fmt: string) {
  return (
    <>
      {fmt} <Unit>USDG</Unit>
    </>
  );
}

function when(t: ReportedTime) {
  return t.ts === undefined ? (
    <>
      {t.raw} <Unit>as reported, zone unknown</Unit>
    </>
  ) : (
    <>
      <span className="whitespace-nowrap">{t.utc}</span> · <span className="whitespace-nowrap">{t.eastern}</span>
    </>
  );
}

export function CyclePricing({ listing, feed, vaultStrike6, vaultUnitPrice6 }: CyclePricingProps) {
  const f = listing === undefined ? null : keeperPricingFigures(listing.pricing);
  const disagrees =
    f !== null &&
    ((vaultStrike6 !== undefined && vaultStrike6 !== f.strikeUsdg6) ||
      (vaultUnitPrice6 !== undefined && vaultUnitPrice6 !== f.unitPrice6));

  return (
    <Card className="@container">
      <CardHead>
        <CardTitle>How the keeper priced this week</CardTitle>
        {f !== null ? <CardMeta>keeper-reported</CardMeta> : null}
      </CardHead>

      {f === null ? (
        <p data-slot="pricing-unavailable" className={MUTED_LINE}>
          {unavailableWords(listing !== undefined, feed)}
        </p>
      ) : (
        <>
          {disagrees ? (
            <Notice tone="warn" className="mb-4" title="This report does not match the vault's order.">
              <span data-slot="pricing-mismatch">
                The strike or price the keeper reports differs from the vault&apos;s own figures. The vault&apos;s figures
                are what a buyer pays; this report is out of date or wrong.
              </span>
            </Notice>
          ) : null}

          <div data-slot="cycle-pricing" className="min-w-0">
            <Rows>
              <Row k="Pricing mode" mono={false} v={modeWords(f)} />
              <Row k="What set the ask" mono={false} v={askWords(f)} />
              {f.mode === "vol" ? <Row k="Target delta" v={f.targetDeltaFmt} /> : null}
              {f.deltaAtStrike !== undefined ? <Row k="Delta at the strike" v={f.deltaAtStrikeFmt} /> : null}
              {f.ivAtStrike !== undefined ? <Row k="Implied volatility at the strike" v={f.ivAtStrikeFmt} /> : null}
              <Row k="Strike" v={usdg(f.strikeFmt)} />
              {f.strikeClamped !== null ? (
                <Row
                  k="Delta strike before the band clamp"
                  v={
                    <>
                      {f.deltaStrikeFmt} <Unit>USDG</Unit>{" "}
                      <Unit>
                        · moved {f.strikeClamped === "band-floor" ? "up to the vault's band floor" : "down to the vault's band ceiling"}
                      </Unit>
                    </>
                  }
                />
              ) : null}
              <Row k="Spot used" v={usdg(f.spotFmt)} />
              {f.fairUnit6 !== undefined ? <Row k={fairValueLabel(f)} v={usdg(f.fairUnitFmt)} /> : null}
              {f.volUnit6 !== undefined ? <Row k="Fair value plus the keeper's edge" v={usdg(f.volUnitFmt)} /> : null}
              <Row k="Vault floor per contract" v={usdg(f.floorUnitFmt)} />
              <Row k="Vault floor plus the keeper's margin" v={usdg(f.marginUnitFmt)} />
              <Row k="Ask per contract" v={usdg(f.unitPriceFmt)} />
              {f.expiryDate !== undefined ? <Row k="Option expiry priced against" v={f.expiryDate} /> : null}
              {f.chainTime !== undefined ? <Row k={chainTimeLabel(f)} v={when(f.chainTime)} /> : null}
              {f.lastTradeTime !== undefined ? <Row k="Last trade" v={when(f.lastTradeTime)} /> : null}
            </Rows>
          </div>

          <p data-slot="pricing-note" className={NOTE}>
            Reported by the keeper with its order, not read from the chain, and shown for information only.
            {` ${pricingSourceNote(f)} `}
            The vault itself enforces only its premium floor and its strike band: it refuses a strike outside the band
            and a price below the floor, whatever this report says.
          </p>
        </>
      )}
    </Card>
  );
}
