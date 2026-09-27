/**
 * The MM bot's REAL tick and kill (quoter.ts), driven against a fake chain, so the guards they carry are
 * reached. quoter.test.ts replaces `tick` wholesale where it needs a tick, which is why deleting any of these guards
 * stayed green there:
 *   - trackOrders files every fill into the vault's markout book (`book.record`), which /state's markouts read;
 *   - planVault (tickOne before) applies the market-safety halt (`this.marketSafety(...)`), the only caller of the spot-move breaker;
 *   - a body-less kill cancels every House vault discovery found, including one it does not quote;
 *   - a refused MM_VAULTS entry (a House vault) has its resting orders cancelled by the tick
 *     and by a kill: it is quoted by neither path, so before this nothing cancelled them through its epochEnd.
 *
 * WHAT IS FAKED, AND WHY. Only the process boundaries:
 *   - the chain: {FakeChain} implements the four PublicClient methods the bot calls (`getBlock`, `getBlockNumber`,
 *     `readContract`, `multicall`, and `getLogs` on the log client) over an in-memory book, answering each view by
 *     function name the way the contract does. A view it does not model FAILS in the multicall (as a reverting view
 *     does on chain), so a reader that treats a failure as fatal throws and the test says which one;
 *   - the sender: records each vault call and applies a `cancel` to the fake book (a tx needs a signer and a node);
 *   - the pricing service: `fairMany` answers an ok fair at the oracle's spot (it is an HTTP service);
 *   - the alerter: records the kinds it was asked to page (it is an HTTP relay).
 * Everything between those boundaries is the production code: config.ts parsing the real env, V2Store/MmStore on
 * SQLite, the series scan, readVaultState/readMarkets/readSeriesViews, fills.ts, the engine, the planner, the breaker,
 * House discovery through `HouseVaultFactory.vaults()` and the `epochEnd()` probe (answersEpochEnd).
 *
 * Each guard's test was proven by deleting the guarded line and watching the named test go red.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ContractFunctionRevertedError, getAddress, type Address } from 'viem';
import { loadV2Config, type MmConfig } from '../config.js';
import { createV2Logger, silentLogger, type Logger } from '../logger.js';
import { holidayHorizon } from '../../calendar.js';
import { V2Store } from '../store.js';
import type { TxOutcome } from '../tx.js';
import { KIND_INDEX, type OrderKindName } from './constants.js';
import type { FairInput } from './engine.js';
import { MmBot, quotedMarkets, siblingAskers, siblingRanks } from './quoter.js';

const REGISTRY = fileURLToPath(new URL('../fixtures/registry-v2.json', import.meta.url));
/** P7 (spot age) and P8 (open grace) off, explicitly: they add the spot-clock reads, which no test here is about. */
const ENV = {
  V2_MODE: 'mm',
  RH_RPC: 'http://127.0.0.1:9',
  MM_QUOTER_PK: `0x${'11'.repeat(32)}`,
  PRICING_URL: 'http://127.0.0.1:8790',
  MM_KILL_TOKEN: 'k'.repeat(32),
  V2_REGISTRY_PATH: REGISTRY,
  MM_MARKETS: 'NVDA',
  MM_MAX_SPOT_AGE_S: '0',
  MM_OPEN_GRACE_S: '0',
};

/** Wednesday 2026-09-23 15:00 UTC: 11:00 New York, inside a regular session. */
const T = Date.UTC(2026, 8, 23, 15, 0, 0) / 1000;
/** Friday 2026-09-25 20:00 UTC: the series' expiry, far from its pull window at T. */
const EXPIRY = Date.UTC(2026, 8, 25, 20, 0, 0) / 1000;
const SPOT = 180_000_000n; // USDG base units per share
const LONG_ID = 7n;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const HOUSE = getAddress('0x00000000000000000000000000000000000a0001');
const REFUSED = getAddress('0x00000000000000000000000000000000000a0002');
const FACTORY = getAddress('0x00000000000000000000000000000000000fac01');
const hash = (b: string) => `0x${b.repeat(32)}` as const;

interface BookOrder {
  maker: Address;
  longId: bigint;
  kind: number;
  price: bigint;
  units: bigint;
  filled: bigint;
  validUntil: number;
  cancelled: boolean;
}

type Call = { address: Address; functionName: string; args?: readonly unknown[] };

class FakeChain {
  readonly config: MmConfig;
  readonly underlying: Address;
  readonly oracle: Address;
  readonly orders = new Map<bigint, BookOrder>();
  /** Lower-case vaults that answer `HouseVault.epochEnd()`: House vaults. Every other address reverts it. */
  readonly house = new Set<string>();
  /** `HouseVaultFactory.vaults()` per lower-case factory. */
  readonly factories = new Map<string, Address[]>();
  /** Every vault call the sender was handed, in order. */
  readonly sent: Array<{ vault: Address; functionName: string; args: readonly unknown[] }> = [];
  /** The chain time each `sent` entry was handed at, parallel to `sent`. */
  readonly sentAt: number[] = [];
  /** Chain seconds each send takes (a slow or rate-limited RPC); 0 = instant. */
  sendDelayS = 0;
  /**
   * The sender also applies `place` (a new order, next id) and `replace` to the book, and
   * `seriesOrderCount` / `ordersOfSeries` answer from it, so each vault's other-asker read (reads.readOtherAskers)
   * sees what the other vaults rest. Off by default: the tests above count sends against a book that only cancels.
   */
  liveBook = false;
  private nextOrderId = 1_000n;
  readonly alerts: string[] = [];
  /** Every page with the severity and dedupe key it was raised at, and every clear, in order. */
  readonly pages: Array<{ kind: string; message: string; severity?: string; dedupeKey?: string } | { cleared: string; dedupeKey?: string }> = [];
  /** Views that revert, as `functionName` (every address) or `functionName@lower-case address`. */
  readonly failing = new Set<string>();
  /**
   * A view answered with this value instead of the default below, by `functionName`. The defaults quote
   * nothing (bidCap 0, and `free` too small to write one unit); a test that needs the bot to place overrides them.
   */
  readonly overrides = new Map<string, unknown>();
  /**
   * Every listed series (one SeriesCreated log each; `series(longId)` and `collateralAsset(longId)` answer
   * from it). One NVDA series unless a test lists more.
   */
  readonly listed: Array<{ longId: bigint; underlying: Address }>;
  /** `HouseVault.underlying()` per lower-case House vault; a House vault not named here trades `underlying`. */
  readonly houseUnderlying = new Map<string, Address>();
  now = T;
  block = 65_101_000n;
  spot = SPOT;
  readonly deployBlock: bigint;

  constructor(env: Record<string, string> = {}) {
    this.config = loadV2Config({ ...ENV, ...env }) as MmConfig;
    this.underlying = getAddress(quotedMarkets(this.config)[0]!.underlying);
    this.listed = [{ longId: LONG_ID, underlying: this.underlying }];
    const oracle = this.config.contracts.settlementOracle;
    if (oracle === null) throw new Error('the fixture registry has no settlementOracle');
    this.oracle = oracle;
    this.deployBlock = this.config.registry.deployBlock ?? 0n;
  }

  /** The underlying of a listed series (the first market's when the id is not listed). */
  underlyingOf(longId: unknown): Address {
    return this.listed.find((l) => l.longId === longId)?.underlying ?? this.underlying;
  }

  /** The next tick is `s` seconds and a few blocks later. */
  advance(s: number): void {
    this.now += s;
    this.block += BigInt(Math.max(1, Math.floor(s / 2)));
  }

  add(id: bigint, kind: OrderKindName, over: Partial<BookOrder> = {}): void {
    this.orders.set(id, { maker: this.config.contracts.makerVault, longId: LONG_ID, kind: KIND_INDEX[kind], price: 5_000_000n, units: 100n, filled: 0n, validUntil: T + 3_600, cancelled: false, ...over });
  }

  private ofMaker(maker: unknown): bigint[] {
    return [...this.orders].filter(([, o]) => o.maker.toLowerCase() === String(maker).toLowerCase()).map(([id]) => id);
  }

  /** One view, as the contract answers it. `undefined` = not modelled, which the multicall reports as a failure. */
  private view({ address, functionName, args = [] }: Call): unknown {
    const c = this.config.contracts;
    const lc = address.toLowerCase();
    if (this.failing.has(functionName) || this.failing.has(`${functionName}@${lc}`)) throw new ContractFunctionRevertedError({ abi: [], functionName });
    if (this.overrides.has(functionName)) return this.overrides.get(functionName);
    if (this.liveBook && (functionName === 'seriesOrderCount' || functionName === 'ordersOfSeries')) {
      const ids = [...this.orders].filter(([, o]) => o.longId === args[0]).map(([id]) => id);
      if (functionName === 'seriesOrderCount') return BigInt(ids.length);
      const [, from, limit] = args as [bigint, bigint, bigint];
      const page = ids.slice(Number(from), Number(from + limit));
      return [page, from + BigInt(page.length)];
    }
    switch (functionName) {
      // MakerVault / HouseVault
      case 'orderBook':
        return c.orderBook;
      case 'epochEnd':
        if (this.house.has(lc)) return BigInt(EXPIRY + 86_400);
        throw new ContractFunctionRevertedError({ abi: [], functionName: 'epochEnd' });
      // A House vault's own Stock Token (HouseVault.underlying, an immutable). MakerVault has no such getter.
      case 'underlying':
        if (!this.house.has(lc)) throw new ContractFunctionRevertedError({ abi: [], functionName: 'underlying' });
        return this.houseUnderlying.get(lc) ?? this.underlying;
      // HouseVault only: the epoch reads a kinded factory's vault is quoted with (house.ts chainEpochReader), and the
      // reserve views readVaultState reads on a House vault.
      case 'weekly':
      case 'epochId':
      case 'pendingDepositUsdg':
      case 'owedUsdg':
      case 'performanceFeeOwed':
      // The quoting brake (off) and the stock reserve (none).
      case 'quotingPaused':
      case 'pendingDepositStock':
      case 'owedStock':
        if (!this.house.has(lc)) throw new ContractFunctionRevertedError({ abi: [], functionName });
        return functionName === 'weekly' ? true : functionName === 'epochId' ? 1n : functionName === 'quotingPaused' ? false : 0n;
      case 'limits':
        return { maxSeriesUnits: 10_000n, maxTotalNotional: 10n ** 15n, askToleranceBps: 500, maxBidBpsOfSpot: 5_000, maxOrderLifetime: 7 * 86_400, maxDailyOutflow: 10n ** 15n };
      case 'totalNotional':
      case 'seriesNotional':
      case 'owed':
      case 'askFloorOf':
      case 'bidCap':
      case 'seriesOrderCount':
        return 0n;
      case 'askFloor':
        // MakerVault only (MakerVault.sol askFloor). HouseVault.sol has askFloorOf(uint256,bool) alone, so on a House
        // vault this selector reverts, as it does on chain.
        if (this.house.has(lc)) throw new ContractFunctionRevertedError({ abi: [], functionName: 'askFloor' });
        return 0n;
      case 'trackedSeries':
        return [];
      case 'outflow':
        return [0n, 10n ** 15n];
      case 'exposure':
        return [0n, 0n, { longs: 0n, shorts: 0n, bids: 0n, resale: 0n, writes: 0n, live: 0n }];
      // HouseVaultFactory
      case 'vaults':
        return this.factories.get(lc) ?? [];
      // AccessManager
      case 'canCall':
        return [true, 0];
      // OrderBook
      case 'pendingFeeParams':
        return [{ premiumFeeBps: 100, resaleFeeBps: 100 }, 0];
      case 'feeParams':
        return { premiumFeeBps: 100, resaleFeeBps: 100 };
      case 'tradingPaused':
        return false;
      case 'makerOrderCount':
        return BigInt(this.ofMaker(args[0]).length);
      case 'ordersOfMaker': {
        const [maker, from, limit] = args as [Address, bigint, bigint];
        const ids = this.ofMaker(maker).slice(Number(from), Number(from + limit));
        return [ids, from + BigInt(ids.length)];
      }
      case 'ordersOfSeries':
        return [[], 0n];
      case 'getOrders':
        return (args[0] as bigint[]).map((id) => this.orders.get(id) ?? { maker: ZERO, longId: 0n, kind: 0, price: 0n, units: 0n, filled: 0n, validUntil: 0, cancelled: false });
      // ERC-20 (USDG and the Stock Token)
      case 'balanceOf':
        return 10n ** 12n;
      // ExpiryCalendar
      case 'isRegularSession':
        return true;
      case 'closeOf':
        return BigInt(Date.UTC(2026, 8, 23, 20, 0, 0) / 1000);
      // Clearinghouse
      case 'usdg':
        return '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
      case 'calendar':
        return c.expiryCalendar;
      case 'free':
        return 10n ** 12n;
      case 'market':
        return { enabled: true, mintPaused: false, oracle: this.oracle };
      case 'series':
        return { underlying: this.underlyingOf(args[0]), oracle: this.oracle, exerciseFeeBps: 0, settled: false, settlementPrice: 0n, isPut: false, strike: 200_000_000n, expiry: EXPIRY, mintFeePpm: 80 };
      case 'collateralAsset':
        return this.underlyingOf(args[0]);
      case 'collateralPerUnit':
        return 10n ** 16n;
      // SettlementOracle
      case 'trySpot':
        return [true, this.spot, BigInt(this.now - 30)];
      default:
        return undefined;
    }
  }

  client() {
    return {
      getBlock: async (args: { blockNumber?: bigint } = {}) =>
        args.blockNumber !== undefined
          ? { number: args.blockNumber, hash: hash('d1'), timestamp: 0n }
          : { number: this.block, hash: hash('ee'), timestamp: BigInt(this.now) },
      getBlockNumber: async () => this.block,
      readContract: async (call: Call) => {
        const out = this.view(call);
        if (out === undefined) throw new Error(`the fake chain has no view ${call.functionName} on ${call.address}`);
        return out;
      },
      multicall: async ({ contracts }: { contracts: readonly Call[] }) =>
        contracts.map((call) => {
          try {
            const result = this.view(call);
            return result === undefined
              ? { status: 'failure' as const, error: new Error(`the fake chain has no view ${call.functionName}`) }
              : { status: 'success' as const, result };
          } catch (error) {
            return { status: 'failure' as const, error: error as Error };
          }
        }),
    };
  }

  /** The Clearinghouse SeriesCreated log of every listed series; no other log is modelled (a Bid fill needs none). */
  logClient() {
    const created = this.deployBlock + 10n;
    return {
      getBlockNumber: async () => this.block,
      getLogs: async (args: { event?: { name?: string }; fromBlock: bigint; toBlock: bigint }) =>
        args.event?.name === 'SeriesCreated' && args.fromBlock <= created && created <= args.toBlock
          ? this.listed.map((l) => ({ args: { longId: l.longId, underlying: l.underlying, isPut: false, strike: 200_000_000n, expiry: BigInt(EXPIRY) } }))
          : [],
    };
  }

  sender() {
    return {
      execute: async (call: { address: Address; functionName: string; args: readonly unknown[] }): Promise<TxOutcome> => {
        this.sent.push({ vault: call.address, functionName: call.functionName, args: call.args });
        this.sentAt.push(this.now);
        if (this.sendDelayS > 0) this.advance(this.sendDelayS);
        if (call.functionName === 'cancel') {
          for (const id of call.args[0] as bigint[]) {
            const o = this.orders.get(id);
            if (o !== undefined && o.maker.toLowerCase() === call.address.toLowerCase()) o.cancelled = true;
          }
        }
        if (this.liveBook && call.functionName === 'place') {
          const [longId, kind, price, units, validUntil] = call.args as [bigint, number, bigint, bigint, number];
          this.orders.set(this.nextOrderId++, { maker: call.address, longId, kind, price, units, filled: 0n, validUntil, cancelled: false });
        }
        if (this.liveBook && call.functionName === 'replace') {
          const [id, price, units] = call.args as [bigint, bigint, bigint];
          const o = this.orders.get(id);
          if (o !== undefined && o.maker.toLowerCase() === call.address.toLowerCase()) Object.assign(o, { price, units, filled: 0n });
        }
        return { status: 'confirmed', hash: hash('ab'), nonce: 0, blockNumber: this.block, gasUsed: 100_000n, result: undefined };
      },
    };
  }

  /** An ok fair for every request, priced at the oracle's spot now. */
  pricing() {
    return {
      fairMany: async (requests: readonly unknown[]): Promise<FairInput[]> =>
        requests.map(() => ({ ok: true as const, fair: 2_000_000n, delta: 0.3, iv: 0.5, asOf: this.now, source: 'fake', spot: this.spot })),
    };
  }

  bot(store = new V2Store(':memory:'), log: Logger = silentLogger()): MmBot {
    return new MmBot({
      config: this.config,
      log,
      client: this.client() as never,
      logClient: this.logClient() as never,
      sender: this.sender() as never,
      alerter: {
        alert: async (kind, message, _data, options) => (this.alerts.push(kind), this.pages.push({ kind, message, severity: options?.severity, dedupeKey: options?.dedupeKey }), true),
        clear: (kind, dedupeKey) => void this.pages.push({ cleared: kind, dedupeKey }),
      },
      store,
      pricing: this.pricing() as never,
      signer: '0x0000000000000000000000000000000000000001',
      now: () => this.now * 1000,
      killWaitMs: 10_000,
      killRetryMs: 1,
    });
  }

  /** The order ids every `cancel` sent through `vault` named. */
  cancelledVia(vault: Address): bigint[] {
    return this.sent.filter((s) => s.functionName === 'cancel' && s.vault.toLowerCase() === vault.toLowerCase()).flatMap((s) => s.args[0] as bigint[]);
  }
}

type VaultRow = { address: string; markouts: Array<{ longId: string; side: string; units: string }> };
const vaultRows = (bot: MmBot) => (bot.state() as { vaults: VaultRow[] }).vaults;

/*//////////////////////////////////////////////////////////////
                          THE HARNESS
//////////////////////////////////////////////////////////////*/

test('the MM warns at boot inside the last quarter of its NYSE holiday table, and /state carries the horizon', async () => {
  const lines: string[] = [];
  const log = createV2Logger({ level: 'info', mode: 'mm', destination: { write: (line: string) => void lines.push(line) } });
  const warnings = () => lines.map((l) => JSON.parse(l) as { level: string; msg: string }).filter((l) => l.level === 'warn' && /NYSE holiday table/.test(l.msg));

  // Today (T, 2026-09-23): quiet at boot, and /state says how far the table reaches.
  const chain = new FakeChain();
  chain.add(1n, 'AskWrite');
  const bot = chain.bot(undefined, log);
  assert.deepEqual(warnings(), [], 'more than a quarter left: no boot warning');
  await bot.tick();
  const state = bot.state() as { holidayHorizon: ReturnType<typeof holidayHorizon> };
  assert.deepEqual(state.holidayHorizon, holidayHorizon(chain.now), '/state reads the horizon at the head block');
  assert.equal(state.holidayHorizon.coveredThrough, '2028-12-31');
  assert.equal(state.holidayHorizon.warning, null);

  // Booted 30 days before the table's last year ends: one warning, naming the date.
  const late = new FakeChain();
  late.now = Date.UTC(2028, 11, 2) / 1000;
  late.bot(undefined, log);
  assert.equal(warnings().length, 1, 'inside the last quarter: warned once at boot');
  assert.match(warnings()[0]!.msg, /ends 2028-12-31 \(30 days left\)/);
});

test('harness: the real tick runs end to end on the fake chain and plans the listed series', async () => {
  const chain = new FakeChain();
  chain.add(1n, 'AskWrite');
  const bot = chain.bot();
  const plan = await bot.tick();
  assert.deepEqual(chain.alerts.filter((k) => k === 'v2_mm_vault_unreadable'), [], 'no vault was skipped as unreadable');
  const series = plan.series.find((s) => s.longId === LONG_ID);
  assert.ok(series !== undefined, 'the listed series is planned');
  // Quotable, not merely present: selected, priced from an ok fair, and halted by nothing. A harness that planned a halted
  // series would make every halt test below pass for the wrong reason.
  assert.equal(series.halt, null, 'no halt on a quiet tick');
  assert.equal(series.selected, true);
  assert.ok(series.fair !== null, 'priced from the fair');
  assert.ok(chain.sent.length > 0, 'the plan was sent through the vault');
  assert.equal(vaultRows(bot).length, 1, 'the treasury vault finished its tick');
});

/*//////////////////////////////////////////////////////////////
                    GUARD 1: FILLS ARE RECORDED
//////////////////////////////////////////////////////////////*/

test('fill recording: a Bid filled between two ticks lands in the vault\'s markout book (book.record in trackOrders)', async () => {
  const chain = new FakeChain();
  chain.add(1n, 'Bid');
  const bot = chain.bot();
  await bot.tick(); // adopts the order at its current fill (0)
  chain.orders.get(1n)!.filled = 40n;
  chain.advance(60);
  await bot.tick();
  const row = vaultRows(bot).find((r) => r.address.toLowerCase() === chain.config.contracts.makerVault.toLowerCase());
  assert.ok(row !== undefined, 'the treasury vault ticked');
  assert.equal(row.markouts.length, 1, 'the fill is in the markout book');
  assert.deepEqual({ longId: row.markouts[0]!.longId, side: row.markouts[0]!.side, units: row.markouts[0]!.units }, { longId: LONG_ID.toString(), side: 'buy', units: '40' });
});

/*//////////////////////////////////////////////////////////////
                 GUARD 2: THE MARKET-SAFETY HALT
//////////////////////////////////////////////////////////////*/

test('market-safety halt: a spot move past MM_BREAKER_BPS inside the window halts the market\'s series (this.marketSafety in planVault)', async () => {
  const chain = new FakeChain();
  chain.add(1n, 'AskWrite');
  const bot = chain.bot();
  const quiet = await bot.tick();
  assert.equal(quiet.series.find((s) => s.longId === LONG_ID)?.halt?.halt === 'spot-move-breaker', false, 'no move yet, no breaker');
  chain.advance(60);
  chain.spot = (SPOT * 10_400n) / 10_000n; // +400 bps in 60 s; the default breaker is 150 bps in 300 s
  const moved = await bot.tick();
  const series = moved.series.find((s) => s.longId === LONG_ID);
  assert.equal(series?.halt?.halt, 'spot-move-breaker', 'the market is halted by the breaker');
  assert.ok(chain.cancelledVia(chain.config.contracts.makerVault).includes(1n), 'the halted series\' resting ask is pulled');
});

/*//////////////////////////////////////////////////////////////
          GUARD 3: A KILL CANCELS EVERY DISCOVERED HOUSE VAULT
//////////////////////////////////////////////////////////////*/

test('kill: a House vault discovery found but does not quote (untagged factory) still has its orders cancelled', async () => {
  // A bare MM_HOUSE_FACTORY address is kind `unknown`: its vaults are discovered but never quoted.
  const chain = new FakeChain({ MM_HOUSE_FACTORY: FACTORY });
  chain.factories.set(FACTORY.toLowerCase(), [HOUSE]);
  chain.house.add(HOUSE.toLowerCase());
  chain.add(1n, 'AskWrite', { maker: HOUSE });
  const bot = chain.bot();
  const outcome = await bot.kill('drill');
  assert.deepEqual(chain.cancelledVia(HOUSE), [1n], 'the House vault\'s ask is cancelled');
  assert.equal(outcome.done, true);
  assert.equal(chain.orders.get(1n)!.cancelled, true);
});

/*//////////////////////////////////////////////////////////////
        FIX: A REFUSED MM_VAULTS ENTRY IS CANCELLED
//////////////////////////////////////////////////////////////*/

test('refused vault: a House vault listed in MM_VAULTS is never quoted, but the tick cancels what it rests before its epochEnd', async () => {
  const chain = new FakeChain({ MM_VAULTS: REFUSED });
  chain.house.add(REFUSED.toLowerCase());
  chain.add(1n, 'AskWrite', { maker: REFUSED });
  chain.add(2n, 'Bid', { maker: REFUSED });
  const bot = chain.bot();
  await bot.tick();
  assert.ok(chain.alerts.includes('v2_mm_vault_is_house'), 'refused and paged (T-OP-245)');
  assert.deepEqual(chain.cancelledVia(REFUSED).sort(), [1n, 2n], 'both resting orders are cancelled');
  assert.deepEqual(chain.sent.filter((s) => s.vault.toLowerCase() === REFUSED.toLowerCase() && s.functionName !== 'cancel'), [], 'nothing but cancels is sent through it');
  // Nothing rests any more, so the next tick sends nothing through it.
  const before = chain.sent.length;
  chain.advance(60);
  await bot.tick();
  assert.equal(chain.sent.slice(before).filter((s) => s.vault.toLowerCase() === REFUSED.toLowerCase()).length, 0, 'quiet once flat');
});

test('refused vault: a body-less kill cancels what a refused MM_VAULTS entry rests', async () => {
  const chain = new FakeChain({ MM_VAULTS: REFUSED });
  chain.house.add(REFUSED.toLowerCase());
  chain.add(1n, 'AskWrite', { maker: REFUSED });
  const bot = chain.bot();
  const outcome = await bot.kill('drill');
  assert.deepEqual(chain.cancelledVia(REFUSED), [1n], 'the refused vault\'s ask is cancelled by the kill');
  assert.equal(outcome.done, true);
});

/*//////////////////////////////////////////////////////////////
   HOUSE VAULTS QUOTE, AND A FAILED GUARD READ PAGES
//////////////////////////////////////////////////////////////*/

type GuardRow = { address: string; unavailable: string | null; selected: string[]; inventory: Array<{ longId: string; halt: { halt: string } | null }> };
const guardRow = (bot: MmBot, vault: Address) => (bot.state() as { vaults: GuardRow[] }).vaults.find((r) => r.address.toLowerCase() === vault.toLowerCase());

test('a House vault (no askFloor) quotes its series: floors come from askFloorOf, nothing halts guards-unreadable', async () => {
  const chain = new FakeChain({ MM_HOUSE_FACTORY: `${FACTORY}:kinded` });
  chain.factories.set(FACTORY.toLowerCase(), [HOUSE]);
  chain.house.add(HOUSE.toLowerCase());
  const bot = chain.bot();
  await bot.tick();
  const row = guardRow(bot, HOUSE);
  assert.ok(row !== undefined, 'the House vault finished its tick');
  assert.deepEqual(row.inventory.filter((s) => s.halt?.halt === 'guards-unreadable').map((s) => s.longId), [], 'HouseVault: no series halted guards-unreadable');
  assert.equal(row.unavailable, null);
  // Quotable, not merely unhalted-by-guards: selected and halted by nothing. (The fake funds no ledger collateral, so the
  // first tick deposits rather than places; the harness test above asserts the same of the treasury.)
  assert.deepEqual(row.selected, [LONG_ID.toString()], 'the House series is selected');
  assert.equal(row.inventory.find((s) => s.longId === LONG_ID.toString())?.halt ?? null, null, 'HouseVault: the series is halted by nothing');
  assert.equal(chain.alerts.includes('v2_mm_guards_unreadable'), false);
});

test('a guard read that fails pages v2_mm_guards_unreadable warn at once, error from the third tick, and clears on recovery', async () => {
  const chain = new FakeChain();
  chain.failing.add('askFloorOf');
  const bot = chain.bot();
  const vault = chain.config.contracts.makerVault;
  const guardPages = () => chain.pages.filter((p): p is { kind: string; message: string; severity?: string; dedupeKey?: string } => 'kind' in p && p.kind === 'v2_mm_guards_unreadable');

  const first = await bot.tick();
  assert.equal(first.series.find((s) => s.longId === LONG_ID)?.halt?.halt, 'guards-unreadable', 'the halt stays');
  assert.equal(guardPages().length, 1, 'paged on the first tick');
  assert.equal(guardPages()[0]!.severity, 'warn');
  assert.match(guardPages()[0]!.message, new RegExp(`vault ${vault}: 1 of 1 series halted guards-unreadable for 1 consecutive tick`));
  assert.match(guardPages()[0]!.message, /askFloorOf\(7,true\): .*askFloorOf/, 'the page names the failing call');
  const unavailable = guardRow(bot, vault)?.unavailable ?? null;
  assert.ok(unavailable !== null && /guards-unreadable/.test(unavailable) && /askFloorOf\(7,false\)/.test(unavailable), `/state says why: ${unavailable}`);

  chain.advance(60);
  await bot.tick();
  assert.deepEqual(guardPages().map((p) => p.severity), ['warn', 'warn'], 'tick 2 is still a warn');
  chain.advance(60);
  await bot.tick();
  const third = guardPages().at(-1)!;
  assert.equal(third.severity, 'error', 'escalated at GUARDS_UNREADABLE_ERROR_TICKS');
  assert.equal(third.dedupeKey, `${vault.toLowerCase()}:error`, 'keyed apart from the warn, so its cooldown cannot swallow the escalation');

  chain.failing.delete('askFloorOf');
  chain.advance(60);
  await bot.tick();
  assert.equal(guardRow(bot, vault)?.unavailable, null, 'available again');
  const clears = chain.pages.filter((p) => 'cleared' in p && p.cleared === 'v2_mm_guards_unreadable').map((p) => (p as { dedupeKey?: string }).dedupeKey);
  assert.deepEqual(clears, [vault.toLowerCase(), `${vault.toLowerCase()}:error`], 'both keys cleared, so the next spell pages again');
  chain.failing.add('askFloorOf');
  chain.advance(60);
  await bot.tick();
  assert.equal(guardPages().at(-1)!.severity, 'warn', 'a new spell starts over at warn');
});

/*//////////////////////////////////////////////////////////////
     ROUTINE SENDS ONCE A MINUTE, PROTECTION ON EVERY READ
//////////////////////////////////////////////////////////////*/

type GateRow = { address: string; sendGate: { due: boolean; held: number; intervalS: number }; budget: { given: number; unsent: number; seriesWithoutAsk: number; shortSends: number } };
const gateRow = (bot: MmBot, vault: Address) => (bot.state() as { vaults: GateRow[] }).vaults.find((r) => r.address.toLowerCase() === vault.toLowerCase())!;
/** A chain on which the bot quotes both sides of the one series: a 10 USDG bid cap, and write collateral for many units. */
const quotingChain = (env: Record<string, string> = {}): FakeChain => {
  const chain = new FakeChain(env);
  chain.overrides.set('bidCap', 10_000_000n);
  chain.overrides.set('free', 10n ** 22n);
  return chain;
};

test('with MM_SEND_INTERVAL_S 60 the vault sends routine transactions once a minute; a breaker cancel goes out on the read that finds it', async () => {
  const chain = quotingChain({ MM_SEND_INTERVAL_S: '60', POLL_INTERVAL_MS: '15000' });
  // A resting ask far from its target: every routine send requotes it (the fake book does not apply a replace).
  chain.add(1n, 'AskWrite');
  const bot = chain.bot();
  const vault = chain.config.contracts.makerVault;
  const routine = () => chain.sent.filter((s) => s.functionName !== 'cancel').length;
  const quotes = () => chain.sent.filter((s) => s.functionName === 'place' || s.functionName === 'replace').length;

  const plan = await bot.tick();
  const first = routine();
  assert.ok(plan.series.some((s) => s.targets?.bid != null && s.targets?.write != null), 'the setup: the bot quotes both sides');
  assert.ok(quotes() >= 2, 'the first read is a routine send: it places the bid and requotes the resting ask');
  assert.deepEqual(chain.cancelledVia(vault), [], 'the setup: the resting ask is not cancelled by a quiet read');
  assert.equal(gateRow(bot, vault).sendGate.due, true);
  for (const dt of [15, 30, 45]) {
    chain.advance(15);
    await bot.tick();
    assert.equal(routine(), first, `+${dt} s: no routine send between routine sends`);
    const gate = gateRow(bot, vault).sendGate;
    assert.equal(gate.due, false);
    assert.ok(gate.held > 0, `+${dt} s: /state names the ${gate.held} routine transactions held for the next send`);
  }
  chain.advance(15);
  await bot.tick();
  assert.ok(routine() > first, '+60 s: the next routine send');
  assert.deepEqual(chain.cancelledVia(vault), [], 'the setup: nothing has cancelled the resting ask yet');

  // 15 s after that routine send the spot jumps 400 bps: the breaker's cancel is protective and goes out on this read.
  chain.advance(15);
  const routineBefore = routine();
  chain.spot = (SPOT * 10_400n) / 10_000n;
  const moved = await bot.tick();
  assert.equal(moved.series.find((s) => s.longId === LONG_ID)?.halt?.halt, 'spot-move-breaker');
  assert.equal(gateRow(bot, vault).sendGate.due, false, 'the setup: this read is between routine sends');
  assert.ok(chain.cancelledVia(vault).includes(1n), 'the halted series\' resting ask is pulled on the read that found the move');
  assert.equal(routine(), routineBefore, 'and nothing routine went with it');
});

test('v2_mm_budget_short pages on the third routine send in a row that the tick budget cut short, with the series left without an ask', async () => {
  // One transaction a tick: the deposit of the idle Stock Tokens goes out and the bid and ask places do not.
  const chain = quotingChain({ MM_MAX_TX_PER_TICK: '1' });
  const bot = chain.bot();
  const vault = chain.config.contracts.makerVault;
  const pages = () => chain.pages.filter((p): p is { kind: string; message: string; severity?: string; dedupeKey?: string } => 'kind' in p && p.kind === 'v2_mm_budget_short');

  const first = await bot.tick();
  assert.ok(first.series.some((s) => s.targets?.write != null), 'the setup: the bot has an ask to place');
  assert.deepEqual(gateRow(bot, vault).budget, { given: 1, unsent: gateRow(bot, vault).budget.unsent, seriesWithoutAsk: 1, shortSends: 1 });
  assert.ok(gateRow(bot, vault).budget.unsent > 0, 'the setup: the plan did not fit');
  chain.advance(60);
  await bot.tick();
  assert.equal(pages().length, 0, 'two short sends are the book filling: no page');
  chain.advance(60);
  await bot.tick();
  assert.equal(pages().length, 1, 'the third short send in a row pages');
  assert.equal(pages()[0]!.dedupeKey, vault.toLowerCase(), 'per vault');
  assert.match(pages()[0]!.message, new RegExp(`vault ${vault}: MM_MAX_TX_PER_TICK \\(1\\) cut 3 routine sends in a row short; 1 series left without a live ask`));
});

/*//////////////////////////////////////////////////////////////
       A HOUSE VAULT QUOTES ITS OWN MARKET ONLY
//////////////////////////////////////////////////////////////*/

/**
 * Two markets (the fixture registry's NVDA and TSLA; on launch day NVDA and SPCX), one live series each inside the
 * epoch, and one House vault per market, each answering `underlying()` with its own stock. The treasury MakerVault
 * quotes both markets; each House vault only its own.
 */
const twoMarkets = () => {
  const HOUSE_B = getAddress('0x00000000000000000000000000000000000a0003');
  const chain = new FakeChain({ MM_HOUSE_FACTORY: `${FACTORY}:kinded`, MM_MARKETS: 'NVDA,TSLA' });
  const tsla = getAddress(quotedMarkets(chain.config).find((m) => m.ticker === 'TSLA')!.underlying);
  const TSLA_ID = 9n;
  chain.listed.push({ longId: TSLA_ID, underlying: tsla });
  chain.factories.set(FACTORY.toLowerCase(), [HOUSE, HOUSE_B]);
  chain.house.add(HOUSE.toLowerCase());
  chain.house.add(HOUSE_B.toLowerCase());
  chain.houseUnderlying.set(HOUSE_B.toLowerCase(), tsla); // HOUSE trades NVDA (the FakeChain default)
  return { chain, HOUSE_B, TSLA_ID };
};

test('each House vault plans only its own market -- the TSLA vault never picks the NVDA series, nor the NVDA vault the TSLA one', async () => {
  // BREAK CHECK: put `underlying: null` back on the House target (quoter.ts vaultTargets) and the TSLA vault
  // selects the NVDA series too, as the SPCX vault would Monday to Thursday once SPCX is Friday-only.
  const { chain, HOUSE_B, TSLA_ID } = twoMarkets();
  const bot = chain.bot();
  await bot.tick();
  const treasury = guardRow(bot, chain.config.contracts.makerVault)!;
  assert.deepEqual([...treasury.selected].sort(), [LONG_ID.toString(), TSLA_ID.toString()].sort(), 'the setup: both series are live and quotable');
  const nvdaVault = guardRow(bot, HOUSE)!;
  const tslaVault = guardRow(bot, HOUSE_B)!;
  assert.deepEqual(nvdaVault.selected, [LONG_ID.toString()], 'the NVDA House vault selects its own series only');
  assert.deepEqual(tslaVault.selected, [TSLA_ID.toString()], 'the TSLA House vault selects its own series only');
  assert.deepEqual(tslaVault.inventory.map((s) => s.longId), [TSLA_ID.toString()], 'nothing of the other market is even planned on it');
  assert.equal(chain.alerts.includes('v2_mm_house_unavailable'), false);
});

test('a House vault whose underlying() cannot be read is not quoted and is paged; it never falls back to every market', async () => {
  const { chain, HOUSE_B } = twoMarkets();
  chain.failing.add(`underlying@${HOUSE_B.toLowerCase()}`);
  const bot = chain.bot();
  await bot.tick();
  assert.equal(guardRow(bot, HOUSE_B), undefined, 'the vault is not a target this tick');
  const page = chain.pages.find((p): p is { kind: string; message: string; dedupeKey?: string } => 'kind' in p && p.kind === 'v2_mm_house_unavailable');
  assert.ok(page !== undefined, 'paged');
  assert.match(page.message, new RegExp(`House vault ${HOUSE_B} was discovered but its underlying\\(\\) could not be read; it is NOT quoted`));
  assert.equal(page.dedupeKey, HOUSE_B.toLowerCase());
  assert.deepEqual(guardRow(bot, HOUSE)!.selected, [LONG_ID.toString()], 'the other House vault still quotes its own market');
});

/*//////////////////////////////////////////////////////////////
   A SLOW TICK STAMPS EACH PLACE AT ITS OWN SEND AND SKIPS A DEAD REPLACE
//////////////////////////////////////////////////////////////*/

/**
 * The fork measurement, on the fake chain: every send takes 50 s of chain time. Two resting asks: the older
 * (id 1) is an extra and is cancelled first, protectively; the newer (id 2) ends at T + 100, outside the 60 s replace
 * margin when the tick plans, so its requote is planned as a replace. By the time that replace would go out (T + 50) the
 * order has 50 s left, inside the margin: it must not be sent. Every place must live MM_MAX_QUOTE_LIFETIME_S (180) from
 * the chain time of its own send, not from the tick's start. The control is the same chain with instant sends.
 */
const slowChain = (delayS: number) => {
  const chain = quotingChain({ MM_MAX_QUOTE_LIFETIME_S: '180' });
  chain.add(1n, 'AskWrite');
  chain.add(2n, 'AskWrite', { validUntil: T + 100 });
  chain.sendDelayS = delayS;
  return chain;
};
const slowPages = (chain: FakeChain) => chain.pages.filter((p): p is { kind: string; message: string; dedupeKey?: string } => 'kind' in p && p.kind === 'v2_mm_slow_tick');

test('a slow tick stamps each place from its own send and does not send a planned replace of an order that ran out mid-tick', async () => {
  const chain = slowChain(50);
  const plan = await chain.bot().tick();
  assert.ok(plan.txs.some((t) => t.type === 'replace' && t.orderId === 2n), 'the setup: the tick planned a replace of ask 2');
  assert.ok(plan.txs.some((t) => t.type === 'cancel' && t.orderIds.includes(1n)), 'the setup: the extra ask is cancelled first');
  const places = chain.sent.map((s, i) => ({ ...s, at: chain.sentAt[i]! })).filter((s) => s.functionName === 'place');
  assert.ok(places.length > 0 && places.every((p) => p.at > T), 'the setup: every place went out after the tick\'s start');
  for (const p of places) assert.equal(p.args[4], p.at + 180, `a place sent at chain time ${p.at} lives 180 s from its own send`);
  assert.ok(!chain.sent.some((s) => s.functionName === 'replace' && s.args[0] === 2n), 'the replace of ask 2 (50 s left at its send, margin 60 s) is not sent');
  const slow = slowPages(chain);
  assert.equal(slow.length, 1, 'the slow tick pages once');
  assert.match(slow[0]!.message, /^mm tick took \d+\.\d s, over MM_REPLACE_CONFIRM_S 60 s: /);
});

test('control: with instant sends the same tick sends the replace, stamps places from the tick\'s start, and pages nothing', async () => {
  const chain = slowChain(0);
  await chain.bot().tick();
  const places = chain.sent.filter((s) => s.functionName === 'place');
  assert.ok(places.length > 0, 'the setup: places went out');
  for (const p of places) assert.equal(p.args[4], T + 180, 'no time passed: the send-time stamp is the tick-start one');
  assert.ok(chain.sent.some((s) => s.functionName === 'replace' && s.args[0] === 2n), 'the replace of ask 2 goes out: 100 s left, outside the margin');
  assert.deepEqual(slowPages(chain), [], 'a fast tick pages nothing');
});

/*//////////////////////////////////////////////////////////////
   THE TREASURY STEPS ASIDE FOR ITS OWN HOUSE VAULT, NOT BOTH WAYS
//////////////////////////////////////////////////////////////*/

/**
 * A fork finding, replayed. The treasury MakerVault and the NVDA House vault quote the same series from one
 * process, and every vault plans from the same head before any vault sends (tick()). So on the first read both see an
 * empty book and both place an ask; on the next read each finds the other's ask (reads.readOtherAskers drops only the
 * vault's OWN orders). Measured in run 4 (orders 1533/1555 vs 1587/1588, then 1589/1590 vs 1606/1607, all at 1168300):
 * both halted `other-asker` on the same read and both cancelled, "no write target", so the series had no ask from
 * either vault until the next routine send, when both placed again. The treasury's ask is the fallback, so
 * the House vault must not step aside for it.
 */
test('the treasury steps aside for the House vault\'s ask, the House vault never for the treasury\'s, so the series has an ask at every read', async () => {
  // BREAK CHECK: `below: new Set()` in siblingRanks (quoter.ts) -> red at +15 s, "the series has an ask
  // from one of the two vaults": both vaults cancel on one read, exactly that. Dropping the sibling band from
  // planner.stepAsideAsks -> red at +60 s: the treasury's fresh ask lands one tick under the House ask and rests.
  const chain = quotingChain({ MM_HOUSE_FACTORY: `${FACTORY}:kinded`, MM_SEND_INTERVAL_S: '60', POLL_INTERVAL_MS: '15000' });
  chain.liveBook = true;
  chain.factories.set(FACTORY.toLowerCase(), [HOUSE]);
  chain.house.add(HOUSE.toLowerCase());
  const treasury = chain.config.contracts.makerVault;
  const asks = (maker: Address) =>
    [...chain.orders.values()].filter(
      (o) => o.longId === LONG_ID && o.maker.toLowerCase() === maker.toLowerCase() && !o.cancelled && o.filled < o.units && (o.kind === KIND_INDEX.AskWrite || o.kind === KIND_INDEX.AskResale) && (o.validUntil === 0 || o.validUntil > chain.now),
    );
  const haltOn = (bot: MmBot, vault: Address) => guardRow(bot, vault)?.inventory.find((s) => s.longId === LONG_ID.toString())?.halt ?? null;
  const bot = chain.bot();

  // Read 1, a routine send for both: each plans from the same empty book and places an ask (run 4, 10:06 ET).
  await bot.tick();
  assert.equal(asks(HOUSE).length, 1, 'the setup: the House vault placed its ask');
  assert.equal(asks(treasury).length, 1, 'the setup: the treasury placed its ask in the same tick, blind to the House one');
  const [house] = asks(HOUSE);
  const [mine] = asks(treasury);
  assert.ok(house!.price <= mine!.price, 'the setup: the House ask is at or below the treasury\'s, so the treasury steps aside for it');
  assert.ok(mine!.price <= house!.price, 'the setup: and the treasury\'s is at or below the House one, the mutual case the fork measured');

  // Every read for two routine sends: the House ask stays, the treasury's stays off, and the series is never bare.
  for (const dt of [15, 30, 45, 60, 75, 90, 105, 120]) {
    chain.advance(15);
    await bot.tick();
    assert.ok(asks(HOUSE).length + asks(treasury).length > 0, `+${dt} s: the series has an ask from one of the two vaults`);
    assert.equal(asks(HOUSE).length, 1, `+${dt} s: the House vault keeps its ask`);
    assert.equal(asks(treasury).length, 0, `+${dt} s: the treasury's ask stays off while the House one rests (it is the fallback)`);
    assert.equal(haltOn(bot, treasury)?.halt, 'other-asker', `+${dt} s: /state names why the treasury holds its ask off`);
    assert.notEqual(haltOn(bot, HOUSE)?.halt, 'other-asker', `+${dt} s: the House vault does not step aside for the treasury`);
  }
});

test('siblingRanks puts House vaults above the treasury, ties in target order; siblingAskers drops the lower, marks the higher', () => {
  const T0 = getAddress('0x00000000000000000000000000000000000b0001');
  const X1 = getAddress('0x00000000000000000000000000000000000b0002');
  const H1 = getAddress('0x00000000000000000000000000000000000b0003');
  const H2 = getAddress('0x00000000000000000000000000000000000b0004');
  const OUT = '0x00000000000000000000000000000000000b00ff';
  // vaultTargets order: the treasury, an MM_VAULTS extra, then the House vaults in factory order.
  const ranks = siblingRanks([
    { address: T0, kind: 'treasury' },
    { address: X1, kind: 'treasury' },
    { address: H1, kind: 'house' },
    { address: H2, kind: 'house' },
  ]);
  const of = (v: Address) => ranks.get(v.toLowerCase())!;
  const names = (set: ReadonlySet<string>) => [...set].sort();
  assert.deepEqual(names(of(H1).above), [], 'the first House vault steps aside for none of the bot\'s vaults');
  assert.deepEqual(names(of(T0).above), names(new Set([H1, H2].map((a) => a.toLowerCase()))), 'the treasury steps aside for every House vault');
  assert.deepEqual(names(of(T0).below), [X1.toLowerCase()], 'and not for its own MM_VAULTS extra (tie-break: target order)');
  assert.deepEqual(names(of(X1).below), [], 'the extra ranks last');
  for (const [v, r] of ranks) for (const w of r.above) assert.ok(ranks.get(w)!.below.has(v), `no two vaults step aside for each other (${v} / ${w})`);

  const ask = (maker: string, id: bigint) => ({ id, maker: maker.toLowerCase(), kind: 'AskWrite' as const, price: 1n, remaining: 100n, makerFree: 10n ** 19n });
  // What readOtherAskers hands each vault: every ask on the series but its own.
  const all = [ask(T0, 1n), ask(X1, 2n), ask(H1, 3n), ask(OUT, 4n)];
  const readFor = (v: Address) => ({ asks: new Map([['7', all.filter((o) => o.maker !== v.toLowerCase())]]), truncated: ['7'] });
  const seen = siblingAskers(readFor(T0), of(T0)).asks.get('7')!;
  assert.deepEqual(seen.map((o) => [o.id, o.sibling === true]), [[3n, true], [4n, false]], 'the treasury: the House ask marked sibling, its extra\'s dropped, a third party\'s untouched');
  assert.deepEqual(siblingAskers(readFor(H1), of(H1)).asks.get('7')!.map((o) => [o.id, o.sibling === true]), [[4n, false]], 'the House vault: only the third party remains');
  assert.deepEqual(siblingAskers(readFor(H1), of(H1)).truncated, ['7'], 'the partial-read report passes through');
});

/*//////////////////////////////////////////////////////////////
   AN UNREAD BALANCE IS NAMED, NOT SHOWN AS A MEASURED 0
//////////////////////////////////////////////////////////////*/

/** /state's vaultState: the ticked vault's chain state, freeCollateral and walletTokens included. */
type BalanceState = { vaultState: { balancesUnread?: string[]; freeCollateral: Record<string, unknown> } };

test('a free() read that fails is named in /state (balancesUnread) beside its 0n, which sizes no write; a read one is not named', async () => {
  const chain = new FakeChain();
  chain.add(1n, 'AskWrite');
  chain.failing.add('free');
  const bot = chain.bot();
  await bot.tick();
  const state = bot.state() as BalanceState;
  assert.ok((state.vaultState.balancesUnread ?? []).some((x) => x.startsWith('free(')), JSON.stringify(state.vaultState.balancesUnread));
  // Control: the same chain with free() answering names nothing.
  const ok = new FakeChain();
  ok.add(1n, 'AskWrite');
  const okBot = ok.bot();
  await okBot.tick();
  assert.equal((okBot.state() as BalanceState).vaultState.balancesUnread, undefined);
});
