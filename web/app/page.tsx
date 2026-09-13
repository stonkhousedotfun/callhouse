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
import { GuardBadges, PhaseBadge } from "@/components/PhaseBadge";
import { PositionSplit } from "@/components/PositionSplit";
import { addressUrl } from "@/lib/chain";
import { MARKET, SHARE_TICKER, VAULT } from "@/lib/contracts";
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
import { collateralSplit, useVaultSnapshot } from "@/lib/hooks";

export default function HomePage() {
  const { data: v, isLoading, isError: chainReadFailed } = useVaultSnapshot();
  const { rows, source, error: historyError } = useCycleHistory();
  const last = lastSettled(rows);

  // Share price is collateral only, in raw 18-decimal units. Premium is not folded into it:
  // USDG accrues per share and is claimed separately (see UsdgClaim).
  const pps =
    v.totalAssets !== undefined && v.totalSupply !== undefined && v.totalSupply > 0n
      ? (v.totalAssets * WAD) / v.totalSupply
      : undefined;

  const tvl = tvlUsdg(v.totalAssets, v.spotUsdg);

  // Locked collateral splits into "sold" (calls a buyer owns, so assignable) and "listed"
  // (written but nobody has bought them). The per-contract size comes from what the vault
  // actually locked, not from a hardcoded lot: the registry owns lotSize and can move it.
  const split = collateralSplit(v);

  // Premium only. On an assigned week the harvest also carried the strike proceeds, which are
  // the collateral's sale price at the strike, not earnings; they get their own line below.
  const lastPerShare = last ? premiumPerShare(last) : undefined;
  const lastTvl = tvlUsdg(last?.assetsAtHarvest, last?.spotUsdgAtHarvest);
  const lastWasAssigned =
    last !== undefined && ((last.contractsAssigned ?? 0n) > 0n || (last.strikeProceedsUsdg ?? 0n) > 0n);

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Robinhood Chain 4663 · Overcall · Valorem Clear · Seaport 1.6</div>
        <h1>
          {SHARE_TICKER} — pooled covered calls on {MARKET} Stock Tokens
        </h1>
        <p className="lede">
          Deposit one tokenised stock, receive vault shares. Each week a keeper writes an Overcall
          call against the idle collateral and lists it for USDG. Depositors receive whatever
          premium actually fills — and nothing at all in a week where nobody buys.
        </p>
      </div>

      {!VAULT ? (
        <div className="notice" data-tone="warn">
          <strong>No vault address configured.</strong>
          Set <code>NEXT_PUBLIC_VAULT</code> to the deployed Callhouse vault on chain 4663. Every
          other address (registry, clearinghouse, Seaport, USDG, the Stock Token) is compiled in
          from explorer-confirmed recon and needs no configuration.
        </div>
      ) : null}

      {/* A failed batch is not an empty vault. Say which one it is. */}
      {chainReadFailed ? (
        <div className="notice" data-tone="warn">
          <strong>Chain reads are failing right now.</strong>
          The vault and registry could not be read from the RPC, so the numbers below are missing
          rather than zero.
        </div>
      ) : null}

      <div className="card">
        <div className="card-head">
          <span className="card-title">
            {SHARE_TICKER} vault
            {v.symbol && v.symbol !== SHARE_TICKER ? ` · on-chain symbol ${v.symbol}` : ""}
          </span>
          <PhaseBadge phase={v.phase} fillState={v.fillState} />
        </div>

        <GuardBadges
          writesHalted={v.writesHalted}
          oraclePaused={v.oraclePaused}
          spotStale={v.spotStale}
          valoremFeeAccepted={v.valoremFeeAccepted}
        />

        <div className="grid grid-3" style={{ marginTop: 14 }}>
          <div className="stat">
            <div className="stat-label">Collateral</div>
            <div className="stat-value">
              {fmtAsset(v.totalAssets)} <span className="faint">{MARKET}</span>
            </div>
            <div className="stat-sub">
              {tvl === undefined ? "spot unavailable" : `${fmtUsdg(tvl)} USDG at feed spot`}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">Shares</div>
            <div className="stat-value">
              {fmtAsset(v.totalSupply)} <span className="faint">{SHARE_TICKER}</span>
            </div>
            <div className="stat-sub">
              {pps === undefined ? "—" : `${fmtAsset(pps, 6)} ${MARKET} per share`}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">This week&apos;s strike</div>
            <div className="stat-value">
              {v.cycleStrikeUsdg && v.cycleStrikeUsdg > 0n ? fmtUsdg(v.cycleStrikeUsdg) : "—"}{" "}
              <span className="faint">USDG</span>
            </div>
            <div className="stat-sub">
              {v.contractsWritten !== undefined && v.contractsWritten > 0n
                ? `${v.contractsWritten.toString()} contracts written · ${(v.contractsSold ?? 0n).toString()} sold`
                : "nothing written this cycle"}
            </div>
          </div>
        </div>

        <hr className="hr" />

        <PositionSplit idle={split.idle} listed={split.listed} sold={split.sold} assigned={split.assigned} />

        {multiplierIsActive(v.uiMultiplier) ? (
          <div className="tiny faint" style={{ marginTop: 10 }}>
            The Stock Token reports a uiMultiplier other than 1.0. Display-only {MARKET}-eq of the
            collateral: {fmtAsset(toNvdaEq(v.totalAssets, v.uiMultiplier))}. Share maths uses the
            raw balance above.
          </div>
        ) : null}

        <hr className="hr" />

        <div className="grid grid-2">
          <div>
            <div className="card-title" style={{ marginBottom: 8 }}>
              This week
            </div>
            <div className="rows">
              <div className="row">
                <span className="k">Registry cycle</span>
                <span className="v">#{v.registryCycleNumber ?? "—"}</span>
              </div>
              <div className="row">
                <span className="k">Order hash</span>
                <span className="v">
                  {v.listingHash === undefined
                    ? "—"
                    : /^0x0+$/.test(v.listingHash)
                      ? "no live listing"
                      : (
                          <Link href="/vault/nvda/cycle">{shortHash(v.listingHash)}</Link>
                        )}
                </span>
              </div>
              <div className="row">
                <span className="k">Listings signed</span>
                <span className="v">{v.listingsThisCycle === undefined ? "—" : v.listingsThisCycle} / 3</span>
              </div>
              <CycleTapeInline snapshot={v} />
            </div>
          </div>

          <div>
            <div className="card-title" style={{ marginBottom: 8 }}>
              Last week realized
            </div>
            {last ? (
              <div className="rows">
                <div className="row">
                  <span className="k">Cycle</span>
                  <span className="v">
                    #{last.cycle} · {fmtUtcDate(last.closedAt)}
                  </span>
                </div>
                <div className="row">
                  <span className="k">Net premium per {SHARE_TICKER}</span>
                  <span className="v">
                    {lastPerShare === undefined ? "—" : fmtUsdg(lastPerShare, 6)}
                  </span>
                </div>
                <div className="row">
                  <span className="k">Net premium to depositors</span>
                  <span className="v">{fmtUsdg(last.premiumNetUsdg)}</span>
                </div>
                <div className="row">
                  <span className="k">Net premium / collateral at harvest</span>
                  <span className="v">{fmtRealizedWeek(last.premiumNetUsdg, lastTvl)}</span>
                </div>
                {lastWasAssigned ? (
                  <div className="row" title="USDG received for collateral taken at the strike. Returned principal, not premium.">
                    <span className="k">Strike proceeds (assignment)</span>
                    <span className="v">{fmtUsdg(last.strikeProceedsUsdg)}</span>
                  </div>
                ) : null}
                <div className="row">
                  <span className="k">Result</span>
                  <span className="v">
                    {last.filled
                      ? (last.contractsAssigned ?? 0n) > 0n
                        ? `assigned ${(last.contractsAssigned ?? 0n).toString()}`
                        : "filled, expired worthless"
                      : (last.contractsAssigned ?? 0n) > 0n
                        ? `unfilled, assigned ${(last.contractsAssigned ?? 0n).toString()}`
                        : "unfilled, 0"}
                  </span>
                </div>
              </div>
            ) : (
              <p className="small muted" style={{ marginTop: 4 }}>
                {/* Do not blame the history service for a missing vault address: with no vault
                    configured nothing was ever queried. */}
                {!VAULT
                  ? "Set NEXT_PUBLIC_VAULT to load this vault's weekly results."
                  : isLoading
                    ? "Loading…"
                    : source === "none"
                      ? "No closed week yet, and history is unavailable right now."
                      : "No week has closed yet. The first result publishes after the first Saturday expiry."}
              </p>
            )}
            {historyError ? (
              <div className="tiny faint" style={{ marginTop: 6 }}>
                {historyError}
              </div>
            ) : null}
          </div>
        </div>

        <div className="btn-row" style={{ marginTop: 16 }}>
          <Link className="btn" href="/vault/nvda" style={{ background: "var(--accent)", borderColor: "var(--accent)", color: "#06210f" }}>
            Deposit or withdraw
          </Link>
          <Link className="btn" href="/vault/nvda/cycle">
            This week&apos;s ladder
          </Link>
          <Link className="btn" href="/activity">
            Every week, including the zeros
          </Link>
        </div>
      </div>

      <div className="grid grid-3" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="card-title">Premium, or nothing</div>
          <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>
            The vault lists a call on Overcall&apos;s book. If no buyer takes it, the week earns
            zero. That is the most likely outcome on a thin book and it is published as a row like
            any other.
          </p>
        </div>
        <div className="card">
          <div className="card-title">Assignment is real</div>
          <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>
            If the call is exercised, collateral leaves at the strike and comes back as USDG.
            Upside above the strike is gone for that week. v1 does not buy the token back.
          </p>
        </div>
        <div className="card">
          <div className="card-title">Stock Tokens, not shares</div>
          <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>
            The collateral is a debt security issued by Robinhood Assets (Jersey) Limited. No vote,
            no claim on the company, and the issuer can freeze transfers.{" "}
            <Link href="/legal">Read the legal page.</Link>
          </p>
        </div>
      </div>

      {VAULT ? (
        <p className="tiny faint" style={{ marginTop: 16 }}>
          Vault{" "}
          <a href={addressUrl(VAULT)} target="_blank" rel="noreferrer noopener">
            {VAULT}
          </a>
          {source === "chain" ? " · history rebuilt from vault logs" : source === "indexer" ? " · history from the indexer" : ""}
        </p>
      ) : null}
    </>
  );
}
