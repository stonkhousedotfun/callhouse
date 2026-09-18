import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const longId = "87928758254318692721909164101369622513960639781458875980445111726519827316414";
const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, `../../../ops/fixtures/api/v2/series/${longId}.json`), "utf8"));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("ERC-1155 token metadata", () => {
  it("maps even long and odd short decimal IDs to the same series image", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      requested.push(String(input));
      return new Response(JSON.stringify(fixture), { status: 200, headers: { "content-type": "application/json" } });
    }));
    vi.resetModules();
    const { GET } = await import("../../app/api/token/[id]/route");
    const long = await GET(new Request(`https://app.stonkhouse.fun/api/token/${longId}`), { params: Promise.resolve({ id: longId }) });
    const shortId = String(BigInt(longId) + 1n);
    const short = await GET(new Request(`https://app.stonkhouse.fun/api/token/${shortId}`), { params: Promise.resolve({ id: shortId }) });
    const a = await long.json();
    const b = await short.json();
    expect(long.status).toBe(200);
    expect(short.status).toBe(200);
    expect(a.name).toContain("· long");
    expect(b.name).toContain("· short");
    expect(a.image).toBe(`https://app.stonkhouse.fun/nvda/${longId}/opengraph-image`);
    expect(a.image).toBe(b.image);
    expect(requested).toEqual([`http://localhost:42069/v2/series/${longId}`, `http://localhost:42069/v2/series/${longId}`]);
  });

  it("rejects non-decimal IDs", async () => {
    const { GET } = await import("../../app/api/token/[id]/route");
    const response = await GET(new Request("https://app.stonkhouse.fun/api/token/0x01"), { params: Promise.resolve({ id: "0x01" }) });
    expect(response.status).toBe(400);
  });
});
