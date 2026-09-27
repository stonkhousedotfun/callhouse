/**
 * The MM bot's tick and its kill switch: reads the chain and the pricing service into a planner.TickInput, plans,
 * sends through tx.ts (simulate → send → journal → wait, one at a time, fixed gas), raises alerts and keeps /state.
 *
 * ONE TICK
 *   0. once per process: the deployment anchor (../anchor.ts) checked against the store's, which resets a store written
 *      for another deployment at the same addresses before anything is read from it
 *   1. head block (every decision uses its timestamp); the vault must belong to the configured order book
 *   2. series index: Clearinghouse SeriesCreated logs (series-index.ts)
 *   3. vault state, the calendar session, fees
 *   4. vault orders: new ids from OrderBook.ordersOfMaker(vault) ingested; every open one re-read, a grown `filled` is
 *      a fill written to the realised-PnL ledger in the same SQLite transaction as the new `filled`, a sale at the
 *      seller fee its OrderFilled logs show (fills.ts: not the fees in effect at the head, which a scheduled change
 *      may have moved since the fill)
 *   5. settlements of the ledger's open positions → the day's realised result → the loss stop
 *   6. the quoted markets (MM_MARKETS, else every live v2 market): config, spot, free collateral, wallet tokens
 *   7. the managed series (managedSeries): the selection (nearest the money, MM_MAX_SERIES) plus every series with a
 *      vault order or tracked exposure on any market (outside the quoted set: pull-only); their vault guards, exposure,
 *      collateral, oracle spot
 *   8. /fair for the series that need it (planner.fairRequests), MM_PRICING_TIMEOUT_MS each, never throwing
 *   9. planner.planTick → at most MM_MAX_TX_PER_TICK transactions, cancels first; a kill that lands mid-tick stops
 *      everything but cancels
 *  10. alerts, /state
 *
 * KILL (POST /kill, routes.ts): the killed state is written to v2_meta first (a restart stays killed), `v2_mm_killed`
 * pages, then every vault order with units left is cancelled: live ones and expired ones that still hold escrow
 * (engine.isKillTarget), on every market, whoever placed them through the vault. Passes repeat until a re-read finds
 * none (a place the tick had already queued lands before the kill's cancel, which the sender serialises behind it). The
 * answer is done only when that same re-read finds none: an expired Bid or AskResale whose cancel keeps failing is
 * still escrow on the book, so it is reported as remaining (202) with its id. Every later tick plans nothing but
 * cancels, expired escrowed orders included, until POST /resume.
 */
import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, getAddress, zeroAddress, type Address, type PublicClient } from 'viem';
import { anchorWarning, readDeploymentAnchor } from '../anchor.js';
import { clearinghouseAbi } from '../abi/clearinghouse.js';
import { earnVaultAbi } from '../abi/earnVault.js';
import { houseVaultAbi } from '../abi/houseVault.js';
import { makerVaultAbi } from '../abi/makerVault.js';
import { orderBookAbi } from '../abi/orderBook.js';
import { FAILED_DELIVERY_RETRY_MS, type Alerter } from '../alerts.js';
import { readHead, type Head } from '../chain.js';
import { sessionOpenOf } from '../pricing/bs.js';
import { holidayHorizon } from '../../calendar.js';
import { bidCapAheadOf, refreshLeadOf, replaceMarginOf, type MmConfig } from '../config.js';
import { keepEarn, stuckReason, type EarnKeepResult, type EarnMove, type QueueWatch } from '../earn/keep.js';
import { readEarnState } from '../earn/reads.js';
import type { Logger } from '../logger.js';
import { marketByUnderlying, v2Markets, type V2Market } from '../registry.js';
import type { V2Store } from '../store.js';
import { describeError, type TxOutcome, type TxSender } from '../tx.js';
import { BUDGET_SHORT_SENDS, CANCEL_CHUNK, KILL_RESPONSE_WAIT_MS, MM_GAS } from './constants.js';
import { fairClockHalt, isKillTarget, marketSafetyHalt, pullAtOf, safestAskOf, selectSeries, SpotMoveBreaker, validUntilAt, type FairClockInput, type FairInput, type Halt, type LiveOrder, type SeriesInfo } from './engine.js';
import { flatForRoll, type EpochView } from './epoch.js';
import { houseSupport, legacyWeeklyWindingDown, rollDue, type DiscoveredHouseVault, type HouseSupport, type HouseUnavailable } from './house.js';
import { MM_META, MmStore, type KilledState } from './mm-store.js';
import { trackVaultOrders, type FillRecord, type TrackResult } from './fills.js';
import { lossStop, replayLedger, type LossStop } from './pnl.js';
import { foreignSpend, project, type Projection } from './outflow.js';
import { bidGrowth, bookedCalls, fairRequests, planTick, twoSidedCount, type MmPlanParams, type MmTx, type OtherAskInput, type SeriesView, type TickInput, type TickPlan } from './planner.js';
import { isProtocolOwned, type ProtocolResting } from './protocol-accounts.js';
import type { PricingClient } from './pricing-client.js';
import {
  readMakerOrderIds,
  readMarkets,
  readMeasuredNotional,
  readOrders,
  readOtherAskers,
  readSeriesViews,
  readSettlements,
  readSettledHoldings,
  readVaultState,
  readHouseReserve,
  type ChainOrder,
  VAULT_PLACE_SELECTOR,
  type MarketsRead,
  type MmAddresses,
  type OtherAskers,
  type VaultState,
  readSpotClocks,
} from './reads.js';
import type { KillOutcome, KillSwitch } from './routes.js';
import { scanSeries } from './series-index.js';
import { MarkoutBook } from './markouts.js';

const lc = (a: string): string => a.toLowerCase();
/** Scope key for a body-less kill. Not an address, so it can never collide with one. */
const ALL_VAULTS = 'all';
/**
 * The ONE dedupe key of the `v2_mm_delta` page, for the page and for its clear. The page used
 * `${vault}:${ticker}` and the clear used `ticker` alone, so a resolved delta never lifted the cooldown it had set:
 * the next breach on that vault stayed suppressed until the cooldown expired on its own. Same defect shape as an earlier fix
 * for a different kind - two literals that agree by luck cannot drift when there is one builder.
 */
const deltaAlertKey = (vault: string, ticker: string): string => `${lc(vault)}:${ticker}`;
/**
 * Fills kept for /state PER VAULT. The window was 50 across the whole fleet, so one busy vault could push a
 * quiet vault's fills out of it entirely. Attributed, the right size is per vault: every vault keeps its own
 * 50 and no vault's activity can evict another's, at a bounded cost of 50 x |vaults| records in memory.
 */
const RECENT_FILLS_PER_VAULT = 50;
/**
 * Fair reads per vault per tick for markout checkpoints whose series the quoting pass did not already price
 * (a series no longer selected, or one whose order has gone). Bounded so a burst of fills cannot turn one tick into a
 * pricing storm; the rest wait for the next tick (and are marked late, never exact).
 */
const MARKOUT_EXTRA_FAIRS_PER_TICK = 10;
/** /state's markouts for one vault (lower-case key, as trackOrders files them): the latest 20 fills, newest first. */
export function markoutsOf(books: ReadonlyMap<string, MarkoutBook>, address: string) {
  return books.get(lc(address))?.snapshot(20) ?? [];
}
/**
 * When the session `now` is in began, for fair-before-open: the 09:30 New York open of `now`'s New York date, or null
 * when the on-chain ExpiryCalendar says no session is open (then nothing reads it).
 *
 * WHETHER the session is open comes from ExpiryCalendar.isRegularSession, so the date is a
 * session day by the chain's holidays. The keeper's own list (calendar.ts NYSE_HOLIDAYS_2026_2028, bs.sessionOpenOf's
 * default) is a second calendar; where the two disagreed, sessionOpenOf returned null for the whole session and the
 * engine halted every series `fair-before-open` all day. So no keeper holiday is consulted here: only a weekend, which
 * the chain calendar never opens, is still null (and halts).
 */
export function sessionOpenedAtOf(now: number, sessionOpen: boolean): number | null {
  return sessionOpen ? sessionOpenOf(now, NO_KEEPER_HOLIDAYS) : null;
}
const NO_KEEPER_HOLIDAYS: readonly string[] = [];

/** The dedupe key of one vault's v2_mm_markout_low page, for the page and its clear. */
const markoutAlertKey = (vault: string) => `markout:${lc(vault)}`;

/**
 * Consecutive ticks a vault may halt series `guards-unreadable` before `v2_mm_guards_unreadable` goes from
 * warn to error. One tick is a warn: a single multicall leg can fail on an RPC blip, and the next tick reads it again.
 * Three in a row is structural, a read the vault cannot answer (askFloor on a HouseVault failed every tick): at the
 * 60 s MM cadence that is an error page within about three minutes, and a transient failure never reaches it.
 */
export const GUARDS_UNREADABLE_ERROR_TICKS = 3;

/** The series a vault's tick halted `guards-unreadable` (of all it planned), and the guard reads that failed on them. */
export function guardsUnreadableOf(t: Pick<LastTick, 'plan' | 'input'>): { series: string[]; of: number; calls: string[] } | null {
  const halted = new Set(t.plan.series.filter((s) => s.halt?.halt === 'guards-unreadable').map((s) => s.longId.toString()));
  if (halted.size === 0) return null;
  const calls = t.input.series.filter((v) => halted.has(v.info.longId.toString())).flatMap((v) => v.guardFailures ?? []);
  return { series: [...halted], of: t.plan.series.length, calls };
}

/** The one-line reason for the page and for /state's `unavailable`: how many series, for how long, and the first failing calls. */
export function guardsUnreadableReason(g: NonNullable<ReturnType<typeof guardsUnreadableOf>>, ticks: number): string {
  const shown = g.calls.slice(0, 3).join('; ');
  const more = g.calls.length > 3 ? ` (+${g.calls.length - 3} more)` : '';
  return `${g.series.length} of ${g.of} series halted guards-unreadable for ${ticks} consecutive tick(s); failing: ${shown === '' ? 'no failed read recorded' : shown}${more}`;
}

/**
 * The fleet-wide /state view of the per-vault fill windows: every entry says which vault it came from and the
 * newest is first. Exported because the property worth pinning is that one vault's activity cannot evict
 * another's - which is about the SHAPE of the windows, not about a tick.
 */
export const flattenRecentFills = (byVault: ReadonlyMap<string, readonly FillRecord[]>): Array<FillRecord & { vault: string }> =>
  [...byVault.entries()].flatMap(([vault, fills]) => fills.map((fill) => ({ ...fill, vault }))).sort((a, b) => b.at - a.at);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Bot cap 0 means the vault's limit alone; otherwise the tighter of the two. Never widens on-chain. */
const capAtMost = (bot: bigint, onChain: bigint): bigint => {
  if (bot <= 0n) return onChain;
  if (onChain <= 0n) return bot;
  return bot < onChain ? bot : onChain;
};

export interface MmBotContext {
  config: MmConfig;
  log: Logger;
  client: PublicClient;
  logClient: PublicClient;
  sender: Pick<TxSender, 'execute'>;
  alerter: Pick<Alerter, 'alert' | 'clear'>;
  store: V2Store;
  pricing: Pick<PricingClient, 'fairMany'>;
  signer: Address;
  /** Wall clock (ms), for /state timings and the kill record only. */
  now?: () => number;
  /** How long POST /kill waits for its cancels before answering 202. */
  killWaitMs?: number;
  /** The pause between the kill's cancel passes after the first (default 1 s). */
  killRetryMs?: number;
  /**
   * House vault discovery and epoch reads. Left unset in production, where `houseSupport` reports the
   * artifact gap; the tests inject a reader so the epoch path is exercised (mm/house.ts).
   */
  house?: Partial<HouseSupport>;
  /**
   * Does this address answer `HouseVault.epochEnd()`? true = it is a House vault, false = the call
   * reverts or returns nothing (it is not one), a throw = the chain could not say. Defaults to
   * `answersEpochEnd(client)`; the tests inject one because their client is unreachable.
   */
  isHouseVault?: (vault: Address, blockNumber: bigint) => Promise<boolean>;
}

/** An MM_VAULTS entry this process refuses to quote because it is a House vault. */
export interface RefusedVault {
  address: Address;
  reason: string;
}

/**
 * The default House-vault probe: read `epochEnd()` (HouseVault.sol :191) from the vault. A revert, or a
 * call that returns no data (no code, or a contract without the function), means "not a House vault"; any other
 * failure - RPC down, timeout - is thrown, because the caller must not treat "could not ask" as "is not one".
 */
export function answersEpochEnd(client: Pick<PublicClient, 'readContract'>) {
  return async (vault: Address, blockNumber: bigint): Promise<boolean> => {
    try {
      await client.readContract({ address: vault, abi: houseVaultAbi, functionName: 'epochEnd', blockNumber });
      return true;
    } catch (error) {
      const notHouse = error instanceof BaseError
        && error.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError) !== null;
      if (notHouse) return false;
      throw error;
    }
  };
}

/**
 * One vault after its chain reads and before it plans. The read phase of every vault runs first so
 * the protocol-owned resting book can be the UNION of all of them: a bid of vault A that would cross
 * an ask of vault B is only visible to `crossesProtocol` if B's orders are in the book A plans
 * against. Building the book per vault, as the recovered WIP did, can only ever see a self-cross.
 */
interface PreparedVault {
  a: MmAddresses;
  target: VaultTarget;
  vault: VaultState;
  chainOrders: ChainOrder[];
}

/**
 * One vault after it planned and before it sends. Every vault plans before any sends, so the tick knows how
 * many transactions each House vault actually needs and can hand the rest of the budget to the treasury (tick()).
 */
interface PlannedVault {
  prepared: PreparedVault;
  input: TickInput;
  /** The plan as sent: on a read between routine sends, its protective transactions only (sendGate). */
  plan: TickPlan;
  stop: LossStop;
  views: SeriesView[];
  foreignOutflow: bigint | null;
  pricing: LastTick['pricing'];
  coverage: Record<string, MarketCoverage>;
  scan: { created: number; caughtUp: boolean };
  sendGate: SendGate;
}

/**
 * Whether this read is the vault's ROUTINE send (MM_SEND_INTERVAL_S since the last one that
 * sent a routine transaction, head time), and how many routine transactions were held back when it is not. A
 * protective transaction goes out on every read (engine.ts MmAction `protective`).
 */
export interface SendGate {
  intervalS: number;
  due: boolean;
  lastRoutineSendAt: number | null;
  held: number;
}

/** What the tick's MM_MAX_TX_PER_TICK let this vault send, and what it had to leave. */
export interface VaultBudget {
  given: number;
  /** Transactions the budget left unsent this tick (0 = the plan went out whole). */
  unsent: number;
  /** Series with an ask to place that the budget left without a live ask (budgetShortSeries). */
  seriesWithoutAsk: number;
  /** Consecutive routine sends of this vault cut short by the budget; v2_mm_budget_short at BUDGET_SHORT_SENDS. */
  shortSends: number;
}

/** A transaction that may go out on any read, not only on the vault's routine send. */
export const isProtectiveTx = (tx: MmTx): boolean => 'protective' in tx && tx.protective === true;

/** A read is a vault's routine send when `intervalS` of head time has passed since its last one. */
export const routineSendDue = (intervalS: number, lastRoutineSendAt: number | null, now: number): boolean =>
  intervalS <= 0 || lastRoutineSendAt === null || now - lastRoutineSendAt >= intervalS;

/**
 * What the vault sending now may spend (tick(), THE ARITHMETIC): `remaining` less a reserve for the vaults still
 * to send, each what its plan needs up to a `share`, the reserve capped so this vault keeps at least a `share` of what
 * remains.
 */
export function vaultBudgetOf(remaining: number, share: number, laterNeeds: readonly number[]): number {
  const later = laterNeeds.reduce((n, need) => n + Math.min(share, need), 0);
  const reserve = Math.min(later, Math.max(0, remaining - share));
  return Math.max(0, remaining - reserve);
}

/**
 * The series a budget cut left without a live ask: an ask `place` of the plan that was not sent, on a series with
 * no ask still resting after the sends (the tick's live asks, less those a sent cancel took off). Pure; exported for the
 * test of the count v2_mm_budget_short carries.
 */
export function budgetShortSeries(plan: TickPlan, sent: ReadonlyMap<number, unknown>): bigint[] {
  const cancelled = new Set<string>();
  plan.txs.forEach((tx, i) => {
    if (tx.type === 'cancel' && sent.has(i)) for (const id of tx.orderIds) cancelled.add(id.toString());
  });
  const resting = new Set<string>();
  for (const s of plan.series ?? []) {
    for (const o of s.live) if (o.kind !== 'Bid' && !cancelled.has(o.id.toString())) resting.add(s.longId.toString());
  }
  const out = new Map<string, bigint>();
  plan.txs.forEach((tx, i) => {
    if (tx.type === 'place' && tx.slot !== 'bid' && !sent.has(i) && !resting.has(tx.longId.toString())) out.set(tx.longId.toString(), tx.longId);
  });
  return [...out.values()];
}

/**
 * The protocol-owned resting orders of EVERY quoted vault, as one book.
 *
 * It takes a list of per-vault order lists rather than one flat list on purpose: the argument shape
 * is the invariant. A caller that has only one vault's orders cannot produce a book that sees a
 * cross between two vaults, which is precisely the defect this function exists to prevent - vault A
 * bidding 100 while vault B asks 99 lets an outside account take B and hit A for a riskless spread
 * paid by depositors (mm/protocol-accounts.ts). Filled, cancelled and zero-maker orders are not
 * resting and are dropped.
 */
export function unionProtocolBook(
  perVault: ReadonlyArray<readonly ChainOrder[]>,
  protocolAccounts: ReadonlySet<string>,
  /** Head timestamp. An order past its `validUntil` is not resting, so it cannot be crossed. */
  now?: number,
): ProtocolResting[] {
  const out: ProtocolResting[] = [];
  for (const orders of perVault) {
    for (const o of orders) {
      if (o.maker === zeroAddress || o.cancelled || o.filled >= o.units) continue;
      // Expired but not yet cancelled. Admitting it made the guard refuse our own quote against an order
      // nobody can fill - conservative, so it cost spread rather than money, but it is still a wrong answer.
      if (now !== undefined && o.validUntil !== 0 && o.validUntil <= now) continue;
      if (!isProtocolOwned(o.maker, protocolAccounts)) continue;
      out.push({ longId: o.longId, maker: lc(o.maker), kind: o.kind, price: o.price });
    }
  }
  return out;
}

/** One vault this process quotes for, resolved once per tick. */
export interface VaultTarget {
  address: Address;
  /** `'house'` is epoch-disciplined; `'treasury'` is a MakerVault with no epoch (today's behaviour). */
  kind: 'treasury' | 'house';
  /**
   * The one Stock Token a House vault trades, read from the vault itself (HouseVault.underlying(),
   * mm/house.ts UnderlyingReader): the vault's series selection keeps only that market's series. null only for the
   * treasury MakerVault and MM_VAULTS extras, which are multi-market by design and quote every quoted market. A House
   * vault whose underlying cannot be read is never a target (vaultTargets), so null never means "all markets" for one.
   */
  underlying: Address | null;
  caps: ResolvedCaps;
  /** Never null for a House vault: one that cannot be read is not quoted at all. */
  epoch: EpochView | null;
}

/**
 * Where each of the bot's OWN vaults ranks for MM_ASK_FALLBACK_ONLY, by lower-case vault: the vaults ranked
 * above it (it steps aside for their asks) and below it (it never does).
 *
 * reads.readOtherAskers drops only the planning vault's own orders, so every other vault this process quotes was
 * "another maker" to it, and two of them quoting one series stepped aside for EACH OTHER. Every vault plans from the
 * same head before any vault sends (tick()), so on one read both place an ask, on the next both find the other's ask
 * and both cancel ("no write target"), and the series has no ask from either until the next routine send, when both
 * place again. A change measured it on a v9 fork: the treasury and the NVDA House vault cancelled
 * 1533/1555 and 1587/1588 on one read, then 1589/1590 and 1606/1607 on a later one, all at the same price.
 *
 * So the vaults are ranked: House vaults first (the treasury's ask is the fallback, and a series a House vault
 * offers is left to it), then the treasury MakerVault and the MM_VAULTS extras. Within one kind the rank is the target
 * order (the treasury before its extras, House vaults in factory order): a tie-break that only stops two vaults of one
 * kind looping the same way, not a priority rule. Makers this process does not run are untouched.
 */
export interface SiblingRank {
  above: ReadonlySet<string>;
  below: ReadonlySet<string>;
}
export function siblingRanks(targets: ReadonlyArray<Pick<VaultTarget, 'address' | 'kind'>>): Map<string, SiblingRank> {
  const ranked = [...targets.filter((t) => t.kind === 'house'), ...targets.filter((t) => t.kind !== 'house')].map((t) => lc(t.address));
  return new Map(ranked.map((vault, i) => [vault, { above: new Set(ranked.slice(0, i)), below: new Set(ranked.slice(i + 1)) }]));
}

/**
 * An other-asker read as the planner takes it. The asks of the bot's vaults ranked BELOW this one are dropped;
 * those ranked ABOVE it are marked `sibling`, so the planner steps aside for them across the band their own vault leaves
 * a resting ask in (planner.stepAsideAsks). Every other maker's ask passes through unchanged.
 */
export function siblingAskers(read: OtherAskers, rank: SiblingRank): { asks: ReadonlyMap<string, OtherAskInput[]>; truncated: readonly string[] } {
  const asks = new Map([...read.asks].map(([id, list]) => [id, list.filter((o) => !rank.below.has(lc(o.maker))).map((o): OtherAskInput => (rank.above.has(lc(o.maker)) ? { ...o, sibling: true } : o))]));
  return { asks, truncated: read.truncated };
}

/** The three bot caps after MM_VAULT_CAPS, before the on-chain clamp. */
export interface ResolvedCaps {
  maxSeriesUnits: bigint;
  maxTotalNotionalUsdg6: bigint;
  dailyLossLimitUsdg6: bigint;
}

export interface TxRecord {
  /** A planner tx, or the EarnVault venue step's move. */
  type: MmTx['type'] | 'earn-sweep' | 'earn-pull';
  what: string;
  status: TxOutcome['status'];
  hash?: string;
  revert?: string | null;
  error?: string;
  gasUsed?: bigint;
  /** Set when the revert was the vault's outflow cap (INTERFACE_VERSION 7). */
  outflow?: OutflowRefusal;
}

export type { FillRecord } from './fills.js';

/** A vault call the outflow cap refused (`OutflowCapExceeded(available, outflow)`), decoded. */
export interface OutflowRefusal {
  what: string;
  available: bigint | null;
  wanted: bigint | null;
}

/**
 * Per quoted market, listed vs selected: what the registry ladder lists, what the series index holds live
 * for it, what the selection took, and every series the selection did NOT take with the halt it will carry. A trim
 * other than the two caps is NAMED here (pull-window, epoch-outside) rather than folded into "not-selected".
 */
export interface MarketCoverage {
  /** Series the market's resolved registry ladder lists (config: ladderSeriesCount). */
  listed: number;
  /** Live (unexpired) series of this market in the series index at this tick. */
  live: number;
  selected: number;
  /** Not selected, by the halt each will carry: the caps (`not-selected`), the pull window, the vault epoch. */
  trimmed: { 'not-selected': number; 'pull-window': number; 'epoch-outside': number };
}

/** The per-market coverage of one selection: pure, so a test can hand it 50 series and read 50 selected. */
export function marketCoverage(input: {
  now: number;
  live: readonly SeriesInfo[];
  picked: readonly SeriesInfo[];
  pullMinutes: number;
  epochEnd: number | null;
  tickerOf: ReadonlyMap<string, string>;
  listedByMarket: Readonly<Record<string, number>>;
}): Record<string, MarketCoverage> {
  const out: Record<string, MarketCoverage> = {};
  const row = (ticker: string): MarketCoverage =>
    (out[ticker] ??= { listed: input.listedByMarket[ticker] ?? 0, live: 0, selected: 0, trimmed: { 'not-selected': 0, 'pull-window': 0, 'epoch-outside': 0 } });
  for (const ticker of Object.keys(input.listedByMarket)) row(ticker);
  const pickedIds = new Set(input.picked.map((s) => s.longId.toString()));
  for (const s of input.live) {
    const r = row(input.tickerOf.get(s.underlying.toLowerCase()) ?? '?');
    r.live += 1;
    if (pickedIds.has(s.longId.toString())) {
      r.selected += 1;
    } else if (!(input.now < pullAtOf(s.expiry, input.pullMinutes))) {
      r.trimmed['pull-window'] += 1;
    } else if (input.epochEnd !== null && s.expiry > input.epochEnd) {
      r.trimmed['epoch-outside'] += 1;
    } else {
      r.trimmed['not-selected'] += 1;
    }
  }
  return out;
}

interface LastTick {
  head: Head;
  /** WHICH vault this tick was for. Every per-vault alert key and identity reads it. */
  vaultAddress: Address;
  vault: VaultState;
  input: TickInput;
  plan: TickPlan;
  stop: LossStop;
  txs: TxRecord[];
  /** USDG the chain says left the vault that this bot did not send (outflow.foreignSpend), or null. */
  foreignOutflow: bigint | null;
  /** Vault calls the cap refused this tick: after the first, no further bid grows (the cap is shared). */
  outflowRefused: OutflowRefusal[];
  pricing: { requested: number; failed: number; reasons: Record<string, number> };
  scan: { scannedTo: bigint | null; created: number; caughtUp: boolean };
  /** Listed vs selected per quoted market, and what trimmed the rest. */
  coverage: Record<string, MarketCoverage>;
  /** The routine-send gate and the tick budget of this vault. */
  sendGate: SendGate;
  budget: VaultBudget;
  startedAt: number;
  durationMs: number;
}

export function mmPlanParams(config: MmConfig): MmPlanParams {
  const t = config.tuning;
  return {
    halfSpreadBps: t.halfSpreadBps,
    minHalfSpreadUsdg6: t.minHalfSpreadUsdg6,
    expiryWidenS: t.expiryWidenS,
    expiryWidenBps: t.expiryWidenBps,
    pullMinutes: t.pullMinutes,
    quoteOffHours: t.quoteOffHours,
    fairMaxAgeS: t.fairMaxAgeS,
    fairMaxAgeOffHoursS: t.fairMaxAgeOffHoursS,
    skewBpsPerDeltaShare: t.skewBpsPerDeltaShare,
    maxSkewBps: t.maxSkewBps,
    requoteBps: t.requoteBps,
    resizeBps: t.resizeBps,
    maxSeries: t.maxSeries,
    maxSeriesPerMarket: t.maxSeriesPerMarket,
    bidUnits: t.bidUnits,
    askUnits: t.askUnits,
    askFallbackOnly: t.askFallbackOnly,
    writeOversubscribeBps: t.writeOversubscribeBps,
    maxSeriesUnits: t.maxSeriesUnits,
    maxTotalNotionalUsdg6: t.maxTotalNotionalUsdg6,
    deltaAlertShares: t.deltaAlertShares,
    syncIntervalS: t.syncIntervalS,
    depositTokens: t.depositTokens,
    maxQuoteLifetimeS: t.maxQuoteLifetimeS,
    fairSpotToleranceBps: t.fairSpotToleranceBps,
    epochWindDownS: t.epochWindDownS,
    // The safest-ask knobs. Listed here or they never reach planTick (the planner falls back to
    // engine.SAFEST_ASK_DEFAULTS, the same numbers, so an omission would silently ignore the env, not disable a guard).
    volMarkupPts: t.volMarkupPts,
    intrinsicBufferBps: t.intrinsicBufferBps,
    minPremiumUsdg6: t.minPremiumUsdg6,
    deltaBandLo: t.deltaBandLo,
    deltaBandHi: t.deltaBandHi,
    selectVol: t.selectVol,
    maxDeltaShares: t.maxDeltaShares,
    maxGamma: t.maxGamma,
    maxExpiryNotionalUsdg6: t.maxExpiryNotionalUsdg6,
    dailyMtmLossLimitUsdg6: t.dailyMtmLossLimitUsdg6,
    // Safe call selling: required on MmPlanParams, so a key left out here fails to compile.
    spotLagBps: t.spotLagBps,
    spotLagStaleBps: t.spotLagStaleBps,
    fairFromSession: t.fairFromSession,
    writeStopMinutes: t.writeStopMinutes,
  };
}

/**
 * The series a tick manages: the selection, plus every series with a vault order or tracked exposure that is not expired
 * or still has an order with units left, ON ANY MARKET. A market outside the quoted set (paused in the registry, dropped
 * from MM_MARKETS) is managed pull-only (planner: halt market-not-quoted): its live quotes are cancelled, its expired
 * escrow reclaimed, its inventory counted for a delta, instead of being left fillable at stale prices until validUntil.
 */
export function managedSeries(input: {
  now: number;
  picked: readonly SeriesInfo[];
  /** Series info of every series with a vault order or tracked exposure, by decimal longId. */
  extra: ReadonlyMap<string, SeriesInfo>;
  ordersBySeries: ReadonlyMap<string, readonly LiveOrder[]>;
}): Map<string, SeriesInfo> {
  const managed = new Map(input.picked.map((s) => [s.longId.toString(), s]));
  for (const [id, info] of input.extra) {
    const hasOrders = (input.ordersBySeries.get(id) ?? []).some((o) => !o.cancelled && o.filled < o.units);
    if (info.expiry > input.now || hasOrders) managed.set(id, info);
  }
  return managed;
}

/** The markets the bot quotes: MM_MARKETS (any status), else every live v2 market. */
export function quotedMarkets(config: Pick<MmConfig, 'registry' | 'tuning'>): V2Market[] {
  const tickers = config.tuning.markets;
  if (tickers === null) return v2Markets(config.registry, ['live']);
  return v2Markets(config.registry, ['live', 'paused', 'planned']).filter((m) => tickers.includes(m.ticker));
}

export class MmBot implements KillSwitch {
  readonly mm: MmStore;
  private addresses: MmAddresses | null = null;
  private calendar: Address | null;
  private wakeLoop: (() => void) | null = null;
  private last: LastTick | null = null;
  private lastByVault = new Map<string, LastTick>();
  private readonly house: HouseSupport;
  /** The target of each vault's last tick, for /state. */
  private targetsByVault = new Map<string, VaultTarget>();
  /** Last reason the House path was unavailable, for /state. */
  private houseUnavailable: HouseUnavailable = null;
  /**
   * Every House vault the last enumeration found, quoted or not. The kill cancels on these too: a vault skipped for an
   * unreadable epoch or kind (an untagged factory) may still hold orders an earlier tick placed.
   */
  private discoveredHouse: Address[] = [];
  /** MM_VAULTS entries refused this tick because they are House vaults. Mirrored into /state. */
  private refusedVaults: RefusedVault[] = [];
  /** Conclusive `epochEnd()` probe results per MM_VAULTS entry (code does not change under an address). */
  private readonly houseProbe = new Map<string, boolean>();
  private readonly isHouseVault: (vault: Address, blockNumber: bigint) => Promise<boolean>;
  private ticks = 0;
  /**
   * Transactions sent so far in the CURRENT tick, across every vault. Incremented by {execute} as each
   * send returns, so `tick()` can charge a vault's sends against the process budget even when that vault's
   * `sendVault` (before `tickOne`) throws AFTER sending (the head re-read or the outflow record can throw, and the catch in `tick()`
   * skipped the charge because `lastByVault` is only written at the very end of it).
   */
  private sentThisTick = 0;
  /** Head time of each vault's last read that sent a routine transaction (lower-case vault). */
  private readonly lastRoutineSendAt = new Map<string, number>();
  /** Consecutive routine sends of each vault the tick's budget cut short (lower-case vault). */
  private readonly budgetShortSends = new Map<string, number>();
  /**
   * Recent fills PER VAULT, one window each. This was a single 50-entry list with no vault field, so a busy
   * vault's fills evicted a quiet one's entirely and nothing in /state said which vault a fill belonged to -
   * exactly the reading an operator does during an incident. One window per vault cannot evict across vaults;
   * the flattened view carries the vault on every entry.
   */
  private recentFillsByVault = new Map<string, FillRecord[]>();
  /** post-trade markouts per vault (lower-case address), fed by trackOrders and observed each tick. */
  private readonly markoutsByVault = new Map<string, MarkoutBook>();
  /** The last tick's sales PER VAULT. A single field was overwritten by each vault tick, so /state reported the last vault ticked and called it the vault's. */
  private lastSalesByVault = new Map<string, TrackResult['sales']>();
  /**
   * In-flight cancel runs, KEYED BY SCOPE. This was a single promise, so a kill for vault B while a
   * kill for vault A was still cancelling returned A's counts to B's caller and published them as B's - the
   * operator read `cancelled: 12, done: true` about a vault nothing had touched. The key is the vault address,
   * or `ALL_VAULTS` for a body-less kill, so a second kill of the SAME scope still coalesces (which is the
   * behaviour worth keeping) while a different scope gets its own run and its own answer.
   */
  private killRuns = new Map<string, Promise<{ cancelled: number; remaining: number; remainingOrderIds: bigint[]; errors: string[] }>>();
  private anchored: Promise<void> | null = null;
  private lastKill: KillOutcome | null = null;
  /**
   * Wall clock of the last v2_mm_loss_stop delivery that failed, PER VAULT. A single instance field was wrong in
   * BOTH directions rather than conservative: vault A's failed delivery delayed vault B's page by up to
   * FAILED_DELIVERY_RETRY_MS, and A's later success cleared the clock and unblocked B early.
   */
  private lossStopFailedAt = new Map<string, number>();
  /** Consecutive ticks each vault (lower-case) halted a series guards-unreadable; the page escalates at GUARDS_UNREADABLE_ERROR_TICKS. */
  private guardsUnreadableTicks = new Map<string, number>();
  private readonly wall: () => number;
  private readonly params: MmPlanParams;
  /**
   * P15, one per process (every vault's tick records the same market's spot; a repeat at one head adds a
   * zero move). In memory on purpose: a restart forgets a halt and the fresh history trips again on the next move.
   */
  private readonly breaker: SpotMoveBreaker;
  /** Where the EarnVault's queue head was first seen standing, and the last Earn step, for /state. */
  private earnWatch: QueueWatch | null = null;
  private lastEarn: (EarnKeepResult & { at: number }) | null = null;

  constructor(readonly ctx: MmBotContext) {
    this.wall = ctx.now ?? Date.now;
    this.params = mmPlanParams(ctx.config);
    this.breaker = new SpotMoveBreaker({ bps: ctx.config.tuning.breakerBps, windowS: ctx.config.tuning.breakerWindowS, haltS: ctx.config.tuning.breakerHaltS });
    this.calendar = ctx.config.contracts.expiryCalendar;
    this.mm = new MmStore(ctx.store);
    this.house = houseSupport(ctx.config.tuning.houseFactories, ctx.house, ctx.client);
    this.isHouseVault = ctx.isHouseVault ?? answersEpochEnd(ctx.client);
    this.houseUnavailable = this.house.unavailable;
    const vaults = [ctx.config.contracts.makerVault, ...ctx.config.tuning.extraVaults];
    // The spot-lag clock (spot-lag.ts) prices on calendar.ts's NYSE table, which ends with its last listed
    // year. Warn at boot while a quarter is left to add the next year's closures (the wall clock: no head block yet).
    const horizon = holidayHorizon(Math.floor(this.wall() / 1000));
    if (horizon.warning !== null) ctx.log.warn({ holidayHorizon: horizon }, horizon.warning);
    // Say at boot what the caps cover. Derived caps cover every listed series of every quoted market;
    // explicit caps were already checked against the ladder by config.ts, so this line is the record, not the gate.
    ctx.log.info(
      {
        maxSeries: this.params.maxSeries,
        maxSeriesPerMarket: this.params.maxSeriesPerMarket,
        derived: ctx.config.tuning.seriesCoverage.derived,
        listedByMarket: ctx.config.tuning.seriesCoverage.listedByMarket,
      },
      ctx.config.tuning.seriesCoverage.derived
        ? 'mm series caps derived from the registry ladder: every listed series of every quoted market is selectable'
        : 'mm series caps set explicitly (MM_MAX_SERIES / MM_MAX_SERIES_PER_MARKET); config.ts verified they cover the ladder',
    );
    const wiped = this.mm.bind({
      chainId: ctx.config.chainId,
      clearinghouse: ctx.config.contracts.clearinghouse,
      orderBook: ctx.config.contracts.orderBook,
      vaults,
      // The rows written before the vault column existed are the treasury's: mm-store migrateLegacy.
      treasury: ctx.config.contracts.makerVault,
    });
    if (wiped) ctx.log.warn({}, 'the MM store described another deployment; it was cleared (series rescanned, vault orders adopted afresh)');
    const killed = this.mm.killed();
    if (killed !== null) ctx.log.warn({ killedAt: killed.at, reason: killed.reason }, 'the kill switch is engaged: nothing is quoted until POST /resume');
  }

  bindLoop(loop: { wake(): void }): void {
    this.wakeLoop = () => loop.wake();
  }

  /*------------------------------- setup ------------------------------*/

  /** Once per process, before the store is read: reset it if it describes another deployment at these addresses. */
  private bindAnchor(): Promise<void> {
    this.anchored ??= (async () => {
      const anchor = await readDeploymentAnchor(this.ctx.client, this.ctx.config.registry.deployBlock);
      const recorded = this.mm.anchor();
      const check = this.mm.bindAnchor(anchor);
      const warning = anchorWarning(check, 'the MM store');
      if (warning !== null) this.ctx.log.warn({ check, anchor, recorded, db: this.ctx.store.path }, `${warning}${check === 'unanchored' ? '' : ' (series rescanned, vault orders adopted afresh, pending journal rows dropped; the kill switch is kept)'}`);
      else this.ctx.log.info({ check, anchor }, 'MM store bound to the deployment anchor');
    })().catch((error: unknown) => {
      this.anchored = null;
      throw error;
    });
    return this.anchored;
  }

  /** Treasury first, then MM_VAULTS extras, unique, checksummed. */
  quotedVaults(): Address[] {
    const treasury = getAddress(this.ctx.config.contracts.makerVault);
    const out: Address[] = [treasury];
    const seen = new Set([lc(treasury)]);
    for (const v of this.ctx.config.tuning.extraVaults) {
      if (seen.has(lc(v))) continue;
      seen.add(lc(v));
      out.push(getAddress(v));
    }
    return out;
  }

  /** MM_VAULT_CAPS for this vault, falling back to the process-wide MM_* values. Only ever tightens. */
  private capsFor(vault: string): ResolvedCaps {
    const t = this.ctx.config.tuning;
    const o = t.vaultCaps.get(lc(vault)) ?? {};
    return {
      maxSeriesUnits: o.maxSeriesUnits ?? t.maxSeriesUnits,
      maxTotalNotionalUsdg6: o.maxTotalNotionalUsdg6 ?? t.maxTotalNotionalUsdg6,
      dailyLossLimitUsdg6: o.dailyLossLimitUsdg6 ?? t.dailyLossLimitUsdg6,
    };
  }

  /**
   * The vaults of this tick: the treasury MakerVault, the MM_VAULTS extras, and every House vault the
   * factory enumerates.
   *
   * FAIL CLOSED ON THE HOUSE SIDE. A House vault whose epoch cannot be read is SKIPPED, not quoted
   * with `epoch: null` - `null` means "no epoch discipline" to mm/epoch.ts, so the fallback would be
   * permission to open risk past `epochEnd` in the one kind of vault that must be flat for `rollEpoch`.
   * `rollDue` is recomputed here from the head's own timestamp so it cannot be stale or invented.
   */
  /** Why no House vault is being quoted, or null when the House path works. Mirrored into /state. */
  houseGap(): HouseUnavailable {
    return this.houseUnavailable;
  }

  async vaultTargets(head: Head): Promise<VaultTarget[]> {
    // underlying null: the treasury MakerVault and MM_VAULTS extras quote every quoted market (VaultTarget.underlying).
    const target = (address: Address): VaultTarget => ({ address, kind: 'treasury' as const, underlying: null, caps: this.capsFor(address), epoch: null });
    const [treasury, ...extras] = this.quotedVaults();
    const out: VaultTarget[] = [target(treasury!)];
    this.houseUnavailable = this.house.unavailable;
    /*
     * HOUSE DISCOVERY RUNS BEFORE THE MM_VAULTS EXTRAS ARE ACCEPTED, because the extras are checked
     * against it. `discovered` stays null when the House path is unavailable or cannot be enumerated; the extras
     * are still probed one by one below, so an unconfigured or broken factory cannot let a House vault through.
     */
    let discovered: readonly DiscoveredHouseVault[] | null = null;
    if (this.house.unavailable !== null) {
      await this.ctx.alerter.alert(
        'v2_mm_house_unavailable',
        `House vaults are configured but cannot be quoted: ${this.house.unavailable}`,
        { factories: this.factoryAddresses() },
        { force: true },
      );
    } else if (this.house.discover !== null) {
      // ENUMERATION FAILS CLOSED TOO, and it must not take the treasury down with it. A factory that
      // cannot be enumerated - RPC down, wrong address, not a factory - is REPORTED every tick rather
      // than being silently equivalent to "no House vaults" (mm/house.ts header), and the treasury
      // vaults above still quote. Letting the throw escape would stop the whole tick, which is a worse
      // failure than the one this path exists to handle.
      try {
        discovered = await this.house.discover(head.blockNumber);
      } catch (error) {
        this.houseUnavailable = `House factory could not be enumerated: ${(error as Error).message}`;
        await this.ctx.alerter.alert(
          'v2_mm_house_unavailable',
          `House vaults are configured but the factory could not be enumerated: ${(error as Error).message}`,
          { factories: this.factoryAddresses() },
          { force: true },
        );
      }
    }
    /*
     * AN MM_VAULTS ENTRY THAT IS A HOUSE VAULT IS REFUSED, NOT QUOTED AS A TREASURY VAULT.
     *
     * An MM_VAULTS address is quoted with `epoch: null`, which mm/epoch.ts reads as "no epoch discipline": on a
     * House vault that is permission to open risk past `epochEnd` in the one kind of vault that must be flat for
     * `rollEpoch` - fail-OPEN on depositor money. Before this, such an address was quoted as a treasury vault and
     * the House loop below then skipped it as already seen, so a House vault listed in MM_VAULTS lost its epoch.
     *
     * A House vault is recognised two ways, so neither order of discovery lets one through: a configured factory
     * enumerates it, or it answers `epochEnd()` (no factory needed). It is refused for THAT VAULT ONLY, not for the
     * whole bot: failing every vault would also stop the treasury and the correctly discovered House vaults,
     * including the wind-down cancels a House vault needs before its roll (the boundary in tick()).
     * It is not re-classified as House either (that would hide the config error): it is quoted by NEITHER path
     * until MM_VAULTS no longer lists it, and `v2_mm_vault_is_house` pages with the fix. A probe that cannot reach
     * the chain skips the vault for this tick (`v2_mm_vault_unreadable`) and is asked again on the next.
     */
    const enumerated = new Map((discovered ?? []).map((d) => [lc(d.vault), d] as const));
    const refused = new Set<string>();
    this.refusedVaults = [];
    for (const address of extras) {
      const verdict = await this.houseVerdict(address, enumerated, head.blockNumber);
      if (verdict === null) {
        out.push(target(address));
      } else if ('unreadable' in verdict) {
        await this.ctx.alerter.alert(
          'v2_mm_vault_unreadable',
          `MM_VAULTS entry ${address} could not be checked for being a House vault (epochEnd() probe failed), so it is ` +
            `NOT quoted this tick; the other vaults still quote: ${verdict.unreadable}`,
          { vault: address, error: verdict.unreadable },
          { dedupeKey: lc(address) },
        );
      } else {
        refused.add(lc(address));
        this.refusedVaults.push({ address, reason: verdict.reason });
        await this.ctx.alerter.alert(
          'v2_mm_vault_is_house',
          `MM_VAULTS lists ${address}, which is a House vault (${verdict.reason}). It is NOT quoted by this process - not ` +
            'as a treasury vault (that would drop its epoch) and not as a House vault. House vaults are quoted only through ' +
            'MM_HOUSE_FACTORY discovery, with their epoch: remove it from MM_VAULTS. Until then every order it already rests ' +
            'is cancelled each tick (cancel-only: nothing new is placed on it), and a kill cancels them too.',
          { vault: address, reason: verdict.reason },
          { dedupeKey: lc(address) },
        );
      }
    }
    if (discovered === null) return out;
    this.discoveredHouse = discovered.map((d) => d.vault);
    // A refused MM_VAULTS entry is skipped here too: it is quoted by neither path (above).
    const seen = new Set([...out.map((t) => lc(t.address)), ...refused]);
    for (const found of discovered) {
      const address = found.vault;
      if (seen.has(lc(address))) continue;
      seen.add(lc(address));
      if (found.factoryKind === 'unknown') {
        // The kind rule is the factory's, and this one was configured without a tag. Neither answer may be
        // guessed (config.ts HouseFactoryKind), so the vault is not quoted and the fix is named.
        this.houseUnavailable = `House factory ${found.factory} is untagged; its vaults are not quoted`;
        await this.ctx.alerter.alert(
          'v2_mm_house_unavailable',
          `House vault ${address} comes from factory ${found.factory}, which MM_HOUSE_FACTORY lists without a kind tag; ` +
            'it is NOT quoted. Tag the factory :legacy-weekly (pre-T-OP-101, no weekly() getter) or :kinded (T-OP-101).',
          { vault: address, factory: found.factory },
          { dedupeKey: lc(address) },
        );
        continue;
      }
      const read = this.house.readEpoch === null ? null : await this.house.readEpoch(found, head.blockNumber);
      // A view without a kind is as unusable as no view: the wind-down would fall back to the weekly lead on a vault
      // that may be daily. Only the runtime reader is guaranteed to set it; an injected one must too.
      if (read === null || read.kind === undefined) {
        this.houseUnavailable = `epoch unreadable for House vault ${address}`;
        await this.ctx.alerter.alert(
          'v2_mm_house_unavailable',
          `House vault ${address} was discovered but its epoch could not be read; it is NOT quoted`,
          { vault: address },
          { dedupeKey: lc(address) },
        );
        continue;
      }
      /*
       * A House vault holds ONE stock's depositors: it quotes that market's series only. Before this the target
       * carried `underlying: null` ("until the factory ABI lands") and the vault picked from every market's live series
       * by expiry alone -- with SPCX Friday-only, Monday to Thursday the SPCX vault's only in-window series
       * were NVDA's. The contract does not refuse it either (HouseVault._seriesInEpoch checks existence and expiry).
       * Read from the vault, not the registry: the registry can be wrong, the vault's immutable cannot. Unreadable: not
       * quoted and paged, like an unreadable epoch; never every market.
       */
      const underlying = this.house.readUnderlying === null ? null : await this.house.readUnderlying(address, head.blockNumber);
      if (underlying === null) {
        this.houseUnavailable = `underlying unreadable for House vault ${address}`;
        await this.ctx.alerter.alert(
          'v2_mm_house_unavailable',
          `House vault ${address} was discovered but its underlying() could not be read; it is NOT quoted (it would otherwise pick series of every market)`,
          { vault: address, reason: 'underlying-unreadable' },
          { dedupeKey: lc(address) },
        );
        continue;
      }
      out.push({
        address,
        kind: 'house',
        underlying,
        caps: this.capsFor(address),
        epoch: {
          ...read,
          rollDue: rollDue(read.epochEnd, head.timestamp),
          // The vault's own lead. epochSelectable prefers it over the process-wide epochWindDownS.
          windDownS: read.kind === 'daily' ? this.ctx.config.tuning.epochWindDownDailyS : this.ctx.config.tuning.epochWindDownS,
          // A legacy weekly vault once a daily factory is configured closes only, for its whole epoch. It stays
          // in the list (so its resting orders are still cancelled and its inventory closed) but opens nothing new.
          windingDown: legacyWeeklyWindingDown(found.factoryKind, this.ctx.config.tuning.houseFactories),
        },
      });
    }
    return out;
  }

  /** MM_VAULTS entries refused as House vaults on the last tick. Mirrored into /state. */
  refused(): readonly RefusedVault[] {
    return this.refusedVaults;
  }

  /**
   * Null = not a House vault (quote it as MM_VAULTS says); `reason` = it is one, refuse it;
   * `unreadable` = the probe could not reach the chain, skip it this tick. A conclusive probe answer is cached.
   */
  private async houseVerdict(
    address: Address,
    enumerated: ReadonlyMap<string, DiscoveredHouseVault>,
    blockNumber: bigint,
  ): Promise<null | { reason: string } | { unreadable: string }> {
    const found = enumerated.get(lc(address));
    if (found !== undefined) return { reason: `House factory ${found.factory} enumerates it` };
    let answers = this.houseProbe.get(lc(address));
    if (answers === undefined) {
      try {
        answers = await this.isHouseVault(address, blockNumber);
      } catch (error) {
        return { unreadable: describeError(error) };
      }
      this.houseProbe.set(lc(address), answers);
    }
    return answers ? { reason: 'it answers HouseVault.epochEnd()' } : null;
  }

  private async resolveAddresses(blockNumber: bigint): Promise<MmAddresses> {
    if (this.addresses !== null) return this.addresses;
    const { client, config } = this.ctx;
    const { clearinghouse, orderBook, makerVault } = config.contracts;
    const vaultBook = await client.readContract({ address: makerVault, abi: makerVaultAbi, functionName: 'orderBook', blockNumber });
    if (lc(vaultBook) !== lc(orderBook)) {
      throw new Error(`MAKER_VAULT ${makerVault} quotes on order book ${vaultBook}, not the configured ${orderBook}: refusing to quote`);
    }
    const usdg = config.registry.usdg ?? (await client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: 'usdg', blockNumber }));
    this.calendar ??= await client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: 'calendar', blockNumber });
    // accessManager is a REQUIRED contract for V2_MODE=mm (config.ts MODE_CONTRACTS): a bot that cannot
    // read whether it may quote must refuse to start, not quote blind.
    this.addresses = { clearinghouse, orderBook, vault: makerVault, usdg: getAddress(usdg), manager: config.contracts.accessManager };
    return this.addresses;
  }

  /** Extra vaults that quote on another book are skipped; treasury mismatch still throws in resolveAddresses. */
  private async addressesFor(vault: Address, blockNumber: bigint): Promise<MmAddresses | 'wrong-book'> {
    const shared = await this.resolveAddresses(blockNumber);
    if (lc(vault) === lc(shared.vault)) return shared;
    const vaultBook = await this.ctx.client.readContract({ address: vault, abi: makerVaultAbi, functionName: 'orderBook', blockNumber });
    if (lc(vaultBook) !== lc(shared.orderBook)) return 'wrong-book';
    return { ...shared, vault };
  }

  /*------------------------------- orders -----------------------------*/

  /** Vault orders placed since the last ingestion into the store (all of them, adopted, the first time). */
  private async ingestOrders(a: MmAddresses, count: bigint, head: Head): Promise<number> {
    const index = this.mm.makerIndex(a.vault);
    const from = index ?? 0n;
    if (count <= from) {
      if (index === null) this.mm.ingestOrders([], count, this.wall(), a.vault);
      return 0;
    }
    const ids = await readMakerOrderIds(this.ctx.client, a.orderBook, a.vault, from, count, head.blockNumber);
    const orders = await readOrders(this.ctx.client, a.orderBook, ids, head.blockNumber);
    const adopt = index === null;
    this.mm.ingestOrders(
      orders.map((o) => ({ order: { orderId: o.id, longId: o.longId, kind: o.kind, price: o.price, units: o.units, filledSeen: adopt ? o.filled : 0n }, closed: false })),
      from + BigInt(ids.length),
      this.wall(),
      a.vault,
    );
    if (adopt && orders.length > 0) this.ctx.log.info({ orders: orders.length }, 'adopted the vault\'s existing orders at their current fills');
    return orders.length;
  }

  /**
   * Re-read every open vault order; record fills (each sale at the seller fee its OrderFilled logs show, fills.ts) and
   * closes. Returns the chain state of those orders.
   */
  private async trackOrders(a: MmAddresses, fees: VaultState['fees'], head: Head): Promise<ChainOrder[]> {
    const tracked = await trackVaultOrders(
      { client: this.ctx.client, logClient: this.ctx.logClient, mm: this.mm, log: this.ctx.log, orderBook: a.orderBook, vault: a.vault, deployBlock: this.ctx.config.registry.deployBlock ?? 0n },
      fees,
      head,
    );
    const vaultKey = lc(a.vault);
    if (tracked.fills.length > 0) {
      const book = this.markoutBook(vaultKey);
      for (const f of tracked.fills) book.record({ at: f.at, orderId: f.orderId, longId: f.longId, side: f.side, units: f.units, price: f.price });
      const window = [...tracked.fills.reverse(), ...(this.recentFillsByVault.get(vaultKey) ?? [])].slice(0, RECENT_FILLS_PER_VAULT);
      this.recentFillsByVault.set(vaultKey, window);
    }
    this.lastSalesByVault.set(vaultKey, tracked.sales);
    return tracked.chain;
  }

  private markoutBook(vaultKey: string): MarkoutBook {
    let book = this.markoutsByVault.get(vaultKey);
    if (book === undefined) {
      book = new MarkoutBook();
      this.markoutsByVault.set(vaultKey, book);
    }
    return book;
  }

  /**
   * Store the markout checkpoints that have come due, with the fairs this tick already read
   * plus a bounded extra read for due series it did not quote, then page or clear v2_mm_markout_low. Never throws: a
   * pricing failure leaves the checkpoint pending (and, past its grace, missing), it never stops the quoting tick.
   * A series already expired is not asked for: its later "fair" is its settlement, which is not a markout.
   * A fair is stored only when it passes the quoting path's own clock checks (engine.fairClockHalt, `clock`):
   * a stale asOf, or in session a chain dated before this session's open, leaves the checkpoint pending instead of
   * marking a fill against the previous close.
   */
  private async markoutTick(vault: Address, head: Head, fairs: ReadonlyMap<string, FairInput>, tickerFor: (info: SeriesInfo) => string | null, clock: FairClockInput): Promise<void> {
    const vaultKey = lc(vault);
    const book = this.markoutsByVault.get(vaultKey);
    if (book === undefined) return;
    const due = book.due(head.timestamp);
    if (due.length > 0) {
      const have = new Map<string, bigint>();
      for (const [id, f] of fairs) if (f.ok && fairClockHalt(clock, f.asOf) === null) have.set(id, f.fair);
      const infos = this.mm.seriesByIds(due.filter((id) => !have.has(id.toString())));
      const extra = [...infos.values()]
        .filter((info) => info.expiry > head.timestamp && tickerFor(info) !== null)
        .slice(0, MARKOUT_EXTRA_FAIRS_PER_TICK);
      if (extra.length > 0) {
        try {
          const answers = await this.ctx.pricing.fairMany(extra.map((info) => ({ ticker: tickerFor(info)!, strike: info.strike, expiry: info.expiry, isPut: info.isPut })));
          answers.forEach((f, i) => {
            if (f.ok && fairClockHalt(clock, f.asOf) === null) have.set(extra[i]!.longId.toString(), f.fair);
          });
        } catch (err) {
          this.ctx.log.warn({ vault, error: describeError(err) }, 'markout fair read failed; checkpoints stay pending');
        }
      }
      book.observe(head.timestamp, (longId) => have.get(longId.toString()));
    }
    const rule = this.ctx.config.tuning.markoutAlert;
    const alert = book.alert(rule);
    if (alert !== null) {
      await this.ctx.alerter.alert(
        'v2_mm_markout_low',
        `MM vault ${vaultKey}: the last ${alert.fills} fills are marked out ${alert.meanBps} bps at 30 min (notional-weighted; alert below ${alert.thresholdBps}). Fills are landing on the wrong side of where the option went next: check the asks for staleness or cheapness`,
        { vault: vaultKey, ...alert },
        { dedupeKey: markoutAlertKey(vaultKey) },
      );
    } else {
      this.ctx.alerter.clear('v2_mm_markout_low', markoutAlertKey(vaultKey));
    }
  }

  /** Settled long ids a vault held nothing of when last read; never asked about again. */
  private settledEmpty = new Map<string, Set<string>>();

  private isEarnVault(vault: Address): boolean {
    const earn = this.ctx.config.tuning.earn?.vault;
    return earn !== undefined && lc(earn) === lc(vault);
  }

  /**
   * (N3). The settled tokens a treasury MakerVault still holds. Candidates are the expired series of the vault's
   * MM ledger (every series it traded) and of `trackedSeries`, less the ones already read empty. A settled series drops
   * out of the managed set once it has no live order (managedSeries), so the planner never sees it through `series`.
   */
  private async settledHoldings(a: MmAddresses, tracked: readonly bigint[], head: Head): Promise<Array<{ tokenId: bigint; longId: bigint; units: bigint }>> {
    const done = this.settledEmpty.get(lc(a.vault)) ?? new Set<string>();
    const ids = new Set<string>([...this.mm.ledger(a.vault).map((e) => e.longId), ...tracked.map((id) => id.toString())]);
    for (const id of done) ids.delete(id);
    if (ids.size === 0) return [];
    const infos = this.mm.seriesByIds([...ids].map((id) => BigInt(id)));
    const expired = [...ids].filter((id) => {
      const info = infos.get(id);
      return info !== undefined && info.expiry <= head.timestamp;
    }).map((id) => BigInt(id));
    if (expired.length === 0) return [];
    const { held, empty, waiting } = await readSettledHoldings(this.ctx.client, a, expired, head.blockNumber);
    // A converted call payout without a fresh spot would revert MakerVault.redeem; it waits for a print.
    for (const w of waiting) this.ctx.log.warn({ vault: a.vault, tokenId: w.tokenId, units: w.units }, `redeem held: ${w.reason}`);
    for (const id of empty) done.add(id.toString());
    this.settledEmpty.set(lc(a.vault), done);
    return held;
  }

  /** Settlements of open ledger positions, then the loss stop for the head's day. */
  private async ledgerStop(a: MmAddresses, head: Head, dailyLossLimitUsdg6: bigint): Promise<LossStop> {
    let ledger = replayLedger(this.mm.ledger(a.vault));
    const open = [...ledger.positions].filter(([, p]) => p.units !== 0n).map(([id]) => BigInt(id));
    if (open.length > 0) {
      const infos = this.mm.seriesByIds(open);
      const expired = open.filter((id) => {
        const info = infos.get(id.toString());
        // Per vault: asking the global question here is what filtered a second vault's expired
        // position out of `expired` for ever, so it never settled and its loss never reached its loss stop.
        return info !== undefined && info.expiry <= head.timestamp && !this.mm.hasSettlement(id, a.vault);
      });
      if (expired.length > 0) {
        const settlements = await readSettlements(this.ctx.client, a.clearinghouse, expired, head.blockNumber);
        let recorded = 0;
        for (const id of expired) {
          const s = settlements.get(id.toString());
          if (s === undefined || !s.settled) continue;
          this.mm.recordSettlement({ type: 'settle', longId: id.toString(), isPut: s.isPut, strike: s.strike, settlementPrice: s.settlementPrice, exerciseFeeBps: s.exerciseFeeBps, at: head.timestamp }, a.vault);
          recorded += 1;
        }
        if (recorded > 0) ledger = replayLedger(this.mm.ledger(a.vault));
      }
    }
    return lossStop(ledger, head.timestamp, dailyLossLimitUsdg6);
  }

  /*-------------------------------- tick ------------------------------*/

  async tick(): Promise<TickPlan> {
    const startedAt = this.wall();
    const { client, config, log } = this.ctx;
    await this.bindAnchor();
    const head = await readHead(client);
    // When the head was read, by the bot's clock, so each send can date itself in chain time (execute).
    const headAt = this.wall();
    const shared = await this.resolveAddresses(head.blockNumber);
    const scan = await scanSeries(this.ctx.logClient, this.mm, { clearinghouse: shared.clearinghouse, deployBlock: config.registry.deployBlock ?? 0n, head: head.blockNumber });
    const targets = await this.vaultTargets(head);
    const protocolAccounts = this.protocolAccountSet(targets.map((t) => t.address));
    /*
     * MM_MAX_TX_PER_TICK IS A PROCESS BUDGET, SPENT TREASURY FIRST WITH A RESERVE FOR THE REST.
     *
     * Treasury first because it is the live vault and carries the protocol's existing inventory, so
     * its cancels and syncs are the ones that must not wait a tick. Strict treasury-first alone is
     * not safe, though: a treasury that saturates the budget every tick would starve a House vault
     * of even its cancels, and a vault that cannot cancel cannot wind down for `rollEpoch`. So each
     * vault still to come reserves an equal `share`, released the moment its own turn arrives.
     */
    // READ PHASE, every vault, before any of them plans: the union book below depends on it.
    const prepared: PreparedVault[] = [];
    for (const target of targets) {
      /*
       * ONE VAULT'S FAULT IS NOT THE FLEET'S. There was no boundary here, so a single bad
       * MM_VAULTS entry - an address with no code, a vault mid-migration, one RPC read that throws - aborted
       * the whole tick. That took down quoting for every HEALTHY vault too, including the epoch wind-down
       * cancels a House vault needs to be flat for its roll, which is the opposite of what a fault should do.
       * The failing vault is skipped and paged; the others tick.
       *
       * THE BOUNDARY STARTS AT addressesFor. That is the read of a non-treasury vault's `orderBook`,
       * the first thing to throw for an address with no code, and it used to sit above this try - so the
       * exact case named above still aborted every vault after it.
       */
      try {
        const a = await this.addressesFor(target.address, head.blockNumber);
        if (a === 'wrong-book') {
          await this.ctx.alerter.alert(
            'v2_mm_wrong_book',
            `vault ${target.address} quotes on a different order book than the registry; skipped this tick`,
            { vault: target.address, registryBook: shared.orderBook },
            { dedupeKey: lc(target.address) },
          );
          continue;
        }
        this.targetsByVault.set(lc(target.address), target);
        const vault = await readVaultState(client, a, { signer: this.ctx.signer, calendar: this.calendar!, now: head.timestamp, blockNumber: head.blockNumber, house: target.kind === 'house' });
        await this.ingestOrders(a, vault.makerOrderCount, head);
        prepared.push({ a, target, vault, chainOrders: await this.trackOrders(a, vault.fees, head) });
      } catch (error) {
        await this.ctx.alerter.alert(
          'v2_mm_vault_unreadable',
          `vault ${target.address} could not be read this tick and is skipped; the other vaults still quote: ${describeError(error)}`,
          { vault: target.address, error: describeError(error) },
          { dedupeKey: lc(target.address) },
        );
      }
    }
    /*
     * ONE RESTING BOOK FOR THE WHOLE TICK, from the union of every quoted vault's live orders.
     *
     * This is the difference between the cross-vault guard working and only appearing to. The hazard
     * protocol-accounts.ts exists for is vault A bidding 100 while vault B asks 99, which lets any
     * outside account take B and hit A for a riskless 1 paid by depositors. A book built from the
     * ticking vault's own orders cannot contain B's ask while A plans, so `crossesProtocol` could
     * only ever catch A crossing itself - and `v2_mm_protocol_cross` would read as coverage that
     * does not exist. Same array to every vault.
     */
    const protocolBook = unionProtocolBook(prepared.map((p) => p.chainOrders), protocolAccounts, head.timestamp);
    // From every target, not only the vaults read this tick: a vault skipped as unreadable still rests its asks.
    const ranks = siblingRanks(targets);
    /*
     * THE ARITHMETIC (pinned in quoter.test.ts, and since changed). With M = maxTxPerTick and n planned
     * vaults, `share` = max(1, floor(M / n)). EVERY VAULT PLANS FIRST, then they send in order, treasury first. A vault
     * still to send reserves what its plan NEEDS, up to one `share`: min(share, its transaction count). Vault i may send
     * `remaining - reserve`, the reserve capped so the vault sending keeps at least one `share` of what remains, and
     * whatever a vault leaves unspent flows to the next. So with M = 10, three vaults and House plans of 1 transaction
     * each, the treasury may send 8, not 4.
     *
     * Before this, each vault still to come reserved a full `share` whether its plan needed it or not, and what a
     * House vault left flowed only to the vaults after it, never back to the treasury. At the launch env (M 60, three
     * vaults) the treasury was held to 20 a tick while each House vault sent about 2: a change measured 20 transactions
     * every tick and live asks on only 15 to 25 of 50 series. A House vault still gets up to its `share` before the
     * treasury's surplus, so a treasury that saturates the budget cannot starve its cancels (the reason for the reserve).
     *
     * `remaining` is charged from {sentThisTick}, which {execute} counts as sends return, NOT from
     * `lastByVault`: that record is written at the END of `sendVault`, so a vault that threw after sending (the
     * post-send head re-read is an RPC call) was never charged and the vaults after it were budgeted as if
     * nothing had gone out -- a tick could then exceed M by that vault's sends. Charging what was actually
     * sent, on the catch path too, keeps M a bound on the process rather than on the vaults that finished.
     */
    this.sentThisTick = 0;
    // A refused MM_VAULTS entry's resting orders, cancelled before any vault plans. Charged to the budget.
    await this.cancelRefused(head);
    // PLAN PHASE, every vault, before any of them sends. Same boundary as the read phase: a vault that throws while
    // planning must not stop the rest.
    const planned: PlannedVault[] = [];
    for (const p of prepared) {
      try {
        planned.push(await this.planVault(p, head, scan, protocolAccounts, protocolBook, startedAt, ranks.get(lc(p.target.address)) ?? { above: new Set(), below: new Set() }));
      } catch (error) {
        await this.ctx.alerter.alert(
          'v2_mm_vault_unreadable',
          `vault ${p.a.vault} failed mid-tick and is skipped; the other vaults still quote: ${describeError(error)}`,
          { vault: p.a.vault, error: describeError(error) },
          { dedupeKey: lc(p.a.vault) },
        );
      }
    }
    const share = Math.max(1, Math.floor(config.tuning.maxTxPerTick / Math.max(1, planned.length)));
    let remaining = config.tuning.maxTxPerTick - this.sentThisTick;
    let first: TickPlan | null = null;
    for (const [i, pv] of planned.entries()) {
      // A vault with no budget left still runs sendVault with 0: its /state, its alerts and the budget-short count
      // must see the tick it was cut out of.
      const budget = vaultBudgetOf(remaining, share, planned.slice(i + 1).map((q) => q.plan.txs.length));
      // Same boundary again for the sends.
      let plan: TickPlan;
      try {
        plan = await this.sendVault(pv, head, startedAt, budget, headAt);
      } catch (error) {
        await this.ctx.alerter.alert(
          'v2_mm_vault_unreadable',
          `vault ${pv.prepared.a.vault} failed mid-tick and is skipped; the other vaults still quote: ${describeError(error)}`,
          { vault: pv.prepared.a.vault, error: describeError(error) },
          { dedupeKey: lc(pv.prepared.a.vault) },
        );
        remaining = config.tuning.maxTxPerTick - this.sentThisTick;
        continue;
      }
      remaining = config.tuning.maxTxPerTick - this.sentThisTick;
      if (first === null) first = plan;
    }
    // The EarnVault venue step, once per tick after every vault has quoted (its own fault boundary inside).
    if (config.tuning.earn !== null) await this.earnTick(head);
    // A tick longer than the replace margin (MM_REPLACE_CONFIRM_S) is a slow or rate-limited RPC. Its places are
    // stamped at send and its late replaces skipped (execute), but the book it quotes thins; paged per the cooldown, with
    // the duration, before coverage collapses. Measured on a v9 fork: 76-123 s ticks, ask coverage 0-35 of 40.
    const tookS = (this.wall() - startedAt) / 1000;
    if (tookS > config.tuning.replaceConfirmS) {
      await this.ctx.alerter.alert(
        'v2_mm_slow_tick',
        `mm tick took ${tookS.toFixed(1)} s, over MM_REPLACE_CONFIRM_S ${config.tuning.replaceConfirmS} s: late places are stamped at their own send, but replaces the chain no longer has time for are skipped and coverage thins (a slow or rate-limited RPC?)`,
        { durationS: tookS, replaceConfirmS: config.tuning.replaceConfirmS },
        { dedupeKey: 'tick' },
      );
    }
    this.ticks += 1;
    const plan = first ?? {
      selected: [],
      netDelta: [],
      series: [],
      txs: [],
      capped: [],
      outflow: { cap: 0n, used: 0n, released: 0n, budget: 0n, planned: 0n, blocked: false },
    };
    log.info(
      {
        vaults: targets.length,
        house: targets.filter((t) => t.kind === 'house').length,
        head: head.blockNumber,
        txs: [...this.lastByVault.values()].reduce((n, r) => n + r.txs.length, 0),
      },
      'mm tick',
    );
    return plan;
  }

  /**
   * THE EARNVAULT VENUE STEP (earn/keep.ts over earn/plan.ts). Sweep the idle USDG above the rendered buffer
   * (MmTuning.earn, EARN_BUFFER_USDG6 / EARN_BUFFER_BPS) into the venue, pull back up to it, pull for an open queue,
   * and page v2_earn_queue_stuck when the queue head has stood still for EARN_QUEUE_STUCK_S. `sweepToVenue` and
   * `pullFromVenue` are QUOTER on the EarnVault; `processQueue` and `skim` are the cranker's and are not sent here.
   * At most one move a tick, charged to the tick's MM_MAX_TX_PER_TICK: with the budget spent it still reads and
   * watches the queue but sends nothing. A failed read pages and the tick carries on.
   */
  async earnTick(head: Head): Promise<EarnKeepResult | null> {
    const earn = this.ctx.config.tuning.earn;
    if (earn === null) return null;
    const { client, config, log } = this.ctx;
    try {
      const { usdg } = await this.resolveAddresses(head.blockNumber);
      const result = await keepEarn(
        {
          read: () => readEarnState({ client, vault: earn.vault, usdg, now: head.timestamp, lastSkimAt: null }),
          send: async (move) => {
            if (this.sentThisTick >= config.tuning.maxTxPerTick) {
              log.warn({ vault: earn.vault, move: move.kind, amount: move.amount }, 'EarnVault move not sent: MM_MAX_TX_PER_TICK is spent this tick');
              return false;
            }
            const record = await this.sendEarnMove(move, earn.vault);
            this.sentThisTick += 1;
            return record.status === 'confirmed';
          },
        },
        earn,
        this.earnWatch,
      );
      this.earnWatch = result.watch;
      this.lastEarn = { ...result, at: head.timestamp };
      if (result.watch !== null && result.stuckForS >= earn.queueStuckS) {
        const { state, plan } = result;
        await this.ctx.alerter.alert(
          'v2_earn_queue_stuck',
          `EarnVault ${earn.vault}: queued withdrawals ${state.queueHead}..${state.queueTail} have not moved for ${result.stuckForS} s ` +
            `(EARN_QUEUE_STUCK_S ${earn.queueStuckS}): ${stuckReason(state, plan)}`,
          { vault: earn.vault, head: state.queueHead, tail: state.queueTail, stuckForS: result.stuckForS, skipped: plan.skipped, wallet: state.wallet, escrowed: state.escrowed, venueWithdrawable: state.venueWithdrawable },
          { dedupeKey: `${lc(earn.vault)}:${state.queueHead}` },
        );
      }
      return result;
    } catch (error) {
      await this.ctx.alerter.alert(
        'v2_mm_vault_unreadable',
        `EarnVault ${earn.vault} could not be read or moved this tick; nothing was swept or pulled: ${describeError(error)}`,
        { vault: earn.vault, error: describeError(error) },
        { dedupeKey: `earn:${lc(earn.vault)}` },
      );
      return null;
    }
  }

  /**
   * CANCEL WHAT A REFUSED MM_VAULTS ENTRY RESTS, EVERY TICK, AND PLACE NOTHING.
   *
   * A House vault listed in MM_VAULTS is refused and quoted by neither path, so before this nothing
   * cancelled the orders it already rested: not the planner (it is no target), not the epoch wind-down (that runs only
   * for discovered House vaults), and not a kill (which walked vaultTargets() alone). Those orders sat at prices no one
   * refreshed, and a House vault must be flat for its `rollEpoch` at `epochEnd`. Cancel-only is the fail-closed action:
   * it can never open risk, it needs no fair value or epoch read, and it goes quiet once the vault rests nothing.
   * Every order with units left is a target (engine.isKillTarget: live, or expired while still holding escrow), the
   * same rule a kill uses. A vault that cannot be read is paged and retried on the next tick; the others carry on.
   */
  private async cancelRefused(head: Head): Promise<void> {
    for (const { address } of this.refusedVaults) {
      try {
        const a = await this.addressesFor(address, head.blockNumber);
        if (a === 'wrong-book') continue;
        const count = (await this.ctx.client.readContract({ address: a.orderBook, abi: orderBookAbi, functionName: 'makerOrderCount', args: [a.vault], blockNumber: head.blockNumber })) as bigint;
        await this.ingestOrders(a, count, head);
        const chain = await readOrders(this.ctx.client, a.orderBook, this.mm.openOrders(a.vault).map((o) => o.orderId), head.blockNumber);
        const targets = chain.filter((o) => o.maker !== zeroAddress && isKillTarget(o, head.timestamp));
        for (let i = 0; i < targets.length; i += CANCEL_CHUNK) {
          const ids = targets.slice(i, i + CANCEL_CHUNK).map((o) => o.id);
          await this.send({ type: 'cancel', orderIds: ids, longIds: [], reason: 'refused MM_VAULTS entry (a House vault): not managed, so cancelled' }, a.vault);
          this.sentThisTick += 1;
        }
      } catch (error) {
        await this.ctx.alerter.alert(
          'v2_mm_vault_unreadable',
          `refused vault ${address} could not be read, so its resting orders were not cancelled this tick: ${describeError(error)}`,
          { vault: address, error: describeError(error) },
          { dedupeKey: lc(address) },
        );
      }
    }
  }

  /**
   * The market-safety halt of every market read this tick (engine.marketSafetyHalt), WRITTEN ONTO
   * `read.markets` (MarketView.halt, which the planner turns into a halt of every series of the market) and returned,
   * keyed by lower-case underlying; null = may quote. Records each market's oracle spot in the breaker first, so a move
   * this tick trips it this tick. Reads nothing when P7 and P8 are both off, and nothing outside a session.
   */
  private async marketSafety(read: MarketsRead, head: Head, sessionOpen: boolean): Promise<Map<string, Halt | null>> {
    const t = this.ctx.config.tuning;
    const out = new Map<string, Halt | null>();
    for (const [u, m] of read.markets) this.breaker.observe(u, head.timestamp, m.spot);
    const needClocks = sessionOpen && (t.maxSpotAgeS > 0 || t.openGraceS > 0) && this.calendar !== null;
    const clocks = needClocks
      ? await readSpotClocks(this.ctx.client, {
          calendar: this.calendar!,
          now: head.timestamp,
          openGraceS: t.openGraceS,
          toleranceBps: t.fairSpotToleranceBps,
          markets: [...read.markets.values()].flatMap((m) => {
            const print = read.spotPrints.get(m.underlying);
            return print === undefined ? [] : [{ underlying: m.underlying, oracle: print.oracle, spot: m.spot, updatedAt: print.updatedAt }];
          }),
          blockNumber: head.blockNumber,
        })
      : null;
    for (const u of read.markets.keys()) {
      const clock = clocks?.clocks.get(u);
      out.set(
        u,
        marketSafetyHalt({
          now: head.timestamp,
          sessionOpen,
          sessionOpenAtGrace: clocks?.sessionOpenAtGrace ?? false,
          spotObservedAt: clock?.observedAt ?? null,
          spotObservedInSession: clock?.observedInSession ?? null,
          breaker: this.breaker.haltOf(u, head.timestamp),
          params: { maxSpotAgeS: t.maxSpotAgeS, openGraceS: t.openGraceS },
        }),
      );
    }
    for (const [u, halt] of out) {
      const view = read.markets.get(u);
      if (view !== undefined) read.markets.set(u, { ...view, halt });
    }
    return out;
  }

  /**
   * Whether this read is `vault`'s routine send: MM_SEND_INTERVAL_S of head time since its
   * last read that sent a routine transaction. 0 = every read.
   */
  private sendGateOf(vault: Address, now: number): Omit<SendGate, 'held'> {
    const intervalS = this.ctx.config.tuning.sendIntervalS;
    const last = this.lastRoutineSendAt.get(lc(vault)) ?? null;
    return { intervalS, due: routineSendDue(intervalS, last, now), lastRoutineSendAt: last };
  }

  /** The plan phase of one vault: every read, the pricing call and the planner. Sends nothing (sendVault does). */
  private async planVault(
    prepared: PreparedVault,
    head: Head,
    scan: { created: number; caughtUp: boolean },
    protocolAccounts: ReadonlySet<string>,
    /** The UNION book of every quoted vault, built once in tick(). Never rebuild it per vault. */
    protocolBook: readonly ProtocolResting[],
    startedAt: number,
    /** Where this vault ranks among the bot's own vaults for the step-aside (siblingRanks). */
    rank: SiblingRank,
  ): Promise<PlannedVault> {
    const { client, config } = this.ctx;
    const { a, target, vault, chainOrders } = prepared;
    const stop = await this.ledgerStop(a, head, target.caps.dailyLossLimitUsdg6);

    const markets = quotedMarkets(config);
    const quotedSet = new Set(markets.map((m) => lc(m.underlying)));
    const marketsRead = await readMarkets(client, a, markets.map((m) => ({ ticker: m.ticker, underlying: m.underlying })), head.blockNumber);
    // Each quoted market's safety halt rides on its MarketView; the planner halts every
    // series of the market with it and cancels their resting orders, asks included.
    await this.marketSafety(marketsRead, head, vault.sessionOpen);
    const tickerOf = new Map(markets.map((m) => [lc(m.underlying), m.ticker]));

    // The managed series: the selection over every live series of the quoted markets, plus the series of the vault's
    // open orders and tracked exposure there.
    // A House vault selects from its own market only (VaultTarget.underlying); the treasury from every quoted one.
    const live = this.mm.liveSeries(head.timestamp).filter((s) => quotedSet.has(lc(s.underlying)) && (target.underlying === null || lc(s.underlying) === lc(target.underlying)));
    const spots = new Map([...marketsRead.markets].filter(([, m]) => m.spot !== null).map(([u, m]) => [u, m.spot!]));
    // P16: the SAME delta band the planner ranks by (planner.selectedSeries), or the two selections disagree.
    const band = safestAskOf(this.params);
    const picked = selectSeries({ now: head.timestamp, candidates: live, spots, pullMinutes: this.params.pullMinutes, maxSeries: this.params.maxSeries, maxSeriesPerMarket: this.params.maxSeriesPerMarket, epoch: target.epoch, deltaBand: band.deltaBandHi > 0 ? { lo: band.deltaBandLo, hi: band.deltaBandHi, vol: band.selectVol } : null });
    // Listed vs selected per market: the caps are derived to cover the ladder, so a `not-selected` count
    // above zero here is the finding, and a pull-window or epoch trim is named as such rather than read as a gap.
    const coverage = marketCoverage({
      now: head.timestamp,
      live,
      picked,
      pullMinutes: this.params.pullMinutes,
      epochEnd: target.epoch?.epochEnd ?? null,
      tickerOf,
      listedByMarket: config.tuning.seriesCoverage.listedByMarket,
    });
    const ordersBySeries = new Map<string, LiveOrder[]>();
    for (const o of chainOrders) {
      if (o.maker === zeroAddress) continue;
      const list = ordersBySeries.get(o.longId.toString()) ?? [];
      list.push({ id: o.id, kind: o.kind, price: o.price, units: o.units, filled: o.filled, validUntil: o.validUntil, cancelled: o.cancelled });
      ordersBySeries.set(o.longId.toString(), list);
    }
    const extraIds = [...new Set([...ordersBySeries.keys(), ...vault.tracked.map((id) => id.toString())])].map((k) => BigInt(k));
    const managed = managedSeries({ now: head.timestamp, picked, extra: this.mm.seriesByIds(extraIds), ordersBySeries });
    const views = await readSeriesViews(client, a, {
      series: [...managed.values()].map((info) => ({ info, ticker: tickerOf.get(lc(info.underlying)) ?? marketByUnderlying(config.registry, info.underlying)?.ticker ?? '?', orders: ordersBySeries.get(info.longId.toString()) ?? [] })),
      blockNumber: head.blockNumber,
    });
    const tracked = await readMeasuredNotional(client, a.vault, vault.tracked, head.blockNumber);
    const settledHeld = target.kind === 'treasury' && !this.isEarnVault(a.vault) ? await this.settledHoldings(a, vault.tracked, head) : undefined;
    // Who else is offering on each managed series, read only when the fallback rule is on (one tail page
    // per series plus one getOrders batch; off, the planner never consults it and the read is skipped).
    // Ranked among the bot's own vaults (siblingAskers), so two of them never step aside for each other.
    const otherAskers = this.params.askFallbackOnly
      ? siblingAskers(await readOtherAskers(client, a, views.map((v) => v.info.longId), head.timestamp, head.blockNumber), rank)
      : null;

    const killed = this.mm.killedFor(a.vault);
    const base: Omit<TickInput, 'fairs'> = {
      now: head.timestamp,
      sessionOpen: vault.sessionOpen,
      sessionClose: vault.sessionClose,
      // fair-before-open: the calendar says WHETHER a session is open, sessionOpenedAtOf WHEN it began. An open session
      // it cannot place is null, which the engine halts on rather than guesses.
      sessionOpenedAt: sessionOpenedAtOf(head.timestamp, vault.sessionOpen),
      killed: killed !== null,
      lossStop: stop,
      lastSync: this.mm.lastSync(a.vault),
      vault: {
        isQuoter: vault.isQuoter,
        quoterDelay: vault.quoterDelay,
        tradingPaused: vault.tradingPaused,
        // HouseVault.quotingPaused, null on a treasury vault. Every series halts `quoting-paused` while it is set.
        quotingPaused: vault.quotingPaused,
        // Per-tick chain state: the ask must be grossed up by the seller fee the book will take from the
        // vault, and by the scheduled one too when a change is pending (engine.quoteFeeBpsOf).
        fees: { current: vault.fees, pending: vault.pendingFees },
        limits: vault.limits,
        outflow: vault.outflow,
        totalNotional: vault.totalNotional,
        usdgWallet: vault.usdgWallet,
        // House pendingDepositUsdg + owedUsdg, null on a treasury vault. The planner takes it out of
        // the bid budget; execute() re-checks it against a fresh read before each bid-growing send.
        usdgReserved: vault.usdgReserved,
        owed: vault.owed,
        freeCollateral: marketsRead.freeCollateral,
        walletTokens: marketsRead.walletTokens,
        ...(marketsRead.balancesUnread === undefined ? {} : { balancesUnread: marketsRead.balancesUnread }),
        // The House underlying's queued-deposit and owed-withdrawal stock, which depositToClearinghouse clamps
        // away (BadUnits when nothing is left). A House target's underlying is never null (VaultTarget.underlying).
        ...(vault.stockReserved === null || target.underlying === null ? {} : { walletReserved: new Map([[lc(target.underlying), vault.stockReserved]]) }),
        tracked,
        // (N3): the treasury MakerVault's settled tokens, which it now redeems itself.
        ...(settledHeld === undefined ? {} : { settledHeld }),
        // Read from the vault (HouseVault.epochEnd :191 / epochId :193) by vaultTargets; null = treasury.
        epoch: target.epoch,
      } satisfies TickInput['vault'],
      markets: marketsRead.markets,
      series: views,
      params: {
        ...this.params,
        // Per vault (MM_VAULT_CAPS), then clamped: 0 = the vault's on-chain limit alone, and a bot
        // cap never widens a contract limit.
        maxSeriesUnits: capAtMost(target.caps.maxSeriesUnits, vault.limits.maxSeriesUnits),
        maxTotalNotionalUsdg6: capAtMost(target.caps.maxTotalNotionalUsdg6, vault.limits.maxTotalNotional),
      },
      // A quote must be refreshed on the last routine send before it expires, so the lead covers the send
      // interval plus two reads (config.ts refreshLeadOf).
      refreshS: refreshLeadOf({ pollIntervalMs: config.pollIntervalMs, sendIntervalS: config.tuning.sendIntervalS }),
      // OrderBook.replace reverts OrderNotLive past validUntil, so no replace inside the margin a
      // replace needs to land: MM_REPLACE_CONFIRM_S (config.ts replaceMarginOf, the same function the boot check reads).
      replaceMarginS: replaceMarginOf({ pollIntervalMs: config.pollIntervalMs, txTimeoutMs: config.txTimeoutMs, replaceConfirmS: config.tuning.replaceConfirmS }),
      // A bid is capped at its value two routine sends ahead (mm/spot-lag.ts), so theta does not chase it.
      bidCapAheadS: bidCapAheadOf({ pollIntervalMs: config.pollIntervalMs, sendIntervalS: config.tuning.sendIntervalS }),
      protocolAccounts,
      protocolBook,
      ...(otherAskers === null ? {} : { otherAskers: otherAskers.asks }),
    };
    if (otherAskers !== null && otherAskers.truncated.length > 0) {
      this.ctx.log.warn({ vault: a.vault, series: otherAskers.truncated }, 'other-asker read was partial: series with more orders than the tail page');
    }

    const requests = fairRequests(base);
    const answers = await this.ctx.pricing.fairMany(requests.map((v) => ({ ticker: v.ticker, strike: v.info.strike, expiry: v.info.expiry, isPut: v.info.isPut })));
    const fairs = new Map<string, FairInput>(requests.map((v, i) => [v.info.longId.toString(), answers[i]!]));
    // The markout sampler takes the planner's fair clock (fair-stale, and fair-before-open while it is on).
    await this.markoutTick(a.vault, head, fairs, (info) => tickerOf.get(lc(info.underlying)) ?? marketByUnderlying(config.registry, info.underlying)?.ticker ?? null, {
      now: head.timestamp,
      sessionOpen: vault.sessionOpen,
      sessionOpenedAt: this.params.fairFromSession ? base.sessionOpenedAt : undefined,
      params: this.params,
    });
    const reasons: Record<string, number> = {};
    for (const f of answers) if (!f.ok) reasons[f.reason] = (reasons[f.reason] ?? 0) + 1;

    const input: TickInput = { ...base, fairs };
    const full = planTick(input);
    // Between a vault's routine sends only its protective transactions go out; the rest wait
    // for the next routine send, which plans them afresh.
    const gate = this.sendGateOf(a.vault, head.timestamp);
    const plan = gate.due ? full : { ...full, txs: full.txs.filter(isProtectiveTx) };
    const sendGate: SendGate = { ...gate, held: full.txs.length - plan.txs.length };

    // The outflow bucket is shared by every quoter and by the admin (booked but never enforced), so a reading above
    // what this bot's own booked calls account for is USDG somebody else moved. Checked before the tick books more.
    const foreignOutflow = foreignSpend({
      observedUsed: vault.outflow.used,
      now: head.timestamp,
      cap: vault.limits.maxDailyOutflow,
      previous: this.mm.outflowProjection(a.vault),
    });

    return {
      prepared,
      input,
      plan,
      stop,
      views,
      foreignOutflow,
      pricing: { requested: requests.length, failed: answers.filter((f) => !f.ok).length, reasons },
      coverage,
      scan,
      sendGate,
    };
  }

  /** The send phase of one vault: its plan's transactions within `txBudget`, then its record, alerts and log line. */
  private async sendVault(planned: PlannedVault, head: Head, startedAt: number, txBudget: number, headAt?: number): Promise<TickPlan> {
    const { client } = this.ctx;
    const { prepared, input, plan, stop, views, foreignOutflow, pricing, coverage, scan, sendGate } = planned;
    const { a, vault } = prepared;
    const killed = this.mm.killedFor(a.vault);
    const { txs, sent, refused, unsent, skipped } = await this.execute(plan, a, head, txBudget, headAt);
    // A read that sent a routine transaction is the vault's routine send; the next is MM_SEND_INTERVAL_S later.
    if ([...sent.keys()].some((i) => !isProtectiveTx(plan.txs[i]!))) this.lastRoutineSendAt.set(lc(a.vault), head.timestamp);
    const budget = this.budgetOf(a.vault, plan, sent, unsent, txBudget, sendGate);
    // Dated from a head read AFTER the sends: the vault refills the bucket from `_outflowAt`, the block of its last
    // booked call, so a projection dated at the tick's own head would assume a refill the chain has not made and the
    // next tick would read an honest level as a foreign spend (a long tick of many places is minutes of refill).
    this.recordOutflow(plan, views, sent, txs.length === 0 ? head : await readHead(client), vault, a.vault);
    const last: LastTick = {
      head,
      vaultAddress: a.vault,
      vault,
      input,
      plan,
      stop,
      txs,
      foreignOutflow,
      outflowRefused: refused,
      pricing,
      scan: { scannedTo: this.mm.scannedTo(), created: scan.created, caughtUp: scan.caughtUp },
      coverage,
      sendGate,
      budget,
      startedAt,
      durationMs: this.wall() - startedAt,
    };
    this.lastByVault.set(lc(a.vault), last);
    if (this.last === null || lc(a.vault) === lc(this.ctx.config.contracts.makerVault)) this.last = last;
    await this.raiseAlerts(last);
    this.ctx.log.info(
      { vault: a.vault, head: head.blockNumber, selected: plan.selected.length, twoSided: twoSidedCount(plan), txs: txs.length, skipped, killed: killed !== null, lossStop: stop.tripped, coverage, sendGate, budget },
      'mm vault tick',
    );
    return plan;
  }

  /**
   * This vault's budget line, and the budget-short count: consecutive ROUTINE sends (reads between them do not
   * count either way) whose plan the tick's MM_MAX_TX_PER_TICK cut short.
   */
  private budgetOf(vault: Address, plan: TickPlan, sent: ReadonlyMap<number, unknown>, unsent: number, given: number, gate: SendGate): VaultBudget {
    const key = lc(vault);
    const before = this.budgetShortSends.get(key) ?? 0;
    const shortSends = !gate.due ? before : unsent > 0 ? before + 1 : 0;
    this.budgetShortSends.set(key, shortSends);
    return { given, unsent, seriesWithoutAsk: unsent > 0 ? budgetShortSeries(plan, sent).length : 0, shortSends };
  }

  /*------------------------------ sending -----------------------------*/

  private callOf(tx: MmTx, vault: Address): { call: { address: Address; abi: typeof makerVaultAbi; functionName: string; args: readonly unknown[]; gas: bigint }; kind: string; key: string; what: string } {
    const v = { address: vault, abi: makerVaultAbi };
    switch (tx.type) {
      case 'cancel':
        return { call: { ...v, functionName: 'cancel', args: [tx.orderIds], gas: MM_GAS.cancelBase + MM_GAS.cancelEach * BigInt(tx.orderIds.length) }, kind: 'mm-cancel', key: tx.orderIds.join(','), what: `cancel ${tx.orderIds.join(', ')} (${tx.reason})` };
      case 'replace':
        return { call: { ...v, functionName: 'replace', args: [tx.orderId, tx.price, tx.units], gas: MM_GAS.replace }, kind: 'mm-replace', key: tx.orderId.toString(), what: `replace ${tx.slot} ${tx.orderId} on ${tx.longId}: ${tx.units} @ ${tx.price} (${tx.reason})` };
      case 'place':
        return { call: { ...v, functionName: 'place', args: [tx.longId, tx.kind, tx.price, tx.units, tx.validUntil], gas: MM_GAS.place }, kind: 'mm-place', key: `${tx.longId}:${tx.slot}`, what: `place ${tx.slot} on ${tx.longId}: ${tx.units} @ ${tx.price} until ${tx.validUntil} (${tx.reason})` };
      case 'sync':
        return { call: { ...v, functionName: 'sync', args: [tx.longIds], gas: MM_GAS.syncBase + MM_GAS.syncEach * BigInt(tx.longIds.length) }, kind: 'mm-sync', key: tx.longIds.join(','), what: `sync ${tx.longIds.length} series (${tx.reason})` };
      case 'close':
        return { call: { ...v, functionName: 'close', args: [tx.longId, tx.units], gas: MM_GAS.close }, kind: 'mm-close', key: tx.longId.toString(), what: `close ${tx.units} pairs of ${tx.longId}` };
      case 'claimOwed':
        return { call: { ...v, functionName: 'claimOwed', args: [], gas: MM_GAS.claimOwed }, kind: 'mm-claimOwed', key: 'owed', what: `claimOwed ${tx.amount}` };
      case 'deposit':
        return { call: { ...v, functionName: 'depositToClearinghouse', args: [tx.asset as Address, tx.amount], gas: MM_GAS.deposit }, kind: 'mm-deposit', key: lc(tx.asset), what: `depositToClearinghouse ${tx.amount} of ${tx.asset}` };
      case 'redeem':
        // (N3): the MakerVault's own redeem (QUOTER), never Clearinghouse.redeem on its behalf: an opted-out
        // holder refuses third-party redemption.
        return { call: { ...v, functionName: 'redeem', args: [tx.tokenId], gas: MM_GAS.redeem }, kind: 'mm-redeem', key: tx.tokenId.toString(), what: `redeem ${tx.units} of settled ${tx.tokenId} (${tx.reason})` };
    }
  }

  /** EarnVault.sweepToVenue / pullFromVenue, through the same send path (journal key, alerts) as every tx. */
  private sendEarnMove(move: EarnMove, vault: Address): Promise<TxRecord> {
    const functionName = move.kind === 'sweep' ? 'sweepToVenue' : 'pullFromVenue';
    const why = move.kind === 'pull' ? `pull for the ${move.reason}` : 'idle USDG above the buffer';
    return this.sendCall(
      { call: { address: vault, abi: earnVaultAbi, functionName, args: [move.amount], gas: MM_GAS.earnMove }, kind: `mm-earn-${move.kind}`, key: move.kind, what: `${functionName} ${move.amount} (${why})` },
      `earn-${move.kind}`,
      vault,
    );
  }

  private send(tx: MmTx, vault: Address): Promise<TxRecord> {
    return this.sendCall(this.callOf(tx, vault), tx.type, vault);
  }

  private async sendCall(
    prepared: { call: { address: Address; abi: typeof makerVaultAbi | typeof earnVaultAbi; functionName: string; args: readonly unknown[]; gas: bigint }; kind: string; key: string; what: string },
    type: TxRecord['type'],
    vault: Address,
  ): Promise<TxRecord> {
    const { call, kind, key, what } = prepared;
    /*
     * EVERY JOURNAL KEY IS NAMESPACED BY VAULT, and it is done HERE rather than in the eight
     * branches of {callOf} so it cannot be applied to seven of them.
     *
     * tx.ts dedupes an in-flight submission by (kind, key). `claimOwed` keyed to the literal 'owed' meant vault
     * A's in-flight claim suppressed vault B's call entirely - and B still booked the outflow for a transaction
     * it never sent, so its projection drifted against the chain and the next tick read an honest level as a
     * foreign spend. `mm-deposit` keyed on the asset had the same collision. The order-id keys were incidentally
     * safe because order ids are book-global, which is exactly the kind of accident that stops being true.
     */
    const outcome = await this.ctx.sender.execute(call as never, { kind, key: `${lc(vault)}:${key}` });
    const record: TxRecord = { type, what, status: outcome.status };
    if ('hash' in outcome) record.hash = outcome.hash;
    if (outcome.status === 'simulation-reverted') {
      record.revert = outcome.revert;
      record.error = outcome.error.slice(0, 300);
      const refusal = MmBot.outflowRefusal(record, outcome);
      if (refusal !== null) record.outflow = refusal;
    }
    if (outcome.status === 'send-failed' || outcome.status === 'unconfirmed') record.error = outcome.error.slice(0, 300);
    if (outcome.status === 'confirmed' || outcome.status === 'reverted') record.gasUsed = outcome.gasUsed;

    const level = outcome.status === 'confirmed' || outcome.status === 'in-flight' ? 'info' : 'warn';
    this.ctx.log[level]({ kind, key, status: outcome.status, hash: record.hash, revert: record.revert, gasUsed: record.gasUsed }, what);
    if (record.outflow !== undefined) {
      // A handled condition, not a guard the bot's reads disagree with: paged as the outflow alert, per UTC day
      // AND PER VAULT. The cap is a property of the vault (`vault.limits.maxDailyOutflow`), so a day-only
      // key let the first vault to hit its cap suppress the page for every other vault until the next UTC day.
      await this.ctx.alerter.alert(
        'v2_mm_outflow',
        `vault ${vault}: the daily outflow cap refused ${type} (${record.outflow.available ?? '?'} USDG base units left, ${record.outflow.wanted ?? '?'} wanted): ${what}`,
        { vault, kind, key, available: record.outflow.available, wanted: record.outflow.wanted },
        { dedupeKey: `${lc(vault)}:${Math.floor(this.wall() / 86_400_000)}` },
      );
    } else if (outcome.status === 'simulation-reverted') {
      await this.ctx.alerter.alert('v2_mm_tx_rejected', `vault ${type} would revert (${outcome.revert ?? 'no reason'}): ${what}`, { vault, kind, key, revert: outcome.revert, error: record.error }, { dedupeKey: `${kind}:${lc(vault)}:${key}` });
    } else if (outcome.status === 'reverted' || outcome.status === 'unconfirmed' || outcome.status === 'send-failed') {
      await this.ctx.alerter.alert('v2_tx_revert', `mm ${type} ${outcome.status}: ${what}`, { vault, kind, key, hash: record.hash, error: record.error }, { dedupeKey: `${kind}:${lc(vault)}:${key}` });
    }
    return record;
  }

  /**
   * A refusal by the vault's outflow cap: `OutflowCapExceeded(available, outflow)` decoded off the simulation. The
   * cap is one shared bucket, so once it has refused one call every later bid in the tick would be refused too.
   */
  private static outflowRefusal(record: TxRecord, outcome: TxOutcome): OutflowRefusal | null {
    if (record.revert !== 'OutflowCapExceeded') return null;
    const args = outcome.status === 'simulation-reverted' ? (outcome.revertArgs ?? []) : [];
    const num = (i: number): bigint | null => (typeof args[i] === 'bigint' ? (args[i] as bigint) : null);
    return { what: record.what, available: num(0), wanted: num(1) };
  }

  private async execute(
    plan: TickPlan,
    a: MmAddresses,
    head: Head,
    limit = this.ctx.config.tuning.maxTxPerTick,
    headAt?: number,
  ): Promise<{ txs: TxRecord[]; sent: Map<number, TxRecord>; refused: OutflowRefusal[]; unsent: number; skipped: number }> {
    const out: TxRecord[] = [];
    /*
     * THE CHAIN'S TIME AT EACH SEND. The plan was made at the head's time, and the sends go one at a time; a tick
     * of many sends on a slow RPC ran 76-123 s on a v9 fork, so a place stamped from the plan lived 6-14 s and a
     * planned replace hit an order that had already expired (OrderNotLive). The head's timestamp plus what the bot's clock
     * says has passed since it was read (`headAt`) dates each send without another RPC round trip on the very RPC that is
     * slow. Without `headAt` (a caller outside tick) the head's time is used, as the plan did.
     */
    const chainNow = (): number => head.timestamp + (headAt === undefined ? 0 : Math.max(0, Math.floor((this.wall() - headAt) / 1000)));
    const replaceMarginS = replaceMarginOf({ pollIntervalMs: this.ctx.config.pollIntervalMs, txTimeoutMs: this.ctx.config.txTimeoutMs, replaceConfirmS: this.ctx.config.tuning.replaceConfirmS });
    let skipped = 0;
    const sent = new Map<number, TxRecord>();
    const refused: OutflowRefusal[] = [];
    // How many of the plan's transactions the budget (`limit`) left unsent; v2_mm_budget_short counts on it.
    let unsent = 0;
    /*
     * 'fee-out-of-range' FINALLY HAS A CONSUMER.
     *
     * engine.ts grossUpToTick returns the UNGROSSED price with ok:false when the seller fee read is out of
     * range, and quotePrices records 'fee-out-of-range' in clampedBy. Nothing anywhere read that value - it
     * reached /state and stopped - so the vault rested an ask BELOW its intended net, silently, with no halt
     * and no alert. The analogous unreadable-input case halts with 'guards-unreadable'; this one did not.
     *
     * The guard lives here rather than in the planner because the planner is another task's file, and because
     * refusing to SEND is the fail-closed action anyway: a cancel still goes out, so the fix never strands
     * inventory. Only the asks that would rest a wrong price are withheld.
     */
    const feeBroken = new Set(
      (plan.series ?? []).filter((v) => v.prices?.clampedBy?.includes('fee-out-of-range')).map((v) => v.longId.toString()),
    );
    if (feeBroken.size > 0) {
      await this.ctx.alerter.alert(
        'v2_mm_fee_unreadable',
        `seller fee out of range on ${feeBroken.size} series: their asks are NOT rested this tick (an ungrossed ask rests below the vault's intended net)`,
        { vault: a.vault, series: [...feeBroken] },
        { dedupeKey: lc(a.vault) },
      );
    }
    /*
     * A HOUSE VAULT'S RESERVE, RE-CHECKED AT SEND TIME. The plan budgeted bids from the wallet
     * less `pendingDepositUsdg + owedUsdg`, assuming every live bid's escrow comes back first. It may not: a cancel of a
     * Bid that filled after the tick's read returns nothing and does not revert (OrderBook.sol:316-317), and sends go
     * one at a time across many blocks. So before each bid-growing tx on a House vault the rule the contract enforces
     * per call (HouseVault._requireUnreservedSpend) is checked against a FRESH read: send only if
     * delta <= max(0, wallet - reserve). A failed read is a refusal. After a refusal, or after a bid-growing send that
     * did not confirm, no later bid grows on this vault this tick. Cancels, asks and every treasury tx are untouched.
     */
    const house = this.targetsByVault.get(lc(a.vault))?.kind === 'house';
    const growth = house ? bidGrowth(plan) : new Map<number, bigint>();
    let houseHeld = false;
    for (const [index, tx] of plan.txs.entries()) {
      // Cancels and syncs still go out; only a price that would rest wrong is withheld.
      if ((tx.type === 'place' || tx.type === 'replace') && feeBroken.has(tx.longId.toString())) continue;
      if (out.length >= limit) {
        unsent = plan.txs.length - index;
        break;
      }
      // A kill that arrived during this tick: nothing but cancels from here on.
      if (tx.type !== 'cancel' && this.mm.killedFor(a.vault) !== null) break;
      // The outflow cap refused a call: every later bid draws on the same bucket, so stop growing them for this tick
      // rather than paying gas for simulations that cannot pass. Cancels (credits) and asks (not booked) carry on.
      const growsBid = (tx.type === 'place' || tx.type === 'replace') && tx.slot === 'bid';
      if (refused.length > 0 && growsBid) continue;
      const delta = growth.get(index);
      if (delta !== undefined) {
        if (houseHeld) continue;
        const refusal = await this.houseReserveRefusal(a, delta);
        if (refusal !== null) {
          houseHeld = true;
          const what = tx.type === 'place' || tx.type === 'replace' ? `${tx.type} bid on ${tx.longId}` : tx.type;
          await this.ctx.alerter.alert(
            'v2_mm_tx_rejected',
            `vault ${tx.type} withheld (house-reserve): ${what} needs ${delta} USDG base units, ${refusal.unreserved ?? 'unreadable'} unreserved; no further bid grows on this vault this tick`,
            { vault: a.vault, kind: tx.type, revert: 'house-reserve', delta, unreserved: refusal.unreserved, error: refusal.error },
            { dedupeKey: `house-reserve:${lc(a.vault)}` },
          );
          continue;
        }
      }
      // A place gets its validUntil from ITS send, the planner's rule (validUntilAt) at the chain time now; a
      // replace whose order is inside the replace margin now is skipped, the planner's own rule (planSeriesActions),
      // re-judged at send: OrderBook.replace reverts OrderNotLive past validUntil. The next tick cancels and re-places it.
      let toSend: MmTx = tx;
      if (tx.type === 'place' && tx.life !== undefined) {
        const now = chainNow();
        const validUntil = validUntilAt(tx.life, now);
        if (validUntil === null) {
          skipped += 1;
          this.ctx.log.warn({ vault: a.vault, longId: tx.longId, slot: tx.slot, chainNow: now, cap: tx.life.cap }, `place ${tx.slot} on ${tx.longId} skipped at send: its last valid moment ${tx.life.cap} has passed (chain time ${now})`);
          continue;
        }
        toSend = { ...tx, validUntil };
      } else if (tx.type === 'replace' && tx.orderValidUntil !== undefined) {
        const now = chainNow();
        if (tx.orderValidUntil - now < replaceMarginS) {
          skipped += 1;
          this.ctx.log.warn(
            { vault: a.vault, longId: tx.longId, slot: tx.slot, orderId: tx.orderId, orderValidUntil: tx.orderValidUntil, chainNow: now, replaceMarginS },
            `replace ${tx.slot} ${tx.orderId} skipped at send: its order ends at ${tx.orderValidUntil}, inside the ${replaceMarginS} s replace margin at chain time ${now}`,
          );
          continue;
        }
      }
      const record = await this.send(toSend, a.vault);
      if (delta !== undefined && record.status !== 'confirmed') houseHeld = true;
      out.push(record);
      this.sentThisTick += 1;
      sent.set(index, record);
      if (tx.type === 'sync' && record.status === 'confirmed') this.mm.setLastSync(head.timestamp, a.vault);
      if (record.outflow !== undefined) {
        refused.push(record.outflow);
        this.ctx.log.warn({ kind: tx.type, available: record.outflow.available, wanted: record.outflow.wanted }, 'the vault\'s daily outflow cap refused a call: no further bid grows this tick');
      }
    }
    return { txs: out, sent, refused, unsent, skipped };
  }

  /**
   * Null when a bid-growing tx of `delta` USDG may be sent on House vault `a` now; otherwise why not. A failed
   * read is a refusal (`unreserved: null`): the reserve is not known to be zero, so nothing may be assumed free.
   */
  private async houseReserveRefusal(a: MmAddresses, delta: bigint): Promise<{ unreserved: bigint | null; error: string | null } | null> {
    try {
      const { wallet, reserved } = await readHouseReserve(this.ctx.client, a);
      const unreserved = wallet > reserved ? wallet - reserved : 0n;
      return delta <= unreserved ? null : { unreserved, error: null };
    } catch (error) {
      return { unreserved: null, error: describeError(error) };
    }
  }

  /**
   * Record where the outflow bucket stands after this tick's own booked calls, for the next tick's foreign-spend
   * check. A call that was sent but whose fate is unknown (`in-flight`, `unconfirmed`) is counted as booked: an
   * over-estimate of the bot's own spending only makes the next comparison more forgiving, never falsely accusing.
   */
  private recordOutflow(plan: TickPlan, views: readonly SeriesView[], sent: ReadonlyMap<number, TxRecord>, head: Head, vault: VaultState, vaultAddr: Address): void {
    const BOOKED: ReadonlySet<TxOutcome['status']> = new Set(['confirmed', 'in-flight', 'unconfirmed']);
    const live = new Map<string, { kind: LiveOrder['kind']; price: bigint; remaining: bigint }>();
    for (const v of views) for (const o of v.orders) live.set(o.id.toString(), { kind: o.kind, price: o.price, remaining: o.units > o.filled ? o.units - o.filled : 0n });
    const applied = bookedCalls(plan, live).filter((c) => {
      const record = sent.get(c.index);
      return record !== undefined && BOOKED.has(record.status);
    });
    this.mm.setOutflowProjection({ used: project(vault.outflow.used, applied), at: head.timestamp, cap: vault.limits.maxDailyOutflow }, vaultAddr);
  }

  /*------------------------------- alerts -----------------------------*/

  private async raiseAlerts(t: LastTick): Promise<void> {
    const { alerter, store } = this.ctx;
    if (t.stop.tripped) {
      // Per vault AND per day. The prefix was built to take a suffix and only ever got the day, so
      // the first vault to trip its loss stop on a given UTC day silenced the page for every other vault that
      // day - the louder the incident, the more vaults it hid.
      const vaultKey = lc(t.vaultAddress);
      const key = `${MM_META.lossStopAlerted}${vaultKey}:${t.stop.day}`;
      /**
       * THE PROBE IS SCOPED TO THE SAME SUBJECT AS THE MARK. Later changes made the mark per vault and left
       * this read asking `dedupeKey null`, which matches ANY vault's page from that UTC day: vault A trips and is
       * paged, its row lands with dedupe_key NULL, vault B trips later the same day, getMeta(keyB) is null but the
       * probe returns true on A's row, so B is marked as already paged and NOBODY IS EVER PAGED FOR B. Fail-open,
       * no error, no retry. Scoping a key means scoping every READ of it, not only the write.
       *
       * The page now carries `dedupeKey` (the same vault:day tuple the mark uses), so its stored row is
       * attributable and this probe asks about THIS vault. The alternative - teaching alertDeliveredSince to take
       * a vault and filtering the query on it - was worse twice over: it lives in the generic alert store
       * (`keeper/src/v2/store.ts`, shared by every mode), which would learn about vaults for one caller's sake,
       * and it would leave a NULL-keyed row that every other kind's probe still collides on. dedupe_key is the
       * column the store already has for exactly this, and the v2_mm_delta page beside this one already uses it.
       */
      const pageKey = `${vaultKey}:${t.stop.day}`;
      // Redelivered from its stored row since the failure (alerts.ts redeliver): remembered, not paged twice.
      if (store.getMeta(key) === null && store.alertDeliveredSince('v2_mm_loss_stop', pageKey, t.stop.day * 86_400_000)) {
        store.setMeta(key, String(t.head.timestamp));
        this.lossStopFailedAt.delete(vaultKey);
      }
      // Per vault: A's failed delivery must not delay B's page, and A's success must not unblock B early.
      const failedAt = this.lossStopFailedAt.get(vaultKey);
      const retryDue = failedAt === undefined || this.wall() - failedAt >= FAILED_DELIVERY_RETRY_MS;
      if (store.getMeta(key) === null && retryDue) {
        // Remembered only once delivered: a page the relay refused is sent again by a later tick of the same day.
        if (await alerter.alert('v2_mm_loss_stop', `MM daily realised-loss stop on vault ${t.vaultAddress}: ${t.stop.realised} USDG base units today (limit ${t.stop.limit}); every quote pulled until the next UTC day`, { vault: t.vaultAddress, day: t.stop.day, realised: t.stop.realised, limit: t.stop.limit }, { force: true, dedupeKey: pageKey })) {
          store.setMeta(key, String(t.head.timestamp));
          this.lossStopFailedAt.delete(vaultKey);
        } else {
          this.lossStopFailedAt.set(vaultKey, this.wall());
        }
      }
    }
    if (!t.vault.isQuoter) {
      // INTERFACE_VERSION 8. Two causes, one kind: a non-zero delay means the key IS a member but every
      // call would have to be scheduled through the manager, which this bot cannot do; zero means it is
      // not a member, or the selector is not mapped to a role on that target. The remedy differs.
      const manager = this.addresses?.manager ?? this.ctx.config.contracts.accessManager;
      // The vault this tick was for. This read `this.addresses?.vault`, which is the TREASURY on
      // every tick, so a House vault's page named the wrong vault and an operator chasing it looked in the
      // wrong place - or dismissed it, because the treasury looked healthy.
      const vault = t.vaultAddress;
      const why =
        t.vault.quoterDelay > 0
          ? `is a member with a ${t.vault.quoterDelay}s execution delay, so every vault call would have to be scheduled`
          : 'may not call it (not a member, or the selector is not mapped)';
      await alerter.alert(
        'v2_mm_not_quoter',
        `the MM signer ${this.ctx.signer} ${why}: AccessManager ${manager} refuses place(uint256,uint8,uint128,uint64,uint40) on vault ${vault}, so nothing can be quoted or cancelled`,
        { signer: this.ctx.signer, manager, vault, selector: VAULT_PLACE_SELECTOR, immediate: false, delay: t.vault.quoterDelay },
      );
    } else {
      alerter.clear('v2_mm_not_quoter');
    }
    // The budget cut this vault's routine sends short BUDGET_SHORT_SENDS times in a row, so series sit without
    // an ask and nothing else would say so (25 to 35 of 50 dark, no page). Cleared by a routine send that
    // went out whole; a read between routine sends leaves it as it is.
    const budgetKey = lc(t.vaultAddress);
    if (t.budget.shortSends >= BUDGET_SHORT_SENDS) {
      await alerter.alert(
        'v2_mm_budget_short',
        `vault ${t.vaultAddress}: MM_MAX_TX_PER_TICK (${this.ctx.config.tuning.maxTxPerTick}) cut ${t.budget.shortSends} routine sends in a row short; ${t.budget.seriesWithoutAsk} series left without a live ask, ${t.budget.unsent} transactions unsent this tick (this vault's budget ${t.budget.given})`,
        { vault: t.vaultAddress, shortSends: t.budget.shortSends, seriesWithoutAsk: t.budget.seriesWithoutAsk, unsent: t.budget.unsent, given: t.budget.given, maxTxPerTick: this.ctx.config.tuning.maxTxPerTick },
        { dedupeKey: budgetKey },
      );
    } else if (t.budget.shortSends === 0) {
      alerter.clear('v2_mm_budget_short', budgetKey);
    }
    for (const row of t.plan.netDelta) {
      if (row.alert) {
        await alerter.alert('v2_mm_delta', `MM net delta on ${row.ticker} (vault ${lc(t.vaultAddress)}) is ${row.deltaShares.toFixed(2)} shares (alert above ${this.params.deltaAlertShares}); hedge by hand`, { vault: lc(t.vaultAddress), ticker: row.ticker, deltaShares: row.deltaShares, positions: row.positions, unknown: row.unknown }, { dedupeKey: deltaAlertKey(t.vaultAddress, row.ticker) });
      } else {
        alerter.clear('v2_mm_delta', deltaAlertKey(t.vaultAddress, row.ticker));
      }
    }
    // Nothing quoted for want of a fair value: every selected series halted fair-unavailable (the service down, or a
    // refusal: chain-stale, spot-unavailable, chain-inconsistent) or fair-stale (an asOf that stopped advancing), or
    // every request failed in transport. Pricing /health stays ok for most of these, so this is the page.
    const selected = t.plan.series.filter((s) => s.selected);
    const fairHalted = selected.filter((s) => s.halt !== null && ['fair-unavailable', 'fair-stale', 'fair-spot-mismatch', 'fair-out-of-bounds'].includes(s.halt.halt));
    const allFailed = t.pricing.requested > 0 && t.pricing.failed === t.pricing.requested && Object.keys(t.pricing.reasons).some((r) => r.startsWith('pricing-'));
    if (allFailed || (selected.length > 0 && fairHalted.length === selected.length)) {
      const halts: Record<string, number> = {};
      for (const s of fairHalted) halts[s.halt!.halt] = (halts[s.halt!.halt] ?? 0) + 1;
      await alerter.alert(
        'v2_mm_pricing',
        `no fair value to quote on: ${fairHalted.length} of ${selected.length} selected series halted (${Object.entries(halts).map(([k, n]) => `${k} ${n}`).join(', ') || 'every /fair request failed'}); nothing is quoted`,
        { halts, reasons: t.pricing.reasons, requested: t.pricing.requested, failed: t.pricing.failed, pricingUrl: new URL(this.ctx.config.pricingUrl).origin },
      );
    } else if (selected.length > fairHalted.length || t.pricing.failed < t.pricing.requested) {
      alerter.clear('v2_mm_pricing');
    }
    // The vault's daily outflow cap. Once per UTC day while it binds: the bot trimmed its bids (or the chain
    // refused one), so quoting is smaller than the strategy asks until the bucket refills.
    const outflow = t.plan.outflow;
    if (outflow.blocked || t.outflowRefused.length > 0) {
      const day = Math.floor(this.wall() / 86_400_000);
      const trimmed = t.plan.capped.filter((c) => c.caps.includes('outflow')).length;
      await alerter.alert(
        'v2_mm_outflow',
        `the vault's daily outflow cap is binding: ${outflow.used} of ${outflow.cap} USDG base units used, ${outflow.budget} left for this tick's bids; ${trimmed} series trimmed${t.outflowRefused.length > 0 ? `, ${t.outflowRefused.length} call(s) refused on chain` : ''}`,
        { vault: t.vaultAddress, cap: outflow.cap, used: outflow.used, released: outflow.released, budget: outflow.budget, planned: outflow.planned, seriesTrimmed: trimmed, refused: t.outflowRefused },
        // Per vault as well as per day: each vault has its own cap, so one vault binding its cap must not
        // stand in for the fleet.
        { dedupeKey: `${lc(t.vaultAddress)}:${day}` },
      );
    }
    if (t.foreignOutflow !== null) {
      await alerter.alert(
        'v2_mm_outflow_foreign',
        `the MakerVault's outflow bucket is ${t.foreignOutflow} USDG base units above what this bot's own calls account for: USDG left the vault through a quoter or admin call this bot did not send`,
        { over: t.foreignOutflow, used: t.vault.outflow.used, cap: t.vault.limits.maxDailyOutflow, vault: this.addresses?.vault ?? this.ctx.config.contracts.makerVault, signer: this.ctx.signer },
        { force: true },
      );
    }
    // Each market-safety halt pages once per vault and market while it holds (the Alerter's
    // dedupe), and is cleared on the first tick it no longer holds, so the next spell pages again.
    const SAFETY_ALERT: Record<string, `v2_${string}`> = { 'spot-age': 'v2_mm_spot_age', 'open-grace': 'v2_mm_open_grace', 'spot-move-breaker': 'v2_mm_spot_breaker' };
    const vaultKey = String(t.vaultAddress ?? '').toLowerCase();
    for (const m of t.input?.markets?.values() ?? []) {
      for (const [halt, kind] of Object.entries(SAFETY_ALERT)) {
        const key = `${vaultKey}:${lc(m.underlying)}`;
        if (m.halt?.halt === halt) {
          await alerter.alert(kind, `vault ${t.vaultAddress}: ${m.ticker} halted ${halt}; its quotes, resting asks included, are pulled${m.halt.detail ? ` (${m.halt.detail})` : ''}`, { vault: t.vaultAddress, market: m.ticker, halt, detail: m.halt.detail }, { dedupeKey: key });
        } else {
          alerter.clear(kind, key);
        }
      }
    }
    const eventHalted = (t.plan.series ?? []).filter((s) => s.halt?.halt === 'event-uncertainty');
    if (eventHalted.length > 0) {
      await alerter.alert(
        'v2_mm_event_halt',
        `vault ${t.vaultAddress}: ${eventHalted.length} series halted event-uncertainty (the pricing service flagged an event or model uncertainty); their quotes are pulled`,
        { vault: t.vaultAddress, series: eventHalted.map((s) => s.longId.toString()), detail: eventHalted[0]!.halt?.detail },
        { dedupeKey: vaultKey },
      );
    } else {
      alerter.clear('v2_mm_event_halt', vaultKey);
    }
    /*
     * A guard read that fails halts the series `guards-unreadable`, and that halt was SILENT: /health ok,
     * nothing paged, and both House vaults quoted nothing for as long as their askFloor read reverted. The halt stays (a
     * failed floor is never a zero floor); the silence goes. Warn from the first tick, error once it has held
     * GUARDS_UNREADABLE_ERROR_TICKS in a row, keyed apart so the escalation is not swallowed by the warn's cooldown.
     */
    const guards = guardsUnreadableOf(t);
    if (guards !== null) {
      const ticks = (this.guardsUnreadableTicks.get(vaultKey) ?? 0) + 1;
      this.guardsUnreadableTicks.set(vaultKey, ticks);
      const escalated = ticks >= GUARDS_UNREADABLE_ERROR_TICKS;
      await alerter.alert(
        'v2_mm_guards_unreadable',
        `vault ${t.vaultAddress}: ${guardsUnreadableReason(guards, ticks)}; those series are not quoted`,
        { vault: t.vaultAddress, series: guards.series, of: guards.of, calls: guards.calls, ticks, errorAfterTicks: GUARDS_UNREADABLE_ERROR_TICKS },
        { dedupeKey: escalated ? `${vaultKey}:error` : vaultKey, severity: escalated ? 'error' : 'warn' },
      );
    } else {
      this.guardsUnreadableTicks.delete(vaultKey);
      alerter.clear('v2_mm_guards_unreadable', vaultKey);
      alerter.clear('v2_mm_guards_unreadable', `${vaultKey}:error`);
    }
    const crossed = (t.plan.series ?? []).filter((s) => s.halt?.halt === 'protocol-cross');
    if (crossed.length > 0) {
      await alerter.alert(
        'v2_mm_protocol_cross',
        `MM skipped ${crossed.length} rest(s) that would cross a protocol-owned maker`,
        // `this.addresses.vault` is the TREASURY on every tick, so this named the wrong vault and
        // keyed every vault's page to one address. The tick's own vault is the subject.
        { vault: t.vaultAddress, series: crossed.map((s) => s.longId.toString()) },
        { dedupeKey: lc(t.vaultAddress) },
      );
    }
    const epoch = t.input?.vault?.epoch ?? null;
    if (epoch !== null && epoch.rollDue) {
      const inventory = (t.plan.series ?? []).map((s) => {
        const view = t.input.series.find((v) => v.info.longId === s.longId);
        return view?.exposure ?? { longs: 0n, shorts: 0n, resale: 0n };
      });
      if (!flatForRoll(inventory)) {
        await alerter.alert(
          'v2_mm_epoch_unflat',
          `House vault still holds risk at epochEnd ${epoch.epochEnd} (index ${epoch.index})`,
          { epochEnd: epoch.epochEnd, index: epoch.index },
          { force: true },
        );
      }
    }
    const unfunded = t.plan.series.filter((s) => s.sizes !== null && s.halt === null && s.sizes.capped.some((c) => c === 'usdg' || c === 'collateral') && (s.sizes.bid === 0n || s.sizes.write + s.sizes.resale === 0n));
    const byTicker = new Map<string, number>();
    for (const s of unfunded) byTicker.set(s.ticker, (byTicker.get(s.ticker) ?? 0) + 1);
    for (const [ticker, n] of byTicker) {
      // Keyed by ticker ALONE, two vaults short of funds on the same ticker suppressed each other.
      await alerter.alert('v2_mm_funds', `MM quotes one side only on ${n} ${ticker} series on vault ${t.vaultAddress}: the vault lacks USDG (bids) or ledger collateral (write asks)`, { vault: t.vaultAddress, ticker, series: n, usdgWallet: t.vault.usdgWallet }, { dedupeKey: `${lc(t.vaultAddress)}:${ticker}` });
    }
  }

  /** The configured House factory addresses, for alert context. */
  private factoryAddresses(): Address[] {
    return this.ctx.config.tuning.houseFactories.map((f) => f.address);
  }

  /**
   * Treasury vault, every MM_VAULTS extra, every discovered House vault, and the quoter key - all
   * lower-cased (mm-store `lc`), never compared by checksum.
   */
  protocolAccountSet(discovered: readonly Address[] = []): Set<string> {
    const set = new Set<string>();
    set.add(lc(this.ctx.config.contracts.makerVault));
    for (const v of this.ctx.config.tuning.extraVaults) set.add(lc(v));
    for (const v of discovered) set.add(lc(v));
    set.add(lc(this.ctx.signer));
    return set;
  }

  /*-------------------------------- kill ------------------------------*/

  async kill(reason: string, vault?: string): Promise<KillOutcome> {
    const at = Math.floor(this.wall() / 1000);
    if (vault !== undefined) this.mm.setKilledFor(vault, { at, reason });
    else this.mm.setKilled({ at, reason });
    this.ctx.log.warn({ reason, vault: vault ?? 'all' }, vault === undefined ? 'kill switch engaged: cancelling every vault order' : 'kill switch engaged for one vault');
    // Paged alongside the cancels, never before them: a relay that hangs (10 s timeout) must not keep quotes fillable.
    // The text says WHICH vault. A one-vault kill used to page "every vault order is being cancelled", so the
    // operator reading the page could not tell a fleet stop from a single House vault stopping.
    void this.ctx.alerter.alert(
      'v2_mm_killed',
      vault === undefined
        ? `MM kill switch engaged for every vault (${reason}): every vault order is being cancelled; nothing quotes until POST /resume`
        : `MM kill switch engaged for vault ${lc(vault)} (${reason}): that vault's orders are being cancelled and it quotes nothing until POST /resume; other vaults keep quoting`,
      { reason, vault: vault === undefined ? ALL_VAULTS : lc(vault) },
      { force: true },
    ).catch(() => false);
    // A failure (an unreachable RPC) is an answer, not a 500: the stored kill still halts every later tick.
    const scope = vault === undefined ? ALL_VAULTS : lc(vault);
    let run = this.killRuns.get(scope);
    if (run === undefined) {
      run = this.cancelEverything(vault)
        .catch((error: unknown) => ({ cancelled: 0, remaining: -1, remainingOrderIds: [] as bigint[], errors: [describeError(error)] }))
        .finally(() => {
          this.killRuns.delete(scope);
        });
      this.killRuns.set(scope, run);
    }
    const waitMs = this.ctx.killWaitMs ?? KILL_RESPONSE_WAIT_MS;
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([run, new Promise<null>((r) => (timer = setTimeout(() => r(null), waitMs)))]);
    clearTimeout(timer);
    const outcome: KillOutcome =
      result === null
        ? { killed: true, at, reason, cancelled: 0, remaining: -1, remainingOrderIds: [], done: false, errors: ['cancels still running; GET /state shows the vault\'s live orders'] }
        : { killed: true, at, reason, cancelled: result.cancelled, remaining: result.remaining, remainingOrderIds: result.remainingOrderIds, done: result.remaining === 0, errors: result.errors };
    this.lastKill = outcome;
    return outcome;
  }

  /**
   * Release a kill. The return says `killed: false` about THE SCOPE ASKED ABOUT: resuming one vault
   * used to answer a flat false without consulting {MmStore.killedFor}, so an operator who resumed vault A while
   * the process-wide kill was still engaged - or while A's own mark survived - read "quoting resumes" and it did
   * not. A brake that reports released while still engaged is the failure this whole task is about.
   */
  resume(vault?: string): { killed: false | true; at: number; stillKilled?: KilledState } {
    const at = Math.floor(this.wall() / 1000);
    if (vault !== undefined) this.mm.setKilledFor(vault, null);
    else this.mm.setKilled(null);
    const remaining = vault !== undefined ? this.mm.killedFor(vault) : this.mm.killed();
    if (remaining !== null) {
      this.ctx.log.warn({ vault: vault ?? 'all', remaining }, 'resume did NOT release: a wider kill is still engaged');
      return { killed: true, at, stillKilled: remaining };
    }
    this.ctx.log.warn({ vault: vault ?? 'all' }, 'kill switch released: quoting resumes at the next tick');
    void this.ctx.alerter.alert('v2_mm_resumed', 'MM kill switch released (POST /resume): quoting resumes', {}, { force: true });
    this.wakeLoop?.();
    return { killed: false, at };
  }

  /**
   * Cancel every vault order with units left (live, or expired still holding escrow: engine.isKillTarget), until a
   * re-read finds none. The final count uses the same predicate as the targets, so a target whose cancel failed is
   * remaining, never done.
   */
  private stillKilled(vault?: string): boolean {
    return vault !== undefined ? this.mm.killedFor(vault) !== null : this.mm.killed() !== null;
  }

  private async cancelEverything(onlyVault?: string): Promise<{ cancelled: number; remaining: number; remainingOrderIds: bigint[]; errors: string[] }> {
    const errors: string[] = [];
    /*
     * CANCELLED IS COUNTED FROM CHAIN STATE, NOT FROM THE RECEIPT. OrderBook.cancel skips an order that is already
     * cancelled or fully filled WITHOUT reverting (`if (o.cancelled || remaining == 0) continue`), so a confirmed
     * receipt says the call ran, not that it cancelled every id it named: an order filled between the read and the
     * send was counted as cancelled. An id counts once a later read of the book shows it cancelled.
     */
    const asked = new Set<bigint>();
    const seenCancelled = new Set<bigint>();
    const observe = (chain: readonly ChainOrder[]) => {
      for (const o of chain) if (o.cancelled && asked.has(o.id)) seenCancelled.add(o.id);
    };
    /*
     * ONE VAULT'S FAULT IS NOT THE KILL'S, the tick's boundary applied to the one path that must
     * degrade per vault. A vault whose reads throw is skipped and named here, and the remaining vaults are still
     * cancelled. It is not a finished kill: while any vault is unreadable the answer is `remaining: -1`, because a
     * vault nobody could read may still have orders that can fill.
     */
    const unreadable = new Map<string, string>();
    const failures = () => [...errors, ...unreadable.values()];
    await this.bindAnchor();
    const resumed = () => ({ cancelled: seenCancelled.size, remaining: -1, remainingOrderIds: [] as bigint[], errors: [...failures(), 'resumed (POST /resume) while the kill was cancelling: its remaining passes were stopped'] });
    const read = async (vaultAddr: Address, head: Head): Promise<{ a: MmAddresses; chain: ChainOrder[] } | 'wrong-book' | 'unreadable'> => {
      try {
        const a = await this.addressesFor(vaultAddr, head.blockNumber);
        if (a === 'wrong-book') return a;
        const count = (await this.ctx.client.readContract({ address: a.orderBook, abi: orderBookAbi, functionName: 'makerOrderCount', args: [a.vault], blockNumber: head.blockNumber })) as bigint;
        await this.ingestOrders(a, count, head);
        const chain = await readOrders(this.ctx.client, a.orderBook, this.mm.openOrders(a.vault).map((o) => o.orderId), head.blockNumber);
        unreadable.delete(lc(vaultAddr));
        observe(chain);
        return { a, chain };
      } catch (error) {
        unreadable.set(lc(vaultAddr), `vault ${vaultAddr} could not be read during the kill, so its orders were not cancelled: ${describeError(error)}`);
        return 'unreadable';
      }
    };
    /*
     * THE SAME VAULT SET THE TICK USES. This resolved `quotedVaults()` - the treasury plus the
     * MM_VAULTS extras - while the tick resolves `vaultTargets()`, which ALSO includes every House vault the
     * factory enumerates. A body-less kill therefore never deep-cancelled a factory-discovered vault, and
     * because the loop only counts targets it actually walked it could still answer `done: true`. A brake that
     * reports success for a vault it never looked at is worse than one that fails.
     *
     * Falling back to `quotedVaults()` when discovery throws is deliberate: a kill must cancel what it can
     * reach rather than abort, and the shortfall is reported through `errors` instead of being swallowed.
     */
    let vaults: Address[];
    if (onlyVault !== undefined) {
      vaults = [getAddress(onlyVault)];
    } else {
      try {
        const head0 = await readHead(this.ctx.client);
        const targeted = (await this.vaultTargets(head0)).map((t) => t.address);
        // Plus every House vault discovery found but did not quote (untagged factory, unreadable kind).
        const have = new Set(targeted.map(lc));
        const house = this.discoveredHouse.filter((v) => !have.has(lc(v)));
        for (const v of house) have.add(lc(v));
        // Plus every MM_VAULTS entry refused as a House vault (vaultTargets just rebuilt the list). It is
        // quoted by neither path, so without this nothing a kill does reaches the orders it already rests.
        const refused = this.refusedVaults.map((r) => r.address).filter((v) => !have.has(lc(v)));
        vaults = [...targeted, ...house, ...refused];
      } catch (error) {
        vaults = this.quotedVaults();
        errors.push(`vault discovery failed during kill; cancelled the ${vaults.length} configured vault(s) only: ${describeError(error)}`);
      }
    }
    for (let pass = 0; pass < 5; pass += 1) {
      if (!this.stillKilled(onlyVault)) return resumed();
      const head = await readHead(this.ctx.client);
      let anyTargets = false;
      for (const vaultAddr of vaults) {
        if (!this.stillKilled(onlyVault)) return resumed();
        const r = await read(vaultAddr, head);
        if (r === 'wrong-book' || r === 'unreadable') continue;
        const targets = r.chain.filter((o) => o.maker !== zeroAddress && isKillTarget(o, head.timestamp));
        if (targets.length === 0) continue;
        anyTargets = true;
        for (let i = 0; i < targets.length; i += CANCEL_CHUNK) {
          if (!this.stillKilled(onlyVault)) return resumed();
          const ids = targets.slice(i, i + CANCEL_CHUNK).map((o) => o.id);
          try {
            const record = await this.send({ type: 'cancel', orderIds: ids, longIds: [], reason: 'kill switch' }, r.a.vault);
            if (record.status === 'confirmed') for (const id of ids) asked.add(id);
            else if (record.status !== 'in-flight') errors.push(`${record.what}: ${record.status}${record.revert ? ` ${record.revert}` : ''}`);
          } catch (error) {
            errors.push(describeError(error));
          }
        }
      }
      // An unreadable vault is retried on the next pass rather than read as having nothing left.
      if (!anyTargets && unreadable.size === 0) return { cancelled: seenCancelled.size, remaining: 0, remainingOrderIds: [], errors };
      await sleep(pass === 0 ? 0 : (this.ctx.killRetryMs ?? 1_000));
    }
    if (!this.stillKilled(onlyVault)) return resumed();
    const head = await readHead(this.ctx.client);
    const left: bigint[] = [];
    for (const vaultAddr of vaults) {
      const r = await read(vaultAddr, head);
      if (r === 'wrong-book' || r === 'unreadable') continue;
      left.push(...r.chain.filter((o) => o.maker !== zeroAddress && isKillTarget(o, head.timestamp)).map((o) => o.id));
    }
    const remaining = unreadable.size > 0 ? -1 : left.length;
    if (remaining !== 0) this.ctx.log.error({ remainingOrderIds: left, unreadable: [...unreadable.keys()], errors: failures() }, 'kill switch: vault orders still hold escrow or can fill after every cancel pass, or a vault could not be read; later ticks keep cancelling');
    return { cancelled: seenCancelled.size, remaining, remainingOrderIds: left, errors: failures() };
  }

  /*-------------------------------- state -----------------------------*/

  /** /state's `unavailable` for one vault's last tick: null while every guard read answers. */
  private guardsUnavailable(row: LastTick, address: string): string | null {
    const g = guardsUnreadableOf(row);
    return g === null ? null : guardsUnreadableReason(g, this.guardsUnreadableTicks.get(address) ?? 0);
  }

  state(): unknown {
    const t = this.last;
    if (t === null) return null;
    const { plan, input, vault } = t;
    const halts: Record<string, number> = {};
    for (const s of plan.series) {
      const k = s.halt === null ? (s.targets === null ? 'not-quoted' : 'quoting') : s.halt.halt;
      halts[k] = (halts[k] ?? 0) + 1;
    }
    return {
      mode: 'mm',
      signer: this.ctx.signer,
      vault: this.addresses?.vault ?? this.ctx.config.contracts.makerVault,
      head: t.head,
      ticks: this.ticks,
      lastTickAt: new Date(t.startedAt).toISOString(),
      lastTickDurationMs: t.durationMs,
      // The NYSE holiday table's horizon at the head block; `warning` is non-null inside its last quarter.
      holidayHorizon: holidayHorizon(t.head.timestamp),
      killed: this.mm.killed(),
      lastKill: this.lastKill,
      // The EarnVault venue step's last run; null when V2_EARN_VAULT is unset or the step has not run yet.
      earn:
        this.lastEarn === null
          ? null
          : {
              vault: this.ctx.config.tuning.earn?.vault ?? null,
              at: this.lastEarn.at,
              queueHead: this.lastEarn.state.queueHead,
              queueTail: this.lastEarn.state.queueTail,
              wallet: this.lastEarn.state.wallet,
              escrowed: this.lastEarn.state.escrowed,
              venueWithdrawable: this.lastEarn.state.venueWithdrawable,
              buffer: this.lastEarn.plan.buffer,
              skipped: this.lastEarn.plan.skipped,
              sent: this.lastEarn.sent,
              queueStuckForS: this.lastEarn.stuckForS,
            },
      house: {
        factories: this.ctx.config.tuning.houseFactories,
        // Null when the House path works; otherwise why no House vault is being quoted.
        unavailable: this.houseUnavailable,
        // MM_VAULTS entries refused because they are House vaults, and why.
        refused: this.refusedVaults,
      },
      vaults: [...this.lastByVault.entries()].map(([address, row]) => ({
        address,
        kind: this.targetsByVault.get(address)?.kind ?? 'treasury',
        killed: this.mm.killedFor(address),
        isQuoter: row.vault.isQuoter,
        tradingPaused: row.vault.tradingPaused,
        epoch: row.input.vault.epoch,
        caps: {
          maxSeriesUnits: row.input.params.maxSeriesUnits,
          maxTotalNotionalUsdg6: row.input.params.maxTotalNotionalUsdg6,
          dailyLossLimitUsdg6: row.stop.limit,
        },
        inventory: row.plan.series.map((s) => ({ longId: s.longId.toString(), inventory: s.inventory, halt: s.halt })),
        selected: row.plan.selected.map((id) => id.toString()),
        // The latest fills and their +1/+5/+30-minute markouts, newest first.
        markouts: markoutsOf(this.markoutsByVault, address),
        // The mark-to-market loss stop this vault's tick planned with (planner mtmLossStop): today's
        // realised result, the unrealised marks, their total against the limit, tripped, and the positions with no mark.
        mtm: row.plan.mtm ?? null,
        txs: row.txs.length,
        // The routine-send gate (MM_SEND_INTERVAL_S) and what the tick budget let this vault send.
        sendGate: row.sendGate,
        budget: row.budget,
        twoSided: twoSidedCount(row.plan),
        // Null while every guard read answers; else why series are halted guards-unreadable, and the failing calls.
        unavailable: this.guardsUnavailable(row, address),
        guardsUnreadable: guardsUnreadableOf(row),
        // Per vault, not "the last vault ticked": both of these used to be single fields overwritten each tick.
        lastSales: this.lastSalesByVault.get(address) ?? null,
        recentFills: this.recentFillsByVault.get(address) ?? [],
      })),
      lossStop: { day: t.stop.day, realisedUsdg6: t.stop.realised, limitUsdg6: t.stop.limit, tripped: t.stop.tripped },
      session: { open: vault.sessionOpen, close: vault.sessionClose, quoteOffHours: this.params.quoteOffHours },
      netDelta: plan.netDelta.map((r) => ({
        ticker: r.ticker,
        underlying: r.underlying,
        deltaShares: Number(r.deltaShares.toFixed(6)),
        deltaUsdg: r.spot === null ? null : Number(((r.deltaShares * Number(r.spot)) / 1e6).toFixed(2)),
        spot: r.spot,
        positions: r.positions,
        positionsWithoutDelta: r.unknown,
        alertAboveShares: this.params.deltaAlertShares,
        alert: r.alert,
        hedging: 'manual (no borrow market)',
      })),
      vaultState: {
        isQuoter: vault.isQuoter,
        tradingPaused: vault.tradingPaused,
        limits: vault.limits,
        outflow: {
          capUsdg6: plan.outflow.cap,
          usedUsdg6: plan.outflow.used,
          availableUsdg6: vault.outflow.available,
          releasedThisTickUsdg6: plan.outflow.released,
          budgetThisTickUsdg6: plan.outflow.budget,
          plannedThisTickUsdg6: plan.outflow.planned,
          blocked: plan.outflow.blocked,
          refused: t.outflowRefused,
          foreignUsdg6: t.foreignOutflow,
          // The WRITE is scoped to the ticked vault (setOutflowProjection(..., vaultAddr)); this read used
          // `this.addresses?.vault`, the treasury, so a House vault tick reported the treasury's projection as
          // its own. Scoped write, unscoped read - the same split as the loss stop.
          projection: this.mm.outflowProjection(t.vaultAddress),
        },
        botLimits: { maxSeriesUnits: this.params.maxSeriesUnits, maxTotalNotionalUsdg6: this.params.maxTotalNotionalUsdg6 },
        totalNotional: vault.totalNotional,
        usdgWallet: vault.usdgWallet,
        // USDG in that wallet the vault owes queued depositors and unclaimed withdrawers (House only).
        usdgReserved: vault.usdgReserved,
        owed: vault.owed,
        freeCollateral: Object.fromEntries(input.vault.freeCollateral),
        walletTokens: Object.fromEntries(input.vault.walletTokens),
        // Which of the two maps' values are an unread 0n, not a measured one.
        ...(input.vault.balancesUnread === undefined ? {} : { balancesUnread: [...input.vault.balancesUnread] }),
        trackedSeries: input.vault.tracked.length,
        // As above: written per ticked vault (`this.mm.lastSync(a.vault)`), read here as the treasury's.
        lastSync: this.mm.lastSync(t.vaultAddress),
      },
      quoting: {
        managed: plan.series.length,
        selected: plan.selected.length,
        twoSided: twoSidedCount(plan),
        byHalt: halts,
        capped: plan.capped,
        // The caps as settled at boot (derived from the ladder unless set) and, per quoted market, listed
        // vs live vs selected with every trim named. `not-selected` > 0 on a derived cap means the ladder grew past
        // the registry the image was built with, or MM_MARKETS quotes more than the caps were derived for.
        seriesCaps: { maxSeries: this.params.maxSeries, maxSeriesPerMarket: this.params.maxSeriesPerMarket, derived: this.ctx.config.tuning.seriesCoverage.derived },
        byMarket: t.coverage,
      },
      pricing: t.pricing,
      series: plan.series.map((s) => ({
        longId: s.longId,
        ticker: s.ticker,
        type: s.isPut ? 'put' : 'call',
        strike: s.strike,
        expiry: s.expiry,
        selected: s.selected,
        halt: s.halt,
        fair: s.fair === null ? null : { fair: s.fair.fair, delta: s.fair.delta, iv: s.fair.iv, source: s.fair.source, asOf: s.fair.asOf },
        fairReason: s.fairReason,
        quote: s.prices === null ? null : { bid: s.prices.bid, ask: s.prices.ask, resale: s.prices.resale, halfSpread: s.prices.halfSpread, skew: s.prices.skew, widenBps: s.prices.widen, clampedBy: s.prices.clampedBy },
        // Safe call selling: the spot-lag floor (spotRef, spotQ, bandBps, lagFair, the per-slot floor, whether it raised
        // an ask) and why the write side is held.
        lag: s.lag,
        writeHold: s.writeHold,
        targets: s.targets,
        sizes: s.sizes === null ? null : { bid: s.sizes.bid, write: s.sizes.write, resale: s.sizes.resale, exposure: s.sizes.exposure, notional: s.sizes.notional, capped: s.sizes.capped },
        inventory: s.inventory,
        live: s.live,
      })),
      lastTxs: t.txs,
      // Every entry says which vault it is from, and each vault keeps its own window, so a busy vault cannot
      // evict a quiet one's fills from this view. Newest first across the fleet.
      recentFills: flattenRecentFills(this.recentFillsByVault),
      // The primary vault's sales, named as such; the per-vault figure for every vault is in `vaults[]` above.
      lastSales: this.lastSalesByVault.get(lc(t.vaultAddress)) ?? null,
      index: { ...t.scan, ...this.mm.counts() },
      recentTxs: this.ctx.store.recentTxs(20),
    };
  }
}
