import { describe, expect, it } from "vitest";
import { PricingClient } from "../../lib/v2/pricing";

const input = { ticker: "NVDA", strike: 231_000_000n, expiry: 1_790_020_800, isPut: false };
const money = (raw: string) => ({ raw, decimals: 6, formatted: raw });

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
});
