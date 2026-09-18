#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * Step 4 of the O2-03 rehearsal: failure drills (plan tasks/O-ops-launch.md O2-03 step 4, plus the INTERFACE_VERSION 6
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
 *   feed-paused        sandbox   NVDA and META oraclePaused() across finalize: NVDA a pool-only candidate, META no
 *                                source (v2_settle_stuck after an hour); flag cleared: the cranker's retry corroborates
 *                                NVDA, captures META; both settle and pay
 *   sources-disagree   sandbox   TSLA window rounds 3 % above the pool: candidate disagreed, v2_sources_disagree,
 *                                finalized uncorroborated after the 6 h delay, paid
 *   guardian-veto      sandbox   META candidate vetoed: Held, v2_settlement_held, no finalize past the delay; adminResolve
 *                                TooEarly before 48 h, ResolveOutOfBand outside the band, then resolved; settled and paid
 *   cranker-killed     sandbox   cranker A (anvil #8) snapshots (and prunes an expired resale ask) and is SIGKILLed;
 *                                cranker B (anvil #11, own journal) finalizes, settles and redeems; every Redeemed once
 *                                per (token, holder)
 *   mint-paused        sandbox   guardian setMintPaused(NVDA): mint, AskWrite fills and writeToSell refused, resale fills,
 *                                close works, the MM bot pulls its NVDA write quotes, the expiry settles and redeems while
 *                                paused, unpause mints again
 *   fee-change         sandbox   setFeeParams (+1 % seller fee, +0.05 USDG taker fee): a take before effectiveAt pays the
 *                                old fees, a take capped at effectiveAt - 1 reverts DeadlinePassed after activation, a
 *                                fresh take pays the new fees
 *   pin-refused        sandbox   ChainlinkFeedSource.setOracle(oracle, false): createSeries of a new expiry reverts
 *                                SourceNotPinned, the cranker pages v2_pin_refused; restored: after its 900 s recheck
 *                                the cranker creates the ladder and pins the expiry
 *   usdg-paused        forward   USDG paused() between the snapshot and finalize of the next daily expiry: the live
 *                                cranker redeems, a put payout is credited to the ledger (notifier
 *                                payout_failed_to_ledger), a converted call payout falls back to in kind; unpaused, the
 *                                holder withdraws
 *   monitor            both      every drill's monitor.mjs --once run (inside its sandbox, on a copy of the forward state)
 *                                paged the provoked kinds through the relay; a final forward run
 *
 * Every drill's assertions go to state.json checks (stage 4-drills/<id>), its evidence to state.drills[id], its
 * transactions to the ledger (drill id, sandbox flag). Exit 1 when a drill failed. A drill whose harness passed but that
 * found a product defect in another lane (reported on the board) is `issue`: exit 0 unless REHEARSE_STRICT=1.
 *
 *   node ops/v2/rehearse/4-drills.mjs [--only <id>[,<id>]] [--skip-web]
 * ------------------------------------------------------------------------------------------------- */
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import {
  ABI, INDEXER_URL, RehearsalError, accountOf, contracts, expect, fail, getAddress, getJson, impersonate, info, ledgerAppend, loadState, markets, now, nyTime,
  patchState, placedOrderId, pub, read, say, send, setLedgerTag, setStage, signalService, serviceRunning, sleep, step, stopService, until, usd, viem, warpTo,
} from "./lib.mjs";
import {
  E18, FatalDrillError, MONITOR_DIR, MONITOR_STATE, NOTIFIER_BOT, STATUS, answer8, bal, cal, ch, events, expectMonitorSent, journal, locateFlag, nextDaily,
  describeRevert, ob, oracle, poolTwap8, printWindow, refreshFeeds, runMonitor, sandbox, setFlag, statusOf, strikeAbove, strikeBelow, telegramMark,
  telegramMessages, txFrom, waitRecorded, waitRelayAlert, writeTo,
} from "./drill-kit.mjs";
import { generatedClean, INDEXER_GENERATED, startIndexer } from "./stack.mjs";

setStage("4-drills");
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

const who = (role) => accountOf(role);
const lower = (a) => a.toLowerCase();
/** The dapp's take deadline rule (DECISIONS-2026-09-17 §4): under 1 h, capped at effectiveAt - 1 while a fee change is pending. */
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
  const cards = await until("an NVDA series with an ask on the indexer's cards", async () => {
    const c = await getJson(`${INDEXER_URL}/v2/cards?ticker=NVDA&limit=50`);
    return c.items.find((x) => BigInt(x.unitsAvailable) >= 1n && x.series.expiry > t + 3600) ?? null;
  }, { timeoutMs: 120_000, intervalMs: 3_000, service: "indexer" });
  const longId = BigInt(cards.series.longId);
  const marketsJson = await getJson(`${INDEXER_URL}/v2/markets`);
  const buyer = who("web");
  const before = await ch("balanceOf", [buyer, longId]);
  info(`series NVDA ${cards.series.strike.formatted} call ${nyTime(cards.series.expiry)} (${cards.series.longId.slice(0, 12)}…), best ask ${cards.ask.formatted}`);
  const browser = await browserApi.openBrowser();
  let r;
  let stoppedAt = null;
  try {
    const wallet = new browserApi.BrowserWallet(buyer, "web buyer (indexer down)");
    r = await browserApi.outageBuyFlow(browser, {
      wallet, ticker: "NVDA", longId: cards.series.longId, indexerUrl: INDEXER_URL, marketsJson,
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
  const issues = r.natural ? [] : [{ lane: "web (codex)", reported: "first reported on the board 2026-09-17T17:05:40Z", text: r.issue }];
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
    const nvPrice = (await answer8("NVDA")) / 100n;
    const mtPrice = (await answer8("META")) / 100n;
    const nv = await writeTo({ writer: "whale", holder: "cy", T: "NVDA", strike: strikeBelow("NVDA", nvPrice, 100n), expiry: E, units: 20n, label: "feed-paused NVDA" });
    const mt = await writeTo({ writer: "whale", holder: "cy", T: "META", strike: strikeBelow("META", mtPrice, 100n), expiry: E, units: 20n, label: "feed-paused META" });
    const mark = await telegramMark();
    const cr = await box.startCranker();
    const printed = await printWindow(E);
    await warpTo(E + 5, "E + 5 s");
    const rec = await waitRecorded("NVDA", E, box.fromBlock, cr.name);
    expect((await txFrom(rec.transactionHash)) === who("cranker"), `the cranker snapshotted NVDA's pool at ${nyTime(E)} (tx ${rec.transactionHash})`);

    const nvFlag = await locateFlag(M.NVDA.asset, "oraclePaused");
    const mtFlag = await locateFlag(M.META.asset, "oraclePaused");
    await setFlag(nvFlag, true, "NVDA oracle paused (issuer flag)");
    await setFlag(mtFlag, true, "META oracle paused (issuer flag)");
    const [nvWin] = await read(C.sources.chainlink, ABI.chainlink, "windowPrice", [M.NVDA.asset, E - 1800, E]);
    expect(!nvWin && !(await oracle("trySpot", [M.NVDA.asset]))[0] && !(await oracle("trySpot", [M.META.asset]))[0], `oraclePaused() true on NVDA and META: the Chainlink window and spot are not ok (flag at storage slot ${nvFlag.slot.slice(0, 10)}… bit ${nvFlag.bit})`);

    await warpTo(E + 125, "E + 125 s: finalize opens while the flag is set");
    const nvPending = await until("NVDA Pending on the pool alone", async () => ((await statusOf("NVDA", E)) === STATUS.Pending ? oracle("candidate", [M.NVDA.asset, E]) : null), { timeoutMs: 120_000, intervalMs: 1_500, service: cr.name });
    const [, okList, prices] = await oracle("recordedSources", [M.NVDA.asset, E]);
    expect(Number(nvPending[1]) === 1 && !nvPending[2] && okList[0] === false && okList[1] === true, `NVDA finalize with the feed paused captured Chainlink not ok and the pool ok (${usd(prices[1])}): a pool-only candidate, source 1, finalizable ${nyTime(Number(nvPending[3]))} NY`);
    const { result: metaTry } = await pub.simulateContract({ account: who("cranker"), address: C.settlementOracle, abi: ABI.oracle, functionName: "finalize", args: [M.META.asset, E] });
    const metaInfo = await oracle("settlementInfo", [M.META.asset, E]);
    expect(metaTry[0] === false && Number(metaInfo[0]) === STATUS.None && metaInfo[5] === false, "META (Chainlink only) with the feed paused: finalize returns (false, 0), nothing captured, status None");

    await warpTo(E + 125 + 3600, "an hour of the flag: the no-source threshold (CRANKER_NO_SOURCE_ALERT_S 3600)");
    const stuck = await waitRelayAlert(mark, "v2_settle_stuck", { re: new RegExp(M.META.asset, "i"), service: cr.name, timeoutMs: 120_000 });
    expect(Boolean(stuck), `cranker paged v2_settle_stuck for META through the relay: "${stuck.text.split("\n").slice(0, 2).join(" ").slice(0, 160)}"`);
    const mon = await runMonitor("feed-paused", { from: MONITOR_STATE });
    const monitor = expectMonitorSent(mon, [["v2_mon_oracle_paused", /^NVDA /], ["v2_mon_oracle_paused", /^META /]]);

    await setFlag(nvFlag, false, "NVDA oracle flag cleared");
    await setFlag(mtFlag, false, "META oracle flag cleared");
    const nvFin = await until("NVDA Finalized after the retry", async () => {
      const i = await oracle("settlementInfo", [M.NVDA.asset, E]);
      return Number(i[0]) === STATUS.Finalized ? i : null;
    }, { timeoutMs: 120_000, intervalMs: 1_500, service: cr.name });
    const [nvLog] = await events(C.settlementOracle, ABI.oracle, "SettlementFinalized", { underlying: M.NVDA.asset, expiry: E }, box.fromBlock);
    expect(nvFin[3] === true && Number(nvFin[2]) === 0 && nvFin[1] === printed.NVDA / 100n && (await txFrom(nvLog.transactionHash)) === who("cranker"), `flag cleared: the cranker's next finalize upgraded Chainlink and finalized NVDA corroborated at ${usd(nvFin[1])} (source 0, tx ${nvLog.transactionHash})`);
    const mtCand = await until("META candidate after the retry", async () => {
      const c = await oracle("candidate", [M.META.asset, E]);
      return Number(c[3]) > 0 ? c : null;
    }, { timeoutMs: 120_000, intervalMs: 1_500, service: cr.name });
    expect(Number(mtCand[1]) === 0 && !mtCand[2], `flag cleared: the cranker's finalize captured META (single source ${usd(mtCand[0])}, finalizable ${nyTime(Number(mtCand[3]))} NY)`);
    await waitRedeemed("cy's NVDA long redeemed", [[who("cy"), nv]], cr.name);
    await warpTo(Number(mtCand[3]) + 5, "past META's uncorroborated delay");
    await until("META Finalized", async () => (await statusOf("META", E)) === STATUS.Finalized, { timeoutMs: 120_000, intervalMs: 1_500, service: cr.name });
    await waitRedeemed("cy's META long redeemed", [[who("cy"), mt]], cr.name);
    const paid = await redeemedLogs(box.fromBlock, [nv, mt]);
    const cyPaid = paid.filter((l) => getAddress(l.args.holder) === who("cy"));
    expect(cyPaid.length === 2 && cyPaid.every((l) => l.args.amount > 0n), `both settle and pay: ${cyPaid.map((l) => `${l.args.tokenId === nv ? "NVDA" : "META"} ${getAddress(l.args.asset) === getAddress(loadState().usdg) ? `${usd(l.args.amount)} USDG` : `${(Number(l.args.amount) / 1e18).toFixed(6)} in kind`}`).join(", ")}`);
    const bot = botEvidence(cr.db);
    return {
      mode: "sandbox", expiry: E, flag: { NVDA: { slot: nvFlag.slot, bit: nvFlag.bit }, META: { slot: mtFlag.slot, bit: mtFlag.bit } },
      txs: [{ what: "NVDA SettlementFinalized (retry)", hash: nvLog.transactionHash }, ...cyPaid.map((l) => ({ what: `Redeemed ${l.args.tokenId === nv ? "NVDA" : "META"} cy`, hash: l.transactionHash }))],
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
    const ts = await writeTo({ writer: "whale", holder: "dee", T: "TSLA", strike: strikeBelow("TSLA", (await answer8("TSLA")) / 100n, 100n), expiry: E, units: 20n, label: "sources-disagree TSLA" });
    const mark = await telegramMark();
    const cr = await box.startCranker();
    const twap = await poolTwap8("TSLA");
    const high = (twap * 103n) / 100n;
    await printWindow(E, { TSLA: high });
    info(`TSLA window rounds at ${usd(high / 100n)}: 3 % above the pool's ${usd(twap / 100n)} (maxDeviationBps 150)`);
    await warpTo(E + 5, "E + 5 s");
    const rec = await waitRecorded("TSLA", E, box.fromBlock, cr.name);
    await warpTo(E + 125, "E + 125 s: finalize opens");
    const candLog = await until("TSLA SettlementCandidate", async () => (await events(C.settlementOracle, ABI.oracle, "SettlementCandidate", { underlying: M.TSLA.asset, expiry: E }, box.fromBlock))[0] ?? null, { timeoutMs: 120_000, intervalMs: 1_500, service: cr.name });
    const candBlock = await pub.getBlock({ blockNumber: candLog.blockNumber });
    const [, okList, prices, dev] = await oracle("recordedSources", [M.TSLA.asset, E]);
    const lo = prices[0] < prices[1] ? prices[0] : prices[1];
    const diffBps = ((prices[0] > prices[1] ? prices[0] - prices[1] : prices[1] - prices[0]) * BPS) / lo;
    expect(candLog.args.disagreed === true && Number(candLog.args.sourceIndex) === 0 && candLog.args.price === high / 100n && Number(candLog.args.finalizableAt) === Number(candBlock.timestamp) + 21_600 && okList[0] && okList[1] && diffBps > BigInt(dev),
      `SettlementCandidate(disagreed = true): Chainlink ${usd(prices[0])} vs pool snapshot ${usd(prices[1])} (${diffBps} bps > ${dev}), candidate source 0 at ${usd(candLog.args.price)}, finalizable ${nyTime(Number(candLog.args.finalizableAt))} NY = announcement + 6 h (tx ${candLog.transactionHash})`);
    expect((await statusOf("TSLA", E)) === STATUS.Pending, "status Pending while the delay runs");
    const alert = await waitRelayAlert(mark, "v2_sources_disagree", { service: cr.name });
    expect(Boolean(alert), `cranker paged v2_sources_disagree through the relay: "${alert.text.split("\n").slice(0, 2).join(" ").slice(0, 160)}"`);
    const mon = await runMonitor("sources-disagree", { from: MONITOR_STATE });
    const monitor = expectMonitorSent(mon, ["v2_mon_sources_disagree"]);
    await warpTo(Number(candLog.args.finalizableAt) + 5, "past the uncorroborated delay");
    const finLog = await until("TSLA SettlementFinalized", async () => (await events(C.settlementOracle, ABI.oracle, "SettlementFinalized", { underlying: M.TSLA.asset, expiry: E }, box.fromBlock))[0] ?? null, { timeoutMs: 120_000, intervalMs: 1_500, service: cr.name });
    expect(finLog.args.corroborated === false && finLog.args.price === candLog.args.price && Number(finLog.args.sourceIndex) === 0, `after the delay the cranker finalized TSLA uncorroborated at the candidate ${usd(finLog.args.price)} (tx ${finLog.transactionHash})`);
    await waitRedeemed("dee's TSLA long redeemed", [[who("dee"), ts]], cr.name);
    const [paid] = (await redeemedLogs(box.fromBlock, [ts])).filter((l) => getAddress(l.args.holder) === who("dee"));
    expect(paid && paid.args.amount > 0n, `settled and paid dee: ${getAddress(paid.args.asset) === getAddress(loadState().usdg) ? `${usd(paid.args.amount)} USDG` : `${(Number(paid.args.amount) / 1e18).toFixed(6)} TSLA`} (tx ${paid.transactionHash})`);
    return {
      mode: "sandbox", expiry: E, prices: { chainlink: prices[0].toString(), pool: prices[1].toString(), diffBps: Number(diffBps) },
      txs: [{ what: "TSLA snapshot", hash: rec.transactionHash }, { what: "SettlementCandidate (disagreed)", hash: candLog.transactionHash }, { what: "SettlementFinalized uncorroborated", hash: finLog.transactionHash }, { what: "Redeemed dee", hash: paid.transactionHash }],
      alerts: [{ kind: "v2_sources_disagree", text: alert.text.slice(0, 240) }], monitor, cranker: botEvidence(cr.db),
      notCovered: ["The indexer's settling -> settled status for this expiry (the indexer is frozen in a sandbox); step 3 covers the settling status on META."],
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
    const mtAnswer = await answer8("META");
    const mt = await writeTo({ writer: "whale", holder: "eve", T: "META", strike: strikeBelow("META", mtAnswer / 100n, 100n), expiry: E, units: 20n, label: "guardian-veto META" });
    const mark = await telegramMark();
    const cr = await box.startCranker();
    await printWindow(E, { META: (mtAnswer * 103n) / 100n });
    await warpTo(E + 125, "E + 125 s: finalize opens");
    const cand = await until("META candidate", async () => {
      const c = await oracle("candidate", [M.META.asset, E]);
      return Number(c[3]) > 0 ? c : null;
    }, { timeoutMs: 120_000, intervalMs: 1_500, service: cr.name });
    const veto = await send(S.guardian, { address: C.settlementOracle, abi: ABI.oracle, functionName: "veto", args: [M.META.asset, E], label: "guardian veto META", action: "veto" });
    const vetoLog = viem.parseEventLogs({ abi: ABI.oracle, eventName: "SettlementVetoed", logs: veto.receipt.logs })[0];
    expect(Boolean(vetoLog) && (await statusOf("META", E)) === STATUS.Held, `guardian (impersonated ${S.guardian}) vetoed META's candidate ${usd(cand[0])}: SettlementVetoed, status Held (tx ${veto.hash})`);
    const held = await waitRelayAlert(mark, "v2_settlement_held", { service: cr.name });
    expect(Boolean(held), `cranker paged v2_settlement_held through the relay: "${held.text.split("\n").slice(0, 2).join(" ").slice(0, 160)}"`);
    const early = await send(S.admin, { address: C.settlementOracle, abi: ABI.oracle, functionName: "adminResolve", args: [M.META.asset, E, cand[0]], label: "admin adminResolve before RESOLVE_DELAY", expectRevert: true });
    expect(early.reverted && /TooEarly/.test(early.reason), `adminResolve before expiry + 48 h reverts ${early.reason}`);
    const mon = await runMonitor("guardian-veto", { from: MONITOR_STATE });
    const monitor = expectMonitorSent(mon, ["v2_mon_settlement_held", ["v2_mon_config_changed", /SettlementVetoed/]]);
    await warpTo(Number(cand[3]) + 5, "past the vetoed candidate's delay");
    await sleep(15_000);
    expect((await statusOf("META", E)) === STATUS.Held && (await events(C.settlementOracle, ABI.oracle, "SettlementFinalized", { underlying: M.META.asset, expiry: E }, box.fromBlock)).length === 0, "past its delay the held candidate does not finalize (the cranker keeps paging, sends no finalize)");
    await warpTo(E + 48 * 3600 + 5, "expiry + RESOLVE_DELAY (48 h)");
    const [bounded, lo, hi] = await oracle("resolveBand", [M.META.asset, E]);
    const out = await send(S.admin, { address: C.settlementOracle, abi: ABI.oracle, functionName: "adminResolve", args: [M.META.asset, E, hi + 1_000_000n], label: "admin adminResolve outside the band", expectRevert: true });
    expect(bounded && out.reverted && /ResolveOutOfBand/.test(out.reason), `adminResolve outside [${usd(lo)}, ${usd(hi)}] reverts ${out.reason}`);
    const price = (cand[0] * 9_950n) / BPS;
    const resolve = await send(S.admin, { address: C.settlementOracle, abi: ABI.oracle, functionName: "adminResolve", args: [M.META.asset, E, price], label: `admin adminResolve META ${usd(price)}`, action: "adminResolve" });
    const info_ = await oracle("settlementInfo", [M.META.asset, E]);
    expect(Number(info_[0]) === STATUS.Finalized && info_[4] === true && info_[1] === price, `admin (impersonated ${S.admin}) resolved META at ${usd(price)} inside the band after 48 h: SettlementResolved, Finalized, resolved = true (tx ${resolve.hash})`);
    await waitRedeemed("eve's META long redeemed", [[who("eve"), mt]], cr.name);
    const series = await ch("series", [mt]);
    const [paid] = (await redeemedLogs(box.fromBlock, [mt])).filter((l) => getAddress(l.args.holder) === who("eve"));
    expect(series.settled && series.settlementPrice === price && paid, `the cranker settled META at the resolved price and redeemed eve: ${(Number(paid.args.amount) / 1e18).toFixed(6)} META in kind (tx ${paid.transactionHash})`);
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
    const nv = await writeTo({ writer: "whale", holder: "cy", T: "NVDA", strike: strikeBelow("NVDA", (await answer8("NVDA")) / 100n, 100n), expiry: E, units: 30n, label: "cranker-killed NVDA" });
    const ts = await writeTo({ writer: "whale", holder: "dee", T: "TSLA", strike: strikeBelow("TSLA", (await answer8("TSLA")) / 100n, 100n), expiry: E, units: 30n, label: "cranker-killed TSLA" });
    // A resale ask left open at expiry escrows 10 of dee's longs: the cranker must prune it before it can redeem them.
    await send(who("dee"), { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "setApprovalForAll", args: [C.orderBook, true], label: "dee setApprovalForAll(book)", action: "setApprovalForAll" });
    const { receipt: resaleReceipt } = await send(who("dee"), { address: C.orderBook, abi: ABI.orderBook, functionName: "place", args: [ts, RESALE, 90_000_000n, 10n, 0], label: "dee AskResale 0.10 share TSLA (left open at expiry)", action: "place-resale" });
    const resaleId = placedOrderId(resaleReceipt, C.orderBook);
    const a = await box.startCranker({ name: "drill-cranker-killed-a", keyRole: "cranker" });
    await printWindow(E);
    await warpTo(E + 5, "E + 5 s");
    const recN = await waitRecorded("NVDA", E, box.fromBlock, a.name);
    const recT = await waitRecorded("TSLA", E, box.fromBlock, a.name);
    expect((await txFrom(recN.transactionHash)) === who("cranker") && (await txFrom(recT.transactionHash)) === who("cranker"), `cranker A (anvil #8 ${who("cranker")}) snapshotted NVDA and TSLA (txs ${recN.transactionHash}, ${recT.transactionHash})`);
    signalService(a.name, "SIGKILL");
    await until("cranker A gone", async () => !serviceRunning(a.name), { timeoutMs: 15_000, intervalMs: 250 });
    await stopService(a.name);
    const aEvidence = botEvidence(a.db);
    expect(true, `cranker A killed with SIGKILL mid-expiry (after its snapshots, before finalize opens); its journal holds ${aEvidence.txs.length} transaction(s)`);
    await warpTo(E + 125, "E + 125 s: finalize opens with no cranker running");
    await sleep(8_000);
    expect((await statusOf("NVDA", E)) === STATUS.None && (await statusOf("TSLA", E)) === STATUS.None, "with no cranker the expiry waits: NVDA and TSLA still None");
    const b = await box.startCranker({ name: "drill-cranker-killed-b", keyRole: "cranker2" });
    await until("cranker B finalizes NVDA and TSLA", async () => (await statusOf("NVDA", E)) === STATUS.Finalized && (await statusOf("TSLA", E)) === STATUS.Finalized, { timeoutMs: 180_000, intervalMs: 1_500, service: b.name });
    const fins = [...(await events(C.settlementOracle, ABI.oracle, "SettlementFinalized", { underlying: M.NVDA.asset, expiry: E }, box.fromBlock)), ...(await events(C.settlementOracle, ABI.oracle, "SettlementFinalized", { underlying: M.TSLA.asset, expiry: E }, box.fromBlock))];
    const finFrom = await Promise.all(fins.map((l) => txFrom(l.transactionHash)));
    expect(fins.length === 2 && finFrom.every((f) => f === who("cranker2")) && fins.every((l) => l.args.corroborated), `cranker B (anvil #11 ${who("cranker2")}, its own journal) finalized both corroborated (txs ${fins.map((l) => l.transactionHash).join(", ")})`);
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
      txs: [{ what: "A snapshot NVDA", hash: recN.transactionHash }, { what: "A snapshot TSLA", hash: recT.transactionHash }, ...fins.map((l) => ({ what: "B SettlementFinalized", hash: l.transactionHash })), { what: `prune of the resale ask (cranker ${prunedBy === who("cranker2") ? "B" : "A"})`, hash: pruned.transactionHash }, ...[...new Set(logs.map((l) => l.transactionHash))].map((h) => ({ what: "B redeemBatch", hash: h }))],
      bounties: Object.fromEntries(Object.entries(byAction).map(([k, v]) => [k, v.toString()])),
      crankerA: aEvidence, crankerB: bEvidence,
    };
  });
}

/* ------------------------------------------------------------------ mint-paused (sandbox) */
async function mintPaused() {
  const M = markets();
  const C = contracts();
  const S = loadState();
  return sandbox("mint-paused", async (box) => {
    const E = await nextDaily();
    const whale = who("whale");
    const strike = strikeBelow("NVDA", (await answer8("NVDA")) / 100n, 100n);
    const nv = await writeTo({ writer: "whale", holder: "eve", T: "NVDA", strike, expiry: E, units: 20n, label: "mint-paused NVDA to eve" });
    await writeTo({ writer: "whale", holder: "whale", T: "NVDA", strike, expiry: E, units: 10n, label: "mint-paused NVDA pair kept by the writer" });
    // Orders before the pause: the writer's AskWrite (collateral in its ledger), gus's bid, eve's resale ask.
    await send(whale, { address: M.NVDA.asset, abi: ABI.erc20, functionName: "approve", args: [C.clearinghouse, E18], label: "whale NVDA approve", action: "approve" });
    await send(whale, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "deposit", args: [M.NVDA.asset, E18 / 10n, whale], label: "whale deposit 0.1 NVDA for an AskWrite", action: "deposit" });
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
        if (getAddress(s.underlying) === M.NVDA.asset) out.push(ids[i]);
      }
      return out;
    };
    const before = await until("the MM bot quotes NVDA AskWrite", async () => {
      const w = await vaultWrites();
      return w.length > 0 ? w : null;
    }, { timeoutMs: 150_000, intervalMs: 3_000, service: mm.name });
    info(`MM vault: ${before.length} live NVDA AskWrite order(s) before the pause`);

    const cr = await box.startCranker();
    const pause = await send(S.guardian, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "setMintPaused", args: [M.NVDA.asset, true], label: "guardian setMintPaused(NVDA, true)", action: "setMintPaused" });
    expect((await ch("market", [M.NVDA.asset])).mintPaused === true, `guardian (impersonated) paused NVDA minting: MintPausedSet (tx ${pause.hash})`);
    const mint = await send(whale, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "mint", args: [nv, 1n, whale, whale], label: "whale mint while paused", expectRevert: true });
    expect(mint.reverted && /MintPaused/.test(mint.reason), `a writer's mint reverts ${mint.reason}`);
    const deadline = await dappDeadline();
    const takeAsk = await send(who("cy"), { address: C.orderBook, abi: ABI.orderBook, functionName: "take", args: [{ longId: nv, buying: true, orderIds: [askWrite], units: 10n, minUnits: 10n, limitPrice: 3_000_000n, writeToSell: false, recipient: who("cy"), deadline }], label: "cy take the AskWrite while paused", expectRevert: true });
    expect(takeAsk.reverted && /BelowMinUnits/.test(takeAsk.reason), `buying an AskWrite (mint on fill) is skipped by the book: take reverts ${takeAsk.reason}`);
    const hitBid = await send(whale, { address: C.orderBook, abi: ABI.orderBook, functionName: "take", args: [{ longId: nv, buying: false, orderIds: [bid], units: 10n, minUnits: 10n, limitPrice: 200_000n, writeToSell: true, recipient: whale, deadline }], label: "whale writeToSell into gus's bid while paused", expectRevert: true });
    expect(hitBid.reverted && /BelowMinUnits/.test(hitBid.reason), `writing into a bid (writeToSell) is skipped: take reverts ${hitBid.reason}`);
    const resaleTake = await send(who("fay"), { address: C.orderBook, abi: ABI.orderBook, functionName: "take", args: [{ longId: nv, buying: true, orderIds: [resale], units: 5n, minUnits: 5n, limitPrice: 2_500_000n, writeToSell: false, recipient: who("fay"), deadline }], label: "fay buys eve's resale while paused", action: "take-buy" });
    const resaleFill = viem.parseEventLogs({ abi: ABI.orderBook, eventName: "OrderFilled", logs: resaleTake.receipt.logs })[0];
    expect(resaleFill && !resaleFill.args.primary && (await ch("balanceOf", [who("fay"), nv])) === 5n, `existing longs still trade: fay bought eve's 0.05 share resale (tx ${resaleTake.hash})`);
    const free0 = await ch("free", [whale, M.NVDA.asset]);
    const close = await send(whale, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "close", args: [nv, 10n], label: "whale close 10 units while paused", action: "close" });
    expect((await ch("free", [whale, M.NVDA.asset])) === free0 + 10n * 10n ** 16n && (await ch("balanceOf", [whale, nv])) === 0n, `a writer's close() works while paused: 10 long + 10 short burned, 0.1 NVDA collateral freed (tx ${close.hash})`);
    const pulled = await until("the MM bot pulls its NVDA write quotes", async () => ((await vaultWrites()).length === 0 ? true : null), { timeoutMs: 120_000, intervalMs: 3_000, service: mm.name });
    expect(pulled, `the MM bot pulled every NVDA AskWrite quote after the pause (${before.length} before)`);
    const mon = await runMonitor("mint-paused", { from: MONITOR_STATE });
    const monitor = expectMonitorSent(mon, [["v2_mon_config_changed", /MintPausedSet/]]);

    await printWindow(E);
    await warpTo(E + 5, "E + 5 s");
    await waitRecorded("NVDA", E, box.fromBlock, cr.name);
    await warpTo(E + 125, "E + 125 s");
    await until("NVDA Finalized while minting is paused", async () => (await statusOf("NVDA", E)) === STATUS.Finalized, { timeoutMs: 120_000, intervalMs: 1_500, service: cr.name });
    await waitRedeemed("eve's and fay's longs redeemed while paused", [[who("eve"), nv], [who("fay"), nv]], cr.name);
    const logs = (await redeemedLogs(box.fromBlock, [nv])).filter((l) => [who("eve"), who("fay")].includes(getAddress(l.args.holder)));
    expect(logs.length === 2 && (await ch("market", [M.NVDA.asset])).mintPaused === true, `settlement and redemptions work while paused: eve and fay redeemed (tx ${[...new Set(logs.map((l) => l.transactionHash))].join(", ")}), minting still paused`);
    const unpause = await send(S.guardian, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "setMintPaused", args: [M.NVDA.asset, false], label: "guardian setMintPaused(NVDA, false)", action: "setMintPaused" });
    const next = await nextDaily();
    const later = await ch("longIdOf", [M.NVDA.asset, false, strike, next]);
    if (!(await ch("seriesExists", [later]))) await send(whale, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "createSeries", args: [M.NVDA.asset, false, strike, next], label: "whale createSeries (after unpause)", action: "createSeries" });
    const mintAfter = await send(whale, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "mint", args: [later, 5n, whale, whale], label: "whale mint after unpause", action: "mint" });
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
    const Ef = Number(await cal("nextExpiry", [BigInt((await now()) + 26 * 3600), false]));
    const strike = strikeBelow("NVDA", (await answer8("NVDA")) / 100n, 200n);
    const longId = await ch("longIdOf", [M.NVDA.asset, false, strike, Ef]);
    if (!(await ch("seriesExists", [longId]))) await send(whale, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "createSeries", args: [M.NVDA.asset, false, strike, Ef], label: "whale createSeries (fee drill)", action: "createSeries" });
    await send(whale, { address: M.NVDA.asset, abi: ABI.erc20, functionName: "approve", args: [C.clearinghouse, 3n * E18], label: "whale NVDA approve", action: "approve" });
    await send(whale, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "deposit", args: [M.NVDA.asset, 3n * E18, whale], label: "whale deposit 3 NVDA", action: "deposit" });
    await send(whale, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "setOperator", args: [C.orderBook, true], label: "whale setOperator(book)", action: "setOperator" });
    const PRICE = 5_000_000n;
    const { receipt: askReceipt } = await send(whale, { address: C.orderBook, abi: ABI.orderBook, functionName: "place", args: [longId, WRITE, PRICE, 300n, 0], label: "whale AskWrite 3 shares @ 5.00 (fee drill)", action: "place-write" });
    const orderId = placedOrderId(askReceipt, C.orderBook);
    const F0 = fees(await ob("feeParams"));
    const F1 = { ...F0, premiumFeeBps: F0.premiumFeeBps + 100, takerFeeFlat: F0.takerFeeFlat + 50_000 };
    const sched = await send(S.admin, { address: C.orderBook, abi: ABI.orderBook, functionName: "setFeeParams", args: [F1], label: `admin setFeeParams seller ${F1.premiumFeeBps} bps, taker ${usd(F1.takerFeeFlat)}`, action: "setFeeParams" });
    const schedLog = viem.parseEventLogs({ abi: ABI.orderBook, eventName: "FeeParamsScheduled", logs: sched.receipt.logs })[0];
    const schedBlock = await pub.getBlock({ blockNumber: sched.receipt.blockNumber });
    const effectiveAt = Number(schedLog.args.effectiveAt);
    const [pending, pendingAt] = await ob("pendingFeeParams");
    expect(effectiveAt === Number(schedBlock.timestamp) + 86_400 && Number(pendingAt) === effectiveAt && JSON.stringify(fees(pending)) === JSON.stringify(F1) && JSON.stringify(fees(await ob("feeParams"))) === JSON.stringify(F0),
      `admin (impersonated) scheduled seller fee ${F0.premiumFeeBps} -> ${F1.premiumFeeBps} bps and taker fee ${usd(F0.takerFeeFlat)} -> ${usd(F1.takerFeeFlat)}: FeeParamsScheduled effective ${nyTime(effectiveAt)} NY = block + 24 h; feeParams() unchanged (tx ${sched.hash})`);
    const mon = await runMonitor("fee-change", { from: MONITOR_STATE });
    const monitor = expectMonitorSent(mon, [["v2_mon_fee_scheduled", /RAISES/]]);

    const takeParams = async (role, deadline) => ({ longId, buying: true, orderIds: [orderId], units: 100n, minUnits: 100n, limitPrice: PRICE, writeToSell: false, recipient: who(role), deadline });
    const takeAndCheck = async (role, feesIn, label) => {
      const p = await takeParams(role, await dappDeadline());
      const r = await send(who(role), { address: C.orderBook, abi: ABI.orderBook, functionName: "take", args: [p], label, action: "take-buy" });
      const fill = viem.parseEventLogs({ abi: ABI.orderBook, eventName: "OrderFilled", logs: r.receipt.logs })[0];
      const taken = viem.parseEventLogs({ abi: ABI.orderBook, eventName: "Taken", logs: r.receipt.logs })[0];
      const premium = fill.args.premium;
      const okSeller = fill.args.sellerFee === (premium * BigInt(feesIn.premiumFeeBps)) / BPS;
      const okTaker = taken.args.takerFee === takerFeeOf(premium, feesIn);
      return { r, fill, taken, ok: okSeller && okTaker, deadline: p.deadline, premium };
    };
    const a = await takeAndCheck("dee", F0, "dee take before effectiveAt");
    expect(a.ok && a.deadline <= effectiveAt - 1, `a take before effectiveAt pays the old fees: premium ${usd(a.premium)}, seller fee ${usd(a.fill.args.sellerFee)} (${F0.premiumFeeBps} bps), taker fee ${usd(a.taken.args.takerFee)} (tx ${a.r.hash})`);

    await warpTo(effectiveAt - 600, "ten minutes before the fee change takes effect");
    const capped = await takeParams("fay", await dappDeadline());
    const [, qPremium, qFee] = await ob("quoteTake", [capped]);
    expect(capped.deadline === effectiveAt - 1 && qFee === takerFeeOf(qPremium, F0), `the dapp's take built ten minutes before activation is capped at effectiveAt - 1 (${capped.deadline}) and quoted at the old taker fee ${usd(qFee)}`);
    await warpTo(effectiveAt, "effectiveAt: the scheduled fees apply from this block");
    const [, zeroAt] = await ob("pendingFeeParams");
    expect(JSON.stringify(fees(await ob("feeParams"))) === JSON.stringify(F1) && Number(zeroAt) === 0, "at effectiveAt feeParams() returns the new fees and pendingFeeParams() is empty");
    const late = await send(who("fay"), { address: C.orderBook, abi: ABI.orderBook, functionName: "take", args: [capped], label: "fay sends the capped take after activation", expectRevert: true, sendReverting: true, gas: 1_000_000n });
    expect(late.reverted && /DeadlinePassed/.test(late.reason) && late.receipt.status === "reverted", `the capped take mined after activation reverts ${late.reason}: it never pays the new fees (tx ${late.hash}, status reverted)`);
    const c = await takeAndCheck("cy", F1, "cy take after activation");
    expect(c.ok, `a fresh take after activation pays the new fees: premium ${usd(c.premium)}, seller fee ${usd(c.fill.args.sellerFee)} (${F1.premiumFeeBps} bps), taker fee ${usd(c.taken.args.takerFee)} (tx ${c.r.hash})`);
    return {
      mode: "sandbox", seriesExpiry: Ef, effectiveAt, feesBefore: F0, feesAfter: F1,
      txs: [{ what: "setFeeParams (schedule)", hash: sched.hash }, { what: "take before effectiveAt (old fees)", hash: a.r.hash }, { what: "capped take after activation (reverted DeadlinePassed)", hash: late.hash }, { what: "take after activation (new fees)", hash: c.r.hash }],
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
    const E2 = await nextDaily();
    const revoke = await send(S.admin, { address: C.sources.chainlink, abi: ABI.chainlink, functionName: "setOracle", args: [C.settlementOracle, false], label: "admin ChainlinkFeedSource.setOracle(oracle, false)", action: "setOracle" });
    expect((await read(C.sources.chainlink, ABI.chainlink, "isOracle", [C.settlementOracle])) === false, `admin (impersonated) removed the SettlementOracle from ChainlinkFeedSource's allow-list: OracleSet(oracle, false) (tx ${revoke.hash})`);
    const t1 = await warpTo(E2 - 3_840, "the ladder horizon (now + 65 min) passes today's close: a new daily expiry enters it");
    await refreshFeeds("pin-refused: fresh spot for the ladders", 0);
    let Enew = null;
    let cursor = t1 + 3_900;
    for (let i = 0; i < 3; i += 1) {
      const e = Number(await cal("nextExpiry", [BigInt(cursor), false]));
      if (getAddress(await oracle("pinnedBy", [M.NVDA.asset, e])) === ZERO) {
        Enew = e;
        break;
      }
      cursor = e;
    }
    if (Enew === null) fail("no unpinned daily expiry among the next three");
    const strike = strikeAbove("NVDA", (await answer8("NVDA")) / 100n, 100n);
    const refused = await send(who("whale"), { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "createSeries", args: [M.NVDA.asset, false, strike, Enew], label: "whale createSeries on the new expiry", expectRevert: true });
    expect(refused.reverted && /SourceNotPinned/.test(refused.reason) && refused.reason.toLowerCase().includes(C.sources.chainlink.toLowerCase()) && /0xea8e4eb5/i.test(refused.reason),
      `createSeries of NVDA ${nyTime(Enew)} (not pinned yet) reverts ${refused.reason}: the Chainlink source answered NotAuthorized (0xea8e4eb5), so the creation fails closed`);
    const mark = await telegramMark();
    const cr = await box.startCranker();
    const alert = await waitRelayAlert(mark, "v2_pin_refused", { re: new RegExp(String(Enew)), service: cr.name, timeoutMs: 150_000 });
    expect(Boolean(alert), `the cranker's ladder probe paged v2_pin_refused through the relay naming ${Enew}: "${alert.text.split("\n").slice(0, 2).join(" ").slice(0, 200)}"`);
    expect(getAddress(await oracle("pinnedBy", [M.NVDA.asset, Enew])) === ZERO, "nothing was created or pinned on the refused expiry");
    const mon = await runMonitor("pin-refused", { from: MONITOR_STATE });
    const monitor = expectMonitorSent(mon, [["v2_mon_oracle_allowlist", /OracleSet\(/], "v2_mon_pin_blocked"]);
    const restore = await send(S.admin, { address: C.sources.chainlink, abi: ABI.chainlink, functionName: "setOracle", args: [C.settlementOracle, true], label: "admin ChainlinkFeedSource.setOracle(oracle, true)", action: "setOracle" });
    await sleep(12_000);
    expect(getAddress(await oracle("pinnedBy", [M.NVDA.asset, Enew])) === ZERO, `allow-list restored (tx ${restore.hash}); within PIN_REFUSED_RECHECK_S (900 s) the cranker does not ask again`);
    await warpTo((await now()) + 905, "past the cranker's 900 s pin recheck");
    await refreshFeeds("pin-refused: recheck", 0);
    await until("the cranker pins and creates the recovered expiry", async () => getAddress(await oracle("pinnedBy", [M.NVDA.asset, Enew])) === C.clearinghouse, { timeoutMs: 150_000, intervalMs: 2_000, service: cr.name });
    const created = await events(C.clearinghouse, ABI.clearinghouse, "SeriesCreated", { underlying: M.NVDA.asset }, box.fromBlock);
    const onNew = created.filter((l) => Number(l.args.expiry) === Enew);
    const pinnedLog = (await events(C.settlementOracle, ABI.oracle, "SettlementConfigPinned", { underlying: M.NVDA.asset, expiry: Enew }, box.fromBlock))[0];
    expect(onNew.length > 0 && pinnedLog && (await txFrom(pinnedLog.transactionHash)) === who("cranker"), `recovered: the cranker's recheck created ${onNew.length} NVDA series on ${nyTime(Enew)} and pinned the expiry (SettlementConfigPinned, tx ${pinnedLog?.transactionHash})`);
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
  const spot = (await answer8("NVDA")) / 100n;
  const put = await writeTo({ writer: "whale", holder: "eve", T: "NVDA", isPut: true, strike: strikeAbove("NVDA", spot, 200n), expiry: E, units: 20n, label: "usdg-paused NVDA put (USDG collateral) to eve" });
  const call = await writeTo({ writer: "whale", holder: "eve", T: "NVDA", strike: strikeBelow("NVDA", spot, 200n), expiry: E, units: 20n, label: "usdg-paused NVDA call to eve" });
  const fromBlock = await pub.getBlockNumber();
  const tg = await telegramMark();
  const printed = await printWindow(E);
  await warpTo(E + 5, "E + 5 s");
  const rec = await waitRecorded("NVDA", E, fromBlock, "cranker", 180_000);
  expect((await txFrom(rec.transactionHash)) === who("cranker"), `the live cranker snapshotted NVDA (tx ${rec.transactionHash})`);
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
    expect(getAddress(callLog.args.asset) === M.NVDA.asset && callLog.args.toLedger === false && callLog.args.amount === callLog.args.amountInKind,
      `USDG paused: eve's ITM call could not convert (the swap pays USDG) and fell back to in kind: ${(Number(callLog.args.amount) / 1e18).toFixed(6)} NVDA to her wallet (tx ${callLog.transactionHash})`);
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
    txs: [{ what: "NVDA snapshot (live cranker)", hash: rec.transactionHash }, { what: "withdraw after unpause", hash: withdrawHash }],
    credited: credited.toString(), monitor: [...monitor, { kind: "v2_mon_resolved", severity: "info", message: "v2_mon_usdg_paused resolved" }],
    notes: [`KeeperRewards Rewarded events from the drill's first block: ${rewards.length} (bounties are paid in USDG: while it was paused each reward transfer failed silently and nothing was logged for it)`],
  };
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

export const DRILLS = [
  { id: "indexer-down", title: "Indexer down: the web ticket still buys via the on-chain book", run: indexerDown },
  { id: "feed-paused", title: "Feed paused flag during finalize: retry later works", run: feedPaused },
  { id: "sources-disagree", title: "Sources disagree: candidate with disagreed, finalizes after the delay", run: sourcesDisagree },
  { id: "guardian-veto", title: "Guardian veto: Held, then admin resolve after warp", run: guardianVeto },
  { id: "cranker-killed", title: "Cranker killed mid-expiry: a second cranker (different key) finishes", run: crankerKilled },
  { id: "mint-paused", title: "Guardian pauses minting: closes and redemptions still work", run: mintPaused },
  { id: "fee-change", title: "Scheduled fee change (24 h): old fees before effectiveAt, a capped take reverts after", run: feeChange },
  { id: "pin-refused", title: "Source removed from the allow-list: createSeries fails closed, v2_pin_refused, recovery", run: pinRefused },
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
