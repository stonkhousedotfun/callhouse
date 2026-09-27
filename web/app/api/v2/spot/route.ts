import { NextResponse } from "next/server";

import { liveV2Markets } from "@/lib/markets";
import { V2_API_BASE } from "@/lib/v2/api";
import { resolveDisplaySpot, type DisplaySpotRow } from "@/lib/v2/displaySpot";

/**
 * GET /api/v2/spot — the price each live market SHOWS (lib/v2/displaySpot.ts has the whole contract).
 *
 * DISPLAY ONLY. The order is the API's /v2/markets spot, then the market's Chainlink feed, then its Uniswap v3 pool,
 * then the last good price this server saw. The chain is read here, on the server, over the public RPC (or a
 * server-only CHAIN_RPC_URL), never from the browser and never with a keyed URL. No trade or quote path reads this
 * route: they keep the strict live spot.
 *
 * CACHING. Chain reads are reused for 45 s inside the process; a shared cache may reuse the answer for 30 s.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The API's live spots by ticker, raw USDG 6 dp and time; an empty map when the API does not answer. */
async function apiSpots(): Promise<Map<string, { raw: bigint; updatedAt: number }>> {
  const out = new Map<string, { raw: bigint; updatedAt: number }>();
  try {
    const response = await fetch(`${V2_API_BASE}/v2/markets`, { signal: AbortSignal.timeout(3_000), cache: "no-store" });
    if (!response.ok) return out;
    const rows = await response.json() as unknown;
    if (!Array.isArray(rows)) return out;
    for (const row of rows as Array<{ ticker?: unknown; spot?: { raw?: unknown } | null; spotUpdatedAt?: unknown }>) {
      const raw = row?.spot?.raw;
      const at = row?.spotUpdatedAt;
      if (typeof row?.ticker === "string" && typeof raw === "string" && /^\d+$/.test(raw) &&
          typeof at === "number" && Number.isSafeInteger(at) && at > 0) {
        out.set(row.ticker, { raw: BigInt(raw), updatedAt: at });
      }
    }
  } catch {
    // The API being down is exactly the case the fallback is for.
  }
  return out;
}

export async function GET(): Promise<Response> {
  const api = await apiSpots();
  const items: DisplaySpotRow[] = [];
  for (const market of liveV2Markets()) {
    const spot = await resolveDisplaySpot(market.ticker, api.get(market.ticker) ?? null);
    if (spot) items.push({ ticker: market.ticker, raw: spot.raw.toString(), updatedAt: spot.updatedAt, source: spot.source });
  }
  return NextResponse.json({ items }, { headers: { "cache-control": "public, max-age=30, s-maxage=30" } });
}
