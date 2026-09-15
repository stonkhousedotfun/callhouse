"use client";

import Link from "next/link";
import { useAccount } from "wagmi";

import { CycleTape } from "@/components/CycleTape";
import { DepositForm } from "@/components/DepositForm";
import { VaultOverview } from "@/components/VaultOverview";
import { GuardBadges, VaultPhaseBadge } from "@/components/PhaseBadge";
import { PositionSplit } from "@/components/PositionSplit";
import { RedeemQueue } from "@/components/RedeemQueue";
import { StrandedBanner } from "@/components/StrandedBanner";
import { UsdgClaim } from "@/components/UsdgClaim";
import { Card, CardHead, CardMeta, CardTitle, ExternalLink, Notice, PageHead, Row, Rows, Stat, Unit } from "@/components/ui";
import { addressUrl } from "@/lib/chain";
import { ASSET, MARKET, SHARE_TICKER, VAULT } from "@/lib/contracts";
import {
  depositState,
  fmtAsset,
  fmtMultiplier,
  fmtRealizedWeek,
  fmtUsdg,
  fmtUtcDate,
  maxContracts,
  premiumPerShare,
  toNvdaEq,
  tvlUsdg,
} from "@/lib/format";
import { lastSettled, unfilledWeekResult, useCycleHistory } from "@/lib/history";
import { collateralSplit, useAccountPosition, useNow, useVaultSnapshot } from "@/lib/hooks";

export default function VaultPage() {
  const { address } = useAccount();
  const { data: v, isError: chainReadFailed, refetch: refetchVault } = useVaultSnapshot();
  const { data: position, refetch: refetchPosition } = useAccountPosition(address);
  const { rows } = useCycleHistory();
  const last = lastSettled(rows);
  const nowSeconds = useNow();
  // The same predicate as the deposit form: a full cap is "cap full", never "closed".
  const deposits = depositState(v, nowSeconds);

  const refresh = () => {
    void refetchVault();
    void refetchPosition();
  };

  // Locked collateral is sold collateral: under write on fill nothing is written until a buyer
  // pays for it, so the split has no "listed, unsold" slice (see collateralSplit).
  const split = collateralSplit(v);
  const cap = maxContracts(v.totalAssets, v.policy);

  // Premium only (W-21). On an assigned week the harvest also carried the strike proceeds —
  // collateral sold at the strike — which are shown on their own line and in no premium figure.
  const lastPerShare = last ? premiumPerShare(last) : undefined;
  const lastTvl = tvlUsdg(last?.assetsAtHarvest, last?.spotUsdgAtHarvest);
  const lastWasAssigned =
    last !== undefined && ((last.contractsAssigned ?? 0n) > 0n || (last.strikeProceedsUsdg ?? 0n) > 0n);

  return (
    <>
      <PageHead
        eyebrow={<>Vault · {MARKET} · Beta</>}
        title={
          <>
            {SHARE_TICKER} — deposit, withdraw, claim
          </>
        }
        lede={
          <p>
            Deposit {MARKET} Stock Tokens and receive {SHARE_TICKER}. Premium arrives as USDG and is
            claimed separately; it is never folded into the share price.
          </p>
        }
      />

      <div className="grid gap-4 sm:gap-5">
        {/* The three disclosures below are required, verbatim, by scripts/copy-lint.mjs. They are
            compliance text from README "Frontend copy" and TECHSPEC 7.3 — do not reword them. */}
        <Notice
          tone="warn"
          className="lg:[&>div]:max-w-[88ch]"
          title={<>Premium is paid only if a buyer fills the vault&apos;s listing.</>}
        >
          Nothing is written until someone buys, so an empty week means zero for the week. Assignment can take your
          tokens at the strike, and the upside above it is gone for that week. Stock Tokens are debt securities issued
          by Robinhood Assets (Jersey) Limited, not equity in the underlying company: no vote, no claim on the company,
          and the issuer can freeze transfers. The vault is unaudited. See{" "}
          <Link href="/legal" className="link">
            Legal
          </Link>{" "}
          and{" "}
          <Link href="/docs" className="link">
            Docs
          </Link>{" "}
          for the full risk list.
        </Notice>

        {!VAULT ? (
          <Notice tone="danger" title="No vault address configured.">
            Set <code className="num text-[0.95em] text-ink">NEXT_PUBLIC_VAULT</code> before this page can read or
            write anything.
          </Notice>
        ) : null}

        {chainReadFailed ? (
          <Notice tone="warn" title="Chain reads are failing right now.">
            The vault could not be read from the RPC. Balances and phase below are missing rather
            than zero, and a transaction sent now may revert on a rule this page could not check.
          </Notice>
        ) : null}

        <StrandedBanner snapshot={v} position={position} onDone={refresh} />

        <VaultOverview />

        <Card>
          <CardHead>
            <CardTitle>Your position</CardTitle>
            <VaultPhaseBadge snapshot={v} nowSeconds={nowSeconds} />
          </CardHead>

          {!address ? (
            <p className="rounded-md bg-surface-2 px-4 py-3.5 text-[14.5px] leading-[1.55] text-ink-2">
              Connect a wallet to see your shares, your queued redemption and your claimable USDG.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Stat
                  className="rounded-md bg-surface-2 p-4 sm:col-span-2 sm:p-5 lg:col-span-1"
                  label="Shares"
                  value={fmtAsset(position.shares)}
                  unit={SHARE_TICKER}
                  sub={
                    <>
                      worth {fmtAsset(position.sharesValueAssets)} {MARKET} raw
                    </>
                  }
                />
                <Stat
                  className="rounded-md bg-surface-2 p-4 sm:p-5"
                  label="Claimable USDG"
                  value={fmtUsdg(position.claimableUsdg)}
                  tone="usdg"
                  sub="premium on filled weeks, strike proceeds on assigned weeks"
                />
                <Stat
                  className="rounded-md bg-surface-2 p-4 sm:p-5"
                  label="Queued shares"
                  value={fmtAsset(position.queuedShares)}
                  sub={
                    (position.queuedShares ?? 0n) === 0n
                      ? "nothing queued"
                      : `epoch ${position.queuedEpoch?.toString() ?? "—"}`
                  }
                />
              </div>

              {/* Raw vs display-adjusted. The uiMultiplier line is labelled display-only because
                  nothing in the vault's maths, and nothing in a transaction built on this page,
                  ever uses it. */}
              <Rows className="mt-4 lg:grid-cols-2 lg:gap-x-10 lg:[&>[data-slot=row]:nth-last-child(2)]:border-b-0">
                <Row k={<>Wallet {MARKET}, raw</>} v={fmtAsset(position.assetBalance)} />
                <Row
                  k={
                    <>
                      Wallet {MARKET}-eq{" "}
                      <span className="text-ink-3">(display only, ×{fmtMultiplier(v.uiMultiplier)})</span>
                    </>
                  }
                  v={fmtAsset(toNvdaEq(position.assetBalance, v.uiMultiplier))}
                />
                <Row
                  k={
                    <>
                      Share value {MARKET}-eq <span className="text-ink-3">(display only)</span>
                    </>
                  }
                  v={fmtAsset(toNvdaEq(position.sharesValueAssets, v.uiMultiplier))}
                />
                <Row k="Wallet USDG" v={fmtUsdg(position.usdgBalance)} />
              </Rows>
            </>
          )}
        </Card>

        <div className="grid grid-cols-1 items-start gap-4 sm:gap-5 lg:grid-cols-2">
          <DepositForm snapshot={v} position={position} onDone={refresh} />
          <RedeemQueue snapshot={v} position={position} onDone={refresh} />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-2">
          <UsdgClaim snapshot={v} position={position} onDone={refresh} />

          <Card>
            <CardHead>
              <CardTitle>Last week realized</CardTitle>
              <CardMeta>{last ? `cycle #${last.cycle}` : "no closed week"}</CardMeta>
            </CardHead>
            {last ? (
              <>
                <Stat
                  size="lg"
                  className="rounded-md bg-surface-2 p-4 sm:p-5"
                  label={<>Net premium per {SHARE_TICKER}</>}
                  value={lastPerShare === undefined ? "—" : fmtUsdg(lastPerShare, 6)}
                  sub={
                    <>
                      {last.filled
                        ? `${(last.contractsSold ?? last.contracts ?? 0n).toString()} calls sold`
                        : unfilledWeekResult(last).short}
                      {last.stranded ? (last.strandRecovered === true ? " · claim stranded at the close, since recovered" : " · claim stranded at the close") : ""} ·{" "}
                      {fmtUtcDate(last.closedAt)}
                    </>
                  }
                />
                <Rows className="mt-4">
                  <Row
                    title="USDG buyers paid the vault for this week's calls, before the protocol fee. Strike proceeds excluded."
                    k="Premium received"
                    v={fmtUsdg(last.premiumGrossUsdg)}
                  />
                  <Row k="Protocol fee" v={fmtUsdg(last.feeUsdg ?? 0n)} />
                  <Row k="Net premium to depositors" v={fmtUsdg(last.premiumNetUsdg)} />
                  <Row k="Net premium / collateral at harvest" v={fmtRealizedWeek(last.premiumNetUsdg, lastTvl)} />
                  <Row k="Contracts assigned" v={(last.contractsAssigned ?? 0n).toString()} />
                  {lastWasAssigned ? (
                    <Row
                      title="USDG received for collateral taken at the strike. Returned principal, not premium."
                      k="Strike proceeds (assignment)"
                      v={fmtUsdg(last.strikeProceedsUsdg)}
                    />
                  ) : null}
                </Rows>
                <p className="mt-3 text-[12.5px] leading-[1.55] text-ink-3">
                  One week is one week. This figure is never multiplied out to a longer period
                  anywhere on this site.{" "}
                  <Link href="/activity" className="link">
                    See every week
                  </Link>
                  .
                </p>
                {lastWasAssigned ? (
                  <p className="mt-2 text-[12.5px] leading-[1.55] text-ink-3">
                    Strike proceeds are the USDG your {MARKET} was sold for at the strike when the
                    calls were exercised. They are credited to holders and claimable with the
                    premium, but they are returned collateral, not earnings, and no premium figure
                    above includes them.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="rounded-md bg-surface-2 px-4 py-3.5 text-[14.5px] leading-[1.55] text-ink-2">
                No week has closed yet. The first result — filled or zero — publishes after the first
                expiry.
              </p>
            )}
          </Card>
        </div>

        <CycleTape snapshot={v} />

        <Card>
          <CardHead>
            <CardTitle>Vault collateral</CardTitle>
            <GuardBadges snapshot={v} />
          </CardHead>
          <div className="lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-x-10">
            <div className="lg:col-start-1 lg:row-start-1">
              <PositionSplit idle={split.idle} sold={split.sold} assigned={split.assigned} />
            </div>
            <Rows className="mt-4 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:mt-0">
              <Row
                title="Contracts written this cycle. Every one was sold in the transaction that wrote it."
                k="Calls sold this week"
                v={
                  <>
                    {v.contractsWritten === undefined ? "—" : v.contractsWritten.toString()}
                    {cap !== undefined ? (
                      <>
                        {" "}
                        <Unit>of at most</Unit> {cap.toString()}
                      </>
                    ) : (
                      ""
                    )}
                  </>
                }
              />
              <Row
                title="Policy.maxContracts(totalAssets) − contractsWritten: what the vault can still write this cycle. Re-sized at every fill."
                k="Capacity remaining"
                v={
                  v.capacity === undefined ? (
                    "—"
                  ) : (
                    <>
                      {v.capacity.toString()} <Unit>contracts</Unit>
                    </>
                  )
                }
              />
              <Row
                k="Deposit cap"
                v={
                  <>
                    {fmtAsset(v.depositCap)} <Unit>{MARKET}</Unit>
                  </>
                }
              />
              <Row
                k="Reserved for the redeem queue"
                v={
                  <>
                    {fmtAsset(v.reservedAssets)} <Unit>{MARKET}</Unit> · {fmtUsdg(v.usdgReservedForQueue)} <Unit>USDG</Unit>
                  </>
                }
              />
              <Row k="Instant redemption" v={v.canRedeemInstantly ? "open" : "queue only"} />
              <Row
                k="Deposits"
                v={deposits.kind === "unknown" ? "—" : deposits.kind === "capFull" ? "cap full" : deposits.kind}
              />
              <Row
                k="Protocol fee on harvested premium"
                v={v.policy ? `${(v.policy.protocolFeeBps / 100).toFixed(2)}%` : "—"}
              />
            </Rows>
            <p className="mt-4 grid gap-1 border-t border-line pt-4 text-[12.5px] leading-[1.55] text-ink-3 sm:block lg:col-start-1 lg:row-start-2 lg:grid lg:self-end">
              <span>
                Stock Token{" "}
                <ExternalLink href={addressUrl(ASSET)} className="link num [overflow-wrap:anywhere]">
                  {ASSET}
                </ExternalLink>
              </span>
              {VAULT ? (
                <span>
                  {" · vault "}
                  <ExternalLink href={addressUrl(VAULT)} className="link num [overflow-wrap:anywhere]">
                    {VAULT}
                  </ExternalLink>
                </span>
              ) : null}
            </p>
          </div>
        </Card>
      </div>
    </>
  );
}
