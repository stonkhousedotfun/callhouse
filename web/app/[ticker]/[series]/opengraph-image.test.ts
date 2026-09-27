/**
 * The market page's share card route (./opengraph-image.tsx). It asks the API only for a known v2 ticker, a series
 * segment that parses (a positive even long id, or a c-/p- alias), and a market that is live; every other case, and a
 * failed API call, renders the neutral card rather than an error. The lines themselves are ./seriesImage's own tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isV2Live } from "@/lib/markets";
import { v2Api } from "@/lib/v2/api";
import OpengraphImage, { contentType, runtime, size } from "./opengraph-image";
import { renderSeriesImage, seriesImageLines } from "./seriesImage";

vi.mock("./seriesImage", () => ({
  renderSeriesImage: vi.fn((lines: unknown) => ({ image: lines })),
  neutralSeriesImageLines: vi.fn(() => "NEUTRAL"),
  seriesImageLines: vi.fn((s: { longId: string }) => `SERIES ${s.longId}`),
}));
vi.mock("@/lib/v2/api", () => ({ v2Api: { getSeries: vi.fn() } }));
vi.mock("@/lib/markets", async (orig) => ({ ...(await orig<typeof import("@/lib/markets")>()), isV2Live: vi.fn() }));

const card = (ticker: string, series: string) => OpengraphImage({ params: Promise.resolve({ ticker, series }) });

beforeEach(() => {
  vi.mocked(isV2Live).mockReturnValue(true);
  vi.mocked(v2Api.getSeries).mockReset();
  vi.mocked(v2Api.getSeries).mockImplementation(async (id: string) => ({ series: { longId: id } }) as never);
  vi.mocked(renderSeriesImage).mockClear();
});

describe("[ticker]/[series]/opengraph-image", () => {
  it("is a 1200x630 PNG on the node runtime", () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe("image/png");
    expect(runtime).toBe("nodejs");
  });

  it("a live market and a valid long id: that series' lines", async () => {
    expect(await card("nvda", "4")).toEqual({ image: "SERIES 4" });
    expect(v2Api.getSeries).toHaveBeenCalledWith("4");
    expect(seriesImageLines).toHaveBeenCalledWith({ longId: "4" });
  });

  it("a readable alias resolves to its canonical long id before the API is asked", async () => {
    await card("nvda", "c-210-2026-10-16");
    const id = vi.mocked(v2Api.getSeries).mock.calls[0]![0];
    expect(id).toMatch(/^\d+$/);
    expect(BigInt(id) % 2n).toBe(0n);
  });

  it("unknown or uppercase ticker, odd/zero/garbage series, or a market not live: neutral, and no API call", async () => {
    const bad: Array<[string, string]> = [["zzzz", "4"], ["NVDA", "4"], ["nvda", "3"], ["nvda", "0"], ["nvda", "c-210-2026-02-30"], ["nvda", "x"]];
    for (const [t, s] of bad) expect(await card(t, s), `${t}/${s}`).toEqual({ image: "NEUTRAL" });
    vi.mocked(isV2Live).mockReturnValue(false);
    expect(await card("nvda", "4")).toEqual({ image: "NEUTRAL" });
    expect(v2Api.getSeries).not.toHaveBeenCalled();
  });

  it("a failed API call: neutral, not an error", async () => {
    vi.mocked(v2Api.getSeries).mockRejectedValue(new Error("404"));
    expect(await card("nvda", "4")).toEqual({ image: "NEUTRAL" });
  });
});
