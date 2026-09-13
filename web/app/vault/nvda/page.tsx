"use client";

import Link from "next/link";
import { useAccount } from "wagmi";

import { CycleTape } from "@/components/CycleTape";
import { DepositForm } from "@/components/DepositForm";
import { GuardBadges, PhaseBadge } from "@/components/PhaseBadge";
import { PositionSplit } from "@/components/PositionSplit";
import { RedeemQueue } from "@/components/RedeemQueue";
import { UsdgClaim } from "@/components/UsdgClaim";
import { addressUrl } from "@/lib/chain";
import { ASSET, MARKET, SHARE_TICKER, VAULT } from "@/lib/contracts";
import {
  fmtAsset,
  fmtMultiplier,
  fmtRealizedWeek,
  fmtUsdg,
  fmtUtcDate,
  toNvdaEq,
  tvlUsdg,
  usdgPerShare,
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

  // Per-contract collateral is derived from what the vault locked (see collateralSplit): the
  // registry owns lotSize, so a hardcoded 1e18 would lie the moment Overcall changes it.
  const split = collateralSplit(v);

  const lastPerShare = usdgPerShare(last?.netUsdg, last?.sharesAtHarvest);
  const lastTvl = tvlUsdg(last?.assetsAtHarvest, last?.spotUsdgAtHarvest);

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
        <strong>Premium is paid only if a buyer fills the Overcall listing.</strong>
        An empty book means zero for the week. Assignment can take your tokens at the strike, and
        the upside above it is gone for that week. Stock Tokens are debt securities issued by
        Robinhood Assets (Jersey) Limited, not equity in the underlying company: no vote, no claim
        on the company, and the issuer can freeze transfers. See <Link href="/legal">Legal</Link>{" "}
        and <Link href="/docs">Docs</Link> for the full risk list.
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

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <span className="card-title">Your position</span>
          <PhaseBadge phase={v.phase} fillState={v.fillState} />
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
                <div className="stat-sub">filled weeks only</div>
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
                <div className="stat-label">USDG per {SHARE_TICKER}</div>
                <div className="stat-value">
                  {lastPerShare === undefined ? "—" : fmtUsdg(lastPerShare, 6)}
                </div>
                <div className="stat-sub">
                  {last.filled ? "a buyer filled the listing" : "unfilled, 0"} ·{" "}
                  {fmtUtcDate(last.closedAt)}
                </div>
              </div>
              <div className="rows" style={{ marginTop: 12 }}>
                <div className="row">
                  <span className="k">Gross premium</span>
                  <span className="v">{fmtUsdg(last.grossUsdg ?? 0n)}</span>
                </div>
                <div className="row">
                  <span className="k">Protocol fee</span>
                  <span className="v">{fmtUsdg(last.feeUsdg ?? 0n)}</span>
                </div>
                <div className="row">
                  <span className="k">Net to depositors</span>
                  <span className="v">{fmtUsdg(last.netUsdg ?? 0n)}</span>
                </div>
                <div className="row">
                  <span className="k">Net / collateral at harvest</span>
                  <span className="v">{fmtRealizedWeek(last.netUsdg ?? 0n, lastTvl)}</span>
                </div>
                <div className="row">
                  <span className="k">Contracts assigned</span>
                  <span className="v">{(last.contractsAssigned ?? 0n).toString()}</span>
                </div>
              </div>
              <p className="tiny faint" style={{ marginTop: 10, marginBottom: 0 }}>
                One week is one week. This figure is never multiplied out to a longer period
                anywhere on this site. <Link href="/activity">See every week</Link>.
              </p>
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
          />
        </div>
        <PositionSplit idle={split.idle} listed={split.listed} sold={split.sold} assigned={split.assigned} />
        <div className="rows" style={{ marginTop: 14 }}>
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
