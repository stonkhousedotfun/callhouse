/**
 * The MM bot's send cadence, replace margin and budget-short count, pinned on the
 * RENDERED launch env (ops/v2/env/mm-bot.env, as ops/v2-env.mjs writes it) wherever a number matters: a keeper default
 * is not what ships. quoter.tick.test.ts drives the real tick for the send gate and the page; planner.test.ts pins the
 * bid cap two routine sends ahead; quoter.test.ts pins the tick budget arithmetic.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { newYorkTimeToUnix } from '../../calendar.js';
import { bidCapAheadOf, DEFAULT_REGISTRY_PATH, KEEPER_PACKAGE_DIR, loadV2Config, refreshLeadOf, replaceMarginOf, type MmConfig } from '../config.js';
import { bsDelta, bsPrice, bsVega, tradingYears } from '../pricing/bs.js';
import { KIND_INDEX, type OrderKindName } from './constants.js';
import { planSeriesActions, type FairInput, type LiveOrder } from './engine.js';
import { planTick, type SeriesView, type TickInput, type TickPlan } from './planner.js';
import { budgetShortSeries, isProtectiveTx, mmPlanParams, routineSendDue, vaultBudgetOf } from './quoter.js';

/** The env the MM bot ships with, as ops/v2-env.mjs renders it. */
const SHIPPED_ENV = join(KEEPER_PACKAGE_DIR, '..', 'ops', 'v2', 'env', 'mm-bot.env');

/** The shipped env's assignments through loadV2Config, its secrets and an out-of-image registry path standing in. */
function shipped(over: Record<string, string> = {}): MmConfig {
  const env: Record<string, string> = {};
  for (const line of readFileSync(SHIPPED_ENV, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]!] = m[2]!;
  }
  assert.equal(env.V2_MODE, 'mm', 'the setup: this is the MM bot\'s file');
  const secrets = { MM_QUOTER_PK: `0x${'2b'.repeat(32)}`, MM_KILL_TOKEN: 'f0'.repeat(32), ALERT_WEBHOOK_TOKEN: 'e1'.repeat(32) };
  return loadV2Config({ ...env, ...secrets, V2_REGISTRY_PATH: join(KEEPER_PACKAGE_DIR, DEFAULT_REGISTRY_PATH), ...over }) as MmConfig;
}

const marginOf = (c: MmConfig) => replaceMarginOf({ pollIntervalMs: c.pollIntervalMs, txTimeoutMs: c.txTimeoutMs, replaceConfirmS: c.tuning.replaceConfirmS });
const leadOf = (c: MmConfig) => refreshLeadOf({ pollIntervalMs: c.pollIntervalMs, sendIntervalS: c.tuning.sendIntervalS });

test('the rendered launch env boots: reads every 15 s, routine sends once a minute, a replace margin under the quote life', () => {
  // BREAK CHECK (b): put `Math.ceil((input.pollIntervalMs + input.txTimeoutMs) / 1000)` back in config.ts
  // replaceMarginOf and shipped() throws here: "the replace margin 195 s is at or above MM_MAX_QUOTE_LIFETIME_S 180 s".
  const c = shipped();
  assert.equal(c.pollIntervalMs, 15_000);
  assert.equal(c.tuning.sendIntervalS, 60, 'owner ruling 49: a routine send at most once a minute per vault');
  assert.equal(c.tuning.maxQuoteLifetimeS, 180);
  assert.equal(c.txTimeoutMs, 180_000, 'the setup: KEEPER_TX_TIMEOUT_MS is the keeper default, 180 s');
  const margin = marginOf(c);
  assert.equal(margin, 60);
  assert.ok(margin < c.tuning.maxQuoteLifetimeS, `the replace margin ${margin} s must be under the quote life ${c.tuning.maxQuoteLifetimeS} s`);
  // The refresh lead covers the send interval plus two reads, so a quote is re-placed on the last routine send before
  // it lapses, and it stays under the life, so a quote is not re-placed on every send.
  const lead = leadOf(c);
  assert.equal(lead, 90);
  assert.ok(lead >= c.tuning.sendIntervalS + c.pollIntervalMs / 1000 && lead < c.tuning.maxQuoteLifetimeS);
});

test('a replace margin at or above the quote life is refused at boot, naming both values', () => {
  assert.throws(() => shipped({ MM_REPLACE_CONFIRM_S: '180' }), /MM_REPLACE_CONFIRM_S: the replace margin 180 s is at or above MM_MAX_QUOTE_LIFETIME_S 180 s/);
  assert.throws(() => shipped({ MM_MAX_QUOTE_LIFETIME_S: '200', MM_REPLACE_CONFIRM_S: '240' }), /the replace margin 240 s is at or above MM_MAX_QUOTE_LIFETIME_S 200 s/);
  // The controls: one second under the life boots, and a life of 0 (no bot cap on validUntil) has nothing to be under.
  assert.equal(shipped({ MM_REPLACE_CONFIRM_S: '179' }).tuning.replaceConfirmS, 179);
  assert.equal(shipped({ MM_MAX_QUOTE_LIFETIME_S: '0', MM_REPLACE_CONFIRM_S: '600' }).tuning.maxQuoteLifetimeS, 0);
});

test('at the rendered env a live quote that moved is REPLACED on the routine sends before its refresh; at the old margin it never was', () => {
  const c = shipped();
  const life = c.tuning.maxQuoteLifetimeS;
  const PLACED = 1_790_000_000;
  const bid: LiveOrder = { id: 1n, kind: 'Bid', price: 1_000_000n, units: 100n, filled: 0n, validUntil: PLACED + life, cancelled: false };
  // A 10 % move of the target: past MM_REQUOTE_BPS, and not a bound the bid breaks (the caps are wide), so a routine requote.
  const moved = { bid: { price: 1_100_000n, units: 100n }, write: null, resale: null };
  const plan = (dt: number, replaceMarginS: number) =>
    planSeriesActions({
      longId: 7n,
      now: PLACED + dt,
      orders: [bid],
      targets: moved,
      validUntil: { bid: PLACED + dt + life, write: null, resale: null },
      askFloors: { write: 0n, resale: 0n },
      bidCap: 10_000_000n,
      refreshS: leadOf(c),
      replaceMarginS,
      params: { requoteBps: c.tuning.requoteBps, resizeBps: c.tuning.resizeBps },
    });
  // The next routine send is 60 s after the place, or one read later; both are before the 90 s refresh lead.
  for (const dt of [c.tuning.sendIntervalS, c.tuning.sendIntervalS + c.pollIntervalMs / 1000]) {
    const actions = plan(dt, marginOf(c));
    assert.deepEqual(actions.map((a) => a.type), ['replace'], `+${dt} s: one replace, not a cancel and a place`);
  }
  // The margin measured, one poll plus KEEPER_TX_TIMEOUT_MS: every quote is inside it from its first second.
  const old = Math.ceil((c.pollIntervalMs + c.txTimeoutMs) / 1000);
  assert.equal(old, 195);
  assert.deepEqual(plan(c.tuning.sendIntervalS, old).map((a) => a.type), ['cancel', 'place'], 'the old margin: never a replace');
});

test('budgetShortSeries counts the series a budget cut left with no ask resting, and nothing else', () => {
  const live = (id: bigint, kind: 'Bid' | 'AskWrite' | 'AskResale') => ({ id, kind, price: 1n, remaining: 100n, validUntil: 0 });
  const series = (longId: bigint, orders: ReturnType<typeof live>[]) => ({ longId, live: orders }) as unknown as TickPlan['series'][number];
  const place = (longId: bigint, slot: 'bid' | 'write' | 'resale') => ({ type: 'place' as const, longId, slot, kind: 0, price: 1n, units: 100n, validUntil: 0, reason: 'no live' });
  const plan = {
    series: [
      series(1n, [live(11n, 'AskWrite')]), // its ask is refreshed: the cancel went out, the place did not -> dark
      series(2n, [live(21n, 'AskWrite')]), // another ask still rests -> not dark
      series(3n, []), // a bid place unsent: bids are not asks
      series(4n, []), // its ask place went out
      series(5n, [live(51n, 'Bid')]), // no ask at all and its ask place unsent -> dark
    ],
    txs: [{ type: 'cancel' as const, orderIds: [11n], longIds: [1n], reason: 'refresh' }, place(1n, 'write'), place(2n, 'resale'), place(3n, 'bid'), place(4n, 'write'), place(5n, 'write')],
  } as unknown as TickPlan;
  const sent = new Map<number, unknown>([
    [0, {}],
    [4, {}],
  ]);
  assert.deepEqual(budgetShortSeries(plan, sent), [1n, 5n]);
  // Everything sent: nothing is dark for want of budget.
  assert.deepEqual(budgetShortSeries(plan, new Map(plan.txs.map((_, i) => [i, {}]))), []);
});

/*//////////////////////////////////////////////////////////////
   DONE MEANS 5, IN PROCESS: 50 SERIES, 15 s READS, 60 s SENDS
//////////////////////////////////////////////////////////////*/

/** How the /fair spot moves per read: still, a steady drift down or up, or a seeded +/- walk of the same step. */
interface SpotMove {
  mode: 'down' | 'up' | 'walk';
  bpsPerRead: number;
  seed?: number;
}
const STILL: SpotMove = { mode: 'down', bpsPerRead: 0 };

/**
 * engine.orderActions before the reorder: cancels and housekeeping as planned, then every replace to no more units, then every
 * replace to more, then every place, each group in series priority (plan.series order) and, within a series, slot order
 * (engine.planSeriesActions: bid, write, resale). Sorting on those keys restores that order exactly.
 */
function legacyOrder(plan: TickPlan): TickPlan['txs'] {
  const rank = new Map(plan.series.map((s, i) => [s.longId.toString(), i]));
  const SLOT = { bid: 0, write: 1, resale: 2 } as const;
  const group = (tx: TickPlan['txs'][number]): number =>
    tx.type === 'replace' ? (tx.units <= tx.fromUnits ? 0 : 1) : tx.type === 'place' ? 2 : -1;
  const quotes = plan.txs.filter((tx) => group(tx) >= 0) as Array<Extract<TickPlan['txs'][number], { type: 'replace' | 'place' }>>;
  quotes.sort((a, b) => group(a) - group(b) || rank.get(a.longId.toString())! - rank.get(b.longId.toString())! || SLOT[a.slot] - SLOT[b.slot]);
  return [...plan.txs.filter((tx) => group(tx) < 0), ...quotes];
}

/**
 * The quoter's loop around the REAL planner at the rendered env, on a book that applies every place, replace and cancel:
 * 50 NVDA calls (10 strikes x 5 daily expiries), reads every POLL_INTERVAL_MS, the vault's routine send gated by
 * routineSendDue and only protective transactions between (isProtectiveTx), the treasury budget of vaultBudgetOf with two
 * House vaults that each need 2 transactions, the refresh lead, replace margin and bid horizon of config.ts. The spot is
 * held still, as on the fork (its oracle and its /fair did not move). This
 * stands in for a fork run of the same scenario.
 *
 * `legacy` runs the same loop the earlier way: every read a routine send, the bid capped now, the 195 s margin, the
 * 60 s refresh lead and a treasury budget of 20 (60 - 2 x 20). It must reproduce what was measured.
 */
function simulate(c: MmConfig, legacy: boolean, reads: number, move: SpotMove = STILL) {
  const t = c.tuning;
  const U = '0x00000000000000000000000000000000000000aa';
  const START = newYorkTimeToUnix(2026, 9, 23, 11);
  const CLOSE = newYorkTimeToUnix(2026, 9, 23, 16);
  // The /fair spot follows `move`; the oracle print (Chainlink, ChainlinkFeedSource.sol:17) follows it only on a 0.5 %
  // deviation. At rest both are 180 and the print is 30 s old, as before.
  let fairSpot = 180_000_000n;
  let print = fairSpot;
  let printAt = START - 30;
  let seed = move.seed ?? 1;
  const series = [23, 24, 25, 28, 29].flatMap((d, e) =>
    Array.from({ length: 10 }, (_, s) => ({ longId: BigInt(1 + e * 10 + s), underlying: U, isPut: false, strike: BigInt((170 + 5 * s) * 1e6), expiry: newYorkTimeToUnix(2026, 9, d, 16) })),
  );
  const pollS = c.pollIntervalMs / 1000;
  const sendIntervalS = legacy ? 0 : t.sendIntervalS;
  const refreshS = legacy ? Math.max(60, Math.ceil((c.pollIntervalMs * 2) / 1000)) : refreshLeadOf({ pollIntervalMs: c.pollIntervalMs, sendIntervalS });
  const replaceMarginS = legacy ? Math.ceil((c.pollIntervalMs + c.txTimeoutMs) / 1000) : replaceMarginOf({ pollIntervalMs: c.pollIntervalMs, txTimeoutMs: c.txTimeoutMs, replaceConfirmS: t.replaceConfirmS });
  const bidCapAheadS = legacy ? 0 : bidCapAheadOf({ pollIntervalMs: c.pollIntervalMs, sendIntervalS });
  const share = Math.floor(t.maxTxPerTick / 3);
  const budget = legacy ? t.maxTxPerTick - 2 * share : vaultBudgetOf(t.maxTxPerTick, share, [2, 2]);
  const kindOf = Object.fromEntries(Object.entries(KIND_INDEX).map(([k, v]) => [v, k])) as Record<number, OrderKindName>;
  const book = new Map<bigint, LiveOrder & { longId: bigint }>();
  let nextId = 1n;
  let lastRoutine: number | null = null;
  const sends: Array<{ now: number; quotable: number; withAsk: number }> = [];
  const counts = { replace: 0, cancelPlace: 0, refresh: 0, txs: 0, protective: 0, between: 0, askUnderLag: 0, askUnderVault: 0, bidOverCap: 0 };
  for (let now = START; now < START + reads * pollS; now += pollS) {
    if (now > START && move.bpsPerRead !== 0) {
      let sign = move.mode === 'down' ? -1 : 1;
      if (move.mode === 'walk') {
        // xorshift32 in 32-bit integer arithmetic: a float LCG loses its low bits past 2^53 and walks one way only.
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        sign = (seed >>> 0) % 2 === 0 ? 1 : -1;
      }
      fairSpot = (fairSpot * BigInt(10_000 + sign * move.bpsPerRead)) / 10_000n;
      const gap = fairSpot > print ? fairSpot - print : print - fairSpot;
      if (gap * 10_000n >= print * 50n) {
        print = fairSpot;
        printAt = now;
      }
    }
    const spot = print;
    const views: SeriesView[] = series.map((info) => ({
      info, ticker: 'NVDA', settled: false, spotFresh: true, spot, spotUpdatedAt: printAt, oracleBandBps: 150,
      exposure: { longs: 0n, shorts: 0n, bids: 0n, resale: 0n, writes: 0n, live: 0n }, seriesNotional: 0n,
      askFloors: { write: (spot * 50n) / 10_000n, resale: (spot * 50n) / 10_000n }, bidCap: spot / 10n,
      collateralAsset: U, collateralPerUnit: 10n ** 16n, mintFeePpm: 80,
      orders: [...book.values()].filter((o) => o.longId === info.longId),
    }));
    const fairs = new Map<string, FairInput>(series.map((info) => {
      const x = { type: 'call' as const, spot: Number(fairSpot) / 1e6, strike: Number(info.strike) / 1e6, vol: 0.5, t: tradingYears(now, info.expiry) };
      return [info.longId.toString(), { ok: true, fair: BigInt(Math.round(bsPrice(x) * 1e6)), delta: bsDelta(x), iv: 0.5, asOf: now - 5, source: 'model', spot: fairSpot, vega: bsVega(x) }];
    }));
    const input: TickInput = {
      now, sessionOpen: true, sessionClose: CLOSE, sessionOpenedAt: newYorkTimeToUnix(2026, 9, 23, 9) + 1_800, killed: false,
      lossStop: { day: Math.floor(now / 86_400), realised: 0n, limit: t.dailyLossLimitUsdg6, tripped: false }, lastSync: now - 60,
      vault: {
        isQuoter: true, quoterDelay: 0, tradingPaused: false, fees: { current: { premiumFeeBps: 500, resaleFeeBps: 0 }, pending: null },
        limits: { maxSeriesUnits: 30_000n, maxTotalNotional: 2n ** 128n - 1n, askToleranceBps: 0, maxBidBpsOfSpot: 1_000, maxOrderLifetime: 300, maxDailyOutflow: 2n ** 128n - 1n },
        outflow: { used: 0n, available: 2n ** 128n - 1n }, totalNotional: 0n, usdgWallet: 20_000_000_000n, usdgReserved: null, owed: 0n,
        freeCollateral: new Map([[U, 60n * 10n ** 18n]]), walletTokens: new Map([[U, 0n]]), tracked: [], epoch: null,
      },
      markets: new Map([[U, { underlying: U, ticker: 'NVDA', enabled: true, mintPaused: false, spot }]]),
      series: views, fairs, params: { ...mmPlanParams(c), maxSeries: 50, maxSeriesPerMarket: 50 },
      refreshS, replaceMarginS, bidCapAheadS, protocolAccounts: new Set<string>(), protocolBook: [],
    };
    const full = planTick(input);
    const due = routineSendDue(sendIntervalS, lastRoutine, now);
    // `legacy` replays the earlier engine.orderActions order (replaces, then places), so it still measures the loop
    // the earlier measurement ran; the planner's groups keep series priority, so a stable partition restores that order exactly.
    const txs = legacy ? legacyOrder(full) : full.txs;
    const sent = (due ? txs : txs.filter(isProtectiveTx)).slice(0, budget);
    for (const tx of sent) {
      counts.txs += 1;
      if (isProtectiveTx(tx)) counts.protective += 1;
      if (!due) counts.between += 1;
      if (tx.type === 'cancel') for (const id of tx.orderIds) book.get(id)!.cancelled = true;
      if (tx.type === 'replace') {
        counts.replace += 1;
        // The bound crossings, by bound (engine.judgeReplace's protective reasons): an ask under the spot-lag
        // floor, an ask under the vault's own floor of its kind, a bid over the spot-lag cap.
        if (tx.protective === true && tx.slot !== 'bid' && /below the spot-lag floor/.test(tx.reason)) counts.askUnderLag += 1;
        if (tx.protective === true && tx.slot !== 'bid' && /below the (write|resale) ask floor/.test(tx.reason)) counts.askUnderVault += 1;
        if (tx.protective === true && tx.slot === 'bid' && /above the spot-lag cap/.test(tx.reason)) counts.bidOverCap += 1;
        Object.assign(book.get(tx.orderId)!, { price: tx.price, units: tx.units });
      }
      if (tx.type === 'place') {
        if (/placed fresh, not replaced/.test(tx.reason)) counts.cancelPlace += 1;
        if (/refresh before validUntil/.test(tx.reason)) counts.refresh += 1;
        const id = nextId++;
        book.set(id, { id, longId: tx.longId, kind: kindOf[tx.kind]!, price: tx.price, units: tx.units, filled: 0n, validUntil: tx.validUntil, cancelled: false });
      }
    }
    if (due && sent.some((tx) => !isProtectiveTx(tx))) {
      lastRoutine = now;
      const live = [...book.values()].filter((o) => !o.cancelled && o.filled < o.units && now < o.validUntil && o.kind !== 'Bid');
      const quotable = full.series.filter((s) => s.halt === null && s.targets !== null && (s.targets.write !== null || s.targets.resale !== null));
      sends.push({ now, quotable: quotable.length, withAsk: quotable.filter((s) => live.some((o) => o.longId === s.longId)).length });
    }
  }
  const longestFull = sends.reduce((acc, s) => (s.withAsk === s.quotable ? { run: acc.run + 1, best: Math.max(acc.best, acc.run + 1) } : { run: 0, best: acc.best }), { run: 0, best: 0 }).best;
  const settled = sends.slice(2);
  const gaps = settled.map((s) => s.quotable - s.withAsk).sort((a, b) => a - b);
  return {
    sends, counts, longestFull,
    minWithAsk: Math.min(...settled.map((s) => s.withAsk)),
    minQuotable: Math.min(...sends.map((s) => s.quotable)),
    /** The most quotable series without a live ask on one routine send, after the first two (the initial fill). */
    worstGap: gaps[gaps.length - 1] ?? 0,
    medianGap: gaps[Math.floor(gaps.length / 2)] ?? 0,
    perMinute: counts.txs / ((reads * pollS) / 60),
  };
}

test('in process: at the rendered env every quotable series keeps a live ask for 10+ consecutive sends, requotes are replaces; the legacy loop leaves series dark', () => {
  const c = shipped();
  const READS = 80; // 20 minutes of 15 s reads
  const after = simulate(c, false, READS);
  assert.ok(after.minQuotable >= 45, `the setup: at least 45 of the 50 series are quotable at this spot (${after.minQuotable})`);
  assert.equal(after.sends.length, 20, 'one routine send a minute, as owner ruling 49 asks');
  assert.ok(after.longestFull >= 10, `every quotable series has a live ask on ${after.longestFull} consecutive routine sends (Done means 5 asks 10)`);
  assert.equal(after.counts.cancelPlace, 0, 'no requote is a cancel and a place: the replace margin is under the quote life');
  assert.ok(after.counts.replace > after.counts.cancelPlace, 'replaces outnumber cancel+place on the requote path');
  assert.ok(after.perMinute <= c.tuning.maxTxPerTick, `${after.perMinute.toFixed(1)} transactions a minute, within one budget a minute`);

  const legacy = simulate(c, true, READS);
  assert.ok(legacy.minWithAsk <= legacy.minQuotable - 15, `the legacy loop leaves series dark as T-OP-666 measured (at worst ${legacy.minWithAsk} of ${legacy.minQuotable})`);
  assert.equal(legacy.counts.replace, 0, 'legacy: the 195 s margin leaves no replace');
  assert.ok(legacy.counts.cancelPlace > 100, `legacy: every requote a cancel and a place (${legacy.counts.cancelPlace})`);
});

/**
 * The same loop with the /fair spot moving 6 bps per 15 s read and the oracle printing only on a 0.5 % move:
 * the case measured on a fork at 36-40 of 47 series with an ask and about 95 transactions a minute
 * Measured here before the fix (same loop, same seed): down 33/47 at worst and 119 tx/min, up
 * 27/49 and 60.5, walk 36/48 and 76.5. Neither fix alone closes it: the spot cushion alone (spot-lag.ts) cuts the
 * churn (down 56 tx/min) but leaves series dark (down 33/47); places before routine requotes alone (engine.orderActions)
 * lights them on most sends but not on a send that follows a jump (down 26/47, walk 21/48) and keeps the churn (down
 * 119.5). With both: every quotable series holds an ask on every routine send after the first fill, in every case.
 *
 * BREAK CHECK: set bidCushionBps to 0 in spot-lag.ts, or put the places back after every replace in
 * engine.orderActions, and the coverage assertion below goes red by the case's name.
 */
const MOVES: ReadonlyArray<{ name: string; move: SpotMove; maxPerMinute: number }> = [
  // Measured with both fixes: 59.5, 63.1 and 50.5 tx/min (46.5 with the spot still); the rise is 59.8 with the
  // ask cushion. Over the still case because a move needs quotes moved: a steady drift is ~2.4 sigma of the cushions'
  // horizon at iv 0.5, so bids still cross the cap (down) and asks their floors (up), and both corrections are
  // protective, sent on every read.
  { name: 'a steady 6 bps/read fall', move: { mode: 'down', bpsPerRead: 6 }, maxPerMinute: 65 },
  { name: 'a steady 6 bps/read rise', move: { mode: 'up', bpsPerRead: 6 }, maxPerMinute: 62 },
  { name: 'a seeded 6 bps/read walk', move: { mode: 'walk', bpsPerRead: 6, seed: 7 }, maxPerMinute: 55 },
];

test('with the /fair spot moving 6 bps a read (a fall, a rise or a walk), every quotable series holds an ask on every routine send after the first fill', () => {
  const c = shipped();
  const READS = 80; // 20 minutes of 15 s reads
  for (const { name, move, maxPerMinute } of MOVES) {
    const r = simulate(c, false, READS, move);
    assert.equal(r.sends.length, 20, `${name}: one routine send a minute`);
    assert.equal(
      r.worstGap,
      0,
      `${name}: ${r.worstGap} quotable series without a live ask on the worst routine send (${r.sends.slice(2).map((x) => `${x.withAsk}/${x.quotable}`).join(' ')})`,
    );
    assert.ok(r.perMinute <= maxPerMinute, `${name}: ${r.perMinute.toFixed(1)} transactions a minute, over ${maxPerMinute}`);
    assert.equal(r.counts.cancelPlace, 0, `${name}: requotes are replaces`);
  }
  const still = simulate(c, false, READS);
  assert.equal(still.worstGap, 0, 'the still spot: every quotable series holds an ask');
  assert.ok(still.perMinute <= 47, `the still spot stays at T-OP-700's rate: ${still.perMinute.toFixed(1)} a minute`);
});

/**
 * the ask side of the spot cushion, in the same loop. On a rising /fair spot every read lifts the spot-lag floor, and
 * every 0.5 % print lifts the vault's own ask floor (here the stand-in 0.5 % of the print, an out-of-the-money floor),
 * so an ask priced at either is under it one read later and is replaced as a protective send. Measured here before the
 * ask cushion (spot-lag.ts, THE ASK CUSHION): a 2, 3 and 4 bps/read rise sent 67, 90 and 119 protective ask replaces in
 * 20 minutes (59.1, 59.1 and 60.9 tx/min); a 6 bps/read rise 187 (57 spot-lag, 130 vault floor; 63.1 tx/min). After:
 * none at 2-4 bps/read (55.5-55.8 tx/min) and 79 at 6 (40 and 39; 59.8 tx/min). 4 bps/read is about 1.6 sigma of the
 * cushion's 150 s horizon at iv 0.5, 6 bps/read about 2.4: past one sigma a floor is still crossed, and replaced at once.
 * The fall, the walk and the still spot are the cases above, unchanged to the transaction.
 *
 * BREAK CHECK: drop lag.askAhead from withSpotLag's two most() calls in spot-lag.ts and the 2 bps/read case goes
 * red by name.
 */
test('with the /fair spot rising 2-4 bps a read no ask is replaced for crossing a floor, and a 6 bps/read rise replaces fewer than half as many', () => {
  const c = shipped();
  const READS = 80; // 20 minutes of 15 s reads
  for (const bps of [2, 3, 4]) {
    const r = simulate(c, false, READS, { mode: 'up', bpsPerRead: bps });
    const name = `a steady ${bps} bps/read rise`;
    assert.equal(
      r.counts.askUnderLag + r.counts.askUnderVault,
      0,
      `${name}: ${r.counts.askUnderLag} asks replaced under the spot-lag floor and ${r.counts.askUnderVault} under the vault's floor in 20 minutes`,
    );
    assert.equal(r.worstGap, 0, `${name}: every quotable series holds an ask on every routine send after the first fill`);
    assert.ok(r.perMinute <= 57, `${name}: ${r.perMinute.toFixed(1)} transactions a minute, over 57`);
  }
  const steep = simulate(c, false, READS, { mode: 'up', bpsPerRead: 6 });
  const crossed = steep.counts.askUnderLag + steep.counts.askUnderVault;
  assert.ok(crossed <= 93, `a steady 6 bps/read rise: ${crossed} protective ask replaces in 20 minutes (${steep.counts.askUnderLag} spot-lag, ${steep.counts.askUnderVault} vault floor), over half of the 187 before`);
  assert.equal(steep.worstGap, 0, 'a steady 6 bps/read rise: every quotable series holds an ask');
});
