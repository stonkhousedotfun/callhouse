/**
 * The indexer API v2 wire contract as zod schemas: one strict schema
 * per `/v2/*` route response, plus the shared objects every route is built from.
 *
 * TWIN FILE. The indexer validates real responses against this schema before sending them,
 * so producer and consumer are held to the same bytes. Keep both copies IDENTICAL and change
 * them together with their tests when the wire shape changes.
 *
 * Why strict. Every object is `.strict()`: an unknown key fails the parse. A tolerant schema would
 * let the indexer grow a field the dapp never reads, or rename one and keep sending the old name
 * alongside it, and nothing would notice until a page rendered a stale figure. v1 shipped exactly
 * that bug (the dapp read flat keys the indexer never sent). A deliberate shape change is a diff
 * here, visible in review; an accidental one is a red test.
 *
 * Wire conventions pinned below (carried over from v1, see ops/fixtures/api/README.md):
 * - Money is `{ raw, decimals, formatted }`. `raw` is the base-unit integer as a canonical decimal
 *   string (no sign, no leading zeros); `formatted` is `formatUnits(raw, decimals)` and is for
 *   display only. USDG is 6 dp; Stock Tokens (and therefore every in-kind call payout and call
 *   collateral figure) are 18 dp. Two figures can go negative (unrealised and realised PnL):
 *   they use SignedMoney, which allows a leading `-`.
 * - Every price is USDG base units per WHOLE share (ADR-04). Every `units` is 0.01-share units,
 *   a decimal string.
 * - uint256 ids (longId, shortId, orderId, tokenId) and block numbers are decimal strings; a
 *   uint256 does not survive `Number`, and v1 already sends blocks as strings.
 * - Timestamps are unix SECONDS as non-negative integers (not ISO strings, unlike v1).
 * - Addresses are EIP-55 checksummed; tx hashes are lowercase 0x + 64 hex.
 * - Lists return `{ items, nextCursor }`. `nextCursor` is present on every `items` response, null
 *   on the last page (§4's table omits it on some rows; the list convention above the table
 *   wins). `/v2/markets` is the one bare array, exactly as §4 shows it: the market set is small
 *   and never paged.
 * - Errors are `{ error: { code, message } }`.
 *
 * Where §4 names a route but not its shape (/v2/config, /v2/accounts/:address/history,
 * /v2/makers, the leaderboard `value`, the fair-value fallback) the shape below is the decision;
 * ops/fixtures/api/v2/README.md lists each one and why. web/lib/v2/api-types.ts carries the same
 * shapes as hand-written TypeScript with a compile-time equality check per type, so the types a
 * page imports cannot drift from what this file accepts.
 */
import { checksumAddress } from "viem";
import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------------------------

const UINT_RE = /^(0|[1-9]\d*)$/;
const INT_RE = /^(0|-?[1-9]\d*)$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_RE = /^0x[0-9a-f]{64}$/;

/** A non-negative base-unit integer as a canonical decimal string. */
export const uintStringSchema = z.string().regex(UINT_RE, "expected a canonical decimal uint string");

/** A signed base-unit integer as a canonical decimal string ("-0" is not canonical). */
export const intStringSchema = z.string().regex(INT_RE, "expected a canonical decimal int string");

/**
 * An EIP-55 checksummed address. The regex runs inside the refinement (not before it) because a
 * zod 3 regex failure does not stop a later refinement, and a checksum of a non-address is
 * meaningless.
 */
export const addressSchema = z
  .string()
  .refine((a) => ADDRESS_RE.test(a) && checksumAddress(a as `0x${string}`) === a, {
    message: "expected an EIP-55 checksummed address",
  });

export const txHashSchema = z.string().regex(TX_RE, "expected a lowercase 0x-prefixed 32-byte hash");

/** Unix seconds. */
export const unixSchema = z.number().int().nonnegative();

/** Basis points and other small non-negative integers. */
const countSchema = z.number().int().nonnegative();

const finiteSchema = z.number().finite();

// ---------------------------------------------------------------------------------------------
// Shared objects (§4 "Shared objects")
// ---------------------------------------------------------------------------------------------

export const moneySchema = z
  .object({ raw: uintStringSchema, decimals: countSchema, formatted: z.string() })
  .strict();

/** Money that may be negative: unrealised and realised PnL only. */
export const signedMoneySchema = z
  .object({ raw: intStringSchema, decimals: countSchema, formatted: z.string() })
  .strict();

/**
 * status: open (now < mintCutoff) · cutoff (mintCutoff ≤ now < expiry) · expired (past expiry, no
 * candidate yet, or final but `settle` not yet called) · settling (an uncorroborated candidate is
 * waiting out its delay) · held (vetoed) · settled (the series stored its payouts).
 */
export const seriesStatusSchema = z.enum(["open", "cutoff", "expired", "settling", "held", "settled"]);

export const seriesRefSchema = z
  .object({
    longId: uintStringSchema,
    shortId: uintStringSchema,
    ticker: z.string().min(1),
    underlying: addressSchema,
    isPut: z.boolean(),
    strike: moneySchema,
    expiry: unixSchema,
    tenor: z.enum(["daily", "weekly", "special"]),
    mintCutoff: unixSchema,
    mintFeePpm: countSchema.max(5_000),
    mintFeesHeld: moneySchema,
    mintFeesAccrued: moneySchema,
    status: seriesStatusSchema,
  })
  .strict();

/** Top of book plus the pricing service's view. `bidUnits`/`askUnits` are the units resting at the best price. */
export const quoteSchema = z
  .object({
    bestBid: moneySchema.nullable(),
    bestAsk: moneySchema.nullable(),
    bidUnits: uintStringSchema,
    askUnits: uintStringSchema,
    fair: moneySchema.nullable(),
    iv: finiteSchema.nonnegative().nullable(),
    delta: finiteSchema.min(-1).max(1).nullable(),
    last: moneySchema.nullable(),
  })
  .strict();

/** A ticket's cost (USDG, taker fee included), its net payout at the card target and payout/cost rounded down to 2 dp. */
const cardTicketSchema = z
  .object({ cost: moneySchema, payoutAtTarget: moneySchema, multiple: finiteSchema.nonnegative() })
  .strict();

/**
 * A payoff card (ADR-12). `ask` is the best ask per whole share; `target` is the deterministic
 * scenario price: call `roundUp(strike × (1 + cardTargetBps/1e4), strikeTick)`, put
 * `roundDown(strike × (1 − cardTargetBps/1e4), strikeTick)` and never below one strikeTick.
 * `perUnit` is one 0.01-share unit at the best ask with its own taker fee added to the cost and
 * the exercise fee netted from the payout. `perShare` is a one-share (100-unit) ticket that walks
 * the whole ask side cheapest first, in take order: Σ premium over exactly 100 units plus ONE
 * taker fee on that total, payout = 100 × the per-unit net payout at the target; null when the
 * book cannot fill 100 ask units. `unitsAvailable` is the largest fully executable ticket
 * after shared writer collateral and per-fill rent. `orderIds` are the 100-unit ticket when
 * available, otherwise the full-depth ticket; `perUnit.cost` describes only the one-unit ticket.
 */
export const cardSchema = z
  .object({
    series: seriesRefSchema,
    spot: moneySchema.nullable(),
    ask: moneySchema,
    target: moneySchema,
    perUnit: cardTicketSchema,
    perShare: cardTicketSchema.nullable(),
    maxLoss: z.literal("cost"),
    unitsAvailable: uintStringSchema,
    orderIds: z.array(uintStringSchema),
  })
  .strict();

export const orderKindSchema = z.enum(["Bid", "AskResale", "AskWrite"]);

export const bookOrderSchema = z
  .object({
    orderId: uintStringSchema,
    maker: addressSchema,
    units: uintStringSchema, // individually fillable at the indexed snapshot
    onChainRemainingUnits: uintStringSchema,
    makerFreeCollateral: moneySchema.nullable(),
    makerFreeUnits: uintStringSchema.nullable(), // AskWrite only; budget shared across one maker's asks
    kind: orderKindSchema,
    validUntil: unixSchema,
  })
  .strict();

export const levelSchema = z
  .object({ price: moneySchema, units: uintStringSchema, orders: z.array(bookOrderSchema) })
  .strict();

/** A profitable long exit through resale or settlement. id = `${longId}-${holder}`. */
export const winSchema = z
  .object({
    id: z.string().min(1),
    holder: addressSchema,
    ticker: z.string().min(1),
    series: seriesRefSchema,
    cost: moneySchema,
    payout: moneySchema,
    multiple: finiteSchema.nonnegative(),
    settledAt: unixSchema,
    tx: txHashSchema,
  })
  .strict();

export const errorSchema = z
  .object({ error: z.object({ code: z.string().min(1), message: z.string() }).strict() })
  .strict();

const nextCursorSchema = z.string().min(1).nullable();

// ---------------------------------------------------------------------------------------------
// /v2/health, /v2/config, /v2/markets
// ---------------------------------------------------------------------------------------------

export const healthResponseSchema = z
  .object({
    status: z.enum(["ok", "lagging", "degraded"]),
    block: uintStringSchema,
    lagSeconds: countSchema,
    interfaceVersion: countSchema,
  })
  .strict();

const maybeAddress = addressSchema.nullable();

/** Everything the dapp needs to boot. A contract that is not deployed yet is null. */
export const configResponseSchema = z
  .object({
    chainId: countSchema,
    interfaceVersion: countSchema,
    deployBlock: uintStringSchema.nullable(),
    usdg: z.object({ address: addressSchema, symbol: z.string().min(1), decimals: countSchema }).strict(),
    contracts: z
      .object({
        clearinghouse: maybeAddress,
        orderBook: maybeAddress,
        settlementOracle: maybeAddress,
        expiryCalendar: maybeAddress,
        keeperRewards: maybeAddress,
        autoRoller: maybeAddress,
        payoutAdapter: maybeAddress,
        makerVault: maybeAddress,
        makerRegistry: maybeAddress,
        rewardsDistributor: maybeAddress,
        sources: z.object({ chainlink: maybeAddress, univ3: maybeAddress, dataStreams: maybeAddress }).strict(),
      })
      .strict(),
    fees: z
      .object({
        premiumFeeBps: countSchema,
        resaleFeeBps: countSchema,
        takerFeeFlat: moneySchema,
        takerFeeCapBps: countSchema,
        makerRebateBps: countSchema,
        exerciseFeeBps: countSchema,
        mintFeePpm: countSchema.max(5_000),
      })
      .strict(),
    pendingFees: z.object({
      premiumFeeBps: countSchema,
      resaleFeeBps: countSchema,
      takerFeeFlat: moneySchema,
      takerFeeCapBps: countSchema,
      makerRebateBps: countSchema,
      effectiveAt: countSchema,
    }).strict().nullable(),
    constants: z
      .object({
        unit: uintStringSchema,
        unitsPerShare: countSchema,
        priceTick: countSchema,
        settlementWindow: countSchema,
        finalizeDelay: countSchema,
        snapshotGrace: countSchema,
        resolveDelay: countSchema,
        maxTenor: countSchema,
        minSeriesLead: countSchema,
        mintFeePeriod: countSchema,
        mintFeeCeilPpm: countSchema,
      })
      .strict(),
    ladder: z
      .object({
        weekly: z
          .object({ rungs: countSchema, firstOtmBps: countSchema, stepBps: countSchema, cardTargetBps: countSchema })
          .strict(),
        daily: z
          .object({ rungs: countSchema, firstOtmBps: countSchema, stepBps: countSchema, cardTargetBps: countSchema })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const marketSchema = z
  .object({
    ticker: z.string().min(1),
    name: z.string().min(1),
    underlying: addressSchema,
    status: z.enum(["planned", "live", "paused"]),
    // A failed live oracle read leaves only this market's spot unavailable.
    spot: moneySchema.nullable(),
    spotUpdatedAt: unixSchema.nullable(),
    strikeTick: moneySchema,
    puts: z.boolean(),
    mintFeePpm: countSchema.max(5_000),
    expiries: z.array(unixSchema),
    stats: z
      .object({
        volume24h: moneySchema,
        premium7d: moneySchema,
        openInterestUnits: uintStringSchema,
        seriesOpen: countSchema,
      })
      .strict(),
  })
  .strict()
  .refine((market) => (market.spot === null) === (market.spotUpdatedAt === null),
    { message: "spot and spotUpdatedAt must both be available or unavailable" });

export const marketsResponseSchema = z.array(marketSchema);

// ---------------------------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------------------------

export const marketSeriesResponseSchema = z
  .object({
    items: z.array(
      z
        .object({
          series: seriesRefSchema,
          quote: quoteSchema,
          openInterestUnits: uintStringSchema,
          volume24h: moneySchema,
        })
        .strict(),
    ),
    nextCursor: nextCursorSchema,
  })
  .strict();

export const settlementCandidateSchema = z
  .object({
    price: moneySchema,
    sourceIndex: countSchema,
    disagreed: z.boolean(),
    finalizableAt: unixSchema,
  })
  .strict();

/**
 * Null before expiry. `status` is the oracle's SettlementStatus name. The three per-unit payouts
 * are in the collateral asset (18 dp for calls, 6 dp for puts) and null until the series settled.
 * `finalizedAt` is the oracle verdict; `settledAt` is this series' later SeriesSettled event.
 */
export const settlementSchema = z
  .object({
    status: z.enum(["None", "Pending", "Finalized", "Held"]),
    price: moneySchema.nullable(),
    longPayoutPerUnit: moneySchema.nullable(),
    feePerUnit: moneySchema.nullable(),
    shortPayoutPerUnit: moneySchema.nullable(),
    finalizedAt: unixSchema.nullable(),
    settledAt: unixSchema.nullable(),
    sourceIndex: countSchema.nullable(),
    corroborated: z.boolean().nullable(),
    candidate: settlementCandidateSchema.nullable(),
  })
  .strict();

export const seriesDetailResponseSchema = z
  .object({
    series: seriesRefSchema,
    quote: quoteSchema,
    openInterestUnits: uintStringSchema,
    volume: moneySchema,
    settlement: settlementSchema.nullable(),
    exerciseFeeBps: countSchema,
  })
  .strict();

export const bookResponseSchema = z
  .object({ bids: z.array(levelSchema), asks: z.array(levelSchema), updatedBlock: uintStringSchema, snapshotTimestamp: unixSchema })
  .strict();

export const holdersResponseSchema = z
  .object({
    items: z.array(z.object({ holder: addressSchema, units: uintStringSchema }).strict()),
    nextCursor: nextCursorSchema,
  })
  .strict();

export const tradeSchema = z
  .object({
    id: z.string().min(1),
    ts: unixSchema,
    price: moneySchema,
    units: uintStringSchema,
    premium: moneySchema,
    takerIsBuyer: z.boolean(),
    primary: z.boolean(),
    taker: addressSchema,
    maker: addressSchema,
    tx: txHashSchema,
  })
  .strict();

export const tradesResponseSchema = z.object({ items: z.array(tradeSchema), nextCursor: nextCursorSchema }).strict();

// ---------------------------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------------------------

export const cardsResponseSchema = z
  .object({ items: z.array(cardSchema), generatedAt: unixSchema, nextCursor: nextCursorSchema })
  .strict();

/** `maxMultiple` is the card's own multiple, restated for "up to N×" copy; null with no card. */
export const heroCardResponseSchema = z
  .object({ card: cardSchema.nullable(), maxMultiple: finiteSchema.nonnegative().nullable() })
  .strict();

// ---------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------

/** V2Types.Strategy. `maxUnits` "0" = all free collateral. */
export const strategySchema = z
  .object({
    active: z.boolean(),
    weekly: z.boolean(),
    smartPricing: z.boolean(),
    otmBps: countSchema,
    askBps: countSchema,
    minAskBps: countSchema,
    maxAskBps: countSchema,
    maxUnits: uintStringSchema,
  })
  .strict();

export const positionsResponseSchema = z
  .object({
    longs: z.array(
      z
        .object({
          series: seriesRefSchema,
          units: uintStringSchema,
          avgCost: moneySchema, // USDG per whole share, taker fees included
          mark: moneySchema.nullable(), // fair value per whole share; null once expired
          unrealised: signedMoneySchema.nullable(), // USDG, (mark − avgCost) × units / 100
          claimable: moneySchema.nullable(), // collateral-asset amount `redeem` pays; null unless settled
        })
        .strict(),
    ),
    shorts: z.array(
      z
        .object({
          series: seriesRefSchema,
          units: uintStringSchema,
          premiumReceived: moneySchema, // USDG, net of premium fee; native collateral rent is separate
          collateralLocked: moneySchema, // collateral asset
          claimable: moneySchema.nullable(),
        })
        .strict(),
    ),
    orders: z.array(
      z
        .object({
          orderId: uintStringSchema,
          series: seriesRefSchema,
          kind: orderKindSchema,
          price: moneySchema,
          units: uintStringSchema, // original size
          filled: uintStringSchema,
          validUntil: unixSchema,
        })
        .strict(),
    ),
    ledger: z.array(z.object({ asset: addressSchema, symbol: z.string().min(1), free: moneySchema }).strict()),
    strategies: z.array(
      z
        .object({
          ticker: z.string().min(1),
          strategy: strategySchema,
          currentSeries: seriesRefSchema.nullable(),
          orderId: uintStringSchema.nullable(),
          lastRolledAt: unixSchema.nullable(),
          lastStaleCancelAt: unixSchema.nullable(),
          staleSpot: moneySchema.nullable(),
        })
        .strict(),
    ),
    prefs: z.object({ inKind: z.boolean(), toLedger: z.boolean() }).strict(),
  })
  .strict();

const historyFillSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("fill"),
    ts: unixSchema,
    longId: uintStringSchema,
    series: seriesRefSchema,
    data: z
      .object({
        orderId: uintStringSchema,
        side: z.enum(["buy", "sell"]),
        role: z.enum(["taker", "maker"]),
        counterparty: addressSchema,
        units: uintStringSchema,
        price: moneySchema,
        premium: moneySchema,
        fee: moneySchema, // what this account paid: taker fee as taker, seller fee as a selling maker
        rebate: moneySchema, // maker rebate received
        primary: z.boolean(),
        realisedPnl: signedMoneySchema.nullable(), // set when the fill sells longs out of a position
        tx: txHashSchema,
      })
      .strict(),
  })
  .strict();

const historyMintSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("mint"),
    ts: unixSchema,
    longId: uintStringSchema,
    series: seriesRefSchema,
    data: z.object({ units: uintStringSchema, collateral: moneySchema, fee: moneySchema, longTo: addressSchema, tx: txHashSchema }).strict(),
  })
  .strict();

const historyCloseSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("close"),
    ts: unixSchema,
    longId: uintStringSchema,
    series: seriesRefSchema,
    data: z
      .object({
        units: uintStringSchema,
        collateralFreed: moneySchema,
        feeRefund: moneySchema,
        realisedPnl: signedMoneySchema.nullable(),
        tx: txHashSchema,
      })
      .strict(),
  })
  .strict();

const historyRedemptionSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("redemption"),
    ts: unixSchema,
    longId: uintStringSchema,
    series: seriesRefSchema,
    data: z
      .object({
        side: z.enum(["long", "short"]),
        tokenId: uintStringSchema,
        units: uintStringSchema,
        asset: addressSchema, // what was delivered (USDG when converted)
        amount: moneySchema,
        amountInKind: moneySchema,
        toLedger: z.boolean(),
        realisedPnl: signedMoneySchema.nullable(), // long redemption: payout USDG value − FIFO cost; null for a short
        tx: txHashSchema,
      })
      .strict(),
  })
  .strict();

const historyDepositSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("deposit"),
    ts: unixSchema,
    longId: z.null(),
    series: z.null(),
    data: z
      .object({
        asset: addressSchema,
        symbol: z.string().min(1),
        amount: moneySchema,
        from: addressSchema,
        tx: txHashSchema,
      })
      .strict(),
  })
  .strict();

const historyWithdrawalSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("withdrawal"),
    ts: unixSchema,
    longId: z.null(),
    series: z.null(),
    data: z
      .object({ asset: addressSchema, symbol: z.string().min(1), amount: moneySchema, to: addressSchema, tx: txHashSchema })
      .strict(),
  })
  .strict();

export const historyItemSchema = z.discriminatedUnion("kind", [
  historyFillSchema,
  historyMintSchema,
  historyCloseSchema,
  historyRedemptionSchema,
  historyDepositSchema,
  historyWithdrawalSchema,
]);

export const historyResponseSchema = z
  .object({ items: z.array(historyItemSchema), nextCursor: nextCursorSchema })
  .strict();

// ---------------------------------------------------------------------------------------------
// Feeds, strategies, leaderboard, pnl, stats
// ---------------------------------------------------------------------------------------------

export const winsResponseSchema = z.object({ items: z.array(winSchema), nextCursor: nextCursorSchema }).strict();

const activityBase = {
  id: z.string().min(1),
  ts: unixSchema,
  longId: uintStringSchema,
  series: seriesRefSchema,
  accounts: z.array(addressSchema),
};

const activityFillSchema = z
  .object({
    ...activityBase,
    kind: z.literal("fill"),
    data: z
      .object({
        orderId: uintStringSchema,
        taker: addressSchema,
        maker: addressSchema,
        recipient: addressSchema,
        units: uintStringSchema,
        price: moneySchema,
        premium: moneySchema,
        takerFee: moneySchema,
        sellerFee: moneySchema,
        makerRebate: moneySchema,
        primary: z.boolean(),
        takerIsBuyer: z.boolean(),
        tx: txHashSchema,
      })
      .strict(),
  })
  .strict();

const activitySettlementSchema = z
  .object({
    ...activityBase,
    kind: z.literal("settlement"),
    data: z
      .object({
        price: moneySchema,
        longPayoutPerUnit: moneySchema,
        feePerUnit: moneySchema,
        shortPayoutPerUnit: moneySchema,
        tx: txHashSchema,
      })
      .strict(),
  })
  .strict();

const activityRedemptionSchema = z
  .object({
    ...activityBase,
    kind: z.literal("redemption"),
    data: z
      .object({
        holder: addressSchema,
        side: z.enum(["long", "short"]),
        tokenId: uintStringSchema,
        units: uintStringSchema,
        asset: addressSchema,
        amount: moneySchema,
        amountInKind: moneySchema,
        settlementPrice: moneySchema,
        toLedger: z.boolean(),
        tx: txHashSchema,
      })
      .strict(),
  })
  .strict();

const activityRollSchema = z
  .object({
    ...activityBase,
    kind: z.literal("roll"),
    data: z
      .object({ writer: addressSchema, orderId: uintStringSchema, price: moneySchema, units: uintStringSchema, tx: txHashSchema })
      .strict(),
  })
  .strict();

const activityStaleCancelSchema = z.object({
  ...activityBase,
  kind: z.literal("stale_cancel"),
  data: z.object({ writer: addressSchema, orderId: uintStringSchema, spot: moneySchema,
    spotUpdatedAt: unixSchema, nextRollAfter: unixSchema, tx: txHashSchema }).strict(),
}).strict();

export const activityItemSchema = z.discriminatedUnion("kind", [
  activityFillSchema,
  activitySettlementSchema,
  activityRedemptionSchema,
  activityRollSchema,
  activityStaleCancelSchema,
]);

export const activityResponseSchema = z
  .object({ items: z.array(activityItemSchema), nextCursor: nextCursorSchema })
  .strict();

/** dayIndex = floor(Unix seconds / 86400) for the New York date's 16:00 close. */
export const calendarHolidaysResponseSchema = z.object({
  items: z.array(z.object({
    dayIndex: countSchema,
    isHoliday: z.boolean(),
    isSessionDay: z.boolean(), // UTC weekday and not an ExpiryCalendar holiday
  }).strict()),
}).strict();

export const strategiesResponseSchema = z
  .object({
    items: z.array(
      z
        .object({
          writer: addressSchema,
          underlying: addressSchema,
          ticker: z.string().min(1),
          strategy: strategySchema,
          currentLongId: uintStringSchema.nullable(),
          orderId: uintStringSchema.nullable(),
          expiry: unixSchema.nullable(),
          lastRolledAt: unixSchema.nullable(),
          lastStaleCancelAt: unixSchema.nullable(),
          staleSpot: moneySchema.nullable(),
        })
        .strict(),
    ),
    nextCursor: nextCursorSchema,
  })
  .strict();

const leaderboardWindowSchema = z.enum(["week", "month", "all"]);

const leaderRow = <V extends z.ZodTypeAny>(value: V) =>
  z.object({ rank: countSchema, holder: addressSchema, value, wins: countSchema, losses: countSchema, best: winSchema }).strict();

/**
 * Discriminated on `metric` because the unit of `value` depends on it: an aggregate multiple
 * (number), absolute profit (signed USDG Money), or a win streak (integer).
 */
export const leaderboardResponseSchema = z.discriminatedUnion("metric", [
  z
    .object({
      metric: z.literal("multiple"),
      window: leaderboardWindowSchema,
      items: z.array(leaderRow(finiteSchema.nonnegative())),
      nextCursor: nextCursorSchema,
    })
    .strict(),
  z
    .object({
      metric: z.literal("absolute"),
      window: leaderboardWindowSchema,
      items: z.array(leaderRow(signedMoneySchema)),
      nextCursor: nextCursorSchema,
    })
    .strict(),
  z
    .object({
      metric: z.literal("streak"),
      window: leaderboardWindowSchema,
      items: z.array(leaderRow(countSchema)),
      nextCursor: nextCursorSchema,
    })
    .strict(),
]);

/** One Win plus what the PNL card prints. `entryPrice` is the average fill price per share, fees excluded. */
export const pnlResponseSchema = winSchema
  .extend({
    units: uintStringSchema,
    entryPrice: moneySchema,
    settlementPrice: moneySchema.nullable(),
    spotAtEntry: moneySchema.nullable(),
  })
  .strict();

export const statsResponseSchema = z
  .object({
    volume24h: moneySchema,
    volumeAll: moneySchema,
    premiumAll: moneySchema,
    feesAll: moneySchema,
    contractsFilled: uintStringSchema,
    holders: countSchema,
    biggestWinDay: winSchema.nullable(),
    biggestWinWeek: winSchema.nullable(),
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Makers, fair value
// ---------------------------------------------------------------------------------------------

export const makerEpochSchema = z.object({ id: countSchema, start: unixSchema, end: unixSchema }).strict();

const makerStatFields = {
  uptimePct: finiteSchema.min(0).max(100),
  avgSpreadBps: finiteSchema.nonnegative().nullable(), // null: never quoted both sides in the epoch
  depthWithin100bps: uintStringSchema, // units
  fills: countSchema,
  volume: moneySchema,
  rebates: moneySchema,
  score: finiteSchema.nonnegative(),
};

export const makersResponseSchema = z
  .object({
    epoch: makerEpochSchema,
    items: z.array(z.object({ maker: addressSchema, tierBps: countSchema, ...makerStatFields }).strict()),
    nextCursor: nextCursorSchema,
  })
  .strict();

/** Per-maker history, newest epoch first; `epochs[0]` is the running epoch. */
export const makerResponseSchema = z
  .object({
    maker: addressSchema,
    tierBps: countSchema,
    epochs: z.array(z.object({ epoch: makerEpochSchema, ...makerStatFields }).strict()),
  })
  .strict();

/**
 * Proxied from the pricing service (§5), which never throws on bad market data and answers
 * `{ fair: null, reason }` instead; the indexer passes that through rather than inventing a 5xx.
 */
export const fairResponseSchema = z.union([
  z
    .object({
      fair: moneySchema,
      iv: finiteSchema.nonnegative(),
      delta: finiteSchema.min(-1).max(1),
      source: z.enum(["cboe", "model"]),
      asOf: unixSchema,
    })
    .strict(),
  z.object({ fair: z.null(), reason: z.string().min(1) }).strict(),
]);

// ---------------------------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------------------------

export type RouteSpec = {
  /** Express-style path; `:param` segments match one path segment. */
  readonly route: string;
  readonly schema: z.ZodTypeAny;
  /** Cache-Control max-age in seconds. 0 = no-store. */
  readonly cache: 0 | 15;
};

/**
 * Every v2 route. The fixture test maps each file under ops/fixtures/api/v2 to exactly one entry
 * here and requires every entry to have at least one fixture; X2-04 validates live responses by
 * the same table. Query strings never change a response's shape, so they are not part of a route.
 */
export const ROUTES: readonly RouteSpec[] = [
  { route: "/v2/health", schema: healthResponseSchema, cache: 0 },
  { route: "/v2/config", schema: configResponseSchema, cache: 0 },
  { route: "/v2/markets", schema: marketsResponseSchema, cache: 15 },
  { route: "/v2/calendar/holidays", schema: calendarHolidaysResponseSchema, cache: 15 },
  { route: "/v2/markets/:ticker/series", schema: marketSeriesResponseSchema, cache: 15 },
  { route: "/v2/series/:longId", schema: seriesDetailResponseSchema, cache: 15 },
  { route: "/v2/series/:longId/book", schema: bookResponseSchema, cache: 15 },
  { route: "/v2/series/:longId/holders", schema: holdersResponseSchema, cache: 15 },
  { route: "/v2/series/:longId/trades", schema: tradesResponseSchema, cache: 15 },
  { route: "/v2/cards", schema: cardsResponseSchema, cache: 15 },
  { route: "/v2/cards/hero", schema: heroCardResponseSchema, cache: 15 },
  { route: "/v2/accounts/:address/positions", schema: positionsResponseSchema, cache: 15 },
  { route: "/v2/accounts/:address/history", schema: historyResponseSchema, cache: 15 },
  { route: "/v2/feed/wins", schema: winsResponseSchema, cache: 15 },
  { route: "/v2/feed/activity", schema: activityResponseSchema, cache: 15 },
  { route: "/v2/strategies", schema: strategiesResponseSchema, cache: 15 },
  { route: "/v2/leaderboard", schema: leaderboardResponseSchema, cache: 15 },
  { route: "/v2/pnl/:id", schema: pnlResponseSchema, cache: 15 },
  { route: "/v2/stats", schema: statsResponseSchema, cache: 15 },
  { route: "/v2/makers", schema: makersResponseSchema, cache: 15 },
  { route: "/v2/makers/:address", schema: makerResponseSchema, cache: 15 },
  { route: "/v2/fair/:longId", schema: fairResponseSchema, cache: 15 },
];
