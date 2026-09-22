#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * ops/devnet/seed.mjs — puts a realistic market on a freshly deployed devnet (ops/devnet/up.sh).
 *
 *   node ops/devnet/seed.mjs trade     fund the five dev wallets, approvals, collateral, the weekly and
 *                                      daily ladders (registry defaults), write-on-fill asks at several
 *                                      prices, bids, buys of 1 / 10 / 100 / 350 units, a sale into a bid
 *                                      from inventory and one by minting, one resale ask; plus one deep
 *                                      ITM NVDA call on the first daily expiry, bought by three wallets;
 *                                      with the periphery deployed, the AutoRoller writer setup and strategy
 *                                      (ben), one small swap each way through SwapRouter02 (PayoutAdapter
 *                                      route warm-up) and the MakerVault's funding and Clearinghouse deposit
 *   node ops/devnet/seed.mjs warm      one Multicall3 TRANSACTION reading the Stock Tokens, USDG, the
 *                                      real feeds and the pools, so a state dump taken next carries them
 *   node ops/devnet/seed.mjs session   inside a regular session before the first daily expiry (warping to
 *                                      the next one when the chain is outside a session): fresh mock-feed
 *                                      rounds, the AutoRoller roll of ben's strategy, and a MakerVault
 *                                      AskWrite + Bid on NVDA weekly1-r0 (skipped without those contracts)
 *   node ops/devnet/seed.mjs settle    session, then warp past the first daily expiry, write the settlement
 *                                      window into the mock feeds (NVDA at the pool's price so both sources agree),
 *                                      snapshot, finalize (NVDA final, TSLA a pending candidate), settle
 *                                      every NVDA series of that expiry, prune its orders, redeem holders
 *                                      (longs, then shorts) except Eve's 1-unit winning long for browser
 *                                      Collect (other ITM longs convert through the PayoutAdapter); then gate
 *   node ops/devnet/seed.mjs summary   recompute and print the summary from the chain's logs, gate it
 *   node ops/devnet/seed.mjs all       trade, warm, session, settle (what up.sh runs when it does not detach)
 *
 * Reads ops/devnet/addresses.json (written by up.sh from DevDeploy's output) and the market registry
 * (ops/markets/dev.json `v2.defaults` for the ladders); writes what it did under `seed` in
 * addresses.json. Environment: DEVNET_PORT (8546) or DEVNET_RPC, DEVNET_ADDRESSES.
 *
 * GATES (exit 1 when any fails): >= 10 series, >= 20 orders, >= 10 fills, and at least one settled
 * in-the-money series with >= 2 long holders redeemed for a non-zero payout. For each periphery contract
 * the devnet has: AutoRoller >= 1 active strategy whose roll order is live; MakerVault >= 2 live quotes
 * (and the book's maker registry is the devnet's); PayoutAdapter set on the Clearinghouse with a route for
 * every market with a pool, and >= 1 ITM call long redeemed in USDG through it.
 *
 * PERIPHERY (C2-09 AutoRoller, C2-10 UniV3PayoutAdapter, C2-11 MakerVault/MakerRegistry/RewardsDistributor).
 * DevDeploy deploys them by default (DEV_AUTO_ROLLER / DEV_PAYOUT_ADAPTER / DEV_MAKER_SUITE = 0 switches
 * one off; addresses.json then carries null). A contract that is null is skipped here, never faked, and its
 * gates do not apply. Their ABIs come from ops/abis/v2 or, until exported there, from the forge artifacts
 * under CONTRACTS_DIR (lib.mjs abiOf).
 * ------------------------------------------------------------------------------------------------- */
import {
  ABI, ADDRESSES_FILE, WALLETS, deal, devAccounts, die, loadAddresses, now, nyTime, pub, read, registry, rpc, send,
  sentCount, usd, viem, warpTo, writeJson,
} from "./lib.mjs";

const { encodeFunctionData, getAddress, parseAbi, maxUint256 } = viem;

/**
 * Is the deployed `payoutAdapter` actually a v8 PayoutRouter?
 *
 * On this devnet it is not: `script/v2/DevDeploy.s.sol:507` still deploys the v7
 * `UniV3PayoutAdapter` for that key, and `routes(address)` KEPT its selector `0xd7409659` while its
 * return type changed from `(address pool, uint24 fee)` to the 5-field
 * `Route {venue, fee, tickSpacing, v3Pool, feeBps}`.
 *
 * WHICH DIRECTION IS DANGEROUS, measured rather than reasoned (viem 2.56.3, both directions decoded
 * at this base):
 *   - v8 ABI over v7 data THROWS. The v8 `Route` is five STATIC words, so the decoder needs 160
 *     bytes and a v7 return supplies 64: `PositionOutOfBoundsError: Position 95 is out of bounds
 *     (0 < position < 64)`. Loud, and it is the direction this devnet is in.
 *   - v7 ABI over v8 data is the SILENT one: it reads `venue = 1` as the address
 *     `0x...0001` and the `fee` word as 3000, and returns them without complaint. Demonstrated at
 *     `web/lib/v2/conversion.test.ts:36-43`.
 * Every consumer ABI in this repo is v8-only -- `web/lib/abi/v2/payoutAdapter.ts`,
 * `keeper/src/v2/abi/payoutAdapter.ts` and `indexer/abis/v2/payoutAdapter.ts` are all generated from
 * `ops/abis/v2/PayoutRouter.json` and none carries the two-field return. So the exposure here is a
 * THROWN read, not a plausible wrong number.
 *
 * Every caller of `routes()` needs this guard, not just the first one found: the trade step and the
 * settlement summary both read it, and guarding one left the other to die on the same value.
 * Swapping the ABI back to `UniV3PayoutAdapter.json` is NOT the fix -- that hides the version gap
 * rather than reporting it. C8-10 / T-156 replace the deployment; the probe is `authority()`,
 * because `PayoutRouter` is `Managed` and the v7 adapter predates `Managed`.
 */
let payoutIsV8Cache;
async function payoutRouterIsV8(address) {
  if (!address) return false;
  if (payoutIsV8Cache === undefined) {
    try {
      await read(address, parseAbi(["function authority() view returns (address)"]), "authority");
      payoutIsV8Cache = true;
    } catch {
      payoutIsV8Cache = false;
    }
  }
  return payoutIsV8Cache;
}

const PRICE_TICK = 100n;
const USDG_PER_WALLET = 1_000_000n * 10n ** 6n;
const SHARES_PER_WALLET = 1_000n * 10n ** 18n;
/** Implied vols for the seeded ask prices only (Black-Scholes); nothing on chain reads them. */
const IV = { NVDA: 0.55, TSLA: 0.65 };
/** A seeded ask is never below 0.10 USDG per share (the v1 registry's minAskUsdg6). */
const MIN_ASK = 100_000n;

const GATES = { series: 10, orders: 20, fills: 10, itmRedeemedHolders: 2, activeRolls: 1, vaultQuotes: 2, convertedRedemptions: 1 };

/** C2-09: ben's AutoRoller strategy: weekly calls 5 % OTM, asks at 0.60 % of spot, pricer band 0.30-1.50 %, 10 shares. */
const ROLL_WRITER = "ben";
const ROLL_STRATEGY = { active: true, weekly: true, smartPricing: true, otmBps: 500, askBps: 60, minAskBps: 30, maxAskBps: 150, maxUnits: 1_000n };
const ROLL_COLLATERAL = 20n * 10n ** 18n;
/** C2-10: route warm-up swaps (the NVDA side goes through the adapter itself). */
const SWAP_NVDA_IN = 5n * 10n ** 17n;
const SWAP_USDG_IN = 100n * 10n ** 6n;
/** C2-11: the vault's treasury (all its NVDA goes to its Clearinghouse ledger as write collateral) and its quotes. */
const VAULT_USDG = 100_000n * 10n ** 6n;
const VAULT_NVDA = 100n * 10n ** 18n;
const VAULT_QUOTE_TAG = "weekly1-r0";
const VAULT_ASK_UNITS = 500n;
const VAULT_BID_UNITS = 300n;
/** NY regular session length, seconds (09:30-16:00). */
const SESSION_S = 23_400;
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const step = (s) => process.stdout.write(`\n== ${s}\n`);
const info = (s) => process.stdout.write(`  ${s}\n`);

/* ---------------------------------------------------------------------------------------------- */
/*  prices                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

function ncdf(x) {
  // Abramowitz-Stegun 26.2.17
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

/** Black-Scholes call, USDG base units per share, r = 0. */
function callFair(spot6, strike6, secondsToExpiry, sigma) {
  const S = Number(spot6);
  const K = Number(strike6);
  const T = Math.max(secondsToExpiry, 3600) / (365 * 86400);
  const v = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (v * v) / 2) / v;
  return S * ncdf(d1) - K * ncdf(d1 - v);
}

const toTick = (x) => {
  const v = (BigInt(Math.max(0, Math.round(x))) / PRICE_TICK) * PRICE_TICK;
  return v < PRICE_TICK ? PRICE_TICK : v;
};
const scale = (price, factor) => toTick(Number(price) * factor);
const roundUp = (x, tick) => ((x + tick - 1n) / tick) * tick;
const roundDown = (x, tick) => (x / tick) * tick;

/* ---------------------------------------------------------------------------------------------- */
/*  registry defaults                                                                              */
/* ---------------------------------------------------------------------------------------------- */

/** registry v2.defaults with the market's overrides applied (keeper/src/v2/registry.ts rule). */
function paramsFor(reg, ticker) {
  const d = reg.v2?.defaults ?? {};
  const row = reg.markets.find((m) => m.ticker === ticker);
  const o = row?.v2?.overrides ?? {};
  const ladder = (tenor) => ({ ...(d.ladder?.[tenor] ?? {}), ...(o.ladder?.[tenor] ?? {}) });
  return {
    ladder: { weekly: ladder("weekly"), daily: ladder("daily") },
    expiriesAhead: { ...(d.expiriesAhead ?? {}), ...(o.expiriesAhead ?? {}) },
    strikeTick: BigInt(row?.v2?.strikeTick ?? "2500000"),
  };
}

/* ---------------------------------------------------------------------------------------------- */
/*  trade                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

async function trade() {
  const A = loadAddresses();
  const acct = await devAccounts();
  const reg = registry();
  const C = A.contracts;
  const usdg = A.usdg;
  const byTicker = Object.fromEntries(A.markets.map((m) => [m.ticker, m]));
  const NVDA = byTicker.NVDA;
  const TSLA = byTicker.TSLA;
  if (!NVDA || !TSLA) die("addresses.json must list the NVDA and TSLA markets");
  const whales = [...new Set(reg.markets.map((m) => m.v2?.univ3Pool).filter(Boolean).map((a) => getAddress(a)))];

  step("fund the five dev wallets (1,000,000 USDG, 1,000 NVDA, 1,000 TSLA each)");
  for (const w of WALLETS) {
    const how = [];
    how.push(await deal(usdg, acct[w], USDG_PER_WALLET, whales));
    for (const m of A.markets) how.push(await deal(m.underlying, acct[w], SHARES_PER_WALLET, whales));
    info(`${w.padEnd(4)} ${acct[w]}  (${[...new Set(how)].join(", ")})`);
  }

  step("approvals: USDG and the Stock Tokens to the Clearinghouse, USDG to the book, the book as operator and ERC-1155 spender");
  for (const w of WALLETS) {
    const from = acct[w];
    await send(from, { address: usdg, abi: ABI.erc20, functionName: "approve", args: [C.clearinghouse, maxUint256], label: `${w} USDG approve ch` });
    await send(from, { address: usdg, abi: ABI.erc20, functionName: "approve", args: [C.orderBook, maxUint256], label: `${w} USDG approve book` });
    for (const m of A.markets) {
      await send(from, { address: m.underlying, abi: ABI.erc20, functionName: "approve", args: [C.clearinghouse, maxUint256], label: `${w} ${m.ticker} approve` });
    }
    await send(from, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "setOperator", args: [C.orderBook, true], label: `${w} setOperator` });
    await send(from, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "setApprovalForAll", args: [C.orderBook, true], label: `${w} setApprovalForAll` });
  }

  step("writers deposit collateral (calls lock the Stock Token)");
  for (const w of ["ada", "ben"]) {
    for (const [m, shares] of [[NVDA, 200n], [TSLA, 100n]]) {
      await send(acct[w], { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "deposit", args: [m.underlying, shares * 10n ** 18n, acct[w]], label: `${w} deposit ${m.ticker}` });
      info(`${w} deposited ${shares} ${m.ticker}`);
    }
  }

  step("series: daily and weekly ladders from registry v2.defaults, plus one ITM NVDA call");
  const t0 = await now();
  const next = (after, weekly) => read(C.expiryCalendar, ABI.calendar, "nextExpiry", [after, weekly]).then(Number);
  // createSeries needs expiry >= now + MIN_SERIES_LEAD (1 h); 5 minutes of slack for the blocks this takes.
  const firstDaily = await next(t0 + 3600 + 300, false);
  const series = [];
  const created = new Map();
  const spots = {};
  const create = async (m, tenor, expiryIndex, rung, strike, expiry, tag) => {
    const { result: longId } = await send(acct.cranker, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "createSeries", args: [m.underlying, false, strike, expiry], label: `createSeries ${m.ticker} ${strike} ${expiry}` });
    const key = longId.toString();
    if (!created.has(key)) {
      const s = { longId: key, ticker: m.ticker, underlying: m.underlying, isPut: false, strike: strike.toString(), expiry, tenor, expiryIndex, rung, tag, tags: [tag] };
      created.set(key, s);
      series.push(s);
    } else if (!created.get(key).tags.includes(tag)) {
      // the same strike and expiry from another ladder (a weekly that is also a daily): one series, two names
      created.get(key).tags.push(tag);
    }
    return created.get(key);
  };
  const expiries = { daily: [], weekly: [] };
  for (const m of A.markets) {
    const p = paramsFor(reg, m.ticker);
    const [spot] = await read(C.settlementOracle, ABI.oracle, "spot", [m.underlying]);
    spots[m.ticker] = spot;
    const dailies = [firstDaily];
    while (dailies.length < (p.expiriesAhead.daily ?? 3)) dailies.push(await next(dailies.at(-1), false));
    // Weeklies strictly after the first daily, so the expiry the seed settles never takes a weekly ladder
    // (and its resale ask) with it.
    const weeklies = [await next(firstDaily, true)];
    while (weeklies.length < (p.expiriesAhead.weekly ?? 2)) weeklies.push(await next(weeklies.at(-1), true));
    expiries.daily = dailies;
    expiries.weekly = weeklies;
    for (const [tenor, list] of [["daily", dailies], ["weekly", weeklies]]) {
      const l = p.ladder[tenor];
      for (const [ei, expiry] of list.entries()) {
        for (let r = 0; r < l.rungs; r += 1) {
          const bps = BigInt(l.firstOtmBps + r * l.stepBps);
          const strike = roundUp((spot * (10_000n + bps)) / 10_000n, p.strikeTick);
          await create(m, tenor, ei, r, strike, expiry, `${tenor}${ei + 1}-r${r}`);
        }
      }
    }
    info(`${m.ticker} spot ${usd(spot)}: ${series.filter((s) => s.ticker === m.ticker).length} series on ${[...new Set([...dailies, ...weeklies])].length} expiries`);
  }
  const nvdaTick = paramsFor(reg, "NVDA").strikeTick;
  const itm = await create(NVDA, "daily", 0, -1, roundDown((spots.NVDA * 95n) / 100n, nvdaTick), firstDaily, "itm");
  info(`ITM: NVDA call ${usd(itm.strike)} expiring ${nyTime(firstDaily)} NY (spot ${usd(spots.NVDA)})`);

  const find = (ticker, tag) => series.find((s) => s.ticker === ticker && s.tags.includes(tag)) ?? die(`no ${ticker} ${tag} series`);
  const fair = (s) => callFair(spots[s.ticker], BigInt(s.strike), s.expiry - t0, IV[s.ticker]);
  const ask = (s) => {
    const p = toTick(fair(s) * 1.1);
    return p < MIN_ASK ? MIN_ASK : p;
  };

  step("orders: write-on-fill asks at several prices, bids");
  const orders = [];
  const place = async (who, s, kind, price, units) => {
    const { result: id } = await send(acct[who], { address: C.orderBook, abi: ABI.orderBook, functionName: "place", args: [BigInt(s.longId), kind, price, units, 0], label: `${who} place ${s.ticker} ${s.tag}` });
    const o = { id: id.toString(), maker: who, ticker: s.ticker, tag: s.tag, longId: s.longId, kind: ["Bid", "AskResale", "AskWrite"][kind], price: price.toString(), units };
    orders.push(o);
    return o;
  };
  const BID = 0;
  const RESALE = 1;
  const WRITE = 2;
  const o = {};
  /** One write-on-fill ask per writer per series, keyed by longId: two ladders can name the same series. */
  const adaAsk = new Map();
  const benAsk = new Map();
  const askOf = (who, s) => (who === "ada" ? adaAsk : benAsk).get(s.longId) ?? die(`no ${who} ask on ${s.ticker} ${s.tags.join("/")}`);
  for (const m of [NVDA, TSLA]) {
    for (const tag of ["daily1-r0", "daily1-r1", "daily1-r2", "daily1-r3", "daily1-r4", "daily2-r0", "daily2-r1", "daily2-r2", "weekly1-r0", "weekly1-r1", "weekly1-r2", "weekly2-r0"]) {
      const s = series.find((x) => x.ticker === m.ticker && x.tags.includes(tag));
      if (!s || adaAsk.has(s.longId)) continue; // a rung that merged into another ladder's series
      adaAsk.set(s.longId, await place("ada", s, WRITE, ask(s), 300n));
    }
  }
  for (const tag of ["daily1-r0", "daily1-r1", "weekly1-r0"]) {
    const s = find("NVDA", tag);
    if (!benAsk.has(s.longId)) benAsk.set(s.longId, await place("ben", s, WRITE, scale(ask(s), 1.15), 200n));
  }
  const itmAsk = toTick(fair(itm) * 0.55);
  o.itmAda = await place("ada", itm, WRITE, itmAsk, 150n);
  o.itmBen = await place("ben", itm, WRITE, scale(itmAsk, 1.1), 150n);
  o.cyBidD1 = await place("cy", find("NVDA", "daily1-r0"), BID, scale(ask(find("NVDA", "daily1-r0")), 0.6), 50n);
  o.cyBidW1 = await place("cy", find("NVDA", "weekly1-r0"), BID, scale(ask(find("NVDA", "weekly1-r0")), 0.6), 50n);
  o.benBidW2 = await place("ben", find("NVDA", "weekly2-r0"), BID, scale(ask(find("NVDA", "weekly2-r0")), 0.55), 100n);
  o.deeBidTsla = await place("dee", find("TSLA", "weekly1-r0"), BID, scale(ask(find("TSLA", "weekly1-r0")), 0.5), 100n);
  info(`${orders.length} orders placed (${orders.filter((x) => x.kind === "AskWrite").length} write-on-fill asks, ${orders.filter((x) => x.kind === "Bid").length} bids)`);

  step("fills: buys of 1 / 10 / 100 / 350 units, a sale from inventory, a sale by minting");
  const fills = [];
  const take = async (who, s, buying, named, units, { writeToSell = false } = {}) => {
    const prices = named.map((x) => BigInt(x.price));
    const limitPrice = buying ? prices.reduce((a, b) => (b > a ? b : a)) : prices.reduce((a, b) => (b < a ? b : a));
    // The take rule since INTERFACE_VERSION 6 (DECISIONS-2026-09-17 §4, any take builder): while a fee
    // change is pending, the deadline stops before it takes effect, so a take pays the fees it was
    // quoted or reverts DeadlinePassed; otherwise it stays under 24 h. The scripted flow seeds a fresh
    // devnet before any schedule, but the rule holds for every builder, not only the reachable ones.
    const [, feesEffectiveAt] = await read(C.orderBook, ABI.orderBook, "pendingFeeParams");
    const takeAt = await now();
    const deadline = Number(feesEffectiveAt) === 0 ? takeAt + 3600 : Math.min(takeAt + 3600, Number(feesEffectiveAt) - 1);
    // INTERFACE_VERSION 8 adds `maxTotalFee` as the TENTH and last TakeParams field, mirrored from the
    // frozen tuple in ops/abis/v2/OrderBook.json:
    //   (uint256,bool,uint256[],uint64,uint64,uint128,bool,address,uint40,uint128)
    // The bound is the fee this exact take is QUOTED, not a ceiling: OrderBook.sol:461-462 checks
    // `takerFee + (buying ? 0 : sellerFees) > maxTotalFee`, and quoteTake returns those two with
    // sellerFees already zeroed when buying, so the quoted sum IS the number the take compares. A
    // `type(uint128).max` here would pass every possible fee and make FeeAboveMax unreachable, which
    // is the one thing this field exists to prevent. quoteTake does not check maxTotalFee itself
    // (OrderBook.sol:484-496 calls _checkTake, which does not look at it), so the quote is made with
    // 0 and only the take carries the bound. The quote is sent AS the taker because quoteTake reads
    // msg.sender for the discount.
    const quoted = { longId: BigInt(s.longId), buying, orderIds: named.map((x) => BigInt(x.id)), units, minUnits: units, limitPrice, writeToSell, recipient: acct[who], deadline, maxTotalFee: 0n };
    const [, , quotedTakerFee, quotedSellerFees] = await read(C.orderBook, ABI.orderBook, "quoteTake", [quoted], acct[who]);
    const maxTotalFee = quotedTakerFee + quotedSellerFees;
    const p = { ...quoted, maxTotalFee };
    const { result, hash } = await send(acct[who], { address: C.orderBook, abi: ABI.orderBook, functionName: "take", args: [p], label: `${who} take ${s.ticker} ${s.tag} ${units}` });
    const [filled, premium, fee] = result;
    if (filled !== units) die(`${who} take ${s.tag}: filled ${filled} of ${units}`);
    if (fee > maxTotalFee) die(`${who} take ${s.tag}: taker fee ${fee} is above the quoted bound ${maxTotalFee}, which take() should have refused with FeeAboveMax`);
    fills.push({ who, ticker: s.ticker, tag: s.tag, side: buying ? "buy" : writeToSell ? "write-to-sell" : "sell", units: Number(units), premium: premium.toString(), takerFee: fee.toString(), maxTotalFee: maxTotalFee.toString(), tx: hash });
    info(`${who.padEnd(4)} ${buying ? "bought" : writeToSell ? "wrote+sold" : "sold"} ${String(units).padStart(3)} units ${s.ticker} ${s.tag} (${usd(s.strike)} ${nyTime(s.expiry)}): premium ${usd(premium)} fee ${usd(fee)} USDG`);
  };
  const d1 = find("NVDA", "daily1-r0");
  const w1 = find("NVDA", "weekly1-r0");
  await take("cy", d1, true, [askOf("ada", d1)], 1n);
  await take("dee", d1, true, [askOf("ada", d1)], 10n);
  await take("eve", d1, true, [askOf("ada", d1), askOf("ben", d1)], 100n);
  await take("eve", w1, true, [askOf("ada", w1), askOf("ben", w1)], 350n);
  await take("cy", itm, true, [o.itmAda, o.itmBen], 100n);
  await take("dee", itm, true, [o.itmAda, o.itmBen], 10n);
  await take("eve", itm, true, [o.itmAda], 1n);
  await take("cy", find("TSLA", "daily1-r0"), true, [askOf("ada", find("TSLA", "daily1-r0"))], 10n);
  await take("dee", find("TSLA", "weekly1-r0"), true, [askOf("ada", find("TSLA", "weekly1-r0"))], 100n);
  await take("eve", d1, false, [o.cyBidD1], 20n);
  await take("ben", find("TSLA", "weekly1-r0"), false, [o.deeBidTsla], 50n, { writeToSell: true });

  step("one resale ask");
  o.eveResale = await place("eve", w1, RESALE, scale(ask(w1), 1.4), 150n);
  info(`eve lists 150 of her 350 NVDA ${w1.tag} longs at ${usd(o.eveResale.price)} (order ${o.eveResale.id})`);

  // ------------------------------------------------------------------------------------------
  // PERIPHERY. Set up here, on the fork (every token slot these touch is then in a state dump); the roll
  // and the vault's quotes need a regular session and a fresh round, so `session` sends them.
  // ------------------------------------------------------------------------------------------
  const periphery = {};
  if (C.autoRoller) {
    step(`AutoRoller: ${ROLL_WRITER}'s writer setup (C2-09) and one weekly NVDA strategy, rolled in the session step`);
    const w = acct[ROLL_WRITER];
    const ch = (functionName, args, label) => send(w, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName, args, label: `${ROLL_WRITER} ${label}` });
    await send(w, { address: NVDA.underlying, abi: ABI.erc20, functionName: "approve", args: [C.clearinghouse, maxUint256], label: `${ROLL_WRITER} NVDA approve (roll collateral)` });
    await ch("deposit", [NVDA.underlying, ROLL_COLLATERAL, w], "deposit (roll collateral)");
    await ch("setPayoutToLedger", [true], "setPayoutToLedger");
    await ch("setOperator", [C.orderBook, true], "setOperator book");
    await ch("setOperator", [C.autoRoller, true], "setOperator roller");
    await send(w, { address: C.orderBook, abi: ABI.orderBook, functionName: "setDelegate", args: [C.autoRoller, true], label: `${ROLL_WRITER} setDelegate roller` });
    await send(w, { address: C.autoRoller, abi: ABI.autoRoller, functionName: "setStrategy", args: [NVDA.underlying, ROLL_STRATEGY], label: `${ROLL_WRITER} setStrategy NVDA` });
    info(`${ROLL_WRITER} ${w}: +${ROLL_COLLATERAL / 10n ** 18n} NVDA collateral, payouts to the ledger, book + roller operators, roller delegate`);
    info(`strategy NVDA weekly, strike +${ROLL_STRATEGY.otmBps / 100} %, ask ${ROLL_STRATEGY.askBps} bps of spot (pricer band ${ROLL_STRATEGY.minAskBps}-${ROLL_STRATEGY.maxAskBps}), max ${ROLL_STRATEGY.maxUnits} units`);
    periphery.autoRoller = { writer: ROLL_WRITER, address: w, ticker: "NVDA", underlying: NVDA.underlying, strategy: ROLL_STRATEGY, collateral: ROLL_COLLATERAL.toString() };
  } else {
    info("autoRoller: not deployed on this devnet (DEV_AUTO_ROLLER=0), skipped");
  }

  // IS THE DEPLOYED ADAPTER ACTUALLY A v8 PayoutRouter? On this devnet it is not:
  // script/v2/DevDeploy.s.sol:507 still deploys the v7 UniV3PayoutAdapter for this key, and
  // `routes(address)` KEPT its selector 0xd7409659 while its return type changed from
  // (address pool, uint24 fee) to the 5-field Route {venue, fee, tickSpacing, v3Pool, feeBps}. So
  // reading this v7 contract through the v8 ABI THROWS (PositionOutOfBoundsError: the static
  // 5-word tuple needs 160 bytes, a v7 return supplies 64). The silent mis-decode is the OTHER
  // direction -- a v7 ABI over v8 data -- and our ABIs are v8-only, so we get the loud failure.
  // The v8 ABI must NOT be swapped back to UniV3PayoutAdapter.json to make this stop: that would
  // hide the version gap instead of reporting it (C8-10 / T-156 replace the deployment). The probe
  // is `authority()`, because PayoutRouter is Managed and the v7 adapter predates Managed.
  const payoutIsV8 = await payoutRouterIsV8(C.payoutAdapter);
  if (C.payoutAdapter && !payoutIsV8) {
    info(`payoutAdapter ${C.payoutAdapter} is the v7 UniV3PayoutAdapter, not a v8 PayoutRouter (DevDeploy.s.sol:507): route and warm-up swaps SKIPPED, ITM calls pay in kind. routes(address) shares selector 0xd7409659 across the two versions, so a v8-ABI read of it throws rather than mis-decoding. C8-10/T-156 replace the deployment; this skip goes away on its own then.`);
  } else if (C.payoutAdapter) {
    step("PayoutRouter: the NVDA route, and one small swap each way through SwapRouter02 (C8-06)");
    const nvdaRoute = await read(C.payoutAdapter, ABI.payoutAdapter, "routes", [NVDA.underlying]);
    const routedPool = nvdaRoute.v3Pool;
    const fee = nvdaRoute.fee;
    if (!NVDA.pool || getAddress(routedPool) !== getAddress(NVDA.pool)) die(`PayoutRouter routes NVDA through ${routedPool}, not the market's pool ${NVDA.pool}`);
    const router = reg.v2.uniswapV3.swapRouter02;
    const admin = acct.admin;
    const bal = (token) => read(token, ABI.erc20, "balanceOf", [admin]);
    // A detached devnet keeps only the pool, router and token slots a transaction touched: these two swaps put the
    // pool's swap path (both directions around the current tick) and the adapter's own token slots in the dump, so
    // the settlement's redemptions can convert on the detached node.
    await deal(NVDA.underlying, admin, (await bal(NVDA.underlying)) + SWAP_NVDA_IN, whales);
    await send(admin, { address: NVDA.underlying, abi: ABI.erc20, functionName: "approve", args: [C.payoutAdapter, SWAP_NVDA_IN], label: "admin NVDA approve adapter" });
    const minOut = (spots.NVDA * SWAP_NVDA_IN * 95n) / (10n ** 18n * 100n);
    let before = await bal(usdg);
    await send(admin, { address: C.payoutAdapter, abi: ABI.payoutAdapter, functionName: "swapToUsdg", args: [NVDA.underlying, SWAP_NVDA_IN, minOut, admin], label: "adapter swapToUsdg NVDA" });
    const usdgOut = (await bal(usdg)) - before;
    await send(admin, { address: usdg, abi: ABI.erc20, functionName: "approve", args: [router, SWAP_USDG_IN], label: "admin USDG approve router" });
    before = await bal(NVDA.underlying);
    await send(admin, {
      address: router, abi: ABI.swapRouter02, functionName: "exactInputSingle", label: "router USDG -> NVDA",
      args: [{ tokenIn: usdg, tokenOut: NVDA.underlying, fee, recipient: admin, amountIn: SWAP_USDG_IN, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }],
    });
    const nvdaOut = (await bal(NVDA.underlying)) - before;
    const slippage = await read(C.clearinghouse, ABI.clearinghouse, "maxPayoutSlippageBps");
    info(`route NVDA -> pool ${routedPool} (fee ${fee}), Clearinghouse slippage bound ${slippage} bps`);
    info(`swapToUsdg 0.5 NVDA -> ${usd(usdgOut)} USDG; exactInputSingle ${usd(SWAP_USDG_IN)} USDG -> ${(Number(nvdaOut) / 1e18).toFixed(6)} NVDA`);
    periphery.payoutAdapter = { route: { underlying: NVDA.underlying, pool: routedPool, fee }, router, warmSwaps: { nvdaIn: SWAP_NVDA_IN.toString(), usdgOut: usdgOut.toString(), usdgIn: SWAP_USDG_IN.toString(), nvdaOut: nvdaOut.toString() } };
  } else {
    info("payoutAdapter: not deployed on this devnet (DEV_PAYOUT_ADAPTER=0 or no SwapRouter02), skipped: ITM calls pay in kind");
  }

  if (C.makerVault) {
    step("MakerVault: the admin funds the vault, its quoter moves the NVDA into the vault's Clearinghouse ledger (C2-11)");
    const admin = acct.admin;
    const bal = (token) => read(token, ABI.erc20, "balanceOf", [admin]);
    await deal(usdg, admin, (await bal(usdg)) + VAULT_USDG, whales);
    await deal(NVDA.underlying, admin, (await bal(NVDA.underlying)) + VAULT_NVDA, whales);
    for (const [token, amount, name] of [[usdg, VAULT_USDG, "USDG"], [NVDA.underlying, VAULT_NVDA, "NVDA"]]) {
      await send(admin, { address: token, abi: ABI.erc20, functionName: "approve", args: [C.makerVault, amount], label: `admin ${name} approve vault` });
      await send(admin, { address: C.makerVault, abi: ABI.makerVault, functionName: "deposit", args: [token, amount], label: `vault deposit ${name}` });
    }
    await send(acct.quoter, { address: C.makerVault, abi: ABI.makerVault, functionName: "depositToClearinghouse", args: [NVDA.underlying, VAULT_NVDA], label: "quoter depositToClearinghouse NVDA" });
    const free = await read(C.clearinghouse, ABI.clearinghouse, "free", [C.makerVault, NVDA.underlying]);
    info(`vault ${C.makerVault}: ${usd(VAULT_USDG)} USDG in the wallet (bid escrow), ${free / 10n ** 18n} NVDA in its Clearinghouse ledger (write collateral); quoter ${acct.quoter}`);
    periphery.makerVault = { vault: C.makerVault, quoter: acct.quoter, usdg: VAULT_USDG.toString(), nvdaInLedger: free.toString() };
  } else {
    info("makerVault: not deployed on this devnet (DEV_MAKER_SUITE=0), skipped");
  }

  A.seed = {
    ...(A.seed ?? {}),
    trade: {
      at: t0,
      spots: Object.fromEntries(Object.entries(spots).map(([k, v]) => [k, v.toString()])),
      expiries,
      settleExpiry: firstDaily,
      itm: { longId: itm.longId, strike: itm.strike, expiry: itm.expiry },
      resaleOrderId: o.eveResale.id,
      wallets: Object.fromEntries(WALLETS.map((w) => [w, acct[w]])),
      series,
      orders,
      fills,
      periphery,
      transactions: sentCount(),
    },
  };
  writeJson(ADDRESSES_FILE, A);
  info(`${sentCount()} transactions; plan written to ${ADDRESSES_FILE} (seed.trade)`);
}

/* ---------------------------------------------------------------------------------------------- */
/*  warm                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

/** Reads in a TRANSACTION, so a state dump (which carries only what transactions touched) keeps them. */
async function warm() {
  const A = loadAddresses();
  const acct = await devAccounts();
  const reg = registry();
  const TOKEN = parseAbi([
    "function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)",
    "function totalSupply() view returns (uint256)", "function paused() view returns (bool)", "function oraclePaused() view returns (bool)",
    "function uiMultiplier() view returns (uint256)", "function owner() view returns (address)", "function balanceOf(address) view returns (uint256)",
    "function newUIMultiplier() view returns (uint256)", "function effectiveAt() view returns (uint256)", "function ACCESS_CONTROLLED_REGISTRY() view returns (address)",
    "function isFrozen(address) view returns (bool)", "function isBlocked(address) view returns (bool)",
  ]);
  const FEED = parseAbi([
    "function decimals() view returns (uint8)", "function description() view returns (string)", "function version() view returns (uint256)",
    "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)", "function getRoundData(uint80) view returns (uint80, int256, uint256, uint256, uint80)",
    "function aggregator() view returns (address)", "function phaseId() view returns (uint16)",
    "function accessController() view returns (address)", "function owner() view returns (address)",
  ]);
  const POOL = parseAbi([
    "function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)", "function liquidity() view returns (uint128)",
    "function token0() view returns (address)", "function token1() view returns (address)", "function fee() view returns (uint24)",
    "function tickSpacing() view returns (int24)", "function observe(uint32[]) view returns (int56[], uint160[])",
    "function observations(uint256) view returns (uint32, int56, uint160, bool)",
  ]);
  const calls = [];
  const add = (target, abi, functionName, args = []) => calls.push({ target, allowFailure: true, callData: encodeFunctionData({ abi, functionName, args }) });

  const tokens = [A.usdg, ...A.markets.map((m) => m.underlying)];
  for (const t of tokens) {
    for (const fn of ["name", "symbol", "decimals", "totalSupply", "paused", "oraclePaused", "uiMultiplier", "owner"]) add(t, TOKEN, fn);
    add(t, TOKEN, "balanceOf", [acct.treasurySafe]);
  }
  // The external monitor's views (ops/v2/monitor.mjs). A detached node answers only what was touched before the dump:
  // USDG routes isFrozen through a facet slot nothing else reads, so without this read isFrozen reverts on the devnet
  // (0x800ab12c) while it answers on chain 4663.
  const ours = Object.entries(A.contracts).filter(([k, v]) => k !== "sources" && v).map(([, v]) => v);
  for (const c of ours) add(A.usdg, TOKEN, "isFrozen", [c]);
  for (const m of A.markets) {
    for (const fn of ["newUIMultiplier", "effectiveAt", "ACCESS_CONTROLLED_REGISTRY"]) add(m.underlying, TOKEN, fn);
    const accessRegistry = await read(m.underlying, TOKEN, "ACCESS_CONTROLLED_REGISTRY").catch(() => null);
    if (accessRegistry) for (const c of [...ours, m.pool].filter(Boolean)) add(accessRegistry, TOKEN, "isBlocked", [c]);
  }
  const feeds = [...new Set(A.markets.map((m) => m.realFeed).filter(Boolean))];
  for (const f of feeds) {
    for (const fn of ["decimals", "description", "version", "latestRoundData", "aggregator", "phaseId", "accessController", "owner"]) add(f, FEED, fn);
    const [id] = await read(f, FEED, "latestRoundData");
    for (let k = 1n; k <= 12n; k += 1n) add(f, FEED, "getRoundData", [id - k]);
  }
  const pools = [...new Set([...A.markets.map((m) => m.pool), ...reg.markets.filter((m) => ["NVDA", "TSLA"].includes(m.ticker)).map((m) => m.v2?.univ3Pool)].filter(Boolean).map((a) => getAddress(a)))];
  for (const p of pools) {
    for (const fn of ["slot0", "liquidity", "token0", "token1", "fee", "tickSpacing"]) add(p, POOL, fn);
    add(p, POOL, "observe", [[0]]);
    add(p, POOL, "observe", [[300, 0]]);
    add(p, POOL, "observe", [[1800, 0]]);
    const slot0 = await read(p, POOL, "slot0");
    add(p, POOL, "observations", [BigInt(slot0[2])]);
  }
  for (const m of A.markets) {
    add(A.contracts.sources.chainlink, ABI.chainlink, "latest", [m.underlying]);
    if (m.pool) add(A.contracts.sources.univ3, ABI.univ3, "latest", [m.underlying]);
    add(A.contracts.settlementOracle, ABI.oracle, "trySpot", [m.underlying]);
  }
  const multicall = reg.shared?.multicall3 ?? "0xcA11bde05977b3631167028862bE2a173976CA11";
  const { result } = await send(acct.admin, { address: multicall, abi: ABI.multicall3, functionName: "aggregate3", args: [calls], label: "warm-up multicall" });
  info(`warm-up transaction: ${calls.length} reads over ${tokens.length} tokens, ${feeds.length} feeds, ${pools.length} pools (${result.filter((r) => r.success).length} answered)`);
}

/* ---------------------------------------------------------------------------------------------- */
/*  session                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The AutoRoller only rolls inside a regular session (09:30-16:00 New York) on a spot no older than spotMaxAge, and
 * the MakerVault prices every quote against spot: so this runs in the current session, or warps to 10:00 New York of
 * the next one. It always lands before the first daily expiry the settle step settles (that expiry is a session close
 * at least an hour after the trade step), so the settlement below is unchanged.
 */
async function session() {
  const A = loadAddresses();
  const T = A.seed?.trade ?? die("seed.trade missing: run `seed.mjs trade` first");
  const C = A.contracts;
  if (!C.autoRoller && !C.makerVault) {
    step("session: no AutoRoller and no MakerVault on this devnet, skipped");
    return;
  }
  if (!A.mockFeed) die("session pushes fresh rounds through the mock feeds: DevDeploy ran with DEV_MOCK_FEED=0");
  const acct = await devAccounts();
  const NVDA = A.markets.find((m) => m.ticker === "NVDA") ?? die("no NVDA market in addresses.json");
  const e = T.settleExpiry;
  const cal = (functionName, args) => read(C.expiryCalendar, ABI.calendar, functionName, args);

  let t = await now();
  // a margin for the blocks this step mines
  if (!(await cal("isRegularSession", [t + 120]))) {
    let target = null;
    for (let day = Math.floor(t / 86400); target === null && day <= Math.floor(t / 86400) + 10; day += 1) {
      if (!(await cal("isSessionDay", [day]))) continue;
      const tenAm = Number(await cal("closeOf", [day])) - SESSION_S + 1800;
      if (tenAm > t) target = tenAm;
    }
    if (target === null || !(await cal("isRegularSession", [target]))) die(`no regular session within 10 days of ${t}`);
    t = await warpTo(target);
    step(`session: warped to ${nyTime(t)} New York, a regular session`);
  } else {
    step(`session: ${nyTime(t)} New York is inside a regular session`);
  }
  if (t >= e - 2100) die(`the session step (${t}) would stamp rounds inside the settlement window of ${e}`);

  for (const m of A.markets) {
    const [, answer] = await read(m.feed, ABI.mockFeed, "latestRoundData");
    await pushRound(m.feed, answer, t, `${m.ticker} fresh round`);
  }
  const out = { at: t };

  if (C.autoRoller) {
    const P = T.periphery?.autoRoller ?? die("seed.trade.periphery.autoRoller missing: the trade step ran without the AutoRoller");
    const writer = getAddress(P.address);
    const { result: advanced } = await send(acct.cranker, { address: C.autoRoller, abi: ABI.autoRoller, functionName: "roll", args: [writer, P.underlying], label: `roll ${P.writer} ${P.ticker}` });
    if (!advanced) die(`AutoRoller.roll(${P.writer}, ${P.ticker}) returned false inside the session: spot not fresh, no expiry or no free collateral`);
    const [longId, orderId, expiry] = await read(C.autoRoller, ABI.autoRoller, "position", [writer, P.underlying]);
    const [order] = await read(C.orderBook, ABI.orderBook, "getOrders", [[orderId]]);
    const series = await read(C.clearinghouse, ABI.clearinghouse, "series", [longId]);
    info(`rolled ${P.writer}: NVDA call ${usd(series.strike)} exp ${nyTime(Number(expiry))} NY, AskWrite order ${orderId}: ${order.units} units at ${usd(order.price)} USDG/share (the cranker earned the ROLL bounty)`);
    out.roll = { writer, underlying: P.underlying, longId: longId.toString(), orderId: orderId.toString(), strike: series.strike.toString(), expiry: Number(expiry), price: order.price.toString(), units: Number(order.units) };
  }

  if (C.makerVault) {
    const s = T.series.find((x) => x.ticker === "NVDA" && x.tags.includes(VAULT_QUOTE_TAG)) ?? die(`no NVDA ${VAULT_QUOTE_TAG} series`);
    const longId = BigInt(s.longId);
    const [spot] = await read(C.settlementOracle, ABI.oracle, "spot", [NVDA.underlying]);
    const fairNow = callFair(spot, BigInt(s.strike), s.expiry - t, IV.NVDA);
    const floor = roundUp(await read(C.makerVault, ABI.makerVault, "askFloor", [longId]), PRICE_TICK);
    const cap = roundDown(await read(C.makerVault, ABI.makerVault, "bidCap", [longId]), PRICE_TICK);
    let askPrice = toTick(fairNow * 1.08);
    if (askPrice < MIN_ASK) askPrice = MIN_ASK;
    if (askPrice < floor) askPrice = floor;
    let bidPrice = toTick(fairNow * 0.9);
    if (bidPrice > cap) bidPrice = cap;
    if (bidPrice >= askPrice) bidPrice = askPrice - PRICE_TICK;
    if (bidPrice < PRICE_TICK) die(`no room for a vault bid under the ask ${usd(askPrice)} (bid cap ${usd(cap)})`);
    const quote = async (kind, price, units, name) => {
      const { result } = await send(acct.quoter, { address: C.makerVault, abi: ABI.makerVault, functionName: "place", args: [longId, kind, price, units, 0], label: `vault ${name} ${s.ticker} ${VAULT_QUOTE_TAG}` });
      return result;
    };
    const askId = await quote(2, askPrice, VAULT_ASK_UNITS, "AskWrite");
    const bidId = await quote(0, bidPrice, VAULT_BID_UNITS, "Bid");
    info(`vault quotes on NVDA ${VAULT_QUOTE_TAG} (${usd(s.strike)} ${nyTime(s.expiry)} NY, spot ${usd(spot)}): AskWrite order ${askId} ${VAULT_ASK_UNITS} units at ${usd(askPrice)}, Bid order ${bidId} ${VAULT_BID_UNITS} units at ${usd(bidPrice)} (floor ${usd(floor)}, cap ${usd(cap)})`);
    out.vaultQuotes = { longId: s.longId, ask: { orderId: askId.toString(), price: askPrice.toString(), units: Number(VAULT_ASK_UNITS) }, bid: { orderId: bidId.toString(), price: bidPrice.toString(), units: Number(VAULT_BID_UNITS) } };
  }

  const B = loadAddresses();
  B.seed = { ...(B.seed ?? {}), session: out };
  writeJson(ADDRESSES_FILE, B);
}

/* ---------------------------------------------------------------------------------------------- */
/*  settle                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

async function pushRound(feed, answer, at, label) {
  await send((await devAccounts()).admin, { address: feed, abi: ABI.mockFeed, functionName: "push", args: [answer, BigInt(at)], label: `push ${label}` });
}

async function settle() {
  const A = loadAddresses();
  const T = A.seed?.trade ?? die("seed.trade missing: run `seed.mjs trade` first");
  const acct = await devAccounts();
  const C = A.contracts;
  const e = T.settleExpiry;
  const byTicker = Object.fromEntries(A.markets.map((m) => [m.ticker, m]));
  if (!A.mockFeed) die("settle drives the settlement window through the mock feeds: DevDeploy ran with DEV_MOCK_FEED=0");

  step(`settlement of the first daily expiry, ${nyTime(e)} New York (${e})`);
  const nvda = byTicker.NVDA;
  const [poolOk, poolPrice] = await read(C.sources.univ3, ABI.univ3, "latest", [nvda.underlying]);
  if (!poolOk) die("the NVDA pool TWAP is not ok: the settlement could not corroborate");
  info(`NVDA pool TWAP ${usd(poolPrice)} USDG: the mock feed will print it across the window so both sources agree`);

  const t = await warpTo(e + 5);
  info(`warped to ${t} (${nyTime(t)} NY)`);
  const nvdaAnswer = poolPrice * 100n; // 6 dp -> the feed's 8 dp
  await pushRound(nvda.feed, nvdaAnswer, e - 2100, "NVDA before the window");
  await pushRound(nvda.feed, nvdaAnswer, e - 900, "NVDA inside the window");
  await pushRound(nvda.feed, nvdaAnswer, t, "NVDA now");
  for (const m of A.markets.filter((x) => x.ticker !== "NVDA")) {
    const [, answer] = await read(m.feed, ABI.mockFeed, "latestRoundData");
    await pushRound(m.feed, answer, e - 2100, `${m.ticker} before the window`);
    await pushRound(m.feed, answer, t, `${m.ticker} now`);
  }

  for (const m of A.markets) {
    const { result } = await send(acct.cranker, { address: C.settlementOracle, abi: ABI.oracle, functionName: "snapshot", args: [m.underlying, e], label: `snapshot ${m.ticker}` });
    info(`snapshot ${m.ticker}: ${result} source(s) recorded`);
  }
  await warpTo(e + 125);
  for (const m of A.markets) {
    await send(acct.cranker, { address: C.settlementOracle, abi: ABI.oracle, functionName: "finalize", args: [m.underlying, e], label: `finalize ${m.ticker}` });
    const [status, price] = await read(C.settlementOracle, ABI.oracle, "settlementPrice", [m.underlying, e]);
    const [cPrice, , , finalizableAt] = await read(C.settlementOracle, ABI.oracle, "candidate", [m.underlying, e]);
    info(status === 2 ? `finalize ${m.ticker}: Finalized at ${usd(price)}` : `finalize ${m.ticker}: ${["None", "Pending", "Finalized", "Held"][status]} (candidate ${usd(cPrice)}, finalizable at ${nyTime(Number(finalizableAt))} NY)`);
  }
  const [nvdaStatus] = await read(C.settlementOracle, ABI.oracle, "settlementPrice", [nvda.underlying, e]);
  if (nvdaStatus !== 2) die("NVDA did not finalize: the sources did not corroborate");

  const settleFrom = await pub.getBlockNumber();
  const expiring = T.series.filter((s) => s.ticker === "NVDA" && s.expiry === e);
  step(`settle, prune, redeem: ${expiring.length} NVDA series of that expiry`);
  for (const s of expiring) {
    await send(acct.cranker, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "settle", args: [BigInt(s.longId)], label: `settle ${s.tag}` });
  }
  const orderIds = [];
  for (const s of expiring) {
    let cursor = 0n;
    do {
      const [ids, nextCursor] = await read(C.orderBook, ABI.orderBook, "ordersOfSeries", [BigInt(s.longId), cursor, 100n]);
      orderIds.push(...ids);
      cursor = nextCursor;
    } while (cursor !== 0n);
  }
  const { result: pruned } = await send(acct.cranker, { address: C.orderBook, abi: ABI.orderBook, functionName: "prune", args: [orderIds], label: "prune" });
  info(`pruned ${pruned} of ${orderIds.length} orders on those series`);
  const holders = [...WALLETS.map((w) => acct[w])];
  let redeemedCalls = 0;
  for (const s of expiring) {
    const longId = BigInt(s.longId);
    for (const id of [longId, longId | 1n]) {
      const withBalance = [];
      for (const h of holders) {
        // Leave one settled ITM long in a wallet for the browser's payout preference and Collect path.
        if (id === BigInt(T.itm.longId) && getAddress(h) === getAddress(acct.eve)) continue;
        if ((await read(C.clearinghouse, ABI.clearinghouse, "balanceOf", [h, id])) > 0n) withBalance.push(h);
      }
      if (withBalance.length === 0) continue;
      await send(acct.cranker, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "redeemBatch", args: [id, withBalance], label: `redeemBatch ${s.tag}` });
      redeemedCalls += 1;
    }
  }
  info(`${redeemedCalls} redeemBatch calls (longs, then shorts)`);
  if (C.payoutAdapter) {
    const logs = await pub.getContractEvents({ address: C.clearinghouse, abi: ABI.clearinghouse, eventName: "Redeemed", fromBlock: BigInt(settleFrom), toBlock: "latest" });
    const conv = logs.filter((l) => getAddress(l.args.asset) === getAddress(A.usdg) && l.args.amountInKind > 0n && (l.args.tokenId & 1n) === 0n);
    for (const l of conv) info(`converted     ${short(l.args.holder)}: ${(Number(l.args.amountInKind) / 1e18).toFixed(6)} NVDA owed -> ${usd(l.args.amount)} USDG through the PayoutAdapter`);
    if (conv.length === 0) info("no ITM call long was converted to USDG: every payout went in kind (see the summary gate)");
  }
  const keeperUsdg = await read(A.usdg, ABI.erc20, "balanceOf", [acct.cranker]);
  info(`cranker bounties so far: ${usd(keeperUsdg)} USDG`);

  A.seed = { ...(A.seed ?? {}), settle: { expiry: e, warpedTo: t, poolPrice: poolPrice.toString(), series: expiring.map((s) => s.longId), pruned: Number(pruned), transactions: sentCount() } };
  writeJson(ADDRESSES_FILE, A);
}

/* ---------------------------------------------------------------------------------------------- */
/*  summary                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

async function summary() {
  const A = loadAddresses();
  const C = A.contracts;
  const fromBlock = BigInt(A.startBlock);
  const events = (address, abi, eventName) => pub.getContractEvents({ address, abi, eventName, fromBlock, toBlock: "latest" });
  const created = await events(C.clearinghouse, ABI.clearinghouse, "SeriesCreated");
  const placed = await events(C.orderBook, ABI.orderBook, "OrderPlaced");
  const filled = await events(C.orderBook, ABI.orderBook, "OrderFilled");
  const settled = await events(C.clearinghouse, ABI.clearinghouse, "SeriesSettled");
  const redeemed = await events(C.clearinghouse, ABI.clearinghouse, "Redeemed");
  const candidates = await events(C.settlementOracle, ABI.oracle, "SettlementCandidate");
  const tickerOf = Object.fromEntries(A.markets.map((m) => [m.underlying.toLowerCase(), m.ticker]));

  const liveIds = placed.map((l) => l.args.orderId);
  const live = liveIds.length ? await read(C.orderBook, ABI.orderBook, "getOrders", [liveIds]) : [];
  const t = await now();
  const isLive = (o) => !o.cancelled && o.filled < o.units && BigInt(t) < BigInt(o.validUntil);
  const liveCount = live.filter(isLive).length;
  const resale = live.map((o, i) => ({ o, id: liveIds[i] })).filter(({ o }) => o.kind === 1 && isLive(o));

  const itm = [];
  for (const s of settled) {
    if (s.args.longPayoutPerUnit === 0n) continue;
    const series = await read(C.clearinghouse, ABI.clearinghouse, "series", [s.args.longId]);
    const holders = [...new Set(redeemed.filter((r) => r.args.tokenId === s.args.longId && r.args.amount > 0n).map((r) => r.args.holder))];
    itm.push({ longId: s.args.longId, series, price: s.args.settlementPrice, holders, payoutPerUnit: s.args.longPayoutPerUnit });
  }
  const perMarket = {};
  for (const l of created) perMarket[tickerOf[l.args.underlying.toLowerCase()]] = (perMarket[tickerOf[l.args.underlying.toLowerCase()]] ?? 0) + 1;

  const block = await pub.getBlockNumber();
  step(`devnet summary (block ${block}, chain time ${nyTime(t)} New York)`);
  info(`series        ${created.length}  (${Object.entries(perMarket).map(([k, v]) => `${k} ${v}`).join(", ")})`);
  info(`orders        ${placed.length}  (${liveCount} live now)`);
  info(`fills         ${filled.length}  OrderFilled events, ${[...new Set(filled.map((f) => f.transactionHash))].length} takes`);
  info(`settled       ${settled.length} series (${itm.length} in the money)`);
  for (const x of itm) {
    info(`ITM series    ${tickerOf[x.series.underlying.toLowerCase()]} call ${usd(x.series.strike)} exp ${nyTime(Number(x.series.expiry))} NY, settled at ${usd(x.price)}: ${x.holders.length} long holders redeemed (${x.holders.map((h) => `${h.slice(0, 6)}…${h.slice(-4)}`).join(", ")})`);
  }
  for (const c of candidates) {
    const [status] = await read(C.settlementOracle, ABI.oracle, "settlementPrice", [c.args.underlying, c.args.expiry]);
    if (status === 1) info(`pending       ${tickerOf[c.args.underlying.toLowerCase()]} ${nyTime(Number(c.args.expiry))} NY: uncorroborated candidate ${usd(c.args.price)}, finalizable ${nyTime(Number(c.args.finalizableAt))} NY`);
  }
  for (const { o, id } of resale) info(`resale ask    order ${id}: ${o.units - o.filled} units at ${usd(o.price)} USDG/share`);
  info(`redemptions   ${redeemed.length} Redeemed events`);

  const best = itm.reduce((a, b) => (b.holders.length > (a?.holders.length ?? -1) ? b : a), null);
  const failures = [];
  if (created.length < GATES.series) failures.push(`series ${created.length} < ${GATES.series}`);
  if (placed.length < GATES.orders) failures.push(`orders ${placed.length} < ${GATES.orders}`);
  if (filled.length < GATES.fills) failures.push(`fills ${filled.length} < ${GATES.fills}`);
  if (!best || best.holders.length < GATES.itmRedeemedHolders) failures.push(`no settled ITM series with >= ${GATES.itmRedeemedHolders} redeemed long holders`);

  const passed = [];
  const periphery = {};
  if (C.autoRoller) {
    const sets = await events(C.autoRoller, ABI.autoRoller, "StrategySet");
    const rolls = await events(C.autoRoller, ABI.autoRoller, "Rolled");
    const pairs = [...new Map(sets.map((l) => [`${l.args.writer}:${l.args.underlying}`, l.args])).values()];
    const active = [];
    for (const { writer, underlying } of pairs) {
      const strategy = await read(C.autoRoller, ABI.autoRoller, "strategy", [writer, underlying]);
      const [longId, orderId, expiry] = await read(C.autoRoller, ABI.autoRoller, "position", [writer, underlying]);
      if (!strategy.active || orderId === 0n) continue;
      const [order] = await read(C.orderBook, ABI.orderBook, "getOrders", [[orderId]]);
      if (!isLive(order)) continue;
      const series = await read(C.clearinghouse, ABI.clearinghouse, "series", [longId]);
      active.push({ writer, ticker: tickerOf[underlying.toLowerCase()], longId: longId.toString(), orderId: orderId.toString(), strike: series.strike.toString(), expiry: Number(expiry), price: order.price.toString(), unitsLeft: Number(order.units - order.filled) });
    }
    info(`auto-roller   ${active.length} active strateg${active.length === 1 ? "y" : "ies"} with a live roll order (${sets.length} StrategySet, ${rolls.length} Rolled)`);
    for (const x of active) info(`roll          ${short(x.writer)} ${x.ticker} call ${usd(x.strike)} exp ${nyTime(x.expiry)} NY: AskWrite order ${x.orderId}, ${x.unitsLeft} units at ${usd(x.price)}`);
    if (active.length < GATES.activeRolls) failures.push(`${active.length} active AutoRoller strategies with a live roll order < ${GATES.activeRolls}`);
    else passed.push(`${active.length} active roll`);
    periphery.autoRoller = { active };
  }
  if (C.makerVault) {
    const quotes = live.map((o, i) => ({ o, id: liveIds[i] })).filter(({ o }) => getAddress(o.maker) === getAddress(C.makerVault) && isLive(o));
    const registry = await read(C.orderBook, ABI.orderBook, "makerRegistry");
    info(`maker vault   ${quotes.length} live quotes from ${short(C.makerVault)} (book maker registry ${short(registry)})`);
    for (const { o, id } of quotes) info(`vault quote   order ${id}: ${["Bid", "AskResale", "AskWrite"][o.kind]} ${o.units - o.filled} units at ${usd(o.price)}`);
    if (quotes.length < GATES.vaultQuotes) failures.push(`MakerVault live quotes ${quotes.length} < ${GATES.vaultQuotes}`);
    else if (!C.makerRegistry || getAddress(registry) !== getAddress(C.makerRegistry)) failures.push(`OrderBook.makerRegistry ${registry} is not the devnet's MakerRegistry ${C.makerRegistry}`);
    else passed.push(`${quotes.length} vault quotes`);
    periphery.makerVault = { liveQuotes: quotes.map(({ id }) => id.toString()) };
  }
  if (C.payoutAdapter) {
    const adapter = await read(C.clearinghouse, ABI.clearinghouse, "payoutAdapter");
    const slippage = await read(C.clearinghouse, ABI.clearinghouse, "maxPayoutSlippageBps");
    const routes = [];
    // Same guard as the trade step, and for the same reason: a v8-ABI routes() read THROWS on the
    // v7 adapter (see the file header for the measurement of both directions).
    if (await payoutRouterIsV8(C.payoutAdapter)) {
      for (const m of A.markets.filter((x) => x.pool)) {
        const route = await read(C.payoutAdapter, ABI.payoutAdapter, "routes", [m.underlying]);
        routes.push({ ticker: m.ticker, pool: route.v3Pool, fee: route.fee });
      }
    } else {
      info(`routes: not read — payoutAdapter ${C.payoutAdapter} is the v7 UniV3PayoutAdapter (DevDeploy.s.sol:507), whose routes(address) shares selector 0xd7409659 with the v8 one and decodes to the wrong fields`);
    }
    // ITM call long redemptions: long id (even), something owed; converted when paid in USDG.
    let itmCallLongs = 0;
    const converted = [];
    for (const r of redeemed.filter((x) => (x.args.tokenId & 1n) === 0n && x.args.amountInKind > 0n)) {
      const series = await read(C.clearinghouse, ABI.clearinghouse, "series", [r.args.tokenId]);
      if (series.isPut) continue;
      itmCallLongs += 1;
      if (getAddress(r.args.asset) === getAddress(A.usdg)) converted.push({ holder: r.args.holder, usdg: r.args.amount.toString(), inKind: r.args.amountInKind.toString(), tx: r.transactionHash });
    }
    info(`payout        adapter ${short(adapter)} (slippage ${slippage} bps), routes ${routes.map((r) => `${r.ticker} fee ${r.fee} via ${short(r.pool)}`).join(", ") || "none"}; ${converted.length} of ${itmCallLongs} ITM call long redemptions paid in USDG`);
    const badRoute = routes.find((r) => r.fee === 0 || getAddress(r.pool) !== getAddress(A.markets.find((m) => m.ticker === r.ticker).pool));
    if (getAddress(adapter) !== getAddress(C.payoutAdapter)) failures.push(`Clearinghouse.payoutAdapter ${adapter} is not the devnet's adapter ${C.payoutAdapter}`);
    else if (!(await payoutRouterIsV8(C.payoutAdapter))) {
      // The route gate asserts a v8 property, and on the v7 adapter there is no v8 route to assert:
      // the deployment predates the Route struct entirely. Failing here would stop the devnet coming
      // up over a contract version it does not control, and passing here silently would claim a
      // payout path that does not exist. So it is a NAMED skip that says which it is, and it starts
      // gating again by itself the moment DevDeploy deploys the PayoutRouter (C8-10 / T-156).
      info("payout route: NOT GATED — the deployed adapter is the v7 UniV3PayoutAdapter, which has no v8 Route to check. This gate returns when DevDeploy deploys the PayoutRouter (C8-10/T-156).");
    } else if (routes.length === 0 || badRoute) failures.push(`PayoutAdapter route missing or not the market pool (${badRoute?.ticker ?? "no market with a pool"})`);
    else if (itmCallLongs > 0 && converted.length < GATES.convertedRedemptions) failures.push(`no ITM call long converted to USDG (${itmCallLongs} redeemed in kind)`);
    else passed.push(`payout route set, ${converted.length} USDG conversions`);
    periphery.payoutAdapter = { adapter, slippageBps: slippage, routes, converted };
  }

  const result = {
    block: block.toString(),
    chainTime: t,
    series: created.length,
    orders: placed.length,
    liveOrders: liveCount,
    fills: filled.length,
    settledSeries: settled.length,
    itmSettled: itm.map((x) => ({ longId: x.longId.toString(), strike: x.series.strike.toString(), expiry: Number(x.series.expiry), settlementPrice: x.price.toString(), redeemedHolders: x.holders })),
    resaleAsks: resale.map(({ id }) => id.toString()),
    periphery,
    gates: failures.length ? `FAILED: ${failures.join("; ")}` : "passed",
  };
  A.seed = { ...(A.seed ?? {}), summary: result };
  writeJson(ADDRESSES_FILE, A);
  if (failures.length) die(`\nDEVNET SEED FAILED: ${failures.join("; ")}`);
  process.stdout.write(`\nDEVNET SEED PASSED: ${created.length} series >= ${GATES.series}, ${placed.length} orders >= ${GATES.orders}, ${filled.length} fills >= ${GATES.fills}, ITM series settled with ${best.holders.length} redeemed holders >= ${GATES.itmRedeemedHolders}${passed.length ? `; ${passed.join(", ")}` : ""}\n`);
}

/* ---------------------------------------------------------------------------------------------- */

const commands = {
  trade,
  warm,
  session,
  settle: async () => {
    await session();
    await settle();
    await summary();
  },
  summary,
  all: async () => {
    await trade();
    await warm();
    await session();
    await settle();
    await summary();
  },
};
const cmd = process.argv[2] ?? "all";
if (!commands[cmd]) die(`usage: node ops/devnet/seed.mjs ${Object.keys(commands).join("|")}`, 2);
await rpc("eth_chainId").catch((error) => die(`no devnet node answers (${error.shortMessage ?? error.message}); start it with ops/devnet/up.sh`, 2));
try {
  await commands[cmd]();
} catch (error) {
  die(`seed ${cmd} failed: ${error.stack ?? error.message}`);
}
