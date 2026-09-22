import { describe, expect, it } from "vitest";
import { V2_REGISTRY } from "../../lib/v2/marketRegistry.generated";
import { PricingClient, type PricingProvenance } from "../../lib/v2/pricing";

const market = V2_REGISTRY.markets.find((entry) => entry.ticker === "NVDA")!;
const input = { ticker: "NVDA", underlying: market.underlying,
  strike: 231_000_000n, expiry: 1_790_020_800, isPut: false };
const money = (raw: string) => ({ raw, decimals: 6, formatted: raw });
const provenance = (overrides: Partial<PricingProvenance> = {}): PricingProvenance => ({
  contract: "O3-307/1",
  provider: "listed-live",
  providerProduct: "quotes",
  method: "listed",
  methodDetail: "listed-contract",
  contributingExpiries: [input.expiry],
  identity: {
    market: "NVDA",
    issuer: null,
    token: { chainId: V2_REGISTRY.chainId, address: market.underlying, uiMultiplier: market.uiMultiplier },
    option: { side: "call", strike: money("231000000"), expiry: input.expiry,
      timeZone: "America/New_York", exercise: "european", payoff: "cash-value", settlement: "oracle-twap" },
    listed: [{ providerInstrumentId: "NVDA260920C00231000", root: "NVDA", side: "call", strike: "231",
      expiry: input.expiry, multiplier: 100, exercise: "american", settlement: "physical" }],
  },
  observations: {
    listedQuotes: [{ providerInstrumentId: "NVDA260920C00231000", bid: "2.4", ask: "2.6",
      bidSize: "10", askSize: "12", currency: "USD", observedAt: 190 }],
    vendorTheoretical: [],
  },
  clocks: { quoteObservedAt: 190, tradeObservedAt: null, underlyingObservedAt: 180,
    volatilityObservedAt: null, publishedAt: 195, receivedAt: 198, computedAt: 200 },
  ages: { quoteS: 10, tradeS: null, underlyingS: 20, volatilityS: null },
  entitlement: { class: "real-time", declaredDelayS: 0, rightsRef: "test" },
  expiryClock: { expiry: input.expiry, timeZone: "America/New_York", basis: "trading-time", yearsToExpiry: 0.2 },
  quality: { readiness: "ready", reasons: [], uncertainty: null, disagreement: null, fallback: null },
  pricedSpot: money("215500000"),
  ...overrides,
});

describe("pricing service client", () => {
  it("caches fair and surface spot separately for 30 seconds and coalesces concurrent requests", async () => {
    let now = 1_000;
    const paths: string[] = [];
    const fetcher = async (request: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(request));
      paths.push(url.pathname);
      return Response.json(url.pathname === "/fair"
        ? { fair: money("250000"), spot: money("215500000"), iv: 0.3, delta: 0.2, source: "cboe", asOf: 123 }
        : { spot: money("216000000") });
    };
    const client = new PricingClient({ url: "http://127.0.0.1:8790", fetcher: fetcher as typeof fetch, now: () => now });
    const [one, two] = await Promise.all([client.fair(input), client.fair(input)]);
    expect(one).toEqual(two);
    expect(one?.fair).toBe(250_000n);
    expect(one?.asOf).toBe(123);
    expect(await client.spot("nvda")).toBe(216_000_000n);
    expect(paths).toEqual(["/fair", "/surface/NVDA"]);
    now += 30_001;
    await client.fair(input);
    expect(paths).toEqual(["/fair", "/surface/NVDA", "/fair"]);
  });

  it("returns null for outage and malformed data without throwing, then retries", async () => {
    let now = 1_000;
    let calls = 0;
    const client = new PricingClient({ url: "http://127.0.0.1", now: () => now, fetcher: (async () => {
      calls++;
      if (calls === 1) throw Error("down");
      return Response.json({ fair: null, reason: "chain-stale" });
    }) as typeof fetch });
    expect(await client.fair(input)).toBeNull();
    expect(await client.fair(input)).toBeNull();
    expect(calls).toBe(1);
    now += 5_001;
    expect(await client.fair(input)).toBeNull();
    expect(calls).toBe(2);
    expect(await new PricingClient().spot("NVDA")).toBeNull();
  });

  it.each([[404, "unknown-ticker"], [500, "internal-error"]] as const)(
    "retains a %s pricing refusal reason", async (status, reason) => {
      const client = new PricingClient({ url: "http://127.0.0.1", fetcher: (async () =>
        Response.json({ fair: null, reason }, { status })) as typeof fetch });
      expect(await client.fairResult(input)).toEqual({ quote: null, reasonCode: reason, provenance: null });
    });

  it("retains optional provenance, zero fair and one shared pending/cache entry", async () => {
    let calls = 0;
    const p = provenance();
    const client = new PricingClient({ url: "http://127.0.0.1", fetcher: (async () => {
      calls++;
      return Response.json({ fair: money("0"), spot: money("215500000"), iv: 0.3, delta: 0,
        source: "model", asOf: 190, provenance: p });
    }) as typeof fetch });

    const [quote, result] = await Promise.all([client.fair(input), client.fairResult(input)]);
    expect(calls).toBe(1);
    expect(quote?.fair).toBe(0n);
    expect(result.quote?.fair).toBe(0n);
    expect(result.provenance).toEqual(p);
    expect(result.reasonCode).toBeNull();
  });

  it("keeps refusal reason/provenance and corrects a false Cboe label without inventing entitlement", async () => {
    let calls = 0;
    const unavailable = provenance({
      provider: "backup-delayed",
      method: "external-indicative",
      observations: { listedQuotes: [], vendorTheoretical: [{ product: "fmv", value: "2.5", iv: 0.3,
        currency: "USD", observedAt: 190 }] },
      entitlement: { class: "delayed", declaredDelayS: 900, rightsRef: null },
      quality: { readiness: "unavailable", reasons: ["fallback-provider", "chain-unavailable"],
        uncertainty: null, disagreement: null, fallback: { from: "primary", to: "backup-delayed", reason: "outage" } },
    });
    const bodies = [
      { fair: null, reason: "chain-unavailable", provenance: unavailable },
      { fair: money("250000"), spot: money("215500000"), iv: 0.3, delta: 0.2,
        source: "cboe", asOf: 190, provenance: { ...provenance({ provider: "cboe-delayed", method: "extrapolated",
          quality: { readiness: "degraded", reasons: ["extrapolated"], uncertainty: null,
            disagreement: null, fallback: null } }) } },
    ];
    let now = 1_000;
    const client = new PricingClient({ url: "http://127.0.0.1", now: () => now, fetcher: (async () =>
      Response.json(bodies[calls++]!)) as typeof fetch });

    const failed = await client.fairResult(input);
    expect(failed).toEqual({ quote: null, reasonCode: "chain-unavailable", provenance: unavailable });
    expect(await client.fair(input)).toBeNull();
    expect(calls).toBe(1);
    now += 5_001;
    const recovered = await client.fairResult(input);
    expect(recovered.quote?.source).toBe("model");
    expect(recovered.provenance?.entitlement.class).toBe("real-time");
  });

  it("preserves provenance absence but fails closed on present-invalid or mismatched provenance", async () => {
    const legacy = new PricingClient({ url: "http://127.0.0.1", fetcher: (async () => Response.json({
      fair: money("250000"), spot: money("215500000"), iv: 0.3, delta: 0.2,
      source: "cboe", asOf: 190,
    })) as typeof fetch });
    expect((await legacy.fairResult(input)).quote?.source).toBe("cboe");
    const legacyUnknown = new PricingClient({ url: "http://127.0.0.1", fetcher: (async () => Response.json({
      fair: money("250000"), spot: money("215500000"), iv: 0.3, delta: 0.2,
      source: "cboe", asOf: 190,
    })) as typeof fetch });
    expect((await legacyUnknown.fairResult({ ...input, ticker: "TEST",
      underlying: "0x0000000000000000000000000000000000000011" })).quote?.source).toBe("cboe");

    const p = provenance();
    const wrongAddress = "0x0000000000000000000000000000000000000012";
    const invalid = [
      { contract: "wrong" },
      { ...p, identity: { ...p.identity, market: "TSLA" } },
      { ...p, identity: { ...p.identity, token: { ...p.identity.token, chainId: 1 } } },
      { ...p, identity: { ...p.identity, token: { ...p.identity.token, address: wrongAddress } } },
      { ...p, identity: { ...p.identity, option: { ...p.identity.option, side: "put" } } },
      { ...p, identity: { ...p.identity, option: { ...p.identity.option, strike: money("232000000") } } },
      { ...p, identity: { ...p.identity, option: { ...p.identity.option, expiry: input.expiry + 1 } },
        expiryClock: { ...p.expiryClock, expiry: input.expiry + 1 } },
      { ...p, pricedSpot: null },
      { ...p, pricedSpot: money("215500001") },
      { ...p, quality: { ...p.quality, readiness: "unavailable", reasons: ["chain-unavailable"] } },
      { ...p, identity: { ...p.identity, listed: [] },
        observations: { listedQuotes: [], vendorTheoretical: [{ product: "fmv", value: "2.5", iv: 0.3,
          currency: "USD", observedAt: 190 }] } },
      { ...p, identity: { ...p.identity, listed: [{ ...p.identity.listed[0]!, root: "TSLA" }] } },
      { ...p, identity: { ...p.identity, listed: [{ ...p.identity.listed[0]!, multiplier: 150 }] } },
      { ...p, observations: { ...p.observations, listedQuotes: [{ ...p.observations.listedQuotes[0]!,
        bid: "invalid" }] } },
      { ...p, observations: { ...p.observations, listedQuotes: [{ ...p.observations.listedQuotes[0]!,
        bid: "0" }] } },
      { ...p, observations: { ...p.observations, listedQuotes: [{ ...p.observations.listedQuotes[0]!,
        bid: "2.7", ask: "2.6" }] } },
      { ...p, observations: { ...p.observations, listedQuotes: [{ ...p.observations.listedQuotes[0]!,
        bid: "1.0000000000000001", ask: "1.0000000000000000" }] } },
      { ...p, observations: { ...p.observations, listedQuotes: [{ ...p.observations.listedQuotes[0]!,
        providerInstrumentId: "OTHER" }] } },
    ];
    for (const bad of invalid) {
      const client = new PricingClient({ url: "http://127.0.0.1", fetcher: (async () => Response.json({
        fair: money("250000"), spot: money("215500000"), iv: 0.3, delta: 0.2,
        source: "cboe", asOf: 190, provenance: bad,
      })) as typeof fetch });
      expect(await client.fairResult(input)).toEqual({ quote: null, reasonCode: null, provenance: null });
    }
  });

  it("binds known token multiplier identity to the generated registry snapshot", async () => {
    const canonicalInput = { ...input, ticker: "NVDA", underlying: market.underlying };
    const base = provenance();
    const providerInstrumentId = "NVDA260920C00231000";
    const canonical = provenance({
      identity: { ...base.identity, market: "NVDA",
        token: { chainId: V2_REGISTRY.chainId, address: market.underlying, uiMultiplier: market.uiMultiplier },
        listed: [{ ...base.identity.listed[0]!, providerInstrumentId, root: "NVDA",
          expiry: null, multiplier: null }] },
      observations: { ...base.observations,
        listedQuotes: [{ ...base.observations.listedQuotes[0]!, providerInstrumentId }] },
    });
    const response = (p: PricingProvenance) => Response.json({
      fair: money("250000"), spot: money("215500000"), iv: 0.3, delta: 0.2,
      source: "model", asOf: 190, provenance: p,
    });
    const accepted = new PricingClient({ url: "http://127.0.0.1", fetcher: (async () =>
      response(canonical)) as typeof fetch });
    expect((await accepted.fairResult(canonicalInput)).quote?.fair).toBe(250_000n);

    for (const token of [
      { ...canonical.identity.token, chainId: 1 },
      { ...canonical.identity.token, uiMultiplier: null },
      { ...canonical.identity.token, uiMultiplier: "1000000000000000000" },
    ]) {
      const client = new PricingClient({ url: "http://127.0.0.1", fetcher: (async () =>
        response({ ...canonical, identity: { ...canonical.identity, token } })) as typeof fetch });
      expect(await client.fairResult(canonicalInput)).toEqual({ quote: null, reasonCode: null, provenance: null });
    }

    const wrongUnderlying = "0x0000000000000000000000000000000000000011";
    const wrongSeries = { ...canonicalInput, underlying: wrongUnderlying };
    const wrongAddress = { ...canonical, identity: { ...canonical.identity,
      token: { ...canonical.identity.token, address: wrongUnderlying } } };
    const client = new PricingClient({ url: "http://127.0.0.1", fetcher: (async () =>
      response(wrongAddress)) as typeof fetch });
    expect(await client.fairResult(wrongSeries)).toEqual({ quote: null, reasonCode: null, provenance: null });

    const unknownInput = { ...input, ticker: "TEST", underlying: wrongUnderlying };
    const unknown = { ...canonical, identity: { ...canonical.identity, market: "TEST",
      token: { ...canonical.identity.token, address: wrongUnderlying, uiMultiplier: null } } };
    const unknownClient = new PricingClient({ url: "http://127.0.0.1", fetcher: (async () =>
      response(unknown)) as typeof fetch });
    expect(await unknownClient.fairResult(unknownInput)).toEqual({ quote: null, reasonCode: null, provenance: null });
  });
});
