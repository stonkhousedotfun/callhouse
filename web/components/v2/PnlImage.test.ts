import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
