import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono, type Context as HonoContext } from "hono";
import { logger as honoLogger } from "hono/logger";
import { and, desc, eq, graphql, sql } from "ponder";
import { getAddress, isAddress, type Address } from "viem";

import { ACC_PRECISION, ASSET, CHAIN_ID, CHAIN_NAME, CLEARINGHOUSE, SEAPORT, USDG, VAULT, WAD } from "../../lib/env";
import { capacity, entryStrandShare } from "../../lib/lifecycle";
import { ROLE_DEFAULT_ADMIN, ROLE_GUARDIAN, ROLE_KEEPER } from "../../lib/roles";
import { cache15s } from "./cache";
import { readAccountLive, readChainHead, readOraclePaused, readVaultLive } from "./chain";
import { asset, iso, num, toJson, usdg } from "./serialize";

const app = new Hono();

// One line per request: method, path, status, milliseconds. Every route is a public GET, so
// paths are safe to log verbatim.
app.use(honoLogger());

/*//////////////////////////////////////////////////////////////
                           CONSTANTS
//////////////////////////////////////////////////////////////*/

const PHASE_NAMES = ["Idle", "Listed", "Exercisable", "Settling"] as const;

/**
 * The `?status=` values the list routes accept: exactly the schema's enums (X-2). Exported so
 * `src/api/index.test.ts` can pin them to `ponder.schema.ts`; a value added to one side without
 * the other is either unreachable through the API or a 400 for a status the tape really uses.
 */
export const CYCLE_STATUSES = ["listed", "filled", "unfilled", "assigned", "closed", "stranded"] as const;
type CycleStatus = (typeof CYCLE_STATUSES)[number];

export const LISTING_STATUSES = ["approved", "partially_filled", "filled", "cancelled"] as const;
type ListingStatus = (typeof LISTING_STATUSES)[number];

const ONE = 10n ** 18n;
const ZERO_HASH = `0x${"0".repeat(64)}`;

/** X-1: the vault's `listingHash()` is `bytes32(0)` when nothing is live; the wire says null, never a zero hash. */
const hashOrNull = (h: `0x${string}` | null | undefined): `0x${string}` | null =>
  h === null || h === undefined || h.toLowerCase() === ZERO_HASH ? null : h;

/**
 * `/v1/vault.week.option`'s two ids. The vault's `optionId()` and `claimKey()` answer 0 for
 * "none" — `claimKey` is 0 while Listed before the first fill (nothing is written at arm) and
 * after a redeem; `optionId` is 0 after an unfilled close and after a redeem — and a successful
 * Multicall read of 0 is `0n`, which `??` does not treat as absent. Published as-is that put
 * `"0"` on the wire for most of every week, where every other route says null for none
 * (`cycle.written.claimKey`, GraphQL `vaultState`, X-1's listing hash). Zero is absent: the
 * live id if there is one, else the week's own row, else null.
 */
export function weekOptionIds(
  live: { optionId: bigint | null; claimKey: bigint | null },
  row: { optionId: bigint | null; claimKey: bigint | null } | null,
): { optionId: string | null; claimKey: string | null } {
  const present = (v: bigint | null | undefined): bigint | null => (v === null || v === undefined || v === 0n ? null : v);
  const optionId = present(live.optionId) ?? present(row?.optionId);
  const claimKey = present(live.claimKey) ?? present(row?.claimKey);
  return { optionId: optionId === null ? null : optionId.toString(), claimKey: claimKey === null ? null : claimKey.toString() };
}

/**
 * `/v1/account/:addr.strand`: the owner's pending share of a stranded claim, in its two places.
 *
 *   staged   `owedStrandWad` / `owedStrandGen`: already moved out of an epoch onto the owner.
 *   epoch    the part of the owner's queued epoch's `EpochStrandShare` that THIS OWNER's entry will
 *            take when it settles. Exactly `Vault._settleEpochEntry` (and `previewCompleteRedeem`):
 *            `w × shares / sharesRemaining`, the last claimant taking the rest. Not the epoch's
 *            whole remaining WAD — that is every queuer's, and publishing it to each of them
 *            overstated each owner's share by `sharesRemaining / shares`. Only an epoch that has
 *            settled (`epochId < vault epochId`) with a strand share (`strandGen` set) has one.
 *
 * The two can belong to different generations (a staged share of a resolved generation, and an
 * entry in an epoch that settled under a later strand), so each carries its own: `gen` is the
 * staged share's generation when one is staged and the epoch's otherwise (the one `recovered`
 * and `strand` describe), and `epochGen` is always the epoch share's.
 */
export function accountStrand(input: {
  stagedWad: bigint;
  stagedGen: bigint | null;
  epochId: bigint | null;
  currentEpoch: bigint;
  queuedShares: bigint;
  epoch: { strandGen: bigint | null; sharesSettled: bigint; sharesClaimed: bigint; strandWad: bigint; strandWadClaimed: bigint } | null;
}): { wad: bigint; gen: bigint | null; epochWad: bigint; epochGen: bigint | null } {
  const { stagedWad, stagedGen, epochId, currentEpoch, queuedShares, epoch } = input;
  const settledWithShare =
    epoch !== null && epoch.strandGen !== null && epochId !== null && epochId !== 0n && epochId < currentEpoch && queuedShares > 0n;
  const epochWad = settledWithShare ? entryStrandShare(epoch, queuedShares) : 0n;
  const epochGen = settledWithShare ? epoch.strandGen : null;
  return { wad: stagedWad, gen: stagedWad > 0n ? stagedGen : epochGen, epochWad, epochGen };
}

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
  clearinghouse: CLEARINGHOUSE,
  seaport: SEAPORT,
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
type StrandRow = typeof schema.strand.$inferSelect;

/**
 * The public shape of a week.
 *
 * Note what is ALWAYS present, even on a week nobody bought: `contractsSold: 0`,
 * `premiumGross: 0`, `premiumNet: 0`, `fee: 0`, `status: "unfilled"`. An unfilled week is the
 * most likely outcome and it is published, not hidden. Equally always present, and zero on
 * every week that was not assigned: `harvest.strikeProceedsUsdg`, so premium and returned
 * principal never have to be told apart by subtraction on the consumer's side.
 *
 * The `option` group replaced the pre-redesign `registry` group: the window comes from the
 * armed Valorem option type, read from the vault at `RollOpen`, and there are no rungs, no lot
 * size and no announcement. A week the vault never armed has no row at all.
 */
export function cycleJson(c: CycleRow) {
  return {
    cycle: c.cycleNumber,
    status: c.status,
    // The vault's own count (`CallsWritten`), the same figure the status was decided on. Seaport's
    // `fill.contractsSold` below is its cross-check and equal by construction.
    filled: c.contractsWritten > 0n,
    assigned: c.contractsAssigned > 0n,
    stranded: c.stranded,

    option: {
      exerciseTimestamp: num(c.exerciseTimestamp),
      exerciseAt: iso(c.exerciseTimestamp),
      expiryTimestamp: num(c.expiryTimestamp),
      expiryAt: iso(c.expiryTimestamp),
    },

    written: {
      optionId: c.optionId === null ? null : c.optionId.toString(),
      claimKey: c.claimKey === null ? null : c.claimKey.toString(),
      strikeUsdg: usdg(c.strikeUsdg),
      // The sum of every fill's `CallsWritten`. Under write on fill this equals `fill.contractsSold`.
      contracts: num(c.contractsWritten),
      collateral: asset(c.collateral),
      writeCount: c.writeCount,
      openedAt: iso(c.openedAt),
      txOpen: c.txOpen,
      firstWriteAt: iso(c.firstWriteAt),
      lastWriteAt: iso(c.lastWriteAt),
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
      // Seaport's count. The cross-check of `written.contracts`; equal by construction.
      contractsSold: num(c.contractsSold),
      fillCount: c.fillCount,
      // What buyers paid, which is what reached the vault: one consideration item, no venue cut.
      premiumGross: usdg(c.premiumGross),
      unitPriceUsdg: usdg(c.fillUnitPriceUsdg),
      firstFillAt: iso(c.firstFillAt),
      lastFillAt: iso(c.lastFillAt),
    },

    settlement: {
      lockedAt: iso(c.lockedAt),
      contractsAssigned: num(c.contractsAssigned),
      // The whole strike USDG the claim returned. 0 while stranded; set at recovery.
      assignmentUsdg: usdg(c.assignmentUsdg),
      assetsReturned: asset(c.assetsReturned),
      // Market-wide exercise against this option type. Our assignment is a bucket lottery,
      // resolved only at the close, so this is a signal and not a claim about us.
      marketExercised: num(c.marketExercised),
      bucketIndex: c.bucketIndex === null ? null : c.bucketIndex.toString(),
      bucketAssigned: num(c.bucketAssigned),
      closedAt: iso(c.closedAt),
      txClose: c.txClose,
      // The stranded close (AF-02): the claim could not be redeemed at `rollClose`. Null on
      // every week that closed normally; `recoveredAt` null while the claim is still stranded.
      strand:
        c.strandGen === null
          ? null
          : {
              gen: c.strandGen.toString(),
              recovered: c.recoveredAt !== null,
              recoveredAt: iso(c.recoveredAt),
              recoveredTx: c.recoveredTx,
            },
    },

    // Premium and strike proceeds are published SEPARATELY (W-21). On an assigned week the
    // vault's harvest sweeps both, but the strike proceeds are returned principal — collateral
    // that left at the strike and came back as USDG — and must never be read as yield. Every
    // field named `premium*` is premium only; `creditedUsdg` and `usdgPerShare` are the whole
    // amount credited to holders and are NOT a return.
    harvest: {
      harvested: c.harvested,
      // The vault's whole USDG take: premium that filled plus any strike proceeds.
      grossUsdg: usdg(c.harvestGross),
      // grossUsdg − strikeProceedsUsdg: premium as harvested. Equals `fill.premiumGross` once
      // every fill's USDG has been swept (there is no venue cut between the two).
      premiumGross: usdg(c.harvestPremiumGross),
      // The strike-proceeds part of the harvests: `RollClose.usdgFromAssignment`, plus the live
      // shares' part of a recovered stranded claim. The queue's part of a recovered claim is
      // reserved directly and never passes through a harvest, so after a strand this can sit
      // below `settlement.assignmentUsdg`.
      strikeProceedsUsdg: usdg(c.strikeProceeds),
      // Charged on the premium part only; strike proceeds are never fee'd, so on an assigned
      // week fee / grossUsdg is not the policy rate. fee / premiumGross is.
      fee: usdg(c.fee),
      // premiumGross − fee. PREMIUM ONLY.
      premiumNet: usdg(c.premiumNet),
      // premiumNet + strikeProceedsUsdg: everything the Distributor credited to holders.
      creditedUsdg: usdg(c.creditedUsdg),
      // premiumNet per whole share, summed per sweep. The per-share premium figure.
      premiumNetPerShare: usdg(c.premiumNetPerShare),
      // creditedUsdg per whole share, summed per sweep. Includes strike proceeds.
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
    // The one consideration item: USDG to the vault, an exact multiple of `contracts`.
    grossUsdg: usdg(l.grossUsdg),
    unitPriceUsdg: usdg(l.unitPriceUsdg),
    fill: {
      contractsFilled: num(l.contractsFilled),
      fillCount: l.fillCount,
      proceedsUsdg: usdg(l.proceedsUsdg),
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

export function harvestJson(h: HarvestRow) {
  return {
    cycle: h.cycleNumber,
    // true = the end-of-cycle harvest inside `rollClose` (the week's verdict).
    // false = a checkpoint (deposit, mint, settleQueue) or the retry of a stranded claim.
    terminal: h.terminal,
    origin: h.origin,
    filled: h.filled,
    // The event's three amounts, verbatim. `netUsdg` includes strike proceeds on the terminal
    // harvest of an assigned week and on a retry harvest.
    grossUsdg: usdg(h.grossUsdg),
    fee: usdg(h.feeUsdg),
    netUsdg: usdg(h.netUsdg),
    // This event split (lib/harvest.ts): premium only, and the strike proceeds beside it.
    premiumGross: usdg(h.premiumGrossUsdg),
    strikeProceedsUsdg: usdg(h.strikeProceedsUsdg),
    premiumNet: usdg(h.premiumNetUsdg),
    assignmentUsdg: usdg(h.assignmentUsdg),
    contractsSold: num(h.contractsSold),
    contractsAssigned: num(h.contractsAssigned),
    // premiumNet per whole share: the per-share premium figure.
    premiumNetPerShare: usdg(h.premiumNetPerShare),
    // netUsdg per whole share. Includes strike proceeds; not a premium figure.
    usdgPerShare: usdg(h.usdgPerShare),
    supply: asset(h.supply),
    accUsdgPerShare: h.accUsdgPerShare.toString(),
    at: iso(h.timestamp),
    txHash: h.txHash,
  };
}

export function strandJson(s: StrandRow) {
  return {
    gen: s.gen.toString(),
    cycle: s.cycleNumber,
    claimKey: s.claimKey.toString(),
    strandedAt: iso(s.strandedAt),
    strandedTx: s.strandedTx,
    // WAD (of 1e18) of the claim owned by settled queue epochs, and how many took a share.
    epochWad: s.epochWad.toString(),
    epochCount: s.epochCount,
    recovered: s.recovered,
    recoveredAt: iso(s.recoveredAt),
    recoveredTx: s.recoveredTx,
    // What the redeem returned, and the queue's part of it still to be collected.
    assetsIn: asset(s.assetsIn),
    usdgIn: usdg(s.usdgIn),
    queueWad: s.queueWad.toString(),
    wadLeft: s.wadLeft.toString(),
    assetsLeft: asset(s.assetsLeft),
    usdgLeft: usdg(s.usdgLeft),
    settledCount: s.settledCount,
  };
}

/*//////////////////////////////////////////////////////////////
                          GET /v1/vault
//////////////////////////////////////////////////////////////*/

/**
 * TVL, phase, and this week: strike, listing, fill, capacity, the stranded-claim state.
 *
 * Indexed state is the base; a live read is layered on top for the few facts events cannot
 * carry (Valorem's live position, the oracle, the deposit gate, capacity). If the RPC is down
 * the route still answers from the index with `live: false` rather than failing.
 */
app.get("/v1/vault", cache15s, async (c) => {
  const state = await loadState();

  const [live, oraclePaused] = await Promise.all([readVaultLive(), readOraclePaused()]);

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
    state !== null && state.cycleNumber !== 0 ? state.cycleNumber : (live.cycleNumber ?? 0);

  const thisCycle =
    thisCycleNumber === 0
      ? null
      : await db
          .select()
          .from(schema.cycle)
          .where(eq(schema.cycle.cycleNumber, thisCycleNumber))
          .limit(1)
          .then((r) => r[0] ?? null);

  // The last terminal harvest: one `rollClose`'s sweep. A checkpoint or a retry is not a
  // result and must never be shown as one. (X-3: this used to be called `lastWeek`, which it
  // is not when a week was swept in more than one go — the week's total is the cycle row.)
  const lastHarvest = await db
    .select()
    .from(schema.harvest)
    .where(eq(schema.harvest.terminal, true))
    .orderBy(desc(schema.harvest.blockNumber))
    .limit(1)
    .then((r) => r[0] ?? null);

  // The last CLOSED week, whole: every sweep summed, and the verdict.
  const lastClosedCycle = await db
    .select()
    .from(schema.cycle)
    .where(eq(schema.cycle.harvested, true))
    .orderBy(desc(schema.cycle.cycleNumber))
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
  const stranded = live.isStranded ?? state?.stranded ?? false;
  const contractsWritten = live.contractsWritten ?? state?.contractsWritten ?? 0n;
  const queuedShares = live.queuedShares ?? state?.queuedShares ?? 0n;

  // Capacity: `Policy.maxContracts(totalAssets) − contractsWritten`. There is no inventory and no
  // `contractsRemaining` view under write on fill; this is what the next listing may offer and
  // what the fill gate would still admit (re-sized at every fill against NAV then).
  const cap =
    live.policy === null ? null : capacity(live.policy, totalAssets, contractsWritten);

  const stateStrand =
    state !== null && state.strandedCycleNumber !== null
      ? await db
          .select()
          .from(schema.strand)
          .where(eq(schema.strand.cycleNumber, state.strandedCycleNumber))
          .orderBy(desc(schema.strand.gen))
          .limit(1)
          .then((r) => r[0] ?? null)
      : null;

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
        // `maxDeposit() == 0` is the whole deposit gate in one bit: phase, exercise window,
        // unclaimed assignment, stranded claim, unbacked reserve, share-price floor.
        depositsOpen: live.maxDeposit === null ? null : live.maxDeposit > 0n,
        valoremFeeAccepted: live.valoremFeeAccepted ?? state?.valoremFeeAccepted ?? false,
        // Clear's own fee switch, live. On, and not accepted above, means no arm and no fill
        // until governance flips one of the two; null when the clearinghouse could not be read.
        clearFeesEnabled: live.clearFeesEnabled,
        // The issuer's two levers. A paused oracle makes `rollOpen` and every fill revert — no
        // price, no write. A transfer pause freezes the token itself and stops deposits,
        // redemptions and settlement alike; nothing in this system can route around that.
        oraclePaused: oraclePaused ?? state?.oraclePaused ?? false,
        tokenPaused: state?.tokenPaused ?? false,
        // Seconds. Days, not hours, on purpose: the NVDA/USD feed only moves while the US
        // equity market is open, so a ~52h weekend gap is normal and Friday's close IS spot.
        maxPriceAgeSeconds: state?.maxPriceAge ?? 0,
      },

      // The stranded-claim state machine (AF-02). While `stranded`, deposits and instant
      // redemption are shut, `rollOpen` refuses, the queue still settles on the idle balance,
      // and anyone may call `retryStrandedClaim()`.
      stranded: {
        stranded,
        gen: (live.strandGen ?? state?.strandGen ?? 0n).toString(),
        lastResolvedGen: (live.lastResolvedGen ?? state?.lastResolvedGen ?? 0n).toString(),
        // The part of the claim live shares still own, of 1e18. NAV counts the locked
        // collateral scaled by this.
        remainingWad: (live.strandedRemainingWad ?? state?.strandedRemainingWad ?? 0n).toString(),
        wad: WAD.toString(),
        cycle: state?.strandedCycleNumber ?? null,
        claimKey: stateStrand === null ? null : stateStrand.claimKey.toString(),
        since: stateStrand === null ? null : iso(stateStrand.strandedAt),
        // Locked collateral the claim still holds, raw (`lockedAssets()`), while stranded.
        lockedAssets: stranded ? asset(live.lockedAssets ?? state?.lockedCollateral ?? 0n) : null,
      },

      tvl: {
        totalAssets: asset(totalAssets),
        idleAssets: asset(live.idleAssets ?? indexedIdle),
        // Live reads Valorem's position, so this falls as buyers are assigned after exercise.
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
        protocolFeeBps: live.policy?.protocolFeeBps ?? state?.protocolFeeBps ?? 0,
        feeRecipient: state?.feeRecipient ?? null,
      },

      queue: {
        queuedShares: asset(queuedShares),
        epochId: (state?.epochId ?? 1n).toString(),
        // `settleQueue()` is permissionless while Idle with shares queued: the flat exit, and
        // the only exit while a claim is stranded.
        canSettle: phaseCode === 0 && queuedShares > 0n,
      },

      week: {
        cycle: thisCycle === null ? null : cycleJson(thisCycle),
        // The armed option, as the vault holds it. The vault is the clock: fills stop and
        // `lockBook` opens at `exerciseAt`, `rollClose` at `expiryAt`. No registry.
        option: {
          // 0 from the vault's view means none: the live id, else the week's row, else null.
          ...weekOptionIds(live, thisCycle),
          strikeUsdg: usdg(live.cycleStrikeUsdg ?? state?.strikeUsdg ?? 0n),
          exerciseTimestamp: num(live.cycleExerciseTs ?? state?.exerciseTimestamp ?? 0n),
          exerciseAt: iso(live.cycleExerciseTs ?? state?.exerciseTimestamp ?? 0n),
          expiryTimestamp: num(live.cycleExpiryTs ?? state?.expiryTimestamp ?? 0n),
          expiryAt: iso(live.cycleExpiryTs ?? state?.expiryTimestamp ?? 0n),
        },
        // Index-first, like everything else here: the live read is preferred because a
        // listing can be cancelled without the vault emitting anything the indexer has yet
        // processed, but a dead RPC falls back to the cycle row rather than reporting zeros
        // for a listing that is demonstrably on the book.
        listing: {
          hash: live.listingHash !== null ? hashOrNull(live.listingHash) : hashOrNull(state?.listingHash),
          contracts: num(live.listingAmount ?? thisCycle?.listedContracts ?? 0n),
          grossUsdg: usdg(live.listingGrossUsdg ?? thisCycle?.listedGrossUsdg ?? 0n),
          listingsThisCycle: live.listingsThisCycle ?? state?.listingsThisCycle ?? 0,
          maxListingsPerCycle: 3,
        },
        assignmentLive: {
          // Straight from `clear.claim().amountExercised / 1e18`, so it is a contract count.
          contractsAssigned: num(live.contractsAssigned ?? 0n),
          // Written == sold. The sum of this cycle's fills.
          contractsWritten: num(contractsWritten),
          // `Policy.maxContracts(totalAssets) − contractsWritten`: what a listing may still
          // offer. Null when the policy could not be read live.
          capacity: cap === null ? null : num(cap),
        },
      },

      lastHarvest: lastHarvest === null ? null : harvestJson(lastHarvest),
      lastClosedCycle: lastClosedCycle === null ? null : cycleJson(lastClosedCycle),

      lifetime: {
        // Cycles ARMED. Nothing is written at arm, so this counts weeks the keeper opened.
        cyclesArmed: state?.cyclesWritten ?? 0,
        cyclesFilled: state?.cyclesFilled ?? 0,
        cyclesUnfilled: state?.cyclesUnfilled ?? 0,
        cyclesAssigned: state?.cyclesAssigned ?? 0,
        cyclesStranded: state?.cyclesStranded ?? 0,
        // What buyers paid on every fill; one consideration item, so it is what the vault got.
        premiumGross: usdg(state?.lifetimePremiumGross ?? 0n),
        // Strike USDG the claims returned, stranded recoveries included.
        assignmentUsdg: usdg(state?.lifetimeAssignmentUsdg ?? 0n),
        protocolFee: usdg(state?.lifetimeProtocolFee ?? 0n),
        // Premium after the protocol fee. PREMIUM ONLY (W-21).
        premiumNet: usdg(state?.lifetimePremiumNet ?? 0n),
        // Strike proceeds swept by harvests: returned principal, not premium.
        strikeProceedsUsdg: usdg(state?.lifetimeStrikeProceeds ?? 0n),
        // premiumNet + strikeProceedsUsdg: everything credited to holders.
        creditedUsdg: usdg(state?.lifetimeCreditedUsdg ?? 0n),
        // Asset base units settled redeemers were booked and not paid (AF-05 haircuts).
        haircutAssets: asset(state?.lifetimeHaircutAssets ?? 0n),
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
 * Every week the vault ever armed is here, including the ones it armed and nobody bought
 * (`status: "unfilled"`, every money field 0) and the ones whose close stranded the claim
 * (`status: "stranded"` until the retry lands). That is the point of the route.
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
        armed: state?.cyclesWritten ?? 0,
        filled: state?.cyclesFilled ?? 0,
        unfilled: state?.cyclesUnfilled ?? 0,
        assigned: state?.cyclesAssigned ?? 0,
        stranded: state?.cyclesStranded ?? 0,
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

  const strands = await db
    .select()
    .from(schema.strand)
    .where(eq(schema.strand.cycleNumber, n))
    .orderBy(desc(schema.strand.gen));

  return sendJson(
    c,
    toJson({
      addresses: ADDRESSES,
      cycle: cycleJson(row),
      listings: listings.map(listingJson),
      harvests: harvests.map(harvestJson),
      strands: strands.map(strandJson),
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
 * field 0. `?include=all` adds the checkpoint rows (`origin: "checkpoint"`: premium swept into
 * the index ahead of a deposit or a flat queue settlement) and the retry rows (`origin:
 * "retry"`: a stranded claim's strike USDG arriving late), which are money but not results.
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
 * Shares, claimable USDG, queued position, and any share of a stranded claim.
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

  // A share of a stranded claim, staged when the owner's entry settled while the claim was
  // stranded, or still waiting inside the owner's settled epoch (this owner's pro-rata part of it,
  // not the epoch's whole WAD). It becomes assets and USDG only once the generation is redeemed;
  // until then `previewCompleteRedeem` quotes it as nothing.
  const queuedShares = live.queuedShares ?? indexed?.queuedShares ?? 0n;
  const pending = accountStrand({
    stagedWad: live.strandWad ?? indexed?.strandWad ?? 0n,
    stagedGen: live.strandGen ?? indexed?.strandGen ?? null,
    epochId,
    currentEpoch,
    queuedShares,
    epoch,
  });
  const strandWad = pending.wad;
  const epochStrandWad = pending.epochWad;
  const pendingGen = pending.gen;
  const strandRow =
    pendingGen === null || pendingGen === 0n
      ? null
      : await db
          .select()
          .from(schema.strand)
          .where(eq(schema.strand.gen, pendingGen))
          .limit(1)
          .then((r) => r[0] ?? null);

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
        queuedShares: asset(queuedShares),
        epochId: epochId === null ? null : epochId.toString(),
        // An epoch only pays once the cycle it sat through has closed and settled.
        settled: epoch !== null && epoch.status === "settled",
        claimable: epochId !== null && epochId !== 0n && epochId < currentEpoch,
        // What `completeRedeem` pays now: haircut applied, recovered strand shares folded in.
        previewAssets: asset(live.previewAssets ?? 0n),
        previewUsdg: usdg(live.previewUsdg ?? 0n),
        epochSettledAt: epoch === null ? null : iso(epoch.settledAt),
        // USDG booked to this owner that a payout could not move (AF-03). Still owed.
        deferredUsdg: usdg(indexed?.deferredUsdg ?? 0n),
      },

      // The owner's pending share of a stranded claim (AF-02), if any: staged against the owner
      // (`wad`, generation `gen`) or this owner's part of the settled epoch they queued into
      // (`epochWad`, generation `epochGen`), which their entry takes on settlement.
      strand:
        strandWad === 0n && epochStrandWad === 0n
          ? null
          : {
              gen: pendingGen === null ? null : pendingGen.toString(),
              wad: strandWad.toString(),
              epochWad: epochStrandWad.toString(),
              epochGen: pending.epochGen === null ? null : pending.epochGen.toString(),
              // Redeemed: the share is worth `assetsIn × wad / 1e18` and `usdgIn × wad / 1e18`
              // and `queue.preview*` already include it. Not yet: it is quoted as nothing.
              recovered: strandRow?.recovered ?? false,
              strand: strandRow === null ? null : strandJson(strandRow),
            },

      lifetime: {
        deposited: asset(indexed?.depositedAssets ?? 0n),
        withdrawn: asset(indexed?.withdrawnAssets ?? 0n),
        redeemedAssets: asset(indexed?.redeemedAssets ?? 0n),
        redeemedUsdg: usdg(indexed?.redeemedUsdg ?? 0n),
        claimedUsdg: usdg(indexed?.claimedUsdg ?? 0n),
        // Booked and not paid because the reserve was unbacked (AF-05). Permanent.
        haircutAssets: asset(indexed?.haircutAssets ?? 0n),
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
      liveHash: hashOrNull(state?.listingHash),
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
                        GET /v1/strands
//////////////////////////////////////////////////////////////*/

/** Every stranded claim, newest first: when it stranded, who owns what of it, whether it recovered. */
app.get("/v1/strands", cache15s, async (c) => {
  const limit = clampLimit(c.req.query("limit"), 50, 500);
  const offset = clampOffset(c.req.query("offset"));

  const rows = await db
    .select()
    .from(schema.strand)
    .orderBy(desc(schema.strand.gen))
    .limit(limit)
    .offset(offset);

  const state = await loadState();

  return sendJson(
    c,
    toJson({
      addresses: ADDRESSES,
      stranded: state?.stranded ?? false,
      count: rows.length,
      limit,
      offset,
      strands: rows.map(strandJson),
    }),
  );
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
        stranded: s.stranded,
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
        // STRANDED_CLAIM from the relay's alert list: the one state that needs a human to know.
        stranded: state?.stranded ?? null,
        // The last block in which this vault did anything. Not the keeper's own heartbeat —
        // the keeper runs its own /health; this is the on-chain evidence it is alive.
        lastActivityBlock: (state?.lastBlock ?? 0n).toString(),
        lastActivityAt: iso(state?.lastTimestamp ?? null),
      },
    }),
    status === "degraded" ? 503 : 200,
  );
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
      "GET  /v1/strands",
      "GET  /v1/snapshots",
      "GET  /v1/health",
      "POST /graphql",
    ],
  }),
);

export default app;
