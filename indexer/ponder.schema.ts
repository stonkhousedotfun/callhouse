import { index, onchainEnum, onchainTable } from "ponder";

/*//////////////////////////////////////////////////////////////
                              ENUMS
//////////////////////////////////////////////////////////////*/

/**
 * The life of one cycle as this product tells it. The vault numbers its own cycles (no
 * registry), so a row exists from `RollOpen` and never before: there is no "the week was
 * announced and the vault sat it out" row, because nothing announces weeks any more.
 *
 *   listed    the keeper armed an option type (`RollOpen`). Nothing is written yet: under write
 *             on fill collateral moves only when a buyer fills.
 *   filled    a buyer filled. Set the moment the first matching OrderFulfilled lands; the same
 *             transaction's `CallsWritten` is the write that fill caused.
 *   unfilled  the week closed with zero contracts sold, so nothing was ever written and there
 *             was no claim to redeem. THE MOST LIKELY OUTCOME, published honestly as "unfilled, 0".
 *   closed    the week closed after a fill, expiring out of the money. Premium kept, tokens kept.
 *   assigned  the week closed with contracts assigned: tokens went out at the strike, USDG came in.
 *   stranded  the week closed but Valorem's redeem reverted (USDG paused or frozen, the vault
 *             blocklisted on the Stock Token): the vault is Idle with the claim kept, deposits
 *             and instant redemption shut, and anyone may `retryStrandedClaim()`. Resolves to
 *             `assigned` or `closed` when the retry lands.
 *
 * `unfilled`, `closed` and `assigned` are terminal. `stranded` is terminal until recovery.
 */
export const cycleStatus = onchainEnum("cycle_status", [
  "listed",
  "filled",
  "unfilled",
  "assigned",
  "closed",
  "stranded",
]);

/**
 * Seaport order lifecycle as observed on chain. `partially_filled` and `cancelled` can both be
 * final states (a listing cancelled after a partial fill keeps `partially_filled`); `endedAt`
 * says whether the order is still live, and `endReason` says what ended it. Nothing here ever
 * reads "expired" or "invalidated": Seaport's clock is not an event, and a counter bump is
 * reported by the vault as `ListingCancelled` like any other cancellation.
 */
export const listingStatus = onchainEnum("listing_status", [
  "approved",
  "partially_filled",
  "filled",
  "cancelled",
]);

export const epochStatus = onchainEnum("epoch_status", ["open", "settled"]);

/**
 * Where a `Harvest` came from. The event is identical on every path and only the transaction
 * tells them apart (see `lib/lifecycle.ts harvestOrigin`).
 *
 *   rollClose   `_harvest()` inside `rollClose`: the week's verdict, emitted even at zero.
 *   checkpoint  `_checkpointHarvest()` inside `deposit`, `mint` or `settleQueue`: premium that
 *               already landed is indexed before new shares mint or the queue's escrow takes
 *               its accrual. Real money, not a weekly result.
 *   retry       `_harvest()` inside `retryStrandedClaim`: the live shares' part of a stranded
 *               claim's strike USDG, indexed fee-free under the stranded cycle's number.
 */
export const harvestOrigin = onchainEnum("harvest_origin", ["rollClose", "checkpoint", "retry"]);

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

  /** The vault's own cycle counter. 0 before the first `rollOpen`; kept until the next one. */
  cycleNumber: t.integer().notNull().default(0),
  /** The armed Valorem option type. Cleared when the claim is redeemed, or at an unfilled close. */
  optionId: t.bigint(),
  /** The one Valorem claim every fill of the cycle writes into. Null until the first fill. */
  claimKey: t.bigint(),
  strikeUsdg: t.bigint().notNull().default(0n),
  /** The armed option's window, read from the vault at `RollOpen` (`cycleExerciseTs` / `cycleExpiryTs`). */
  exerciseTimestamp: t.bigint().notNull().default(0n),
  expiryTimestamp: t.bigint().notNull().default(0n),

  /**
   * Contracts written this cycle: the sum of every `CallsWritten.contractsCount` since
   * `RollOpen`. Under write on fill this IS the number sold — every write happens inside the
   * Seaport fill that bought it — so there is no separate sold figure here. The cycle row keeps
   * Seaport's own count beside it as the cross-check.
   */
  contractsWritten: t.bigint().notNull().default(0n),

  listingHash: t.hex(),
  /** `listingsThisCycle()`: `approveListing` calls this cycle, cancelled or not. Max 3. */
  listingsThisCycle: t.integer().notNull().default(0),

  /** Raw ERC-20 balance of the asset held by the vault, from Transfer logs. 18 decimals. */
  assetBalance: t.bigint().notNull().default(0n),
  /** Raw USDG balance of the vault, from Transfer logs. 6 decimals. */
  usdgBalance: t.bigint().notNull().default(0n),
  /**
   * Collateral locked in Valorem, summed over every fill's `CallsWritten.collateral` and
   * cleared when the claim is redeemed. Deliberately NOT called `lockedAssets`: the contract's
   * `lockedAssets()` reads Valorem's live position and therefore falls as buyers are assigned
   * after the exercise timestamp, while this figure holds at what was written until the claim
   * is redeemed. The API reads the live number. Stays put while a claim is stranded.
   */
  lockedCollateral: t.bigint().notNull().default(0n),
  /** Asset base units promised to settled redemption epochs (and recovered strand shares) and excluded from NAV. */
  reservedAssets: t.bigint().notNull().default(0n),
  /** USDG base units promised to settled redemption epochs (and recovered strand shares). */
  usdgReservedForQueue: t.bigint().notNull().default(0n),

  totalShares: t.bigint().notNull().default(0n),
  queuedShares: t.bigint().notNull().default(0n),
  epochId: t.bigint().notNull().default(1n),

  /** Distributor index, 1e27-scaled USDG per share. */
  accUsdgPerShare: t.bigint().notNull().default(0n),
  totalUsdgDistributed: t.bigint().notNull().default(0n),
  /** Mirrors `Distributor.totalUsdgClaimed`: every `ClaimUsdg` plus the queue escrow's take (`QueueSettled.usdgOut`). */
  totalUsdgClaimed: t.bigint().notNull().default(0n),

  /** Lifetime totals across every cycle. USDG base units. */
  /** What buyers paid on every fill (Seaport `OrderFulfilled`, the one USDG consideration item). */
  lifetimePremiumGross: t.bigint().notNull().default(0n),
  /** Strike USDG the claims returned: `RollClose.usdgFromAssignment`, plus a recovered strand's `usdgOut`. */
  lifetimeAssignmentUsdg: t.bigint().notNull().default(0n),
  lifetimeProtocolFee: t.bigint().notNull().default(0n),
  /**
   * Protocol fee actually paid out. The fee accrues at every harvest with premium in it (counted in
   * `lifetimeProtocolFee`) but the push is best-effort — a blocked recipient must not freeze
   * `rollClose` — so payment trails accrual and completes via the permissionless `sweepFee`.
   * `lifetimeProtocolFee − totalFeeSwept` is the vault's live `pendingFeeUsdg`.
   */
  totalFeeSwept: t.bigint().notNull().default(0n),
  /**
   * Premium after the protocol fee, summed over every `Harvest`: `grossUsdg − strike proceeds −
   * feeUsdg`. PREMIUM ONLY (W-21). The whole credited figure lives in `lifetimeCreditedUsdg`.
   */
  lifetimePremiumNet: t.bigint().notNull().default(0n),
  /**
   * The strike-proceeds part of every `Harvest` that carried any: `RollClose.usdgFromAssignment`
   * on a terminal harvest, the live shares' part of a recovered stranded claim on a retry
   * harvest. Returned principal, never yield. The queue's part of a recovered claim goes to
   * `usdgReservedForQueue` without passing through a harvest, so this can sit below
   * `lifetimeAssignmentUsdg` after a strand.
   */
  lifetimeStrikeProceeds: t.bigint().notNull().default(0n),
  /** Sum of `Harvest.netUsdg`: everything credited to holders. `lifetimePremiumNet + lifetimeStrikeProceeds`. */
  lifetimeCreditedUsdg: t.bigint().notNull().default(0n),
  /** Asset base units settled redeemers were booked and NOT paid, across every `ReserveHaircut` (AF-05). */
  lifetimeHaircutAssets: t.bigint().notNull().default(0n),
  /** Cycles armed (`RollOpen`). Nothing is written at arm, so "armed" is the honest word. */
  cyclesWritten: t.integer().notNull().default(0),
  cyclesFilled: t.integer().notNull().default(0),
  cyclesUnfilled: t.integer().notNull().default(0),
  cyclesAssigned: t.integer().notNull().default(0),
  /** Cycles whose close stranded the claim (AF-02), recovered or not. */
  cyclesStranded: t.integer().notNull().default(0),

  /** Governance-visible settings, mirrored from their events (and seeded from the constructor by `Vault:setup`). */
  depositCap: t.bigint().notNull().default(0n),
  feeRecipient: t.hex(),
  protocolFeeBps: t.integer().notNull().default(0),
  valoremFeeAccepted: t.boolean().notNull().default(false),

  /** USDG received while there were no shares, or too small to index. Carried, never dropped. */
  usdgUnallocated: t.bigint().notNull().default(0n),

  /** Seaport nonce for this offerer. Bumped by `invalidateAllListings()`, `lockBook`, `rollClose`. */
  seaportCounter: t.bigint().notNull().default(0n),

  /**
   * The listing cancelled most recently, and the tx it happened in.
   * `_invalidateAllListings()` emits ListingCancelled and then AllListingsInvalidated, and
   * `lockBook` / `rollClose` emit their own event after that, so this is how the later handlers
   * recognise the order the first one just closed and refine its end reason without a scan.
   */
  lastCancelledHash: t.hex(),
  lastCancelledTx: t.hex(),

  /**
   * The transaction the most recent `RollClose` was emitted in.
   *
   * WHY: `Harvest` is emitted from THREE places. `_harvest()` runs inside `rollClose` and is
   * the week's verdict; `_checkpointHarvest()` runs inside `deposit`/`mint`/`settleQueue` and
   * fires whenever premium has already landed; and `_harvest()` runs again inside
   * `retryStrandedClaim`. All emit the identical event with the same cycle number. The only
   * thing that tells the terminal one apart from logs alone is the transaction: `rollClose`
   * emits `RollClose` immediately BEFORE `_harvest()`, so a `Harvest` whose tx hash matches this
   * column is the terminal one. Treating a checkpoint as terminal would flip the vault to Idle
   * mid-cycle, close the week early with a partial figure, and count a phantom week in the
   * lifetime tallies. The retry is told apart by the strand row's `recoveredTx` the same way.
   */
  rollCloseTx: t.hex(),

  /*── the stranded-claim state machine (AF-02) ──*/
  /** `isStranded()`: Idle with a claim still open. Deposits, instant redemption and `rollOpen` are shut. */
  stranded: t.boolean().notNull().default(false),
  /** `strandGen()`: how many claims have ever stranded. */
  strandGen: t.bigint().notNull().default(0n),
  /** `lastResolvedGen()`: the last generation `retryStrandedClaim` redeemed. Equals `strandGen` when nothing is stranded. */
  lastResolvedGen: t.bigint().notNull().default(0n),
  /**
   * `strandedRemainingWad()`: the part of the stranded claim live shares still own (of 1e18).
   * 1e18 at the strand, minus every `EpochStrandShare`, 0 after recovery. NAV counts the locked
   * collateral scaled by this while stranded.
   */
  strandedRemainingWad: t.bigint().notNull().default(0n),
  /** The cycle whose close stranded the open claim. Null when nothing is stranded. */
  strandedCycleNumber: t.integer(),

  /** ERC-8056 display multiplier, last value seen. 1e18 == 1.0. Display only, never share maths. */
  uiMultiplier: t.bigint().notNull().default(10n ** 18n),
  /** A scheduled multiplier change: the new value and when it starts applying. */
  uiMultiplierPending: t.bigint(),
  uiMultiplierEffectiveAt: t.bigint(),

  /**
   * The issuer's switches, mirrored from the Stock Token's own events.
   * `oraclePaused` blocks every `rollOpen` and every fill; a transfer pause blocks settlement
   * itself, which is a risk the product discloses rather than one it can engineer around.
   */
  oraclePaused: t.boolean().notNull().default(false),
  tokenPaused: t.boolean().notNull().default(false),

  /** How stale the spot price may be before an arm or a fill is refused, in seconds. */
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
    /** The event that produced this snapshot, e.g. "Deposit", "RollOpen", "CallsWritten", "Harvest". */
    reason: t.text().notNull(),

    phase: t.integer().notNull(),
    cycleNumber: t.integer().notNull(),
    writesHalted: t.boolean().notNull(),
    stranded: t.boolean().notNull(),

    assetBalance: t.bigint().notNull(),
    /** assetBalance − reservedAssets. Matches `Vault.idleAssets()`. */
    idleAssets: t.bigint().notNull(),
    lockedCollateral: t.bigint().notNull(),
    /** idleAssets + lockedCollateral. Matches `Vault.totalAssets()` outside assignment and a strand. */
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
 * The product's public record: one row per cycle the vault armed.
 *
 * A row exists from `RollOpen`, and it survives with zeros if nobody buys. A week with no buyer
 * is a row of zeros, never a missing row.
 *
 * Contracts appear twice on purpose. `contractsWritten` sums the vault's own `CallsWritten`
 * (one per fill) and `contractsSold` sums Seaport's `OrderFulfilled` offer items; under write on
 * fill the two are equal by construction, so a difference is a bug in the tape, not a fact
 * about the week. The verdict (`status`, the API's `filled`, `cyclesFilled`) is taken from
 * `contractsWritten`, which depends on no configured address; `contractsSold` is the cross-check. `collateral` is what those writes locked (the Valorem engine fee, if ever
 * accepted, is pulled ON TOP of it and is not in this figure).
 *
 * The money columns the site quotes, and exactly what each one means:
 *   premiumGross         what buyers paid for our calls. ONE consideration item, USDG to the
 *                        vault, so there is no venue cut and gross is what reached the vault.
 *   harvestGross         the vault's whole USDG take as the Harvest events measured it: premium
 *                        PLUS, on an assigned week, the strike proceeds.
 *   harvestPremiumGross  `harvestGross − strikeProceeds`: premium only, as harvested.
 *   strikeProceeds       the strike-proceeds part of the harvests: `RollClose.usdgFromAssignment`
 *                        on the terminal harvest, the live shares' part of a recovered stranded
 *                        claim on a retry harvest. Returned principal — collateral that left at
 *                        the strike — and NEVER yield. `assignmentUsdg` is the whole strike USDG
 *                        the claim returned; the two differ only after a strand, by the part the
 *                        queue took directly.
 *   fee                  the protocol fee taken at harvest: `protocolFeeBps` (launch 500, 5%) of
 *                        the PREMIUM only. Strike proceeds are never fee'd, so on an assigned week
 *                        `fee != harvestGross × bps / 10_000`; it is
 *                        `(harvestGross − usdgFromAssignment) × bps / 10_000`, per Harvest event.
 *   premiumNet           `harvestPremiumGross − fee`. PREMIUM ONLY: the only figure that says
 *                        what the week earned.
 *   creditedUsdg         `harvestGross − fee` = `premiumNet + strikeProceeds`: everything the
 *                        Distributor credited to holders. Real money, not a return.
 * The split is `lib/harvest.ts`.
 */
export const cycle = onchainTable(
  "cycle",
  (t) => ({
    cycleNumber: t.integer().primaryKey(),
    status: cycleStatus("status").notNull().default("listed"),

    /*── the armed option type, from RollOpen ──*/
    optionId: t.bigint(),
    /** USDG base units per contract. 6 decimals. The option's `exerciseAmount`. */
    strikeUsdg: t.bigint().notNull().default(0n),
    /** The option's window, read from the vault at the roll: fills stop and `lockBook` opens at exercise; `rollClose` at expiry. */
    exerciseTimestamp: t.bigint(),
    expiryTimestamp: t.bigint(),
    openedAt: t.bigint(),
    openedBlock: t.bigint(),
    txOpen: t.hex(),

    /*── what the fills wrote, from CallsWritten (one per fill) ──*/
    /** The one Valorem claim. Null until the first fill. */
    claimKey: t.bigint(),
    contractsWritten: t.bigint().notNull().default(0n),
    /** Asset base units locked into Valorem: contractsWritten × 1e18, summed across fills. */
    collateral: t.bigint().notNull().default(0n),
    writeCount: t.integer().notNull().default(0),
    firstWriteAt: t.bigint(),
    lastWriteAt: t.bigint(),

    /*── listings ──*/
    /** Listings the vault authorised this cycle (`ListingApproved.seq` of the latest one). */
    listingCount: t.integer().notNull().default(0),
    /** Hash of the most recent listing the vault authorised this cycle. */
    orderHash: t.hex(),
    /** Ask on that listing: total USDG demanded for the whole order. */
    listedGrossUsdg: t.bigint().notNull().default(0n),
    listedUnitPriceUsdg: t.bigint().notNull().default(0n),
    listedContracts: t.bigint().notNull().default(0n),
    listedAt: t.bigint(),

    /*── fills, from Seaport ──*/
    contractsSold: t.bigint().notNull().default(0n),
    premiumGross: t.bigint().notNull().default(0n),
    /** premiumGross / contractsSold. 0 on an unfilled week. */
    fillUnitPriceUsdg: t.bigint().notNull().default(0n),
    fillCount: t.integer().notNull().default(0),
    firstFillAt: t.bigint(),
    lastFillAt: t.bigint(),

    /*── exercise signals seen during the week (market-wide, NOT our assignment) ──*/
    /** Contracts exercised against this option type by anyone. Our share is a bucket lottery. */
    marketExercised: t.bigint().notNull().default(0n),
    /** Valorem bucket our claim wrote into, from BucketWrittenInto on the first fill. uint96 on chain. */
    bucketIndex: t.bigint(),
    /** Contracts assigned to that bucket. A signal that we are likely to be assigned. */
    bucketAssigned: t.bigint().notNull().default(0n),

    /*── settlement ──*/
    lockedAt: t.bigint(),
    /** Contracts assigned to this vault, as `RollClose.contractsAssignedCount` read before the redeem. 0..contractsWritten. Known even on a stranded close. */
    contractsAssigned: t.bigint().notNull().default(0n),
    /** USDG the claim returned for the assignment: strike × contractsAssigned. 0 while stranded; set at recovery. */
    assignmentUsdg: t.bigint().notNull().default(0n),
    /** Asset base units that came back from the claim. 0 while stranded; set at recovery. */
    assetsReturned: t.bigint().notNull().default(0n),
    closedAt: t.bigint(),
    closedBlock: t.bigint(),
    txClose: t.hex(),

    /*── the stranded close (AF-02) ──*/
    /** True if this cycle's `rollClose` could not redeem the claim. Stays true as history after recovery. */
    stranded: t.boolean().notNull().default(false),
    /** The strand generation, keyed into `strand`. */
    strandGen: t.bigint(),
    recoveredAt: t.bigint(),
    recoveredTx: t.hex(),

    /*── harvest ──*/
    harvested: t.boolean().notNull().default(false),
    /** Vault's USDG take this cycle, as the Harvest events measured it. Premium + strike proceeds. */
    harvestGross: t.bigint().notNull().default(0n),
    /** harvestGross − strikeProceeds. Premium only. */
    harvestPremiumGross: t.bigint().notNull().default(0n),
    /** Strike proceeds swept by the harvests. Returned principal, not premium. */
    strikeProceeds: t.bigint().notNull().default(0n),
    fee: t.bigint().notNull().default(0n),
    /** harvestPremiumGross − fee. Premium only. */
    premiumNet: t.bigint().notNull().default(0n),
    /** harvestGross − fee = premiumNet + strikeProceeds. Everything credited to holders. */
    creditedUsdg: t.bigint().notNull().default(0n),
    /** premiumNet per whole share, USDG base units, summed per sweep. 0 on an unfilled week. */
    premiumNetPerShare: t.bigint().notNull().default(0n),
    /** creditedUsdg per whole share, USDG base units, summed per sweep. Includes strike proceeds. */
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
 * Every listing is a PARTIAL_RESTRICTED Seaport 1.6 order with the vault as offerer AND zone,
 * one ERC-1155 offer item (the armed option type, up to capacity) and ONE ERC-20 consideration
 * item (USDG to the vault). The contract has proved `grossUsdg % amount == 0` at approval, so
 * the unit price is exact and a partial fill pays exactly `unitPrice × k`. There is no venue
 * fee item and no 95/5 split: what a fill pays is what reached the vault.
 */
export const listing = onchainTable(
  "listing",
  (t) => ({
    orderHash: t.hex().primaryKey(),
    cycleNumber: t.integer().notNull(),
    /** `listingsThisCycle` after this approval: 1, 2 or 3, unique within a cycle. The contract caps the cycle at 3. */
    seq: t.integer().notNull(),
    optionId: t.bigint().notNull(),
    /** Contracts offered: the order's size, up to the vault's capacity at approval. */
    amount: t.bigint().notNull(),
    /** The one consideration item. Always an exact multiple of `amount`. */
    grossUsdg: t.bigint().notNull(),
    unitPriceUsdg: t.bigint().notNull(),

    status: listingStatus("status").notNull().default("approved"),
    contractsFilled: t.bigint().notNull().default(0n),
    /** USDG that actually reached the vault on fills of this order. */
    proceedsUsdg: t.bigint().notNull().default(0n),
    fillCount: t.integer().notNull().default(0),

    approvedAt: t.bigint().notNull(),
    approvedBlock: t.bigint().notNull(),
    approvedTx: t.hex().notNull(),
    lastFillAt: t.bigint(),
    lastFillTx: t.hex(),
    endedAt: t.bigint(),
    endedTx: t.hex(),
    /**
     * Why the order stopped being live: "filled", "cancelled" (`cancelListing`), "counter" (the
     * keeper's or guardian's `invalidateAllListings`), "lockBook" or "rollClose" (each bumps the
     * counter on its way through, and its own event one log later says which).
     */
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

    /**
     * The owner's staged share of a stranded claim, WAD of 1e18 (`owedStrandWad`). Set when a
     * queue entry settles out of an epoch that owns part of the claim, cleared by
     * `StrandShareSettled` once the claim is redeemed and the share becomes assets and USDG.
     */
    strandWad: t.bigint().notNull().default(0n),
    /** Which generation that share belongs to (`owedStrandGen`). */
    strandGen: t.bigint(),
    /** USDG booked to this owner that a `completeRedeem` could not move (`UsdgLegDeferred`, AF-03). Still owed; 0 once paid. */
    deferredUsdg: t.bigint().notNull().default(0n),
    /** Asset base units booked and not paid because the reserve was unbacked (`ReserveHaircut`, AF-05). Permanent. */
    haircutAssets: t.bigint().notNull().default(0n),

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
 * Checkpoint rows (`deposit`, `mint`, `settleQueue`) and the retry's row (`retryStrandedClaim`)
 * land here too, with `terminal: false` and their `origin`. They are real money movements but
 * they are NOT weekly results, so `/v1/activity` shows terminal rows only unless asked otherwise.
 */
export const harvest = onchainTable(
  "harvest",
  (t) => ({
    id: t.text().primaryKey(),
    cycleNumber: t.integer().notNull(),
    /** The cycle had contracts written (`CallsWritten`, == sold) when this harvest landed. False for a cycle-0 checkpoint. */
    filled: t.boolean().notNull(),

    /** True for the end-of-cycle harvest inside `rollClose` — the week's verdict. `origin === "rollClose"`. */
    terminal: t.boolean().notNull().default(true),
    origin: harvestOrigin("origin").notNull().default("rollClose"),

    grossUsdg: t.bigint().notNull(),
    feeUsdg: t.bigint().notNull(),
    netUsdg: t.bigint().notNull(),

    /**
     * THIS event's gross, split (lib/harvest.ts). `strikeProceedsUsdg` is non-zero only on the
     * terminal harvest of an assigned week and on a retry harvest; `premiumGrossUsdg = grossUsdg
     * − strikeProceedsUsdg` and `premiumNetUsdg = premiumGrossUsdg − feeUsdg`. `netUsdg` stays
     * the event's own figure, which includes the strike proceeds.
     */
    premiumGrossUsdg: t.bigint().notNull().default(0n),
    strikeProceedsUsdg: t.bigint().notNull().default(0n),
    premiumNetUsdg: t.bigint().notNull().default(0n),

    /** The cycle's figures at the time of this harvest, for context. */
    assignmentUsdg: t.bigint().notNull().default(0n),
    contractsSold: t.bigint().notNull().default(0n),
    contractsAssigned: t.bigint().notNull().default(0n),

    /** Distributor index after this harvest, and the supply it was spread over. */
    accUsdgPerShare: t.bigint().notNull().default(0n),
    supply: t.bigint().notNull().default(0n),
    /** premiumNetUsdg × 1e18 / supply — premium only, USDG base units per whole share. */
    premiumNetPerShare: t.bigint().notNull().default(0n),
    /** netUsdg × 1e18 / supply — everything credited, including strike proceeds. */
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
 *
 * Settlement happens inside `rollClose` (`cycleNumber` is that week) or, while the vault is
 * Idle, through the permissionless `settleQueue()`, which belongs to no week (`cycleNumber`
 * null). An epoch settled while a claim is stranded also takes a WAD share of that claim
 * (`EpochStrandShare`), paid to its owners once `retryStrandedClaim` redeems it.
 */
export const queueEpoch = onchainTable(
  "queue_epoch",
  (t) => ({
    epochId: t.bigint().primaryKey(),
    status: epochStatus("status").notNull().default("open"),
    /** The cycle whose `rollClose` settled this epoch. Null while open, and null for a flat `settleQueue()`. */
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

    /** The stranded claim this epoch owns a share of (`epochStrandGen`). Null for an ordinary epoch. */
    strandGen: t.bigint(),
    /** The epoch's share of that claim, WAD of 1e18, as `EpochStrandShare` fixed it at settlement. */
    strandWad: t.bigint().notNull().default(0n),
    /** How much of it has been staged against owners as their entries settled. Converges on `strandWad`. */
    strandWadClaimed: t.bigint().notNull().default(0n),

    openedAt: t.bigint(),
    settledAt: t.bigint(),
    settledTx: t.hex(),
  }),
  (t) => ({
    byStatus: index().on(t.status),
  }),
);

/*//////////////////////////////////////////////////////////////
                        STRANDED CLAIMS
//////////////////////////////////////////////////////////////*/

/**
 * One row per stranded claim (AF-02), keyed by the vault's generation counter.
 *
 * A generation opens when `rollClose` cannot redeem the claim (`ClaimStranded`) and closes when
 * `retryStrandedClaim` does (`StrandedClaimRecovered`). Between the two, every epoch the queue
 * settles takes a WAD share of the claim out of the live shares' hands (`EpochStrandShare`,
 * summed here as `epochWad`); at recovery that part of both legs, `queueWad` of them, moves into
 * the reserves and is drawn down owner by owner (`StrandShareSettled`, `*Left`), while the rest
 * belongs to the shares still live and goes through the retry's `Harvest`.
 */
export const strand = onchainTable(
  "strand",
  (t) => ({
    gen: t.bigint().primaryKey(),
    cycleNumber: t.integer().notNull(),
    claimKey: t.bigint().notNull(),
    strandedAt: t.bigint().notNull(),
    strandedBlock: t.bigint().notNull(),
    strandedTx: t.hex().notNull(),

    /** WAD of the claim handed to settled epochs so far (`1e18 − strandedRemainingWad` while open). */
    epochWad: t.bigint().notNull().default(0n),
    epochCount: t.integer().notNull().default(0),

    recovered: t.boolean().notNull().default(false),
    recoveredAt: t.bigint(),
    recoveredBlock: t.bigint(),
    recoveredTx: t.hex(),
    /** What the redeem returned, both legs. `strands(gen).assetsIn / usdgIn`. */
    assetsIn: t.bigint().notNull().default(0n),
    usdgIn: t.bigint().notNull().default(0n),
    /** The queue's part of the claim at recovery: `1e18 − strandedRemainingWad` then. */
    queueWad: t.bigint().notNull().default(0n),
    /** The queue's part not yet folded into an owner's owed balances. `strands(gen).wadLeft / assetsLeft / usdgLeft`. */
    wadLeft: t.bigint().notNull().default(0n),
    assetsLeft: t.bigint().notNull().default(0n),
    usdgLeft: t.bigint().notNull().default(0n),
    /** `StrandShareSettled` events: owners whose share became assets and USDG. */
    settledCount: t.integer().notNull().default(0),
  }),
  (t) => ({
    byCycle: index().on(t.cycleNumber),
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

/*//////////////////////////////////////////////////////////////
                         FACTORY MARKETS
//////////////////////////////////////////////////////////////*/

/*
 * Everything below is the factory market (contracts/src/solo/: one `AccountFactory` per market,
 * one `WriterAccount` clone per user), Tier 1 of the multi-market plan. It is populated only when
 * FACTORY_ADDRESS is set, from logs alone: no handler below makes an `eth_call` (the public RPC
 * has no historical state and per-market archive endpoints are not provisioned), and the one
 * optional read — `Factory:setup`, the factory's immutables and constructor-set settings — is
 * best-effort and marked `settingsVerified`. The vault tables above are untouched: the two
 * products share a process only on the NVDA deployment, and nothing joins them.
 */

/**
 * `writer_account.status`, the account's place in the week as the logs tell it
 * (lib/factoryLifecycle.ts `nextStatus`).
 *
 *   idle      no write requested (the row default, and `WriteRequested(0)`).
 *   pending   `WriteRequested(n)`: in the keeper's pending list, waiting for `listFor`.
 *   listed    `LotsListed`: one-lot orders on the book under a pinned week.
 *   settled   `Settled`: flat again; the request is cleared on chain, so a new one is needed.
 */
export const writerAccountStatus = onchainEnum("writer_account_status", ["idle", "pending", "listed", "settled"]);

/**
 * One row, keyed by the factory address: the market as the factory's own events describe it,
 * plus totals summed over every account.
 *
 * Three groups of columns have different provenance, and the names say which:
 *   - `asset`, `feed`, `clear`, `implementation`, the six policy fields, `feeRecipient` and
 *     `depositCap` are seeded by `Factory:setup` from views (`settingsVerified` says whether the
 *     read answered; null / unset otherwise). `FeeRecipientSet` and `DepositCapSet` then keep
 *     the last two current. `PolicySet` carries NO values, so `policySetAt` records that the
 *     policy changed and the six fields may be stale from that moment.
 *   - `admin`, `writesHalted`, the week and `accountCount` are exact, from events.
 *   - the totals are sums of account events: `pendingLots` is the requests of the accounts
 *     currently pending (the keeper's work queue), the rest are lifetime.
 */
export const market = onchainTable("market", (t) => ({
  id: t.hex().primaryKey(),
  /** The `MARKET` env label (NVDA, AAPL, ...). A label: nothing is derived from it. */
  ticker: t.text().notNull(),

  /*── immutables, from the setup read ──*/
  asset: t.hex(),
  feed: t.hex(),
  clear: t.hex(),
  implementation: t.hex(),
  /** The setup read answered. False means every nullable column in this group is unverified, not zero. */
  settingsVerified: t.boolean().notNull().default(false),

  /*── governance-visible settings ──*/
  /** The DEFAULT_ADMIN_ROLE holder, from `RoleGranted`: the constructor's grant is the deploy tx's first event. */
  admin: t.hex(),
  feeRecipient: t.hex(),
  /** Per-ACCOUNT cap on held assets (`deposit` reverts `DepositCapExceeded` above it). Null until read or set. */
  depositCap: t.bigint(),
  minOtmBps: t.integer(),
  maxOtmBps: t.integer(),
  minPremiumBps: t.integer(),
  maxUtilizationBps: t.integer(),
  /** Charged on every fill as the second consideration item of each lot order, to `feeRecipient`. */
  protocolFeeBps: t.integer(),
  /** `list` refuses more lots than this per account. */
  maxContractsCap: t.bigint(),
  /** The last `PolicySet`. The event has no arguments, so the six fields above may be stale from here. */
  policySetAt: t.bigint(),
  writesHalted: t.boolean().notNull().default(false),

  /*── the current week, from WeekSet ──*/
  /** The factory's own counter. 0 before the first `setWeek`. */
  weekId: t.integer().notNull().default(0),
  strikeUsdg: t.bigint().notNull().default(0n),
  exerciseTs: t.bigint().notNull().default(0n),
  /** Every account's expiry is this plus its index (one second each), so no two share a Valorem bucket. */
  baseExpiryTs: t.bigint().notNull().default(0n),
  askUsdg: t.bigint().notNull().default(0n),
  weekSetAt: t.bigint(),

  /*── totals ──*/
  /** `AccountCreated` count == `nextIndex`. */
  accountCount: t.integer().notNull().default(0),
  /** Requested lots of the accounts currently `pending`: what the keeper has to list. */
  pendingLots: t.bigint().notNull().default(0n),
  lotsListed: t.bigint().notNull().default(0n),
  lotsFilled: t.bigint().notNull().default(0n),
  /** Sum of `LotFilled.premiumUsdg`: the whole ask per lot, protocol fee item included. */
  premiumUsdg: t.bigint().notNull().default(0n),
  settlements: t.integer().notNull().default(0),
  assetReturned: t.bigint().notNull().default(0n),
  /** Sum of `Settled.strikeUsdg`: strike proceeds of assigned lots. Principal, never premium. */
  assignedUsdg: t.bigint().notNull().default(0n),
  claimedUsdg: t.bigint().notNull().default(0n),

  lastBlock: t.bigint().notNull().default(0n),
  lastTimestamp: t.bigint().notNull().default(0n),
}));

/**
 * One row per `WriterAccount` clone, keyed by the clone's address.
 *
 * `owner` follows `AccountRekeyed` / `OwnershipTransferred`. The `listed*` group is the week
 * pinned onto the account by `list` and is cleared by `settle`, exactly as the contract clears
 * it; `optionId` survives a settle only when the redeem failed (lib/factoryLifecycle.ts
 * `accountAfterSettled`). Balances are NOT here: a clone's token transfers cannot be filtered
 * (the set of addresses is dynamic), so `depositedTotal − withdrawnTotal` is a lower bound on
 * what the account holds, not its balance; assignment moves assets out without a `Withdrawn`.
 */
export const writerAccount = onchainTable(
  "writer_account",
  (t) => ({
    id: t.hex().primaryKey(),
    factory: t.hex().notNull(),
    owner: t.hex().notNull(),
    /** `AccountCreated.index`: 1-based, the account's second of expiry offset. */
    index: t.integer().notNull(),
    createdAt: t.bigint().notNull(),
    createdBlock: t.bigint().notNull(),
    createdTx: t.hex().notNull(),

    status: writerAccountStatus("status").notNull().default("idle"),

    depositedTotal: t.bigint().notNull().default(0n),
    withdrawnTotal: t.bigint().notNull().default(0n),
    claimedUsdg: t.bigint().notNull().default(0n),

    /*── the current request / listing ──*/
    requestedLots: t.bigint().notNull().default(0n),
    listedLots: t.bigint().notNull().default(0n),
    /** Fills of the CURRENT listing. Reset by `Settled`. */
    filledLots: t.bigint().notNull().default(0n),
    listedWeekId: t.integer(),
    optionId: t.bigint(),
    listedAskUsdg: t.bigint().notNull().default(0n),
    listedAt: t.bigint(),

    /*── lifetime ──*/
    lotsListed: t.bigint().notNull().default(0n),
    lotsFilled: t.bigint().notNull().default(0n),
    premiumUsdg: t.bigint().notNull().default(0n),
    settlements: t.integer().notNull().default(0),
    lastSettledAt: t.bigint(),

    lastActivityAt: t.bigint().notNull(),
    lastActivityBlock: t.bigint().notNull(),
  }),
  (t) => ({
    byOwner: index().on(t.owner),
    byStatus: index().on(t.status),
  }),
);

/**
 * One row per `WeekSet`, keyed `${factory}-${weekId}`: the terms the keeper set and what the
 * accounts did under them. A week nobody listed under is a row of zeros, never a missing row —
 * the same rule as the vault's `cycle`.
 */
export const marketWeek = onchainTable(
  "market_week",
  (t) => ({
    id: t.text().primaryKey(),
    factory: t.hex().notNull(),
    weekId: t.integer().notNull(),
    strikeUsdg: t.bigint().notNull(),
    exerciseTs: t.bigint().notNull(),
    baseExpiryTs: t.bigint().notNull(),
    askUsdg: t.bigint().notNull(),
    setAt: t.bigint().notNull(),
    setBlock: t.bigint().notNull(),
    setTx: t.hex().notNull(),

    lotsListed: t.bigint().notNull().default(0n),
    lotsFilled: t.bigint().notNull().default(0n),
    premiumUsdg: t.bigint().notNull().default(0n),
    accountsListed: t.integer().notNull().default(0),
    accountsSettled: t.integer().notNull().default(0),
    assetReturned: t.bigint().notNull().default(0n),
    assignedUsdg: t.bigint().notNull().default(0n),
  }),
  (t) => ({
    byWeek: index().on(t.weekId),
  }),
);

/**
 * One row per `LotFilled`: one contract written, one order gone from the book, `premiumUsdg`
 * paid (the whole ask; the seller's part and the fee item are split by Seaport, not here).
 * `orderHash` is the filled Seaport order, so a Seaport `OrderFulfilled` can be joined to it by
 * anyone who wants the consideration items; this indexer does not follow Seaport for the clones.
 */
export const lotFill = onchainTable(
  "lot_fill",
  (t) => ({
    /** `${txHash}-${logIndex}`. */
    id: t.text().primaryKey(),
    factory: t.hex().notNull(),
    account: t.hex().notNull(),
    owner: t.hex().notNull(),
    /** The account's pinned week at the fill. Null only on a replay that missed the `LotsListed`. */
    weekId: t.integer(),
    optionId: t.bigint().notNull(),
    orderHash: t.hex().notNull(),
    premiumUsdg: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (t) => ({
    byAccount: index().on(t.account),
    byOwner: index().on(t.owner),
    byWeek: index().on(t.weekId),
    byBlock: index().on(t.blockNumber),
  }),
);

/**
 * One row per `Settled`: the account's verdict for the week it was listed under, with the
 * listing's size and fills beside the redeem's two legs so the outcome is reproducible from the
 * row (lib/factoryLifecycle.ts `settlementOutcome`: unfilled | assigned | expired | unredeemed).
 */
export const accountSettlement = onchainTable(
  "account_settlement",
  (t) => ({
    /** `${txHash}-${logIndex}`. */
    id: t.text().primaryKey(),
    factory: t.hex().notNull(),
    account: t.hex().notNull(),
    owner: t.hex().notNull(),
    weekId: t.integer(),
    lotsListed: t.bigint().notNull(),
    lotsFilled: t.bigint().notNull(),
    assetReturned: t.bigint().notNull(),
    strikeUsdg: t.bigint().notNull(),
    outcome: t.text().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (t) => ({
    byAccount: index().on(t.account),
    byWeek: index().on(t.weekId),
    byBlock: index().on(t.blockNumber),
  }),
);

/**
 * Who holds which AccessControl role on the factory. Same rules as `role_member` for the vault
 * (rows are never deleted; a revoke keeps the row with `granted: false`), in its own table so a
 * deployment running both products never has one product's grant overwrite the other's.
 */
export const marketRole = onchainTable(
  "market_role",
  (t) => ({
    /** `${role}-${account.toLowerCase()}`, the same key convention as `role_member`. */
    id: t.text().primaryKey(),
    factory: t.hex().notNull(),
    role: t.hex().notNull(),
    /** DEFAULT_ADMIN_ROLE, KEEPER_ROLE, GUARDIAN_ROLE, or UNKNOWN_ROLE (lib/roles.ts: the factory uses the same three hashes). */
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

/*//////////////////////////////////////////////////////////////
                         V2 CLEARINGHOUSE
//////////////////////////////////////////////////////////////*/

/** V2 rows live beside v1 rows. No v1 table is reused by the new Clearinghouse. */
export const v2MarketStatus = onchainEnum("v2_market_status", ["planned", "live", "paused"]);
export const v2SeriesStatus = onchainEnum("v2_series_status", [
  "open", "cutoff", "expired", "settling", "held", "settled",
]);
export const v2OrderKind = onchainEnum("v2_order_kind", ["Bid", "AskResale", "AskWrite"]);
export const v2OrderStatus = onchainEnum("v2_order_status", [
  "open", "filled", "cancelled", "pruned", "expired",
]);
export const v2Side = onchainEnum("v2_side", ["long", "short"]);
export const v2LotSource = onchainEnum("v2_lot_source", ["fill", "transfer", "mint"]);
export const v2SettlementStatus = onchainEnum("v2_settlement_status", [
  "None", "Pending", "Finalized", "Held",
]);

/** One row per registered underlying. Raw money is in asset or USDG base units. */
export const v2Market = onchainTable(
  "v2_market",
  (t) => ({
    underlying: t.hex().primaryKey(),
    ticker: t.text().notNull(),
    enabled: t.boolean().notNull(),
    mintPaused: t.boolean().notNull(),
    strikeTick: t.bigint().notNull(),
    exerciseFeeBps: t.integer().notNull(),
    oracle: t.hex().notNull(),
    mintFeePpm: t.integer().notNull(),
    status: v2MarketStatus("status").notNull(),
    registeredAt: t.bigint().notNull(),
    registeredBlock: t.bigint().notNull(),
    registeredTx: t.hex().notNull(),
    seriesCreated: t.integer().notNull().default(0),
    seriesOpen: t.integer().notNull().default(0),
    openInterestUnits: t.bigint().notNull().default(0n),
    volumeUnits: t.bigint().notNull().default(0n),
    volumeUsdg: t.bigint().notNull().default(0n),
    premiumUsdg: t.bigint().notNull().default(0n),
    feesUsdg: t.bigint().notNull().default(0n),
    lastBlock: t.bigint().notNull(),
    lastTimestamp: t.bigint().notNull(),
  }),
  (t) => ({ byTicker: index().on(t.ticker), byStatus: index().on(t.status) }),
);

/** Clearinghouse-wide governance settings derived from their events. */
export const v2ProtocolState = onchainTable("v2_protocol_state", (t) => ({
  id: t.text().primaryKey(),
  createPaused: t.boolean().notNull().default(false),
  feeRecipient: t.hex(),
  payoutAdapter: t.hex(),
  maxSlippageBps: t.integer(),
  updatedAt: t.bigint().notNull(),
}));

/** Latest ERC-1155 metadata URI per token, when the Clearinghouse emits URI. */
export const v2TokenUri = onchainTable("v2_token_uri", (t) => ({
  tokenId: t.bigint().primaryKey(),
  uri: t.text().notNull(),
  updatedAt: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/** Append-only treasury fee withdrawal. */
export const v2FeeSweep = onchainTable("v2_fee_sweep", (t) => ({
  id: t.text().primaryKey(),
  asset: t.hex().notNull(),
  recipient: t.hex().notNull(),
  amount: t.bigint().notNull(),
  ts: t.bigint().notNull(),
  block: t.bigint().notNull(),
  logIndex: t.integer().notNull(),
  tx: t.hex().notNull(),
}), (t) => ({ byAsset: index().on(t.asset), byRecipient: index().on(t.recipient) }));

/** A long ID identifies both the series and its associated short token. */
export const v2Series = onchainTable(
  "v2_series",
  (t) => ({
    longId: t.bigint().primaryKey(),
    underlying: t.hex().notNull(),
    ticker: t.text().notNull(),
    isPut: t.boolean().notNull(),
    strike: t.bigint().notNull(),
    expiry: t.bigint().notNull(),
    tenor: t.text().notNull(),
    mintCutoff: t.bigint().notNull(),
    oracle: t.hex().notNull(),
    exerciseFeeBps: t.integer().notNull(),
    mintFeePpm: t.integer().notNull(),
    /** Native collateral rent: held until close refund or settlement accrual. */
    mintFeesHeld: t.bigint().notNull().default(0n),
    mintFeesAccrued: t.bigint().notNull().default(0n),
    status: v2SeriesStatus("status").notNull().default("open"),
    settlementPrice: t.bigint(),
    longPayoutPerUnit: t.bigint(),
    feePerUnit: t.bigint(),
    shortPayoutPerUnit: t.bigint(),
    settledAt: t.bigint(),
    settledTx: t.hex(),
    settledBlock: t.bigint(),
    settledLogIndex: t.integer(),
    openInterestUnits: t.bigint().notNull().default(0n),
    volumeUnits: t.bigint().notNull().default(0n),
    volumeUsdg: t.bigint().notNull().default(0n),
    lastPrice: t.bigint(),
    createdAt: t.bigint().notNull(),
    createdBlock: t.bigint().notNull(),
    createdTx: t.hex().notNull(),
  }),
  (t) => ({
    byUnderlyingExpiry: index().on(t.underlying, t.expiry),
    byTickerExpiry: index().on(t.ticker, t.expiry),
    byStatus: index().on(t.status),
    byExpiry: index().on(t.expiry),
    bySettledActivity: index().on(t.settledBlock, t.settledLogIndex, t.longId),
    bySettledAt: index().on(t.settledAt, t.settledBlock),
  }),
);

/** The current state of one on-chain order; remaining units are `units - filled`. */
export const v2Order = onchainTable(
  "v2_order",
  (t) => ({
    orderId: t.bigint().primaryKey(),
    maker: t.hex().notNull(),
    longId: t.bigint().notNull(),
    kind: v2OrderKind("kind").notNull(),
    price: t.bigint().notNull(),
    units: t.bigint().notNull(),
    filled: t.bigint().notNull().default(0n),
    validUntil: t.bigint().notNull(),
    status: v2OrderStatus("status").notNull().default("open"),
    placedAt: t.bigint().notNull(),
    placedBlock: t.bigint().notNull(),
    placedTx: t.hex().notNull(),
    updatedAt: t.bigint().notNull(),
    /** A replace emits cancellation followed by a new placement in this transaction. */
    cancelledTx: t.hex(),
    cancelledLogIndex: t.integer(),
    replacedBy: t.bigint(),
  }),
  (t) => ({
    byMaker: index().on(t.maker),
    bySeriesStatus: index().on(t.longId, t.status),
    byStatusExpiry: index().on(t.status, t.validUntil),
  }),
);

/** Mutable OrderBook policy. A scheduled change becomes active by block time without another log. */
export const v2OrderBookState = onchainTable("v2_order_book_state", (t) => ({
  /** The OrderBook address. */
  id: t.hex().primaryKey(),
  tradingPaused: t.boolean().notNull().default(false),
  premiumFeeBps: t.integer(),
  resaleFeeBps: t.integer(),
  takerFeeFlat: t.bigint(),
  takerFeeCapBps: t.integer(),
  makerRebateBps: t.integer(),
  pendingPremiumFeeBps: t.integer(),
  pendingResaleFeeBps: t.integer(),
  pendingTakerFeeFlat: t.bigint(),
  pendingTakerFeeCapBps: t.integer(),
  pendingMakerRebateBps: t.integer(),
  pendingEffectiveAt: t.bigint(),
  updatedAt: t.bigint().notNull(),
}));

/** Current admin-maintained holiday calendar, keyed by UTC day index from ExpiryCalendar. */
export const v2CalendarHoliday = onchainTable("v2_calendar_holiday", (t) => ({
  dayIndex: t.integer().primaryKey(),
  isHoliday: t.boolean().notNull(),
  changedAt: t.bigint().notNull(),
  changedBlock: t.bigint().notNull(),
  changedTx: t.hex().notNull(),
}));

/** Whitelisted one-off expiries; denied entries remain visible for historical explanation. */
export const v2SpecialExpiry = onchainTable("v2_special_expiry", (t) => ({
  ts: t.bigint().primaryKey(),
  allowed: t.boolean().notNull(),
  changedAt: t.bigint().notNull(),
  changedBlock: t.bigint().notNull(),
  changedTx: t.hex().notNull(),
}));

/** Latest keeper bounty for each bytes32 action. */
export const v2KeeperBounty = onchainTable("v2_keeper_bounty", (t) => ({
  action: t.hex().primaryKey(),
  amount: t.bigint().notNull(),
  changedAt: t.bigint().notNull(),
  changedBlock: t.bigint().notNull(),
  changedTx: t.hex().notNull(),
}));

/** One Rewarded event, including zero-paid attempts if the contract emits them. */
export const v2KeeperReward = onchainTable("v2_keeper_reward", (t) => ({
  id: t.text().primaryKey(),
  keeper: t.hex().notNull(),
  action: t.hex().notNull(),
  amount: t.bigint().notNull(),
  ts: t.bigint().notNull(),
  block: t.bigint().notNull(),
  logIndex: t.integer().notNull(),
  tx: t.hex().notNull(),
}), (t) => ({ byKeeperTime: index().on(t.keeper, t.ts), byActionTime: index().on(t.action, t.ts) }));

/** Event-derived keeper reward totals, never inferred from configured bounty amounts. */
export const v2KeeperRewardTotal = onchainTable("v2_keeper_reward_total", (t) => ({
  id: t.text().primaryKey(),
  keeper: t.hex().notNull(),
  action: t.hex().notNull(),
  count: t.integer().notNull(),
  amount: t.bigint().notNull(),
}), (t) => ({ byKeeper: index().on(t.keeper), byAction: index().on(t.action) }));

/** One OrderFilled log. `${tx}-${logIndex}` distinguishes multiple makers in one take. */
export const v2Fill = onchainTable(
  "v2_fill",
  (t) => ({
    id: t.text().primaryKey(),
    orderId: t.bigint().notNull(),
    longId: t.bigint().notNull(),
    maker: t.hex().notNull(),
    taker: t.hex().notNull(),
    /** Long receiver on ask hits, USDG receiver on bid hits (interface v4). */
    recipient: t.hex().notNull(),
    units: t.bigint().notNull(),
    price: t.bigint().notNull(),
    premium: t.bigint().notNull(),
    sellerFee: t.bigint().notNull(),
    makerRebate: t.bigint().notNull(),
    primary: t.boolean().notNull(),
    takerIsBuyer: t.boolean().notNull(),
    buyer: t.hex().notNull(),
    seller: t.hex().notNull(),
    /** Fair value at fill time, if the pricing service answered; used for feed integrity. */
    fairAtFill: t.bigint(),
    /** Seller's realised USDG gain or loss on this fill only; null for a primary sale. */
    realisedDeltaUsdg: t.bigint(),
    ts: t.bigint().notNull(),
    block: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    tx: t.hex().notNull(),
  }),
  (t) => ({
    bySeriesTime: index().on(t.longId, t.ts),
    byMakerTime: index().on(t.maker, t.ts),
    byTakerTime: index().on(t.taker, t.ts),
    byTime: index().on(t.ts),
    byBuyer: index().on(t.buyer),
    bySeller: index().on(t.seller),
    byBlockLog: index().on(t.block, t.logIndex),
  }),
);

/** One Taken log, containing the fee for the whole call across its maker fills. */
export const v2Take = onchainTable(
  "v2_take",
  (t) => ({
    id: t.text().primaryKey(),
    taker: t.hex().notNull(),
    longId: t.bigint().notNull(),
    buying: t.boolean().notNull(),
    units: t.bigint().notNull(),
    premium: t.bigint().notNull(),
    takerFee: t.bigint().notNull(),
    ts: t.bigint().notNull(),
    block: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    tx: t.hex().notNull(),
  }),
  (t) => ({ byTakerTime: index().on(t.taker, t.ts), bySeriesTime: index().on(t.longId, t.ts) }),
);

/** Wallet-held ERC-1155 balance; OrderBook escrow is excluded. PnL tracks its beneficial maker separately. */
export const v2Balance = onchainTable(
  "v2_balance",
  (t) => ({
    /** `${tokenId}-${holder}`. */
    id: t.text().primaryKey(),
    tokenId: t.bigint().notNull(),
    holder: t.hex().notNull(),
    longId: t.bigint().notNull(),
    side: v2Side("side").notNull(),
    units: t.bigint().notNull().default(0n),
  }),
  (t) => ({ byHolder: index().on(t.holder), bySeriesSide: index().on(t.longId, t.side) }),
);

/** Raw long-token transfers for block-end cost-basis reconciliation against fill logs. */
export const v2Transfer = onchainTable(
  "v2_transfer",
  (t) => ({
    id: t.text().primaryKey(),
    tokenId: t.bigint().notNull(),
    longId: t.bigint().notNull(),
    from: t.hex().notNull(),
    to: t.hex().notNull(),
    units: t.bigint().notNull(),
    ts: t.bigint().notNull(),
    block: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    tx: t.hex().notNull(),
  }),
  (t) => ({ byBlockLog: index().on(t.block, t.logIndex), byTx: index().on(t.tx) }),
);

/** Last fully reconciled block. A reorg rewinds this row with the other onchain tables. */
export const v2PnlCursor = onchainTable("v2_pnl_cursor", (t) => ({
  id: t.text().primaryKey(),
  block: t.bigint().notNull(),
}));

/** FIFO long cost basis. Transfer-in lots carry zero cost and cannot produce feed wins. */
export const v2Lot = onchainTable(
  "v2_lot",
  (t) => ({
    /** `${longId}-${holder}-${seq}`. */
    id: t.text().primaryKey(),
    longId: t.bigint().notNull(),
    holder: t.hex().notNull(),
    seq: t.integer().notNull(),
    units: t.bigint().notNull(),
    unitsRemaining: t.bigint().notNull(),
    /** Includes this lot's share of the taker fee. USDG base units. */
    costUsdg: t.bigint().notNull(),
    costRemainingUsdg: t.bigint().notNull(),
    acquiredAt: t.bigint().notNull(),
    source: v2LotSource("source").notNull(),
    sourceId: t.text().notNull(),
  }),
  (t) => ({ byHolderSeriesSeq: index().on(t.holder, t.longId, t.seq), bySeries: index().on(t.longId) }),
);

/** One holder's realised result in one series. PPM gives an exact sortable multiple. */
export const v2PositionPnl = onchainTable(
  "v2_position_pnl",
  (t) => ({
    /** `${longId}-${holder}`; also the public win ID. */
    id: t.text().primaryKey(),
    longId: t.bigint().notNull(),
    holder: t.hex().notNull(),
    unitsBought: t.bigint().notNull().default(0n),
    costUsdg: t.bigint().notNull().default(0n),
    unitsSold: t.bigint().notNull().default(0n),
    proceedsUsdg: t.bigint().notNull().default(0n),
    unitsTransferredOut: t.bigint().notNull().default(0n),
    unitsRedeemed: t.bigint().notNull().default(0n),
    payoutUsdgValue: t.bigint().notNull().default(0n),
    realisedUsdg: t.bigint().notNull().default(0n),
    /** Exact decimal display value; `multiplePpm` is for ranking. */
    multiple: t.text(),
    multiplePpm: t.bigint(),
    /** Pricing-service spot from the first observed buy, for the PnL receipt. */
    spotAtEntry: t.bigint(),
    closedAt: t.bigint(),
    closedTx: t.hex(),
    selfFill: t.boolean().notNull().default(false),
    belowMinCost: t.boolean().notNull().default(false),
    offMarket: t.boolean().notNull().default(false),
    transferIn: t.boolean().notNull().default(false),
    transferredOut: t.boolean().notNull().default(false),
  }),
  (t) => ({
    byHolder: index().on(t.holder),
    bySeries: index().on(t.longId),
    byClosed: index().on(t.closedAt),
    byMultiple: index().on(t.multiplePpm),
  }),
);

/** Per-holder materialized ranking counters for New York week, month and all time. */
export const v2Leaderboard = onchainTable(
  "v2_leaderboard",
  (t) => ({
    id: t.text().primaryKey(),
    window: t.text().notNull(),
    windowStart: t.bigint().notNull(),
    holder: t.hex().notNull(),
    bestMultiplePpm: t.bigint().notNull().default(0n),
    absoluteRealisedUsdg: t.bigint().notNull().default(0n),
    streak: t.integer().notNull().default(0),
    wins: t.integer().notNull().default(0),
    losses: t.integer().notNull().default(0),
    bestWinId: t.text(),
    updatedAt: t.bigint().notNull(),
  }),
  (t) => ({
    byWindowMultiple: index().on(t.window, t.windowStart, t.bestMultiplePpm),
    byWindowAbsolute: index().on(t.window, t.windowStart, t.absoluteRealisedUsdg),
    byWindowStreak: index().on(t.window, t.windowStart, t.streak),
    byHolder: index().on(t.holder),
  }),
);

/** Writer performance from premiums and released/assigned collateral, per period. */
export const v2WriterStats = onchainTable(
  "v2_writer_stats",
  (t) => ({
    id: t.text().primaryKey(),
    writer: t.hex().notNull(),
    window: t.text().notNull(),
    windowStart: t.bigint().notNull(),
    premiumUsdg: t.bigint().notNull().default(0n),
    collateralUsdg: t.bigint().notNull().default(0n),
    assignedUsdg: t.bigint().notNull().default(0n),
    realisedYieldUsdg: t.bigint().notNull().default(0n),
    updatedAt: t.bigint().notNull(),
  }),
  (t) => ({ byWriterWindow: index().on(t.writer, t.window, t.windowStart) }),
);

/** Exact net primary premiums per writer and series. Updated after Taken fees are
 * matched to all fills in a block; positions reads this instead of trade history. */
export const v2WriterSeriesPremium = onchainTable(
  "v2_writer_series_premium",
  (t) => ({
    /** `${longId}-${writer}`. */
    id: t.text().primaryKey(),
    longId: t.bigint().notNull(),
    writer: t.hex().notNull(),
    premiumUsdg: t.bigint().notNull().default(0n),
  }),
  (t) => ({ byWriterSeries: index().on(t.writer, t.longId) }),
);

/** Free internal asset balance, keyed `${account}-${asset}`. */
export const v2Ledger = onchainTable(
  "v2_ledger",
  (t) => ({
    id: t.text().primaryKey(),
    account: t.hex().notNull(),
    asset: t.hex().notNull(),
    free: t.bigint().notNull().default(0n),
  }),
  (t) => ({ byAccount: index().on(t.account), byAsset: index().on(t.asset) }),
);

/** Deposit and withdrawal receipts for account history; ledger alone cannot reconstruct them. */
export const v2CashFlow = onchainTable(
  "v2_cash_flow",
  (t) => ({
    id: t.text().primaryKey(),
    kind: t.text().notNull(),
    account: t.hex().notNull(),
    /** Deposited.from or Withdrawn.to; can differ from the ledger account. */
    actor: t.hex().notNull(),
    asset: t.hex().notNull(),
    amount: t.bigint().notNull(),
    ts: t.bigint().notNull(),
    block: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    tx: t.hex().notNull(),
  }),
  (t) => ({ byAccountTime: index().on(t.account, t.ts) }),
);

/** Current payout preferences, permissions, and lifetime writer/buyer statistics. */
export const v2Account = onchainTable(
  "v2_account",
  (t) => ({
    account: t.hex().primaryKey(),
    /** USDG is the default payout choice; the holder explicitly opts into Stock Tokens. */
    inKind: t.boolean().notNull().default(false),
    toLedger: t.boolean().notNull().default(false),
    thirdPartyRedeem: t.boolean().notNull().default(true),
    /** JSON address maps are event-derived; individual updates preserve old entries. */
    operators: t.text().notNull().default("{}"),
    delegates: t.text().notNull().default("{}"),
    approvals: t.text().notNull().default("{}"),
    firstSeen: t.bigint().notNull(),
    lastSeen: t.bigint().notNull(),
    fills: t.integer().notNull().default(0),
    volumeUsdg: t.bigint().notNull().default(0n),
    premiumReceivedUsdg: t.bigint().notNull().default(0n),
    realisedUsdg: t.bigint().notNull().default(0n),
    wins: t.integer().notNull().default(0),
    losses: t.integer().notNull().default(0),
    streak: t.integer().notNull().default(0),
    bestStreak: t.integer().notNull().default(0),
  }),
  (t) => ({ byWins: index().on(t.wins), byStreak: index().on(t.streak) }),
);

/** Append-only Minted log. Collateral is in the series' collateral asset base units. */
export const v2Mint = onchainTable(
  "v2_mint",
  (t) => ({
    id: t.text().primaryKey(),
    longId: t.bigint().notNull(),
    writer: t.hex().notNull(),
    longTo: t.hex().notNull(),
    units: t.bigint().notNull(),
    collateral: t.bigint().notNull(),
    fee: t.bigint().notNull(),
    ts: t.bigint().notNull(),
    block: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    tx: t.hex().notNull(),
  }),
  (t) => ({ byWriter: index().on(t.writer), byLongTo: index().on(t.longTo), bySeries: index().on(t.longId) }),
);

/** Append-only Closed log. */
export const v2Close = onchainTable(
  "v2_close",
  (t) => ({
    id: t.text().primaryKey(),
    longId: t.bigint().notNull(),
    account: t.hex().notNull(),
    units: t.bigint().notNull(),
    collateralFreed: t.bigint().notNull(),
    feeRefund: t.bigint().notNull(),
    /** Account's realised USDG gain or loss on this close only. */
    realisedDeltaUsdg: t.bigint(),
    ts: t.bigint().notNull(),
    block: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    tx: t.hex().notNull(),
  }),
  (t) => ({ byAccount: index().on(t.account), bySeries: index().on(t.longId) }),
);

/** Append-only Redeemed log; `amount` is actual delivery, `amountInKind` is owed collateral. */
export const v2Redemption = onchainTable(
  "v2_redemption",
  (t) => ({
    id: t.text().primaryKey(),
    tokenId: t.bigint().notNull(),
    longId: t.bigint().notNull(),
    side: v2Side("side").notNull(),
    holder: t.hex().notNull(),
    to: t.hex().notNull(),
    units: t.bigint().notNull(),
    asset: t.hex().notNull(),
    amount: t.bigint().notNull(),
    amountInKind: t.bigint().notNull(),
    toLedger: t.boolean().notNull(),
    /** Holder's realised USDG gain or loss on a long redemption; null for a short. */
    realisedDeltaUsdg: t.bigint(),
    ts: t.bigint().notNull(),
    block: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    tx: t.hex().notNull(),
  }),
  (t) => ({ byHolderTime: index().on(t.holder, t.ts), bySeries: index().on(t.longId), byTime: index().on(t.ts) }),
);

/** One oracle verdict per `(underlying, expiry)` shared by all strikes and sides. */
export const v2Settlement = onchainTable(
  "v2_settlement",
  (t) => ({
    id: t.text().primaryKey(),
    underlying: t.hex().notNull(),
    expiry: t.bigint().notNull(),
    status: v2SettlementStatus("status").notNull().default("None"),
    price: t.bigint(),
    sourceIndex: t.integer(),
    corroborated: t.boolean(),
    candidatePrice: t.bigint(),
    candidateSourceIndex: t.integer(),
    candidateDisagreed: t.boolean(),
    candidateAt: t.bigint(),
    finalizableAt: t.bigint(),
    /** JSON map of source index to `{ok, price, recordedAt}`. */
    recordedSources: t.text().notNull().default("{}"),
    finalizedAt: t.bigint(),
    finalizedTx: t.hex(),
    /** The canonical finalized/resolved log, for stable notifier activity ordering. */
    finalizedBlock: t.bigint(),
    finalizedLogIndex: t.integer(),
    heldAt: t.bigint(),
  }),
  (t) => ({ byUnderlyingExpiry: index().on(t.underlying, t.expiry), byStatus: index().on(t.status) }),
);

/** Current AutoRoller strategy for one writer and underlying. */
export const v2Strategy = onchainTable(
  "v2_strategy",
  (t) => ({
    id: t.text().primaryKey(),
    writer: t.hex().notNull(),
    underlying: t.hex().notNull(),
    ticker: t.text().notNull(),
    active: t.boolean().notNull(),
    weekly: t.boolean().notNull(),
    smartPricing: t.boolean().notNull(),
    otmBps: t.integer().notNull(),
    askBps: t.integer().notNull(),
    minAskBps: t.integer().notNull(),
    maxAskBps: t.integer().notNull(),
    maxUnits: t.bigint().notNull(),
    currentLongId: t.bigint(),
    orderId: t.bigint(),
    expiry: t.bigint(),
    lastRolledAt: t.bigint(),
    lastStaleCancelAt: t.bigint(),
    staleSpot: t.bigint(),
    updatedAt: t.bigint().notNull(),
  }),
  (t) => ({ byWriter: index().on(t.writer), byUnderlyingActive: index().on(t.underlying, t.active) }),
);

/** Append-only Rolled log, including the new order and its terms. */
export const v2Roll = onchainTable(
  "v2_roll",
  (t) => ({
    id: t.text().primaryKey(),
    writer: t.hex().notNull(),
    underlying: t.hex().notNull(),
    longId: t.bigint().notNull(),
    orderId: t.bigint().notNull(),
    strike: t.bigint().notNull(),
    expiry: t.bigint().notNull(),
    price: t.bigint().notNull(),
    units: t.bigint().notNull(),
    ts: t.bigint().notNull(),
    block: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    tx: t.hex().notNull(),
  }),
  (t) => ({ byWriterTime: index().on(t.writer, t.ts), bySeries: index().on(t.longId), byTime: index().on(t.ts) }),
);

/** Materialized quote quality and rebates for a maker in one weekly epoch. */
export const v2MakerEpoch = onchainTable(
  "v2_maker_epoch",
  (t) => ({
    /** `${maker}-${epoch}`. */
    id: t.text().primaryKey(),
    maker: t.hex().notNull(),
    epoch: t.bigint().notNull(),
    tierBps: t.integer().notNull().default(0),
    samples: t.integer().notNull().default(0),
    twoSidedSamples: t.integer().notNull().default(0),
    uptimePpm: t.bigint().notNull().default(0n),
    avgSpreadBps: t.bigint().notNull().default(0n),
    depthWithin100bps: t.bigint().notNull().default(0n),
    fills: t.integer().notNull().default(0),
    volumeUsdg: t.bigint().notNull().default(0n),
    rebatesUsdg: t.bigint().notNull().default(0n),
    scorePpm: t.bigint().notNull().default(0n),
  }),
  (t) => ({ byEpochScore: index().on(t.epoch, t.scorePpm), byMaker: index().on(t.maker) }),
);

/** Daily aggregate. `day` is UTC day start; per-market and global rows share this table. */
export const v2StatsDaily = onchainTable(
  "v2_stats_daily",
  (t) => ({
    /** `${day}-${underlying}`; use `all` for the global row. */
    id: t.text().primaryKey(),
    day: t.bigint().notNull(),
    underlying: t.hex(),
    volumeUnits: t.bigint().notNull().default(0n),
    volumeUsdg: t.bigint().notNull().default(0n),
    premiumUsdg: t.bigint().notNull().default(0n),
    feesUsdg: t.bigint().notNull().default(0n),
    contractsFilled: t.integer().notNull().default(0),
    newHolders: t.integer().notNull().default(0),
    wins: t.integer().notNull().default(0),
  }),
  (t) => ({ byDay: index().on(t.day), byUnderlyingDay: index().on(t.underlying, t.day) }),
);

/** Rent becoming treasury revenue, in the emitted native collateral asset. */
export const v2MintFeeAccrual = onchainTable("v2_mint_fee_accrual", (t) => ({
  id: t.text().primaryKey(), longId: t.bigint().notNull(), asset: t.hex().notNull(), amount: t.bigint().notNull(),
  ts: t.bigint().notNull(), block: t.bigint().notNull(), logIndex: t.integer().notNull(), tx: t.hex().notNull(),
}), (t) => ({ bySeries: index().on(t.longId), byAsset: index().on(t.asset) }));

/** Permissionless withdrawal of a stale AutoRoller ask; position remains until expiry. */
export const v2StaleCancel = onchainTable("v2_stale_cancel", (t) => ({
  id: t.text().primaryKey(), writer: t.hex().notNull(), underlying: t.hex().notNull(),
  longId: t.bigint().notNull(), orderId: t.bigint().notNull(), spot: t.bigint().notNull(), spotUpdatedAt: t.bigint().notNull(),
  ts: t.bigint().notNull(), block: t.bigint().notNull(), logIndex: t.integer().notNull(), tx: t.hex().notNull(),
}), (t) => ({ byWriter: index().on(t.writer), byActivity: index().on(t.block, t.logIndex, t.id) }));
