/**
 * The app's share card (app/opengraph-image.tsx). v1: the v1 brand lines, no API call. v2: the live hero card's lines
 * when the API has one; the price-free brand card when it has none or the call fails (that card carries no
 * price, so it needs no "example" label).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderBrandImage } from "@/components/v2/PnlImage";
import { liveOptionImageLines } from "@/components/v2/PnlText";
import { v2Api } from "@/lib/v2/api";
import OpengraphImage, { alt, contentType, runtime, size } from "./opengraph-image";

vi.mock("@/components/v2/PnlImage", () => ({ renderBrandImage: vi.fn((lines: unknown) => ({ image: lines })) }));
vi.mock("@/components/v2/PnlText", () => ({ liveOptionImageLines: vi.fn((card: { id: string }) => ({ fromCard: card.id })) }));
vi.mock("@/lib/v2/api", () => ({ v2Api: { getHeroCard: vi.fn() } }));

const FALLBACK = { eyebrow: "StonkHouse", metric: "Buy an outcome", headline: "Know your maximum loss",
  detail: "Stock Token options on Robinhood Chain", risk: "Live prices in the app" };

beforeEach(() => {
  vi.mocked(renderBrandImage).mockClear();
  vi.mocked(v2Api.getHeroCard).mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("app/opengraph-image", () => {
  it("is a 1200x630 PNG rendered on the node runtime", () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe("image/png");
    expect(runtime).toBe("nodejs");
    expect(alt).toContain("known maximum loss");
  });

  it("v1: the v1 brand card, and no API call", async () => {
    vi.stubEnv("NEXT_PUBLIC_V2", "");
    await OpengraphImage();
    expect(renderBrandImage).toHaveBeenCalledWith(expect.objectContaining({ metric: "Stock Tokens", headline: "Let your stonks work for you" }));
    expect(v2Api.getHeroCard).not.toHaveBeenCalled();
  });

  it("v2 with a hero card: that card's lines", async () => {
    vi.stubEnv("NEXT_PUBLIC_V2", "1");
    vi.mocked(v2Api.getHeroCard).mockResolvedValue({ card: { id: "c1" } } as never);
    expect(await OpengraphImage()).toEqual({ image: { fromCard: "c1" } });
    expect(liveOptionImageLines).toHaveBeenCalledWith({ id: "c1" });
  });

  it("v2 with no card, or a failed call: the price-free fallback", async () => {
    vi.stubEnv("NEXT_PUBLIC_V2", "1");
    vi.mocked(v2Api.getHeroCard).mockResolvedValue({ card: null } as never);
    expect(await OpengraphImage()).toEqual({ image: FALLBACK });
    vi.mocked(v2Api.getHeroCard).mockRejectedValue(new Error("503"));
    expect(await OpengraphImage()).toEqual({ image: FALLBACK });
  });
});
