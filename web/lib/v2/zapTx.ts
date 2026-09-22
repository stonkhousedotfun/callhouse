import { type Abi, type Address, type Hex, type PublicClient } from "viem";

import { USDG_DECIMALS } from "../contracts";
import { publicClient, robinhoodChain } from "../chain";
import { requireV2Address } from "./config";
import { stockZapAbi } from "../abi/v2/stockZap";
import { explainV2Error } from "./errors";
import { BPS } from "./payoff";
import type { WriteContext } from "./tx";
import { V2ReceiptUnknownError, waitForV2Receipt } from "./txStatus";

/**
 * IStockZap, from the GENERATED module. `web/lib/abi/v2/stockZap.ts` is emitted by
 * `web/scripts/gen-abis.mjs` from `ops/abis/v2/StockZap.json` (that name read off the generated
 * file's own header line 1 — the old comment here said `IStockZap.json`, which does not exist at
 * this base), and the generated module exists — the comment that used to stand here said the JSON
 * did not exist yet and that a file under
 * `lib/abi/v2/` would be deleted on the next gen-abis run. That is no longer true, and a
 * hand-written two-function `parseAbi` sitting beside the generated eight-function module is
 * exactly the drift the generator exists to prevent. Same change, same reason, as `lendTx.ts`.
 *
 * Callers still supply only asset + amounts + recipient + deadline — never a fee, tick spacing,
 * pool key, pool id or v3 pool. Verified against the generated ABI at this base: writeZap(address
 * asset, uint256 usdgIn, uint256 minAssetOut, address to, uint40 deadline) and exitZap(address
 * asset, uint256 assetIn, uint256 minUsdgOut, address to, uint40 deadline), argument for argument.
 * The generated module also carries the 39 error fragments the hand-rolled one had none of, so a
 * revert now decodes to a name instead of an unknown selector.
 */

/** Same bounds as buyQuote in ticket.ts:23-25. */
export const ZAP_SLIPPAGE_BPS_DEFAULT = 200;
export const ZAP_SLIPPAGE_BPS_MAX = 1_000;
/** Same quote lifetime as TAKE_QUOTE_LIFETIME_SECONDS in tx.ts:13. */
export const ZAP_DEADLINE_SECONDS = 300;

export type ZapQuote = { minOut: bigint; slippageBps: number };

function requireSlippageBps(slippageBps: number): number {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > ZAP_SLIPPAGE_BPS_MAX) {
    throw new RangeError("slippage tolerance must be 0–10%");
  }
  return slippageBps;
}

function applySlippage(amount: bigint, slippageBps: number): bigint {
  return amount * (BPS - BigInt(requireSlippageBps(slippageBps))) / BPS;
}

/**
 * `spot` MUST be the bigint returned by `selectTradeSpot()` (marketSpot.ts:12-19) — the same
 * value the writer page uses to gate deposits and asks. A null spot disables the zap; it must
 * not produce a zero or unbounded minOut.
 */
export function quoteWriteZap(usdgIn: bigint, spot: bigint | null, spotDecimals: number, assetDecimals: number,
  slippageBps = ZAP_SLIPPAGE_BPS_DEFAULT, usdgDecimals = USDG_DECIMALS): ZapQuote | null {
  if (spot === null || spot <= 0n || usdgIn <= 0n) return null;
  requireSlippageBps(slippageBps);
  const expected = usdgIn * (10n ** BigInt(spotDecimals)) * (10n ** BigInt(assetDecimals))
    / (spot * (10n ** BigInt(usdgDecimals)));
  const minOut = applySlippage(expected, slippageBps);
  if (minOut <= 0n) return null;
  return { minOut, slippageBps };
}

export function quoteExitZap(assetIn: bigint, spot: bigint | null, spotDecimals: number, assetDecimals: number,
  slippageBps = ZAP_SLIPPAGE_BPS_DEFAULT, usdgDecimals = USDG_DECIMALS): ZapQuote | null {
  if (spot === null || spot <= 0n || assetIn <= 0n) return null;
  requireSlippageBps(slippageBps);
  const expected = assetIn * spot * (10n ** BigInt(usdgDecimals))
    / ((10n ** BigInt(assetDecimals)) * (10n ** BigInt(spotDecimals)));
  const minOut = applySlippage(expected, slippageBps);
  if (minOut <= 0n) return null;
  return { minOut, slippageBps };
}

async function write(context: WriteContext, address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<Hex> {
  const client = context.client ?? publicClient;
  if (await context.wallet.getChainId() !== robinhoodChain.id) throw new Error("Switch to Robinhood Chain to continue.");
  try {
    const { request } = await client.simulateContract({ account: context.account, address, abi, functionName, args });
    const hash = await context.wallet.writeContract({ ...request, account: context.account, chain: robinhoodChain });
    await waitForV2Receipt(client, hash, functionName);
    try { await context.onConfirmed?.(hash); } catch { /* A confirmed write remains final. */ }
    return hash;
  } catch (error) {
    if (error instanceof V2ReceiptUnknownError) throw error;
    throw new Error(explainV2Error(error), { cause: error });
  }
}

/**
 * F-APP-02. The deadline is derived from CHAIN time, never the client wall clock.
 *
 * `Math.floor(Date.now() / 1000)` was the old source, and it is a guard that cannot see its subject:
 * the thing it bounds is chain time, and it was reading the browser's. A clock behind chain time
 * yields an instant `DeadlinePassed` revert; a clock ahead silently stretches the window past the
 * intended quote lifetime, which weakens the staleness guard on an oracle-spot-derived `minOut` —
 * the fail-open direction, and the one nobody notices.
 *
 * `tx.ts:99-101` already does this correctly three functions away, reading `getBlock({ blockTag:
 * "latest" })` and deriving from `block.timestamp`. This is that, not a new mechanism.
 */
async function deadline(client: PublicClient): Promise<number> {
  const block = await client.getBlock({ blockTag: "latest" });
  return Number(block.timestamp) + ZAP_DEADLINE_SECONDS;
}

function requireSpot(spot: bigint | null): bigint {
  if (spot === null || spot <= 0n) throw new Error("Live spot is unavailable.");
  return spot;
}

export async function writeZap(context: WriteContext, asset: Address, usdgIn: bigint, spot: bigint | null,
  spotDecimals: number, assetDecimals: number, slippageBps = ZAP_SLIPPAGE_BPS_DEFAULT): Promise<Hex> {
  const zap = requireV2Address("stockZap");
  const quote = quoteWriteZap(usdgIn, requireSpot(spot), spotDecimals, assetDecimals, slippageBps);
  if (!quote) throw new Error("Live spot is unavailable.");
  const until = await deadline(context.client ?? publicClient);
  return write(context, zap, stockZapAbi, "writeZap", [asset, usdgIn, quote.minOut, context.account, until]);
}

export async function exitZap(context: WriteContext, asset: Address, assetIn: bigint, spot: bigint | null,
  spotDecimals: number, assetDecimals: number, slippageBps = ZAP_SLIPPAGE_BPS_DEFAULT): Promise<Hex> {
  const zap = requireV2Address("stockZap");
  const quote = quoteExitZap(assetIn, requireSpot(spot), spotDecimals, assetDecimals, slippageBps);
  if (!quote) throw new Error("Live spot is unavailable.");
  const until = await deadline(context.client ?? publicClient);
  return write(context, zap, stockZapAbi, "exitZap", [asset, assetIn, quote.minOut, context.account, until]);
}
