/**
 * What every API route must say, built from the keeper dry run's record (run.json) and the fork's
 * own logs and views (chain.ts). Pure: no network, no Ponder.
 *
 * Precedence. The chain is the authority for every figure the API publishes: the expectations are
 * derived from logs and views the way the product defines them (README "The money columns the
 * site quotes"), never copied from the indexer's lib/harvest.ts, so an arithmetic slip in the
 * indexer cannot agree with itself. run.json is the keeper's own account of what it drove, and
 * every figure it records is cross-checked against the chain into `disagreements`; the run fails
 * on any of them, because a dry run that misdescribes its own week is not a dry run.
 *
 * THE DRY RUN THIS EXPECTS (write on fill, no registry): `pnpm --filter @callhouse/keeper dryrun`
 * (keeper/src/dryrun.ts) deploys the vault on the REAL Clear and Seaport of the fork and arms
 * weeks with `rollOpen(id)` on option types the keeper created itself, in order, each one of
 *
 *   unfilled    listed, nobody bought, the listing invalidated at `lockBook`, a zero harvest;
 *   assigned    bought in several fills (each fill its own `CallsWritten`), some contracts
 *               exercised and assigned at the strike, a deposit while Listed (a checkpoint
 *               harvest), a queued redeem settled at the close and collected;
 *   stranded    bought, then the USDG issuer froze the vault so `rollClose` could not redeem
 *               the claim (`ClaimStranded`, zero legs, the queue's epoch taking its share), then
 *               unfrozen and `retryStrandedClaim` redeemed it (`StrandedClaimRecovered`, the
 *               retry's `Harvest` under the stranded cycle's number) and the shares were paid;
 *   armed       the LAST week may still be open at the run's last block: armed and listed, not
 *               closed. The keeper's run ends exactly so (week 4 Listed after the recovery), and
 *               that end state is worth asserting: `/v1/vault.week` is that week, and the
 *               lifetime tallies count it as armed but not as filled or unfilled.
 *
 * Nothing here assumes which cycle number is which scenario: every week is derived from what its
 * logs say, and the scenario-specific checks switch on the logs (a `ClaimStranded` present, a
 * fill present, a `RollClose` present).
 *
 * THE RECORD IS THE KEEPER'S OWN SHAPE. run.json carries one key per week, `cycle1` .. `cycleN`
 * (`KeeperCycle` below, exactly what dryrun.ts writes), not an array. `runCycles` reads those keys
 * in order and normalises each into a `RunCycle`, failing loudly with the path of any field it
 * needs and did not find, so a keeper that changes its record shape is caught before a single
 * expectation is compared. `expected.test.ts` builds its fixture in the same shape, copied from a
 * real passing run.
 */
import { formatUnits, keccak256, toHex } from "viem";

import type { ChainCycle, ChainFacts, ChainHarvest, ChainListing, ChainStrand } from "./chain.ts";
import type { Expectation, Json } from "./diff.ts";

/*//////////////////////////////////////////////////////////////
                       run.json (the fields read)
//////////////////////////////////////////////////////////////*/

/** A decimal figure as run.json stores it: most are strings, a few counts are numbers. */
type Num = string | number;

/** One Seaport fill of the week's listing, as keeper/src/dryrun.ts records it in `cycleN.fills[]`. */
export type KeeperFill = {
  buyer?: string;
  /** Contracts moved; equals the fill's `CallsWritten.contractsCount`. */
  contracts: Num;
  tx: string;
  block?: Num;
  /** The one USDG consideration item, to the vault. */
  premium: Num;
};

/**
 * One week as keeper/src/dryrun.ts records it under `cycleN`. Only the fields read here are
 * typed; the record carries more (queue legs, the listed deposit, balances) for its own report.
 * A week still armed at the run's last block has only its arm: no `lockTx`, `rollCloseTx` or
 * `harvest`.
 */
export type KeeperCycle = {
  /** The armed Valorem option id, decimal. */
  optionId: string;
  strikeUsdg6: Num;
  exerciseTimestamp: Num;
  expiryTimestamp: Num;
  rollOpenTx: string;
  approveTx?: string;
  orderHash?: string;
  /** Sum of the fills; "0" on an unfilled week. Absent while the week is still open. */
  contracts?: Num;
  /** Absent on an unfilled week and on an open one with no buyer. */
  fills?: KeeperFill[];
  lockTx?: string;
  rollCloseTx?: string;
  /**
   * The keeper's cycle row once the week is done (closed, or recovered after a strand): gross, fee
   * and net SUMMED over every `Harvest` carrying the cycle's number from its `rollOpen` block to the
   * close (the retry, after a strand) — keeper/src/roll.ts `harvestForCycle` — and what the claim
   * returned: `RollClose`'s legs on an ordinary close, `StrandedClaimRecovered`'s after a strand.
   */
  harvest?: {
    gross: Num;
    fee: Num;
    net: Num;
    assetsReturned: Num;
    usdgFromAssignment: Num;
    /** `RollClose.contractsAssignedCount`. */
    contractsAssigned: Num;
    /** How many `Harvest` logs that sum covered. */
    harvestEvents?: number;
  };
  /** Present when the close stranded the claim. `harvestAtClose` is the terminal `Harvest` alone. */
  strand?: { rollCloseTx: string; gen: Num; claimKey: string; harvestAtClose?: { gross: Num; fee: Num; net: Num } };
  /** Present once `retryStrandedClaim` redeemed the stranded claim. `harvest` is the retry's `Harvest` alone. */
  recovery?: { retryTx: string; assets: Num; usdgOut: Num; queueWad: Num; harvest?: { gross: Num; fee: Num } };
};

export type RunJson = {
  forkBlock: string;
  chainId: number;
  error: string | null;
  /** `admin` and `keeper` hold the two roles; `depositor` is the account `/v1/account` is checked for. */
  actors: { admin: string; keeper: string; depositor: string } & Record<string, string>;
  addresses: { Vault: string } & Record<string, string>;
  /** The vault's deploy block (START_BLOCK) and the block of the run's last transaction (END_BLOCK). */
  blocks: { vaultDeployBlock: Num; lastBlock: Num };
} & { [week: `cycle${number}`]: KeeperCycle };

/** One Seaport fill, normalised. */
export type RunFill = { txHash: string; contracts: Num; grossUsdg6: Num };

/** What the keeper recorded about a week's close, normalised. Null on the `RunCycle` while the week is open. */
export type RunClose = {
  rollCloseTx: string;
  /** Null when nobody called `lockBook` (a `rollClose` from Listed is legal). */
  lockTx: string | null;
  contractsAssigned: Num;
  /** The keeper's sum over the week's `Harvest` logs (see `KeeperCycle.harvest`), and how many it covered. */
  harvest: { gross: Num; fee: Num; net: Num };
  harvestEvents: number | null;
  /** The terminal `Harvest` alone, when the keeper recorded it (a stranded close). */
  terminalHarvest: { gross: Num; fee: Num; net: Num } | null;
  /** The retry's `Harvest` alone, when the keeper recorded it. */
  retryHarvest: { gross: Num; fee: Num } | null;
  /** True when the close could not redeem the claim (`ClaimStranded` in the rollClose receipt). */
  stranded: boolean;
  /** The `retryStrandedClaim` transaction that redeemed it; null when never stranded or still stranded. */
  retryTx: string | null;
  /** What the claim returned: `RollClose`'s legs on an ordinary close, `ClaimRedeemed`'s at the retry, 0 while stranded. */
  assetsReturned: Num;
  usdgFromAssignment: Num;
};

/** One week, as the builder consumes it. Every field is cross-checked against the chain. */
export type RunCycle = {
  cycleNumber: number;
  optionId: string;
  strikeUsdg6: Num;
  exerciseTimestamp: Num;
  expiryTimestamp: Num;
  rollOpenTx: string;
  approveTx: string | null;
  orderHash: string | null;
  /** `cycleN.contracts` when recorded: the week's contracts sold == written. */
  contracts: Num | null;
  /** In order. Empty on an unfilled week. */
  fills: RunFill[];
  /** `lockBook` on a week still open at the run's end (null if not called yet). */
  lockTx: string | null;
  /** Null while the week is still armed at the run's last block. Only the last week may be. */
  close: RunClose | null;
};

/** Walk `a.b.c` into run.json and fail loudly if the dry run did not record it. */
export function runValue(run: RunJson, path: string): unknown {
  let cur: unknown = run;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !(key in (cur as object))) {
      throw new Error(`run.json has no ${path}. Did the dry run finish every cycle? (run.error: ${run.error ?? "none"})`);
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const big = (v: unknown, what: string): bigint => {
  if (typeof v !== "string" && typeof v !== "number" && typeof v !== "bigint") throw new Error(`run.json ${what} is not a number: ${JSON.stringify(v)}`);
  return BigInt(v);
};

const WEEK_KEY = /^cycle([1-9][0-9]*)$/;

/**
 * The dry run's weeks, `cycle1` .. `cycleN` in cycle order, normalised. Throws with the path of the
 * first missing field. Every week before the last must be closed; the last may still be armed.
 */
export function runCycles(run: RunJson): RunCycle[] {
  const keys = Object.keys(run)
    .map((key) => ({ key, m: WEEK_KEY.exec(key) }))
    .filter((x): x is { key: string; m: RegExpExecArray } => x.m !== null)
    .map(({ key, m }) => ({ key, n: Number(m[1]) }))
    .sort((a, b) => a.n - b.n);
  if (keys.length === 0) {
    throw new Error(`run.json has no cycle1. Did the dry run arm a week? (run.error: ${run.error ?? "none"})`);
  }
  return keys.map(({ key, n }, i) => {
    const path = (field: string) => `${key}.${field}`;
    const at = (field: string) => runValue(run, path(field));
    const opt = (field: string): unknown => {
      try {
        return at(field);
      } catch {
        return undefined;
      }
    };
    const str = (v: unknown, where: string): string => {
      if (typeof v !== "string") throw new Error(`run.json ${where} is not a string: ${JSON.stringify(v)}`);
      return v;
    };
    const num = (v: unknown, where: string): Num => {
      if (typeof v !== "string" && typeof v !== "number") throw new Error(`run.json ${where} is not a number: ${JSON.stringify(v)}`);
      return v;
    };
    const k = run[key as `cycle${number}`]!;
    const fills = (Array.isArray(k.fills) ? k.fills : []).map((f, j) => ({
      txHash: str(runValue(run, path(`fills.${j}.tx`)), path(`fills[${j}].tx`)),
      contracts: num(f.contracts, path(`fills[${j}].contracts`)),
      grossUsdg6: num(runValue(run, path(`fills.${j}.premium`)), path(`fills[${j}].premium`)),
    }));
    const lockTx = typeof k.lockTx === "string" ? k.lockTx : null;

    let close: RunClose | null = null;
    if (k.rollCloseTx !== undefined) {
      const h = at("harvest");
      if (h === null || typeof h !== "object") throw new Error(`run.json ${path("harvest")} is not an object`);
      const harvestEvents = opt("harvest.harvestEvents");
      const atClose = k.strand?.harvestAtClose;
      const retryHarvest = k.recovery?.harvest;
      close = {
        rollCloseTx: str(k.rollCloseTx, path("rollCloseTx")),
        lockTx,
        contractsAssigned: num(at("harvest.contractsAssigned"), path("harvest.contractsAssigned")),
        harvest: {
          gross: num(at("harvest.gross"), path("harvest.gross")),
          fee: num(at("harvest.fee"), path("harvest.fee")),
          net: num(at("harvest.net"), path("harvest.net")),
        },
        harvestEvents: typeof harvestEvents === "number" ? harvestEvents : null,
        terminalHarvest: atClose === undefined ? null : { gross: num(atClose.gross, path("strand.harvestAtClose.gross")), fee: num(atClose.fee, path("strand.harvestAtClose.fee")), net: num(atClose.net, path("strand.harvestAtClose.net")) },
        retryHarvest: retryHarvest === undefined ? null : { gross: num(retryHarvest.gross, path("recovery.harvest.gross")), fee: num(retryHarvest.fee, path("recovery.harvest.fee")) },
        stranded: k.strand !== undefined,
        retryTx: k.recovery === undefined ? null : str(at("recovery.retryTx"), path("recovery.retryTx")),
        assetsReturned: num(at("harvest.assetsReturned"), path("harvest.assetsReturned")),
        usdgFromAssignment: num(at("harvest.usdgFromAssignment"), path("harvest.usdgFromAssignment")),
      };
    } else {
      if (k.strand !== undefined) {
        throw new Error(`run.json ${key} stranded (${path("strand")}) but records no ${path("rollCloseTx")} or ${path("harvest")}. Did the dry run finish the week?`);
      }
      if (i !== keys.length - 1) {
        throw new Error(`run.json has no ${path("rollCloseTx")} but ${keys[i + 1]!.key} follows it: only the last week may still be open`);
      }
    }

    return {
      cycleNumber: n,
      optionId: str(at("optionId"), path("optionId")),
      strikeUsdg6: num(at("strikeUsdg6"), path("strikeUsdg6")),
      exerciseTimestamp: num(at("exerciseTimestamp"), path("exerciseTimestamp")),
      expiryTimestamp: num(at("expiryTimestamp"), path("expiryTimestamp")),
      rollOpenTx: str(at("rollOpenTx"), path("rollOpenTx")),
      approveTx: typeof k.approveTx === "string" ? k.approveTx : null,
      orderHash: typeof k.orderHash === "string" ? k.orderHash : null,
      contracts: k.contracts === undefined ? null : num(k.contracts, path("contracts")),
      fills,
      lockTx,
      close,
    };
  });
}

/** Block bounds of the dry run: the vault's deploy block and the last transaction's block. */
export function runBlocks(run: RunJson): { vaultDeployBlock: bigint; lastBlock: bigint } {
  return {
    vaultDeployBlock: big(runValue(run, "blocks.vaultDeployBlock"), "blocks.vaultDeployBlock"),
    lastBlock: big(runValue(run, "blocks.lastBlock"), "blocks.lastBlock"),
  };
}

/*//////////////////////////////////////////////////////////////
                              HELPERS
//////////////////////////////////////////////////////////////*/

const USDG_DECIMALS = 6;
const ASSET_DECIMALS = 18;
const ONE = 10n ** 18n;
const LOT = 10n ** 18n;
const WAD = 10n ** 18n;
const ZERO_HASH = `0x${"0".repeat(64)}`;

/** The API's `iso()`: unix seconds to ISO 8601, and 0 / null to null. */
export const isoOf = (secs: bigint | null | undefined): string | null =>
  secs === null || secs === undefined || secs === 0n ? null : new Date(Number(secs) * 1000).toISOString();

const lower = (s: string) => s.toLowerCase();
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const sum = <T>(xs: readonly T[], f: (x: T) => bigint) => xs.reduce((s, x) => s + f(x), 0n);
const perShare = (amount: bigint, supply: bigint) => (supply === 0n ? 0n : (amount * ONE) / supply);

/** `Policy.maxContracts(totalAssets) − contractsWritten`, as the API publishes `week.assignmentLive.capacity`. */
export const capacityOf = (p: { maxUtilizationBps: number; maxContractsCap: bigint }, totalAssets: bigint, written: bigint): bigint => {
  const byUtilization = (totalAssets * BigInt(p.maxUtilizationBps)) / 10_000n / LOT;
  const max = byUtilization < p.maxContractsCap ? byUtilization : p.maxContractsCap;
  return max > written ? max - written : 0n;
};

/**
 * How an epoch's share of a stranded claim is drawn down as its entries settle, exactly as
 * `Vault._settleEpochEntry` does it: pro rata by shares against what the epoch still holds, the
 * last claimant (`shares == sharesRemaining`) taking the rest. Returns the WAD each entry took, in
 * order, so both `queue_epoch.strandWadClaimed` and an owner's staged share can be expected.
 */
export function epochStrandDrawdown(sharesSettled: bigint, strandWad: bigint, entries: readonly { shares: bigint }[]): bigint[] {
  let remaining = sharesSettled;
  let wad = strandWad;
  const taken: bigint[] = [];
  for (const e of entries) {
    const mine = wad === 0n ? 0n : e.shares >= remaining ? wad : (wad * e.shares) / remaining;
    taken.push(mine);
    wad -= mine;
    remaining = remaining > e.shares ? remaining - e.shares : 0n;
  }
  return taken;
}

class Builder {
  readonly expectations: Expectation[] = [];
  readonly disagreements: string[] = [];
  crossChecks = 0;

  route(route: string, prefix = "") {
    const join = (p: string) => (prefix === "" ? p : p === "" ? prefix : `${prefix}.${p}`);
    const self = this;
    return {
      eq(path: string, expected: Json, source?: string) {
        self.expectations.push({ route, path: join(path), expected, ...(source === undefined ? {} : { source }) });
      },
      /** A `{raw, decimals, formatted}` amount: three leaves. */
      amount(path: string, raw: bigint, decimals: number, source?: string) {
        this.eq(`${path}.raw`, raw.toString(), source);
        this.eq(`${path}.decimals`, decimals);
        this.eq(`${path}.formatted`, formatUnits(raw, decimals));
      },
      usdg(path: string, raw: bigint, source?: string) {
        this.amount(path, raw, USDG_DECIMALS, source);
      },
      asset(path: string, raw: bigint, source?: string) {
        this.amount(path, raw, ASSET_DECIMALS, source);
      },
      at(sub: string) {
        return self.route(route, join(sub));
      },
    };
  }

  /** Record a run.json-vs-chain disagreement. The run fails on any of them. */
  agree(what: string, fromRun: unknown, fromChain: unknown) {
    // Numbers compare by decimal value whatever their JS type (run.json stores most as strings),
    // hex by lowercase, everything else by its JSON.
    const scalar = (v: unknown): unknown =>
      typeof v === "bigint" || typeof v === "number" ? String(v) : typeof v === "string" && v.startsWith("0x") ? lower(v) : v;
    const norm = (v: unknown) => {
      const s = Array.isArray(v) ? v.map(scalar) : scalar(v);
      return typeof s === "string" ? s : JSON.stringify(s);
    };
    this.crossChecks += 1;
    if (norm(fromRun) !== norm(fromChain)) {
      this.disagreements.push(`${what}: run.json says ${norm(fromRun)}, the chain says ${norm(fromChain)}`);
    }
  }
}

type RouteWriter = ReturnType<Builder["route"]>;

/*//////////////////////////////////////////////////////////////
                         THE WEEK, DERIVED
//////////////////////////////////////////////////////////////*/

/** One `Harvest` as the API publishes it: the event's amounts and the split the product defines. */
export type HarvestTruth = {
  cycleNumber: number;
  origin: "rollClose" | "checkpoint" | "retry";
  txHash: string;
  block: bigint;
  timestamp: bigint;
  /** The cycle had sold something when this harvest landed. */
  filled: boolean;
  gross: bigint;
  fee: bigint;
  net: bigint;
  /** The part of `gross` that is strike proceeds: `RollClose.usdgFromAssignment` on the terminal harvest, the live shares' part of the recovered claim on the retry's, 0 on a checkpoint. */
  strikeProceeds: bigint;
  premiumGross: bigint;
  premiumNet: bigint;
  /** The cycle's figures as the tape held them when this harvest landed. */
  assignmentUsdg: bigint;
  contractsSold: bigint;
  contractsAssigned: bigint;
  supply: bigint;
  premiumNetPerShare: bigint;
  usdgPerShare: bigint;
  accAfter: bigint;
};

export type ListingTruth = {
  orderHash: string;
  cycle: number;
  seq: number;
  status: "filled" | "partially_filled" | "cancelled" | "approved";
  optionId: bigint;
  contracts: bigint;
  gross: bigint;
  unitPrice: bigint;
  contractsFilled: bigint;
  fillCount: number;
  proceeds: bigint;
  lastFillAt: bigint | null;
  lastFillTx: string | null;
  approvedAt: bigint;
  approvedBlock: bigint;
  approvedTx: string;
  endedAt: bigint | null;
  endedTx: string | null;
  endReason: string | null;
};

export type StrandTruth = {
  gen: bigint;
  cycleNumber: number;
  claimKey: bigint;
  strandedAt: bigint;
  strandedTx: string;
  epochWad: bigint;
  epochCount: number;
  recovered: boolean;
  recoveredAt: bigint | null;
  recoveredTx: string | null;
  assetsIn: bigint;
  usdgIn: bigint;
  queueWad: bigint;
  wadLeft: bigint;
  assetsLeft: bigint;
  usdgLeft: bigint;
  settledCount: number;
};

/** One week as the product defines it, every figure derived rather than copied. */
export type WeekTruth = {
  cycleNumber: number;
  status: "listed" | "stranded" | "closed" | "unfilled" | "assigned";
  exerciseTimestamp: bigint;
  expiryTimestamp: bigint;
  optionId: bigint;
  /** Null on an unfilled week: nothing was written, so no claim was opened. */
  claimKey: bigint | null;
  strike: bigint;
  /** Contracts written == sold: the sum of the fills' `CallsWritten`. */
  contracts: bigint;
  collateral: bigint;
  writeCount: number;
  firstWriteAt: bigint | null;
  lastWriteAt: bigint | null;
  openedAt: bigint;
  txOpen: string;
  /** Every listing the vault authorised this cycle, by `seq` ascending. */
  listings: ListingTruth[];
  sold: bigint;
  fillCount: number;
  premiumGross: bigint;
  firstFillAt: bigint | null;
  lastFillAt: bigint | null;
  lockedAt: bigint | null;
  assigned: bigint;
  /** What the claim returned, once it did: `RollClose`'s legs, or the retry's `ClaimRedeemed` after a strand. 0 while stranded. */
  assetsReturned: bigint;
  assignmentUsdg: bigint;
  marketExercised: bigint;
  bucketIndex: bigint | null;
  bucketAssigned: bigint;
  closedAt: bigint | null;
  txClose: string | null;
  stranded: boolean;
  strand: StrandTruth | null;
  /** Every `Harvest` carrying this cycle's number, newest first (what `/v1/cycles/:n` lists). */
  allHarvests: HarvestTruth[];
  /** The harvests that accumulate onto the cycle row: checkpoints while open, the terminal one, the retry's. */
  harvests: HarvestTruth[];
  terminal: HarvestTruth | null;
  /** The row's harvest columns, summed over `harvests`. */
  gross: bigint;
  fee: bigint;
  net: bigint;
  strikeProceeds: bigint;
  harvestPremiumGross: bigint;
  premiumNet: bigint;
  premiumNetPerShare: bigint;
  usdgPerShare: bigint;
  supplyAtHarvest: bigint;
};

function deriveListing(cycle: number, chain: ChainListing): ListingTruth {
  const contracts = chain.amount;
  const contractsFilled = sum(chain.fills, (f) => f.contracts);
  const proceeds = sum(chain.fills, (f) => f.toVault);
  const lastFill = chain.fills.at(-1) ?? null;
  const complete = contractsFilled >= contracts && contracts > 0n;

  let status: ListingTruth["status"] = "approved";
  let endedAt: bigint | null = null;
  let endedTx: string | null = null;
  let endReason: string | null = null;
  if (complete && lastFill !== null) {
    status = "filled";
    endedAt = lastFill.timestamp;
    endedTx = lastFill.txHash;
    endReason = "filled";
  } else if (chain.cancelled !== null) {
    status = contractsFilled > 0n ? "partially_filled" : "cancelled";
    endedAt = chain.cancelled.timestamp;
    endedTx = chain.cancelled.txHash;
    endReason = chain.cancelled.reason;
  } else if (contractsFilled > 0n) {
    status = "partially_filled";
  }

  return {
    orderHash: lower(chain.orderHash),
    cycle,
    seq: chain.seq,
    status,
    optionId: chain.optionId,
    contracts,
    gross: chain.grossUsdg,
    // The contract has proved `grossUsdg % amount == 0` at approval.
    unitPrice: contracts === 0n ? 0n : chain.grossUsdg / contracts,
    contractsFilled,
    fillCount: chain.fills.length,
    proceeds,
    lastFillAt: lastFill?.timestamp ?? null,
    lastFillTx: lastFill?.txHash ?? null,
    approvedAt: chain.approvedTimestamp,
    approvedBlock: chain.approvedBlock,
    approvedTx: chain.approvedTx,
    endedAt,
    endedTx,
    endReason,
  };
}

export function deriveStrand(b: Builder, s: ChainStrand): StrandTruth {
  const epochWad = sum(s.epochShares, (e) => e.wad);
  const r = s.recovered;
  if (r !== null) {
    // The queue's part at recovery is exactly what the epochs took while it was stranded.
    b.agree(`strand ${s.gen} queueWad = sum of EpochStrandShare`, epochWad, r.queueWad);
  }
  const queueAssets = r === null ? 0n : (r.assets * r.queueWad) / WAD;
  const queueUsdg = r === null ? 0n : (r.usdgOut * r.queueWad) / WAD;
  return {
    gen: s.gen,
    cycleNumber: s.cycleNumber,
    claimKey: s.claimKey,
    strandedAt: s.strandedTimestamp,
    strandedTx: lower(s.strandedTx),
    epochWad,
    epochCount: s.epochShares.length,
    recovered: r !== null,
    recoveredAt: r?.timestamp ?? null,
    recoveredTx: r === null ? null : lower(r.txHash),
    assetsIn: r?.assets ?? 0n,
    usdgIn: r?.usdgOut ?? 0n,
    queueWad: r?.queueWad ?? 0n,
    wadLeft: (r?.queueWad ?? 0n) - sum(s.shareSettlements, (x) => x.wad),
    assetsLeft: queueAssets - sum(s.shareSettlements, (x) => x.assets),
    usdgLeft: queueUsdg - sum(s.shareSettlements, (x) => x.usdgOut),
    settledCount: s.shareSettlements.length,
  };
}

/** The live shares' part of a recovered claim's USDG: what the retry's harvest sweeps, fee-free. */
const liveUsdgOf = (r: NonNullable<ChainStrand["recovered"]>): bigint => r.usdgOut - (r.usdgOut * r.queueWad) / WAD;

function deriveHarvest(
  b: Builder,
  h: ChainHarvest,
  c: ChainCycle & { close: NonNullable<ChainCycle["close"]> },
  fills: readonly { block: bigint; contracts: bigint }[],
  strand: ChainStrand | null,
): HarvestTruth {
  if (h.supplyFromLog) {
    // One transaction per block on anvil: the supply UsdgDistributed reports is the supply the
    // block before, because the harvest runs before a deposit's mint and before a settlement's burn.
    b.agree(`Harvest ${h.txHash} supply: UsdgDistributed.totalSupply = totalSupply() the block before`, h.supply, h.supplyBefore);
  }
  const closed = h.block >= c.close.block;
  const recovered = strand?.recovered ?? null;
  const recoveredBy = recovered !== null && h.block >= recovered.block;
  const soldAt = sum(
    fills.filter((f) => f.block <= h.block),
    (f) => f.contracts,
  );
  const strikeProceeds =
    h.origin === "rollClose" ? min(c.close.usdgFromAssignment, h.gross) : h.origin === "retry" && recovered !== null ? min(liveUsdgOf(recovered), h.gross) : 0n;
  const premiumGross = h.gross - strikeProceeds;
  const premiumNet = premiumGross > h.fee ? premiumGross - h.fee : 0n;
  // The cycle row's figures when this harvest landed: nothing before the close; RollClose's legs
  // at the close (zero on a stranded one); the redeemed figures from the retry on.
  const assignmentUsdg = !closed ? 0n : c.stranded === null ? c.close.usdgFromAssignment : recoveredBy && c.redeemed !== null ? c.redeemed.exerciseReceived : 0n;
  return {
    cycleNumber: h.cycleNumber,
    origin: h.origin,
    txHash: lower(h.txHash),
    block: h.block,
    timestamp: h.timestamp,
    filled: soldAt > 0n,
    gross: h.gross,
    fee: h.fee,
    net: h.net,
    strikeProceeds,
    premiumGross,
    premiumNet,
    assignmentUsdg,
    contractsSold: soldAt,
    contractsAssigned: closed ? c.close.contractsAssignedCount : 0n,
    supply: h.supply,
    premiumNetPerShare: perShare(premiumNet, h.supply),
    usdgPerShare: perShare(h.net, h.supply),
    accAfter: h.accAfter,
  };
}

function deriveOpenWeek(b: Builder, chain: ChainFacts, k: RunCycle): WeekTruth {
  const n = k.cycleNumber;
  const found = chain.cycles.find((x) => x.cycleNumber === n);
  if (found === undefined || found.open === null) {
    throw new Error(`the chain has no RollOpen for still-open cycle ${n}`);
  }
  if (found.close !== null) {
    throw new Error(`run.json cycle${n} is still open but the chain has a RollClose`);
  }
  const c = found as ChainCycle & { open: NonNullable<ChainCycle["open"]> };
  const w = `cycle ${n}`;
  b.agree(`${w} option id`, k.optionId, c.open.optionId);
  b.agree(`${w} strike`, big(k.strikeUsdg6, `cycle${n}.strikeUsdg6`), c.open.strike);
  b.agree(`${w} exercise timestamp`, big(k.exerciseTimestamp, `cycle${n}.exerciseTimestamp`), c.open.exerciseTs);
  b.agree(`${w} expiry timestamp`, big(k.expiryTimestamp, `cycle${n}.expiryTimestamp`), c.open.expiryTs);
  b.agree(`${w} rollOpen tx`, k.rollOpenTx, c.open.txHash);
  b.agree(`${w} still open (no RollClose)`, null, found.close);

  const chainListings = chain.listings.filter((l) => l.optionId === c.open.optionId).sort((x, y) => x.seq - y.seq);
  const listings = chainListings.map((l) => deriveListing(n, l));
  const fills = chainListings.flatMap((l) => l.fills).sort((x, y) => (x.block < y.block ? -1 : x.block > y.block ? 1 : 0));
  const fillLine = (txHash: string, contracts: bigint | string | number, gross: bigint | string | number) => `${lower(txHash)}:${contracts}:${gross}`;
  b.agree(
    `${w} fills (tx:contracts:usdg to the vault)`,
    k.fills.map((f) => fillLine(f.txHash, f.contracts, f.grossUsdg6)),
    fills.map((f) => fillLine(f.txHash, f.contracts, f.toVault)),
  );
  const written = sum(c.writes, (x) => x.contracts);
  const collateral = sum(c.writes, (x) => x.collateral);
  const sold = sum(fills, (f) => f.contracts);
  const premiumGross = sum(fills, (f) => f.toVault);
  b.agree(`${w} contracts sold (Seaport) = written (CallsWritten)`, sold, written);
  const claimKey = c.writes[0]?.claimKey ?? null;

  return {
    cycleNumber: n,
    status: "listed",
    exerciseTimestamp: c.open.exerciseTs,
    expiryTimestamp: c.open.expiryTs,
    optionId: c.open.optionId,
    claimKey,
    strike: c.open.strike,
    contracts: written,
    collateral,
    writeCount: c.writes.length,
    firstWriteAt: c.writes[0]?.timestamp ?? null,
    lastWriteAt: c.writes.at(-1)?.timestamp ?? null,
    openedAt: c.open.timestamp,
    txOpen: lower(c.open.txHash),
    listings,
    sold,
    fillCount: fills.length,
    premiumGross,
    firstFillAt: fills[0]?.timestamp ?? null,
    lastFillAt: fills.at(-1)?.timestamp ?? null,
    lockedAt: c.locked?.timestamp ?? null,
    assigned: 0n,
    assetsReturned: 0n,
    assignmentUsdg: 0n,
    marketExercised: c.marketExercised,
    bucketIndex: c.bucketIndex,
    bucketAssigned: c.bucketAssigned,
    closedAt: null,
    txClose: null,
    stranded: false,
    strand: null,
    allHarvests: [],
    harvests: [],
    terminal: null,
    gross: 0n,
    fee: 0n,
    net: 0n,
    strikeProceeds: 0n,
    harvestPremiumGross: 0n,
    premiumNet: 0n,
    premiumNetPerShare: 0n,
    usdgPerShare: 0n,
    supplyAtHarvest: 0n,
  };
}

function deriveWeek(b: Builder, chain: ChainFacts, k: RunCycle, strands: StrandTruth[]): WeekTruth {
  if (k.close === null) return deriveOpenWeek(b, chain, k);
  const n = k.cycleNumber;
  const found = chain.cycles.find((x) => x.cycleNumber === n);
  if (found === undefined || found.open === null || found.close === null) {
    throw new Error(`the chain has no closed cycle ${n} (RollOpen and RollClose)`);
  }
  const close = k.close;
  const c = found as ChainCycle & { open: NonNullable<ChainCycle["open"]>; close: NonNullable<ChainCycle["close"]> };
  const w = `cycle ${n}`;

  /* ---- the armed type ---- */
  b.agree(`${w} option id`, k.optionId, c.open.optionId);
  b.agree(`${w} strike`, big(k.strikeUsdg6, `cycle${n}.strikeUsdg6`), c.open.strike);
  b.agree(`${w} exercise timestamp`, big(k.exerciseTimestamp, `cycle${n}.exerciseTimestamp`), c.open.exerciseTs);
  b.agree(`${w} expiry timestamp`, big(k.expiryTimestamp, `cycle${n}.expiryTimestamp`), c.open.expiryTs);
  b.agree(`${w} rollOpen tx`, k.rollOpenTx, c.open.txHash);
  b.agree(`${w} lockBook tx`, k.lockTx, c.locked?.txHash ?? null);
  b.agree(`${w} rollClose tx`, close.rollCloseTx, c.close.txHash);

  /* ---- listings and fills ---- */
  const chainListings = chain.listings.filter((l) => l.optionId === c.open.optionId).sort((x, y) => x.seq - y.seq);
  const listings = chainListings.map((l) => deriveListing(n, l));
  const fills = chainListings
    .flatMap((l) => l.fills)
    .sort((x, y) => (x.block < y.block ? -1 : x.block > y.block ? 1 : 0));
  const fillLine = (txHash: string, contracts: bigint | string | number, gross: bigint | string | number) => `${lower(txHash)}:${contracts}:${gross}`;
  b.agree(
    `${w} fills (tx:contracts:usdg to the vault)`,
    k.fills.map((f) => fillLine(f.txHash, f.contracts, f.grossUsdg6)),
    fills.map((f) => fillLine(f.txHash, f.contracts, f.toVault)),
  );

  /* ---- written == sold, per fill ---- */
  const written = sum(c.writes, (x) => x.contracts);
  const collateral = sum(c.writes, (x) => x.collateral);
  const sold = sum(fills, (f) => f.contracts);
  const premiumGross = sum(fills, (f) => f.toVault);
  b.agree(`${w} contracts sold (Seaport) = written (CallsWritten)`, sold, written);
  b.agree(`${w} collateral = contracts x lot`, written * LOT, collateral);
  // Each fill's write sits in the fill's own transaction.
  b.agree(`${w} one write per fill`, fills.map((f) => lower(f.txHash)), c.writes.map((x) => lower(x.txHash)));
  const claimKey = c.writes[0]?.claimKey ?? null;
  for (const x of c.writes) b.agree(`${w} every fill writes into one claim`, claimKey, x.claimKey);

  /* ---- the close ---- */
  const assigned = c.close.contractsAssignedCount;
  b.agree(`${w} contracts assigned`, big(close.contractsAssigned, `cycle${n}.harvest.contractsAssigned`), assigned);
  // The vault is the only writer of each of these private option types, so every exercised
  // contract lands in its one bucket.
  b.agree(`${w} bucket assignment = contracts assigned`, assigned, c.bucketAssigned);
  b.agree(`${w} stranded`, close.stranded, c.stranded !== null);

  const strand = c.stranded === null ? null : (strands.find((s) => s.gen === c.stranded!.gen) ?? null);
  const chainStrand = c.stranded === null ? null : (chain.strands.find((s) => s.gen === c.stranded!.gen) ?? null);
  if (c.stranded !== null) {
    if (strand === null || chainStrand === null) throw new Error(`the chain has a ClaimStranded for ${w} (gen ${c.stranded.gen}) but no strand record`);
    b.agree(`${w} strand belongs to this cycle`, n, strand.cycleNumber);
    b.agree(`${w} stranded claim key`, claimKey, c.stranded.claimKey);
    // A stranded close reports zero legs; the real figures arrive with the retry.
    b.agree(`${w} stranded close reports zero legs`, "0:0", `${c.close.assetsReturned}:${c.close.usdgFromAssignment}`);
  }
  b.agree(`${w} retry tx`, close.retryTx, chainStrand?.recovered?.txHash ?? null);

  // What the claim returned, once it did.
  let assetsReturned = c.close.assetsReturned;
  let assignmentUsdg = c.close.usdgFromAssignment;
  if (c.stranded !== null) {
    const r = chainStrand?.recovered ?? null;
    if (r !== null) {
      if (c.redeemed === null) throw new Error(`${w} recovered (${r.txHash}) but the vault emitted no ClaimRedeemed for its claim`);
      b.agree(`${w} StrandedClaimRecovered legs = ClaimRedeemed legs`, `${r.assets}:${r.usdgOut}`, `${c.redeemed.underlyingReturned}:${c.redeemed.exerciseReceived}`);
      b.agree(`${w} recovered in the retry tx`, r.txHash, c.redeemed.txHash);
      assetsReturned = c.redeemed.underlyingReturned;
      assignmentUsdg = c.redeemed.exerciseReceived;
    }
  }
  b.agree(`${w} assetsReturned`, big(close.assetsReturned, `cycle${n}.harvest.assetsReturned`), assetsReturned);
  b.agree(`${w} usdgFromAssignment`, big(close.usdgFromAssignment, `cycle${n}.harvest.usdgFromAssignment`), assignmentUsdg);
  // Nothing sold means nothing written, no claim, and no collateral to bring home.
  if (sold === 0n) {
    b.agree(`${w} unfilled: no claim`, null, claimKey);
    b.agree(`${w} unfilled: nothing to return`, 0n, assetsReturned);
    b.agree(`${w} unfilled: nothing assigned`, 0n, assigned);
  }

  /* ---- harvests ---- */
  const allChain = chain.harvests.filter((h) => h.cycleNumber === n);
  const terminalChain = allChain.find((h) => h.origin === "rollClose");
  if (terminalChain === undefined || lower(terminalChain.txHash) !== lower(c.close.txHash)) {
    throw new Error(`the chain has no Harvest in ${w}'s rollClose transaction`);
  }
  b.agree(`${w} one terminal Harvest`, 1, allChain.filter((h) => h.origin === "rollClose").length);
  b.agree(`${w} retry Harvest present iff recovered`, chainStrand?.recovered !== null && chainStrand?.recovered !== undefined, allChain.some((h) => h.origin === "retry"));

  const all = allChain.map((h) => deriveHarvest(b, h, c, fills, chainStrand));
  const terminal = all.find((h) => h.origin === "rollClose")!;
  // A checkpoint that lands after the close (a deposit or a flat settleQueue still carrying the
  // closed cycle's number) keeps its row but must not restate a published week.
  const touching = all.filter((h) => h.origin === "rollClose" || h.origin === "retry" || h.block < c.close.block);
  const last = touching.reduce((m, h) => (h.block > m.block ? h : m), touching[0]!);
  // The keeper's cycle row (and run.json harvest) is harvestForCycle: every Harvest from the
  // rollOpen block through the close or the retry, summed. Not the terminal event alone.
  b.agree(`${w} Harvest.grossUsdg`, big(close.harvest.gross, `cycle${n}.harvest.gross`), sum(touching, (h) => h.gross));
  b.agree(`${w} Harvest.feeUsdg`, big(close.harvest.fee, `cycle${n}.harvest.fee`), sum(touching, (h) => h.fee));
  b.agree(`${w} Harvest.netUsdg`, big(close.harvest.net, `cycle${n}.harvest.net`), sum(touching, (h) => h.net));

  const status: WeekTruth["status"] =
    c.stranded !== null && chainStrand?.recovered === null ? "stranded" : assigned > 0n ? "assigned" : sold > 0n ? "closed" : "unfilled";

  return {
    cycleNumber: n,
    status,
    exerciseTimestamp: c.open.exerciseTs,
    expiryTimestamp: c.open.expiryTs,
    optionId: c.open.optionId,
    claimKey,
    strike: c.open.strike,
    contracts: written,
    collateral,
    writeCount: c.writes.length,
    firstWriteAt: c.writes[0]?.timestamp ?? null,
    lastWriteAt: c.writes.at(-1)?.timestamp ?? null,
    openedAt: c.open.timestamp,
    txOpen: lower(c.open.txHash),
    listings,
    sold,
    fillCount: fills.length,
    premiumGross,
    firstFillAt: fills[0]?.timestamp ?? null,
    lastFillAt: fills.at(-1)?.timestamp ?? null,
    lockedAt: c.locked?.timestamp ?? null,
    assigned,
    assetsReturned,
    assignmentUsdg,
    marketExercised: c.marketExercised,
    bucketIndex: c.bucketIndex,
    bucketAssigned: c.bucketAssigned,
    closedAt: c.close.timestamp,
    txClose: lower(c.close.txHash),
    stranded: c.stranded !== null,
    strand,
    allHarvests: [...all].sort((x, y) => (x.block > y.block ? -1 : x.block < y.block ? 1 : 0)),
    harvests: touching,
    terminal,
    gross: sum(touching, (h) => h.gross),
    fee: sum(touching, (h) => h.fee),
    net: sum(touching, (h) => h.net),
    strikeProceeds: sum(touching, (h) => h.strikeProceeds),
    harvestPremiumGross: sum(touching, (h) => h.premiumGross),
    premiumNet: sum(touching, (h) => h.premiumNet),
    premiumNetPerShare: sum(touching, (h) => h.premiumNetPerShare),
    usdgPerShare: sum(touching, (h) => h.usdgPerShare),
    supplyAtHarvest: last.supply,
  };
}

/*//////////////////////////////////////////////////////////////
                         SHAPES, AS EXPECTED
//////////////////////////////////////////////////////////////*/

function expectCycle(w: RouteWriter, t: WeekTruth) {
  w.eq("cycle", t.cycleNumber);
  w.eq("status", t.status, "listed while still armed; ClaimStranded unrecovered → stranded; else assigned / closed / unfilled by what sold and was assigned");
  w.eq("filled", t.sold > 0n);
  w.eq("assigned", t.assigned > 0n);
  w.eq("stranded", t.stranded, "a ClaimStranded in the rollClose tx; stays true as history after recovery");

  const op = w.at("option");
  op.eq("exerciseTimestamp", t.exerciseTimestamp.toString(), "clear.option(optionId).exerciseTimestamp");
  op.eq("exerciseAt", isoOf(t.exerciseTimestamp));
  op.eq("expiryTimestamp", t.expiryTimestamp.toString(), "clear.option(optionId).expiryTimestamp");
  op.eq("expiryAt", isoOf(t.expiryTimestamp));

  const wr = w.at("written");
  wr.eq("optionId", t.optionId.toString(), "RollOpen.optionId");
  wr.eq("claimKey", t.claimKey === null ? null : t.claimKey.toString(), "CallsWritten.claimKey (null when nothing sold)");
  wr.usdg("strikeUsdg", t.strike, "RollOpen.strikeUsdg");
  wr.eq("contracts", t.contracts.toString(), "sum of CallsWritten.contractsCount");
  wr.asset("collateral", t.collateral, "sum of CallsWritten.collateral");
  wr.eq("writeCount", t.writeCount, "CallsWritten events");
  wr.eq("openedAt", isoOf(t.openedAt), "RollOpen block timestamp");
  wr.eq("txOpen", t.txOpen, "run.json cycles[].rollOpenTx");
  wr.eq("firstWriteAt", isoOf(t.firstWriteAt));
  wr.eq("lastWriteAt", isoOf(t.lastWriteAt));

  const li = w.at("listing");
  const latest = t.listings.at(-1) ?? null;
  li.eq("count", t.listings.length, "ListingApproved.seq of the latest listing");
  li.eq("orderHash", latest === null ? null : latest.orderHash, "the latest ListingApproved.orderHash");
  li.eq("contracts", (latest?.contracts ?? 0n).toString(), "ListingApproved.amount");
  li.usdg("grossUsdg", latest?.gross ?? 0n, "ListingApproved.grossUsdg");
  li.usdg("unitPriceUsdg", latest?.unitPrice ?? 0n, "grossUsdg / amount");
  li.eq("listedAt", isoOf(latest?.approvedAt ?? null), "ListingApproved block timestamp");

  const fi = w.at("fill");
  fi.eq("contractsSold", t.sold.toString(), "Seaport OrderFulfilled offer items");
  fi.eq("fillCount", t.fillCount, "OrderFulfilled events");
  fi.usdg("premiumGross", t.premiumGross, "sum of the one USDG consideration item per fill");
  fi.usdg("unitPriceUsdg", t.sold === 0n ? 0n : t.premiumGross / t.sold);
  fi.eq("firstFillAt", isoOf(t.firstFillAt));
  fi.eq("lastFillAt", isoOf(t.lastFillAt));

  const se = w.at("settlement");
  se.eq("lockedAt", isoOf(t.lockedAt), "BookLocked block timestamp");
  se.eq("contractsAssigned", t.assigned.toString(), "RollClose.contractsAssignedCount");
  se.usdg("assignmentUsdg", t.assignmentUsdg, "RollClose.usdgFromAssignment, or ClaimRedeemed.exerciseReceived at the retry");
  se.asset("assetsReturned", t.assetsReturned, "RollClose.assetsReturned, or ClaimRedeemed.underlyingReturned at the retry");
  se.eq("marketExercised", t.marketExercised.toString(), "Valorem OptionsExercised");
  se.eq("bucketIndex", t.bucketIndex === null ? null : t.bucketIndex.toString(), "Valorem BucketWrittenInto in this cycle's first fill");
  se.eq("bucketAssigned", t.bucketAssigned.toString(), "Valorem BucketAssignedExercise on that bucket");
  se.eq("closedAt", isoOf(t.closedAt), "RollClose block timestamp");
  se.eq("txClose", t.txClose, "run.json cycles[].rollCloseTx");
  if (t.strand === null) se.eq("strand", null, "no ClaimStranded for this cycle");
  else {
    const st = se.at("strand");
    st.eq("gen", t.strand.gen.toString(), "ClaimStranded.gen");
    st.eq("recovered", t.strand.recovered, "a StrandedClaimRecovered for that gen");
    st.eq("recoveredAt", isoOf(t.strand.recoveredAt));
    st.eq("recoveredTx", t.strand.recoveredTx, "run.json cycles[].retryTx");
  }

  const hv = w.at("harvest");
  hv.eq("harvested", t.status !== "listed");
  hv.usdg("grossUsdg", t.gross, "sum of Harvest.grossUsdg over the cycle's checkpoints, its terminal harvest and its retry");
  hv.usdg("premiumGross", t.harvestPremiumGross, "gross - strike proceeds, per harvest");
  hv.usdg("strikeProceedsUsdg", t.strikeProceeds, "RollClose.usdgFromAssignment on the terminal harvest + the live shares' part of a recovered claim on the retry");
  hv.usdg("fee", t.fee, "sum of Harvest.feeUsdg");
  hv.usdg("premiumNet", t.premiumNet, "gross - strike proceeds - fee, per harvest");
  hv.usdg("creditedUsdg", t.net, "sum of Harvest.netUsdg");
  hv.usdg("premiumNetPerShare", t.premiumNetPerShare, "sum over harvests of premiumNet x 1e18 / supply at that harvest");
  hv.usdg("usdgPerShare", t.usdgPerShare, "sum over harvests of net x 1e18 / supply at that harvest");
  hv.asset("supplyAtHarvest", t.supplyAtHarvest, "totalSupply() the block before the last harvest that touched the cycle");
  hv.eq("harvestedAt", t.terminal === null ? null : isoOf(t.terminal.timestamp), "the terminal harvest's block timestamp");
}

function expectListing(w: RouteWriter, l: ListingTruth) {
  w.eq("orderHash", l.orderHash);
  w.eq("cycle", l.cycle);
  w.eq("seq", l.seq, "ListingApproved.seq");
  w.eq("status", l.status, "Seaport fills / vault ListingCancelled");
  w.eq("optionId", l.optionId.toString());
  w.eq("contracts", l.contracts.toString());
  w.usdg("grossUsdg", l.gross, "ListingApproved.grossUsdg");
  w.usdg("unitPriceUsdg", l.unitPrice, "grossUsdg / amount");
  const f = w.at("fill");
  f.eq("contractsFilled", l.contractsFilled.toString());
  f.eq("fillCount", l.fillCount);
  f.usdg("proceedsUsdg", l.proceeds);
  f.eq("lastFillAt", isoOf(l.lastFillAt));
  f.eq("lastFillTx", l.lastFillTx === null ? null : lower(l.lastFillTx));
  w.eq("approvedAt", isoOf(l.approvedAt));
  w.eq("approvedTx", lower(l.approvedTx), "ListingApproved tx");
  w.eq("endedAt", isoOf(l.endedAt));
  w.eq("endedTx", l.endedTx === null ? null : lower(l.endedTx));
  w.eq("endReason", l.endReason, "filled / cancelled / counter / lockBook / rollClose, from the same tx's other events");
}

function expectHarvest(w: RouteWriter, t: HarvestTruth) {
  w.eq("cycle", t.cycleNumber);
  w.eq("terminal", t.origin === "rollClose");
  w.eq("origin", t.origin, "RollClose in the tx → rollClose; StrandedClaimRecovered → retry; else checkpoint");
  w.eq("filled", t.filled);
  w.usdg("grossUsdg", t.gross, "Harvest.grossUsdg");
  w.usdg("fee", t.fee, "Harvest.feeUsdg");
  w.usdg("netUsdg", t.net, "Harvest.netUsdg");
  w.usdg("premiumGross", t.premiumGross);
  w.usdg("strikeProceedsUsdg", t.strikeProceeds);
  w.usdg("premiumNet", t.premiumNet);
  w.usdg("assignmentUsdg", t.assignmentUsdg, "the cycle's assignment USDG as of this harvest");
  w.eq("contractsSold", t.contractsSold.toString());
  w.eq("contractsAssigned", t.contractsAssigned.toString());
  w.usdg("premiumNetPerShare", t.premiumNetPerShare);
  w.usdg("usdgPerShare", t.usdgPerShare);
  w.asset("supply", t.supply, "UsdgDistributed.totalSupply / totalSupply() the block before");
  w.eq("accUsdgPerShare", t.accAfter.toString(), "accUsdgPerShare() at the harvest block");
  w.eq("at", isoOf(t.timestamp));
  w.eq("txHash", t.txHash);
}

function expectStrand(w: RouteWriter, s: StrandTruth) {
  w.eq("gen", s.gen.toString(), "ClaimStranded.gen");
  w.eq("cycle", s.cycleNumber, "ClaimStranded.cycleNumber");
  w.eq("claimKey", s.claimKey.toString(), "ClaimStranded.claimKey");
  w.eq("strandedAt", isoOf(s.strandedAt));
  w.eq("strandedTx", s.strandedTx);
  w.eq("epochWad", s.epochWad.toString(), "sum of EpochStrandShare.wad");
  w.eq("epochCount", s.epochCount, "EpochStrandShare events");
  w.eq("recovered", s.recovered);
  w.eq("recoveredAt", isoOf(s.recoveredAt));
  w.eq("recoveredTx", s.recoveredTx, "StrandedClaimRecovered tx");
  w.asset("assetsIn", s.assetsIn, "StrandedClaimRecovered.assets");
  w.usdg("usdgIn", s.usdgIn, "StrandedClaimRecovered.usdgOut");
  w.eq("queueWad", s.queueWad.toString(), "StrandedClaimRecovered.queueWad");
  w.eq("wadLeft", s.wadLeft.toString(), "queueWad - sum of StrandShareSettled.wad");
  w.asset("assetsLeft", s.assetsLeft, "floor(assets x queueWad / 1e18) - sum of StrandShareSettled.assets");
  w.usdg("usdgLeft", s.usdgLeft, "floor(usdgOut x queueWad / 1e18) - sum of StrandShareSettled.usdgOut");
  w.eq("settledCount", s.settledCount, "StrandShareSettled events");
}

/*//////////////////////////////////////////////////////////////
                              BUILD
//////////////////////////////////////////////////////////////*/

export type Routes = {
  vault: string;
  cycles: string;
  cycle: (n: number) => string;
  listings: string;
  account: string;
  health: string;
  activity: string;
  activityAll: string;
  strands: string;
  graphql: string;
};

export const routesFor = (depositor: string): Routes => ({
  vault: "GET /v1/vault",
  cycles: "GET /v1/cycles",
  cycle: (n) => `GET /v1/cycles/${n}`,
  listings: "GET /v1/listings",
  account: `GET /v1/account/${depositor}`,
  health: "GET /v1/health",
  activity: "GET /v1/activity",
  activityAll: "GET /v1/activity?include=all",
  strands: "GET /v1/strands",
  graphql: "POST /graphql",
});

/** The GraphQL document the sync posts. Epochs and the vault row are not all on a REST route. */
export const graphqlQuery = (vault: string) => `{
  queueEpochs(orderBy: "epochId", orderDirection: "asc") {
    items { epochId status cycleNumber sharesQueued queueCount sharesSettled assetsSettled usdgSettled sharesClaimed assetsClaimed usdgClaimed claimCount strandGen strandWad strandWadClaimed settledTx }
  }
  vaultState(id: "${vault}") {
    phase cycleNumber writesHalted claimKey optionId listingHash lockedCollateral contractsWritten
    assetBalance usdgBalance reservedAssets usdgReservedForQueue totalShares queuedShares epochId
    accUsdgPerShare totalUsdgDistributed totalUsdgClaimed usdgUnallocated seaportCounter
    protocolFeeBps feeRecipient depositCap maxPriceAge totalFeeSwept lifetimeProtocolFee
    lifetimePremiumGross lifetimeAssignmentUsdg
    lifetimePremiumNet lifetimeStrikeProceeds lifetimeCreditedUsdg lifetimeHaircutAssets
    cyclesWritten cyclesFilled cyclesUnfilled cyclesAssigned cyclesStranded
    stranded strandGen lastResolvedGen strandedRemainingWad strandedCycleNumber lastBlock
  }
}`;

export type Built = { expectations: Expectation[]; disagreements: string[]; crossChecks: number; weeks: WeekTruth[]; strands: StrandTruth[] };

export function buildExpectations(run: RunJson, chain: ChainFacts): Built {
  const b = new Builder();
  const depositor = String(runValue(run, "actors.depositor"));
  const routes = routesFor(depositor);

  b.agree("vault address", runValue(run, "addresses.Vault"), chain.vault);
  b.agree("chain id", run.chainId, chain.chainId);
  const { lastBlock } = runBlocks(run);
  b.agree("last dry-run block = END_BLOCK", lastBlock, chain.endBlock);
  if (run.error !== null) b.disagreements.push(`the dry run recorded an error: ${run.error}`);
  const weeksRun = runCycles(run);
  b.agree("cycles armed", weeksRun.length, chain.cycles.length);

  const strands = chain.strands.map((s) => deriveStrand(b, s));
  const weeks = weeksRun.map((k) => deriveWeek(b, chain, k, strands));
  const byNumberDesc = [...weeks].sort((x, y) => y.cycleNumber - x.cycleNumber);
  const latestWeek = byNumberDesc[0]!;
  const views = chain.views;

  // Strand generations are the vault's own counter; each one is a cycle that stranded.
  b.agree("strandGen() = claims ever stranded", strands.length, views.strandGen);
  b.agree("lastResolvedGen() = claims recovered", strands.filter((s) => s.recovered).length, views.lastResolvedGen);
  const openStrand = strands.find((s) => !s.recovered) ?? null;
  b.agree("isStranded() = an unrecovered strand", openStrand !== null, views.isStranded);
  b.agree("cycles stranded = weeks with a ClaimStranded", weeks.filter((t) => t.stranded).length, strands.length);

  const allHarvests = chain.harvests.map((h) => {
    const c = chain.cycles.find((x) => x.cycleNumber === h.cycleNumber);
    if (c === undefined || c.open === null) throw new Error(`Harvest for cycle ${h.cycleNumber} but that cycle never opened`);
    if (c.close === null) throw new Error(`Harvest for still-open cycle ${h.cycleNumber}: a checkpoint on an armed week is not in this dry run`);
    const cc = c as ChainCycle & { close: NonNullable<ChainCycle["close"]> };
    const fills = chain.listings.filter((l) => l.optionId === c.open!.optionId).flatMap((l) => l.fills);
    const strand = c.stranded === null ? null : (chain.strands.find((s) => s.gen === c.stranded!.gen) ?? null);
    return deriveHarvest(b, h, cc, fills, strand);
  });
  const harvestsDesc = [...allHarvests].sort((x, y) => (x.block > y.block ? -1 : x.block < y.block ? 1 : 0));
  const terminalsDesc = harvestsDesc.filter((h) => h.origin === "rollClose");

  /* ---------------- per-cycle routes ---------------- */
  for (const t of weeks) {
    const r = b.route(routes.cycle(t.cycleNumber));
    expectCycle(r.at("cycle"), t);
    const listingsDesc = [...t.listings].sort((x, y) => y.seq - x.seq);
    r.eq("listings.length", listingsDesc.length, "ListingApproved events for this option id");
    listingsDesc.forEach((l, i) => expectListing(r.at(`listings[${i}]`), l));
    r.eq("harvests.length", t.allHarvests.length, "every Harvest carrying this cycle's number");
    t.allHarvests.forEach((h, i) => expectHarvest(r.at(`harvests[${i}]`), h));
    const cycleStrands = strands.filter((s) => s.cycleNumber === t.cycleNumber).sort((x, y) => (x.gen > y.gen ? -1 : 1));
    r.eq("strands.length", cycleStrands.length, "ClaimStranded events for this cycle");
    cycleStrands.forEach((s, i) => expectStrand(r.at(`strands[${i}]`), s));
  }

  /* ---------------- list routes ---------------- */
  const list = b.route(routes.cycles);
  list.eq("count", weeks.length);
  list.eq("cycles.length", weeks.length);
  list.eq("totals.armed", chain.cycles.length, "RollOpen events");
  list.eq("totals.filled", weeks.filter((t) => t.sold > 0n).length);
  list.eq("totals.unfilled", weeks.filter((t) => t.status === "unfilled").length);
  list.eq("totals.assigned", weeks.filter((t) => t.assigned > 0n).length);
  list.eq("totals.stranded", weeks.filter((t) => t.stranded).length);
  byNumberDesc.forEach((t, i) => expectCycle(list.at(`cycles[${i}]`), t));

  const listings = b.route(routes.listings);
  const allListings = weeks.flatMap((t) => t.listings).sort((x, y) => Number(y.approvedBlock - x.approvedBlock));
  listings.eq("count", allListings.length);
  listings.eq("listings.length", allListings.length);
  listings.eq("liveHash", views.listingHash === ZERO_HASH ? null : lower(views.listingHash), "listingHash() (zero = none, X-1)");
  listings.eq("seaportCounter", views.seaportCounter.toString(), "seaport.getCounter(vault)");
  allListings.forEach((l, i) => expectListing(listings.at(`listings[${i}]`), l));

  const activity = b.route(routes.activity);
  activity.eq("include", "terminal");
  activity.eq("count", terminalsDesc.length, "one terminal Harvest per rollClose");
  terminalsDesc.forEach((h, i) => expectHarvest(activity.at(`harvests[${i}]`), h));
  const activityAll = b.route(routes.activityAll);
  activityAll.eq("include", "all");
  activityAll.eq("count", harvestsDesc.length, "every Harvest log on chain");
  harvestsDesc.forEach((h, i) => expectHarvest(activityAll.at(`harvests[${i}]`), h));

  const strandsRoute = b.route(routes.strands);
  const strandsDesc = [...strands].sort((x, y) => (x.gen > y.gen ? -1 : 1));
  strandsRoute.eq("stranded", views.isStranded, "isStranded()");
  strandsRoute.eq("count", strandsDesc.length);
  strandsRoute.eq("strands.length", strandsDesc.length);
  strandsDesc.forEach((s, i) => expectStrand(strandsRoute.at(`strands[${i}]`), s));

  /* ---------------- /v1/vault ---------------- */
  const v = b.route(routes.vault);
  const imm = chain.immutables;
  v.eq("addresses.chainId", chain.chainId);
  v.eq("addresses.vault", chain.vault);
  v.eq("addresses.asset", imm.asset);
  v.eq("addresses.usdg", imm.usdg);
  v.eq("addresses.clearinghouse", imm.clear);
  v.eq("addresses.seaport", imm.seaport);
  v.eq("live", true);
  v.eq("blockNumber", chain.endBlock.toString());

  v.eq("phase.code", views.phase);
  v.eq("phase.name", ["Idle", "Listed", "Exercisable", "Settling"][views.phase] ?? "Unknown");
  v.eq("phase.writesHalted", views.writesHalted);
  v.eq("phase.canRedeemInstantly", views.canRedeemInstantly);
  v.eq("phase.depositsOpen", views.maxDepositZero > 0n, "maxDeposit(0) > 0");
  v.eq("phase.valoremFeeAccepted", views.valoremFeeAccepted);
  v.eq("phase.clearFeesEnabled", views.clearFeesEnabled, "clear.feesEnabled()");
  v.eq("phase.oraclePaused", views.oraclePaused);
  v.eq("phase.tokenPaused", false);
  v.eq("phase.maxPriceAgeSeconds", chain.settings.maxPriceAge, "maxPriceAge()");

  const st = v.at("stranded");
  st.eq("stranded", views.isStranded, "isStranded()");
  st.eq("gen", views.strandGen.toString(), "strandGen()");
  st.eq("lastResolvedGen", views.lastResolvedGen.toString(), "lastResolvedGen()");
  st.eq("remainingWad", views.strandedRemainingWad.toString(), "strandedRemainingWad()");
  st.eq("wad", WAD.toString());
  st.eq("cycle", openStrand === null ? null : openStrand.cycleNumber, "the unrecovered strand's cycle, else null");
  st.eq("claimKey", openStrand === null ? null : openStrand.claimKey.toString());
  st.eq("since", openStrand === null ? null : isoOf(openStrand.strandedAt));
  if (openStrand === null) st.eq("lockedAssets", null);
  else st.asset("lockedAssets", views.lockedAssets, "lockedAssets() while stranded");

  v.asset("tvl.totalAssets", views.totalAssets, "totalAssets()");
  v.asset("tvl.idleAssets", views.idleAssets, "idleAssets()");
  v.asset("tvl.lockedAssets", views.lockedAssets, "lockedAssets()");
  v.asset("tvl.reservedAssets", views.reservedAssets, "reservedAssets() (the indexed reserve must agree)");
  v.asset("tvl.totalShares", views.totalSupply, "totalSupply()");
  v.asset("tvl.pricePerShare", views.totalSupply === 0n ? ONE : (views.totalAssets * ONE) / views.totalSupply);
  v.asset("tvl.depositCap", chain.settings.depositCap, "depositCap()");
  v.asset("tvl.maxDeposit", views.maxDepositZero, "maxDeposit(0)");
  v.eq("tvl.uiMultiplier", views.uiMultiplier.toString(), "uiMultiplier()");
  v.eq("tvl.uiMultiplierPending", null);
  v.eq("tvl.uiMultiplierEffectiveAt", null);
  if (views.spotUsdg === null) v.eq("tvl.spotUsdg", null);
  else v.usdg("tvl.spotUsdg", views.spotUsdg, "spotUsdg()");

  const claimedOnChain = sum(chain.claims, (c) => c.amount) + sum(chain.queue.settled, (s) => s.usdgOut);
  b.agree("sum of ClaimUsdg + queue escrow takes = totalUsdgClaimed()", claimedOnChain, views.totalUsdgClaimed);
  b.agree("sum of UsdgDistributed = totalUsdgDistributed()", chain.usdgDistributed, views.totalUsdgDistributed);
  v.usdg("usdg.balance", views.usdgBalance, "usdg.balanceOf(vault) (the indexed balance must agree)");
  v.usdg("usdg.distributed", views.totalUsdgDistributed, "totalUsdgDistributed()");
  v.usdg("usdg.claimed", views.totalUsdgClaimed, "totalUsdgClaimed(): ClaimUsdg plus the queue escrow's take at settlement");
  v.usdg("usdg.reservedForQueue", views.usdgReservedForQueue, "usdgReservedForQueue()");
  v.usdg("usdg.unallocated", views.usdgUnallocated, "usdgUnallocated()");
  v.eq("usdg.accUsdgPerShare", views.accUsdgPerShare.toString(), "accUsdgPerShare()");
  v.eq("usdg.accUsdgPerSharePrecision", (10n ** 27n).toString());
  v.eq("usdg.protocolFeeBps", chain.settings.protocolFeeBps, "policy().protocolFeeBps");
  v.eq("usdg.feeRecipient", lower(chain.settings.feeRecipient), "feeRecipient() (set in the constructor, no event)");
  v.asset("queue.queuedShares", views.queuedShares, "queuedShares()");
  v.eq("queue.epochId", views.epochId.toString(), "epochId()");
  v.eq("queue.canSettle", views.phase === 0 && views.queuedShares > 0n, "Idle with shares queued");

  const latestClosed = byNumberDesc.find((t) => t.status !== "listed") ?? latestWeek;
  expectCycle(v.at("week.cycle"), latestWeek);
  const wo = v.at("week.option");
  // After a close the vault forgets the armed type (`optionId` 0 → the cycle row's) unless the
  // claim is stranded, and keeps the strike and the window until the next `rollOpen`.
  wo.eq("optionId", views.optionId === 0n ? latestWeek.optionId.toString() : views.optionId.toString(), "optionId(), or the cycle row once cleared");
  wo.eq("claimKey", views.claimKey === 0n ? (latestWeek.claimKey === null ? null : latestWeek.claimKey.toString()) : views.claimKey.toString(), "claimKey(), or the cycle row once cleared");
  wo.usdg("strikeUsdg", views.cycleStrikeUsdg, "cycleStrikeUsdg()");
  wo.eq("exerciseTimestamp", views.cycleExerciseTs.toString(), "cycleExerciseTs()");
  wo.eq("exerciseAt", isoOf(views.cycleExerciseTs));
  wo.eq("expiryTimestamp", views.cycleExpiryTs.toString(), "cycleExpiryTs()");
  wo.eq("expiryAt", isoOf(views.cycleExpiryTs));
  v.eq("week.listing.hash", views.listingHash === ZERO_HASH ? null : lower(views.listingHash), "listingHash() (zero = null, X-1)");
  v.eq("week.listing.contracts", views.listingAmount.toString());
  v.usdg("week.listing.grossUsdg", views.listingGrossUsdg);
  v.eq("week.listing.listingsThisCycle", views.listingsThisCycle);
  v.eq("week.listing.maxListingsPerCycle", 3);
  v.eq("week.assignmentLive.contractsAssigned", views.contractsAssigned.toString());
  v.eq("week.assignmentLive.contractsWritten", views.contractsWritten.toString());
  v.eq("week.assignmentLive.capacity", capacityOf(chain.settings, views.totalAssets, views.contractsWritten).toString(), "Policy.maxContracts(totalAssets) - contractsWritten");

  // X-3: the last TERMINAL harvest, which is not the last harvest when a retry or a checkpoint
  // came after it; and the last closed week whole.
  expectHarvest(v.at("lastHarvest"), terminalsDesc[0]!);
  expectCycle(v.at("lastClosedCycle"), latestClosed);

  const lifetime = {
    premiumGross: sum(weeks, (t) => t.premiumGross),
    // Strike USDG the claims returned, stranded recoveries included, whoever it went to.
    assignmentUsdg: sum(chain.cycles, (c) => c.close?.usdgFromAssignment ?? 0n) + sum(chain.strands, (s) => s.recovered?.usdgOut ?? 0n),
    // The harvest tallies run over EVERY Harvest log, post-close checkpoints included.
    protocolFee: sum(allHarvests, (h) => h.fee),
    premiumNet: sum(allHarvests, (h) => h.premiumNet),
    strikeProceeds: sum(allHarvests, (h) => h.strikeProceeds),
    credited: sum(allHarvests, (h) => h.net),
    haircut: sum(chain.queue.haircuts, (h) => h.booked - h.paid),
  };
  b.agree("pendingFeeUsdg = fee accrued - fee swept", lifetime.protocolFee - chain.feeSwept, views.pendingFeeUsdg);
  v.eq("lifetime.cyclesArmed", weeks.length, "RollOpen events");
  v.eq("lifetime.cyclesFilled", weeks.filter((t) => t.sold > 0n).length);
  v.eq("lifetime.cyclesUnfilled", weeks.filter((t) => t.status === "unfilled").length);
  v.eq("lifetime.cyclesAssigned", weeks.filter((t) => t.assigned > 0n).length);
  v.eq("lifetime.cyclesStranded", weeks.filter((t) => t.stranded).length, "ClaimStranded events");
  v.usdg("lifetime.premiumGross", lifetime.premiumGross, "sum of fills (one consideration item)");
  v.usdg("lifetime.assignmentUsdg", lifetime.assignmentUsdg, "sum of RollClose.usdgFromAssignment + StrandedClaimRecovered.usdgOut");
  v.usdg("lifetime.protocolFee", lifetime.protocolFee, "sum of Harvest.feeUsdg");
  v.usdg("lifetime.premiumNet", lifetime.premiumNet, "sum over every Harvest of (gross - strike proceeds - fee)");
  v.usdg("lifetime.strikeProceedsUsdg", lifetime.strikeProceeds, "sum over every Harvest of its strike-proceeds part");
  v.usdg("lifetime.creditedUsdg", lifetime.credited, "sum of Harvest.netUsdg");
  v.asset("lifetime.haircutAssets", lifetime.haircut, "sum of ReserveHaircut booked - paid");

  const holders = (role: string) => chain.roles.filter((r) => r.granted && lower(role) === lower(r.role)).map((r) => lower(r.account));
  // Role hashes: keccak256 of the name, and 0x00 for the admin (OpenZeppelin AccessControl).
  const ROLE_ADMIN = ZERO_HASH;
  const ROLE_KEEPER = keccak256(toHex("KEEPER_ROLE"));
  const ROLE_GUARDIAN = keccak256(toHex("GUARDIAN_ROLE"));
  v.eq("roles.admin", holders(ROLE_ADMIN), "RoleGranted logs");
  v.eq("roles.keeper", holders(ROLE_KEEPER), "RoleGranted logs");
  v.eq("roles.guardian", holders(ROLE_GUARDIAN), "RoleGranted logs");
  b.agree("admin role holder", [lower(String(runValue(run, "actors.admin")))], holders(ROLE_ADMIN));
  b.agree("keeper role holder", [lower(String(runValue(run, "actors.keeper")))], holders(ROLE_KEEPER));

  v.eq("indexedAt.blockNumber", chain.lastVaultActivityBlock.toString(), "last block with a vault-state event");
  v.eq("indexedAt.timestamp", chain.lastVaultActivityTimestamp.toString());
  v.eq("indexedAt.at", isoOf(chain.lastVaultActivityTimestamp));

  /* ---------------- the redeem queue, replayed ---------------- */
  // Every epoch the index has a row for: queued into, settled, or opened after a settlement.
  const epochIds = new Set<bigint>([
    ...chain.queue.redeems.map((q) => q.epochId),
    ...chain.queue.settled.flatMap((s) => [s.epochId, s.epochId + 1n]),
    ...chain.strands.flatMap((s) => s.epochShares.map((e) => e.epochId)),
  ]);
  const epochs = [...epochIds].sort((x, y) => (x < y ? -1 : 1));
  type EpochTruth = {
    id: bigint;
    settled: ChainFacts["queue"]["settled"][number] | null;
    cycleNumber: number | null;
    redeems: ChainFacts["queue"]["redeems"];
    entries: ChainFacts["queue"]["entries"];
    strandGen: bigint | null;
    strandWad: bigint;
    strandWadClaimed: bigint;
  };
  const epochTruths: EpochTruth[] = epochs.map((id) => {
    const settled = chain.queue.settled.find((s) => s.epochId === id) ?? null;
    const settledIn = settled === null ? undefined : weeks.find((t) => t.txClose === lower(settled.txHash));
    const entries = chain.queue.entries.filter((q) => q.epochId === id);
    const share = chain.strands.flatMap((s) => s.epochShares.filter((e) => e.epochId === id).map((e) => ({ gen: s.gen, wad: e.wad })))[0] ?? null;
    const taken = share === null ? [] : epochStrandDrawdown(settled?.shares ?? 0n, share.wad, entries);
    return {
      id,
      settled,
      cycleNumber: settledIn === undefined ? null : settledIn.cycleNumber,
      redeems: chain.queue.redeems.filter((q) => q.epochId === id),
      entries,
      strandGen: share === null ? null : share.gen,
      strandWad: share?.wad ?? 0n,
      strandWadClaimed: sum(taken, (x) => x),
    };
  });

  /* ---------------- /v1/account/:depositor ---------------- */
  const a = b.route(routes.account);
  const acct = chain.account;
  const mine = (owner: string) => lower(owner) === lower(depositor);
  const deposited = sum(chain.deposits.filter((d) => mine(d.owner)), (d) => d.assets);
  const withdrawn = sum(chain.withdraws.filter((d) => mine(d.owner)), (d) => d.assets);
  const completes = chain.queue.completes.filter((c) => mine(c.owner));
  const claimedUsdg = sum(chain.claims.filter((c) => mine(c.account)), (c) => c.amount);
  const haircut = sum(chain.queue.haircuts.filter((h) => mine(h.owner)), (h) => h.booked - h.paid);
  // A deferred USDG leg stays on record until a later payout moves USDG for the same owner.
  let deferredUsdg = 0n;
  for (const ev of [
    ...chain.queue.deferred.filter((d) => mine(d.owner)).map((d) => ({ block: d.block, kind: "defer" as const, amount: d.usdgOwed })),
    ...completes.map((c) => ({ block: c.block, kind: "pay" as const, amount: c.usdgOut })),
  ].sort((x, y) => (x.block < y.block ? -1 : x.block > y.block ? 1 : x.kind === "defer" ? -1 : 1))) {
    if (ev.kind === "defer") deferredUsdg = ev.amount;
    else if (ev.amount > 0n) deferredUsdg = 0n;
  }
  const queuedEpoch = acct.queuedEpoch;
  const epoch = queuedEpoch === 0n ? null : (epochTruths.find((e) => e.id === queuedEpoch) ?? null);
  const epochStrandWad = epoch === null || epoch.strandGen === null ? 0n : epoch.strandWad - epoch.strandWadClaimed;
  const pendingGen = acct.owedStrandWad > 0n ? acct.owedStrandGen : (epoch?.strandGen ?? null);
  const pendingStrand = pendingGen === null || pendingGen === 0n ? null : (strands.find((s) => s.gen === pendingGen) ?? null);

  a.eq("address", depositor);
  a.eq("live", true);
  a.eq("known", true);
  a.asset("position.shares", acct.shares, "balanceOf(depositor)");
  a.asset("position.sharesAsAssets", acct.sharesAsAssets, "convertToAssets(shares)");
  a.usdg("position.claimableUsdg", acct.claimableUsdg, "claimableUsdg(depositor)");
  a.asset("queue.queuedShares", acct.queuedShares, "queuedSharesOf(depositor)");
  a.eq("queue.epochId", acct.queuedEpoch.toString(), "queuedEpochOf(depositor)");
  a.eq("queue.settled", epoch !== null && epoch.settled !== null, "the epoch's QueueSettled");
  a.eq("queue.claimable", queuedEpoch !== 0n && queuedEpoch < views.epochId, "queued epoch < epochId()");
  a.asset("queue.previewAssets", acct.previewAssets, "previewCompleteRedeem(depositor)");
  a.usdg("queue.previewUsdg", acct.previewUsdg, "previewCompleteRedeem(depositor)");
  a.eq("queue.epochSettledAt", epoch === null ? null : isoOf(epoch.settled?.timestamp ?? null));
  a.usdg("queue.deferredUsdg", deferredUsdg, "UsdgLegDeferred not yet paid by a later CompleteRedeem");
  if (acct.owedStrandWad === 0n && epochStrandWad === 0n) a.eq("strand", null, "owedStrandWad(depositor) == 0 and no epoch share pending");
  else {
    const s = a.at("strand");
    s.eq("gen", pendingGen === null ? null : pendingGen.toString(), "owedStrandGen(depositor), or the queued epoch's generation");
    s.eq("wad", acct.owedStrandWad.toString(), "owedStrandWad(depositor)");
    s.eq("epochWad", epochStrandWad.toString(), "the queued epoch's EpochStrandShare.wad less what its settled entries took");
    s.eq("recovered", pendingStrand?.recovered ?? false);
    if (pendingStrand === null) s.eq("strand", null);
    else expectStrand(s.at("strand"), pendingStrand);
  }
  a.asset("lifetime.deposited", deposited, "Deposit logs");
  a.asset("lifetime.withdrawn", withdrawn, "Withdraw logs (instant redemptions)");
  a.asset("lifetime.redeemedAssets", sum(completes, (c) => c.assets), "CompleteRedeem.assets");
  a.usdg("lifetime.redeemedUsdg", sum(completes, (c) => c.usdgOut), "CompleteRedeem.usdgOut");
  a.usdg("lifetime.claimedUsdg", claimedUsdg, "ClaimUsdg logs");
  a.asset("lifetime.haircutAssets", haircut, "ReserveHaircut booked - paid");
  a.eq("lifetime.depositCount", chain.deposits.filter((d) => mine(d.owner)).length);
  a.eq("lifetime.firstSeenAt", isoOf(chain.depositorFirstSeen));
  a.eq("lifetime.lastActivityAt", isoOf(chain.depositorLastActivity));

  /* ---------------- /v1/health ---------------- */
  const hl = b.route(routes.health);
  hl.eq("status", "ok");
  hl.eq("chain.id", chain.chainId);
  hl.eq("chain.name", "robinhood");
  hl.eq("indexer.head", chain.endBlock.toString(), "END_BLOCK");
  hl.eq("indexer.headTimestamp", chain.endBlockTimestamp.toString());
  hl.eq("indexer.headAt", isoOf(chain.endBlockTimestamp));
  hl.eq("rpc.head", chain.endBlock.toString());
  hl.eq("rpc.reachable", true);
  hl.eq("lag.blocks", "0");
  hl.eq("vault.address", chain.vault);
  hl.eq("vault.phase", views.phase);
  hl.eq("vault.phaseName", ["Idle", "Listed", "Exercisable", "Settling"][views.phase] ?? "Unknown");
  hl.eq("vault.cycle", views.cycleNumber, "cycleNumber()");
  hl.eq("vault.writesHalted", views.writesHalted);
  hl.eq("vault.stranded", views.isStranded, "isStranded()");
  hl.eq("vault.lastActivityBlock", chain.lastVaultActivityBlock.toString());
  hl.eq("vault.lastActivityAt", isoOf(chain.lastVaultActivityTimestamp));

  /* ---------------- GraphQL: epochs and the vault row ---------------- */
  const g = b.route(routes.graphql);
  g.eq("data.queueEpochs.items.length", epochTruths.length, "epochs queued into, settled, and the one opened after each settlement");
  epochTruths.forEach((e, i) => {
    const w = g.at(`data.queueEpochs.items[${i}]`);
    w.eq("epochId", e.id.toString());
    w.eq("status", e.settled === null ? "open" : "settled");
    w.eq("cycleNumber", e.cycleNumber, "the cycle whose rollClose settled it; null for a flat settleQueue()");
    w.eq("sharesQueued", sum(e.redeems, (q) => q.shares).toString(), "QueueRedeem.shares");
    w.eq("queueCount", e.redeems.length);
    w.eq("sharesSettled", (e.settled?.shares ?? 0n).toString(), "QueueSettled.shares");
    w.eq("assetsSettled", (e.settled?.assets ?? 0n).toString(), "QueueSettled.assets");
    w.eq("usdgSettled", (e.settled?.usdgOut ?? 0n).toString(), "QueueSettled.usdgOut");
    w.eq("sharesClaimed", sum(e.entries, (q) => q.shares).toString(), "QueueEntrySettled.shares");
    w.eq("assetsClaimed", sum(e.entries, (q) => q.assets).toString(), "QueueEntrySettled.assets");
    w.eq("usdgClaimed", sum(e.entries, (q) => q.usdgOut).toString(), "QueueEntrySettled.usdgOut");
    w.eq("claimCount", e.entries.length);
    w.eq("strandGen", e.strandGen === null ? null : e.strandGen.toString(), "EpochStrandShare.gen");
    w.eq("strandWad", e.strandWad.toString(), "EpochStrandShare.wad");
    w.eq("strandWadClaimed", e.strandWadClaimed.toString(), "the entries' pro-rata draw on it, last claimant taking the rest");
    w.eq("settledTx", e.settled === null ? null : lower(e.settled.txHash));
  });

  const vs = g.at("data.vaultState");
  const openClaim = views.claimKey !== 0n;
  vs.eq("phase", views.phase);
  vs.eq("cycleNumber", views.cycleNumber);
  vs.eq("writesHalted", views.writesHalted);
  vs.eq("claimKey", openClaim ? views.claimKey.toString() : null, "claimKey() (0 → null)");
  vs.eq("optionId", views.optionId === 0n ? null : views.optionId.toString(), "optionId() (0 → null; forgotten at an unfilled close, cleared at a redeem, kept while stranded)");
  vs.eq("listingHash", views.listingHash === ZERO_HASH ? null : lower(views.listingHash));
  vs.eq("lockedCollateral", (openClaim ? latestWeek.collateral : 0n).toString(), "the open claim's CallsWritten.collateral, 0 once redeemed");
  vs.eq("contractsWritten", views.contractsWritten.toString());
  vs.eq("assetBalance", views.assetBalance.toString(), "asset.balanceOf(vault)");
  vs.eq("usdgBalance", views.usdgBalance.toString(), "usdg.balanceOf(vault)");
  vs.eq("reservedAssets", views.reservedAssets.toString());
  vs.eq("usdgReservedForQueue", views.usdgReservedForQueue.toString());
  vs.eq("totalShares", views.totalSupply.toString());
  vs.eq("queuedShares", views.queuedShares.toString());
  vs.eq("epochId", views.epochId.toString());
  vs.eq("accUsdgPerShare", views.accUsdgPerShare.toString());
  vs.eq("totalUsdgDistributed", views.totalUsdgDistributed.toString());
  vs.eq("totalUsdgClaimed", views.totalUsdgClaimed.toString(), "totalUsdgClaimed()");
  vs.eq("usdgUnallocated", views.usdgUnallocated.toString());
  vs.eq("seaportCounter", views.seaportCounter.toString());
  vs.eq("protocolFeeBps", chain.settings.protocolFeeBps, "policy().protocolFeeBps");
  vs.eq("feeRecipient", lower(chain.settings.feeRecipient), "feeRecipient()");
  vs.eq("depositCap", chain.settings.depositCap.toString(), "depositCap()");
  vs.eq("maxPriceAge", chain.settings.maxPriceAge);
  vs.eq("totalFeeSwept", chain.feeSwept.toString(), "FeeSwept logs");
  vs.eq("lifetimeProtocolFee", lifetime.protocolFee.toString());
  vs.eq("lifetimePremiumGross", lifetime.premiumGross.toString());
  vs.eq("lifetimeAssignmentUsdg", lifetime.assignmentUsdg.toString());
  vs.eq("lifetimePremiumNet", lifetime.premiumNet.toString());
  vs.eq("lifetimeStrikeProceeds", lifetime.strikeProceeds.toString());
  vs.eq("lifetimeCreditedUsdg", lifetime.credited.toString());
  vs.eq("lifetimeHaircutAssets", lifetime.haircut.toString());
  vs.eq("cyclesWritten", weeks.length);
  vs.eq("cyclesFilled", weeks.filter((t) => t.sold > 0n).length);
  vs.eq("cyclesUnfilled", weeks.filter((t) => t.status === "unfilled").length);
  vs.eq("cyclesAssigned", weeks.filter((t) => t.assigned > 0n).length);
  vs.eq("cyclesStranded", weeks.filter((t) => t.stranded).length);
  vs.eq("stranded", views.isStranded);
  vs.eq("strandGen", views.strandGen.toString());
  vs.eq("lastResolvedGen", views.lastResolvedGen.toString());
  vs.eq("strandedRemainingWad", views.strandedRemainingWad.toString());
  vs.eq("strandedCycleNumber", openStrand === null ? null : openStrand.cycleNumber);
  vs.eq("lastBlock", chain.lastVaultActivityBlock.toString());

  return { expectations: b.expectations, disagreements: b.disagreements, crossChecks: b.crossChecks, weeks, strands };
}
