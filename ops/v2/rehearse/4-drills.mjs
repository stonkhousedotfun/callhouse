#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * Step 4 of the v7 rehearsal: failure drills (plus the INTERFACE_VERSION 6
 * drills), after the story of step 3, against the same fork and the same live stack.
 *
 * MODES (drill-kit.mjs sandbox). A `sandbox` drill runs on an evm_snapshot of the fork with the live stack frozen
 * (SIGSTOP: indexer, notifier, cranker, mm-bot, pricer) and its own processes (a cranker with a fresh journal and no
 * indexer, and where needed a second cranker or an MM bot), then everything it started is stopped, the fork is reverted
 * and the stack thawed: every sandbox drill starts from the same post-story state, in any order. A `forward` drill needs
 * the live indexer, notifier or web, so it runs on the real timeline and puts back what it changed.
 *
 *   monitor baseline   ops/v2/monitor.mjs --once adopts the history of steps 1-3 (forward state out/monitor/)
 *   indexer-down       forward   Ponder stopped under an open series page: the book is rebuilt from chain, 0.01 share
 *                                bought (Playwright); Ponder restarted, it catches up and lists the fill
 *   D = the dual-source launch market (NVDA), X = the single-source one (SPCX, pool nulled on the copy).
 *   feed-paused        sandbox   D and X oraclePaused() across finalize: D a pool-only candidate, X no
 *                                source (v2_settle_stuck after an hour); flag cleared: the cranker's retry corroborates
 *                                D, captures X; both settle and pay
 *   sources-disagree   sandbox   D window rounds 3 % above the pool (v7: TSLA; D is the only pooled market): candidate disagreed, v2_sources_disagree,
 *                                finalized uncorroborated after the 6 h delay, paid
 *   guardian-veto      sandbox   X candidate vetoed: Held, v2_settlement_held, no finalize past the delay; adminResolve
 *                                TooEarly before 48 h, ResolveOutOfBand outside the band, then resolved; settled and paid
 *   cranker-killed     sandbox   cranker A (anvil #8) snapshots (and prunes an expired resale ask) and is SIGKILLed;
 *                                cranker B (anvil #11, own journal) finalizes, settles and redeems; every Redeemed once
 *                                per (token, holder)
 *   mint-paused        sandbox   guardian setMintPaused(D): mint, AskWrite fills and writeToSell refused, resale fills,
 *                                close works, the MM bot pulls its D write quotes, the expiry settles and redeems while
 *                                paused, unpause mints again
 *   fee-change         sandbox   setFeeParams (+1 % seller fee, +0.05 USDG taker fee): a take before effectiveAt pays the
 *                                old fees, a take quoted at the old fees and sent after activation reverts FeeAboveMax
 *                                rather than silently paying the new one, a take past its deadline reverts DeadlinePassed, a
 *                                fresh take pays the new fees
 *   pin-refused        sandbox   ChainlinkFeedSource.setOracle(oracle, false): createSeries of a new expiry reverts
 *                                SourceNotPinned, the cranker pages v2_pin_refused; restored: after its 900 s recheck
 *                                the cranker creates the ladder and pins the expiry
 *   reprice            sandbox   the stand-in's fair value on D moved past ben's band (/_control/fair-scale): a drill
 *                                pricer (anvil #9, fresh journal) reprices ben's roll ask to the band's ceiling: Repriced
 *                                from its key, remainder and validUntil kept, position() on the new ask
 *   stale-cancel-notify forward  permissionless AutoRoller.cancelStale after the spot reaches ben's live roll strike;
 *                                the fake Telegram receives auto_roll withdrawn; the feed's answer
 *                                is put back. Runs before usdg-paused: that drill warps past the close of ben's roll
 *                                expiry, and a v8 AutoRoller rolls only in session, so ben has no live ask after it
 *   usdg-paused        forward   USDG paused() between the snapshot and finalize of the next daily expiry: the live
 *                                cranker redeems, a put payout is credited to the ledger (notifier
 *                                payout_failed_to_ledger), a converted call payout falls back to in kind; unpaused, the
 *                                holder withdraws
 *   monitor            both      every drill's monitor.mjs --once run (inside its sandbox, on a copy of the forward state)
 *                                paged the provoked kinds through the relay; a final forward run
 *
 * Every drill's assertions go to state.json checks (stage 4-drills/<id>), its evidence to state.drills[id], its
 * transactions to the ledger (drill id, sandbox flag). Exit 1 when a drill failed. A drill whose harness passed but that
 * found a product defect elsewhere (reported separately) is `issue`: exit 0 unless REHEARSE_STRICT=1.
 *
 *   node ops/v2/rehearse/4-drills.mjs [--only <id>[,<id>]] [--skip-web]
 * ------------------------------------------------------------------------------------------------- */
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import {
  ABI, INDEXER_URL, PRICING_URL, RehearsalError, accountOf, contracts, expect, fail, getAddress, getJson, impersonate, info, ledgerAppend, loadState, markets, now, nyTime, pushRound,
  patchState, placedOrderId, pub, quoteTake, read, say, send, setLedgerTag, setStage, signalService, serviceRunning, sleep, step, stopService, until, usd, viem, warpTo,
} from "./lib.mjs";
import {
  E18, FatalDrillError, MONITOR_DIR, MONITOR_STATE, NOTIFIER_BOT, STATUS, answer8, bal, cal, ch, events, expectMonitorSent, journal, locateFlag, nextDaily,
  describeRevert, ob, oracle, poolTwap8, printWindow, refreshFeeds, runMonitor, sandbox, setFlag, statusOf, strikeAbove, strikeBelow, telegramMark,
  telegramMessages, txFrom, waitRecorded, waitRelayAlert, writeTo, bookMint, managed, managedExecute, managedSchedule,
} from "./drill-kit.mjs";
import { generatedClean, INDEXER_GENERATED, startIndexer } from "./stack.mjs";
import { MM_OPEN_GRACE_S, PRICE_TICK, PRICER_EDGE_BPS, PRICER_REPRICE_THRESHOLD_BPS } from "./keeper-defaults.mjs";

setStage("4-drills");
// INTERFACE_VERSION 8: the drills run on the registry's launch set by ROLE (state.roles, step 1). D is the
// dual-source market (Chainlink + its pool, its v3 or v4 payout route: NVDA), X the single-source one (SPCX, its pool and route nulled on
// the rehearsal copy), which carries the beats META used to: feed-paused's no-source half, the guardian veto.
const ROLES = loadState().roles;
if (!ROLES) throw new RehearsalError("state.json has no roles: step 1 predates T-OP-247 (INTERFACE_VERSION 8); run step 1 again");
const D = ROLES.dual;
const X = ROLES.single;
const argv = process.argv.slice(2);
const SKIP_WEB = argv.includes("--skip-web") || loadState().skipWeb === true;
const ONLY = argv.includes("--only") ? (argv[argv.indexOf("--only") + 1] ?? "").split(",").filter(Boolean) : null;
const STRICT = process.env.REHEARSE_STRICT === "1";
const BID = 0;
const RESALE = 1;
const WRITE = 2;
const BPS = 10_000n;
const ZERO = "0x0000000000000000000000000000000000000000";
const REDEEM_TIMEOUT = 300_000;
/** OrderBook FEE_CHANGE_DELAY (callhouse-contracts src/v2/OrderBook.sol setFeeParams): 48 h from INTERFACE_VERSION 8. */
const FEE_CHANGE_DELAY_S = 48 * 3600;

const who = (role) => accountOf(role);
const lower = (a) => a.toLowerCase();
/**
 * The v7 dapp take deadline rule: under 1 h, capped at effectiveAt - 1 while a fee
 * change is pending. THE DAPP NO LONGER DOES THIS. A later change retired the workaround in the keeper
 * (keeper/src/v2/mm/devnet-mm.ts) because v8 states the concern directly with TakeParams.maxTotalFee: the v7
 * cap refused by TIME, which also refuses perfectly good fills, where the fee cap refuses by PRICE. This helper
 * survives only because the mint-paused drill below wants an ordinary near-future deadline; the fee-change
 * drill no longer uses it, and nothing here should treat the effectiveAt clamp as current dapp behaviour.
 */
async function dappDeadline() {
  const [, effectiveAt] = await ob("pendingFeeParams");
  const t = await now();
  return Number(effectiveAt) === 0 ? t + 3600 : Math.min(t + 3600, Number(effectiveAt) - 1);
}
const fees = (f) => ({ premiumFeeBps: Number(f.premiumFeeBps), resaleFeeBps: Number(f.resaleFeeBps), takerFeeFlat: Number(f.takerFeeFlat), takerFeeCapBps: Number(f.takerFeeCapBps), makerRebateBps: Number(f.makerRebateBps) });
const takerFeeOf = (premium, f) => {
  const byCap = (premium * BigInt(f.takerFeeCapBps)) / BPS;
  return byCap < BigInt(f.takerFeeFlat) ? byCap : BigInt(f.takerFeeFlat);
};
/**
 * A real `maxTotalFee` for a take the book is expected to SKIP. quoteTake cannot supply one here: it reverts
 * BelowMinUnits at exactly the point take does (OrderBook.sol:494 against :455), so there is no quote to read.
 * The bound is computed from the LIVE fee params at the take's own limit price, mirroring the contract's own
 * sum at OrderBook.sol:461 -- the taker fee when buying, plus the taker's own seller fees when selling into a
 * bid. It is an upper bound on what the call could be charged, never an unbounded value, so FeeAboveMax stays
 * reachable. These two drills are unaffected by the cap either way: BelowMinUnits is raised at :455, BEFORE
 * the cap is tested at :462.
 */
const skipCap = async (units, limitPrice, buying) => {
  const f = fees(await ob("feeParams"));
  const premium = units * limitPrice;
  return takerFeeOf(premium, f) + (buying ? 0n : (premium * BigInt(f.premiumFeeBps)) / BPS);
};
const hashes = (list) => list.filter((x) => x.hash).map((x) => ({ what: x.what ?? x.label ?? x.kind, hash: x.hash, gas: x.gas ?? null }));

/** A bot journal's transactions and alerts as drill evidence. */
function botEvidence(db) {
  const j = journal(db);
  return {
    txs: j.txs.map((t) => ({ kind: t.kind, fn: t.fn, status: t.status, hash: t.hash, gas: t.gas, block: t.block })),
    alerts: j.alerts.map((a) => ({ kind: a.kind, severity: a.severity, message: a.message.slice(0, 240), delivered: Boolean(a.delivered) })),
  };
}

/** Wait until every (holder, tokenId) has a zero balance (the cranker redeemed it). */
async function waitRedeemed(label, pairs, service, timeoutMs = REDEEM_TIMEOUT) {
  return until(label, async () => {
    for (const [holder, id] of pairs) if ((await ch("balanceOf", [holder, id])) !== 0n) return null;
    return true;
  }, { timeoutMs, intervalMs: 2_000, service });
}

async function redeemedLogs(fromBlock, tokenIds) {
  const set = new Set(tokenIds.map(String));
  return (await events(contracts().clearinghouse, ABI.clearinghouse, "Redeemed", undefined, fromBlock)).filter((l) => set.has(l.args.tokenId.toString()));
}

/* ================================================================================================ */
/*  drills                                                                                          */
/* ================================================================================================ */

/* ------------------------------------------------------------------ indexer-down (forward) */
async function indexerDown() {
  if (SKIP_WEB) return { status: "skipped", notes: ["--skip-web: no web, no browser"] };
  const S = loadState();
  const browserApi = await import("./browser.mjs");
  await refreshFeeds("indexer-down: a fresh round for the page's spot", 0);
  const head = await pub.getBlockNumber();
  await until("the indexer at the head", async () => BigInt((await getJson(`${INDEXER_URL}/v2/health`)).block) >= head, { timeoutMs: 120_000, service: "indexer" });
  const t = await now();
  const cards = await until(`an ${D} series with an ask on the indexer's cards`, async () => {
    const c = await getJson(`${INDEXER_URL}/v2/cards?ticker=${D}&limit=50`);
    return c.items.find((x) => BigInt(x.unitsAvailable) >= 1n && x.series.expiry > t + 3600) ?? null;
  }, { timeoutMs: 120_000, intervalMs: 3_000, service: "indexer" });
  const longId = BigInt(cards.series.longId);
  const marketsJson = await getJson(`${INDEXER_URL}/v2/markets`);
  const buyer = who("web");
  const before = await ch("balanceOf", [buyer, longId]);
  info(`series ${D} ${cards.series.strike.formatted} call ${nyTime(cards.series.expiry)} (${cards.series.longId.slice(0, 12)}…), best ask ${cards.ask.formatted}`);
  const browser = await browserApi.openBrowser();
  let r;
  let stoppedAt = null;
  try {
    const wallet = new browserApi.BrowserWallet(buyer, "web buyer (indexer down)");
    r = await browserApi.outageBuyFlow(browser, {
      wallet, ticker: D, longId: cards.series.longId, indexerUrl: INDEXER_URL, marketsJson,
      stopIndexer: async () => {
        await stopService("indexer");
        stoppedAt = await pub.getBlockNumber();
        const refused = await fetch(`${INDEXER_URL}/v2/health`).then(() => false, () => true);
        expect(refused, `indexer stopped at block ${stoppedAt}: ${INDEXER_URL} refuses connections`);
      },
    });
    ledgerAppend(wallet.calls.map((c) => ({ step: "4-drills", action: `browser-${c.name}`, label: `web buyer (series page, indexer down) ${c.name}`, from: buyer, to: c.to, hash: c.hash, status: c.status, gasUsed: c.gasUsed, block: c.block, ts: null })));
  } finally {
    await browser.close();
    if (!serviceRunning("indexer")) {
      info("restarting the indexer on its existing database");
      await startIndexer(S, { fresh: false, label: "indexer-restart" });
    }
  }
  expect(r.take.status === "success" && (await ch("balanceOf", [buyer, longId])) >= before + 1n, `with the indexer down the series page bought 0.01 share from the book rebuilt on chain (take ${r.take.hash}, gas ${r.take.gasUsed})${r.natural ? "" : " — after the harness answered /v2/markets for the browser (see issue)"}`);
  expect(generatedClean(INDEXER_GENERATED), `${INDEXER_GENERATED} restored after the restart`);
  const takeBlock = BigInt(r.take.block);
  const health = await until("the restarted indexer past the take's block", async () => {
    const h = await getJson(`${INDEXER_URL}/v2/health`);
    return BigInt(h.block) >= takeBlock ? h : null;
  }, { timeoutMs: 240_000, intervalMs: 2_000, service: "indexer" });
  const trades = await until("the fill in /v2/series trades", async () => {
    const x = await getJson(`${INDEXER_URL}/v2/series/${longId}/trades`);
    return x.items.some((i) => lower(i.tx) === lower(r.take.hash)) ? x : null;
  }, { timeoutMs: 120_000, intervalMs: 2_000, service: "indexer" });
  expect(Boolean(trades), `indexer restarted on its database, caught up to block ${health.block} and lists the outage fill in /v2/series/${cards.series.longId.slice(0, 12)}…/trades`);
  // Fixed on v2 (the page reads trySpot on chain when /v2/markets fails); a run that meets it again is a regression.
  const issues = r.natural ? [] : [{ lane: "web", reported: "first reported 2026-09-17T17:05:40Z", text: r.issue }];
  return {
    status: issues.length ? "issue" : "passed",
    mode: "forward",
    natural: r.natural,
    series: { longId: cards.series.longId, strike: cards.series.strike.formatted, expiry: cards.series.expiry },
    indexerStoppedAt: stoppedAt === null ? null : Number(stoppedAt),
    txs: [{ what: "take (browser, book rebuilt on chain)", hash: r.take.hash, gas: r.take.gasUsed }],
    screenshots: r.shots.map((f) => path.basename(f)),
    issues,
    notes: [
      r.natural
        ? "The ticket bought with the indexer down and no help: the page read the series, the orders and the spot on chain."
        : "Workaround: after recording the disabled ticket, the browser alone got the /v2/markets answer captured before the outage; every other indexer request kept failing, and the take used the book rebuilt from on-chain orders.",
    ],
    notCovered: ["A cold load of a series page while the indexer is already down: this drill opens the page while the indexer is up and stops it under the open page."],
  };
}

/* ------------------------------------------------------------------ feed-paused (sandbox) */
async function feedPaused() {
  const M = markets();
  const C = contracts();
  return sandbox("feed-paused", async (box) => {
    const E = await nextDaily();
    const nvPrice = (await answer8(D)) / 100n;
    const mtPrice = (await answer8(X)) / 100n;
    const nv = await writeTo({ writer: "whale", holder: "cy", T: D, strike: strikeBelow(D, nvPrice, 100n), expiry: E, units: 20n, label: `feed-paused ${D}` });
    const mt = await writeTo({ writer: "whale", holder: "cy", T: X, strike: strikeBelow(X, mtPrice, 100n), expiry: E, units: 20n, label: `feed-paused ${X}` });
    const mark = await telegramMark();
    const cr = await box.startCranker();
    const printed = await printWindow(E);
    await warpTo(E + 5, "E + 5 s");
    const rec = await waitRecorded(D, E, box.fromBlock, cr.name);
    expect((await txFrom(rec.transactionHash)) === who("cranker"), `the cranker snapshotted ${D}'s pool at ${nyTime(E)} (tx ${rec.transactionHash})`);

    const nvFlag = await locateFlag(M[D].asset, "oraclePaused");
    const mtFlag = await locateFlag(M[X].asset, "oraclePaused");
    await setFlag(nvFlag, true, `${D} oracle paused (issuer flag)`);
    await setFlag(mtFlag, true, `${X} oracle paused (issuer flag)`);
    const [nvWin] = await read(C.sources.chainlink, ABI.chainlink, "windowPrice", [M[D].asset, E - 1800, E]);
    expect(!nvWin && !(await oracle("trySpot", [M[D].asset]))[0] && !(await oracle("trySpot", [M[X].asset]))[0], `oraclePaused() true on ${D} and ${X}: the Chainlink window and spot are not ok (flag at storage slot ${nvFlag.slot.slice(0, 10)}… bit ${nvFlag.bit})`);

    await warpTo(E + 125, "E + 125 s: finalize opens while the flag is set");
    const nvPending = await until(`${D} Pending on the pool alone`, async () => ((await statusOf(D, E)) === STATUS.Pending ? oracle("candidate", [M[D].asset, E]) : null), { timeoutMs: 120_000, intervalMs: 1_500, service: cr.name });
    const [, okList, prices] = await oracle("recordedSources", [M[D].asset, E]);
    expect(Number(nvPending[1]) === 1 && !nvPending[2] && okList[0] === false && okList[1] === true, `${D} finalize with the feed paused captured Chainlink not ok and the pool ok (${usd(prices[1])}): a pool-only candidate, source 1, finalizable ${nyTime(Number(nvPending[3]))} NY`);
    const { result: metaTry } = await pub.simulateContract({ account: who("cranker"), address: C.settlementOracle, abi: ABI.oracle, functionName: "finalize", args: [M[X].asset, E] });
    const metaInfo = await oracle("settlementInfo", [M[X].asset, E]);
    expect(metaTry[0] === false && Number(metaInfo[0]) === STATUS.None && metaInfo[5] === false, `${X} (Chainlink only) with the feed paused: finalize returns (false, 0), nothing captured, status None`);

    await warpTo(E + 125 + 3600, "an hour of the flag: the no-source threshold (CRANKER_NO_SOURCE_ALERT_S 3600)");
    const stuck = await waitRelayAlert(mark, "v2_settle_stuck", { re: new RegExp(M[X].asset, "i"), service: cr.name, timeoutMs: 120_000 });
    expect(Boolean(stuck), `cranker paged v2_settle_stuck for ${X} through the relay: "${stuck.text.split("\n").slice(0, 2).join(" ").slice(0, 160)}"`);
    const mon = await runMonitor("feed-paused", { from: MONITOR_STATE });
    const monitor = expectMonitorSent(mon, [["v2_mon_oracle_paused", new RegExp(`^${D} `)], ["v2_mon_oracle_paused", new RegExp(`^${X} `)]]);

    await setFlag(nvFlag, false, `${D} oracle flag cleared`);
    await setFlag(mtFlag, false, `${X} oracle flag cleared`);
    const nvFin = await until(`${D} Finalized after the retry`, async () => {
      const i = await oracle("settlementInfo", [M[D].asset, E]);
      return Number(i[0]) === STATUS.Finalized ? i : null;
    }, { timeoutMs: 120_000, intervalMs: 1_500, service: cr.name });
    const [nvLog] = await events(C.settlementOracle, ABI.oracle, "SettlementFinalized", { underlying: M[D].asset, expiry: E }, box.fromBlock);
    expect(nvFin[3] === true && Number(nvFin[2]) === 0 && nvFin[1] === printed[D] / 100n && (await txFrom(nvLog.transactionHash)) === who("cranker"), `flag cleared: the cranker's next finalize upgraded Chainlink and finalized ${D} corroborated at ${usd(nvFin[1])} (source 0, tx ${nvLog.transactionHash})`);
    const mtCand = await until(`${X} candidate after the retry`, async () => {
      const c = await oracle("candidate", [M[X].asset, E]);
      return Number(c[3]) > 0 ? c : null;
    }, { timeoutMs: 120_000, intervalMs: 1_500, service: cr.name });
    expect(Number(mtCand[1]) === 0 && !mtCand[2], `flag cleared: the cranker's finalize captured ${X} (single source ${usd(mtCand[0])}, finalizable ${nyTime(Number(mtCand[3]))} NY)`);
    await waitRedeemed(`cy's ${D} long redeemed`, [[who("cy"), nv]], cr.name);
    await warpTo(Number(mtCand[3]) + 5, `past ${X}'s uncorroborated delay`);
    await until(`${X} Finalized`, async () => (await statusOf(X, E)) === STATUS.Finalized, { timeoutMs: 120_000, intervalMs: 1_500, service: cr.name });
    await waitRedeemed(`cy's ${X} long redeemed`, [[who("cy"), mt]], cr.name);
    const paid = await redeemedLogs(box.fromBlock, [nv, mt]);
    const cyPaid = paid.filter((l) => getAddress(l.args.holder) === who("cy"));
    expect(cyPaid.length === 2 && cyPaid.every((l) => l.args.amount > 0n), `both settle and pay: ${cyPaid.map((l) => `${l.args.tokenId === nv ? D : X} ${getAddress(l.args.asset) === getAddress(loadState().usdg) ? `${usd(l.args.amount)} USDG` : `${(Number(l.args.amount) / 1e18).toFixed(6)} in kind`}`).join(", ")}`);
    const bot = botEvidence(cr.db);
    return {
      mode: "sandbox", expiry: E, flag: { [D]: { slot: nvFlag.slot, bit: nvFlag.bit }, [X]: { slot: mtFlag.slot, bit: mtFlag.bit } },
      txs: [{ what: `${D} SettlementFinalized (retry)`, hash: nvLog.transactionHash }, ...cyPaid.map((l) => ({ what: `Redeemed ${l.args.tokenId === nv ? D : X} cy`, hash: l.transactionHash }))],
      alerts: [{ kind: "v2_settle_stuck", text: stuck.text.slice(0, 240) }], monitor, cranker: bot,
    };
  });
}

/* ------------------------------------------------------------------ sources-disagree (sandbox) */
async function sourcesDisagree() {
  const M = markets();
  const C = contracts();
  return sandbox("sources-disagree", async (box) => {
    const E = await nextDaily();
    const ts = await writeTo({ writer: "whale", holder: "dee", T: D, strike: strikeBelow(D, (await answer8(D)) / 100n, 100n), expiry: E, units: 20n, label: `sources-disagree ${D}` });
    const mark = await telegramMark();
    const cr = await box.startCranker();
    const twap = await poolTwap8(D);
    const high = (twap * 103n) / 100n;
    await printWindow(E, { [D]: high });
    info(`${D} window rounds at ${usd(high / 100n)}: 3 % above the pool's ${usd(twap / 100n)} (maxDeviationBps 150)`);
    await warpTo(E + 5, "E + 5 s");
    const rec = await waitRecorded(D, E, box.fromBlock, cr.name);
    await warpTo(E + 125, "E + 125 s: finalize opens");
    const candLog = await until(`${D} SettlementCandidate`, async () => (await events(C.settlementOracle, ABI.oracle, "SettlementCandidate", { underlying: M[D].asset, expiry: E }, box.fromBlock))[0] ?? null, { timeoutMs: 120_000, intervalMs: 1_500, service: cr.name });
    const candBlock = await pub.getBlock({ blockNumber: candLog.blockNumber });
    const [, okList, prices, dev] = await oracle("recordedSources", [M[D].asset, E]);
    const lo = prices[0] < prices[1] ? prices[0] : prices[1];
    const diffBps = ((prices[0] > prices[1] ? prices[0] - prices[1] : prices[1] - prices[0]) * BPS) / lo;
    expect(candLog.args.disagreed === true && Number(candLog.args.sourceIndex) === 0 && candLog.args.price === high / 100n && Number(candLog.args.finalizableAt) === Number(candBlock.timestamp) + 21_600 && okList[0] && okList[1] && diffBps > BigInt(dev),
      `SettlementCandidate(disagreed = true): Chainlink ${usd(prices[0])} vs pool snapshot ${usd(prices[1])} (${diffBps} bps > ${dev}), candidate source 0 at ${usd(candLog.args.price)}, finalizable ${nyTime(Number(candLog.args.finalizableAt))} NY = announcement + 6 h (tx ${candLog.transactionHash})`);
    expect((await statusOf(D, E)) === STATUS.Pending, "status Pending while the delay runs");
    const alert = await waitRelayAlert(mark, "v2_sources_disagree", { service: cr.name });
    expect(Boolean(alert), `cranker paged v2_sources_disagree through the relay: "${alert.text.split("\n").slice(0, 2).join(" ").slice(0, 160)}"`);
    const mon = await runMonitor("sources-disagree", { from: MONITOR_STATE });
    const monitor = expectMonitorSent(mon, ["v2_mon_sources_disagree"]);
    await warpTo(Number(candLog.args.finalizableAt) + 5, "past the uncorroborated delay");
    const finLog = await until(`${D} SettlementFinalized`, async () => (await events(C.settlementOracle, ABI.oracle, "SettlementFinalized", { underlying: M[D].asset, expiry: E }, box.fromBlock))[0] ?? null, { timeoutMs: 120_000, intervalMs: 1_500, service: cr.name });
    expect(finLog.args.corroborated === false && finLog.args.price === candLog.args.price && Number(finLog.args.sourceIndex) === 0, `after the delay the cranker finalized ${D} uncorroborated at the candidate ${usd(finLog.args.price)} (tx ${finLog.transactionHash})`);
    await waitRedeemed(`dee's ${D} long redeemed`, [[who("dee"), ts]], cr.name);
    const [paid] = (await redeemedLogs(box.fromBlock, [ts])).filter((l) => getAddress(l.args.holder) === who("dee"));
    expect(paid && paid.args.amount > 0n, `settled and paid dee: ${getAddress(paid.args.asset) === getAddress(loadState().usdg) ? `${usd(paid.args.amount)} USDG` : `${(Number(paid.args.amount) / 1e18).toFixed(6)} ${D}`} (tx ${paid.transactionHash})`);
    return {
      mode: "sandbox", expiry: E, prices: { chainlink: prices[0].toString(), pool: prices[1].toString(), diffBps: Number(diffBps) },
      txs: [{ what: `${D} snapshot`, hash: rec.transactionHash }, { what: "SettlementCandidate (disagreed)", hash: candLog.transactionHash }, { what: "SettlementFinalized uncorroborated", hash: finLog.transactionHash }, { what: "Redeemed dee", hash: paid.transactionHash }],
      alerts: [{ kind: "v2_sources_disagree", text: alert.text.slice(0, 240) }], monitor, cranker: botEvidence(cr.db),
      notCovered: ["The indexer's settling -> settled status for this expiry (the indexer is frozen in a sandbox); step 3 covers the settling status on the single-source market."],
    };
  });
}

/* ------------------------------------------------------------------ guardian-veto (sandbox) */
async function guardianVeto() {
  const M = markets();
  const C = contracts();
  const S = loadState();
  return sandbox("guardian-veto", async (box) => {
    const E = await nextDaily();
    const mtAnswer = await answer8(X);
    const mt = await writeTo({ writer: "whale", holder: "eve", T: X, strike: strikeBelow(X, mtAnswer / 100n, 100n), expiry: E, units: 20n, label: `guardian-veto ${X}` });
    const mark = await telegramMark();
    const cr = await box.startCranker();
    await printWindow(E, { [X]: (mtAnswer * 103n) / 100n });
    await warpTo(E + 125, "E + 125 s: finalize opens");
    const cand = await until(`${X} candidate`, async () => {
      const c = await oracle("candidate", [M[X].asset, E]);
      return Number(c[3]) > 0 ? c : null;
    }, { timeoutMs: 120_000, intervalMs: 1_500, service: cr.name });
    const veto = await send(S.guardian, { address: C.settlementOracle, abi: ABI.oracle, functionName: "veto", args: [M[X].asset, E], label: `guardian veto ${X}`, action: "veto" });
    const vetoLog = viem.parseEventLogs({ abi: ABI.oracle, eventName: "SettlementVetoed", logs: veto.receipt.logs })[0];
    expect(Boolean(vetoLog) && (await statusOf(X, E)) === STATUS.Held, `guardian (impersonated ${S.guardian}) vetoed ${X}'s candidate ${usd(cand[0])}: SettlementVetoed, status Held (tx ${veto.hash})`);
    const held = await waitRelayAlert(mark, "v2_settlement_held", { service: cr.name });
    expect(Boolean(held), `cranker paged v2_settlement_held through the relay: "${held.text.split("\n").slice(0, 2).join(" ").slice(0, 160)}"`);
    // INTERFACE_VERSION 8: adminResolve is CONFIG_ADMIN's (V8Roles, 24 h execution delay), so every call below is
    // scheduled through the AccessManager and executed after the delay (managed()). The early one executes at about
    // E + 24 h, still inside RESOLVE_DELAY (48 h).
    const early = await managed(S.admin, { address: C.settlementOracle, abi: ABI.oracle, functionName: "adminResolve", args: [M[X].asset, E, cand[0]], label: "admin adminResolve before RESOLVE_DELAY", expectRevert: true });
    const earlyAt = await now();
    expect(early.reverted && /TooEarly/.test(early.reason) && earlyAt < E + 48 * 3600, `adminResolve at expiry + ${((earlyAt - E) / 3600).toFixed(1)} h (scheduled, ${early.delay} s AccessManager delay), before expiry + 48 h, reverts ${early.reason}`);
    const mon = await runMonitor("guardian-veto", { from: MONITOR_STATE });
    const monitor = expectMonitorSent(mon, ["v2_mon_settlement_held", ["v2_mon_config_changed", /SettlementVetoed/]]);
    await warpTo(Number(cand[3]) + 5, "past the vetoed candidate's delay");
    await sleep(15_000);
    expect((await statusOf(X, E)) === STATUS.Held && (await events(C.settlementOracle, ABI.oracle, "SettlementFinalized", { underlying: M[X].asset, expiry: E }, box.fromBlock)).length === 0, "past its delay the held candidate does not finalize (the cranker keeps paging, sends no finalize)");
    await warpTo(E + 48 * 3600 + 5, "expiry + RESOLVE_DELAY (48 h)");
    const [bounded, lo, hi] = await oracle("resolveBand", [M[X].asset, E]);
    const out = await managed(S.admin, { address: C.settlementOracle, abi: ABI.oracle, functionName: "adminResolve", args: [M[X].asset, E, hi + 1_000_000n], label: "admin adminResolve outside the band", expectRevert: true });
    expect(bounded && out.reverted && /ResolveOutOfBand/.test(out.reason), `adminResolve outside [${usd(lo)}, ${usd(hi)}] reverts ${out.reason}`);
    const price = (cand[0] * 9_950n) / BPS;
    const resolve = await managed(S.admin, { address: C.settlementOracle, abi: ABI.oracle, functionName: "adminResolve", args: [M[X].asset, E, price], label: `admin adminResolve ${X} ${usd(price)}`, action: "adminResolve" });
    const info_ = await oracle("settlementInfo", [M[X].asset, E]);
    expect(Number(info_[0]) === STATUS.Finalized && info_[4] === true && info_[1] === price, `admin (impersonated ${S.admin}) resolved ${X} at ${usd(price)} inside the band after 48 h: SettlementResolved, Finalized, resolved = true (tx ${resolve.hash})`);
    await waitRedeemed(`eve's ${X} long redeemed`, [[who("eve"), mt]], cr.name);
    const series = await ch("series", [mt]);
    const [paid] = (await redeemedLogs(box.fromBlock, [mt])).filter((l) => getAddress(l.args.holder) === who("eve"));
    expect(series.settled && series.settlementPrice === price && paid, `the cranker settled ${X} at the resolved price and redeemed eve: ${(Number(paid.args.amount) / 1e18).toFixed(6)} ${X} in kind (tx ${paid.transactionHash})`);
    const mon2 = await runMonitor("guardian-veto-resolved", { stateFile: path.join(MONITOR_DIR, "guardian-veto.state.json") });
    monitor.push(...expectMonitorSent(mon2, [["v2_mon_config_changed", /SettlementResolved/]]));
    return {
      mode: "sandbox", expiry: E, candidate: cand[0].toString(), resolved: price.toString(), band: [lo.toString(), hi.toString()],
      txs: [{ what: "veto", hash: veto.hash }, { what: "adminResolve", hash: resolve.hash }, { what: "Redeemed eve", hash: paid.transactionHash }],
      alerts: [{ kind: "v2_settlement_held", text: held.text.slice(0, 240) }], monitor, cranker: botEvidence(cr.db),
    };
  });
}

/* ------------------------------------------------------------------ cranker-killed (sandbox) */
async function crankerKilled() {
  const M = markets();
  const C = contracts();
  return sandbox("cranker-killed", async (box) => {
    const E = await nextDaily();
    // The v7 drill used two pooled markets (NVDA, TSLA). The rehearsal copy has one (D): dee's position is a
    // second D series, 5 % in the money, so there are still two series, one of them carrying the escrowed resale ask.
    const spotD = (await answer8(D)) / 100n;
    const nv = await writeTo({ writer: "whale", holder: "cy", T: D, strike: strikeBelow(D, spotD, 100n), expiry: E, units: 30n, label: `cranker-killed ${D} 1 % ITM` });
    const ts = await writeTo({ writer: "whale", holder: "dee", T: D, strike: strikeBelow(D, spotD, 500n), expiry: E, units: 30n, label: `cranker-killed ${D} 5 % ITM` });
    if (ts === nv) fail(`cranker-killed: the 1 % and 5 % ${D} strikes rounded to the same series; the drill needs two`);
    // A resale ask left open at expiry escrows 10 of dee's longs: the cranker must prune it before it can redeem them.
    await send(who("dee"), { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "setApprovalForAll", args: [C.orderBook, true], label: "dee setApprovalForAll(book)", action: "setApprovalForAll" });
    const { receipt: resaleReceipt } = await send(who("dee"), { address: C.orderBook, abi: ABI.orderBook, functionName: "place", args: [ts, RESALE, 90_000_000n, 10n, 0], label: `dee AskResale 0.10 share ${D} 5 % ITM (left open at expiry)`, action: "place-resale" });
    const resaleId = placedOrderId(resaleReceipt, C.orderBook);
    const a = await box.startCranker({ name: "drill-cranker-killed-a", keyRole: "cranker" });
    await printWindow(E);
    await warpTo(E + 5, "E + 5 s");
    const recN = await waitRecorded(D, E, box.fromBlock, a.name);
    expect((await txFrom(recN.transactionHash)) === who("cranker"), `cranker A (anvil #8 ${who("cranker")}) snapshotted ${D}'s pool (tx ${recN.transactionHash})`);
    signalService(a.name, "SIGKILL");
    await until("cranker A gone", async () => !serviceRunning(a.name), { timeoutMs: 15_000, intervalMs: 250 });
    await stopService(a.name);
    const aEvidence = botEvidence(a.db);
    expect(true, `cranker A killed with SIGKILL mid-expiry (after its snapshots, before finalize opens); its journal holds ${aEvidence.txs.length} transaction(s)`);
    await warpTo(E + 125, "E + 125 s: finalize opens with no cranker running");
    await sleep(8_000);
    expect((await statusOf(D, E)) === STATUS.None, `with no cranker the expiry waits: ${D} still None`);
    const b = await box.startCranker({ name: "drill-cranker-killed-b", keyRole: "cranker2" });
    await until(`cranker B finalizes ${D}`, async () => (await statusOf(D, E)) === STATUS.Finalized, { timeoutMs: 180_000, intervalMs: 1_500, service: b.name });
    const fins = await events(C.settlementOracle, ABI.oracle, "SettlementFinalized", { underlying: M[D].asset, expiry: E }, box.fromBlock);
    const finFrom = await Promise.all(fins.map((l) => txFrom(l.transactionHash)));
    expect(fins.length === 1 && finFrom.every((f) => f === who("cranker2")) && fins.every((l) => l.args.corroborated), `cranker B (anvil #11 ${who("cranker2")}, its own journal) finalized ${D} corroborated on A's snapshot (tx ${fins.map((l) => l.transactionHash).join(", ")})`);
    const whale = who("whale");
    await waitRedeemed("cranker B redeems every drill long and short", [[who("cy"), nv], [who("dee"), ts], [whale, nv | 1n], [whale, ts | 1n], [C.orderBook, ts]], b.name);
    const pruned = (await events(C.orderBook, ABI.orderBook, "OrderCancelled", { orderId: resaleId }, box.fromBlock))[0];
    const prunedBy = pruned ? await txFrom(pruned.transactionHash) : null;
    expect(pruned && pruned.args.pruned === true && [who("cranker"), who("cranker2")].includes(prunedBy),
      `dee's resale ask left open at expiry was pruned by ${prunedBy === who("cranker2") ? "cranker B" : "cranker A in the tick of its snapshots, before it was killed"}: its 10 escrowed longs went back to dee and were redeemed with the rest (OrderCancelled pruned = true, tx ${pruned?.transactionHash})`);
    const logs = await redeemedLogs(box.fromBlock, [nv, nv | 1n, ts, ts | 1n]);
    const keys = logs.map((l) => `${l.args.tokenId}:${lower(l.args.holder)}`);
    const redeemFrom = new Set(await Promise.all([...new Set(logs.map((l) => l.transactionHash))].map(txFrom)));
    expect(keys.length === 4 && new Set(keys).size === keys.length && [...redeemFrom].every((f) => f === who("cranker2")), `cranker B settled and redeemed cy, dee and the writer's shorts: ${logs.length} Redeemed, each (token, holder) once, all sent by anvil #11`);
    const rewards = (await events(C.keeperRewards, ABI.keeperRewards, "Rewarded", undefined, box.fromBlock)).filter((l) => getAddress(l.args.keeper) === who("cranker2"));
    const names = Object.fromEntries(["SNAPSHOT", "FINALIZE", "SETTLE", "REDEEM", "ROLL"].map((x) => [viem.keccak256(viem.toHex(x)), x]));
    const byAction = {};
    for (const r of rewards) byAction[names[r.args.action] ?? r.args.action] = (byAction[names[r.args.action] ?? r.args.action] ?? 0n) + r.args.amount;
    expect(rewards.length > 0 && byAction.FINALIZE > 0n, `KeeperRewards paid cranker B: ${Object.entries(byAction).map(([k, v]) => `${k} ${usd(v)}`).join(", ")} USDG`);
    const bEvidence = botEvidence(b.db);
    return {
      mode: "sandbox", expiry: E,
      txs: [{ what: `A snapshot ${D}`, hash: recN.transactionHash }, ...fins.map((l) => ({ what: "B SettlementFinalized", hash: l.transactionHash })), { what: `prune of the resale ask (cranker ${prunedBy === who("cranker2") ? "B" : "A"})`, hash: pruned.transactionHash }, ...[...new Set(logs.map((l) => l.transactionHash))].map((h) => ({ what: "B redeemBatch", hash: h }))],
      bounties: Object.fromEntries(Object.entries(byAction).map(([k, v]) => [k, v.toString()])),
      crankerA: aEvidence, crankerB: bEvidence,
      notCovered: [`Two markets finalized by the replacement cranker in one expiry: the v7 drill had two pooled markets (NVDA, TSLA); the rehearsal copy has one (${D}), so cranker B finalizes one market over two of its series (T-OP-247).`],
    };
  });
}

/* ------------------------------------------------------------------ mint-paused (sandbox) */
async function mintPaused() {
  const M = markets();
  const C = contracts();
  const S = loadState();
  return sandbox("mint-paused", async (box) => {
    // The v8 mm-bot quotes nothing inside MM_OPEN_GRACE_S of the session open (keeper mm/engine.ts
    // marketSafetyHalt "open-grace"). The story ends minutes after an open (its auto-roll beat), so a sandbox started
    // there leaves the drill's MM bot halted past the 150 s wait below: step past the grace first.
    const t0 = await now();
    if ((await cal("isRegularSession", [BigInt(t0)])) && !(await cal("isRegularSession", [BigInt(t0 - MM_OPEN_GRACE_S)]))) {
      await warpTo(t0 + MM_OPEN_GRACE_S + 5, `past the mm-bot's ${MM_OPEN_GRACE_S} s open grace (MM_OPEN_GRACE_S)`);
    }
    const E = await nextDaily();
    const whale = who("whale");
    const strike = strikeBelow(D, (await answer8(D)) / 100n, 100n);
    const nv = await writeTo({ writer: "whale", holder: "eve", T: D, strike, expiry: E, units: 20n, label: `mint-paused ${D} to eve` });
    await writeTo({ writer: "whale", holder: "whale", T: D, strike, expiry: E, units: 10n, label: `mint-paused ${D} pair kept by the writer` });
    // Orders before the pause: the writer's AskWrite (collateral in its ledger), gus's bid, eve's resale ask.
    await send(whale, { address: M[D].asset, abi: ABI.erc20, functionName: "approve", args: [C.clearinghouse, E18], label: `whale ${D} approve`, action: "approve" });
    await send(whale, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "deposit", args: [M[D].asset, E18 / 10n, whale], label: `whale deposit 0.1 ${D} for an AskWrite`, action: "deposit" });
    await send(whale, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "setOperator", args: [C.orderBook, true], label: "whale setOperator(book)", action: "setOperator" });
    const place = async (role, kind, price, units) => (await send(who(role), { address: C.orderBook, abi: ABI.orderBook, functionName: "place", args: [nv, kind, price, units, 0], label: `${role} place ${["Bid", "AskResale", "AskWrite"][kind]} ${units}u @ ${usd(price)}`, action: `place-${["bid", "resale", "write"][kind]}` })).receipt;
    const askWrite = placedOrderId(await place("whale", WRITE, 3_000_000n, 10n), C.orderBook);
    const bid = placedOrderId(await place("gus", BID, 200_000n, 10n), C.orderBook);
    const resale = placedOrderId(await place("eve", RESALE, 2_500_000n, 5n), C.orderBook);
    await refreshFeeds("mint-paused: fresh spot for the MM bot", 0);
    const mm = await box.startMm();
    const vaultWrites = async () => {
      const count = await ob("makerOrderCount", [C.makerVault]);
      if (count === 0n) return [];
      const [ids] = await ob("ordersOfMaker", [C.makerVault, 0n, count]);
      const orders = await ob("getOrders", [ids]);
      const t = await now();
      const out = [];
      for (let i = 0; i < ids.length; i += 1) {
        const o = orders[i];
        if (Number(o.kind) !== WRITE || o.cancelled || o.filled >= o.units || t >= Number(o.validUntil)) continue;
        const s = await ch("series", [o.longId]);
        if (getAddress(s.underlying) === M[D].asset) out.push(ids[i]);
      }
      return out;
    };
    const before = await until(`the MM bot quotes ${D} AskWrite`, async () => {
      const w = await vaultWrites();
      return w.length > 0 ? w : null;
    }, { timeoutMs: 150_000, intervalMs: 3_000, service: mm.name });
    info(`MM vault: ${before.length} live ${D} AskWrite order(s) before the pause`);

    const cr = await box.startCranker();
    const pause = await send(S.guardian, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "setMintPaused", args: [M[D].asset, true], label: `guardian setMintPaused(${D}, true)`, action: "setMintPaused" });
    expect((await ch("market", [M[D].asset])).mintPaused === true, `guardian (impersonated) paused ${D} minting: MintPausedSet (tx ${pause.hash})`);
    // v8: a mint comes from the Clearinghouse's minter (the book), for the writer (bookMint), so the pause is what refuses it.
    const mint = await bookMint({ writer: "whale", longId: nv, units: 1n, holder: "whale", label: "whale mint while paused (through the book's minter role)", expectRevert: true });
    expect(mint.reverted && /MintPaused/.test(mint.reason), `a writer's mint reverts ${mint.reason}`);
    const deadline = await dappDeadline();
    const takeAsk = await send(who("cy"), { address: C.orderBook, abi: ABI.orderBook, functionName: "take", args: [{ longId: nv, buying: true, orderIds: [askWrite], units: 10n, minUnits: 10n, limitPrice: 3_000_000n, writeToSell: false, recipient: who("cy"), deadline, maxTotalFee: await skipCap(10n, 3_000_000n, true) }], label: "cy take the AskWrite while paused", expectRevert: true });
    expect(takeAsk.reverted && /BelowMinUnits/.test(takeAsk.reason), `buying an AskWrite (mint on fill) is skipped by the book: take reverts ${takeAsk.reason}`);
    const hitBid = await send(whale, { address: C.orderBook, abi: ABI.orderBook, functionName: "take", args: [{ longId: nv, buying: false, orderIds: [bid], units: 10n, minUnits: 10n, limitPrice: 200_000n, writeToSell: true, recipient: whale, deadline, maxTotalFee: await skipCap(10n, 200_000n, false) }], label: "whale writeToSell into gus's bid while paused", expectRevert: true });
    expect(hitBid.reverted && /BelowMinUnits/.test(hitBid.reason), `writing into a bid (writeToSell) is skipped: take reverts ${hitBid.reason}`);
    // This one is expected to FILL, so its cap comes from a quote of the same params rather than from the
    // fee-params bound above: quoteTake does not enforce the cap (OrderBook.sol:462 is inside take only).
    const resaleBase = { longId: nv, buying: true, orderIds: [resale], units: 5n, minUnits: 5n, limitPrice: 2_500_000n, writeToSell: false, recipient: who("fay"), deadline };
    const [, , rTakerFee, rSellerFees] = await quoteTake(C.orderBook, who("fay"), { ...resaleBase, maxTotalFee: 0n });
    const resaleTake = await send(who("fay"), { address: C.orderBook, abi: ABI.orderBook, functionName: "take", args: [{ ...resaleBase, maxTotalFee: rTakerFee + rSellerFees }], label: "fay buys eve's resale while paused", action: "take-buy" });
    const resaleFill = viem.parseEventLogs({ abi: ABI.orderBook, eventName: "OrderFilled", logs: resaleTake.receipt.logs })[0];
    expect(resaleFill && !resaleFill.args.primary && (await ch("balanceOf", [who("fay"), nv])) === 5n, `existing longs still trade: fay bought eve's 0.05 share resale (tx ${resaleTake.hash})`);
    const free0 = await ch("free", [whale, M[D].asset]);
    const close = await send(whale, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "close", args: [nv, 10n], label: "whale close 10 units while paused", action: "close" });
    // v8 (INTERFACE_VERSION 7): close() also pays back the unused collateral rent: Closed(.., collateralFreed, feeRefund).
    const closed = viem.parseEventLogs({ abi: ABI.clearinghouse, eventName: "Closed", logs: close.receipt.logs })[0];
    expect(Boolean(closed) && closed.args.collateralFreed === 10n * 10n ** 16n && (await ch("free", [whale, M[D].asset])) === free0 + closed.args.collateralFreed + closed.args.feeRefund && (await ch("balanceOf", [whale, nv])) === 0n,
      `a writer's close() works while paused: 10 long + 10 short burned, 0.1 ${D} collateral freed plus ${closed?.args.feeRefund ?? "?"} wei of unused rent (tx ${close.hash})`);
    const pulled = await until(`the MM bot pulls its ${D} write quotes`, async () => ((await vaultWrites()).length === 0 ? true : null), { timeoutMs: 120_000, intervalMs: 3_000, service: mm.name });
    expect(pulled, `the MM bot pulled every ${D} AskWrite quote after the pause (${before.length} before)`);
    const mon = await runMonitor("mint-paused", { from: MONITOR_STATE });
    const monitor = expectMonitorSent(mon, [["v2_mon_config_changed", /MintPausedSet/]]);

    await printWindow(E);
    await warpTo(E + 5, "E + 5 s");
    await waitRecorded(D, E, box.fromBlock, cr.name);
    await warpTo(E + 125, "E + 125 s");
    await until(`${D} Finalized while minting is paused`, async () => (await statusOf(D, E)) === STATUS.Finalized, { timeoutMs: 120_000, intervalMs: 1_500, service: cr.name });
    await waitRedeemed("eve's and fay's longs redeemed while paused", [[who("eve"), nv], [who("fay"), nv]], cr.name);
    const logs = (await redeemedLogs(box.fromBlock, [nv])).filter((l) => [who("eve"), who("fay")].includes(getAddress(l.args.holder)));
    expect(logs.length === 2 && (await ch("market", [M[D].asset])).mintPaused === true, `settlement and redemptions work while paused: eve and fay redeemed (tx ${[...new Set(logs.map((l) => l.transactionHash))].join(", ")}), minting still paused`);
    const unpause = await send(S.guardian, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "setMintPaused", args: [M[D].asset, false], label: `guardian setMintPaused(${D}, false)`, action: "setMintPaused" });
    const next = await nextDaily();
    const later = await ch("longIdOf", [M[D].asset, false, strike, next]);
    if (!(await ch("seriesExists", [later]))) await send(whale, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "createSeries", args: [M[D].asset, false, strike, next], label: "whale createSeries (after unpause)", action: "createSeries" });
    const mintAfter = await bookMint({ writer: "whale", longId: later, units: 5n, holder: "whale", label: "whale mint after unpause (through the book's minter role)" });
    expect(mintAfter.receipt.status === "success", `unpaused: minting works again (tx ${mintAfter.hash}; unpause tx ${unpause.hash})`);
    return {
      mode: "sandbox", expiry: E,
      txs: [{ what: "setMintPaused true", hash: pause.hash }, { what: "resale take while paused", hash: resaleTake.hash }, { what: "close while paused", hash: close.hash }, ...[...new Set(logs.map((l) => l.transactionHash))].map((h) => ({ what: "redeemBatch while paused", hash: h })), { what: "setMintPaused false", hash: unpause.hash }, { what: "mint after unpause", hash: mintAfter.hash }],
      reverts: { mint: mint.reason, askWriteTake: takeAsk.reason, writeToSell: hitBid.reason },
      monitor, cranker: botEvidence(cr.db), mm: botEvidence(mm.db),
    };
  });
}

/* ------------------------------------------------------------------ fee-change (sandbox) */
async function feeChange() {
  const M = markets();
  const C = contracts();
  const S = loadState();
  return sandbox("fee-change", async (box) => {
    const whale = who("whale");
    // INTERFACE_VERSION 8, two waits where v7 had one. setFeeParams is FEE_MANAGER's (V8Roles, 48 h AccessManager
    // execution delay): the admin schedules it and executes it 48 h later (managed()). The executed call then opens
    // the book's own window, FEE_CHANGE_DELAY (48 h from v8; 24 h in v7). The manager delay is waited out FIRST, so
    // everything this drill asserts -- old fees before effectiveAt, the price cap after -- starts at execution, and
    // the series and its AskWrite are created after it with an expiry past effectiveAt.
    const F0 = fees(await ob("feeParams"));
    const F1 = { ...F0, premiumFeeBps: F0.premiumFeeBps + 100, takerFeeFlat: F0.takerFeeFlat + 50_000 };
    const sched = await managed(S.admin, { address: C.orderBook, abi: ABI.orderBook, functionName: "setFeeParams", args: [F1], label: `admin setFeeParams seller ${F1.premiumFeeBps} bps, taker ${usd(F1.takerFeeFlat)}`, action: "setFeeParams" });
    const schedLog = viem.parseEventLogs({ abi: ABI.orderBook, eventName: "FeeParamsScheduled", logs: sched.receipt.logs })[0];
    const schedBlock = await pub.getBlock({ blockNumber: sched.receipt.blockNumber });
    const effectiveAt = Number(schedLog.args.effectiveAt);
    const [pending, pendingAt] = await ob("pendingFeeParams");
    expect(effectiveAt === Number(schedBlock.timestamp) + FEE_CHANGE_DELAY_S && Number(pendingAt) === effectiveAt && JSON.stringify(fees(pending)) === JSON.stringify(F1) && JSON.stringify(fees(await ob("feeParams"))) === JSON.stringify(F0),
      `admin (impersonated) scheduled seller fee ${F0.premiumFeeBps} -> ${F1.premiumFeeBps} bps and taker fee ${usd(F0.takerFeeFlat)} -> ${usd(F1.takerFeeFlat)} through the AccessManager (${sched.delay} s execution delay): FeeParamsScheduled effective ${nyTime(effectiveAt)} NY = execution block + ${FEE_CHANGE_DELAY_S / 3600} h; feeParams() unchanged (tx ${sched.hash})`);
    await refreshFeeds("fee-change: fresh spot after the AccessManager delay", 0);
    const Ef = Number(await cal("nextExpiry", [BigInt(effectiveAt + 2 * 3600), false]));
    const strike = strikeBelow(D, (await answer8(D)) / 100n, 200n);
    const longId = await ch("longIdOf", [M[D].asset, false, strike, Ef]);
    if (!(await ch("seriesExists", [longId]))) await send(whale, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "createSeries", args: [M[D].asset, false, strike, Ef], label: "whale createSeries (fee drill)", action: "createSeries" });
    await send(whale, { address: M[D].asset, abi: ABI.erc20, functionName: "approve", args: [C.clearinghouse, 3n * E18], label: `whale ${D} approve`, action: "approve" });
    await send(whale, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "deposit", args: [M[D].asset, 3n * E18, whale], label: `whale deposit 3 ${D}`, action: "deposit" });
    await send(whale, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "setOperator", args: [C.orderBook, true], label: "whale setOperator(book)", action: "setOperator" });
    const PRICE = 5_000_000n;
    const { receipt: askReceipt } = await send(whale, { address: C.orderBook, abi: ABI.orderBook, functionName: "place", args: [longId, WRITE, PRICE, 300n, 0], label: "whale AskWrite 3 shares @ 5.00 (fee drill)", action: "place-write" });
    const orderId = placedOrderId(askReceipt, C.orderBook);
    const mon = await runMonitor("fee-change", { from: MONITOR_STATE });
    const monitor = expectMonitorSent(mon, [["v2_mon_fee_scheduled", /RAISES/]]);

    // The cap is quoted per call, at the fees in force when the params are BUILT. That matters for `capped`
    // below, which is built before the fee change activates and sent after it: the take then reverts
    // DeadlinePassed, not FeeAboveMax, because _checkTake tests the deadline at OrderBook.sol:815 before any
    // fee is computed and long before the cap is tested at :462. The drill still proves what it always did.
    const takeParams = async (role, deadline) => {
      const base = { longId, buying: true, orderIds: [orderId], units: 100n, minUnits: 100n, limitPrice: PRICE, writeToSell: false, recipient: who(role), deadline };
      const [, , qTakerFee, qSellerFees] = await quoteTake(contracts().orderBook, who(role), { ...base, maxTotalFee: 0n });
      return { ...base, maxTotalFee: qTakerFee + qSellerFees };
    };
    const takeAndCheck = async (role, feesIn, label) => {
      // An ORDINARY one-hour deadline, not the retired effectiveAt - 1 clamp: these takes are meant to
      // execute and pay, and what protects them from a fee change is their maxTotalFee, not their deadline.
      const p = await takeParams(role, (await now()) + 3_600);
      const r = await send(who(role), { address: C.orderBook, abi: ABI.orderBook, functionName: "take", args: [p], label, action: "take-buy" });
      const fill = viem.parseEventLogs({ abi: ABI.orderBook, eventName: "OrderFilled", logs: r.receipt.logs })[0];
      const taken = viem.parseEventLogs({ abi: ABI.orderBook, eventName: "Taken", logs: r.receipt.logs })[0];
      const premium = fill.args.premium;
      const okSeller = fill.args.sellerFee === (premium * BigInt(feesIn.premiumFeeBps)) / BPS;
      const okTaker = taken.args.takerFee === takerFeeOf(premium, feesIn);
      return { r, fill, taken, ok: okSeller && okTaker, deadline: p.deadline, premium };
    };
    const a = await takeAndCheck("dee", F0, "dee take before effectiveAt");
    expect(a.ok, `a take before effectiveAt pays the old fees: premium ${usd(a.premium)}, seller fee ${usd(a.fill.args.sellerFee)} (${F0.premiumFeeBps} bps), taker fee ${usd(a.taken.args.takerFee)} (tx ${a.r.hash})`);

    // THE PROPERTY, THROUGH THE v8 MECHANISM. A fee change must not silently overcharge a take that was
    // quoted before it. v7 protected that by TIME -- a deadline clamped to effectiveAt - 1, so the take
    // expired rather than paid -- which also refused perfectly good fills. v8 protects it by PRICE:
    // TakeParams.maxTotalFee is the most the taker will pay, and OrderBook reverts FeeAboveMax above it.
    // The time-based workaround is retired; this proves the replacement actually holds.
    await warpTo(effectiveAt - 600, "ten minutes before the fee change takes effect");
    const quotedOld = await takeParams("fay", (await now()) + 3_600);
    const [, qPremium, qFee] = await quoteTake(contracts().orderBook, who("fay"), quotedOld);
    expect(qFee === takerFeeOf(qPremium, F0) && quotedOld.maxTotalFee === qFee,
      `fay's take is quoted at the OLD taker fee ${usd(qFee)} and carries exactly that as maxTotalFee (${usd(quotedOld.maxTotalFee)}), derived from quoteTake and not from a constant`);
    await warpTo(effectiveAt, "effectiveAt: the scheduled fees apply from this block");
    const [, zeroAt] = await ob("pendingFeeParams");
    expect(JSON.stringify(fees(await ob("feeParams"))) === JSON.stringify(F1) && Number(zeroAt) === 0, "at effectiveAt feeParams() returns the new fees and pendingFeeParams() is empty");
    // PROVE THE PRECONDITION BEFORE ASSERTING THE REVERT. takerFeeOf is min(premium x takerFeeCapBps, flat),
    // so raising takerFeeFlat only raises the fee while the FLAT term binds. If the cap term bound instead,
    // the new fee would equal the old one, FeeAboveMax could never fire, and a revert assertion here would be
    // passing for a reason that has nothing to do with the cap. So quote the same params at the NEW fees and
    // require that they really do exceed what fay agreed to.
    const [, qPremiumNew, qFeeNew] = await quoteTake(contracts().orderBook, who("fay"), quotedOld);
    expect(qFeeNew === takerFeeOf(qPremiumNew, F1) && qFeeNew > quotedOld.maxTotalFee,
      `the scheduled change really does raise this take's taker fee, ${usd(quotedOld.maxTotalFee)} -> ${usd(qFeeNew)}: the cap is about to be exceeded, so FeeAboveMax is reachable`);
    // AND THE DEADLINE IS STILL AHEAD, PROVED RATHER THAN DONE ON PAPER. quotedOld was
    // built at effectiveAt - 600 with a one-hour deadline, so at activation it has about 3000 s left. _checkTake tests
    // the deadline (OrderBook.sol:815) BEFORE any fee is computed, so if the warps above ever move, the take would
    // revert DeadlinePassed and the FeeAboveMax assertion below would go red for a reason that looks like the wrong bug.
    // Fail here instead, on the arithmetic, with both numbers in the message.
    const atActivation = await now();
    expect(quotedOld.deadline > atActivation,
      `fay's quoted take is still inside its deadline at activation (deadline ${quotedOld.deadline}, now ${atActivation}, ${quotedOld.deadline - atActivation} s left), so the revert below can only be the fee cap`);
    const overcharged = await send(who("fay"), { address: C.orderBook, abi: ABI.orderBook, functionName: "take", args: [quotedOld], label: "fay sends the take she quoted at the old fees, after activation", expectRevert: true, sendReverting: true, gas: 1_000_000n });
    expect(overcharged.reverted && /FeeAboveMax/.test(overcharged.reason) && overcharged.receipt.status === "reverted",
      `a take quoted at the old fees REFUSES the new one on price: reverts ${overcharged.reason} (tx ${overcharged.hash}, status reverted). It never silently pays ${usd(qFeeNew)} against a ${usd(quotedOld.maxTotalFee)} cap`);

    // DEADLINE COVERAGE, SEPARATE AND SMALLER. The deadline check is still real and still FIRST --
    // _checkTake tests it at OrderBook.sol:815 before any fee is computed, long before the cap at :462 -- so
    // a take past its deadline must still revert DeadlinePassed. This is its own assertion about deadlines
    // and NOT a fee-change workaround: folding it into the fee case is how the fee assertion would later be
    // deleted as redundant, and a drill asserting only FeeAboveMax would still pass with the deadline check
    // removed entirely.
    // v8's quoteTake runs the same deadline check as take, so the cap is quoted on a live deadline and the deadline is
    // then set in the past: the take below is what is expected to refuse it.
    const stale = { ...(await takeParams("cy", (await now()) + 3_600)), deadline: (await now()) - 1 };
    const expired = await send(who("cy"), { address: C.orderBook, abi: ABI.orderBook, functionName: "take", args: [stale], label: "cy sends a take whose deadline has already passed", expectRevert: true, sendReverting: true, gas: 1_000_000n });
    expect(expired.reverted && /DeadlinePassed/.test(expired.reason) && expired.receipt.status === "reverted",
      `a take past its deadline still reverts ${expired.reason}, checked before any fee is computed (tx ${expired.hash}, status reverted)`);
    const c = await takeAndCheck("cy", F1, "cy take after activation");
    expect(c.ok, `a fresh take after activation pays the new fees: premium ${usd(c.premium)}, seller fee ${usd(c.fill.args.sellerFee)} (${F1.premiumFeeBps} bps), taker fee ${usd(c.taken.args.takerFee)} (tx ${c.r.hash})`);
    return {
      mode: "sandbox", seriesExpiry: Ef, effectiveAt, feesBefore: F0, feesAfter: F1,
      txs: [{ what: "setFeeParams (schedule)", hash: sched.hash }, { what: "take before effectiveAt (old fees)", hash: a.r.hash }, { what: "take quoted at old fees, sent after activation (reverted FeeAboveMax)", hash: overcharged.hash }, { what: "take past its deadline (reverted DeadlinePassed)", hash: expired.hash }, { what: "take after activation (new fees)", hash: c.r.hash }],
      monitor,
    };
  });
}

/* ------------------------------------------------------------------ pin-refused (sandbox) */
async function pinRefused() {
  const M = markets();
  const C = contracts();
  const S = loadState();
  return sandbox("pin-refused", async (box) => {
    // INTERFACE_VERSION 8: setOracle is CONFIG_ADMIN's (V8Roles, 24 h AccessManager execution delay). The revoke is
    // scheduled and executed 24 h later (managed()). The restore must land INSIDE the cranker's PIN_REFUSED_RECHECK_S
    // (900 s) after the refusal, or the no-re-ask assertion below has nothing to prove, so it is scheduled right after
    // the revoke executes for a `when` 300 s after the probe point t1, and E2 is picked so t1 is past its earliest time.
    const revokeCall = { address: C.sources.chainlink, abi: ABI.chainlink, functionName: "setOracle", args: [C.settlementOracle, false], label: "admin ChainlinkFeedSource.setOracle(oracle, false)", action: "setOracle" };
    const restoreCall = { address: C.sources.chainlink, abi: ABI.chainlink, functionName: "setOracle", args: [C.settlementOracle, true], label: "admin ChainlinkFeedSource.setOracle(oracle, true)", action: "setOracle" };
    const revoke = await managed(S.admin, revokeCall);
    expect((await read(C.sources.chainlink, ABI.chainlink, "isOracle", [C.settlementOracle])) === false, `admin (impersonated) removed the SettlementOracle from ChainlinkFeedSource's allow-list through the AccessManager (${revoke.delay} s delay): OracleSet(oracle, false) (tx ${revoke.hash})`);
    // E2 is a close at which the expiry entering the ladder horizon (nextExpiry(E2 - 3840 + 3900)) is not pinned yet,
    // the first such close at least the restore's delay ahead, so the probe point t1 is past the restore's earliest time.
    let E2 = await nextDaily(revoke.delay + 3_900);
    let Enew = null;
    for (let i = 0; i < 10 && Enew === null; i += 1) {
      const e = Number(await cal("nextExpiry", [BigInt(E2 + 60), false]));
      if (getAddress(await oracle("pinnedBy", [M[D].asset, e])) === ZERO) Enew = e;
      else E2 = e;
    }
    if (Enew === null) fail("no daily close in the next ten whose next expiry is unpinned");
    const restoreScheduled = await managedSchedule(S.admin, { ...restoreCall, when: E2 - 3_840 + 300 });
    const t1 = await warpTo(E2 - 3_840, "the ladder horizon (now + 65 min) passes today's close: a new daily expiry enters it");
    await refreshFeeds("pin-refused: fresh spot for the ladders", 0);
    expect(Number(await cal("nextExpiry", [BigInt(t1 + 3_900), false])) === Enew, `at ${nyTime(t1)} NY the ladder horizon's next expiry is ${nyTime(Enew)}, not pinned`);
    const strike = strikeAbove(D, (await answer8(D)) / 100n, 100n);
    const refused = await send(who("whale"), { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "createSeries", args: [M[D].asset, false, strike, Enew], label: "whale createSeries on the new expiry", expectRevert: true });
    expect(refused.reverted && /SourceNotPinned/.test(refused.reason) && refused.reason.toLowerCase().includes(C.sources.chainlink.toLowerCase()) && /0xea8e4eb5/i.test(refused.reason),
      `createSeries of ${D} ${nyTime(Enew)} (not pinned yet) reverts ${refused.reason}: the Chainlink source answered NotAuthorized (0xea8e4eb5), so the creation fails closed`);
    const mark = await telegramMark();
    const cr = await box.startCranker();
    const alert = await waitRelayAlert(mark, "v2_pin_refused", { re: new RegExp(String(Enew)), service: cr.name, timeoutMs: 150_000 });
    expect(Boolean(alert), `the cranker's ladder probe paged v2_pin_refused through the relay naming ${Enew}: "${alert.text.split("\n").slice(0, 2).join(" ").slice(0, 200)}"`);
    expect(getAddress(await oracle("pinnedBy", [M[D].asset, Enew])) === ZERO, "nothing was created or pinned on the refused expiry");
    const mon = await runMonitor("pin-refused", { from: MONITOR_STATE });
    const monitor = expectMonitorSent(mon, [["v2_mon_oracle_allowlist", /OracleSet\(/], "v2_mon_pin_blocked"]);
    const restore = await managedExecute(S.admin, restoreCall, restoreScheduled);
    const restoreBlock = restore.receipt.blockNumber;
    // PIN_REFUSED_RECHECK_S governs the cranker's LADDER PROBE (planner.planPinGroup: a refused group is skipped for
    // 900 s), so that is what is asserted: the cranker's own createSeries (journal kind createSeries, sent through
    // multicall3) on Enew. It is not a lock on the expiry. Under v8 the admin's 24 h delay lets the story's daily
    // auto-roll positions expire, so a roll is due at t1: while the source is refused it closes out, and once the
    // source is restored AutoRoller.roll creates its series on Enew and pins it. That roll is reported, not hidden.
    const ladderCreatesOn = async (fromBlock) => {
      const hashes = new Set(botEvidence(cr.db).txs.filter((x) => x.kind === "createSeries" && x.status === "success" && x.hash).map((x) => x.hash.toLowerCase()));
      return (await events(C.clearinghouse, ABI.clearinghouse, "SeriesCreated", { underlying: M[D].asset }, fromBlock)).filter((l) => Number(l.args.expiry) === Enew && hashes.has(l.transactionHash.toLowerCase()));
    };
    await sleep(12_000);
    const early = await ladderCreatesOn(restoreBlock);
    const rollPin = (await events(C.settlementOracle, ABI.oracle, "SettlementConfigPinned", { underlying: M[D].asset, expiry: Enew }, restoreBlock))[0];
    expect(early.length === 0, `allow-list restored (tx ${restore.hash}); within PIN_REFUSED_RECHECK_S (900 s) the cranker's ladder probe does not ask again: none of its own createSeries on ${nyTime(Enew)}${rollPin ? ` (an auto-roll pinned the expiry meanwhile, tx ${rollPin.transactionHash}: rolls are not governed by the recheck window)` : ""}`);
    await warpTo((await now()) + 905, "past the cranker's 900 s pin recheck");
    await refreshFeeds("pin-refused: recheck", 0);
    const onNew = await until("the cranker's recheck creates its ladder on the recovered expiry", async () => {
      const l = await ladderCreatesOn(restoreBlock);
      return l.length ? l : null;
    }, { timeoutMs: 150_000, intervalMs: 2_000, service: cr.name });
    const pinnedLog = (await events(C.settlementOracle, ABI.oracle, "SettlementConfigPinned", { underlying: M[D].asset, expiry: Enew }, box.fromBlock))[0];
    const pinnedBy = pinnedLog ? ((await pub.getTransaction({ hash: pinnedLog.transactionHash })).to?.toLowerCase() === C.autoRoller.toLowerCase() ? "an AutoRoller.roll" : "its ladder createSeries") : "?";
    expect(getAddress(await oracle("pinnedBy", [M[D].asset, Enew])) === C.clearinghouse && pinnedLog && (await txFrom(pinnedLog.transactionHash)) === who("cranker"),
      `recovered: after the 900 s recheck the cranker created ${onNew.length} ${D} ladder series on ${nyTime(Enew)} (tx ${onNew[0].transactionHash}); the expiry was pinned by ${pinnedBy} sent by the cranker (SettlementConfigPinned, tx ${pinnedLog?.transactionHash})`);
    return {
      mode: "sandbox", refusedExpiry: Enew, revert: refused.reason,
      txs: [{ what: "setOracle(oracle, false)", hash: revoke.hash }, { what: "setOracle(oracle, true)", hash: restore.hash }, { what: "cranker createSeries + pin (recovered)", hash: pinnedLog.transactionHash }],
      alerts: [{ kind: "v2_pin_refused", text: alert.text.slice(0, 300) }], monitor, cranker: botEvidence(cr.db),
    };
  });
}

/* ------------------------------------------------------------------ usdg-paused (forward) */
async function usdgPaused() {
  const M = markets();
  const C = contracts();
  const S = loadState();
  setLedgerTag({ drill: "usdg-paused" });
  await refreshFeeds("usdg-paused: before writing", 0);
  const E = await nextDaily(3_600 + 1_800 + 900);
  const eve = who("eve");
  const whale = who("whale");
  const spot = (await answer8(D)) / 100n;
  const put = await writeTo({ writer: "whale", holder: "eve", T: D, isPut: true, strike: strikeAbove(D, spot, 200n), expiry: E, units: 20n, label: `usdg-paused ${D} put (USDG collateral) to eve` });
  const call = await writeTo({ writer: "whale", holder: "eve", T: D, strike: strikeBelow(D, spot, 200n), expiry: E, units: 20n, label: `usdg-paused ${D} call to eve` });
  const fromBlock = await pub.getBlockNumber();
  const tg = await telegramMark();
  const printed = await printWindow(E);
  await warpTo(E + 5, "E + 5 s");
  const rec = await waitRecorded(D, E, fromBlock, "cranker", 180_000);
  expect((await txFrom(rec.transactionHash)) === who("cranker"), `the live cranker snapshotted ${D} (tx ${rec.transactionHash})`);
  const flag = await locateFlag(S.usdg, "paused");
  await setFlag(flag, true, "USDG paused (issuer flag)");
  const mon = await runMonitor("usdg-paused", { stateFile: MONITOR_STATE });
  const monitor = expectMonitorSent(mon, ["v2_mon_usdg_paused"]);
  let credited = 0n;
  let withdrawHash = null;
  try {
    await warpTo(E + 125, "E + 125 s: the live cranker finalizes, settles and redeems with USDG paused");
    await waitRedeemed("eve's put and call longs redeemed", [[eve, put], [eve, call]], "cranker", 360_000);
    const logs = await redeemedLogs(fromBlock, [put, call, put | 1n, call | 1n]);
    const putLog = logs.find((l) => l.args.tokenId === put && getAddress(l.args.holder) === eve);
    const callLog = logs.find((l) => l.args.tokenId === call && getAddress(l.args.holder) === eve);
    credited = putLog.args.amount;
    expect(putLog.args.toLedger === true && getAddress(putLog.args.to) === C.clearinghouse && getAddress(putLog.args.asset) === S.usdg && credited > 0n && (await ch("free", [eve, S.usdg])) >= credited,
      `USDG paused: eve's ITM put payout ${usd(credited)} USDG could not be transferred and was credited to her Clearinghouse ledger (Redeemed toLedger = true, tx ${putLog.transactionHash})`);
    expect(getAddress(callLog.args.asset) === M[D].asset && callLog.args.toLedger === false && callLog.args.amount === callLog.args.amountInKind,
      `USDG paused: eve's ITM call could not convert (the swap pays USDG) and fell back to in kind: ${(Number(callLog.args.amount) / 1e18).toFixed(6)} ${D} to her wallet (tx ${callLog.transactionHash})`);
    const shortLog = logs.find((l) => l.args.tokenId === (put | 1n) && getAddress(l.args.holder) === whale);
    if (shortLog) info(`the writer's put short: ${usd(shortLog.args.amount)} USDG, toLedger ${shortLog.args.toLedger}`);
    const blocked = await send(eve, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "withdraw", args: [S.usdg, credited, eve], label: "eve withdraw while USDG is paused", expectRevert: true });
    expect(blocked.reverted, `withdrawing the credit while USDG is paused reverts: USDG ${describeRevert(blocked.reason).slice(0, 80)}`);
    const note = await until("eve's payout_failed_to_ledger notification", async () => (await telegramMessages()).find((m) => m.n > tg && m.bot === NOTIFIER_BOT && /Payout held in your Stonkhouse balance/.test(m.text)) ?? null, { timeoutMs: 240_000, intervalMs: 3_000, service: "notifier" });
    expect(note.chatId === String(loadState().story.subscriptions.eve.chatId), `notifier sent eve payout_failed_to_ledger through the Telegram stand-in: "${note.text.split("\n").slice(0, 2).join(" ").slice(0, 200)}"`);
    const pos = await until("the credit in eve's /v2 positions ledger", async () => {
      const p = await getJson(`${INDEXER_URL}/v2/accounts/${eve}/positions`);
      const row = (p.ledger ?? []).find((x) => lower(x.asset) === lower(S.usdg));
      return row && BigInt(row.free.raw) >= credited ? row : null;
    }, { timeoutMs: 180_000, intervalMs: 3_000, service: "indexer" });
    expect(Boolean(pos), `indexer: eve's positions ledger shows ${pos.free.formatted} USDG free`);
  } finally {
    await setFlag(flag, false, "USDG unpaused");
  }
  const usdg0 = await bal(S.usdg, eve);
  const w = await send(eve, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "withdraw", args: [S.usdg, credited, eve], label: "eve withdraws the credited payout", action: "withdraw" });
  withdrawHash = w.hash;
  expect((await bal(S.usdg, eve)) === usdg0 + credited, `USDG unpaused: eve withdrew the ${usd(credited)} USDG credit (Withdrawn, tx ${w.hash})`);
  const mon2 = await runMonitor("usdg-unpaused", { stateFile: MONITOR_STATE });
  expect(mon2.resolved.some((r) => r.kind === "v2_mon_usdg_paused" && r.delivered), "monitor.mjs --once sent v2_mon_resolved for v2_mon_usdg_paused");
  const rewards = await events(C.keeperRewards, ABI.keeperRewards, "Rewarded", undefined, fromBlock);
  return {
    mode: "forward", expiry: E, flag: { slot: flag.slot, bit: flag.bit },
    txs: [{ what: `${D} snapshot (live cranker)`, hash: rec.transactionHash }, { what: "withdraw after unpause", hash: withdrawHash }],
    credited: credited.toString(), monitor: [...monitor, { kind: "v2_mon_resolved", severity: "info", message: "v2_mon_usdg_paused resolved" }],
    notes: [`KeeperRewards Rewarded events from the drill's first block: ${rewards.length} (bounties are paid in USDG: while it was paused each reward transfer failed silently and nothing was logged for it)`],
  };
}

/* ------------------------------------------------------------------ reprice (sandbox) */
/** keeper/src/v2/pricer/planner.ts priceBand: the ends rounded inward to the tick. */
function priceBand(spot, minAskBps, maxAskBps) {
  let min = ((spot * BigInt(minAskBps) + BPS - 1n) / BPS + PRICE_TICK - 1n) / PRICE_TICK * PRICE_TICK;
  if (min === 0n) min = PRICE_TICK;
  const max = (spot * BigInt(maxAskBps)) / BPS / PRICE_TICK * PRICE_TICK;
  return min > max ? null : { min, max };
}

async function setFairScale(ticker, bps) {
  const res = await fetch(`${PRICING_URL}/_control/fair-scale`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticker, bps }) });
  if (!res.ok) fail(`pricing stand-in /_control/fair-scale ${ticker} ${bps}: ${res.status} ${await res.text()}`);
}

/**
 * The reprice path end to end: the pricing service's fair value moves, the
 * pricer (a drill-local one, anvil #9, fresh journal, so ben's position is "new" and due at once) asks /fair, and
 * AutoRoller.reprice replaces ben's live roll ask: Repriced(old, new, price) from the pricer's key, the new ask at the
 * pricer's target with the old ask's remaining units and validUntil, the old one cancelled, position() on the new one.
 * The lever is the stand-in's /_control/fair-scale on D, sized so fair × (1 + edge) lands past the band's ceiling: the
 * expected price is then the ceiling itself (planner.ts targetPrice, clamped 'ceiling'), independent of the seconds of
 * time decay between this read and the pricer's own /fair.
 */
async function reprice() {
  const M = markets();
  const C = contracts();
  const ben = who("ben");
  return sandbox("reprice", async (box) => {
    const [longId, orderId] = await read(C.autoRoller, ABI.autoRoller, "position", [ben, M[D].asset]);
    expect(orderId !== 0n, `ben has a live ${D} roll ask for the pricer to move (order ${orderId})`);
    const strat = await read(C.autoRoller, ABI.autoRoller, "strategy", [ben, M[D].asset]);
    expect(strat.active && strat.smartPricing, `ben's ${D} strategy is active with smart pricing (band ${strat.minAskBps}-${strat.maxAskBps} bps of spot)`);
    const [old] = await ob("getOrders", [[orderId]]);
    let t = await now();
    if (!(await cal("isRegularSession", [t]))) {
      let at = null;
      for (let day = Math.floor(t / 86_400); day <= Math.floor(t / 86_400) + 10 && at === null; day += 1) {
        if (!(await cal("isSessionDay", [day]))) continue;
        const open30 = Number(await cal("closeOf", [day])) - 23_400 + 1_800;
        if (open30 > t && (await cal("isRegularSession", [open30]))) at = open30;
      }
      if (at === null) fail(`no regular session within 10 days of ${nyTime(t)}`);
      t = await warpTo(at, "30 min into the next regular session (the pricer reprices in session only)");
    }
    expect(Number(old.validUntil) > t + 300 && !old.cancelled && old.filled < old.units, `ben's ask ${orderId} is live at ${nyTime(t)} NY: ${old.units - old.filled} units at ${usd(old.price)}, valid until ${nyTime(Number(old.validUntil))}`);
    await refreshFeeds("reprice: a fresh round for the band", 0);
    const s = await ch("series", [longId]);
    const [spotOk, spot] = await read(s.oracle, ABI.oracle, "trySpot", [M[D].asset]);
    expect(spotOk && spot < s.strike, `${D} spot ${usd(spot)} from the series' pinned oracle, short of the ${usd(s.strike)} strike (reprice refuses in the money)`);
    const band = priceBand(spot, Number(strat.minAskBps), Number(strat.maxAskBps));
    if (band === null) fail(`ben's band ${strat.minAskBps}-${strat.maxAskBps} bps at ${usd(spot)} holds no tick`);
    const diff = band.max > old.price ? band.max - old.price : old.price - band.max;
    expect(diff * BPS > old.price * PRICER_REPRICE_THRESHOLD_BPS, `the band's ceiling ${usd(band.max)} is more than ${PRICER_REPRICE_THRESHOLD_BPS / 100n} % from the live ${usd(old.price)}: a reprice to it is due`);
    const fairOf = async () => {
      const r = await getJson(`${PRICING_URL}/fair?ticker=${D}&strike=${s.strike}&expiry=${s.expiry}&type=call`);
      if (r.fair === null) fail(`pricing stand-in has no fair value for ben's series: ${r.reason}`);
      return BigInt(r.fair.raw);
    };
    const fair0 = await fairOf();
    // twice the ceiling after the edge: the clamp holds whatever the fair value does in the next few seconds
    const scaleBps = Number((band.max * 2n * BPS * BPS) / (fair0 * (BPS + PRICER_EDGE_BPS)) + 1n);
    let events_ = null;
    let bot = null;
    try {
      await setFairScale(D, Math.max(scaleBps, 10_001));
      const fair1 = await fairOf();
      expect(fair1 * (BPS + PRICER_EDGE_BPS) > band.max * BPS, `pricing stand-in: ${D} fair scaled x${(Math.max(scaleBps, 10_001) / 10_000).toFixed(2)} from ${usd(fair0)} to ${usd(fair1)}: fair x (1 + ${PRICER_EDGE_BPS} bps) is past the band's ceiling ${usd(band.max)}`);
      bot = await box.startPricer();
      events_ = await until("the drill pricer's Repriced on ben's ask", async () => {
        const logs = await events(C.autoRoller, ABI.autoRoller, "Repriced", { writer: ben }, box.fromBlock);
        return logs.length ? logs : null;
      }, { timeoutMs: 180_000, intervalMs: 2_000, service: bot.name });
    } finally {
      await setFairScale(D, 10_000);
    }
    const log = events_[0];
    const sender = await txFrom(log.transactionHash);
    expect(events_.length === 1 && sender === who("pricer") && log.args.oldOrderId === orderId && log.args.price === band.max,
      `Repriced(${log.args.oldOrderId} -> ${log.args.newOrderId}, ${usd(log.args.price)}) from the pricer's key ${sender}: the band's ceiling, ${usd(old.price)} -> ${usd(log.args.price)} (tx ${log.transactionHash})`);
    const [oldAfter, fresh] = await ob("getOrders", [[orderId, log.args.newOrderId]]);
    expect(oldAfter.cancelled && getAddress(fresh.maker) === ben && Number(fresh.kind) === WRITE && fresh.price === band.max && fresh.units === old.units - old.filled && fresh.filled === 0n && fresh.validUntil === old.validUntil && !fresh.cancelled,
      `the replacement: ben's AskWrite ${log.args.newOrderId} at ${usd(fresh.price)}, ${fresh.units} units (the old ask's remainder), valid until ${nyTime(Number(fresh.validUntil))} (unchanged); order ${orderId} cancelled`);
    const [, tracked] = await read(C.autoRoller, ABI.autoRoller, "position", [ben, M[D].asset]);
    expect(tracked === log.args.newOrderId, `AutoRoller.position(ben, ${D}) tracks the new order ${tracked}`);
    // The Repriced log is on chain before the pricer has written the receipt's status to its journal (it records the
    // send, then the receipt), so the journal is read once it holds this transaction as success -- bounded, and a
    // journal that never records it still fails the expect below by the same condition.
    const recorded = (e) => e.txs.some((x) => x.kind === "reprice" && x.hash?.toLowerCase() === log.transactionHash.toLowerCase() && x.status === "success");
    const evidence = await until("the drill pricer's journal records the reprice's receipt", async () => {
      const e = botEvidence(bot.db);
      return recorded(e) ? e : null;
    }, { timeoutMs: 60_000, intervalMs: 1_000, service: bot.name }).catch(() => botEvidence(bot.db));
    const failures = evidence.alerts.filter((a) => /v2_pricer_reprice_failed|v2_error/.test(a.kind));
    expect(recorded(evidence) && failures.length === 0,
      `the drill pricer's journal records the reprice (kind reprice, status success), no v2_pricer_reprice_failed or v2_error (${evidence.txs.length} tx, alerts: ${evidence.alerts.map((a) => a.kind).join(", ") || "none"})`);
    return {
      mode: "sandbox",
      order: { old: orderId.toString(), new: log.args.newOrderId.toString(), from: old.price.toString(), to: log.args.price.toString() },
      band: { min: band.min.toString(), max: band.max.toString() },
      fair: { before: fair0.toString(), scaleBps: Math.max(scaleBps, 10_001) },
      txs: [{ what: "AutoRoller.reprice (drill pricer)", hash: log.transactionHash }],
      pricer: evidence,
      notes: ["The fair value was moved by the stand-in's /_control/fair-scale, not by the market: the real pricing service reads the live Cboe chain, which cannot follow the fork's warped clock."],
    };
  });
}

/* ------------------------------------------------------------------ monitor (summary) */
async function monitorSummary(results) {
  const withMonitor = Object.entries(results).filter(([, r]) => Array.isArray(r.monitor));
  const final = await runMonitor("final", { stateFile: MONITOR_STATE });
  expect(final.report.incompleteChecks.length === 0, `final forward monitor run completes every check (exit ${final.code}; ${final.report.findings.length} open finding(s))`);
  const kinds = Object.fromEntries(withMonitor.map(([id, r]) => [id, r.monitor.map((m) => m.kind)]));
  expect(withMonitor.length > 0, `monitor.mjs --once paged the provoked events in ${withMonitor.length} drill(s): ${withMonitor.map(([id, r]) => `${id}: ${[...new Set(r.monitor.map((m) => m.kind))].join(" + ")}`).join("; ")}`);
  return { mode: "both", kinds, final: { code: final.code, findings: final.report.findings.map((f) => `${f.severity} ${f.id}`), sent: final.sent.map((s) => s.kind), resolved: final.resolved.map((r) => r.id) } };
}

/* ------------------------------------------------------------------ stale-cancel-notify (forward) */
async function staleCancelNotify() {
  const M = markets();
  const C = contracts();
  const S = loadState();
  const ben = who("ben");
  const [longId, orderId, expiry] = await read(C.autoRoller, ABI.autoRoller, "position", [ben, M[D].asset]);
  expect(orderId !== 0n, `ben still has a live AutoRoller ask to withdraw (orderId ${orderId}, expiry ${nyTime(Number(expiry))})`);
  const rolls = await pub.getContractEvents({ address: C.autoRoller, abi: ABI.autoRoller, eventName: "Rolled", args: { writer: ben }, fromBlock: BigInt(S.deployBlock) });
  const last = rolls.at(-1);
  expect(Boolean(last), "ben has a Rolled log so the strike of the live ask is known");
  const strike = last.args.strike;
  const t = await now();
  const answerBefore = await answer8(D);
  const above = strike * 100n + 10n ** 8n;
  await pushRound(M[D].feed, above, t, `${D} spot ${usd(strike + 1_000_000n)} above ben's ${usd(strike)} roll strike`);
  const tg = await telegramMark();
  const fromBlock = await pub.getBlockNumber();
  const cancelled = await send(who("whale"), {
    address: C.autoRoller,
    abi: ABI.autoRoller,
    functionName: "cancelStale",
    args: [ben, M[D].asset],
    label: `whale cancelStale(ben, ${D}) permissionless`,
    action: "cancelStale",
  });
  expect(!cancelled.reverted, `cancelStale withdrew ben's ask (tx ${cancelled.hash})`);
  const note = await until("ben's auto_roll withdrawn notification", async () => {
    const all = await telegramMessages();
    return all.find((m) => m.n > tg && m.bot === NOTIFIER_BOT && new RegExp(`Auto-roll withdrew your ${D} ask`).test(m.text)) ?? null;
  }, { timeoutMs: 240_000, intervalMs: 3_000, service: "notifier" });
  expect(note.chatId === String(S.story.subscriptions.ben.chatId), `notifier sent auto_roll withdrawn to ben's fake Telegram chat: "${note.text.split("\n")[0]}"`);
  const logs = await events(C.autoRoller, ABI.autoRoller, "StaleAskCancelled", { writer: ben }, fromBlock).catch(() => []);
  // Forward drill: put the answer back so the drills after it (and --only reruns) read the pool-aligned spot, not ben's
  // strike + 1.
  await pushRound(M[D].feed, answerBefore, await now(), `${D} spot back to ${usd(answerBefore / 100n)} after the stale-cancel drill`);
  return {
    mode: "forward",
    tx: cancelled.hash,
    orderId: orderId.toString(),
    longId: longId.toString(),
    strike: strike.toString(),
    staleLogs: logs.length,
    telegram: note.text.split("\n")[0],
  };
}

export const DRILLS = [
  { id: "indexer-down", title: "Indexer down: the web ticket still buys via the on-chain book", run: indexerDown },
  { id: "feed-paused", title: "Feed paused flag during finalize: retry later works", run: feedPaused },
  { id: "sources-disagree", title: "Sources disagree: candidate with disagreed, finalizes after the delay", run: sourcesDisagree },
  { id: "guardian-veto", title: "Guardian veto: Held, then admin resolve after warp", run: guardianVeto },
  { id: "cranker-killed", title: "Cranker killed mid-expiry: a second cranker (different key) finishes", run: crankerKilled },
  { id: "mint-paused", title: "Guardian pauses minting: closes and redemptions still work", run: mintPaused },
  { id: "fee-change", title: "Scheduled fee change (AccessManager 48 h, then the book's 48 h window): old fees before effectiveAt, a capped take reverts after", run: feeChange },
  { id: "pin-refused", title: "Source removed from the allow-list: createSeries fails closed, v2_pin_refused, recovery", run: pinRefused },
  { id: "reprice", title: "Pricing service -> pricer -> AutoRoller Repriced: ben's roll ask moved to the pricer's target", run: reprice },
  { id: "stale-cancel-notify", title: "cancelStale withdraws ben's overtaken ask; fake Telegram gets auto_roll withdrawn", run: staleCancelNotify },
  { id: "usdg-paused", title: "USDG paused during redemption: ledger credit, later withdraw", run: usdgPaused },
  { id: "monitor", title: "monitor.mjs --once reports the provoked admin events", run: null },
];

async function main() {
  const S = loadState();
  if (!S.story?.finishedAt) fail("step 3 has not finished in this state.json: the drills build on the story's fork and services");
  await impersonate(S.admin);
  await impersonate(S.guardian);
  const t0 = Date.now();
  const previous = S.drills && S.drills._run === S.createdAt ? S.drills : {};
  const results = { ...previous, _run: S.createdAt };
  delete results._summary;
  const selected = DRILLS.filter((d) => ONLY === null || ONLY.includes(d.id));

  step("4. monitor baseline: ops/v2/monitor.mjs --once adopts the history of steps 1-3");
  setStage("4-drills/monitor");
  if (S.drills?._run !== S.createdAt) rmSync(MONITOR_DIR, { recursive: true, force: true });
  if (!existsSync(MONITOR_STATE)) {
    await refreshFeeds("drills start", 900);
    const base = await runMonitor("baseline", { stateFile: MONITOR_STATE });
    expect(base.report.incompleteChecks.length === 0 && [0, 1].includes(base.code), `monitor baseline (forward state): exit ${base.code}, every check complete, ${base.report.findings.length} open finding(s), history adopted`);
    patchState({ monitorBaseline: { code: base.code, findings: base.report.findings.map((f) => `${f.severity} ${f.id}`), sent: base.sent.map((s) => s.kind) } });
  } else {
    info(`forward monitor state kept from this run's earlier step 4 (${path.relative(process.cwd(), MONITOR_STATE)})`);
  }

  let fatal = null;
  for (const d of selected) {
    step(`4. drill ${d.id}: ${d.title}`);
    setStage(`4-drills/${d.id}`);
    setLedgerTag({ drill: d.id });
    const started = Date.now();
    if (fatal) {
      results[d.id] = { status: "not-run", title: d.title, error: `not run: ${fatal}` };
      continue;
    }
    try {
      const r = d.id === "monitor" ? await monitorSummary(results) : await d.run();
      results[d.id] = { status: r.status ?? "passed", title: d.title, seconds: Math.round((Date.now() - started) / 1000), ...r };
      say(`  ${results[d.id].status.toUpperCase()} ${d.id} (${results[d.id].seconds} s)`);
    } catch (error) {
      const message = error instanceof RehearsalError ? error.message : String(error?.stack ?? error);
      results[d.id] = { status: "failed", title: d.title, seconds: Math.round((Date.now() - started) / 1000), error: message };
      say(`  FAILED ${d.id}: ${message.slice(0, 600)}`);
      if (error instanceof FatalDrillError) fatal = message;
    } finally {
      setLedgerTag({});
      patchState({ drills: results });
    }
  }
  setStage("4-drills");
  const list = Object.entries(results).filter(([k]) => !k.startsWith("_"));
  const count = (s) => list.filter(([, r]) => r.status === s).length;
  const summary = { passed: count("passed"), issue: count("issue"), failed: count("failed"), skipped: count("skipped"), notRun: count("not-run"), seconds: Math.round((Date.now() - t0) / 1000) };
  results._summary = summary;
  patchState({ drills: results });
  say(`\nSTEP 4 ${summary.failed || (STRICT && summary.issue) ? "FAILED" : "DONE"}: ${list.length} drills: ${summary.passed} passed, ${summary.issue} passed with a product issue reported, ${summary.failed} failed, ${summary.skipped} skipped, ${summary.notRun} not run (${summary.seconds} s)`);
  for (const [id, r] of list) if (r.status === "issue") for (const i of r.issues ?? []) say(`  ISSUE ${id} [${i.lane}]: ${i.text}`);
  if (summary.failed || summary.notRun || (STRICT && summary.issue)) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  process.stderr.write(`\nSTEP 4 FAILED: ${error instanceof RehearsalError ? error.message : (error?.stack ?? error)}\n`);
  process.exitCode = 1;
}
