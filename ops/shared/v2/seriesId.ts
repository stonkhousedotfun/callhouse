// Series ids of the v2 Clearinghouse, computed off-chain.
//
// WHY THIS EXISTS: every Clearinghouse ERC-1155 id is derived, never assigned. The indexer keys
// series rows by it, the web builds balanceOf / redeem calls from a strike picker with it, and the
// keeper places and reprices orders against it; none of them should need an RPC round trip
// (`IClearinghouse.longIdOf`) to name a series, and all three must agree with the chain to the bit.
// This mirrors callhouse-contracts src/v2/interfaces/V2Ids.sol, the formula IClearinghouse.longIdOf
// documents:
//
//   longId  = uint256(keccak256(abi.encode(address underlying, bool isPut, uint128 strike, uint40 expiry))) & ~1
//   shortId = longId | 1
//
// abi.encode, not encodePacked: every field is a full 32-byte word, so the mirror is a plain
// encodeAbiParameters over the same four types. The low bit tells a long (0) from a short (1).
// Units (ADR-04): `strike` is USDG base units (6 dp) per whole share, $215.00 = 215_000_000n;
// `expiry` is unix seconds.
//
// ONE COPY IS EDITED: this file. indexer, web and keeper each import a byte copy that their
// `pnpm gen:abis` writes (indexer/src/v2, web/lib/v2, keeper/src/v2), because the workspace has no
// cross-package imports; each package's drift test fails if its copy differs from this file. So the
// imports are viem only, and the code must typecheck under all three tsconfigs (strict,
// noUncheckedIndexedAccess, isolatedModules).
//
// The test vectors in ops/fixtures/v2/series-ids.json are produced by Solidity
// (script/v2/EmitSeriesIds.s.sol in callhouse-contracts, copied here by script/v2/export-abis.sh),
// not by this file, so a mistake on either side fails the other side's test instead of being
// copied into both.
//
// DELIBERATELY ABSENT: no range clamping. viem's encoder throws on an address that is not one, a
// strike above uint128 or an expiry above uint40, which is what the Solidity signature would refuse.
import { encodeAbiParameters, keccak256, type Address } from "viem";

const SERIES_KEY = [{ type: "address" }, { type: "bool" }, { type: "uint128" }, { type: "uint40" }] as const;

/** Long id of the series (underlying, isPut, strike, expiry). The low bit is always 0. */
export function longIdOf(underlying: Address, isPut: boolean, strike: bigint, expiry: number | bigint): bigint {
  // abitype types uint40 as `number`. A bigint expiry above 2^53 loses precision in Number(), but
  // every such value is already above uint40's maximum, so the encoder still throws for it.
  const expirySeconds = typeof expiry === "bigint" ? Number(expiry) : expiry;
  return BigInt(keccak256(encodeAbiParameters(SERIES_KEY, [underlying, isPut, strike, expirySeconds]))) & ~1n;
}

/** Short id paired with `longId` (`longId | 1`). A short id passed in comes back unchanged. */
export function shortIdOf(longId: bigint): bigint {
  return longId | 1n;
}

/** Whether `id` is a short id (low bit 1). */
export function isShortId(id: bigint): boolean {
  return (id & 1n) === 1n;
}
