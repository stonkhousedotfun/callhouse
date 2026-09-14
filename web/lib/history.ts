"use client";

import { useQuery } from "@tanstack/react-query";
import { parseEventLogs, type Abi, type Hex, type Log } from "viem";

import { fetchCycles, type CycleRow } from "./api";
import { archiveClient } from "./chain";
import { VAULT, VAULT_FROM_BLOCK, vaultAbi } from "./contracts";

/**
 * Weekly history.
 *
 * Preferred source is the indexer (plan §6). But history is the one thing a user cannot check
 * for themselves from a single chain read, and "the indexer is down" must never look the same as
 * "the vault has never earned anything". So when the indexer is unreachable this falls back to
 * reading the vault's own logs directly.
 *
 * The fallback uses `archiveClient` — the PRIMARY RPC only. The backup RPC answers
 * "Archive requests require a personal token" for an old eth_getLogs range, and a fallback
 * transport would hand that back as if it were an empty result set.
 */

/**
 * eth_getLogs over a range, halving the range whenever the node refuses or times out.
 *
 * The primary RPC serves a full 0 → latest range for a single address, but "serves" is a
 * function of how many logs are in it. Rather than guess a chunk size, this asks for the whole
 * thing and only splits when the node says no. Set NEXT_PUBLIC_VAULT_FROM_BLOCK to the deploy
 * block and the first attempt almost always succeeds.
 */
type Budget = { requests: number; deadline: number };

async function getLogsChunked(
  address: `0x${string}`,
  from: bigint,
  to: bigint,
  depth: number,
  budget: Budget,
): Promise<Log[]> {
  // A hard budget, because splitting a range that a node simply will not serve turns into an
  // unbounded walk. Blowing the budget is an error the page reports, not a spinner that never
  // resolves.
  if (budget.requests <= 0 || Date.now() > budget.deadline) {
    throw new Error("log scan budget exhausted — set NEXT_PUBLIC_VAULT_FROM_BLOCK to the deploy block");
  }
  budget.requests -= 1;
  try {
    return await archiveClient.getLogs({ address, fromBlock: from, toBlock: to });
  } catch (err) {
    // 64 chunks is the floor. Below that the range is not the problem and the error is real.
    if (depth >= 6 || to - from < 2n) throw err;
    // Sequential, not Promise.all: a parallel split would fan out to 64 simultaneous archive
    // queries against a public RPC at the deepest level.
    const mid = from + (to - from) / 2n;
    const head = await getLogsChunked(address, from, mid, depth + 1, budget);
    const tail = await getLogsChunked(address, mid + 1n, to, depth + 1, budget);
    return [...head, ...tail];
  }
}

/** A decoded vault log, as viem's `parseEventLogs` shapes it, with nothing assumed present. */
export type LooseLog = {
  eventName?: string;
  args?: Record<string, unknown>;
  blockNumber?: bigint;
  transactionHash?: Hex | null;
};

function arg(log: LooseLog, key: string): unknown {
  return log.args?.[key];
}

function toBig(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  return undefined;
}

function toNum(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return undefined;
}

const WAD = 10n ** 18n;

/** A row with the blocks that opened and closed it, before those are turned into timestamps. */
export type ChainDraft = CycleRow & { openBlock?: bigint; closeBlock?: bigint };

/**
 * Fold decoded vault logs, in block order, into one draft row per cycle.
 *
 * Pure on purpose: no RPC, no clock, no timestamps (those are one `getBlock` per boundary
 * block, done by the caller). It is exported so web/lib/history.test.ts can feed it the exact
 * event sequence a paying week with a mid-week deposit produces; the page itself only ever
 * goes through `useCycleHistory`.
 *
 * WRITE ON FILL. `RollOpen.contractsCount` is always 0: the vault arms an option type and writes
 * nothing. Every Seaport fill then emits one `CallsWritten` from inside `authorizeOrder` with the
 * contracts that fill sold, so the week's size is the SUM of its `CallsWritten`, and written
 * equals sold by construction (contracts/README.md "Write on fill").
 *
 * A STRANDED CLOSE. `rollClose` whose Valorem redeem reverts emits `ClaimStranded` beside a
 * `RollClose` with zero legs; the week is closed and harvested (premium only) but the claim's
 * strike USDG is still inside Valorem. `retryStrandedClaim` later emits `StrandedClaimRecovered`
 * and a `Harvest` carrying the stranded cycle's number, in its own transaction. That Harvest is
 * fee-free on the recovered USDG (`_harvest(usdgReturned − queueUsdg)`), so it is folded onto the
 * closed row as strike proceeds, never as premium.
 */
export function foldVaultLogs(logs: LooseLog[]): ChainDraft[] {
  const rows = new Map<number, ChainDraft>();
  const ensure = (cycle: number): ChainDraft => {
    let row = rows.get(cycle);
    if (!row) {
      // Every row here starts from one of the vault's own events, so the vault armed it.
      // The weeks it sat out leave no vault log and are known only to the indexer.
      row = { cycle, wrote: true, filled: false, settled: false };
      rows.set(cycle, row);
    }
    return row;
  };

  // Pass one: UsdgDistributed carries the vault's total supply at the instant of distribution,
  // which is the denominator of "USDG per share" for that week. It has no cycle number, so it is
  // paired to its Harvest by transaction hash: `_accrueHarvest` calls `_distributeUsdg`, which
  // emits it, inside the same call that then emits Harvest.
  const supplyByTx = new Map<string, bigint>();
  // Also pass one: the strike proceeds of each close, by transaction (W-21). `rollClose` emits
  // `RollClose(…, usdgFromAssignment, …)` and then, in the same transaction, the terminal
  // `Harvest` whose `grossUsdg` INCLUDES that amount — and whose fee was charged on
  // `grossUsdg − usdgFromAssignment` alone. So that harvest is split here into premium and
  // strike proceeds using the RollClose from its own transaction, exactly as the indexer does
  // (indexer/lib/harvest.ts). A checkpoint Harvest from a deposit shares no transaction with a
  // RollClose and is premium through and through.
  const assignmentUsdgByTx = new Map<string, bigint>();
  // And the recoveries: `StrandedClaimRecovered(gen, assets, usdgOut, queueWad)` shares its
  // transaction with a `Harvest` whose fee-free part is `usdgOut − usdgOut × queueWad / 1e18`
  // (the queue's slice goes to the settled epochs, not through the harvest).
  const recoveredUsdgByTx = new Map<string, bigint>();
  for (const log of logs) {
    if (!log.transactionHash) continue;
    if (log.eventName === "UsdgDistributed") {
      const supply = toBig(arg(log, "totalSupply"));
      if (supply !== undefined) supplyByTx.set(log.transactionHash, supply);
    } else if (log.eventName === "RollClose") {
      const assignment = toBig(arg(log, "usdgFromAssignment"));
      if (assignment !== undefined) assignmentUsdgByTx.set(log.transactionHash, assignment);
    } else if (log.eventName === "StrandedClaimRecovered") {
      const usdgOut = toBig(arg(log, "usdgOut"));
      const queueWad = toBig(arg(log, "queueWad")) ?? 0n;
      if (usdgOut !== undefined) recoveredUsdgByTx.set(log.transactionHash, usdgOut - (usdgOut * queueWad) / WAD);
    }
  }

  // Walk in block order so "the cycle currently open" is well defined when we hit a
  // ListingApproved or a CallsWritten, which carry an optionId or a claimKey but no cycle number.
  let currentCycle: number | undefined;
  // The cycle whose claim is stranded, if any: the recovery's Harvest folds onto it.
  let strandedCycle: number | undefined;

  for (const log of logs) {
    switch (log.eventName) {
      case "RollOpen": {
        const cycle = toNum(arg(log, "cycleNumber"));
        if (cycle === undefined) break;
        currentCycle = cycle;
        const row = ensure(cycle);
        row.optionId = toBig(arg(log, "optionId"));
        // Always 0 under write on fill; kept as the starting point of the CallsWritten sum so a
        // pre-redesign log (the opening write) still folds correctly.
        row.contracts = toBig(arg(log, "contractsCount")) ?? 0n;
        row.contractsSold = row.contracts;
        row.strikeUsdg = toBig(arg(log, "strikeUsdg"));
        row.txOpen = log.transactionHash ?? undefined;
        row.openBlock = log.blockNumber;
        break;
      }
      case "CallsWritten": {
        // One per FILL, from inside authorizeOrder. Summed onto the open cycle: written == sold.
        // The pre-redesign opening write preceded RollOpen in the same transaction while
        // `currentCycle` still named the closed week; that one is skipped (settled row) so an old
        // log range does not restate a published week.
        if (currentCycle === undefined) break;
        const row = ensure(currentCycle);
        if (row.settled) break;
        const n = toBig(arg(log, "contractsCount"));
        if (n === undefined) break;
        row.contracts = (row.contracts ?? 0n) + n;
        row.contractsSold = row.contracts;
        row.filled = row.contracts > 0n;
        break;
      }
      case "ListingApproved": {
        if (currentCycle === undefined) break;
        const row = ensure(currentCycle);
        // The latest approved hash wins: relisting cancels the previous order on-chain, so the
        // most recent ListingApproved is the one Seaport will honour.
        row.orderHash = arg(log, "orderHash") as Hex | undefined;
        break;
      }
      case "ClaimStranded": {
        const cycle = toNum(arg(log, "cycleNumber"));
        if (cycle === undefined) break;
        ensure(cycle).stranded = true;
        strandedCycle = cycle;
        break;
      }
      case "StrandedClaimRecovered": {
        // The claim is home. The row stays marked stranded (it is history: the close did strand)
        // and its recovery Harvest, in this same transaction, is accepted below.
        break;
      }
      case "RollClose": {
        const cycle = toNum(arg(log, "cycleNumber"));
        if (cycle === undefined) break;
        const row = ensure(cycle);
        row.contractsAssigned = toBig(arg(log, "contractsAssignedCount"));
        row.txClose = log.transactionHash ?? undefined;
        row.closeBlock = log.blockNumber;
        row.settled = true;
        break;
      }
      case "Harvest": {
        const cycle = toNum(arg(log, "cycleNumber"));
        if (cycle === undefined) break;
        const row = ensure(cycle);
        const recovered = log.transactionHash ? recoveredUsdgByTx.get(log.transactionHash) : undefined;
        // A checkpoint that lands AFTER the week closed still carries the closed week's number:
        // rollClose does not clear `cycleNumber` (Vault.sol only assigns it in rollOpen), and a
        // deposit between rollClose and the next rollOpen sweeps whatever USDG arrived since —
        // a stray transfer, say. That must not restate a published week; summed onto this row it
        // would flip a published "unfilled, 0" to "filled". Once closed, the row accepts only
        // the terminal Harvest, which shares rollClose's transaction, and the recovery Harvest of
        // its own stranded claim. The indexer's rule is the same (`touchesCycle`,
        // indexer/src/vault.ts). Without a close hash there is nothing to compare against, and
        // the sum proceeds as before rather than dropping real money.
        const isRecovery = recovered !== undefined && row.stranded === true && strandedCycle === cycle;
        if (row.settled && row.txClose !== undefined && log.transactionHash !== row.txClose && !isRecovery) break;
        // Accumulated, not assigned. Vault.sol emits Harvest from two places with the same
        // cycle number: `_checkpointHarvest()` on every deposit or mint that lands after premium
        // has already arrived (so the new shares cannot claim it), and `_harvest()` inside
        // rollClose, which always emits and carries gross 0 once the checkpoints have swept the
        // balance. Assigning here made the last event win, and on a paying week with one
        // mid-week deposit the last event is the zero: the week rendered as "unfilled, 0". The
        // indexer sums (indexer/src/vault.ts, "Accumulated, not assigned"); this is the same fold.
        const gross = toBig(arg(log, "grossUsdg")) ?? 0n;
        const fee = toBig(arg(log, "feeUsdg")) ?? 0n;
        const net = toBig(arg(log, "netUsdg")) ?? 0n;
        // The strike-proceeds part of this sweep: the RollClose in the same transaction, or the
        // recovered claim's fee-free USDG, clamped to what the sweep found; 0 for a checkpoint.
        // What is left of the gross is premium.
        const feeFree = isRecovery
          ? recovered
          : log.transactionHash
            ? (assignmentUsdgByTx.get(log.transactionHash) ?? 0n)
            : 0n;
        const strike = feeFree < gross ? feeFree : gross;
        const premiumGross = gross - strike;
        const premiumNet = premiumGross > fee ? premiumGross - fee : 0n;
        row.harvestGrossUsdg = (row.harvestGrossUsdg ?? 0n) + gross;
        row.feeUsdg = (row.feeUsdg ?? 0n) + fee;
        row.creditedUsdg = (row.creditedUsdg ?? 0n) + net;
        row.strikeProceedsUsdg = (row.strikeProceedsUsdg ?? 0n) + strike;
        row.premiumGrossUsdg = (row.premiumGrossUsdg ?? 0n) + premiumGross;
        row.premiumNetUsdg = (row.premiumNetUsdg ?? 0n) + premiumNet;
        // A buyer paid if any premium reached the vault (or, under write on fill, if any
        // CallsWritten fired: the two agree, and the CallsWritten path already set this).
        row.filled = row.filled || (row.premiumGrossUsdg ?? 0n) > 0n;
        if (isRecovery) strandedCycle = undefined;
        // UsdgDistributed fires at most twice per Harvest transaction — once from
        // `_accrueHarvest` for the net, and in the terminal `_harvest` once more for any
        // unallocated carry — always with the same supply, so keeping the last per hash loses
        // nothing. The pairing is per sweep, not per week. The terminal Harvest of a week whose
        // premium was all swept by checkpoints has gross 0 and, unless dust was being carried,
        // no UsdgDistributed at all; it must not erase the denominator the earlier sweeps
        // established. Once a deposit has changed the supply between sweeps no single
        // denominator is exact — the supply at the last sweep that distributed is as close as
        // logs alone get to the indexer's `supplyAtHarvest`, which carries the same caveat.
        const supply = log.transactionHash ? supplyByTx.get(log.transactionHash) : undefined;
        if (supply !== undefined) row.sharesAtHarvest = supply;
        break;
      }
      default:
        break;
    }
  }

  return [...rows.values()];
}

/**
 * Rebuild the weekly rows from vault events.
 *
 * An UNFILLED week still produces a full row: RollOpen armed the type, no CallsWritten ever
 * fired, RollClose closed it, and Harvest fired with zeros. That row is published as
 * "unfilled, 0" exactly like a filled one, because the product promises the zero weeks as
 * loudly as the paid ones.
 */
async function cyclesFromChain(): Promise<CycleRow[]> {
  if (!VAULT) return [];

  const head = await archiveClient.getBlockNumber();
  const rawLogs = await getLogsChunked(VAULT, VAULT_FROM_BLOCK, head, 0, {
    requests: 48,
    deadline: Date.now() + 25_000,
  });

  // Decode against the vault's own ABI rather than asking the RPC to filter by topic. The
  // address-only query is the shape recon proved this RPC serves over a full range; adding six
  // topic0 values to the OR filter is what makes it time out.
  const logs = parseEventLogs({
    abi: vaultAbi as unknown as Abi,
    logs: rawLogs,
  }) as unknown as LooseLog[];

  const rows = foldVaultLogs(logs);

  // One getBlock per distinct block that starts or ends a cycle — a handful of calls a year,
  // not a scan.
  const blocks = new Set<bigint>();
  for (const row of rows) {
    if (row.openBlock !== undefined) blocks.add(row.openBlock);
    if (row.closeBlock !== undefined) blocks.add(row.closeBlock);
  }
  const timestamps = new Map<bigint, number>();
  await Promise.all(
    [...blocks].slice(0, 120).map(async (blockNumber) => {
      try {
        const block = await archiveClient.getBlock({ blockNumber });
        timestamps.set(blockNumber, Number(block.timestamp));
      } catch {
        /* a missing timestamp renders as an em dash; it is not worth failing the page over */
      }
    }),
  );

  const out: CycleRow[] = rows.map((row) => ({
    ...row,
    openedAt: row.openBlock !== undefined ? timestamps.get(row.openBlock) : undefined,
    closedAt: row.closeBlock !== undefined ? timestamps.get(row.closeBlock) : undefined,
    status: row.settled ? (row.stranded ? "stranded" : row.filled ? "filled" : "unfilled") : "open",
  }));

  out.sort((a, b) => b.cycle - a.cycle);
  return out;
}

export type HistorySource = "indexer" | "chain" | "none";

export function useCycleHistory() {
  const query = useQuery({
    queryKey: ["cycle-history", VAULT ?? "none"],
    enabled: VAULT !== undefined,
    refetchInterval: 60_000,
    queryFn: async (): Promise<{ rows: CycleRow[]; source: HistorySource; error?: string }> => {
      const indexed = await fetchCycles(60);
      if (indexed !== null && indexed.length > 0) return { rows: indexed, source: "indexer" };
      try {
        const rows = await cyclesFromChain();
        return {
          rows,
          source: "chain",
          error: indexed === null ? "Indexer unreachable — history rebuilt from vault logs." : undefined,
        };
      } catch (err) {
        // The detail belongs in the console. A page that prints a raw JSON-RPC request body at a
        // depositor has told them nothing and looks broken.
        if (typeof console !== "undefined") console.warn("[history] log fallback failed", err);
        if (indexed !== null) return { rows: indexed, source: "indexer" };
        return {
          rows: [],
          source: "none",
          error: "History is unavailable: the indexer did not answer and the log fallback failed.",
        };
      }
    },
  });

  return {
    rows: query.data?.rows ?? [],
    source: query.data?.source ?? "none",
    error: query.data?.error,
    isLoading: query.isLoading,
  };
}

/** The most recent week that actually closed. Used for the "Last week realized" figure. */
export function lastSettled(rows: CycleRow[]): CycleRow | undefined {
  return rows.find((row) => row.settled);
}
