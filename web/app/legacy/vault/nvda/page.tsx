"use client";

import Link from "next/link";
import { useAccount } from "wagmi";

import { CycleTape } from "@/components/CycleTape";

import { VaultOverview } from "@/components/VaultOverview";
import { GuardBadges, VaultPhaseBadge } from "@/components/PhaseBadge";
import { PositionSplit } from "@/components/PositionSplit";
import { RedeemQueue } from "@/components/RedeemQueue";
import { StrandedBanner } from "@/components/StrandedBanner";
import { UsdgClaim } from "@/components/UsdgClaim";
import { Card, CardHead, CardMeta, CardTitle, ExternalLink, InfoTip, Notice, PageHead, Row, Rows, Stat, Unit } from "@/components/ui";
import { Time } from "@/components/ui/Time";
import { addressUrl } from "@/lib/chain";
import { ASSET, MARKET, SHARE_TICKER, VAULT } from "@/lib/contracts";
import {
  depositState,
  fmtAsset,
  fmtMultiplier,
  fmtRealizedWeek,
  fmtUsdg,
  maxContracts,
  premiumPerShare,
  toStockEq,
  tvlUsdg,
} from "@/lib/format";
import { lastSettled, unfilledWeekResult, useCycleHistory } from "@/lib/history";
import { collateralSplit, useAccountPosition, useNow, useVaultSnapshot } from "@/lib/hooks";
import { displayRatioPercent } from "@/lib/numberFormat";

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

  // Premium only. On an assigned week the harvest also carried the strike proceeds —
  // collateral sold at the strike — which are shown on their own line and in no premium figure.
  const lastPerShare = last ? premiumPerShare(last) : undefined;
  const lastTvl = tvlUsdg(last?.assetsAtHarvest, last?.spotUsdgAtHarvest);
  const lastWasAssigned =
    last !== undefined && ((last.contractsAssigned ?? 0n) > 0n || (last.strikeProceedsUsdg ?? 0n) > 0n);

  return (
    <>
      <PageHead
        eyebrow={<>Pooled vault · closed</>}
        title={
          <>
            Collect your queued {SHARE_TICKER}
          </>
        }
        lede={<p>The pooled vault is closed. Collect a queued redemption here.</p>}
      />

      <div className="grid gap-4 sm:gap-5">
        {/* Cut to one line: the vault arms no new week, so the premium and assignment lines no longer
            apply. The full Stock Token disclosure is on /legal. */}
        <Notice tone="warn" className="lg:[&>div]:max-w-[88ch]">
          Stock Tokens are debt securities, not shares, and the issuer can freeze transfers.{" "}
          <Link href="/legal" className="link">
            Legal
          </Link>
        </Notice>

        {!VAULT ? (
          <Notice tone="danger" title="No vault address configured.">
            Set <code className="num text-[0.95em] text-ink">NEXT_PUBLIC_VAULT</code>.
          </Notice>
        ) : null}

        {chainReadFailed ? (
          <Notice tone="warn" title="Can't read the vault right now.">
            Figures below may be missing, and a transaction may fail.
          </Notice>
        ) : null}

        <StrandedBanner snapshot={v} position={position} onDone={refresh} />

        <VaultOverview />

        <Card>
          <CardHead>
            {/* Tips sit beside card titles, not in them: the fork acceptance run matches title text exactly. */}
            <div className="flex items-center gap-2">
              <CardTitle>Your position</CardTitle>
              <InfoTip label="About your position">
                Claimable USDG is premium plus any strike proceeds. The -eq figures apply the token&apos;s display
                multiplier; transactions use the raw amount.
              </InfoTip>
            </div>
            <VaultPhaseBadge snapshot={v} nowSeconds={nowSeconds} />
          </CardHead>

          {!address ? (
            <p className="rounded-md bg-surface-2 px-4 py-3.5 text-[14.5px] leading-[1.55] text-ink-2">
              Connect a wallet to see your position.
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

              {/* Raw vs display-adjusted. The -eq rows are display only (the card's tip says so):
                  nothing in the vault's maths, and nothing in a transaction built on this page,
                  ever uses uiMultiplier. */}
              <Rows className="mt-4 lg:grid-cols-2 lg:gap-x-10 lg:[&>[data-slot=row]:nth-last-child(2)]:border-b-0">
                <Row k={<>Wallet {MARKET}, raw</>} v={fmtAsset(position.assetBalance)} />
                <Row
                  k={
                    <>
                      Wallet {MARKET}-eq <span className="text-ink-3">×{fmtMultiplier(v.uiMultiplier)}</span>
                    </>
                  }
                  v={fmtAsset(toStockEq(position.assetBalance, v.uiMultiplier))}
                />
                <Row k={<>Share value {MARKET}-eq</>} v={fmtAsset(toStockEq(position.sharesValueAssets, v.uiMultiplier))} />
                <Row k="Wallet USDG" v={fmtUsdg(position.usdgBalance)} />
              </Rows>
            </>
          )}
        </Card>

        <div className="grid grid-cols-1 items-start gap-4 sm:gap-5 lg:grid-cols-2">
          <Notice tone="warn" title="Deposits are closed.">
            Collect a queued redemption in Withdraw.
          </Notice>
          <RedeemQueue snapshot={v} position={position} onDone={refresh} />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-2">
          <UsdgClaim snapshot={v} position={position} onDone={refresh} />

          <Card>
            <CardHead>
              <div className="flex items-center gap-2">
                <CardTitle>Last week realized</CardTitle>
                <InfoTip label="About last week">
                  Strike proceeds are what the vault&apos;s {MARKET} sold for at the strike. They are returned
                  collateral, not premium.
                </InfoTip>
              </div>
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
                      {last.closedAt ? <Time at={Number(last.closedAt)} dateOnly /> : "—"}
                    </>
                  }
                />
                <Rows className="mt-4">
                  <Row
                    title="Before the protocol fee. Strike proceeds excluded."
                    k="Premium received"
                    v={fmtUsdg(last.premiumGrossUsdg)}
                  />
                  <Row k="Protocol fee" v={fmtUsdg(last.feeUsdg ?? 0n)} />
                  <Row k="Net premium to depositors" v={fmtUsdg(last.premiumNetUsdg)} />
                  <Row k="Net premium / collateral" v={fmtRealizedWeek(last.premiumNetUsdg, lastTvl)} />
                  <Row k="Contracts assigned" v={(last.contractsAssigned ?? 0n).toString()} />
                  {lastWasAssigned ? <Row k="Strike proceeds" v={fmtUsdg(last.strikeProceedsUsdg)} /> : null}
                </Rows>
                <p className="mt-3 text-[12.5px] leading-[1.55] text-ink-3">
                  <Link href="/activity" className="link">
                    See every week
                  </Link>
                </p>
              </>
            ) : (
              <p className="rounded-md bg-surface-2 px-4 py-3.5 text-[14.5px] leading-[1.55] text-ink-2">
                No week has closed yet.
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
                title="Calls the vault can still sell this week."
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
                k="Protocol fee"
                v={v.policy ? displayRatioPercent(BigInt(v.policy.protocolFeeBps), 10_000n) : "—"}
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
