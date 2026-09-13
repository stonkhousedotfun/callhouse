/**
 * What every API route must say, built from the keeper dry run's record (run.json) and the fork's
 * own logs and views (chain.ts). Pure: no network, no Ponder.
 *
 * Precedence. A figure the dry run recorded — and asserted on chain while it ran — is taken from
 * run.json, and the chain's copy of it is cross-checked into `disagreements`. A figure the dry run
 * never recorded (supply at harvest, block timestamps, the Seaport counter, Valorem's bucket, the
 * live views the API layers on top) comes from the chain. Nothing is ever taken from the indexer.
 *
 * Every expected money figure is derived here the way the product defines it (README "The money
 * columns the site quotes"), not copied from the indexer's lib/harvest.ts, so an arithmetic slip
 * in the indexer cannot agree with itself.
 */
import { formatUnits, keccak256, toHex } from "viem";

import type { ChainCycle, ChainFacts, ChainHarvest, ChainListing } from "./chain.ts";
import type { Expectation, Json } from "./diff.ts";

/*//////////////////////////////////////////////////////////////
                       run.json (the fields read)
//////////////////////////////////////////////////////////////*/

export type KeeperCycleRow = {
  cycle_number: number;
  option_id: string;
  strike_usdg6: string;
  contracts: number;
  status: string;
  roll_open_tx: string | null;
  lock_tx: string | null;
  roll_close_tx: string | null;
  gross_usdg6: string | null;
  fee_usdg6: string | null;
  net_usdg6: string | null;
  contracts_assigned: number;
  assets_returned?: string | null;
  usdg_from_assignment?: string | null;
};

export type KeeperListingRow = {
  order_hash: string;
  cycle_number: number;
  seq: number;
  option_id: string;
  contracts: string;
  unit_price6: string;
  gross_usdg6: string;
  to_vault6: string;
  to_overcall6: string;
  status: string;
  approve_tx: string | null;
};

export type RunJson = {
  forkBlock: string;
  chainId: number;
  error: string | null;
  actors: Record<string, string>;
  addresses: Record<string, string>;
  cycle1: Record<string, unknown>;
  cycle2: Record<string, unknown>;
  cycle3: Record<string, unknown>;
  harnessTxs: Array<{ label: string; by: string; hash: string; block: string }>;
  db: { cycles: KeeperCycleRow[]; listings: KeeperListingRow[]; txs: Array<{ hash: string; block_number: number | null }> };
};

/** Walk `a.b.c` into run.json and fail loudly if the dry run did not record it. */
export function runValue(run: RunJson, path: string): unknown {
  let cur: unknown = run;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !(key in (cur as object))) {
      throw new Error(`run.json has no ${path}. Did the dry run finish all three cycles? (run.error: ${run.error ?? "none"})`);
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const runBig = (run: RunJson, path: string): bigint => {
  const v = runValue(run, path);
  if (typeof v !== "string" && typeof v !== "number" && typeof v !== "bigint") throw new Error(`run.json ${path} is not a number: ${JSON.stringify(v)}`);
  return BigInt(v);
};

/** Block bounds of the dry run: the vault's and the mock registry's deploy blocks, and the last tx. */
export function runBlocks(run: RunJson): { vaultDeployBlock: bigint; registryDeployBlock: bigint; lastBlock: bigint } {
  const deploy = (label: string) => {
    const tx = run.harnessTxs.find((t) => t.label === `deploy ${label}`);
    if (tx === undefined) throw new Error(`run.json harnessTxs has no "deploy ${label}"`);
    return BigInt(tx.block);
  };
  const blocks = [
    ...run.harnessTxs.map((t) => BigInt(t.block)),
    ...run.db.txs.filter((t) => t.block_number !== null).map((t) => BigInt(t.block_number as number)),
  ];
  return { vaultDeployBlock: deploy("Vault"), registryDeployBlock: deploy("MockRegistry"), lastBlock: blocks.reduce((m, b) => (b > m ? b : m), 0n) };
}

/*//////////////////////////////////////////////////////////////
                              HELPERS
//////////////////////////////////////////////////////////////*/

const USDG_DECIMALS = 6;
const ASSET_DECIMALS = 18;
const ONE = 10n ** 18n;
const ZERO_HASH = `0x${"0".repeat(64)}`;

/** The API's `iso()`: unix seconds to ISO 8601, and 0 / null to null. */
export const isoOf = (secs: bigint | null | undefined): string | null =>
  secs === null || secs === undefined || secs === 0n ? null : new Date(Number(secs) * 1000).toISOString();

const lower = (s: string) => s.toLowerCase();

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

/** One week as the product defines it, every figure derived rather than copied. */
export type WeekTruth = {
  cycleNumber: number;
  status: "closed" | "unfilled" | "assigned";
  optionIds: string[];
  lotSize: bigint;
  exerciseTimestamp: bigint;
  expiryTimestamp: bigint;
  setAt: bigint;
  setTx: string;
  optionId: bigint;
  claimKey: bigint;
  strike: bigint;
  contracts: bigint;
  collateral: bigint;
  openedAt: bigint;
  txOpen: string;
  listing: ListingTruth;
  sold: bigint;
  fillCount: number;
  premiumGross: bigint;
  premiumToVault: bigint;
  overcallFee: bigint;
  firstFillAt: bigint | null;
  lastFillAt: bigint | null;
  lockedAt: bigint;
  assigned: bigint;
  assetsReturned: bigint;
  marketExercised: bigint;
  bucketIndex: bigint | null;
  bucketAssigned: bigint;
  closedAt: bigint;
  txClose: string;
  /** Harvest gross / fee / net of the one terminal harvest. */
  gross: bigint;
  fee: bigint;
  net: bigint;
  strikeProceeds: bigint;
  harvestPremiumGross: bigint;
  premiumNet: bigint;
  supply: bigint;
  premiumNetPerShare: bigint;
  usdgPerShare: bigint;
  accAfter: bigint;
  harvestTx: string;
  harvestAt: bigint;
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
  writer: bigint;
  overcallFee: bigint;
  contractsFilled: bigint;
  fillCount: number;
  proceeds: bigint;
  feePaid: bigint;
  lastFillAt: bigint | null;
  lastFillTx: string | null;
  approvedAt: bigint;
  approvedBlock: bigint;
  approvedTx: string;
  endedAt: bigint | null;
  endedTx: string | null;
  endReason: string | null;
};

const perShare = (amount: bigint, supply: bigint) => (supply === 0n ? 0n : (amount * ONE) / supply);

function deriveListing(b: Builder, run: RunJson, cycle: number, chain: ChainListing): ListingTruth {
  const k = run.db.listings.find((l) => l.cycle_number === cycle);
  if (k === undefined) throw new Error(`run.json db.listings has no row for cycle ${cycle}`);
  const contracts = BigInt(k.contracts);
  const gross = BigInt(k.gross_usdg6);
  const unitPrice = BigInt(k.unit_price6);
  b.agree(`cycle ${cycle} listing order hash`, k.order_hash, chain.orderHash);
  b.agree(`cycle ${cycle} listing contracts`, contracts, chain.amount);
  b.agree(`cycle ${cycle} listing gross`, gross, chain.grossUsdg);
  b.agree(`cycle ${cycle} listing unit price`, unitPrice * contracts, chain.grossUsdg);
  b.agree(`cycle ${cycle} listing approve tx`, k.approve_tx, chain.approvedTx);
  b.agree(`cycle ${cycle} listing seq`, k.seq, chain.seq);

  const contractsFilled = chain.fills.reduce((s, f) => s + f.contracts, 0n);
  const proceeds = chain.fills.reduce((s, f) => s + f.toVault, 0n);
  const feePaid = chain.fills.reduce((s, f) => s + f.toOvercall, 0n);
  const lastFill = chain.fills.at(-1) ?? null;
  const complete = contractsFilled >= contracts && contracts > 0n;
  b.agree(`cycle ${cycle} keeper listing status`, k.status === "filled", complete);
  if (complete) {
    b.agree(`cycle ${cycle} fill to vault`, k.to_vault6, proceeds);
    b.agree(`cycle ${cycle} fill to Overcall`, k.to_overcall6, feePaid);
  }

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
    endReason = chain.cancelled.invalidated ? "invalidated" : "cancelled";
  } else if (contractsFilled > 0n) {
    status = "partially_filled";
  }

  return {
    orderHash: lower(k.order_hash),
    cycle,
    seq: k.seq,
    status,
    optionId: BigInt(k.option_id),
    contracts,
    gross,
    unitPrice,
    writer: BigInt(k.to_vault6),
    overcallFee: BigInt(k.to_overcall6),
    contractsFilled,
    fillCount: chain.fills.length,
    proceeds,
    feePaid,
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

function deriveWeek(b: Builder, run: RunJson, chain: ChainFacts, n: 1 | 2 | 3): WeekTruth {
  const r = `cycle${n}`;
  const c: ChainCycle | undefined = chain.cycles.find((x) => x.cycleNumber === n);
  const k = run.db.cycles.find((x) => x.cycle_number === n);
  if (c === undefined || c.set === null || c.open === null || c.written === null || c.locked === null || c.close === null) {
    throw new Error(`the chain has no complete cycle ${n} (CycleSet, RollOpen, CallsWritten, BookLocked, RollClose)`);
  }
  if (k === undefined) throw new Error(`run.json db.cycles has no row for cycle ${n}`);

  const optionIds = runValue(run, `${r}.optionIds`) as string[];
  b.agree(`cycle ${n} registry option ids`, optionIds, c.set.optionIds);
  const exerciseTimestamp = runBig(run, `${r}.exerciseTimestamp`);
  const expiryTimestamp = runBig(run, `${r}.expiryTimestamp`);
  b.agree(`cycle ${n} exercise timestamp`, exerciseTimestamp, c.set.exerciseAt);
  b.agree(`cycle ${n} expiry timestamp`, expiryTimestamp, c.set.expireAt);
  const setTx = run.harnessTxs.find((t) => t.label === `MockRegistry.setCycleWithStrikes(cycle ${n})`);
  b.agree(`cycle ${n} CycleSet tx`, setTx?.hash ?? null, c.set.txHash);

  const contracts = runBig(run, `${r}.contracts`);
  const strike = runBig(run, `${r}.strikeUsdg6`);
  b.agree(`cycle ${n} contracts written`, contracts, c.open.contracts);
  b.agree(`cycle ${n} keeper row contracts`, k.contracts, c.open.contracts);
  b.agree(`cycle ${n} strike`, strike, c.open.strike);
  b.agree(`cycle ${n} option id`, k.option_id, c.open.optionId);
  if (k.roll_open_tx !== null) b.agree(`cycle ${n} rollOpen tx`, k.roll_open_tx, c.open.txHash);
  b.agree(`cycle ${n} lockBook tx`, k.lock_tx, c.locked.txHash);
  const txClose = String(runValue(run, `${r}.rollCloseTx`));
  b.agree(`cycle ${n} rollClose tx`, txClose, c.close.txHash);
  b.agree(`cycle ${n} keeper row rollClose tx`, k.roll_close_tx, c.close.txHash);
  if (n === 3) b.agree("cycle 3 claim key", runBig(run, "cycle3.claimKey"), c.written.claimKey);
  const collateral = contracts * c.set.lotSize;
  b.agree(`cycle ${n} collateral = contracts x lot`, collateral, c.written.collateral);

  const chainListing = chain.listings.find((l) => l.optionId === c.open!.optionId);
  if (chainListing === undefined) throw new Error(`the chain has no ListingApproved for cycle ${n}`);
  const listing = deriveListing(b, run, n, chainListing);
  b.agree(`cycle ${n} order hash`, String(runValue(run, `${r}.orderHash`)), listing.orderHash);

  const sold = listing.contractsFilled;
  const premiumToVault = listing.proceeds;
  const overcallFee = listing.feePaid;
  const premiumGross = premiumToVault + overcallFee;
  if (sold > 0n) {
    b.agree(`cycle ${n} fill gross`, runBig(run, `${r}.gross6`), premiumGross);
    b.agree(`cycle ${n} fill to vault`, runBig(run, `${r}.toVault6`), premiumToVault);
    b.agree(`cycle ${n} fill to Overcall`, runBig(run, `${r}.toOvercall6`), overcallFee);
  }

  // The week's money, from the dry run's record.
  const gross = runBig(run, `${r}.harvest.gross`);
  const fee = runBig(run, `${r}.harvest.fee`);
  const net = runBig(run, `${r}.harvest.net`);
  const harvests: ChainHarvest[] = chain.harvests.filter((h) => h.cycleNumber === n);
  b.agree(`cycle ${n} Harvest events`, 1, harvests.length);
  const h = harvests.find((x) => lower(x.txHash) === lower(c.close!.txHash));
  if (h === undefined) throw new Error(`the chain has no Harvest in cycle ${n}'s rollClose transaction`);
  b.agree(`cycle ${n} Harvest.grossUsdg`, gross, h.gross);
  b.agree(`cycle ${n} Harvest.feeUsdg`, fee, h.fee);
  b.agree(`cycle ${n} Harvest.netUsdg`, net, h.net);

  const strikeProceeds = n === 3 ? runBig(run, "cycle3.harvest.usdgFromAssignment") : BigInt(k.usdg_from_assignment ?? "0");
  const assetsReturned = n === 3 ? runBig(run, "cycle3.harvest.assetsReturned") : BigInt(k.assets_returned ?? "-1");
  const assigned = BigInt(k.contracts_assigned);
  b.agree(`cycle ${n} RollClose.usdgFromAssignment`, strikeProceeds, c.close.usdgFromAssignment);
  b.agree(`cycle ${n} RollClose.assetsReturned`, assetsReturned, c.close.assetsReturned);
  b.agree(`cycle ${n} RollClose.contractsAssignedCount`, assigned, c.close.contractsAssignedCount);
  if (n === 3) {
    b.agree("cycle 3 premium leg", runBig(run, "cycle3.harvest.premium"), gross - strikeProceeds);
    b.agree("cycle 3 contracts assigned (harness)", runBig(run, "cycle3.harvest.contractsAssigned"), assigned);
    b.agree("cycle 3 contracts exercised", runBig(run, "cycle3.contractsExercised"), c.marketExercised);
  } else {
    b.agree(`cycle ${n} market exercise`, 0n, c.marketExercised);
  }
  // The vault is the only writer of each of these private option types, so every exercised
  // contract lands in its one bucket.
  b.agree(`cycle ${n} bucket assignment = contracts assigned`, assigned, c.bucketAssigned);

  // Supply at harvest: the share count the terminal sweep indexed against. Pre-close, so the
  // queued shares escrowed in cycle 3 still count. Cross-checked against UsdgDistributed and
  // against the dry run's deposit (every share ever minted is still outstanding before cycle 3's close).
  const supply = c.supplyBeforeClose ?? 0n;
  if (c.distributedSupply !== null) b.agree(`cycle ${n} UsdgDistributed.totalSupply`, supply, c.distributedSupply);
  const minted = runBig(run, "cycle3.final.totalSupply") + runBig(run, "cycle3.queue.sharesQueued");
  b.agree(`cycle ${n} supply before close = shares minted`, minted, supply);

  const harvestPremiumGross = gross - strikeProceeds;
  const premiumNet = harvestPremiumGross - fee;
  const status: WeekTruth["status"] = sold === 0n ? "unfilled" : assigned > 0n ? "assigned" : "closed";

  return {
    cycleNumber: n,
    status,
    optionIds,
    lotSize: c.set.lotSize,
    exerciseTimestamp,
    expiryTimestamp,
    setAt: c.set.timestamp,
    setTx: lower(c.set.txHash),
    optionId: BigInt(k.option_id),
    claimKey: c.written.claimKey,
    strike,
    contracts,
    collateral,
    openedAt: c.open.timestamp,
    txOpen: lower(k.roll_open_tx ?? c.open.txHash),
    listing,
    sold,
    fillCount: listing.fillCount,
    premiumGross,
    premiumToVault,
    overcallFee,
    firstFillAt: chainListing.fills[0]?.timestamp ?? null,
    lastFillAt: chainListing.fills.at(-1)?.timestamp ?? null,
    lockedAt: c.locked.timestamp,
    assigned,
    assetsReturned,
    marketExercised: c.marketExercised,
    bucketIndex: c.bucketIndex,
    bucketAssigned: c.bucketAssigned,
    closedAt: c.close.timestamp,
    txClose: lower(txClose),
    gross,
    fee,
    net,
    strikeProceeds,
    harvestPremiumGross,
    premiumNet,
    supply,
    premiumNetPerShare: perShare(premiumNet, supply),
    usdgPerShare: perShare(net, supply),
    accAfter: c.accAfterClose ?? 0n,
    harvestTx: lower(h.txHash),
    harvestAt: h.timestamp,
  };
}

/*//////////////////////////////////////////////////////////////
                         SHAPES, AS EXPECTED
//////////////////////////////////////////////////////////////*/

function expectCycle(w: RouteWriter, t: WeekTruth) {
  w.eq("cycle", t.cycleNumber);
  w.eq("status", t.status);
  w.eq("wrote", true);
  w.eq("filled", t.sold > 0n);
  w.eq("assigned", t.assigned > 0n);

  const reg = w.at("registry");
  reg.eq("optionIds", t.optionIds, "run.json cycleN.optionIds");
  reg.eq("strikeCount", t.optionIds.length);
  reg.asset("lotSize", t.lotSize, "CycleSet.lotSize");
  reg.eq("exerciseTimestamp", t.exerciseTimestamp.toString(), "run.json cycleN.exerciseTimestamp");
  reg.eq("exerciseAt", isoOf(t.exerciseTimestamp));
  reg.eq("expiryTimestamp", t.expiryTimestamp.toString(), "run.json cycleN.expiryTimestamp");
  reg.eq("expiryAt", isoOf(t.expiryTimestamp));
  reg.eq("setAt", isoOf(t.setAt), "CycleSet block timestamp");
  reg.eq("setTx", t.setTx, "run.json harnessTxs setCycleWithStrikes");

  const wr = w.at("written");
  wr.eq("optionId", t.optionId.toString(), "run.json db.cycles option_id");
  wr.eq("claimKey", t.claimKey.toString(), "CallsWritten.claimKey");
  wr.usdg("strikeUsdg", t.strike, "run.json cycleN.strikeUsdg6");
  wr.eq("contracts", t.contracts.toString(), "run.json cycleN.contracts");
  wr.asset("collateral", t.collateral, "contracts x lot");
  wr.eq("openedAt", isoOf(t.openedAt), "RollOpen block timestamp");
  wr.eq("txOpen", t.txOpen, "run.json db.cycles roll_open_tx (cycle 2: RollOpen log; the keeper adopted it)");

  const li = w.at("listing");
  li.eq("count", 1);
  li.eq("orderHash", t.listing.orderHash, "run.json cycleN.orderHash");
  li.eq("contracts", t.listing.contracts.toString(), "run.json db.listings contracts");
  li.usdg("grossUsdg", t.listing.gross, "run.json db.listings gross_usdg6");
  li.usdg("unitPriceUsdg", t.listing.unitPrice, "run.json db.listings unit_price6");
  li.eq("listedAt", isoOf(t.listing.approvedAt), "ListingApproved block timestamp");

  const fi = w.at("fill");
  fi.eq("contractsSold", t.sold.toString(), "Seaport OrderFulfilled offer");
  fi.eq("fillCount", t.fillCount);
  fi.usdg("premiumGross", t.premiumGross, "run.json cycleN.gross6 (0 when unfilled)");
  fi.usdg("premiumToVault", t.premiumToVault, "run.json cycleN.toVault6");
  fi.usdg("overcallFee", t.overcallFee, "run.json cycleN.toOvercall6");
  fi.usdg("unitPriceUsdg", t.sold === 0n ? 0n : t.premiumGross / t.sold);
  fi.eq("firstFillAt", isoOf(t.firstFillAt));
  fi.eq("lastFillAt", isoOf(t.lastFillAt));

  const se = w.at("settlement");
  se.eq("lockedAt", isoOf(t.lockedAt), "BookLocked block timestamp");
  se.eq("contractsAssigned", t.assigned.toString(), "run.json db.cycles contracts_assigned");
  se.usdg("assignmentUsdg", t.strikeProceeds, "RollClose.usdgFromAssignment");
  se.asset("assetsReturned", t.assetsReturned, "run.json RollClose.assetsReturned");
  se.eq("marketExercised", t.marketExercised.toString(), "Valorem OptionsExercised");
  se.eq("bucketIndex", t.bucketIndex === null ? null : t.bucketIndex.toString(), "Valorem BucketWrittenInto in this cycle's rollOpen tx");
  se.eq("bucketAssigned", t.bucketAssigned.toString(), "Valorem BucketAssignedExercise on that bucket");
  se.eq("closedAt", isoOf(t.closedAt), "RollClose block timestamp");
  se.eq("txClose", t.txClose, "run.json cycleN.rollCloseTx");

  const hv = w.at("harvest");
  hv.eq("harvested", true);
  hv.usdg("grossUsdg", t.gross, "run.json cycleN.harvest.gross");
  hv.usdg("premiumGross", t.harvestPremiumGross, "gross - strike proceeds");
  hv.usdg("strikeProceedsUsdg", t.strikeProceeds, "run.json cycle3.harvest.usdgFromAssignment / RollClose");
  hv.usdg("fee", t.fee, "run.json cycleN.harvest.fee");
  hv.usdg("premiumNet", t.premiumNet, "gross - strike proceeds - fee");
  hv.usdg("creditedUsdg", t.net, "run.json cycleN.harvest.net");
  hv.usdg("premiumNetPerShare", t.premiumNetPerShare, "premiumNet x 1e18 / supply before close");
  hv.usdg("usdgPerShare", t.usdgPerShare, "net x 1e18 / supply before close");
  hv.asset("supplyAtHarvest", t.supply, "totalSupply() at rollClose block - 1");
  hv.eq("harvestedAt", isoOf(t.closedAt));
}

function expectListing(w: RouteWriter, l: ListingTruth) {
  w.eq("orderHash", l.orderHash);
  w.eq("cycle", l.cycle);
  w.eq("seq", l.seq);
  w.eq("status", l.status, "Seaport fills / vault ListingCancelled");
  w.eq("optionId", l.optionId.toString());
  w.eq("contracts", l.contracts.toString());
  w.usdg("grossUsdg", l.gross, "run.json db.listings gross_usdg6");
  w.usdg("unitPriceUsdg", l.unitPrice, "run.json db.listings unit_price6");
  w.usdg("writerUsdg", l.writer, "run.json db.listings to_vault6");
  w.usdg("overcallFeeUsdg", l.overcallFee, "run.json db.listings to_overcall6");
  const f = w.at("fill");
  f.eq("contractsFilled", l.contractsFilled.toString());
  f.eq("fillCount", l.fillCount);
  f.usdg("proceedsUsdg", l.proceeds);
  f.usdg("feePaidUsdg", l.feePaid);
  f.eq("lastFillAt", isoOf(l.lastFillAt));
  f.eq("lastFillTx", l.lastFillTx === null ? null : lower(l.lastFillTx));
  w.eq("approvedAt", isoOf(l.approvedAt));
  w.eq("approvedTx", lower(l.approvedTx), "run.json db.listings approve_tx");
  w.eq("endedAt", isoOf(l.endedAt));
  w.eq("endedTx", l.endedTx === null ? null : lower(l.endedTx));
  w.eq("endReason", l.endReason);
}

function expectHarvest(w: RouteWriter, t: WeekTruth) {
  w.eq("cycle", t.cycleNumber);
  w.eq("terminal", true);
  w.eq("filled", t.sold > 0n);
  w.usdg("grossUsdg", t.gross, "run.json cycleN.harvest.gross");
  w.usdg("fee", t.fee, "run.json cycleN.harvest.fee");
  w.usdg("netUsdg", t.net, "run.json cycleN.harvest.net");
  w.usdg("premiumGross", t.harvestPremiumGross);
  w.usdg("strikeProceedsUsdg", t.strikeProceeds);
  w.usdg("premiumNet", t.premiumNet);
  w.usdg("premiumToVault", t.premiumToVault);
  w.usdg("assignmentUsdg", t.strikeProceeds);
  w.eq("contractsSold", t.sold.toString());
  w.eq("contractsAssigned", t.assigned.toString());
  w.usdg("premiumNetPerShare", t.premiumNetPerShare);
  w.usdg("usdgPerShare", t.usdgPerShare);
  w.asset("supply", t.supply);
  w.eq("accUsdgPerShare", t.accAfter.toString(), "accUsdgPerShare() at the close block");
  w.eq("at", isoOf(t.harvestAt));
  w.eq("txHash", t.harvestTx, "run.json cycleN.rollCloseTx");
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
  graphql: "POST /graphql",
});

/** The GraphQL document the sync posts. Epochs and the vault row are not all on a REST route. */
export const graphqlQuery = (vault: string) => `{
  queueEpochs(orderBy: "epochId", orderDirection: "asc") {
    items { epochId status cycleNumber sharesQueued queueCount sharesSettled assetsSettled usdgSettled sharesClaimed assetsClaimed usdgClaimed claimCount settledTx }
  }
  vaultState(id: "${vault}") {
    phase cycleNumber writesHalted claimKey optionId listingHash lockedCollateral contractsWritten
    assetBalance usdgBalance reservedAssets usdgReservedForQueue totalShares queuedShares epochId
    accUsdgPerShare totalUsdgDistributed totalUsdgClaimed usdgUnallocated seaportCounter
    protocolFeeBps feeRecipient depositCap maxPriceAge totalFeeSwept lifetimeProtocolFee
    lifetimePremiumGross lifetimePremiumToVault lifetimeOvercallFee lifetimeAssignmentUsdg
    lifetimePremiumNet lifetimeStrikeProceeds lifetimeCreditedUsdg
    cyclesWritten cyclesFilled cyclesUnfilled cyclesAssigned lastBlock
  }
}`;

export type Built = { expectations: Expectation[]; disagreements: string[]; crossChecks: number; weeks: WeekTruth[] };

export function buildExpectations(run: RunJson, chain: ChainFacts): Built {
  const b = new Builder();
  const depositor = run.actors.depositor;
  if (depositor === undefined) throw new Error("run.json actors.depositor is missing");
  const routes = routesFor(depositor);

  b.agree("vault address", run.addresses.Vault, chain.vault);
  b.agree("registry address", run.addresses.MockRegistry, chain.immutables.registry);
  b.agree("chain id", run.chainId, chain.chainId);
  const { lastBlock } = runBlocks(run);
  b.agree("last dry-run block = END_BLOCK", lastBlock, chain.endBlock);
  if (run.error !== null) b.disagreements.push(`the dry run recorded an error: ${run.error}`);

  const weeks = ([1, 2, 3] as const).map((n) => deriveWeek(b, run, chain, n));
  const byNumberDesc = [...weeks].sort((x, y) => y.cycleNumber - x.cycleNumber);
  const w3 = weeks[2]!;

  /* ---------------- per-cycle and list routes ---------------- */
  for (const t of weeks) {
    const r = b.route(routes.cycle(t.cycleNumber));
    expectCycle(r.at("cycle"), t);
    r.eq("listings.length", 1);
    expectListing(r.at("listings[0]"), t.listing);
    r.eq("harvests.length", 1);
    expectHarvest(r.at("harvests[0]"), t);
  }

  const list = b.route(routes.cycles);
  list.eq("count", weeks.length);
  list.eq("cycles.length", weeks.length);
  list.eq("totals.written", chain.cycles.filter((c) => c.open !== null).length, "RollOpen events");
  list.eq("totals.filled", weeks.filter((t) => t.sold > 0n).length);
  list.eq("totals.unfilled", weeks.filter((t) => t.sold === 0n).length);
  list.eq("totals.assigned", weeks.filter((t) => t.assigned > 0n).length);
  byNumberDesc.forEach((t, i) => expectCycle(list.at(`cycles[${i}]`), t));

  const listings = b.route(routes.listings);
  const listingsDesc = [...weeks].sort((x, y) => Number(y.listing.approvedBlock - x.listing.approvedBlock));
  listings.eq("count", listingsDesc.length);
  listings.eq("listings.length", listingsDesc.length);
  listings.eq("liveHash", chain.views.listingHash === ZERO_HASH ? null : lower(chain.views.listingHash), "listingHash() (zero = none)");
  listings.eq("seaportCounter", chain.views.seaportCounter.toString(), "seaport.getCounter(vault)");
  listingsDesc.forEach((t, i) => expectListing(listings.at(`listings[${i}]`), t.listing));

  const activity = b.route(routes.activity);
  activity.eq("include", "terminal");
  activity.eq("count", weeks.length);
  byNumberDesc.forEach((t, i) => expectHarvest(activity.at(`harvests[${i}]`), t));
  const activityAll = b.route(routes.activityAll);
  activityAll.eq("include", "all");
  activityAll.eq("count", chain.harvests.length, "every Harvest log on chain");

  /* ---------------- /v1/vault ---------------- */
  const v = b.route(routes.vault);
  const imm = chain.immutables;
  v.eq("addresses.chainId", chain.chainId);
  v.eq("addresses.vault", chain.vault);
  v.eq("addresses.asset", imm.asset);
  v.eq("addresses.usdg", imm.usdg);
  v.eq("addresses.registry", imm.registry, "run.json addresses.MockRegistry");
  v.eq("addresses.clearinghouse", imm.clear);
  v.eq("addresses.seaport", imm.seaport);
  v.eq("addresses.overcallFeeRecipient", imm.overcallFeeRecipient);
  v.eq("live", true);
  v.eq("blockNumber", chain.endBlock.toString());

  const views = chain.views;
  v.eq("phase.code", views.phase);
  v.eq("phase.name", ["Idle", "Listed", "Exercisable", "Settling"][views.phase] ?? "Unknown");
  v.eq("phase.writesHalted", views.writesHalted);
  v.eq("phase.canRedeemInstantly", views.canRedeemInstantly);
  v.eq("phase.valoremFeeAccepted", views.valoremFeeAccepted);
  v.eq("phase.oraclePaused", views.oraclePaused);
  v.eq("phase.tokenPaused", false);
  v.eq("phase.maxPriceAgeSeconds", chain.settings.maxPriceAge, "maxPriceAge()");

  const finalIdle = runBig(run, "cycle3.final.idleAssets");
  const finalSupply = runBig(run, "cycle3.final.totalSupply");
  b.agree("final idleAssets", finalIdle, views.idleAssets);
  b.agree("final totalSupply", finalSupply, views.totalSupply);
  b.agree("final totalAssets = idle (nothing locked)", finalIdle, views.totalAssets);
  v.asset("tvl.totalAssets", views.totalAssets, "run.json cycle3.final.idleAssets");
  v.asset("tvl.idleAssets", views.idleAssets, "run.json cycle3.final.idleAssets");
  v.asset("tvl.lockedAssets", views.lockedAssets);
  v.asset("tvl.reservedAssets", views.reservedAssets);
  v.asset("tvl.totalShares", views.totalSupply, "run.json cycle3.final.totalSupply");
  v.asset("tvl.pricePerShare", views.totalSupply === 0n ? ONE : (views.totalAssets * ONE) / views.totalSupply);
  v.asset("tvl.depositCap", chain.settings.depositCap, "depositCap()");
  v.asset("tvl.maxDeposit", views.maxDepositZero, "maxDeposit(0)");
  v.eq("tvl.uiMultiplier", views.uiMultiplier.toString(), "uiMultiplier()");
  v.eq("tvl.uiMultiplierPending", null);
  v.eq("tvl.uiMultiplierEffectiveAt", null);
  if (views.spotUsdg === null) v.eq("tvl.spotUsdg", null);
  else v.usdg("tvl.spotUsdg", views.spotUsdg, "spotUsdg()");

  const remainder = runBig(run, "cycle3.usdgLeftInVault.remainder");
  b.agree("USDG left in the vault", remainder, views.usdgBalance);
  b.agree("sum of UsdgDistributed = totalUsdgDistributed()", chain.usdgDistributed, views.totalUsdgDistributed);
  v.usdg("usdg.balance", views.usdgBalance, "run.json cycle3.usdgLeftInVault.remainder");
  v.usdg("usdg.distributed", views.totalUsdgDistributed, "totalUsdgDistributed()");
  v.usdg("usdg.claimed", views.totalUsdgClaimed, "totalUsdgClaimed(): ClaimUsdg plus the queue escrow's take at settlement");
  v.usdg("usdg.reservedForQueue", views.usdgReservedForQueue);
  v.usdg("usdg.unallocated", views.usdgUnallocated);
  v.eq("usdg.accUsdgPerShare", views.accUsdgPerShare.toString(), "accUsdgPerShare()");
  v.eq("usdg.accUsdgPerSharePrecision", (10n ** 27n).toString());
  v.eq("usdg.protocolFeeBps", chain.settings.protocolFeeBps, "policy().protocolFeeBps (set in the constructor, no event)");
  v.eq("usdg.feeRecipient", lower(chain.settings.feeRecipient), "feeRecipient() (set in the constructor, no event)");
  b.agree("fee recipient = the dry run's fee Safe", run.actors.feeSafe, chain.settings.feeRecipient);
  v.asset("queue.queuedShares", views.queuedShares);
  v.eq("queue.epochId", views.epochId.toString(), "epochId()");

  expectCycle(v.at("week.cycle"), w3);
  const live = chain.registryLive;
  const wr = v.at("week.registry");
  wr.eq("live", true);
  wr.eq("cycleNumber", live.cycleNumber);
  wr.eq("isWritingOpen", live.isWritingOpen);
  wr.eq("isCycleLive", live.isCycleLive);
  wr.eq("writeDeadline", live.writeDeadline.toString());
  wr.eq("writeDeadlineAt", isoOf(live.writeDeadline));
  wr.eq("exerciseAt", isoOf(live.exerciseTimestamp));
  wr.eq("expiryAt", isoOf(live.expiryTimestamp));
  wr.asset("lotSize", live.lotSize);
  wr.eq("rungs.length", live.rungs.length);
  const strikes3 = runValue(run, "cycle3.strikes") as string[];
  live.rungs.forEach((rung, i) => {
    b.agree(`live rung ${i} strike`, strikes3[i] ?? null, rung.strike);
    wr.eq(`rungs[${i}].optionId`, rung.optionId.toString());
    wr.usdg(`rungs[${i}].strikeUsdg`, rung.strike, "run.json cycle3.strikes");
    wr.eq(`rungs[${i}].approved`, rung.approved);
    wr.eq(`rungs[${i}].ours`, rung.optionId === w3.optionId);
  });
  v.eq("week.listing.hash", lower(views.listingHash), "listingHash()");
  v.eq("week.listing.contracts", views.listingAmount.toString());
  v.usdg("week.listing.grossUsdg", views.listingGrossUsdg);
  v.eq("week.listing.listingsThisCycle", views.listingsThisCycle);
  v.eq("week.listing.maxListingsPerCycle", 3);
  v.eq("week.assignmentLive.contractsAssigned", views.contractsAssigned.toString());
  v.eq("week.assignmentLive.contractsRemaining", views.contractsRemaining.toString());
  v.eq("week.assignmentLive.contractsWritten", views.contractsWritten.toString());

  expectHarvest(v.at("lastWeek"), w3);

  const sum = (f: (t: WeekTruth) => bigint) => weeks.reduce((s, t) => s + f(t), 0n);
  const lifetime = {
    premiumGross: sum((t) => t.premiumGross),
    premiumToVault: sum((t) => t.premiumToVault),
    overcallFee: sum((t) => t.overcallFee),
    assignmentUsdg: sum((t) => t.strikeProceeds),
    protocolFee: sum((t) => t.fee),
    premiumNet: sum((t) => t.premiumNet),
    strikeProceeds: sum((t) => t.strikeProceeds),
    credited: sum((t) => t.net),
  };
  b.agree("fee swept = fee accrued", lifetime.protocolFee, chain.feeSwept);
  b.agree("pendingFeeUsdg", 0n, views.pendingFeeUsdg);
  v.eq("lifetime.cyclesWritten", weeks.length);
  v.eq("lifetime.cyclesFilled", weeks.filter((t) => t.sold > 0n).length);
  v.eq("lifetime.cyclesUnfilled", weeks.filter((t) => t.sold === 0n).length);
  v.eq("lifetime.cyclesAssigned", weeks.filter((t) => t.assigned > 0n).length);
  v.usdg("lifetime.premiumGross", lifetime.premiumGross, "sum of fills, both legs");
  v.usdg("lifetime.premiumToVault", lifetime.premiumToVault);
  v.usdg("lifetime.overcallFee", lifetime.overcallFee);
  v.usdg("lifetime.assignmentUsdg", lifetime.assignmentUsdg, "sum of RollClose.usdgFromAssignment");
  v.usdg("lifetime.protocolFee", lifetime.protocolFee, "sum of run.json harvest fees");
  v.usdg("lifetime.premiumNet", lifetime.premiumNet, "sum of (gross - strike proceeds - fee)");
  v.usdg("lifetime.strikeProceedsUsdg", lifetime.strikeProceeds);
  v.usdg("lifetime.creditedUsdg", lifetime.credited, "sum of run.json harvest nets");

  const holders = (role: string) => chain.roles.filter((r) => r.granted && lower(role) === lower(r.role)).map((r) => lower(r.account));
  // Role hashes: keccak256 of the name, and 0x00 for the admin (OpenZeppelin AccessControl).
  const ROLE_ADMIN = ZERO_HASH;
  const ROLE_KEEPER = keccak256(toHex("KEEPER_ROLE"));
  const ROLE_GUARDIAN = keccak256(toHex("GUARDIAN_ROLE"));
  v.eq("roles.admin", holders(ROLE_ADMIN), "RoleGranted logs");
  v.eq("roles.keeper", holders(ROLE_KEEPER), "RoleGranted logs");
  v.eq("roles.guardian", holders(ROLE_GUARDIAN), "RoleGranted logs");
  b.agree("admin role holder", [lower(run.actors.admin ?? "")], holders(ROLE_ADMIN));
  b.agree("keeper role holder", [lower(run.actors.keeper ?? "")], holders(ROLE_KEEPER));

  v.eq("indexedAt.blockNumber", chain.lastVaultActivityBlock.toString(), "last block with a vault-state event");
  v.eq("indexedAt.timestamp", chain.lastVaultActivityTimestamp.toString());
  v.eq("indexedAt.at", isoOf(chain.lastVaultActivityTimestamp));

  /* ---------------- /v1/account/:depositor ---------------- */
  const a = b.route(routes.account);
  const acct = chain.account;
  const deposited = chain.deposits.filter((d) => lower(d.owner) === lower(depositor)).reduce((s, d) => s + d.assets, 0n);
  const claimedOnChain = chain.claims.filter((c) => lower(c.account) === lower(depositor)).reduce((s, c) => s + c.amount, 0n);
  const completes = chain.queue.completes.filter((c) => lower(c.owner) === lower(depositor));
  const claimedUsdg = runBig(run, "cycle1.harvest.depositorReceived") + runBig(run, "cycle3.claimed");
  const redeemedAssets = runBig(run, "cycle3.queue.assetsOut");
  const redeemedUsdg = runBig(run, "cycle3.queue.usdgOut");
  b.agree("depositor shares", runBig(run, "cycle3.final.depositorShares"), acct.shares);
  b.agree("depositor deposit = shares minted", finalSupply + runBig(run, "cycle3.queue.sharesQueued"), deposited);
  b.agree("depositor USDG claimed", claimedUsdg, claimedOnChain);
  b.agree("depositor redeemed assets", redeemedAssets, completes.reduce((s, c) => s + c.assets, 0n));
  b.agree("depositor redeemed USDG", redeemedUsdg, completes.reduce((s, c) => s + c.usdgOut, 0n));
  a.eq("address", depositor);
  a.eq("live", true);
  a.eq("known", true);
  a.asset("position.shares", acct.shares, "run.json cycle3.final.depositorShares");
  a.asset("position.sharesAsAssets", acct.sharesAsAssets, "convertToAssets(shares)");
  a.usdg("position.claimableUsdg", acct.claimableUsdg, "claimableUsdg(depositor)");
  a.asset("queue.queuedShares", acct.queuedShares);
  a.eq("queue.epochId", acct.queuedEpoch.toString(), "queuedEpochOf(depositor)");
  a.eq("queue.settled", false);
  a.eq("queue.claimable", false);
  a.asset("queue.previewAssets", acct.previewAssets);
  a.usdg("queue.previewUsdg", acct.previewUsdg);
  a.eq("queue.epochSettledAt", null);
  a.asset("lifetime.deposited", deposited, "Deposit logs");
  a.asset("lifetime.withdrawn", 0n);
  a.asset("lifetime.redeemedAssets", redeemedAssets, "run.json cycle3.queue.assetsOut");
  a.usdg("lifetime.redeemedUsdg", redeemedUsdg, "run.json cycle3.queue.usdgOut");
  a.usdg("lifetime.claimedUsdg", claimedUsdg, "run.json cycle1.harvest.depositorReceived + cycle3.claimed");
  a.eq("lifetime.depositCount", chain.deposits.filter((d) => lower(d.owner) === lower(depositor)).length);
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
  hl.eq("vault.lastActivityBlock", chain.lastVaultActivityBlock.toString());
  hl.eq("vault.lastActivityAt", isoOf(chain.lastVaultActivityTimestamp));
  hl.eq("relay.keeperAuthConfigured", false);

  /* ---------------- GraphQL: epochs and the vault row ---------------- */
  const g = b.route(routes.graphql);
  const epochIds = new Set<bigint>([...chain.queue.redeems.map((q) => q.epochId), ...chain.queue.settled.flatMap((s) => [s.epochId, s.epochId + 1n])]);
  const epochs = [...epochIds].sort((x, y) => (x < y ? -1 : 1));
  g.eq("data.queueEpochs.items.length", epochs.length, "epochs queued into, settled, and the one opened after each settlement");
  const queueSettled = chain.queue.settled;
  b.agree("cycle 3 queue shares", runBig(run, "cycle3.queue.sharesQueued"), queueSettled[0]?.shares ?? null);
  b.agree("cycle 3 queue assets", runBig(run, "cycle3.queue.payoutAssets"), queueSettled[0]?.assets ?? null);
  b.agree("cycle 3 queue USDG", runBig(run, "cycle3.queue.escrowUsdg"), queueSettled[0]?.usdgOut ?? null);
  b.agree("cycle 3 queue epoch", runBig(run, "cycle3.queue.epoch"), queueSettled[0]?.epochId ?? null);
  epochs.forEach((id, i) => {
    const e = g.at(`data.queueEpochs.items[${i}]`);
    const settled = queueSettled.find((s) => s.epochId === id);
    const redeems = chain.queue.redeems.filter((q) => q.epochId === id);
    const entries = chain.queue.entries.filter((q) => q.epochId === id);
    const settledIn = settled === undefined ? undefined : weeks.find((t) => t.txClose === lower(settled.txHash));
    e.eq("epochId", id.toString());
    e.eq("status", settled === undefined ? "open" : "settled");
    e.eq("cycleNumber", settledIn === undefined ? null : settledIn.cycleNumber, "the cycle whose rollClose settled it");
    e.eq("sharesQueued", redeems.reduce((s, q) => s + q.shares, 0n).toString(), "run.json cycle3.queue.sharesQueued");
    e.eq("queueCount", redeems.length);
    e.eq("sharesSettled", (settled?.shares ?? 0n).toString(), "run.json cycle3.queue.sharesQueued");
    e.eq("assetsSettled", (settled?.assets ?? 0n).toString(), "run.json cycle3.queue.payoutAssets");
    e.eq("usdgSettled", (settled?.usdgOut ?? 0n).toString(), "run.json cycle3.queue.escrowUsdg");
    e.eq("sharesClaimed", entries.reduce((s, q) => s + q.shares, 0n).toString());
    e.eq("assetsClaimed", entries.reduce((s, q) => s + q.assets, 0n).toString(), "run.json cycle3.queue.assetsOut");
    e.eq("usdgClaimed", entries.reduce((s, q) => s + q.usdgOut, 0n).toString(), "run.json cycle3.queue.usdgOut");
    e.eq("claimCount", entries.length);
    e.eq("settledTx", settled === undefined ? null : lower(settled.txHash));
  });

  const vs = g.at("data.vaultState");
  vs.eq("phase", views.phase);
  vs.eq("cycleNumber", views.cycleNumber);
  vs.eq("writesHalted", views.writesHalted);
  vs.eq("claimKey", null, "claimKey() = 0 after the close");
  vs.eq("optionId", null);
  vs.eq("listingHash", views.listingHash === ZERO_HASH ? null : lower(views.listingHash));
  vs.eq("lockedCollateral", views.lockedAssets.toString());
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
  vs.eq("lifetimePremiumToVault", lifetime.premiumToVault.toString());
  vs.eq("lifetimeOvercallFee", lifetime.overcallFee.toString());
  vs.eq("lifetimeAssignmentUsdg", lifetime.assignmentUsdg.toString());
  vs.eq("lifetimePremiumNet", lifetime.premiumNet.toString());
  vs.eq("lifetimeStrikeProceeds", lifetime.strikeProceeds.toString());
  vs.eq("lifetimeCreditedUsdg", lifetime.credited.toString());
  vs.eq("cyclesWritten", weeks.length);
  vs.eq("cyclesFilled", weeks.filter((t) => t.sold > 0n).length);
  vs.eq("cyclesUnfilled", weeks.filter((t) => t.sold === 0n).length);
  vs.eq("cyclesAssigned", weeks.filter((t) => t.assigned > 0n).length);
  vs.eq("lastBlock", chain.lastVaultActivityBlock.toString());

  return { expectations: b.expectations, disagreements: b.disagreements, crossChecks: b.crossChecks, weeks };
}
