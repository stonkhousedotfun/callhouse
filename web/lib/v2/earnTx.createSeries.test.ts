/**
 * (measured on a v9 fork): the Earn custom-strike ask granted the order book operator flag, then
 * createSeries reverted BadStrike for a strike outside half-to-double spot, and the copy said "on the tick". preflightAsk
 * now checks createSeries's own refusals for a NEW series before any write, on the chain's clock:
 * CreatePaused, the expiry window (1 hour to 45 days), and the strike band against the oracle's trySpot.
 */
import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";

import { MAX_TENOR_SECONDS, MIN_SERIES_LEAD_SECONDS, STRIKE_BAND_FACTOR, preflightAsk, strikeInBand } from "./earnTx";
import { V2_ERROR_TEXT } from "./errors";
import { TRADING_PAUSED_LINE } from "./tradingGate";

const account = "0x0000000000000000000000000000000000000044";
const underlying = "0x0000000000000000000000000000000000000055";
const oracle = "0x0000000000000000000000000000000000000099";

vi.mock("./config", () => ({
  V2_DEPLOYMENT: { contracts: { orderBook: "0x0000000000000000000000000000000000000022" } },
  requireV2Address: (key: string) => ({ clearinghouse: "0x0000000000000000000000000000000000000011",
    orderBook: "0x0000000000000000000000000000000000000022",
    expiryCalendar: "0x0000000000000000000000000000000000000033" })[key as "clearinghouse" | "orderBook" | "expiryCalendar"],
}));

/** A chain at `now` (seconds). Enough free collateral for any test size; spot $200 unless told otherwise. */
function chain(now: number, options: { exists?: boolean; paused?: boolean; spot?: readonly [boolean, bigint] | "revert"; tradingPaused?: boolean;
  enabled?: boolean; mintPaused?: boolean; validExpiry?: boolean; mintCutoff?: number } = {}) {
  const readContract = vi.fn(async ({ functionName }: { functionName: string; address?: string }) => {
    switch (functionName) {
      case "market": return { enabled: options.enabled ?? true, mintPaused: options.mintPaused ?? false, strikeTick: 1_000_000n, mintFeePpm: 0, oracle };
      case "isValidExpiry": return options.validExpiry ?? true;
      case "isOperator": return true;
      case "free": return 10n ** 30n;
      case "feeParams": return { premiumFeeBps: 500 };
      case "longIdOf": return 42n;
      case "seriesExists": return options.exists ?? false;
      case "mintFee": return 0n;
      case "mintCutoff": return options.mintCutoff ?? now + 86_400;
      case "createPaused": return options.paused ?? false;
      case "tradingPaused": return options.tradingPaused ?? false;
      case "trySpot": {
        if (options.spot === "revert") throw new Error("execution reverted");
        const [ok, price] = options.spot ?? [true, 200_000_000n];
        return [ok, price, BigInt(now)];
      }
      default: throw new Error(`unexpected ${functionName}`);
    }
  });
  return { readContract, getBlock: vi.fn(async () => ({ number: 123n, timestamp: BigInt(now) })) } as unknown as
    PublicClient & { readContract: typeof readContract };
}

const NOW = 1_790_000_000;
const DAY = 86_400;
const ask = (client: PublicClient, strike: bigint, expiry = NOW + DAY) =>
  preflightAsk(account, underlying, false, strike, expiry, 100n, 500, client);

describe("strike band (createSeries's trySpot block)", () => {
  it("names the band once: factor 2, as Clearinghouse.createSeries writes it", () => {
    expect(STRIKE_BAND_FACTOR).toBe(2n);
    expect(strikeInBand(100_000_000n, { ok: true, price: 200_000_000n })).toBe(true); // spot / 2, inclusive
    expect(strikeInBand(99_000_000n, { ok: true, price: 200_000_000n })).toBe(false);
    expect(strikeInBand(400_000_000n, { ok: true, price: 200_000_000n })).toBe(true); // spot x 2, inclusive
    expect(strikeInBand(401_000_000n, { ok: true, price: 200_000_000n })).toBe(false);
  });

  it("no test when the oracle cannot answer, as the contract skips it: not ok, zero spot, or a revert", () => {
    expect(strikeInBand(1n, { ok: false, price: 200_000_000n })).toBe(true);
    expect(strikeInBand(1n, { ok: true, price: 0n })).toBe(true);
    expect(strikeInBand(1n, null)).toBe(true);
  });

  it("a spot beyond uint128 has no upper bound (the contract's overflow guard), and still a lower one", () => {
    const huge = 1n << 128n;
    expect(strikeInBand(huge * 3n, { ok: true, price: huge })).toBe(true);
    expect(strikeInBand(huge / 2n - 1n, { ok: true, price: huge })).toBe(false);
  });

  it("refuses a new series above double spot before any write, naming the band in USDG", async () => {
    const client = chain(NOW);
    await expect(ask(client, 401_000_000n)).rejects.toThrow(
      "Choose a strike between half and double the current price: 100 to 400 USDG.");
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "trySpot", address: oracle,
      args: [underlying], blockNumber: 123n }));
  });

  it("the chain's own BadStrike copy names the band too (a revert that gets past the preflight, or another caller)", () => {
    expect(V2_ERROR_TEXT.BadStrike).toBe("Choose a strike on the market's strike tick, between half and double the current price.");
  });

  it("refuses a new series below half spot", async () => {
    await expect(ask(chain(NOW), 99_000_000n)).rejects.toThrow(/between half and double the current price/);
  });

  it("control: a strike inside the band passes", async () => {
    await expect(ask(chain(NOW), 250_000_000n)).resolves.toMatchObject({ exists: false, now: NOW });
  });

  it("a reverting trySpot is skipped, as the contract's catch skips it", async () => {
    await expect(ask(chain(NOW, { spot: "revert" }), 900_000_000n)).resolves.toMatchObject({ exists: false });
    await expect(ask(chain(NOW, { spot: [false, 200_000_000n] }), 900_000_000n)).resolves.toMatchObject({ exists: false });
  });

  it("an EXISTING series skips every createSeries check (createSeries returns its id early)", async () => {
    const client = chain(NOW, { exists: true, paused: true });
    await expect(ask(client, 900_000_000n, NOW + 60 * DAY)).resolves.toMatchObject({ exists: true });
    const names = client.readContract.mock.calls.map(([request]) => request.functionName);
    expect(names).not.toContain("createPaused");
    expect(names).not.toContain("trySpot");
  });
});

describe("expiry window and create pause", () => {
  it("names the window once, as V2Constants: MIN_SERIES_LEAD 1 hour, MAX_TENOR 45 days", () => {
    expect(MIN_SERIES_LEAD_SECONDS).toBe(3_600);
    expect(MAX_TENOR_SECONDS).toBe(45 * DAY);
  });

  it("refuses an expiry under an hour away and one over 45 days away; the edges pass", async () => {
    const message = "Choose an expiry at least 1 hour and at most 45 days away.";
    await expect(ask(chain(NOW), 200_000_000n, NOW + 3_599)).rejects.toThrow(message);
    await expect(ask(chain(NOW), 200_000_000n, NOW + 45 * DAY + 1)).rejects.toThrow(message);
    await expect(ask(chain(NOW), 200_000_000n, NOW + 3_600)).resolves.toMatchObject({ exists: false });
    await expect(ask(chain(NOW), 200_000_000n, NOW + 45 * DAY)).resolves.toMatchObject({ exists: false });
  });

  it("refuses while series creation is paused, with the CreatePaused copy", async () => {
    await expect(ask(chain(NOW, { paused: true }), 200_000_000n)).rejects.toThrow(V2_ERROR_TEXT.CreatePaused);
  });
});

describe("the chain's clock, not the browser's", () => {
  it("judges 'future expiry' on the block timestamp: a browser clock far behind cannot pass a past expiry", async () => {
    vi.useFakeTimers({ now: (NOW - 30 * DAY) * 1000, toFake: ["Date"] });
    try {
      await expect(ask(chain(NOW), 200_000_000n, NOW - 1)).rejects.toThrow("Choose a future expiry");
    } finally { vi.useRealTimers(); }
  });

  it("a browser clock far ahead does not refuse an expiry the chain still has ahead of it", async () => {
    vi.useFakeTimers({ now: (NOW + 30 * DAY) * 1000, toFake: ["Date"] });
    try {
      await expect(ask(chain(NOW), 200_000_000n, NOW + DAY)).resolves.toMatchObject({ now: NOW });
    } finally { vi.useRealTimers(); }
  });

  it("returns the preflight block's timestamp for the ask's validUntil", async () => {
    await expect(ask(chain(NOW + 17), 200_000_000n, NOW + DAY)).resolves.toMatchObject({ now: NOW + 17 });
  });
});

describe("OrderBook.place reverts TradingPaused (_whenTrading)", () => {
  // The refusal carries the brake's FULL line (what is paused, what still works), not the short decoded-revert
  // text. `toThrow(string)` matches a substring, so the message is compared whole.
  it("refuses the ask while the book's brake is on, read at the preflight block, before the operator grant or createSeries", async () => {
    const client = chain(NOW, { tradingPaused: true });
    await expect(ask(client, 200_000_000n)).rejects.toHaveProperty("message", TRADING_PAUSED_LINE);
    expect(TRADING_PAUSED_LINE).not.toBe(V2_ERROR_TEXT.TradingPaused);
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "tradingPaused",
      address: "0x0000000000000000000000000000000000000022", blockNumber: 123n }));
    // Refused on the brake alone: none of createSeries's own reads ran.
    const names = client.readContract.mock.calls.map(([request]) => request.functionName);
    expect(names).not.toContain("createPaused");
  });

  it("control: the same ask passes with the brake off", async () => {
    await expect(ask(chain(NOW, { tradingPaused: false }), 200_000_000n)).resolves.toMatchObject({ exists: false });
  });
});

describe("the ask preflight's other mirrors, pinned", () => {
  it("MATCH, with a stated margin: an existing series' ask shuts 60 s before Clearinghouse.mintCutoff (mint and the AskWrite place refuse PastCutoff at block.timestamp >= expiry - SETTLEMENT_WINDOW); a slow wallet must not land after it", async () => {
    await expect(ask(chain(NOW, { exists: true, mintCutoff: NOW + 60 }), 200_000_000n)).rejects.toThrow("This series is past its writing cutoff.");
    await expect(ask(chain(NOW, { exists: true, mintCutoff: NOW }), 200_000_000n)).rejects.toThrow("This series is past its writing cutoff.");
    await expect(ask(chain(NOW, { exists: true, mintCutoff: NOW + 61 }), 200_000_000n)).resolves.toMatchObject({ exists: true, mintCutoff: NOW + 61 });
  });

  it("MATCH: createSeries's calendar test (BadExpiry) and strike tick (BadStrike) refuse before any write", async () => {
    const message = "Choose a calendar expiry and a strike on the market tick.";
    await expect(ask(chain(NOW, { validExpiry: false }), 200_000_000n)).rejects.toThrow(message);
    await expect(ask(chain(NOW), 200_500_000n)).rejects.toThrow(message); // tick is 1 USDG
  });

  it("MATCH for a disabled market (createSeries and mint refuse MarketDisabled); STRICTER on purpose for a mint pause: place accepts the ask, but the take skips it (plan.mintOpen), so it could never fill", async () => {
    await expect(ask(chain(NOW, { enabled: false }), 200_000_000n)).rejects.toThrow("Writing is paused for this market.");
    await expect(ask(chain(NOW, { mintPaused: true }), 200_000_000n)).rejects.toThrow("Writing is paused for this market.");
  });
});
