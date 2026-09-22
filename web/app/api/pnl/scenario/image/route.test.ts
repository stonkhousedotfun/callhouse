import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * T-OP-120 (design §2.8). The scenario image route: a PNG at the share sizes for a valid query, the neutral brand
 * card for a malformed one, and never a 500 for a query that passes the shape check but not the arithmetic.
 * Fonts are stubbed out (the renderer falls back to sans-serif), so the bytes prove layout, not typography.
 */
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

const example = "ticker=NVDA&side=call&strike=230000000&units=300&fee=25&cost=12499900&price=240000000&expiry=1790200800";

async function image(query: string) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("fonts.googleapis.com")) return new Response("", { status: 200 });
    throw new Error(`unexpected scenario image fetch ${url}`);
  }));
  vi.resetModules();
  const { GET } = await import("./route");
  const response = await GET(new Request(`https://app.stonkhouse.fun/api/pnl/scenario/image?${query}`));
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { response, bytes };
}

function pngSize(bytes: Uint8Array) {
  expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe("scenario image route", () => {
  it("renders the design example at 1080 square", async () => {
    const { response, bytes } = await image(`${example}&format=square`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    expect(pngSize(bytes)).toEqual({ width: 1080, height: 1080 });
    expect(bytes.byteLength).toBeGreaterThan(10_000);
  }, 30_000);

  it("defaults to the 1200x630 wide card and renders the neutral card for a malformed query", async () => {
    const wide = await image(example);
    expect(pngSize(wide.bytes)).toEqual({ width: 1200, height: 630 });
    const neutral = await image("ticker=NVDA&side=call&strike=0");
    expect(neutral.response.status).toBe(200);
    expect(pngSize(neutral.bytes)).toEqual({ width: 1200, height: 630 });
    expect(neutral.bytes.byteLength).toBeGreaterThan(10_000);
  }, 30_000);

  it("answers 200 for a query the shape check passes but the arithmetic refuses", async () => {
    // cost 1 base unit against a payout of 10^30 units: the percentage overflows what pnlAt will display (RangeError).
    const query = `${example.replace("cost=12499900", "cost=1").replace("units=300", `units=${"9".repeat(30)}`)}`;
    // Positive control: the copy builder itself refuses this query, so the route's 200 is the guard, not luck.
    const { parseScenario, scenarioImageCopy } = await import("../../../../../components/v2/PnlImage");
    const scenario = parseScenario(new URLSearchParams(query));
    expect(scenario).not.toBeNull();
    expect(() => scenarioImageCopy(scenario!)).toThrow(RangeError);
    const { response, bytes } = await image(query);
    expect(response.status).toBe(200);
    expect(pngSize(bytes)).toEqual({ width: 1200, height: 630 });
  }, 30_000);

  it("is a dynamic node route", async () => {
    const route = await import("./route");
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
  });
});
