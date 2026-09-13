import { index, onchainEnum, onchainTable } from "ponder";

/*//////////////////////////////////////////////////////////////
                              ENUMS
//////////////////////////////////////////////////////////////*/

/**
 * The life of one Overcall cycle as this product tells it.
 *
 *   idle      the registry opened the week but the vault never wrote into it (no rung inside
 *             the OTM band, writes halted, nothing idle to write against). A real, published
 *             outcome, not a gap in the tape.
 *   listed    the vault wrote calls and the inventory is (or was) on the book.
 *   filled    a buyer actually filled. Set the moment the first matching OrderFulfilled lands.
 *   unfilled  the week closed with zero contracts sold. THE MOST LIKELY OUTCOME, and the one
 *             the product promises to publish honestly as "unfilled, 0".
 *   closed    the week closed after a fill, expiring out of the money. Premium kept, tokens kept.
 *   assigned  the week closed with contracts assigned: tokens went out at the strike, USDG came in.
 *
 * `unfilled`, `closed` and `assigned` are terminal. `idle` is terminal for a skipped week.
 */
export const cycleStatus = onchainEnum("cycle_status", [
  "idle",
  "listed",
  "filled",
  "unfilled",
  "assigned",
  "closed",
]);

/** Seaport order lifecycle as observed on chain. */
export const listingStatus = onchainEnum("listing_status", [
  "approved",
  "partially_filled",
  "filled",
  "cancelled",
  "invalidated",
  "expired",
]);

export const epochStatus = onchainEnum("epoch_status", ["open", "settled"]);

/*//////////////////////////////////////////////////////////////
                          VAULT STATE
//////////////////////////////////////////////////////////////*/

/**
 * One row, keyed by the vault address: the running reduction of every event seen so far.
 *
 * Everything here is derived from logs, never from an RPC read, so it is deterministic and
 * reproducible from a backfill. Where a derived figure can drift from the contract's own view
 * mid-cycle, the column name says so (see `lockedCollateral`).
 */
export const vaultState = onchainTable("vault_state", (t) => ({
  id: t.hex().primaryKey(),

  /** 0 Idle, 1 Listed, 2 Exercisable, 3 Settling. Derived from RollOpen / BookLocked / RollClose. */
  phase: t.integer().notNull().default(0),
  writesHalted: t.boolean().notNull().default(false),

  /** Registry cycle the vault is written into. 0 while flat. */
  cycleNumber: t.integer().notNull().default(0),
  optionId: t.bigint(),
  claimKey: t.bigint(),
  strikeUsdg: t.bigint().notNull().default(0n),
  exerciseTimestamp: t.bigint().notNull().default(0n),
  expiryTimestamp: t.bigint().notNull().default(0n),

  contractsWritten: t.bigint().notNull().default(0n),
  /**
   * Contracts that left the vault on a Seaport fill.
   * NOT readable from the vault: `AdapterValorem.contractsSold` is declared but never written
   * on chain. The only source of truth is Seaport's OrderFulfilled, so this is indexed.
   */
  contractsSold: t.bigint().notNull().default(0n),

  listingHash: t.hex(),
  listingsThisCycle: t.integer().notNull().default(0),

  /** Raw ERC-20 balance of the asset held by the vault, from Transfer logs. 18 decimals. */
  assetBalance: t.bigint().notNull().default(0n),
  /** Raw USDG balance of the vault, from Transfer logs. 6 decimals. */
  usdgBalance: t.bigint().notNull().default(0n),
  /**
   * Collateral currently locked in Valorem, set at write and cleared at redeem.
   * Deliberately NOT called `lockedAssets`: the contract's `lockedAssets()` reads Valorem's
   * live position and therefore falls as buyers are assigned mid-week, while this figure
   * holds at the amount written until the claim is redeemed. The API reads the live number.
   */
  lockedCollateral: t.bigint().notNull().default(0n),
  /** Asset base units promised to settled redemption epochs and excluded from NAV. */
  reservedAssets: t.bigint().notNull().default(0n),
  /** USDG base units promised to settled redemption epochs. */
  usdgReservedForQueue: t.bigint().notNull().default(0n),

  totalShares: t.bigint().notNull().default(0n),
  queuedShares: t.bigint().notNull().default(0n),
  epochId: t.bigint().notNull().default(1n),

  /** Distributor index, 1e27-scaled USDG per share. */
  accUsdgPerShare: t.bigint().notNull().default(0n),
  totalUsdgDistributed: t.bigint().notNull().default(0n),
  totalUsdgClaimed: t.bigint().notNull().default(0n),

  /** Lifetime totals across every cycle. USDG base units. */
  lifetimePremiumGross: t.bigint().notNull().default(0n),
  lifetimePremiumToVault: t.bigint().notNull().default(0n),
  lifetimeOvercallFee: t.bigint().notNull().default(0n),
  lifetimeAssignmentUsdg: t.bigint().notNull().default(0n),
  lifetimeProtocolFee: t.bigint().notNull().default(0n),
  /**
   * Protocol fee actually paid out. The fee accrues at every harvest with premium in it (counted in
   * `lifetimeProtocolFee`) but the push is best-effort — a blocked recipient must not freeze
   * `rollClose` — so payment trails accrual and completes via the permissionless `sweepFee`.
   * `lifetimeProtocolFee − totalFeeSwept` is the vault's live `pendingFeeUsdg`.
   */
  totalFeeSwept: t.bigint().notNull().default(0n),
  lifetimePremiumNet: t.bigint().notNull().default(0n),
  cyclesWritten: t.integer().notNull().default(0),
  cyclesFilled: t.integer().notNull().default(0),
  cyclesUnfilled: t.integer().notNull().default(0),
  cyclesAssigned: t.integer().notNull().default(0),

  /** Governance-visible settings, mirrored from their events. */
  depositCap: t.bigint().notNull().default(0n),
  feeRecipient: t.hex(),
  protocolFeeBps: t.integer().notNull().default(0),
  valoremFeeAccepted: t.boolean().notNull().default(false),

  /** USDG received while there were no shares, or too small to index. Carried, never dropped. */
  usdgUnallocated: t.bigint().notNull().default(0n),

  /** Seaport nonce for this offerer. Bumped by `invalidateAllListings()`. */
  seaportCounter: t.bigint().notNull().default(0n),

  /** Lot size the registry last announced, asset base units per contract. */
  registryLotSize: t.bigint().notNull().default(0n),

  /**
   * The listing cancelled most recently, and the tx it happened in.
   * `_invalidateAllListings()` emits ListingCancelled and then AllListingsInvalidated, so
   * this is how the second handler recognises the order the first one just closed and
   * upgrades its end reason from "cancelled" to "invalidated" without a table scan.
   */
  lastCancelledHash: t.hex(),
  lastCancelledTx: t.hex(),

  /**
   * The transaction the most recent `RollClose` was emitted in.
   *
   * WHY: `Harvest` is emitted from TWO places. `_harvest()` runs inside `rollClose` and is
   * the week's verdict; `_checkpointHarvest()` runs inside `deposit`/`mint` and fires
   * mid-week, whenever premium has already landed, so that new shares cannot claim premium
   * earned before they arrived. Both emit the identical event with the identical cycle
   * number. The only thing that tells them apart from logs alone is the transaction:
   * `rollClose` emits `RollClose` immediately BEFORE `_harvest()`, so a `Harvest` whose tx
   * hash matches this column is the terminal one and every other `Harvest` is a checkpoint.
   * Treating a checkpoint as terminal would flip the vault to Idle mid-cycle, close the week
   * early with a partial figure, and count a phantom week in the lifetime tallies.
   */
  rollCloseTx: t.hex(),

  /** ERC-8056 display multiplier, last value seen. 1e18 == 1.0. Display only, never share maths. */
  uiMultiplier: t.bigint().notNull().default(10n ** 18n),
  /** A scheduled multiplier change: the new value and when it starts applying. */
  uiMultiplierPending: t.bigint(),
  uiMultiplierEffectiveAt: t.bigint(),

  /**
   * The issuer's switches, mirrored from the Stock Token's own events.
   * `oraclePaused` blocks every `rollOpen`; a transfer pause blocks settlement itself, which
   * is a risk the product discloses rather than one it can engineer around.
   */
  oraclePaused: t.boolean().notNull().default(false),
  tokenPaused: t.boolean().notNull().default(false),

  /** How stale the spot price may be before a write is refused, in seconds. */
  maxPriceAge: t.integer().notNull().default(0),

  lastBlock: t.bigint().notNull().default(0n),
  lastTimestamp: t.bigint().notNull().default(0n),
}));

/*//////////////////////////////////////////////////////////////
                           SNAPSHOTS
//////////////////////////////////////////////////////////////*/

/** An append-only trail of vault state, one row per state-changing event. */
export const vaultSnapshot = onchainTable(
  "vault_snapshot",
  (t) => ({
    /** `${blockNumber}-${logIndex}` — monotonic and unique. */
    id: t.text().primaryKey(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
    /** The event that produced this snapshot, e.g. "Deposit", "RollOpen", "Harvest". */
    reason: t.text().notNull(),

    phase: t.integer().notNull(),
    cycleNumber: t.integer().notNull(),
    writesHalted: t.boolean().notNull(),

    assetBalance: t.bigint().notNull(),
    /** assetBalance − reservedAssets. Matches `Vault.idleAssets()`. */
    idleAssets: t.bigint().notNull(),
    lockedCollateral: t.bigint().notNull(),
    /** idleAssets + lockedCollateral. Matches `Vault.totalAssets()` outside mid-week assignment. */
    totalAssets: t.bigint().notNull(),
    reservedAssets: t.bigint().notNull(),
    usdgBalance: t.bigint().notNull(),

    totalShares: t.bigint().notNull(),
    queuedShares: t.bigint().notNull(),
    accUsdgPerShare: t.bigint().notNull(),
    totalUsdgDistributed: t.bigint().notNull(),
    uiMultiplier: t.bigint().notNull(),
  }),
  (t) => ({
    byBlock: index().on(t.blockNumber),
    byCycle: index().on(t.cycleNumber),
  }),
);

/*//////////////////////////////////////////////////////////////
                             CYCLES
//////////////////////////////////////////////////////////////*/

/**
 * The product's public record: one row per Overcall registry cycle.
 *
 * A row exists as soon as the registry emits `CycleSet`, whether or not the vault ever writes
 * into it, and it survives with zeros if nobody buys. A week with no buyer is a row of zeros,
 * never a missing row.
 *
 * The three money columns the site quotes, and exactly what each one means:
 *   premiumGross   what buyers paid for our calls, INCLUDING Overcall's 5% cut.
 *   fee            the protocol fee taken at harvest: `protocolFeeBps` (launch 500, 5%) of the
 *                  PREMIUM only, on filled weeks only. Strike proceeds are never fee'd, so on an
 *                  assigned week `fee != harvestGross × bps / 10_000`; it is
 *                  `(harvestGross − assignmentUsdg) × bps / 10_000`, per Harvest event.
 *   premiumNet     what depositors actually received, after Overcall's 5% AND the protocol fee.
 *                  `harvestGross − fee`, so on an assigned week it INCLUDES `assignmentUsdg`
 *                  (principal sold at the strike), not only premium.
 * `premiumToVault`, `overcallFee`, `assignmentUsdg` and `harvestGross` are carried alongside
 * so nothing about the two stacked fees has to be inferred.
 */
export const cycle = onchainTable(
  "cycle",
  (t) => ({
    cycleNumber: t.integer().primaryKey(),
    status: cycleStatus("status").notNull().default("idle"),

    /*── registry facts, from CycleSet ──*/
    /** Every rung the registry approved this week, as decimal strings (uint256 does not fit JSON). */
    optionIds: t.json().$type<string[]>(),
    strikeCount: t.integer().notNull().default(0),
    lotSize: t.bigint(),
    /** Book close / write deadline. `registry.writeDeadline() == exerciseTimestamp`. */
    exerciseTimestamp: t.bigint(),
    expiryTimestamp: t.bigint(),
    setAt: t.bigint(),
    setBlock: t.bigint(),
    setTx: t.hex(),

    /*── what the vault wrote ──*/
    wrote: t.boolean().notNull().default(false),
    optionId: t.bigint(),
    claimKey: t.bigint(),
    /** USDG base units per contract. 6 decimals. */
    strikeUsdg: t.bigint().notNull().default(0n),
    contractsWritten: t.bigint().notNull().default(0n),
    /** Asset base units locked into Valorem: contractsWritten × lotSize. */
    collateral: t.bigint().notNull().default(0n),
    openedAt: t.bigint(),
    openedBlock: t.bigint(),
    txOpen: t.hex(),

    /*── listings ──*/
    listingCount: t.integer().notNull().default(0),
    /** Hash of the most recent listing the vault authorised this cycle. */
    orderHash: t.hex(),
    /** Ask on that listing: total USDG demanded, both consideration items. */
    listedGrossUsdg: t.bigint().notNull().default(0n),
    listedUnitPriceUsdg: t.bigint().notNull().default(0n),
    listedContracts: t.bigint().notNull().default(0n),
    listedAt: t.bigint(),

    /*── fills, from Seaport ──*/
    contractsSold: t.bigint().notNull().default(0n),
    premiumGross: t.bigint().notNull().default(0n),
    premiumToVault: t.bigint().notNull().default(0n),
    overcallFee: t.bigint().notNull().default(0n),
    /** premiumGross / contractsSold. 0 on an unfilled week. */
    fillUnitPriceUsdg: t.bigint().notNull().default(0n),
    fillCount: t.integer().notNull().default(0),
    firstFillAt: t.bigint(),
    lastFillAt: t.bigint(),

    /*── exercise signals seen during the week (market-wide, NOT our assignment) ──*/
    /** Contracts exercised against this option type by anyone. Our share is a bucket lottery. */
    marketExercised: t.bigint().notNull().default(0n),
    /** Valorem bucket our claim wrote into, from BucketWrittenInto. uint96 on chain. */
    bucketIndex: t.bigint(),
    /** Contracts assigned to that bucket. A signal that we are likely to be assigned. */
    bucketAssigned: t.bigint().notNull().default(0n),

    /*── settlement ──*/
    lockedAt: t.bigint(),
    /** Contracts actually assigned to this vault, measured at redeem. 0..contractsWritten. */
    contractsAssigned: t.bigint().notNull().default(0n),
    /** USDG received because of assignment: strike × contractsAssigned. */
    assignmentUsdg: t.bigint().notNull().default(0n),
    /** Asset base units that came back from the claim. */
    assetsReturned: t.bigint().notNull().default(0n),
    closedAt: t.bigint(),
    closedBlock: t.bigint(),
    txClose: t.hex(),

    /*── harvest ──*/
    harvested: t.boolean().notNull().default(false),
    /** Vault's USDG take this cycle, as the Harvest event measured it. */
    harvestGross: t.bigint().notNull().default(0n),
    fee: t.bigint().notNull().default(0n),
    premiumNet: t.bigint().notNull().default(0n),
    /** premiumNet per whole share, USDG base units scaled by 1e18. 0 on an unfilled week. */
    usdgPerShare: t.bigint().notNull().default(0n),
    supplyAtHarvest: t.bigint().notNull().default(0n),
    harvestedAt: t.bigint(),
  }),
  (t) => ({
    byStatus: index().on(t.status),
    byExpiry: index().on(t.expiryTimestamp),
  }),
);

/*//////////////////////////////////////////////////////////////
                            LISTINGS
//////////////////////////////////////////////////////////////*/

/**
 * One row per Seaport order the vault authorised, keyed by order hash.
 *
 * The 95/5 split is recomputed here per contract, exactly as `Policy.splitPremium` does it:
 *   feePerContract    = floor(unitPrice × 500 / 10_000)
 *   writerPerContract = unitPrice − feePerContract
 * Rounding on the total instead would produce an order that signs and validates and is then
 * refused by Seaport on a partial fill (InexactFraction) — and every Overcall order is
 * PARTIAL_OPEN, so that silently turns the listing into full-fill-only.
 */
export const listing = onchainTable(
  "listing",
  (t) => ({
    orderHash: t.hex().primaryKey(),
    cycleNumber: t.integer().notNull(),
    /** `listingsThisCycle` at approval: 1, 2 or 3. The contract caps the cycle at 3. */
    seq: t.integer().notNull(),
    optionId: t.bigint().notNull(),
    /** Contracts offered. */
    amount: t.bigint().notNull(),
    /** Both consideration items summed. Always an exact multiple of `amount`. */
    grossUsdg: t.bigint().notNull(),
    unitPriceUsdg: t.bigint().notNull(),
    /** consideration[0], to the vault: writerPerContract × amount. */
    writerUsdg: t.bigint().notNull(),
    /** consideration[1], to Overcall: feePerContract × amount. */
    overcallFeeUsdg: t.bigint().notNull(),

    status: listingStatus("status").notNull().default("approved"),
    contractsFilled: t.bigint().notNull().default(0n),
    /** USDG that actually reached the vault on fills of this order. */
    proceedsUsdg: t.bigint().notNull().default(0n),
    /** USDG that actually reached Overcall on fills of this order. */
    feePaidUsdg: t.bigint().notNull().default(0n),
    fillCount: t.integer().notNull().default(0),

    approvedAt: t.bigint().notNull(),
    approvedBlock: t.bigint().notNull(),
    approvedTx: t.hex().notNull(),
    lastFillAt: t.bigint(),
    lastFillTx: t.hex(),
    endedAt: t.bigint(),
    endedTx: t.hex(),
    /** Why the order stopped being live: "filled", "cancelled", "counter", "lockBook", "rollClose". */
    endReason: t.text(),
  }),
  (t) => ({
    byCycle: index().on(t.cycleNumber),
    byStatus: index().on(t.status),
  }),
);

/*//////////////////////////////////////////////////////////////
                             USERS
//////////////////////////////////////////////////////////////*/

/**
 * Per-depositor position.
 *
 * `shares` is the ERC-20 balance, which EXCLUDES anything sitting in the redeem queue: the
 * vault escrows queued shares on itself. `queuedShares` mirrors `Vault.queuedSharesOf`.
 * Claimable USDG is not derivable from logs alone (it depends on a per-account index
 * snapshot), so the API reads `claimableUsdg(address)` live and returns it alongside these.
 */
export const user = onchainTable(
  "user",
  (t) => ({
    address: t.hex().primaryKey(),
    shares: t.bigint().notNull().default(0n),
    queuedShares: t.bigint().notNull().default(0n),
    queuedEpoch: t.bigint(),

    depositedAssets: t.bigint().notNull().default(0n),
    withdrawnAssets: t.bigint().notNull().default(0n),
    redeemedAssets: t.bigint().notNull().default(0n),
    redeemedUsdg: t.bigint().notNull().default(0n),
    claimedUsdg: t.bigint().notNull().default(0n),

    depositCount: t.integer().notNull().default(0),
    firstSeenAt: t.bigint().notNull(),
    firstSeenBlock: t.bigint().notNull(),
    lastActivityAt: t.bigint().notNull(),
    lastActivityBlock: t.bigint().notNull(),
  }),
  (t) => ({
    byShares: index().on(t.shares),
  }),
);

/*//////////////////////////////////////////////////////////////
                            HARVESTS
//////////////////////////////////////////////////////////////*/

/**
 * One row per `Harvest` event, including the zero-premium ones.
 *
 * `filled: false, grossUsdg: 0` is the honest record of a week nobody bought, and `/activity`
 * renders it as "unfilled, 0". The terminal harvest fires on every `rollClose` unconditionally
 * — including with a gross of zero — so an unfilled week always produces a row.
 *
 * Mid-week `_checkpointHarvest()` rows also land here, with `terminal: false`. They are real
 * money movements (premium swept into the index before a deposit mints) but they are NOT
 * weekly results, so `/v1/activity` shows terminal rows only unless asked otherwise.
 */
export const harvest = onchainTable(
  "harvest",
  (t) => ({
    id: t.text().primaryKey(),
    cycleNumber: t.integer().notNull(),
    filled: t.boolean().notNull(),

    /**
     * True for the end-of-cycle harvest inside `rollClose` — the week's verdict.
     * False for a mid-week `_checkpointHarvest()`, which `deposit`/`mint` fire to fix the
     * USDG index before new shares exist. Both emit the same event; only the terminal one
     * closes the week, and only terminal rows belong in the weekly tape at `/v1/activity`.
     */
    terminal: t.boolean().notNull().default(true),

    grossUsdg: t.bigint().notNull(),
    feeUsdg: t.bigint().notNull(),
    netUsdg: t.bigint().notNull(),

    /** Where the gross came from, split out. */
    premiumToVault: t.bigint().notNull().default(0n),
    assignmentUsdg: t.bigint().notNull().default(0n),
    contractsSold: t.bigint().notNull().default(0n),
    contractsAssigned: t.bigint().notNull().default(0n),

    /** Distributor index after this harvest, and the supply it was spread over. */
    accUsdgPerShare: t.bigint().notNull().default(0n),
    supply: t.bigint().notNull().default(0n),
    /** netUsdg × 1e18 / supply — USDG base units per whole share. */
    usdgPerShare: t.bigint().notNull().default(0n),

    timestamp: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (t) => ({
    byCycle: index().on(t.cycleNumber),
    byTime: index().on(t.timestamp),
  }),
);

/*//////////////////////////////////////////////////////////////
                          REDEEM QUEUE
//////////////////////////////////////////////////////////////*/

/**
 * One row per redemption epoch.
 *
 * The vault opens at epoch 1 and increments on every settlement. Queuing escrows shares;
 * settlement burns them and sets aside a pro-rata slice of idle assets plus the USDG the
 * escrow itself accrued over the cycle. Claimants then draw the epoch down, and the last one
 * takes the remainder so no dust is stranded — which is why `*Claimed` converges on
 * `*Settled` rather than being recomputed per user.
 */
export const queueEpoch = onchainTable(
  "queue_epoch",
  (t) => ({
    epochId: t.bigint().primaryKey(),
    status: epochStatus("status").notNull().default("open"),
    /** The cycle this epoch settled in. Null while still open. */
    cycleNumber: t.integer(),

    sharesQueued: t.bigint().notNull().default(0n),
    queueCount: t.integer().notNull().default(0),

    sharesSettled: t.bigint().notNull().default(0n),
    assetsSettled: t.bigint().notNull().default(0n),
    usdgSettled: t.bigint().notNull().default(0n),

    sharesClaimed: t.bigint().notNull().default(0n),
    assetsClaimed: t.bigint().notNull().default(0n),
    usdgClaimed: t.bigint().notNull().default(0n),
    claimCount: t.integer().notNull().default(0),

    openedAt: t.bigint(),
    settledAt: t.bigint(),
    settledTx: t.hex(),
  }),
  (t) => ({
    byStatus: index().on(t.status),
  }),
);

/*//////////////////////////////////////////////////////////////
                             ROLES
//////////////////////////////////////////////////////////////*/

/**
 * Who currently holds which AccessControl role on the vault.
 *
 * Rows are never deleted — a revoked grant stays with `granted: false` and a `revokedAt`, so
 * the history of who could touch the vault, and when, survives. The contract never calls
 * `_setRoleAdmin`, so every role's admin is `DEFAULT_ADMIN_ROLE` for the life of the vault and
 * `RoleAdminChanged` can never fire; there is nothing to index for it.
 */
export const roleMember = onchainTable(
  "role_member",
  (t) => ({
    /** `${role}-${account}`. */
    id: t.text().primaryKey(),
    role: t.hex().notNull(),
    /** DEFAULT_ADMIN_ROLE, KEEPER_ROLE, GUARDIAN_ROLE, or UNKNOWN_ROLE. */
    roleName: t.text().notNull(),
    account: t.hex().notNull(),
    granted: t.boolean().notNull(),
    grantedAt: t.bigint(),
    grantedTx: t.hex(),
    revokedAt: t.bigint(),
    revokedTx: t.hex(),
  }),
  (t) => ({
    byRole: index().on(t.role),
    byGranted: index().on(t.granted),
  }),
);
