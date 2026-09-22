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
export const v2AccessOperationStatus = onchainEnum("v2_access_operation_status", [
  "pending", "executed", "canceled",
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
  defaultExerciseFeeBps: t.integer().notNull().default(0),
  defaultMintFeePpm: t.integer().notNull().default(0),
  defaultOracle: t.hex(),
  feeRecipient: t.hex(),
  payoutAdapter: t.hex(),
  maxSlippageBps: t.integer(),
  updatedAt: t.bigint().notNull(),
}));

/** Current Clearinghouse minter allow-list, derived only from MinterSet. */
export const v2Minter = onchainTable("v2_minter", (t) => ({
  minter: t.hex().primaryKey(),
  allowed: t.boolean().notNull(),
  changedAt: t.bigint().notNull(),
  changedBlock: t.bigint().notNull(),
  changedTx: t.hex().notNull(),
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
  discountModule: t.hex(),
  updatedAt: t.bigint().notNull(),
}));

/** Current maker-controlled funding policy. Revoking allowance also forces funding off on chain. */
export const v2FundingSource = onchainTable("v2_funding_source", (t) => ({
  maker: t.hex().primaryKey(),
  allowed: t.boolean().notNull().default(false),
  fundingOn: t.boolean().notNull().default(false),
  changedAt: t.bigint().notNull(),
  changedBlock: t.bigint().notNull(),
  changedTx: t.hex().notNull(),
}));

/** One attempted OrderBook funding pull. A null delivered amount means FundingFailed, not zero delivery. */
export const v2FundingAttempt = onchainTable("v2_funding_attempt", (t) => ({
  id: t.text().primaryKey(),
  maker: t.hex().notNull(),
  asset: t.hex().notNull(),
  requested: t.bigint().notNull(),
  delivered: t.bigint(),
  succeeded: t.boolean().notNull(),
  ts: t.bigint().notNull(),
  block: t.bigint().notNull(),
  logIndex: t.integer().notNull(),
  tx: t.hex().notNull(),
}), (t) => ({ byMakerTime: index().on(t.maker, t.ts), byAssetTime: index().on(t.asset, t.ts) }));

/** One AccessManager operation nonce. The terminal events carry no payload, so schedule fields are nullable. */
export const v2AccessOperation = onchainTable("v2_access_operation", (t) => ({
  id: t.text().primaryKey(),
  // AccessManager's operation id (the `operationId` event argument). NAMED `opId`, NOT `operationId`, because
  // ponder 0.17 reserves the snake-cased columns `operation_id`, `operation` and `checkpoint` for its own reorg
  // tables and refuses the schema at build time ("'v2AccessOperation.operationId' is a reserved column name",
  // node_modules/ponder/dist/esm/build/schema.js) -- the indexer could not boot (T-OP-197). The wire field
  // stays `id` (src/api/v2/admin.ts operationWire); only the DB column is renamed. `opId` is the name the
  // day-zero batch uses for the same value (callhouse-contracts docs/V8-DAY-ZERO-ADMIN-BATCH.md).
  opId: t.hex().notNull(),
  nonce: t.bigint().notNull(),
  status: v2AccessOperationStatus("status").notNull(),
  caller: t.hex(),
  target: t.hex(),
  data: t.hex(),
  selector: t.hex(),
  targetName: t.text(),
  functionSignature: t.text(),
  label: t.text(),
  expectedRoleId: t.bigint(),
  roleId: t.bigint(),
  roleName: t.text(),
  scheduledAt: t.bigint(),
  readyAt: t.bigint(),
  expiresAt: t.bigint(),
  scheduledBlock: t.bigint(),
  scheduledLogIndex: t.integer(),
  scheduledTx: t.hex(),
  finishedAt: t.bigint(),
  finishedBlock: t.bigint(),
  finishedLogIndex: t.integer(),
  finishedTx: t.hex(),
}), (t) => ({
  byStatusReady: index().on(t.status, t.readyAt),
  byTarget: index().on(t.target),
  byCaller: index().on(t.caller),
}));

/** Current AccessManager role settings; delayed grant-delay changes retain both sides of the transition. */
export const v2AccessRole = onchainTable("v2_access_role", (t) => ({
  roleId: t.bigint().primaryKey(),
  name: t.text().notNull(),
  chainLabel: t.text(),
  expectedExecutionDelayS: t.bigint(),
  adminRoleId: t.bigint().notNull().default(0n),
  guardianRoleId: t.bigint().notNull().default(0n),
  grantDelayS: t.bigint().notNull().default(0n),
  pendingGrantDelayS: t.bigint(),
  pendingGrantDelayAt: t.bigint(),
  updatedAt: t.bigint().notNull(),
  updatedBlock: t.bigint().notNull(),
  updatedLogIndex: t.integer().notNull(),
  updatedTx: t.hex().notNull(),
}));

/** Current membership plus any delayed execution-delay replacement. */
export const v2AccessRoleMember = onchainTable("v2_access_role_member", (t) => ({
  id: t.text().primaryKey(),
  roleId: t.bigint().notNull(),
  roleName: t.text().notNull(),
  account: t.hex().notNull(),
  granted: t.boolean().notNull(),
  memberSince: t.bigint(),
  executionDelayS: t.bigint(),
  pendingExecutionDelayS: t.bigint(),
  pendingExecutionDelayAt: t.bigint(),
  lastGrantNewMember: t.boolean(),
  grantedAt: t.bigint(),
  grantedBlock: t.bigint(),
  grantedTx: t.hex(),
  revokedAt: t.bigint(),
  revokedBlock: t.bigint(),
  revokedTx: t.hex(),
}), (t) => ({ byRoleGranted: index().on(t.roleId, t.granted), byAccountGranted: index().on(t.account, t.granted) }));

/** Current AccessManager target-level settings, including a delayed admin-delay replacement. */
export const v2AccessTarget = onchainTable("v2_access_target", (t) => ({
  target: t.hex().primaryKey(),
  targetName: t.text(),
  closed: t.boolean().notNull().default(false),
  adminDelayS: t.bigint().notNull().default(0n),
  pendingAdminDelayS: t.bigint(),
  pendingAdminDelayAt: t.bigint(),
  updatedAt: t.bigint().notNull(),
  updatedBlock: t.bigint().notNull(),
  updatedLogIndex: t.integer().notNull(),
  updatedTx: t.hex().notNull(),
}));

/** Current `(target, selector) -> role` mapping. Manifest expectations are annotations, not chain state. */
export const v2AccessTargetFunction = onchainTable("v2_access_target_function", (t) => ({
  id: t.text().primaryKey(),
  target: t.hex().notNull(),
  targetName: t.text(),
  selector: t.hex().notNull(),
  functionSignature: t.text(),
  label: t.text(),
  roleId: t.bigint().notNull(),
  roleName: t.text().notNull(),
  expectedRoleId: t.bigint(),
  changedAt: t.bigint().notNull(),
  changedBlock: t.bigint().notNull(),
  changedLogIndex: t.integer().notNull(),
  changedTx: t.hex().notNull(),
}), (t) => ({ byTarget: index().on(t.target), byRole: index().on(t.roleId) }));

/** Latest payout route. `routes()` supplies the v8-only tickSpacing and v3Pool tuple fields. */
export const v2PayoutRoute = onchainTable("v2_payout_route", (t) => ({
  asset: t.hex().primaryKey(),
  active: t.boolean().notNull(),
  venue: t.integer().notNull(),
  poolId: t.hex().notNull(),
  fee: t.integer().notNull(),
  tickSpacing: t.integer().notNull(),
  v3Pool: t.hex().notNull(),
  feeBps: t.integer().notNull(),
  changedAt: t.bigint().notNull(),
  changedBlock: t.bigint().notNull(),
  changedTx: t.hex().notNull(),
}));

/** FeeSplitter distribution, including the USDG amount that actually exited to treasury. */
export const v2FlywheelDistribution = onchainTable("v2_flywheel_distribution", (t) => ({
  id: t.text().primaryKey(),
  asset: t.hex().notNull(),
  assetIn: t.bigint().notNull(),
  usdgIn: t.bigint().notNull(),
  treasuryOut: t.bigint().notNull(),
  buybackAdded: t.bigint().notNull(),
  ts: t.bigint().notNull(), block: t.bigint().notNull(), logIndex: t.integer().notNull(), tx: t.hex().notNull(),
}), (t) => ({ byTime: index().on(t.ts), byAssetTime: index().on(t.asset, t.ts) }));

export const v2FlywheelDistributionSkip = onchainTable("v2_flywheel_distribution_skip", (t) => ({
  id: t.text().primaryKey(), asset: t.hex().notNull(), reason: t.hex().notNull(),
  ts: t.bigint().notNull(), block: t.bigint().notNull(), logIndex: t.integer().notNull(), tx: t.hex().notNull(),
}), (t) => ({ byTime: index().on(t.ts) }));

export const v2FlywheelBuyback = onchainTable("v2_flywheel_buyback", (t) => ({
  id: t.text().primaryKey(), usdgIn: t.bigint().notNull(), tokenOut: t.bigint().notNull(),
  ts: t.bigint().notNull(), block: t.bigint().notNull(), logIndex: t.integer().notNull(), tx: t.hex().notNull(),
}), (t) => ({ byTime: index().on(t.ts) }));

/** Burn rows carry event-block supply; totals are derived from rows and supply, never a mutable counter. */
export const v2FlywheelBurn = onchainTable("v2_flywheel_burn", (t) => ({
  id: t.text().primaryKey(), token: t.hex().notNull(), amount: t.bigint().notNull(),
  totalSupplyAtBlock: t.bigint().notNull(),
  ts: t.bigint().notNull(), block: t.bigint().notNull(), logIndex: t.integer().notNull(), tx: t.hex().notNull(),
}), (t) => ({ byTime: index().on(t.ts) }));

export const v2FlywheelBuybackSkip = onchainTable("v2_flywheel_buyback_skip", (t) => ({
  id: t.text().primaryKey(), reason: t.hex().notNull(),
  ts: t.bigint().notNull(), block: t.bigint().notNull(), logIndex: t.integer().notNull(), tx: t.hex().notNull(),
}), (t) => ({ byTime: index().on(t.ts) }));

/** Concrete V4BuybackExecutor execution detail; FeeSplitter:BoughtBack remains the canonical buy receipt. */
export const v2FlywheelExecution = onchainTable("v2_flywheel_execution", (t) => ({
  id: t.text().primaryKey(), usdgIn: t.bigint().notNull(), usdgSpent: t.bigint().notNull(),
  wethOut: t.bigint().notNull(), tokenOut: t.bigint().notNull(), minWethOut: t.bigint().notNull(),
  declaredFeeBps: t.bigint().notNull(), measuredFeeBps: t.bigint().notNull(),
  ts: t.bigint().notNull(), block: t.bigint().notNull(), logIndex: t.integer().notNull(), tx: t.hex().notNull(),
}), (t) => ({ byTime: index().on(t.ts) }));

/** Executor audit event only. Public burn totals use FeeSplitter:Burned, never this duplicate signal. */
export const v2FlywheelExecutorBurn = onchainTable("v2_flywheel_executor_burn", (t) => ({
  id: t.text().primaryKey(), amount: t.bigint().notNull(),
  ts: t.bigint().notNull(), block: t.bigint().notNull(), logIndex: t.integer().notNull(), tx: t.hex().notNull(),
}), (t) => ({ byTime: index().on(t.ts), byTx: index().on(t.tx) }));

/** A fee sweep that could not collect what an order book owed. The event payload (orderBook,
 *  amount) cannot tell its three cases apart, so `kind` records WHICH emit fired rather than being
 *  derived from the amount — see the handler in src/v2/flywheel.ts. */
export const v2FlywheelStrandedFees = onchainTable("v2_flywheel_stranded_fees", (t) => ({
  id: t.text().primaryKey(), orderBook: t.hex().notNull(),
  /** OWED_UNREADABLE | CLAIM_SHORT | CLAIM_REVERTED */
  kind: t.text().notNull(),
  /** 0 ONLY when kind is OWED_UNREADABLE, where it means UNKNOWN — never "nothing stranded". */
  amount: t.bigint().notNull(),
  ts: t.bigint().notNull(), block: t.bigint().notNull(), logIndex: t.integer().notNull(), tx: t.hex().notNull(),
}), (t) => ({ byTime: index().on(t.ts), byBook: index().on(t.orderBook) }));

/** Money or positions leaving treasury-controlled protocol holders. */
export const v2TreasuryExit = onchainTable("v2_treasury_exit", (t) => ({
  id: t.text().primaryKey(), source: t.text().notNull(), sourceAddress: t.hex().notNull(),
  eventKind: t.text().notNull(), assetKind: t.text().notNull(),
  asset: t.hex(), tokenId: t.bigint(), recipient: t.hex().notNull(), amount: t.bigint().notNull(),
  ts: t.bigint().notNull(), block: t.bigint().notNull(), logIndex: t.integer().notNull(), tx: t.hex().notNull(),
}), (t) => ({ bySourceTime: index().on(t.source, t.ts), byRecipientTime: index().on(t.recipient, t.ts) }));

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

/** Durable evidence that two non-protocol wallets have interacted. Links are append-only. */
export const v2SelfTradeLink = onchainTable(
  "v2_self_trade_link",
  (t) => ({
    /** The two lower-case addresses, sorted and joined with `:`. */
    id: t.text().primaryKey(),
    left: t.hex().notNull(),
    right: t.hex().notNull(),
  }),
  (t) => ({ byLeft: index().on(t.left), byRight: index().on(t.right) }),
);

/** FIFO ownership lots used to distinguish linked minimum-price units from ordinary inventory. */
export const v2SelfTradeLot = onchainTable(
  "v2_self_trade_lot",
  (t) => ({
    /** Deterministic source-event path; retained at zero so replay cannot recreate consumed taint. */
    id: t.text().primaryKey(),
    longId: t.bigint().notNull(),
    holder: t.hex().notNull(),
    /** The primary writer for measured units; null means ordinary, unmeasured inventory. */
    writer: t.hex(),
    primaryFillId: t.text(),
    sourceId: t.text().notNull(),
    units: t.bigint().notNull(),
    unitsRemaining: t.bigint().notNull(),
    createdBlock: t.bigint().notNull(),
    createdLogIndex: t.integer().notNull(),
  }),
  (t) => ({
    byHolderSeries: index().on(t.holder, t.longId),
    byWriter: index().on(t.writer),
  }),
);

/** Lifetime units attributed to a writer, independent of maker-program enrollment. */
export const v2SelfTradeMaker = onchainTable("v2_self_trade_maker", (t) => ({
  maker: t.hex().primaryKey(),
  units: t.bigint().notNull().default(0n),
  updatedAt: t.bigint().notNull(),
  updatedBlock: t.bigint().notNull(),
}));

/**
 * WHAT THE DETECTOR REFUSED TO COUNT, AND WHY. One row per reason, not per fill.
 *
 * v2SelfTradeMaker alone cannot answer the question D18 actually attached to leaving the
 * self-trade loophole open ("the indexer flags the pattern"), because the attribution fires only
 * on `takerIsBuyer && minimumPrice && linked` (indexer/lib/v2/selfTrade.ts). Both cheap evasions
 * - pricing the primary leg one tick higher, or funding the second wallet off chain so no edge
 * exists - drive the counted total to exactly 0, which is indistinguishable from an honest
 * market. This table is what makes that 0 readable: if it is empty the zero is real, and if it is
 * not the zero is an artefact of the detector.
 *
 * `reason` is the primary key and comes from SelfTradeUnseenReason, so this table has one row per
 * distinct blind spot and is rewritten in place rather than appended per block.
 */
export const v2SelfTradeUnseen = onchainTable("v2_self_trade_unseen", (t) => ({
  reason: t.text().primaryKey(),
  units: t.bigint().notNull().default(0n),
  fills: t.integer().notNull().default(0),
  updatedAt: t.bigint().notNull(),
  updatedBlock: t.bigint().notNull(),
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
    /** Reprice history belongs to the current rolled position and resets on the next roll. */
    lastRepricedAt: t.bigint(),
    lastRepricedPrice: t.bigint(),
    repriceCount: t.integer().notNull().default(0),
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
    /**
     * lib/v2/makerScoring.ts MAKER_BENCHMARK_POLICY when scored. Figures compare only within one policy;
     * no default, so a writer that forgets it fails instead of labelling a row it did not score.
     */
    benchmarkPolicy: t.integer().notNull(),
    /** absentSamples + validSamples: what uptime and depth are averaged over. */
    samples: t.integer().notNull().default(0),
    /** Series-ticks with no quote on either side: definite downtime. */
    absentSamples: t.integer().notNull().default(0),
    /** Series-ticks quoted and measured against a chain reference; may measure zero. */
    validSamples: t.integer().notNull().default(0),
    /** Series-ticks quoted with no chain reference to measure against; outside uptime and depth. */
    missingReferenceSamples: t.integer().notNull().default(0),
    twoSidedSamples: t.integer().notNull().default(0),
    uptimePpm: t.bigint().notNull().default(0n),
    avgSpreadBps: t.bigint().notNull().default(0n),
    /**
     * The mean resting units inside 100 bps of fair. Its NAME pins its band, so it keeps that meaning and
     * never takes the epoch band (02-interfaces.md:870-873).
     */
    depthWithin100bps: t.bigint().notNull().default(0n),
    /**
     * The same mean inside the epoch's scoring band (lib/v2/makerScoring.ts MAKER_SCORING_POLICY). This is
     * the one the score ranks on; the 100 bps column is published beside it and is not scored.
     */
    depthInBand: t.bigint().notNull().default(0n),
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

/*//////////////////////////////////////////////////////////////
                  P8 LENDING PERIPHERY — EARN VAULT
//////////////////////////////////////////////////////////////*/

/**
 * The Earn VAULT is the lending surface: depositors supply a Stock Token or USDG, receive shares,
 * and the vault keeps what it does not need right now in a venue adapter (v8-plan/tasks/
 * P-periphery.md:19-30, P8-02). It is NOT `/earn` in the web app, which is the covered-call
 * WRITING surface (web/app/earn/page.tsx). Every table here is prefixed `v2EarnVault` for that
 * reason; the bare word means the writing surface everywhere else in this product.
 *
 * TWO RULES THIS BLOCK IS BUILT ON.
 *
 * 1. Yield is recorded only from observed flows. No column holds a rate, a projection, or any
 *    figure scaled to a period the chain did not report: a skim row is base units and a
 *    timestamp, and whoever wants a period return divides two observations at the edge. The
 *    vault's venue exposes a rate as a view; it is deliberately not read and not stored.
 * 2. Unavailable is not zero. A column whose "not observed yet" state differs from "observed and
 *    it was zero" is nullable and says so, on the precedent of v2FundingAttempt.delivered above
 *    ("A null delivered amount means FundingFailed, not zero delivery"). A .notNull().default(0)
 *    on such a column would publish a guess as a measurement.
 *
 * The OrderBook's side of just-in-time funding is already indexed into v2FundingSource and
 * v2FundingAttempt by src/v2/orderBook.ts and is not duplicated here. v2EarnVaultAdapterMove is
 * the VAULT's own view — what it pulled from or pushed to its venue adapter — and the two are
 * meant to be cross-checked against each other, not merged.
 */

/**
 * One configured Earn vault, keyed by its address so a second instance never overwrites the first.
 * Every configuration column is nullable: the row is created by whichever event is observed first,
 * and a skim of 0 bps or an unpaused vault are real observations that must not be confused with a
 * field nothing has reported yet.
 */
export const v2EarnVaultState = onchainTable("v2_earn_vault_state", (t) => ({
  vault: t.hex().primaryKey(),
  /** The supplied asset (a Stock Token or USDG). Null until an asset-naming event is observed. */
  asset: t.hex(),
  /** Current venue adapter. Null until observed; the zero address would be a real "detached" value. */
  adapter: t.hex(),
  /** Yield skim to the FeeSplitter. Null means not observed; 0 means observed and skimming nothing. */
  skimBps: t.integer(),
  /** Null means not observed; false means observed and running. */
  paused: t.boolean(),
  /** Running share supply from observed mint/burn events. Null until the first is observed. */
  sharesSupply: t.bigint(),
  updatedAt: t.bigint().notNull(),
  updatedBlock: t.bigint().notNull(),
  updatedLogIndex: t.integer().notNull(),
  updatedTx: t.hex().notNull(),
}));

/** One completed deposit. Both amounts come from the log that created the row, so neither is nullable. */
export const v2EarnVaultDeposit = onchainTable("v2_earn_vault_deposit", (t) => ({
  id: t.text().primaryKey(),
  vault: t.hex().notNull(),
  /** Asset owner that initiated the deposit. */
  account: t.hex().notNull(),
  /** Account that received the minted shares; it may differ from the owner. */
  receiver: t.hex().notNull(),
  asset: t.hex().notNull(),
  /** Supplied amount in the asset's base units. */
  assets: t.bigint().notNull(),
  /** Shares minted for it, in share base units. */
  shares: t.bigint().notNull(),
  /** Null for an immediate deposit; otherwise the v2EarnVaultDepositQueue row it fulfilled. */
  queueId: t.text(),
  ts: t.bigint().notNull(),
  block: t.bigint().notNull(),
  logIndex: t.integer().notNull(),
  tx: t.hex().notNull(),
}), (t) => ({
  byAccountTime: index().on(t.account, t.ts),
  byReceiverTime: index().on(t.receiver, t.ts),
  byVaultTime: index().on(t.vault, t.ts),
  byAssetTime: index().on(t.asset, t.ts),
  byQueue: index().on(t.queueId),
}));

/**
 * One deposit request held until the vault returns to a flat boundary. A queued row is not a
 * completed deposit: no shares exist until DepositServed. `status` is one of `queued` |
 * `fulfilled` | `cancelled`.
 */
export const v2EarnVaultDepositQueue = onchainTable("v2_earn_vault_deposit_queue", (t) => ({
  id: t.text().primaryKey(),
  vault: t.hex().notNull(),
  /** Asset owner from DepositQueued; DepositServed does not repeat it. */
  account: t.hex().notNull(),
  receiver: t.hex().notNull(),
  asset: t.hex().notNull(),
  status: t.text().notNull(),
  /** Assets escrowed while the request waits. */
  assetsQueued: t.bigint().notNull(),
  requestedAt: t.bigint().notNull(),
  requestedBlock: t.bigint().notNull(),
  requestedLogIndex: t.integer().notNull(),
  requestedTx: t.hex().notNull(),
  /** Null while queued or cancelled; DepositServed always mints a positive amount. */
  mintedShares: t.bigint(),
  /** All null while open; set together when the request is fulfilled or cancelled. */
  fulfilledAt: t.bigint(),
  fulfilledBlock: t.bigint(),
  fulfilledLogIndex: t.integer(),
  fulfilledTx: t.hex(),
}), (t) => ({
  byAccountRequested: index().on(t.account, t.requestedAt),
  byReceiverRequested: index().on(t.receiver, t.requestedAt),
  byVaultStatus: index().on(t.vault, t.status, t.requestedAt),
  byStatusRequested: index().on(t.status, t.requestedAt),
}));

/** One completed withdrawal: shares burned, assets paid out. */
export const v2EarnVaultWithdrawal = onchainTable("v2_earn_vault_withdrawal", (t) => ({
  id: t.text().primaryKey(),
  vault: t.hex().notNull(),
  account: t.hex().notNull(),
  asset: t.hex().notNull(),
  assets: t.bigint().notNull(),
  shares: t.bigint().notNull(),
  /**
   * The v2EarnVaultWithdrawalQueue row this settles. NULL MEANS SERVED IMMEDIATELY AND NEVER
   * QUEUED — it does not mean queue entry zero, and it is not an unknown.
   */
  queueId: t.text(),
  ts: t.bigint().notNull(),
  block: t.bigint().notNull(),
  logIndex: t.integer().notNull(),
  tx: t.hex().notNull(),
}), (t) => ({
  byAccountTime: index().on(t.account, t.ts),
  byVaultTime: index().on(t.vault, t.ts),
  byQueue: index().on(t.queueId),
}));

/**
 * One queued withdrawal request, from the moment the venue was too illiquid to serve it. P8-02's
 * rule is "disclose, do not hide": the request exists as a row the instant it queues, and its
 * fulfilment is a separate, later observation.
 *
 * `status` is one of `queued` | `fulfilled` | `cancelled`, as plain text on the precedent of
 * v2TreasuryExit.eventKind above.
 */
export const v2EarnVaultWithdrawalQueue = onchainTable("v2_earn_vault_withdrawal_queue", (t) => ({
  id: t.text().primaryKey(),
  vault: t.hex().notNull(),
  account: t.hex().notNull(),
  asset: t.hex().notNull(),
  status: t.text().notNull(),
  /** Shares escrowed by the request. */
  sharesQueued: t.bigint().notNull(),
  /**
   * Assets the request asked for, when the request names an amount rather than only shares.
   * Null means the request did not quote one, not that it asked for nothing.
   */
  assetsRequested: t.bigint(),
  requestedAt: t.bigint().notNull(),
  requestedBlock: t.bigint().notNull(),
  requestedLogIndex: t.integer().notNull(),
  requestedTx: t.hex().notNull(),
  /**
   * What the request actually paid out. NULL MEANS STILL QUEUED OR CANCELLED — NOT A ZERO PAYOUT.
   * A fulfilment that legitimately delivered nothing is 0. This is the same distinction
   * v2FundingAttempt.delivered draws, and the reason this column has no default.
   */
  fulfilledAssets: t.bigint(),
  /** All null while the request is open; set together when it is fulfilled or cancelled. */
  fulfilledAt: t.bigint(),
  fulfilledBlock: t.bigint(),
  fulfilledLogIndex: t.integer(),
  fulfilledTx: t.hex(),
}), (t) => ({
  byAccountRequested: index().on(t.account, t.requestedAt),
  byVaultStatus: index().on(t.vault, t.status, t.requestedAt),
  byStatusRequested: index().on(t.status, t.requestedAt),
}));

/**
 * One observed yield skim out of the vault. THIS IS THE WHOLE OF WHAT THIS TASK STORES ABOUT
 * YIELD: an amount in base units and the block it happened in. No rate is derived here, and none
 * may be derived into a stored column later — a consumer that wants a period figure sums these
 * rows between two timestamps it chose itself.
 */
export const v2EarnVaultSkim = onchainTable("v2_earn_vault_skim", (t) => ({
  id: t.text().primaryKey(),
  vault: t.hex().notNull(),
  asset: t.hex().notNull(),
  /** Skimmed amount in the asset's base units. */
  amount: t.bigint().notNull(),
  /**
   * Where the skim went. Null means the log did not name a destination — it is NOT an assertion
   * that the FeeSplitter received it. The splitter's own receipt is indexed on its side.
   */
  recipient: t.hex(),
  ts: t.bigint().notNull(),
  block: t.bigint().notNull(),
  logIndex: t.integer().notNull(),
  tx: t.hex().notNull(),
}), (t) => ({
  byVaultTime: index().on(t.vault, t.ts),
  byAssetTime: index().on(t.asset, t.ts),
}));

/**
 * One move between the vault and its venue adapter. `direction` is `pull` (adapter -> vault, what
 * `fund` does under the OrderBook's FUNDING_GAS) or `push` (vault -> adapter, idle funds going to
 * work), as plain text.
 *
 * This is the vault's own view. The OrderBook's view of the same funding call is already in
 * v2FundingAttempt and is neither duplicated nor modified by this table.
 */
export const v2EarnVaultAdapterMove = onchainTable("v2_earn_vault_adapter_move", (t) => ({
  id: t.text().primaryKey(),
  vault: t.hex().notNull(),
  /** The adapter at the time of the move. Null if the log does not carry it. */
  adapter: t.hex(),
  asset: t.hex().notNull(),
  direction: t.text().notNull(),
  requested: t.bigint().notNull(),
  /**
   * What the venue actually moved. NULL MEANS THE MOVE FAILED OR WAS NOT REPORTED, NOT THAT ZERO
   * MOVED. A partial fill against a ~90%-utilised venue is a real number and belongs here; a
   * reverted pull is null. Exactly v2FundingAttempt.delivered's distinction.
   */
  delivered: t.bigint(),
  succeeded: t.boolean().notNull(),
  ts: t.bigint().notNull(),
  block: t.bigint().notNull(),
  logIndex: t.integer().notNull(),
  tx: t.hex().notNull(),
}), (t) => ({
  byVaultTime: index().on(t.vault, t.ts),
  byAssetTime: index().on(t.asset, t.ts),
  byAdapterTime: index().on(t.adapter, t.ts),
}));

/**
 * One StockZap action. `kind` is `write` (USDG -> Stock Token credited to the Clearinghouse
 * ledger) or `exit` (wallet Stock Token -> USDG), as plain text.
 *
 * Column set mirrored from callhouse-contracts src/v2/interfaces/IStockZap.sol (worktree
 * wt/v8-contracts at b2bf1dbc), whose two events are
 *   WriteZapped(address indexed account, address indexed asset, address caller, uint256 usdgIn,
 *               uint256 assetOut, uint8 venue)
 *   ExitZapped (address indexed account, address indexed asset, address caller, uint256 assetIn,
 *               uint256 usdgOut, uint8 venue)
 * and whose topic0s are pinned in v8-plan/status/INTERFACE-CHANGES-V8.md Entry 4. `amountIn` and
 * `amountOut` hold the pair in whichever direction the kind names; `caller` is kept separate from
 * `account` because a zap may be executed for someone else.
 */
export const v2ZapAction = onchainTable("v2_zap_action", (t) => ({
  id: t.text().primaryKey(),
  zap: t.hex().notNull(),
  kind: t.text().notNull(),
  account: t.hex().notNull(),
  asset: t.hex().notNull(),
  caller: t.hex().notNull(),
  amountIn: t.bigint().notNull(),
  amountOut: t.bigint().notNull(),
  /** The routed venue as the contract reports it (uint8). Stored as observed, never relabelled. */
  venue: t.integer().notNull(),
  ts: t.bigint().notNull(),
  block: t.bigint().notNull(),
  logIndex: t.integer().notNull(),
  tx: t.hex().notNull(),
}), (t) => ({
  byAccountTime: index().on(t.account, t.ts),
  byAssetTime: index().on(t.asset, t.ts),
  byKindTime: index().on(t.kind, t.ts),
}));

/*//////////////////////////////////////////////////////////////
                  P8-06 HOUSE VAULT — USER-FUNDED MM
//////////////////////////////////////////////////////////////*/

/**
 * House vault tape (P8-06 / X8-07 ingest). Separate source from MakerVault: HouseVault
 * composes the same quoting surface but depositor withdrawals must NEVER land in
 * v2TreasuryExit (src/v2/treasury.ts files MakerVault:Withdrawn as source "makerVault").
 *
 * NAV IS A BOUNDARY FACT. Only HouseVault:EpochRolled writes v2HouseNav. A Transfer, a
 * queued deposit, or a clock block does not. Intra-epoch NAV is null on this table because
 * there is no row — the API's running-epoch `nav: null` (indexer/src/api/v2/schema.ts
 * houseNavSchema) is that absence, not a stored 0.
 *
 * Unavailable is not zero: usdg / stockUnits on a NAV row are null when EpochRolled does
 * not name them (the event is price, nav, supply, sharesMinted, sharesBurned,
 * performanceFee — HouseVault.sol:231-240). 0 would mean an observed empty book.
 *
 * Event signatures are mirrored from callhouse-contracts src/v2/periphery/house/HouseVault.sol
 * and HouseVaultFactory.sol (wt/v8-contracts). Topic strings are pinned in
 * test/v2/unit/HouseVaultInterface.t.sol. PERFORMANCE_FEE_CEIL_BPS and MIN_SHARES live on
 * the contract as constants (HouseVault.sol:147-150); they are not retyped into a column.
 */
export const v2HouseVault = onchainTable("v2_house_vault", (t) => ({
  vault: t.hex().primaryKey(),
  /** Stock Token this instance makes a market in. From VaultCreated.underlying. */
  underlying: t.hex().notNull(),
  /** The vault IS the ERC-20 share token. */
  sharesToken: t.hex().notNull(),
  factory: t.hex().notNull(),
  name: t.text().notNull(),
  symbol: t.text().notNull(),
  createdAt: t.bigint().notNull(),
  createdBlock: t.bigint().notNull(),
  createdLogIndex: t.integer().notNull(),
  createdTx: t.hex().notNull(),
  /** Null until a Transfer is observed; 0 is an observed empty supply. */
  sharesSupply: t.bigint(),
  /** Null until QuotingPausedSet; false is observed running. */
  quotingPaused: t.boolean(),
  /** Null until PerformanceFeeBpsSet; 0 is observed zero fee. */
  performanceFeeBps: t.integer(),
  currentEpochId: t.bigint(),
  currentEpochEnd: t.bigint(),
}), (t) => ({
  byUnderlying: index().on(t.underlying),
  byFactory: index().on(t.factory),
}));

/** One weekly epoch of one vault. `${vault}-${epochId}`. */
export const v2HouseEpoch = onchainTable("v2_house_epoch", (t) => ({
  id: t.text().primaryKey(),
  vault: t.hex().notNull(),
  epochId: t.bigint().notNull(),
  /** Unix seconds. Null until observed (first epoch start is VaultCreated.ts). */
  start: t.bigint(),
  /** Unix seconds. Null until epochEnd is observed (VaultCreated eth_call or EpochRolled). */
  end: t.bigint(),
  /** `running` | `rolled`. */
  status: t.text().notNull(),
  rolledAt: t.bigint(),
  rolledBlock: t.bigint(),
  rolledLogIndex: t.integer(),
  rolledTx: t.hex(),
  /**
   * Signed NAV-delta for a closed epoch. NULL WHILE RUNNING AND NULL AFTER ROLL unless a
   * future event names it — EpochRolled does not. Never stored as 0 to mean "unknown".
   */
  resultUsdg: t.bigint(),
}), (t) => ({
  byVaultEpoch: index().on(t.vault, t.epochId),
  byVaultStatus: index().on(t.vault, t.status),
}));

/**
 * One boundary NAV. ONE ROW PER EPOCH ROLLED, never per block. Source event is always
 * EpochRolled. usdg and stockUnits are null: the log does not name the legs.
 */
export const v2HouseNav = onchainTable("v2_house_nav", (t) => ({
  id: t.text().primaryKey(),
  vault: t.hex().notNull(),
  epochId: t.bigint().notNull(),
  at: t.bigint().notNull(),
  /** Null: EpochRolled does not name the USDG leg. Not zero. */
  usdg: t.bigint(),
  /** Null: EpochRolled does not name the Stock-Token leg. Not zero. */
  stockUnits: t.bigint(),
  /** Settlement price from EpochRolled.price, USDG 6 dp per whole share. */
  settlementPrice: t.bigint().notNull(),
  /** EpochRolled.nav, USDG base units. */
  navUsdg: t.bigint().notNull(),
  sourceEvent: t.text().notNull(),
  supply: t.bigint().notNull(),
  sharesMinted: t.bigint().notNull(),
  sharesBurned: t.bigint().notNull(),
  performanceFee: t.bigint().notNull(),
  ts: t.bigint().notNull(),
  block: t.bigint().notNull(),
  logIndex: t.integer().notNull(),
  tx: t.hex().notNull(),
}), (t) => ({
  byVaultEpoch: index().on(t.vault, t.epochId),
  byVaultTime: index().on(t.vault, t.ts),
}));

/** Current share holding. `${vault}-${account}`. Null supply on the vault is "never observed". */
export const v2HouseShareBalance = onchainTable("v2_house_share_balance", (t) => ({
  id: t.text().primaryKey(),
  vault: t.hex().notNull(),
  account: t.hex().notNull(),
  shares: t.bigint().notNull(),
  updatedAt: t.bigint().notNull(),
  updatedBlock: t.bigint().notNull(),
  updatedLogIndex: t.integer().notNull(),
  updatedTx: t.hex().notNull(),
}), (t) => ({
  byVault: index().on(t.vault),
  byAccount: index().on(t.account),
}));

/**
 * Current deposit request per (vault, account). Status `queued` | `cancelled` | `settled` | `claimed`.
 * Amounts are from DepositRequested; a cancel writes the cancelled amounts from that log.
 */
export const v2HouseDepositQueue = onchainTable("v2_house_deposit_queue", (t) => ({
  id: t.text().primaryKey(),
  vault: t.hex().notNull(),
  account: t.hex().notNull(),
  epochId: t.bigint().notNull(),
  usdgAmount: t.bigint().notNull(),
  stockAmount: t.bigint().notNull(),
  status: t.text().notNull(),
  requestedAt: t.bigint().notNull(),
  requestedBlock: t.bigint().notNull(),
  requestedLogIndex: t.integer().notNull(),
  requestedTx: t.hex().notNull(),
  closedAt: t.bigint(),
  closedBlock: t.bigint(),
  closedLogIndex: t.integer(),
  closedTx: t.hex(),
}), (t) => ({
  byVaultStatus: index().on(t.vault, t.status, t.requestedAt),
  byAccount: index().on(t.account, t.requestedAt),
  byVaultEpoch: index().on(t.vault, t.epochId),
}));

/** Current withdraw request per (vault, account). Same status vocabulary as deposits. */
export const v2HouseWithdrawQueue = onchainTable("v2_house_withdraw_queue", (t) => ({
  id: t.text().primaryKey(),
  vault: t.hex().notNull(),
  account: t.hex().notNull(),
  epochId: t.bigint().notNull(),
  shares: t.bigint().notNull(),
  status: t.text().notNull(),
  requestedAt: t.bigint().notNull(),
  requestedBlock: t.bigint().notNull(),
  requestedLogIndex: t.integer().notNull(),
  requestedTx: t.hex().notNull(),
  closedAt: t.bigint(),
  closedBlock: t.bigint(),
  closedLogIndex: t.integer(),
  closedTx: t.hex(),
}), (t) => ({
  byVaultStatus: index().on(t.vault, t.status, t.requestedAt),
  byAccount: index().on(t.account, t.requestedAt),
  byVaultEpoch: index().on(t.vault, t.epochId),
}));

/** Batch queue processing at the boundary. One row per EpochRolled. */
export const v2HouseQueueSettlement = onchainTable("v2_house_queue_settlement", (t) => ({
  id: t.text().primaryKey(),
  vault: t.hex().notNull(),
  epochId: t.bigint().notNull(),
  sharesMinted: t.bigint().notNull(),
  sharesBurned: t.bigint().notNull(),
  performanceFee: t.bigint().notNull(),
  ts: t.bigint().notNull(),
  block: t.bigint().notNull(),
  logIndex: t.integer().notNull(),
  tx: t.hex().notNull(),
}), (t) => ({
  byVaultEpoch: index().on(t.vault, t.epochId),
}));

/** In-kind payout (and/or shares from a priced deposit) from Claimed. */
export const v2HouseClaim = onchainTable("v2_house_claim", (t) => ({
  id: t.text().primaryKey(),
  vault: t.hex().notNull(),
  account: t.hex().notNull(),
  shares: t.bigint().notNull(),
  usdgAmount: t.bigint().notNull(),
  stockAmount: t.bigint().notNull(),
  ts: t.bigint().notNull(),
  block: t.bigint().notNull(),
  logIndex: t.integer().notNull(),
  tx: t.hex().notNull(),
}), (t) => ({
  byVaultTime: index().on(t.vault, t.ts),
  byAccountTime: index().on(t.account, t.ts),
}));

/** Performance fee paid to the immutable splitter at the boundary. 0 is a real observation. */
export const v2HousePerformanceFee = onchainTable("v2_house_performance_fee", (t) => ({
  id: t.text().primaryKey(),
  vault: t.hex().notNull(),
  epochId: t.bigint().notNull(),
  amount: t.bigint().notNull(),
  ts: t.bigint().notNull(),
  block: t.bigint().notNull(),
  logIndex: t.integer().notNull(),
  tx: t.hex().notNull(),
}), (t) => ({
  byVaultEpoch: index().on(t.vault, t.epochId),
}));

/**
 * House-vault fills and rebates. OrderBook:OrderFilled already writes v2Fill; this table is
 * the vault-shaped projection (maker or taker is a v2HouseVault row). Populated by the
 * reducer tests and, when a fill is observed against a registered vault, by the ingest
 * helper — not by a second ponder.on("OrderBook:OrderFilled"), which would steal the
 * existing handler.
 */
export const v2HouseFill = onchainTable("v2_house_fill", (t) => ({
  id: t.text().primaryKey(),
  vault: t.hex().notNull(),
  side: t.text().notNull(),
  orderId: t.bigint().notNull(),
  longId: t.bigint().notNull(),
  maker: t.hex().notNull(),
  taker: t.hex().notNull(),
  units: t.bigint().notNull(),
  price: t.bigint().notNull(),
  premium: t.bigint().notNull(),
  sellerFee: t.bigint().notNull(),
  makerRebate: t.bigint().notNull(),
  ts: t.bigint().notNull(),
  block: t.bigint().notNull(),
  logIndex: t.integer().notNull(),
  tx: t.hex().notNull(),
}), (t) => ({
  byVaultTime: index().on(t.vault, t.ts),
  byLongId: index().on(t.longId),
}));

/**
 * Self-dealing refusal. HouseVault.take reverts V2Errors.NotAuthorized with NO LOG
 * (HouseVault.sol:794-799). This table exists so the name is landed for T-X8-07-API; ingest
 * never invents a row from Transfer or ProtocolAccountSet. Protocol counterparties are
 * v2HouseProtocolAccount.
 */
export const v2HouseSelfDealRefusal = onchainTable("v2_house_self_deal_refusal", (t) => ({
  id: t.text().primaryKey(),
  vault: t.hex().notNull(),
  counterparty: t.hex().notNull(),
  reason: t.text(),
  ts: t.bigint().notNull(),
  block: t.bigint().notNull(),
  logIndex: t.integer().notNull(),
  tx: t.hex().notNull(),
}), (t) => ({
  byVaultTime: index().on(t.vault, t.ts),
}));

export const v2HouseProtocolAccount = onchainTable("v2_house_protocol_account", (t) => ({
  id: t.text().primaryKey(),
  vault: t.hex().notNull(),
  account: t.hex().notNull(),
  blocked: t.boolean().notNull(),
  ts: t.bigint().notNull(),
  block: t.bigint().notNull(),
  logIndex: t.integer().notNull(),
  tx: t.hex().notNull(),
}), (t) => ({
  byVaultAccount: index().on(t.vault, t.account),
}));

export const v2HouseLimits = onchainTable("v2_house_limits", (t) => ({
  id: t.text().primaryKey(),
  vault: t.hex().notNull(),
  maxSeriesUnits: t.bigint().notNull(),
  maxTotalNotional: t.bigint().notNull(),
  askToleranceBps: t.integer().notNull(),
  maxBidBpsOfSpot: t.integer().notNull(),
  maxOrderLifetime: t.bigint().notNull(),
  maxDailyOutflow: t.bigint().notNull(),
  ts: t.bigint().notNull(),
  block: t.bigint().notNull(),
  logIndex: t.integer().notNull(),
  tx: t.hex().notNull(),
}), (t) => ({
  byVaultTime: index().on(t.vault, t.ts),
}));

export const v2HouseExposure = onchainTable("v2_house_exposure", (t) => ({
  id: t.text().primaryKey(),
  vault: t.hex().notNull(),
  longId: t.bigint().notNull(),
  units: t.bigint().notNull(),
  notional: t.bigint().notNull(),
  totalNotional: t.bigint().notNull(),
  ts: t.bigint().notNull(),
  block: t.bigint().notNull(),
  logIndex: t.integer().notNull(),
  tx: t.hex().notNull(),
}), (t) => ({
  byVaultLong: index().on(t.vault, t.longId),
  byVaultTime: index().on(t.vault, t.ts),
}));

/*//////////////////////////////////////////////////////////////
       T-295: STATE FACTS THAT HAD NOWHERE TO PERSIST
//////////////////////////////////////////////////////////////*/

/**
 * Which AccessManager actually governs each v8 contract, from `AuthorityUpdated`.
 *
 * Every restricted contract emits this on deployment and on any later re-pointing. Until now the
 * indexer read none of them, so the only statement anywhere about who governs a contract was the
 * deploy manifest — a document, not chain state. Read by the /trust page (W8-02a) and by
 * /v2/config's `accessManager`: a contract whose authority is NOT the deployed AccessManager is
 * the launch check this table exists to make answerable.
 */
export const v2ContractAuthority = onchainTable("v2_contract_authority", (t) => ({
  /** Lower-cased Ponder source name, e.g. "orderbook". One row per contract, not per address. */
  id: t.text().primaryKey(),
  source: t.text().notNull(),
  contract: t.hex().notNull(),
  authority: t.hex().notNull(),
  updatedAt: t.bigint().notNull(),
  updatedBlock: t.bigint().notNull(),
  updatedLogIndex: t.integer().notNull(),
  updatedTx: t.hex().notNull(),
}), (t) => ({ byAuthority: index().on(t.authority) }));

/**
 * Current value of one named pointer or parameter, from the `*Set` admin events.
 *
 * A setting is (source, key) — "FeeSplitter:burnBps", "Clearinghouse:calendar". The value lands in
 * exactly one of the four typed columns by its ABI type, so a consumer reads a typed value rather
 * than parsing text; `valueKind` says which column is live. Read by /v2/config (the fee and pointer
 * block the notifier's fee_notice compares against) and by the /trust page's parameter list.
 *
 * Current state only. The history is {@link v2ContractSettingChange}, and the two are written in
 * the same handler so a row here always has the change that produced it.
 */
export const v2ContractSetting = onchainTable("v2_contract_setting", (t) => ({
  /** `${source}:${key}`, e.g. "FeeSplitter:treasury". */
  id: t.text().primaryKey(),
  source: t.text().notNull(),
  key: t.text().notNull(),
  /** Which of the value columns carries this setting: "address" | "uint" | "bool" | "text". */
  valueKind: t.text().notNull(),
  valueAddress: t.hex(),
  valueUint: t.bigint(),
  valueBool: t.boolean(),
  valueText: t.text(),
  updatedAt: t.bigint().notNull(),
  updatedBlock: t.bigint().notNull(),
  updatedLogIndex: t.integer().notNull(),
  updatedTx: t.hex().notNull(),
}), (t) => ({ bySource: index().on(t.source) }));

/** Append-only history of {@link v2ContractSetting}. Read by the /trust page's change log. */
export const v2ContractSettingChange = onchainTable("v2_contract_setting_change", (t) => ({
  /** `${tx}-${logIndex}`. */
  id: t.text().primaryKey(),
  source: t.text().notNull(),
  key: t.text().notNull(),
  valueKind: t.text().notNull(),
  valueAddress: t.hex(),
  valueUint: t.bigint(),
  valueBool: t.boolean(),
  valueText: t.text(),
  ts: t.bigint().notNull(),
  block: t.bigint().notNull(),
  logIndex: t.integer().notNull(),
  tx: t.hex().notNull(),
}), (t) => ({ bySourceKeyTime: index().on(t.source, t.key, t.ts) }));

/**
 * USDG paid INTO a contract that pays keepers or lenders, from `Funded` on KeeperRewards and
 * RewardsDistributor. Distinct from EarnVault's `Funded`, which is a just-in-time draw against an
 * OrderBook fill and is already carried by the funding attempt tape.
 *
 * Read by the keeper-budget panel (how much has been put in, against v2_keeper_reward paid out) and
 * by the lender rewards page (an epoch root with nothing funded behind it is not claimable).
 */
export const v2ContractFunding = onchainTable("v2_contract_funding", (t) => ({
  /** `${tx}-${logIndex}`. */
  id: t.text().primaryKey(),
  source: t.text().notNull(),
  contract: t.hex().notNull(),
  from: t.hex().notNull(),
  amount: t.bigint().notNull(),
  ts: t.bigint().notNull(),
  block: t.bigint().notNull(),
  logIndex: t.integer().notNull(),
  tx: t.hex().notNull(),
}), (t) => ({ bySourceTime: index().on(t.source, t.ts) }));

/**
 * One rewards epoch as published on chain, from `RootSet`.
 *
 * The Merkle root and the epoch total are what a claim is checked against, so the claim UI cannot
 * show a claimable amount without them (P8-05 / T-113). Off-chain epoch generation produces the
 * same numbers; this row is the chain's copy, and a disagreement between them is the thing worth
 * seeing.
 */
export const v2RewardsEpoch = onchainTable("v2_rewards_epoch", (t) => ({
  /** `${distributor}-${epoch}`: epoch ids are local to one distributor instance. */
  id: t.text().primaryKey(),
  distributor: t.hex().notNull(),
  epoch: t.bigint().notNull(),
  root: t.hex().notNull(),
  total: t.bigint().notNull(),
  setAt: t.bigint().notNull(),
  setBlock: t.bigint().notNull(),
  setLogIndex: t.integer().notNull(),
  setTx: t.hex().notNull(),
}), (t) => ({ byDistributorEpoch: index().on(t.distributor, t.epoch), byEpoch: index().on(t.epoch) }));

/** One rewards claim, from `Claimed`. Read by the claim API to mark a leaf already spent. */
export const v2RewardsClaim = onchainTable("v2_rewards_claim", (t) => ({
  /** `${distributor}-${epoch}-${index}`: a leaf is claim-once inside one distributor instance. */
  id: t.text().primaryKey(),
  distributor: t.hex().notNull(),
  epoch: t.bigint().notNull(),
  leafIndex: t.bigint().notNull(),
  account: t.hex().notNull(),
  amount: t.bigint().notNull(),
  ts: t.bigint().notNull(),
  block: t.bigint().notNull(),
  logIndex: t.integer().notNull(),
  tx: t.hex().notNull(),
}), (t) => ({
  byAccount: index().on(t.account),
  byDistributorEpoch: index().on(t.distributor, t.epoch),
  byEpoch: index().on(t.epoch),
}));

/**
 * Capital paid into the treasury MakerVault, from `Deposited`. The withdrawal side already exists as
 * v2TreasuryExit (source "makerVault"); without this row the vault's balance could only ever be seen
 * going down. Read by the treasury panel's funded-versus-withdrawn line.
 */
export const v2MakerVaultDeposit = onchainTable("v2_maker_vault_deposit", (t) => ({
  /** `${tx}-${logIndex}`. */
  id: t.text().primaryKey(),
  asset: t.hex().notNull(),
  from: t.hex().notNull(),
  amount: t.bigint().notNull(),
  ts: t.bigint().notNull(),
  block: t.bigint().notNull(),
  logIndex: t.integer().notNull(),
  tx: t.hex().notNull(),
}), (t) => ({ byAssetTime: index().on(t.asset, t.ts) }));

/**
 * The treasury MakerVault's exposure to one series, from `ExposureSet` — the same fact the House
 * vault carries in v2HouseExposure, which the MakerVault had no table for. `totalNotional` is the
 * vault-wide figure the limits are judged against, so it is stored beside the per-series number
 * rather than recomputed. Read by the treasury risk panel and by the limits check below it.
 */
export const v2MakerVaultExposure = onchainTable("v2_maker_vault_exposure", (t) => ({
  /** The series long ID. Current exposure, one row per series. */
  longId: t.bigint().primaryKey(),
  units: t.bigint().notNull(),
  notional: t.bigint().notNull(),
  totalNotional: t.bigint().notNull(),
  updatedAt: t.bigint().notNull(),
  updatedBlock: t.bigint().notNull(),
  updatedLogIndex: t.integer().notNull(),
  updatedTx: t.hex().notNull(),
}));

/**
 * The treasury MakerVault's current limits, from `LimitsSet`. A tuple, so it gets columns rather
 * than a setting row: the risk panel reads the fields individually and the MM bot's own limits are
 * only meaningful next to these. Mirrors v2HouseLimits for the House vault.
 */
export const v2MakerVaultLimits = onchainTable("v2_maker_vault_limits", (t) => ({
  /** Single row, keyed by the vault address. */
  vault: t.hex().primaryKey(),
  maxSeriesUnits: t.bigint().notNull(),
  maxTotalNotional: t.bigint().notNull(),
  askToleranceBps: t.integer().notNull(),
  maxBidBpsOfSpot: t.integer().notNull(),
  maxOrderLifetime: t.bigint().notNull(),
  maxDailyOutflow: t.bigint().notNull(),
  updatedAt: t.bigint().notNull(),
  updatedBlock: t.bigint().notNull(),
  updatedLogIndex: t.integer().notNull(),
  updatedTx: t.hex().notNull(),
}));

/**
 * A withdrawal of an owed balance from the OrderBook, from `OwedClaimed`.
 *
 * The book credits `owed` when a transfer to a maker fails, and the maker claims it later. The
 * credit side is already indexed; the claim was not, so an owed balance appeared permanent. Read by
 * the account page's owed line, which must go to zero after a claim.
 */
export const v2OwedClaim = onchainTable("v2_owed_claim", (t) => ({
  /** `${tx}-${logIndex}`. */
  id: t.text().primaryKey(),
  account: t.hex().notNull(),
  amount: t.bigint().notNull(),
  ts: t.bigint().notNull(),
  block: t.bigint().notNull(),
  logIndex: t.integer().notNull(),
  tx: t.hex().notNull(),
}), (t) => ({ byAccountTime: index().on(t.account, t.ts) }));

/**
 * A market's settlement-oracle configuration, from `MarketConfigured`: the source list in priority
 * order and the three parameters the fallback chain is judged by. Read by /v2/markets' settlement
 * metadata (X3-101) and by the /trust page; a market whose sources changed between two expiries is
 * only visible here.
 */
export const v2OracleMarketConfig = onchainTable("v2_oracle_market_config", (t) => ({
  /** The 18-dp Stock Token. */
  underlying: t.hex().primaryKey(),
  /** Priority order, as emitted. Lower-cased addresses. */
  sources: t.text().array().notNull(),
  maxDeviationBps: t.integer().notNull(),
  uncorroboratedDelayS: t.bigint().notNull(),
  spotMaxAgeS: t.bigint().notNull(),
  updatedAt: t.bigint().notNull(),
  updatedBlock: t.bigint().notNull(),
  updatedLogIndex: t.integer().notNull(),
  updatedTx: t.hex().notNull(),
}));

/**
 * The configuration PINNED to one expiry, from `SettlementConfigPinned`. This is the copy a
 * settlement is actually judged by — a later `MarketConfigured` never moves it — so a settlement
 * dispute is answered by this row and not by the market's current configuration. `spotMaxAge` is
 * absent from the event on purpose: the pin does not carry it.
 */
export const v2OracleExpiryConfig = onchainTable("v2_oracle_expiry_config", (t) => ({
  /** `${underlying}-${expiry}`. */
  id: t.text().primaryKey(),
  underlying: t.hex().notNull(),
  expiry: t.bigint().notNull(),
  sources: t.text().array().notNull(),
  maxDeviationBps: t.integer().notNull(),
  uncorroboratedDelayS: t.bigint().notNull(),
  pinnedAt: t.bigint().notNull(),
  pinnedBlock: t.bigint().notNull(),
  pinnedLogIndex: t.integer().notNull(),
  pinnedTx: t.hex().notNull(),
}), (t) => ({ byUnderlying: index().on(t.underlying) }));

/**
 * Which contracts KeeperRewards will pay a bounty on behalf of, from `CallerSet`. Not a scalar
 * setting: it is an allow-list, and the fact worth seeing is the SET of contracts that can spend the
 * keeper budget. Read by the /trust page and by the keeper-budget panel, where a caller nobody
 * expects is the finding.
 */
export const v2KeeperCaller = onchainTable("v2_keeper_caller", (t) => ({
  caller: t.hex().primaryKey(),
  registered: t.boolean().notNull(),
  changedAt: t.bigint().notNull(),
  changedBlock: t.bigint().notNull(),
  changedLogIndex: t.integer().notNull(),
  changedTx: t.hex().notNull(),
}));
