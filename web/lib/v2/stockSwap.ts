/**
 * Buy NVDA or SPCX into the user's WALLET with ETH or USDG, through the Uniswap UniversalRouter
 * and the deep v3 pools on chain 4663.
 *
 * WHY NOT StockZap OR THE REGISTRY PAYOUT ROUTE. StockZap deposits into the Clearinghouse ledger, not the wallet,
 * and exists for writing calls. The registry's payout routes point at small v4 pools. The launch pools are the
 * fee-500 v3 pools below. They were measured on chain on 2026-09-23 at block 70319896, and a 10-share buy is a
 * small fraction of the ~$55k-$670k it takes to move any of them 1%:
 *
 *   USDG/NVDA  0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3   WETH/NVDA  0x62AB521f71431f78ac374CdbadC6cda3c8916b6C
 *   SPCX/USDG  0xc61284332117c3FB23A2A56cceFFD07F7aF60029   WETH/SPCX  0xC3c9F0171490Ef0F4536fe493F3b0EbB5ee0CB5e
 *   WETH/USDG  0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a   (the first hop of ETH -> USDG -> stock)
 *
 * Nothing here hard-codes a pool. Each one is DERIVED from the registry's v3 factory with the canonical v3
 * CREATE2 init-code hash (`v3PoolAddress`). That derivation reproduces all five addresses above, and
 * stockSwap.test.ts pins them. A wrong factory or hash fails that test instead of quoting a pool that does not
 * exist.
 *
 * ROUTES. USDG pays through USDG -> stock. ETH is quoted BOTH ways, directly through stock/WETH and through
 * WETH -> USDG -> stock, and the larger quoted output wins. Quoting only one ETH path is the forbidden shortcut.
 *
 * MINIMUM OUT comes from the QUOTE, never from spot: minOut = quoted out x (1 - slippage). Price impact
 * compares the quote with the pre-trade pool prices (slot0), net of each hop's LP fee, so the number shown
 * is the price moved by this trade and not the fee. A quote whose impact is above MAX_PRICE_IMPACT_BPS is
 * returned with `refused` set, and `buildBuyCall` will not build it.
 */
import {
  concatHex, decodeErrorResult, encodeAbiParameters, encodeFunctionData, getAddress, getContractAddress, keccak256,
  numberToHex, type Address, type Hex, type PublicClient,
} from "viem";

import { erc20Abi } from "../abi/erc20";
import { quoterV3Abi, uniswapV3PoolAbi } from "../abi/v2/quoterV3";
import { permit2Abi, universalRouterAbi } from "../abi/v2/universalRouter";
import { publicClient, robinhoodChain } from "../chain";
import { USDG } from "../contracts";
import { displayExact } from "../numberFormat";
import { V2_UNISWAP_V3 } from "../markets.generated";
import { isWalletRejection, WALLET_REJECTED_TEXT } from "./errors";
import { waitForV2Receipt, V2ReceiptUnknownError } from "./txStatus";
import { approveExact, type WriteContext } from "./tx";

/** WETH on 4663. On chain, the registry's QuoterV2 returns this address from WETH9(), and so does the router's WRAP_ETH deposit. */
export const WETH: Address = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
/** Uniswap UniversalRouter on 4663 (Etherscan-verified; poolManager() is the 4663 PoolManager). */
export const UNIVERSAL_ROUTER: Address = getAddress("0x8876789976decbfcbbbe364623c63652db8c0904");
/** Canonical Permit2. The router pulls ERC-20 input through it, so USDG is approved to Permit2, not the router. */
export const PERMIT2: Address = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
/** Uniswap v3 POOL_INIT_CODE_HASH. On 4663 it derives every pool above from the registry factory. */
export const V3_POOL_INIT_CODE_HASH: Hex = "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";
/** Every launch pool is the 0.05% tier. */
export const POOL_FEE = 500;

export const DEFAULT_SLIPPAGE_BPS = 50;
export const MAX_SLIPPAGE_BPS = 300;
/** Above 3% the quote is refused. A buy that big should be split or routed off-app. */
export const MAX_PRICE_IMPACT_BPS = 300;
/** The router's `execute` deadline, counted from the latest block's timestamp. */
export const SWAP_DEADLINE_SECONDS = 600;
/** Permit2 allowance lifetime for a USDG buy: long enough to confirm the swap, short enough not to linger. */
export const PERMIT2_EXPIRY_SECONDS = 1_800;

/** UniversalRouter command bytes, Commands.sol in the verified source: V3_SWAP_EXACT_IN = 0x00, WRAP_ETH = 0x0b. */
const V3_SWAP_EXACT_IN = 0x00;
const WRAP_ETH = 0x0b;
/** ActionConstants.ADDRESS_THIS: "the router itself", the recipient of wrapped ETH before the swap spends it. */
const ADDRESS_THIS: Address = "0x0000000000000000000000000000000000000002";
const MAX_UINT48 = (1n << 48n) - 1n;
const Q192 = 1n << 192n;
const BPS = 10_000n;
const FEE_DENOMINATOR = 1_000_000n;

export type PayToken = "ETH" | "USDG";
export const PAY_TOKENS: readonly PayToken[] = ["ETH", "USDG"];
export const PAY_DECIMALS: Record<PayToken, number> = { ETH: 18, USDG: 6 };
export const STOCK_DECIMALS = 18;

export type Hop = { tokenIn: Address; fee: number; tokenOut: Address };
export type Route = { label: string; hops: readonly Hop[] };

/** The candidate routes for one buy. ETH has two, and `quoteStockBuy` compares both. */
export function routesFor(payToken: PayToken, stock: Address, symbol = "stock"): Route[] {
  if (payToken === "USDG") return [{ label: `USDG → ${symbol}`, hops: [{ tokenIn: USDG, fee: POOL_FEE, tokenOut: stock }] }];
  return [
    { label: `ETH → ${symbol}`, hops: [{ tokenIn: WETH, fee: POOL_FEE, tokenOut: stock }] },
    {
      label: `ETH → USDG → ${symbol}`,
      hops: [{ tokenIn: WETH, fee: POOL_FEE, tokenOut: USDG }, { tokenIn: USDG, fee: POOL_FEE, tokenOut: stock }],
    },
  ];
}

/** Uniswap v3 packed path: tokenIn (20) | fee (3) | tokenOut (20) | fee (3) | ... */
export function encodeV3Path(hops: readonly Hop[]): Hex {
  if (hops.length === 0) throw new RangeError("A route needs at least one hop.");
  const parts: Hex[] = [hops[0]!.tokenIn];
  hops.forEach((hop, i) => {
    if (i > 0 && hop.tokenIn.toLowerCase() !== hops[i - 1]!.tokenOut.toLowerCase()) throw new RangeError("Route hops do not chain.");
    parts.push(numberToHex(hop.fee, { size: 3 }), hop.tokenOut);
  });
  return concatHex(parts);
}

/** The v3 pool for a pair and fee: CREATE2 from the factory over keccak(abi.encode(token0, token1, fee)). */
export function v3PoolAddress(tokenA: Address, tokenB: Address, fee: number, factory: Address = V2_UNISWAP_V3.factory): Address {
  const [token0, token1] = BigInt(tokenA) < BigInt(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA];
  const salt = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }], [token0, token1, fee]));
  return getContractAddress({ opcode: "CREATE2", from: factory, salt, bytecodeHash: V3_POOL_INIT_CODE_HASH });
}

/**
 * Output of `amountIn` at the pools' pre-trade prices, less each hop's LP fee. sqrtPriceX96 is sqrt(token1/token0)
 * in raw units. A zero-for-one hop multiplies by price and the other direction divides by it. Rounds down.
 */
export function spotOut(amountIn: bigint, hops: readonly Hop[], sqrtPricesX96: readonly bigint[]): bigint {
  if (sqrtPricesX96.length !== hops.length) throw new RangeError("One pool price per hop.");
  let amount = amountIn;
  hops.forEach((hop, i) => {
    const sqrtP = sqrtPricesX96[i]!;
    if (sqrtP <= 0n) throw new RangeError("Pool price is zero.");
    const priceX192 = sqrtP * sqrtP;
    const zeroForOne = BigInt(hop.tokenIn) < BigInt(hop.tokenOut);
    const out = zeroForOne ? (amount * priceX192) / Q192 : (amount * Q192) / priceX192;
    amount = (out * (FEE_DENOMINATOR - BigInt(hop.fee))) / FEE_DENOMINATOR;
  });
  return amount;
}

/** How far below spot the quote lands, in bps, rounded UP so a borderline trade is judged conservatively. */
export function priceImpactBps(quotedOut: bigint, spot: bigint): number {
  if (spot <= 0n) throw new RangeError("Spot output must be positive.");
  if (quotedOut >= spot) return 0;
  return Number(((spot - quotedOut) * BPS + spot - 1n) / spot);
}

export function clampSlippageBps(bps: number): number {
  if (!Number.isFinite(bps)) return DEFAULT_SLIPPAGE_BPS;
  return Math.min(MAX_SLIPPAGE_BPS, Math.max(1, Math.round(bps)));
}

/** Minimum out from the QUOTED output. Never from spot: spot ignores this trade's own impact. */
export function minimumOut(quotedOut: bigint, slippageBps: number): bigint {
  return (quotedOut * (BPS - BigInt(clampSlippageBps(slippageBps)))) / BPS;
}

export function refusalFor(impactBps: number, quotedOut: bigint): string | null {
  if (quotedOut <= 0n) return "The pools returned nothing for that amount. Try a larger amount.";
  if (impactBps > MAX_PRICE_IMPACT_BPS) {
    // Exact to the basis point, no zero tail: 301 bps reads "3.01%", never a truncated "3%" next to "the 3% limit".
    const pct = (bps: number) => `${displayExact(BigInt(bps), 2, { minDecimals: 0 })}%`;
    return `This buy would move the price ${pct(impactBps)}, above the ${pct(MAX_PRICE_IMPACT_BPS)} limit. Try a smaller amount.`;
  }
  return null;
}

export type RouteQuote = { route: Route; amountOut: bigint | null };

export type StockQuote = {
  payToken: PayToken;
  stock: Address;
  amountIn: bigint;
  route: Route;
  path: Hex;
  amountOut: bigint;
  spotOut: bigint;
  impactBps: number;
  slippageBps: number;
  minOut: bigint;
  /** Every candidate that was quoted, with null for a path the quoter could not fill. */
  candidates: RouteQuote[];
  /** Why this quote must not be sent, or null when it may. */
  refused: string | null;
};

/** The route with the larger quoted output. A route the quoter could not fill never wins. */
export function pickBestRoute(candidates: readonly RouteQuote[]): RouteQuote | null {
  let best: RouteQuote | null = null;
  for (const c of candidates) {
    if (c.amountOut === null) continue;
    if (best === null || c.amountOut > best.amountOut!) best = c;
  }
  return best;
}

/** Assemble a quote from already-read numbers. Pure, so the arithmetic is testable without a chain. */
export function assembleQuote(args: {
  payToken: PayToken; stock: Address; amountIn: bigint; slippageBps: number;
  candidates: RouteQuote[]; sqrtPricesX96: readonly bigint[];
}): StockQuote {
  const best = pickBestRoute(args.candidates);
  if (!best) throw new Error("No pool could quote that buy. Try again in a moment.");
  const spot = spotOut(args.amountIn, best.route.hops, args.sqrtPricesX96);
  const amountOut = best.amountOut!;
  const impactBps = priceImpactBps(amountOut, spot);
  const slippageBps = clampSlippageBps(args.slippageBps);
  return {
    payToken: args.payToken, stock: args.stock, amountIn: args.amountIn,
    route: best.route, path: encodeV3Path(best.route.hops),
    amountOut, spotOut: spot, impactBps, slippageBps, minOut: minimumOut(amountOut, slippageBps),
    candidates: args.candidates, refused: refusalFor(impactBps, amountOut),
  };
}

/** Quote every candidate route through QuoterV2 (an eth_call), then read the chosen route's pool prices. */
export async function quoteStockBuy(args: {
  payToken: PayToken; stock: Address; symbol?: string; amountIn: bigint; slippageBps?: number; client?: PublicClient;
}): Promise<StockQuote> {
  if (args.amountIn <= 0n) throw new RangeError("Enter an amount to pay.");
  const client = args.client ?? publicClient;
  const routes = routesFor(args.payToken, args.stock, args.symbol);
  const candidates = await Promise.all(routes.map(async (route): Promise<RouteQuote> => {
    try {
      const { result } = await client.simulateContract({
        address: V2_UNISWAP_V3.quoterV2, abi: quoterV3Abi, functionName: "quoteExactInput",
        args: [encodeV3Path(route.hops), args.amountIn],
      });
      return { route, amountOut: result[0] };
    } catch {
      return { route, amountOut: null };
    }
  }));
  const best = pickBestRoute(candidates);
  if (!best) throw new Error("No pool could quote that buy. Try again in a moment.");
  const slot0s = await client.multicall({
    allowFailure: false,
    contracts: best.route.hops.map((hop) => ({
      address: v3PoolAddress(hop.tokenIn, hop.tokenOut, hop.fee), abi: uniswapV3PoolAbi, functionName: "slot0" as const,
    })),
  });
  return assembleQuote({
    payToken: args.payToken, stock: args.stock, amountIn: args.amountIn,
    slippageBps: args.slippageBps ?? DEFAULT_SLIPPAGE_BPS, candidates, sqrtPricesX96: slot0s.map((s) => s[0]),
  });
}

export type BuyCall = { to: Address; data: Hex; value: bigint };
export type ExecuteArgs = readonly [commands: Hex, inputs: readonly Hex[], deadline: bigint];

/**
 * UniversalRouter `execute` arguments that swap `quote.amountIn` for at least `quote.minOut` of the stock, paid
 * to `recipient`. ETH wraps into the router first (WRAP_ETH to ADDRESS_THIS) and the swap spends the router's
 * WETH (payerIsUser = false). USDG is pulled from the user through Permit2 (payerIsUser = true).
 *
 * The 4663 router's V3_SWAP_EXACT_IN takes SIX fields: (recipient, amountIn, amountOutMin, path, payerIsUser,
 * minHopPriceX36). The last is sent empty, which disables the per-hop check (V3SwapRouter.sol). amountOutMin
 * still binds the whole route. A five-field input reverts SliceOutOfBounds().
 */
export function buildBuyArgs(quote: StockQuote, recipient: Address, deadline: bigint): { args: ExecuteArgs; value: bigint } {
  if (quote.refused) throw new Error(quote.refused);
  if (BigInt(recipient) === 0n) throw new Error("Connect a wallet to receive the stock.");
  if (quote.minOut <= 0n || quote.minOut > quote.amountOut) throw new RangeError("Minimum out must be positive and at most the quote.");
  const payerIsUser = quote.payToken === "USDG";
  const swap = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bool" }, { type: "uint256[]" }],
    [recipient, quote.amountIn, quote.minOut, quote.path, payerIsUser, []],
  );
  const commands: number[] = [];
  const inputs: Hex[] = [];
  if (quote.payToken === "ETH") {
    commands.push(WRAP_ETH);
    inputs.push(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ADDRESS_THIS, quote.amountIn]));
  }
  commands.push(V3_SWAP_EXACT_IN);
  inputs.push(swap);
  return {
    args: [concatHex(commands.map((c) => numberToHex(c, { size: 1 }))), inputs, deadline],
    value: quote.payToken === "ETH" ? quote.amountIn : 0n,
  };
}

/** The same call as raw calldata, for an eth_call simulation or a wallet that takes `data`. */
export function buildBuyCall(quote: StockQuote, recipient: Address, deadline: bigint): BuyCall {
  const { args, value } = buildBuyArgs(quote, recipient, deadline);
  return { to: UNIVERSAL_ROUTER, data: encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args }), value };
}

export type BuyBalances = { stock: bigint; eth: bigint; usdg: bigint };

/** The wallet's stock, ETH and USDG balances in one round trip. */
export async function readBuyBalances(stock: Address, account: Address, client: PublicClient = publicClient): Promise<BuyBalances> {
  const [eth, [stockBalance, usdg]] = await Promise.all([
    client.getBalance({ address: account }),
    client.multicall({ allowFailure: false, contracts: [
      { address: stock, abi: erc20Abi, functionName: "balanceOf", args: [account] },
      { address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [account] },
    ] }),
  ]);
  return { stock: stockBalance, eth, usdg };
}

const ROUTER_ERROR_TEXT: Record<string, string> = {
  V3TooLittleReceived: "The price moved past your minimum. Get a new quote and try again.",
  TransactionDeadlinePassed: "The quote expired before the swap was mined. Get a new quote and try again.",
  InsufficientAllowance: "Permit2 is not approved for that much USDG. Approve again and retry.",
  AllowanceExpired: "The Permit2 approval expired. Approve again and retry.",
  InsufficientETH: "The wallet did not send enough ETH for that buy.",
};

export class StockSwapError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "StockSwapError";
  }
}

/**
 * Every error the router call can revert with: the router's own and Permit2's underneath it. `execute` is
 * simulated against the ROUTER ABI, which does not list Permit2's errors, so an InsufficientAllowance or
 * AllowanceExpired from Permit2 reaches here as raw revert data that viem could not name. A command the router ran
 * by call arrives wrapped in ExecutionFailed(commandIndex, message); its message is the inner revert.
 */
const SWAP_ERRORS_ABI = [...universalRouterAbi, ...permit2Abi].filter((item) => item.type === "error");

function swapErrorName(raw: Hex, depth = 0): string | null {
  try {
    const { errorName, args } = decodeErrorResult({ abi: SWAP_ERRORS_ABI, data: raw });
    const message = errorName === "ExecutionFailed" ? (args as readonly unknown[] | undefined)?.[1] : undefined;
    if (typeof message === "string" && /^0x[0-9a-fA-F]{8,}$/.test(message) && depth < 3) return swapErrorName(message as Hex, depth + 1);
    return errorName;
  } catch {
    return null;
  }
}

/** Plain copy for a router or Permit2 revert, or a wallet refusal, found anywhere in viem's cause chain. */
export function explainStockSwapError(error: unknown): string {
  let cause: unknown = error;
  const seen = new Set<unknown>();
  while (cause && typeof cause === "object" && !seen.has(cause)) {
    seen.add(cause);
    const value = cause as { errorName?: unknown; data?: unknown; raw?: unknown; cause?: unknown; shortMessage?: unknown };
    const decoded = value.data as { errorName?: unknown } | null;
    for (const name of [value.errorName, decoded && typeof decoded === "object" ? decoded.errorName : undefined]) {
      if (typeof name === "string" && name in ROUTER_ERROR_TEXT) return ROUTER_ERROR_TEXT[name]!;
    }
    const raw = typeof value.data === "string" ? value.data : value.raw;
    if (typeof raw === "string" && /^0x[0-9a-fA-F]{8,}$/.test(raw)) {
      const name = swapErrorName(raw as Hex);
      if (name !== null && name in ROUTER_ERROR_TEXT) return ROUTER_ERROR_TEXT[name]!;
    }
    cause = value.cause;
  }
  if (isWalletRejection(error)) return WALLET_REJECTED_TEXT;
  return "The swap could not be completed. Get a new quote and try again.";
}

/**
 * Send the buy. USDG first gets an exact ERC-20 approval to Permit2 (`approveExact`, never unlimited) and an
 * exact, short-lived Permit2 allowance to the router. Then the router call is simulated with its value and sent.
 * The deadline is taken from the latest block, not the local clock, and read again after any approval.
 */
export async function executeStockBuy(context: WriteContext, quote: StockQuote): Promise<Hex> {
  if (quote.refused) throw new Error(quote.refused);
  const client = context.client ?? publicClient;
  if (await context.wallet.getChainId() !== robinhoodChain.id) throw new Error("Switch to Robinhood Chain to continue.");
  const block = await client.getBlock({ blockTag: "latest" });
  if (quote.payToken === "USDG") {
    await approveExact(context, USDG, PERMIT2, quote.amountIn);
    const [allowed, expiration] = await client.readContract({
      address: PERMIT2, abi: permit2Abi, functionName: "allowance", args: [context.account, USDG, UNIVERSAL_ROUTER],
    });
    if (allowed < quote.amountIn || BigInt(expiration) < block.timestamp + BigInt(SWAP_DEADLINE_SECONDS)) {
      const expiry = block.timestamp + BigInt(PERMIT2_EXPIRY_SECONDS);
      await sendSimulated(context, client, "approve", () => client.simulateContract({
        account: context.account, address: PERMIT2, abi: permit2Abi, functionName: "approve",
        args: [USDG, UNIVERSAL_ROUTER, quote.amountIn, Number(expiry > MAX_UINT48 ? MAX_UINT48 : expiry)],
      }));
    }
  }
  // Approvals can take minutes of wallet prompts, so a USDG buy takes its deadline from a fresh block.
  const now = quote.payToken === "USDG" ? (await client.getBlock({ blockTag: "latest" })).timestamp : block.timestamp;
  const { args, value } = buildBuyArgs(quote, context.account, now + BigInt(SWAP_DEADLINE_SECONDS));
  return sendSimulated(context, client, "execute", () => client.simulateContract({
    account: context.account, address: UNIVERSAL_ROUTER, abi: universalRouterAbi, functionName: "execute", args, value,
  }));
}

/** Simulate against current chain state, send the simulated request, and wait for a successful receipt. */
async function sendSimulated(
  context: WriteContext, client: PublicClient, operation: string, simulate: () => Promise<{ request: object }>,
): Promise<Hex> {
  try {
    const { request } = await simulate();
    const hash = await context.wallet.writeContract({ ...request, account: context.account, chain: robinhoodChain } as never);
    await waitForV2Receipt(client, hash, operation);
    try { await context.onConfirmed?.(hash); } catch { /* the receipt is final; a refresh failure must not invite a retry */ }
    return hash;
  } catch (error) {
    if (error instanceof V2ReceiptUnknownError) throw error;
    throw new StockSwapError(explainStockSwapError(error), error);
  }
}
