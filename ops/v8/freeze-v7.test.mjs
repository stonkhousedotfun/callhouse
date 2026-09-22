// node --test ops/v8/freeze-v7.test.mjs
//
// Drives ops/v8/freeze-v7.mjs against an in-memory v7 Clearinghouse. No chain, no signer, no network, no viem:
// every edge the script touches (chain reads, the cast send, the two health URLs) is injected.
//
// The rule these tests follow is the one the task states: a check must go RED when the thing it checks is
// ABSENT, not only when it is wrong. So most tests below delete a protected fact -- a send that "succeeds" and
// changes nothing, a market row with no `enabled`, a cranker that answers 200 for the wrong Clearinghouse -- and
// require a refusal.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXIT,
  Refusal,
  SET_CREATE_PAUSED_SIG,
  SET_MARKET_CONFIG_SIG,
  argvKeyMaterial,
  castSender,
  crankerIssues,
  freezeState,
  indexerIssues,
  planCalls,
  run,
  signerEnv,
  v7Targets,
} from "./freeze-v7.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEGACY = JSON.parse(readFileSync(path.join(HERE, "..", "markets", "v7-legacy.json"), "utf8"));
const RUNBOOK = readFileSync(path.join(HERE, "..", "runbooks", "v7-runoff.md"), "utf8");
const T = v7Targets(LEGACY);
const NVDA = T.markets[0].underlying;
const ORACLE = "0x1111111111111111111111111111111111111111";
const ENV = { RH_RPC: "http://rpc.invalid", V7_CRANKER_HEALTH_URL: "http://cranker.invalid/health", V7_INDEXER_HEALTH_URL: "http://indexer.invalid/v2/health" };
const EXEC = ["--execute", "--chain-id", "4663", "--guardian-account", "guardian-ks", "--admin-account", "admin-ks"];
const CHECK = ["--check", "--chain-id", "4663"];
const lc = (a) => a.toLowerCase();
const NOW = 1_790_100_000;

/** A v7 Clearinghouse + OrderBook, and the cast sender that mutates it the way the contract would. */
function fakeV7(opts = {}) {
  const cfg0 = { enabled: true, mintPaused: false, strikeTick: 100n, exerciseFeeBps: 25, oracle: ORACLE, mintFeePpm: 80 };
  const s = {
    block: T.deployBlock + 1_000_000n,
    time: NOW,
    createPaused: false,
    markets: { [lc(NVDA)]: { ...cfg0 } },
    tradingPaused: false,
    registered: [{ underlying: NVDA, config: { ...cfg0 }, blockNumber: T.deployBlock + 10n, transactionIndex: 0 }],
    pauses: [],
    configs: [],
    created: [
      { longId: 2n, underlying: NVDA, blockNumber: T.deployBlock + 20n, transactionIndex: 0 },
      { longId: 4n, underlying: NVDA, blockNumber: T.deployBlock + 21n, transactionIndex: 0 },
      { longId: 6n, underlying: NVDA, blockNumber: T.deployBlock + 22n, transactionIndex: 0 },
    ],
    series: new Map([
      [2n, { underlying: NVDA, expiry: NOW - 7 * 86400, settled: true }],
      [4n, { underlying: NVDA, expiry: NOW - 3600, settled: false }],
      [6n, { underlying: NVDA, expiry: NOW + 5 * 86400, settled: false }],
    ]),
    supply: new Map([[2n, 0n], [4n, 10n], [6n, 7n]]),
    mints: [],
    sends: [],
    reads: 0,
    ...opts.state,
  };
  const touch = () => {
    s.reads += 1;
  };
  const chain = {
    chainId: async () => (touch(), opts.rpcChainId ?? 4663),
    blockNumber: async () => (touch(), opts.staleHead ? T.deployBlock + 1_000_000n : s.block),
    headTimestamp: async () => (touch(), s.time),
    hasCode: async () => (touch(), true),
    createPaused: async () => (touch(), "createPaused" in (opts.override ?? {}) ? opts.override.createPaused : s.createPaused),
    market: async (_ch, u) => {
      touch();
      const row = s.markets[lc(u)];
      if (!row) return { enabled: false, mintPaused: false, strikeTick: 0n, exerciseFeeBps: 0, oracle: ORACLE, mintFeePpm: 0 };
      return opts.override?.market ? opts.override.market({ ...row }) : { ...row };
    },
    series: async (_ch, id) => (touch(), s.series.get(BigInt(id))),
    totalSupply: async (_ch, id) => (touch(), s.supply.get(BigInt(id)) ?? 0n),
    hasRole: async (_ch, role, account) => (touch(), opts.noRole === role ? false : role === "GUARDIAN_ROLE" ? lc(account) === lc(T.guardian) : lc(account) === lc(T.admin)),
    tradingPaused: async () => (touch(), s.tradingPaused),
    orderBookClearinghouse: async () => (touch(), T.clearinghouse),
    marketRegisteredLogs: async () => (touch(), s.registered),
    seriesCreatedLogs: async (_ch, from) => (touch(), s.created.filter((c) => c.blockNumber >= from)),
    mintLogs: async (_ch, from) => (touch(), s.mints.filter((m) => m.blockNumber >= from)),
    freezeEvents: async () => (touch(), opts.hideEvents ? { pauses: [], configs: [] } : { pauses: s.pauses, configs: s.configs }),
    simulate: async () => (touch(), opts.simulate ?? { ok: true }),
    simulateSettle: async (_ch, id, { time } = {}) => {
      touch();
      if (opts.settle) return opts.settle(BigInt(id), time);
      const row = s.series.get(BigInt(id));
      const at = time ?? s.time;
      if (at < row.expiry) return { kind: "reverted", error: "NotExpired" };
      return { kind: "returned", value: time === undefined };
    },
  };
  const send = ({ account, to, sig, args }) => {
    s.sends.push({ account, to, sig, args });
    if (opts.send) return opts.send({ account, to, sig, args }, s);
    s.block += 1n;
    const at = { blockNumber: s.block, transactionIndex: 0, transactionHash: `0x${String(s.sends.length).padStart(64, "0")}` };
    if (sig === SET_CREATE_PAUSED_SIG) {
      s.createPaused = true;
      s.pauses.push({ paused: true, ...at });
    } else if (sig === SET_MARKET_CONFIG_SIG) {
      const [enabled, , strikeTick, exerciseFeeBps, oracle, mintFeePpm] = args[1].slice(1, -1).split(",");
      const u = lc(args[0]);
      // Clearinghouse.setMarketConfig keeps the stored mintPaused whatever the call carries.
      s.markets[u] = { enabled: enabled === "true", mintPaused: s.markets[u].mintPaused, strikeTick: BigInt(strikeTick), exerciseFeeBps: Number(exerciseFeeBps), oracle, mintFeePpm: Number(mintFeePpm) };
      s.configs.push({ underlying: args[0], enabled: enabled === "true", config: { ...s.markets[u] }, ...at });
    }
    const from = account === "guardian-ks" ? T.guardian : account === "admin-ks" ? T.admin : "0x000000000000000000000000000000000000dEaD";
    return { status: "success", from, to, ...at };
  };
  return { s, chain, send };
}

function healthy(s, over = {}) {
  return async (url) => {
    if (url === ENV.V7_CRANKER_HEALTH_URL) {
      return over.cranker?.(s) ?? { status: 200, body: { status: "ok", mode: "cranker", checks: { heartbeat: true }, chain: { chainId: 4663, headBlock: String(s.block) }, contracts: { clearinghouse: T.clearinghouse }, signer: { address: T.cranker } } };
    }
    if (url === ENV.V7_INDEXER_HEALTH_URL) return over.indexer?.(s) ?? { status: 200, body: { status: "ok", block: String(s.block), lagSeconds: 1, interfaceVersion: 7 } };
    throw new Error(`unexpected URL ${url}`);
  };
}

/** Run the script; `fake` defaults to a live (unfrozen) v7 set. Returns { code, error, lines, fake }. */
async function go(argv, { fake = fakeV7(), env = ENV, health } = {}) {
  const lines = [];
  let t = 0;
  const io = {
    chain: () => fake.chain,
    send: fake.send,
    fetchJson: health ?? healthy(fake.s),
    sleep: async () => {},
    clock: () => (t += 10_000),
    log: (l) => lines.push(l),
  };
  try {
    return { code: await run(argv, env, io), error: null, lines, fake };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return { code: EXIT.REFUSED, error, lines, fake };
  }
}

/** A set that the owner has already frozen, events included. */
function frozenFake(opts = {}) {
  const f = fakeV7(opts);
  f.send({ account: "guardian-ks", to: T.clearinghouse, sig: SET_CREATE_PAUSED_SIG, args: ["true"] });
  const c = f.s.markets[lc(NVDA)];
  f.send({ account: "admin-ks", to: T.clearinghouse, sig: SET_MARKET_CONFIG_SIG, args: [NVDA, `(false,${c.mintPaused},${c.strikeTick},${c.exerciseFeeBps},${c.oracle},${c.mintFeePpm})`] });
  f.s.sends.length = 0;
  return f;
}

/* ------------------------------------------------------------------ dry run and refusals before any RPC */

test("the default is a dry run: no RPC read and no send", async () => {
  const r = await go([]);
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.fake.s.reads, 0, "a dry run read the chain");
  assert.equal(r.fake.s.sends.length, 0, "a dry run sent a transaction");
  assert.ok(r.lines.some((l) => l.startsWith("DRY RUN")));
});

test("--execute and --check both refuse without --chain-id, before any RPC", async () => {
  for (const argv of [["--execute", "--guardian-account", "g", "--admin-account", "a"], ["--check"]]) {
    const r = await go(argv);
    assert.equal(r.code, EXIT.REFUSED);
    assert.match(r.error.message, /requires --chain-id/);
    assert.equal(r.fake.s.reads, 0);
  }
});

test("a --chain-id that disagrees with the registry refuses before any RPC", async () => {
  const r = await go(["--execute", "--chain-id", "1", "--guardian-account", "g", "--admin-account", "a"]);
  assert.match(r.error.message, /disagrees with the registry/);
  assert.equal(r.fake.s.reads, 0);
});

test("an RPC on the wrong chain refuses and sends nothing", async () => {
  const r = await go(EXEC, { fake: fakeV7({ rpcChainId: 31337 }) });
  assert.match(r.error.message, /the RPC is chain 31337/);
  assert.equal(r.fake.s.sends.length, 0);
});

test("key material on argv is refused, and the refusal does not echo it", async () => {
  const key = `0x${"ab".repeat(32)}`;
  for (const argv of [[...EXEC, key], [...EXEC, "--private-key", key], ["--private-key=whatever"]]) {
    const r = await go(argv);
    assert.equal(r.code, EXIT.REFUSED);
    assert.match(r.error.message, /key material on the command line/);
    assert.ok(!r.error.message.includes("abab"), "the refusal printed the key");
    assert.equal(r.fake.s.reads, 0);
  }
  assert.deepEqual(argvKeyMaterial(EXEC), [], "an ordinary --execute argv is not key material");
});

test("the run-off URLs are required: without them a freeze that stopped a service would read as done", async () => {
  for (const drop of ["V7_CRANKER_HEALTH_URL", "V7_INDEXER_HEALTH_URL", "RH_RPC"]) {
    const env = { ...ENV };
    delete env[drop];
    const r = await go(EXEC, { env });
    assert.equal(r.code, EXIT.REFUSED, `${drop} missing was not refused`);
    assert.equal(r.fake.s.reads, 0);
  }
});

/* ------------------------------------------------------------------ the happy path */

test("execute: guardian pause first, then admin disable, then both read back, exit 0", async () => {
  const r = await go(EXEC);
  assert.equal(r.error, null, r.error?.message);
  assert.equal(r.code, EXIT.OK);
  assert.deepEqual(r.fake.s.sends.map((x) => [x.account, x.sig]), [["guardian-ks", SET_CREATE_PAUSED_SIG], ["admin-ks", SET_MARKET_CONFIG_SIG]]);
  assert.equal(r.fake.s.createPaused, true);
  assert.equal(r.fake.s.markets[lc(NVDA)].enabled, false);
  assert.ok(r.lines.some((l) => l.startsWith("READBACK PASS")));
  assert.ok(r.lines.some((l) => l.startsWith("FROZEN")));
});

test("the admin call carries the chain's config with ONLY enabled flipped", async () => {
  const f = fakeV7();
  f.s.markets[lc(NVDA)].mintPaused = true;
  const calls = planCalls(T, { createPaused: false, markets: [{ ...T.markets[0], cfg: f.s.markets[lc(NVDA)] }], tradingPaused: false });
  assert.deepEqual(calls[1].args, [NVDA, `(false,true,100,25,${ORACLE},80)`]);
  assert.equal(calls[0].from, T.guardian);
  assert.equal(calls[1].from, T.admin);
});

test("an already-frozen set sends nothing and still runs the readback and run-off checks", async () => {
  const r = await go(EXEC, { fake: frozenFake() });
  assert.equal(r.error, null, r.error?.message);
  assert.equal(r.fake.s.sends.length, 0);
  assert.ok(r.lines.some((l) => l.startsWith("NOTHING TO SEND")));
  assert.ok(r.lines.some((l) => l.startsWith("READBACK PASS")));
});

test("--check on a frozen set is read-only and green", async () => {
  const r = await go(CHECK, { fake: frozenFake() });
  assert.equal(r.error, null, r.error?.message);
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.fake.s.sends.length, 0);
});

/* ------------------------------------------------------------------ the readback goes red when its subject is absent */

test("PROVE-BY-BREAKING: a send that reports success but changes nothing is a READBACK FAILURE", async () => {
  // The protected fact deleted: the receipts are perfect, the chain never moved.
  const fake = fakeV7({ send: ({ account, to }, s) => ({ status: "success", from: account === "guardian-ks" ? T.guardian : T.admin, to, blockNumber: s.block, transactionIndex: 0, transactionHash: "0x01" }) });
  const r = await go(EXEC, { fake });
  assert.equal(r.code, EXIT.REFUSED);
  assert.match(r.error.message, /READBACK FAILED/);
  assert.match(r.error.message, /createPaused\(\) reads false, expected true/);
  assert.match(r.error.message, /enabled reads true, expected false/);
});

test("a readback is never taken from an RPC head behind the send block", async () => {
  const r = await go(EXEC, { fake: fakeV7({ staleHead: true }) });
  assert.equal(r.code, EXIT.REFUSED);
  assert.match(r.error.message, /the RPC head is still before block/);
  assert.ok(!r.lines.some((l) => l.startsWith("READBACK")), "a readback ran from behind the send");
});

test("half-applied: the admin send fails after the pause landed, and the refusal names the half", async () => {
  const f = fakeV7();
  const real = f.send;
  f.send = (call) => {
    if (call.sig === SET_MARKET_CONFIG_SIG) throw new Refusal("cast send exited 1");
    return real(call);
  };
  const r = await go(EXEC, { fake: f });
  assert.equal(r.code, EXIT.REFUSED);
  assert.match(r.error.message, /SEND FAILED after 1 successful call/);
  assert.match(r.error.message, /HALF-APPLIED: paused, but NVDA still enabled/);
  assert.match(r.error.message, /Abort points/);
});

test("--check reports a half-applied freeze as RED, never as done", async () => {
  const f = fakeV7();
  f.send({ account: "guardian-ks", to: T.clearinghouse, sig: SET_CREATE_PAUSED_SIG, args: ["true"] });
  const r = await go(CHECK, { fake: f });
  assert.equal(r.code, EXIT.REFUSED);
  assert.match(r.error.message, /HALF-APPLIED/);
  assert.equal(freezeState({ createPaused: false, markets: [{ ticker: "NVDA", cfg: { enabled: false } }] }).kind, "HALF-APPLIED");
});

test("a receipt signed by the wrong account is a failure even when the chain moved", async () => {
  const f = fakeV7();
  const real = f.send;
  f.send = (call) => ({ ...real(call), from: "0x000000000000000000000000000000000000dEaD" });
  const r = await go(EXEC, { fake: f });
  assert.match(r.error.message, /signed by 0x000000000000000000000000000000000000dEaD/);
});

test("a market row with no `enabled` field is refused, not read as false", async () => {
  const r = await go(CHECK, { fake: frozenFake({ override: { market: (row) => (delete row.enabled, row) } }) });
  assert.match(r.error.message, /has no enabled; the readback cannot see its subject/);
});

test("createPaused() returning nothing is refused, not read as false or true", async () => {
  const r = await go(CHECK, { fake: frozenFake({ override: { createPaused: undefined } }) });
  assert.match(r.error.message, /createPaused\(\): returned undefined, not a boolean/);
});

test("an unregistered market (strikeTick 0) is refused: wrong address or wrong chain", async () => {
  const f = fakeV7();
  delete f.s.markets[lc(NVDA)];
  const r = await go(EXEC, { fake: f });
  assert.match(r.error.message, /strikeTick is 0/);
  assert.equal(f.s.sends.length, 0);
});

test("a config write that moved another field fails the readback and names the field", async () => {
  const f = fakeV7();
  const real = f.send;
  f.send = (call) => {
    const out = real(call);
    if (call.sig === SET_MARKET_CONFIG_SIG) f.s.markets[lc(NVDA)].strikeTick = 500n;
    return out;
  };
  const r = await go(EXEC, { fake: f });
  assert.match(r.error.message, /strikeTick changed from 100 to 500/);
});

test("--check catches a disable that moved another field, from the chain's own event history", async () => {
  const f = frozenFake();
  f.s.configs.at(-1).config.exerciseFeeBps = 99;
  const r = await go(CHECK, { fake: f });
  assert.match(r.error.message, /moved exerciseFeeBps from 25 to 99/);
});

test("frozen flags with no freeze events is a blind scan, not a pass", async () => {
  const r = await go(CHECK, { fake: frozenFake({ hideEvents: true }) });
  assert.match(r.error.message, /no CreatePausedSet\(true\) event/);
  assert.match(r.error.message, /event scan is blind/);
});

test("mid-cycle: a series created after the pause landed fails the readback", async () => {
  const f = frozenFake();
  f.s.created.push({ longId: 8n, underlying: NVDA, blockNumber: f.s.pauses[0].blockNumber + 1n, transactionIndex: 0 });
  f.s.series.set(8n, { underlying: NVDA, expiry: NOW + 86400, settled: false });
  const r = await go(CHECK, { fake: f });
  assert.match(r.error.message, /series 8 was created in block .* after the pause landed/);
});

test("mid-cycle: a unit minted after the disable landed fails the readback (a short id maps to its long)", async () => {
  const f = frozenFake();
  f.s.mints.push({ id: 7n, blockNumber: f.s.configs[0].blockNumber + 2n, transactionIndex: 0 });
  const r = await go(CHECK, { fake: f });
  assert.match(r.error.message, /token 7 was minted in block .* after NVDA was disabled/);
});

test("a book the freeze paused is a readback failure: holders lose resale", async () => {
  const f = frozenFake();
  f.s.tradingPaused = true;
  const r = await go(CHECK, { fake: f });
  assert.match(r.error.message, /tradingPaused\(\) reads true/);
});

/* ------------------------------------------------------------------ preflight refusals, nothing sent */

test("an enabled registered market missing from waves.live is refused before any send", async () => {
  const f = fakeV7();
  const other = "0x2222222222222222222222222222222222222222";
  f.s.registered.push({ underlying: other, config: {}, blockNumber: T.deployBlock + 11n, transactionIndex: 0 });
  f.s.markets[lc(other)] = { enabled: true, mintPaused: false, strikeTick: 100n, exerciseFeeBps: 25, oracle: ORACLE, mintFeePpm: 80 };
  const r = await go(EXEC, { fake: f });
  assert.match(r.error.message, /registered market 0x2222.* is enabled and is not in waves.live/);
  assert.equal(f.s.sends.length, 0);
});

test("an empty MarketRegistered scan is refused as blind", async () => {
  const f = fakeV7();
  f.s.registered = [];
  const r = await go(EXEC, { fake: f });
  assert.match(r.error.message, /MarketRegistered scan .* found nothing/);
  assert.equal(f.s.sends.length, 0);
});

test("a role holder without its role, or a missing keystore name, is refused before any send", async () => {
  const noRole = await go(EXEC, { fake: fakeV7({ noRole: "DEFAULT_ADMIN_ROLE" }) });
  assert.match(noRole.error.message, /does not hold DEFAULT_ADMIN_ROLE/);
  assert.equal(noRole.fake.s.sends.length, 0);
  const noAccount = await go(["--execute", "--chain-id", "4663", "--guardian-account", "guardian-ks"]);
  assert.match(noAccount.error.message, /--admin-account <keystore name> is required/);
  assert.equal(noAccount.fake.s.sends.length, 0);
});

test("a call that would revert in simulation is refused before any send", async () => {
  const r = await go(EXEC, { fake: fakeV7({ simulate: { ok: false, error: "AccessControlUnauthorizedAccount" } }) });
  assert.match(r.error.message, /would revert \(AccessControlUnauthorizedAccount\); nothing was sent/);
  assert.equal(r.fake.s.sends.length, 0);
});

test("a dead run-off path BEFORE the freeze is refused, so the freeze is not blamed for it", async () => {
  const f = fakeV7();
  const r = await go(EXEC, { fake: f, health: healthy(f.s, { cranker: () => ({ status: 503, body: {} }) }) });
  assert.match(r.error.message, /run-off path is not alive before the freeze/);
  assert.equal(f.s.sends.length, 0);
});

/* ------------------------------------------------------------------ run-off: cranker, indexer, settle */

test("a cranker answering 200 for a different Clearinghouse is not the v7 cranker", async () => {
  const f = frozenFake();
  const r = await go(CHECK, {
    fake: f,
    health: healthy(f.s, { cranker: (s) => ({ status: 200, body: { mode: "cranker", checks: { heartbeat: true }, chain: { chainId: 4663, headBlock: String(s.block) }, contracts: { clearinghouse: "0x3333333333333333333333333333333333333333" }, signer: { address: T.cranker } } }) }),
  });
  assert.match(r.error.message, /RUN-OFF FAILED/);
  assert.match(r.error.message, /is not the v7 Clearinghouse/);
});

test("a cranker that has not read a block since the freeze fails after the liveness timeout", async () => {
  const f = frozenFake();
  const r = await go([...CHECK, "--liveness-timeout", "30"], {
    fake: f,
    health: healthy(f.s, { cranker: () => ({ status: 200, body: { mode: "cranker", checks: { heartbeat: true }, chain: { chainId: 4663, headBlock: String(T.deployBlock) }, contracts: { clearinghouse: T.clearinghouse }, signer: { address: T.cranker } } }) }),
  });
  assert.match(r.error.message, /it has not ticked since the freeze/);
});

test("cranker and indexer health bodies with the identity fields ABSENT are failures", () => {
  assert.ok(crankerIssues({ status: 200, body: {} }, T, 1n).length >= 5, "an empty cranker body must fail every identity check");
  assert.match(indexerIssues({ status: 200, body: { status: "ok", block: "5" } }, 1n).join("\n"), /interfaceVersion is undefined, expected 7/);
  assert.match(indexerIssues({ status: 200, body: { status: "ok", interfaceVersion: 7 } }, 1n).join("\n"), /it has indexed nothing/);
  assert.match(indexerIssues({ status: 200, body: { status: "lagging", block: "9", interfaceVersion: 7 } }, 1n).join("\n"), /expected "ok"/);
  assert.match(crankerIssues({ status: null, body: null, error: "fetch failed" }, T, 1n).join("\n"), /answered nothing \(fetch failed\)/);
});

test("an indexer that has not indexed past the freeze fails the run-off", async () => {
  const f = frozenFake();
  const r = await go([...CHECK, "--liveness-timeout", "30"], { fake: f, health: healthy(f.s, { indexer: () => ({ status: 200, body: { status: "ok", block: String(T.deployBlock), interfaceVersion: 7 } }) }) });
  assert.match(r.error.message, /has not indexed past the freeze/);
});

test("an empty SeriesCreated scan is blind, not 'nothing to settle'", async () => {
  const f = frozenFake();
  f.s.created = [];
  const r = await go(CHECK, { fake: f });
  assert.match(r.error.message, /SeriesCreated scan .* found nothing/);
});

test("settle reverting MarketDisabled means the freeze is blocking settlement", async () => {
  const r = await go(CHECK, { fake: frozenFake({ settle: () => ({ kind: "reverted", error: "MarketDisabled" }) }) });
  assert.match(r.error.message, /reverts MarketDisabled; the freeze is blocking settlement/);
});

test("an expired series whose oracle is still not final past the grace is stranded", async () => {
  const f = frozenFake({ settle: () => ({ kind: "returned", value: false }) });
  f.s.series.get(4n).expiry = NOW - 48 * 3600;
  const r = await go(CHECK, { fake: f });
  assert.match(r.error.message, /the series is stranded/);
});

test("a node that ignores the block-time override leaves future series UNPROVEN: exit 3, never 0", async () => {
  const f = frozenFake({ settle: (_id, time) => (time === undefined ? { kind: "returned", value: true } : { kind: "reverted", error: "NotExpired" }) });
  const r = await go(CHECK, { fake: f });
  assert.equal(r.error, null, r.error?.message);
  assert.equal(r.code, EXIT.UNPROVEN);
  assert.ok(r.lines.some((l) => l.startsWith("UNPROVEN")));
  assert.ok(!r.lines.some((l) => l.startsWith("FROZEN")), "an unproven run printed FROZEN");
});

/* ------------------------------------------------------------------ the signer edge */

test("castSender hands cast a keystore account, never a key, and never the RPC URL on argv", () => {
  let seen;
  const send = castSender({
    rpc: "https://rpc.example/secret-token",
    env: { PATH: "/bin", PRIVATE_KEY: "x", ETH_PRIVATE_KEY: "x", DEPLOYER_PRIVATE_KEY: "x", ETH_MNEMONIC: "x", ETH_PASSWORD: "x" },
    spawn: (cmd, argv, options) => {
      seen = { cmd, argv, env: options.env };
      return { status: 0, stdout: JSON.stringify({ status: "0x1", from: T.guardian, to: T.clearinghouse, transactionHash: "0x01", blockNumber: "0x10", transactionIndex: "0x0" }) };
    },
  });
  const receipt = send({ account: "guardian-ks", to: T.clearinghouse, sig: SET_CREATE_PAUSED_SIG, args: ["true"], chainId: 4663 });
  assert.equal(seen.cmd, "cast");
  assert.deepEqual(seen.argv.slice(0, 6), ["send", "--json", "--chain", "4663", "--account", "guardian-ks"]);
  assert.ok(!seen.argv.some((a) => /private-key|rpc-url|secret-token|mnemonic|password/.test(a)), `argv leaked: ${seen.argv.join(" ")}`);
  assert.equal(seen.env.ETH_RPC_URL, "https://rpc.example/secret-token");
  for (const k of ["PRIVATE_KEY", "ETH_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "ETH_MNEMONIC", "ETH_PASSWORD"]) assert.ok(!(k in seen.env), `${k} reached cast`);
  assert.equal(receipt.status, "success");
  assert.equal(receipt.blockNumber, 16n);
  assert.deepEqual(Object.keys(signerEnv({ A: "1", SEED_PHRASE: "x" }, "r")), ["A", "ETH_RPC_URL"]);
});

test("castSender treats a non-zero exit or an unparseable receipt as NOT landed", () => {
  const exit1 = castSender({ rpc: "r", env: {}, spawn: () => ({ status: 1, stdout: "" }) });
  assert.throws(() => exit1({ account: "a", to: T.clearinghouse, sig: SET_CREATE_PAUSED_SIG, args: ["true"], chainId: 4663 }), /NOT landed/);
  const junk = castSender({ rpc: "r", env: {}, spawn: () => ({ status: 0, stdout: "Enter password:" }) });
  assert.throws(() => junk({ account: "a", to: T.clearinghouse, sig: SET_CREATE_PAUSED_SIG, args: ["true"], chainId: 4663 }), /outcome is unknown/);
  const reverted = castSender({ rpc: "r", env: {}, spawn: () => ({ status: 0, stdout: JSON.stringify({ status: "0x0", blockNumber: "0x1" }) }) });
  assert.equal(reverted({ account: "a", to: T.clearinghouse, sig: SET_CREATE_PAUSED_SIG, args: ["true"], chainId: 4663 }).status, "reverted");
});

/* ------------------------------------------------------------------ targets: the V1 trap and the v7 pins */

test("targets come from v2.contracts.clearinghouse, which is FreezeV7's pinned v7 Clearinghouse, not the V1 one", () => {
  // Mirrored from callhouse-contracts script/v2/FreezeV7.s.sol:153-161 (CLEARINGHOUSE, ORDER_BOOK, NVDA, GUARDIAN,
  // ADMIN) and :166 (DEPLOY_BLOCK). If the registry and the contracts-side tool ever disagree, one of them is aimed
  // at the wrong contract, and neither side may be "fixed" by editing it to match the other.
  assert.equal(T.clearinghouse, "0x22dEf851cD1a3B04Ad7d232bE786d76E6944d424");
  assert.equal(T.orderBook, "0x9fcAe743C3fA0aEC7DB9b1d01e86464b85759942");
  assert.equal(NVDA, "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC");
  assert.equal(T.guardian, "0x29741A8d283a253E8Ce10aDfd04C6507438b6F39");
  assert.equal(T.admin, "0xEb82c3D0F89d47453F94f0C2b2a2752e27a19d9b");
  assert.equal(T.deployBlock, 65_780_341n);
  assert.notEqual(lc(T.clearinghouse), lc(LEGACY.shared.clearinghouse), "the V1 Clearinghouse is shared.clearinghouse");
  assert.deepEqual(T.markets.map((m) => m.ticker), ["NVDA"]);
});

test("v7Targets refuses a non-v7 registry and an ambiguous clearinghouse", () => {
  const v8 = structuredClone(LEGACY);
  v8.v2.interfaceVersion = 8;
  assert.throws(() => v7Targets(v8), /expected 7/);
  const trap = structuredClone(LEGACY);
  trap.v2.contracts.clearinghouse = trap.shared.clearinghouse;
  assert.throws(() => v7Targets(trap), /V1 Clearinghouse/);
  const noLive = structuredClone(LEGACY);
  noLive.waves.live = [];
  assert.throws(() => v7Targets(noLive), /waves.live is empty/);
});

/* ------------------------------------------------------------------ the runbook */

test("the runbook documents the script, a FAILED freeze, and how to tell half-applied from clean", () => {
  assert.match(RUNBOOK, /ops\/v8\/freeze-v7\.mjs/);
  assert.match(RUNBOOK, /HALF-APPLIED/);
  assert.match(RUNBOOK, /exit(s)? 3|exit code 3/i);
  assert.match(RUNBOOK, /UNPROVEN/);
  const blocks = [...RUNBOOK.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => b.includes("freeze-v7.mjs"));
  assert.ok(blocks.length > 0, "no command block runs the script");
  for (const b of blocks) {
    assert.ok(!/--private-key|0x[0-9a-fA-F]{64}/.test(b), `a freeze-v7 command carries key material:\n${b}`);
    assert.ok(!/--rpc-url|https?:\/\//.test(b), `a freeze-v7 command puts a URL on argv:\n${b}`);
    if (/--execute/.test(b)) assert.match(b, /--chain-id 4663/, `--execute without the chain id:\n${b}`);
  }
});
