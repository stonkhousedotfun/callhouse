/** GET /api/token/[id]: ERC-1155 metadata, with the indexer API stubbed. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/v2/api", () => ({ v2Api: { getSeries: vi.fn() } }));
vi.mock("@/components/v2/PnlText", () => ({
  tokenMetadataText: vi.fn((series: { ticker: string }, isShort: boolean) => ({ title: `${series.ticker} ${isShort ? "short" : "long"}`, description: "desc" })),
}));

import { APP_URL } from "@/lib/site";
import { v2Api } from "@/lib/v2/api";
import { GET } from "./route";

const getSeries = vi.mocked(v2Api.getSeries);
const call = (id: string) => GET(new Request(`http://localhost/api/token/${id}`), { params: Promise.resolve({ id }) });

const SERIES = { ticker: "NVDA", isPut: false, strike: { formatted: "231.00" }, expiry: 1_790_366_400 };

describe("GET /api/token/[id]", () => {
  beforeEach(() => {
    getSeries.mockReset();
  });

  it.each(["0", "abc", "01", "-2", "2.0", "", (2n ** 256n).toString()])("refuses token id %j with 400 before calling the API", async (id) => {
    const res = await call(id);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid token ID" });
    expect(getSeries).not.toHaveBeenCalled();
  });

  it("serves a long id's metadata under its long id, cacheable", async () => {
    getSeries.mockResolvedValue({ series: SERIES } as never);
    const res = await call("42");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60, stale-while-revalidate=300");
    expect(getSeries).toHaveBeenCalledWith("42");
    const body = await res.json();
    expect(body).toMatchObject({
      name: "NVDA long",
      description: "desc",
      image: `${APP_URL}/nvda/42/opengraph-image`,
      external_url: `${APP_URL}/nvda/42`,
    });
    expect(body.attributes).toEqual([
      { trait_type: "Side", value: "Long" },
      { trait_type: "Type", value: "Call" },
      { trait_type: "Ticker", value: "NVDA" },
      { trait_type: "Strike", value: "231.00" },
      { trait_type: "Expiry", value: 1_790_366_400, display_type: "date" },
    ]);
  });

  it("maps a short (odd) id to its long series and labels it Short", async () => {
    getSeries.mockResolvedValue({ series: { ...SERIES, isPut: true } } as never);
    const body = await (await call("43")).json();
    expect(getSeries).toHaveBeenCalledWith("42");
    expect(body.name).toBe("NVDA short");
    expect(body.attributes[0]).toEqual({ trait_type: "Side", value: "Short" });
    expect(body.attributes[1]).toEqual({ trait_type: "Type", value: "Put" });
  });

  it("answers 404 when the series cannot be read", async () => {
    getSeries.mockRejectedValue(new Error("404"));
    const res = await call("42");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Series unavailable" });
  });
});
