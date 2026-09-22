/**
 * The /v2/services fail-closed matrix.
 *
 * WHAT THIS FILE IS FOR. `healthy: true` is a claim the web app acts on, so every path that is not
 * "the pricer said it is ready, recently" must reach `healthy: false` — and must say WHICH path it
 * was, because "the pricer is down" and "nobody configured the URL" call for different actions from
 * whoever is on call. One test per branch, and a test that NO branch can reach healthy:true except
 * the single ready one.
 *
 * NO PONDER, NO PGLITE. `services.ts` imports nothing from ponder, so this is a plain vitest file
 * rather than the database harness `routes.test.ts` needs. That is deliberate: a status reader that
 * needed a database to test would not get tested.
 *
 * THE CASE THAT IS EASY TO GET WRONG, and the reason the body is parsed before the status code:
 * the pricer answers **503 for a legitimate not-ready** (`keeper/src/v2/health.ts` readyRoute —
 * "200 when ready, 503 when not, the body either way"). A reader that branched on the status code
 * first would report `http_error` for the one case where the pricer told us exactly what was wrong.
 * `passes the pricer's own reason through a 503` below is that case, and it is the assertion that
 * would go red if anyone reorders those two checks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PRICER_CACHE_MS, PRICER_FRESH_MS, readPricerStatus, resetPricerCache,
} from "./services";

const URL_VALUE = "http://127.0.0.1:8791/ready";
const NOW = 1_800_000_000_000; // wall-clock ms; unix seconds are NOW/1000

/** A valid T-423 /ready body. The five keys and nothing else. */
function readyBody(over: Partial<Record<string, unknown>> = {}) {
  return {
    ready: true,
    reasons: [] as string[],
    checkedAt: new Date(NOW).toISOString(),
    lastEvaluationAt: new Date(NOW - 5_000).toISOString(),
    interfaceVersion: 8,
    ...over,
  };
}

function respond(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

beforeEach(() => { resetPricerCache(); vi.stubEnv("PRICER_READY_URL", URL_VALUE); });
afterEach(() => { vi.unstubAllEnvs(); resetPricerCache(); });

describe("the one healthy case", () => {
  it("ready:true with no reasons, inside the freshness bound, is healthy", async () => {
    const fetchImpl = vi.fn(async () => respond(readyBody()));
    const status = await readPricerStatus(fetchImpl as unknown as typeof fetch, NOW);
    expect(status.healthy).toBe(true);
    expect(status.reason).toBe("ready");
    expect(status.reasons).toEqual([]);
    expect(status.checkedAt).toBe(NOW / 1000);
    expect(status.lastEvaluationAt).toBe((NOW - 5_000) / 1000);
  });

  it("reads the readiness URL and NEVER the pricer's /health", async () => {
    // /health carries the signer, its balance, the RPC origins and the db path. AC5.
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => { requested.push(url); return respond(readyBody()); });
    await readPricerStatus(fetchImpl as unknown as typeof fetch, NOW);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requested).toEqual([URL_VALUE]);
    expect(requested[0]).not.toContain("/health");
  });
});

describe("every other path fails closed, with its own reason", () => {
  it("not_configured — PRICER_READY_URL unset, and nothing is fetched", async () => {
    vi.stubEnv("PRICER_READY_URL", "");
    const fetchImpl = vi.fn(async () => respond(readyBody()));
    const status = await readPricerStatus(fetchImpl as unknown as typeof fetch, NOW);
    expect(status).toMatchObject({ healthy: false, reason: "not_configured", reasons: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("not_configured — a whitespace-only URL is unset, not a URL", async () => {
    vi.stubEnv("PRICER_READY_URL", "   ");
    const fetchImpl = vi.fn(async () => respond(readyBody()));
    expect((await readPricerStatus(fetchImpl as unknown as typeof fetch, NOW)).reason).toBe("not_configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("timeout — the request did not answer in time", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const fetchImpl = vi.fn(async () => { throw timeout; });
    const status = await readPricerStatus(fetchImpl as unknown as typeof fetch, NOW);
    expect(status).toMatchObject({ healthy: false, reason: "timeout" });
  });

  it("http_error — a transport failure is not a timeout", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const status = await readPricerStatus(fetchImpl as unknown as typeof fetch, NOW);
    expect(status).toMatchObject({ healthy: false, reason: "http_error" });
  });

  it("http_error — a non-2xx WITHOUT a valid ready body", async () => {
    // 502 from a proxy, an HTML error page, a 404 on a reused URL: no reason to pass through.
    const fetchImpl = vi.fn(async () => respond({ error: "bad gateway" }, 502));
    const status = await readPricerStatus(fetchImpl as unknown as typeof fetch, NOW);
    expect(status).toMatchObject({ healthy: false, reason: "http_error", reasons: [] });
  });

  it("malformed_body — a 200 whose body is not the frozen five-key contract", async () => {
    const cases: unknown[] = [
      null,
      "ready",
      { ready: "yes", reasons: [], checkedAt: new Date(NOW).toISOString(), lastEvaluationAt: null, interfaceVersion: 8 },
      { ready: true, reasons: "none", checkedAt: new Date(NOW).toISOString(), lastEvaluationAt: null, interfaceVersion: 8 },
      { ready: true, reasons: [], checkedAt: "not-a-date", lastEvaluationAt: null, interfaceVersion: 8 },
      { ready: true, reasons: [], checkedAt: new Date(NOW).toISOString(), lastEvaluationAt: null }, // no interfaceVersion
      // An UNKNOWN KEY is malformed, not ignored: it means we are reading something that is not
      // /ready — the pricer's /health, a proxy page, another service on a reused URL.
      { ...readyBody(), signer: "0xdeadbeef" },
      // A reason outside the producer's closed set means the same thing.
      { ...readyBody(), ready: false, reasons: ["disk-full"] },
    ];
    for (const body of cases) {
      resetPricerCache();
      const fetchImpl = vi.fn(async () => respond(body));
      const status = await readPricerStatus(fetchImpl as unknown as typeof fetch, NOW);
      expect(status.healthy, JSON.stringify(body)).toBe(false);
      expect(status.reason, JSON.stringify(body)).toBe("malformed_body");
    }
  });

  it("not_ready — passes the pricer's own reason through a 503", async () => {
    // THE OVERLAP CASE. 503 is how a legitimate not-ready is delivered, so the body decides and the
    // status code does not. Reorder those two checks in services.ts and this goes red.
    const fetchImpl = vi.fn(async () => respond(readyBody({ ready: false, reasons: ["role-refused", "fair-stale"] }), 503));
    const status = await readPricerStatus(fetchImpl as unknown as typeof fetch, NOW);
    expect(status).toMatchObject({ healthy: false, reason: "not_ready" });
    expect(status.reasons).toEqual(["role-refused", "fair-stale"]);
  });

  it("not_ready — ready:true contradicted by a named reason is still not ready", async () => {
    const fetchImpl = vi.fn(async () => respond(readyBody({ ready: true, reasons: ["tick-failed"] })));
    const status = await readPricerStatus(fetchImpl as unknown as typeof fetch, NOW);
    expect(status).toMatchObject({ healthy: false, reason: "not_ready", reasons: ["tick-failed"] });
  });

  it("stale — an answer older than the freshness bound is not a current answer", async () => {
    const old = new Date(NOW - PRICER_FRESH_MS - 1_000).toISOString();
    const fetchImpl = vi.fn(async () => respond(readyBody({ checkedAt: old })));
    const status = await readPricerStatus(fetchImpl as unknown as typeof fetch, NOW);
    // It said ready:true. It is still not healthy: a pricer that was fine two minutes ago and died
    // one minute ago is not a pricer that is fine.
    expect(status).toMatchObject({ healthy: false, reason: "stale" });
  });
});

describe("the cache serves the last answer and then stops", () => {
  it("reuses a fresh answer without asking again, and re-stamps checkedAt", async () => {
    const fetchImpl = vi.fn(async () => respond(readyBody()));
    const first = await readPricerStatus(fetchImpl as unknown as typeof fetch, NOW);
    const second = await readPricerStatus(fetchImpl as unknown as typeof fetch, NOW + PRICER_CACHE_MS - 1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second.healthy).toBe(true);
    expect(second.checkedAt).toBe(Math.floor((NOW + PRICER_CACHE_MS - 1) / 1000));
    expect(first.checkedAt).toBe(NOW / 1000);
  });

  it("asks again once the cache window has passed", async () => {
    const fetchImpl = vi.fn(async () => respond(readyBody()));
    await readPricerStatus(fetchImpl as unknown as typeof fetch, NOW);
    await readPricerStatus(fetchImpl as unknown as typeof fetch, NOW + PRICER_CACHE_MS + 1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("a cached HEALTHY answer cannot outlive the pricer's own freshness bound", async () => {
    // The cache window is shorter than the freshness bound on purpose, so this is belt and braces:
    // re-asking at a time when the SAME body has aged past the bound must flip to stale, not keep
    // serving the cached true. This is the assertion that stops a stale cache reading as healthy.
    const body = readyBody();
    const fetchImpl = vi.fn(async () => respond(body));
    expect((await readPricerStatus(fetchImpl as unknown as typeof fetch, NOW)).healthy).toBe(true);
    const later = NOW + PRICER_FRESH_MS + 1_000;
    const status = await readPricerStatus(fetchImpl as unknown as typeof fetch, later);
    expect(status).toMatchObject({ healthy: false, reason: "stale" });
  });

  it("an unset URL clears a previously cached healthy answer", async () => {
    const fetchImpl = vi.fn(async () => respond(readyBody()));
    expect((await readPricerStatus(fetchImpl as unknown as typeof fetch, NOW)).healthy).toBe(true);
    vi.stubEnv("PRICER_READY_URL", "");
    const status = await readPricerStatus(fetchImpl as unknown as typeof fetch, NOW + 1);
    expect(status).toMatchObject({ healthy: false, reason: "not_configured" });
  });
});

describe("healthy is reachable from exactly one reason", () => {
  it("no failure path produces healthy:true", async () => {
    // The whole-file control. If a branch is ever added that forgets to set healthy:false, this
    // catches it without anyone remembering to write a test for that branch.
    const failures: Array<() => typeof fetch> = [
      () => (vi.fn(async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }) as unknown as typeof fetch),
      () => (vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch),
      () => (vi.fn(async () => respond({ error: "nope" }, 502)) as unknown as typeof fetch),
      () => (vi.fn(async () => respond({ nonsense: true })) as unknown as typeof fetch),
      () => (vi.fn(async () => respond(readyBody({ ready: false, reasons: ["loop-wedged"] }), 503)) as unknown as typeof fetch),
      () => (vi.fn(async () => respond(readyBody({ checkedAt: new Date(NOW - PRICER_FRESH_MS - 1).toISOString() }))) as unknown as typeof fetch),
    ];
    for (const make of failures) {
      resetPricerCache();
      const status = await readPricerStatus(make(), NOW);
      expect(status.healthy).toBe(false);
      expect(status.reason).not.toBe("ready");
    }
  });
});
