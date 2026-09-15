"use client";

/**
 * The landing page: the vault's live state next to the last closed week.
 *
 * What is deliberately NOT here is any forward-looking number. Everything shown is either the
 * current on-chain state or a realized figure from a week that has already closed, labelled
 * "Last week realized". No week is ever scaled up to a longer period — the wording rules in
 * scripts/copy-lint.mjs exist to keep it that way.
 */
import Link from "next/link";

import { CycleTapeInline } from "@/components/CycleTape";
import { GuardBadges, VaultPhaseBadge } from "@/components/PhaseBadge";
import { PositionSplit } from "@/components/PositionSplit";
import { StrandedBanner } from "@/components/StrandedBanner";
import {
  Button,
  Card,
  CardHead,
  CardTitle,
  ExternalLink,
  Notice,
  PageHead,
  Row,
  Rows,
  Stat,
  WarnIcon,
} from "@/components/ui";
import { addressUrl } from "@/lib/chain";
import { MARKET, MAX_LISTINGS_PER_CYCLE, SHARE_TICKER, VAULT } from "@/lib/contracts";
import {
  WAD,
  fmtAsset,
  fmtRealizedWeek,
  fmtUsdg,
  fmtUtcDate,
  multiplierIsActive,
  premiumPerShare,
  shortHash,
  toNvdaEq,
  tvlUsdg,
} from "@/lib/format";
import { useCycleHistory, lastSettled } from "@/lib/history";
import { collateralSplit, useNow, useVaultSnapshot } from "@/lib/hooks";

export default function HomePage() {
  const { data: v, isLoading, isError: chainReadFailed } = useVaultSnapshot();
  const { rows, source, error: historyError } = useCycleHistory();
  const nowSeconds = useNow();
  const last = lastSettled(rows);

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

  // Premium only. On an assigned week the harvest also carried the strike proceeds, which are
  // the collateral's sale price at the strike, not earnings; they get their own line below.
  const lastPerShare = last ? premiumPerShare(last) : undefined;
  const lastTvl = tvlUsdg(last?.assetsAtHarvest, last?.spotUsdgAtHarvest);
  const lastWasAssigned =
    last !== undefined && ((last.contractsAssigned ?? 0n) > 0n || (last.strikeProceedsUsdg ?? 0n) > 0n);

  return (
    <>
      <PageHead
        eyebrow="Robinhood Chain 4663 · Valorem Clear · Seaport 1.6"
        title={
          <>
            {SHARE_TICKER} — pooled covered calls on {MARKET} Stock Tokens
          </>
        }
        lede={
          <p>
            Deposit one tokenised stock, receive vault shares. Each week a keeper arms one out-of-the-money call on the
            idle collateral and lists it for USDG on this site&apos;s own fill page. Nothing is written until a buyer
            fills; each fill writes exactly what it buys. Depositors receive whatever premium actually fills — and
            nothing at all in a week where nobody buys.
          </p>
        }
      />

      <div className="grid gap-4 sm:gap-5">
        {!VAULT ? (
          <Notice tone="warn" title="No vault address configured.">
            Set <code>NEXT_PUBLIC_VAULT</code> to the deployed Stonkhouse vault on chain 4663. Every
            other address (clearinghouse, Seaport, USDG, the Stock Token) is compiled in from
            explorer-confirmed recon and needs no configuration.
          </Notice>
        ) : null}

        {/* A failed batch is not an empty vault. Say which one it is. */}
        {chainReadFailed ? (
          <Notice tone="warn" title="Chain reads are failing right now.">
            The vault could not be read from the RPC, so the numbers below are missing rather than zero.
          </Notice>
        ) : null}

        <StrandedBanner snapshot={v} compact />

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
              value={v.cycleStrikeUsdg && v.cycleStrikeUsdg > 0n && v.phase !== 0 ? fmtUsdg(v.cycleStrikeUsdg) : "—"}
              unit="USDG"
              sub={
                v.phase === undefined
                  ? "—"
                  : v.phase === 0
                    ? "nothing armed this cycle"
                    : `${(v.contractsWritten ?? 0n).toString()} calls sold this week${
                        v.capacity !== undefined && v.phase === 1 ? ` · capacity for ${v.capacity.toString()} more` : ""
                      }`
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

          <div className="grid grid-cols-1 gap-x-12 gap-y-6 border-t border-line pt-6 lg:grid-cols-2">
            <div className="min-w-0">
              <h3 className="mb-1.5 text-base font-bold tracking-[-0.01em]">
                This week
              </h3>
              <Rows>
                <Row k="Vault cycle" v={<>#{v.cycleNumber ?? "—"}</>} />
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
                <CycleTapeInline snapshot={v} />
              </Rows>
            </div>

            <div className="min-w-0 max-lg:border-t max-lg:border-line max-lg:pt-6">
              <h3 className="mb-1.5 text-base font-bold tracking-[-0.01em]">
                Last week realized
              </h3>
              {last ? (
                <Rows>
                  <Row
                    k="Cycle"
                    v={
                      <>
                        #{last.cycle} · {fmtUtcDate(last.closedAt)}
                      </>
                    }
                  />
                  <Row
                    k={<>Net premium per {SHARE_TICKER}</>}
                    v={lastPerShare === undefined ? "—" : fmtUsdg(lastPerShare, 6)}
                  />
                  <Row k="Net premium to depositors" v={fmtUsdg(last.premiumNetUsdg)} />
                  <Row k="Net premium / collateral at harvest" v={fmtRealizedWeek(last.premiumNetUsdg, lastTvl)} />
                  {lastWasAssigned ? (
                    <Row
                      title="USDG received for collateral taken at the strike. Returned principal, not premium."
                      k="Strike proceeds (assignment)"
                      v={fmtUsdg(last.strikeProceedsUsdg)}
                    />
                  ) : null}
                  <Row
                    k="Result"
                    mono={false}
                    v={
                      last.stranded && last.strandRecovered !== true
                        ? "closed, claim stranded"
                        : last.stranded
                          ? `claim stranded, recovered${(last.contractsAssigned ?? 0n) > 0n ? `, assigned ${(last.contractsAssigned ?? 0n).toString()}` : ""}`
                          : last.filled
                          ? (last.contractsAssigned ?? 0n) > 0n
                            ? `assigned ${(last.contractsAssigned ?? 0n).toString()}`
                            : "filled, expired worthless"
                          : "unfilled, 0"
                    }
                  />
                </Rows>
              ) : (
                <p className="rounded-md bg-surface-2 px-4 py-3.5 text-[14.5px] leading-[1.55] text-ink-2">
                  {/* Do not blame the history service for a missing vault address: with no vault
                      configured nothing was ever queried. */}
                  {!VAULT
                    ? "Set NEXT_PUBLIC_VAULT to load this vault's weekly results."
                    : isLoading
                      ? "Loading…"
                      : source === "none"
                        ? "No closed week yet, and history is unavailable right now."
                        : "No week has closed yet. The first result publishes after the first expiry."}
                </p>
              )}
              {historyError ? (
                <div className="mt-2 text-[12.5px] text-ink-3">
                  {historyError}
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap gap-3 border-t border-line pt-6">
            <Button href="/vault/nvda" className="max-sm:w-full">
              Deposit or withdraw
            </Button>
            <Button variant="ghost" href="/vault/nvda/cycle" className="max-sm:w-full">
              This week&apos;s call · buy it
            </Button>
            <Button variant="ghost" href="/activity" className="max-sm:w-full">
              Every week, including the zeros
            </Button>
          </div>
        </Card>

        <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-3">
          <Card pad="sm" className="grid grid-cols-[26px_minmax(0,1fr)] content-start gap-x-2 gap-y-2">
            <WarnIcon size={18} className="mt-[5px] text-warn" />
            <CardTitle className="text-[17px]!">Premium, or nothing</CardTitle>
            <p className="col-span-2 text-[14.5px] sm:col-span-1 sm:col-start-2 leading-[1.6] text-ink-2">
              The vault lists a call on <Link href="/vault/nvda/cycle" className="link">its own fill page</Link>, the only venue. If no
              buyer takes it, the week earns zero. That is the most likely outcome on a thin book and it is published
              as a row like any other.
            </p>
          </Card>
          <Card pad="sm" className="grid grid-cols-[26px_minmax(0,1fr)] content-start gap-x-2 gap-y-2">
            <WarnIcon size={18} className="mt-[5px] text-warn" />
            <CardTitle className="text-[17px]!">Assignment is real</CardTitle>
            <p className="col-span-2 text-[14.5px] sm:col-span-1 sm:col-start-2 leading-[1.6] text-ink-2">
              If a call the vault sold is exercised, collateral leaves at the strike and comes back as USDG. Upside
              above the strike is gone for that week. v1 does not buy the token back.
            </p>
          </Card>
          <Card pad="sm" className="grid grid-cols-[26px_minmax(0,1fr)] content-start gap-x-2 gap-y-2">
            <WarnIcon size={18} className="mt-[5px] text-warn" />
            <CardTitle className="text-[17px]!">Stock Tokens, not shares</CardTitle>
            <p className="col-span-2 text-[14.5px] sm:col-span-1 sm:col-start-2 leading-[1.6] text-ink-2">
              The collateral is a debt security issued by Robinhood Assets (Jersey) Limited. No vote,
              no claim on the company, and the issuer can freeze transfers.{" "}
              <Link href="/legal" className="link">Read the legal page.</Link>
            </p>
          </Card>
        </div>

        {VAULT ? (
          <p className="text-[12.5px] text-ink-3">
            Vault{" "}
            <ExternalLink href={addressUrl(VAULT)} className="link num [overflow-wrap:anywhere]">
              {VAULT}
            </ExternalLink>
            {source === "chain" ? " · history rebuilt from vault logs" : source === "indexer" ? " · history from the indexer" : ""}
            {" · unaudited"}
          </p>
        ) : null}
      </div>
    </>
  );
}
