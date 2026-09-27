/** GET /api/pnl/[id]/image: shape selection and wiring; loading and rendering are stubbed. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/v2/PnlData", () => ({ loadPnl: vi.fn(async (id: string) => ({ id })) }));
vi.mock("@/components/v2/PnlImage", () => ({ renderPnlImage: vi.fn(() => new Response("png")) }));

import { loadPnl } from "@/components/v2/PnlData";
import { renderPnlImage } from "@/components/v2/PnlImage";
import { GET } from "./route";

const call = (url: string, id: string) => GET(new Request(url), { params: Promise.resolve({ id }) });

describe("GET /api/pnl/[id]/image", () => {
  beforeEach(() => {
    vi.mocked(loadPnl).mockClear();
    vi.mocked(renderPnlImage).mockClear();
  });

  it("renders the square card only for format=square", async () => {
    await call("http://localhost/api/pnl/7/image?format=square", "7");
    expect(loadPnl).toHaveBeenCalledWith("7");
    expect(renderPnlImage).toHaveBeenCalledWith({ id: "7" }, "square");
  });

  it.each(["", "?format=wide", "?format=SQUARE", "?format=tall"])("defaults to the wide card for %j", async (query) => {
    const res = await call(`http://localhost/api/pnl/7/image${query}`, "7");
    expect(renderPnlImage).toHaveBeenCalledWith({ id: "7" }, "wide");
    expect(await res.text()).toBe("png");
  });
});
