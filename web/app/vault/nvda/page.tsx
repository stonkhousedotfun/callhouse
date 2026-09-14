"use client";

import Link from "next/link";
import { useAccount } from "wagmi";

import { CycleTape } from "@/components/CycleTape";
import { DepositForm } from "@/components/DepositForm";
import { GuardBadges, PhaseBadge } from "@/components/PhaseBadge";
import { PositionSplit } from "@/components/PositionSplit";
import { RedeemQueue } from "@/components/RedeemQueue";
import { StrandedBanner } from "@/components/StrandedBanner";
import { UsdgClaim } from "@/components/UsdgClaim";
import { addressUrl } from "@/lib/chain";
import { ASSET, MARKET, SHARE_TICKER, VAULT } from "@/lib/contracts";
import {
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
import { lastSettled, useCycleHistory } from "@/lib/history";
import { collateralSplit, useAccountPosition, useVaultSnapshot } from "@/lib/hooks";

export default function VaultPage() {
  const { address } = useAccount();
  const { data: v, isError: chainReadFailed, refetch: refetchVault } = useVaultSnapshot();
  const { data: position, refetch: refetchPosition } = useAccountPosition(address);
  const { rows } = useCycleHistory();
  const last = lastSettled(rows);

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
      <div className="page-head">
        <div className="eyebrow">Vault · {MARKET}</div>
        <h1>
          {SHARE_TICKER} — deposit, withdraw, claim
        </h1>
        <p className="lede">
          Deposit {MARKET} Stock Tokens and receive {SHARE_TICKER}. Premium arrives as USDG and is
          claimed separately; it is never folded into the share price.
        </p>
      </div>

      {/* The three disclosures below are required, verbatim, by scripts/copy-lint.mjs. They are
          compliance text from README "Frontend copy" and TECHSPEC 7.3 — do not reword them. */}
      <div className="notice" data-tone="warn">
        <strong>Premium is paid only if a buyer fills the vault&apos;s listing.</strong>
        Nothing is written until someone buys, so an empty week means zero for the week. Assignment can take your
        tokens at the strike, and the upside above it is gone for that week. Stock Tokens are debt securities issued
        by Robinhood Assets (Jersey) Limited, not equity in the underlying company: no vote, no claim on the company,
        and the issuer can freeze transfers. The vault is unaudited. See <Link href="/legal">Legal</Link> and{" "}
        <Link href="/docs">Docs</Link> for the full risk list.
      </div>

      {!VAULT ? (
        <div className="notice" data-tone="bad" style={{ marginTop: 16 }}>
          <strong>No vault address configured.</strong>
          Set <code>NEXT_PUBLIC_VAULT</code> before this page can read or write anything.
        </div>
      ) : null}

      {chainReadFailed ? (
        <div className="notice" data-tone="warn" style={{ marginTop: 16 }}>
          <strong>Chain reads are failing right now.</strong>
          The vault could not be read from the RPC. Balances and phase below are missing rather
          than zero, and a transaction sent now may revert on a rule this page could not check.
        </div>
      ) : null}

      <StrandedBanner snapshot={v} position={position} onDone={refresh} />

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <span className="card-title">Your position</span>
          <PhaseBadge phase={v.phase} fillState={v.fillState} sold={v.contractsWritten} />
        </div>

        {!address ? (
          <p className="small muted" style={{ marginBottom: 0 }}>
            Connect a wallet to see your shares, your queued redemption and your claimable USDG.
          </p>
        ) : (
          <>
            <div className="grid grid-3">
              <div className="stat">
                <div className="stat-label">Shares</div>
                <div className="stat-value">
                  {fmtAsset(position.shares)} <span className="faint">{SHARE_TICKER}</span>
                </div>
                <div className="stat-sub">
                  worth {fmtAsset(position.sharesValueAssets)} {MARKET} raw
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">Claimable USDG</div>
                <div className="stat-value">{fmtUsdg(position.claimableUsdg)}</div>
                <div className="stat-sub">premium on filled weeks, strike proceeds on assigned weeks</div>
              </div>
              <div className="stat">
                <div className="stat-label">Queued shares</div>
                <div className="stat-value">{fmtAsset(position.queuedShares)}</div>
                <div className="stat-sub">
                  {(position.queuedShares ?? 0n) === 0n
                    ? "nothing queued"
                    : `epoch ${position.queuedEpoch?.toString() ?? "—"}`}
                </div>
              </div>
            </div>

            <hr className="hr" />

            {/* Raw vs display-adjusted. The uiMultiplier line is labelled display-only because
                nothing in the vault's maths, and nothing in a transaction built on this page,
                ever uses it. */}
            <div className="rows">
              <div className="row">
                <span className="k">Wallet {MARKET}, raw</span>
                <span className="v">{fmtAsset(position.assetBalance)}</span>
              </div>
              <div className="row">
                <span className="k">
                  Wallet {MARKET}-eq <span className="faint">(display only, ×{fmtMultiplier(v.uiMultiplier)})</span>
                </span>
                <span className="v">{fmtAsset(toNvdaEq(position.assetBalance, v.uiMultiplier))}</span>
              </div>
              <div className="row">
                <span className="k">Share value {MARKET}-eq <span className="faint">(display only)</span></span>
                <span className="v">{fmtAsset(toNvdaEq(position.sharesValueAssets, v.uiMultiplier))}</span>
              </div>
              <div className="row">
                <span className="k">Wallet USDG</span>
                <span className="v">{fmtUsdg(position.usdgBalance)}</span>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <DepositForm snapshot={v} position={position} onDone={refresh} />
        <RedeemQueue snapshot={v} position={position} onDone={refresh} />
      </div>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <UsdgClaim snapshot={v} position={position} onDone={refresh} />

        <div className="card">
          <div className="card-head">
            <span className="card-title">Last week realized</span>
            <span className="tiny faint mono">{last ? `cycle #${last.cycle}` : "no closed week"}</span>
          </div>
          {last ? (
            <>
              <div className="stat">
                <div className="stat-label">Net premium per {SHARE_TICKER}</div>
                <div className="stat-value">
                  {lastPerShare === undefined ? "—" : fmtUsdg(lastPerShare, 6)}
                </div>
                <div className="stat-sub">
                  {last.filled
                    ? `${(last.contractsSold ?? last.contracts ?? 0n).toString()} calls sold`
                    : lastWasAssigned
                      ? `unfilled, assigned ${(last.contractsAssigned ?? 0n).toString()}`
                      : "unfilled, 0"}
                  {last.stranded ? " · claim stranded at the close" : ""} ·{" "}
                  {fmtUtcDate(last.closedAt)}
                </div>
              </div>
              <div className="rows" style={{ marginTop: 12 }}>
                <div className="row" title="USDG buyers paid the vault for this week's calls, before the protocol fee. Strike proceeds excluded.">
                  <span className="k">Premium received</span>
                  <span className="v">{fmtUsdg(last.premiumGrossUsdg)}</span>
                </div>
                <div className="row">
                  <span className="k">Protocol fee</span>
                  <span className="v">{fmtUsdg(last.feeUsdg ?? 0n)}</span>
                </div>
                <div className="row">
                  <span className="k">Net premium to depositors</span>
                  <span className="v">{fmtUsdg(last.premiumNetUsdg)}</span>
                </div>
                <div className="row">
                  <span className="k">Net premium / collateral at harvest</span>
                  <span className="v">{fmtRealizedWeek(last.premiumNetUsdg, lastTvl)}</span>
                </div>
                <div className="row">
                  <span className="k">Contracts assigned</span>
                  <span className="v">{(last.contractsAssigned ?? 0n).toString()}</span>
                </div>
                {lastWasAssigned ? (
                  <div className="row" title="USDG received for collateral taken at the strike. Returned principal, not premium.">
                    <span className="k">Strike proceeds (assignment)</span>
                    <span className="v">{fmtUsdg(last.strikeProceedsUsdg)}</span>
                  </div>
                ) : null}
              </div>
              <p className="tiny faint" style={{ marginTop: 10, marginBottom: 0 }}>
                One week is one week. This figure is never multiplied out to a longer period
                anywhere on this site. <Link href="/activity">See every week</Link>.
              </p>
              {lastWasAssigned ? (
                <p className="tiny faint" style={{ marginTop: 6, marginBottom: 0 }}>
                  Strike proceeds are the USDG your {MARKET} was sold for at the strike when the
                  calls were exercised. They are credited to holders and claimable with the
                  premium, but they are returned collateral, not earnings, and no premium figure
                  above includes them.
                </p>
              ) : null}
            </>
          ) : (
            <p className="small muted" style={{ marginBottom: 0 }}>
              No week has closed yet. The first result — filled or zero — publishes after the first
              expiry.
            </p>
          )}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <CycleTape snapshot={v} />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <span className="card-title">Vault collateral</span>
          <GuardBadges
            writesHalted={v.writesHalted}
            oraclePaused={v.oraclePaused}
            spotStale={v.spotStale}
            valoremFeeAccepted={v.valoremFeeAccepted}
            stranded={v.isStranded}
          />
        </div>
        <PositionSplit idle={split.idle} sold={split.sold} assigned={split.assigned} />
        <div className="rows" style={{ marginTop: 14 }}>
          <div className="row" title="Contracts written this cycle. Every one was sold in the transaction that wrote it.">
            <span className="k">Calls sold this week</span>
            <span className="v">
              {v.contractsWritten === undefined ? "—" : v.contractsWritten.toString()}
              {cap !== undefined ? ` of at most ${cap.toString()}` : ""}
            </span>
          </div>
          <div className="row" title="Policy.maxContracts(totalAssets) − contractsWritten: what the vault can still write this cycle. Re-sized at every fill.">
            <span className="k">Capacity remaining</span>
            <span className="v">{v.capacity === undefined ? "—" : `${v.capacity.toString()} contracts`}</span>
          </div>
          <div className="row">
            <span className="k">Deposit cap</span>
            <span className="v">
              {fmtAsset(v.depositCap)} {MARKET}
            </span>
          </div>
          <div className="row">
            <span className="k">Reserved for the redeem queue</span>
            <span className="v">
              {fmtAsset(v.reservedAssets)} {MARKET} · {fmtUsdg(v.usdgReservedForQueue)} USDG
            </span>
          </div>
          <div className="row">
            <span className="k">Instant redemption</span>
            <span className="v">{v.canRedeemInstantly ? "open" : "queue only"}</span>
          </div>
          <div className="row">
            <span className="k">Deposits</span>
            <span className="v">{v.depositsOpen === undefined ? "—" : v.depositsOpen ? "open" : "closed"}</span>
          </div>
          <div className="row">
            <span className="k">Protocol fee on harvested premium</span>
            <span className="v">
              {v.policy ? `${(v.policy.protocolFeeBps / 100).toFixed(2)}%` : "—"}
            </span>
          </div>
        </div>
        <p className="tiny faint" style={{ marginTop: 12, marginBottom: 0 }}>
          Stock Token{" "}
          <a href={addressUrl(ASSET)} target="_blank" rel="noreferrer noopener">
            {ASSET}
          </a>
          {VAULT ? (
            <>
              {" · vault "}
              <a href={addressUrl(VAULT)} target="_blank" rel="noreferrer noopener">
                {VAULT}
              </a>
            </>
          ) : null}
        </p>
      </div>
    </>
  );
}
