/**
 * The week's Valorem option type: which tuple, and what its id will be before it exists.
 *
 * Valorem's `newOptionType` is permissionless and the id is a pure function of the six-field
 * tuple (ops/recon/R4-valorem-abi.md §"optionId derivation", reproduced here byte for byte):
 *
 *   optionKey = uint160(bytes20(keccak256(abi.encode(
 *                 underlyingAsset, underlyingAmount, exerciseAsset, exerciseAmount,
 *                 exerciseTimestamp, expiryTimestamp))))
 *   optionId  = uint256(optionKey) << 96
 *
 * `bytes20(hash)` takes the MOST significant 20 bytes, not the low 20, and the low 96 bits are
 * the claim key: 0 for the option itself, `>= 1` for a claim NFT written against it (the first
 * claim on an option is literally `optionId + 1`). Because the id is deterministic the keeper
 * can check `clear.tokenType(id)` before it spends gas: `Option` (1) means the tuple already
 * exists — another keeper, an earlier tick whose receipt was lost, anyone — and is reused;
 * `None` (0) means create it. Creating an existing tuple reverts `OptionsTypeExists(optionId)`,
 * which is why the read comes first.
 *
 * Pure. `optionType.test.ts` pins `optionIdFor` against the five real NVDA ids of Overcall's
 * cycle 1 (their tuples are on chain and their ids were emitted by the real Clear).
 */
import { encodeAbiParameters, keccak256, type Address } from 'viem';
import { BPS, ONE_LOT, USDG_ONE } from './config.js';

/** IValoremClear.TokenType. `option()` decodes a struct for ANY id; only this tells them apart. */
export const TOKEN_TYPE_NONE = 0;
export const TOKEN_TYPE_OPTION = 1;
export const TOKEN_TYPE_CLAIM = 2;

export interface OptionTuple {
  underlyingAsset: Address;
  /** One lot: 1e18 of the Stock Token. The vault refuses any other (UnexpectedLotSize). */
  underlyingAmount: bigint;
  exerciseAsset: Address;
  /** The strike per contract, USDG base units. */
  exerciseAmount: bigint;
  exerciseTimestamp: number;
  expiryTimestamp: number;
}

/** The option id Valorem will assign to (or has assigned to) this tuple. */
export function optionIdFor(t: OptionTuple): bigint {
  const hash = keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint96' }, { type: 'address' }, { type: 'uint96' }, { type: 'uint40' }, { type: 'uint40' }],
      [t.underlyingAsset, t.underlyingAmount, t.exerciseAsset, t.exerciseAmount, t.exerciseTimestamp, t.expiryTimestamp],
    ),
  );
  // The top 20 bytes of the hash are the option key; shifted into the high 160 bits of the id.
  return (BigInt(hash) >> 96n) << 96n;
}

/** The option id a claim id belongs to (its low 96 bits zeroed). */
export function optionIdOfClaim(claimId: bigint): bigint {
  return (claimId >> 96n) << 96n;
}

/**
 * The strike for the week: spot lifted by KEEPER_STRIKE_OTM_BPS and rounded to the nearest
 * whole USDG. Whole dollars because that is the tick Overcall's ladders use and what a buyer
 * expects to read on a call; the vault itself accepts any strike inside the band.
 *
 *   strike6 = round(spot6 × (10000 + otmBps) / 10000 / 1e6) × 1e6
 *
 * Round half up. Whether the result sits inside the policy band is the caller's check
 * (Policy.strikeBand at the same spot): with the launch band [3%, 12%] and a 5% target the
 * rounding can cross the lower bound only below a spot of about 25 USDG, but the check is made
 * rather than assumed.
 */
export function targetStrike6(spotUsdg6: bigint, otmBps: number | bigint): bigint {
  const lifted = (spotUsdg6 * (BPS + BigInt(otmBps))) / BPS;
  return ((lifted + USDG_ONE / 2n) / USDG_ONE) * USDG_ONE;
}

/** The tuple the vault will accept for this asset, this strike and this window. */
export function weeklyTuple(asset: Address, usdg: Address, strike6: bigint, exerciseTs: number, expiryTs: number): OptionTuple {
  return {
    underlyingAsset: asset,
    underlyingAmount: ONE_LOT,
    exerciseAsset: usdg,
    exerciseAmount: strike6,
    exerciseTimestamp: exerciseTs,
    expiryTimestamp: expiryTs,
  };
}
