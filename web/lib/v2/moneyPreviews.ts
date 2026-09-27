/**
 * The numbers a user sees before signing come from the contract's own preview views
 * themselves, not from a second copy of the math.
 *
 * These fragments are not a generated ABI. Regeneration is a separate step, and this file does not commit
 * generated ABI files. The selectors are the views' own; ERC-165 ids are unchanged.
 */
import { type Abi, type Address, type PublicClient } from "viem";

import { fmtUsdg, fmtEastern } from "@/lib/format";
import { displayQuantity } from "@/lib/numberFormat";

/** A revert, an unread call, or any failure. No digit, so a caller cannot mistake it for an amount. */
export const CANNOT_PREVIEW = "Cannot preview. Nothing is shown until the contract answers.";

const earnPreviewAbi = [
  {
    type: "function", name: "previewDeposit", stateMutability: "view",
    inputs: [{ name: "assets", type: "uint256" }],
    outputs: [{ name: "shares", type: "uint256" }, { name: "queued", type: "bool" }],
  },
  {
    type: "function", name: "previewRedeem", stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [
      { name: "assets", type: "uint256" },
      { name: "queued", type: "bool" },
      { name: "needsVenue", type: "bool" },
    ],
  },
  {
    type: "function", name: "previewQueued", stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "shares", type: "uint256" },
      { name: "assets", type: "uint256" },
      { name: "headNow", type: "bool" },
      { name: "needsVenue", type: "bool" },
    ],
  },
] as const satisfies Abi;

const clearinghousePreviewAbi = [
  {
    type: "function", name: "previewRedeem", stateMutability: "view",
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "holder", type: "address" },
      { name: "caller", type: "address" },
    ],
    outputs: [
      { name: "units", type: "uint256" },
      { name: "asset", type: "address" },
      { name: "owed", type: "uint256" },
      { name: "minUsdgOut", type: "uint256" },
    ],
  },
] as const satisfies Abi;

const autoRollerPreviewAbi = [
  {
    type: "function", name: "previewRoll", stateMutability: "view",
    inputs: [
      { name: "writer", type: "address" },
      { name: "underlying", type: "address" },
    ],
    outputs: [
      { name: "due", type: "bool" },
      { name: "strike", type: "uint128" },
      { name: "expiry", type: "uint40" },
      { name: "price", type: "uint128" },
      { name: "units", type: "uint64" },
    ],
  },
] as const satisfies Abi;

export type PreviewRead<T> = { ok: true } & T | { ok: false };

export type EarnDepositPreview = PreviewRead<{ shares: bigint; queued: boolean }>;
export type EarnRedeemPreview = PreviewRead<{ assets: bigint; queued: boolean; needsVenue: boolean }>;
export type EarnQueuedPreview = PreviewRead<{ shares: bigint; assets: bigint; headNow: boolean; needsVenue: boolean }>;
export type OptionRedeemPreview = PreviewRead<{ units: bigint; asset: Address; owed: bigint; minUsdgOut: bigint }>;
export type RollPreview = PreviewRead<{ due: boolean; strike: bigint; expiry: number; price: bigint; units: bigint }>;

async function ask<T>(read: () => Promise<T>): Promise<T | null> {
  try { return await read(); } catch { return null; }
}

export async function readEarnDepositPreview(client: PublicClient, vault: Address, assets: bigint): Promise<EarnDepositPreview> {
  const got = await ask(() => client.readContract({
    address: vault, abi: earnPreviewAbi, functionName: "previewDeposit", args: [assets],
  }));
  if (!got) return { ok: false };
  const [shares, queued] = got;
  return { ok: true, shares, queued };
}

export async function readEarnRedeemPreview(client: PublicClient, vault: Address, shares: bigint): Promise<EarnRedeemPreview> {
  const got = await ask(() => client.readContract({
    address: vault, abi: earnPreviewAbi, functionName: "previewRedeem", args: [shares],
  }));
  if (!got) return { ok: false };
  const [assets, queued, needsVenue] = got;
  return { ok: true, assets, queued, needsVenue };
}

export async function readEarnQueuedPreview(client: PublicClient, vault: Address, id: bigint): Promise<EarnQueuedPreview> {
  const got = await ask(() => client.readContract({
    address: vault, abi: earnPreviewAbi, functionName: "previewQueued", args: [id],
  }));
  if (!got) return { ok: false };
  const [shares, assets, headNow, needsVenue] = got;
  return { ok: true, shares, assets, headNow, needsVenue };
}

export async function readOptionRedeemPreview(
  client: PublicClient, clearinghouse: Address, tokenId: bigint, holder: Address, caller: Address,
): Promise<OptionRedeemPreview> {
  const got = await ask(() => client.readContract({
    address: clearinghouse, abi: clearinghousePreviewAbi, functionName: "previewRedeem", args: [tokenId, holder, caller],
  }));
  if (!got) return { ok: false };
  const [units, asset, owed, minUsdgOut] = got;
  return { ok: true, units, asset, owed, minUsdgOut };
}

export async function readRollPreview(
  client: PublicClient, roller: Address, writer: Address, underlying: Address,
): Promise<RollPreview> {
  const got = await ask(() => client.readContract({
    address: roller, abi: autoRollerPreviewAbi, functionName: "previewRoll", args: [writer, underlying],
  }));
  if (!got) return { ok: false };
  const [due, strike, expiry, price, units] = got;
  return { ok: true, due, strike, expiry, price, units };
}

function sharesText(shares: bigint, shareDecimals: number): string {
  return `${displayQuantity(shares, shareDecimals, { maxDecimals: 4 })} shares`;
}

/** What previewDeposit said. A queued deposit does not print the zero share count as if it were a mint. */
export function formatEarnDepositPreview(result: EarnDepositPreview, shareDecimals: number | null): string {
  if (!result.ok) return CANNOT_PREVIEW;
  if (result.queued) return "This deposit will queue. No shares are minted until it is served.";
  if (shareDecimals === null) return CANNOT_PREVIEW;
  return `You would receive ${sharesText(result.shares, shareDecimals)}.`;
}

/** What previewRedeem said, including the queued case and a withdrawal that still needs the venue. */
export function formatEarnRedeemPreview(result: EarnRedeemPreview): string {
  if (!result.ok) return CANNOT_PREVIEW;
  if (result.queued) return "This withdrawal will queue. Nothing is paid now.";
  const amount = `${fmtUsdg(result.assets, 2)} USDG`;
  if (result.needsVenue) return `You would receive ${amount} only if the lending venue delivers the rest.`;
  return `You would receive ${amount} now.`;
}

/** previewQueued's amount for one open request. An estimate behind the head says so. */
export function formatEarnQueuedPreview(result: EarnQueuedPreview, shareDecimals: number | null): string {
  if (!result.ok) return CANNOT_PREVIEW;
  const when = result.headNow ? "If served now" : "Estimate, earlier requests are served first";
  if (result.shares > 0n) {
    if (shareDecimals === null) return CANNOT_PREVIEW;
    return `${when}: ${sharesText(result.shares, shareDecimals)}.`;
  }
  if (result.needsVenue) return `${when}: ${fmtUsdg(result.assets, 2)} USDG only if the lending venue delivers the rest.`;
  return `${when}: ${fmtUsdg(result.assets, 2)} USDG.`;
}

/** Clearinghouse.previewRedeem: units, the asset, the amount owed, and the USDG floor. */
export function formatOptionRedeemPreview(result: OptionRedeemPreview): string {
  if (!result.ok) return CANNOT_PREVIEW;
  const floor = result.minUsdgOut === 0n
    ? "paid in the asset, with no USDG conversion"
    : `at least ${fmtUsdg(result.minUsdgOut, 2)} USDG if converted`;
  return `Collecting would redeem ${result.units.toString()} units of ${result.asset} and pay ${result.owed.toString()} base units of that asset, ${floor}.`;
}

/** AutoRoller.previewRoll. Not due means the contract would place nothing; the zeros are not shown as a quote. */
export function formatRollPreview(result: RollPreview): string {
  if (!result.ok) return CANNOT_PREVIEW;
  if (!result.due) return "No new roll would be placed now.";
  const when = fmtEastern(result.expiry);
  return `The next roll would write ${displayQuantity(result.units, 2, { maxDecimals: 2 })} shares at strike ${fmtUsdg(result.strike, 4)} USDG, expiry ${when}, ask ${fmtUsdg(result.price, 4)} USDG.`;
}

