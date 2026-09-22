import type { Context, MiddlewareHandler } from "hono";

/**
 * A 15-second response cache for the public read routes.
 *
 * Two layers, both required:
 *   - `Cache-Control: public, max-age=15` so a CDN or the browser can hold it.
 *   - a tiny in-process store so a burst of uncached clients does not turn one page view
 *     into a dozen RPC round trips. The card routes also share one exact computation
 *     across distinct query URLs within this window.
 *
 * Fifteen seconds is deliberately short. This product's numbers change on human timescales —
 * one roll a week — but the phase and the fill state are exactly what somebody refreshing
 * during a Friday roll is watching, and a stale "unfilled" would read as a lie.
 */

const TTL_MS = 15_000;
const MAX_ENTRIES = 256;

type Entry = { body: string; status: number; expires: number };

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry | null>>();

type Computed<T> = { value: T; expiresAt: number };
type Computation = { promise: Promise<Computed<unknown>>; expires: number; pending: boolean };
/** Fixed internal keys only: share an expensive read across URL variants and concurrent callers. */
const computations = new Map<string, Computation>();

export const v2QueryKeys: readonly [RegExp, readonly string[]][] = [
  [/^\/v2\/calendar\/holidays$/, ["fromDay", "toDay"]],
  [/^\/v2\/markets\/[^/]+\/series$/, ["expiry", "type", "status", "cursor", "limit"]],
  [/^\/v2\/series\/[^/]+\/book$/, ["depth"]],
  [/^\/v2\/series\/[^/]+\/trades$/, ["cursor", "limit"]],
  [/^\/v2\/cards$/, ["type", "sort", "tenor", "ticker", "cursor", "limit"]],
  [/^\/v2\/series\/[^/]+\/holders$/, ["side", "cursor", "limit"]],
  [/^\/v2\/strategies$/, ["active", "cursor", "limit"]],
  [/^\/v2\/feed\/activity$/, ["since", "kinds", "cursor", "limit"]],
  [/^\/v2\/accounts\/[^/]+\/history$/, ["cursor", "limit"]],
  [/^\/v2\/feed\/wins$/, ["window", "cursor", "limit"]],
  [/^\/v2\/leaderboard$/, ["metric", "window", "cursor", "limit"]],
  [/^\/v2\/makers$/, ["epoch", "cursor", "limit"]],
  [/^\/v2\/admin\/operations$/, ["status", "cursor", "limit"]],
  [/^\/v2\/earn$/, ["address"]],
  [/^\/v2\/house\/[^/]+$/, ["address"]],
  [/^\/v2\/(?:accounts\/[^/]+\/positions|config|markets|series\/[^/]+|cards\/hero|fair\/[^/]+|pnl\/[^/]+|stats|flywheel|house|makers\/[^/]+)$/, []],
];

export function compute15s<T>(key: string, run: () => Promise<T>): Promise<Computed<T>> {
  const hit = computations.get(key);
  if (hit !== undefined && (hit.pending || hit.expires > Date.now())) return hit.promise as Promise<Computed<T>>;
  let entry: Computation;
  const promise = Promise.resolve().then(run).then((value) => {
    const expiresAt = Date.now() + TTL_MS;
    if (computations.get(key) === entry) { entry.pending = false; entry.expires = expiresAt; }
    return { value, expiresAt };
  }, (reason: unknown) => {
    if (computations.get(key) === entry) computations.delete(key);
    throw reason;
  });
  entry = { promise, expires: Infinity, pending: true };
  computations.set(key, entry);
  return promise;
}

/**
 * One computation per key PER INDEXED CHECKPOINT, shared by every concurrent and later caller until
 * the checkpoint moves. For a route that must never be staler than the index itself (so no TTL is
 * acceptable) but is too expensive to recompute on every hit. Ponder publishes projection writes and
 * the checkpoint in one transaction, so an unchanged checkpoint means unchanged indexed state; the
 * cost is bounded by the block rate, not the request rate. A failed computation is dropped, never
 * served again. {clearCache} empties it like everything else here.
 */
const atCheckpoint = new Map<string, { checkpoint: string; promise: Promise<unknown> }>();

export function computeAtCheckpoint<T>(key: string, checkpoint: string, run: () => Promise<T>): Promise<T> {
  const hit = atCheckpoint.get(key);
  if (hit !== undefined && hit.checkpoint === checkpoint) return hit.promise as Promise<T>;
  const entry = { checkpoint, promise: Promise.resolve().then(run) as Promise<unknown> };
  atCheckpoint.set(key, entry);
  entry.promise.catch(() => { if (atCheckpoint.get(key) === entry) atCheckpoint.delete(key); });
  return entry.promise as Promise<T>;
}

/** Keep only the query keys each public v2 route actually reads. */
export function responseCacheKey(rawUrl: string): string {
  const queryAt = rawUrl.indexOf("?");
  if (queryAt < 0) return rawUrl;
  const base = rawUrl.slice(0, queryAt);
  const pathname = new URL(base).pathname;
  if (!pathname.startsWith("/v2/")) return rawUrl;
  const keys = v2QueryKeys.find(([pattern]) => pattern.test(pathname))?.[1];
  if (keys === undefined) return rawUrl;
  const source = new URL(rawUrl).searchParams;
  const canonical = new URLSearchParams();
  for (const key of keys) {
    const value = source.get(key);
    if (value !== null) canonical.set(key, value);
  }
  const query = canonical.toString();
  return query.length === 0 ? base : `${base}?${query}`;
}

function evictExpired(now: number) {
  for (const [key, entry] of store) {
    if (entry.expires <= now) store.delete(key);
  }
  // Hard bound so a route with a high-cardinality query string cannot grow without limit.
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done === true) break;
    store.delete(oldest.value);
  }
}

export const cache15s: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== "GET") return next();

  const key = responseCacheKey(c.req.url);
  const boundedKey = key.length <= 2_048;
  const now = Date.now();
  const hit = boundedKey ? store.get(key) : undefined;

  if (hit !== undefined && hit.expires > now) {
    return respond(c, hit.body, hit.status, "HIT", hit.expires);
  }

  const pending = boundedKey ? inflight.get(key) : undefined;
  if (pending !== undefined) {
    const shared = await pending;
    if (shared !== null && shared.expires > Date.now())
      return respond(c, shared.body, shared.status, "HIT", shared.expires);
  }

  let release: ((entry: Entry | null) => void) | undefined;
  let owned: Promise<Entry | null> | undefined;
  if (boundedKey && inflight.size < MAX_ENTRIES && !inflight.has(key)) {
    owned = new Promise((resolve) => { release = resolve; });
    inflight.set(key, owned);
  }

  try {
    await next();

    // A shared snapshot may be older than this response. Do not grant it a fresh TTL.
    const snapshotExpiry = Number(c.res.headers.get("x-internal-snapshot-expires-at"));
    c.res.headers.delete("x-internal-snapshot-expires-at");
    const responseTime = Date.now();
    const expires = Math.min(responseTime + TTL_MS,
      Number.isFinite(snapshotExpiry) && snapshotExpiry > 0 ? snapshotExpiry : Infinity);

    // Only cache clean JSON responses; clearCache may have invalidated an in-flight read.
    if (boundedKey && c.res.status >= 200 && c.res.status < 300 && expires > responseTime) {
      const body = await c.res.clone().text();
      const entry = { body, status: c.res.status, expires };
      if (owned === undefined || inflight.get(key) === owned) {
        evictExpired(responseTime);
        store.set(key, entry);
        release?.(entry);
      }
      c.res.headers.set("cache-control", `public, max-age=${Math.max(0, Math.floor((expires - Date.now()) / 1000))}`);
      c.res.headers.set("x-cache", "MISS");
    } else {
      c.res.headers.set("cache-control", "no-store");
    }
    return undefined;
  } finally {
    release?.(null);
    if (owned !== undefined && inflight.get(key) === owned) inflight.delete(key);
  }
};

function respond(c: Context, body: string, status: number, marker: string, expires: number) {
  return c.newResponse(body, status as 200, {
    "content-type": "application/json; charset=UTF-8",
    "cache-control": `public, max-age=${Math.max(0, Math.floor((expires - Date.now()) / 1000))}`,
    "x-cache": marker,
  });
}

/** Drop everything. Exposed so a test or an admin path can force a re-read. */
export const clearCache = () => { store.clear(); inflight.clear(); computations.clear(); atCheckpoint.clear(); };
