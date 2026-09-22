import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// T-OP-120: vitest.config.ts collects lib/** and components/** only, so the scenario route's own test file (the
// design's fence names web/app/api/pnl/scenario/image/route.test.ts) is registered here, the collected neighbour
// of the route it covers. Its suites appear under this file's name; nothing else about them changes.
import "../../app/api/pnl/scenario/image/route.test";

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname,
  "../../../ops/fixtures/api/v2/pnl/87928758254318692721909164101369622513960639781458875980445111726519827316414-0x4088c59Eb3fB713B124f182E7083AEb3358A030B.json"), "utf8"));

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function image(id: string, format: string) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("fonts.googleapis.com")) return new Response("", { status: 200 });
    if (url.includes("/v2/pnl/missing-id")) return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "missing" } }), { status: 404 });
    if (url.includes("/v2/pnl/")) return new Response(JSON.stringify(fixture), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error(`unexpected image test fetch ${url}`);
  }));
  vi.resetModules();
  const { GET } = await import("../../app/api/pnl/[id]/image/route");
  const response = await GET(new Request(`https://app.stonkhouse.fun/api/pnl/${id}/image?format=${format}`),
    { params: Promise.resolve({ id }) });
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { response, bytes };
}

function pngSize(bytes: Uint8Array) {
  expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe("PNL image route", () => {
  it("renders the share PNG at 1080 square with substantial image bytes", async () => {
    const { response, bytes } = await image(fixture.id, "square");
    expect(response.headers.get("content-type")).toContain("image/png");
    expect(pngSize(bytes)).toEqual({ width: 1080, height: 1080 });
    expect(bytes.byteLength).toBeGreaterThan(10_000);
  }, 30_000);

  it("renders a neutral 1200x630 PNG for an unknown ID", async () => {
    const { bytes } = await image("missing-id", "wide");
    expect(pngSize(bytes)).toEqual({ width: 1200, height: 630 });
    expect(bytes.byteLength).toBeGreaterThan(10_000);
  }, 30_000);
});

/**
 * T-OP-120 (design §2.8). The scenario card: the same layout as a settled outcome, watermarked "Scenario, not a
 * fill", every figure recomputed from the position and the ticket's cost by the slider's own math. The query is
 * data, never trusted as a result: a malformed or out-of-range input renders the neutral brand card.
 */
describe("scenario share card", () => {
  const example = new URLSearchParams({ ticker: "NVDA", side: "call", strike: "230000000", units: "300", fee: "25",
    cost: "12499900", price: "240000000", expiry: "1790200800" });

  it("parses the explorer's query into a position and defaults the conversion terms to the contract ceilings", async () => {
    const { parseScenario } = await import("./PnlImage");
    expect(parseScenario(example)).toEqual({
      ticker: "NVDA", position: { isPut: false, strike: 230_000_000n, units: 300n, exerciseFeeBps: 25 },
      cost: 12_499_900n, price: 240_000_000n, expiry: 1_790_200_800, slippageBps: 300, routeFeeBps: 100,
    });
    const wired = new URLSearchParams(example);
    wired.set("slippage", "150"); wired.set("routeFee", "30"); wired.set("side", "put"); wired.set("ticker", "nvda");
    expect(parseScenario(wired)).toMatchObject({ ticker: "NVDA", position: { isPut: true }, slippageBps: 150, routeFeeBps: 30 });
  });

  it("refuses every input the contracts would refuse, and every malformed one", async () => {
    const { parseScenario } = await import("./PnlImage");
    const broken: [string, string][] = [
      ["side", "sell"], ["ticker", "nvda!"], ["ticker", ""], ["strike", "0"], ["strike", "-1"], ["strike", "1.5"], ["units", "0"],
      ["units", "1e3"], ["cost", "abc"], ["price", "0x10"], ["expiry", "0"], ["expiry", "4102444801"],
      // EXERCISE_FEE_CEIL_BPS = 200, MAX_PAYOUT_SLIPPAGE_CEIL_BPS = 300, MAX_ROUTE_FEE_BPS = 100 (V2Constants.sol:77, :88, :91 at ee14bfbc).
      ["fee", "201"], ["slippage", "301"], ["routeFee", "101"],
    ];
    for (const [key, value] of broken) {
      const query = new URLSearchParams(example);
      query.set(key, value);
      expect(parseScenario(query), `${key}=${value}`).toBeNull();
    }
    for (const key of ["ticker", "side", "strike", "units", "fee", "cost", "price", "expiry"]) {
      const query = new URLSearchParams(example);
      query.delete(key);
      expect(parseScenario(query), `missing ${key}`).toBeNull();
    }
    // Zero cost is a valid (free) ticket; the card then shows no multiple.
    const free = new URLSearchParams(example);
    free.set("cost", "0");
    expect(parseScenario(free)?.cost).toBe(0n);
  });

  it("writes the design example as a watermarked scenario, not an outcome", async () => {
    const { SCENARIO_WATERMARK, parseScenario, scenarioImageCopy } = await import("./PnlImage");
    const copy = scenarioImageCopy(parseScenario(example)!);
    expect(SCENARIO_WATERMARK).toBe("Scenario, not a fill");
    expect(copy).toEqual({
      eyebrow: "Scenario, not a fill",
      metric: "+14.85 to +15.69 USDG",
      headline: "If NVDA ends at $240.00 by Sep 23, 2026",
      detail: "NVDA $230.00 call · 2.18× to 2.25× on a 12.50 USDG buy",
      risk: "Max loss 12.50 USDG · scenario, not a fill",
    });
    const put = new URLSearchParams(example);
    put.set("side", "put"); put.set("price", "220000000");
    expect(scenarioImageCopy(parseScenario(put)!)).toMatchObject({ metric: "+15.77 USDG", detail: "NVDA $230.00 put · 2.26× on a 12.50 USDG buy" });
    const free = new URLSearchParams(example);
    free.set("cost", "0");
    expect(scenarioImageCopy(parseScenario(free)!)).toMatchObject({ metric: "+27.35 to +28.19 USDG", detail: "NVDA $230.00 call · — on a 0.00 USDG buy" });
  });
});
