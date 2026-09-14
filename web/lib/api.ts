/**
 * Typed client for the Callhouse indexer (Ponder + Hono, plan §6) and for this app's own
 * server-side order feed (app/api/keeper/orders).
 *
 * Two rules shape this file.
 *
 * 1. The indexer is a CONVENIENCE, never a dependency. Chain reads drive every number a user can
 *    act on; the indexer supplies history, which cannot be reconstructed from a single block.
 *    So every call here fails soft, returns `null`, and the page says "history unavailable"
 *    rather than blanking. /activity additionally falls back to a direct log scan.
 *
 * 2. The indexer's NESTED shape is the contract. `/v1/cycles` groups a week into `written`,
 *    `listing`, `fill`, `settlement` and `harvest` (plus the cycle's own clock), and every money
 *    figure inside them is `{raw, decimals, formatted}` with `raw` in base units. That shape is
 *    pinned by the files under ops/fixtures/api/: the indexer's own test proves it still emits
 *    them and web/lib/api.test.ts proves this file still reads them. The flat top-level spellings
 *    (`grossUsdg`, `contractsSold`, ...) are a courtesy for a hand-rolled payload and are read
 *    only when the nested group is absent; the indexer does not send them. The readiness audit
 *    found this file reading only the flat keys, so every paying week arrived with every figure
 *    undefined and rendered as "unfilled, 0" — the one lie the product exists not to tell.
 *    A bigint is accepted as a string, a number, a bigint or a money object (its `raw`, never
 *    its `formatted`). The tolerance is deliberate: an indexer rename should degrade one figure,
 *    not crash the vault page.
 *
 * UNDER WRITE ON FILL the vault writes nothing at rollOpen: `RollOpen.contractsCount` is always 0
 * and every fill writes exactly what it sold (`CallsWritten` per fill), so contracts written and
 * contracts sold are one number. `contracts` on a row is that number; `contractsSold` is kept as
 * a field because the indexer publishes it and older payloads carry it, and the two agree.
 */
import type { Address, Hex } from "viem";

import type { ListingRow } from "./listing";

const RAW_API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:42069";
export const API_BASE = RAW_API_BASE.replace(/\/+$/, "");

const DEFAULT_TIMEOUT_MS = 8000;

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function getJson(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (body && typeof body.error === "string") detail = body.error;
    } catch {
      /* a non-JSON error body is still an error; the status carries the meaning */
    }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`);
  }
  return res.json();
}

/* ---------------------------------------------------------------------------- field pickers */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** First key that is present and not null. Accepts camelCase and snake_case spellings. */
function pick(source: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const v = source[key];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function toBigInt(value: unknown): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  // The indexer's money shape, `{raw, decimals, formatted}`. `raw` is the base-unit integer and
  // is the only field ever parsed: `formatted` is a display string with a decimal point in it,
  // and reading it here would turn 48.000000 USDG into an exception and then into "unfilled, 0".
  if (typeof value === "object") return toBigInt((value as { raw?: unknown }).raw);
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return Number.isFinite(value) ? BigInt(Math.trunc(value)) : undefined;
    if (typeof value === "string") {
      const t = value.trim();
      if (!t) return undefined;
      return BigInt(t);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return undefined;
    // Timestamps sometimes arrive as ISO strings from a Postgres-backed indexer.
    if (/^\d+$/.test(t)) return Number(t);
    const parsed = Date.parse(t);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
  }
  return undefined;
}

function toHex(value: unknown): Hex | undefined {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value) ? (value as Hex) : undefined;
}

function toStr(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/* ------------------------------------------------------------------------------------ types */

export type VaultSummary = {
  phase?: number;
  cycleNumber?: number;
  totalAssets?: bigint;
  idleAssets?: bigint;
  lockedAssets?: bigint;
  totalSupply?: bigint;
  usdgBalance?: bigint;
  uiMultiplier?: bigint;
  spotUsdg?: bigint;
  updatedAt?: number;
};

/**
 * One weekly cycle. An UNFILLED week is a first-class row: a call was armed, `filled` false,
 * every premium field 0. It is the most likely outcome and the product publishes it as such.
 */
export type CycleRow = {
  cycle: number;
  /**
   * False for a week the vault sat out (no option type armed: writes halted, a strike outside the
   * band, a stale feed). Such a week is a published outcome, not "unfilled": "unfilled" says a
   * call was armed and nobody bought it, which is not what happened. The indexer sends it; the
   * log fallback sets it true, since every row there starts from a vault event.
   */
  wrote?: boolean;
  optionId?: bigint;
  strikeUsdg?: bigint;
  /** Contracts written this week. Under write on fill this equals contracts sold. */
  contracts?: bigint;
  contractsSold?: bigint;
  contractsAssigned?: bigint;
  orderHash?: Hex;
  openedAt?: number;
  listedAt?: number;
  filledAt?: number;
  closedAt?: number;
  exerciseTs?: number;
  expiryTs?: number;
  /**
   * True when `rollClose` could not redeem the week's Valorem claim and left it stranded
   * (ClaimStranded). The week is closed and its premium harvested; the strike USDG inside the
   * claim arrives when `retryStrandedClaim` succeeds, through a later Harvest carrying this
   * cycle's number. False or absent for an ordinary week.
   */
  stranded?: boolean;
  // THE WEEK'S USDG, SPLIT (W-21). On an assigned week the vault's harvest sweeps premium AND
  // the strike proceeds from the contracts taken at the strike. The strike proceeds are returned
  // principal, not yield, so every premium figure a page shows — gross, net, per share, "Last
  // week realized" — reads the `premium*` fields, and the strike proceeds get their own line.
  //
  //   harvestGrossUsdg   = premiumGrossUsdg + strikeProceedsUsdg   (Harvest.grossUsdg, summed)
  //   creditedUsdg       = premiumNetUsdg   + strikeProceedsUsdg   (Harvest.netUsdg, summed)
  //   premiumNetUsdg     = premiumGrossUsdg − feeUsdg
  //
  // `premium*` is undefined, never guessed, when the week was assigned and nothing says how much
  // of the harvest was strike proceeds: a dash is honest, a subtraction of zero is not.

  /** Everything the harvests swept: premium plus strike proceeds. NOT a premium figure. */
  harvestGrossUsdg?: bigint;
  /** Premium that reached the vault (what buyers paid: there is no third-party fee leg), strike proceeds excluded. */
  premiumGrossUsdg?: bigint;
  /** The protocol fee. Charged on premium only. */
  feeUsdg?: bigint;
  /** Premium after the protocol fee. The only figure that says what the week earned. */
  premiumNetUsdg?: bigint;
  /** USDG received for collateral taken at the strike. Returned principal. 0 when not assigned. */
  strikeProceedsUsdg?: bigint;
  /** Everything credited to holders: net premium plus strike proceeds. NOT a premium figure. */
  creditedUsdg?: bigint;
  /** Vault total supply at the moment of harvest — the denominator of USDG/share. */
  sharesAtHarvest?: bigint;
  /**
   * Net PREMIUM per whole share for the week, in USDG base units, as the indexer sums it per
   * sweep (indexer/lib/harvest.ts). On a week with a mid-week deposit this is exact where
   * `premiumNetUsdg / sharesAtHarvest` is not, because each sweep was indexed against the supply
   * of its own moment. Pages prefer it (lib/format.ts `premiumPerShare`); the log fallback
   * cannot produce it.
   */
  premiumNetPerShare?: bigint;
  /** Vault assets at the moment of harvest, raw 18-dec. */
  assetsAtHarvest?: bigint;
  /** Spot per lot in USDG base units at harvest, for the net premium / TVL figure. */
  spotUsdgAtHarvest?: bigint;
  txOpen?: Hex;
  txClose?: Hex;
  status?: string;
  /** True only when a buyer actually paid. Derived, never trusted from a status string alone. */
  filled: boolean;
  settled: boolean;
};

export type AccountRow = {
  address?: Address;
  shares?: bigint;
  claimableUsdg?: bigint;
  queuedShares?: bigint;
  queuedEpoch?: number;
};

export type HealthRow = {
  ok: boolean;
  lastBeat?: number;
  rpcLagBlocks?: number;
  phase?: number;
  cycleNumber?: number;
};

/* ------------------------------------------------------------------------------ normalisers */

/**
 * The statuses under which the indexer considers a week over (indexer/ponder.schema.ts,
 * `cycleStatus`), plus the generic "settled" a hand-rolled payload might use. A week whose close
 * stranded its claim is closed too: the harvest ran, the queue settled, only the claim's USDG is
 * still to come.
 *
 * `idle` is not here because on its own it is ambiguous. The indexer uses it both for the
 * current week before the next rollOpen (not over) and for a week the vault sat out (over, and
 * a published outcome — the schema calls it "terminal for a skipped week"). Only RollClose ever
 * stamps `closedAt`, so a skipped week never gets one. The two are told apart below by the
 * week's own clock: an idle week the vault never armed is settled once its expiry has passed.
 * Leaving idle out entirely made every skipped week render as "still running" forever.
 */
const CLOSED_STATUSES = new Set(["unfilled", "closed", "assigned", "settled", "stranded"]);

/**
 * One `/v1/cycles` row → one `CycleRow`. Exported for web/lib/api.test.ts, which runs it over
 * the fixtures in ops/fixtures/api/; nothing outside this file calls it directly.
 *
 * `nowSeconds` is only consulted for an idle week (see `CLOSED_STATUSES`); it is a parameter
 * so the test can place "now" on either side of a fixture's expiry. `fetchCycles` reads the
 * clock once per response rather than once per row.
 */
export function normaliseCycle(input: unknown, nowSeconds: number = Math.floor(Date.now() / 1000)): CycleRow | null {
  const r = asRecord(input);
  const cycle = toNumber(pick(r, "cycle", "cycleNumber", "cycle_number", "number"));
  if (cycle === undefined) return null;

  // The indexer's groups. On a flat payload each is `{}`, so every `pick` below falls through
  // to the top-level spelling on its right. The week's clock (exercise, expiry) lived under
  // `registry` before the redesign and is read from a `cycle`/`option` group as well, so either
  // spelling of the indexer's works.
  const clock = { ...asRecord(r.registry), ...asRecord(r.option), ...asRecord(r.cycle) };
  const written = asRecord(r.written);
  const listing = asRecord(r.listing);
  const fill = asRecord(r.fill);
  const settlement = asRecord(r.settlement);
  const harvest = asRecord(r.harvest);

  // `harvest.grossUsdg` is the vault's whole USDG take for the week — premium that reached the
  // vault plus any strike proceeds — as the Harvest events measured it.
  const gross = toBigInt(
    pick(harvest, "grossUsdg") ??
      pick(r, "grossUsdg", "harvestGrossUsdg", "premiumGross", "premium_gross", "premiumGrossUsdg", "gross"),
  );
  const fee = toBigInt(pick(harvest, "fee") ?? pick(r, "feeUsdg", "fee", "protocolFeeUsdg", "premium_fee"));
  const contractsWritten = toBigInt(
    pick(written, "contracts") ?? pick(r, "contracts", "contractsWritten", "contracts_written"),
  );
  // Written and sold are one figure under write on fill; a payload that carries only one of the
  // two spellings still yields both.
  const contractsSold =
    toBigInt(pick(fill, "contractsSold") ?? pick(r, "contractsSold", "contracts_sold", "sold")) ?? contractsWritten;
  const contractsAssigned = toBigInt(
    pick(settlement, "contractsAssigned") ?? pick(r, "contractsAssigned", "contracts_assigned", "assigned"),
  );

  // Premium and strike proceeds, apart (W-21). The indexer publishes both since W-21; the
  // presence of `harvest.creditedUsdg` is how its current shape is told from the one before,
  // in which `harvest.premiumNet` meant `grossUsdg − fee` and INCLUDED the strike proceeds. An
  // older payload is split here by subtraction instead, from the same RollClose figure the
  // indexer uses (`settlement.assignmentUsdg`).
  const splitByIndexer = pick(harvest, "creditedUsdg") !== undefined;
  const strikeReported = toBigInt(
    pick(harvest, "strikeProceedsUsdg") ??
      pick(settlement, "assignmentUsdg") ??
      pick(r, "strikeProceedsUsdg", "assignmentUsdg", "usdgFromAssignment", "strike_proceeds_usdg"),
  );
  // Nothing on the row says a contract was assigned, so nothing in the harvest can be strike
  // proceeds. An assigned week with no strike figure stays unknown: premium is left undefined
  // and renders as a dash rather than as the whole harvest.
  const strike =
    strikeReported ?? (contractsAssigned === undefined || contractsAssigned === 0n ? 0n : undefined);
  const credited = toBigInt(
    splitByIndexer
      ? pick(harvest, "creditedUsdg")
      : (pick(harvest, "premiumNet") ??
          pick(r, "creditedUsdg", "netUsdg", "premiumNet", "premium_net", "premiumNetUsdg", "net")),
  );
  const minus = (a: bigint | undefined, b: bigint | undefined): bigint | undefined =>
    a === undefined || b === undefined ? undefined : a > b ? a - b : 0n;
  const premiumGross = splitByIndexer
    ? toBigInt(pick(harvest, "premiumGross"))
    : minus(gross, strike);
  const premiumNet = splitByIndexer
    ? toBigInt(pick(harvest, "premiumNet"))
    : (minus(credited, strike) ?? minus(premiumGross, fee));
  const status = toStr(pick(r, "status"));
  // `wrote` (the pre-redesign name) or `armed`: did the vault open a cycle on an option type.
  const wroteRaw = pick(r, "wrote", "armed");
  const wrote = typeof wroteRaw === "boolean" ? wroteRaw : undefined;
  const strandedRaw = pick(settlement, "stranded") ?? pick(r, "stranded");
  const stranded = typeof strandedRaw === "boolean" ? strandedRaw : status === "stranded" ? true : undefined;
  const filledAt = toNumber(pick(fill, "firstFillAt") ?? pick(r, "filledAt", "filled_at"));
  const closedAt = toNumber(
    pick(settlement, "closedAt") ?? pick(r, "closedAt", "closed_at", "settledAt", "settled_at"),
  );
  const expiryTs = toNumber(
    pick(clock, "expiryTimestamp", "expiryTs") ??
      pick(written, "expiryTimestamp", "expiryTs") ??
      pick(r, "expiryTs", "expiry_ts", "expiryTimestamp", "expiry_timestamp"),
  );

  // A skipped week. The vault armed nothing, so nothing can close it; the week's expiry is the
  // moment its outcome became final. `wrote` must be the indexer's own false: a flat payload
  // that says only `status: "idle"` has not said whether the vault sat the week out, and is
  // left open rather than guessed at.
  const skippedAndOver =
    status === "idle" && wrote === false && expiryTs !== undefined && expiryTs < nowSeconds;

  // "Filled" means a buyer paid. The indexer says so itself (`filled` is `contractsSold > 0`
  // on its side, and Seaport's OrderFulfilled plus the vault's CallsWritten are the only source
  // of truth for that), so its boolean wins when present. Without it, contracts sold is the
  // fact; and without even that, USDG having arrived is the best a flat payload can say. A
  // status string alone is a label.
  const filled =
    typeof r.filled === "boolean"
      ? r.filled
      : contractsSold !== undefined
        ? contractsSold > 0n
        : (gross !== undefined && gross > 0n) || (credited !== undefined && credited > 0n) || status === "filled";

  return {
    cycle,
    wrote,
    optionId: toBigInt(pick(written, "optionId") ?? pick(r, "optionId", "option_id")),
    strikeUsdg: toBigInt(pick(written, "strikeUsdg") ?? pick(r, "strikeUsdg", "strike", "strike_usdg")),
    contracts: contractsWritten ?? contractsSold,
    contractsSold,
    contractsAssigned,
    orderHash: toHex(pick(listing, "orderHash") ?? pick(r, "orderHash", "order_hash")),
    // ISO strings from the indexer, epoch seconds from a flat payload: toNumber reads both.
    openedAt: toNumber(pick(written, "openedAt") ?? pick(r, "openedAt", "opened_at", "listedAt", "listed_at")),
    listedAt: toNumber(pick(listing, "listedAt") ?? pick(r, "listedAt", "listed_at")),
    filledAt,
    closedAt,
    exerciseTs: toNumber(
      pick(clock, "exerciseTimestamp", "exerciseTs") ??
        pick(written, "exerciseTimestamp", "exerciseTs") ??
        pick(r, "exerciseTs", "exercise_ts", "exerciseTimestamp", "exercise_timestamp"),
    ),
    expiryTs,
    stranded,
    harvestGrossUsdg: gross,
    premiumGrossUsdg: premiumGross,
    feeUsdg: fee,
    premiumNetUsdg: premiumNet,
    strikeProceedsUsdg: strike,
    creditedUsdg: credited,
    sharesAtHarvest: toBigInt(
      pick(harvest, "supplyAtHarvest") ??
        pick(r, "sharesAtHarvest", "shares_at_harvest", "totalSupplyAtHarvest", "total_supply_at_harvest", "shares"),
    ),
    // Only the indexer's premium-only per-share figure is read. `harvest.usdgPerShare` is the
    // credited figure (strike proceeds included) and is deliberately never carried onto the row.
    premiumNetPerShare: toBigInt(pick(harvest, "premiumNetPerShare") ?? pick(r, "premiumNetPerShare")),
    // The indexer's cycle row carries neither of these; they are flat-payload courtesies only.
    assetsAtHarvest: toBigInt(pick(r, "assetsAtHarvest", "assets_at_harvest", "tvlAssets", "tvl_assets")),
    spotUsdgAtHarvest: toBigInt(pick(r, "spotUsdgAtHarvest", "spot_usdg_at_harvest", "spotUsdg", "spot_usdg")),
    txOpen: toHex(pick(written, "txOpen") ?? pick(r, "txOpen", "tx_open")),
    txClose: toHex(pick(settlement, "txClose") ?? pick(r, "txClose", "tx_close")),
    status,
    filled,
    // Over when the indexer says so, when a close is on record, or when a skipped week's
    // expiry has passed. An ASSIGNED week has a `closedAt` and a status in the set;
    // before this read the nested `closedAt` it fell through to "open".
    settled:
      closedAt !== undefined || (status !== undefined && CLOSED_STATUSES.has(status)) || skippedAndOver,
  };
}

function unwrapList(payload: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(payload)) return payload;
  const r = asRecord(payload);
  for (const key of keys) {
    const v = r[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

/* ------------------------------------------------------------------------------- public API */

export async function fetchVaultSummary(): Promise<VaultSummary | null> {
  try {
    const raw = asRecord(await getJson(`${API_BASE}/v1/vault`));
    const body = asRecord(pick(raw, "vault") ?? raw);
    return {
      phase: toNumber(pick(body, "phase")),
      cycleNumber: toNumber(pick(body, "cycleNumber", "cycle", "cycle_number")),
      totalAssets: toBigInt(pick(body, "totalAssets", "total_assets", "tvlAssets")),
      idleAssets: toBigInt(pick(body, "idleAssets", "idle_nvda", "idle")),
      lockedAssets: toBigInt(pick(body, "lockedAssets", "locked_nvda", "locked")),
      totalSupply: toBigInt(pick(body, "totalSupply", "shares", "total_supply")),
      usdgBalance: toBigInt(pick(body, "usdg", "usdgBalance", "usdg_balance")),
      uiMultiplier: toBigInt(pick(body, "uiMultiplier", "ui_multiplier")),
      spotUsdg: toBigInt(pick(body, "spotUsdg", "spot_usdg", "spot")),
      updatedAt: toNumber(pick(body, "ts", "updatedAt", "updated_at")),
    };
  } catch {
    return null;
  }
}

/** Newest cycle first. Returns null (not []) when the indexer is unreachable, so the caller
 *  can tell "no history yet" apart from "cannot reach history". */
export async function fetchCycles(limit = 52): Promise<CycleRow[] | null> {
  try {
    const payload = await getJson(`${API_BASE}/v1/cycles?limit=${encodeURIComponent(String(limit))}`);
    // Not `.map(normaliseCycle)`: map would pass the array index as `nowSeconds`.
    const now = Math.floor(Date.now() / 1000);
    const rows = unwrapList(payload, "cycles", "items", "data")
      .map((row) => normaliseCycle(row, now))
      .filter((c): c is CycleRow => c !== null);
    rows.sort((a, b) => b.cycle - a.cycle);
    return rows;
  } catch {
    return null;
  }
}

export async function fetchAccount(address: Address): Promise<AccountRow | null> {
  try {
    const raw = asRecord(await getJson(`${API_BASE}/v1/account/${address}`));
    const body = asRecord(pick(raw, "account") ?? raw);
    return {
      address,
      shares: toBigInt(pick(body, "shares", "balance")),
      claimableUsdg: toBigInt(pick(body, "claimableUsdg", "claimable_usdg", "claimable")),
      queuedShares: toBigInt(pick(body, "queuedShares", "queued_shares", "queued")),
      queuedEpoch: toNumber(pick(body, "queuedEpoch", "queued_epoch", "epoch")),
    };
  } catch {
    return null;
  }
}

export async function fetchHealth(): Promise<HealthRow> {
  try {
    // Ponder reserves `/health` for its own bare liveness; the app payload is `/v1/health`.
    const body = asRecord(await getJson(`${API_BASE}/v1/health`, 4000));
    const indexer = asRecord(body.indexer);
    const lag = asRecord(body.lag);
    const vault = asRecord(body.vault);
    return {
      ok: true,
      lastBeat: toNumber(pick(indexer, "headTimestamp", "head", "headAt")),
      rpcLagBlocks: toNumber(pick(lag, "blocks")),
      phase: toNumber(pick(vault, "phase")),
      cycleNumber: toNumber(pick(vault, "cycle")),
    };
  } catch {
    return { ok: false };
  }
}

/* ---------------------------------------------------------------------- the order feed */

export type KeeperOrderIssue = { orderHash: Hex | null; reasons: string[] };

/** Why an order is not offered when nothing is wrong with it (lib/keeperOrders.ts KEEPER_STATES). */
export type KeeperClosedState = "notCurrent" | "soldOut" | "cancelled" | "notListed" | "expired";

export type KeeperOrderBook = {
  /** False when this deployment has no KEEPER_ORDERS_URL. The page then says the feed is not wired. */
  configured: boolean;
  /** Orders the server checked against the chain, as listing rows. Still re-checked by OrderPayload. */
  listings: ListingRow[];
  /** Integrity failures: the keeper served something under the authorised hash that is not that
   *  order, or that does not parse. Never fillable, and the one outcome that is an alarm. */
  rejected: KeeperOrderIssue[];
  /** Lifecycle states: sold out, cancelled, not Listed, expired, or not the current listing. */
  closed: Array<{ orderHash: Hex | null; state: KeeperClosedState }>;
  /** Orders the chain could not be read for. Not offered yet; not the keeper's fault. */
  unchecked: KeeperOrderIssue[];
  error?: string;
};

/** The route never returns more than KEEPER_MAX_ORDERS items per list (lib/keeperOrders.ts); this
 *  bound is the page's own, so a surprise from the route cannot become thousands of list items. */
const KEEPER_LIST_CAP = 9;
const KEEPER_STATES: readonly KeeperClosedState[] = ["notCurrent", "soldOut", "cancelled", "notListed", "expired"];

function keeperIssues(value: unknown): KeeperOrderIssue[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, KEEPER_LIST_CAP).map((r) => {
    const row = asRecord(r);
    return {
      orderHash: toHex(row.orderHash) ?? null,
      reasons: Array.isArray(row.reasons)
        ? row.reasons.filter((x): x is string => typeof x === "string").slice(0, 32)
        : [],
    };
  });
}

/**
 * Read the vault's listing as the keeper serves it, through app/api/keeper/orders, which checks
 * every order against the chain before returning it (lib/keeperOrders.ts). This is the fill
 * page's only source of an order's parameters: the on-chain slot carries the hash, the count,
 * the gross and the option id, but not the salt, times or counter a fill must send.
 *
 * A 503 with `configured: false` is the "not set up here" answer, not an error. Every other
 * failure is reported as `error` in the route's own words, or in this function's: the browser's
 * own abort and network messages are never shown. The route answers inside its own deadline
 * (about eleven seconds), under the fifteen this waits.
 */
export async function fetchKeeperOrderBook(): Promise<KeeperOrderBook> {
  const unanswered: KeeperOrderBook = {
    configured: true,
    listings: [],
    rejected: [],
    closed: [],
    unchecked: [],
    error: "The order feed route did not answer.",
  };
  let res: Response;
  try {
    res = await fetch("/api/keeper/orders", {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return unanswered;
  }
  let payload: Record<string, unknown>;
  try {
    payload = asRecord(await res.json());
  } catch {
    return { ...unanswered, error: `The order feed route answered HTTP ${res.status}.` };
  }
  const configured = payload.configured !== false;
  const listings = Array.isArray(payload.orders) ? (payload.orders as ListingRow[]).slice(0, KEEPER_LIST_CAP) : [];
  const closed = Array.isArray(payload.closed)
    ? payload.closed.slice(0, KEEPER_LIST_CAP).flatMap((r) => {
        const row = asRecord(r);
        const state = KEEPER_STATES.find((s) => s === row.state);
        return state === undefined ? [] : [{ orderHash: toHex(row.orderHash) ?? null, state }];
      })
    : [];
  const error =
    typeof payload.error === "string" ? payload.error : res.ok ? undefined : `The order feed route answered HTTP ${res.status}.`;
  return {
    configured,
    listings: res.ok ? listings : [],
    rejected: keeperIssues(payload.rejected),
    closed,
    unchecked: keeperIssues(payload.unchecked),
    error,
  };
}
