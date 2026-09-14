"use client";

import { txUrl } from "@/lib/chain";
import { MARKET, SHARE_TICKER, VAULT } from "@/lib/contracts";
import type { CycleRow } from "@/lib/api";
import { fmtRealizedWeek, fmtUsdg, fmtUtcDate, premiumPerShare, tvlUsdg } from "@/lib/format";
import { useCycleHistory } from "@/lib/history";

/** A column total that is only a number when every row's figure is known; otherwise a dash. */
function sumKnown(rows: CycleRow[], figure: (row: CycleRow) => bigint | undefined): bigint | undefined {
  let total = 0n;
  for (const row of rows) {
    const v = figure(row);
    if (v === undefined) return undefined;
    total += v;
  }
  return total;
}

/**
 * Every week the vault has run, in one table, with the zeros in it.
 *
 * A week with no buyer is a row that says "unfilled, 0" — not a gap, not a skipped entry, not a
 * filtered-out result. On a thin book that is the most likely week, and the product's promise is
 * to publish it as plainly as a paid one.
 *
 * The "Sold" column is the week's `CallsWritten` summed: under write on fill every contract is
 * written inside the fill that bought it, so written and sold are one number and there is no
 * "wrote 12, sold 3" row any more.
 *
 * The USDG figures are summed per cycle, not read from a single event. A mid-week deposit
 * checkpoints the harvest so a late depositor cannot claim premium earned before they arrived,
 * which means one cycle can emit several Harvest events under the same cycle number. Only the
 * terminal one — emitted inside the keeper's rollClose — closes the week; the checkpoints still
 * move real money, so both kinds accumulate onto the same row. A close whose Valorem redeem
 * reverted strands the claim: the row is closed and marked, and the strike USDG arrives through a
 * later Harvest when the claim is retried.
 *
 * Premium and strike proceeds are separate columns (W-21). On an assigned week the closing
 * harvest also sweeps the USDG the assigned collateral was sold for at the strike. That is
 * returned principal: it is credited to holders, but it is not premium, and no premium column,
 * total or ratio on this page includes it.
 */
export default function ActivityPage() {
  const { rows, source, error, isLoading } = useCycleHistory();

  const settled = rows.filter((r) => r.settled);
  const filled = settled.filter((r) => r.filled);
  const unfilled = settled.filter((r) => !r.filled);
  const totalPremiumNet = sumKnown(settled, (r) => r.premiumNetUsdg ?? (r.filled ? undefined : 0n));
  const totalFee = settled.reduce((acc, r) => acc + (r.feeUsdg ?? 0n), 0n);
  const totalAssigned = settled.reduce((acc, r) => acc + (r.contractsAssigned ?? 0n), 0n);
  const totalStrike = sumKnown(
    settled,
    (r) => r.strikeProceedsUsdg ?? ((r.contractsAssigned ?? 0n) > 0n ? undefined : 0n),
  );

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Activity</div>
        <h1>Every week, including the zeros</h1>
        <p className="lede">
          One row per cycle. Filled weeks show what actually landed; weeks where nobody bought the
          call show <strong>unfilled, 0</strong>, or <strong>unfilled, assigned</strong> when Valorem
          assigned the vault&apos;s contracts anyway. No week is ever extrapolated to a longer period.
        </p>
      </div>

      {!VAULT ? (
        <div className="notice" data-tone="warn">
          <strong>No vault address configured.</strong>
          Set <code>NEXT_PUBLIC_VAULT</code> to read the vault&apos;s history.
        </div>
      ) : null}

      <div className="grid grid-3">
        <div className="card">
          <div className="stat-label">Weeks closed</div>
          <div className="stat-value">{settled.length}</div>
          <div className="stat-sub">
            {filled.length} filled · {unfilled.length} unfilled
          </div>
        </div>
        <div className="card">
          <div className="stat-label">Net premium to depositors</div>
          <div className="stat-value">{fmtUsdg(totalPremiumNet)}</div>
          <div className="stat-sub">after {fmtUsdg(totalFee)} protocol fee</div>
        </div>
        <div className="card">
          <div className="stat-label">Contracts assigned</div>
          <div className="stat-value">{totalAssigned.toString()}</div>
          <div className="stat-sub">
            collateral taken at the strike · {fmtUsdg(totalStrike)} USDG strike proceeds, not premium
          </div>
        </div>
      </div>

      {error ? (
        <div className="notice" data-tone="warn" style={{ marginTop: 16 }}>
          {error}
        </div>
      ) : null}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <span className="card-title">Weekly results</span>
          <span className="tiny faint mono">
            {source === "indexer" ? "indexer" : source === "chain" ? "rebuilt from vault logs" : "no source"}
          </span>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Cycle</th>
                <th>Closed</th>
                <th>Strike</th>
                <th title="contracts sold, each written inside the fill that bought it (the sum of the week's CallsWritten)">Sold</th>
                <th>Assigned</th>
                <th title="premium buyers paid the vault in USDG, strike proceeds excluded">Premium</th>
                <th>Fee</th>
                <th title="premium after the protocol fee, strike proceeds excluded">Net premium</th>
                <th title="Strike proceeds (assignment): USDG received for collateral taken at the strike. Returned principal, not premium.">
                  Strike proceeds
                </th>
                <th title={`net premium in USDG per one ${SHARE_TICKER} share`}>Premium/share</th>
                <th title="net premium over collateral valued at the feed spot at harvest">Net/TVL</th>
                <th>Result</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  {/* Table cells are nowrap so numeric columns stay aligned; the empty-state
                      sentence is prose and must wrap instead of dragging the scroll container
                      hundreds of pixels wide on a phone. */}
                  <td colSpan={13} className="muted" style={{ whiteSpace: "normal" }}>
                    {!VAULT
                      ? "Set a vault address to load its weekly history."
                      : isLoading
                        ? "Loading…"
                        : source === "none"
                          ? "History is unavailable right now. The vault's own state on the other pages is read straight from the chain and is unaffected."
                          : "No cycle has run yet. The first row appears after the first week closes."}
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  // Premium only; strike proceeds have their own column and are in no ratio.
                  const perShare = premiumPerShare(row);
                  const tvl = tvlUsdg(row.assetsAtHarvest, row.spotUsdgAtHarvest);
                  // Kept short so the 13-column table still fits a laptop without a side scroll.
                  // The long form lives in the cell's title attribute.
                  const assigned = row.contractsAssigned ?? 0n;
                  const sold = row.contractsSold ?? row.contracts ?? 0n;
                  const result = !row.settled
                    ? "open"
                    : row.stranded
                      ? "closed, claim stranded"
                      : !row.filled
                        ? assigned > 0n
                          ? `unfilled, assigned ${assigned.toString()}`
                          : "unfilled, 0"
                        : assigned > 0n
                          ? `assigned ${assigned.toString()}`
                          : "filled";
                  const resultLong = !row.settled
                    ? "the week is still running"
                    : row.stranded
                      ? "the week closed and its premium was harvested, but Valorem could not return the claim's collateral (a USDG pause or freeze, or a Stock Token blocklist); the strike USDG arrives when the claim is retried"
                      : !row.filled
                        ? assigned > 0n
                          ? `nobody bought the vault's call, so it earned no premium, but Valorem assigned ${assigned.toString()} of its contracts; that collateral left at the strike and came back as the strike proceeds`
                          : "nobody bought the call; nothing was written and the week earned nothing"
                        : assigned > 0n
                          ? `${assigned.toString()} of the ${sold.toString()} contracts sold were assigned to the vault; that collateral left at the strike and came back as the strike proceeds`
                          : `buyers filled ${sold.toString()} contracts and the calls expired out of the money`;
                  return (
                    <tr key={row.cycle}>
                      <td>#{row.cycle}</td>
                      <td>{fmtUtcDate(row.closedAt)}</td>
                      <td>{row.strikeUsdg === undefined ? "—" : fmtUsdg(row.strikeUsdg)}</td>
                      <td>{sold.toString()}</td>
                      <td>{assigned.toString()}</td>
                      <td>{fmtUsdg(row.premiumGrossUsdg ?? (row.filled ? undefined : 0n))}</td>
                      <td>{fmtUsdg(row.feeUsdg ?? 0n)}</td>
                      <td>{fmtUsdg(row.premiumNetUsdg ?? (row.filled ? undefined : 0n))}</td>
                      <td>{fmtUsdg(row.strikeProceedsUsdg ?? (assigned > 0n ? undefined : 0n))}</td>
                      <td>{perShare === undefined ? "—" : fmtUsdg(perShare, 6)}</td>
                      <td>{fmtRealizedWeek(row.premiumNetUsdg ?? (row.filled ? undefined : 0n), tvl)}</td>
                      <td title={resultLong}>{result}</td>
                      {/* Prefer the closing tx: it is the one carrying the harvest. Truncated
                          hard so thirteen columns still fit a laptop; the full hash is the title. */}
                      <td>
                        {(() => {
                          const tx = row.txClose ?? row.txOpen;
                          if (!tx) return "—";
                          return (
                            <a href={txUrl(tx)} target="_blank" rel="noreferrer noopener" title={tx}>
                              {`${tx.slice(0, 8)}…`}
                            </a>
                          );
                        })()}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <p className="tiny faint" style={{ marginTop: 12, marginBottom: 0 }}>
          &ldquo;Net / TVL&rdquo; is net premium divided by the vault&apos;s {MARKET} collateral
          valued at the feed spot recorded at harvest. It describes one week and is never scaled to
          a longer period. A dash means the indexer has not recorded a collateral snapshot for that
          harvest.
        </p>
        <p className="tiny faint" style={{ marginTop: 6, marginBottom: 0 }}>
          &ldquo;Strike proceeds&rdquo; is the USDG received on an assigned week for the collateral
          taken at the strike. It is credited to holders with the premium, but it is returned
          collateral, not earnings, so it is left out of the premium, net premium, per-share and
          Net / TVL columns.
        </p>
        <p className="tiny faint" style={{ marginTop: 6, marginBottom: 0 }}>
          &ldquo;Sold&rdquo; is also the number written: each fill writes exactly the contracts it buys, so the
          vault is never assigned on more than it sold.
        </p>
      </div>
    </>
  );
}
