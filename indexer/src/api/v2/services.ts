/**
 * GET /v2/services — what the indexer can say about the SERVICES it does not run.
 *
 * WHY THIS EXISTS. The pricer is a separate process (keeper, PRICER_PORT). Before this route the
 * only link between the two ran the other way: the pricer optionally posts to the indexer through
 * INDEXER_URL (`keeper/src/v2/pricer/main.ts`). The indexer had no URL for the pricer and `/v2/health`
 * reports indexed-head lag and nothing else, so the web app could not tell "the pricer is down" from
 * "there is no fair value for this series". T-423 gave the pricer a public-safe readiness endpoint;
 * this reads it and republishes it on the frozen v2 wire so T-296 can consume a typed field.
 *
 * FAIL CLOSED, AND THE ONE SUBTLETY THAT MATTERS. `healthy` is true ONLY when the pricer answered
 * `ready: true`, named no reason against itself, and did so recently enough. Every other path —
 * no URL, a timeout, an unreadable answer, an answer we could not refresh — is `healthy: false` with
 * its own distinct reason.
 *
 * THE SUBTLETY: the producer answers **503 for a legitimate not-ready** (`health.ts` readyRoute:
 * "200 when ready, 503 when not, the body either way"). So "non-2xx" and "the pricer said it is not
 * ready" are NOT disjoint cases, and a reader that branches on the status code FIRST collapses them
 * and throws the producer's reason away — it would report `http_error` for the one case where the
 * pricer told us precisely what was wrong. This module therefore parses the BODY first and only
 * falls back to the status code when the body is not a valid readiness answer. That ordering is the
 * difference between fail-closed and fail-closed-in-name-only.
 *
 * WHAT IS NEVER TOUCHED. The pricer's `/health` body carries the signer and its balance, the RPC
 * origins, the contract addresses and the db path. It is never fetched here and never served. Only
 * `/ready` is read, and only the five keys T-423 froze are read out of it.
 *
 * THE ENV VAR IS READ HERE, NOT IN lib/env.ts. `indexer/lib/env.ts` is fenced by T-295, and this row
 * says so explicitly; `PRICER_READY_URL` is therefore read from `process.env` in this file. It is
 * also read per call rather than captured at module load, so a test can set it without re-importing
 * the module and so an operator restart is the only thing needed to change it.
 */
import type { Hono } from "hono";

/**
 * The pricer's closed reason set, MIRRORED from `keeper/src/v2/health.ts` READY_REASONS at base
 * 48f5602604b4dd979a7eba167b9b93063d40c41e — copied, not re-reasoned. A reason outside this set is
 * not passed through: the producer already replaces anything unknown with `state-unknown`, and if a
 * value outside the set somehow arrives, the body is not the contract we validated and the answer
 * becomes `malformed_body`.
 */
export const PRICER_READY_REASONS = [
  "loop-wedged",
  "no-completed-tick",
  "tick-failed",
  "role-unread",
  "role-refused",
  "role-delayed",
  "fair-stale",
  "state-unknown",
] as const;
export type PricerReadyReason = (typeof PRICER_READY_REASONS)[number];

/**
 * Why the indexer's answer is what it is. Distinct per failure, so a consumer can tell "nobody
 * configured this" from "the pricer said no" from "we could not reach it".
 *
 *   ready           the pricer answered ready:true, no reasons, inside the freshness bound
 *   not_configured  PRICER_READY_URL is unset or blank. NOT an error and NOT healthy
 *   timeout         the request did not answer within PRICER_READY_TIMEOUT_MS
 *   http_error      a non-2xx whose body is NOT a valid readiness answer, or a transport failure
 *   malformed_body  a 2xx or 503 whose body is not the five-key contract T-423 froze
 *   not_ready       the pricer answered, validly, that it is not ready. `reasons` carries its own
 *   stale           the answer is older than the freshness bound: the last one we hold, or the
 *                   pricer's own checkedAt. An old truth is not a current one
 */
export const PRICER_STATUS_REASONS = [
  "ready", "not_configured", "timeout", "http_error", "malformed_body", "not_ready", "stale",
] as const;
export type PricerStatusReason = (typeof PRICER_STATUS_REASONS)[number];

export interface PricerServiceStatus {
  healthy: boolean;
  reason: PricerStatusReason;
  /** The producer's own reasons, passed through untouched. Empty unless it answered validly. */
  reasons: PricerReadyReason[];
  /** Unix SECONDS. When THIS answer was determined (schema.ts pins seconds, the producer sends ISO). */
  checkedAt: number;
  /** Unix SECONDS of the pricer's latest completed evaluation, or null before its first. */
  lastEvaluationAt: number | null;
}

/** How long to wait for the pricer before giving up. Short: this is a status read on a hot route. */
export const PRICER_TIMEOUT_MS = 2_000;
/** How long an answer is reused without asking again. Below /v2/health's own 15s cache horizon. */
export const PRICER_CACHE_MS = 10_000;
/**
 * How old the pricer's OWN `checkedAt` may be and still count as current.
 *
 * This is the bound the row means by "within the freshness bound". It is deliberately larger than
 * the cache window: the cache decides when to re-ask, this decides whether the answer we have still
 * describes the present. An answer older than this is `stale` and NOT healthy, even though it says
 * ready — a pricer that died one minute after saying it was fine is not a pricer that is fine.
 */
export const PRICER_FRESH_MS = 60_000;

const SECONDS = (ms: number) => Math.floor(ms / 1000);

/** ISO -> unix seconds, or null. A value that is not a finite date is null, never 0 or NaN. */
function isoToSeconds(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? SECONDS(ms) : null;
}

/**
 * The five-key body T-423 froze, validated key by key.
 *
 * Validated rather than trusted because an unknown key here would mean we are reading something
 * other than `/ready` — the pricer's `/health`, a proxy's error page, a different service on a
 * reused URL — and the correct response to that is `malformed_body`, not a partial read. Unknown
 * keys are rejected for the same reason `schema.ts` is strict throughout.
 */
function parseReadyBody(body: unknown): { ready: boolean; reasons: PricerReadyReason[]; checkedAt: number; lastEvaluationAt: number | null } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  const allowed = new Set(["ready", "reasons", "checkedAt", "lastEvaluationAt", "interfaceVersion"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) return null;
  if (typeof value.ready !== "boolean") return null;
  if (!Array.isArray(value.reasons)) return null;
  if (typeof value.interfaceVersion !== "number" || !Number.isFinite(value.interfaceVersion)) return null;
  const known: ReadonlySet<string> = new Set(PRICER_READY_REASONS);
  const reasons: PricerReadyReason[] = [];
  for (const reason of value.reasons) {
    if (typeof reason !== "string" || !known.has(reason)) return null;
    if (!reasons.includes(reason as PricerReadyReason)) reasons.push(reason as PricerReadyReason);
  }
  const checkedAt = isoToSeconds(value.checkedAt);
  if (checkedAt === null) return null;
  if (value.lastEvaluationAt !== null && typeof value.lastEvaluationAt !== "string") return null;
  return { ready: value.ready, reasons, checkedAt, lastEvaluationAt: isoToSeconds(value.lastEvaluationAt) };
}

type Cached = { at: number; status: PricerServiceStatus };
let cached: Cached | null = null;

/** Test seam only. Nothing in the running server calls this. */
export function resetPricerCache(): void { cached = null; }

function unhealthy(reason: PricerStatusReason, now: number, reasons: PricerReadyReason[] = [], lastEvaluationAt: number | null = null): PricerServiceStatus {
  return { healthy: false, reason, reasons, checkedAt: SECONDS(now), lastEvaluationAt };
}

/**
 * Read the pricer's readiness, with a timeout and a short cache.
 *
 * `fetchImpl` and `now` are parameters so the test can drive every branch without a socket or a
 * clock; the route passes neither.
 */
export async function readPricerStatus(
  fetchImpl: typeof fetch = fetch, now: number = Date.now(),
): Promise<PricerServiceStatus> {
  const url = (process.env.PRICER_READY_URL ?? "").trim();
  // An unset URL is a deployment that has not been wired up yet, not a fault. It is still not
  // healthy: the indexer cannot vouch for a service it has no address for.
  if (url === "") { cached = null; return unhealthy("not_configured", now); }

  if (cached !== null && now - cached.at < PRICER_CACHE_MS) {
    return { ...cached.status, checkedAt: SECONDS(now) };
  }

  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(PRICER_TIMEOUT_MS) });
  } catch (error) {
    // A timeout and a refused connection are different operational stories, so they get different
    // reasons. AbortSignal.timeout rejects with a TimeoutError; anything else is transport.
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return serve(unhealthy(timedOut ? "timeout" : "http_error", now), now);
  }

  let body: unknown;
  try { body = await response.json(); } catch { body = null; }
  const parsed = parseReadyBody(body);

  // BODY FIRST, STATUS SECOND. The producer answers 503 for a legitimate not-ready and sends the
  // body either way, so a valid body is authoritative whatever the code. Only when the body is not
  // the frozen contract does the status code decide which failure this was.
  if (parsed === null) return serve(unhealthy(response.ok ? "malformed_body" : "http_error", now), now);

  if (SECONDS(now) - parsed.checkedAt > SECONDS(PRICER_FRESH_MS)) {
    return serve(unhealthy("stale", now, parsed.reasons, parsed.lastEvaluationAt), now);
  }
  if (!parsed.ready || parsed.reasons.length > 0) {
    return serve(unhealthy("not_ready", now, parsed.reasons, parsed.lastEvaluationAt), now);
  }
  return serve({ healthy: true, reason: "ready", reasons: [], checkedAt: SECONDS(now), lastEvaluationAt: parsed.lastEvaluationAt }, now);
}

function serve(status: PricerServiceStatus, now: number): PricerServiceStatus {
  cached = { at: now, status };
  return status;
}

export function registerServiceRoutes(app: Hono): void {
  app.get("/services", async (c) => {
    c.header("cache-control", "no-store");
    return c.json({ pricer: await readPricerStatus() });
  });
}
