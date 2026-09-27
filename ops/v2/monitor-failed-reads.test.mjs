/**
 * node --test ops/v2/monitor-failed-reads.test.mjs
 *
 * A read that FAILED (a 429, a dropped connection) is a read that did not happen: it never clears an alert,
 * passes a check or shows a made-up value. For each check the bug hunt fixed, a whole pass in the House-check style opens
 * the alert, fails ONLY the read under test by transport (the alert stays open and the check is incomplete), then reads
 * it clean (the alert resolves). Every other read in the pass answers as a healthy deployment does, so the one failure
 * is the only thing that could flip the verdict. The House check has its own and is not repeated here.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";

import {
  DEFAULTS,
  KINDS,
  MAX_HOOK_FEE_BPS,
  SNAPSHOT_GRACE,
  applyFlywheelLogs,
  checkBuyback,
  checkManagerWiring,
  checkRoundJumps,
  checkRoute,
  checkRouteDecode,
  checkSafeThreshold,
  checkSplitter,
  checkTokenPool,
  expectedPinnedConfig,
  loadViem,
  markDelivered,
  parseRegistry,
  reconcile,
  repriceFindings,
  runOnce,
  v4PoolId,
} from "./monitor.mjs";
import { C, FakeChain, SRC, addr, defaultRead, fakeViem, market, options, rawLog, tmp, transportError, writeRegistry } from "./fake-chain.mjs";

const onChain = (chain) => ({ viem: fakeViem(chain), nowMs: () => chain.head.timestamp * 1000 });
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const scratch = (prefix) => {
  const d = tmp(prefix);
  dirs.push(d);
  return d;
};
const stateOf = (dir) => JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));
const isOpen = (dir, id) => stateOf(dir).alerts[id] !== undefined;
const lc = (a) => a.toLowerCase();
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const same = (a, b) => lc(String(a)) === lc(String(b));
const SERIES_CREATED =
  "event SeriesCreated(uint256 indexed longId, address indexed underlying, bool isPut, uint128 strike, uint40 expiry, address oracle, uint16 exerciseFeeBps, uint32 mintFeePpm)";

/** The three passes every test below makes: opened, then the one read failed by transport, then read clean. */
async function openKeepResolve({ dir, chain, opts, id, check, open, fail, clean, advance = 120 }) {
  open();
  const r1 = await runOnce(opts, onChain(chain));
  assert.ok(isOpen(dir, id), `opened: ${id} not in ${JSON.stringify(Object.keys(stateOf(dir).alerts))}; ${check}: ${JSON.stringify(r1.checks[check])}`);
  assert.equal(r1.checks[check].status, "ok", `the clean pass completes ${check}: ${JSON.stringify(r1.checks[check])}`);
  chain.setHead(chain.head.number + 100n, chain.head.timestamp + advance);
  fail();
  const r2 = await runOnce(opts, onChain(chain));
  assert.equal(r2.checks[check].status, "incomplete", `a transport failure leaves ${check} incomplete: ${JSON.stringify(r2.checks[check])}`);
  assert.ok(isOpen(dir, id), `a transport failure never resolves ${id}`);
  assert.ok(!r2.findings.some((f) => f.kind === "v2_mon_resolved" && f.key.startsWith(id.split(":")[0])), "and nothing is sent as resolved");
  chain.setHead(chain.head.number + 100n, chain.head.timestamp + advance);
  clean();
  const r3 = await runOnce(opts, onChain(chain));
  assert.equal(r3.checks[check].status, "ok", `read clean, ${check} completes: ${JSON.stringify(r3.checks[check])}`);
  assert.ok(!isOpen(dir, id), `read clean and healthy, ${id} resolves`);
  return { r1, r2, r3 };
}

/** A FakeChain with Multicall3: a call flagged by `reject` fails as viem reports a REJECTED aggregate3 batch (the
 *  transport error on every call of the batch, viem 2.56.3 actions/public/multicall.js); anything else is read. */
class MulticallChain extends FakeChain {
  constructor(o) {
    super(o);
    this.reject = () => false;
  }
  client() {
    const c = super.client();
    const chain = this;
    c.multicall = async ({ contracts }) =>
      Promise.all(
        contracts.map(async (x) => {
          if (chain.reject(x)) return { status: "failure", error: transportError(), result: undefined };
          try {
            return { status: "success", result: await c.readContract(x) };
          } catch (error) {
            return { status: "failure", error, result: undefined };
          }
        }),
      );
    return c;
  }
}

// ---------------------------------------------------------------------------------------------- roller

describe("roller: a failed spot or witness read never clears an overtaken ask", () => {
  const W = addr(0xf);
  const U2 = addr(0xa001);
  const world = (ChainClass = FakeChain, multicall = false) => {
    const dir = scratch("monitor-1019-roller-");
    const file = writeRegistry(dir, { markets: [market("NVDA", 1)], deployBlock: 1000 });
    if (multicall) {
      const reg = JSON.parse(readFileSync(file, "utf8"));
      reg.shared.multicall3 = addr(0xca11);
      writeFileSync(file, JSON.stringify(reg));
    }
    const now = 1_790_000_000;
    const expiry = now + 3 * 86_400;
    const chain = new ChainClass({ head: 20_000n, timestamp: now });
    chain.logs.push(
      rawLog("event Rolled(address indexed writer, address indexed underlying, uint256 longId, uint256 orderId, uint128 strike, uint40 expiry, uint128 price, uint64 units)", { writer: W, underlying: U2, longId: 84n, orderId: 7n, strike: 200_000_000n, expiry, price: 5n, units: 500n }, { address: C.autoRoller, blockNumber: 5000 }),
    );
    const w = { spot: () => [true, 210_000_000n, BigInt(chain.head.timestamp)], witness: null };
    chain.read = (address, fn, args) => {
      switch (fn) {
        case "position":
          return [84n, 7n, expiry];
        case "getOrders":
          return args[0].map(() => ({ maker: W, longId: 84n, kind: 2, price: 5n, units: 500n, filled: 0n, validUntil: expiry, cancelled: false }));
        case "series":
          return { underlying: U2, isPut: false, expiry: BigInt(expiry), strike: 200_000_000n, oracle: C.settlementOracle, exerciseFeeBps: 30, settled: false, settlementPrice: 0n, longPayoutPerUnit: 0n, feePerUnit: 0n, shortPayoutPerUnit: 0n, mintFeePpm: 80, mintFeesHeld: 0n };
        case "trySpot":
          return w.spot();
        case "settlementConfig":
          return w.witness === null ? defaultRead(chain, address, fn, args) : [true, [SRC.chainlink, SRC.univ3], 150, 21600, 3600];
        case "latest":
          if (w.witness !== null && same(address, SRC.univ3)) return w.witness();
          return defaultRead(chain, address, fn, args);
        default:
          return defaultRead(chain, address, fn, args);
      }
    };
    return { dir, chain, opts: options(dir, file), w, id: `v2_mon_roller_ask_overtaken:${lc(W)}:${lc(U2)}`, key: `${W}:${U2}` };
  };
  const started = async (x) => {
    // The first pass over the strike only starts the clock; the page opens on the next.
    await runOnce(x.opts, onChain(x.chain));
    x.chain.setHead(x.chain.head.number + 100n, x.chain.head.timestamp + 120);
  };

  test("trySpot fails by transport: the page and its clock stay; read clean below the strike, it resolves", async () => {
    const x = world();
    await started(x);
    const since = stateOf(x.dir).scan.rollerStale[x.key].since;
    await openKeepResolve({
      ...x,
      check: "roller",
      open: () => {},
      fail: () => {
        x.w.spot = () => {
          throw transportError();
        };
      },
      clean: () => {
        assert.equal(stateOf(x.dir).scan.rollerStale[x.key].since, since, "the unread pass kept the clock where it was");
        x.w.spot = () => [true, 190_000_000n, BigInt(x.chain.head.timestamp)];
      },
    });
  });

  test("a trySpot that REVERTS is the contract's own 'no fresh spot' (cancelStale cannot fire either): still judged, not unread", async () => {
    const x = world();
    await started(x);
    await runOnce(x.opts, onChain(x.chain));
    assert.ok(isOpen(x.dir, x.id));
    x.chain.setHead(x.chain.head.number + 100n, x.chain.head.timestamp + 120);
    x.w.spot = () => {
      const e = new Error("The contract function \"trySpot\" reverted: execution reverted");
      e.name = "ContractFunctionRevertedError";
      throw e;
    };
    const r = await runOnce(x.opts, onChain(x.chain));
    assert.equal(r.checks.roller.status, "ok");
    assert.ok(!isOpen(x.dir, x.id), "as before T-OP-1019: a reverting spot is not an overtaken ask");
  });

  test("the witness (source 1 latest) fails by transport while spot is short of the strike: kept; read clean, it resolves", async () => {
    const x = world();
    x.w.spot = () => [true, 190_000_000n, BigInt(x.chain.head.timestamp)]; // short of the strike: the witness decides
    x.w.witness = () => [true, 210_000_000n, BigInt(x.chain.head.timestamp)];
    await started(x);
    await openKeepResolve({
      ...x,
      check: "roller",
      open: () => {},
      fail: () => {
        x.w.witness = () => {
          throw transportError();
        };
      },
      clean: () => {
        x.w.witness = () => [true, 190_000_000n, BigInt(x.chain.head.timestamp)];
      },
    });
  });

  test("the witness's settlementConfig fails by transport while spot is short of the strike: kept, the clock stays; read clean, it resolves", async () => {
    const x = world();
    x.w.spot = () => [true, 190_000_000n, BigInt(x.chain.head.timestamp)]; // short of the strike: the witness decides
    x.w.witness = () => [true, 210_000_000n, BigInt(x.chain.head.timestamp)];
    const cfg = { fail: false };
    const read = x.chain.read;
    x.chain.read = (address, fn, args) => {
      if (fn === "settlementConfig" && cfg.fail) throw transportError();
      return read(address, fn, args);
    };
    await started(x);
    const since = stateOf(x.dir).scan.rollerStale[x.key].since;
    await openKeepResolve({
      ...x,
      check: "roller",
      open: () => {},
      fail: () => {
        cfg.fail = true; // only settlementConfig: spot answers, and latest() would say overtaken if it were reached
      },
      clean: () => {
        assert.equal(stateOf(x.dir).scan.rollerStale[x.key].since, since, "the unread pass kept the clock where it was");
        cfg.fail = false;
        x.w.witness = () => [true, 190_000_000n, BigInt(x.chain.head.timestamp)];
      },
    });
  });

  test("a settlementConfig that REVERTS is 'no witness', as _tryWitness sees it: judged, not unread, and the page resolves", async () => {
    const x = world();
    x.w.spot = () => [true, 190_000_000n, BigInt(x.chain.head.timestamp)];
    x.w.witness = () => [true, 210_000_000n, BigInt(x.chain.head.timestamp)];
    const cfg = { revert: false };
    const read = x.chain.read;
    x.chain.read = (address, fn, args) => {
      if (fn === "settlementConfig" && cfg.revert) {
        const e = new Error('The contract function "settlementConfig" reverted: execution reverted');
        e.name = "ContractFunctionRevertedError";
        throw e;
      }
      return read(address, fn, args);
    };
    await started(x);
    await runOnce(x.opts, onChain(x.chain));
    assert.ok(isOpen(x.dir, x.id), "premise: the witness shows the ask overtaken and the page is open");
    x.chain.setHead(x.chain.head.number + 100n, x.chain.head.timestamp + 120);
    cfg.revert = true;
    const r = await runOnce(x.opts, onChain(x.chain));
    assert.equal(r.checks.roller.status, "ok", JSON.stringify(r.checks.roller));
    assert.ok(!isOpen(x.dir, x.id), "no witness and a spot short of the strike: cancelStale cannot fire, so neither does the page");
    assert.equal(stateOf(x.dir).scan.rollerStale[x.key], undefined, "and its clock is cleared");
  });

  test("Multicall3: a REJECTED batch carrying trySpot is a transport failure, never 'no such view' (readMany): kept, then resolved", async () => {
    const x = world(MulticallChain, true);
    await started(x);
    await openKeepResolve({
      ...x,
      check: "roller",
      open: () => {},
      fail: () => {
        x.chain.reject = (call) => call.functionName === "trySpot";
      },
      clean: () => {
        x.chain.reject = () => false;
        x.w.spot = () => [true, 190_000_000n, BigInt(x.chain.head.timestamp)];
      },
    });
  });
});

// ---------------------------------------------------------------------------------------------- tvl

describe("tvl: a failed balance or supply read never resolves the audit trigger", () => {
  const world = () => {
    const dir = scratch("monitor-1019-tvl-");
    const file = writeRegistry(dir, { markets: [market("NVDA", 1)], deployBlock: 1000 });
    const chain = new FakeChain({ head: 20_000n });
    const w = { balance: () => undefined };
    chain.read = (address, fn, args) => {
      if (fn === "balanceOf") {
        const v = w.balance(args[0]);
        if (v !== undefined) return v;
      }
      return defaultRead(chain, address, fn, args);
    };
    // 1,000,000 USDG: the two holders' default 1,000,000 USDG each is past it.
    return { dir, chain, opts: options(dir, file, ["--threshold", "auditTriggerUsdg=1000000000000"]), w, id: "v2_mon_tvl_audit_trigger:full" };
  };

  test("the MakerVault's USDG balance fails by transport: :full stays open (a :fault is paged beside it); read clean and small, it resolves", async () => {
    const x = world();
    const { r2 } = await openKeepResolve({
      ...x,
      check: "tvl",
      open: () => {},
      fail: () => {
        x.w.balance = (holder) => {
          if (same(holder, C.makerVault)) throw transportError();
          return undefined;
        };
      },
      clean: () => {
        x.w.balance = () => 1n;
      },
    });
    assert.ok(r2.findings.some((f) => f.id === "v2_mon_tvl_audit_trigger:fault"), "the unread total is still said, as the :fault finding");
  });

  test("USDG totalSupply fails by transport with every balance read: :full stays open; read clean, it resolves", async () => {
    const x = world();
    const supply = { fail: false };
    const base = x.chain.read;
    x.chain.read = (address, fn, args) => {
      if (fn === "totalSupply" && supply.fail) throw transportError();
      return base(address, fn, args);
    };
    await openKeepResolve({
      ...x,
      check: "tvl",
      open: () => {},
      fail: () => {
        supply.fail = true;
      },
      clean: () => {
        supply.fail = false;
        x.w.balance = () => 1n;
      },
    });
  });
});

// ---------------------------------------------------------------------------------------------- rent

describe("rent: a Clearinghouse.market() row that failed is not 'not registered'", () => {
  test("market(NVDA) fails by transport: v2_mon_mint_fee_zero stays open; read clean with a rate, it resolves", async () => {
    const dir = scratch("monitor-1019-rent-");
    const NV = market("NVDA", 1);
    const file = writeRegistry(dir, { markets: [NV], deployBlock: 1000 });
    const chain = new FakeChain({ head: 20_000n });
    const w = { row: () => ({ enabled: true, mintPaused: false, strikeTick: 1n, exerciseFeeBps: 30, oracle: C.settlementOracle, mintFeePpm: 0 }) };
    chain.read = (address, fn, args) => (fn === "market" && same(args[0], NV.asset) ? w.row() : defaultRead(chain, address, fn, args));
    await openKeepResolve({
      dir,
      chain,
      opts: options(dir, file),
      id: `v2_mon_mint_fee_zero:${lc(NV.asset)}:chain`,
      check: "rent",
      open: () => {},
      fail: () => {
        w.row = () => {
          throw transportError();
        };
      },
      clean: () => {
        w.row = () => ({ enabled: true, mintPaused: false, strikeTick: 1n, exerciseFeeBps: 30, oracle: C.settlementOracle, mintFeePpm: 80 });
      },
    });
  });
});

// ---------------------------------------------------------------------------------------------- pools

describe("pools: the source's pools() and observeWindow() are unread when they fail", () => {
  const POOL = addr(0x9001);
  const world = () => {
    const dir = scratch("monitor-1019-pools-");
    const file = writeRegistry(dir, { markets: [market("NVDA", 1, { pool: POOL, floor: "1000" })], deployBlock: 1000 });
    const chain = new FakeChain({ head: 20_000n });
    const w = { pools: () => [POOL, false, 18, 300, 1000n], observe: () => [true, 1n, 0, 10n ** 20n] };
    chain.read = (address, fn, args) => {
      if (same(address, SRC.univ3) && fn === "pools") return w.pools();
      if (same(address, SRC.univ3) && fn === "observeWindow") return w.observe();
      if (same(address, POOL) && fn === "liquidity") return 10n ** 20n;
      return defaultRead(chain, address, fn, args);
    };
    return { dir, chain, opts: options(dir, file), w };
  };

  test("pools() fails by transport: an open v2_mon_pool_wiring stays; read clean and wired right, it resolves", async () => {
    const x = world();
    await openKeepResolve({
      ...x,
      id: `v2_mon_pool_wiring:${lc(market("NVDA", 1).asset)}:pool`,
      check: "pools",
      open: () => {
        x.w.pools = () => [addr(0x9002), false, 18, 300, 1000n]; // the source trades another pool
      },
      fail: () => {
        x.w.pools = () => {
          throw transportError();
        };
      },
      clean: () => {
        x.w.pools = () => [POOL, false, 18, 300, 1000n];
      },
    });
  });

  test("observeWindow() fails by transport behind a deep head: an open v2_mon_pool_liquidity_low stays; read clean and deep, it resolves", async () => {
    const x = world();
    await openKeepResolve({
      ...x,
      id: `v2_mon_pool_liquidity_low:${lc(POOL)}`,
      check: "pools",
      open: () => {
        x.w.observe = () => [false, 0n, 0, 5n]; // the window's harmonic mean is under the floor; the head is deep
      },
      fail: () => {
        x.w.observe = () => {
          throw transportError();
        };
      },
      clean: () => {
        x.w.observe = () => [true, 1n, 0, 10n ** 20n];
      },
    });
  });
});

// ---------------------------------------------------------------------------------------------- settlement

describe("settlement: an unread snapshot or pinned list never clears a launch veto", () => {
  const NV = market("NVDA", 1);
  const world = () => {
    const dir = scratch("monitor-1019-settle-");
    const file = writeRegistry(dir, { markets: [NV], deployBlock: 1000 });
    const now = 1_790_000_000;
    const E = now - SNAPSHOT_GRACE - 3000; // past the snapshot grace, not finalized
    const chain = new FakeChain({ head: 20_000n, timestamp: now });
    chain.logs.push(rawLog(SERIES_CREATED, { longId: 0x2468n, underlying: NV.asset, isPut: false, strike: 200_000_000n, expiry: E, oracle: C.settlementOracle, exerciseFeeBps: 30, mintFeePpm: 80 }, { address: C.clearinghouse, blockNumber: 5000 }));
    // The pool is in the list PINNED for E; today's marketConfig (the fake's default) lists Chainlink alone.
    const w = { snap: () => [0n, 0, 0], cfg: () => [true, [SRC.chainlink, SRC.univ3], 150, 21600, 3600] };
    chain.read = (address, fn, args) => {
      if (fn === "openInterest") return 500n;
      if (fn === "settlementInfo") return [1, 0n, 0, false, false, false]; // Pending, not captured
      if (fn === "settlementConfig") return w.cfg();
      if (fn === "snapshots") return w.snap();
      if (fn === "windowPrice") return [true, 100_00000000n]; // Chainlink prices the window: pool-leg-denied
      return defaultRead(chain, address, fn, args);
    };
    return { dir, chain, opts: options(dir, file, ["--launch", "NVDA"]), w, id: `v2_mon_guardian_veto_due:${lc(NV.asset)}:${E}:pool` };
  };

  test("UniV3TwapSource.snapshots fails by transport: the launch veto page stays; read clean and recorded, it resolves", async () => {
    const x = world();
    const { r2 } = await openKeepResolve({
      ...x,
      check: "settlement",
      open: () => {},
      fail: () => {
        x.w.snap = () => {
          throw transportError();
        };
      },
      clean: () => {
        x.w.snap = () => [100_00000000n, 0, x.chain.head.timestamp - 60];
      },
    });
    assert.ok(r2.notes.some((n) => /settlement: UniV3TwapSource\.snapshots\(NVDA/.test(n)), JSON.stringify(r2.notes));
  });

  test("settlementConfig (the pinned list) fails by transport, and today's list has no pool: the veto page stays; read clean, it resolves", async () => {
    const x = world();
    await openKeepResolve({
      ...x,
      check: "settlement",
      open: () => {},
      fail: () => {
        x.w.cfg = () => {
          throw transportError();
        };
      },
      clean: () => {
        x.w.cfg = () => [true, [SRC.chainlink, SRC.univ3], 150, 21600, 3600];
        x.w.snap = () => [100_00000000n, 0, x.chain.head.timestamp - 60];
      },
    });
  });
});

// ---------------------------------------------------------------------------------------------- feedgap

describe("feedgap: an unread pinned feed is not the market's feed", () => {
  const NV = market("NVDA", 1);
  const PINNED = addr(0xbee1);
  const FRESH = addr(0xbee2);
  const world = () => {
    const dir = scratch("monitor-1019-feedgap-");
    const file = writeRegistry(dir, { markets: [NV], deployBlock: 1000 });
    const now = 1_790_000_000;
    const E = now + 3600; // ahead, inside feedGapLeadS (3 h)
    const chain = new FakeChain({ head: 20_000n, timestamp: now });
    chain.logs.push(rawLog(SERIES_CREATED, { longId: 0x2468n, underlying: NV.asset, isPut: false, strike: 200_000_000n, expiry: E, oracle: C.settlementOracle, exerciseFeeBps: 30, mintFeePpm: 80 }, { address: C.clearinghouse, blockNumber: 5000 }));
    // E settles on the PINNED feed, silent for 10 days; the market's feed today is another one that just printed.
    const w = { pinnedFeeds: () => [PINNED, 7200, 0, true], pinnedPools: () => [ZERO_ADDR, false, 18, 300, false, 0n], pinnedAt: now - 10 * 86_400 };
    chain.read = (address, fn, args) => {
      if (same(address, SRC.chainlink) && fn === "pinnedFeeds") return w.pinnedFeeds();
      if (same(address, SRC.chainlink) && fn === "feeds") return [FRESH, 7200, 0];
      if (same(address, SRC.univ3) && fn === "pinnedPools") return w.pinnedPools();
      if (same(address, PINNED) && fn === "latestRoundData") return [1n, 100_00000000n, 0n, BigInt(w.pinnedAt), 1n];
      if (same(address, FRESH) && fn === "latestRoundData") return [1n, 100_00000000n, 0n, BigInt(chain.head.timestamp), 1n];
      return defaultRead(chain, address, fn, args);
    };
    return { dir, chain, opts: options(dir, file, ["--launch", "NVDA"]), w, id: `v2_mon_feed_expiry_gap:${lc(NV.asset)}:${E}` };
  };

  test("ChainlinkFeedSource.pinnedFeeds fails by transport: judged on the fresh market feed it would vanish, so it stays; read clean after a print, it resolves", async () => {
    const x = world();
    await openKeepResolve({
      ...x,
      check: "feedgap",
      advance: 60,
      open: () => {},
      fail: () => {
        x.w.pinnedFeeds = () => {
          throw transportError();
        };
      },
      clean: () => {
        x.w.pinnedFeeds = () => [PINNED, 7200, 0, true];
        x.w.pinnedAt = x.chain.head.timestamp; // the pinned feed printed
      },
    });
  });

  test("UniV3TwapSource.pinnedPools fails by transport: the gap stays open and the check is incomplete; read clean, it completes", async () => {
    const x = world();
    await openKeepResolve({
      ...x,
      check: "feedgap",
      advance: 60,
      open: () => {},
      fail: () => {
        x.w.pinnedPools = () => {
          throw transportError();
        };
      },
      clean: () => {
        x.w.pinnedPools = () => [ZERO_ADDR, false, 18, 300, false, 0n];
        x.w.pinnedAt = x.chain.head.timestamp;
      },
    });
  });
});

// ---------------------------------------------------------------------------------------------- feeds: pinned feeds

describe("feeds: a feed pinned for an open expiry is unread when its reads fail", () => {
  const NV = market("NVDA", 1);
  const PINNED = addr(0xbee3);
  const world = () => {
    const dir = scratch("monitor-1019-feeds-");
    const file = writeRegistry(dir, { markets: [NV], deployBlock: 1000 });
    const now = 1_790_000_000;
    const E = now + 5 * 86_400;
    const chain = new FakeChain({ head: 20_000n, timestamp: now });
    chain.logs.push(rawLog(SERIES_CREATED, { longId: 0x2468n, underlying: NV.asset, isPut: false, strike: 200_000_000n, expiry: E, oracle: C.settlementOracle, exerciseFeeBps: 30, mintFeePpm: 80 }, { address: C.clearinghouse, blockNumber: 5000 }));
    const w = { pinnedFeeds: () => [PINNED, 7200, 0, true], ac: () => addr(0xacc0) };
    chain.read = (address, fn, args) => {
      if (same(address, SRC.chainlink) && fn === "pinnedFeeds") return w.pinnedFeeds();
      if (same(address, PINNED) && fn === "accessController") return w.ac();
      return defaultRead(chain, address, fn, args);
    };
    return { dir, chain, opts: options(dir, file), w, id: `v2_mon_feed_access_controller:${lc(PINNED)}` };
  };

  test("the pinned feed's accessController() fails by transport: its open page stays; read clean and ungated, it resolves", async () => {
    const x = world();
    await openKeepResolve({
      ...x,
      check: "feeds",
      open: () => {},
      fail: () => {
        x.w.ac = () => {
          throw transportError();
        };
      },
      clean: () => {
        x.w.ac = () => ZERO_ADDR;
      },
    });
  });

  test("pinnedFeeds(asset, E) fails by transport: the pinned feed's open page stays; read clean and ungated, it resolves", async () => {
    const x = world();
    await openKeepResolve({
      ...x,
      check: "feeds",
      open: () => {},
      fail: () => {
        x.w.pinnedFeeds = () => {
          throw transportError();
        };
      },
      clean: () => {
        x.w.pinnedFeeds = () => [PINNED, 7200, 0, true];
        x.w.ac = () => ZERO_ADDR;
      },
    });
  });
});

// ---------------------------------------------------------------------------------------------- scope

describe("scope: a registry market whose Clearinghouse row could not be read keeps its alerts", () => {
  test("TSLA (planned in the registry, registered on chain): its market() fails by transport, feeds is incomplete and its page stays; read clean, it resolves", async () => {
    const dir = scratch("monitor-1019-scope-");
    const TS = market("TSLA", 2, { status: "planned" });
    const file = writeRegistry(dir, { markets: [market("NVDA", 1), TS], deployBlock: 1000 });
    const chain = new FakeChain({ head: 20_000n });
    const w = { row: () => ({ enabled: true, mintPaused: false, strikeTick: 1n, exerciseFeeBps: 30, oracle: C.settlementOracle, mintFeePpm: 80 }), ac: () => addr(0xacc0) };
    chain.read = (address, fn, args) => {
      if (fn === "market" && same(args[0], TS.asset)) return w.row();
      if (same(address, TS.feed) && fn === "accessController") return w.ac();
      return defaultRead(chain, address, fn, args);
    };
    const { r2 } = await openKeepResolve({
      dir,
      chain,
      opts: options(dir, file),
      id: `v2_mon_feed_access_controller:${lc(TS.feed)}`,
      check: "feeds",
      open: () => {},
      fail: () => {
        w.row = () => {
          throw transportError();
        };
      },
      clean: () => {
        w.row = () => ({ enabled: true, mintPaused: false, strikeTick: 1n, exerciseFeeBps: 30, oracle: C.settlementOracle, mintFeePpm: 80 });
        w.ac = () => ZERO_ADDR;
      },
    });
    for (const c of ["tokens", "rent"]) assert.equal(r2.checks[c].status, "incomplete", `${c} walks the same scope: ${JSON.stringify(r2.checks[c])}`);
  });

  // Divergence, pools and pricing walk the same scope. Each world below makes its check run for real
  // (a calibrated band on an open market, a pool, a pricing service), and the control pass shows it completes "ok", so
  // the unread market() row is the only thing that can make it incomplete in the second pass.
  const POOL = addr(0x9001);
  const pricingService = async (url) => {
    const health = new URL(url).pathname === "/health";
    const body = health ? { status: "ok", service: "callhouse-pricing", settings: { maxChainAgeS: 1800 }, chains: {} } : { reason: "not-found" };
    return new Response(JSON.stringify(body), { status: health ? 200 : 404, headers: { "content-type": "application/json" } });
  };
  const poolReads = (address, fn) => {
    if (same(address, SRC.univ3) && fn === "pools") return [POOL, false, 18, 300, 1000n];
    if (same(address, SRC.univ3) && fn === "observeWindow") return [true, 1n, 0, 10n ** 20n];
    if (same(address, POOL) && fn === "liquidity") return 10n ** 20n;
    return undefined;
  };
  const worlds = {
    // A divergence band needs a registry pool and both price sources.
    divergence: {
      nvda: market("NVDA", 1, { pool: POOL, floor: "1000" }),
      extra: ["--divergence-band", "NVDA=210"],
      // Both paired sources answer the same fresh price: no divergence, so the check completes "ok".
      read: (address, fn, args) => ((same(address, SRC.chainlink) || same(address, SRC.univ3)) && fn === "latest" ? [true, 200_000_000n, 1_789_999_000n] : poolReads(address, fn, args)),
    },
    pools: { nvda: market("NVDA", 1, { pool: POOL, floor: "1000" }), extra: [], read: poolReads },
    pricing: { nvda: market("NVDA", 1), extra: ["--pricing", "http://pricing.invalid"], fetch: pricingService },
  };
  for (const [c, world] of Object.entries(worlds)) {
    test(`${c}: TSLA's market() fails by transport, so ${c} is incomplete and says why; read clean, it completes`, async () => {
      const dir = scratch(`monitor-1019-scope-${c}-`);
      const TS = market("TSLA", 2, { status: "planned" });
      const file = writeRegistry(dir, { markets: [world.nvda, TS], deployBlock: 1000 });
      const chain = new FakeChain({ head: 20_000n, timestamp: 1_790_000_000 }); // a Monday: the 24/5 market is open
      const w = { fail: false };
      chain.read = (address, fn, args) => {
        if (fn === "market" && same(args[0], TS.asset)) {
          if (w.fail) throw transportError();
          return { enabled: true, mintPaused: false, strikeTick: 1n, exerciseFeeBps: 30, oracle: C.settlementOracle, mintFeePpm: 80 };
        }
        return world.read?.(address, fn, args) ?? defaultRead(chain, address, fn, args);
      };
      const opts = options(dir, file, world.extra);
      const deps = () => ({ ...onChain(chain), ...(world.fetch ? { fetch: world.fetch } : {}) });
      const clean = await runOnce(opts, deps());
      assert.equal(clean.checks[c].status, "ok", `control: ${c} completes when the scope is read: ${JSON.stringify(clean.checks[c])}`);
      chain.setHead(chain.head.number + 100n, chain.head.timestamp + 120);
      w.fail = true;
      const failed = await runOnce(opts, deps());
      assert.equal(failed.checks[c].status, "incomplete", JSON.stringify(failed.checks[c]));
      assert.match(failed.checks[c].detail, /scope incomplete: TSLA not read/);
      chain.setHead(chain.head.number + 100n, chain.head.timestamp + 120);
      w.fail = false;
      const again = await runOnce(opts, deps());
      assert.equal(again.checks[c].status, "ok", JSON.stringify(again.checks[c]));
    });
  }
});

// ---------------------------------------------------------------------------------------------- tokenpool

describe("tokenpool: an unread feeBps() or maxTotalFeeBps() never clears the fee page", () => {
  const EXEC = addr(0xe8ec);
  const world = () => {
    const dir = scratch("monitor-1019-tokenpool-");
    const file = writeRegistry(dir, { markets: [market("NVDA", 1)], deployBlock: 1000 });
    const reg = JSON.parse(readFileSync(file, "utf8"));
    const key = { currency0: addr(0x13), currency1: addr(0x14), fee: 3000, tickSpacing: 60, hooks: addr(0x1004) };
    const poolId = v4PoolId(loadViem(), key);
    reg.shared.token = { address: addr(0x13), symbol: "STONK", decimals: 18, poolKey: key, poolId };
    reg.v2.flywheel = { feeSplitter: null, buybackExecutor: EXEC, deployBlock: 1000 };
    writeFileSync(file, JSON.stringify(reg));
    const chain = new FakeChain({ head: 20_000n });
    const w = { fees: () => [0, 30, 0, 301, 0, 331n], cap: () => 400 }; // a hook fee above MAX_HOOK_FEE_BPS (300)
    chain.read = (address, fn, args) => {
      if (same(address, EXEC) && fn === "key") return key;
      if (same(address, EXEC) && fn === "feeBps") return w.fees();
      if (same(address, EXEC) && fn === "maxTotalFeeBps") return w.cap();
      return defaultRead(chain, address, fn, args);
    };
    return { dir, chain, opts: options(dir, file), w, id: `v2_mon_token_pool_fee:${lc(poolId)}:fee` };
  };

  test("feeBps() fails by transport: the hook-fee page stays; read clean with the hook under the cap, it resolves", async () => {
    const x = world();
    await openKeepResolve({
      ...x,
      check: "tokenpool",
      open: () => {},
      fail: () => {
        x.w.fees = () => {
          throw transportError();
        };
      },
      clean: () => {
        x.w.fees = () => [0, 30, 0, 100, 0, 130n];
      },
    });
  });

  test("maxTotalFeeBps() fails by transport: the check is incomplete (the fee cap is not judged); read clean, it completes", async () => {
    const x = world();
    await openKeepResolve({
      ...x,
      check: "tokenpool",
      open: () => {},
      fail: () => {
        x.w.cap = () => {
          throw transportError();
        };
      },
      clean: () => {
        x.w.cap = () => 400;
        x.w.fees = () => [0, 30, 0, 100, 0, 130n];
      },
    });
  });
});

// ---------------------------------------------------------------------------------------------- pins: band views

describe("pins: band views that fail by transport are unread, never 'no band views'", () => {
  test("pinnedBands/bands fail by transport: the band mismatch stays, the expiry is not marked verified; read clean and equal, it resolves and verifies", async () => {
    const dir = scratch("monitor-1019-pins-");
    const NV = market("NVDA", 1);
    const file = writeRegistry(dir, { markets: [NV], deployBlock: 1000 });
    const json = JSON.parse(readFileSync(file, "utf8"));
    json.markets[0].v2.chainlinkBand = { minPrice: "1000000", maxPrice: "900000000" };
    writeFileSync(file, JSON.stringify(json));
    const reg = parseRegistry(json, file);
    const want = expectedPinnedConfig(reg, reg.markets[0]);
    const now = 1_790_000_000;
    const E = now + 5 * 86_400;
    const chain = new FakeChain({ head: 20_000n, timestamp: now });
    chain.logs.push(rawLog(SERIES_CREATED, { longId: 0x2468n, underlying: NV.asset, isPut: false, strike: 200_000_000n, expiry: E, oracle: C.settlementOracle, exerciseFeeBps: 30, mintFeePpm: 80 }, { address: C.clearinghouse, blockNumber: 5000 }));
    // Pinned exactly as the registry says, so the band is the only thing that can differ.
    const w = { band: () => [1n, 2n] };
    chain.read = (address, fn, args) => {
      if (fn === "openInterest") return 500n;
      if (fn === "settlementConfig") return [true, want.sources, want.maxDeviationBps, want.uncorroboratedDelay, want.spotMaxAge];
      if (same(address, SRC.chainlink) && fn === "pinnedFeeds") return [want.feed, want.maxStale, want.maxRoundJumpBps, true];
      if (same(address, SRC.chainlink) && (fn === "pinnedBands" || fn === "bands")) return w.band();
      return defaultRead(chain, address, fn, args);
    };
    const id = `v2_mon_pin_mismatch:${lc(NV.asset)}:${E}`;
    await openKeepResolve({
      dir,
      chain,
      opts: options(dir, file),
      id,
      check: "pins",
      advance: 1000, // past pinCheckS (900 s), so the pass re-reads rather than serving its cache
      open: () => {},
      fail: () => {
        w.band = () => {
          throw transportError();
        };
      },
      clean: () => {
        assert.deepEqual(stateOf(dir).scan.pinsVerified, {}, "an unread band never marks the expiry verified");
        w.band = () => [1_000_000n, 900_000_000n];
      },
    });
    assert.equal(Object.keys(stateOf(dir).scan.pinsVerified).length, 1, "read clean and equal, it verifies");
  });

  test("a pass whose band views failed is never cached: the next pass inside pinCheckS re-reads and keeps the mismatch", async () => {
    const dir = scratch("monitor-1019-pins-cache-");
    const NV = market("NVDA", 1);
    const file = writeRegistry(dir, { markets: [NV], deployBlock: 1000 });
    const json = JSON.parse(readFileSync(file, "utf8"));
    json.markets[0].v2.chainlinkBand = { minPrice: "1000000", maxPrice: "900000000" };
    writeFileSync(file, JSON.stringify(json));
    const reg = parseRegistry(json, file);
    const want = expectedPinnedConfig(reg, reg.markets[0]);
    const now = 1_790_000_000;
    const E = now + 5 * 86_400;
    const chain = new FakeChain({ head: 20_000n, timestamp: now });
    chain.logs.push(rawLog(SERIES_CREATED, { longId: 0x2468n, underlying: NV.asset, isPut: false, strike: 200_000_000n, expiry: E, oracle: C.settlementOracle, exerciseFeeBps: 30, mintFeePpm: 80 }, { address: C.clearinghouse, blockNumber: 5000 }));
    const w = { band: () => [1n, 2n] }; // pinned exactly as the registry says, except the band
    let bandReads = 0;
    chain.read = (address, fn, args) => {
      if (fn === "openInterest") return 500n;
      if (fn === "settlementConfig") return [true, want.sources, want.maxDeviationBps, want.uncorroboratedDelay, want.spotMaxAge];
      if (same(address, SRC.chainlink) && fn === "pinnedFeeds") return [want.feed, want.maxStale, want.maxRoundJumpBps, true];
      if (same(address, SRC.chainlink) && (fn === "pinnedBands" || fn === "bands")) {
        bandReads += 1;
        return w.band();
      }
      return defaultRead(chain, address, fn, args);
    };
    const opts = options(dir, file);
    const id = `v2_mon_pin_mismatch:${lc(NV.asset)}:${E}`;
    const r1 = await runOnce(opts, onChain(chain));
    assert.ok(isOpen(dir, id), `premise: the band mismatch is open: ${JSON.stringify(r1.checks.pins)}`);
    // Past pinCheckS (900 s): re-read, and the band views fail by transport.
    chain.setHead(chain.head.number + 100n, chain.head.timestamp + 1000);
    w.band = () => {
      throw transportError();
    };
    const r2 = await runOnce(opts, onChain(chain));
    assert.equal(r2.checks.pins.status, "incomplete");
    assert.equal(stateOf(dir).scan.pinsCache, null, "the unread pass left nothing to replay");
    // 60 s later, inside pinCheckS, the bands read clean and still differ: the pass must read them, not replay pass 2.
    chain.setHead(chain.head.number + 5n, chain.head.timestamp + 60);
    w.band = () => [1n, 2n];
    const before = bandReads;
    const r3 = await runOnce(opts, onChain(chain));
    assert.ok(bandReads > before, "the bands were read again");
    assert.equal(r3.checks.pins.status, "ok", JSON.stringify(r3.checks.pins));
    assert.ok(isOpen(dir, id), "the mismatch is still open: a replay of the unread pass would have resolved it");
    assert.ok(!r3.findings.some((f) => f.kind === "v2_mon_resolved" && f.key.startsWith("v2_mon_pin_mismatch")));
  });
});

// ---------------------------------------------------------------------------------------------- config: Repriced sender

describe("config: a Repriced whose sender could not be read is never folded into the summary", () => {
  const PRICER = addr(0xb02);
  const rep = (i) => ({
    eventName: "Repriced",
    blockNumber: 5000n + BigInt(i),
    logIndex: 0,
    transactionHash: `0x${(i + 1).toString(16).padStart(64, "0")}`,
    args: { writer: addr(0xf), underlying: addr(0xa001), oldOrderId: BigInt(i), newOrderId: BigInt(i + 1), price: 100n },
    priceBefore: 100n,
  });
  test("cap 1, three reprices, the third's sender unread: it is its own warn saying a foreign sender is not ruled out, and the summary counts only judged ones", () => {
    const events = [rep(0), rep(1), rep(2)];
    const senders = new Map([[lc(events[0].transactionHash), PRICER], [lc(events[1].transactionHash), PRICER], [lc(events[2].transactionHash), null]]);
    const out = repriceFindings(events, null, { t: { repriceWarnCap: 1 }, pricerKey: PRICER, senders });
    const unjudged = out.find((f) => f.key === `${lc(events[2].transactionHash)}:0`);
    assert.ok(unjudged !== undefined, `the unread sender's reprice is individual: ${JSON.stringify(out.map((f) => f.key))}`);
    assert.match(unjudged.message, /the sender could not be read, so a foreign sender is NOT ruled out/);
    const summary = out.find((f) => f.key.endsWith(":summary"));
    assert.ok(summary !== undefined && summary.data.count === 1, `the summary folds only the judged reprice past the cap: ${JSON.stringify(summary?.data)}`);
    assert.equal(summary.data.last, `${lc(events[1].transactionHash)}:0`);
  });
});

// ---------------------------------------------------------------------------------------------- feeds: decimals

describe("feeds: an unread decimals() is not 8", () => {
  test("a round jump with decimals null shows the raw answers and says why; undefined keeps the 8 default", () => {
    const rounds = [
      { id: (1n << 64n) | 1n, answer: 100_000_000n, updatedAt: 1 },
      { id: (1n << 64n) | 2n, answer: 200_000_000n, updatedAt: 2 },
    ];
    const [unread] = checkRoundJumps(rounds, { ticker: "NVDA", feed: addr(0xb001), decimals: null });
    assert.match(unread.message, /\(raw 100000000 -> 200000000; decimals\(\) could not be read\)/);
    const [given] = checkRoundJumps(rounds, { ticker: "NVDA", feed: addr(0xb001) });
    assert.match(given.message, /\(1\.00 -> 2\.00\)/);
  });
});

// ---------------------------------------------------------------------------------------------- ownership

/*
 * The static half of the ownership test: every finding() site in monitor.mjs, against the runOnce
 * check that produces it. A hand-written fixture list missed v2_mon_manager_launch_key (filed under "config", produced
 * by "manager") and never reached 13 other relabeled branches; walking the source cannot miss a site. The scanner skips
 * strings, templates, comments and regex literals, so "finding(s)" in a message is not a call.
 */

/** Code positions of `<name>(` calls (not `x.name(`) for the given names. */
function scanCalls(src, names) {
  const hits = [];
  const isId = (c) => c !== undefined && /[\w$]/.test(c);
  const REGEX_AFTER = new Set(["return", "typeof", "case", "in", "of", "delete", "void", "throw", "new", "yield", "await", "else", "do"]);
  const templates = []; // the brace depth at each open `${`
  let depth = 0;
  let prevSig = ""; // the last significant code character (the regex-literal heuristic)
  let prevWord = ""; // the last keyword or identifier, when it is the last token
  let i = 0;
  const skipString = (q) => {
    i++;
    while (i < src.length && src[i] !== q) i += src[i] === "\\" ? 2 : 1;
    i++;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) break;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      skipString(c);
      prevSig = "a";
      prevWord = "";
      continue;
    }
    if (c === "`" || (c === "}" && templates.length > 0 && templates[templates.length - 1] === depth)) {
      if (c === "}") templates.pop();
      i++;
      while (i < src.length) {
        if (src[i] === "\\") i += 2;
        else if (src[i] === "`") {
          i++;
          break;
        } else if (src[i] === "$" && src[i + 1] === "{") {
          i += 2;
          templates.push(depth);
          break;
        } else i++;
      }
      prevSig = "a";
      prevWord = "";
      continue;
    }
    if (c === "/" && (prevSig === "" || "(,=:[!&|?{;+-*%<>~^".includes(prevSig) || REGEX_AFTER.has(prevWord))) {
      i++;
      let cls = false;
      while (i < src.length && (cls || src[i] !== "/")) {
        if (src[i] === "\\") i++;
        else if (src[i] === "[") cls = true;
        else if (src[i] === "]") cls = false;
        else if (src[i] === "\n") throw new Error(`scanCalls: a regex literal ran to the end of line ${src.slice(0, i).split("\n").length}`);
        i++;
      }
      i++;
      while (isId(src[i])) i++;
      prevSig = "a";
      prevWord = "";
      continue;
    }
    if (isId(c) && !isId(src[i - 1])) {
      let j = i;
      while (isId(src[j])) j++;
      const word = src.slice(i, j);
      const method = src[i - 1] === "." && src[i - 2] !== "."; // x.fn( is a method; ...fn( is a spread call
      if (names.has(word) && src[j] === "(" && !method) hits.push({ name: word, at: i, open: j });
      prevSig = "a";
      prevWord = word;
      i = j;
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") depth--;
    if (!/\s/.test(c)) {
      prevSig = c;
      prevWord = "";
    }
    i++;
  }
  return hits;
}

/** The call whose "(" is at `open`: its top-level argument texts (comments dropped) and the index of its ")". */
function callAt(src, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  let i = open + 1;
  const skipString = (q) => {
    i++;
    while (i < src.length && src[i] !== q) i += src[i] === "\\" ? 2 : 1;
    i++;
  };
  const skipTemplate = () => {
    i++;
    while (i < src.length) {
      if (src[i] === "\\") i += 2;
      else if (src[i] === "`") return void i++;
      else if (src[i] === "$" && src[i + 1] === "{") {
        i += 2;
        for (let d = 1; i < src.length && d > 0; ) {
          if (src[i] === '"' || src[i] === "'") skipString(src[i]);
          else if (src[i] === "`") skipTemplate();
          else {
            if (src[i] === "{") d++;
            if (src[i] === "}") d--;
            i++;
          }
        }
      } else i++;
    }
  };
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") i = src.indexOf("\n", i);
    else if (c === '"' || c === "'") (skipString(c), i--);
    else if (c === "`") (skipTemplate(), i--);
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && depth > 0) depth--;
    else if (c === ")" || (c === "," && depth === 0)) {
      args.push(src.slice(start, i).replace(/\/\/[^\n]*/g, "").trim());
      start = i + 1;
      if (c === ")") return { args, close: i };
    }
  }
  throw new Error(`callAt: no ")" for the call at ${open}`);
}

/** Every non-event finding() site in monitor.mjs, with the check it is filed under and the checks that produce it. */
function findingOwnership(src) {
  const decls = [...src.matchAll(/^(?:export )?(?:async )?(?:function\*? ([A-Za-z_$][\w$]*)|(?:const|let|class) ([A-Za-z_$][\w$]*))/gm)].map((m) => ({ name: m[1] ?? m[2], from: m.index }));
  decls.forEach((d, k) => (d.to = k + 1 < decls.length ? decls[k + 1].from : src.length));
  const declAt = (pos) => decls.findLast((d) => d.from <= pos);
  const runOnce = decls.find((d) => d.name === "runOnce");
  const runs = [...src.slice(runOnce.from, runOnce.to).matchAll(/await run\("([a-z0-9]+)", async/g)].map((m) => {
    const from = runOnce.from + m.index;
    return { check: m[1], from, to: callAt(src, src.indexOf("(", from)).close };
  });
  // Outside every run() block, runOnce itself is the "meta" check (always completed).
  const checkAt = (pos) => runs.find((r) => r.from <= pos && pos < r.to)?.check ?? "meta";
  const calls = scanCalls(src, new Set(decls.map((d) => d.name)));
  const callers = new Map();
  for (const c of calls) {
    const d = declAt(c.at);
    if (c.name === "finding" || d === undefined || d.name === c.name) continue;
    callers.set(c.name, [...(callers.get(c.name) ?? []), d === runOnce ? { check: checkAt(c.at) } : { decl: d.name }]);
  }
  const owners = (name, seen = new Set([name])) =>
    new Set((callers.get(name) ?? []).flatMap((c) => (c.check !== undefined ? [c.check] : seen.has(c.decl) ? [] : [...owners(c.decl, new Set([...seen, c.decl]))])));
  const sites = [];
  let events = 0;
  for (const c of calls.filter((x) => x.name === "finding")) {
    const d = declAt(c.at);
    if (d.name === "finding") continue; // the definition
    const [kindArg = "", , checkArg = ""] = callAt(src, c.open).args;
    const line = src.slice(0, c.at).split("\n").length;
    const kinds = [...kindArg.matchAll(/"(v2_mon_[a-z0-9_]+)"/g)].map((m) => m[1]);
    if (kinds.length > 0 && kinds.every((k) => KINDS[k]?.event === true)) {
      events += 1; // an event never resolves, so which check it is filed under changes nothing
      continue;
    }
    sites.push({ line, fn: d.name, kinds, filed: /^"([a-z0-9]+)"$/.exec(checkArg)?.[1] ?? null, producedBy: d === runOnce ? [checkAt(c.at)] : [...owners(d.name)] });
  }
  return { sites, events };
}

describe("A condition is owned by the check that reads its inputs", () => {
  test("every finding() site is filed under the one check that produces it (static, the whole of monitor.mjs)", () => {
    const src = readFileSync(new URL("./monitor.mjs", import.meta.url), "utf8");
    const { sites, events } = findingOwnership(src);
    // The scan must have seen the file: a scanner that lost its place would judge nothing and pass.
    assert.ok(sites.length >= 100 && events >= 20, `scanned ${sites.length} condition and ${events} event sites`);
    const launchKey = sites.find((x) => x.kinds.includes("v2_mon_manager_launch_key"));
    assert.deepEqual(launchKey?.producedBy, ["manager"], "the launch-key site is found and attributed to the manager check");
    const wrong = sites.filter((x) => x.kinds.length === 0 || x.kinds.some((k) => KINDS[k] === undefined) || x.filed === null || x.producedBy.length !== 1 || x.producedBy[0] !== x.filed);
    assert.deepEqual(
      wrong.map((x) => `monitor.mjs:${x.line} ${x.fn} ${x.kinds.join("|") || "(kind not a literal)"} filed under ${x.filed ?? "(not a literal)"}, produced by [${x.producedBy}]`),
      [],
      "a condition filed under a check that does not produce it is resolved when THAT check completes, even while its own read failed",
    );
  });

  test("the launch key still holding its role after the lock stays open while the manager's hasRole fails", () => {
    const GKEY = addr(0x6e1);
    const key = (isMember) => ({ label: "guardianKey", address: GKEY, roleId: 4, roleName: "GUARDIAN", isMember, executionDelay: isMember === null ? null : 0, wantMember: true, wantDelayS: 0, launchOnly: true });
    const wiring = (isMember) => checkManagerWiring({ manager: addr(0x3a), rows: [], members: [key(isMember)], lock: { block: "100", at: 1_000 }, functions: [] });
    const [held] = wiring(true);
    assert.equal(held?.kind, "v2_mon_manager_launch_key", "premise: a key still holding its role after the lock is paged");
    const alerts = {};
    const all = ["meta", "config", "manager"];
    reconcile(alerts, [held], { completed: new Set(all), nowS: 1 });
    const id = `${held.kind}:${held.key}`;
    markDelivered(alerts, id, held.severity, 1);
    // hasRole failed by transport: nothing is judged, the manager check is incomplete, and config completes as usual.
    assert.deepEqual(wiring(null), [], "premise: an unread membership produces nothing");
    const failed = reconcile(alerts, wiring(null), { completed: new Set(["meta", "config"]), nowS: 2 });
    assert.deepEqual(failed.resolved, [], "a failed hasRole never sends 'resolved'");
    assert.ok(alerts[id] !== undefined, "the launch-key alert stays open");
    // Read clean and revoked: resolved.
    const clean = reconcile(alerts, wiring(false), { completed: new Set(all), nowS: 3 });
    assert.deepEqual(clean.resolved.map((r) => r.id), [id]);
  });


  // reconcile resolves a remembered condition when its OWNING check (the finding's `check`) completes without it. Filed
  // under another group ("config", "fees"), the producing check's `incomplete` on a failed read protected nothing: the
  // other group completed and the alert resolved. Each producer below is called from exactly one runOnce check.
  test("manager, routes, safes, tokenpool and flywheel conditions name their own check", () => {
    const now = 1_000_000;
    const S = addr(0x5b1);
    const produced = {
      manager: checkManagerWiring({ manager: addr(0x3a), rows: [{ roleId: 1, name: "FEE_MANAGER", chainAdmin: 6, chainGuardian: 7, wantAdmin: 0, wantGuardian: 7 }], members: [] }),
      routes: [
        ...checkRoute({ ticker: "NVDA", asset: addr(0xa001), route: { venue: 1, fee: 3000, tickSpacing: 60, v3Pool: ZERO_ADDR, feeBps: 30 }, registryRoute: { venue: "v4", fee: 3000, tickSpacing: 60, poolId: null }, poolId: null }),
        ...checkRouteDecode({ address: addr(0xc7), interfaceVersion: 8, isAdapter: true }),
      ],
      safes: checkSafeThreshold({ safe: addr(0x5afe), label: "Admin Safe", threshold: 1n, owners: 3 }),
      tokenpool: checkTokenPool(
        { poolId: `0x${"5".repeat(64)}`, poolKey: { currency0: addr(1), currency1: addr(2), fee: 3000, tickSpacing: 60, hooks: ZERO_ADDR }, recomputedPoolId: `0x${"5".repeat(64)}`, depth: null, fees: { v3: 0, v4Lp: 0, v4Protocol: 0, hook: MAX_HOOK_FEE_BPS + 1, creatorTax: 0, total: 999n }, maxTotalFeeBps: 400 },
        { ...DEFAULTS, tokenPoolMinDepth: 1 },
      ),
      flywheel: [
        ...checkSplitter({ splitter: S, now: 10_000 + DEFAULTS.splitterIdleS + 1, lastDistributedAt: null, pendingSince: 10_000, floorMisses: [] }, DEFAULTS),
        ...checkBuyback({ splitter: S, now, balance: 60_000_000n, lastBuybackAt: null, fundedSince: now - DEFAULTS.buybackStuckS - 1, lastSkip: null, unburned: [] }, DEFAULTS),
        ...checkBuyback({ splitter: S, now: 10, balance: 0n, lastBuybackAt: null, fundedSince: null, unburned: applyFlywheelLogs({ lastDistributedAt: null, pendingSince: null, floorMisses: {}, lastBoughtBackAt: null, fundedSince: null }, [{ eventName: "BoughtBack", args: { usdgIn: 50_000_000n, tokenOut: 10n }, transactionHash: "0x2" }], 10, S) }, DEFAULTS),
      ],
    };
    const kinds = new Set();
    for (const [check, findings] of Object.entries(produced)) {
      assert.ok(findings.length > 0, `${check}: the fixture produces a finding`);
      for (const f of findings) {
        kinds.add(f.kind);
        if (!f.event) assert.equal(f.check, check, `${f.kind} is owned by the ${check} check`);
      }
    }
    for (const k of ["v2_mon_manager_wiring", "v2_mon_route_wiring", "v2_mon_route_decode", "v2_mon_safe_threshold", "v2_mon_token_pool_fee", "v2_mon_token_pool_depth", "v2_mon_splitter_idle", "v2_mon_buyback_stuck", "v2_mon_buyback_unburned"]) {
      assert.ok(kinds.has(k), `${k} is covered: ${JSON.stringify([...kinds])}`);
    }
  });
});

// ---------------------------------------------------------------------------------------------- config: Data Streams listing

describe("config: an unread pinned list is not 'the source is listed nowhere'", () => {
  test("a fresh Data Streams FeedSet while an expiry's settlementConfig fails by transport pages at error as listed, not at warn as listed nowhere", async () => {
    const dir = scratch("monitor-1019-ds-");
    const NV = market("NVDA", 1);
    const DS = addr(0xd3);
    const file = writeRegistry(dir, { markets: [NV], deployBlock: 1000 });
    const json = JSON.parse(readFileSync(file, "utf8"));
    json.v2.contracts.sources.dataStreams = DS;
    writeFileSync(file, JSON.stringify(json));
    const now = 1_790_000_000;
    const E = now + 5 * 86_400;
    const chain = new FakeChain({ head: 20_000n, timestamp: now });
    chain.logs.push(rawLog(SERIES_CREATED, { longId: 0x2468n, underlying: NV.asset, isPut: false, strike: 200_000_000n, expiry: E, oracle: C.settlementOracle, exerciseFeeBps: 30, mintFeePpm: 80 }, { address: C.clearinghouse, blockNumber: 5000 }));
    const w = { cfg: () => [true, [SRC.chainlink, DS], 150, 21600, 3600] };
    chain.read = (address, fn, args) => (fn === "settlementConfig" ? w.cfg() : defaultRead(chain, address, fn, args));
    const opts = options(dir, file);
    await runOnce(opts, onChain(chain)); // the first pass adopts the history up to its head
    chain.setHead(20_100n, now + 60);
    chain.logs.push(rawLog("event FeedSet(address indexed underlying, bytes32 indexed feedId)", { underlying: NV.asset, feedId: `0x${"ab".repeat(32)}` }, { address: DS, blockNumber: 20_050 }));
    w.cfg = () => {
      throw transportError();
    };
    const r = await runOnce(opts, onChain(chain));
    const f = r.findings.find((x) => x.kind === "v2_mon_data_streams_feed");
    assert.ok(f !== undefined, JSON.stringify(r.findings.map((x) => x.kind)));
    assert.equal(f.severity, "error", "unread is paged as listed");
    assert.match(f.message, /where the source is listed could not be read: treat it as listed/);
    assert.doesNotMatch(f.message, /listed nowhere/);
  });
});
