import { NextResponse } from "next/server";

import { CHAIN_ID, publicClient } from "@/lib/chain";
import { CLEARINGHOUSE, SEAPORT, USDG, VAULT } from "@/lib/contracts";
import {
  serveKeeperOrders,
  shareWhileRunning,
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
 * followed. The keeper's answer is capped in bytes, in order count and in time, and the chain
 * reads have their own deadline (lib/keeperOrders.ts), so the route answers well inside the
 * fifteen seconds the browser waits.
 *
 * WHAT IT DOES NOT BELIEVE: the keeper. Every order that names the vault's listingHash is rebuilt
 * from its parameters with Seaport's counter read from the chain, hashed locally and by Seaport,
 * and served only if it is the vault's order in every field a fill spends against. What it
 * returns under `rejected`, `closed` and `unchecked` is described in lib/keeperOrders.ts.
 *
 * SHARING: one computation serves every request that arrives while it runs, and for two seconds
 * after it settles, so many open cycle pages cost one keeper request and one chain batch, and a
 * slow RPC does not stack a new batch on every poll.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SHARE_MS = 2_000;

type Answer = { status: number; body: KeeperOrdersBody };

let reader: KeeperChainReader | null = null;
function chainReader(): KeeperChainReader {
  // Only reached once serveKeeperOrders has confirmed a vault is configured.
  reader ??= viemKeeperChainReader(publicClient, { vault: VAULT!, seaport: SEAPORT });
  return reader;
}

const UNEXPECTED = "The fallback route could not check the keeper's orders.";

// Keyed by the URL, so a changed KEEPER_ORDERS_URL never reuses an answer from the old one.
const answer = shareWhileRunning(
  (keeperOrdersUrl): Promise<Answer> =>
    serveKeeperOrders({
      keeperOrdersUrl,
      config: { vault: VAULT, usdg: USDG, clearinghouse: CLEARINGHOUSE, seaport: SEAPORT, chainId: CHAIN_ID },
      chain: {
        readState: (query) => chainReader().readState(query),
        getOrderHashes: (components) => chainReader().getOrderHashes(components),
      },
      nowSeconds: Math.floor(Date.now() / 1000),
    }).catch(
      (): Answer => ({
        status: 502,
        body: { configured: true, orders: [], rejected: [], closed: [], unchecked: [], error: UNEXPECTED },
      }),
    ),
  { shareMs: SHARE_MS },
);

export async function GET() {
  const { status, body } = await answer(process.env.KEEPER_ORDERS_URL);
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}
