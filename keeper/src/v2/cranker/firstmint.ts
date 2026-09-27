/**
 * Step `firstmint`: the first mint of each fresh expiry, made into the keeper's own EOA, so that no
 * heavy-hook receiver ever pays the expiry's settlement pin.
 *
 * WHY. In the v9 contracts the FIRST MINT of an (underlying, expiry) pins its settlement sources
 * (Clearinghouse.mint -> SettlementOracle.pin; createSeries no longer pins). A mint the book delivers runs under
 * OrderBook DELIVERY_GAS (500,000), and one that runs out of it is a skipped fill: nothing lost, the pin rolls back.
 * Measured on a 4663 fork with the v9 rehearsal state (evidence): an EarnVault bid (16 bids resting) as the
 * FIRST fill of a fresh expiry is skipped; the same fill after an EOA fill pinned the expiry goes through. So
 * something light must take first. This step does: for each live-market expiry this Clearinghouse has not pinned, it
 * buys ONE unit (0.01 share) of the cheapest AskWrite into the keeper's own account.
 *
 * BOUNDED. A take names at most FIRST_MINT_MAX_ORDER_IDS asks of one series with `limitPrice` their dearest price and
 * `maxTotalFee` the taker fee's compiled ceiling at that price, so the book can charge no more than
 * firstMintCost(limitPrice). Spend is kept per UTC day in store meta and a take that would cross FIRST_MINT_DAILY_CAP
 * is not sent; nor is one dearer than FIRST_MINT_MAX_COST. At most FIRST_MINT_MAX_PER_TICK sends per tick.
 *
 * IDEMPOTENT. An expiry whose `pinnedBy` is this Clearinghouse is never taken again: read every tick at the head, and
 * again (`isAdvanced`, at the latest block) just before each send. `minUnits` 1 makes a take the book would fill
 * nothing of revert in simulation, so a skipped fill is never paid for.
 *
 * NEVER A CONTRACT RECIPIENT. The recipient is the keeper's own account, and the step refuses to run at all while that
 * account has code (an EIP-7702 delegation included): a contract there is exactly the receiver this step exists to
 * keep away from the pin.
 *
 * FUNDING (operator). The keeper account needs a USDG float of at least FIRST_MINT_MAX_COST and gas. The step
 * approves the OrderBook for FIRST_MINT_DAILY_CAP (not unlimited) the first time an allowance is short; a balance
 * short of a take pages `v2_first_mint` and sends nothing.
 */
import { parseAbi, type Address } from 'viem';
import { orderBookAbi } from '../abi/orderBook.js';
import { settlementOracleAbi } from '../abi/settlementOracle.js';
import type { ReadOutcome } from '../chain.js';
import { marketByUnderlying, v2Markets } from '../registry.js';
import {
  BPS,
  FIRST_MINT_CUTOFF_MARGIN_S,
  FIRST_MINT_DAILY_CAP,
  FIRST_MINT_DEADLINE_S,
  FIRST_MINT_MAX_COST,
  FIRST_MINT_MAX_ORDER_IDS,
  FIRST_MINT_MAX_PER_TICK,
  FIRST_MINT_NO_ASK_ALERT_S,
  FIRST_MINT_ORDER_SCAN,
  GAS,
  SETTLEMENT_WINDOW,
  TAKER_FEE_CAP_CEIL_BPS,
  UNITS_PER_SHARE,
} from './constants.js';
import { advanced, type CrankOutcome } from './effects.js';
import { pinGroupKey } from './planner.js';
import { okResult, readMany } from './reads.js';
import { Budget, head, newReport, send, type CrankContext, type StepReport } from './steps.js';

const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

/** OrderBook OrderKind.AskWrite: the only kind whose fill mints (an AskResale moves an existing long). */
const ASK_WRITE = 2;

/** The alert kind every first-mint page goes out under; each cause carries its own severity. */
export const FIRST_MINT_ALERT = 'v2_first_mint';
/** The journal kind of a first-mint take (one key per pin group, so an unmined take blocks its own resend only). */
export const FIRST_MINT_KIND = 'firstmint';

/** USDG spent by the step on one UTC day (`YYYY-MM-DD` of the head), base units as a decimal string. */
export const firstMintSpentMetaKey = (day: string) => `cranker:first-mint:spent:${day}`;

export const utcDay = (timestamp: number): string => new Date(timestamp * 1000).toISOString().slice(0, 10);

/** The mint cutoff of an expiry (IClearinghouse.mintCutoff): a mint at or past it reverts PastCutoff. */
export const mintCutoff = (expiry: number): number => expiry - SETTLEMENT_WINDOW;

export interface FirstMintAsk {
  orderId: bigint;
  longId: bigint;
  maker: Address;
  kind: number;
  /** USDG base units per share. */
  price: bigint;
  units: bigint;
  filled: bigint;
  validUntil: number;
  cancelled: boolean;
}

export type FirstMintPlan =
  /** `pinnedBy` is this Clearinghouse: a mint only reads the slot. Nothing to do, ever again. */
  | { action: 'pinned' }
  /** Too close to the mint cutoff for a take to land before it. */
  | { action: 'past-cutoff' }
  /** No live AskWrite from another maker on any series of the expiry. */
  | { action: 'no-ask' }
  /** Asks exist, but the cheapest costs more than this take may spend (`bound`: the day's cap left, or the per-take cap). */
  | { action: 'over-cap'; cheapest: bigint; bound: bigint }
  | { action: 'take'; longId: bigint; orderIds: bigint[]; limitPrice: bigint; maxTotalFee: bigint; maxCost: bigint };

/**
 * The most a ONE-unit take at `limitPrice` can cost: OptionMath.premium (price * units / UNITS_PER_SHARE, floored) and
 * the taker fee at its compiled ceiling (min(flat, premium * capBps / BPS) <= premium * TAKER_FEE_CAP_CEIL_BPS / BPS).
 */
export function firstMintCost(limitPrice: bigint): { premium: bigint; fee: bigint; total: bigint } {
  const premium = limitPrice / UNITS_PER_SHARE;
  const fee = (premium * TAKER_FEE_CAP_CEIL_BPS) / BPS;
  return { premium, fee, total: premium + fee };
}

/**
 * What the step does for one (oracle, underlying, expiry). Pure.
 *
 * `pinnedBy` other than this Clearinghouse (zero, or a Clearinghouse the oracle has since superseded) is NOT pinned:
 * this Clearinghouse's next mint runs the pin's write path either way, and that is the cost this step exists to pay.
 * An ask qualifies when it is a live AskWrite (not cancelled, units left, valid past the take's deadline) from a maker
 * other than the keeper (the book skips a self-fill) at a positive price whose one-unit cost fits both the day's cap
 * left and FIRST_MINT_MAX_COST. The series of the cheapest qualifying ask is taken, naming its cheapest asks first.
 */
export function planFirstMint(input: {
  expiry: number;
  pinnedBy: Address;
  clearinghouse: Address;
  asks: readonly FirstMintAsk[];
  now: number;
  keeper: Address;
  capLeft: bigint;
  maxCost?: bigint;
}): FirstMintPlan {
  if (input.pinnedBy.toLowerCase() === input.clearinghouse.toLowerCase()) return { action: 'pinned' };
  if (input.now >= mintCutoff(input.expiry) - FIRST_MINT_CUTOFF_MARGIN_S) return { action: 'past-cutoff' };
  const keeper = input.keeper.toLowerCase();
  const live = input.asks
    .filter((a) => a.kind === ASK_WRITE && !a.cancelled && a.filled < a.units && a.validUntil > input.now + FIRST_MINT_DEADLINE_S && a.maker.toLowerCase() !== keeper && a.price > 0n)
    .sort((a, b) => (a.price === b.price ? (a.orderId < b.orderId ? -1 : 1) : a.price < b.price ? -1 : 1));
  if (live.length === 0) return { action: 'no-ask' };
  const perTake = input.maxCost ?? FIRST_MINT_MAX_COST;
  const bound = input.capLeft < perTake ? input.capLeft : perTake;
  const affordable = live.filter((a) => firstMintCost(a.price).total <= bound);
  if (affordable.length === 0) return { action: 'over-cap', cheapest: firstMintCost(live[0]!.price).total, bound };
  const longId = affordable[0]!.longId;
  const named = affordable.filter((a) => a.longId === longId).slice(0, FIRST_MINT_MAX_ORDER_IDS);
  const limitPrice = named.at(-1)!.price;
  const cost = firstMintCost(limitPrice);
  return { action: 'take', longId, orderIds: named.map((a) => a.orderId), limitPrice, maxTotalFee: cost.fee, maxCost: cost.total };
}

interface OrderStruct {
  maker: Address;
  longId: bigint;
  kind: number;
  price: bigint;
  units: bigint;
  filled: bigint;
  validUntil: number;
  cancelled: boolean;
}

function must<T>(o: ReadOutcome<unknown> | undefined, what: string): T {
  if (o === undefined) throw new Error(`${what}: no result`);
  if (!o.ok) throw new Error(`${what}: ${o.error.message.split('\n')[0]}`);
  return o.result as T;
}

/**
 * The newest FIRST_MINT_ORDER_SCAN orders of each series, with their prices (reads.ts OrderView carries none). A
 * failed read throws: the step fails this tick and runs again next tick, rather than reading "no ask".
 */
async function readAsks(ctx: CrankContext, longIds: readonly bigint[], blockNumber: bigint): Promise<FirstMintAsk[]> {
  if (longIds.length === 0) return [];
  const ob = ctx.addresses.orderBook;
  const counts = await readMany(ctx.client, longIds.map((id) => ({ address: ob, abi: orderBookAbi, functionName: 'seriesOrderCount', args: [id] })), blockNumber);
  const pages = longIds
    .map((id, i) => ({ id, count: must<bigint>(counts[i], `seriesOrderCount(${id})`) }))
    .filter((p) => p.count > 0n)
    .map((p) => ({ id: p.id, cursor: p.count > FIRST_MINT_ORDER_SCAN ? p.count - FIRST_MINT_ORDER_SCAN : 0n }));
  if (pages.length === 0) return [];
  const listed = await readMany(ctx.client, pages.map((p) => ({ address: ob, abi: orderBookAbi, functionName: 'ordersOfSeries', args: [p.id, p.cursor, FIRST_MINT_ORDER_SCAN] })), blockNumber);
  const ids = pages.flatMap((p, i) => [...must<[readonly bigint[], bigint]>(listed[i], `ordersOfSeries(${p.id})`)[0]]);
  const slices: bigint[][] = [];
  for (let i = 0; i < ids.length; i += 200) slices.push(ids.slice(i, i + 200));
  const out = await readMany(ctx.client, slices.map((slice) => ({ address: ob, abi: orderBookAbi, functionName: 'getOrders', args: [slice] })), blockNumber);
  return slices.flatMap((slice, i) => {
    const orders = must<OrderStruct[]>(out[i], 'getOrders');
    return slice.map((orderId, j) => {
      const o = orders[j]!;
      return { orderId, longId: BigInt(o.longId), maker: o.maker, kind: Number(o.kind), price: BigInt(o.price), units: BigInt(o.units), filled: BigInt(o.filled), validUntil: Number(o.validUntil), cancelled: o.cancelled };
    });
  });
}

/** USDG the take moved: the simulated (premium, takerFee) of a confirmed take, else the bound it was sent under. */
function spentBy(outcome: CrankOutcome, maxCost: bigint): bigint {
  if (outcome.status === 'confirmed') {
    const r = outcome.result as readonly [bigint, bigint, bigint] | undefined;
    if (Array.isArray(r) && typeof r[1] === 'bigint' && typeof r[2] === 'bigint') return r[1] + r[2];
    return maxCost;
  }
  // Broadcast with no receipt yet: it may still land, so it counts at its bound.
  if (outcome.status === 'unconfirmed') return maxCost;
  return 0n;
}

export async function stepFirstMint(ctx: CrankContext, usdg: Address): Promise<StepReport> {
  const report = newReport('firstmint');
  // GATE FIRST, before any read: the operator's off switch for this step only, for the time a
  // setMarket / setFeed / setPool repair is scheduled. Said once per tick, so a switch left off is visible in the log.
  if (!ctx.config.tuning.firstMintEnabled) {
    ctx.log.warn({ step: 'firstmint' }, 'firstmint is disabled (CRANKER_FIRSTMINT_ENABLED=0): no first mint is taken this tick; every other step runs');
    report.notes = { skipped: 'disabled' };
    return report;
  }
  const budget = new Budget(Math.min(FIRST_MINT_MAX_PER_TICK, ctx.config.tuning.maxTxPerStep), ctx.yieldWhen);
  const h = await head(ctx);
  const now = h.timestamp;
  const ch = ctx.addresses.clearinghouse;
  const keeper = ctx.sender.account;
  const live = new Set(v2Markets(ctx.config.registry, ['live']).map((m) => m.underlying.toLowerCase()));
  const done = ctx.index.doneExpiries();
  const groups = ctx.index
    .expiries()
    .filter((g) => live.has(g.underlying.toLowerCase()) && !done.has(`${g.oracle}:${g.underlying}:${g.expiry}`) && now < mintCutoff(g.expiry));
  if (groups.length === 0) {
    report.notes = { groups: [], reason: 'no upcoming expiry of a live market in the index' };
    return report;
  }

  const pins = await readMany(ctx.client, groups.map((g) => ({ address: g.oracle as Address, abi: settlementOracleAbi, functionName: 'pinnedBy', args: [g.underlying, g.expiry] })), h.blockNumber);
  const day = utcDay(now);
  let spent = BigInt(ctx.store.getMeta(firstMintSpentMetaKey(day)) ?? '0');
  const notes: Array<Record<string, unknown>> = [];
  const open: Array<{ g: (typeof groups)[number]; key: string; ticker: string; pinnedBy: Address }> = [];
  groups.forEach((g, i) => {
    const key = pinGroupKey(g.oracle, g.underlying, g.expiry);
    const ticker = marketByUnderlying(ctx.config.registry, g.underlying)?.ticker ?? g.underlying;
    const pinnedBy = okResult<Address>(pins[i]);
    if (pinnedBy === undefined) notes.push({ ticker, expiry: g.expiry, action: 'unreadable' });
    else if (pinnedBy.toLowerCase() === ch.toLowerCase()) notes.push({ ticker, expiry: g.expiry, action: 'pinned' });
    else open.push({ g, key, ticker, pinnedBy });
  });
  const summary = () => ({ day, spent: spent.toString(), cap: FIRST_MINT_DAILY_CAP.toString(), keeper, groups: notes });
  if (open.length === 0) {
    report.notes = { ...summary(), pinnedThisTick: 0, spentThisTick: '0' };
    return report;
  }

  // The recipient is this account: a contract there is the heavy receiver the step exists to keep off the pin.
  const code = await ctx.client.getCode({ address: keeper, blockNumber: h.blockNumber });
  if (code !== undefined && code !== '0x') {
    await ctx.alerts.raise({
      kind: FIRST_MINT_ALERT,
      dedupeKey: 'keeper-code',
      once: false,
      severity: 'error',
      message: `cranker firstmint: the keeper account ${keeper} has code, so the step takes nothing into it (a contract recipient is what it exists to avoid). ${open.length} expiry(ies) stay unpinned until a light taker mints first`,
      data: { keeper, unpinned: open.map((o) => ({ ticker: o.ticker, expiry: o.g.expiry })) },
    });
    for (const o of open) notes.push({ ticker: o.ticker, expiry: o.g.expiry, action: 'refused', reason: 'keeper account has code' });
    report.notes = { ...summary(), pinnedThisTick: 0, spentThisTick: '0' };
    return report;
  }

  const asks = await readAsks(ctx, open.flatMap((o) => ctx.index.seriesOf(o.g.underlying, o.g.expiry, o.g.oracle).map((s) => s.longId)), h.blockNumber);
  const funds = await readMany(
    ctx.client,
    [
      { address: usdg, abi: erc20Abi, functionName: 'balanceOf', args: [keeper] },
      { address: usdg, abi: erc20Abi, functionName: 'allowance', args: [keeper, ctx.addresses.orderBook] },
    ],
    h.blockNumber,
  );
  let balance = must<bigint>(funds[0], 'USDG.balanceOf(keeper)');
  let allowance = must<bigint>(funds[1], 'USDG.allowance(keeper, orderBook)');
  let pinnedThisTick = 0;
  let spentThisTick = 0n;

  for (const o of open) {
    const longIds = new Set(ctx.index.seriesOf(o.g.underlying, o.g.expiry, o.g.oracle).map((s) => s.longId));
    const capLeft = spent >= FIRST_MINT_DAILY_CAP ? 0n : FIRST_MINT_DAILY_CAP - spent;
    const plan = planFirstMint({ expiry: o.g.expiry, pinnedBy: o.pinnedBy, clearinghouse: ch, asks: asks.filter((a) => longIds.has(a.longId)), now, keeper, capLeft });
    const note: Record<string, unknown> = { ticker: o.ticker, expiry: o.g.expiry, action: plan.action };
    notes.push(note);
    if (plan.action === 'no-ask') {
      if (now >= mintCutoff(o.g.expiry) - FIRST_MINT_NO_ASK_ALERT_S) {
        await ctx.alerts.raise({
          kind: FIRST_MINT_ALERT,
          dedupeKey: `no-ask:${o.key}`,
          once: true,
          severity: 'warn',
          message: `cranker firstmint: ${o.ticker} ${new Date(o.g.expiry * 1000).toISOString()} is still unpinned within ${FIRST_MINT_NO_ASK_ALERT_S / 3600} h of its mint cutoff and has no AskWrite the keeper can buy. Its first fill pins it; one into a heavy-hook receiver (the EarnVault) is skipped until a light taker mints first`,
          data: { ticker: o.ticker, underlying: o.g.underlying, expiry: o.g.expiry },
        });
      }
      continue;
    }
    if (plan.action === 'over-cap') {
      note.cheapest = plan.cheapest.toString();
      note.bound = plan.bound.toString();
      await ctx.alerts.raise({
        kind: FIRST_MINT_ALERT,
        dedupeKey: `over-cap:${day}:${o.key}`,
        once: true,
        severity: 'warn',
        message: `cranker firstmint: the cheapest ask on ${o.ticker} ${new Date(o.g.expiry * 1000).toISOString()} costs ${plan.cheapest} USDG base units for one unit, over this take's bound of ${plan.bound} (per take ${FIRST_MINT_MAX_COST}, per day ${FIRST_MINT_DAILY_CAP}, ${spent} spent today). The expiry stays unpinned`,
        data: { ticker: o.ticker, expiry: o.g.expiry, cheapest: plan.cheapest.toString(), bound: plan.bound.toString(), spent: spent.toString() },
      });
      continue;
    }
    if (plan.action !== 'take') continue;
    Object.assign(note, { longId: plan.longId.toString(), orderIds: plan.orderIds.map(String), limitPrice: plan.limitPrice.toString(), maxCost: plan.maxCost.toString() });
    if (!budget.left) {
      note.action = 'deferred';
      note.reason = 'budget';
      continue;
    }
    if (balance < plan.maxCost) {
      note.action = 'unfunded';
      await ctx.alerts.raise({
        kind: FIRST_MINT_ALERT,
        dedupeKey: 'balance',
        once: false,
        severity: 'warn',
        message: `cranker firstmint: the keeper account ${keeper} holds ${balance} USDG base units, under the ${plan.maxCost} a first mint of ${o.ticker} ${new Date(o.g.expiry * 1000).toISOString()} may cost. Fund it with USDG (the step spends at most ${FIRST_MINT_DAILY_CAP} a day)`,
        data: { keeper, balance: balance.toString(), need: plan.maxCost.toString(), ticker: o.ticker, expiry: o.g.expiry },
      });
      continue;
    }
    if (allowance < plan.maxCost) {
      const approved = await send(ctx, report, budget, `approve the OrderBook for ${FIRST_MINT_DAILY_CAP} USDG base units (first mint)`, { address: usdg, abi: erc20Abi, functionName: 'approve', args: [ctx.addresses.orderBook, FIRST_MINT_DAILY_CAP], gas: GAS.usdgApprove }, {
        kind: 'firstmint-approve',
        key: ctx.addresses.orderBook.toLowerCase(),
      });
      if (!advanced(approved)) {
        note.action = 'approve-failed';
        note.status = approved.status;
        continue;
      }
      allowance = FIRST_MINT_DAILY_CAP;
      if (!budget.left) {
        note.action = 'deferred';
        note.reason = 'budget';
        continue;
      }
    }
    const outcome = await send(
      ctx,
      report,
      budget,
      `first mint of ${o.ticker} ${o.g.expiry}: take 1 unit of ${plan.longId} into the keeper`,
      {
        address: ctx.addresses.orderBook,
        abi: orderBookAbi,
        functionName: 'take',
        args: [{ longId: plan.longId, buying: true, orderIds: plan.orderIds, units: 1n, minUnits: 1n, limitPrice: plan.limitPrice, writeToSell: false, recipient: keeper, deadline: now + FIRST_MINT_DEADLINE_S, maxTotalFee: plan.maxTotalFee }],
        gas: GAS.firstMintTake,
      },
      {
        kind: FIRST_MINT_KIND,
        key: o.key,
        // Pinned since the head read (another taker, or an earlier take of ours that landed): send nothing.
        isAdvanced: async () =>
          ((await ctx.client.readContract({ address: o.g.oracle as Address, abi: settlementOracleAbi, functionName: 'pinnedBy', args: [o.g.underlying as Address, o.g.expiry] })) as Address).toLowerCase() === ch.toLowerCase(),
        worthSending: (r) => Array.isArray(r) && typeof r[0] === 'bigint' && r[0] >= 1n,
      },
    );
    note.status = outcome.status;
    if (advanced(outcome)) pinnedThisTick += 1;
    if (ctx.sender.dryRun) continue;
    const cost = spentBy(outcome, plan.maxCost);
    if (cost > 0n) {
      spent += cost;
      spentThisTick += cost;
      balance -= cost;
      allowance -= cost;
      ctx.store.setMeta(firstMintSpentMetaKey(day), spent.toString());
    }
  }
  report.notes = { ...summary(), pinnedThisTick, spentThisTick: spentThisTick.toString() };
  return report;
}
