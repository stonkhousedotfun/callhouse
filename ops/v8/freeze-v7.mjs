/**
 * OWN8-04: freeze the LIVE v7 set (create-pause + every live market disabled) and prove it from chain.
 *
 * The risk this exists for is a half-applied freeze that reads as done: paused while NVDA is still enabled, or
 * both applied while a keeper was mid-cycle. So nothing here reports success from a transaction receipt. Every
 * verdict is a READBACK of the chain after the sends, and the run-off path (v7 cranker, v7 indexer, settle) is
 * checked afterwards, because a freeze that silently stops the v7 cranker strands every open series.
 *
 *   node ops/v8/freeze-v7.mjs                                   # dry run (default): offline plan, no RPC, no send
 *   node ops/v8/freeze-v7.mjs --check --chain-id 4663           # read-only: state, readback, run-off; sends nothing
 *   node ops/v8/freeze-v7.mjs --execute --chain-id 4663 \
 *     --guardian-account <keystore-name> --admin-account <keystore-name>
 *
 * Every URL comes from the environment, never argv (production endpoints embed keys): RH_RPC,
 * V7_CRANKER_HEALTH_URL (the v7 cranker's full /health URL), V7_INDEXER_HEALTH_URL (the v7 indexer's full
 * /v2/health URL). Signing is `cast send --account <keystore-name>` only: this file never sees a key, refuses
 * argv that carries one, and strips key-shaped variables from the environment it hands to cast.
 *
 * The contracts side is the authority on what the freeze does (callhouse-contracts docs/V7-RUNOFF.md and
 * script/v2/FreezeV7.s.sol). The ABI below is mirrored from FreezeV7.s.sol:12-56 and from the deployed source
 * rev 1b087550 (script/artifacts/v2-4663/Clearinghouse.json sourceRev), never from src/v2 on the v8 branch,
 * which is a different contract. The runbook is ops/runbooks/v7-runoff.md.
 *
 * Exit codes: 0 every check saw its subject and passed; 1 refused or a check failed; 2 unexpected error;
 * 3 frozen and read back, but a run-off check had no subject it could prove (see the printed UNPROVEN line).
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

export const DEFAULT_V7_LEGACY = path.join(REPO, "ops", "markets", "v7-legacy.json");

export const EXIT = Object.freeze({ OK: 0, REFUSED: 1, ERROR: 2, UNPROVEN: 3 });

/** v7 V2Types.MarketConfig, in storage order (FreezeV7.s.sol:12-19; V2Types.sol at rev 1b087550). */
export const CONFIG_FIELDS = Object.freeze(["enabled", "mintPaused", "strikeTick", "exerciseFeeBps", "oracle", "mintFeePpm"]);
const CONFIG_TUPLE = "(bool enabled, bool mintPaused, uint64 strikeTick, uint16 exerciseFeeBps, address oracle, uint32 mintFeePpm)";

/** The only two calls a freeze may send, as cast signatures. cast encodes them; this file never types a selector. */
export const SET_CREATE_PAUSED_SIG = "setCreatePaused(bool)";
export const SET_MARKET_CONFIG_SIG = "setMarketConfig(address,(bool,bool,uint64,uint16,address,uint32))";

export const V7_CLEARINGHOUSE_ABI_TEXT = Object.freeze([
  "function createPaused() view returns (bool)",
  `function market(address underlying) view returns (${CONFIG_TUPLE})`,
  "function series(uint256 longId) view returns ((address underlying, bool isPut, uint40 expiry, uint128 strike, address oracle, uint16 exerciseFeeBps, bool settled, uint128 settlementPrice, uint128 longPayoutPerUnit, uint128 feePerUnit, uint128 shortPayoutPerUnit, uint32 mintFeePpm, uint128 mintFeesHeld))",
  "function totalSupply(uint256 id) view returns (uint256)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function settle(uint256 longId) returns (bool advanced)",
  "function setCreatePaused(bool paused)",
  `function setMarketConfig(address underlying, ${CONFIG_TUPLE} cfg)`,
  "event SeriesCreated(uint256 indexed longId, address indexed underlying, bool isPut, uint128 strike, uint40 expiry, address oracle, uint16 exerciseFeeBps, uint32 mintFeePpm)",
  `event MarketRegistered(address indexed underlying, ${CONFIG_TUPLE} config)`,
  `event MarketConfigSet(address indexed underlying, ${CONFIG_TUPLE} config)`,
  "event CreatePausedSet(bool paused)",
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
  "error MarketDisabled()",
  "error CreatePaused()",
  "error NotExpired()",
  "error UnknownSeries()",
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
]);
export const V7_ORDER_BOOK_ABI_TEXT = Object.freeze([
  "function clearinghouse() view returns (address)",
  "function tradingPaused() view returns (bool)",
]);

/** Errors that mean the FREEZE blocked a path it must never block (V2Errors at rev 1b087550). */
export const FREEZE_ERRORS = Object.freeze(["MarketDisabled", "CreatePaused"]);

/** FreezeV7.DEFAULT_LOG_CHUNK. */
export const DEFAULT_LOG_CHUNK = 500_000n;
/** An expired series whose oracle is still not final after this long is stranded, not pending. */
export const DEFAULT_SETTLE_GRACE_S = 12 * 3600;
export const DEFAULT_LIVENESS_TIMEOUT_S = 180;
const LIVENESS_POLL_MS = 10_000;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";
const KEY_RE = /(?:^|[^0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?:$|[^0-9a-fA-F])/;
/** Environment variables a signer could pick a key up from. cast only ever gets --account. */
const KEY_ENV_RE = /(PRIVATE_KEY|MNEMONIC|^ETH_PASSWORD$|^ETH_KEYSTORE$|SEED)/i;

export class Refusal extends Error {
  constructor(message) {
    super(message);
    this.name = "Refusal";
  }
}

const lc = (value) => String(value).toLowerCase();
const same = (a, b) => typeof a === "string" && typeof b === "string" && lc(a) === lc(b);

function address(value, label) {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) throw new Refusal(`${label}: expected a 20-byte 0x address, got ${JSON.stringify(value)}`);
  if (lc(value) === ZERO) throw new Refusal(`${label}: the zero address is not a target`);
  return value;
}

/* ---------------------------------------------------------------------------------------------------------------
 * Targets: everything the freeze acts on, from the FROZEN v7 registry and nowhere else.
 * ------------------------------------------------------------------------------------------------------------- */

/**
 * Read the v7 targets out of ops/markets/v7-legacy.json. The V1 trap (T-162-O8-RUNOFF-CLEARINGHOUSE-LABEL):
 * `shared.clearinghouse` in this same file is the V1 Clearinghouse; the v7 one is `v2.contracts.clearinghouse`.
 */
export function v7Targets(registry) {
  const v2 = registry?.v2;
  if (!v2 || typeof v2 !== "object") throw new Refusal("registry: no v2 block; this is not the frozen v7 registry");
  if (v2.interfaceVersion !== 7) {
    throw new Refusal(`registry: v2.interfaceVersion is ${JSON.stringify(v2.interfaceVersion)}, expected 7; this file is not the v7 registry and nothing in it may be frozen`);
  }
  const chainId = registry?.shared?.chainId;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Refusal(`registry: shared.chainId must be a positive integer, got ${JSON.stringify(chainId)}`);
  const deployBlock = Number(v2.deployBlock);
  if (!Number.isSafeInteger(deployBlock) || deployBlock <= 0) throw new Refusal(`registry: v2.deployBlock must be a positive block number, got ${JSON.stringify(v2.deployBlock)}`);

  const clearinghouse = address(v2.contracts?.clearinghouse, "v2.contracts.clearinghouse");
  const v1 = registry?.shared?.clearinghouse;
  if (same(clearinghouse, v1)) {
    throw new Refusal("registry: v2.contracts.clearinghouse equals shared.clearinghouse (the V1 Clearinghouse); refusing to aim an admin call at an ambiguous target");
  }
  const orderBook = address(v2.contracts?.orderBook, "v2.contracts.orderBook");
  const guardian = address(v2.protocolAddresses?.guardian, "v2.protocolAddresses.guardian");
  const admin = address(v2.protocolAddresses?.admin, "v2.protocolAddresses.admin");
  const cranker = address(v2.bots?.cranker, "v2.bots.cranker");

  const live = registry?.waves?.live;
  if (!Array.isArray(live) || live.length === 0) throw new Refusal("registry: waves.live is empty; the freeze needs at least one live market to disable");
  const markets = live.map((ticker) => {
    const row = (registry.markets ?? []).filter((m) => m?.ticker === ticker);
    if (row.length !== 1) throw new Refusal(`registry: waves.live names ${ticker} but markets[] has ${row.length} rows for it`);
    return { ticker, underlying: address(row[0].asset, `markets[${ticker}].asset`) };
  });
  return { chainId, deployBlock: BigInt(deployBlock), clearinghouse, orderBook, guardian, admin, cranker, markets };
}

/* ---------------------------------------------------------------------------------------------------------------
 * Argv and environment hygiene.
 * ------------------------------------------------------------------------------------------------------------- */

/** A key on argv is visible to `ps -axww` for the life of the process. Refuse, and never echo the value. */
export function argvKeyMaterial(argv) {
  const offending = [];
  argv.forEach((arg, i) => {
    if (/^--(private-key|mnemonic|password)(=|$)/.test(arg)) offending.push(`argument ${i + 1} (${arg.split("=")[0]})`);
    else if (KEY_RE.test(arg)) offending.push(`argument ${i + 1} (a 32-byte hex value)`);
  });
  return offending;
}

/** The environment cast runs with: the RPC URL added, every key-shaped variable removed. */
export function signerEnv(env, rpc) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!KEY_ENV_RE.test(k) && k !== "ETH_RPC_URL") out[k] = v;
  out.ETH_RPC_URL = rpc;
  return out;
}

/* ---------------------------------------------------------------------------------------------------------------
 * Chain state and the plan.
 * ------------------------------------------------------------------------------------------------------------- */

function normalizeConfig(raw, label) {
  if (raw === null || typeof raw !== "object") throw new Refusal(`${label}: market() returned ${JSON.stringify(raw)}, not a config tuple`);
  const cfg = {};
  for (const field of CONFIG_FIELDS) {
    if (!(field in raw)) throw new Refusal(`${label}: market() has no ${field}; the readback cannot see its subject`);
    cfg[field] = raw[field];
  }
  if (typeof cfg.enabled !== "boolean" || typeof cfg.mintPaused !== "boolean") throw new Refusal(`${label}: enabled/mintPaused are not booleans`);
  cfg.strikeTick = BigInt(cfg.strikeTick);
  cfg.exerciseFeeBps = Number(cfg.exerciseFeeBps);
  cfg.mintFeePpm = Number(cfg.mintFeePpm);
  cfg.oracle = address(cfg.oracle, `${label}.oracle`);
  return cfg;
}

/** A market row whose strikeTick is 0 is not registered (Clearinghouse.setMarketConfig reverts UnsupportedAsset). */
async function readMarket(chain, t, m) {
  const label = `market(${m.ticker} ${m.underlying})`;
  let raw;
  try {
    raw = await chain.market(t.clearinghouse, m.underlying);
  } catch (error) {
    throw new Refusal(`${label}: read failed: ${shortError(error)}; an unreadable market is not a disabled one`);
  }
  const cfg = normalizeConfig(raw, label);
  if (cfg.strikeTick === 0n) throw new Refusal(`${label}: strikeTick is 0, so the market is not registered on this Clearinghouse; wrong address or wrong chain`);
  return cfg;
}

async function readBool(read, label) {
  let value;
  try {
    value = await read();
  } catch (error) {
    throw new Refusal(`${label}: read failed: ${shortError(error)}`);
  }
  if (typeof value !== "boolean") throw new Refusal(`${label}: returned ${JSON.stringify(value)}, not a boolean; the readback cannot see its subject`);
  return value;
}

/** Everything the freeze depends on, read once. Refuses rather than guessing on any unreadable fact. */
export async function readState(chain, t) {
  const createPaused = await readBool(() => chain.createPaused(t.clearinghouse), "createPaused()");
  const markets = [];
  for (const m of t.markets) markets.push({ ...m, cfg: await readMarket(chain, t, m) });
  const tradingPaused = await readBool(() => chain.tradingPaused(t.orderBook), "OrderBook.tradingPaused()");
  return { createPaused, markets, tradingPaused };
}

/** LIVE, FROZEN, or HALF-APPLIED, with the half named. */
export function freezeState(state) {
  const enabled = state.markets.filter((m) => m.cfg.enabled).map((m) => m.ticker);
  if (state.createPaused && enabled.length === 0) return { kind: "FROZEN", detail: "createPaused() == true and every live market disabled" };
  if (!state.createPaused && enabled.length === state.markets.length) return { kind: "LIVE", detail: "not paused and every live market enabled" };
  if (state.createPaused) {
    return { kind: "HALF-APPLIED", detail: `paused, but ${enabled.join(", ")} still enabled: new series ids are stopped, mint into the series that already exist is NOT` };
  }
  const disabled = state.markets.filter((m) => !m.cfg.enabled).map((m) => m.ticker);
  return { kind: "HALF-APPLIED", detail: `${disabled.join(", ")} disabled but createPaused() == false${enabled.length ? `, and ${enabled.join(", ")} still enabled` : ""}` };
}

const tupleArg = (cfg) => `(${cfg.enabled},${cfg.mintPaused},${cfg.strikeTick},${cfg.exerciseFeeBps},${cfg.oracle},${cfg.mintFeePpm})`;

/** The calls that take `state` to FROZEN. Guardian first (it covers every market), then admin per enabled market. */
export function planCalls(t, state) {
  const calls = [];
  if (!state.createPaused) {
    calls.push({ role: "guardian", from: t.guardian, to: t.clearinghouse, sig: SET_CREATE_PAUSED_SIG, args: ["true"], what: "setCreatePaused(true)" });
  }
  for (const m of state.markets) {
    if (!m.cfg.enabled) continue;
    // Read from the chain, ONLY `enabled` flipped. The Clearinghouse keeps its stored mintPaused whatever this carries.
    const cfg = { ...m.cfg, enabled: false };
    calls.push({ role: "admin", from: t.admin, to: t.clearinghouse, sig: SET_MARKET_CONFIG_SIG, args: [m.underlying, tupleArg(cfg)], what: `setMarketConfig(${m.ticker}, enabled = false)`, ticker: m.ticker, cfg });
  }
  return calls;
}

/**
 * Every registered market must be in the freeze set or already disabled: `setCreatePaused` alone does not stop
 * `mint` into an existing series (FreezeV7.freezeSet refuses the same thing). An EMPTY log scan is a refusal, not
 * a pass: NVDA is registered, so a scan that finds nothing cannot see what it is checking.
 */
export async function registeredMarketIssues(chain, t, toBlock, logChunk) {
  const registered = (await chain.marketRegisteredLogs(t.clearinghouse, t.deployBlock, toBlock, logChunk)).map((r) => r.underlying);
  if (registered.length === 0) {
    return [`MarketRegistered scan from block ${t.deployBlock} to ${toBlock} found nothing; ${t.markets.map((m) => m.ticker).join(", ")} is registered, so the scan is blind (wrong address, wrong chain, or a node that caps eth_getLogs)`];
  }
  const issues = [];
  for (const m of t.markets) {
    if (!registered.some((u) => same(u, m.underlying))) issues.push(`${m.ticker} ${m.underlying} is in waves.live but no MarketRegistered log names it`);
  }
  for (const u of new Set(registered.map(lc))) {
    if (t.markets.some((m) => same(m.underlying, u))) continue;
    const cfg = await readMarket(chain, t, { ticker: "unlisted", underlying: u });
    if (cfg.enabled) issues.push(`registered market ${u} is enabled and is not in waves.live; the freeze would leave mint open there`);
  }
  return issues;
}

/* ---------------------------------------------------------------------------------------------------------------
 * Readback: the only thing that decides whether the freeze happened.
 * ------------------------------------------------------------------------------------------------------------- */

/**
 * Compare the chain after the sends with the chain before them. `before` is the preflight read. Returns issues;
 * an empty list is the only success. Every field of every config is compared, not only `enabled`: a config write
 * that moved anything else wrote a row the chain did not hold.
 */
export function readbackIssues(before, after) {
  const issues = [];
  if (after.createPaused !== true) issues.push(`createPaused() reads ${after.createPaused}, expected true`);
  for (const m of after.markets) {
    const prior = before.markets.find((b) => same(b.underlying, m.underlying));
    if (m.cfg.enabled !== false) issues.push(`market(${m.ticker}).enabled reads ${m.cfg.enabled}, expected false`);
    if (!prior) {
      issues.push(`market(${m.ticker}) has no preflight read to compare against`);
      continue;
    }
    for (const field of CONFIG_FIELDS) {
      if (field === "enabled") continue;
      if (String(m.cfg[field]).toLowerCase() !== String(prior.cfg[field]).toLowerCase()) {
        issues.push(`market(${m.ticker}).${field} changed from ${prior.cfg[field]} to ${m.cfg[field]}; the freeze flips enabled and nothing else`);
      }
    }
  }
  if (before.markets.length !== after.markets.length) issues.push(`read ${after.markets.length} markets back, preflight read ${before.markets.length}`);
  if (after.tradingPaused !== false) issues.push("OrderBook.tradingPaused() reads true: the book is paused, which the freeze never does (holders lose resale)");
  return issues;
}

const pos = (log) => [BigInt(log.blockNumber), Number(log.transactionIndex ?? 0)];
const after = (log, point) => {
  const [b, i] = pos(log);
  const [pb, pi] = pos(point);
  return b > pb || (b === pb && i > pi);
};

/**
 * Where the freeze landed, from the chain's own events: the latest CreatePausedSet(true) and, per market, the
 * latest MarketConfigSet with enabled == false. A FROZEN state with no such event is a blind scan, not a pass.
 *
 * The disabling event is also compared with the config event before it (MarketRegistered or an earlier
 * MarketConfigSet): every field but `enabled` must match. That is the chain's own record that the freeze flipped
 * one bit, and unlike a before/after read it still holds when --check runs long after the send.
 */
export async function freezePoints(chain, t, toBlock, logChunk) {
  const { pauses, configs } = await chain.freezeEvents(t.clearinghouse, t.deployBlock, toBlock, logChunk);
  const registered = await chain.marketRegisteredLogs(t.clearinghouse, t.deployBlock, toBlock, logChunk);
  const issues = [];
  const pause = [...pauses].filter((p) => p.paused === true).sort((a, b) => (after(a, b) ? 1 : -1)).pop() ?? null;
  if (!pause) issues.push(`no CreatePausedSet(true) event between block ${t.deployBlock} and ${toBlock}; createPaused cannot be true without one, so the event scan is blind`);
  const disables = {};
  for (const m of t.markets) {
    const d = configs.filter((c) => same(c.underlying, m.underlying) && c.enabled === false).sort((a, b) => (after(a, b) ? 1 : -1)).pop() ?? null;
    if (!d) issues.push(`no MarketConfigSet(${m.ticker}, enabled = false) event between block ${t.deployBlock} and ${toBlock}; the event scan is blind`);
    disables[m.ticker] = d;
    if (!d) continue;
    const history = [...registered, ...configs].filter((c) => same(c.underlying, m.underlying) && after(d, c));
    const prior = history.sort((a, b) => (after(a, b) ? 1 : -1)).pop();
    if (!prior) {
      issues.push(`${m.ticker}: no MarketRegistered or MarketConfigSet before the disable in block ${d.blockNumber}; cannot show the disable flipped only enabled`);
      continue;
    }
    for (const field of CONFIG_FIELDS) {
      if (field === "enabled") continue;
      if (String(d.config?.[field]).toLowerCase() !== String(prior.config?.[field]).toLowerCase()) {
        issues.push(`${m.ticker}: the disable in block ${d.blockNumber} moved ${field} from ${prior.config?.[field]} to ${d.config?.[field]}; the freeze flips enabled and nothing else`);
      }
    }
  }
  return { pause, disables, issues };
}

/**
 * Mid-cycle proof. A series created after the pause landed, or a unit minted after a market's disable landed,
 * means the freeze did not hold even though both flags read right.
 */
export async function postFreezeActivityIssues(chain, t, points, toBlock, logChunk) {
  const issues = [];
  if (points.pause) {
    const created = await chain.seriesCreatedLogs(t.clearinghouse, BigInt(points.pause.blockNumber), toBlock, logChunk);
    for (const s of created.filter((s) => after(s, points.pause))) {
      issues.push(`series ${s.longId} was created in block ${s.blockNumber}, after the pause landed in block ${points.pause.blockNumber}`);
    }
  }
  const earliest = Object.values(points.disables).filter(Boolean).sort((a, b) => (after(a, b) ? 1 : -1))[0];
  if (earliest) {
    const created = await chain.seriesCreatedLogs(t.clearinghouse, t.deployBlock, toBlock, logChunk);
    const mints = await chain.mintLogs(t.clearinghouse, BigInt(earliest.blockNumber), toBlock, logChunk);
    for (const mint of mints) {
      // V2Ids: a long id is even and its short id is longId | 1 (V2Ids.sol at rev 1b087550).
      const s = created.find((c) => BigInt(c.longId) === (BigInt(mint.id) & ~1n));
      const ticker = s ? t.markets.find((m) => same(m.underlying, s.underlying))?.ticker : null;
      const point = ticker ? points.disables[ticker] : earliest;
      if (point && after(mint, point)) issues.push(`token ${mint.id} was minted in block ${mint.blockNumber}, after ${ticker ?? "a market"} was disabled in block ${point.blockNumber}`);
    }
  }
  return issues;
}

/* ---------------------------------------------------------------------------------------------------------------
 * Run-off: settle, the v7 cranker, the v7 indexer.
 * ------------------------------------------------------------------------------------------------------------- */

/**
 * Every unsettled v7 series must still settle. An expired one is simulated at the head; a future one is simulated
 * at expiry + 1 with an eth_call block override. `settle` returns false (never reverts) while the oracle is not
 * final (Clearinghouse.sol:567 at rev 1b087550), so a returned value of either kind proves the call runs past
 * everything the freeze could have gated. A revert is a failure; an override the node ignored or refused is
 * UNPROVEN, never a pass.
 */
export async function settleCheck(chain, t, { now, toBlock, logChunk, graceS = DEFAULT_SETTLE_GRACE_S }) {
  const created = await chain.seriesCreatedLogs(t.clearinghouse, t.deployBlock, toBlock, logChunk);
  const issues = [];
  const unproven = [];
  const rows = { total: created.length, settled: 0, settleableNow: 0, awaitingOracle: 0, probedFuture: 0, lastExpiry: 0, lastOpenExpiry: 0 };
  if (created.length === 0) {
    issues.push(`SeriesCreated scan from block ${t.deployBlock} to ${toBlock} found nothing; the v7 set has traded, so the run-off check is blind`);
    return { issues, unproven, rows };
  }
  for (const log of created) {
    const id = BigInt(log.longId);
    let s;
    try {
      s = await chain.series(t.clearinghouse, id);
    } catch (error) {
      issues.push(`series(${id}) read failed: ${shortError(error)}`);
      continue;
    }
    const expiry = Number(s?.expiry);
    if (!Number.isSafeInteger(expiry) || expiry <= 0 || typeof s?.settled !== "boolean") {
      issues.push(`series(${id}) returned no expiry/settled; the readback cannot see its subject`);
      continue;
    }
    rows.lastExpiry = Math.max(rows.lastExpiry, expiry);
    if (s.settled) {
      rows.settled += 1;
      continue;
    }
    const supply = BigInt(await chain.totalSupply(t.clearinghouse, id));
    if (supply > 0n) rows.lastOpenExpiry = Math.max(rows.lastOpenExpiry, expiry);
    const future = expiry > now;
    const r = await chain.simulateSettle(t.clearinghouse, id, future ? { time: expiry + 1 } : {});
    const label = `settle(${id}) [expiry ${iso(expiry)}, long supply ${supply}]`;
    if (r.kind === "returned") {
      if (future) rows.probedFuture += 1;
      else if (r.value === true) rows.settleableNow += 1;
      else if (now - expiry > graceS) issues.push(`${label}: expired ${Math.floor((now - expiry) / 3600)} h ago and the oracle is still not final; the series is stranded (is the v7 cranker finalizing?)`);
      else rows.awaitingOracle += 1;
    } else if (r.kind === "reverted") {
      if (future && r.error === "NotExpired") unproven.push(`${label}: the node ignored the block-time override (NotExpired)`);
      else if (FREEZE_ERRORS.includes(r.error)) issues.push(`${label}: reverts ${r.error}; the freeze is blocking settlement`);
      else issues.push(`${label}: reverts ${r.error ?? r.data ?? "without a reason"}`);
    } else {
      unproven.push(`${label}: ${r.message ?? "the node refused the simulation"}`);
    }
  }
  return { issues, unproven, rows };
}

function blockOf(value) {
  try {
    return value === null || value === undefined || value === "" ? null : BigInt(value);
  } catch {
    return null;
  }
}

/** The v7 cranker's /health (keeper/src/v2/health.ts). Identity first: a v8 cranker answering 200 proves nothing here. */
export function crankerIssues(res, t, minBlock) {
  const b = res?.body;
  if (!res || res.status !== 200) return [`cranker /health answered ${res?.status ?? "nothing"}${res?.error ? ` (${res.error})` : ""}; 503 means the loop is wedged`];
  if (!b || typeof b !== "object") return ["cranker /health returned no JSON body"];
  const issues = [];
  if (b.mode !== "cranker") issues.push(`cranker /health mode is ${JSON.stringify(b.mode)}, expected "cranker"`);
  if (b.chain?.chainId !== t.chainId) issues.push(`cranker /health chain ${JSON.stringify(b.chain?.chainId)}, expected ${t.chainId}`);
  if (!same(b.contracts?.clearinghouse, t.clearinghouse)) issues.push(`cranker /health clearinghouse ${JSON.stringify(b.contracts?.clearinghouse)} is not the v7 Clearinghouse ${t.clearinghouse}; this is not the v7 cranker`);
  if (!same(b.signer?.address, t.cranker)) issues.push(`cranker /health signer ${JSON.stringify(b.signer?.address)} is not the v7 cranker ${t.cranker}`);
  if (b.checks?.heartbeat !== true) issues.push(`cranker /health heartbeat is ${JSON.stringify(b.checks?.heartbeat)}; the loop is not ticking`);
  const head = blockOf(b.chain?.headBlock);
  if (head === null) issues.push("cranker /health has no chain.headBlock; it has not read the chain");
  else if (minBlock !== null && head < minBlock) issues.push(`cranker last read block ${head}, before block ${minBlock}; it has not ticked since the freeze`);
  return issues;
}

/** The v7 indexer's /v2/health (indexer/src/api/v2/index.ts). */
export function indexerIssues(res, minBlock) {
  const b = res?.body;
  if (!res || res.status !== 200) return [`indexer /v2/health answered ${res?.status ?? "nothing"}${res?.error ? ` (${res.error})` : ""}`];
  if (!b || typeof b !== "object") return ["indexer /v2/health returned no JSON body"];
  const issues = [];
  if (b.status !== "ok") issues.push(`indexer status is ${JSON.stringify(b.status)}, expected "ok" (lagging or degraded is not following the chain)`);
  if (Number(b.interfaceVersion) !== 7) issues.push(`indexer interfaceVersion is ${JSON.stringify(b.interfaceVersion)}, expected 7; this is not the v7 indexer`);
  const head = blockOf(b.block);
  if (head === null || head === 0n) issues.push(`indexer block is ${JSON.stringify(b.block)}; it has indexed nothing`);
  else if (minBlock !== null && head < minBlock) issues.push(`indexer head ${head} is before block ${minBlock}; it has not indexed past the freeze`);
  return issues;
}

/** Poll both services until both pass or the timeout. Returns the last issues seen (empty = alive past minBlock). */
export async function livenessIssues({ fetchJson, urls, t, minBlock, timeoutS, sleep, clock = Date.now }) {
  const deadline = clock() + timeoutS * 1000;
  for (;;) {
    const [c, i] = await Promise.all([fetchJson(urls.cranker), fetchJson(urls.indexer)]);
    const issues = [...crankerIssues(c, t, minBlock), ...indexerIssues(i, minBlock)];
    if (issues.length === 0 || clock() >= deadline) return issues;
    await sleep(LIVENESS_POLL_MS);
  }
}

/* ---------------------------------------------------------------------------------------------------------------
 * Sending. cast, keystore account only.
 * ------------------------------------------------------------------------------------------------------------- */

function parseReceipt(stdout) {
  let r;
  try {
    r = JSON.parse(stdout);
  } catch {
    throw new Refusal("cast send did not print a JSON receipt; the send's outcome is unknown, so nothing after it runs");
  }
  const status = r.status === "0x1" || r.status === 1 || r.status === "1" || r.status === "success" ? "success" : "reverted";
  return { status, from: r.from, to: r.to, transactionHash: r.transactionHash, blockNumber: BigInt(r.blockNumber), transactionIndex: Number(r.transactionIndex ?? 0) };
}

/** The default sender. The password prompt comes from cast on the terminal; this process never holds a key. */
export function castSender({ rpc, env, spawn = spawnSync }) {
  return ({ account, to, sig, args, chainId }) => {
    const argv = ["send", "--json", "--chain", String(chainId), "--account", account, to, sig, ...args];
    const res = spawn("cast", argv, { env: signerEnv(env, rpc), encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });
    if (res.error) throw new Refusal(`cast did not start: ${shortError(res.error)}`);
    if (res.status !== 0) throw new Refusal(`cast send exited ${res.status}; treat the send as NOT landed until the readback says otherwise`);
    return parseReceipt(res.stdout);
  };
}

/* ---------------------------------------------------------------------------------------------------------------
 * The procedure.
 * ------------------------------------------------------------------------------------------------------------- */

function parseArgs(argv) {
  const opts = {
    registry: DEFAULT_V7_LEGACY,
    execute: false,
    check: false,
    chainId: null,
    guardianAccount: null,
    adminAccount: null,
    rpcEnv: "RH_RPC",
    crankerEnv: "V7_CRANKER_HEALTH_URL",
    indexerEnv: "V7_INDEXER_HEALTH_URL",
    logChunk: DEFAULT_LOG_CHUNK,
    graceS: DEFAULT_SETTLE_GRACE_S,
    livenessTimeoutS: DEFAULT_LIVENESS_TIMEOUT_S,
    help: false,
  };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Refusal(`${flag} needs a value`);
    return v;
  };
  const positive = (raw, flag) => {
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Refusal(`${flag} must be a positive integer, got ${JSON.stringify(raw)}`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--execute") opts.execute = true;
    else if (arg === "--check") opts.check = true;
    else if (arg === "--chain-id") opts.chainId = positive(value(i++, arg), arg);
    else if (arg === "--registry") opts.registry = value(i++, arg);
    else if (arg === "--guardian-account") opts.guardianAccount = value(i++, arg);
    else if (arg === "--admin-account") opts.adminAccount = value(i++, arg);
    else if (arg === "--rpc-env") opts.rpcEnv = value(i++, arg);
    else if (arg === "--cranker-env") opts.crankerEnv = value(i++, arg);
    else if (arg === "--indexer-env") opts.indexerEnv = value(i++, arg);
    else if (arg === "--log-chunk") opts.logChunk = BigInt(positive(value(i++, arg), arg));
    else if (arg === "--settle-grace-hours") opts.graceS = positive(value(i++, arg), arg) * 3600;
    else if (arg === "--liveness-timeout") opts.livenessTimeoutS = positive(value(i++, arg), arg);
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Refusal(`unknown argument ${JSON.stringify(arg.slice(0, 40))}`);
  }
  return opts;
}

const USAGE = `usage: node ops/v8/freeze-v7.mjs [--check | --execute] [options]

Default: dry run. Reads ops/markets/v7-legacy.json and prints the plan; no RPC, no send.
  --check                  read-only: state, readback, run-off checks against the chain; sends nothing
  --execute                send the missing freeze calls, then read everything back
  --chain-id <id>          required with --check and --execute; must match the registry and the RPC
  --guardian-account <n>   Foundry keystore account holding GUARDIAN_ROLE (--execute, when a pause is planned)
  --admin-account <n>      Foundry keystore account holding DEFAULT_ADMIN_ROLE (--execute, when a disable is planned)
  --registry <path>        frozen v7 registry (default ops/markets/v7-legacy.json)
  --rpc-env <name>         env var holding the RPC URL (default RH_RPC)
  --cranker-env <name>     env var holding the v7 cranker /health URL (default V7_CRANKER_HEALTH_URL)
  --indexer-env <name>     env var holding the v7 indexer /v2/health URL (default V7_INDEXER_HEALTH_URL)
  --log-chunk <blocks>     eth_getLogs span (default ${DEFAULT_LOG_CHUNK})
  --settle-grace-hours <h> an expired series not final after this is stranded (default ${DEFAULT_SETTLE_GRACE_S / 3600})
  --liveness-timeout <s>   how long to wait for the cranker and indexer to pass the freeze block (default ${DEFAULT_LIVENESS_TIMEOUT_S})
Keys: never. Signing is cast --account <keystore name>; argv carrying a key is refused.`;

function jsonFile(filename) {
  try {
    return JSON.parse(readFileSync(filename, "utf8"));
  } catch (error) {
    throw new Refusal(`cannot read ${filename}: ${String(error?.message ?? error).split("\n")[0]}`);
  }
}

function fail(prefix, issues) {
  if (issues.length > 0) throw new Refusal(`${prefix}:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
}

/**
 * The whole procedure against injected edges, so the tests drive it without a chain, a signer or a network.
 * `io` = { chain, send, fetchJson, sleep, log, now } — `send` is only ever called under --execute.
 */
export async function run(argv, env, io) {
  const offending = argvKeyMaterial(argv);
  if (offending.length > 0) throw new Refusal(`key material on the command line (${offending.join(", ")}); it is visible to every process on this machine. Use a Foundry keystore: --guardian-account / --admin-account <name>`);
  const opts = parseArgs(argv);
  const log = io.log;
  if (opts.help) {
    log(USAGE);
    return EXIT.OK;
  }
  if (opts.execute && opts.check) throw new Refusal("--check and --execute are exclusive; --execute already ends with the full check");

  const t = v7Targets(jsonFile(path.resolve(opts.registry)));
  log(`v7 Clearinghouse ${t.clearinghouse} (v2.contracts.clearinghouse; NOT shared.clearinghouse, which is V1)`);
  log(`v7 OrderBook ${t.orderBook} (read only; the freeze never pauses the book)`);
  log(`guardian ${t.guardian}  admin ${t.admin}  v7 cranker ${t.cranker}`);
  log(`live markets to disable: ${t.markets.map((m) => `${m.ticker} ${m.underlying}`).join(", ")}`);
  log(`PLAN: 1) guardian ${SET_CREATE_PAUSED_SIG} true  2) admin ${SET_MARKET_CONFIG_SIG} per enabled market, config read from chain with ONLY enabled flipped`);
  log("THEN: read createPaused() and every market() back, scan for series created / units minted after the freeze, check settle, the v7 cranker and the v7 indexer");

  if (!opts.execute && !opts.check) {
    log("DRY RUN: no RPC call and no send. Re-run with --check (read-only) or --execute, each with --chain-id.");
    return EXIT.OK;
  }
  if (opts.chainId === null) throw new Refusal(`${opts.execute ? "--execute" : "--check"} requires --chain-id; a readback from an unidentified chain proves nothing`);
  if (opts.chainId !== t.chainId) throw new Refusal(`--chain-id ${opts.chainId} disagrees with the registry's shared.chainId ${t.chainId}; no RPC call made`);
  const rpc = env[opts.rpcEnv];
  if (typeof rpc !== "string" || rpc.length === 0) throw new Refusal(`the RPC URL must be in ${opts.rpcEnv}; it is never accepted on argv`);
  const urls = { cranker: env[opts.crankerEnv], indexer: env[opts.indexerEnv] };
  for (const [name, envName] of [["cranker", opts.crankerEnv], ["indexer", opts.indexerEnv]]) {
    if (typeof urls[name] !== "string" || urls[name].length === 0) {
      throw new Refusal(`the v7 ${name} health URL must be in ${envName}; the run-off check cannot be skipped, and without it a freeze that stopped the ${name} would read as done`);
    }
  }

  const chain = io.chain(rpc);
  const actual = Number(await chain.chainId());
  if (actual !== opts.chainId) throw new Refusal(`the RPC is chain ${actual}, expected ${opts.chainId}; nothing read, nothing sent`);
  for (const [label, a] of [["v7 Clearinghouse", t.clearinghouse], ["v7 OrderBook", t.orderBook]]) {
    if (!(await chain.hasCode(a))) throw new Refusal(`${label} ${a} has no bytecode on chain ${actual}`);
  }
  const bookCh = await chain.orderBookClearinghouse(t.orderBook);
  if (!same(bookCh, t.clearinghouse)) throw new Refusal(`OrderBook.clearinghouse() is ${bookCh}, not ${t.clearinghouse}; these two addresses are not one v7 set`);

  const head0 = BigInt(await chain.blockNumber());
  const before = await readState(chain, t);
  const s0 = freezeState(before);
  log(`STATE: ${s0.kind} — ${s0.detail}`);
  fail("registered-market completeness refused", await registeredMarketIssues(chain, t, head0, opts.logChunk));

  let lastSent = null;
  if (opts.execute) {
    const calls = planCalls(t, before);
    if (calls.length === 0) log("NOTHING TO SEND: already frozen. Running the readback and run-off checks.");
    else {
      const roleIssues = [];
      for (const [role, holder, name] of [["guardian", t.guardian, "GUARDIAN_ROLE"], ["admin", t.admin, "DEFAULT_ADMIN_ROLE"]]) {
        if (!calls.some((c) => c.role === role)) continue;
        if (!(await readBool(() => chain.hasRole(t.clearinghouse, name, holder), `hasRole(${name}, ${holder})`))) roleIssues.push(`${holder} does not hold ${name} on ${t.clearinghouse}`);
        const account = role === "guardian" ? opts.guardianAccount : opts.adminAccount;
        if (!account) roleIssues.push(`--${role}-account <keystore name> is required: a ${role} call is planned`);
      }
      fail("role preflight refused", roleIssues);
      // The run-off path must be alive BEFORE anything is sent, or a dead cranker gets blamed on the freeze.
      fail("run-off path is not alive before the freeze; fix it first (nothing was sent)", await livenessIssues({ ...io, urls, t, minBlock: null, timeoutS: 0 }));
      for (const c of calls) {
        const sim = await chain.simulate({ from: c.from, to: c.to, sig: c.sig, args: c.args, cfg: c.cfg });
        if (!sim.ok) throw new Refusal(`${c.what} from ${c.from} would revert (${sim.error ?? "no reason"}); nothing was sent`);
      }
      log(`SENDING ${calls.length} call(s). Instant, no timelock: there is no abort after this line.`);
      for (const [n, c] of calls.entries()) {
        let receipt;
        try {
          receipt = io.send({ account: c.role === "guardian" ? opts.guardianAccount : opts.adminAccount, to: c.to, sig: c.sig, args: c.args, chainId: opts.chainId });
        } catch (error) {
          return halfApplied(log, chain, t, `${c.what} did not complete: ${shortError(error)}`, n);
        }
        const bad = [];
        if (receipt.status !== "success") bad.push("status is not success");
        if (!same(receipt.from, c.from)) bad.push(`signed by ${receipt.from}, expected the ${c.role} ${c.from}`);
        if (!same(receipt.to, c.to)) bad.push(`sent to ${receipt.to}, expected ${c.to}`);
        if (bad.length > 0) return halfApplied(log, chain, t, `${c.what} (${receipt.transactionHash}): ${bad.join("; ")}`, n);
        log(`SENT ${c.what} in block ${receipt.blockNumber} (${receipt.transactionHash}); the readback decides whether it took`);
        lastSent = receipt.blockNumber;
      }
    }
  }

  // A readback from a node that has not reached the send's block reads the pre-freeze chain. Wait for it.
  if (lastSent !== null) {
    const clock = io.clock ?? Date.now;
    const deadline = clock() + opts.livenessTimeoutS * 1000;
    while (BigInt(await chain.blockNumber()) < lastSent) {
      if (clock() >= deadline) throw new Refusal(`the RPC head is still before block ${lastSent}, where the last send landed; a readback from behind the send proves nothing. Re-run --check.`);
      await io.sleep(2_000);
    }
  }

  // THE READBACK. Nothing above counts as success; this does.
  const head = BigInt(await chain.blockNumber());
  const now = Number(await chain.headTimestamp());
  const afterState = await readState(chain, t);
  const s1 = freezeState(afterState);
  const readback = s1.kind === "HALF-APPLIED" ? [`HALF-APPLIED: ${s1.detail}`] : [];
  readback.push(...readbackIssues(before, afterState));
  const points = await freezePoints(chain, t, head, opts.logChunk);
  readback.push(...points.issues);
  if (points.pause || Object.values(points.disables).some(Boolean)) readback.push(...(await postFreezeActivityIssues(chain, t, points, head, opts.logChunk)));
  fail(`READBACK FAILED (state ${s1.kind}) — the freeze is NOT done`, readback);
  log(`READBACK PASS: createPaused() == true; ${afterState.markets.map((m) => `${m.ticker}.enabled == false, every other field unchanged`).join("; ")}; OrderBook not paused`);
  log(`READBACK PASS: pause landed in block ${points.pause.blockNumber}; no series created and no unit minted after the freeze`);

  const freezeBlock = [points.pause, ...Object.values(points.disables)].map((p) => BigInt(p.blockNumber)).reduce((a, b) => (a > b ? a : b));
  const settle = await settleCheck(chain, t, { now, toBlock: head, logChunk: opts.logChunk, graceS: opts.graceS });
  const live = await livenessIssues({ ...io, urls, t, minBlock: freezeBlock, timeoutS: opts.livenessTimeoutS });
  fail("RUN-OFF FAILED — frozen, but the run-off path is not intact", [...settle.issues, ...live]);
  const r = settle.rows;
  log(`RUN-OFF PASS: v7 cranker and v7 indexer alive past block ${freezeBlock}`);
  log(`RUN-OFF: ${r.total} series; ${r.settled} settled; ${r.settleableNow} settleable now; ${r.awaitingOracle} awaiting the oracle; ${r.probedFuture} future series settle past expiry in simulation`);
  log(`RUN-OFF DATES: last position expires ${r.lastOpenExpiry ? iso(r.lastOpenExpiry) : "(none open)"}; last settlement due ${r.lastExpiry ? iso(r.lastExpiry) : "(none)"}`);
  if (settle.unproven.length > 0) {
    log(`UNPROVEN: ${settle.unproven.length} unsettled series could not be simulated past expiry:\n${settle.unproven.map((u) => `  - ${u}`).join("\n")}`);
    log("Re-run --check after the next expiry has passed; do not read this run as a proof that those series settle.");
    return EXIT.UNPROVEN;
  }
  log("FROZEN: both readbacks agree and the run-off path is intact.");
  return EXIT.OK;
}

/** A send failed partway. Read the chain and say exactly which half is on it; never report this as done. */
async function halfApplied(log, chain, t, why, sentBefore) {
  let where;
  try {
    where = freezeState(await readState(chain, t));
  } catch (error) {
    where = { kind: "UNKNOWN", detail: `the state could not be read back: ${shortError(error)}` };
  }
  throw new Refusal(`SEND FAILED after ${sentBefore} successful call(s): ${why}\n  chain now reads ${where.kind}: ${where.detail}\n  See ops/runbooks/v7-runoff.md "Abort points": complete the missing half or reverse it deliberately. Re-run with --execute to send only what is missing.`);
}

/* ---------------------------------------------------------------------------------------------------------------
 * The real edges: viem for reads (from keeper/, never installed by this file), fetch for health.
 * ------------------------------------------------------------------------------------------------------------- */

function iso(ts) {
  return new Date(Number(ts) * 1000).toISOString().replace(".000Z", "Z");
}

function shortError(error) {
  if (error instanceof Refusal) return String(error.message).split("\n")[0];
  if (typeof error?.shortMessage === "string") return error.shortMessage.split("\n")[0];
  return typeof error?.message === "string" ? error.message.split("\n")[0] : String(error);
}

export function viemChain(rpc) {
  let viem;
  try {
    viem = createRequire(path.join(REPO, "keeper", "package.json"))("viem");
  } catch {
    throw new Refusal("viem is not resolvable from keeper/: dependency missing; do not install or patch node_modules from this task");
  }
  const chAbi = viem.parseAbi(V7_CLEARINGHOUSE_ABI_TEXT);
  const obAbi = viem.parseAbi(V7_ORDER_BOOK_ABI_TEXT);
  const client = viem.createPublicClient({ transport: viem.http(rpc, { timeout: 30_000, retryCount: 1 }) });
  const read = (address, functionName, args = [], abi = chAbi) => client.readContract({ address, abi, functionName, args });
  const ev = (name) => chAbi.find((x) => x.type === "event" && x.name === name);
  const logs = async (address, event, fromBlock, toBlock, chunk, extra = {}) => {
    const out = [];
    for (let from = fromBlock; from <= toBlock; from += chunk) {
      const to = from + chunk - 1n < toBlock ? from + chunk - 1n : toBlock;
      out.push(...(await client.getLogs({ address, event: ev(event), fromBlock: from, toBlock: to, strict: true, ...extra })));
    }
    return out;
  };
  const revertName = (error) => {
    const data = error?.walk?.((e) => typeof e?.data === "string")?.data ?? error?.data;
    if (typeof data !== "string") return { error: null, data: null };
    try {
      return { error: viem.decodeErrorResult({ abi: chAbi, data }).errorName, data };
    } catch {
      return { error: null, data };
    }
  };
  const ROLES = { GUARDIAN_ROLE: viem.keccak256(viem.toBytes("GUARDIAN_ROLE")), DEFAULT_ADMIN_ROLE: `0x${"0".repeat(64)}` };
  return {
    chainId: () => client.getChainId(),
    blockNumber: () => client.getBlockNumber(),
    headTimestamp: async () => Number((await client.getBlock({ blockTag: "latest" })).timestamp),
    hasCode: async (a) => {
      const code = await client.getCode({ address: a });
      return typeof code === "string" && !/^0x0*$/.test(code);
    },
    createPaused: (ch) => read(ch, "createPaused"),
    market: (ch, u) => read(ch, "market", [u]),
    series: (ch, id) => read(ch, "series", [id]),
    totalSupply: (ch, id) => read(ch, "totalSupply", [id]),
    hasRole: (ch, role, account) => read(ch, "hasRole", [ROLES[role], account]),
    tradingPaused: (ob) => read(ob, "tradingPaused", [], obAbi),
    orderBookClearinghouse: (ob) => read(ob, "clearinghouse", [], obAbi),
    marketRegisteredLogs: async (ch, from, to, chunk) =>
      (await logs(ch, "MarketRegistered", from, to, chunk)).map((l) => ({ underlying: l.args.underlying, config: l.args.config, blockNumber: l.blockNumber, transactionIndex: l.transactionIndex })),
    seriesCreatedLogs: async (ch, from, to, chunk) =>
      (await logs(ch, "SeriesCreated", from, to, chunk)).map((l) => ({ longId: l.args.longId, underlying: l.args.underlying, blockNumber: l.blockNumber, transactionIndex: l.transactionIndex })),
    mintLogs: async (ch, from, to, chunk) => {
      const single = (await logs(ch, "TransferSingle", from, to, chunk, { args: { from: ZERO } })).map((l) => ({ id: l.args.id, blockNumber: l.blockNumber, transactionIndex: l.transactionIndex }));
      const batch = (await logs(ch, "TransferBatch", from, to, chunk, { args: { from: ZERO } })).flatMap((l) => l.args.ids.map((id) => ({ id, blockNumber: l.blockNumber, transactionIndex: l.transactionIndex })));
      return [...single, ...batch];
    },
    freezeEvents: async (ch, from, to, chunk) => ({
      pauses: (await logs(ch, "CreatePausedSet", from, to, chunk)).map((l) => ({ paused: l.args.paused, blockNumber: l.blockNumber, transactionIndex: l.transactionIndex, transactionHash: l.transactionHash })),
      configs: (await logs(ch, "MarketConfigSet", from, to, chunk)).map((l) => ({ underlying: l.args.underlying, enabled: l.args.config.enabled, config: l.args.config, blockNumber: l.blockNumber, transactionIndex: l.transactionIndex, transactionHash: l.transactionHash })),
    }),
    simulate: async ({ from, to, sig, args, cfg }) => {
      const data = sig === SET_CREATE_PAUSED_SIG
        ? viem.encodeFunctionData({ abi: chAbi, functionName: "setCreatePaused", args: [true] })
        : viem.encodeFunctionData({ abi: chAbi, functionName: "setMarketConfig", args: [args[0], cfg] });
      try {
        await client.call({ account: from, to, data });
        return { ok: true };
      } catch (error) {
        const r = revertName(error);
        return { ok: false, error: r.error ?? shortError(error) };
      }
    },
    simulateSettle: async (ch, id, { time } = {}) => {
      const data = viem.encodeFunctionData({ abi: chAbi, functionName: "settle", args: [id] });
      const params = [{ to: ch, data }, "latest"];
      if (time !== undefined) params.push({}, { time: viem.toHex(time) });
      let out;
      try {
        out = await client.request({ method: "eth_call", params });
      } catch (error) {
        const r = revertName(error);
        if (r.error !== null || r.data !== null) return { kind: "reverted", ...r };
        return { kind: "unsupported", message: shortError(error) };
      }
      try {
        return { kind: "returned", value: viem.decodeFunctionResult({ abi: chAbi, functionName: "settle", data: out }) };
      } catch (error) {
        return { kind: "unsupported", message: `settle returned undecodable data: ${shortError(error)}` };
      }
    },
  };
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch (error) {
    return { status: null, body: null, error: shortError(error) };
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const rpcEnv = argv.includes("--rpc-env") ? argv[argv.indexOf("--rpc-env") + 1] : "RH_RPC";
  return run(argv, env, {
    chain: viemChain,
    send: castSender({ rpc: env[rpcEnv], env }),
    fetchJson,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(line),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`${error instanceof Refusal ? "REFUSED" : "ERROR"}: ${error instanceof Refusal ? error.message : shortError(error)}`);
      process.exitCode = error instanceof Refusal ? EXIT.REFUSED : EXIT.ERROR;
    },
  );
}
