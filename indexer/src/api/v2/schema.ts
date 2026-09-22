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

function decimalRaw(value: string, decimals: number): string | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (match === null || decimals > 100) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals))) return null;
  return `${match[1]}${fraction.slice(0, decimals).padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
}

function compareDecimalStrings(left: string, right: string): -1 | 0 | 1 | null {
  const leftMatch = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(left);
  const rightMatch = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(right);
  if (leftMatch === null || rightMatch === null) return null;
  const leftWhole = leftMatch[1]!;
  const rightWhole = rightMatch[1]!;
  if (leftWhole.length !== rightWhole.length) return leftWhole.length < rightWhole.length ? -1 : 1;
  if (leftWhole !== rightWhole) return leftWhole < rightWhole ? -1 : 1;
  const leftFraction = leftMatch[2] ?? "";
  const rightFraction = rightMatch[2] ?? "";
  const fractionLength = Math.max(leftFraction.length, rightFraction.length);
  for (let index = 0; index < fractionLength; index++) {
    const leftDigit = leftFraction[index] ?? "0";
    const rightDigit = rightFraction[index] ?? "0";
    if (leftDigit !== rightDigit) return leftDigit < rightDigit ? -1 : 1;
  }
  return 0;
}

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

/**
 * Highest decimal scale the UI will render. claude-24 measured viem 2.56.3 producing 99,983
 * characters in 5,072 ms for 100,000 decimals, while 1e9 threw "Invalid string length"
 * immediately. 36 is twice the system's real maximum of 18 and stays far below the silent,
 * multi-second denial-of-service range.
 */
export const MAX_RENDERABLE_DECIMALS = 36;

/** Basis points and other small non-negative integers. */
const countSchema = z.number().int().nonnegative();
const decimalsSchema = countSchema.max(MAX_RENDERABLE_DECIMALS);

const finiteSchema = z.number().finite();
const openStringSchema = z.string().min(1);

// ---------------------------------------------------------------------------------------------
// Shared objects (§4 "Shared objects")
// ---------------------------------------------------------------------------------------------

export const moneySchema = z
  .object({ raw: uintStringSchema, decimals: decimalsSchema, formatted: z.string() })
  .strict();

/** Money that may be negative: unrealised and realised PnL only. */
export const signedMoneySchema = z
  .object({ raw: intStringSchema, decimals: decimalsSchema, formatted: z.string() })
  .strict();

/** The provider, method, inputs, clocks and quality state behind one fair-value estimate (§5.1). */
export const pricingProvenanceSchema = z
  .object({
    contract: z.literal("O3-307/1"),
    provider: openStringSchema,
    providerProduct: openStringSchema.nullable(),
    method: z.enum(["listed", "interpolated", "extrapolated", "modeled", "external-indicative"]),
    methodDetail: openStringSchema.nullable(),
    contributingExpiries: z.array(unixSchema),
    identity: z
      .object({
        market: openStringSchema,
        issuer: openStringSchema.nullable(),
        token: z
          .object({ chainId: countSchema.min(1), address: addressSchema, uiMultiplier: openStringSchema.nullable() })
          .strict(),
        option: z
          .object({
            side: z.enum(["call", "put"]),
            strike: moneySchema,
            expiry: unixSchema,
            timeZone: z.literal("America/New_York"),
            exercise: z.literal("european"),
            payoff: z.literal("cash-value"),
            settlement: z.literal("oracle-twap"),
          })
          .strict(),
        listed: z.array(
          z
            .object({
              providerInstrumentId: openStringSchema.nullable(),
              root: openStringSchema.nullable(),
              side: z.enum(["call", "put"]),
              strike: openStringSchema,
              expiry: unixSchema.nullable(),
              multiplier: finiteSchema.positive().nullable(),
              exercise: openStringSchema.nullable(),
              settlement: openStringSchema.nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
    observations: z
      .object({
        listedQuotes: z.array(
          z
            .object({
              providerInstrumentId: openStringSchema.nullable(),
              bid: openStringSchema.nullable(),
              ask: openStringSchema.nullable(),
              bidSize: openStringSchema.nullable(),
              askSize: openStringSchema.nullable(),
              currency: openStringSchema,
              observedAt: unixSchema.nullable(),
            })
            .strict(),
        ),
        vendorTheoretical: z.array(
          z
            .object({
              product: openStringSchema,
              value: openStringSchema.nullable(),
              iv: finiteSchema.nonnegative().nullable(),
              currency: openStringSchema,
              observedAt: unixSchema.nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
    clocks: z
      .object({
        quoteObservedAt: unixSchema.nullable(),
        tradeObservedAt: unixSchema.nullable(),
        underlyingObservedAt: unixSchema.nullable(),
        volatilityObservedAt: unixSchema.nullable(),
        publishedAt: unixSchema.nullable(),
        receivedAt: unixSchema,
        computedAt: unixSchema,
      })
      .strict(),
    ages: z
      .object({
        quoteS: finiteSchema.nullable(),
        tradeS: finiteSchema.nullable(),
        underlyingS: finiteSchema.nullable(),
        volatilityS: finiteSchema.nullable(),
      })
      .strict(),
    entitlement: z
      .object({
        class: z.enum(["real-time", "delayed", "end-of-day", "indicative", "unknown"]),
        declaredDelayS: countSchema.nullable(),
        rightsRef: openStringSchema.nullable(),
      })
      .strict(),
    expiryClock: z
      .object({
        expiry: unixSchema,
        timeZone: z.literal("America/New_York"),
        basis: z.enum(["trading-time", "calendar-time"]),
        yearsToExpiry: finiteSchema.nullable(),
      })
      .strict(),
    quality: z
      .object({
        readiness: z.enum(["ready", "degraded", "unavailable"]),
        reasons: z.array(openStringSchema),
        uncertainty: z
          .object({
            ivLow: finiteSchema.nonnegative().nullable(),
            ivHigh: finiteSchema.nonnegative().nullable(),
            fairLow: moneySchema.nullable(),
            fairHigh: moneySchema.nullable(),
          })
          .strict()
          .nullable(),
        disagreement: z
          .object({ provider: openStringSchema, fairBps: finiteSchema.nonnegative().nullable() })
          .strict()
          .nullable(),
        fallback: z
          .object({ from: openStringSchema, to: openStringSchema, reason: openStringSchema })
          .strict()
          .nullable(),
      })
      .strict(),
    pricedSpot: moneySchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.quality.readiness === "ready") !== (value.quality.reasons.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["quality", "reasons"],
        message: "reasons must be empty exactly when pricing is ready" });
    }
    if (value.method === "listed") {
      const listed = value.identity.listed[0];
      const quote = value.observations.listedQuotes[0];
      if (value.identity.listed.length !== 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["identity", "listed"],
          message: "listed pricing requires exactly one listed instrument" });
      }
      if (value.observations.listedQuotes.length !== 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["observations", "listedQuotes"],
          message: "listed pricing requires exactly one listed quote" });
      }
      if (listed !== undefined) {
        if (listed.providerInstrumentId === null) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["identity", "listed", 0, "providerInstrumentId"],
            message: "listed pricing requires an exact provider instrument id" });
        }
        if (listed.root !== null && listed.root !== value.identity.market) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["identity", "listed", 0, "root"],
            message: "listed instrument root must match the canonical market when stated" });
        }
        if (listed.side !== value.identity.option.side) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["identity", "listed", 0, "side"],
            message: "listed instrument side must match the priced option" });
        }
        if (decimalRaw(listed.strike, value.identity.option.strike.decimals) !== value.identity.option.strike.raw) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["identity", "listed", 0, "strike"],
            message: "listed instrument strike must match the priced option" });
        }
        if (listed.expiry !== null && listed.expiry !== value.identity.option.expiry) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["identity", "listed", 0, "expiry"],
            message: "listed instrument expiry must match the priced option when stated" });
        }
        if (listed.multiplier !== null && listed.multiplier !== 100) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["identity", "listed", 0, "multiplier"],
            message: "listed instrument multiplier must be 100 when stated" });
        }
      }
      if (quote !== undefined) {
        const bidIsPositive = quote.bid === null ? null : compareDecimalStrings(quote.bid, "0");
        const askVsBid = quote.bid === null || quote.ask === null
          ? null : compareDecimalStrings(quote.ask, quote.bid);
        if (bidIsPositive === null || askVsBid === null || bidIsPositive <= 0 || askVsBid < 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["observations", "listedQuotes", 0],
            message: "listed pricing requires a finite, positive, uncrossed two-sided quote" });
        }
      }
      if (listed !== undefined && quote !== undefined &&
          listed.providerInstrumentId !== quote.providerInstrumentId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["observations", "listedQuotes", 0, "providerInstrumentId"],
          message: "listed quote must identify the priced listed instrument" });
      }
      if (value.contributingExpiries.length !== 1 ||
          value.contributingExpiries[0] !== value.identity.option.expiry) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contributingExpiries"],
          message: "listed pricing must use exactly the priced option expiry" });
      }
    }
    const clocks = [
      ["quoteS", "quoteObservedAt"],
      ["tradeS", "tradeObservedAt"],
      ["underlyingS", "underlyingObservedAt"],
      ["volatilityS", "volatilityObservedAt"],
    ] as const;
    for (const [ageKey, clockKey] of clocks) {
      const observedAt = value.clocks[clockKey];
      const expected = observedAt === null ? null : value.clocks.computedAt - observedAt;
      if (value.ages[ageKey] !== expected) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ages", ageKey],
          message: `${ageKey} must derive from computedAt and ${clockKey}` });
      }
    }
    if (value.expiryClock.expiry !== value.identity.option.expiry) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiryClock", "expiry"],
        message: "expiry clocks must describe the priced option" });
    }
  });

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
    fairProvenance: pricingProvenanceSchema.nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.fair !== null && value.fairProvenance?.quality.readiness === "unavailable") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fairProvenance", "quality", "readiness"],
        message: "numeric fair provenance cannot be unavailable" });
    }
  });

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
const maybeAddress = addressSchema.nullable();

/**
 * `<operationId>:<nonce>`, lowercase, exactly as the indexer keys the ingest row.
 *
 * `nonce` is AccessManager's `uint32`, so ten digits is its whole range; a leading zero is refused
 * so one row can never have two spellings of the same key.
 */
const OPERATION_KEY_RE = /^0x[0-9a-f]{64}:(0|[1-9]\d{0,9})$/;

export const adminOperationSchema = z
  .object({
    /**
     * THE UNIQUE ONE. `id` is AccessManager's operation id and it REPEATS: rescheduling the same
     * call reuses it, and the indexer keys its row on `operationId:nonce` for exactly that reason
     * (`indexer/src/v2/accessManager.ts:135-137`). Two live rows can therefore carry the same `id`,
     * so anything that needs a per-row identity -- a React key, a dedupe, a map -- uses this.
     * `id` is unchanged in meaning and stays on the wire for readers that key on the operation.
     */
    key: z.string().regex(OPERATION_KEY_RE, "expected <operationId>:<nonce>"),
    id: txHashSchema,
    role: openStringSchema,
    target: addressSchema,
    /** Null when scheduled calldata is shorter than a four-byte selector. */
    selector: z.string().regex(/^0x[0-9a-f]{8}$/, "expected a lowercase 4-byte selector").nullable(),
    label: openStringSchema,
    caller: addressSchema,
    scheduledAt: unixSchema,
    readyAt: unixSchema,
    status: z.enum(["pending", "executed", "canceled"]),
  })
  .strict();

export const adminOperationsResponseSchema = z
  .object({ items: z.array(adminOperationSchema), nextCursor: nextCursorSchema })
  .strict();

export const flywheelAssetSchema = z
  .object({
    asset: addressSchema,
    symbol: z.string().min(1).nullable(),
    decimals: decimalsSchema.nullable(),
    amountRaw: uintStringSchema,
  })
  .strict();

export const flywheelDistributionSchema = z
  .object({
    id: openStringSchema,
    asset: addressSchema,
    symbol: z.string().min(1).nullable(),
    decimals: decimalsSchema.nullable(),
    assetInRaw: uintStringSchema,
    usdgInRaw: uintStringSchema,
    treasuryOutRaw: uintStringSchema,
    buybackAddedRaw: uintStringSchema,
    ts: unixSchema,
    tx: txHashSchema,
  })
  .strict();

export const flywheelResponseSchema = z
  .object({
    configured: z.boolean(),
    splitter: maybeAddress,
    tokenAddress: maybeAddress,
    tokenDecimals: decimalsSchema.nullable(),
    burnedTotal: uintStringSchema.nullable(),
    burned7d: uintStringSchema.nullable(),
    revenue7d: z.array(flywheelAssetSchema),
    held: z.array(flywheelAssetSchema),
    lastDistribution: flywheelDistributionSchema.nullable(),
    distributions: z.array(flywheelDistributionSchema),
  })
  .strict();

/**
 * Lending vault wire (the `/v2/earn` route; not the `/earn` covered-call writer page).
 * Every figure that can be "not yet observed" is nullable: null is unavailable, "0" is observed
 * zero. The route projects v2EarnVault* rows and does not compute a rate.
 */
export const earnQueuedRequestSchema = z
  .object({
    id: openStringSchema,
    status: z.enum(["queued", "fulfilled", "cancelled"]),
    sharesQueued: uintStringSchema,
    /** Null: the request did not quote an asset amount. "0" would be an observed ask of nothing. */
    assetsRequested: uintStringSchema.nullable(),
    /** Null: still queued or cancelled — not a zero payout. "0" is a fulfilment that delivered nothing. */
    fulfilledAssets: uintStringSchema.nullable(),
    requestedAt: unixSchema,
  })
  .strict();

export const earnAccountSchema = z
  .object({
    address: addressSchema,
    /** Null: no per-account share balance is stored. "0" would be an observed empty holding. */
    shares: uintStringSchema.nullable(),
    queued: z.array(earnQueuedRequestSchema).optional(),
  })
  .strict();

export const earnAdapterMoveSchema = z
  .object({
    adapter: maybeAddress,
    direction: z.enum(["pull", "push"]).nullable(),
    requested: uintStringSchema,
    /** Null: the move failed or was not reported. "0" is an observed empty delivery. */
    delivered: uintStringSchema.nullable(),
    ts: unixSchema,
    tx: txHashSchema,
  })
  .strict();

export const earnQueueSchema = z
  .object({
    depth: countSchema,
    /** Null when depth is 0 (no open request). */
    oldestRequestedAt: unixSchema.nullable(),
  })
  .strict();

export const earnVaultSchema = z
  .object({
    vault: addressSchema,
    /** Null until an asset-naming event is observed. */
    asset: maybeAddress,
    /** Null until an adapter is observed; the zero address would be a real detached adapter. */
    adapter: maybeAddress,
    /** Null: pause not observed. false: observed and running. */
    paused: z.boolean().nullable(),
    /** Null: share supply not observed. "0" is an observed empty supply. */
    sharesSupply: uintStringSchema.nullable(),
    /** Null: no deposit row yet. "0" is observed deposits that net to zero. */
    deposited: uintStringSchema.nullable(),
    /** Null: no skim row yet. "0" is an observed skim of nothing. */
    skimmed: uintStringSchema.nullable(),
    queue: earnQueueSchema.optional(),
    lastAdapterMove: earnAdapterMoveSchema.nullable().optional(),
    /**
     * T-OP-086 (SEC-19 / T-OP-065). Live `indicativeAssetsPerShare()`: asset base units per 1e18 shares,
     * a DISPLAY-ONLY mark -- locked collateral less the option's intrinsic value at the oracle spot,
     * floored at zero -- never a price the vault pays. `convertToShares` / `convertToAssets` revert
     * `PositionOpen()` while a position is open, so this is the figure to show then. Null: not read (no
     * client, RPC down, or a deployment older than the view). "0" is an observed zero.
     */
    indicativeAssetsPerShare: uintStringSchema.nullable().optional(),
    /** Live `indicativeTotalAssets()`, same mark over the whole vault, asset base units. Null: not read. */
    indicativeTotalAssets: uintStringSchema.nullable().optional(),
    /** Live `hasOpenPosition()`: true while the convert views refuse. Null: not read. */
    hasOpenPosition: z.boolean().nullable().optional(),
  })
  .strict();

export const earnResponseSchema = z
  .object({
    configured: z.boolean(),
    vaults: z.array(earnVaultSchema).optional(),
    account: earnAccountSchema.nullable().optional(),
  })
  .strict();

/**
 * House vault tape. NAV exists only at a Friday settlement boundary after positions are
 * redeemed (P8-06 weekly epochs). While the current epoch is running, `nav` is null — never 0,
 * never omitted. Zero would mean a published empty book at a boundary, which is a fact.
 */
export const houseNavSchema = z
  .object({
    epoch: uintStringSchema,
    at: unixSchema,
    /**
     * MIRRORS indexer/ponder.schema.ts `v2HouseNav.usdg`, which is nullable because EpochRolled
     * does not name the USDG leg. Read from the column, not reasoned: the ingest can only ever
     * store null here, so a non-nullable wire field could be satisfied only by publishing a 0
     * that this file's own header calls a fact. Null means "the log did not say".
     */
    usdg: moneySchema.nullable(),
    /** Null for the same reason as `usdg` (`v2HouseNav.stockUnits`). Never 0. */
    stockUnits: uintStringSchema.nullable(),
    settlementPrice: moneySchema,
    navUsdg: moneySchema,
  })
  .strict();

export const houseEpochSchema = z
  .object({
    id: uintStringSchema,
    /**
     * MIRRORS `v2HouseEpoch.start` / `.end`, both nullable ("Null until observed"). Coercing an
     * unobserved boundary to 0 would publish 1970-01-01 as an epoch boundary, which reads as a
     * fact rather than as a gap.
     */
    start: unixSchema.nullable(),
    end: unixSchema.nullable(),
    nav: houseNavSchema.nullable(),
    /** Null while running. Signed USDG fact after the boundary; a losing epoch is negative. */
    resultUsdg: signedMoneySchema.nullable(),
  })
  .strict();

export const houseQueueItemSchema = z
  .object({
    kind: z.enum(["deposit", "withdraw"]),
    account: addressSchema,
    /** Deposit USDG in raw six-decimal units; null for a withdrawal. */
    assets: uintStringSchema.nullable(),
    /** Deposit Stock Tokens in raw 18-decimal units; null for a withdrawal. Optional for old snapshots. */
    stockAmount: uintStringSchema.nullable().optional(),
    shares: uintStringSchema.nullable(),
    requestedAt: unixSchema,
  })
  .strict();

export const houseSharesSchema = z
  .object({
    address: addressSchema,
    /** Null: no share row observed. "0" is an observed empty holding. */
    shares: uintStringSchema.nullable(),
    queued: z.array(houseQueueItemSchema).optional(),
  })
  .strict();

export const houseVaultSchema = z
  .object({
    market: openStringSchema,
    vault: maybeAddress,
    /**
     * Null: no epoch row observed for this vault yet. The vault is still LISTED when that
     * happens - dropping it from the list would hide a real vault behind a missing row, which
     * is the failure this row exists to kill.
     */
    currentEpoch: houseEpochSchema.nullable(),
    /** Null: supply not observed. */
    sharesSupply: uintStringSchema.nullable(),
  })
  .strict();

export const houseListResponseSchema = z
  .object({
    items: z.array(houseVaultSchema),
    nextCursor: nextCursorSchema,
  })
  .strict();

export const houseMarketResponseSchema = z
  .object({
    market: openStringSchema,
    vault: maybeAddress,
    /** Null for the same reason as on `houseVaultSchema`. */
    currentEpoch: houseEpochSchema.nullable(),
    epochs: z.array(houseEpochSchema),
    shares: houseSharesSchema.nullable().optional(),
    queue: z.array(houseQueueItemSchema).optional(),
  })
  .strict();

const payoutRouteSchema = z.discriminatedUnion("venue", [
  z.object({ venue: z.literal("v3"), fee: countSchema }).strict(),
  z
    .object({ venue: z.literal("v4"), fee: countSchema, tickSpacing: z.number().int(), poolId: txHashSchema })
    .strict(),
]);

// ---------------------------------------------------------------------------------------------
// /v2/health, /v2/config, /v2/markets
// ---------------------------------------------------------------------------------------------

/**
 * /v2/services — readiness of the services the indexer DOES NOT run. Additive (T-424); nothing
 * above this line changed.
 *
 * `healthy` is true only when `reason` is `"ready"`. Every other reason is a distinct failure and
 * is never healthy, so a consumer can branch on `healthy` alone and still be fail-closed, and read
 * `reason` only to say WHY. `reasons` is the pricer's own closed set (keeper/src/v2/health.ts
 * READY_REASONS), passed through untouched so a consumer never has to guess what a new string
 * means; it is empty unless the pricer answered validly.
 *
 * Times are unix SECONDS, per this file's convention at the top. The pricer emits ISO strings on
 * its own `/ready`; `services.ts` converts at the boundary. Neither side is wrong — the wire
 * conventions differ, and the conversion is deliberate rather than a mismatch.
 */
export const pricerServiceSchema = z
  .object({
    healthy: z.boolean(),
    reason: z.enum(["ready", "not_configured", "timeout", "http_error", "malformed_body", "not_ready", "stale"]),
    reasons: z.array(z.enum([
      "loop-wedged", "no-completed-tick", "tick-failed", "role-unread",
      "role-refused", "role-delayed", "fair-stale", "state-unknown",
    ])),
    checkedAt: unixSchema,
    lastEvaluationAt: unixSchema.nullable(),
  })
  .strict();

export const servicesResponseSchema = z.object({ pricer: pricerServiceSchema }).strict();

export const healthResponseSchema = z
  .object({
    status: z.enum(["ok", "lagging", "degraded"]),
    block: uintStringSchema,
    lagSeconds: countSchema,
    interfaceVersion: countSchema,
  })
  .strict();

/** Everything the dapp needs to boot. A contract that is not deployed yet is null. */
export const configResponseSchema = z
  .object({
    chainId: countSchema,
    interfaceVersion: countSchema,
    deployBlock: uintStringSchema.nullable(),
    usdg: z.object({ address: addressSchema, symbol: z.string().min(1), decimals: decimalsSchema }).strict(),
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
        accessManager: maybeAddress.optional(),
        stockZap: maybeAddress.optional(),
        sources: z.object({ chainlink: maybeAddress, univ3: maybeAddress, dataStreams: maybeAddress }).strict(),
      })
      .strict(),
    flywheel: z.object({ feeSplitter: maybeAddress, buybackExecutor: maybeAddress }).strict().optional(),
    safes: z.object({ admin: maybeAddress, treasury: maybeAddress }).strict().optional(),
    access: z
      .object({
        manager: addressSchema,
        roles: z.array(
          z
            .object({
              id: countSchema,
              name: openStringSchema,
              delayS: countSchema,
              holders: z.array(z.object({ address: addressSchema, delayS: countSchema }).strict()),
            })
            .strict(),
        ),
      })
      .strict()
      .optional(),
    pendingOperations: z.array(adminOperationSchema.omit({ status: true })).optional(),
    fees: z
      .object({
        premiumFeeBps: countSchema,
        resaleFeeBps: countSchema,
        takerFeeFlat: moneySchema,
        takerFeeCapBps: countSchema,
        makerRebateBps: countSchema,
        exerciseFeeBps: countSchema,
        mintFeePpm: countSchema.max(5_000),
        // T-OP-120 (G7). The Clearinghouse's `maxPayoutSlippageBps`, from the indexed PayoutAdapterSet event; the
        // conversion floor of a call payout is value * (BPS - min(this + routeFee, 300)) / BPS. Null until an adapter
        // has been set. Ceiling: MAX_PAYOUT_SLIPPAGE_CEIL_BPS = 300 (V2Constants.sol:88, setPayoutAdapter reverts above it).
        maxPayoutSlippageBps: countSchema.max(300).nullable(),
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
        feeChangeDelay: countSchema.optional(),
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
    /**
     * T-OP-099. Whether the market is in the owner's launch set (registry `launchSet.markets`, projected by
     * gen-v2-registry.mjs). `status` is what the CHAIN says about registration; `launch` is what the REGISTRY says
     * about the launch, and a registered market outside the set is served with `launch: false` rather than dropped.
     * The app never offers a trade on a non-launch market whatever `status` says.
     */
    launch: z.boolean(),
    // A failed live oracle read leaves only this market's spot unavailable.
    spot: moneySchema.nullable(),
    spotUpdatedAt: unixSchema.nullable(),
    strikeTick: moneySchema,
    puts: z.boolean(),
    mintFeePpm: countSchema.max(5_000),
    settlement: z
      .object({
        sourceCount: countSchema.min(1).max(8),
        uncorroboratedDelayS: countSchema.min(1_800).max(86_400),
        route: payoutRouteSchema.nullable(),
      })
      .strict()
      .optional(),
    expiries: z.array(unixSchema),
    stats: z
      .object({
        volume24h: moneySchema,
        premium7d: moneySchema,
        /**
         * T-425. The indexed head's block time, in Unix seconds, that `volume24h` and `premium7d`
         * were measured up to. NEVER the host clock: the data only reaches the Ponder checkpoint, so
         * a host-clock window shrinks silently toward zero while the indexer lags and a quiet day
         * cannot be told from a stalled index.
         *
         * REQUIRED, and 0 rather than absent when no checkpoint could be read. 0 is not a timestamp
         * anyone can mistake for a real one, and it is the same condition under which both figures
         * above are 0 -- together they say "no window was measured", which is precisely the sentence
         * the old shape could not say.
         */
        asOf: unixSchema,
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
    /** T-425. The indexed head each item's `volume24h` window ends at. See marketSchema.stats.asOf. */
    asOf: unixSchema,
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
          markSource: z.enum(["fair", "best-bid"]).nullable().optional(),
          unrealised: signedMoneySchema.nullable(), // USDG, (mark − avgCost) × units / 100
          claimable: moneySchema.nullable(), // collateral-asset amount `redeem` pays; null unless settled
        })
        .strict()
        .superRefine((value, ctx) => {
          if (value.markSource !== undefined && ((value.mark === null) !== (value.markSource === null))) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["markSource"],
              message: "markSource must be null exactly when mark is null" });
          }
        }),
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
    data: z.object({ units: uintStringSchema, collateral: moneySchema, fee: moneySchema,
      payer: addressSchema.optional(), longTo: addressSchema, tx: txHashSchema }).strict(),
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

/** Optional consumer-first state for the current AutoRoller position. All prices are USDG6 per whole share. */
const strategyUsdgPriceSchema = moneySchema.extend({ decimals: z.literal(6) });

export const strategyPricingSchema = z.object({
  currentAsk: strategyUsdgPriceSchema.nullable(),
  band: z.object({ min: strategyUsdgPriceSchema, max: strategyUsdgPriceSchema }).strict().nullable(),
  lastRepricedAt: unixSchema.nullable(),
  lastRepricedPrice: strategyUsdgPriceSchema.nullable(),
  repriceCount: countSchema,
  fair: strategyUsdgPriceSchema.nullable(),
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
          pricing: strategyPricingSchema.optional(),
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

/**
 * THE READABILITY OF A SELF-TRADE ZERO.
 *
 * The detector attributes a writer only on `takerIsBuyer && minimumPrice && linked`
 * (indexer/lib/v2/selfTrade.ts), so pricing the primary leg one tick higher, or funding the
 * second wallet off chain so no indexed edge exists, both drive `selfTradeUnits` to exactly 0.
 * D18 accepted the self-trade loophole ON CONDITION that the indexer flags the pattern, and a
 * bare 0 does not satisfy that condition - it is indistinguishable from an honest market.
 *
 *   detected - units were attributed; the number means what it says.
 *   clean    - nothing attributed AND nothing shaped like the pattern was refused. A real zero.
 *   blind    - nothing attributed, but legs WERE refused for a reason an evader controls. The
 *              zero is an artefact of the detector, not a statement about the market.
 *
 * `unseenUnits` is never added to `selfTradeUnits`: a suspicion is not a measurement.
 */
export const selfTradeCoverageSchema = z
  .object({
    status: z.enum(["detected", "clean", "blind"]),
    unseenUnits: uintStringSchema,
    reasons: z.array(z.object({
      reason: z.enum(["price-above-counted-band", "no-link-evidence"]),
      units: uintStringSchema,
      fills: countSchema,
    }).strict()),
  })
  .strict();

export const statsResponseSchema = z
  .object({
    /**
     * T-425. The indexed head's block time, in Unix seconds, that `volume24h`, `biggestWinDay` and
     * `biggestWinWeek` were measured up to -- never the host clock. REQUIRED, and 0 when no
     * checkpoint could be read, which is the same condition that makes `volume24h` 0 and both
     * biggest-win fields null. See marketSchema.stats.asOf, which carries the identical value.
     */
    asOf: unixSchema,
    volume24h: moneySchema,
    volumeAll: moneySchema,
    premiumAll: moneySchema,
    feesAll: moneySchema,
    contractsFilled: uintStringSchema,
    holders: countSchema,
    selfTradeUnits: uintStringSchema.optional(),
    /**
     * Whether `selfTradeUnits` means what it appears to mean. See selfTradeCoverageSchema: a
     * bare 0 cannot distinguish "nobody is self-trading" from "the detector could not see it",
     * and both cheap evasions produce exactly 0.
     */
    selfTradeCoverage: selfTradeCoverageSchema.optional(),
    biggestWinDay: winSchema.nullable(),
    biggestWinWeek: winSchema.nullable(),
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Makers, fair value
// ---------------------------------------------------------------------------------------------

/**
 * The scoring policy the epoch's figures were produced under. ADDITIVE and optional: an absent `band`
 * means the producer does not publish its policy (an older producer), and a consumer must not infer one
 * (02-interfaces.md:886-899). `bps` with `minUsdg` is the band a price is inside when
 * `|price - fair| <= max(fair * bps / 10_000, minUsdg)`.
 *
 * The values are OQ-14 PLACEHOLDERS and are not approved for funded use.
 */
export const makerBandSchema = z.object({ bps: countSchema.max(10_000), minUsdg: moneySchema }).strict();

export const makerEpochSchema = z
  .object({ id: countSchema, start: unixSchema, end: unixSchema, band: makerBandSchema.optional() })
  .strict();

const makerStatFields = {
  /**
   * Which benchmark produced uptimePct, avgSpreadBps, depthWithin100bps and score. THEY ARE COMPARABLE
   * ONLY WITHIN ONE POLICY. 1 = the live /fair estimate, used until callhouse 109e664b and never
   * labelled: a maker item WITHOUT this field is a policy-1 figure. 2 = chain-only reference from other
   * participants' fills (T-307). A new policy is a new number, never a silent redefinition.
   */
  benchmarkPolicy: countSchema.min(1),
  /**
   * Series-ticks by kind. absent: no quote on either side (downtime). valid: quoted and measured, possibly
   * at zero. missingReference: quoted but unmeasurable, and outside uptime and depth. A maker that never
   * quoted and one that quoted badly can share a score; they never share these counts.
   */
  samples: z.object({ absent: countSchema, valid: countSchema, missingReference: countSchema }).strict(),
  uptimePct: finiteSchema.min(0).max(100),
  avgSpreadBps: finiteSchema.nonnegative().nullable(), // null: never quoted both sides in the epoch
  depthWithin100bps: uintStringSchema, // units, always inside 100 bps of fair whatever the epoch band is
  /**
   * The same statistic inside the epoch's `band`, optional and new (F2 D10 lands as add-then-drop, so
   * `depthWithin100bps` keeps its name AND its meaning until a separately logged migration drops it).
   * Absent means the producer does not compute it; it is never an alias of the field above.
   */
  depthInBand: uintStringSchema.optional(), // units
  fills: countSchema,
  volume: moneySchema,
  rebates: moneySchema,
  score: finiteSchema.nonnegative(),
  selfTradeUnits: uintStringSchema.optional(),
  /** Same three-state verdict as on /stats, scoped to this maker. */
  selfTradeCoverage: selfTradeCoverageSchema.optional(),
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

export const rewardEpochSchema = z.object({
  distributor: addressSchema,
  epochId: countSchema,
  root: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  total: moneySchema,
  claimed: moneySchema,
}).strict();

export const rewardEpochsResponseSchema = z.object({
  program: z.string(),
  distributors: z.array(z.object({
    distributor: addressSchema,
    funded: moneySchema,
    defunded: moneySchema,
    balance: moneySchema,
  }).strict()),
  items: z.array(rewardEpochSchema),
  nextCursor: nextCursorSchema,
}).strict();

export const rewardClaimSchema = z.object({
  program: z.string(),
  distributor: addressSchema,
  epochId: countSchema,
  index: countSchema,
  amount: moneySchema,
  claimed: z.boolean(),
  tx: txHashSchema.nullable(),
}).strict();

export const rewardClaimsResponseSchema = z.object({
  address: addressSchema,
  items: z.array(rewardClaimSchema),
  nextCursor: nextCursorSchema,
}).strict();

const vaultBalanceSchema = z.object({
  asset: addressSchema,
  symbol: z.string().min(1),
  free: moneySchema,
}).strict();

export const vaultResponseSchema = z.object({
  vault: addressSchema,
  protocol: z.literal(true),
  balances: z.object({
    wallet: z.array(vaultBalanceSchema),
    ledger: z.array(vaultBalanceSchema),
  }).strict(),
  limits: z.object({
    maxSeriesUnits: uintStringSchema,
    maxTotalNotional: uintStringSchema,
    askToleranceBps: countSchema,
    maxBidBpsOfSpot: countSchema,
    maxOrderLifetime: countSchema,
    maxDailyOutflow: uintStringSchema,
  }).strict(),
  outflow: z.object({ used: moneySchema, cap: moneySchema }).strict(),
  liveOrderCount: countSchema,
  trackedSeries: z.array(uintStringSchema),
}).strict();

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
      spot: moneySchema.optional(),
      provenance: pricingProvenanceSchema.optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.provenance === undefined) return;
      if (value.provenance.quality.readiness === "unavailable") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["provenance", "quality", "readiness"],
          message: "numeric fair provenance cannot be unavailable" });
      }
      const source = value.provenance.provider === "cboe-delayed" && value.provenance.method === "listed"
        ? "cboe" : "model";
      if (value.source !== source) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["source"],
          message: "legacy source must agree with pricing provenance" });
      }
      if (value.spot !== undefined && value.provenance.pricedSpot !== null &&
          (value.spot.raw !== value.provenance.pricedSpot.raw || value.spot.decimals !== value.provenance.pricedSpot.decimals)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["spot"],
          message: "spot must agree with provenance.pricedSpot" });
      }
    }),
  z
    .object({
      fair: z.null(),
      reason: z.string().min(1),
      reasonCode: openStringSchema.optional(),
      provenance: pricingProvenanceSchema.optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.provenance !== undefined && value.provenance.quality.readiness !== "unavailable") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["provenance", "quality", "readiness"],
          message: "null fair provenance must be unavailable" });
      }
    }),
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
  // Cache 0: services.ts holds its own short cache, and a status route that the edge could
  // serve from a 15s copy would report a dead pricer as healthy for 15 seconds after it died.
  { route: "/v2/services", schema: servicesResponseSchema, cache: 0 },
  { route: "/v2/config", schema: configResponseSchema, cache: 0 },
  { route: "/v2/admin/operations", schema: adminOperationsResponseSchema, cache: 15 },
  { route: "/v2/flywheel", schema: flywheelResponseSchema, cache: 15 },
  { route: "/v2/earn", schema: earnResponseSchema, cache: 15 },
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
  { route: "/v2/rewards/epochs", schema: rewardEpochsResponseSchema, cache: 15 },
  { route: "/v2/rewards/:address/claims", schema: rewardClaimsResponseSchema, cache: 15 },
  { route: "/v2/vault", schema: vaultResponseSchema, cache: 15 },
  { route: "/v2/fair/:longId", schema: fairResponseSchema, cache: 15 },
  { route: "/v2/house", schema: houseListResponseSchema, cache: 15 },
  { route: "/v2/house/:market", schema: houseMarketResponseSchema, cache: 15 },
];
