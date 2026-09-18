/* -------------------------------------------------------------------------------------------------
 * ops/v2/rehearse/drill-kit.mjs — what the O2-03 failure drills (4-drills.mjs) share.
 *
 *   sandbox(id, fn)        an isolated scenario on a snapshot of the fork: the live stack's chain-following services
 *                          (indexer, notifier, cranker, mm-bot, pricer) are frozen with SIGSTOP, evm_snapshot, the drill
 *                          runs with drill-local processes (a cranker with its own key, port and journal), every drill
 *                          process is stopped, evm_revert, the block at the snapshot height is checked, the stack thawed.
 *                          The services never see a sandbox block: Ponder's finality depth on chain 4663 is 30 blocks,
 *                          so a deeper revert under a running indexer would be unrecoverable.
 *   flags                  a Stock Token's oraclePaused() and USDG's paused() located in storage by probing the slots
 *                          the view reads (ops/v2/monitor-devnet.mjs's method), then set and cleared by storage writes
 *   positions              writeCall/writePut: a writer deposits collateral and mints to a holder (createSeries first
 *                          when the series does not exist)
 *   expiry                 printWindow (the settlement window's rounds), waits for the cranker's snapshot / finalize
 *   evidence               Telegram stand-in messages after a mark, a bot journal's transactions and alerts, contract
 *                          events since the sandbox's snapshot block
 *   monitor                ops/v2/monitor.mjs --once --json against the fork, alerts through the rehearsal relay
 * ------------------------------------------------------------------------------------------------- */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  ABI, OUT, PORTS, PROXY_SLOTS, RELAY_URL, ROOT, RPC, RehearsalError, TELEGRAM_URL, accountOf, contracts, encodeFunctionData, patchState, expect, fail, getAddress, getJson, impersonate,
  info, ledgerAppend, loadState, markets, now, pad, parseAbi, pub, pushRound, read, rpc, say, send, setLedgerTag, signalService, sleep, stopService, toHex, until, usd, viem, warpTo,
} from "./lib.mjs";
import { loadSecrets, startBot } from "./stack.mjs";

const Database = createRequire(path.join(ROOT, "keeper", "package.json"))("better-sqlite3");

export const E18 = 10n ** 18n;
export const E6 = 10n ** 6n;
export const RELAY_BOT = "4663001";
export const NOTIFIER_BOT = "4663002";
export const MONITOR_DIR = path.join(OUT, "monitor");
/** The monitor state that forward runs (not sandboxes) carry from one run to the next. */
export const MONITOR_STATE = path.join(MONITOR_DIR, "forward.state.json");
/** SettlementStatus. */
export const STATUS = { None: 0, Pending: 1, Finalized: 2, Held: 3 };
/** Frozen for the length of a sandbox: everything that follows the chain on its own. */
export const FROZEN_IN_SANDBOX = ["indexer", "notifier", "cranker", "mm-bot", "pricer"];
/** Extra drill process ports inside the reservation (anvil 8590-8594: 8590 is the node, 8591-8594 are free). */
export const DRILL_PORTS = { cranker: PORTS.cranker2, mm: 8591 };

/* ---------------------------------------------------------------------------------------------- */
/*  the sandbox                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

async function pendingTxs() {
  try {
    const s = await rpc("txpool_status");
    return Number(s.pending ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Run `fn(box)` on an evm_snapshot of the fork with the live stack frozen; always stop the drill's processes, revert and
 * thaw. `box.startCranker({ name, keyRole })` / `box.startMm()` start drill-local bots stopped at the end.
 */
export async function sandbox(id, fn) {
  const S = loadState();
  const frozen = [];
  for (const name of FROZEN_IN_SANDBOX) if (signalService(name, "SIGSTOP")) frozen.push(name);
  let result;
  let error = null;
  let snapshotId = null;
  let head = null;
  const started = [];
  try {
    // A transaction a live bot broadcast just before the freeze is mined before the snapshot, not inside it.
    await until("the live bots' pending transactions mined", async () => (await pendingTxs()) === 0, { timeoutMs: 20_000, intervalMs: 500 });
    await sleep(1_200);
    head = await pub.getBlock({ blockTag: "latest" });
    snapshotId = await rpc("evm_snapshot");
    ledgerAppend([{ step: `4-drills`, drill: id, action: "evm_snapshot", label: `evm_snapshot ${snapshotId} at block ${head.number} (${frozen.join(", ")} frozen)`, from: null, to: null, hash: null, status: "fork-control", gasUsed: "0", block: Number(head.number), ts: Number(head.timestamp) }]);
    info(`sandbox ${id}: evm_snapshot ${snapshotId} at block ${head.number}; frozen: ${frozen.join(", ") || "none"}`);
    setLedgerTag({ drill: id, sandbox: true });
    const secrets = loadSecrets();
    const box = {
      id,
      head,
      fromBlock: head.number,
      started,
      async startCranker({ name = `drill-${id}-cranker`, keyRole = "cranker", port = DRILL_PORTS.cranker, extra = {} } = {}) {
        started.push(name);
        const r = await startBot(S, secrets, { name, mode: "cranker", port, keyRole, indexer: false, extra });
        info(`${name}: cranker with anvil #${keyRole === "cranker" ? 8 : 11} (${accountOf(keyRole)}) on ${port}, journal ${path.relative(ROOT, r.db)}, no indexer (log index only)`);
        return { name, db: r.db, port };
      },
      async startMm({ name = `drill-${id}-mm`, port = DRILL_PORTS.mm } = {}) {
        started.push(name);
        const r = await startBot(S, secrets, { name, mode: "mm", port, keyRole: "mmQuoter", indexer: false });
        info(`${name}: mm-bot (quoter anvil #10) on ${port}, journal ${path.relative(ROOT, r.db)}`);
        return { name, db: r.db, port };
      },
    };
    result = await fn(box);
  } catch (e) {
    error = e;
  } finally {
    for (const name of [...started].reverse()) await stopService(name);
    setLedgerTag({ drill: id });
    if (snapshotId !== null) {
      // The fork forgets the sandbox: keep what its keepers were paid before reverting.
      try {
        const rows = await bountyRows(head.number + 1n);
        const s = loadState();
        patchState({ sandboxBounties: { ...(s.sandboxBounties ?? {}), [id]: rows.map((r) => ({ key: r.key, total: r.total.toString(), byAction: Object.fromEntries(Object.entries(r.byAction).map(([k, v]) => [k, v.toString()])), keepers: r.keepers })) } });
      } catch (e) {
        info(`sandbox ${id}: bounty read failed (${e.message})`);
      }
    }
    let revertOk = snapshotId === null;
    if (snapshotId !== null) {
      const reverted = await rpc("evm_revert", [snapshotId]).catch((e) => `error ${e.message}`);
      const back = await pub.getBlock({ blockNumber: head.number }).catch(() => null);
      revertOk = reverted === true && back?.hash === head.hash;
      const after = await pub.getBlock({ blockTag: "latest" });
      ledgerAppend([{ step: "4-drills", drill: id, action: "evm_revert", label: `evm_revert ${snapshotId}: ${reverted === true ? "ok" : reverted}; head ${after.number} at ${after.timestamp}, block ${head.number} hash ${revertOk ? "unchanged" : "CHANGED"}`, from: null, to: null, hash: null, status: "fork-control", gasUsed: "0", block: Number(after.number), ts: Number(after.timestamp) }]);
      info(`sandbox ${id}: evm_revert ${reverted === true ? "ok" : reverted}; head back at ${after.number} (${after.timestamp})`);
      const S2 = loadState();
      if (S2.admin) await impersonate(S2.admin);
      if (S2.guardian) await impersonate(S2.guardian);
    }
    for (const name of frozen) signalService(name, "SIGCONT");
    if (!revertOk) {
      // eslint-disable-next-line no-unsafe-finally
      throw new FatalDrillError(`sandbox ${id}: evm_revert failed; the fork no longer matches what the live services indexed`);
    }
  }
  if (error) throw error;
  return result;
}
export class FatalDrillError extends RehearsalError {}

/* ---------------------------------------------------------------------------------------------- */
/*  storage flags                                                                                  */
/* ---------------------------------------------------------------------------------------------- */

const flagCache = new Map();

/**
 * The storage slot and bit behind a bool view (`fn()` with `args`) of `address`, found by flipping each bit of the slots
 * the view reads until it answers true; every probe write is restored. Cached per (address, fn).
 */
export async function locateFlag(address, fn, args = []) {
  const key = `${address.toLowerCase()}:${fn}`;
  if (flagCache.has(key)) return flagCache.get(key);
  const abi = parseAbi([`function ${fn}(${args.map(() => "address").join(",")}) view returns (bool)`]);
  const readFlag = () => read(address, abi, fn, args);
  if ((await readFlag()) !== false) fail(`${fn}() of ${address} is not false before the probe`);
  const data = encodeFunctionData({ abi, functionName: fn, args });
  const { accessList } = await rpc("eth_createAccessList", [{ to: address, data }, "latest"]);
  const slots = accessList.filter((x) => getAddress(x.address) === getAddress(address)).flatMap((x) => x.storageKeys).filter((k) => !PROXY_SLOTS.has(k.toLowerCase())).reverse();
  const bits = [0, ...Array.from({ length: 96 }, (_, i) => 160 + i), ...Array.from({ length: 159 }, (_, i) => 1 + i)];
  for (const slot of slots) {
    const original = BigInt((await rpc("eth_getStorageAt", [address, slot, "latest"])) ?? "0x0");
    for (const bit of bits) {
      await rpc("anvil_setStorageAt", [address, slot, pad(toHex(original ^ (1n << BigInt(bit))), { size: 32 })]);
      let got;
      try {
        got = await readFlag();
      } catch {
        got = undefined;
      }
      await rpc("anvil_setStorageAt", [address, slot, pad(toHex(original), { size: 32 })]);
      if (got === true) {
        const found = { address, fn, args, slot, bit, readFlag };
        flagCache.set(key, found);
        return found;
      }
    }
  }
  return fail(`could not locate ${fn}() of ${address} in storage`);
}

/** Set a located flag on or off by one storage bit (fork control, in the ledger) and check the view follows. */
export async function setFlag(flag, on, label) {
  const word = BigInt((await rpc("eth_getStorageAt", [flag.address, flag.slot, "latest"])) ?? "0x0");
  const mask = 1n << BigInt(flag.bit);
  await rpc("anvil_setStorageAt", [flag.address, flag.slot, pad(toHex(on ? word | mask : word & ~mask), { size: 32 })]);
  const got = await flag.readFlag();
  if (got !== on) fail(`${label}: ${flag.fn}() reads ${got} after the storage write`);
  ledgerAppend([{ step: "4-drills", action: "set-flag", label: `${label}: ${flag.fn}() ${on} (storage slot ${flag.slot.slice(0, 10)}… bit ${flag.bit})`, from: null, to: getAddress(flag.address), hash: null, status: "fork-control", gasUsed: "0", block: Number(await pub.getBlockNumber()), ts: await now() }]);
}

/** Custom errors of the chain's own tokens, which have no ABI here (a revert reads as "custom error <selector>"). */
const KNOWN_ERRORS = { "0xab35696f": "ContractPaused()" };
/** A revert reason with a known third-party selector named. */
export const describeRevert = (text) => String(text).replace(/custom error (0x[0-9a-f]{8})/i, (m, sel) => (KNOWN_ERRORS[sel.toLowerCase()] ? `${KNOWN_ERRORS[sel.toLowerCase()]} (${sel})` : m));

/* ---------------------------------------------------------------------------------------------- */
/*  reads                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

export const ch = (fn, args = []) => read(contracts().clearinghouse, ABI.clearinghouse, fn, args);
export const ob = (fn, args = []) => read(contracts().orderBook, ABI.orderBook, fn, args);
export const oracle = (fn, args = []) => read(contracts().settlementOracle, ABI.oracle, fn, args);
export const cal = (fn, args = []) => read(contracts().expiryCalendar, ABI.calendar, fn, args);
export const bal = (token, who) => read(token, ABI.erc20, "balanceOf", [who]);
export const statusOf = async (T, E) => Number((await oracle("settlementInfo", [markets()[T].asset, E]))[0]);

/** Spot (6 dp) through the oracle, or null when not ok. */
export async function spot6(T) {
  const [ok, p] = await oracle("trySpot", [markets()[T].asset]);
  return ok ? p : null;
}
/** The etched feed's latest answer (8 dp). */
export async function answer8(T) {
  return (await read(markets()[T].feed, ABI.mockFeed, "latestRoundData"))[1];
}
/** The pool's 5-minute TWAP now, as an 8-dp feed answer. */
export async function poolTwap8(T) {
  const [ok, p] = await read(contracts().sources.univ3, ABI.univ3, "latest", [markets()[T].asset]);
  if (!ok) fail(`${T} pool TWAP not ok`);
  return p * 100n;
}
export function strikeBelow(T, price6, bps = 0n) {
  const tick = BigInt(markets()[T].strikeTick);
  return ((price6 * (10_000n - bps)) / 10_000n / tick) * tick;
}
export function strikeAbove(T, price6, bps = 0n) {
  const tick = BigInt(markets()[T].strikeTick);
  return (((price6 * (10_000n + bps)) / 10_000n + tick - 1n) / tick) * tick;
}

/** The next daily expiry at least `leadS` after now. */
export async function nextDaily(leadS = 3_900) {
  return Number(await cal("nextExpiry", [BigInt((await now()) + leadS), false]));
}

/** The price operator prints a round at the current answer on every feed whose last round is older than `maxAgeS`. */
export async function refreshFeeds(label, maxAgeS = 900) {
  const t = await now();
  for (const [T, m] of Object.entries(markets())) {
    const [, answer, , updatedAt] = await read(m.feed, ABI.mockFeed, "latestRoundData");
    if (t - Number(updatedAt) > maxAgeS) await pushRound(m.feed, answer, t, `${T} ${label} (same answer)`);
  }
}

/* ---------------------------------------------------------------------------------------------- */
/*  positions                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

/**
 * `writer` deposits the collateral of `units` and mints them to `holder` (writer keeps the shorts). createSeries first
 * when the series does not exist yet (it pins the expiry when it is the first). Returns the long id.
 */
export async function writeTo({ writer, holder, T, isPut = false, strike, expiry, units, label }) {
  const C = contracts();
  const M = markets();
  const S = loadState();
  const who = accountOf(writer);
  const to = accountOf(holder);
  const longId = await ch("longIdOf", [M[T].asset, isPut, strike, expiry]);
  if (!(await ch("seriesExists", [longId]))) {
    await send(who, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "createSeries", args: [M[T].asset, isPut, strike, expiry], label: `${writer} createSeries ${T} ${isPut ? "put" : "call"} ${usd(strike)} ${expiry}`, action: "createSeries" });
  }
  const per = await ch("collateralPerUnit", [longId]);
  const need = per * units;
  const asset = isPut ? S.usdg : M[T].asset;
  await send(who, { address: asset, abi: ABI.erc20, functionName: "approve", args: [C.clearinghouse, need], label: `${writer} approve ${isPut ? "USDG" : T} for ${label}`, action: "approve" });
  await send(who, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "deposit", args: [asset, need, who], label: `${writer} deposit for ${label}`, action: "deposit" });
  const r = await send(who, { address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "mint", args: [longId, units, who, to], label: `${writer} mints ${units} units to ${holder}: ${label}`, action: "mint" });
  expect((await ch("balanceOf", [to, longId])) >= units, `${label}: ${holder} holds ${units} units of ${T} ${usd(strike)} ${isPut ? "put" : "call"} ${expiry} written by ${writer} (tx ${r.hash})`);
  return longId;
}

/* ---------------------------------------------------------------------------------------------- */
/*  expiry                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Warp one minute before `E` and print the settlement window's rounds on every feed: `answers[T]` (8 dp), default the
 * pool's TWAP for a pool market and the current answer otherwise. Returns the answers.
 */
export async function printWindow(E, answers = {}) {
  const M = markets();
  const out = {};
  for (const T of Object.keys(M)) out[T] = answers[T] ?? (M[T].pool ? await poolTwap8(T) : await answer8(T));
  const t = await warpTo(E - 60, "one minute before the drill expiry: the settlement window's rounds");
  for (const T of Object.keys(M)) {
    await pushRound(M[T].feed, out[T], E - 2100, `${T} window start ${usd(out[T] / 100n)}`);
    await pushRound(M[T].feed, out[T], E - 900, `${T} inside the window`);
    await pushRound(M[T].feed, out[T], t, `${T} one minute before expiry`);
  }
  return out;
}

/** The pool snapshot of (T, E) recorded (the log), waiting for the cranker. */
export async function waitRecorded(T, E, fromBlock, service, timeoutMs = 120_000) {
  return until(`${T} ${E} pool snapshot`, async () => {
    const logs = await pub.getContractEvents({ address: contracts().sources.univ3, abi: ABI.univ3, eventName: "Recorded", args: { underlying: markets()[T].asset, expiry: E }, fromBlock });
    return logs[0] ?? null;
  }, { timeoutMs, intervalMs: 1_000, service });
}

export async function events(address, abi, eventName, args, fromBlock) {
  return pub.getContractEvents({ address, abi, eventName, args, fromBlock });
}

export async function txFrom(hash) {
  return getAddress((await pub.getTransaction({ hash })).from);
}

/* ---------------------------------------------------------------------------------------------- */
/*  evidence                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

export const telegramMessages = () => getJson(`${TELEGRAM_URL}/_control/messages`);
export async function telegramMark() {
  const all = await telegramMessages();
  return all.length === 0 ? 0 : all.at(-1).n;
}
/** The first relay message after `mark` whose text names `kind` (and matches `re`), waiting for it. */
export async function waitRelayAlert(mark, kind, { re = null, timeoutMs = 90_000, service } = {}) {
  return until(`relay alert ${kind}${re ? ` ${re}` : ""}`, async () => (await telegramMessages()).find((m) => m.n > mark && m.bot === RELAY_BOT && m.text.includes(kind) && (re === null || re.test(m.text))) ?? null, { timeoutMs, intervalMs: 1_000, service });
}
export async function relayAlertsSince(mark) {
  return (await telegramMessages()).filter((m) => m.n > mark && m.bot === RELAY_BOT);
}
export const alertKind = (text) => /\b(v2_[a-z0-9_]+)/.exec(text)?.[1] ?? "?";

/** A bot journal's transactions and alerts (read-only; the bot may still run). */
export function journal(db) {
  if (!existsSync(db)) return { txs: [], alerts: [] };
  const d = new Database(db, { readonly: true, fileMustExist: true });
  try {
    return {
      txs: d.prepare("SELECT kind, tx_key AS key, hash, function_name AS fn, status, gas_used AS gas, block_number AS block, created_at AS at FROM v2_txs ORDER BY created_at").all(),
      alerts: d.prepare("SELECT kind, severity, message, delivered, created_at AS at FROM v2_alerts ORDER BY id").all(),
    };
  } finally {
    d.close();
  }
}

/**
 * KeeperRewards Rewarded logs from `fromBlock`, attributed to (underlying, expiry) by decoding the transaction that paid
 * them (a direct oracle / Clearinghouse / AutoRoller call, or one inside a Multicall3 batch). Amounts in USDG base units.
 */
export async function bountyRows(fromBlock) {
  const S = loadState();
  const C = S.contracts;
  const rewards = await pub.getContractEvents({ address: C.keeperRewards, abi: ABI.keeperRewards, eventName: "Rewarded", fromBlock: BigInt(fromBlock) });
  const actionName = Object.fromEntries(["SNAPSHOT", "FINALIZE", "SETTLE", "REDEEM", "ROLL"].map((a) => [viem.keccak256(viem.toHex(a)), a]));
  const tickerOf = Object.fromEntries(Object.values(S.markets).map((m) => [m.asset.toLowerCase(), m.ticker]));
  const rows = new Map();
  const tryDecode = async (to, data) => {
    for (const [addr, abi] of [[C.settlementOracle, ABI.oracle], [C.clearinghouse, ABI.clearinghouse], [C.autoRoller, ABI.autoRoller]]) {
      if (getAddress(to) !== getAddress(addr)) continue;
      const { functionName, args } = viem.decodeFunctionData({ abi, data });
      if (["snapshot", "finalize"].includes(functionName)) return `${tickerOf[args[0].toLowerCase()]} ${args[1]}`;
      if (["settle", "redeem", "redeemBatch"].includes(functionName)) {
        const s = await pub.readContract({ address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "series", args: [args[0] & ~1n] });
        return `${tickerOf[s.underlying.toLowerCase()]} ${s.expiry}`;
      }
      if (functionName === "roll") return `${tickerOf[args[1].toLowerCase()]} roll`;
    }
    return null;
  };
  for (const r of rewards) {
    const tx = await pub.getTransaction({ hash: r.transactionHash });
    let key = "unattributed";
    try {
      key = (await tryDecode(tx.to, tx.input)) ?? key;
      if (key === "unattributed" && tx.input.startsWith("0x82ad56cb")) {
        const { args } = viem.decodeFunctionData({ abi: ABI.multicall3, data: tx.input });
        for (const call of args[0]) {
          const k = await tryDecode(call.target, call.callData).catch(() => null);
          if (k) {
            key = k;
            break;
          }
        }
      }
    } catch {
      /* unattributed */
    }
    const row = rows.get(key) ?? { key, total: 0n, byAction: {}, keepers: [] };
    row.total += r.args.amount;
    const a = actionName[r.args.action] ?? r.args.action;
    row.byAction[a] = (row.byAction[a] ?? 0n) + r.args.amount;
    if (!row.keepers.includes(getAddress(r.args.keeper))) row.keepers.push(getAddress(r.args.keeper));
    rows.set(key, row);
  }
  return [...rows.values()];
}

/* ---------------------------------------------------------------------------------------------- */
/*  monitor                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/**
 * ops/v2/monitor.mjs --once --json against the fork with the rehearsal registry copy, alerts to the rehearsal relay.
 * `stateFile` is the monitor's state; `from` copies another state into it first (a sandbox runs on a copy of the
 * forward state, so its findings are judged against the history the forward runs adopted). The report is kept in
 * out/monitor/<label>.json.
 */
export async function runMonitor(label, { stateFile, from = null } = {}) {
  mkdirSync(MONITOR_DIR, { recursive: true });
  const S = loadState();
  const secrets = loadSecrets();
  const state = stateFile ?? path.join(MONITOR_DIR, `${label}.state.json`);
  if (from !== null && existsSync(from)) copyFileSync(from, state);
  const args = [path.join(ROOT, "ops", "v2", "monitor.mjs"), "--once", "--json", "--rpc", RPC, "--registry", S.registryCopy, "--state", state];
  const { code, out, err } = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, ALERT_WEBHOOK: `${RELAY_URL}/alert`, ALERT_WEBHOOK_TOKEN: secrets.relayToken }, stdio: ["ignore", "pipe", "pipe"] });
    let o = "";
    let e = "";
    child.stdout.on("data", (d) => (o += d));
    child.stderr.on("data", (d) => (e += d));
    child.on("close", (c) => resolve({ code: c, out: o, err: e }));
  });
  writeFileSync(path.join(MONITOR_DIR, `${label}.json`), out);
  let report;
  try {
    report = JSON.parse(out);
  } catch {
    return fail(`monitor ${label}: exit ${code}, no JSON report (stderr: ${err.slice(0, 400)})`);
  }
  const sent = report.sent.map((s) => ({ id: s.id, kind: s.kind, severity: s.severity, reason: s.reason, delivered: s.delivered, message: s.message }));
  info(`monitor ${label}: exit ${code}; ${report.findings.length} finding(s), ${sent.length} sent (${[...new Set(sent.map((s) => s.kind))].join(", ") || "none"}), ${report.resolved.length} resolved; incomplete: ${report.incompleteChecks.join(", ") || "none"}`);
  return { code, report, sent, resolved: report.resolved.map((r) => ({ id: r.id, kind: r.resolvedKind, delivered: r.delivered })) };
}

/** Assert a monitor run sent (and the relay delivered) at least one alert of each kind, matching `re` when given. */
export function expectMonitorSent(run, wants) {
  const got = [];
  for (const w of wants) {
    const [kind, re] = Array.isArray(w) ? w : [w, null];
    const hit = run.sent.find((s) => s.kind === kind && s.delivered && (re === null || re.test(s.message)));
    expect(Boolean(hit), `monitor.mjs --once sent ${kind}${re ? ` (${re.source})` : ""} through the relay: ${hit ? hit.message.slice(0, 180) : "missing"}`);
    got.push({ kind, severity: hit.severity, message: hit.message.slice(0, 300) });
  }
  return got;
}

export { say };
