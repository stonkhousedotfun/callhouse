#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * Step 5 of the O2-03 rehearsal: the report (plan tasks/O-ops-launch.md O2-03 step 5 and its gate: each step with tx
 * hashes on the fork and the web flows' screenshots), generated from what steps 1-4 recorded:
 *
 *   ## Result           per step and per drill
 *   ## Run              fork block, commits, registry sha256, contracts, markets
 *   ## Steps 1-3        every assertion (state.json checks)
 *   ## Step 4           per drill: mode, assertions, key transactions, relay alerts, monitor kinds, issues, not covered
 *   ## Transactions     the ledger per step: every transaction with gas (drill ones tagged, sandbox ones marked)
 *   ## Bots             each bot journal (live and drill-local): transactions by kind with gas, alerts
 *   ## Gas per action   ledger + journals: count, mean, min, max
 *   ## Bounty spend     KeeperRewards per (underlying, expiry), on the fork and inside each sandbox before its revert
 *   ## Screenshots, ## Deviations from the plan, ## Not covered, ## Reproduce
 *
 *   node ops/v2/rehearse/5-report.mjs [--publish]    out/REHEARSAL-<date>.md; --publish also writes ops/v2/REHEARSAL-<date>.md
 * ------------------------------------------------------------------------------------------------- */
import { copyFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEDGER_FILE, OUT, ROOT, SHOTS, loadState, readJson, say, setStage, usd, nyTime } from "./lib.mjs";
import { bountyRows, journal } from "./drill-kit.mjs";

setStage("5-report");
const PUBLISH = process.argv.includes("--publish");

/** Deviations from the plan's O2-03 text, kept with the harness that makes them. */
export const DEVIATIONS = [
  "Chainlink feeds: the live RHxxx/USD proxies print only on a 0.5 % move or a 24 h heartbeat and accept only signed OCR reports, so nothing on a fork can print after a warp. MockRoundFeed's runtime is etched over each proxy address the registry names (anvil_setCode), its storage continuing the proxy's real phase, round number and last 12 rounds; a rehearsal-only price operator (anvil #17) prints the rounds (market open, the settlement windows, freshness).",
  "The price operator prints a round at the answer in force before every phase that reads spot and whose last round is older than 15-25 minutes, so a warped fork never meets a spot older than the oracle's spotMaxAge. On mainnet at the fork block NVDA's round was hours old (the feeds print on a 0.5 % move or their 24 h heartbeat).",
  "Pricing: a stand-in /fair and /surface (ops/v2/rehearse/pricing-standin.mjs) prices with keeper/src/v2/pricing/bs.ts at the fork oracle's spot and fixed vols (NVDA 55 %, TSLA 65 %, META 45 %), asOf = head block time. The real pricing service needs the live Cboe chain, which cannot follow a warped clock.",
  "Detached node: the public RPC serves state only ~15 minutes behind its head, so after the deploy, funding and a warm-up transaction the fork is dumped and restarted without a fork (ops/devnet/up.sh's method); untouched slots read as zero from then on. Three empty blocks are mined before the deploy so Ponder can read V2_START_BLOCK's parent.",
  "Markets: NVDA (Chainlink + 0.05 % pool), TSLA (Chainlink + its registry 0.30 % pool, as wave1 will ship) and META (wave1, no pool in the recon: Chainlink only, no payout route). The plan's 'single-source delay on the others' is observed on META; TSLA has a pool in the registry and corroborates like NVDA (its 0.30 % route also exercises the 60 bps conversion floor).",
  "Prices: NVDA and TSLA open 3 % below their pool's price and the settlement window prints the pool's TWAP (a +3.1 % close), so the first two daily rungs finish in the money and both sources agree; META settles +3 % on Chainlink alone. The pools are not traded between the warm-up swaps and the settlements.",
  "Time: the story runs in the fork's current regular session when there is room before the first daily expiry's cutoff, otherwise it warps to 10:00 New York of the next session day; every expiry, delay (META's 6 h, the veto's 48 h, the fee change's 24 h, the pin recheck's 900 s) is reached by warp. The browser pages run on a fixed clock at the chain's time.",
  "Operator steps rehearsed by script from impersonated accounts: v2.status live in the rehearsal registry copy (DEPLOY-V2.md step 5), KeeperRewards and MakerVault funding (step 6), and in the drills the guardian's veto and mint pause, the admin's adminResolve, setFeeParams and the Chainlink source's setOracle. Wallets are funded by storage writes (fork control), not transfers.",
  "Notifier and relay: both talk to a Telegram Bot API stand-in (fake-telegram.mjs); Postgres is a throwaway local cluster. Wallets link chats through the real challenge/session/subscription/deep-link flow with /start sent through the stand-in.",
  "Web: built with NEXT_PUBLIC_V2=1 against the rehearsal registry copy (gen:markets, restored after the build), next start on 127.0.0.1:3190; the injected wallet is W2-14's BrowserWallet (anvil dev accounts only).",
  "Warps and the mm-bot: a tick planned just before a multi-hour warp simulates its places after it and refuses them (v2_mm_tx_rejected DeadlinePassed / PastCutoff warnings in the mm journal). The bot sent nothing that reverted; a real chain does not jump hours inside one tick.",
  "Drill isolation: Ponder's finality depth on chain 4663 is 30 blocks, so reverting the fork under the running indexer by more than that is unrecoverable. Drills that need only the chain, the relay and a cranker (feed-paused, sources-disagree, guardian-veto, cranker-killed, mint-paused, fee-change, pin-refused) therefore run in a sandbox: the live indexer, notifier, cranker, mm-bot and pricer are frozen with SIGSTOP, evm_snapshot, the drill starts its own cranker (anvil #8, or #11 for the second cranker; fresh SQLite journal, no INDEXER_URL, so it runs on its log index) and where needed its own MM bot (port 8591), then everything it started is stopped, evm_revert restores the fork (the block at the snapshot height is checked) and the stack is thawed. Their transaction hashes and bounties are recorded before the revert and no longer exist on the fork. The indexer-down and usdg-paused drills need the live indexer, notifier or web and run forward on the real timeline, putting back what they changed.",
  "Drill flags: a Stock Token's oraclePaused() and USDG's paused() are issuer flags nobody on a fork can call; the drills locate each in storage by flipping the bits of the slots the view reads (ops/v2/monitor-devnet.mjs's probe) and set and clear it with anvil_setStorageAt.",
  "Drill positions: writers mint to holders directly (Clearinghouse.mint from the writer) rather than through the book, except where the book is the subject (mint-paused, fee-change, cranker-killed's resale ask).",
  "pin-refused: the cranker's ladder horizon is now + 65 min, so the drill warps to 64 min before today's close to bring a daily expiry nobody pinned into it; the recovery waits out the cranker's compiled PIN_REFUSED_RECHECK_S (900 s) by warp.",
  "monitor: ops/v2/monitor.mjs --once runs against the fork with the rehearsal registry copy and its alerts go through the real relay. A baseline run adopts the history of steps 1-3; each sandbox drill runs it on a copy of that forward state before its revert; the usdg-paused drill and a final run use the forward state. Its feeds check skips the proxy and Safe checks (the etched mocks have no aggregator()).",
];

/**
 * Deviations this run made rather than every run: what the product did decides whether they are deviations at all
 * (a workaround the harness only reaches when the page needs it, the registry value the deploy actually used).
 */
function runDeviations(S, drills) {
  const out = [];
  const spotMaxAgeS = readJson(S.registryCopy ?? "", {}).v2?.defaults?.spotMaxAgeS;
  if (spotMaxAgeS && Number(spotMaxAgeS) < 86_400) {
    out.push(`spotMaxAgeS: the registry this run deployed keeps ${spotMaxAgeS} s, below the feeds' 24 h heartbeat (release blocker ops-c13). The rehearsal's printed rounds hide it; on chain 4663 a feed that prints only on its heartbeat leaves spot() stale for most of the day.`);
  }
  const cards = S.story?.cards;
  if (cards && cards.natural === false) {
    out.push(`Web cards: with NVDA's round ${Math.round(Number(cards.roundAgeS) / 60)} min old the home page offered no "Buy 0.01 share" card (“${cards.notice}”). The story printed a round, waited for the indexer and reloaded (W2-14's workaround) before the browser buyer. The feeds print on a 0.5 % move or their 24 h heartbeat, so mainnet cards would be unbuyable most of the day.`);
  }
  const down = drills["indexer-down"];
  if (down && down.natural === false) {
    out.push("indexer-down: with Ponder stopped under an open series page the ticket kept Buy disabled although the book was rebuilt on chain. Harness workaround so the on-chain-book buy is still exercised: after recording the disabled ticket, the browser alone gets the /v2/markets answer captured before the outage (Playwright route); every other indexer request keeps failing. REHEARSE_STRICT=1 makes the step fail on it.");
  }
  return out;
}

/** Not covered by this rehearsal, whatever the run. */
const NOT_COVERED = [
  "The real pricing service (Cboe chain, the model fallback) and the notifier's Web Push and email channels.",
  "Data Streams as a third source (registered with no feed ids), puts through the cranker's ladders (the registry lists none; the usdg-paused drill writes one by script).",
  "Railway, the go-live scripts, real keys and Safes; the monitor's Chainlink proxy owner / aggregator / Safe checks (etched mocks).",
  "Indexer and notifier behaviour inside the sandbox drills (frozen there): the indexer's settling -> held -> settled statuses of those expiries, fill and settlement receipts for them.",
  "A mainnet-length log history (the indexer and crankers index a few thousand fork blocks).",
];

const HOME = os.homedir();
const rel = (text) => String(text ?? "").split(ROOT).join(".").split(HOME).join("~");
const esc = (s) => rel(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
const short = (h) => (h ? `\`${h}\`` : "");
const ny = (ts) => (ts ? `${nyTime(ts)} NY` : "");

function journalSummary(db) {
  const j = journal(db);
  const byKind = new Map();
  for (const t of j.txs) {
    const k = `${t.kind}|${t.fn}|${t.status}`;
    const r = byKind.get(k) ?? { kind: t.kind, fn: t.fn, status: t.status, n: 0, gas: 0n, max: 0n };
    r.n += 1;
    if (t.gas) {
      r.gas += BigInt(t.gas);
      if (BigInt(t.gas) > r.max) r.max = BigInt(t.gas);
    }
    byKind.set(k, r);
  }
  const alerts = new Map();
  for (const a of j.alerts) alerts.set(`${a.kind} (${a.severity})`, (alerts.get(`${a.kind} (${a.severity})`) ?? 0) + 1);
  return { txs: j.txs, rows: [...byKind.values()], alerts };
}

async function main() {
  const S = loadState();
  const L = readJson(LEDGER_FILE, { entries: [] });
  const date = (S.createdAt ?? new Date().toISOString()).slice(0, 10);
  const lines = [];
  const p = (s = "") => lines.push(s);
  const checks = S.checks ?? [];
  const drills = S.drills ?? {};
  const drillIds = Object.keys(drills).filter((k) => !k.startsWith("_"));
  const stageChecks = (st) => checks.filter((x) => x.stage === st || x.stage.startsWith(`${st}/`));
  const gasByHash = new Map(L.entries.filter((e) => e.hash).map((e) => [e.hash.toLowerCase(), e.gasUsed]));
  const dbDir = path.join(OUT, "db");
  const dbs = existsSync(dbDir) ? readdirSync(dbDir).filter((f) => f.endsWith(".db")).sort((a, b) => (a.startsWith("drill-") - b.startsWith("drill-")) || a.localeCompare(b)) : [];
  for (const file of dbs) for (const t of journal(path.join(dbDir, file)).txs) if (t.hash && t.gas) gasByHash.set(t.hash.toLowerCase(), t.gas);
  const alertText = (text) => esc(text).replace(/^\S+\s+/u, "").split(" chain 4663")[0].slice(0, 300);
  const named = new Map(Object.entries({ ...(S.accounts ?? {}), autoRoller: S.contracts?.autoRoller, makerVault: S.contracts?.makerVault, clearinghouse: S.contracts?.clearinghouse }).filter(([, v]) => v).map(([k, v]) => [v.toLowerCase(), k]));
  const keeperName = (a) => `\`${a.slice(0, 10)}\`${named.has(a.toLowerCase()) ? ` (${named.get(a.toLowerCase())})` : ""}`;
  const shots = existsSync(SHOTS) ? readdirSync(SHOTS).filter((f) => f.endsWith(".png")).sort() : [];

  /* ---------------------------------------------------------------- title and result */
  p(`# Stonkhouse v2 fork rehearsal — ${date} (O2-03)`);
  p();
  p("Generated by `ops/v2/rehearse/5-report.mjs` from `ops/v2/rehearse/out/` (state.json, ledger.json, the bots' journals, the monitor reports). Every transaction hash below is on the local anvil fork of chain 4663, never on mainnet; the hashes of sandbox drills were recorded before the fork was reverted and no longer exist on it.");
  p();
  p("## Result");
  p();
  p("| step | result | assertions |");
  p("|---|---|---|");
  for (const st of ["1-fork", "2-services", "3-story"]) {
    const c = stageChecks(st);
    p(`| ${st} | ${c.length === 0 ? "not run" : c.some((x) => !x.ok) ? "**FAILED**" : "passed"} | ${c.length} |`);
  }
  const sum = drills._summary;
  const c4 = stageChecks("4-drills");
  p(`| 4-drills | ${sum ? `${sum.passed} passed, ${sum.issue} passed with a product issue, ${sum.failed} failed, ${sum.skipped} skipped${sum.notRun ? `, ${sum.notRun} not run` : ""} (${sum.seconds} s)` : "not run"} | ${c4.length} |`);
  p(`| 5-report | this file | |`);
  if (drillIds.length) {
    p();
    p("| drill | mode | result | seconds | relay alerts | monitor kinds paged |");
    p("|---|---|---|---|---|---|");
    for (const id of drillIds) {
      const d = drills[id];
      const alerts = [...new Set((d.alerts ?? []).map((a) => a.kind))].join(", ");
      const mon = [...new Set((d.monitor ?? []).map((m) => m.kind))].join(", ");
      p(`| [${id}](#drill-${id}) | ${d.mode ?? ""} | ${d.status === "failed" ? "**FAILED**" : d.status === "issue" ? "**issue** (product defect reported)" : d.status} | ${d.seconds ?? ""} | ${alerts} | ${mon} |`);
    }
  }

  /* ---------------------------------------------------------------- run */
  p();
  p("## Run");
  p();
  p(`- fork block **${S.forkBlock ?? "?"}** (${S.forkTs ? ny(S.forkTs) : "?"}), public RPC read once; detached after ${S.forkSeconds ?? "?"} s of the ~900 s window; deploy block ${S.deployBlock ?? "?"}`);
  p(`- callhouse-contracts \`${S.contractsHead ?? "?"}\` at \`${rel(S.contractsDir)}\`; registry \`ops/markets/tier1.json\` sha256 \`${S.registrySha ?? "?"}\` (unchanged; the batch wrote back to \`out/tier1.rehearsal.json\`)`);
  p(`- VerifyV2: **${S.verifyChecks ?? "?"} checks passed** (--expect-fresh true); info lines: ${(S.verifyInfo ?? []).map((l) => `\`${l.replace(/^info\s+/, "")}\``).join("; ") || "none"}`);
  if (S.contracts) p(`- contracts: ${Object.entries(S.contracts).filter(([k]) => k !== "sources").map(([k, v]) => `${k} \`${v}\``).join(", ")}; sources ${Object.entries(S.contracts.sources).map(([k, v]) => `${k} \`${v}\``).join(", ")}`);
  if (S.markets) for (const m of Object.values(S.markets)) p(`- ${m.ticker}: asset \`${m.asset}\`, feed \`${m.feed}\`, pool ${m.pool ? `\`${m.pool}\` (fee ${m.poolFee})` : "none"}, registerTx \`${m.registerTx}\``);
  if (S.admin) p(`- impersonated on the fork: admin \`${S.admin}\`, guardian \`${S.guardian}\`; bots anvil #8 cranker, #9 pricer, #10 MM quoter, #11 second cranker (drill)`);

  /* ---------------------------------------------------------------- steps 1-3 */
  p();
  p("## Steps 1-3: assertions");
  for (const st of ["1-fork", "2-services", "3-story"]) {
    const c = stageChecks(st);
    if (!c.length) continue;
    p();
    p(`### ${st}`);
    p();
    for (const x of c) p(`- ${x.ok ? "ok" : "**FAIL**"} ${esc(x.message)}`);
  }

  /* ---------------------------------------------------------------- step 4 */
  p();
  p("## Step 4: failure drills");
  p();
  p("`sandbox` drills run on an evm_snapshot of the post-story fork with the live indexer, notifier, cranker, mm-bot and pricer frozen, their own cranker (and MM bot) started for the drill, then the fork is reverted and the stack thawed, so each starts from the same state. `forward` drills run on the real timeline with the live stack. See Deviations for why.");
  const base = stageChecks("4-drills/monitor").filter((x) => /baseline/.test(x.message));
  if (base.length) {
    p();
    p("Monitor baseline (before the drills):");
    p();
    for (const x of base) p(`- ${x.ok ? "ok" : "**FAIL**"} ${esc(x.message)}`);
  }
  for (const id of drillIds) {
    const d = drills[id];
    p();
    p(`<a id="drill-${id}"></a>`);
    p(`### ${id}: ${esc(d.title)}`);
    p();
    p(`Mode **${d.mode ?? "?"}**, result **${d.status}**${d.seconds !== undefined ? `, ${d.seconds} s` : ""}${d.expiry ? `, drill expiry ${d.expiry} (${ny(d.expiry)})` : ""}.`);
    if (d.error) {
      p();
      p(`Error: ${esc(d.error).slice(0, 1500)}`);
    }
    const c = checks.filter((x) => x.stage === `4-drills/${id}` && !(id === "monitor" && /baseline/.test(x.message)));
    if (c.length) {
      p();
      for (const x of c) p(`- ${x.ok ? "ok" : "**FAIL**"} ${esc(x.message)}`);
    }
    if (d.txs?.length) {
      p();
      p("| key transaction | tx | gas |");
      p("|---|---|---|");
      for (const t of d.txs) p(`| ${esc(t.what)} | ${short(t.hash)} | ${t.gas ?? gasByHash.get(t.hash?.toLowerCase()) ?? ""} |`);
    }
    for (const [label, bot] of [["drill cranker", d.cranker], ["cranker A", d.crankerA], ["cranker B", d.crankerB], ["drill MM bot", d.mm]]) {
      if (!bot) continue;
      const kinds = new Map();
      for (const t of bot.txs) kinds.set(`${t.kind} ${t.status}`, (kinds.get(`${t.kind} ${t.status}`) ?? 0) + 1);
      p();
      p(`${label} journal: ${[...kinds].map(([k, n]) => `${k} ×${n}`).join(", ") || "no transactions"}; alerts: ${[...new Set(bot.alerts.map((a) => a.kind))].join(", ") || "none"}`);
    }
    if (d.alerts?.length) {
      p();
      for (const a of d.alerts) p(`- relay → Telegram stand-in \`${a.kind}\`: ${alertText(a.text)}`);
    }
    if (d.monitor?.length) {
      p();
      for (const m of d.monitor) p(`- monitor.mjs --once \`${m.kind}\` (${m.severity}): ${esc(m.message).slice(0, 300)}`);
    }
    if (d.kinds) {
      p();
      p(`Monitor kinds paged per drill: ${Object.entries(d.kinds).map(([k, v]) => `${k}: ${[...new Set(v)].join(" + ")}`).join("; ")}. Final forward run: exit ${d.final?.code}, open findings: ${d.final?.findings?.join(", ") || "none"}.`);
    }
    for (const i of d.issues ?? []) {
      p();
      p(`**Issue** (${esc(i.lane)}, reported ${esc(i.reported)}): ${esc(i.text)}`);
    }
    for (const n of d.notes ?? []) {
      p();
      p(`Note: ${esc(n)}`);
    }
    for (const n of d.notCovered ?? []) {
      p();
      p(`Not covered here: ${esc(n)}`);
    }
    if (d.screenshots?.length) {
      p();
      p(`Screenshots: ${d.screenshots.map((f) => `[${f}](rehearse/out/screenshots/${f})`).join(", ")}`);
    }
  }

  /* ---------------------------------------------------------------- transactions */
  p();
  p("## Transactions");
  const stepOf = (e) => String(e.step).replace(/\/.*/, "");
  const steps = [...new Set(L.entries.map(stepOf))];
  for (const st of steps) {
    const entries = L.entries.filter((e) => stepOf(e) === st);
    const txs = entries.filter((e) => e.hash);
    p();
    p(`### ${st} (${txs.length} transaction${txs.length === 1 ? "" : "s"})`);
    p();
    if (txs.length) {
      const drillCol = txs.some((e) => e.drill);
      p(`| ${drillCol ? "drill | " : ""}action | label | from | tx | gas | status |`);
      p(`|${drillCol ? "---|" : ""}---|---|---|---|---|---|`);
      for (const e of txs) p(`| ${drillCol ? `${e.drill ?? ""}${e.sandbox ? " (sandbox)" : ""} | ` : ""}${esc(e.action)} | ${esc(e.label)} | ${e.from ? `\`${e.from.slice(0, 10)}\`` : ""} | \`${e.hash}\` | ${e.gasUsed ?? ""} | ${e.status} |`);
    }
    const control = entries.filter((e) => !e.hash);
    if (control.length) {
      p();
      p(`Fork control (no transaction, ${control.length}): ${control.map((e) => `${e.drill ? `[${e.drill}] ` : ""}${esc(e.label)}`).join("; ")}`);
    }
  }

  /* ---------------------------------------------------------------- bots */
  p();
  p("## Bots");
  const journals = {};
  for (const file of dbs) {
    const name = file.replace(/\.db$/, "");
    const j = journalSummary(path.join(dbDir, file));
    journals[name] = j;
    p();
    p(`### ${name}${name.startsWith("drill-") ? " (sandbox drill, reverted)" : " (live)"}`);
    p();
    if (!j.rows.length) {
      p("no transactions");
    } else {
      p("| kind | function | status | count | gas total | gas max |");
      p("|---|---|---|---|---|---|");
      for (const r of j.rows) p(`| ${r.kind} | ${r.fn} | ${r.status} | ${r.n} | ${r.gas || ""} | ${r.max || ""} |`);
    }
    p();
    p(`alerts: ${[...j.alerts].map(([k, n]) => `${k} ×${n}`).join(", ") || "none"}`);
    p();
    p(`transactions: ${j.txs.filter((t) => t.hash).map((t) => `${t.kind} \`${t.hash}\``).join(", ") || "none"}`);
  }

  /* ---------------------------------------------------------------- gas */
  p();
  p("## Gas per action");
  p();
  p("Successful transactions only. `script` = sent by the rehearsal scripts or the browser wallet (ledger); `bot` = the live bots' journals; `drill bot` = the drill-local bots (sandbox).");
  p();
  const gas = new Map();
  const add = (source, action, g) => {
    if (g === null || g === undefined || g === "") return;
    const k = `${source}|${action}`;
    const r = gas.get(k) ?? { source, action, n: 0, total: 0n, max: 0n, min: null };
    const v = BigInt(g);
    r.n += 1;
    r.total += v;
    if (v > r.max) r.max = v;
    if (r.min === null || v < r.min) r.min = v;
    gas.set(k, r);
  };
  for (const e of L.entries.filter((x) => x.hash && x.status === "success")) add("script", `${e.step.replace(/\/.*/, "")} ${e.action}`, e.gasUsed);
  for (const [name, j] of Object.entries(journals)) {
    const drill = name.startsWith("drill-");
    const bot = drill ? (/mm$/.test(name) ? "mm" : "cranker") : name;
    for (const t of j.txs) if (["success", "confirmed"].includes(t.status)) add(drill ? "drill bot" : "bot", `${bot} ${t.kind}`, t.gas);
  }
  p("| source | action | count | mean gas | min | max |");
  p("|---|---|---|---|---|---|");
  for (const r of [...gas.values()].sort((a, b) => a.source.localeCompare(b.source) || a.action.localeCompare(b.action))) p(`| ${r.source} | ${r.action} | ${r.n} | ${r.total / BigInt(r.n)} | ${r.min} | ${r.max} |`);

  /* ---------------------------------------------------------------- bounties */
  p();
  p("## Bounty spend per expiry");
  p();
  p("KeeperRewards `Rewarded` logs attributed to (underlying, expiry) by decoding the paying transaction (USDG). Bounty table at deploy: SNAPSHOT / FINALIZE / SETTLE / REDEEM / ROLL. A keeper shown as `autoRoller` is a settle or redeem inside AutoRoller.roll's close-out: the roller forwards that USDG to the caller of the roll.");
  p();
  p("### On the fork (steps 1-3 and the forward drills)");
  p();
  try {
    const rows = S.contracts ? await bountyRows(S.deployBlock) : [];
    p("| underlying expiry | total USDG | by action | keepers |");
    p("|---|---|---|---|");
    for (const r of rows) p(`| ${r.key}${/^\w+ \d+$/.test(r.key) ? ` (${ny(Number(r.key.split(" ")[1]))})` : ""} | ${usd(r.total)} | ${Object.entries(r.byAction).map(([a, v]) => `${a} ${usd(v)}`).join(", ")} | ${r.keepers.map(keeperName).join(", ")} |`);
    const expiries = rows.filter((r) => /^\w+ \d+$/.test(r.key));
    if (expiries.length) p(`\n${expiries.length} (underlying, expiry) pairs paid ${usd(expiries.reduce((a, r) => a + r.total, 0n))} USDG: ${usd(expiries.reduce((a, r) => a + r.total, 0n) / BigInt(expiries.length))} per pair on average; rolls ${usd(rows.filter((r) => / roll$/.test(r.key)).reduce((a, r) => a + r.total, 0n))}.`);
  } catch (error) {
    p(`not available: ${error.message}`);
  }
  const sb = S.sandboxBounties ?? {};
  if (Object.keys(sb).length) {
    p();
    p("### Inside the sandbox drills (read before each revert)");
    p();
    p("| drill | underlying expiry | total USDG | by action | keepers |");
    p("|---|---|---|---|---|");
    for (const [id, rows] of Object.entries(sb)) {
      if (!rows.length) p(`| ${id} | none | 0.00 | | |`);
      for (const r of rows) p(`| ${id} | ${r.key}${/^\w+ \d+$/.test(r.key) ? ` (${ny(Number(r.key.split(" ")[1]))})` : ""} | ${usd(r.total)} | ${Object.entries(r.byAction).map(([a, v]) => `${a} ${usd(v)}`).join(", ")} | ${r.keepers.map(keeperName).join(", ")} |`);
    }
  }

  /* ---------------------------------------------------------------- screenshots */
  p();
  p("## Screenshots");
  p();
  p("Local artifacts of the run (gitignored, about 6 MB), linked relative to this file:");
  p();
  for (const f of shots) p(`- [${f}](rehearse/out/screenshots/${f})`);
  if (!shots.length) p("none (--skip-web, or the browser flows did not run)");

  /* ---------------------------------------------------------------- deviations, not covered */
  p();
  p("## Deviations from the plan");
  p();
  for (const d of [...DEVIATIONS, ...runDeviations(S, drills)]) p(`- ${d}`);
  const issues = drillIds.flatMap((id) => (drills[id].issues ?? []).map((i) => ({ id, ...i })));
  if (issues.length) {
    p();
    p("Product issues the drills found (reported to their lane):");
    p();
    for (const i of issues) p(`- ${i.id} [${esc(i.lane)}, ${esc(i.reported)}]: ${esc(i.text)}`);
  }
  p();
  p("## Not covered");
  p();
  for (const n of NOT_COVERED) p(`- ${n}`);
  for (const id of drillIds) {
    const d = drills[id];
    if (d.status === "skipped") p(`- drill ${id}: skipped (${(d.notes ?? []).join("; ")})`);
    if (d.status === "failed" || d.status === "not-run") p(`- drill ${id}: ${d.status} (${esc(d.error ?? "").slice(0, 200)})`);
    for (const n of d.notCovered ?? []) p(`- ${id}: ${esc(n)}`);
  }
  p();
  p("## Reproduce");
  p();
  p("```bash");
  p("# a built callhouse-contracts checkout on v2; foundry, jq, Postgres binaries, Playwright Chromium");
  p("CONTRACTS_DIR=../callhouse-contracts ops/v2/rehearse.sh             # steps 1-5, stops everything on exit");
  p("CONTRACTS_DIR=../callhouse-contracts ops/v2/rehearse.sh --keep      # leave the stack up; then --only 4 re-runs the drills");
  p("node ops/v2/rehearse/4-drills.mjs --only feed-paused,fee-change     # sandbox drills can be re-run against a kept stack");
  p("REHEARSE_STRICT=1 ops/v2/rehearse.sh                                # a drill `issue` fails step 4");
  p("```");
  p();

  const file = path.join(OUT, `REHEARSAL-${date}.md`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  say(`report: ${rel(file)} (${lines.length} lines)`);
  if (PUBLISH) {
    const dest = path.join(ROOT, "ops", "v2", `REHEARSAL-${date}.md`);
    copyFileSync(file, dest);
    say(`published: ${rel(dest)}`);
  }
  say(`\nSTEP 5 DONE: report written (${drillIds.length} drills, ${L.entries.filter((e) => e.hash).length} transactions)`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`\nSTEP 5 FAILED: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
}
