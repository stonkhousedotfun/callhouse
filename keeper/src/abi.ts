/**
 * ABI fragments, inlined as viem `as const` tuples so every readContract/writeContract call
 * infers its argument and return types.
 *
 * These are transcribed from the compiled artefacts in ops/abis (Vault.json, plus the linked
 * libraries' SeaportOrderLib.json, ValoremLib.json and Policy.json for their errors,
 * ValoremClear.json) and from ops/recon. They are deliberately NOT imported from those JSON
 * files: ops/ sits outside this package's tsconfig `rootDir`, and a plain JSON import loses the
 * literal types that make viem's inference work.
 *
 * Only what the keeper touches is here. Nothing is guessed. `abi.test.ts` re-derives the error
 * vocabulary from `contracts/out` when the artefacts are present and fails when a fragment here
 * has drifted from the Solidity.
 *
 * Write on fill (contracts redesign of 2026-09-13): `rollOpen(optionId)` ARMS an option type and
 * writes nothing; every Seaport fill of the vault's PARTIAL_RESTRICTED listing writes exactly the
 * filled contracts inside `authorizeOrder`. There is no registry, no `writeMore`, no
 * `invalidateStaleListing`, no EIP-1271 and no Overcall fee item.
 */

/*//////////////////////////////////////////////////////////////
                       SEAPORT ORDER STRUCTS
//////////////////////////////////////////////////////////////*/

const OFFER_ITEM = {
  name: 'offer',
  type: 'tuple[]',
  components: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
  ],
} as const;

const CONSIDERATION_ITEM = {
  name: 'consideration',
  type: 'tuple[]',
  components: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
    { name: 'recipient', type: 'address' },
  ],
} as const;

/** OrderComponents: the struct that is hashed into an order hash. Ends in `counter`. */
const ORDER_COMPONENTS = [
  { name: 'offerer', type: 'address' },
  { name: 'zone', type: 'address' },
  OFFER_ITEM,
  CONSIDERATION_ITEM,
  { name: 'orderType', type: 'uint8' },
  { name: 'startTime', type: 'uint256' },
  { name: 'endTime', type: 'uint256' },
  { name: 'zoneHash', type: 'bytes32' },
  { name: 'salt', type: 'uint256' },
  { name: 'conduitKey', type: 'bytes32' },
  { name: 'counter', type: 'uint256' },
] as const;

/** OrderParameters: identical to OrderComponents except the final field is the consideration
 *  count instead of the counter. This is what `validate` and the fulfil paths take. */
const ORDER_PARAMETERS = [
  { name: 'offerer', type: 'address' },
  { name: 'zone', type: 'address' },
  OFFER_ITEM,
  CONSIDERATION_ITEM,
  { name: 'orderType', type: 'uint8' },
  { name: 'startTime', type: 'uint256' },
  { name: 'endTime', type: 'uint256' },
  { name: 'zoneHash', type: 'bytes32' },
  { name: 'salt', type: 'uint256' },
  { name: 'conduitKey', type: 'bytes32' },
  { name: 'totalOriginalConsiderationItems', type: 'uint256' },
] as const;

/**
 * ZoneParameters: what Seaport 1.6 hands a restricted order's zone in `authorizeOrder` (before
 * the transfers) and `validateOrder` (after). The vault is its own zone; the offer and
 * consideration here are the SPENT and RECEIVED items of this fill — flat `identifier`/`amount`,
 * not the start/end pairs of OrderComponents.
 */
const ZONE_PARAMETERS = [
  { name: 'orderHash', type: 'bytes32' },
  { name: 'fulfiller', type: 'address' },
  { name: 'offerer', type: 'address' },
  {
    name: 'offer',
    type: 'tuple[]',
    components: [
      { name: 'itemType', type: 'uint8' },
      { name: 'token', type: 'address' },
      { name: 'identifier', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
    ],
  },
  {
    name: 'consideration',
    type: 'tuple[]',
    components: [
      { name: 'itemType', type: 'uint8' },
      { name: 'token', type: 'address' },
      { name: 'identifier', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
      { name: 'recipient', type: 'address' },
    ],
  },
  { name: 'extraData', type: 'bytes' },
  { name: 'orderHashes', type: 'bytes32[]' },
  { name: 'startTime', type: 'uint256' },
  { name: 'endTime', type: 'uint256' },
  { name: 'zoneHash', type: 'bytes32' },
] as const;

/*//////////////////////////////////////////////////////////////
                              VAULT
//////////////////////////////////////////////////////////////*/

/**
 * Vault.Harvest.
 *
 * Hoisted out of `vaultAbi` because the keeper queries it with `getLogs` as well as decoding
 * it from a receipt: the vault checkpoints the harvest inside `deposit()` and `mint()`, so a
 * deposit landing between a Seaport fill and `rollClose()` emits the week's premium EARLY and
 * the `rollClose` receipt then carries `Harvest(cycle, 0, 0, 0)`. Reading only the receipt
 * would publish a filled week as "unfilled, 0", which is the one thing the tape must never do.
 * After a stranded close, the retry's Harvest carries the STRANDED cycle's number.
 */
const HARVEST_EVENT = {
  type: 'event',
  name: 'Harvest',
  inputs: [
    { name: 'cycleNumber', type: 'uint32', indexed: true },
    { name: 'grossUsdg', type: 'uint256', indexed: false },
    { name: 'feeUsdg', type: 'uint256', indexed: false },
    { name: 'netUsdg', type: 'uint256', indexed: false },
  ],
} as const;

/** The same fragment, for `getLogs`. */
export const harvestEvent = HARVEST_EVENT;

/**
 * Vault.RollOpen and Vault.RollClose, hoisted for `getLogs` for the same reason as Harvest:
 * both carry the cycle number INDEXED, so a cycle the keeper never witnessed (its own receipt
 * timed out, or someone else ran the week) is reconstructable from the logs alone — the open
 * gives the block the harvest sum starts from, the close gives the assignment count.
 *
 * `RollOpen.contractsCount` is ALWAYS 0 under write on fill: the arm writes nothing. The week's
 * written size is the sum of `CallsWritten.contractsCount` over the cycle's claimKey.
 */
const ROLL_OPEN_EVENT = {
  type: 'event',
  name: 'RollOpen',
  inputs: [
    { name: 'cycleNumber', type: 'uint32', indexed: true },
    { name: 'optionId', type: 'uint256', indexed: true },
    { name: 'contractsCount', type: 'uint112', indexed: false },
    { name: 'strikeUsdg', type: 'uint256', indexed: false },
  ],
} as const;

/** The same fragment, for `getLogs`. */
export const rollOpenEvent = ROLL_OPEN_EVENT;

/** A stranded close (AF-02) reports zero legs here and emits ClaimStranded in the same receipt. */
const ROLL_CLOSE_EVENT = {
  type: 'event',
  name: 'RollClose',
  inputs: [
    { name: 'cycleNumber', type: 'uint32', indexed: true },
    { name: 'assetsReturned', type: 'uint256', indexed: false },
    { name: 'usdgFromAssignment', type: 'uint256', indexed: false },
    { name: 'contractsAssignedCount', type: 'uint256', indexed: false },
  ],
} as const;

/** The same fragment, for `getLogs`. */
export const rollCloseEvent = ROLL_CLOSE_EVENT;

/**
 * Vault.CallsWritten fires ONCE PER FILL, from inside `authorizeOrder`, with that fill's size.
 * Hoisted for `getLogs`: the keeper never sees a fill receipt (the buyer sends it), so the
 * week's sold count is the sum over the cycle's `claimKey`, and `contractsWritten()` must equal it.
 */
const CALLS_WRITTEN_EVENT = {
  type: 'event',
  name: 'CallsWritten',
  inputs: [
    { name: 'optionId', type: 'uint256', indexed: true },
    { name: 'claimKey', type: 'uint256', indexed: true },
    { name: 'contractsCount', type: 'uint112', indexed: false },
    { name: 'collateral', type: 'uint256', indexed: false },
  ],
} as const;

/** The same fragment, for `getLogs`. */
export const callsWrittenEvent = CALLS_WRITTEN_EVENT;

/**
 * Vault.ClaimStranded: a `rollClose` whose Valorem redeem reverted (USDG paused or frozen, NVDA
 * blocklist) reached Idle with the claim kept. `gen` is the strand generation; the keeper
 * alerts, skips `rollOpen` (it would revert `StillStranded`) and calls `retryStrandedClaim()`.
 */
const CLAIM_STRANDED_EVENT = {
  type: 'event',
  name: 'ClaimStranded',
  inputs: [
    { name: 'cycleNumber', type: 'uint32', indexed: true },
    { name: 'claimKey', type: 'uint256', indexed: true },
    { name: 'gen', type: 'uint256', indexed: false },
  ],
} as const;

/** The same fragment, for `getLogs`. */
export const claimStrandedEvent = CLAIM_STRANDED_EVENT;

export const vaultAbi = [
  // --- phase machine ---
  { type: 'function', name: 'phase', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  // Arms the option type for the week. Writes NOTHING: the arm gate reads the option tuple from
  // the clearinghouse itself (asset/USDG, lot 1e18, exercise >= now + 1 h, window >= 1 day,
  // tenor <= 21 days, fee, oracle, both band bounds) and numbers the cycle. Reverts
  // `StillStranded` while a stranded claim is outstanding.
  { type: 'function', name: 'rollOpen', inputs: [{ name: 'optionId_', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  // PARTIAL_RESTRICTED (orderType 3), offerer == zone == vault, ONE USDG consideration item to
  // the vault, amount <= Policy.maxContracts(totalAssets()) - contractsWritten. Pre-validated
  // on Seaport, so the order ships with an empty signature. Three per cycle, cancelled or not.
  {
    type: 'function',
    name: 'approveListing',
    inputs: [{ name: 'components', type: 'tuple', components: ORDER_COMPONENTS }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'cancelListing',
    inputs: [{ name: 'components', type: 'tuple', components: ORDER_COMPONENTS }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  { type: 'function', name: 'invalidateAllListings', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  // Permissionless: settle a redeem queue joined while the vault is flat (Idle).
  { type: 'function', name: 'settleQueue', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  // Permissionless: redeem the stranded claim once the freeze has lifted (reverts `NotStranded`
  // otherwise; `RedeemOutOfGas` if the call was gas-starved).
  { type: 'function', name: 'retryStrandedClaim', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'lockBook', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'rollClose', inputs: [], outputs: [], stateMutability: 'nonpayable' },

  // --- Seaport zone hooks: called BY SEAPORT during a fill, never by the keeper. Here so a fill
  // simulation's revert decodes (`PremiumBelowFloorAtFill`, `StrikeBelowBand`, `ReserveBreached`)
  // and so the hook selectors can be asserted against the artefact.
  {
    type: 'function',
    name: 'authorizeOrder',
    inputs: [{ name: 'zp', type: 'tuple', components: ZONE_PARAMETERS }],
    outputs: [{ type: 'bytes4' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'validateOrder',
    inputs: [{ name: '', type: 'tuple', components: ZONE_PARAMETERS }],
    outputs: [{ type: 'bytes4' }],
    stateMutability: 'view',
  },

  // --- cycle state ---
  { type: 'function', name: 'cycleNumber', inputs: [], outputs: [{ type: 'uint32' }], stateMutability: 'view' },
  { type: 'function', name: 'cycleExerciseTs', inputs: [], outputs: [{ type: 'uint40' }], stateMutability: 'view' },
  { type: 'function', name: 'cycleExpiryTs', inputs: [], outputs: [{ type: 'uint40' }], stateMutability: 'view' },
  { type: 'function', name: 'cycleStrikeUsdg', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'optionId', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'claimKey', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  // Written == sold under write on fill; there is no `contractsSold` / `contractsRemaining`.
  { type: 'function', name: 'contractsWritten', inputs: [], outputs: [{ type: 'uint112' }], stateMutability: 'view' },
  { type: 'function', name: 'contractsAssigned', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'lockedAssets', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'claimedExerciseProceeds',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },

  // --- stranded claim (AF-02): `phase == Idle && claimKey != 0` ---
  { type: 'function', name: 'isStranded', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'strandGen', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'lastResolvedGen', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'strandedRemainingWad', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'strands',
    inputs: [{ name: 'gen', type: 'uint256' }],
    outputs: [
      { name: 'assetsIn', type: 'uint256' },
      { name: 'usdgIn', type: 'uint256' },
      { name: 'wadLeft', type: 'uint256' },
      { name: 'assetsLeft', type: 'uint256' },
      { name: 'usdgLeft', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  { type: 'function', name: 'epochStrandWad', inputs: [{ name: 'epochId', type: 'uint256' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'epochStrandGen', inputs: [{ name: 'epochId', type: 'uint256' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'owedStrandWad', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'owedStrandGen', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },

  // --- listing state ---
  { type: 'function', name: 'listingHash', inputs: [], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'listingGrossUsdg', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'listingAmount', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  // Authorisations spent this cycle (MAX_LISTINGS_PER_CYCLE = 3); every approveListing counts.
  { type: 'function', name: 'listingsThisCycle', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },

  // --- accounting ---
  // Honest NAV: max(balance + locked - reserved, 0).
  { type: 'function', name: 'totalAssets', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'idleAssets', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalSupply', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'previewDeposit',
    inputs: [{ name: 'assets', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  // 0 whenever the one `DepositsClosed` gate is shut (halted, stranded, past exercise, cap,
  // unbacked reserve); the keeper reads it before it reports deposits open.
  {
    type: 'function',
    name: 'maxDeposit',
    inputs: [{ name: 'receiver', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'deposit',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  { type: 'function', name: 'accUsdgPerShare', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'claimableUsdg',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'claimUsdg',
    inputs: [],
    outputs: [{ name: 'amount', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'claimUsdgTo',
    inputs: [{ name: 'to', type: 'address' }],
    outputs: [{ name: 'amount', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  { type: 'function', name: 'totalUsdgDistributed', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'queuedShares', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'epochId', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'reservedAssets', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'usdgReservedForQueue',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  { type: 'function', name: 'canRedeemInstantly', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  // Includes the pro-rata `ReserveHaircut` and any settled stranded share.
  {
    type: 'function',
    name: 'previewCompleteRedeem',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'usdgOut', type: 'uint256' },
    ],
    stateMutability: 'view',
  },

  // --- policy + gates ---
  {
    type: 'function',
    name: 'policy',
    inputs: [],
    outputs: [
      { name: 'minOtmBps', type: 'uint16' },
      { name: 'maxOtmBps', type: 'uint16' },
      { name: 'minPremiumBps', type: 'uint16' },
      { name: 'maxUtilizationBps', type: 'uint16' },
      { name: 'protocolFeeBps', type: 'uint16' },
      { name: 'maxContractsCap', type: 'uint64' },
    ],
    stateMutability: 'view',
  },
  { type: 'function', name: 'spotUsdg', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'uiMultiplier', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'writesHalted', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'valoremFeeAccepted', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'depositCap', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'feeRecipient', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'setDepositCap',
    inputs: [{ name: 'cap', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setPolicy',
    inputs: [
      {
        name: 'p',
        type: 'tuple',
        components: [
          { name: 'minOtmBps', type: 'uint16' },
          { name: 'maxOtmBps', type: 'uint16' },
          { name: 'minPremiumBps', type: 'uint16' },
          { name: 'maxUtilizationBps', type: 'uint16' },
          { name: 'protocolFeeBps', type: 'uint16' },
          { name: 'maxContractsCap', type: 'uint64' },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'acceptValoremFee',
    inputs: [{ name: 'accepted', type: 'bool' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  { type: 'function', name: 'haltWrites', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'unhaltWrites', inputs: [], outputs: [], stateMutability: 'nonpayable' },

  // --- wiring, checked at boot (no registry, no overcallFeeRecipient) ---
  { type: 'function', name: 'asset', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'usdg', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'clear', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'seaport', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'conduitKey', inputs: [], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
  // == address(vault): the vault is its own zone.
  { type: 'function', name: 'seaportZone', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'transferApprovalTarget',
    inputs: [],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },

  // --- roles ---
  { type: 'function', name: 'KEEPER_ROLE', inputs: [], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'GUARDIAN_ROLE', inputs: [], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'DEFAULT_ADMIN_ROLE', inputs: [], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'hasRole',
    inputs: [
      { name: 'role', type: 'bytes32' },
      { name: 'account', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'grantRole',
    inputs: [
      { name: 'role', type: 'bytes32' },
      { name: 'account', type: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },

  // --- events the keeper reads back out of receipts and logs ---
  ROLL_OPEN_EVENT,
  {
    type: 'event',
    // `seq` is listingsThisCycle AFTER the approval: unique per listing within a cycle.
    name: 'ListingApproved',
    inputs: [
      { name: 'orderHash', type: 'bytes32', indexed: true },
      { name: 'optionId', type: 'uint256', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'grossUsdg', type: 'uint256', indexed: false },
      { name: 'seq', type: 'uint8', indexed: false },
    ],
  },
  { type: 'event', name: 'ListingCancelled', inputs: [{ name: 'orderHash', type: 'bytes32', indexed: true }] },
  CALLS_WRITTEN_EVENT,
  {
    type: 'event',
    name: 'AllListingsInvalidated',
    inputs: [{ name: 'newCounter', type: 'uint256', indexed: false }],
  },
  { type: 'event', name: 'BookLocked', inputs: [{ name: 'cycleNumber', type: 'uint32', indexed: true }] },
  ROLL_CLOSE_EVENT,
  HARVEST_EVENT,
  {
    type: 'event',
    name: 'QueueSettled',
    inputs: [
      { name: 'epochId', type: 'uint256', indexed: true },
      { name: 'shares', type: 'uint256', indexed: false },
      { name: 'assets', type: 'uint256', indexed: false },
      { name: 'usdgOut', type: 'uint256', indexed: false },
    ],
  },
  // Stranded-claim state machine (AF-02) and the split payout legs (AF-03, AF-05).
  CLAIM_STRANDED_EVENT,
  {
    type: 'event',
    name: 'EpochStrandShare',
    inputs: [
      { name: 'epochId', type: 'uint256', indexed: true },
      { name: 'gen', type: 'uint256', indexed: false },
      { name: 'wad', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'StrandedClaimRecovered',
    inputs: [
      { name: 'gen', type: 'uint256', indexed: true },
      { name: 'assets', type: 'uint256', indexed: false },
      { name: 'usdgOut', type: 'uint256', indexed: false },
      { name: 'queueWad', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'UsdgLegDeferred',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'receiver', type: 'address', indexed: true },
      { name: 'usdgOwed', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ReserveHaircut',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'booked', type: 'uint256', indexed: false },
      { name: 'paid', type: 'uint256', indexed: false },
    ],
  },

  /*------------------------------------------------------------------
    Custom errors, every one the vault can throw — its own, Policy's,
    SeaportOrderLib's, ValoremLib's, the adapters', AccessControl's and
    OpenZeppelin's. These carry no calldata cost and no runtime weight;
    they exist so a revert surfaces as `StrikeBelowBand(226000000,
    230720000)` in an alert at 20:00 UTC on a Friday instead of a bare
    four-byte selector.

    The 36 marked "linked library" are raised inside SeaportOrderLib or
    ValoremLib (DELEGATECALL) and are ABSENT from Vault.json: a decoder
    built from that artefact alone prints them as selectors. Generated
    from contracts/out at ca0e985 (92 unique); the cross-check test
    re-derives the list whenever the artefacts are present.
  ------------------------------------------------------------------*/
  { type: 'error', name: 'AccessControlBadConfirmation', inputs: [] }, // OpenZeppelin
  { type: 'error', name: 'AccessControlUnauthorizedAccount', inputs: [{ name: 'account', type: 'address' }, { name: 'neededRole', type: 'bytes32' }] }, // OpenZeppelin
  { type: 'error', name: 'BadConduitKey', inputs: [{ name: 'expected', type: 'bytes32' }, { name: 'got', type: 'bytes32' }] }, // SeaportOrderLib.sol:60 (linked library)
  { type: 'error', name: 'BadConsiderationIdentifier', inputs: [{ name: 'got', type: 'uint256' }] }, // SeaportOrderLib.sol:73 (linked library)
  { type: 'error', name: 'BadConsiderationItemType', inputs: [{ name: 'got', type: 'uint8' }] }, // SeaportOrderLib.sol:71 (linked library; ItemType enum)
  { type: 'error', name: 'BadConsiderationLength', inputs: [{ name: 'got', type: 'uint256' }] }, // SeaportOrderLib.sol:70 (linked library)
  { type: 'error', name: 'BadConsiderationToken', inputs: [{ name: 'expected', type: 'address' }, { name: 'got', type: 'address' }] }, // SeaportOrderLib.sol:72 (linked library)
  { type: 'error', name: 'BadCounter', inputs: [{ name: 'expected', type: 'uint256' }, { name: 'got', type: 'uint256' }] }, // SeaportOrderLib.sol:77 (linked library)
  { type: 'error', name: 'BadCycleWindow', inputs: [{ name: 'exerciseTs', type: 'uint40' }, { name: 'expiryTs', type: 'uint40' }] }, // Vault.sol:370
  { type: 'error', name: 'BadOfferIdentifier', inputs: [{ name: 'expected', type: 'uint256' }, { name: 'got', type: 'uint256' }] }, // SeaportOrderLib.sol:66 (linked library)
  { type: 'error', name: 'BadOfferItemType', inputs: [{ name: 'got', type: 'uint8' }] }, // SeaportOrderLib.sol:64 (linked library; ItemType enum)
  { type: 'error', name: 'BadOfferLength', inputs: [{ name: 'got', type: 'uint256' }] }, // SeaportOrderLib.sol:63 (linked library)
  { type: 'error', name: 'BadOfferToken', inputs: [{ name: 'expected', type: 'address' }, { name: 'got', type: 'address' }] }, // SeaportOrderLib.sol:65 (linked library)
  { type: 'error', name: 'BadOfferer', inputs: [{ name: 'got', type: 'address' }] }, // SeaportOrderLib.sol:58 (linked library)
  { type: 'error', name: 'BadOrderType', inputs: [{ name: 'got', type: 'uint8' }] }, // SeaportOrderLib.sol:62 (linked library; OrderType enum, PARTIAL_RESTRICTED = 3 required)
  { type: 'error', name: 'BadVaultRecipient', inputs: [{ name: 'expected', type: 'address' }, { name: 'got', type: 'address' }] }, // SeaportOrderLib.sol:74 (linked library)
  { type: 'error', name: 'BadZone', inputs: [{ name: 'expected', type: 'address' }, { name: 'got', type: 'address' }] }, // SeaportOrderLib.sol:59 (linked library; zone must be the vault)
  { type: 'error', name: 'BadZoneHash', inputs: [{ name: 'got', type: 'bytes32' }] }, // SeaportOrderLib.sol:61 (linked library)
  { type: 'error', name: 'ContractsAboveCap', inputs: [{ name: 'contractsRequested', type: 'uint256' }, { name: 'cap', type: 'uint256' }] }, // Policy.sol:101, raised via ValoremLib (linked library)
  { type: 'error', name: 'ContractsAboveUtilization', inputs: [{ name: 'contractsRequested', type: 'uint256' }, { name: 'maxByUtilization', type: 'uint256' }] }, // Policy.sol:102, raised via ValoremLib (linked library)
  { type: 'error', name: 'ContractsCapZero', inputs: [] }, // Policy.sol:94
  { type: 'error', name: 'ContractsZero', inputs: [] }, // Policy.sol:100, raised via ValoremLib (linked library)
  { type: 'error', name: 'DepositCapExceeded', inputs: [{ name: 'wouldBe', type: 'uint256' }, { name: 'cap', type: 'uint256' }] }, // Vault.sol:361
  { type: 'error', name: 'DepositsClosed', inputs: [] }, // Vault.sol:372 — the one deposit gate (replaces WrongPhase/DepositsClosedForCycle on the deposit path)
  { type: 'error', name: 'DutchAuctionNotAllowed', inputs: [] }, // SeaportOrderLib.sol:67 (linked library)
  { type: 'error', name: 'ERC20InsufficientAllowance', inputs: [{ name: 'spender', type: 'address' }, { name: 'allowance', type: 'uint256' }, { name: 'needed', type: 'uint256' }] }, // OpenZeppelin
  { type: 'error', name: 'ERC20InsufficientBalance', inputs: [{ name: 'sender', type: 'address' }, { name: 'balance', type: 'uint256' }, { name: 'needed', type: 'uint256' }] }, // OpenZeppelin
  { type: 'error', name: 'ERC20InvalidApprover', inputs: [{ name: 'approver', type: 'address' }] }, // OpenZeppelin
  { type: 'error', name: 'ERC20InvalidReceiver', inputs: [{ name: 'receiver', type: 'address' }] }, // OpenZeppelin
  { type: 'error', name: 'ERC20InvalidSender', inputs: [{ name: 'sender', type: 'address' }] }, // OpenZeppelin
  { type: 'error', name: 'ERC20InvalidSpender', inputs: [{ name: 'spender', type: 'address' }] }, // OpenZeppelin
  { type: 'error', name: 'EpochNotSettled', inputs: [{ name: 'epochId', type: 'uint256' }, { name: 'currentEpoch', type: 'uint256' }] }, // Vault.sol:360
  { type: 'error', name: 'ExerciseTooSoon', inputs: [{ name: 'exerciseTs', type: 'uint40' }, { name: 'earliest', type: 'uint40' }] }, // Vault.sol:343 (arm gate: exercise >= now + MIN_LEAD)
  { type: 'error', name: 'GuardianTooEarly', inputs: [{ name: 'allowedAt', type: 'uint40' }] }, // Vault.sol:365
  { type: 'error', name: 'InsufficientFreeShares', inputs: [{ name: 'free', type: 'uint256' }, { name: 'requested', type: 'uint256' }] }, // Vault.sol:364
  { type: 'error', name: 'InventoryLeftBehind', inputs: [{ name: 'balance', type: 'uint256' }, { name: 'baseline', type: 'uint256' }] }, // Vault.sol:355 (validateOrder: option balance not back at baseline)
  { type: 'error', name: 'ListingAlreadyEnded', inputs: [{ name: 'endTime', type: 'uint256' }] }, // SeaportOrderLib.sol:80 (linked library)
  { type: 'error', name: 'ListingOutlivesExercise', inputs: [{ name: 'endTime', type: 'uint256' }, { name: 'exerciseTimestamp', type: 'uint256' }] }, // SeaportOrderLib.sol:78 (linked library)
  { type: 'error', name: 'ListingStartsInFuture', inputs: [{ name: 'startTime', type: 'uint256' }] }, // SeaportOrderLib.sol:79 (linked library)
  { type: 'error', name: 'MaxOtmAboveCeiling', inputs: [{ name: 'got', type: 'uint16' }, { name: 'ceilBps', type: 'uint16' }] }, // Policy.sol:89
  { type: 'error', name: 'MinOtmBelowFloor', inputs: [{ name: 'got', type: 'uint16' }, { name: 'floorBps', type: 'uint16' }] }, // Policy.sol:88
  { type: 'error', name: 'MinPremiumBelowFloor', inputs: [{ name: 'got', type: 'uint16' }, { name: 'floorBps', type: 'uint16' }] }, // Policy.sol:91
  { type: 'error', name: 'NoLiveListing', inputs: [] }, // AdapterSeaport.sol:91
  { type: 'error', name: 'NoOpenClaim', inputs: [] }, // AdapterValorem.sol:70
  { type: 'error', name: 'NotAnOptionType', inputs: [{ name: 'tokenId', type: 'uint256' }] }, // Vault.sol:342 (arm gate: clear.tokenType != Option)
  { type: 'error', name: 'NotLiveListing', inputs: [{ name: 'orderHash', type: 'bytes32' }] }, // Vault.sol:352 (authorizeOrder: not this cycle's listing)
  { type: 'error', name: 'NotSeaport', inputs: [] }, // Vault.sol:350 (zone hooks: caller is not Seaport)
  { type: 'error', name: 'NotStranded', inputs: [] }, // Vault.sol:339 (retryStrandedClaim with nothing stranded)
  { type: 'error', name: 'NotYetExercisable', inputs: [{ name: 'exerciseTs', type: 'uint40' }] }, // Vault.sol:356
  { type: 'error', name: 'NotYetExpired', inputs: [{ name: 'expiryTs', type: 'uint40' }] }, // Vault.sol:357
  { type: 'error', name: 'NothingQueued', inputs: [] }, // Vault.sol:359
  { type: 'error', name: 'NothingToClaim', inputs: [] }, // Distributor.sol:93
  { type: 'error', name: 'OfferAmountZero', inputs: [] }, // SeaportOrderLib.sol:68 (linked library)
  { type: 'error', name: 'OfferExceedsCapacity', inputs: [{ name: 'requested', type: 'uint256' }, { name: 'capacity', type: 'uint256' }] }, // SeaportOrderLib.sol:69 (linked library; capacity = maxContracts(totalAssets) - contractsWritten)
  { type: 'error', name: 'OptionAssetMismatch', inputs: [{ name: 'expectedUnderlying', type: 'address' }, { name: 'gotUnderlying', type: 'address' }] }, // ValoremLib.sol:89 (linked library)
  { type: 'error', name: 'OptionExerciseAssetMismatch', inputs: [{ name: 'expectedExercise', type: 'address' }, { name: 'gotExercise', type: 'address' }] }, // ValoremLib.sol:90 (linked library)
  { type: 'error', name: 'OraclePaused', inputs: [] }, // Vault.sol:347
  { type: 'error', name: 'OrderHashMismatch', inputs: [{ name: 'expected', type: 'bytes32' }, { name: 'got', type: 'bytes32' }] }, // SeaportOrderLib.sol:83 (linked library)
  { type: 'error', name: 'OtmBandInverted', inputs: [{ name: 'minOtmBps', type: 'uint16' }, { name: 'maxOtmBps', type: 'uint16' }] }, // Policy.sol:90
  { type: 'error', name: 'PremiumBelowFloorAtFill', inputs: [{ name: 'grossUsdg', type: 'uint256' }, { name: 'floorUsdg', type: 'uint256' }] }, // Vault.sol:344 (authorizeOrder: floor re-priced at live spot, fee valued at spot)
  { type: 'error', name: 'PremiumBelowMinimum', inputs: [{ name: 'premiumUsdg', type: 'uint256' }, { name: 'minPremiumUsdg', type: 'uint256' }] }, // Policy.sol:99
  { type: 'error', name: 'PremiumNotDivisibleByOrderSize', inputs: [{ name: 'grossUsdg', type: 'uint256' }, { name: 'amount', type: 'uint256' }] }, // SeaportOrderLib.sol:75 (linked library)
  { type: 'error', name: 'PreviousListingLive', inputs: [{ name: 'liveHash', type: 'bytes32' }] }, // AdapterSeaport.sol:89
  { type: 'error', name: 'PriceAgeOutOfBounds', inputs: [{ name: 'got', type: 'uint32' }, { name: 'minAge', type: 'uint32' }, { name: 'maxAge', type: 'uint32' }] }, // Vault.sol:367
  { type: 'error', name: 'ProtocolFeeAboveCeiling', inputs: [{ name: 'got', type: 'uint16' }, { name: 'ceilBps', type: 'uint16' }] }, // Policy.sol:93
  { type: 'error', name: 'RedeemOutOfGas', inputs: [] }, // ValoremLib.sol:104 (linked library; a gas-starved close cannot fake a strand)
  { type: 'error', name: 'ReentrancyGuardReentrantCall', inputs: [] }, // OpenZeppelin
  { type: 'error', name: 'ReserveBreached', inputs: [{ name: 'balance', type: 'uint256' }, { name: 'reserved', type: 'uint256' }] }, // Vault.sol:345 (post-write check inside authorizeOrder)
  { type: 'error', name: 'SafeERC20FailedOperation', inputs: [{ name: 'token', type: 'address' }] }, // OpenZeppelin
  { type: 'error', name: 'SeaportCancelFailed', inputs: [] }, // SeaportOrderLib.sol:82 (linked library)
  { type: 'error', name: 'SeaportValidateFailed', inputs: [] }, // SeaportOrderLib.sol:81 (linked library)
  { type: 'error', name: 'SpotZero', inputs: [] }, // Policy.sol:96
  { type: 'error', name: 'StalePrice', inputs: [{ name: 'updatedAt', type: 'uint256' }, { name: 'maxAge', type: 'uint256' }] }, // Vault.sol:348
  { type: 'error', name: 'StillStranded', inputs: [] }, // Vault.sol:337 (rollOpen / deposit / instant redeem while a claim is stranded)
  { type: 'error', name: 'StrikeAboveBand', inputs: [{ name: 'strikeUsdg', type: 'uint256' }, { name: 'maxStrikeUsdg', type: 'uint256' }] }, // Policy.sol:98, raised via ValoremLib (linked library; arm only)
  { type: 'error', name: 'StrikeBelowBand', inputs: [{ name: 'strikeUsdg', type: 'uint256' }, { name: 'minStrikeUsdg', type: 'uint256' }] }, // Policy.sol:97 (arm AND every fill: reprice after a rally)
  { type: 'error', name: 'TooManyListings', inputs: [{ name: 'authorised', type: 'uint8' }, { name: 'max', type: 'uint8' }] }, // AdapterSeaport.sol:90
  { type: 'error', name: 'UnexpectedLotSize', inputs: [{ name: 'expected', type: 'uint96' }, { name: 'got', type: 'uint96' }] }, // ValoremLib.sol:91 (linked library)
  { type: 'error', name: 'UnitPriceExceedsStrike', inputs: [{ name: 'unitPriceUsdg', type: 'uint256' }, { name: 'strikeUsdg', type: 'uint256' }] }, // SeaportOrderLib.sol:76 (linked library)
  { type: 'error', name: 'UsdgLegBlocked', inputs: [{ name: 'usdgOwed', type: 'uint256' }] }, // Vault.sol:375 (AF-03: USDG leg could not be paid or deferred)
  { type: 'error', name: 'UseQueue', inputs: [] }, // Vault.sol:358
  { type: 'error', name: 'UtilizationAboveCeiling', inputs: [{ name: 'got', type: 'uint16' }, { name: 'ceilBps', type: 'uint16' }] }, // Policy.sol:92 (MAX_UTILIZATION_CEIL_BPS = 9985)
  { type: 'error', name: 'ValoremFeeNotAccepted', inputs: [{ name: 'feeBps', type: 'uint8' }] }, // Vault.sol:346
  { type: 'error', name: 'WriteReturnedNoClaim', inputs: [] }, // ValoremLib.sol:100 (linked library)
  { type: 'error', name: 'WriteReturnedWrongClaim', inputs: [{ name: 'expected', type: 'uint256' }, { name: 'got', type: 'uint256' }] }, // ValoremLib.sol:101 (linked library; a later fill's write landed on a different claim)
  { type: 'error', name: 'WriteWindowClosed', inputs: [{ name: 'exerciseTs', type: 'uint40' }] }, // Vault.sol:376 (fill after cycleExerciseTs)
  { type: 'error', name: 'WritesAreHalted', inputs: [] }, // Vault.sol:333
  { type: 'error', name: 'WrongPhase', inputs: [{ name: 'expected', type: 'uint8' }, { name: 'actual', type: 'uint8' }] }, // Vault.sol:332
  { type: 'error', name: 'ZeroAddr', inputs: [] }, // Vault.sol:366
  { type: 'error', name: 'ZeroAddress', inputs: [] }, // Distributor.sol:94
  { type: 'error', name: 'ZeroAssets', inputs: [] }, // Vault.sol:363
  { type: 'error', name: 'ZeroShares', inputs: [] }, // Vault.sol:362
] as const;

/*//////////////////////////////////////////////////////////////
                          VALOREM CLEAR
//////////////////////////////////////////////////////////////*/

/**
 * Exact upstream ValoremOptionsClearinghouse (valorem-core @6436c823, solc 0.8.16).
 *
 * TRAP, worth repeating everywhere it is used: `claim()` returns `amountWritten` and
 * `amountExercised` as 1e18-SCALED SCALARS, not contract counts. Divide by 1e18 before
 * comparing them with anything the vault calls a "contract".
 *
 * With no registry the keeper creates the week's option type itself: `newOptionType` is
 * permissionless and idempotent on the tuple (the same six fields always hash to the same id).
 */
export const clearAbi = [
  {
    type: 'function',
    name: 'newOptionType',
    inputs: [
      { name: 'underlyingAsset', type: 'address' },
      { name: 'underlyingAmount', type: 'uint96' },
      { name: 'exerciseAsset', type: 'address' },
      { name: 'exerciseAmount', type: 'uint96' },
      { name: 'exerciseTimestamp', type: 'uint40' },
      { name: 'expiryTimestamp', type: 'uint40' },
    ],
    outputs: [{ name: 'optionId', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'option',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      {
        name: 'optionInfo',
        type: 'tuple',
        components: [
          { name: 'underlyingAsset', type: 'address' },
          { name: 'underlyingAmount', type: 'uint96' },
          { name: 'exerciseAsset', type: 'address' },
          { name: 'exerciseAmount', type: 'uint96' },
          { name: 'exerciseTimestamp', type: 'uint40' },
          { name: 'expiryTimestamp', type: 'uint40' },
          { name: 'settlementSeed', type: 'uint160' },
          { name: 'nextClaimKey', type: 'uint96' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'claim',
    inputs: [{ name: 'claimId', type: 'uint256' }],
    outputs: [
      {
        name: 'claimInfo',
        type: 'tuple',
        components: [
          { name: 'amountWritten', type: 'uint256' },
          { name: 'amountExercised', type: 'uint256' },
          { name: 'optionId', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'position',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'underlyingAsset', type: 'address' },
          { name: 'underlyingAmount', type: 'int256' },
          { name: 'exerciseAsset', type: 'address' },
          { name: 'exerciseAmount', type: 'int256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'write',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'amount', type: 'uint112' },
    ],
    outputs: [{ name: 'claimId', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'redeem',
    inputs: [{ name: 'claimId', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'exercise',
    inputs: [
      { name: 'optionId', type: 'uint256' },
      { name: 'amount', type: 'uint112' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  { type: 'function', name: 'feesEnabled', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'feeBps', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'feeTo', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  // 0 None, 1 Option, 2 Claim. The arm gate requires Option.
  {
    type: 'function',
    name: 'tokenType',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: 'typeOfToken', type: 'uint8' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'id', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'isApprovedForAll',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'operator', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'setApprovalForAll',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'approved', type: 'bool' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    name: 'NewOptionType',
    inputs: [
      { name: 'optionId', type: 'uint256', indexed: false },
      { name: 'exerciseAsset', type: 'address', indexed: true },
      { name: 'underlyingAsset', type: 'address', indexed: true },
      { name: 'exerciseAmount', type: 'uint96', indexed: false },
      { name: 'underlyingAmount', type: 'uint96', indexed: false },
      { name: 'exerciseTimestamp', type: 'uint40', indexed: false },
      { name: 'expiryTimestamp', type: 'uint40', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'OptionsWritten',
    inputs: [
      { name: 'optionId', type: 'uint256', indexed: false },
      { name: 'writer', type: 'address', indexed: true },
      { name: 'claimId', type: 'uint256', indexed: false },
      { name: 'amount', type: 'uint112', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'OptionsExercised',
    inputs: [
      { name: 'optionId', type: 'uint256', indexed: true },
      { name: 'exerciser', type: 'address', indexed: true },
      { name: 'amount', type: 'uint112', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ClaimRedeemed',
    inputs: [
      { name: 'claimId', type: 'uint256', indexed: true },
      { name: 'optionId', type: 'uint256', indexed: true },
      { name: 'redeemer', type: 'address', indexed: true },
      { name: 'exerciseAmountRedeemed', type: 'uint256', indexed: false },
      { name: 'underlyingAmountRedeemed', type: 'uint256', indexed: false },
    ],
  },
  // What `claim()` reverts for a burned (redeemed) claim — the one revert the keeper expects to
  // see, and only if it ever reads the claim AFTER rollClose (IValoremClear.sol:319). Here so the
  // warn line names it instead of printing the bare selector 0x6caeb130.
  { type: 'error', name: 'TokenNotFound', inputs: [{ name: 'token', type: 'uint256' }] },
  // What `newOptionType` reverts when the tuple already exists (the id is the tuple's hash).
  { type: 'error', name: 'OptionsTypeExists', inputs: [{ name: 'optionId', type: 'uint256' }] },
  // The fee switch moving. The keeper alerts `fee_switch` on either edge; on, the vault refuses
  // to arm and to fill until an admin has accepted the fee.
  {
    type: 'event',
    name: 'FeeSwitchUpdated',
    inputs: [
      { name: 'feeTo', type: 'address', indexed: false },
      { name: 'enabled', type: 'bool', indexed: false },
    ],
  },
] as const;

/*//////////////////////////////////////////////////////////////
                            SEAPORT 1.6
//////////////////////////////////////////////////////////////*/

export const seaportAbi = [
  {
    type: 'function',
    name: 'getCounter',
    inputs: [{ name: 'offerer', type: 'address' }],
    outputs: [{ name: 'counter', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getOrderHash',
    inputs: [{ name: 'order', type: 'tuple', components: ORDER_COMPONENTS }],
    outputs: [{ name: 'orderHash', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getOrderStatus',
    inputs: [{ name: 'orderHash', type: 'bytes32' }],
    outputs: [
      { name: 'isValidated', type: 'bool' },
      { name: 'isCancelled', type: 'bool' },
      { name: 'totalFilled', type: 'uint256' },
      { name: 'totalSize', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'information',
    inputs: [],
    outputs: [
      { name: 'version', type: 'string' },
      { name: 'domainSeparator', type: 'bytes32' },
      { name: 'conduitController', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'fulfillOrder',
    inputs: [
      {
        name: 'order',
        type: 'tuple',
        components: [
          { name: 'parameters', type: 'tuple', components: ORDER_PARAMETERS },
          { name: 'signature', type: 'bytes' },
        ],
      },
      { name: 'fulfillerConduitKey', type: 'bytes32' },
    ],
    outputs: [{ name: 'fulfilled', type: 'bool' }],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'fulfillAdvancedOrder',
    inputs: [
      {
        name: 'advancedOrder',
        type: 'tuple',
        components: [
          { name: 'parameters', type: 'tuple', components: ORDER_PARAMETERS },
          { name: 'numerator', type: 'uint120' },
          { name: 'denominator', type: 'uint120' },
          { name: 'signature', type: 'bytes' },
          { name: 'extraData', type: 'bytes' },
        ],
      },
      {
        name: 'criteriaResolvers',
        type: 'tuple[]',
        components: [
          { name: 'orderIndex', type: 'uint256' },
          { name: 'side', type: 'uint8' },
          { name: 'index', type: 'uint256' },
          { name: 'identifier', type: 'uint256' },
          { name: 'criteriaProof', type: 'bytes32[]' },
        ],
      },
      { name: 'fulfillerConduitKey', type: 'bytes32' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [{ name: 'fulfilled', type: 'bool' }],
    stateMutability: 'payable',
  },
  {
    type: 'event',
    name: 'OrderFulfilled',
    inputs: [
      { name: 'orderHash', type: 'bytes32', indexed: false },
      { name: 'offerer', type: 'address', indexed: true },
      { name: 'zone', type: 'address', indexed: true },
      { name: 'recipient', type: 'address', indexed: false },
      {
        name: 'offer',
        type: 'tuple[]',
        indexed: false,
        components: [
          { name: 'itemType', type: 'uint8' },
          { name: 'token', type: 'address' },
          { name: 'identifier', type: 'uint256' },
          { name: 'amount', type: 'uint256' },
        ],
      },
      {
        name: 'consideration',
        type: 'tuple[]',
        indexed: false,
        components: [
          { name: 'itemType', type: 'uint8' },
          { name: 'token', type: 'address' },
          { name: 'identifier', type: 'uint256' },
          { name: 'amount', type: 'uint256' },
          { name: 'recipient', type: 'address' },
        ],
      },
    ],
  },
] as const;

/*//////////////////////////////////////////////////////////////
                              ERC-20
//////////////////////////////////////////////////////////////*/

export const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'totalSupply', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'allowance',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'approve',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'transfer',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const;

/*//////////////////////////////////////////////////////////////
                    ROBINHOOD CHAIN STOCK TOKEN
//////////////////////////////////////////////////////////////*/

/** The write gate the vault enforces on chain, mirrored here so the keeper can alert on it
 *  before it wastes a simulation. Probed, never assumed: an older Stock implementation does
 *  not have `oraclePaused()` at all. */
export const stockTokenAbi = [
  { type: 'function', name: 'oraclePaused', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'uiMultiplier', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const;
