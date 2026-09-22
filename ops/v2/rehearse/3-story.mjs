#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * Step 3 of the O2-03 rehearsal: the scripted story (plan tasks/O-ops-launch.md O2-03 step 3), every outcome asserted
 * on chain and through the indexer API, the web flows driven in a browser with screenshots (unless --skip-web).
 *
 *   3a  session and notifier subscriptions: inside a regular session with room before the daily expiry's cutoff (else
 *       a warp to 10:00 New York of the next session day); cy, eve and ben link Telegram chats through the notifier
 *       (challenge, EIP-191 signature, session, subscription, deep link, /start through the Telegram stand-in)
 *   3b  the cranker's daily ladders for the first daily expiry E1 on NVDA, TSLA and META
 *   3c  writers: ada deposits and places manual AskWrite asks (NVDA r0 and r1, META r0); ben deposits, places a manual
 *       ask and enables a DAILY auto-roll strategy (in the browser on /earn/nvda when the web runs); the cranker rolls it
 *   3d  MM quotes appear: the MakerVault's two-sided quotes from the mm-bot, visible in the indexer's book
 *   3e  buyers take 0.01 (cy, NVDA r0), 0.1 (dee, NVDA r1) and 1 share (eve, NVDA r0); hal lifts the vault's TSLA ask;
 *       ivy buys META r0; the browser buyer buys 0.01 share from a home card
 *   3f  one resale: eve lists 0.40 of her share (AskResale), fay buys it
 *   3g  one bid hit by writing: gus bids on NVDA r1, ada sells into it with writeToSell
 *   3h  expiry E1 by warp: the settlement window printed (NVDA, TSLA at their pool's TWAP; META +3 %), the cranker's
 *       snapshot, finalize (NVDA and TSLA corroborated by their pools; META a single-source candidate, finalized after
 *       its 6 h delay by warp), settle, prune, redeem: every holder with a payout is paid; NVDA and TSLA ITM longs in
 *       USDG through the PayoutAdapter, META ITM longs in kind (no route)
 *   3i  auto-roll rolls: warp to the next session, the cranker rolls ben's strategy into the next daily expiry
 *   3j  wins feed, leaderboard, PNL (API, pages, the PNL image route)
 *   3k  notifications delivered: fill, settlement and auto-roll receipts in the linked chats; the delivery rows sent
 *
 *   node ops/v2/rehearse/3-story.mjs [--skip-web]
 * ------------------------------------------------------------------------------------------------- */
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  ABI, INDEXER_URL, NOTIFIER_URL, PRICING_URL, PORTS, RehearsalError, TELEGRAM_URL, accountOf, expect, fail, getAddress, getJson, info, ledgerAppend,
  loadState, now, nyTime, patchState, placedOrderId, pub, pushRound, read, say, send, setStage, signerOf, sleep, step, until, usd, warpTo, impersonate, viem,
} from "./lib.mjs";

setStage("3-story");
const S = loadState();
const SKIP_WEB = process.argv.includes("--skip-web") || S.skipWeb === true;
const C = S.contracts;
const M = S.markets;
const USDG = S.usdg;
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
const BPS = 10_000n;
const TICK = 100n;
const BID = 0;
const RESALE = 1;
const WRITE = 2;
const NOTIFIER_BOT = "4663002";
const story = { startedAt: new Date().toISOString(), txs: {} };
const remember = (key, value) => {
  story[key] = value;
  patchState({ story });
};

/* ---------------------------------------------------------------------------------------------- */
/*  reads                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

const ch = (fn, args = []) => read(C.clearinghouse, ABI.clearinghouse, fn, args);
const ob = (fn, args = []) => read(C.orderBook, ABI.orderBook, fn, args);
const oracle = (fn, args = []) => read(C.settlementOracle, ABI.oracle, fn, args);
const cal = (fn, args = []) => read(C.expiryCalendar, ABI.calendar, fn, args);
const bal = (token, who) => read(token, ABI.erc20, "balanceOf", [who]);
const roundTick = (x) => ((x + TICK - 1n) / TICK) * TICK;
const spotOf = async (T) => (await oracle("spot", [M[T].asset]))[0];

async function fairOf(T, strike, expiry) {
  const r = await getJson(`${PRICING_URL}/fair?ticker=${T}&strike=${strike}&expiry=${expiry}&type=call`);
  if (r.fair === null) fail(`no fair value for ${T} ${strike} ${expiry}: ${r.reason}`);
  return BigInt(r.fair.raw);
}

/** keeper/src/v2/cranker/planner.ts ladderStrikes for calls. */
function ladderStrikes(spot, ladder, tick) {
  const ceilDiv = (a, b) => (a + b - 1n) / b;
  const out = [];
  let raw = ceilDiv(spot * (BPS + BigInt(ladder.firstOtmBps)), BPS);
  for (let i = 0; i < ladder.rungs; i += 1) {
    if (i > 0) raw = ceilDiv(raw * (BPS + BigInt(ladder.stepBps)), BPS);
    let strike = ceilDiv(raw, tick) * tick;
    if (out.length && strike <= out.at(-1)) strike = out.at(-1) + tick;
    if (strike < spot / 2n || strike > spot * 2n) break;
    out.push(strike);
  }
  return out;
}

async function ordersOf(longId) {
  const ids = [];
  let cursor = 0n;
  do {
    const [page, next] = await ob("ordersOfSeries", [longId, cursor, 200n]);
    ids.push(...page);
    cursor = next;
  } while (cursor !== 0n);
  if (!ids.length) return [];
  const orders = await ob("getOrders", [ids]);
  return orders.map((o, i) => ({ id: ids[i], maker: getAddress(o.maker), kind: Number(o.kind), price: BigInt(o.price), units: BigInt(o.units), filled: BigInt(o.filled), validUntil: Number(o.validUntil), cancelled: o.cancelled }));
}

async function liveAsks(longId, exclude = []) {
  const t = await now();
  const asset = (await ch("series", [longId])).underlying;
  const per = await ch("collateralPerUnit", [longId]);
  const out = [];
  for (const o of await ordersOf(longId)) {
    if (o.kind === BID || o.cancelled || o.filled >= o.units || (o.validUntil !== 0 && t >= o.validUntil) || exclude.includes(o.maker)) continue;
    if (o.kind === WRITE && (await ch("free", [o.maker, asset])) < per) continue;
    out.push(o);
  }
  return out.sort((a, b) => (a.price === b.price ? Number(a.id - b.id) : a.price < b.price ? -1 : 1));
}

async function deadline() {
  const [, effectiveAt] = await ob("pendingFeeParams");
  const t = await now();
  return Number(effectiveAt) === 0 ? t + 3600 : Math.min(t + 3600, Number(effectiveAt) - 1);
}

/** Buy `units` from the cheapest live asks of `longId` (the dapp's walk), asserting the fill on chain. */
async function buy(role, longId, units, label, options = {}) {
  // The mm-bot replaces its quotes every few seconds: a level read here can be gone when the take is simulated. Retry.
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await buyOnce(role, longId, units, label, options);
    } catch (error) {
      if (!(error instanceof RehearsalError) || attempt >= 4 || !/would revert|quoteTake fills/.test(error.message)) throw error;
      info(`(${label}: ${error.message.slice(0, 120)}; retrying)`);
      await sleep(2_000);
    }
  }
}
async function buyOnce(role, longId, units, label, { only } = {}) {
  const who = accountOf(role);
  let asks = await liveAsks(longId, [who]);
  if (only) asks = asks.filter(only);
  const chosen = [];
  let left = units;
  for (const o of asks) {
    if (left <= 0n) break;
    chosen.push(o);
    left -= o.units - o.filled;
  }
  if (left > 0n) fail(`${label}: only ${units - left} of ${units} units on the book`);
  // INTERFACE_VERSION 8: TakeParams is TEN fields and `maxTotalFee` is the tenth and last. Field order is
  // MIRRORED from the concrete exported ABI, ops/abis/v2/OrderBook.json, not from a doc or from memory.
  // quoteTake does not enforce the cap -- FeeAboveMax appears exactly once in OrderBook.sol, at :462, inside
  // take -- so the quote is taken with the cap at 0 and its answer sets the real cap for the take itself.
  const base = { longId, buying: true, orderIds: chosen.map((o) => o.id), units, minUnits: units, limitPrice: chosen.at(-1).price, writeToSell: false, recipient: who, deadline: await deadline() };
  const [qUnits, qPremium, qFee, qSellerFees] = await ob("quoteTake", [{ ...base, maxTotalFee: 0n }]);
  // Exactly what take charges (OrderBook.sol:461): takerFee + (buying ? 0 : sellerFees). quoteTake already
  // returns sellerFees as 0 on a buy, so this one expression is correct for both sides and needs no branch.
  // `ob` sends the quote without a `from`, so the taker discount is not applied and the quoted fee is the
  // UNdiscounted one -- the cap can only come out at or above what take will charge, never below it.
  const p = { ...base, maxTotalFee: qFee + qSellerFees };
  if (qUnits !== units) fail(`${label}: quoteTake fills ${qUnits} of ${units}`);
  const before = await ch("balanceOf", [who, longId]);
  const usdgBefore = await bal(USDG, who);
  const { hash, receipt } = await send(who, { address: C.orderBook, abi: ABI.orderBook, functionName: "take", args: [p], label, action: "take-buy" });
  const fills = viem.parseEventLogs({ abi: ABI.orderBook, eventName: "OrderFilled", logs: receipt.logs });
  expect((await ch("balanceOf", [who, longId])) === before + units && usdgBefore - (await bal(USDG, who)) === qPremium + qFee,
    `${label}: +${units} units for ${usd(qPremium)} premium + ${usd(qFee)} taker fee (${fills.length} maker order(s): ${fills.map((f) => `${short(f.args.maker)} ${f.args.units}@${usd(f.args.price)}${f.args.primary ? " minted" : " resale"}`).join(", ")}) tx ${hash}`);
  return { hash, units, premium: qPremium, fee: qFee, fills: fills.map((f) => ({ orderId: f.args.orderId.toString(), maker: f.args.maker, units: Number(f.args.units), price: f.args.price.toString(), primary: f.args.primary })) };
}
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

async function indexedTo(block, label) {
  await until(`indexer at block ${block} (${label})`, async () => BigInt((await getJson(`${INDEXER_URL}/v2/health`)).block) >= BigInt(block), { timeoutMs: 180_000, service: "indexer" });
}

/** An indexer read, retried until `check` holds: an API answer can trail /v2/health's block by a checkpoint. */
async function eventually(label, readFn, check, timeoutMs = 120_000) {
  return until(label, async () => {
    const v = await readFn();
    return check(v) ? v : null;
  }, { timeoutMs, intervalMs: 2_000, service: "indexer" });
}

/** The price operator prints a round at the current answer when the last one is older than `maxAgeS`. */
async function refreshFeeds(label, maxAgeS = 1500) {
  const t = await now();
  for (const T of Object.keys(M)) {
    const [, answer, , updatedAt] = await read(M[T].feed, ABI.mockFeed, "latestRoundData");
    if (t - Number(updatedAt) > maxAgeS) await pushRound(M[T].feed, answer, t, `${T} ${label} (same answer)`);
  }
}

/** Age of a ticker's round in force at chain time, seconds. */
async function feedAgeS(T) {
  const [, , , updatedAt] = await read(M[T].feed, ABI.mockFeed, "latestRoundData");
  return (await now()) - Number(updatedAt);
}

async function nextSessionAt(fromTs, minutesAfterOpen) {
  for (let day = Math.floor(fromTs / 86400); day <= Math.floor(fromTs / 86400) + 10; day += 1) {
    if (!(await cal("isSessionDay", [day]))) continue;
    const at = Number(await cal("closeOf", [day])) - 23_400 + minutesAfterOpen * 60;
    if (at > fromTs && (await cal("isRegularSession", [at]))) return at;
  }
  return fail(`no regular session within 10 days of ${fromTs}`);
}

/* ---------------------------------------------------------------------------------------------- */
/*  notifier                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

async function post(url, body, token) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) fail(`POST ${url}: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
async function subscribeTelegram(role, chatId) {
  const signer = signerOf(role);
  const { message, nonce } = await post(`${NOTIFIER_URL}/v1/challenge`, { address: signer.address });
  const signature = await signer.signMessage({ message });
  const { token } = await post(`${NOTIFIER_URL}/v1/session`, { address: signer.address, signature, nonce });
  const { id } = await post(`${NOTIFIER_URL}/v1/subscriptions`, { channel: "telegram", prefs: {} }, token);
  const link = await fetch(`${NOTIFIER_URL}/v1/telegram/link`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
  const startToken = new URL(link.deepLink).searchParams.get("start");
  await post(`${TELEGRAM_URL}/_control/update`, { token: `${NOTIFIER_BOT}:rehearsal-notifier-bot-token`, text: `/start ${startToken}`, chatId });
  await until(`${role}'s Telegram link`, async () => (await getJson(`${TELEGRAM_URL}/_control/messages`)).some((m) => m.bot === NOTIFIER_BOT && m.chatId === String(chatId) && /Linked to wallet/.test(m.text)), { timeoutMs: 60_000 });
  const list = await fetch(`${NOTIFIER_URL}/v1/subscriptions`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
  const sub = list.items.find((x) => x.id === id);
  expect(sub?.status === "active" && sub.channel === "telegram", `${role} ${short(signer.address)} subscribed through the notifier: telegram subscription ${id} active, linked to chat ${chatId} by /start through the Telegram stand-in`);
  return { id, chatId: String(chatId) };
}

/* ---------------------------------------------------------------------------------------------- */

async function main() {
  const t0 = Date.now();
  if (!S.services) fail("step 2 has not passed (state.json has no services)");
  const reg = JSON.parse(execFileSync("cat", [S.registryCopy]).toString());
  const daily = reg.v2.defaults.ladder.daily;
  const acct = Object.fromEntries(["ada", "ben", "cy", "dee", "eve", "fay", "gus", "hal", "ivy", "web"].map((r) => [r, accountOf(r)]));
  let browser = null;
  let browserApi = null;
  if (!SKIP_WEB) {
    browserApi = await import("./browser.mjs");
    browser = await browserApi.openBrowser();
  }

  try {
    /* ------------------------------------------------------------------ 3a */
    step("3a. a regular session with room before the first daily expiry; Telegram subscriptions");
    let t = await now();
    let E1 = Number(await cal("nextExpiry", [BigInt(t + 3600 + 300), false]));
    // The story needs about 30 minutes of chain time before E1's mint cutoff (E1 - 30 min) and the MM's pull (15 min
    // earlier), and the auto-roll must still reach E1: AutoRoller.roll takes the next expiry at least MIN_SERIES_LEAD
    // (1 h) plus the ladder margin away, and it runs after the writers, so E1 must be at least two hours off.
    if (!(await cal("isRegularSession", [t + 60])) || t > E1 - 1800 - 900 - 2700 - 1800) {
      const at = await nextSessionAt(t, 30);
      t = await warpTo(at, "10:00 New York of the next session day");
      await refreshFeeds("session open", 0);
      E1 = Number(await cal("nextExpiry", [BigInt(t + 3600 + 300), false]));
      info(`warped to ${nyTime(t)} New York`);
    }
    const E1weekly = await cal("isWeekly", [E1]);
    info(`chain time ${nyTime(t)} New York; first daily expiry E1 ${E1} = ${nyTime(E1)} New York${E1weekly ? " (also a weekly)" : ""}`);
    remember("E1", E1);
    await refreshFeeds("before trading");
    const subs = {};
    subs.cy = await subscribeTelegram("cy", 700001);
    subs.eve = await subscribeTelegram("eve", 700002);
    subs.ben = await subscribeTelegram("ben", 700003);
    remember("subscriptions", subs);

    /* ------------------------------------------------------------------ 3b */
    step("3b. the cranker's daily ladders on E1");
    const series = {};
    for (const T of Object.keys(M)) {
      const spot = await spotOf(T);
      const strikes = ladderStrikes(spot, daily, BigInt(M[T].strikeTick));
      const ids = await Promise.all(strikes.map((k) => ch("longIdOf", [M[T].asset, false, k, E1])));
      await until(`${T} daily ladder on E1 (${strikes.map((k) => usd(k)).join(", ")})`, async () => (await Promise.all(ids.map((id) => ch("seriesExists", [id])))).every(Boolean), { timeoutMs: 300_000, intervalMs: 3_000, service: "cranker" });
      series[T] = strikes.map((k, i) => ({ rung: i, strike: k.toString(), longId: ids[i].toString() }));
      const listed = await getJson(`${INDEXER_URL}/v2/markets/${T}/series?expiry=${E1}&type=call`).catch(() => ({ items: [] }));
      expect(strikes.length === daily.rungs, `${T} spot ${usd(spot)}: ${strikes.length} daily rungs on E1 created by the cranker (${strikes.map((k) => usd(k)).join(" / ")}); indexer lists ${listed.items?.length ?? 0} E1 calls`);
    }
    remember("series", series);
    const nv0 = BigInt(series.NVDA[0].longId);
    const nv1 = BigInt(series.NVDA[1].longId);
    const ts0 = BigInt(series.TSLA[0].longId);
    const mt0 = BigInt(series.META[0].longId);

    /* ------------------------------------------------------------------ 3c */
    step("3c. writers: deposits, manual asks, the daily auto-roll strategy");
    const approve = (who, token, spender, amount, label) => send(who, { address: token, abi: ABI.erc20, functionName: "approve", args: [spender, amount], label, action: "approve" });
    const ada = acct.ada;
    for (const [T, shares] of [["NVDA", 20n], ["META", 10n]]) {
      await approve(ada, M[T].asset, C.clearinghouse, shares * E18, `ada ${T} approve Clearinghouse`);
      const free0 = await ch("free", [ada, M[T].asset]);
      await send(ada, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "deposit", args: [M[T].asset, shares * E18, ada], label: `ada deposit ${shares} ${T}`, action: "deposit" });
      expect((await ch("free", [ada, M[T].asset])) === free0 + shares * E18, `ada deposited ${shares} ${T} as write collateral`);
    }
    await send(ada, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "setOperator", args: [C.orderBook, true], label: "ada setOperator(book)", action: "setOperator" });
    await send(ada, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "setApprovalForAll", args: [C.orderBook, true], label: "ada setApprovalForAll(book)", action: "setApprovalForAll" });
    await approve(ada, USDG, C.orderBook, 10_000n * E6, "ada USDG approve book");
    const place = async (role, longId, kind, price, units, label) => {
      const { receipt, hash } = await send(acct[role], { address: C.orderBook, abi: ABI.orderBook, functionName: "place", args: [longId, kind, price, units, 0], label, action: `place-${["bid", "resale", "write"][kind]}` });
      return { orderId: placedOrderId(receipt, C.orderBook), hash };
    };
    const asks = {};
    const nv0Fair = await fairOf("NVDA", series.NVDA[0].strike, E1);
    const nv1Fair = await fairOf("NVDA", series.NVDA[1].strike, E1);
    const mt0Fair = await fairOf("META", series.META[0].strike, E1);
    asks.adaNv0 = await place("ada", nv0, WRITE, roundTick((nv0Fair * 102n) / 100n), 200n, "ada AskWrite NVDA E1 r0 2.00 shares");
    asks.adaNv1 = await place("ada", nv1, WRITE, roundTick((nv1Fair * 102n) / 100n), 100n, "ada AskWrite NVDA E1 r1 1.00 share");
    asks.adaMt0 = await place("ada", mt0, WRITE, roundTick((mt0Fair * 102n) / 100n), 100n, "ada AskWrite META E1 r0 1.00 share");
    info(`fair NVDA r0 ${usd(nv0Fair)}, r1 ${usd(nv1Fair)}, META r0 ${usd(mt0Fair)} USDG/share (stand-in); ada asks at fair + 2 %`);

    const roller = { min: Number(await read(C.autoRoller, ABI.autoRoller, "MIN_ASK_BPS")), max: Number(await read(C.autoRoller, ABI.autoRoller, "MAX_ASK_BPS")), minOtm: Number(await read(C.autoRoller, ABI.autoRoller, "MIN_OTM_BPS")) };
    const ROLL = { otmBps: Math.max(100, roller.minOtm), askBps: 80, minAskBps: Math.max(40, roller.min), maxAskBps: Math.min(200, roller.max), maxShares: 1 };
    const benAskPrice = roundTick((nv0Fair * 104n) / 100n);
    const ben = acct.ben;
    if (browser) {
      const w = new browserApi.BrowserWallet(ben, "ben");
      const r = await browserApi.writerFlow(browser, { wallet: w, depositShares: 3,
        ask: { expiry: E1, longId: nv0.toString(), shares: "0.50", price: (Number(benAskPrice) / 1e6).toFixed(4) },
        roll: ROLL, settlementOracle: C.settlementOracle, underlying: M.NVDA.asset });
      ledgerAppend(w.calls.map((c) => ({ step: "3-story", action: `browser-${c.name}`, label: `ben (browser /earn/nvda) ${c.name}`, from: ben, to: c.to, hash: c.hash, status: c.status, gasUsed: c.gasUsed, block: c.block, ts: null })));
      remember("browserWriter", { calls: w.calls });
      info(`ben's page sent ${w.calls.length} transactions: ${w.calls.map((c) => c.name).join(", ")}`);
    } else {
      await approve(ben, M.NVDA.asset, C.clearinghouse, 3n * E18, "ben NVDA approve Clearinghouse");
      await send(ben, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "deposit", args: [M.NVDA.asset, 3n * E18, ben], label: "ben deposit 3 NVDA", action: "deposit" });
      await send(ben, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "setOperator", args: [C.orderBook, true], label: "ben setOperator(book)", action: "setOperator" });
      await place("ben", nv0, WRITE, benAskPrice, 50n, "ben AskWrite NVDA E1 r0 0.50 share");
      await send(ben, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "setOperator", args: [C.autoRoller, true], label: "ben setOperator(roller)", action: "setOperator" });
      await send(ben, { address: C.orderBook, abi: ABI.orderBook, functionName: "setDelegate", args: [C.autoRoller, true], label: "ben setDelegate(roller)", action: "setDelegate" });
      await send(ben, { address: C.autoRoller, abi: ABI.autoRoller, functionName: "setStrategy", args: [M.NVDA.asset, { active: true, weekly: false, smartPricing: true, otmBps: ROLL.otmBps, askBps: ROLL.askBps, minAskBps: ROLL.minAskBps, maxAskBps: ROLL.maxAskBps, maxUnits: BigInt(ROLL.maxShares * 100) }], label: "ben setStrategy NVDA daily", action: "setStrategy" });
    }
    expect((await ch("free", [ben, M.NVDA.asset])) >= 3n * E18, "ben's 3 NVDA are free write collateral");
    const benOrders = (await ordersOf(nv0)).filter((o) => o.maker === ben && o.kind === WRITE && !o.cancelled);
    expect(benOrders.some((o) => o.units === 50n), `ben's manual AskWrite: 50 units on NVDA E1 r0 at ${usd(benOrders[0]?.price ?? 0n)}`);
    const strat = await read(C.autoRoller, ABI.autoRoller, "strategy", [ben, M.NVDA.asset]);
    expect(strat.active && !strat.weekly && strat.smartPricing, `ben's auto-roll strategy on chain: daily, ${strat.otmBps} bps OTM, ask ${strat.askBps} bps of spot (smart ${strat.minAskBps}-${strat.maxAskBps}), max ${strat.maxUnits} units`);
    const rolled = await until("the cranker's roll of ben's strategy", async () => {
      const [longId, orderId, expiry] = await read(C.autoRoller, ABI.autoRoller, "position", [ben, M.NVDA.asset]);
      return orderId !== 0n ? { longId, orderId, expiry: Number(expiry) } : null;
    }, { timeoutMs: 240_000, intervalMs: 3_000, service: "cranker" });
    const rollLogs = await pub.getContractEvents({ address: C.autoRoller, abi: ABI.autoRoller, eventName: "Rolled", args: { writer: ben }, fromBlock: BigInt(S.deployBlock) });
    expect(rolled.expiry === E1 && rollLogs.length >= 1, `the cranker rolled ben: Rolled into ${nyTime(rolled.expiry)} series ${rolled.longId === nv0 ? "NVDA E1 r0" : rolled.longId}, AskWrite order ${rolled.orderId} (tx ${rollLogs.at(-1)?.transactionHash})`);
    remember("roll1", { ...rolled, longId: rolled.longId.toString(), orderId: rolled.orderId.toString(), tx: rollLogs.at(-1)?.transactionHash });
    await indexedTo(await pub.getBlockNumber(), "writers");
    await eventually("ben's strategy in /v2/strategies", () => getJson(`${INDEXER_URL}/v2/strategies?active=1`), (x) => (x.items ?? []).some((s) => getAddress(s.writer) === ben && s.ticker === "NVDA"));
    expect(true, "indexer /v2/strategies lists ben's active NVDA strategy");

    /* ------------------------------------------------------------------ 3d */
    step("3d. MM quotes appear (mm-bot through the MakerVault)");
    const vaultQuotes = await until("two-sided MakerVault quotes on at least three series, NVDA E1 and TSLA E1 among them", async () => {
      const count = await ob("makerOrderCount", [C.makerVault]);
      if (count === 0n) return null;
      const [ids] = await ob("ordersOfMaker", [C.makerVault, 0n, count]);
      const orders = await ob("getOrders", [ids]);
      const t1 = await now();
      const by = new Map();
      orders.forEach((o, i) => {
        if (o.cancelled || o.filled >= o.units || t1 >= Number(o.validUntil)) return;
        const k = o.longId.toString();
        by.set(k, [...(by.get(k) ?? []), { id: ids[i], kind: Number(o.kind), price: o.price, units: o.units }]);
      });
      const two = [...by].filter(([, os]) => os.some((o) => o.kind === BID) && os.some((o) => o.kind !== BID));
      const e1Ids = new Set([...series.NVDA, ...series.TSLA].map((x) => x.longId));
      const tslaAsk = (by.get(ts0.toString()) ?? []).some((o) => o.kind !== BID);
      return two.length >= 3 && two.some(([id]) => e1Ids.has(id)) && tslaAsk ? { two, by } : null;
    }, { timeoutMs: 300_000, intervalMs: 5_000, service: "mm-bot" });
    await indexedTo(await pub.getBlockNumber(), "vault quotes");
    const inBook = (b) => b.asks.some((l) => l.orders.some((o) => getAddress(o.maker) === C.makerVault));
    const tsBook = await eventually("the vault's TSLA ask in the indexer's book", () => getJson(`${INDEXER_URL}/v2/series/${ts0}/book?depth=20`), inBook);
    const vaultInBook = inBook(tsBook);
    expect(vaultQuotes.two.length >= 3 && vaultInBook, `MM quotes: the vault is two-sided on ${vaultQuotes.two.length} series; the indexer's TSLA E1 r0 book shows its ask (${tsBook.asks.map((l) => `${l.units}@${l.price.formatted}`).join(", ")})`);
    remember("mmQuotes", { twoSided: vaultQuotes.two.length });

    /* ------------------------------------------------------------------ 3e */
    step("3e. buyers take 0.01 / 0.1 / 1 share; MM and META fills; the browser buyer");
    for (const role of ["cy", "dee", "eve", "fay", "gus", "hal", "ivy"]) await approve(acct[role], USDG, C.orderBook, 10_000n * E6, `${role} USDG approve book`);
    const buys = {};
    buys.cy = await buy("cy", nv0, 1n, "cy buys 0.01 share NVDA E1 r0");
    buys.dee = await buy("dee", nv1, 10n, "dee buys 0.1 share NVDA E1 r1");
    buys.eve = await buy("eve", nv0, 100n, "eve buys 1 share NVDA E1 r0");
    buys.hal = await buy("hal", ts0, 50n, "hal buys 0.5 share TSLA E1 r0 from the MM vault", { only: (o) => o.maker === C.makerVault });
    buys.ivy = await buy("ivy", mt0, 50n, "ivy buys 0.5 share META E1 r0");
    expect(buys.hal.fills.every((f) => getAddress(f.maker) === C.makerVault && f.primary), "hal's TSLA buy filled the vault's AskWrite (an MM fill, minted)");
    if (browser) {
      // The home page opens with the feeds as they stand (a round on 4663 is normally hours old): a buyable card here
      // means the cards judge the quote against the oracle's spot age, not a 60 s window. When no card offers the buy,
      // buyerFlow calls back for a printed round and a reload (W2-14's workaround) and the run records it.
      await indexedTo(await pub.getBlockNumber(), "the buys, before the browser opens the cards");
      const ageS = await feedAgeS("NVDA");
      const w = new browserApi.BrowserWallet(acct.web, "web buyer");
      const r = await browserApi.buyerFlow(browser, {
        wallet: w,
        onStale: async () => {
          await refreshFeeds("the home cards were not buyable", 0);
          await indexedTo(await pub.getBlockNumber(), "fresh round for the cards");
        },
      });
      ledgerAppend(w.calls.map((c) => ({ step: "3-story", action: `browser-${c.name}`, label: `web buyer (browser card) ${c.name}`, from: acct.web, to: c.to, hash: c.hash, status: c.status, gasUsed: c.gasUsed, block: c.block, ts: null })));
      expect((await ch("balanceOf", [acct.web, BigInt(r.longId)])) === 1n, `browser buyer: home card -> ticket -> Buy now minted 0.01 share of ${r.longId.slice(0, 12)}… (tx ${r.take.hash})`);
      const ageMin = Math.round(ageS / 60);
      if (r.natural) expect(true, `home cards: the "Buy 0.01 share" card was live with NVDA's round ${ageMin} min old — no round printed for the page`);
      else info(`home cards: no "Buy 0.01 share" with NVDA's round ${ageMin} min old ("${r.notice}"); bought after a printed round and a reload (deviation)`);
      remember("cards", { natural: r.natural, roundAgeS: ageS, notice: r.notice });
      buys.web = { longId: r.longId, hash: r.take.hash };
    }
    remember("buys", buys);
    await indexedTo(await pub.getBlockNumber(), "buys");
    for (const role of ["cy", "dee", "eve"]) {
      const want = role === "dee" ? nv1 : nv0;
      const rowOf = (p) => p.longs.find((l) => l.series.longId === want.toString());
      const pos = await eventually(`${role}'s position in the indexer`, () => getJson(`${INDEXER_URL}/v2/accounts/${acct[role]}/positions`), (p) => rowOf(p) && BigInt(rowOf(p).units) === buys[role].units);
      const row = rowOf(pos);
      expect(row && BigInt(row.units) === buys[role].units, `indexer positions: ${role} holds ${row?.units} units of NVDA ${role === "dee" ? "r1" : "r0"}`);
    }
    const trades = await eventually("cy's and eve's takes in /v2/series trades", () => getJson(`${INDEXER_URL}/v2/series/${nv0}/trades`), (t) => [buys.cy.hash, buys.eve.hash].every((h) => t.items.some((x) => x.tx.toLowerCase() === h.toLowerCase())));
    expect([buys.cy.hash, buys.eve.hash].every((h) => trades.items.some((x) => x.tx.toLowerCase() === h.toLowerCase())), `indexer /v2/series/NVDA r0/trades lists cy's and eve's takes (${trades.items.length} trades)`);

    /* ------------------------------------------------------------------ 3f */
    step("3f. one resale: eve lists 0.40 share, fay buys it");
    const eve = acct.eve;
    await send(eve, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "setApprovalForAll", args: [C.orderBook, true], label: "eve setApprovalForAll(book)", action: "setApprovalForAll" });
    // eve's 100 units are one share: her premium is the per-share price she paid
    const resalePrice = roundTick((BigInt(buys.eve.premium) * 125n) / 100n);
    const resale = await place("eve", nv0, RESALE, resalePrice, 40n, "eve AskResale 0.40 share NVDA E1 r0");
    expect((await ch("balanceOf", [C.orderBook, nv0])) >= 40n, `eve's 40 units escrowed by the book (order ${resale.orderId} at ${usd(resalePrice)})`);
    const eveUsdg0 = await bal(USDG, eve);
    buys.fay = await buy("fay", nv0, 40n, "fay buys eve's 0.40 share resale", { only: (o) => o.id === resale.orderId });
    const resaleFill = buys.fay.fills[0];
    expect(!resaleFill.primary && getAddress(resaleFill.maker) === eve && (await bal(USDG, eve)) > eveUsdg0 && (await ch("balanceOf", [eve, nv0])) === 60n, `resale delivered: fay +40 units from the escrow, eve paid ${usd((await bal(USDG, eve)) - eveUsdg0)} USDG net, eve keeps 60 units`);
    remember("resale", { orderId: resale.orderId.toString(), price: resalePrice.toString(), tx: buys.fay.hash });

    /* ------------------------------------------------------------------ 3g */
    step("3g. one bid hit by writing: gus bids on NVDA E1 r1, ada writes into it");
    const bidPrice = roundTick((nv1Fair * 90n) / 100n);
    const bid = await place("gus", nv1, BID, bidPrice, 30n, "gus Bid 0.30 share NVDA E1 r1");
    const adaShort0 = await ch("balanceOf", [ada, nv1 | 1n]);
    const gusLong0 = await ch("balanceOf", [acct.gus, nv1]);
    const adaUsdg0 = await bal(USDG, ada);
    const spBase = { longId: nv1, buying: false, orderIds: [bid.orderId], units: 30n, minUnits: 30n, limitPrice: bidPrice, writeToSell: true, recipient: ada, deadline: await deadline() };
    // Selling into a bid, so the taker pays its OWN seller fees on top of the taker fee -- which is why
    // quoteTake returns sellerFees non-zero here and zero on a buy (OrderBook.sol:481-483), and why the cap
    // is the sum of both (:461).
    const [, , spTakerFee, spSellerFees] = await ob("quoteTake", [{ ...spBase, maxTotalFee: 0n }]);
    const sp = { ...spBase, maxTotalFee: spTakerFee + spSellerFees };
    const hit = await send(ada, { address: C.orderBook, abi: ABI.orderBook, functionName: "take", args: [sp], label: "ada writes 0.30 share NVDA E1 r1 into gus's bid", action: "take-write-to-sell" });
    const hitFill = viem.parseEventLogs({ abi: ABI.orderBook, eventName: "OrderFilled", logs: hit.receipt.logs })[0];
    expect(hitFill.args.primary && !hitFill.args.takerIsBuyer && (await ch("balanceOf", [ada, nv1 | 1n])) === adaShort0 + 30n && (await ch("balanceOf", [acct.gus, nv1])) === gusLong0 + 30n && (await bal(USDG, ada)) > adaUsdg0,
      `bid hit by writing: 30 units minted from ada's collateral, longs to gus, shorts to ada, ada +${usd((await bal(USDG, ada)) - adaUsdg0)} USDG (tx ${hit.hash})`);
    remember("bidHit", { orderId: bid.orderId.toString(), tx: hit.hash });
    await indexedTo(await pub.getBlockNumber(), "resale and bid");
    await eventually("eve's resale fill in /v2/accounts history", () => getJson(`${INDEXER_URL}/v2/accounts/${eve}/history?limit=100`), (h) => h.items.some((x) => x.kind === "fill" && x.data?.tx?.toLowerCase() === buys.fay.hash.toLowerCase()));
    expect(true, "indexer history: eve's resale fill");

    /* ------------------------------------------------------------------ 3h */
    step("3h. E1 reaches expiry (warp): window, snapshot, finalize, settle, prune, redeem");
    const e1Series = Object.entries(series).flatMap(([T, list]) => list.map((x) => ({ T, ...x, longId: BigInt(x.longId) })));
    // TransferSingle's id is not indexed: read the Clearinghouse's transfers once per check and filter here.
    let transfers = [];
    const loadTransfers = async () => {
      transfers = await pub.getContractEvents({ address: C.clearinghouse, abi: ABI.clearinghouse, eventName: "TransferSingle", fromBlock: BigInt(S.deployBlock) });
    };
    const holdersOf = async (id) => [...new Set(transfers.filter((l) => l.args.id === id).map((l) => getAddress(l.args.to)).filter((a) => a !== "0x0000000000000000000000000000000000000000"))];
    t = await warpTo(E1 - 60, "one minute before E1: the settlement window's rounds");
    const settle = {};
    for (const T of Object.keys(M)) {
      let answer;
      if (M[T].pool) {
        const [ok, twap] = await read(C.sources.univ3, ABI.univ3, "latest", [M[T].asset]);
        if (!ok) fail(`${T} pool TWAP not ok before E1`);
        answer = twap * 100n;
        settle[T] = { poolTwap: twap.toString() };
      } else {
        answer = BigInt(loadState().open[T].settleAnswer8);
        settle[T] = {};
      }
      await pushRound(M[T].feed, answer, E1 - 2100, `${T} window start ${usd(answer / 100n)}`);
      await pushRound(M[T].feed, answer, E1 - 900, `${T} inside the window`);
      await pushRound(M[T].feed, answer, t, `${T} one minute before expiry`);
      settle[T].feedAnswer = answer.toString();
      info(`${T}: rounds at ${usd(answer / 100n)} across [E1 - 35 min, E1]${M[T].pool ? " (the pool's TWAP)" : " (+3 %)"}`);
    }
    await warpTo(E1 + 5, "E1 + 5 s: the snapshot grace");
    const recorded = await until("the cranker's pool snapshots (NVDA, TSLA)", async () => {
      const got = {};
      for (const T of ["NVDA", "TSLA"]) {
        const logs = await pub.getContractEvents({ address: C.sources.univ3, abi: ABI.univ3, eventName: "Recorded", args: { underlying: M[T].asset, expiry: E1 } , fromBlock: BigInt(S.deployBlock) });
        if (!logs.length) return null;
        got[T] = logs[0];
      }
      return got;
    }, { timeoutMs: 240_000, intervalMs: 2_000, service: "cranker" });
    for (const T of ["NVDA", "TSLA"]) {
      const tx = await pub.getTransaction({ hash: recorded[T].transactionHash });
      const blk = await pub.getBlock({ blockNumber: recorded[T].blockNumber });
      expect(getAddress(tx.from) === accountOf("cranker") && Number(blk.timestamp) <= E1 + 600, `${T} snapshot by the cranker at E1 + ${Number(blk.timestamp) - E1} s: pool TWAP ${usd(recorded[T].args.price)} (tx ${recorded[T].transactionHash})`);
      settle[T].snapshotTx = recorded[T].transactionHash;
    }
    await warpTo(E1 + 125, "E1 + 125 s: past FINALIZE_DELAY");
    const fin = await until("NVDA and TSLA Finalized, META a Pending candidate", async () => {
      const out = {};
      for (const T of Object.keys(M)) out[T] = await oracle("settlementInfo", [M[T].asset, E1]);
      return Number(out.NVDA[0]) === 2 && Number(out.TSLA[0]) === 2 && Number(out.META[0]) === 1 ? out : null;
    }, { timeoutMs: 240_000, intervalMs: 2_000, service: "cranker" });
    for (const T of ["NVDA", "TSLA"]) {
      const [, price, sourceIndex, corroborated] = fin[T];
      expect(corroborated && Number(sourceIndex) === 0, `${T} E1 Finalized at ${usd(price)} corroborated (Chainlink agreed with the pool snapshot)`);
      settle[T].price = price.toString();
    }
    const [cPrice, cIndex, cDisagreed, finalizableAt] = await oracle("candidate", [M.META.asset, E1]);
    expect(!cDisagreed && Number(cIndex) === 0 && Number(finalizableAt) >= E1 + 120 + 21_600 - 5, `META E1 single-source candidate ${usd(cPrice)}, finalizable ${nyTime(Number(finalizableAt))} NY (the 6 h uncorroborated delay)`);
    settle.META.candidate = { price: cPrice.toString(), finalizableAt: Number(finalizableAt) };
    await indexedTo(await pub.getBlockNumber(), "finalize");
    const metaSeries = await eventually("META E1 r0 settling in the indexer", () => getJson(`${INDEXER_URL}/v2/series/${mt0}`), (x) => x.series.status === "settling" && x.settlement?.candidate != null);
    expect(metaSeries.series.status === "settling" && metaSeries.settlement?.candidate !== null, `indexer: META E1 r0 status ${metaSeries.series.status}, candidate ${metaSeries.settlement?.candidate?.price?.formatted}`);

    const paidCheck = async (markets, label) => until(label, async () => {
      await loadTransfers();
      for (const s of e1Series.filter((x) => markets.includes(x.T))) {
        const info_ = await ch("series", [s.longId]);
        if (!info_.settled) {
          // a series nobody ever minted has no supply to settle
          if ((await holdersOf(s.longId)).length === 0) continue;
          return null;
        }
        for (const [id, per] of [[s.longId, info_.longPayoutPerUnit], [s.longId | 1n, info_.shortPayoutPerUnit]]) {
          if (per === 0n) continue;
          // the OrderBook opts out of third-party redeem and holds nothing once the cranker has pruned
          for (const h of await holdersOf(id)) if (h !== C.orderBook && (await ch("balanceOf", [h, id])) > 0n) return null;
        }
      }
      return true;
    }, { timeoutMs: 420_000, intervalMs: 3_000, service: "cranker" });
    await paidCheck(["NVDA", "TSLA"], "the cranker settles, prunes and redeems every NVDA and TSLA E1 holder with a payout");
    expect(true, "cranker paid everyone on NVDA and TSLA E1: every holder of a long or short with a non-zero payout redeemed");
    const redeemed = await pub.getContractEvents({ address: C.clearinghouse, abi: ABI.clearinghouse, eventName: "Redeemed", fromBlock: BigInt(S.deployBlock) });
    const longRedemptions = (T) => redeemed.filter((r) => e1Series.some((s) => s.T === T && s.longId === r.args.tokenId) && r.args.amountInKind > 0n);
    const nvdaPaid = longRedemptions("NVDA");
    // r0 always finishes in the money (cy, eve and fay hold it); r1 and the series the browser card picked depend on
    // where the ladder's tick rounding put their strikes, so only the three r0 holders are guaranteed a payout.
    expect(nvdaPaid.length >= 3 && nvdaPaid.every((r) => getAddress(r.args.asset) === getAddress(USDG) && r.args.amount > 0n),
      `USDG conversion on NVDA: ${nvdaPaid.length} ITM long redemptions paid in USDG through the PayoutAdapter (${nvdaPaid.map((r) => `${short(r.args.holder)} ${r.args.units}u ${(Number(r.args.amountInKind) / 1e18).toFixed(5)} NVDA -> ${usd(r.args.amount)}`).join("; ")})`);
    const tslaPaid = longRedemptions("TSLA");
    expect(tslaPaid.length >= 1 && tslaPaid.every((r) => getAddress(r.args.asset) === getAddress(USDG)), `USDG conversion on TSLA (0.30 % pool, 60 bps floor): ${tslaPaid.map((r) => `${short(r.args.holder)} ${(Number(r.args.amountInKind) / 1e18).toFixed(5)} TSLA -> ${usd(r.args.amount)}`).join("; ")}`);
    const cranked = redeemed.filter((r) => nvdaPaid.includes(r) || tslaPaid.includes(r));
    const redeemTxFrom = new Set(await Promise.all([...new Set(cranked.map((r) => r.transactionHash))].map(async (h) => getAddress((await pub.getTransaction({ hash: h })).from))));
    expect([...redeemTxFrom].every((a) => a === accountOf("cranker")), "every NVDA/TSLA long redemption was sent by the cranker");

    t = await warpTo(Number(finalizableAt) + 5, "past META's uncorroborated delay");
    await refreshFeeds("after the META delay", 0);
    await until("META E1 Finalized after the delay", async () => Number((await oracle("settlementInfo", [M.META.asset, E1]))[0]) === 2, { timeoutMs: 240_000, intervalMs: 2_000, service: "cranker" });
    const [, metaPrice, , metaCorroborated] = await oracle("settlementInfo", [M.META.asset, E1]);
    expect(!metaCorroborated, `META E1 Finalized uncorroborated at ${usd(metaPrice)} after the delay`);
    settle.META.price = metaPrice.toString();
    await paidCheck(["META"], "the cranker settles and redeems every META E1 holder with a payout");
    const redeemed2 = await pub.getContractEvents({ address: C.clearinghouse, abi: ABI.clearinghouse, eventName: "Redeemed", fromBlock: BigInt(S.deployBlock) });
    const metaPaid = redeemed2.filter((r) => e1Series.some((s) => s.T === "META" && s.longId === r.args.tokenId) && r.args.amountInKind > 0n);
    expect(metaPaid.length >= 1 && metaPaid.every((r) => getAddress(r.args.asset) === M.META.asset && r.args.amount === r.args.amountInKind),
      `in-kind fallback on META (no pool, no route): ${metaPaid.map((r) => `${short(r.args.holder)} ${(Number(r.args.amount) / 1e18).toFixed(6)} META`).join("; ")}`);
    const rewards = await pub.getContractEvents({ address: C.keeperRewards, abi: ABI.keeperRewards, eventName: "Rewarded", fromBlock: BigInt(S.deployBlock) });
    const bounty = rewards.reduce((a, r) => a + r.args.amount, 0n);
    info(`KeeperRewards paid ${rewards.length} bounties, ${usd(bounty)} USDG, to ${[...new Set(rewards.map((r) => short(r.args.keeper)))].join(", ")}`);
    settle.bounties = { count: rewards.length, usdg: bounty.toString() };
    remember("settlement", settle);

    /* ------------------------------------------------------------------ 3i */
    step("3i. auto-roll rolls into the next daily expiry");
    const sessionAt = await nextSessionAt(await now(), 5);
    t = await warpTo(sessionAt, "09:35 New York of the next session day");
    await refreshFeeds("next session open", 0);
    const roll2 = await until("the cranker rolls ben's strategy into the next daily expiry", async () => {
      const [longId, orderId, expiry] = await read(C.autoRoller, ABI.autoRoller, "position", [ben, M.NVDA.asset]);
      return orderId !== 0n && Number(expiry) > E1 ? { longId, orderId, expiry: Number(expiry) } : null;
    }, { timeoutMs: 300_000, intervalMs: 3_000, service: "cranker" });
    const rolls = await pub.getContractEvents({ address: C.autoRoller, abi: ABI.autoRoller, eventName: "Rolled", args: { writer: ben }, fromBlock: BigInt(S.deployBlock) });
    const last = rolls.at(-1);
    expect(Number(last.args.expiry) === roll2.expiry && getAddress((await pub.getTransaction({ hash: last.transactionHash })).from) === accountOf("cranker"),
      `auto-roll rolled: ben's NVDA call ${usd(last.args.strike)} ${nyTime(roll2.expiry)} NY, ${last.args.units} units at ${usd(last.args.price)} (Rolled by the cranker, tx ${last.transactionHash})`);
    remember("roll2", { longId: roll2.longId.toString(), orderId: roll2.orderId.toString(), expiry: roll2.expiry, tx: last.transactionHash });

    /* ------------------------------------------------------------------ 3j */
    step("3j. wins feed, leaderboard, PNL");
    await indexedTo(await pub.getBlockNumber(), "after the roll");
    const wins = await until("wins for eve and ivy in /v2/feed/wins", async () => {
      const w = await getJson(`${INDEXER_URL}/v2/feed/wins?window=all`);
      const has = (who) => w.items.some((x) => getAddress(x.holder) === who);
      return has(eve) && has(acct.ivy) ? w : null;
    }, { timeoutMs: 180_000, intervalMs: 3_000, service: "indexer" });
    expect(wins.items.every((x) => BigInt(x.payout.raw) > BigInt(x.cost.raw)), `/v2/feed/wins: ${wins.items.map((x) => `${short(x.holder)} ${x.ticker} ${x.multiple}x`).join(", ")}`);
    const board = await eventually("eve on /v2/leaderboard", () => getJson(`${INDEXER_URL}/v2/leaderboard?metric=multiple&window=all`), (b) => b.items.length >= 2 && b.items.some((x) => getAddress(x.holder) === eve));
    expect(board.items.length >= 2 && board.items.some((x) => getAddress(x.holder) === eve), `/v2/leaderboard (multiple, all): ${board.items.map((x) => `#${x.rank} ${short(x.holder)} ${x.value}`).join(", ")}`);
    const eveWin = wins.items.find((x) => getAddress(x.holder) === eve);
    const pnl = await eventually("eve's /v2/pnl", () => getJson(`${INDEXER_URL}/v2/pnl/${eveWin.id}`), (p) => BigInt(p.payout.raw) > 0n && p.settlementPrice?.raw === settle.NVDA.price);
    expect(BigInt(pnl.payout.raw) > 0n && pnl.settlementPrice?.raw === settle.NVDA.price, `/v2/pnl/${eveWin.id.slice(0, 16)}…: cost ${pnl.cost.formatted}, payout ${pnl.payout.formatted}, settlement ${pnl.settlementPrice.formatted}`);
    const stats = await getJson(`${INDEXER_URL}/v2/stats`);
    info(`/v2/stats: volume ${stats.volumeAll?.formatted}, contracts filled ${stats.contractsFilled}, biggest win this week ${stats.biggestWinWeek?.multiple}x`);
    remember("wins", { count: wins.items.length, eve: eveWin.id, leaderboard: board.items.length });
    if (browser) {
      const w = new browserApi.BrowserWallet(eve, "eve");
      const r = await browserApi.resultsFlow(browser, { winner: w, pnlId: eveWin.id });
      expect(r.image.status === 200 && /image\/png/.test(r.image.contentType ?? "") && r.image.png && r.image.bytes > 1000, `PNL image rendered by the web: ${r.image.bytes} bytes image/png (${path.basename(r.image.file)})`);
      remember("screenshots", r.shots);
    }

    /* ------------------------------------------------------------------ 3k */
    step("3k. notifications delivered");
    const want = [
      ["cy", /^Bought /],
      ["eve", /^Bought /],
      ["eve", /^Sold /],
      ["eve", /settled: paid/],
      ["ben", /^Auto-roll listed your next NVDA call/],
    ];
    const rollMessages = (all) => all.filter((m) => m.chatId === subs.ben.chatId && /^Auto-roll listed your next NVDA call/.test(m.text)).length;
    const msgs = await until("the notifier's receipts in the linked chats", async () => {
      const all = (await getJson(`${TELEGRAM_URL}/_control/messages`)).filter((m) => m.bot === NOTIFIER_BOT);
      return want.every(([role, re]) => all.some((m) => m.chatId === subs[role].chatId && re.test(m.text))) && rollMessages(all) >= 2 ? all : null;
    }, { timeoutMs: 300_000, intervalMs: 5_000, service: "notifier" });
    for (const [role, re] of want) {
      const m = msgs.find((x) => x.chatId === subs[role].chatId && re.test(x.text));
      expect(Boolean(m), `${role}'s chat received "${m.text.split("\n")[0]}"`);
    }
    expect(rollMessages(msgs) >= 2, `ben's chat received ${rollMessages(msgs)} auto-roll receipts (the roll into E1 and the roll after it)`);
    const rows = execFileSync("psql", ["-h", "127.0.0.1", "-p", String(PORTS.postgres), "-U", "postgres", "-At", "-c", "select kind || ':' || status || ':' || count(*) from notifier.delivery group by kind, status order by 1"]).toString().trim().split("\n");
    const sent = (kind) => rows.some((r) => r.startsWith(`${kind}:sent:`));
    expect(["fill_receipt", "settlement_receipt", "auto_roll"].every(sent) && !rows.some((r) => /:failed:/.test(r)), `notifier.delivery: fill_receipt, settlement_receipt and auto_roll rows sent, none failed (${rows.join(", ")})`);
    remember("notifications", { messages: msgs.length, deliveries: rows });

    remember("finishedAt", new Date().toISOString());
    say(`\nSTEP 3 PASSED: story complete in ${Math.round((Date.now() - t0) / 1000)} s (chain time now ${nyTime(await now())} New York)`);
  } finally {
    if (browser) await browser.close();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`\nSTEP 3 FAILED: ${error instanceof RehearsalError ? error.message : (error?.stack ?? error)}\n`);
  process.exitCode = 1;
}
