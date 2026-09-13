"use client";

import { txUrl } from "@/lib/chain";
import { MARKET, SHARE_TICKER, VAULT } from "@/lib/contracts";
import { fmtRealizedWeek, fmtUsdg, fmtUtcDate, tvlUsdg, usdgPerShare } from "@/lib/format";
import { useCycleHistory } from "@/lib/history";

/**
 * Every week the vault has run, in one table, with the zeros in it.
 *
 * A week with no buyer is a row that says "unfilled, 0" — not a gap, not a skipped entry, not a
 * filtered-out result. On a thin book that is the most likely week, and the product's promise is
 * to publish it as plainly as a paid one.
 *
 * The USDG figures are summed per cycle, not read from a single event. A mid-week deposit
 * checkpoints the harvest so a late depositor cannot claim premium earned before they arrived,
 * which means one cycle can emit several Harvest events under the same cycle number. Only the
 * terminal one — emitted inside the keeper's rollClose — closes the week; the checkpoints still
 * move real money, so both kinds accumulate onto the same row.
 */
export default function ActivityPage() {
  const { rows, source, error, isLoading } = useCycleHistory();

  const settled = rows.filter((r) => r.settled);
  const filled = settled.filter((r) => r.filled);
  const unfilled = settled.filter((r) => !r.filled);
  const totalNet = settled.reduce((acc, r) => acc + (r.netUsdg ?? 0n), 0n);
  const totalFee = settled.reduce((acc, r) => acc + (r.feeUsdg ?? 0n), 0n);
  const totalAssigned = settled.reduce((acc, r) => acc + (r.contractsAssigned ?? 0n), 0n);

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Activity</div>
        <h1>Every week, including the zeros</h1>
        <p className="lede">
          One row per cycle. Filled weeks show what actually landed; weeks where nobody bought the
          call show <strong>unfilled, 0</strong>. No week is ever extrapolated to a longer period.
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
          <div className="stat-label">Net USDG to depositors</div>
          <div className="stat-value">{fmtUsdg(totalNet)}</div>
          <div className="stat-sub">after {fmtUsdg(totalFee)} protocol fee</div>
        </div>
        <div className="card">
          <div className="stat-label">Contracts assigned</div>
          <div className="stat-value">{totalAssigned.toString()}</div>
          <div className="stat-sub">collateral taken at the strike</div>
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
                <th title="contracts written">Wrote</th>
                <th>Assigned</th>
                <th title="gross premium in USDG">Gross</th>
                <th>Fee</th>
                <th>Net</th>
                <th title={`net USDG per one ${SHARE_TICKER} share`}>USDG/share</th>
                <th title="net USDG over collateral valued at the feed spot at harvest">Net/TVL</th>
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
                  <td colSpan={12} className="muted" style={{ whiteSpace: "normal" }}>
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
                  const perShare = usdgPerShare(row.netUsdg, row.sharesAtHarvest);
                  const tvl = tvlUsdg(row.assetsAtHarvest, row.spotUsdgAtHarvest);
                  // Kept short so the 12-column table still fits a laptop without a side scroll.
                  // The long form lives in the cell's title attribute.
                  const assigned = row.contractsAssigned ?? 0n;
                  const result = !row.settled
                    ? "open"
                    : !row.filled
                      ? "unfilled, 0"
                      : assigned > 0n
                        ? `assigned ${assigned.toString()}`
                        : "filled";
                  const resultLong = !row.settled
                    ? "the week is still running"
                    : !row.filled
                      ? "nobody bought the call; the week earned nothing"
                      : assigned > 0n
                        ? `${assigned.toString()} contracts were exercised; that collateral left at the strike`
                        : "a buyer filled the listing and the call expired out of the money";
                  return (
                    <tr key={row.cycle}>
                      <td>#{row.cycle}</td>
                      <td>{fmtUtcDate(row.closedAt)}</td>
                      <td>{row.strikeUsdg === undefined ? "—" : fmtUsdg(row.strikeUsdg)}</td>
                      <td>{(row.contracts ?? 0n).toString()}</td>
                      <td>{assigned.toString()}</td>
                      <td>{fmtUsdg(row.grossUsdg ?? 0n)}</td>
                      <td>{fmtUsdg(row.feeUsdg ?? 0n)}</td>
                      <td>{fmtUsdg(row.netUsdg ?? 0n)}</td>
                      <td>{perShare === undefined ? "—" : fmtUsdg(perShare, 6)}</td>
                      <td>{fmtRealizedWeek(row.netUsdg ?? 0n, tvl)}</td>
                      <td title={resultLong}>{result}</td>
                      {/* Prefer the closing tx: it is the one carrying the harvest. Truncated
                          hard so twelve columns still fit a laptop; the full hash is the title. */}
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
          &ldquo;Net / TVL&rdquo; is net USDG harvested divided by the vault&apos;s {MARKET} collateral
          valued at the feed spot recorded at harvest. It describes one week and is never scaled to
          a longer period. A dash means the indexer has not recorded a collateral snapshot for that
          harvest.
        </p>
      </div>
    </>
  );
}
