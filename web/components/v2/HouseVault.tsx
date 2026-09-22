"use client";

/**
 * The House vault page for one market: deposit, request withdrawal, epoch countdown, past epochs,
 * in-kind preview, disclosures.
 *
 * This component ASSEMBLES. It authors no arithmetic and no disclosure copy: the figures come from
 * `web/lib/v2/houseRows.ts` (which in turn only routes `houseEpoch.ts`'s maths), the four disclosures
 * come from `web/lib/v2/houseCopy.ts`, and every write goes through `web/lib/v2/houseTx.ts`, which is
 * built on `simulatedWrite`/`approveExact` in `web/lib/v2/tx.ts:30-71`. Shape follows
 * `web/components/v2/LendVault.tsx` and `EarnMarket.tsx:92-120` — `useAccount`/`useWalletClient`,
 * `useNotice`/`useV2ReceiptNotice`, `Button/Notice/PageHead/Panel/Table` from `@/components/ui`, and
 * `useQueryClient` invalidating by the `v2Keys` prefix.
 *
 * NO LIVE SHARE PRICE ANYWHERE ON THIS PAGE. A NAV appears only as a boundary figure and is labelled
 * with the boundary it was struck at ({navCellLabel}); a running epoch shows the unavailable message.
 * There is no "you will receive N shares" estimate — a deposit states that it joins at the next
 * boundary and is valued there, which is {houseCountdown}'s `depositJoinsSentence`.
 *
 * PAST EPOCHS ARE FACTS, LOSING ONES INCLUDED. The table renders exactly what {pastEpochRows} returns,
 * in order, with no aggregate row, no average, no cumulative line and no streak. The sign lives in
 * `row.outcome`, and the "lost" case renders the same way every other case does.
 */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { formatUnits, parseUnits, type Address } from "viem";
import { useAccount, useWalletClient } from "wagmi";

import { ConnectButton } from "@/components/ConnectButton";
import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import { Button, Notice, PageHead, Panel, Table } from "@/components/ui";
import { HouseArmNotice, useHouseDepositsOpen } from "@/components/v2/LaunchCountdown";
import { WithdrawalTerms } from "@/components/v2/WithdrawalTerms";
import { USDG, USDG_DECIMALS } from "@/lib/contracts";
import { v2Markets } from "@/lib/markets";
import type { HouseQueueItem } from "@/lib/v2/api-types";
import { NAV_NOT_AVAILABLE, STOCK_DECIMALS, SHARE_DECIMALS } from "@/lib/v2/houseEpoch";
import { HOUSE_DISCLOSURES } from "@/lib/v2/houseCopy";
import { houseCountdown, houseInKindPreview, navCellLabel, pastEpochRows } from "@/lib/v2/houseRows";
import {
  cancelHouseDepositRequest, cancelHouseWithdrawRequest, claimHouseOwed, claimHouseWithdrawal,
  requestHouseDeposit, requestHouseWithdraw,
} from "@/lib/v2/houseTx";
import { useHouseMarket, v2Keys } from "@/lib/v2/hooks";
import type { WriteContext } from "@/lib/v2/tx";

const usdg = (raw: bigint) => Number(formatUnits(raw, USDG_DECIMALS)).toLocaleString("en-US", { maximumFractionDigits: 6 });
const shares = (raw: bigint) => Number(formatUnits(raw, SHARE_DECIMALS)).toLocaleString("en-US", { maximumFractionDigits: 6 });

function queuedAmount(item: HouseQueueItem): string {
  if (item.kind === "withdraw") {
    return item.shares === null ? "shares unavailable" : `${item.shares} shares`;
  }

  const nonzero: string[] = [];
  if (item.assets !== null && BigInt(item.assets) !== 0n)
    nonzero.push(`${formatUnits(BigInt(item.assets), USDG_DECIMALS)} USDG`);
  if (item.stockAmount !== null && item.stockAmount !== undefined && BigInt(item.stockAmount) !== 0n)
    nonzero.push(`${formatUnits(BigInt(item.stockAmount), STOCK_DECIMALS)} Stock Tokens`);
  if (nonzero.length > 0) return nonzero.join(" and ");

  // A wire zero is an observed amount; null or an omitted legacy field is not. Preserve that
  // distinction even for a malformed all-zero deposit instead of inventing a missing leg.
  if (item.assets !== null) return `${formatUnits(BigInt(item.assets), USDG_DECIMALS)} USDG`;
  if (item.stockAmount !== null && item.stockAmount !== undefined)
    return `${formatUnits(BigInt(item.stockAmount), STOCK_DECIMALS)} Stock Tokens`;
  return "amount unavailable";
}

function parsePositive(raw: string, decimals: number): bigint | null {
  try { const amount = parseUnits(raw, decimals); return amount > 0n ? amount : null; } catch { return null; }
}

/** Whole seconds, as a countdown a reader can check against a clock. No relative-time prose. */
function countdownLabel(secondsRemaining: number): string {
  const days = Math.floor(secondsRemaining / 86_400);
  const hours = Math.floor((secondsRemaining % 86_400) / 3_600);
  const minutes = Math.floor((secondsRemaining % 3_600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

export function HouseVault({ ticker }: { ticker: string }) {
  // Deposits are shut until the vault is armed (owner, 2026-09-22); withdrawals, claims and the roll are not.
  // Fail closed: `open` is false while the arming is unread. HouseArmNotice above carries the clock and why.
  const { open: depositsOpen } = useHouseDepositsOpen(ticker);
  const { address } = useAccount();
  const wallet = useWalletClient();
  const notice = useNotice();
  const unknownReceipt = useV2ReceiptNotice();
  const queryClient = useQueryClient();
  const house = useHouseMarket(ticker, address);
  const registryMarket = v2Markets().find((row) => row.ticker === ticker);
  const underlying = (registryMarket?.asset ?? null) as Address | null;
  const vault = house.data?.vault ?? null;

  const [depositUsdg, setDepositUsdg] = useState("");
  const [depositStock, setDepositStock] = useState("");
  const [withdrawShares, setWithdrawShares] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  // The countdown ticks locally; the epoch boundary itself is the API's, never recomputed here.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(timer);
  }, []);

  function context(): WriteContext {
    if (!address || !wallet.data) throw new Error("Connect your wallet first.");
    return {
      account: address,
      wallet: wallet.data,
      onConfirmed: async () => { await queryClient.invalidateQueries({ queryKey: v2Keys.houseMarket(ticker, address) }); },
    };
  }

  async function act(label: string, task: () => Promise<string>) {
    setBusy(label);
    try {
      notice("pending", label, "Review each requested transaction in your wallet.");
      notice("success", label, await task());
    } catch (error) {
      if (!unknownReceipt(error))
        notice("error", `${label} stopped`, error instanceof Error ? error.message : "Try again after refreshing.");
    } finally { setBusy(null); }
  }

  const current = house.data?.currentEpoch ?? null;
  const countdown = current?.end !== null && current?.end !== undefined ? houseCountdown(now, current) : null;
  const rows = pastEpochRows(house.data?.epochs ?? []);
  const preview = house.data ? houseInKindPreview(house.data) : null;
  const held = house.data?.shares?.shares ?? null;
  const queued = house.data?.shares?.queued ?? [];

  return <>
    <PageHead eyebrow={`${ticker} house vault`} title="Deposit into the house vault."
      lede="The house vault quotes this market's book with depositor money. Deposits and withdrawals settle once a week, at the epoch boundary." />

    {/* The four required disclosures, rendered from houseCopy.ts and never retyped here. */}
    <Notice tone="warn" className="mb-5">
      {HOUSE_DISCLOSURES.map((line) => <p key={line} className="mb-2 last:mb-0">{line}</p>)}
    </Notice>

    {!vault ? <Notice tone="info" className="mb-5">The house vault for {ticker} is not deployed yet. Deposits open when it is.</Notice> : <HouseArmNotice ticker={ticker} />}
    {house.isError ? <Notice tone="warn" className="mb-5">The house vault figures are unavailable right now. Nothing below is current.</Notice> : null}
    {!address ? <Panel className="mb-5"><p className="mb-4 text-ink-2">Connect a wallet to deposit or request a withdrawal.</p><ConnectButton /></Panel> : null}

    <div className="grid gap-5 lg:grid-cols-2">
      <Panel as="section" aria-label="Epoch">
        <h2 className="font-display text-xl font-bold">This epoch</h2>
        {countdown ? <>
          <p className="mt-3 text-ink-2">Epoch {current?.id} ends in <span className="num">{countdownLabel(countdown.secondsRemaining)}</span>, at {countdown.boundaryLabel}.</p>
          <p className="mt-2 text-ink-2">{countdown.depositJoinsSentence}</p>
          <p className="mt-2 text-ink-3">Share price: {NAV_NOT_AVAILABLE}.</p>
        </> : <p className="mt-3 text-ink-3">Epoch figures are unavailable.</p>}
        {held !== null ? <p className="mt-3 text-ink-2">Your shares: <span className="num">{shares(BigInt(held))}</span></p> : null}
        {queued.length ? <ul className="mt-3 text-ink-2">
          {queued.map((item, index) => <li key={`${item.kind}-${item.requestedAt}-${item.account}-${index}`} className="mb-1">
            Queued {item.kind}: {queuedAmount(item)}, requested at {item.requestedAt}.
          </li>)}
        </ul> : null}
      </Panel>

      <Panel as="section" aria-label="Deposit">
        <h2 className="font-display text-xl font-bold">Deposit</h2>
        <WithdrawalTerms className="mt-4" surface="house" boundaryAt={current?.end ?? null} now={now} />
        <label htmlFor="house-deposit-usdg" className="mt-4 block text-sm font-semibold">USDG</label>
        <input id="house-deposit-usdg" inputMode="decimal" value={depositUsdg} onChange={(event) => setDepositUsdg(event.target.value)}
          placeholder="100" className="num mt-2 min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" />
        <Button size="sm" className="mt-3 w-full" disabled={!depositsOpen || !vault || !address || !!busy || !parsePositive(depositUsdg, USDG_DECIMALS)}
          onClick={() => void act("Deposit USDG into the house vault", async () => {
            const amount = parsePositive(depositUsdg, USDG_DECIMALS);
            if (!amount) throw new Error("Enter a positive deposit.");
            await requestHouseDeposit(context(), vault, USDG, amount);
            setDepositUsdg("");
            return "Deposit queued. It joins at the next boundary.";
          })}>Queue USDG deposit</Button>

        <label htmlFor="house-deposit-stock" className="mt-5 block text-sm font-semibold">Stock Tokens</label>
        <input id="house-deposit-stock" inputMode="decimal" value={depositStock} onChange={(event) => setDepositStock(event.target.value)}
          placeholder="1" className="num mt-2 min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" />
        <Button size="sm" variant="ghost" className="mt-3 w-full"
          disabled={!depositsOpen || !vault || !address || !underlying || !!busy || !parsePositive(depositStock, STOCK_DECIMALS)}
          onClick={() => void act("Deposit Stock Tokens into the house vault", async () => {
            const amount = parsePositive(depositStock, STOCK_DECIMALS);
            if (!amount) throw new Error("Enter a positive deposit.");
            if (!underlying) throw new Error("This market has no Stock Token address in the registry.");
            await requestHouseDeposit(context(), vault, underlying, amount);
            setDepositStock("");
            return "Deposit queued. It joins at the next boundary.";
          })}>Queue Stock Token deposit</Button>

        <Button size="sm" variant="ghost" className="mt-3 w-full" disabled={!vault || !address || !!busy}
          onClick={() => void act("Cancel queued deposit", async () => {
            await cancelHouseDepositRequest(context(), vault);
            return "Queued deposit cancelled.";
          })}>Cancel queued deposit</Button>
      </Panel>

      <Panel as="section" aria-label="Withdraw">
        <h2 className="font-display text-xl font-bold">Request a withdrawal</h2>
        <label htmlFor="house-withdraw" className="mt-4 block text-sm font-semibold">Shares</label>
        <input id="house-withdraw" inputMode="decimal" value={withdrawShares} onChange={(event) => setWithdrawShares(event.target.value)}
          placeholder="1" className="num mt-2 min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink" />
        {/* Same boundary terms as the deposit side. A request placed here is served at the next boundary, and
            that has to be on screen before the button, not in the toast after it (plan section 5.5). */}
        <WithdrawalTerms className="mt-3" surface="house" boundaryAt={current?.end ?? null} now={now} />
        <Button size="sm" className="mt-3 w-full" disabled={!vault || !address || !!busy || !parsePositive(withdrawShares, SHARE_DECIMALS)}
          onClick={() => void act("Request a house vault withdrawal", async () => {
            const amount = parsePositive(withdrawShares, SHARE_DECIMALS);
            if (!amount) throw new Error("Enter a positive share amount.");
            await requestHouseWithdraw(context(), vault, amount);
            setWithdrawShares("");
            return "Withdrawal queued until the next boundary.";
          })}>Request withdrawal</Button>
        <Button size="sm" variant="ghost" className="mt-3 w-full" disabled={!vault || !address || !!busy}
          onClick={() => void act("Cancel queued withdrawal", async () => {
            await cancelHouseWithdrawRequest(context(), vault);
            return "Queued withdrawal cancelled.";
          })}>Cancel queued withdrawal</Button>
        <Button size="sm" variant="ghost" className="mt-3 w-full" disabled={!vault || !address || !!busy}
          onClick={() => void act("Claim a settled withdrawal", async () => {
            await claimHouseWithdrawal(context(), vault);
            return "Claim submitted.";
          })}>Claim settled withdrawal</Button>
        <Button size="sm" variant="ghost" className="mt-3 w-full" disabled={!vault || !address || !!busy}
          onClick={() => void act("Claim what the vault still owes you", async () => {
            await claimHouseOwed(context(), vault);
            return "Claim submitted.";
          })}>Claim what is still owed</Button>
      </Panel>

      <Panel as="section" aria-label="In-kind withdrawal preview">
        <h2 className="font-display text-xl font-bold">In-kind withdrawal preview</h2>
        {preview !== null && preview.available
          ? <p className="mt-3 text-ink-2">You receive <span className="num">{usdg(preview.usdgOut)}</span> USDG and <span className="num">{formatUnits(preview.stockOut, STOCK_DECIMALS)}</span> Stock Tokens.</p>
          : <p className="mt-3 text-ink-3">{preview === null ? NAV_NOT_AVAILABLE : preview.message}. A withdrawal is paid as your slice of the vault&apos;s USDG and your slice of its stock, struck at the boundary.</p>}
      </Panel>
    </div>

    <Panel as="section" aria-label="Past epochs" className="mt-5">
      <h2 className="font-display text-xl font-bold">Past epochs</h2>
      {rows.length === 0
        ? <p className="mt-3 text-ink-3">No epoch has settled yet.</p>
        : <Table label={`${ticker} house vault epochs`} className="mt-4">
            <thead><tr>
              <th className="!text-left">Epoch</th><th>Started</th><th>Ended</th><th>NAV (USDG)</th><th>Struck</th><th>Settlement price</th><th>Result (USDG)</th>
            </tr></thead>
            <tbody>
              {rows.map((row) => <tr key={row.id} data-outcome={row.outcome}>
                <td className="!text-left">{row.id}</td>
                <td>{row.startLabel}</td>
                <td>{row.endLabel}</td>
                <td className="num">{row.nav.available ? usdg(row.nav.navUsdg) : NAV_NOT_AVAILABLE}</td>
                <td>{navCellLabel(row)}</td>
                <td className="num">{row.settlementPrice ?? "—"}</td>
                <td className="num">{row.resultUsdg === null ? "not reported" : usdg(row.resultUsdg)}</td>
              </tr>)}
            </tbody>
          </Table>}
    </Panel>
  </>;
}
