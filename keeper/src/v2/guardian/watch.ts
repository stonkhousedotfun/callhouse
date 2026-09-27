/**
 * The guardian watch's tick: find every uncorroborated settlement candidate, page it, and veto a scale
 * fault before it finalizes. The decision is planner.ts; this file finds the expiries, reads them and acts.
 *
 * FINDING THE EXPIRIES. SettlementOracle has no list of pending expiries, so the watch reads its logs, the way
 * cranker/scanner.ts reads the Clearinghouse's: `SettlementCandidate` and `SettlementUnvetoed` open an
 * (underlying, expiry), and `SettlementFinalized` closes it and records the market's price for that expiry. The
 * scan starts at the registry's v2.deployBlock, moves `chunkBlocks` at a time and at most `chunksPerTick` per tick,
 * halves a range the node refuses (down to 100 blocks), and restarts REORG_OVERLAP blocks below its cursor. The
 * cursor lives in memory: a restart rescans from the deploy block, which is also what rebuilds the finalized prices
 * the scale rule reads.
 *
 * EVERY OPEN EXPIRY, EVERY TICK, all reads at the tick's head block: `settlementInfo` (status), `candidate`,
 * `recordedSources` and `settlementConfig` (the pinned source list). The other-source reference is a recorded ok
 * price from any source other than the candidate's, else that source's live `latest`. On the launch markets that
 * is the Uniswap v3 TWAP. An expiry that reads Finalized or Held leaves the open set: Finalized is final, and a Held
 * expiry comes back through `SettlementUnvetoed` if someone lifts the veto.
 *
 * THE STALE-ROUND READ. For the candidate's own source, when it is a ChainlinkFeedSource:
 * the feed pinned for the expiry (else its current feed), walked back from `latestRoundData` to the round in force at
 * the expiry. The walk is bounded (MAX_ROUND_READS) and never crosses a phase boundary, as the source's own walk is.
 * Its age at the expiry is the planner's `roundAge`. Any other source, or a walk that cannot finish, reads as null.
 * Only a contract REVERT means that. A read that got no answer (a 429, a timeout) is `'unread'`: the stale-round
 * check did not run, which the report and the candidate page say, and it is never the same null as "not Chainlink".
 *
 * COVERAGE. Every expiry that emits a candidate is watched, whatever its market or horizon. An
 * expiry pinned 45 days ahead, whose sources were frozen before a feed fix, is covered from its first candidate on.
 *
 * ACTING. Pages go through the Alerter, whose cooldown per (kind, dedupeKey) is the repeat rule. The dedupe key names
 * the candidate (expiry, price, finalizableAt), so a new candidate pages at once. The veto goes through the
 * TxSender under (kind `guardian_veto`, key underlying:expiry), whose journal stops a second send while the first is
 * in flight. `isAdvanced` re-reads the status, so an expiry someone else already Held or finalized is not sent.
 *
 * AFTER THE LOCK. The one-transaction lock revokes the guardian key's
 * GUARDIAN: only the Admin Safe can veto or pause. With `adminSafe` set (main.ts sets it only after reading that state
 * from the AccessManager) the watch still finds, reads and pages every candidate, sends nothing, and each page that
 * would have vetoed says to veto through the Admin Safe instead of blaming GUARDIAN_AUTO_VETO.
 */
import { BaseError, ContractFunctionRevertedError, ExecutionRevertedError, getAbiItem, parseAbi, zeroAddress, type AbiEvent, type Address, type PublicClient } from 'viem';
import { chainlinkFeedSourceAbi } from '../abi/chainlinkFeedSource.js';
import { priceSourceAbi } from '../abi/priceSource.js';
import { settlementOracleAbi } from '../abi/settlementOracle.js';
import type { Alerter } from '../alerts.js';
import { readHead, type Head } from '../chain.js';
import { SETTLEMENT_STATUS, type SettlementStatusName } from '../cranker/constants.js';
import type { Logger } from '../logger.js';
import type { TxOutcome, TxSender } from '../tx.js';
import { planGuardian, type CandidateState, type GuardianPlan, type GuardianThresholds, type GuardianView } from './planner.js';

/** Blocks each scan restarts below its cursor (as cranker/scanner.ts). */
export const REORG_OVERLAP = 100n;
const MIN_CHUNK = 100n;

export type GuardianEventName = 'SettlementCandidate' | 'SettlementUnvetoed' | 'SettlementFinalized';

/** One decoded oracle log the watch acts on. `price` only on SettlementFinalized. */
export interface GuardianLog {
  eventName: GuardianEventName;
  underlying: Address;
  expiry: number;
  price: bigint | null;
}

/** The oracle's view of one (underlying, expiry), read at one block. */
export interface ExpiryReads {
  status: SettlementStatusName;
  candidate: CandidateState | null;
  recorded: { sources: readonly Address[]; ok: readonly boolean[]; prices: readonly bigint[] };
  /** settlementConfig's source list: the pinned one once pinned, else the market's current one. */
  sources: readonly Address[];
  /** settlementConfig's maxDeviationBps: the band the oracle corroborates with. */
  maxDeviationBps: number;
}

/** Everything the watch reads from chain. `viemGuardianChain` in production, a fake in tests. */
export interface GuardianChain {
  head(): Promise<Head>;
  /** The log client's own head: a scan never passes it (cranker/scanner.ts THE HEAD). */
  logHead(): Promise<bigint>;
  getLogs(fromBlock: bigint, toBlock: bigint): Promise<GuardianLog[]>;
  readExpiry(underlying: Address, expiry: number, blockNumber: bigint): Promise<ExpiryReads>;
  /** `source.latest(underlying)`: the price when ok, else null. Never throws for a not-ok or failed read. */
  readLatest(source: Address, underlying: Address, blockNumber: bigint): Promise<bigint | null>;
  /**
   * Seconds the round in force at `expiry` had been in force by then, on the Chainlink feed `source` prices `expiry`
   * from. null when `source` is not a ChainlinkFeedSource or the round cannot be found (a contract revert says so).
   * `'unread'` when a read got no answer: the round's age is unknown. Never throws.
   */
  readRoundAge(source: Address, underlying: Address, expiry: number, blockNumber: bigint): Promise<number | null | 'unread'>;
}

export type VetoSender = Pick<TxSender, 'execute'>;
export type GuardianAlerter = Pick<Alerter, 'alert'>;

export interface GuardianWatchOptions {
  chain: GuardianChain;
  sender: VetoSender;
  alerter: GuardianAlerter;
  log: Logger;
  oracle: Address;
  /** registry v2.deployBlock, else 0. */
  fromBlock: bigint;
  chunkBlocks: number;
  chunksPerTick: number;
  thresholds: GuardianThresholds;
  /** Set when the guardian key holds no GUARDIAN after the lock: who vetoes instead. Nothing is sent then. */
  adminSafe?: Address | null;
}

export interface GuardianExpiryReport {
  underlying: Address;
  expiry: number;
  status: SettlementStatusName;
  candidatePrice: string | null;
  finalizableAt: number | null;
  poolPrice: string | null;
  lastFinalizedPrice: string | null;
  /** `'unread'` when the stale-round check could not read the feed this tick. */
  roundAge: number | null | 'unread';
  plan: GuardianPlan['reason'];
  scaleFault: boolean;
  staleRound: boolean;
  /** 'admin-safe': a veto case after the lock, paged for the Admin Safe (the key holds no GUARDIAN). */
  veto: TxOutcome['status'] | 'off' | 'admin-safe' | null;
}

export interface GuardianTickReport {
  head: string;
  headTimestamp: number;
  scannedTo: string | null;
  open: number;
  expiries: GuardianExpiryReport[];
}

const keyOf = (underlying: Address, expiry: number) => `${underlying.toLowerCase()}:${expiry}`;

export class GuardianWatch {
  private cursor: bigint | null = null;
  private readonly open = new Map<string, { underlying: Address; expiry: number }>();
  /** Finalized prices per underlying (lowercase) and expiry, from SettlementFinalized. */
  private readonly finalized = new Map<string, Map<number, bigint>>();
  private last: GuardianTickReport | null = null;
  ticks = 0;

  constructor(private readonly options: GuardianWatchOptions) {}

  state(): GuardianTickReport | null {
    return this.last;
  }

  async tick(): Promise<GuardianTickReport> {
    const { chain } = this.options;
    const head = await chain.head();
    const scannedTo = await this.scan();
    const expiries: GuardianExpiryReport[] = [];
    for (const [key, { underlying, expiry }] of [...this.open]) {
      expiries.push(await this.watchExpiry(key, underlying, expiry, head));
    }
    this.ticks += 1;
    this.last = { head: head.blockNumber.toString(), headTimestamp: head.timestamp, scannedTo: scannedTo?.toString() ?? null, open: this.open.size, expiries };
    return this.last;
  }

  /** The market's latest finalized price for an expiry before `expiry`, or null. */
  lastFinalizedBefore(underlying: Address, expiry: number): bigint | null {
    const byExpiry = this.finalized.get(underlying.toLowerCase());
    if (byExpiry === undefined) return null;
    let best: number | null = null;
    for (const e of byExpiry.keys()) if (e < expiry && (best === null || e > best)) best = e;
    return best === null ? null : byExpiry.get(best)!;
  }

  private apply(log: GuardianLog): void {
    const key = keyOf(log.underlying, log.expiry);
    if (log.eventName === 'SettlementFinalized') {
      this.open.delete(key);
      if (log.price !== null && log.price > 0n) {
        const u = log.underlying.toLowerCase();
        if (!this.finalized.has(u)) this.finalized.set(u, new Map());
        this.finalized.get(u)!.set(log.expiry, log.price);
      }
      return;
    }
    // A candidate or an unveto (re)opens the expiry, unless it is already known finalized.
    if (this.finalized.get(log.underlying.toLowerCase())?.has(log.expiry)) return;
    this.open.set(key, { underlying: log.underlying, expiry: log.expiry });
  }

  /** Read the oracle's logs up to the log client's head. Returns the last block scanned, or null when caught up. */
  private async scan(): Promise<bigint | null> {
    const { chain, fromBlock, chunksPerTick } = this.options;
    const logHead = await chain.logHead();
    let start = this.cursor === null ? fromBlock : this.cursor + 1n - REORG_OVERLAP;
    if (start < fromBlock) start = fromBlock;
    let chunk = BigInt(this.options.chunkBlocks);
    let last: bigint | null = null;
    for (let i = 0; i < chunksPerTick && start <= logHead; ) {
      const to = start + chunk - 1n > logHead ? logHead : start + chunk - 1n;
      let logs: GuardianLog[];
      try {
        logs = await chain.getLogs(start, to);
      } catch (error) {
        if (chunk <= MIN_CHUNK) throw error;
        chunk = chunk / 2n < MIN_CHUNK ? MIN_CHUNK : chunk / 2n;
        continue;
      }
      for (const log of logs) this.apply(log);
      this.cursor = to;
      last = to;
      start = to + 1n;
      i += 1;
    }
    return last;
  }

  private async watchExpiry(key: string, underlying: Address, expiry: number, head: Head): Promise<GuardianExpiryReport> {
    const { chain, alerter, log, adminSafe } = this.options;
    // After the lock the key cannot veto: plan as if GUARDIAN_AUTO_VETO were off, and page for the Admin Safe.
    const thresholds = adminSafe ? { ...this.options.thresholds, autoVeto: false } : this.options.thresholds;
    const byHand = adminSafe
      ? `the guardian key holds no GUARDIAN after the lock (owner R4): veto through the Admin Safe ${adminSafe}`
      : 'GUARDIAN_AUTO_VETO is off, veto by hand';
    const reads = await chain.readExpiry(underlying, expiry, head.blockNumber);
    const pendingCandidate = reads.status === 'Pending' ? reads.candidate : null;
    const poolPrice = pendingCandidate === null ? null : await this.otherSourcePrice(reads, pendingCandidate.sourceIndex, underlying, head.blockNumber);
    const candidateSource = pendingCandidate === null ? undefined : reads.sources[pendingCandidate.sourceIndex];
    const roundAge = candidateSource === undefined ? null : await chain.readRoundAge(candidateSource, underlying, expiry, head.blockNumber);
    const view: GuardianView = {
      underlying,
      expiry,
      status: reads.status,
      candidate: reads.candidate,
      poolPrice,
      lastFinalizedPrice: this.lastFinalizedBefore(underlying, expiry),
      roundAge,
      maxDeviationBps: reads.maxDeviationBps,
      now: head.timestamp,
    };
    const plan = planGuardian(view, thresholds);
    const report: GuardianExpiryReport = {
      underlying,
      expiry,
      status: reads.status,
      candidatePrice: reads.candidate?.price.toString() ?? null,
      finalizableAt: reads.candidate?.finalizableAt ?? null,
      poolPrice: poolPrice?.toString() ?? null,
      lastFinalizedPrice: view.lastFinalizedPrice?.toString() ?? null,
      roundAge,
      plan: plan.reason,
      scaleFault: plan.scaleFault,
      staleRound: plan.staleRound,
      veto: null,
    };
    if (reads.status === 'Finalized' || reads.status === 'Held') {
      this.open.delete(key);
      return report;
    }
    if (!plan.page || reads.candidate === null) return report;

    const c = reads.candidate;
    const data = {
      underlying,
      expiry,
      candidatePrice: c.price.toString(),
      sourceIndex: c.sourceIndex,
      disagreed: c.disagreed,
      finalizableAt: c.finalizableAt,
      poolPrice: report.poolPrice,
      lastFinalizedPrice: report.lastFinalizedPrice,
      ratios: plan.ratios,
      late: plan.late,
      roundAge,
      staleRoundAfterS: thresholds.staleRoundAfterS,
      maxDeviationBps: reads.maxDeviationBps,
      poolDisagrees: plan.poolDisagrees,
      scaleFactor: thresholds.scaleFactor,
      autoVeto: thresholds.autoVeto,
    };
    const dedupeKey = `${key}:${c.price}:${c.finalizableAt}`;
    await alerter.alert(
      'v2_guardian_candidate',
      `uncorroborated candidate ${c.price} for ${underlying} expiry ${expiry} finalizes at ${c.finalizableAt}` +
        (c.disagreed ? ' (sources disagree)' : ' (single ok source)') +
        ': compare it with an independent price before then' +
        (roundAge === 'unread' ? '. The feed round behind it could not be read this tick: the stale-round check did not run' : ''),
      data,
      { dedupeKey },
    );
    if (plan.scaleFault) {
      await alerter.alert(
        'v2_guardian_scale_fault',
        `candidate ${c.price} for ${underlying} expiry ${expiry} is ${thresholds.scaleFactor}x or more from every reference ` +
          `(pool ${report.poolPrice ?? 'unread'}, last finalized ${report.lastFinalizedPrice ?? 'none'})` +
          (plan.veto ? ': vetoing' : `: ${byHand}`),
        data,
        { dedupeKey },
      );
    }
    if (plan.staleRound) {
      const pool = report.poolPrice === null ? 'the pool was not read' : plan.poolDisagrees ? `the pool (${report.poolPrice}) disagrees beyond ${reads.maxDeviationBps} bps` : `the pool (${report.poolPrice}) agrees within ${reads.maxDeviationBps} bps`;
      await alerter.alert(
        'v2_guardian_stale_round',
        `candidate ${c.price} for ${underlying} expiry ${expiry} came from a feed round ${roundAge} s old at the expiry ` +
          `(over ${thresholds.staleRoundAfterS} s: a feed outage); ${pool}` +
          (plan.veto ? ': vetoing' : plan.poolDisagrees ? `: ${byHand}` : ': check it against an independent price'),
        data,
        { dedupeKey },
      );
    }
    // 'off' only for a candidate the rule WOULD veto with GUARDIAN_AUTO_VETO on; a stale round the pool agrees with is
    // not a veto case at all, and its report says so (null), not that the flag held a veto back.
    const vetoCase = plan.scaleFault || (plan.staleRound && plan.poolDisagrees);
    if (!vetoCase) return report;
    if (!plan.veto) {
      report.veto = adminSafe ? 'admin-safe' : 'off';
      return report;
    }

    const outcome = await this.options.sender.execute(
      { address: this.options.oracle, abi: settlementOracleAbi, functionName: 'veto', args: [underlying, expiry] },
      {
        kind: 'guardian_veto',
        key: `${underlying}:${expiry}`,
        isAdvanced: async () => (await chain.readExpiry(underlying, expiry, (await chain.head()).blockNumber)).status !== 'Pending',
      },
    );
    report.veto = outcome.status;
    if (outcome.status === 'confirmed') {
      this.open.delete(key);
      await alerter.alert('v2_guardian_vetoed', `vetoed ${underlying} expiry ${expiry}: candidate ${c.price} is ${plan.scaleFault ? 'a scale fault' : 'from a stale feed round the pool disagrees with'}; the expiry is Held`, { ...data, reason: plan.reason, hash: outcome.hash }, { dedupeKey, force: true });
    } else if (outcome.status !== 'in-flight' && outcome.status !== 'already-advanced') {
      log.error({ underlying, expiry, outcome }, 'guardian veto did not go through');
      await alerter.alert(
        'v2_guardian_veto_failed',
        `veto of ${underlying} expiry ${expiry} did not go through (${outcome.status}); the ${plan.reason} candidate ${c.price} can finalize at ${c.finalizableAt}`,
        { ...data, outcome: outcome.status, ...('revert' in outcome ? { revert: outcome.revert } : {}) },
        { dedupeKey, force: true },
      );
    }
    return report;
  }

  /** A recorded ok price from a source other than the candidate's, else that source's live `latest`. */
  private async otherSourcePrice(reads: ExpiryReads, candidateIndex: number, underlying: Address, blockNumber: bigint): Promise<bigint | null> {
    const { recorded, sources } = reads;
    for (let i = 0; i < recorded.sources.length; i++) {
      if (i !== candidateIndex && recorded.ok[i] === true && (recorded.prices[i] ?? 0n) > 0n) return recorded.prices[i]!;
    }
    for (let i = 0; i < sources.length; i++) {
      if (i === candidateIndex) continue;
      const p = await this.options.chain.readLatest(sources[i]!, underlying, blockNumber);
      if (p !== null && p > 0n) return p;
    }
    return null;
  }
}

/*//////////////////////////////////////////////////////////////
                        THE ROUND IN FORCE
//////////////////////////////////////////////////////////////*/

/** ChainlinkFeedSource.MAX_ROUND_READS: the most rounds one walk reads, latestRoundData included. */
export const MAX_ROUND_READS = 96;
/** The aggregator's round id in the low 64 bits of a proxy round id; the phase is above (ChainlinkFeedSource). */
const AGGREGATOR_ROUND_MASK = (1n << 64n) - 1n;

export interface FeedRound {
  id: bigint;
  updatedAt: bigint;
}

/**
 * The round in force at `at`: walk back from the latest round until one was updated at or before `at`. `read(null)`
 * is latestRoundData, `read(id)` is getRoundData(id), and either returns null when the read fails. null when the walk
 * reaches round 1 of the phase (it never crosses into the previous aggregator) or reads `maxReads` rounds first.
 * The id asked for is kept, not the one echoed back, as the source's own walk does.
 */
export async function roundInForceAt(read: (id: bigint | null) => Promise<FeedRound | null>, at: number, maxReads = MAX_ROUND_READS): Promise<FeedRound | null> {
  let r = await read(null);
  let reads = 1;
  const t = BigInt(at);
  while (r !== null) {
    if (r.updatedAt <= t) return r;
    if ((r.id & AGGREGATOR_ROUND_MASK) <= 1n || reads >= maxReads) return null;
    const prev = r.id - 1n;
    const next = await read(prev);
    r = next === null ? null : { id: prev, updatedAt: next.updatedAt };
    reads += 1;
  }
  return null;
}

/*//////////////////////////////////////////////////////////////
                         PRODUCTION CHAIN
//////////////////////////////////////////////////////////////*/

const aggregatorRoundsAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function getRoundData(uint80 roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

const EVENTS = {
  candidate: getAbiItem({ abi: settlementOracleAbi, name: 'SettlementCandidate' }) as AbiEvent,
  unvetoed: getAbiItem({ abi: settlementOracleAbi, name: 'SettlementUnvetoed' }) as AbiEvent,
  finalized: getAbiItem({ abi: settlementOracleAbi, name: 'SettlementFinalized' }) as AbiEvent,
};

interface DecodedOracleLog {
  eventName?: string;
  args?: { underlying?: Address; expiry?: number | bigint; price?: bigint };
}

/** Decode what getLogs returned into GuardianLogs; a log without its indexed arguments is skipped. */
export function toGuardianLogs(logs: readonly DecodedOracleLog[]): GuardianLog[] {
  const out: GuardianLog[] = [];
  for (const l of logs) {
    const name = l.eventName;
    if (name !== 'SettlementCandidate' && name !== 'SettlementUnvetoed' && name !== 'SettlementFinalized') continue;
    const u = l.args?.underlying;
    const e = l.args?.expiry;
    if (u === undefined || e === undefined) continue;
    out.push({ eventName: name, underlying: u, expiry: Number(e), price: name === 'SettlementFinalized' ? (l.args?.price ?? null) : null });
  }
  return out;
}

/**
 * Whether `error` is the contract refusing the call (the node executed it and it reverted), as opposed to a read
 * that got no answer (a transport failure, a timeout, a rate limit) or anything else. Only a revert may mean "this
 * contract does not have that view" or "no such round"; every other failure is unknown.
 */
export function isRevert(error: unknown): boolean {
  // ContractFunctionRevertedError: the node answered "reverted" with its code 3 and data; ExecutionRevertedError: viem's
  // reading of a node's "execution reverted" answer without them. A timeout, an HTTP 429 or a closed socket is neither.
  return error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ExecutionRevertedError) !== null;
}

/** GuardianChain over viem: reads on the fallback client, logs on the log client pinned to RH_RPC (chain.ts). */
export function viemGuardianChain(publicClient: PublicClient, logClient: PublicClient, oracle: Address): GuardianChain {
  return {
    head: () => readHead(publicClient),
    logHead: () => logClient.getBlockNumber(),
    async getLogs(fromBlock, toBlock) {
      const logs = await logClient.getLogs({ address: oracle, events: [EVENTS.candidate, EVENTS.unvetoed, EVENTS.finalized], fromBlock, toBlock, strict: false } as never);
      return toGuardianLogs(logs as unknown as DecodedOracleLog[]);
    },
    async readExpiry(underlying, expiry, blockNumber) {
      const read = <T>(functionName: string) =>
        publicClient.readContract({ address: oracle, abi: settlementOracleAbi, functionName, args: [underlying, expiry], blockNumber } as never) as Promise<T>;
      const [info, cand, recorded, config] = await Promise.all([
        read<readonly [number, bigint, number, boolean, boolean, boolean]>('settlementInfo'),
        read<readonly [bigint, number, boolean, number]>('candidate'),
        read<readonly [readonly Address[], readonly boolean[], readonly bigint[], number]>('recordedSources'),
        read<readonly [boolean, readonly Address[], number, number, number]>('settlementConfig'),
      ]);
      const status = SETTLEMENT_STATUS[Number(info[0])];
      if (status === undefined) throw new Error(`settlementInfo(${underlying}, ${expiry}): unknown status ${info[0]}`);
      return {
        status,
        // finalizableAt 0 is the oracle's "no candidate" (cranker/reads.ts).
        candidate: Number(cand[3]) === 0 ? null : { price: cand[0], sourceIndex: Number(cand[1]), disagreed: cand[2], finalizableAt: Number(cand[3]) },
        recorded: { sources: recorded[0], ok: recorded[1], prices: recorded[2] },
        sources: config[1],
        maxDeviationBps: Number(config[2]),
      };
    },
    async readRoundAge(source, underlying, expiry, blockNumber) {
      let feed: Address;
      try {
        // A source without pinnedFeeds is not a ChainlinkFeedSource: the read reverts, and the answer is null.
        const pinned = (await publicClient.readContract({ address: source, abi: chainlinkFeedSourceAbi, functionName: 'pinnedFeeds', args: [underlying, expiry], blockNumber } as never)) as readonly [Address, number, number, boolean];
        feed = pinned[3]
          ? pinned[0]
          : ((await publicClient.readContract({ address: source, abi: chainlinkFeedSourceAbi, functionName: 'feeds', args: [underlying], blockNumber } as never)) as readonly [Address, number, number])[0];
      } catch (error) {
        return isRevert(error) ? null : 'unread';
      }
      if (feed === zeroAddress) return null;
      let unread = false;
      const read = async (id: bigint | null): Promise<FeedRound | null> => {
        try {
          const r = (id === null
            ? await publicClient.readContract({ address: feed, abi: aggregatorRoundsAbi, functionName: 'latestRoundData', blockNumber })
            : await publicClient.readContract({ address: feed, abi: aggregatorRoundsAbi, functionName: 'getRoundData', args: [id], blockNumber })) as readonly [bigint, bigint, bigint, bigint, bigint];
          return { id: r[0], updatedAt: r[3] };
        } catch (error) {
          // A round the aggregator does not have reverts, and ends the walk; a read that got no answer is unknown.
          if (!isRevert(error)) unread = true;
          return null;
        }
      };
      const round = await roundInForceAt(read, expiry);
      if (unread) return 'unread';
      return round === null ? null : expiry - Number(round.updatedAt);
    },
    async readLatest(source, underlying, blockNumber) {
      try {
        const [ok, price] = (await publicClient.readContract({ address: source, abi: priceSourceAbi, functionName: 'latest', args: [underlying], blockNumber } as never)) as readonly [boolean, bigint, bigint];
        return ok && price > 0n ? price : null;
      } catch {
        return null;
      }
    },
  };
}
