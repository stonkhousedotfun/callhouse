"use client";

import type { ReactNode } from "react";

import { Card, CardHead, CardMeta, CardTitle, Chip, ExternalLink, Notice, PageHead, Stat, Table } from "@/components/ui";
import type { ChipTone, StatTone } from "@/components/ui";
import { txUrl } from "@/lib/chain";
import { MARKET, SHARE_TICKER, VAULT } from "@/lib/contracts";
import type { CycleRow } from "@/lib/api";
import { fmtRealizedWeek, fmtUsdg, fmtUtcDate, premiumPerShare, tvlUsdg } from "@/lib/format";
import { useCycleHistory, weekResult } from "@/lib/history";
import type { WeekResult } from "@/lib/history";

/** A header whose title attribute explains the column: a dotted underline says there is more on hover. */
const HINT = "cursor-help underline decoration-line-2 decoration-dotted underline-offset-4";

/**
 * One of the three summary figures over the table: its own card holding one Stat. W-13 finds each
 * card by the Stat's label (`name` here) and reads the value and the line under it.
 */
function SummaryTile({
  name,
  value,
  sub,
  tone,
  className,
}: {
  name: string;
  value: ReactNode;
  sub: ReactNode;
  tone?: StatTone;
  className?: string;
}) {
  return (
    <Card className={className}>
      <Stat size="lg" label={name} value={value} sub={sub} tone={tone} />
    </Card>
  );
}

/**
 * The Result cell's chip colour. Presentation only: it reads the row and the WeekResult that
 * lib/history.ts already computed, and the words in the chip are unchanged, so colour is never the
 * only thing that says what happened. Open and unfilled weeks are neutral, a filled week is
 * accent, an assigned week is USDG (strike proceeds), a recovered strand or an incomplete record
 * is warn, and a claim still stranded is danger.
 */
function resultTone(row: CycleRow, result: WeekResult): ChipTone {
  if (!row.settled) return "neutral";
  if (row.stranded && row.strandRecovered !== true) return "danger";
  if (row.stranded || result.inconsistent) return "warn";
  if (!row.filled) return "neutral";
  if ((row.contractsAssigned ?? 0n) > 0n) return "usdg";
  return "accent";
}

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
 * later Harvest when the claim is retried; the row then says "recovered" and keeps the mark,
 * because the close did strand and that is history.
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
      <PageHead
        eyebrow="Activity"
        title="Every week, including the zeros"
        lede={
          <p>
            One row per cycle. Filled weeks show what actually landed; weeks where nobody bought the
            call show <strong className="font-semibold text-ink">unfilled, 0</strong>: nothing was written,
            so nothing could be assigned. No week is ever extrapolated to a longer period.
          </p>
        }
      />

      <div className="grid gap-4 sm:gap-5">
        {!VAULT ? (
          <Notice tone="warn" title="No vault address configured.">
            Set <code>NEXT_PUBLIC_VAULT</code> to read the vault&apos;s history.
          </Notice>
        ) : null}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3">
          <SummaryTile
            name="Weeks closed"
            value={settled.length}
            sub={
              <>
                {filled.length} filled · {unfilled.length} unfilled
              </>
            }
          />
          <SummaryTile
            name="Net premium to depositors"
            tone="usdg"
            value={fmtUsdg(totalPremiumNet)}
            sub={<>after {fmtUsdg(totalFee)} protocol fee</>}
          />
          <SummaryTile
            className="sm:col-span-2 lg:col-span-1"
            name="Contracts assigned"
            value={totalAssigned.toString()}
            sub={
              <>
                collateral taken at the strike · {fmtUsdg(totalStrike)} USDG strike proceeds, not premium
              </>
            }
          />
        </div>

        {error ? (
          <Notice tone="warn">
            {error}
          </Notice>
        ) : null}

        <Card>
          <CardHead>
            <CardTitle>Weekly results</CardTitle>
            <CardMeta>
              {source === "indexer" ? "indexer" : source === "chain" ? "rebuilt from vault logs" : "no source"}
            </CardMeta>
          </CardHead>

          <Table
            label="Weekly results"
            bleed
            className="max-lg:[mask-image:linear-gradient(to_right,var(--color-ink)_92%,transparent)]"
          >
            <thead>
              <tr>
                <th>Cycle</th>
                <th>Closed</th>
                <th>Strike</th>
                <th className={HINT} title="contracts sold, each written inside the fill that bought it (the sum of the week's CallsWritten)">Sold</th>
                <th>Assigned</th>
                <th className={HINT} title="premium buyers paid the vault in USDG, strike proceeds excluded">Premium</th>
                <th>Fee</th>
                <th className={HINT} title="premium after the protocol fee, strike proceeds excluded">Net premium</th>
                <th
                  className={HINT}
                  title="Strike proceeds (assignment): USDG received for collateral taken at the strike. Returned principal, not premium."
                >
                  Strike proceeds
                </th>
                <th className={HINT} title={`net premium in USDG per one ${SHARE_TICKER} share`}>Premium/share</th>
                <th className={HINT} title="net premium over collateral valued at the feed spot at harvest">Net/TVL</th>
                <th>Result</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  {/* Table cells are nowrap so numeric columns stay aligned; the empty-state
                      sentence is prose and must wrap instead of dragging the scroll container
                      hundreds of pixels wide on a phone. The `!` beats the Table's td defaults. The
                      inner span caps the sentence at the visible width of the scroll region (viewport
                      minus page gutter, card border and region padding; from 560px a further 16px for a
                      classic scrollbar), so a phone reads it without scrolling the thirteen headers
                      sideways. */}
                  <td colSpan={13} className="whitespace-normal! py-6! text-left! font-body! text-[14.5px] text-ink-2!">
                    <span className="block max-w-[calc(100vw-70px)] sm:max-w-[calc(100vw-110px)]">
                      {!VAULT
                        ? "Set a vault address to load its weekly history."
                        : isLoading
                          ? "Loading…"
                          : source === "none"
                            ? "History is unavailable right now. The vault's own state on the other pages is read straight from the chain and is unaffected."
                            : "No cycle has run yet. The first row appears after the first week closes."}
                    </span>
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
                  // lib/history.ts weekResult: an unfilled week cannot be assigned under write on
                  // fill, so a row claiming both is marked as an incomplete record, not a result.
                  const week = weekResult(row);
                  const { short: result, long: resultLong } = week;
                  return (
                    <tr key={row.cycle}>
                      <td className="font-semibold">#{row.cycle}</td>
                      <td className="text-ink-2!">{fmtUtcDate(row.closedAt)}</td>
                      <td>{row.strikeUsdg === undefined ? "—" : fmtUsdg(row.strikeUsdg)}</td>
                      <td>{sold.toString()}</td>
                      <td>{assigned.toString()}</td>
                      <td>{fmtUsdg(row.premiumGrossUsdg ?? (row.filled ? undefined : 0n))}</td>
                      <td className="text-ink-2!">{fmtUsdg(row.feeUsdg ?? 0n)}</td>
                      <td className="font-semibold text-usdg!">{fmtUsdg(row.premiumNetUsdg ?? (row.filled ? undefined : 0n))}</td>
                      <td>{fmtUsdg(row.strikeProceedsUsdg ?? (assigned > 0n ? undefined : 0n))}</td>
                      <td>{perShare === undefined ? "—" : fmtUsdg(perShare, 6)}</td>
                      <td>{fmtRealizedWeek(row.premiumNetUsdg ?? (row.filled ? undefined : 0n), tvl)}</td>
                      <td title={resultLong} className="cursor-help">
                        <Chip tone={resultTone(row, week)} className="py-1!">
                          {result}
                        </Chip>
                      </td>
                      {/* Prefer the closing tx: it is the one carrying the harvest. Truncated
                          hard so thirteen columns still fit a laptop; the full hash is the title. */}
                      <td>
                        {(() => {
                          const tx = row.txClose ?? row.txOpen;
                          if (!tx) return "—";
                          return (
                            <ExternalLink
                              href={txUrl(tx)}
                              srNote={false}
                              title={tx}
                              className="link text-accent-text"
                            >
                              {`${tx.slice(0, 8)}…`}
                            </ExternalLink>
                          );
                        })()}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </Table>

          <div className="mt-1 grid gap-1.5 border-t border-line pt-4 text-[12.5px] leading-[1.55] text-ink-3 [&>p]:max-w-[78ch]">
            <p>
              &ldquo;Net / TVL&rdquo; is net premium divided by the vault&apos;s {MARKET} collateral
              valued at the feed spot recorded at harvest. It describes one week and is never scaled to
              a longer period. A dash means the indexer has not recorded a collateral snapshot for that
              harvest.
            </p>
            <p>
              &ldquo;Strike proceeds&rdquo; is the USDG received on an assigned week for the collateral
              taken at the strike. It is credited to holders with the premium, but it is returned
              collateral, not earnings, so it is left out of the premium, net premium, per-share and
              Net / TVL columns.
            </p>
            <p>
              &ldquo;Sold&rdquo; is also the number written: each fill writes exactly the contracts it buys, so the
              vault is never assigned on more than it sold.
            </p>
          </div>
        </Card>
      </div>
    </>
  );
}
