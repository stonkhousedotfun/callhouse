/**
 * renderSeriesImage: fonts are fetched from Google Fonts as a glyph subset and every failure mode (HTTP error on the
 * CSS, no TrueType source in it, HTTP error on the file, a thrown fetch) falls back to the renderer's sans rather than
 * failing the image. Both weights are needed; one missing weight means no custom fonts at all. fetch and
 * next/og's ImageResponse are stubbed, so nothing touches the network.
 */
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NEON_NIGHT, neutralSeriesImageLines, renderSeriesImage, SERIES_IMAGE_SIZE } from "./seriesImage";

vi.mock("next/og", () => ({
  ImageResponse: class {
    constructor(public element: ReactElement, public options: { width: number; height: number; fonts?: unknown[] }) {}
  },
}));

type Captured = { element: ReactElement; options: { width: number; height: number; fonts?: { name: string; weight: number; data: ArrayBuffer }[] } };
const FONT_URL = "https://fonts.gstatic.com/s/pjs.ttf";
const cssBody = (url = FONT_URL) => `@font-face { font-family: 'Plus Jakarta Sans'; src: url(${url}) format('truetype'); }`;
const lines = neutralSeriesImageLines();
let fetchMock: ReturnType<typeof vi.fn>;

function respond(handler: (url: string) => { ok: boolean; text?: string; bytes?: number } | Error) {
  fetchMock = vi.fn(async (url: string) => {
    const r = handler(url);
    if (r instanceof Error) throw r;
    return { ok: r.ok, text: async () => r.text ?? "", arrayBuffer: async () => new ArrayBuffer(r.bytes ?? 4) };
  });
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => respond((url) => (url.startsWith("https://fonts.googleapis.com") ? { ok: true, text: cssBody() } : { ok: true, bytes: 8 })));
afterEach(() => vi.unstubAllGlobals());

describe("renderSeriesImage", () => {
  it("fetches a subset of both weights and embeds them, at the OG size", async () => {
    const res = (await renderSeriesImage(lines)) as unknown as Captured;
    expect(res.options.width).toBe(SERIES_IMAGE_SIZE.width);
    expect(res.options.height).toBe(630);
    expect(res.options.fonts?.map((f) => [f.name, f.weight, f.data.byteLength])).toEqual([
      ["Plus Jakarta Sans", 800, 8], ["Plus Jakarta Sans", 500, 8],
    ]);
    const cssCalls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("googleapis"));
    expect(cssCalls).toHaveLength(2);
    expect(cssCalls[0]).toContain("wght@800&text=");
    expect(cssCalls[1]).toContain("wght@500&text=");
    // The subset is de-duplicated glyphs: each character once.
    const text = decodeURIComponent(cssCalls[0]!.split("&text=")[1]!);
    expect(new Set(text).size).toBe(text.length);
    for (const ch of "stonkhouse.fun" + lines.headline) expect(text).toContain(ch);
    expect(fetchMock).toHaveBeenCalledWith(FONT_URL, expect.objectContaining({ cache: "force-cache" }));
    const html = renderToStaticMarkup(res.element);
    expect(html).toContain("font-family:Plus Jakarta Sans");
    for (const l of Object.values(lines)) expect(html).toContain(l.replace(/&/g, "&amp;"));
    expect(html).toContain(`background-color:${NEON_NIGHT.ground}`);
    expect(html).toContain(`color:${NEON_NIGHT.dangerText}`);
    expect(html).toContain("app.stonkhouse.fun");
  });

  it.each([
    ["the CSS request fails", (url: string) => (url.includes("googleapis") ? { ok: false } : { ok: true })],
    ["the CSS names no TrueType/OpenType source", (url: string) => (url.includes("googleapis") ? { ok: true, text: "src: url(x.woff2) format('woff2')" } : { ok: true })],
    ["the font file request fails", (url: string) => (url.includes("googleapis") ? { ok: true, text: cssBody() } : { ok: false })],
    ["fetch throws (timeout, DNS)", () => new Error("timeout")],
  ])("%s: no custom fonts, sans-serif, still an image", async (_name, handler) => {
    respond(handler as Parameters<typeof respond>[0]);
    const res = (await renderSeriesImage(lines)) as unknown as Captured;
    expect(res.options.fonts).toBeUndefined();
    expect(renderToStaticMarkup(res.element)).toContain("font-family:sans-serif");
  });

  it("one weight missing is the same as none: the fonts are all-or-nothing", async () => {
    respond((url) => (url.includes("wght@500") ? { ok: false } : url.includes("googleapis") ? { ok: true, text: cssBody() } : { ok: true }));
    const res = (await renderSeriesImage(lines)) as unknown as Captured;
    expect(res.options.fonts).toBeUndefined();
  });
});
