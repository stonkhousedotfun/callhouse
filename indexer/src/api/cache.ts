import type { Context, MiddlewareHandler } from "hono";

/**
 * A 15-second response cache for the public read routes.
 *
 * Two layers, both required:
 *   - `Cache-Control: public, max-age=15` so a CDN or the browser can hold it.
 *   - a tiny in-process store so a burst of uncached clients does not turn one page view
 *     into a dozen RPC round trips. The live vault read behind `/v1/vault` is the expensive
 *     part; the SQL behind it is not.
 *
 * Fifteen seconds is deliberately short. This product's numbers change on human timescales —
 * one roll a week — but the phase and the fill state are exactly what somebody refreshing
 * during a Friday roll is watching, and a stale "unfilled" would read as a lie.
 */

const TTL_MS = 15_000;
const MAX_ENTRIES = 256;

type Entry = { body: string; status: number; expires: number };

const store = new Map<string, Entry>();

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

  const key = c.req.url;
  const now = Date.now();
  const hit = store.get(key);

  if (hit !== undefined && hit.expires > now) {
    return respond(c, hit.body, hit.status, "HIT");
  }

  await next();

  // Only cache clean JSON responses. An error is never worth holding for 15 seconds.
  if (c.res.status >= 200 && c.res.status < 300) {
    const body = await c.res.clone().text();
    evictExpired(now);
    store.set(key, { body, status: c.res.status, expires: now + TTL_MS });
    c.res.headers.set("cache-control", `public, max-age=${TTL_MS / 1000}`);
    c.res.headers.set("x-cache", "MISS");
  } else {
    c.res.headers.set("cache-control", "no-store");
  }
  return undefined;
};

function respond(c: Context, body: string, status: number, marker: string) {
  return c.newResponse(body, status as 200, {
    "content-type": "application/json; charset=UTF-8",
    "cache-control": `public, max-age=${TTL_MS / 1000}`,
    "x-cache": marker,
  });
}

/** Drop everything. Exposed so a test or an admin path can force a re-read. */
export const clearCache = () => store.clear();
