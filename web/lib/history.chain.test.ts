/**
 * lib/history.ts around the pure fold: the indexer-first query, the log-scan fallback (range halving and its budget),
 * block timestamps and status labels, and the week-result copy. react-query, the archive RPC, the indexer and viem's
 * log decoder are stubbed; the "raw" logs handed to the stubbed getLogs are already in decoded (LooseLog) form.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getLogs: vi.fn(),
  getBlock: vi.fn(),
  getBlockNumber: vi.fn(),
  fetchCycles: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn((options: unknown) => ({ options, data: undefined, isLoading: true })) }));
vi.mock("./chain", () => ({ archiveClient: { getLogs: mocks.getLogs, getBlock: mocks.getBlock, getBlockNumber: mocks.getBlockNumber } }));
vi.mock("./api", () => ({ fetchCycles: mocks.fetchCycles }));
vi.mock("./contracts", () => ({ VAULT: "0x00000000000000000000000000000000000000Aa", VAULT_FROM_BLOCK: 0n, vaultAbi: [] }));
vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  parseEventLogs: ({ logs }: { logs: unknown[] }) => logs,
}));

import { useQuery } from "@tanstack/react-query";

import type { CycleRow } from "./api";
import { foldVaultLogs, lastSettled, unfilledWeekResult, useCycleHistory, weekResult, type LooseLog } from "./history";

type Answer = { rows: CycleRow[]; source: string; error?: string };
function useHistoryQueryFn(): () => Promise<Answer> {
  useCycleHistory();
  const { options } = vi.mocked(useQuery).mock.results.at(-1)!.value as { options: { queryFn: () => Promise<Answer>; queryKey: unknown[]; enabled: boolean } };
  return options.queryFn;
}

const tx = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}`;
const week = (cycle: number, openBlock: bigint, closeBlock: bigint | null, gross: bigint): LooseLog[] => [
  { eventName: "RollOpen", args: { cycleNumber: cycle, optionId: 1n, contractsCount: 0n, strikeUsdg: 190_000_000n }, blockNumber: openBlock, transactionHash: tx(cycle * 10) },
  ...(gross > 0n ? [{ eventName: "CallsWritten", args: { contractsCount: 2n }, blockNumber: openBlock + 1n, transactionHash: tx(cycle * 10 + 1) }] : []),
  ...(closeBlock === null ? [] : [
    { eventName: "RollClose", args: { cycleNumber: cycle, usdgFromAssignment: 0n, contractsAssignedCount: 0n }, blockNumber: closeBlock, transactionHash: tx(cycle * 10 + 2) },
    { eventName: "Harvest", args: { cycleNumber: cycle, grossUsdg: gross, feeUsdg: gross / 20n, netUsdg: gross - gross / 20n }, blockNumber: closeBlock, transactionHash: tx(cycle * 10 + 2) },
  ]),
];

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  vi.mocked(useQuery).mockClear();
  mocks.getBlockNumber.mockResolvedValue(1_000n);
  mocks.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: 1_700_000_000n + blockNumber }));
});
afterEach(() => vi.restoreAllMocks());

describe("useCycleHistory", () => {
  it("keys by vault, polls every minute, and returns empty defaults before data arrives", () => {
    const out = useCycleHistory();
    const { options } = vi.mocked(useQuery).mock.results.at(-1)!.value as { options: { queryKey: unknown[]; enabled: boolean; refetchInterval: number } };
    expect(options.queryKey).toEqual(["cycle-history", "0x00000000000000000000000000000000000000Aa"]);
    expect(options.enabled).toBe(true);
    expect(options.refetchInterval).toBe(60_000);
    expect(out).toEqual({ rows: [], source: "none", error: undefined, isLoading: true });
  });

  it("uses the indexer when it has rows, without touching the chain", async () => {
    const rows = [{ cycle: 3, filled: true, settled: true }] as CycleRow[];
    mocks.fetchCycles.mockResolvedValue(rows);
    expect(await useHistoryQueryFn()()).toEqual({ rows, source: "indexer" });
    expect(mocks.fetchCycles).toHaveBeenCalledWith(60);
    expect(mocks.getLogs).not.toHaveBeenCalled();
  });

  it("rebuilds from logs when the indexer is unreachable, with timestamps, statuses and newest first", async () => {
    mocks.fetchCycles.mockResolvedValue(null);
    mocks.getLogs.mockResolvedValue([...week(1, 10n, 20n, 0n), ...week(2, 30n, 40n, 48_000_000n), ...week(3, 50n, null, 0n)]);
    const out = await useHistoryQueryFn()();
    expect(out.source).toBe("chain");
    expect(out.error).toBe("Indexer unreachable — history rebuilt from vault logs.");
    expect(out.rows.map((r) => [r.cycle, r.status, r.openedAt, r.closedAt])).toEqual([
      [3, "open", 1_700_000_050, undefined],
      [2, "filled", 1_700_000_030, 1_700_000_040],
      [1, "unfilled", 1_700_000_010, 1_700_000_020],
    ]);
    expect(mocks.getLogs).toHaveBeenCalledWith({ address: "0x00000000000000000000000000000000000000Aa", fromBlock: 0n, toBlock: 1_000n });
  });

  it("an empty indexer (not an outage) falls back to logs without an error line", async () => {
    mocks.fetchCycles.mockResolvedValue([]);
    mocks.getLogs.mockResolvedValue([]);
    expect(await useHistoryQueryFn()()).toEqual({ rows: [], source: "chain", error: undefined });
  });

  it("labels a stranded close 'stranded' until it is recovered; a missing block timestamp is left undefined", async () => {
    mocks.fetchCycles.mockResolvedValue(null);
    mocks.getBlock.mockRejectedValue(new Error("pruned"));
    mocks.getLogs.mockResolvedValue([
      ...week(4, 10n, 20n, 0n),
      { eventName: "ClaimStranded", args: { cycleNumber: 4, gen: 1 }, blockNumber: 20n, transactionHash: tx(42) },
    ]);
    const [row] = (await useHistoryQueryFn()()).rows;
    expect(row).toMatchObject({ cycle: 4, status: "stranded", openedAt: undefined, closedAt: undefined });
  });

  it("halves a refused range, sequentially, and stitches the halves back in order", async () => {
    mocks.fetchCycles.mockResolvedValue(null);
    const logs = week(5, 10n, 900n, 0n);
    mocks.getLogs.mockImplementation(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (toBlock - fromBlock > 600n) throw new Error("range too large");
      return logs.filter((l) => l.blockNumber! >= fromBlock && l.blockNumber! <= toBlock);
    });
    const out = await useHistoryQueryFn()();
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ cycle: 5, status: "unfilled" });
    const ranges = mocks.getLogs.mock.calls.map(([q]) => [q.fromBlock, q.toBlock]);
    expect(ranges).toEqual([[0n, 1_000n], [0n, 500n], [501n, 1_000n]]);
  });

  it("gives up within the request budget and reports the history as unavailable, keeping the detail in the console", async () => {
    mocks.fetchCycles.mockResolvedValue(null);
    // Every range wider than 20 blocks is refused, so each of the 64 leaves would be needed: 127 requests, over budget.
    mocks.getLogs.mockImplementation(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (toBlock - fromBlock > 20n) throw new Error("range too large");
      return [];
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await useHistoryQueryFn()()).toEqual({ rows: [], source: "none",
      error: "History is unavailable: the indexer did not answer and the log fallback failed." });
    expect(mocks.getLogs).toHaveBeenCalledTimes(48);
    const [, err] = warn.mock.calls[0]!;
    expect(String(err)).toContain("log scan budget exhausted");
  });

  it("stops splitting at 64 chunks and surfaces the node's own error", async () => {
    mocks.fetchCycles.mockResolvedValue(null);
    mocks.getLogs.mockRejectedValue(new Error("node says no"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await useHistoryQueryFn()()).source).toBe("none");
    // Depth 0..6 down the leftmost branch, then the error propagates.
    expect(mocks.getLogs).toHaveBeenCalledTimes(7);
    expect(String(warn.mock.calls[0]![1])).toContain("node says no");
  });

  it("rethrows a real error on a range too small to split", async () => {
    mocks.fetchCycles.mockResolvedValue([]);
    mocks.getBlockNumber.mockResolvedValue(1n);
    mocks.getLogs.mockRejectedValue(new Error("bad request"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // An empty (reachable) indexer is still the answer when the fallback fails.
    expect(await useHistoryQueryFn()()).toEqual({ rows: [], source: "indexer" });
    expect(mocks.getLogs).toHaveBeenCalledTimes(1);
  });
});

describe("foldVaultLogs number tolerance", () => {
  it("reads a bigint cycle number and number amounts, and folds a Harvest without a transaction hash as premium", () => {
    const [draft] = foldVaultLogs([
      { eventName: "RollOpen", args: { cycleNumber: 9n, contractsCount: 0 }, blockNumber: 1n, transactionHash: tx(1) },
      { eventName: "Harvest", args: { cycleNumber: 9n, grossUsdg: 1_000_000, feeUsdg: 50_000, netUsdg: 950_000 } },
    ]);
    expect(draft).toMatchObject({ cycle: 9, contracts: 0n, harvestGrossUsdg: 1_000_000n, strikeProceedsUsdg: 0n, premiumNetUsdg: 950_000n, filled: true });
  });
});

const row = (over: Partial<CycleRow>): CycleRow => ({ cycle: 1, filled: false, settled: true, ...over }) as CycleRow;

describe("lastSettled", () => {
  it("is the first (newest) settled row", () => {
    const rows = [row({ cycle: 3, settled: false }), row({ cycle: 2 }), row({ cycle: 1 })];
    expect(lastSettled(rows)?.cycle).toBe(2);
    expect(lastSettled([row({ settled: false })])).toBeUndefined();
  });
});

describe("weekResult", () => {
  it("a running week is open", () => {
    expect(weekResult(row({ settled: false })).short).toBe("open");
  });

  it("an unfilled week is 'unfilled, 0', and one claiming an assignment is marked a broken record", () => {
    expect(weekResult(row({}))).toMatchObject({ short: "unfilled, 0", inconsistent: false });
    const broken = unfilledWeekResult(row({ contractsAssigned: 3n }));
    expect(broken.short).toBe("record incomplete, assigned 3");
    expect(broken.inconsistent).toBe(true);
    expect(broken.long).toContain("3 contracts assigned but no sale");
  });

  it("a filled week reports the contracts sold, from contractsSold or contracts", () => {
    expect(weekResult(row({ filled: true, contractsSold: 12n }))).toMatchObject({ short: "filled", inconsistent: false });
    expect(weekResult(row({ filled: true, contracts: 7n })).long).toBe("buyers filled 7 contracts and the calls expired out of the money");
    expect(weekResult(row({ filled: true })).long).toContain("filled 0 contracts");
  });

  it("an assigned week names how many of those sold were assigned", () => {
    const r = weekResult(row({ filled: true, contractsSold: 12n, contractsAssigned: 5n }));
    expect(r.short).toBe("assigned 5");
    expect(r.long).toContain("5 of the 12 contracts sold were assigned");
  });

  it("a stranded week says so until recovered, with its generation", () => {
    const stranded = weekResult(row({ filled: true, stranded: true, strandRecovered: false, strandGen: 2 }));
    expect(stranded.short).toBe("closed, claim stranded");
    expect(stranded.long).toContain("(strand generation 2)");
    expect(weekResult(row({ filled: true, stranded: true, strandRecovered: true, contractsAssigned: 4n })).short)
      .toBe("claim stranded, recovered, assigned 4");
    const plain = weekResult(row({ stranded: true, strandRecovered: true }));
    expect(plain.short).toBe("claim stranded, recovered");
    expect(plain.long).not.toContain("strand generation");
  });
});
