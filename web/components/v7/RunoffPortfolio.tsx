"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { formatUnits, type Address, type WalletClient } from "viem";
import { useAccount, useWalletClient } from "wagmi";

import { ConnectButton } from "@/components/ConnectButton";
import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import { Button, Notice, PageHead, Panel } from "@/components/ui";
import type { V7PositionsResponse } from "@/lib/v7/api-schema";
import { v7Api } from "@/lib/v7/api";
import {
  cancelV7,
  claimOwedV7,
  closeV7,
  redeemV7,
  withdrawV7,
  type V7WriteContext,
} from "@/lib/v7/tx";

type Long = V7PositionsResponse["longs"][number];
type Short = V7PositionsResponse["shorts"][number];
type Order = V7PositionsResponse["orders"][number];
type LedgerRow = V7PositionsResponse["ledger"][number];

const date = (unix: number) => new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric",
}).format(new Date(unix * 1_000));
const shares = (units: bigint) => formatUnits(units, 2);
const optionLabel = (position: { series: Long["series"] }) =>
  `${position.series.ticker} $${position.series.strike.formatted} ${position.series.isPut ? "put" : "call"}`;

type Run = (id: string, title: string, write: (context: V7WriteContext) => Promise<unknown>) => Promise<void>;

function PositionCard({ position, busy, run }: { position: Long; busy: string | null; run: Run }) {
  const redeemable = position.series.status === "settled" || position.claimable !== null;
  return <Panel as="article">
    <p className="text-xs font-semibold uppercase tracking-wider text-ink-2">v7 long</p>
    <h2 className="mt-1 font-display text-xl font-bold">{optionLabel(position)}</h2>
    <p className="mt-1 text-sm text-ink-2">Expires {date(position.series.expiry)} · {shares(BigInt(position.units))} shares</p>
    <p className="mt-3 text-sm">{redeemable
      ? `Recorded payout: ${position.claimable?.formatted ?? "available on chain"}.`
      : "This position stays visible until its v7 settlement is ready."}</p>
    {redeemable ? <Button className="mt-4" size="sm" disabled={Boolean(busy)}
      onClick={() => void run(`redeem-${position.series.longId}`, "v7 payout collected",
        (context) => redeemV7(context, BigInt(position.series.longId)))}>
      Redeem v7 long
    </Button> : null}
  </Panel>;
}

function MatchedCard({ long, short, units, busy, run }: {
  long: Long; short: Short; units: bigint; busy: string | null; run: Run;
}) {
  return <Panel as="article">
    <p className="text-xs font-semibold uppercase tracking-wider text-ink-2">Matched v7 pair</p>
    <h2 className="mt-1 font-display text-xl font-bold">{optionLabel(long)}</h2>
    <p className="mt-2 text-sm text-ink-2">Close {shares(units)} matched shares to release the v7 collateral recorded for this pair.</p>
    <Button className="mt-4" size="sm" disabled={Boolean(busy)}
      onClick={() => void run(`close-${long.series.longId}`, "v7 pair closed",
        (context) => closeV7(context, BigInt(long.series.longId), units))}>
      Close matched pair
    </Button>
    <span className="sr-only">Short balance {short.units} units</span>
  </Panel>;
}

function OrderCard({ order, busy, run }: { order: Order; busy: string | null; run: Run }) {
  const remaining = BigInt(order.units) - BigInt(order.filled);
  return <Panel as="article">
    <p className="text-xs font-semibold uppercase tracking-wider text-ink-2">Open v7 order</p>
    <h2 className="mt-1 font-display text-xl font-bold">{optionLabel(order)}</h2>
    <p className="mt-2 text-sm text-ink-2">{order.kind} · {shares(remaining)} shares remaining · {order.price.formatted} USDG</p>
    <Button className="mt-4" size="sm" variant="ghost" disabled={Boolean(busy) || remaining <= 0n}
      onClick={() => void run(`cancel-${order.orderId}`, "v7 order cancelled",
        (context) => cancelV7(context, BigInt(order.orderId)))}>
      Cancel order
    </Button>
  </Panel>;
}

function LedgerCard({ row, busy, run }: { row: LedgerRow; busy: string | null; run: Run }) {
  const amount = BigInt(row.free.raw);
  return <Panel as="article">
    <p className="text-xs font-semibold uppercase tracking-wider text-ink-2">Free v7 balance</p>
    <h2 className="mt-1 font-display text-xl font-bold">{row.free.formatted} {row.symbol}</h2>
    <p className="mt-2 text-sm text-ink-2">Withdraws this free ledger balance to the connected wallet.</p>
    <Button className="mt-4" size="sm" variant="ghost" disabled={Boolean(busy) || amount <= 0n}
      onClick={() => void run(`withdraw-${row.asset}`, `v7 ${row.symbol} withdrawn`,
        (context) => withdrawV7(context, row.asset as Address, amount))}>
      Withdraw {row.symbol}
    </Button>
  </Panel>;
}

export function RunoffPortfolio() {
  const { address } = useAccount();
  const wallet = useWalletClient();
  const queryClient = useQueryClient();
  const notice = useNotice();
  const unknownReceipt = useV2ReceiptNotice();
  const [busy, setBusy] = useState<string | null>(null);
  const positions = useQuery({
    queryKey: ["v7", "positions", address?.toLowerCase()],
    enabled: Boolean(address),
    queryFn: ({ signal }) => v7Api.getPositions(address!, signal),
    staleTime: 15_000,
    refetchInterval: 15_000,
  });
  const matched = useMemo(() => {
    if (!positions.data) return [];
    const longs = new Map(positions.data.longs.map((position) => [position.series.longId, position]));
    return positions.data.shorts.flatMap((short) => {
      const long = longs.get(short.series.longId);
      if (!long || short.series.status === "settled") return [];
      const units = BigInt(long.units) < BigInt(short.units) ? BigInt(long.units) : BigInt(short.units);
      return units > 0n ? [{ long, short, units }] : [];
    });
  }, [positions.data]);

  async function run(id: string, title: string, write: (context: V7WriteContext) => Promise<unknown>) {
    if (!address || !wallet.data || busy) return;
    setBusy(id);
    try {
      notice("pending", title, "Review the v7 contract address and transaction in your wallet.");
      await write({
        account: address,
        wallet: wallet.data as WalletClient,
        onConfirmed: () => queryClient.invalidateQueries({ queryKey: ["v7"] }),
      });
      notice("success", title, "Confirmed on the frozen v7 deployment. The v7 indexer may take a moment to refresh.");
      await queryClient.invalidateQueries({ queryKey: ["v7"] });
    } catch (error) {
      if (!unknownReceipt(error)) {
        notice("error", `${title} stopped`, error instanceof Error ? error.message : "The v7 transaction could not be completed.");
      }
    } finally {
      setBusy(null);
    }
  }

  return <>
    <PageHead eyebrow="Legacy v7" title="Wind down your v7 positions."
      lede="This page reads the frozen v7 indexer and sends exit transactions only to the frozen v7 contracts. It cannot open new v7 risk."
      aside={<ConnectButton />} />
    <Notice tone="warn" className="mb-5" title="v7 is frozen">
      New v7 writes are not offered. Existing positions remain redeemable after settlement. Open interest of zero does not mean every payout or free balance has already been collected.
    </Notice>
    {!address ? <Panel><p className="text-ink-2">Connect the wallet that holds the v7 position or ledger balance.</p></Panel>
      : positions.isPending ? <Panel role="status">Loading this wallet from the dedicated v7 indexer…</Panel>
        : positions.isError || !positions.data ? <Notice tone="warn" role="alert">
          The dedicated v7 indexer is unavailable or returned an unexpected response. No v8 data is used as a fallback, and v7 actions stay hidden.
        </Notice>
          : <div className="grid gap-6">
            <section aria-labelledby="v7-positions-heading">
              <h2 id="v7-positions-heading" className="font-display text-2xl font-bold">Positions and matched pairs</h2>
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                {positions.data.longs.map((position) => <PositionCard key={position.series.longId} position={position} busy={busy} run={run} />)}
                {matched.map((pair) => <MatchedCard key={`matched-${pair.long.series.longId}`} {...pair} busy={busy} run={run} />)}
                {!positions.data.longs.length && !matched.length ? <Panel><p className="text-ink-2">No v7 long or matched position is reported for this wallet.</p></Panel> : null}
              </div>
            </section>
            <section aria-labelledby="v7-orders-heading">
              <h2 id="v7-orders-heading" className="font-display text-2xl font-bold">Resting orders</h2>
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                {positions.data.orders.map((order) => <OrderCard key={order.orderId} order={order} busy={busy} run={run} />)}
                {!positions.data.orders.length ? <Panel><p className="text-ink-2">No resting v7 orders are reported.</p></Panel> : null}
              </div>
            </section>
            <section aria-labelledby="v7-balances-heading">
              <h2 id="v7-balances-heading" className="font-display text-2xl font-bold">Free balances</h2>
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                {positions.data.ledger.filter((row) => BigInt(row.free.raw) > 0n)
                  .map((row) => <LedgerCard key={row.asset} row={row} busy={busy} run={run} />)}
                {!positions.data.ledger.some((row) => BigInt(row.free.raw) > 0n) ? <Panel><p className="text-ink-2">No free v7 ledger balance is reported.</p></Panel> : null}
              </div>
            </section>
            <Panel>
              <h2 className="font-display text-xl font-bold">Unclaimed order proceeds</h2>
              <p className="mt-2 text-sm text-ink-2">Claims any USDG the frozen v7 OrderBook already records as owed to this wallet.</p>
              <Button className="mt-4" size="sm" variant="ghost" disabled={Boolean(busy)}
                onClick={() => void run("claim-owed", "v7 order proceeds claimed", claimOwedV7)}>
                Claim owed USDG
              </Button>
            </Panel>
          </div>}
  </>;
}
