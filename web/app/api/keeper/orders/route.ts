import { NextResponse } from "next/server";

import { CHAIN_ID, publicClient } from "@/lib/chain";
import { CLEARINGHOUSE, SEAPORT, USDG, VAULT } from "@/lib/contracts";
import {
  serveKeeperOrders,
  viemKeeperChainReader,
  type KeeperChainReader,
  type KeeperOrdersBody,
} from "@/lib/keeperOrders";

/**
 * The keeper fallback: the vault's live listing as the keeper serves it at GET /orders, checked
 * against the chain, for the cycle page to use when Overcall's book does not show it.
 *
 * WHERE IT READS FROM: `KEEPER_ORDERS_URL`, a RUNTIME server variable (not NEXT_PUBLIC_, never
 * inlined, never sent to a browser), read per request. On Railway it is the keeper's private
 * address, http://keeper.railway.internal:8787/orders. Unset, this route answers 503 with
 * `configured: false` and the page shows nothing about the fallback.
 *
 * WHAT IT WILL NOT DO: read anything from the request. No query string, no body and no header
 * reaches the upstream call, so the route cannot be pointed at another host. Redirects are not
 * followed. The keeper's answer is capped in bytes and in time (lib/keeperOrders.ts).
 *
 * WHAT IT DOES NOT BELIEVE: the keeper. Every order is rebuilt from its parameters with Seaport's
 * counter read from the chain, hashed by Seaport, and served only if that hash is the vault's
 * listingHash() and the order is the vault's in every field a fill spends against. The rest are
 * logged here and returned under `rejected`. lib/keeperOrders.ts carries the full list.
 *
 * Answers are shared for two seconds, so many open cycle pages cost one keeper request and one
 * chain batch, not one each.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SHARE_MS = 2_000;

type Answer = { status: number; body: KeeperOrdersBody };
let shared: { url: string | undefined; at: number; answer: Promise<Answer> } | null = null;

let reader: KeeperChainReader | null = null;
function chainReader(): KeeperChainReader {
  // Only reached once serveKeeperOrders has confirmed a vault is configured.
  reader ??= viemKeeperChainReader(publicClient, { vault: VAULT!, seaport: SEAPORT });
  return reader;
}

function answer(): Promise<Answer> {
  const keeperOrdersUrl = process.env.KEEPER_ORDERS_URL;
  const now = Date.now();
  if (shared !== null && shared.url === keeperOrdersUrl && now - shared.at < SHARE_MS) return shared.answer;
  const fresh = serveKeeperOrders({
    keeperOrdersUrl,
    config: { vault: VAULT, usdg: USDG, clearinghouse: CLEARINGHOUSE, seaport: SEAPORT, chainId: CHAIN_ID },
    chain: {
      vaultListing: () => chainReader().vaultListing(),
      getCounter: (offerer) => chainReader().getCounter(offerer),
      getOrderHash: (components) => chainReader().getOrderHash(components),
      getOrderStatus: (orderHash) => chainReader().getOrderStatus(orderHash),
    },
    nowSeconds: Math.floor(now / 1000),
  });
  shared = { url: keeperOrdersUrl, at: now, answer: fresh };
  return fresh;
}

export async function GET() {
  const { status, body } = await answer();
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}
