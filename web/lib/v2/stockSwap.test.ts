/**
 * The buy path's arithmetic and calldata, on fixed quotes. The pool addresses and the router input
 * layout were measured on chain 4663 on 2026-09-23 (block 70319896 and a fork of the chain head); the
 * numbers here are those measurements, not values re-derived from memory.
 */
import {
  ContractFunctionExecutionError, ContractFunctionRevertedError, UserRejectedRequestError, decodeAbiParameters,
  decodeFunctionData, encodeErrorResult, getAddress, type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { describe, expect, it, vi } from "vitest";

import { permit2Abi, universalRouterAbi } from "../abi/v2/universalRouter";
import { WALLET_REJECTED_TEXT } from "./errors";
import { USDG } from "../contracts";
import { V2_UNISWAP_V3 } from "../markets.generated";
import {
  DEFAULT_SLIPPAGE_BPS, MAX_PRICE_IMPACT_BPS, MAX_SLIPPAGE_BPS, PERMIT2, PERMIT2_EXPIRY_SECONDS, POOL_FEE,
  SWAP_DEADLINE_SECONDS, UNIVERSAL_ROUTER, WETH, assembleQuote, buildBuyArgs, buildBuyCall, clampSlippageBps,
  encodeV3Path, executeStockBuy, explainStockSwapError, minimumOut, pickBestRoute, priceImpactBps, quoteStockBuy,
  refusalFor, routesFor, spotOut, v3PoolAddress, type RouteQuote, type StockQuote,
} from "./stockSwap";

const NVDA = getAddress("0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC");
const SPCX = getAddress("0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa");
const USER = getAddress("0x00000000000000000000000000000000000000a1");
const Q96 = 1n << 96n;
const ONE = 10n ** 18n;

const SWAP_INPUT = [
  { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bool" }, { type: "uint256[]" },
] as const;

function decodeExecute(data: Hex) {
  const { functionName, args } = decodeFunctionData({ abi: universalRouterAbi, data });
  expect(functionName).toBe("execute");
  const [commands, inputs, deadline] = args as unknown as [Hex, Hex[], bigint];
  return { commands, inputs, deadline };
}

describe("pool derivation (pinned: measured on chain 4663, 2026-09-23)", () => {
  it("derives every launch pool from the registry factory with the canonical v3 init-code hash", () => {
    expect(V2_UNISWAP_V3.factory).toBe("0x1f7d7550B1b028f7571E69A784071F0205FD2EfA");
    expect(v3PoolAddress(USDG, NVDA, POOL_FEE)).toBe("0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3");
    expect(v3PoolAddress(WETH, NVDA, POOL_FEE)).toBe("0x62AB521f71431f78ac374CdbadC6cda3c8916b6C");
    expect(v3PoolAddress(SPCX, USDG, POOL_FEE)).toBe("0xc61284332117c3FB23A2A56cceFFD07F7aF60029");
    expect(v3PoolAddress(WETH, SPCX, POOL_FEE)).toBe("0xC3c9F0171490Ef0F4536fe493F3b0EbB5ee0CB5e");
    expect(v3PoolAddress(WETH, USDG, POOL_FEE)).toBe("0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a");
  });

  it("is order-independent and fee-sensitive", () => {
    expect(v3PoolAddress(NVDA, USDG, POOL_FEE)).toBe(v3PoolAddress(USDG, NVDA, POOL_FEE));
    expect(v3PoolAddress(USDG, NVDA, 3000)).not.toBe(v3PoolAddress(USDG, NVDA, POOL_FEE));
  });
});

describe("routes and paths", () => {
  it("quotes ETH both ways and USDG one way; never through a registry payout route", () => {
    const eth = routesFor("ETH", NVDA, "NVDA");
    expect(eth.map((r) => r.hops.map((h) => [h.tokenIn, h.tokenOut]))).toEqual([
      [[WETH, NVDA]],
      [[WETH, USDG], [USDG, NVDA]],
    ]);
    expect(routesFor("USDG", SPCX, "SPCX").map((r) => r.hops.map((h) => [h.tokenIn, h.tokenOut]))).toEqual([[[USDG, SPCX]]]);
    expect([...eth, ...routesFor("USDG", NVDA)].every((r) => r.hops.every((h) => h.fee === POOL_FEE))).toBe(true);
  });

  it("packs a v3 path as token | fee(3) | token, matching the bytes the router accepted on the fork", () => {
    const [direct, viaUsdg] = routesFor("ETH", NVDA);
    expect(encodeV3Path(direct!.hops).toLowerCase()).toBe(
      "0x0bd7d308f8e1639fab988df18a8011f41eacad730001f4d0601ce157db5bdc3162bbac2a2c8af5320d9eec",
    );
    expect((encodeV3Path(viaUsdg!.hops).length - 2) / 2).toBe(20 + 3 + 20 + 3 + 20);
  });

  it("refuses hops that do not chain", () => {
    expect(() => encodeV3Path([{ tokenIn: WETH, fee: POOL_FEE, tokenOut: USDG }, { tokenIn: WETH, fee: POOL_FEE, tokenOut: NVDA }]))
      .toThrow(/do not chain/);
  });
});

describe("spot, impact and minimum out", () => {
  it("prices a hop in both directions from sqrtPriceX96, net of the LP fee", () => {
    const hop01 = { tokenIn: USDG, fee: POOL_FEE, tokenOut: NVDA }; // USDG is token0 of USDG/NVDA
    const hop10 = { tokenIn: NVDA, fee: POOL_FEE, tokenOut: USDG };
    // price token1/token0 = 4
    expect(spotOut(1_000_000n, [hop01], [2n * Q96])).toBe(4_000_000n * 9995n / 10000n);
    expect(spotOut(4_000_000n, [hop10], [2n * Q96])).toBe(1_000_000n * 9995n / 10000n);
  });

  it("matches the measured WETH/NVDA pool: 1 WETH is about 12.02 NVDA at slot0", () => {
    const sqrt = 274711216595708987447065968640n; // slot0 of 0x62AB…, block 70317498
    const out = spotOut(ONE, [{ tokenIn: WETH, fee: POOL_FEE, tokenOut: NVDA }], [sqrt]);
    expect(out).toBe((((ONE * sqrt * sqrt) >> 192n) * 999_500n) / 1_000_000n);
    expect(out / 10n ** 16n).toBe(1201n);
  });

  it("chains a two-hop route", () => {
    const hops = routesFor("ETH", NVDA)[1]!.hops;
    const out = spotOut(ONE, hops, [Q96, Q96]);
    expect(out).toBe(((ONE * 9995n) / 10000n * 9995n) / 10000n);
  });

  it("rounds price impact up and floors it at zero", () => {
    expect(priceImpactBps(9_970n, 10_000n)).toBe(30);
    expect(priceImpactBps(9_969n, 10_000n)).toBe(31);
    expect(priceImpactBps(99_699n, 100_000n)).toBe(31); // 30.01 bps rounds up
    expect(priceImpactBps(10_001n, 10_000n)).toBe(0);
  });

  it("takes minimum out from the QUOTE with the chosen slippage, clamped to the cap", () => {
    expect(DEFAULT_SLIPPAGE_BPS).toBe(50);
    expect(minimumOut(10_000_000n, 50)).toBe(9_950_000n);
    expect(minimumOut(10_000_000n, 10_000)).toBe(10_000_000n * BigInt(10_000 - MAX_SLIPPAGE_BPS) / 10_000n);
    expect(clampSlippageBps(0)).toBe(1);
    expect(clampSlippageBps(Number.NaN)).toBe(DEFAULT_SLIPPAGE_BPS);
  });
});

const ethRoutes = routesFor("ETH", NVDA, "NVDA");

function ethQuote(direct: bigint | null, via: bigint | null, sqrts: bigint[] = [Q96, Q96]): StockQuote {
  return assembleQuote({
    payToken: "ETH", stock: NVDA, amountIn: ONE, slippageBps: 50,
    candidates: [{ route: ethRoutes[0]!, amountOut: direct }, { route: ethRoutes[1]!, amountOut: via }], sqrtPricesX96: sqrts,
  });
}

describe("route choice and refusal", () => {
  it("takes the ETH path with the larger quoted output", () => {
    const q = ethQuote(ONE * 99n / 100n, ONE * 995n / 1000n);
    expect(q.route.label).toBe("ETH → USDG → NVDA");
    expect(q.amountOut).toBe(ONE * 995n / 1000n);
    expect(q.minOut).toBe((ONE * 995n / 1000n) * 9950n / 10000n);
    expect(q.candidates).toHaveLength(2);
  });

  it("never picks a path the quoter could not fill", () => {
    const candidates: RouteQuote[] = [{ route: ethRoutes[0]!, amountOut: null }, { route: ethRoutes[1]!, amountOut: 1n }];
    expect(pickBestRoute(candidates)?.route).toBe(ethRoutes[1]);
    expect(() => ethQuote(null, null)).toThrow(/No pool could quote/);
  });

  it("states the impact exactly, with no zero tail, so it never reads as equal to the limit", () => {
    expect(refusalFor(301, 1n)).toBe("This buy would move the price 3.01%, above the 3% limit. Try a smaller amount.");
    expect(refusalFor(350, 1n)).toContain("move the price 3.5%,");
    expect(refusalFor(400, 1n)).toContain("move the price 4%,");
    expect(refusalFor(MAX_PRICE_IMPACT_BPS, 1n)).toBeNull();
  });

  it("refuses above the impact cap, and a refused quote cannot be built into calldata", () => {
    // Direct route, spot at price 1 less the fee = 0.9995; a quote 3.5% under spot must be refused.
    const refused = ethQuote(ONE * 9645n / 10000n, null, [Q96]);
    expect(refused.impactBps).toBeGreaterThan(MAX_PRICE_IMPACT_BPS);
    expect(refused.refused).toMatch(/above the 3% limit/);
    expect(() => buildBuyCall(refused, USER, 1n)).toThrow(/above the 3% limit/);
    const fine = ethQuote(ONE * 9990n / 10000n, null, [Q96]);
    expect(fine.refused).toBeNull();
  });
});

describe("UniversalRouter calldata", () => {
  it("ETH: WRAP_ETH to the router then V3_SWAP_EXACT_IN to the wallet, six fields, value = amount", () => {
    const q = ethQuote(ONE * 12n, null, [Q96 * 3n]);
    const call = buildBuyCall(q, USER, 1_700_000_600n);
    expect(call.to).toBe(UNIVERSAL_ROUTER);
    expect(call.value).toBe(ONE);
    const { commands, inputs, deadline } = decodeExecute(call.data);
    expect(commands).toBe("0x0b00");
    expect(deadline).toBe(1_700_000_600n);
    expect(decodeAbiParameters([{ type: "address" }, { type: "uint256" }], inputs[0]!))
      .toEqual(["0x0000000000000000000000000000000000000002", ONE]);
    const [recipient, amountIn, amountOutMin, path, payerIsUser, minHop] = decodeAbiParameters(SWAP_INPUT, inputs[1]!);
    expect(recipient).toBe(USER);
    expect(amountIn).toBe(ONE);
    expect(amountOutMin).toBe(q.minOut);
    expect(amountOutMin).toBe(ONE * 12n * 9950n / 10000n);
    expect(path).toBe(q.path.toLowerCase());
    expect(payerIsUser).toBe(false);
    expect(minHop).toEqual([]);
  });

  it("USDG: a single V3_SWAP_EXACT_IN paid by the user through Permit2, no value", () => {
    const route = routesFor("USDG", SPCX, "SPCX")[0]!;
    const q = assembleQuote({
      payToken: "USDG", stock: SPCX, amountIn: 1_000_000_000n, slippageBps: 100,
      candidates: [{ route, amountOut: 6n * ONE }], sqrtPricesX96: [2n * Q96],
    });
    const { args, value } = buildBuyArgs(q, USER, 99n);
    expect(value).toBe(0n);
    expect(args[0]).toBe("0x00");
    const [recipient, , amountOutMin, , payerIsUser] = decodeAbiParameters(SWAP_INPUT, args[1][0]!);
    expect(recipient).toBe(USER);
    expect(amountOutMin).toBe(6n * ONE * 9900n / 10000n);
    expect(payerIsUser).toBe(true);
  });

  it("refuses the zero address as a recipient", () => {
    expect(() => buildBuyCall(ethQuote(ONE, null, [Q96]), "0x0000000000000000000000000000000000000000", 1n)).toThrow(/Connect a wallet/);
  });
});

describe("quoteStockBuy against a fake client", () => {
  it("quotes both ETH paths through the registry QuoterV2 and reads slot0 of the chosen route's pools", async () => {
    const simulateContract = vi.fn(async ({ args }: { args: readonly [Hex, bigint] }) => {
      const hops = (args[0].length - 2) / 2 === 43 ? 1 : 2;
      return { result: [hops === 1 ? ONE * 12n : ONE * 11n, [], [], 0n] };
    });
    const multicall = vi.fn(async ({ contracts }: { contracts: { address: Address }[] }) => contracts.map(() => [Q96 * 3n, 0, 0, 0, 0, 0, true]));
    const client = { simulateContract, multicall } as unknown as PublicClient;
    const q = await quoteStockBuy({ payToken: "ETH", stock: NVDA, symbol: "NVDA", amountIn: ONE, client });
    expect(simulateContract).toHaveBeenCalledTimes(2);
    for (const call of simulateContract.mock.calls) {
      expect(call[0]).toMatchObject({ address: V2_UNISWAP_V3.quoterV2, functionName: "quoteExactInput" });
    }
    expect(q.route.label).toBe("ETH → NVDA");
    expect(multicall.mock.calls[0]![0].contracts.map((c) => c.address)).toEqual(["0x62AB521f71431f78ac374CdbadC6cda3c8916b6C"]);
    expect(q.minOut).toBe(ONE * 12n * 9950n / 10000n);
  });
});

/** 5 USDG into NVDA at 1 NVDA = 1 USDG (raw price 1e12, since USDG has 6 decimals), quoted 0.15% under spot. */
function usdgQuote(): StockQuote {
  const route = routesFor("USDG", NVDA)[0]!;
  return assembleQuote({
    payToken: "USDG", stock: NVDA, amountIn: 5_000_000n, slippageBps: 50,
    candidates: [{ route, amountOut: 4_990n * 10n ** 15n }], sqrtPricesX96: [Q96 * 1_000_000n],
  });
}

describe("executeStockBuy", () => {
  function fakes(opts: { permitAmount?: bigint; permitExpiry?: number } = {}) {
    const sent: { address: Address; functionName: string; args: readonly unknown[]; value?: bigint }[] = [];
    const client = {
      getBlock: vi.fn(async () => ({ timestamp: 1_000n, number: 1n })),
      multicall: vi.fn(async () => [10n ** 12n, 0n]), // approveExact: balance, allowance
      readContract: vi.fn(async () => [opts.permitAmount ?? 0n, opts.permitExpiry ?? 0, 0]),
      simulateContract: vi.fn(async (req: { address: Address; functionName: string; args: readonly unknown[]; value?: bigint }) => {
        sent.push(req);
        return { request: req };
      }),
      waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })),
    } as unknown as PublicClient;
    const wallet = {
      getChainId: vi.fn(async () => 4663),
      writeContract: vi.fn(async () => "0xabc" as Hex),
    } as unknown as WalletClient;
    return { client, wallet, sent };
  }

  it("ETH: sends one router call with value and a deadline from the latest block", async () => {
    const { client, wallet, sent } = fakes();
    const q = ethQuote(ONE * 12n, null, [Q96 * 3n]);
    await executeStockBuy({ account: USER, wallet, client }, q);
    expect(sent.map((s) => s.functionName)).toEqual(["execute"]);
    expect(sent[0]!.address).toBe(UNIVERSAL_ROUTER);
    expect(sent[0]!.value).toBe(ONE);
    expect(sent[0]!.args[2]).toBe(1_000n + BigInt(SWAP_DEADLINE_SECONDS));
  });

  it("USDG: exact approve to Permit2, exact short-lived Permit2 allowance to the router, then the swap", async () => {
    const { client, wallet, sent } = fakes();
    const q = usdgQuote();
    await executeStockBuy({ account: USER, wallet, client }, q);
    expect(sent.map((s) => [s.address, s.functionName])).toEqual([[USDG, "approve"], [PERMIT2, "approve"], [UNIVERSAL_ROUTER, "execute"]]);
    expect(sent[0]!.args).toEqual([PERMIT2, 5_000_000n]);
    expect(sent[1]!.args).toEqual([USDG, UNIVERSAL_ROUTER, 5_000_000n, 1_000 + PERMIT2_EXPIRY_SECONDS]);
    expect(sent[2]!.value).toBe(0n);
  });

  it("USDG: the swap deadline comes from a block read AFTER the approvals, not before them", async () => {
    const { client, wallet, sent } = fakes();
    let ts = 1_000n;
    (client as unknown as { getBlock: () => Promise<unknown> }).getBlock = vi.fn(async () => { const b = { timestamp: ts, number: 1n }; ts += 500n; return b; });
    await executeStockBuy({ account: USER, wallet, client }, usdgQuote());
    expect(sent[1]!.args[3]).toBe(1_000 + PERMIT2_EXPIRY_SECONDS);
    expect(sent[2]!.args[2]).toBe(1_500n + BigInt(SWAP_DEADLINE_SECONDS));
  });

  it("USDG: skips the Permit2 approval when a live allowance already covers the amount", async () => {
    const { client, wallet, sent } = fakes({ permitAmount: 10n ** 12n, permitExpiry: 1_000 + SWAP_DEADLINE_SECONDS + 1 });
    const q = usdgQuote();
    await executeStockBuy({ account: USER, wallet, client }, q);
    expect(sent.map((s) => s.functionName)).toEqual(["approve", "execute"]);
  });

  it("refuses the wrong chain before sending anything", async () => {
    const { client, sent } = fakes();
    const wallet = { getChainId: vi.fn(async () => 1), writeContract: vi.fn() } as unknown as WalletClient;
    await expect(executeStockBuy({ account: USER, wallet, client }, ethQuote(ONE, null, [Q96]))).rejects.toThrow(/Robinhood Chain/);
    expect(sent).toHaveLength(0);
  });

  it("names a router slippage revert in plain words", () => {
    expect(explainStockSwapError({ cause: { data: { errorName: "V3TooLittleReceived" } } })).toMatch(/price moved past your minimum/);
    expect(explainStockSwapError(new Error("boom"))).toMatch(/could not be completed/);
  });

  /*
   * execute() is simulated against the ROUTER ABI, which does not list Permit2's errors, so a Permit2 revert
   * underneath the swap arrives as raw data viem could not name. The copy for it existed and could never be reached.
   */
  function routerRevert(data: Hex) {
    return new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: universalRouterAbi, data, functionName: "execute" }),
      { abi: universalRouterAbi, functionName: "execute", args: [], contractAddress: UNIVERSAL_ROUTER, sender: USER });
  }

  it("names a Permit2 revert under the router, which the router ABI cannot decode", () => {
    const expired = encodeErrorResult({ abi: permit2Abi, errorName: "AllowanceExpired", args: [1_700_000_000n] });
    expect(explainStockSwapError(routerRevert(expired))).toMatch(/Permit2 approval expired/);
    const short = encodeErrorResult({ abi: permit2Abi, errorName: "InsufficientAllowance", args: [5n] });
    expect(explainStockSwapError(routerRevert(short))).toMatch(/Permit2 is not approved/);
  });

  it("names a Permit2 revert the router wrapped in ExecutionFailed, and keeps an unknown one generic", () => {
    const inner = encodeErrorResult({ abi: permit2Abi, errorName: "InsufficientAllowance", args: [5n] });
    const wrapped = encodeErrorResult({ abi: universalRouterAbi, errorName: "ExecutionFailed", args: [0n, inner] });
    expect(explainStockSwapError(routerRevert(wrapped))).toMatch(/Permit2 is not approved/);
    expect(explainStockSwapError(routerRevert("0xdeadbeef"))).toMatch(/could not be completed/);
  });

  it("a swap the user rejects in the wallet says so", () => {
    const refused = new ContractFunctionExecutionError(new UserRejectedRequestError(new Error("User denied transaction signature.")),
      { abi: universalRouterAbi, functionName: "execute", args: [], contractAddress: UNIVERSAL_ROUTER, sender: USER });
    expect(explainStockSwapError(refused)).toBe(WALLET_REJECTED_TEXT);
  });
});
