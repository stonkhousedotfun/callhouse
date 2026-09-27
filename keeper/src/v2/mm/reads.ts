/**
 * The views an MM tick plans from, read in multicalls pinned to the tick's head block (chain.ts multicallMany; a view
 * that reverts is a failed outcome, not a thrown batch). Nothing here decides (planner.ts) or sends (quoter.ts).
 */
import { getAbiItem, parseAbi, toFunctionSelector, zeroAddress, type AbiEvent, type Address } from 'viem';
import { accessManagerAbi } from '../abi/accessManager.js';
import { clearinghouseAbi } from '../abi/clearinghouse.js';
import { expiryCalendarAbi } from '../abi/expiryCalendar.js';
import { houseVaultAbi } from '../abi/houseVault.js';
import { makerVaultAbi } from '../abi/makerVault.js';
import { orderBookAbi } from '../abi/orderBook.js';
import { priceSourceAbi } from '../abi/priceSource.js';
import { settlementOracleAbi } from '../abi/settlementOracle.js';
import type { MulticallClient, ReadOutcome } from '../chain.js';
import { okResult, readMany, type AnyRead } from '../cranker/reads.js';
import { shortIdOf } from '../seriesId.js';
import { describeError } from '../tx.js';
import { ORDER_KIND } from './constants.js';
import type { LiveOrder, SeriesInfo } from './engine.js';
import type { FillLog } from './pnl.js';
import type { ExposureDetail, MarketView, SeriesView, VaultLimits } from './planner.js';

export const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)']);

/**
 * The vault call the QUOTER role authorises. INTERFACE_VERSION 8 asks the AccessManager whether this key
 * may make THIS call, rather than asking the vault whether this key holds a role — a `Managed` target has
 * no role storage and no `hasRole` at all. Derived from the signature, never pasted as hex, and verified
 * byte-identical between `script/v2/roles.v8.json` (MakerVault.place -> QUOTER) and the published
 * `ops/abis/v2/MakerVault.json`.
 */
export const VAULT_PLACE_SELECTOR = toFunctionSelector('place(uint256,uint8,uint128,uint64,uint40)');

export interface MmAddresses {
  clearinghouse: Address;
  orderBook: Address;
  vault: Address;
  usdg: Address;
  /** The AccessManager the vault is Managed by. Required for V2_MODE=mm (config.ts MODE_CONTRACTS). */
  manager: Address;
}

const lc = (a: string): string => a.toLowerCase();

function must<T>(outcome: { ok: true; result: unknown } | { ok: false; error: Error } | undefined, what: string): T {
  if (outcome === undefined) throw new Error(`${what}: no result`);
  if (!outcome.ok) throw new Error(`${what}: ${outcome.error.message.split('\n')[0]}`);
  return outcome.result as T;
}

/*//////////////////////////////////////////////////////////////
                              VAULT
//////////////////////////////////////////////////////////////*/

export interface VaultState {
  limits: VaultLimits;
  /** MakerVault.outflow(): net USDG the quoter has moved out of the vault, and what the cap still allows. */
  outflow: { used: bigint; available: bigint };
  totalNotional: bigint;
  tracked: bigint[];
  isQuoter: boolean;
  /**
   * The manager's `delay` for this (key, target, selector). 0 with `isQuoter` false means "not a member,
   * or the selector is not mapped"; non-zero means "a member, but every call must be scheduled first" —
   * which the bot cannot do, so it is still not quoting. The two are one alert with different causes.
   */
  quoterDelay: number;
  tradingPaused: boolean;
  owed: bigint;
  makerOrderCount: bigint;
  usdgWallet: bigint;
  /**
   * USDG in the wallet that belongs to OTHER PEOPLE on a House vault:
   * `HouseVault.pendingDepositUsdg()` (queued deposits not yet priced) + `HouseVault.owedUsdg()` (priced withdrawals
   * not yet claimed) + `HouseVault.performanceFeeOwed()` (the performance fee carried until it is paid).
   * That is the sum `HouseVault._requireUnreservedSpend` reserves, so a bid sized against anything smaller reverts
   * InsufficientCollateral while a fee is carried. A bid may never escrow it. `null` for a treasury MakerVault, which
   * has none of the three getters.
   * NOT `owed` above: that is OrderBook.owed(vault), USDG the book owes TO the vault -- the opposite direction.
   */
  usdgReserved: bigint | null;
  /**
   * `HouseVault.quotingPaused()`: GUARDIAN's brake. While it is set the vault's place, replace and take revert
   * TradingPaused (`HouseVault._requireQuoting`); cancel, close, sync, claimOwed and depositToClearinghouse still run.
   * OrderBook.tradingPaused does not see it. `null` for a treasury MakerVault, which has no such getter.
   */
  quotingPaused: boolean | null;
  /**
   * Stock Token in the wallet that belongs to OTHER PEOPLE on a House vault: `HouseVault.pendingDepositStock()`
   * (queued stock deposits) + `HouseVault.owedStock()` (priced stock withdrawals not yet claimed), the vault's own
   * underlying only. `HouseVault.depositToClearinghouse` clamps a deposit of that token to the wallet less this sum
   * (`_unreservedWallet`) and reverts BadUnits when nothing is left. `null` for a treasury MakerVault.
   */
  stockReserved: bigint | null;
  fees: { premiumFeeBps: number; resaleFeeBps: number };
  /** OrderBook.pendingFeeParams(): the zero value when nothing is scheduled, so effectiveAt 0 means none. */
  pendingFees: { params: { premiumFeeBps: number; resaleFeeBps: number }; effectiveAt: number };
  sessionOpen: boolean;
  sessionClose: number | null;
}

export async function readVaultState(client: MulticallClient, a: MmAddresses, input: { signer: Address; calendar: Address; now: number; blockNumber: bigint; house: boolean }): Promise<VaultState> {
  const day = Math.floor(input.now / 86_400);
  const calls: AnyRead[] = [
    { address: a.vault, abi: makerVaultAbi, functionName: 'limits' },
    { address: a.vault, abi: makerVaultAbi, functionName: 'totalNotional' },
    { address: a.vault, abi: makerVaultAbi, functionName: 'trackedSeries' },
    // INTERFACE_VERSION 8. r[3] and r[4] REPLACE the two v7 vault hasRole reads IN PLACE, deliberately:
    // reads.ts decodes this array POSITIONALLY by hardcoded index, so removing a call and letting the rest
    // slide down is a known trap — every later read would return a plausible value
    // from the wrong call and nothing would fail. Reusing the two freed slots leaves r[5]..r[12] untouched.
    { address: a.manager, abi: accessManagerAbi, functionName: 'canCall', args: [input.signer, a.vault, VAULT_PLACE_SELECTOR] },
    { address: a.orderBook, abi: orderBookAbi, functionName: 'pendingFeeParams' },
    { address: a.orderBook, abi: orderBookAbi, functionName: 'tradingPaused' },
    { address: a.orderBook, abi: orderBookAbi, functionName: 'owed', args: [a.vault] },
    { address: a.orderBook, abi: orderBookAbi, functionName: 'makerOrderCount', args: [a.vault] },
    { address: a.orderBook, abi: orderBookAbi, functionName: 'feeParams' },
    { address: a.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [a.vault] },
    { address: input.calendar, abi: expiryCalendarAbi, functionName: 'isRegularSession', args: [input.now] },
    { address: input.calendar, abi: expiryCalendarAbi, functionName: 'closeOf', args: [day] },
    // INTERFACE_VERSION 7: the leaky bucket behind limits.maxDailyOutflow, in the same pinned multicall.
    { address: a.vault, abi: makerVaultAbi, functionName: 'outflow' },
    // A House vault's reserved USDG, AFTER r[12] and never earlier: the decode below is positional
    // (quirk B.1 above), so appending leaves r[0]..r[12] where they were. Same block as balanceOf (r[9]), so the
    // wallet and the reserve it is measured against are one snapshot. A treasury MakerVault has neither getter and
    // would revert, so it issues neither call.
    ...(input.house
      ? [
          { address: a.vault, abi: houseVaultAbi, functionName: 'pendingDepositUsdg' },
          { address: a.vault, abi: houseVaultAbi, functionName: 'owedUsdg' },
          // (N1): r[15], APPENDED after owedUsdg for the same positional reason. The contract reserves this
          // too (HouseVault._requireUnreservedSpend: pendingDepositUsdg + owedUsdg + performanceFeeOwed).
          { address: a.vault, abi: houseVaultAbi, functionName: 'performanceFeeOwed' },
          // r[16]..r[18], APPENDED for the same positional reason. The quoting brake (_requireQuoting) and the
          // stock reserve depositToClearinghouse clamps to (_unreservedWallet: pendingDepositStock + owedStock).
          { address: a.vault, abi: houseVaultAbi, functionName: 'quotingPaused' },
          { address: a.vault, abi: houseVaultAbi, functionName: 'pendingDepositStock' },
          { address: a.vault, abi: houseVaultAbi, functionName: 'owedStock' },
        ] as AnyRead[]
      : []),
  ];
  const r = await readMany(client, calls, input.blockNumber);
  // Six fields since INTERFACE_VERSION 7: a positional decode that drops maxDailyOutflow would not encode setLimits.
  const limits = must<{ maxSeriesUnits: bigint; maxTotalNotional: bigint; askToleranceBps: number; maxBidBpsOfSpot: number; maxOrderLifetime: number; maxDailyOutflow: bigint }>(r[0], 'vault.limits');
  const fees = must<{ premiumFeeBps: number; resaleFeeBps: number }>(r[8], 'orderBook.feeParams');
  // canCall returns (bool immediate, uint32 delay). `immediate` IS the question the bot has: may this key
  // make this call right now, with no scheduling? A delayed member answers false, which is correct — the
  // bot has no scheduling path — and the delay is carried so the alert can say which of the two it is.
  const canPlace = must<readonly [boolean, number]>(r[3], 'manager.canCall(vault.place)');
  const pending = must<readonly [{ premiumFeeBps: number; resaleFeeBps: number }, number]>(r[4], 'orderBook.pendingFeeParams');
  const sessionOpen = must<boolean>(r[10], 'calendar.isRegularSession');
  const outflow = must<readonly [bigint, bigint]>(r[12], 'vault.outflow');
  return {
    limits: {
      maxSeriesUnits: BigInt(limits.maxSeriesUnits),
      maxTotalNotional: BigInt(limits.maxTotalNotional),
      askToleranceBps: Number(limits.askToleranceBps),
      maxBidBpsOfSpot: Number(limits.maxBidBpsOfSpot),
      maxOrderLifetime: Number(limits.maxOrderLifetime),
      maxDailyOutflow: BigInt(limits.maxDailyOutflow),
    },
    outflow: { used: outflow[0], available: outflow[1] },
    totalNotional: must<bigint>(r[1], 'vault.totalNotional'),
    tracked: [...must<readonly bigint[]>(r[2], 'vault.trackedSeries')],
    // NO ADMIN FALLBACK. v7 OR-ed in DEFAULT_ADMIN_ROLE membership; v8 does not, and re-adding it is the
    // single easiest way to silently recreate the bug this deletes. It loses nothing: roles.v8.json lists
    // QUOTER among the Admin Safe's own holdings, so the Safe is a QUOTER member in its own right.
    isQuoter: canPlace[0],
    quoterDelay: Number(canPlace[1]),
    tradingPaused: must<boolean>(r[5], 'orderBook.tradingPaused'),
    owed: must<bigint>(r[6], 'orderBook.owed'),
    makerOrderCount: must<bigint>(r[7], 'orderBook.makerOrderCount'),
    usdgWallet: must<bigint>(r[9], 'usdg.balanceOf(vault)'),
    // `must`, NEVER `okResult(...) ?? 0n`: a reserve that failed to read is not a reserve of zero -- that default is
    // the bug itself. The throw lands in quoter.ts's per-vault boundary, which skips this vault for the tick.
    usdgReserved: input.house
      ? must<bigint>(r[13], 'house.pendingDepositUsdg') + must<bigint>(r[14], 'house.owedUsdg') + must<bigint>(r[15], 'house.performanceFeeOwed')
      : null,
    // `must` for the same reason as the USDG reserve: an unread brake is not "not paused", an unread reserve not zero.
    quotingPaused: input.house ? must<boolean>(r[16], 'house.quotingPaused') : null,
    stockReserved: input.house ? must<bigint>(r[17], 'house.pendingDepositStock') + must<bigint>(r[18], 'house.owedStock') : null,
    fees: { premiumFeeBps: Number(fees.premiumFeeBps), resaleFeeBps: Number(fees.resaleFeeBps) },
    pendingFees: {
      params: { premiumFeeBps: Number(pending[0].premiumFeeBps), resaleFeeBps: Number(pending[0].resaleFeeBps) },
      effectiveAt: Number(pending[1]),
    },
    sessionOpen,
    sessionClose: sessionOpen ? Number(must<bigint>(r[11], 'calendar.closeOf')) : null,
  };
}

/**
 * A House vault's wallet and reserved USDG NOW, for the send-time recheck in quoter.ts execute():
 * `usdg.balanceOf(vault)`, `pendingDepositUsdg()`, `owedUsdg()` and `performanceFeeOwed()` in ONE multicall at a
 * block taken at call time
 * (`cacheTime: 0`, so never a block cached from before the previous send returned, and never the tick's pinned head).
 * Every read is `must`: a failed read throws, and the caller counts a throw as a refusal.
 */
export async function readHouseReserve(client: MulticallClient, a: Pick<MmAddresses, 'vault' | 'usdg'>): Promise<{ blockNumber: bigint; wallet: bigint; reserved: bigint }> {
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const r = await readMany(client, [
    { address: a.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [a.vault] },
    { address: a.vault, abi: houseVaultAbi, functionName: 'pendingDepositUsdg' },
    { address: a.vault, abi: houseVaultAbi, functionName: 'owedUsdg' },
    { address: a.vault, abi: houseVaultAbi, functionName: 'performanceFeeOwed' },
  ], blockNumber);
  return {
    blockNumber,
    wallet: must<bigint>(r[0], 'usdg.balanceOf(vault)'),
    reserved: must<bigint>(r[1], 'house.pendingDepositUsdg') + must<bigint>(r[2], 'house.owedUsdg') + must<bigint>(r[3], 'house.performanceFeeOwed'),
  };
}

/*//////////////////////////////////////////////////////////////
                             MARKETS
//////////////////////////////////////////////////////////////*/

export interface MarketsRead {
  markets: Map<string, MarketView>;
  /** Clearinghouse.free(vault, asset), lower-case asset: USDG and every quoted Stock Token. */
  freeCollateral: Map<string, bigint>;
  /** The vault wallet's Stock Token balances. */
  walletTokens: Map<string, bigint>;
  /**
   * The balance reads above that FAILED, as `free(<asset>)` / `balanceOf(<token>)`. Their value in the maps is
   * 0n, which sizes no write and proposes no deposit (fail closed), but is not a measured 0: /state names them. Optional
   * so a hand-built read without failures needs no field.
   */
  balancesUnread?: string[];
  /**
   * Per lower-case underlying, the market's oracle and its trySpot updatedAt (source 0's print time) when the
   * read was ok, for {readSpotClocks}. Absent when market() failed.
   */
  spotPrints: Map<string, { oracle: Address; updatedAt: number | null }>;
}

export async function readMarkets(client: MulticallClient, a: MmAddresses, markets: ReadonlyArray<{ ticker: string; underlying: Address }>, blockNumber: bigint): Promise<MarketsRead> {
  const first: AnyRead[] = [{ address: a.clearinghouse, abi: clearinghouseAbi, functionName: 'free', args: [a.vault, a.usdg] }];
  for (const m of markets) {
    first.push({ address: a.clearinghouse, abi: clearinghouseAbi, functionName: 'market', args: [m.underlying] });
    first.push({ address: a.clearinghouse, abi: clearinghouseAbi, functionName: 'free', args: [a.vault, m.underlying] });
    first.push({ address: m.underlying, abi: erc20Abi, functionName: 'balanceOf', args: [a.vault] });
  }
  const r1 = await readMany(client, first, blockNumber);
  const balancesUnread: string[] = [];
  /** The balance, or 0n (no write, no deposit) with the read named in balancesUnread. */
  const balance = (o: ReadOutcome<unknown> | undefined, what: string): bigint => {
    const v = okResult<bigint>(o);
    if (v === undefined) balancesUnread.push(what);
    return v ?? 0n;
  };
  const freeCollateral = new Map<string, bigint>([[lc(a.usdg), balance(r1[0], `free(${lc(a.usdg)})`)]]);
  const walletTokens = new Map<string, bigint>();
  const configs: Array<{ enabled: boolean; mintPaused: boolean; oracle: Address } | undefined> = [];
  markets.forEach((m, i) => {
    configs.push(okResult<{ enabled: boolean; mintPaused: boolean; oracle: Address }>(r1[1 + i * 3]));
    freeCollateral.set(lc(m.underlying), balance(r1[2 + i * 3], `free(${lc(m.underlying)})`));
    walletTokens.set(lc(m.underlying), balance(r1[3 + i * 3], `balanceOf(${lc(m.underlying)})`));
  });
  const spotCalls: AnyRead[] = markets.map((m, i) => ({ address: configs[i]?.oracle ?? a.clearinghouse, abi: settlementOracleAbi, functionName: 'trySpot', args: [m.underlying] }));
  const r2 = await readMany(client, spotCalls, blockNumber);
  const out = new Map<string, MarketView>();
  const spotPrints = new Map<string, { oracle: Address; updatedAt: number | null }>();
  markets.forEach((m, i) => {
    const config = configs[i];
    const spot = config === undefined ? undefined : okResult<readonly [boolean, bigint, bigint]>(r2[i]);
    if (config !== undefined) spotPrints.set(lc(m.underlying), { oracle: config.oracle, updatedAt: spot !== undefined && spot[0] && spot[1] > 0n ? Number(spot[2]) : null });
    out.set(lc(m.underlying), {
      underlying: lc(m.underlying),
      ticker: m.ticker,
      enabled: config?.enabled ?? false,
      mintPaused: config?.mintPaused ?? true,
      spot: spot !== undefined && spot[0] && spot[1] > 0n ? spot[1] : null,
    });
  });
  return { markets: out, freeCollateral, walletTokens, spotPrints, ...(balancesUnread.length > 0 ? { balancesUnread } : {}) };
}

/*//////////////////////////////////////////////////////////////
                  SPOT CLOCKS
//////////////////////////////////////////////////////////////*/

export interface SpotClock {
  /** The freshest corroborated observation of the market's spot (engine.MarketSafetyInput.spotObservedAt), or null. */
  observedAt: number | null;
  /** calendar.isRegularSession(observedAt), or null when there is no observation or the read failed. */
  observedInSession: boolean | null;
  /** Which reading `observedAt` is: the oracle's print, or the address of the agreeing source that refreshed it. */
  from: 'oracle-print' | Address | null;
}

/**
 * The inputs of the P7/P8 market-safety halts, in two multicalls. Per market: SettlementOracle.marketConfig(u).sources
 * and then every source after the first (`latest(u)`: a UniV3TwapSource answers its TWAP with updatedAt =
 * block.timestamp); plus calendar.isRegularSession(now − openGraceS) once.
 *
 * FRESHEST CORROBORATED OBSERVATION. The oracle hands back source 0's print
 * time even when the pool corroborates it (SettlementOracle._spot), and the Chainlink feed prints on a 0.5 % move, so a
 * quiet session's print is old while the price is not. A later source reading counts only when its price is within
 * `toleranceBps` of the oracle's spot (MM_FAIR_SPOT_TOLERANCE_BPS); tolerance 0 = no source gets that credit and the
 * print time stands alone. A market with no ok oracle spot has no observation (null): it halts spot-age in session.
 */
export async function readSpotClocks(
  client: MulticallClient,
  input: {
    calendar: Address;
    now: number;
    openGraceS: number;
    toleranceBps: number;
    markets: ReadonlyArray<{ underlying: string; oracle: Address; spot: bigint | null; updatedAt: number | null }>;
    blockNumber: bigint;
  },
): Promise<{ sessionOpenAtGrace: boolean; clocks: Map<string, SpotClock> }> {
  const first: AnyRead[] = [
    { address: input.calendar, abi: expiryCalendarAbi, functionName: 'isRegularSession', args: [input.now - input.openGraceS] },
    ...input.markets.map((m): AnyRead => ({ address: m.oracle, abi: settlementOracleAbi, functionName: 'marketConfig', args: [m.underlying as Address] })),
  ];
  const r1 = await readMany(client, first, input.blockNumber);
  const sessionOpenAtGrace = okResult<boolean>(r1[0]) === true;
  const extra: Array<{ market: number; source: Address }> = [];
  input.markets.forEach((m, i) => {
    const config = okResult<readonly [readonly Address[], number, number, number]>(r1[1 + i]);
    for (const source of config?.[0]?.slice(1) ?? []) extra.push({ market: i, source });
  });
  const r2 = extra.length === 0 ? [] : await readMany(client, extra.map((e): AnyRead => ({ address: e.source, abi: priceSourceAbi, functionName: 'latest', args: [input.markets[e.market]!.underlying as Address] })), input.blockNumber);
  const observed = input.markets.map((m): { at: number | null; from: SpotClock['from'] } => ({ at: m.spot === null ? null : m.updatedAt, from: m.spot === null || m.updatedAt === null ? null : 'oracle-print' }));
  extra.forEach((e, j) => {
    const m = input.markets[e.market]!;
    const o = observed[e.market]!;
    const got = okResult<readonly [boolean, bigint, bigint]>(r2[j]);
    if (m.spot === null || m.spot <= 0n || input.toleranceBps <= 0 || got === undefined || !got[0] || got[1] <= 0n) return;
    const gap = got[1] > m.spot ? got[1] - m.spot : m.spot - got[1];
    if ((gap * 10_000n) / m.spot > BigInt(input.toleranceBps)) return;
    const at = Number(got[2]);
    if (o.at === null || at > o.at) {
      o.at = at;
      o.from = e.source;
    }
  });
  const times = observed.map((o) => o.at);
  const r3 = await readMany(
    client,
    times.flatMap((t): AnyRead[] => (t === null ? [] : [{ address: input.calendar, abi: expiryCalendarAbi, functionName: 'isRegularSession', args: [t] }])),
    input.blockNumber,
  );
  let k = 0;
  const clocks = new Map<string, SpotClock>();
  input.markets.forEach((m, i) => {
    const o = observed[i]!;
    let inSession: boolean | null = null;
    if (o.at !== null) inSession = okResult<boolean>(r3[k++]) ?? null;
    clocks.set(lc(m.underlying), { observedAt: o.at, observedInSession: inSession, from: o.from });
  });
  return { sessionOpenAtGrace, clocks };
}

/*//////////////////////////////////////////////////////////////
                              SERIES
//////////////////////////////////////////////////////////////*/

interface SeriesStruct {
  underlying: Address;
  oracle: Address;
  exerciseFeeBps?: number;
  settled: boolean;
  settlementPrice: bigint;
  isPut: boolean;
  strike: bigint;
  expiry: number;
  /** INTERFACE_VERSION 7: the rent rate pinned at creation; absent on a v6 series read. */
  mintFeePpm?: number;
  /** USDG-or-underlying paid per long unit on redeem once settled (0 for an out-of-the-money long). */
  longPayoutPerUnit?: bigint;
}

/**
 * SettlementOracle.marketConfig(u)'s maxDeviationBps (element 1; the contract fills its default in, so a configured
 * market never answers 0), or null when the read failed or the value is not a band in (0, 10 000) bps. Null means
 * "unread": the spot-lag floor then prices an old print at MM_SPOT_LAG_STALE_BPS alone.
 */
export function bandOf(config: readonly [readonly Address[], number, number, number] | undefined): number | null {
  const bps = config === undefined ? undefined : Number(config[1]);
  return bps !== undefined && Number.isInteger(bps) && bps > 0 && bps < 10_000 ? bps : null;
}

/** `askFloorOf(7,true): reverted` for a failed guard read, or null when it answered. */
function guardFailure(call: string, o: ReadOutcome<unknown> | undefined): string | null {
  if (o !== undefined && o.ok) return null;
  return `${call}: ${o === undefined ? 'no result' : describeError(o.error)}`;
}

/**
 * Everything planner.SeriesView needs per series, plus the settlement for the ledger.
 *
 * THE ASK FLOOR IS READ PER ASK KIND, WITH askFloorOf, ON EVERY VAULT. The keeper read `askFloor(uint256)`,
 * which only MakerVault has: on a HouseVault that selector reverts, so every House series came back with a null floor
 * and halted `guards-unreadable` every tick, silently (measured 10 of 10 on both House vaults, 0 txs). Both
 * vault kinds have `askFloorOf(longId, primary)` with the same selector, so one read path serves both, and it also ends
 * the single-floor bug: a resale's floor is grossed by resaleFeeBps and a write's by premiumFeeBps, so an AskResale
 * checked against the write floor could rest under its own (and revert BadPrice) whenever the rates differ.
 */
export async function readSeriesViews(
  client: MulticallClient,
  a: MmAddresses,
  input: { series: ReadonlyArray<{ info: SeriesInfo; ticker: string; orders: readonly LiveOrder[] }>; blockNumber: bigint },
): Promise<SeriesView[]> {
  const PER = 8;
  const calls: AnyRead[] = [];
  for (const { info } of input.series) {
    calls.push({ address: a.clearinghouse, abi: clearinghouseAbi, functionName: 'series', args: [info.longId] });
    calls.push({ address: a.vault, abi: makerVaultAbi, functionName: 'exposure', args: [info.longId] });
    calls.push({ address: a.vault, abi: makerVaultAbi, functionName: 'askFloorOf', args: [info.longId, true] });
    calls.push({ address: a.vault, abi: makerVaultAbi, functionName: 'askFloorOf', args: [info.longId, false] });
    calls.push({ address: a.vault, abi: makerVaultAbi, functionName: 'bidCap', args: [info.longId] });
    calls.push({ address: a.vault, abi: makerVaultAbi, functionName: 'seriesNotional', args: [info.longId] });
    calls.push({ address: a.clearinghouse, abi: clearinghouseAbi, functionName: 'collateralAsset', args: [info.longId] });
    calls.push({ address: a.clearinghouse, abi: clearinghouseAbi, functionName: 'collateralPerUnit', args: [info.longId] });
  }
  const r = await readMany(client, calls, input.blockNumber);
  const structs = input.series.map((_, i) => okResult<SeriesStruct>(r[i * PER]));

  // One trySpot and one marketConfig per (oracle, underlying): a series quotes against the oracle it pinned at creation.
  // marketConfig's maxDeviationBps is the band trySpot accepts an old print within: CONFIG_ADMIN sets it per
  // market (SettlementOracle.setMarket), so the spot-lag floor reads it here every tick instead of trusting the env.
  const spotKeys = [...new Set(structs.filter((s): s is SeriesStruct => s !== undefined).map((s) => `${lc(s.oracle)}|${lc(s.underlying)}`))];
  const spotResults = await readMany(
    client,
    spotKeys.flatMap((k): AnyRead[] => {
      const [oracle, underlying] = k.split('|') as [Address, Address];
      return [
        { address: oracle, abi: settlementOracleAbi, functionName: 'trySpot', args: [underlying] },
        { address: oracle, abi: settlementOracleAbi, functionName: 'marketConfig', args: [underlying] },
      ];
    }),
    input.blockNumber,
  );
  const spots = new Map(spotKeys.map((k, i) => [k, okResult<readonly [boolean, bigint, bigint]>(spotResults[i * 2])]));
  const bands = new Map(spotKeys.map((k, i) => [k, bandOf(okResult<readonly [readonly Address[], number, number, number]>(spotResults[i * 2 + 1]))]));

  return input.series.map(({ info, ticker, orders }, i) => {
    const s = structs[i];
    const exposure = okResult<readonly [bigint, bigint, ExposureDetail]>(r[i * PER + 1]);
    const writeFloor = okResult<bigint>(r[i * PER + 2]);
    const resaleFloor = okResult<bigint>(r[i * PER + 3]);
    const notional = okResult<bigint>(r[i * PER + 5]);
    const id = info.longId.toString();
    const guardFailures = [
      guardFailure(`exposure(${id})`, r[i * PER + 1]),
      guardFailure(`askFloorOf(${id},true)`, r[i * PER + 2]),
      guardFailure(`askFloorOf(${id},false)`, r[i * PER + 3]),
      guardFailure(`bidCap(${id})`, r[i * PER + 4]),
    ].filter((f): f is string => f !== null);
    const key = s === undefined ? undefined : `${lc(s.oracle)}|${lc(s.underlying)}`;
    const spot = key === undefined ? undefined : spots.get(key);
    const fresh = spot !== undefined && spot[0] && spot[1] > 0n;
    return {
      info,
      ticker,
      settled: s?.settled ?? false,
      spotFresh: fresh,
      spot: fresh ? spot[1] : null,
      // trySpot(ok, price, updatedAt): the print's time, which sizes the spot-lag band (mm/spot-lag.ts).
      spotUpdatedAt: fresh ? Number(spot[2]) : null,
      oracleBandBps: key === undefined ? null : (bands.get(key) ?? null),
      exposure:
        exposure === undefined
          ? null
          : { longs: exposure[2].longs, shorts: exposure[2].shorts, bids: exposure[2].bids, resale: exposure[2].resale, writes: exposure[2].writes, live: exposure[2].live },
      // 0n keeps the vault-wide cap conservative (its `others` is the stored total minus this, so 0 subtracts
      // nothing), but the per-expiry sum would count an unread series as empty: flagged, and the planner gives the whole
      // expiry no room while it is unread (risk.planSizes expiryNotionalUnread).
      seriesNotional: notional ?? 0n,
      ...(notional === undefined ? { seriesNotionalUnread: true } : {}),
      // One pair or none: a floor for one ask kind and not the other is not a floor the planner may price against.
      askFloors: writeFloor === undefined || resaleFloor === undefined ? null : { write: writeFloor, resale: resaleFloor },
      bidCap: okResult<bigint>(r[i * PER + 4]) ?? null,
      guardFailures,
      collateralAsset: lc(okResult<Address>(r[i * PER + 6]) ?? '0x0000000000000000000000000000000000000000'),
      collateralPerUnit: okResult<bigint>(r[i * PER + 7]) ?? 0n,
      // The series' own pinned rate, not the market's: anyone may have created the series at an earlier rate.
      mintFeePpm: Number(s?.mintFeePpm ?? 0),
      orders,
    };
  });
}

/** Clearinghouse.series settlement fields, by long id (a failed read is absent). */
export async function readSettlements(client: MulticallClient, clearinghouse: Address, longIds: readonly bigint[], blockNumber: bigint): Promise<Map<string, { settled: boolean; settlementPrice: bigint; isPut: boolean; strike: bigint; exerciseFeeBps: number }>> {
  const r = await readMany(client, longIds.map((id) => ({ address: clearinghouse, abi: clearinghouseAbi, functionName: 'series', args: [id] })), blockNumber);
  const out = new Map<string, { settled: boolean; settlementPrice: bigint; isPut: boolean; strike: bigint; exerciseFeeBps: number }>();
  longIds.forEach((id, i) => {
    const s = okResult<SeriesStruct>(r[i]);
    if (s !== undefined) out.set(id.toString(), { settled: s.settled, settlementPrice: s.settlementPrice, isPut: s.isPut, strike: s.strike, exerciseFeeBps: Number(s.exerciseFeeBps ?? 0) });
  });
  return out;
}

/**
 * (N3). Which settled Clearinghouse tokens the vault still holds, for the MakerVault's own `redeem(tokenId)`.
 *
 * WHY THE VAULT REDEEMS ITS OWN. Opts the MakerVault out of third-party redemption, and from then on the
 * cranker's `Clearinghouse.redeemBatch` skips it SILENTLY (Clearinghouse.redeemBatch: `!_mayRedeem(holder, msg.sender)`
 * is a `continue`, not a revert). Nobody else will redeem these tokens, so the MM plans `MakerVault.redeem` itself.
 *
 * One multicall at `blockNumber`: per long id, `series(longId)`, `balanceOf(vault, longId)` and
 * `balanceOf(vault, shortId)`. `held` lists every settled token id with a non-zero balance. `empty` lists the settled
 * long ids with neither balance, which the caller may stop asking about. A series that is not settled, or whose reads
 * failed, is in neither list: it is asked again next tick, and nothing is planned from a read that did not answer.
 */
export async function readSettledHoldings(
  client: MulticallClient,
  a: Pick<MmAddresses, 'clearinghouse' | 'vault'>,
  longIds: readonly bigint[],
  blockNumber: bigint,
): Promise<{ held: Array<{ tokenId: bigint; longId: bigint; units: bigint }>; empty: bigint[]; waiting: Array<{ tokenId: bigint; longId: bigint; units: bigint; reason: string }> }> {
  const PER = 3;
  const calls: AnyRead[] = [];
  for (const id of longIds) {
    calls.push({ address: a.clearinghouse, abi: clearinghouseAbi, functionName: 'series', args: [id] });
    calls.push({ address: a.clearinghouse, abi: clearinghouseAbi, functionName: 'balanceOf', args: [a.vault, id] });
    calls.push({ address: a.clearinghouse, abi: clearinghouseAbi, functionName: 'balanceOf', args: [a.vault, shortIdOf(id)] });
  }
  const r = calls.length === 0 ? [] : await readMany(client, calls, blockNumber);
  const held: Array<{ tokenId: bigint; longId: bigint; units: bigint }> = [];
  const empty: bigint[] = [];
  /*
   * MakerVault.redeem runs `_spot(series)` after the Clearinghouse paid a CALL LONG in USDG,
   * and reverts on a stale or missing spot (the oracle's revert, or NoSource on 0). The Clearinghouse converts a call
   * long's payout when it pays anything (`longPayoutPerUnit > 0`), the vault's `payoutPrefs.inKind` is false and a
   * `payoutAdapter` is set (Clearinghouse._redeem; the vault is the holder, so the settlement price is its floor with no
   * spot). Such a redemption is held until the series' own oracle answers `spot(underlying)` non-zero -- the rule
   * cranker/steps.ts houseRoll mirrors for HouseVault._redeemSettled. Puts, shorts and out-of-the-money calls
   * never ask the spot. Held tokens are neither redeemed nor recorded empty, so the next tick asks again.
   */
  const calls2: Array<{ index: number; oracle: Address; underlying: Address }> = [];
  longIds.forEach((longId, i) => {
    const s = okResult<SeriesStruct>(r[i * PER]);
    const longs = okResult<bigint>(r[i * PER + 1]);
    const shorts = okResult<bigint>(r[i * PER + 2]);
    if (s === undefined || !s.settled || longs === undefined || shorts === undefined) return;
    if (longs > 0n) {
      // An absent payout (an older struct) is read as paying: the side on which the redemption waits.
      if (!s.isPut && (s.longPayoutPerUnit ?? 1n) > 0n) calls2.push({ index: held.length, oracle: s.oracle, underlying: s.underlying });
      held.push({ tokenId: longId, longId, units: longs });
    }
    if (shorts > 0n) held.push({ tokenId: shortIdOf(longId), longId, units: shorts });
    if (longs === 0n && shorts === 0n) empty.push(longId);
  });
  if (calls2.length === 0) return { held, empty, waiting: [] };

  // A struct with no oracle or underlying cannot be asked for a spot: that redemption waits (the key never reads fresh).
  const keyOf = (c: { oracle?: Address; underlying?: Address }) => (c.oracle === undefined || c.underlying === undefined ? null : `${lc(c.oracle)}|${lc(c.underlying)}`);
  const spotKeys = [...new Set(calls2.map(keyOf).filter((k): k is string => k !== null))];
  const r2 = await readMany(
    client,
    [
      { address: a.clearinghouse, abi: clearinghouseAbi, functionName: 'payoutPrefs', args: [a.vault] },
      { address: a.clearinghouse, abi: clearinghouseAbi, functionName: 'payoutAdapter' },
      ...spotKeys.map((k): AnyRead => {
        const [oracle, underlying] = k.split('|') as [Address, Address];
        return { address: oracle, abi: settlementOracleAbi, functionName: 'spot', args: [underlying] };
      }),
    ],
    blockNumber,
  );
  const prefs = okResult<readonly [boolean, boolean]>(r2[0]);
  const adapter = okResult<Address>(r2[1]);
  // A failed prefs or adapter read counts as converting: the redemption waits rather than sending into the revert.
  const converts = prefs === undefined || adapter === undefined ? true : prefs[0] === false && lc(adapter) !== lc(zeroAddress);
  if (!converts) return { held, empty, waiting: [] };
  const fresh = new Map(spotKeys.map((k, i) => {
    const spot = okResult<readonly [bigint, bigint]>(r2[2 + i]);
    return [k, spot !== undefined && spot[0] > 0n] as const;
  }));
  const hold = new Set(calls2.filter((c) => { const k = keyOf(c); return k === null || fresh.get(k) !== true; }).map((c) => c.index));
  const waiting = held
    .filter((_, i) => hold.has(i))
    .map((h) => ({ ...h, reason: `settled call long ${h.tokenId} pays in USDG and MakerVault.redeem then needs a fresh spot (_spot): the series oracle has none, so it waits for the next print` }));
  return { held: held.filter((_, i) => !hold.has(i)), empty, waiting };
}

/**
 * MakerVault.exposure notional of each tracked series (measured now), by long id; null when unreadable. `held` is
 * whether the exposure detail shows anything held (a long, a short or a live order); null when unreadable.
 * HouseVault.exposure has the same shape and, a live notional too. A House series leaves
 * `_tracked` only when a re-measure finds nothing held (HouseVault._record), so a flat series whose stored notional is
 * already 0 needs a sync as much as one that stores more than it measures.
 */
export async function readMeasuredNotional(client: MulticallClient, vault: Address, longIds: readonly bigint[], blockNumber: bigint): Promise<Array<{ longId: bigint; stored: bigint; measured: bigint | null; held: boolean | null }>> {
  const calls: AnyRead[] = [];
  for (const id of longIds) {
    calls.push({ address: vault, abi: makerVaultAbi, functionName: 'seriesNotional', args: [id] });
    calls.push({ address: vault, abi: makerVaultAbi, functionName: 'exposure', args: [id] });
  }
  const r = await readMany(client, calls, blockNumber);
  return longIds.map((longId, i) => {
    const exposure = okResult<readonly [bigint, bigint, { longs: bigint; shorts: bigint; live: bigint }]>(r[i * 2 + 1]);
    const d = exposure?.[2];
    const held = d === undefined ? null : d.longs !== 0n || d.shorts !== 0n || d.live !== 0n;
    return { longId, stored: okResult<bigint>(r[i * 2]) ?? 0n, measured: exposure === undefined ? null : exposure[1], held };
  });
}

/*//////////////////////////////////////////////////////////////
                              ORDERS
//////////////////////////////////////////////////////////////*/

export interface ChainOrder {
  id: bigint;
  maker: Address;
  longId: bigint;
  kind: (typeof ORDER_KIND)[number];
  price: bigint;
  units: bigint;
  filled: bigint;
  validUntil: number;
  cancelled: boolean;
}

const PAGE = 200n;

/** Order ids of `maker` from index `from` to `to` (exclusive), paged. */
export async function readMakerOrderIds(client: Pick<import('viem').PublicClient, 'readContract'>, orderBook: Address, maker: Address, from: bigint, to: bigint, blockNumber: bigint): Promise<bigint[]> {
  const out: bigint[] = [];
  let cursor = from;
  while (cursor < to) {
    const limit = to - cursor < PAGE ? to - cursor : PAGE;
    const [ids] = (await client.readContract({ address: orderBook, abi: orderBookAbi, functionName: 'ordersOfMaker', args: [maker, cursor, limit], blockNumber })) as readonly [readonly bigint[], bigint];
    if (ids.length === 0) break;
    out.push(...ids);
    cursor += BigInt(ids.length);
  }
  return out;
}

const ORDER_FILLED = getAbiItem({ abi: orderBookAbi, name: 'OrderFilled' }) as AbiEvent;
const MIN_LOG_CHUNK = 100n;

/**
 * OrderBook.OrderFilled logs of `orderIds` (the indexed orderId topic) in [fromBlock, toBlock], read BACKWARDS from
 * `toBlock` in ranges of `chunkBlocks` (halved on a refused range, down to 100 blocks), at most `maxChunks` ranges: the
 * newest fills first, which are the ones a tick has just seen. `coveredFrom` is the lowest block read; above
 * `fromBlock` when the ranges ran out. Throws when even a minimal range is refused. The log client is pinned to
 * RH_RPC (chain.ts): a fallback that refuses archive ranges would read as "no fills".
 */
export async function readOrderFillLogs(
  client: Pick<import('viem').PublicClient, 'getLogs'>,
  input: { orderBook: Address; orderIds: readonly bigint[]; fromBlock: bigint; toBlock: bigint; chunkBlocks: number; maxChunks: number },
): Promise<{ logs: FillLog[]; coveredFrom: bigint }> {
  const logs: FillLog[] = [];
  let to = input.toBlock;
  let chunk = BigInt(input.chunkBlocks);
  let ranges = 0;
  let coveredFrom = input.toBlock + 1n;
  while (to >= input.fromBlock && ranges < input.maxChunks && input.orderIds.length > 0) {
    const from = to - chunk + 1n < input.fromBlock ? input.fromBlock : to - chunk + 1n;
    let page: Array<{ args?: Record<string, unknown>; blockNumber: bigint | null; logIndex: number | null }>;
    try {
      page = (await client.getLogs({ address: input.orderBook, event: ORDER_FILLED, args: { orderId: [...input.orderIds] }, fromBlock: from, toBlock: to } as never)) as unknown as typeof page;
    } catch (error) {
      if (chunk > MIN_LOG_CHUNK) {
        chunk = chunk / 2n < MIN_LOG_CHUNK ? MIN_LOG_CHUNK : chunk / 2n;
        continue;
      }
      throw error;
    }
    for (const l of page) {
      const a = l.args ?? {};
      if (typeof a.orderId !== 'bigint' || typeof a.units !== 'bigint' || typeof a.premium !== 'bigint' || typeof a.sellerFee !== 'bigint' || typeof a.maker !== 'string' || l.blockNumber === null || l.logIndex === null) continue;
      logs.push({ orderId: a.orderId, maker: a.maker, units: a.units, premium: a.premium, sellerFee: a.sellerFee, blockNumber: l.blockNumber, logIndex: l.logIndex });
    }
    coveredFrom = from;
    ranges += 1;
    to = from - 1n;
  }
  return { logs, coveredFrom };
}

/**
 * (MM_ASK_FALLBACK_ONLY). The live asks OTHER makers rest on each managed series, so the planner can hold
 * the vault's own ask back while someone else is offering. `OrderBook.ordersOfSeries` (OrderBook.sol:554) pages an
 * APPEND-ONLY id list that includes dead orders, so the read is bounded from the TAIL: `seriesOrderCount` first, then
 * the last `tail` ids of each series in one multicall, then one `getOrders` batch over all of them. An ask is counted
 * when it is live at `now` (maker set, not cancelled, unfilled units, validUntil in the future or 0), an AskWrite or
 * AskResale, and its maker is not `vault`. Protocol accounts (the HouseVault's covered-call ask) are NOT filtered
 * here: the planner counts them as other askers by design (fallback-only asks).
 *
 * WHY THE TAIL IS ENOUGH: an ask older than `tail` placements on one series would have to sit under `tail` newer
 * orders without expiring; at the launch cadence (the bot re-places every session, the book expires at the close) the
 * tail of 64 is the whole live set. A count above the tail is reported in `truncated` so /state can say the read was
 * partial rather than the book empty.
 *
 * WHAT BACKS AN ASK. An AskResale's longs are escrowed at placement (OrderBook._place -> _escrowLongs), so a
 * live one can fill. An AskWrite escrows NOTHING: it mints from the maker's FREE collateral at fill time, and the book
 * skips it when that is short. So each AskWrite also carries `makerFree`, the maker's Clearinghouse.free balance of the
 * series' collateral asset, read at the same block. The planner turns that into fillable units with the same rent rule
 * the indexer uses (planner.fillableUnits; indexer/lib/v2/book.ts aggregateBook). This is the only extra read, and only
 * for series that carry a third-party AskWrite.
 */
export interface OtherAsk {
  id: bigint;
  maker: string;
  kind: 'AskWrite' | 'AskResale';
  price: bigint;
  remaining: bigint;
  /**
   * AskWrite only: the maker's free balance of the series' collateral asset. null = the read failed (the
   * collateral asset or the balance), which the planner treats as an ask that cannot fill. Absent on an AskResale.
   */
  makerFree?: bigint | null;
}
export interface OtherAskers {
  /** By decimal longId: live asks from makers other than the vault. Every managed series has an entry. */
  asks: ReadonlyMap<string, OtherAsk[]>;
  /**
   * Series whose id list was longer than the tail read (their oldest orders were not inspected), and series
   * whose order count or id page could not be read (none of their orders inspected): an unread series is partial, never
   * "no other asker".
   */
  truncated: readonly string[];
}

export async function readOtherAskers(
  client: MulticallClient & Pick<import('viem').PublicClient, 'readContract'>,
  a: Pick<MmAddresses, 'orderBook' | 'vault' | 'clearinghouse'>,
  longIds: readonly bigint[],
  now: number,
  blockNumber: bigint,
  tail = 64n,
): Promise<OtherAskers> {
  const asks = new Map<string, OtherAsk[]>(longIds.map((id) => [id.toString(), []]));
  const truncated: string[] = [];
  if (longIds.length === 0) return { asks, truncated };
  const counts = await readMany(client, longIds.map((longId) => ({ address: a.orderBook, abi: orderBookAbi, functionName: 'seriesOrderCount', args: [longId] })), blockNumber);
  const pages: AnyRead[] = [];
  const pageOf: bigint[] = [];
  longIds.forEach((longId, i) => {
    const count = okResult<bigint>(counts[i]);
    if (count === undefined) {
      truncated.push(longId.toString());
      return;
    }
    if (count === 0n) return;
    if (count > tail) truncated.push(longId.toString());
    const cursor = count > tail ? count - tail : 0n;
    pages.push({ address: a.orderBook, abi: orderBookAbi, functionName: 'ordersOfSeries', args: [longId, cursor, tail] });
    pageOf.push(longId);
  });
  if (pages.length === 0) return { asks, truncated };
  const idPages = await readMany(client, pages, blockNumber);
  const ids: bigint[] = [];
  idPages.forEach((r, k) => {
    const page = okResult<readonly [readonly bigint[], bigint]>(r);
    if (page !== undefined) ids.push(...page[0]);
    else if (!truncated.includes(pageOf[k]!.toString())) truncated.push(pageOf[k]!.toString());
  });
  const orders = await readOrders(client, a.orderBook, ids, blockNumber);
  const self = lc(a.vault);
  for (const o of orders) {
    if (o.maker === zeroAddress || o.cancelled || o.filled >= o.units) continue;
    if (o.validUntil !== 0 && o.validUntil <= now) continue;
    if (o.kind !== 'AskWrite' && o.kind !== 'AskResale') continue;
    if (lc(o.maker) === self) continue;
    const list = asks.get(o.longId.toString());
    if (list === undefined) continue;
    list.push({ id: o.id, maker: lc(o.maker), kind: o.kind, price: o.price, remaining: o.units - o.filled });
  }
  await attachMakerFree(client, a.clearinghouse, asks, blockNumber);
  return { asks, truncated };
}

/**
 * Set `makerFree` on every AskWrite in `asks` (in place). One multicall for the collateral asset of each series
 * that carries an AskWrite (Clearinghouse.collateralAsset), one for the free balance of each distinct (maker, asset).
 * A failed read leaves `makerFree` null, never 0n: 0 would be a measured empty balance, and null says "unknown".
 */
async function attachMakerFree(client: MulticallClient, clearinghouse: Address, asks: ReadonlyMap<string, OtherAsk[]>, blockNumber: bigint): Promise<void> {
  const writeSeries = [...asks.entries()].filter(([, list]) => list.some((o) => o.kind === 'AskWrite')).map(([id]) => id);
  if (writeSeries.length === 0) return;
  const assetReads = await readMany(client, writeSeries.map((id) => ({ address: clearinghouse, abi: clearinghouseAbi, functionName: 'collateralAsset', args: [BigInt(id)] })), blockNumber);
  const assetOf = new Map<string, string | null>();
  writeSeries.forEach((id, i) => {
    const asset = okResult<Address>(assetReads[i]);
    assetOf.set(id, asset === undefined || asset === zeroAddress ? null : lc(asset));
  });
  const pairKey = (maker: string, asset: string) => `${maker}:${asset}`;
  const pairs = new Map<string, { maker: string; asset: string }>();
  for (const id of writeSeries) {
    const asset = assetOf.get(id) ?? null;
    if (asset === null) continue;
    for (const o of asks.get(id) ?? []) if (o.kind === 'AskWrite') pairs.set(pairKey(o.maker, asset), { maker: o.maker, asset });
  }
  const pairList = [...pairs.values()];
  const freeReads = pairList.length === 0 ? [] : await readMany(client, pairList.map((p) => ({ address: clearinghouse, abi: clearinghouseAbi, functionName: 'free', args: [p.maker as Address, p.asset as Address] })), blockNumber);
  const freeOf = new Map<string, bigint | null>(pairList.map((p, i) => [pairKey(p.maker, p.asset), okResult<bigint>(freeReads[i]) ?? null]));
  for (const id of writeSeries) {
    const asset = assetOf.get(id) ?? null;
    for (const o of asks.get(id) ?? []) {
      if (o.kind !== 'AskWrite') continue;
      o.makerFree = asset === null ? null : freeOf.get(pairKey(o.maker, asset)) ?? null;
    }
  }
}

/** OrderBook.getOrders in pages, one outcome per id (an unknown id is maker zero). */
export async function readOrders(client: Pick<import('viem').PublicClient, 'readContract'>, orderBook: Address, ids: readonly bigint[], blockNumber: bigint): Promise<ChainOrder[]> {
  const out: ChainOrder[] = [];
  for (let i = 0; i < ids.length; i += Number(PAGE)) {
    const page = ids.slice(i, i + Number(PAGE));
    const orders = (await client.readContract({ address: orderBook, abi: orderBookAbi, functionName: 'getOrders', args: [page], blockNumber })) as ReadonlyArray<{
      maker: Address;
      longId: bigint;
      kind: number;
      price: bigint;
      units: bigint;
      filled: bigint;
      validUntil: number;
      cancelled: boolean;
    }>;
    orders.forEach((o, j) => {
      out.push({ id: page[j]!, maker: o.maker, longId: o.longId, kind: ORDER_KIND[o.kind] ?? 'Bid', price: BigInt(o.price), units: BigInt(o.units), filled: BigInt(o.filled), validUntil: Number(o.validUntil), cancelled: o.cancelled });
    });
  }
  return out;
}
