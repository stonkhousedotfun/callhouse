import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono, type Context as HonoContext } from "hono";
import { logger as honoLogger } from "hono/logger";
import { and, desc, eq, graphql, sql } from "ponder";
import { getAddress, isAddress, type Address } from "viem";

import {
  ACC_PRECISION,
  ASSET,
  CHAIN_ID,
  CHAIN_NAME,
  CLEARINGHOUSE,
  KEEPER_HMAC_SECRET,
  OVERCALL_FEE_RECIPIENT,
  REGISTRY,
  SEAPORT,
  USDG,
  VAULT,
} from "../../lib/env";
import { ROLE_DEFAULT_ADMIN, ROLE_GUARDIAN, ROLE_KEEPER } from "../../lib/roles";
import { cache15s } from "./cache";
import {
  readAccountLive,
  readChainHead,
  readCycleLive,
  readOraclePaused,
  readVaultLive,
} from "./chain";
import { verifyKeeperHmac } from "./hmac";
import { forwardToOvercall, validateRelayBody } from "./overcall";
import { asset, iso, num, toJson, usdg } from "./serialize";
import { log } from "../../lib/log";

const app = new Hono();

// One line per request: method, path, status, milliseconds. The HMAC that gates
// /v1/overcall/list travels in headers, so paths are safe to log verbatim.
app.use(honoLogger());

/*//////////////////////////////////////////////////////////////
                           CONSTANTS
//////////////////////////////////////////////////////////////*/

const PHASE_NAMES = ["Idle", "Listed", "Exercisable", "Settling"] as const;

const CYCLE_STATUSES = [
  "idle",
  "listed",
  "filled",
  "unfilled",
  "assigned",
  "closed",
] as const;
type CycleStatus = (typeof CYCLE_STATUSES)[number];

const LISTING_STATUSES = [
  "approved",
  "partially_filled",
  "filled",
  "cancelled",
  "invalidated",
  "expired",
] as const;
type ListingStatus = (typeof LISTING_STATUSES)[number];

const ONE = 10n ** 18n;

const clampLimit = (raw: string | undefined, fallback: number, max: number): number => {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
};

const clampOffset = (raw: string | undefined): number => {
  const n = raw === undefined ? 0 : Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
};

const ADDRESSES = {
  chainId: CHAIN_ID,
  vault: VAULT,
  asset: ASSET,
  usdg: USDG,
  registry: REGISTRY,
  clearinghouse: CLEARINGHOUSE,
  seaport: SEAPORT,
  overcallFeeRecipient: OVERCALL_FEE_RECIPIENT,
} as const;

/**
 * Serialise and respond without going through `c.json`.
 *
 * Hono types `c.json` by inferring the literal shape of its argument, which on payloads this
 * deeply nested trips TypeScript's instantiation-depth limit. These responses are already
 * plain JSON — `toJson` has flattened every bigint to a decimal string — so the encoding is
 * done here and handed over as a body.
 */
function sendJson(c: HonoContext, value: unknown, status = 200): Response {
  return c.newResponse(JSON.stringify(value), status as 200, {
    "content-type": "application/json; charset=UTF-8",
  });
}

async function loadState() {
  return await db.select().from(schema.vaultState).limit(1).then((r) => r[0] ?? null);
}

/*//////////////////////////////////////////////////////////////
                      SHAPES (one per table)
//////////////////////////////////////////////////////////////*/

type CycleRow = typeof schema.cycle.$inferSelect;
type ListingRow = typeof schema.listing.$inferSelect;
type HarvestRow = typeof schema.harvest.$inferSelect;

/**
 * The public shape of a week.
 *
 * Note what is ALWAYS present, even on a week nobody bought: `contractsSold: 0`,
 * `premiumGross: 0`, `premiumNet: 0`, `fee: 0`, `status: "unfilled"`. An unfilled week is the
 * most likely outcome and it is published, not hidden.
 */
export function cycleJson(c: CycleRow) {
  return {
    cycle: c.cycleNumber,
    status: c.status,
    wrote: c.wrote,
    filled: c.contractsSold > 0n,
    assigned: c.contractsAssigned > 0n,

    registry: {
      optionIds: c.optionIds ?? [],
      strikeCount: c.strikeCount,
      lotSize: c.lotSize === null ? null : asset(c.lotSize),
      exerciseTimestamp: num(c.exerciseTimestamp),
      exerciseAt: iso(c.exerciseTimestamp),
      expiryTimestamp: num(c.expiryTimestamp),
      expiryAt: iso(c.expiryTimestamp),
      setAt: iso(c.setAt),
      setTx: c.setTx,
    },

    written: {
      optionId: c.optionId === null ? null : c.optionId.toString(),
      claimKey: c.claimKey === null ? null : c.claimKey.toString(),
      strikeUsdg: usdg(c.strikeUsdg),
      contracts: num(c.contractsWritten),
      collateral: asset(c.collateral),
      openedAt: iso(c.openedAt),
      txOpen: c.txOpen,
    },

    listing: {
      count: c.listingCount,
      orderHash: c.orderHash,
      contracts: num(c.listedContracts),
      grossUsdg: usdg(c.listedGrossUsdg),
      unitPriceUsdg: usdg(c.listedUnitPriceUsdg),
      listedAt: iso(c.listedAt),
    },

    fill: {
      contractsSold: num(c.contractsSold),
      fillCount: c.fillCount,
      // What buyers paid, INCLUDING Overcall's 5%.
      premiumGross: usdg(c.premiumGross),
      // The 95% that reached the vault.
      premiumToVault: usdg(c.premiumToVault),
      // The 5% that went to Overcall.
      overcallFee: usdg(c.overcallFee),
      unitPriceUsdg: usdg(c.fillUnitPriceUsdg),
      firstFillAt: iso(c.firstFillAt),
      lastFillAt: iso(c.lastFillAt),
    },

    settlement: {
      lockedAt: iso(c.lockedAt),
      contractsAssigned: num(c.contractsAssigned),
      assignmentUsdg: usdg(c.assignmentUsdg),
      assetsReturned: asset(c.assetsReturned),
      // Market-wide exercise against this option type. Our assignment is a bucket lottery,
      // resolved only at redeem, so this is a signal and not a claim about us.
      marketExercised: num(c.marketExercised),
      bucketIndex: c.bucketIndex === null ? null : c.bucketIndex.toString(),
      bucketAssigned: num(c.bucketAssigned),
      closedAt: iso(c.closedAt),
      txClose: c.txClose,
    },

    harvest: {
      harvested: c.harvested,
      // The vault's whole USDG take: premium that filled plus any strike proceeds.
      grossUsdg: usdg(c.harvestGross),
      // Charged on the premium part only; strike proceeds (settlement.assignmentUsdg) are never
      // fee'd, so on an assigned week fee / grossUsdg is not the policy rate.
      fee: usdg(c.fee),
      premiumNet: usdg(c.premiumNet),
      usdgPerShare: usdg(c.usdgPerShare),
      supplyAtHarvest: asset(c.supplyAtHarvest),
      harvestedAt: iso(c.harvestedAt),
    },
  };
}

export function listingJson(l: ListingRow) {
  return {
    orderHash: l.orderHash,
    cycle: l.cycleNumber,
    seq: l.seq,
    status: l.status,
    optionId: l.optionId.toString(),
    contracts: num(l.amount),
    grossUsdg: usdg(l.grossUsdg),
    unitPriceUsdg: usdg(l.unitPriceUsdg),
    // The per-contract 95/5 split, recomputed exactly as Policy.splitPremium does it.
    writerUsdg: usdg(l.writerUsdg),
    overcallFeeUsdg: usdg(l.overcallFeeUsdg),
    fill: {
      contractsFilled: num(l.contractsFilled),
      fillCount: l.fillCount,
      proceedsUsdg: usdg(l.proceedsUsdg),
      feePaidUsdg: usdg(l.feePaidUsdg),
      lastFillAt: iso(l.lastFillAt),
      lastFillTx: l.lastFillTx,
    },
    approvedAt: iso(l.approvedAt),
    approvedTx: l.approvedTx,
    endedAt: iso(l.endedAt),
    endedTx: l.endedTx,
    endReason: l.endReason,
  };
}

function harvestJson(h: HarvestRow) {
  return {
    cycle: h.cycleNumber,
    // true = the end-of-cycle harvest inside `rollClose` (the week's verdict).
    // false = a mid-week `_checkpointHarvest()` fired by a deposit, which sweeps premium into
    //         the index before new shares exist. Real money, but not a weekly result.
    terminal: h.terminal,
    filled: h.filled,
    grossUsdg: usdg(h.grossUsdg),
    fee: usdg(h.feeUsdg),
    netUsdg: usdg(h.netUsdg),
    premiumToVault: usdg(h.premiumToVault),
    assignmentUsdg: usdg(h.assignmentUsdg),
    contractsSold: num(h.contractsSold),
    contractsAssigned: num(h.contractsAssigned),
    usdgPerShare: usdg(h.usdgPerShare),
    supply: asset(h.supply),
    accUsdgPerShare: h.accUsdgPerShare.toString(),
    at: iso(h.timestamp),
    txHash: h.txHash,
  };
}

/*//////////////////////////////////////////////////////////////
                          GET /v1/vault
//////////////////////////////////////////////////////////////*/

/**
 * TVL, phase, and this week: strike, listing, fill.
 *
 * Indexed state is the base; a live read is layered on top for the few facts events cannot
 * carry (Valorem's mid-week position, the oracle, the registry's ladder). If the RPC is down
 * the route still answers from the index with `live: false` rather than failing.
 */
app.get("/v1/vault", cache15s, async (c) => {
  const state = await loadState();

  const [live, liveCycle, oraclePaused] = await Promise.all([
    readVaultLive(),
    readCycleLive(),
    readOraclePaused(),
  ]);

  const indexedIdle =
    state === null
      ? 0n
      : state.assetBalance > state.reservedAssets
        ? state.assetBalance - state.reservedAssets
        : 0n;
  const indexedTotal = state === null ? 0n : indexedIdle + state.lockedCollateral;

  const totalAssets = live.totalAssets ?? indexedTotal;
  const totalShares = live.totalSupply ?? state?.totalShares ?? 0n;
  // Share price in asset base units per whole share. Matches `convertToAssets(1e18)` to
  // within the +1 rounding guard the vault applies; USDG never enters it.
  const pricePerShare = totalShares === 0n ? ONE : (totalAssets * ONE) / totalShares;

  const thisCycleNumber =
    state !== null && state.cycleNumber !== 0
      ? state.cycleNumber
      : (liveCycle.cycleNumber ?? 0);

  const thisCycle =
    thisCycleNumber === 0
      ? null
      : await db
          .select()
          .from(schema.cycle)
          .where(eq(schema.cycle.cycleNumber, thisCycleNumber))
          .limit(1)
          .then((r) => r[0] ?? null);

  // The last WEEK, so the last terminal harvest. A mid-week checkpoint harvest (fired by a
  // deposit while the cycle is still live) is not a result and must never be shown as one.
  const lastHarvest = await db
    .select()
    .from(schema.harvest)
    .where(eq(schema.harvest.terminal, true))
    .orderBy(desc(schema.harvest.blockNumber))
    .limit(1)
    .then((r) => r[0] ?? null);

  // Who can touch this vault right now. Published, not buried: the keeper can only propose,
  // the guardian can only stop things, and the admin can only move policy inside the caps
  // compiled into the bytecode.
  const roleRows = await db
    .select()
    .from(schema.roleMember)
    .where(eq(schema.roleMember.granted, true));
  const holders = (role: string) =>
    roleRows
      .filter((r) => r.role.toLowerCase() === role.toLowerCase())
      .map((r) => r.account);

  const phaseCode = live.phase ?? state?.phase ?? 0;

  return sendJson(
    c,
    toJson({
      addresses: ADDRESSES,
      live: live.live,
      blockNumber: live.blockNumber === null ? null : live.blockNumber.toString(),

      phase: {
        code: phaseCode,
        name: PHASE_NAMES[phaseCode] ?? "Unknown",
        writesHalted: live.writesHalted ?? state?.writesHalted ?? false,
        canRedeemInstantly: live.canRedeemInstantly,
        valoremFeeAccepted: live.valoremFeeAccepted ?? state?.valoremFeeAccepted ?? false,
        // The issuer's two levers. A paused oracle makes `rollOpen` revert — no price, no
        // write. A transfer pause freezes the token itself and stops deposits, redemptions
        // and settlement alike; nothing in this system can route around that.
        oraclePaused: oraclePaused ?? state?.oraclePaused ?? false,
        tokenPaused: state?.tokenPaused ?? false,
        // Seconds. Days, not hours, on purpose: the NVDA/USD feed only moves while the US
        // equity market is open, so a ~52h weekend gap is normal and Friday's close IS spot.
        maxPriceAgeSeconds: state?.maxPriceAge ?? 0,
      },

      tvl: {
        totalAssets: asset(totalAssets),
        idleAssets: asset(live.idleAssets ?? indexedIdle),
        // Live reads Valorem's position, so this falls as buyers are assigned mid-week.
        lockedAssets: asset(live.lockedAssets ?? state?.lockedCollateral ?? 0n),
        reservedAssets: asset(state?.reservedAssets ?? 0n),
        totalShares: asset(totalShares),
        pricePerShare: asset(pricePerShare),
        depositCap: asset(live.depositCap ?? state?.depositCap ?? 0n),
        maxDeposit: asset(live.maxDeposit ?? 0n),
        // ERC-8056. DISPLAY ONLY: no share maths anywhere touches it, and the vault never rebases.
        uiMultiplier: (live.uiMultiplier ?? state?.uiMultiplier ?? ONE).toString(),
        uiMultiplierPending:
          state?.uiMultiplierPending === null || state?.uiMultiplierPending === undefined
            ? null
            : state.uiMultiplierPending.toString(),
        uiMultiplierEffectiveAt: iso(state?.uiMultiplierEffectiveAt ?? null),
        // Reverts when the feed is stale, which is itself the signal. Null means "no fresh price".
        spotUsdg: live.spotUsdg === null ? null : usdg(live.spotUsdg),
      },

      usdg: {
        balance: usdg(state?.usdgBalance ?? 0n),
        distributed: usdg(state?.totalUsdgDistributed ?? 0n),
        claimed: usdg(state?.totalUsdgClaimed ?? 0n),
        reservedForQueue: usdg(live.usdgReservedForQueue ?? state?.usdgReservedForQueue ?? 0n),
        unallocated: usdg(state?.usdgUnallocated ?? 0n),
        // Distributor index. Raw and unscaled, so the divisor is published with it rather
        // than left to be guessed: usdg owed to a holder = shares × acc / precision.
        accUsdgPerShare: (state?.accUsdgPerShare ?? 0n).toString(),
        accUsdgPerSharePrecision: ACC_PRECISION.toString(),
        protocolFeeBps: state?.protocolFeeBps ?? 0,
        feeRecipient: state?.feeRecipient ?? null,
      },

      queue: {
        queuedShares: asset(live.queuedShares ?? state?.queuedShares ?? 0n),
        epochId: (state?.epochId ?? 1n).toString(),
      },

      week: {
        cycle: thisCycle === null ? null : cycleJson(thisCycle),
        // The registry is the clock. `isWritingOpen` is the keeper's only trigger; the wall
        // clock is never consulted. The ladder is whatever rungs Overcall approved this week.
        registry: {
          live: liveCycle.live,
          cycleNumber: liveCycle.cycleNumber,
          isWritingOpen: liveCycle.isWritingOpen,
          isCycleLive: liveCycle.isCycleLive,
          writeDeadline: num(liveCycle.writeDeadline),
          writeDeadlineAt: iso(liveCycle.writeDeadline),
          exerciseAt: iso(liveCycle.exerciseTimestamp),
          expiryAt: iso(liveCycle.expiryTimestamp),
          lotSize: liveCycle.lotSize === null ? null : asset(liveCycle.lotSize),
          rungs: liveCycle.rungs.map((r) => ({
            optionId: r.optionId.toString(),
            strikeUsdg: r.strikeUsdg === null ? null : usdg(r.strikeUsdg),
            approved: r.approved,
            // Which rung we actually wrote, if any.
            ours: thisCycle !== null && thisCycle.optionId === r.optionId,
          })),
        },
        // Index-first, like everything else here: the live read is preferred because a
        // listing can be cancelled without the vault emitting anything the indexer has yet
        // processed, but a dead RPC falls back to the cycle row rather than reporting zeros
        // for a listing that is demonstrably on the book.
        listing: {
          hash: live.listingHash ?? state?.listingHash ?? null,
          contracts: num(live.listingAmount ?? thisCycle?.listedContracts ?? 0n),
          grossUsdg: usdg(live.listingGrossUsdg ?? thisCycle?.listedGrossUsdg ?? 0n),
          listingsThisCycle: live.listingsThisCycle ?? state?.listingsThisCycle ?? 0,
          maxListingsPerCycle: 3,
        },
        assignmentLive: {
          // Straight from `clear.claim().amountExercised / 1e18`, so it is a contract count.
          contractsAssigned: num(live.contractsAssigned ?? 0n),
          contractsRemaining: num(live.contractsRemaining ?? 0n),
          contractsWritten: num(live.contractsWritten ?? 0n),
        },
      },

      lastWeek: lastHarvest === null ? null : harvestJson(lastHarvest),

      lifetime: {
        cyclesWritten: state?.cyclesWritten ?? 0,
        cyclesFilled: state?.cyclesFilled ?? 0,
        cyclesUnfilled: state?.cyclesUnfilled ?? 0,
        cyclesAssigned: state?.cyclesAssigned ?? 0,
        premiumGross: usdg(state?.lifetimePremiumGross ?? 0n),
        premiumToVault: usdg(state?.lifetimePremiumToVault ?? 0n),
        overcallFee: usdg(state?.lifetimeOvercallFee ?? 0n),
        assignmentUsdg: usdg(state?.lifetimeAssignmentUsdg ?? 0n),
        protocolFee: usdg(state?.lifetimeProtocolFee ?? 0n),
        premiumNet: usdg(state?.lifetimePremiumNet ?? 0n),
      },

      roles: {
        admin: holders(ROLE_DEFAULT_ADMIN),
        keeper: holders(ROLE_KEEPER),
        guardian: holders(ROLE_GUARDIAN),
      },

      indexedAt: {
        blockNumber: (state?.lastBlock ?? 0n).toString(),
        timestamp: (state?.lastTimestamp ?? 0n).toString(),
        at: iso(state?.lastTimestamp ?? null),
      },
    }),
  );
});

/*//////////////////////////////////////////////////////////////
                         GET /v1/cycles
//////////////////////////////////////////////////////////////*/

/**
 * The full tape, newest first.
 *
 * Every week the registry ever opened is here, including the ones the vault sat out
 * (`status: "idle"`) and the ones it wrote into and nobody bought (`status: "unfilled"`,
 * every money field 0). That is the point of the route.
 */
app.get("/v1/cycles", cache15s, async (c) => {
  const limit = clampLimit(c.req.query("limit"), 52, 500);
  const offset = clampOffset(c.req.query("offset"));
  const statusParam = c.req.query("status");

  const status = CYCLE_STATUSES.includes(statusParam as CycleStatus)
    ? (statusParam as CycleStatus)
    : undefined;

  if (statusParam !== undefined && status === undefined) {
    return c.json(
      { error: `Unknown status "${statusParam}". Expected one of ${CYCLE_STATUSES.join(", ")}.` },
      400,
    );
  }

  const base = db.select().from(schema.cycle);
  const rows = await (status === undefined ? base : base.where(eq(schema.cycle.status, status)))
    .orderBy(desc(schema.cycle.cycleNumber))
    .limit(limit)
    .offset(offset);

  const state = await loadState();

  return sendJson(
    c,
    toJson({
      addresses: ADDRESSES,
      count: rows.length,
      limit,
      offset,
      totals: {
        written: state?.cyclesWritten ?? 0,
        filled: state?.cyclesFilled ?? 0,
        unfilled: state?.cyclesUnfilled ?? 0,
        assigned: state?.cyclesAssigned ?? 0,
      },
      cycles: rows.map(cycleJson),
    }),
  );
});

/** One week by number, so a permalink to a Friday result is a real URL. */
app.get("/v1/cycles/:cycle", cache15s, async (c) => {
  const n = Number(c.req.param("cycle"));
  if (!Number.isInteger(n) || n < 0) {
    return c.json({ error: "cycle must be a non-negative integer." }, 400);
  }

  const row = await db
    .select()
    .from(schema.cycle)
    .where(eq(schema.cycle.cycleNumber, n))
    .limit(1)
    .then((r) => r[0] ?? null);

  if (row === null) return c.json({ error: `No cycle ${n}.` }, 404);

  const listings = await db
    .select()
    .from(schema.listing)
    .where(eq(schema.listing.cycleNumber, n))
    .orderBy(desc(schema.listing.seq));

  const harvests = await db
    .select()
    .from(schema.harvest)
    .where(eq(schema.harvest.cycleNumber, n))
    .orderBy(desc(schema.harvest.blockNumber));

  return sendJson(
    c,
    toJson({
      addresses: ADDRESSES,
      cycle: cycleJson(row),
      listings: listings.map(listingJson),
      harvests: harvests.map(harvestJson),
    }),
  );
});

/*//////////////////////////////////////////////////////////////
                       GET /v1/activity
//////////////////////////////////////////////////////////////*/

/**
 * The weekly tape, newest first — including the zero rows, which are the point of it.
 *
 * Terminal harvests only by default: those are the one-per-`rollClose` rows that say what a
 * week did, and an unfilled week is always among them with `filled: false` and every money
 * field 0. `?include=all` adds the mid-week `_checkpointHarvest()` rows (`terminal: false`),
 * which are premium swept into the index ahead of a deposit rather than a week's result.
 */
app.get("/v1/activity", cache15s, async (c) => {
  const limit = clampLimit(c.req.query("limit"), 52, 500);
  const offset = clampOffset(c.req.query("offset"));
  const includeParam = c.req.query("include");

  if (includeParam !== undefined && includeParam !== "all" && includeParam !== "terminal") {
    return c.json(
      { error: `Unknown include "${includeParam}". Expected "terminal" (default) or "all".` },
      400,
    );
  }
  const terminalOnly = includeParam !== "all";

  const base = db.select().from(schema.harvest);
  const rows = await (terminalOnly ? base.where(eq(schema.harvest.terminal, true)) : base)
    .orderBy(desc(schema.harvest.blockNumber))
    .limit(limit)
    .offset(offset);

  return sendJson(
    c,
    toJson({
      count: rows.length,
      limit,
      offset,
      include: terminalOnly ? "terminal" : "all",
      harvests: rows.map(harvestJson),
    }),
  );
});

/*//////////////////////////////////////////////////////////////
                      GET /v1/account/:addr
//////////////////////////////////////////////////////////////*/

/**
 * Shares, claimable USDG, queued position.
 *
 * `claimableUsdg` is read live because it cannot be derived from logs: the Distributor keeps a
 * per-account snapshot of the index, and no event exposes it. Everything else is indexed and
 * cross-checked against the chain, so a mismatch is visible rather than hidden.
 */
app.get("/v1/account/:addr", cache15s, async (c) => {
  const raw = c.req.param("addr");
  if (!isAddress(raw)) {
    return c.json({ error: `"${raw}" is not an address.` }, 400);
  }
  const address = getAddress(raw) as Address;

  const [indexed, live, state] = await Promise.all([
    db
      .select()
      .from(schema.user)
      .where(eq(schema.user.address, address))
      .limit(1)
      .then((r) => r[0] ?? null),
    readAccountLive(address),
    loadState(),
  ]);

  const epochId = live.queuedEpoch ?? indexed?.queuedEpoch ?? null;
  const epoch =
    epochId === null || epochId === 0n
      ? null
      : await db
          .select()
          .from(schema.queueEpoch)
          .where(eq(schema.queueEpoch.epochId, epochId))
          .limit(1)
          .then((r) => r[0] ?? null);

  const currentEpoch = state?.epochId ?? 1n;

  return sendJson(
    c,
    toJson({
      address,
      addresses: ADDRESSES,
      live: live.live,
      known: indexed !== null,

      position: {
        // Excludes anything escrowed in the redeem queue; the vault holds those shares.
        shares: asset(live.shares ?? indexed?.shares ?? 0n),
        sharesAsAssets: asset(live.sharesAsAssets ?? 0n),
        claimableUsdg: usdg(live.claimableUsdg ?? 0n),
      },

      queue: {
        queuedShares: asset(live.queuedShares ?? indexed?.queuedShares ?? 0n),
        epochId: epochId === null ? null : epochId.toString(),
        // An epoch only pays once the cycle it sat through has closed and settled.
        settled: epoch !== null && epoch.status === "settled",
        claimable: epochId !== null && epochId !== 0n && epochId < currentEpoch,
        previewAssets: asset(live.previewAssets ?? 0n),
        previewUsdg: usdg(live.previewUsdg ?? 0n),
        epochSettledAt: epoch === null ? null : iso(epoch.settledAt),
      },

      lifetime: {
        deposited: asset(indexed?.depositedAssets ?? 0n),
        withdrawn: asset(indexed?.withdrawnAssets ?? 0n),
        redeemedAssets: asset(indexed?.redeemedAssets ?? 0n),
        redeemedUsdg: usdg(indexed?.redeemedUsdg ?? 0n),
        claimedUsdg: usdg(indexed?.claimedUsdg ?? 0n),
        depositCount: indexed?.depositCount ?? 0,
        firstSeenAt: iso(indexed?.firstSeenAt ?? null),
        lastActivityAt: iso(indexed?.lastActivityAt ?? null),
      },
    }),
  );
});

/*//////////////////////////////////////////////////////////////
                        GET /v1/listings
//////////////////////////////////////////////////////////////*/

/** Current and past Seaport orders, newest first, with their hashes and realised fills. */
app.get("/v1/listings", cache15s, async (c) => {
  const limit = clampLimit(c.req.query("limit"), 50, 500);
  const offset = clampOffset(c.req.query("offset"));
  const cycleParam = c.req.query("cycle");
  const statusParam = c.req.query("status");

  const status = LISTING_STATUSES.includes(statusParam as ListingStatus)
    ? (statusParam as ListingStatus)
    : undefined;
  if (statusParam !== undefined && status === undefined) {
    return c.json(
      { error: `Unknown status "${statusParam}". Expected one of ${LISTING_STATUSES.join(", ")}.` },
      400,
    );
  }

  let cycleNumber: number | undefined;
  if (cycleParam !== undefined) {
    const n = Number(cycleParam);
    if (!Number.isInteger(n) || n < 0) {
      return c.json({ error: "cycle must be a non-negative integer." }, 400);
    }
    cycleNumber = n;
  }

  const clauses = [
    status === undefined ? undefined : eq(schema.listing.status, status),
    cycleNumber === undefined ? undefined : eq(schema.listing.cycleNumber, cycleNumber),
  ].filter((x) => x !== undefined);

  const base = db.select().from(schema.listing);
  const rows = await (clauses.length === 0 ? base : base.where(and(...clauses)))
    .orderBy(desc(schema.listing.approvedBlock))
    .limit(limit)
    .offset(offset);

  const state = await loadState();

  return sendJson(
    c,
    toJson({
      addresses: ADDRESSES,
      liveHash: state?.listingHash ?? null,
      seaportCounter: (state?.seaportCounter ?? 0n).toString(),
      count: rows.length,
      limit,
      offset,
      listings: rows.map(listingJson),
    }),
  );
});

/** One order by hash. */
app.get("/v1/listings/:hash", cache15s, async (c) => {
  const hash = c.req.param("hash").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) {
    return c.json({ error: "hash must be 32 bytes of hex." }, 400);
  }

  const row = await db
    .select()
    .from(schema.listing)
    .where(eq(schema.listing.orderHash, hash as `0x${string}`))
    .limit(1)
    .then((r) => r[0] ?? null);

  if (row === null) return c.json({ error: "No such listing." }, 404);
  return sendJson(c, toJson({ listing: listingJson(row) }));
});

/*//////////////////////////////////////////////////////////////
                       GET /v1/snapshots
//////////////////////////////////////////////////////////////*/

/** The raw state trail, for charts that want a series rather than a point. */
app.get("/v1/snapshots", cache15s, async (c) => {
  const limit = clampLimit(c.req.query("limit"), 200, 1000);
  const offset = clampOffset(c.req.query("offset"));

  const rows = await db
    .select()
    .from(schema.vaultSnapshot)
    .orderBy(desc(schema.vaultSnapshot.blockNumber))
    .limit(limit)
    .offset(offset);

  return sendJson(
    c,
    toJson({
      count: rows.length,
      limit,
      offset,
      snapshots: rows.map((s) => ({
        blockNumber: s.blockNumber.toString(),
        at: iso(s.timestamp),
        reason: s.reason,
        phase: s.phase,
        phaseName: PHASE_NAMES[s.phase] ?? "Unknown",
        cycle: s.cycleNumber,
        writesHalted: s.writesHalted,
        idleAssets: asset(s.idleAssets),
        lockedCollateral: asset(s.lockedCollateral),
        totalAssets: asset(s.totalAssets),
        reservedAssets: asset(s.reservedAssets),
        totalShares: asset(s.totalShares),
        queuedShares: asset(s.queuedShares),
        usdgBalance: usdg(s.usdgBalance),
        totalUsdgDistributed: usdg(s.totalUsdgDistributed),
        uiMultiplier: s.uiMultiplier.toString(),
        txHash: s.txHash,
      })),
    }),
  );
});

/*//////////////////////////////////////////////////////////////
                            HEALTH
//////////////////////////////////////////////////////////////*/

/**
 * Ponder stores each chain's progress as a fixed-width decimal checkpoint. The layout is
 * 10 digits of block timestamp, 16 of chain id, 16 of block number, then transaction index,
 * event type and event index. Slicing it is the only way to read the sync head from SQL.
 */
function decodeCheckpoint(cp: string): { timestamp: bigint; blockNumber: bigint } | null {
  if (typeof cp !== "string" || cp.length < 42) return null;
  try {
    return {
      timestamp: BigInt(cp.slice(0, 10)),
      blockNumber: BigInt(cp.slice(26, 42)),
    };
  } catch {
    return null;
  }
}

async function readIndexerHead(): Promise<{
  blockNumber: bigint;
  timestamp: bigint;
} | null> {
  try {
    // `_ponder_checkpoint` lives in the indexer's own namespace and the readonly connection
    // already has that namespace on its search_path, so the unqualified name resolves.
    const raw = await (
      db as unknown as { execute: (q: unknown) => Promise<unknown> }
    ).execute(sql`select latest_checkpoint from _ponder_checkpoint`);

    const rows: unknown[] = Array.isArray(raw)
      ? raw
      : ((raw as { rows?: unknown[] }).rows ?? []);

    let best: { blockNumber: bigint; timestamp: bigint } | null = null;
    for (const row of rows) {
      const cp = (row as Record<string, unknown>).latest_checkpoint;
      const decoded = typeof cp === "string" ? decodeCheckpoint(cp) : null;
      if (decoded === null) continue;
      if (best === null || decoded.blockNumber > best.blockNumber) best = decoded;
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * Indexer head against chain head.
 *
 * NOTE ON THE PATH. Ponder reserves `/health`, `/ready`, `/status`, `/metrics` and `/client`
 * for its own server and REFUSES TO BUILD if an app route shadows one of them. Its `/health`
 * is a bare liveness probe (empty 200) and its `/ready` returns 503 until the historical sync
 * finishes. The lag payload therefore lives here, at `/v1/health`. Point uptime checks at
 * `/health`, point the dashboard and the keeper's alerting at `/v1/health`.
 */
app.get("/v1/health", async (c) => {
  const [head, chainHead, state] = await Promise.all([
    readIndexerHead(),
    readChainHead(),
    loadState(),
  ]);

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const lagBlocks =
    head !== null && chainHead !== null && chainHead > head.blockNumber
      ? chainHead - head.blockNumber
      : 0n;
  const lagSeconds = head === null ? null : nowSeconds - head.timestamp;

  // 4663 is a sub-second Orbit L2, so a few hundred blocks is seconds of real time. The
  // seconds figure is the one that means anything to a human, and it is the one that gates.
  const rpcOk = chainHead !== null;
  const indexOk = head !== null;
  const fresh = lagSeconds !== null && lagSeconds <= 120n;
  const status = indexOk && rpcOk && fresh ? "ok" : indexOk && rpcOk ? "lagging" : "degraded";

  return sendJson(
    c,
    toJson({
      status,
      chain: { id: CHAIN_ID, name: CHAIN_NAME },
      indexer: {
        head: head === null ? null : head.blockNumber.toString(),
        headTimestamp: head === null ? null : head.timestamp.toString(),
        headAt: head === null ? null : iso(head.timestamp),
      },
      rpc: { head: chainHead === null ? null : chainHead.toString(), reachable: rpcOk },
      lag: {
        blocks: lagBlocks.toString(),
        seconds: lagSeconds === null ? null : lagSeconds.toString(),
      },
      vault: {
        address: VAULT,
        phase: state?.phase ?? null,
        phaseName: state === null ? null : (PHASE_NAMES[state.phase] ?? "Unknown"),
        cycle: state?.cycleNumber ?? 0,
        writesHalted: state?.writesHalted ?? null,
        // The last block in which this vault did anything. Not the keeper's own heartbeat —
        // the keeper runs its own /health; this is the on-chain evidence it is alive.
        lastActivityBlock: (state?.lastBlock ?? 0n).toString(),
        lastActivityAt: iso(state?.lastTimestamp ?? null),
      },
      // The relay is only usable when a shared secret is configured; without one
      // POST /v1/overcall/list answers 503, so reporting `true` unconditionally would be a lie
      // to whatever is watching this endpoint.
      relay: { keeperAuthConfigured: KEEPER_HMAC_SECRET !== undefined },
    }),
    status === "degraded" ? 503 : 200,
  );
});

/*//////////////////////////////////////////////////////////////
                   POST /v1/overcall/list
//////////////////////////////////////////////////////////////*/

/**
 * Keeper-only relay into Overcall's order book.
 *
 * Why it exists at all: the keeper could POST to Overcall directly, and in a pinch it does.
 * Routing through here means the publish is logged next to the indexed listing, the relay can
 * be rate-limited in one place, and the keeper box never needs an outbound allowlist entry
 * for a third-party domain it does not otherwise talk to.
 *
 * Authentication is HMAC-SHA256 over `${timestamp}.${rawBody}`, compared in constant time.
 * See lib hmac.ts. The body must offer from OUR vault; this is not an open proxy.
 *
 * The response is Overcall's own, verbatim — status and body — because their 409/422 text is
 * exactly what the keeper needs to decide whether to retry, re-read the counter, or give up.
 */
app.post("/v1/overcall/list", async (c) => {
  const rawBody = await c.req.text();

  const auth = verifyKeeperHmac(c.req.raw.headers, rawBody);
  if (!auth.ok) {
    // A bad signature on the one mutating route is worth a record — it is either a
    // misconfigured keeper or somebody probing. The 5xx case is just "relay disabled".
    if (auth.status !== 503) {
      log.warn({ status: auth.status, reason: auth.error }, "overcall relay rejected a bad signature");
    }
    return c.json({ error: auth.error }, auth.status);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Body is not valid JSON." }, 400);
  }

  const validation = validateRelayBody(parsed);
  if (!validation.ok) {
    return c.json({ error: validation.error }, 400);
  }

  try {
    const result = await forwardToOvercall(validation.body);

    if (!result.ok) {
      // OVERCALL_POST_REJECTED from ops/alerts.md — their `error` string is the useful part
      // and it is returned verbatim below; the log keeps it after the retry storm has passed.
      const upstreamError =
        typeof result.body === "object" && result.body !== null && "error" in result.body
          ? String((result.body as { error: unknown }).error)
          : undefined;
      log.warn(
        { upstreamStatus: result.status, upstreamError },
        "overcall refused a relayed listing",
      );
    }

    // Overcall answers `{"listing": {...}}`; unwrap it so the keeper reads `listing.orderHash`
    // at the same depth it would from a direct POST.
    const upstream =
      typeof result.body === "object" && result.body !== null && "listing" in result.body
        ? (result.body as { listing: unknown }).listing
        : result.body;

    return sendJson(
      c,
      {
        forwardedTo: result.url,
        // 201 on insert, 200 on a repeat of the same order hash — Overcall is idempotent by
        // order hash, so a keeper retry after a timeout is safe.
        upstreamStatus: result.status,
        listing: result.ok ? upstream : null,
        error: result.ok ? null : upstream,
      },
      result.ok ? 200 : 502,
    );
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "overcall unreachable from the relay",
    );
    return c.json(
      {
        error: "Could not reach Overcall.",
        detail: err instanceof Error ? err.message : String(err),
      },
      504,
    );
  }
});

/*//////////////////////////////////////////////////////////////
                          GRAPHQL + ROOT
//////////////////////////////////////////////////////////////*/

// Ponder generates a GraphQL API from ponder.schema.ts for free. It is the escape hatch for
// any query the REST routes above do not cover.
app.use("/graphql", graphql({ db, schema }));

app.get("/", (c) =>
  c.json({
    name: "callhouse-indexer",
    chain: { id: CHAIN_ID, name: CHAIN_NAME },
    addresses: ADDRESSES,
    routes: [
      "GET  /v1/vault",
      "GET  /v1/cycles",
      "GET  /v1/cycles/:cycle",
      "GET  /v1/activity",
      "GET  /v1/account/:addr",
      "GET  /v1/listings",
      "GET  /v1/listings/:hash",
      "GET  /v1/snapshots",
      "GET  /v1/health",
      "POST /v1/overcall/list",
      "POST /graphql",
    ],
  }),
);

export default app;
