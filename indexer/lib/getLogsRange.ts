import { toEventSelector, type AbiEvent } from "viem";

/**
 * HOW MANY BLOCKS ONE HISTORICAL `eth_getLogs` MAY SPAN, derived from how many addresses it can carry.
 *
 * The dRPC backup's rule is addresses x blocks <= 200,000, not a block count (measured by
 * direct probes: 4 x 50,000 and 1 x 100,001 answered, 5 x 50,000 and 3 x 66,667 refused with code 22). A fixed
 * 50,000-block range therefore passes only while no request names more than 4 addresses; the fifth House vault would
 * have made every dRPC-routed request for that source fail, silently while Alchemy is also listed (Ponder retries it
 * there) and fatally when dRPC is the only endpoint left.
 *
 * WHY NOT JUST THE LARGEST SOURCE. Ponder builds one log filter per (source, event) and MERGES filters that differ in
 * one dimension into one request (ponder/dist/esm/runtime/filter.js mergeLogFiltersToRequests): same address, topics
 * unioned; or same topics, addresses unioned. So a request can carry the addresses of several sources that share an
 * event selector (every AccessManaged contract emits `AuthorityUpdated`), and Ponder merges greedily in handler
 * registration order. The bound here covers both shapes without replaying that order: the larger of the biggest single
 * source list and, for each event selector, the summed address counts of every source whose ABI has it. It counts ABI
 * events, not only the ones with handlers, so it can only over-count.
 */
export const RPC_MAX_GET_LOGS_ADDRESS_BLOCKS = 200_000;

type Source = { abi: readonly unknown[]; address?: unknown };

/** A `factory()` address: Ponder resolves its children at runtime, so their count is unknown here. */
function isFactory(address: unknown): address is { address: unknown } {
  return typeof address === "object" && address !== null && !Array.isArray(address) && "parameter" in address;
}

function count(address: unknown): number {
  if (typeof address === "string") return 1;
  if (Array.isArray(address)) return address.length;
  return 0;
}

/**
 * The most addresses any one merged `eth_getLogs` request can name, and the sources whose count is not knowable at
 * boot (`factory()` children). A factory's own address list is counted: Ponder discovers children with a log request
 * on it.
 */
export function maxAddressesPerGetLogs(sources: Readonly<Record<string, Source>>): { max: number; unbounded: string[] } {
  const bySelector = new Map<string, number>();
  const unbounded: string[] = [];
  let max = 0;
  for (const [name, source] of Object.entries(sources)) {
    const own = isFactory(source.address) ? count(source.address.address) : count(source.address);
    if (isFactory(source.address)) unbounded.push(name);
    max = Math.max(max, own);
    const selectors = new Set(source.abi
      .filter((item): item is AbiEvent => (item as { type?: string }).type === "event")
      .map((item) => toEventSelector(item)));
    for (const selector of selectors) bySelector.set(selector, (bySelector.get(selector) ?? 0) + own);
  }
  for (const total of bySelector.values()) max = Math.max(max, total);
  return { max, unbounded };
}

/**
 * The block range for `chains.<chain>.ethGetLogsBlockRange`: `cap` (lib/env.ts ETH_GET_LOGS_BLOCK_RANGE), narrowed so
 * `addresses` x range stays within RPC_MAX_GET_LOGS_ADDRESS_BLOCKS. Ponder's chunks are inclusive and exactly this
 * many blocks (ponder utils/interval.js getChunks). More addresses than the budget has blocks is refused by count.
 */
export function ethGetLogsBlockRange(addresses: number, cap: number): number {
  const perAddress = Math.floor(RPC_MAX_GET_LOGS_ADDRESS_BLOCKS / Math.max(1, addresses));
  if (perAddress < 1) {
    throw new Error(`[callhouse/indexer] ${addresses} addresses in one eth_getLogs request: the backup RPC answers at ` +
      `most ${RPC_MAX_GET_LOGS_ADDRESS_BLOCKS} addresses x blocks, so no block range fits`);
  }
  return Math.min(cap, perAddress);
}
