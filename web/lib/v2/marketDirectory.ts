import type { V2MarketStatus, V2Wave } from "@/lib/markets";

import type { Market, Money } from "./api-types";

export type MarketDirectoryAvailability =
  | "live"
  | "coming-soon"
  | "deferred"
  | "paused"
  | "checking"
  | "unavailable";

export type MarketDirectoryRegistryRow = {
  ticker: string;
  name: string;
  /** T-OP-099. In the owner's launch set; the registry projection computes it from `launchSet` (lib/markets.ts). */
  launch: boolean;
  v2: {
    status: V2MarketStatus;
    wave: V2Wave;
    registeredAt: number | null;
  };
};

export type MarketDirectoryApiState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; markets: readonly Market[] };

export type MarketDirectoryRow = {
  ticker: string;
  name: string;
  href: string;
  availability: MarketDirectoryAvailability;
  availabilityLabel: string;
  availabilityDetail: string;
  tradeable: boolean;
  spot: Money | null;
  spotUpdatedAt: number | null;
  settlement: Market["settlement"];
  puts: boolean | null;
  seriesOpen: number | null;
};

const AVAILABILITY_COPY: Record<MarketDirectoryAvailability, { label: string; detail: string }> = {
  live: { label: "Live", detail: "Listed and enabled for trading." },
  "coming-soon": {
    label: "Coming soon",
    detail: "Included in the next registry release, but not open for trading yet.",
  },
  deferred: {
    label: "Deferred",
    detail: "Not in the launch set. Kept in the registry for possible later scope; no launch timing is promised.",
  },
  paused: { label: "Paused", detail: "Not open for new trades." },
  checking: { label: "Checking", detail: "Confirming current market availability." },
  unavailable: {
    label: "Status unavailable",
    detail: "Current market availability could not be confirmed. Trading links stay hidden.",
  },
};

const STATUS_ORDER: Record<MarketDirectoryAvailability, number> = {
  live: 0,
  "coming-soon": 1,
  paused: 2,
  checking: 3,
  unavailable: 4,
  deferred: 5,
};

function registryAvailability(row: MarketDirectoryRegistryRow): MarketDirectoryAvailability | null {
  // T-OP-099. THE LAUNCH SET GATES EVERYTHING BELOW. A market outside the owner's launch set is "deferred"
  // whatever its wave and whatever the chain says about it: before this, `planned` + `wave1` read as
  // "Coming soon" for eighteen markets the owner had scoped out of the launch, and a market someone
  // registered on chain outside the set would have rendered as live with a trade link. `row.launch` is
  // computed by the registry projection from LAUNCH_SET (lib/markets.ts); no ticker is written here.
  if (!row.launch) return "deferred";
  if (row.v2.status === "paused") return "paused";
  // Inside the launch set the registry's release status decides: a planned launch market is coming soon.
  // `wave` no longer picks "deferred" -- membership does -- so a launch market can never be deferred by
  // its wave and a non-launch market can never be promised by it.
  if (row.v2.status === "planned") return "coming-soon";
  return null;
}

function releasedAvailability(
  row: MarketDirectoryRegistryRow,
  api: Market | undefined,
  apiState: MarketDirectoryApiState["kind"],
): MarketDirectoryAvailability {
  if (row.v2.registeredAt === null) return "unavailable";
  if (apiState === "loading") return "checking";
  if (apiState === "error" || api === undefined || api.status === "planned") return "unavailable";
  return api.status === "live" ? "live" : "paused";
}

/**
 * Merge the release registry with the chain-derived API view. The API may narrow a released row,
 * but it never promotes a planned or paused registry row into a trading surface.
 */
export function marketDirectoryRows(
  registry: readonly MarketDirectoryRegistryRow[],
  apiState: MarketDirectoryApiState,
): readonly MarketDirectoryRow[] {
  const apiByTicker = new Map(
    apiState.kind === "ready"
      ? apiState.markets.map((market) => [market.ticker.trim().toUpperCase(), market] as const)
      : [],
  );

  return registry.map((row) => {
    // F-APP-04. The map is keyed on `ticker.trim().toUpperCase()` (just above), so the lookup has to
    // normalise identically or the two halves of the same expression can disagree. Latent today —
    // every generated ticker already matches /^[A-Z0-9.]*$/ — and fail-closed if it ever missed, which
    // is why it is folded in here rather than given its own row. Asymmetric key/lookup pairs are worth
    // closing while they are still harmless.
    const api = apiByTicker.get(row.ticker.trim().toUpperCase());
    const availability = registryAvailability(row)
      ?? releasedAvailability(row, api, apiState.kind);
    const copy = AVAILABILITY_COPY[availability];
    const apiIsCurrent = apiState.kind === "ready";
    return {
      ticker: row.ticker,
      name: row.name,
      href: `/${row.ticker.toLowerCase()}`,
      availability,
      availabilityLabel: copy.label,
      availabilityDetail: copy.detail,
      tradeable: availability === "live",
      spot: apiIsCurrent ? api?.spot ?? null : null,
      spotUpdatedAt: apiIsCurrent ? api?.spotUpdatedAt ?? null : null,
      settlement: apiIsCurrent ? api?.settlement : undefined,
      puts: apiIsCurrent && api ? api.puts : null,
      seriesOpen: apiIsCurrent && api ? api.stats.seriesOpen : null,
    };
  }).sort((left, right) =>
    STATUS_ORDER[left.availability] - STATUS_ORDER[right.availability]
      || left.ticker.localeCompare(right.ticker));
}

export function filterMarketDirectory(
  rows: readonly MarketDirectoryRow[],
  query: string,
  availability: MarketDirectoryAvailability | "all" = "all",
): readonly MarketDirectoryRow[] {
  const needle = query.trim().toLowerCase();
  return rows.filter((row) =>
    (availability === "all" || row.availability === availability)
      && (needle === "" || row.ticker.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle)));
}

export function formatConfiguredDelay(seconds: number): string {
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minutes`;
  }
  return `${seconds} seconds`;
}

export function settlementModeLabel(settlement: Market["settlement"]): string | null {
  if (settlement === undefined) return null;
  const sources = `${settlement.sourceCount} ${settlement.sourceCount === 1 ? "source" : "sources"}`;
  const wait = formatConfiguredDelay(settlement.uncorroboratedDelayS);
  return settlement.sourceCount === 1
    ? `${sources} · ${wait} uncorroborated wait`
    : `${sources} · ${wait} fallback wait`;
}

export function settlementPayoutLabel(settlement: Market["settlement"]): string | null {
  if (settlement === undefined) return null;
  return settlement.route === null
    ? "Winning calls pay Stock Tokens · puts pay USDG"
    : "Winning calls try USDG conversion, with Stock Tokens as fallback · puts pay USDG";
}
