/* -------------------------------------------------------------------------------------------------
 * Test-only harness for ops/v2/monitor.test.mjs. Nothing in production imports this file.
 *
 * runOnce(opts, { viem }) takes viem as a seam. fakeViem() hands back the real viem with
 * createPublicClient replaced by an in-memory chain, so a pass runs its real code: log decoding
 * (parseEventLogs over real ABI-encoded logs), every check, dedupe, delivery and the state file.
 * Nothing talks to a network unless the test starts a local HTTP server.
 *
 * The devnet counterpart, which runs the same checks against a real chain, is ops/v2/monitor-devnet.mjs.
 * ------------------------------------------------------------------------------------------------- */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ZERO, loadViem, parseArgs } from "./monitor.mjs";

export const viem = loadViem();

export const addr = (n) => `0x${n.toString(16).padStart(40, "0")}`;

/** The v2 contract set, one recognisable address each. */
export const C = {
  clearinghouse: addr(0xc1),
  orderBook: addr(0xc2),
  settlementOracle: addr(0xc3),
  expiryCalendar: addr(0xc4),
  keeperRewards: addr(0xc5),
  autoRoller: addr(0xc6),
  payoutAdapter: addr(0xc7),
  makerVault: addr(0xc8),
  makerRegistry: addr(0xc9),
  rewardsDistributor: addr(0xca),
};
export const SRC = { chainlink: addr(0xd1), univ3: addr(0xd2) };
export const USDG = addr(0xe1);

/**
 * One holder's USDG balance in every fixture, and the source of the supply below.
 *
 * `defaultRead` keys `balanceOf` on the TOKEN address, not on the holder, so every
 * value-holding contract the registry names reads as holding exactly this much: a fixture's
 * locked total is this times the number of holders. The v8 healthy registry names two
 * (clearinghouse, makerVault), so it locks 2,000,000 USDG.
 */
export const USDG_BALANCE = 10n ** 12n;

/**
 * USDG's totalSupply. It is DERIVED from USDG_BALANCE rather than written beside it, so the
 * two answers cannot drift apart: a supply below the sum of the balances this file hands out
 * would be a fixture contradicting itself, and `tvlFaults` reads a supply of 0 as proof that
 * shared.usdg is the wrong address. The headroom covers any holder count a fixture could name.
 */
export const USDG_TOTAL_SUPPLY = USDG_BALANCE * 1000n;

export function tmp(prefix = "monitor-fake-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** A deployed-v2 registry in the shape parseRegistry reads. */
export function writeRegistry(dir, { markets = [], deployBlock = 1000, defaults = {}, fees = { mintFeePpm: 80 } } = {}) {
  const file = path.join(dir, "registry.json");
  writeFileSync(
    file,
    JSON.stringify({
      shared: { chainId: 4663, usdg: USDG, multicall3: null },
      v2: { interfaceVersion: 7, deployBlock, defaults, fees, contracts: { ...C, sources: { ...SRC, dataStreams: null } } },
      markets,
    }),
  );
  return file;
}

export function market(ticker, n, { status = "live", pool = null, floor = null, mintFeePpm = null } = {}) {
  return { ticker, asset: addr(0xa000 + n), feed: addr(0xb000 + n), feedAggregator: null, v2: { status, univ3Pool: pool, univ3MinLiquidity: floor, mintFeePpm } };
}

/** A real ABI-encoded log, the shape viem returns from eth_getLogs. */
export function rawLog(signature, args, { address, blockNumber, logIndex = 0, tx = null }) {
  const [item] = viem.parseAbi([signature]);
  const indexedArgs = {};
  const dataTypes = [];
  const dataValues = [];
  for (const input of item.inputs) {
    if (input.indexed) indexedArgs[input.name] = args[input.name];
    else {
      dataTypes.push(input);
      dataValues.push(args[input.name]);
    }
  }
  const topics = viem.encodeEventTopics({ abi: [item], eventName: item.name, args: indexedArgs });
  const data = dataTypes.length ? viem.encodeAbiParameters(dataTypes, dataValues) : "0x";
  const bn = BigInt(blockNumber);
  return {
    address,
    topics,
    data,
    blockNumber: bn,
    blockHash: `0x${bn.toString(16).padStart(64, "0")}`,
    logIndex,
    transactionIndex: 0,
    transactionHash: tx ?? `0x${(bn * 1000n + BigInt(logIndex)).toString(16).padStart(64, "f")}`,
    removed: false,
  };
}

/** What viem raises for a rate-limited or unreachable node (isRevert() is false for it). */
export const transportError = (what = "429 Too Many Requests") => {
  const e = new Error(`HTTP request failed. Status: 429 URL: <url> Details: ${what}`);
  e.name = "HttpRequestError";
  return e;
};

/** Default answers for every view the monitor reads: a quiet, healthy deployment. */
export function defaultRead(chain, address, fn, args) {
  const a = address.toLowerCase();
  switch (fn) {
    case "openInterest":
      return 0n;
    case "settlementInfo":
      return [2, 0n, 0, true, false, true];
    case "candidate":
      return [0n, 0, false, 0];
    case "recordedSources":
      return [[SRC.chainlink], [true], [0n], 150];
    case "marketConfig":
      return [[SRC.chainlink], 150, 21600, 3600];
    case "snapshots":
      return [0n, 0, 0];
    case "series":
      return {
        underlying: addr(0xa001),
        isPut: false,
        expiry: 0n,
        strike: 0n,
        oracle: C.settlementOracle,
        exerciseFeeBps: 0,
        settled: true,
        settlementPrice: 0n,
        longPayoutPerUnit: 0n,
        feePerUnit: 0n,
        shortPayoutPerUnit: 0n,
        mintFeePpm: 80,
        mintFeesHeld: 0n,
      };
    case "mintFee":
      return 0n;
    case "balanceOf":
      return a === USDG.toLowerCase() ? USDG_BALANCE : 0n;
    case "totalSupply":
      // The monitor reads this beside the balances (monitor.mjs, the tvl check's readMany) and
      // treats an unreadable answer as a fault, which returns before checkTvl's half and full
      // arms. Without this case no end-to-end fixture could reach them at all.
      return a === USDG.toLowerCase() ? USDG_TOTAL_SUPPLY : 0n;
    case "thirdPartyRedeemAllowed":
      return true;
    case "free":
      return 10n ** 12n;
    case "dailyCap":
      return 10n ** 9n;
    case "spentToday":
      return 0n;
    case "bounty":
      return 1n;
    case "limits":
      return { maxSeriesUnits: 10n ** 9n, maxTotalNotional: 10n ** 15n, askToleranceBps: 0, maxBidBpsOfSpot: 0, maxOrderLifetime: 0, maxDailyOutflow: 2_500_000_000n };
    case "outflow":
      return [0n, 2_500_000_000n];
    case "totalNotional":
      return 0n;
    case "trackedSeries":
      return [];
    case "position":
      return [0n, 0n, 0];
    case "getOrders":
      return args[0].map(() => ({ maker: ZERO, longId: 0n, kind: 0, price: 0n, units: 0n, filled: 0n, validUntil: 0, cancelled: true }));
    case "isDelegate":
      return true;
    case "trySpot":
      return [false, 0n, 0n];
    case "feeParams":
      return { premiumFeeBps: 0, resaleFeeBps: 0, takerFeeFlat: 0, takerFeeCapBps: 0, makerRebateBps: 0 };
    case "pendingFeeParams":
      return [{ premiumFeeBps: 0, resaleFeeBps: 0, takerFeeFlat: 0, takerFeeCapBps: 0, makerRebateBps: 0 }, 0];
    case "calendar":
      return C.expiryCalendar;
    case "market":
      return { enabled: false, mintPaused: false, strikeTick: 0n, exerciseFeeBps: 0, oracle: ZERO, mintFeePpm: 0 };
    case "isValidExpiry":
      return false;
    case "pinnedBy":
      return ZERO;
    case "settlementConfig":
      return [true, [SRC.chainlink], 150, 21600, 3600];
    case "feeds":
      return [ZERO, 0, 0];
    case "pinnedFeeds":
      return [ZERO, 0, 0, false];
    case "pools":
      return [ZERO, false, 18, 300, 0n];
    case "pinnedPools":
      return [ZERO, false, 18, 300, false, 0n];
    case "aggregator":
      return addr(0xf00);
    case "accessController":
      return ZERO;
    case "owner":
      return addr(0x5afe);
    case "decimals":
      return 8;
    case "latestRoundData":
      return [(1n << 64n) | 100n, 100_00000000n, 0n, BigInt(chain.head.timestamp), (1n << 64n) | 100n];
    case "getRoundData":
      return [args[0], 100_00000000n, 0n, BigInt(chain.head.timestamp), args[0]];
    case "nonce":
      return 1n;
    case "getThreshold":
      return 2n;
    case "getOwners":
      return [addr(1), addr(2)];
    case "paused":
    case "oraclePaused":
      return false;
    case "uiMultiplier":
    case "newUIMultiplier":
      return 10n ** 18n;
    case "effectiveAt":
      return 0n;
    case "ACCESS_CONTROLLED_REGISTRY":
      return addr(0xacc);
    case "isBlocked":
    case "isFrozen":
      return false;
    case "liquidity":
      return 10n ** 20n;
    default:
      throw new Error(`fake chain: no answer for ${fn} on ${address}`);
  }
}

export class FakeChain {
  constructor({ head = 20_000n, timestamp = 1_790_000_000 } = {}) {
    this.head = { number: BigInt(head), hash: null, timestamp };
    this.setHead(head, timestamp);
    this.logs = []; // raw protocol logs
    this.tokenLogs = []; // stock-token logs (UIMultiplierUpdated and friends)
    this.read = (address, fn, args) => defaultRead(this, address, fn, args); // override per test
    this.getBlockHook = null; // (n) => block | throws
    this.getCodeHook = null;
    this.getLogsHook = null; // ({from, to, event}) => void | throws
    this.calls = { getBlock: 0, readContract: 0, getLogs: 0, inflightGetBlock: 0, maxInflightGetBlock: 0 };
  }
  setHead(number, timestamp) {
    this.head = { number: BigInt(number), hash: `0x${BigInt(number).toString(16).padStart(64, "a")}`, timestamp };
  }
  blockAt(n) {
    const bn = BigInt(n);
    return { number: bn, hash: `0x${bn.toString(16).padStart(64, "a")}`, timestamp: BigInt(this.head.timestamp) - (this.head.number - bn) / 10n };
  }
  client() {
    const chain = this;
    return {
      async getChainId() {
        return 4663;
      },
      async getBlock({ blockTag, blockNumber } = {}) {
        chain.calls.getBlock += 1;
        if (blockTag === "latest") return { number: chain.head.number, hash: chain.head.hash, timestamp: BigInt(chain.head.timestamp) };
        chain.calls.inflightGetBlock += 1;
        chain.calls.maxInflightGetBlock = Math.max(chain.calls.maxInflightGetBlock, chain.calls.inflightGetBlock);
        try {
          await new Promise((r) => setTimeout(r, 1));
          if (chain.getBlockHook) return chain.getBlockHook(blockNumber);
          return chain.blockAt(blockNumber);
        } finally {
          chain.calls.inflightGetBlock -= 1;
        }
      },
      async getCode({ address }) {
        if (chain.getCodeHook) return chain.getCodeHook(address);
        return "0x6080";
      },
      async readContract({ address, functionName, args = [] }) {
        chain.calls.readContract += 1;
        return chain.read(address, functionName, args);
      },
      async multicall() {
        throw new Error("fake chain: multicall3 is null in the registry, plain calls only");
      },
      async call() {
        return { data: "0x" };
      },
      async getLogs({ address, event, fromBlock, toBlock }) {
        chain.calls.getLogs += 1;
        if (chain.getLogsHook) chain.getLogsHook({ from: fromBlock, to: toBlock, event });
        const want = new Set((Array.isArray(address) ? address : [address]).map((a) => a.toLowerCase()));
        const src = event ? chain.tokenLogs : chain.logs;
        return src.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock && want.has(l.address.toLowerCase()));
      },
    };
  }
}

export function fakeViem(chain) {
  return { ...viem, createPublicClient: () => chain.client() };
}

/** parseArgs with test defaults: --once, a state file in dir, no webhook unless one is given. */
export function options(dir, registry, extra = [], env = {}) {
  return parseArgs(["--once", "--rpc", "http://127.0.0.1:9", "--registry", registry, "--state", path.join(dir, "state.json"), ...extra], env);
}

export const kindsOf = (report) => report.findings.map((f) => f.kind);
