/**
 * PnlShareActions: the share row under a PnL receipt. The links are asserted from the rendered markup;
 * the Copy and Share handlers are driven through a small hook harness (node only, no DOM): the component
 * function runs with `useState` backed by an in-memory slot, its button handlers are called directly with
 * `navigator`, `fetch` and `File` stubbed, and the status line is read from the next render.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PnlResponse } from "@/lib/v2/api-types";

// ---- hook harness: react's state/ref/effect hooks become in-memory slots while `run` calls a component ----
const h = vi.hoisted(() => ({
  active: false, cursor: 0, slots: [] as unknown[], effects: [] as (() => unknown)[],
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (init: unknown) => {
      if (!h.active) return actual.useState(init);
      const i = h.cursor++;
      if (!(i in h.slots)) h.slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
      return [h.slots[i], (next: unknown) => {
        h.slots[i] = typeof next === "function" ? (next as (v: unknown) => unknown)(h.slots[i]) : next;
      }];
    },
    useMemo: (fn: () => unknown, deps: unknown[]) => (h.active ? fn() : actual.useMemo(fn, deps)),
  };
});

import { pnlShareText } from "./PnlText";
import { PnlShareActions } from "./PnlShareActions";

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname,
  "../../../ops/fixtures/api/v2/pnl/87928758254318692721909164101369622513960639781458875980445111726519827316414-0x4088c59Eb3fB713B124f182E7083AEb3358A030B.json"), "utf8")) as PnlResponse;
const URL_ = "https://app.stonkhouse.fun/pnl/abc";

let tree: ReactNode = null;
function render(pnl: PnlResponse = fixture): string {
  h.active = true; h.cursor = 0;
  try { tree = PnlShareActions({ pnl, url: URL_ }); } finally { h.active = false; }
  return renderToStaticMarkup(createElement("div", null, tree));
}
function button(label: string): ReactElement<{ onClick: () => Promise<void> }> {
  const walk = (n: unknown): ReactElement | null => {
    if (Array.isArray(n)) { for (const c of n) { const r = walk(c); if (r) return r; } return null; }
    if (!isValidElement(n)) return null;
    const props = n.props as { children?: unknown; onClick?: unknown };
    if (props.onClick && props.children === label) return n;
    return walk(props.children);
  };
  const hit = walk(tree);
  if (!hit) throw new Error(`no button ${label}`);
  return hit as never;
}
async function press(label: string): Promise<string> {
  await button(label).props.onClick();
  return status(render());
}
const status = (html: string) => /role="status"[^>]*>([^<]*)</.exec(html)?.[1] ?? "";

class FakeFile { constructor(public parts: unknown[], public name: string, public options: { type: string }) {} }

beforeEach(() => { h.slots = []; vi.stubGlobal("File", FakeFile); render(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("PnlShareActions: links", () => {
  it("posts the receipt's share text and URL to X, opened safely in a new tab", () => {
    const html = render();
    const href = /href="(https:\/\/x\.com\/intent\/post\?[^"]+)"/.exec(html)![1]!.replaceAll("&amp;", "&");
    const params = new URL(href).searchParams;
    expect(params.get("text")).toBe(pnlShareText(fixture));
    expect(params.get("url")).toBe(URL_);
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
  });

  it("saves the square image under an encoded id with a lowercase ticker file name", () => {
    const html = render({ ...fixture, id: "a/b c" });
    expect(html).toContain('href="/api/pnl/a%2Fb%20c/image?format=square"');
    expect(html).toContain(`download="stonkhouse-${fixture.series.ticker.toLowerCase()}-outcome.png"`);
    expect(status(html)).toBe("");
  });
});

describe("PnlShareActions: copy", () => {
  it("copies the page URL and says so", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await press("Copy link")).toBe("Link copied");
    expect(writeText).toHaveBeenCalledWith(URL_);
  });

  it("says it could not copy when the clipboard refuses", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    expect(await press("Copy link")).toBe("Could not copy the link");
  });
});

describe("PnlShareActions: native share", () => {
  const ok = () => vi.fn(async () => ({ ok: true, blob: async () => "png-bytes" }));

  it("falls back to copying when the browser has no share sheet", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await press("Share")).toBe("Link copied");
  });

  it("shares the image file when the browser can share files", async () => {
    const share = vi.fn(async () => undefined);
    const fetchMock = ok();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("navigator", { share, canShare: () => true });
    expect(await press("Share")).toBe("Shared");
    expect(fetchMock).toHaveBeenCalledWith(`/api/pnl/${encodeURIComponent(fixture.id)}/image?format=square`);
    const payload = (share.mock.calls[0] as unknown[])[0] as { files: FakeFile[]; text: string; url: string };
    expect(payload.text).toBe(pnlShareText(fixture));
    expect(payload.url).toBe(URL_);
    expect(payload.files[0]!.name).toBe(`stonkhouse-${fixture.series.ticker.toLowerCase()}-outcome.png`);
    expect(payload.files[0]!.options.type).toBe("image/png");
  });

  it("shares text and link only when files cannot be shared", async () => {
    const share = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", ok());
    vi.stubGlobal("navigator", { share });
    expect(await press("Share")).toBe("Shared");
    expect(share).toHaveBeenCalledWith({ title: "StonkHouse outcome", text: pnlShareText(fixture), url: URL_ });
  });

  it("retries without the image when the image cannot be fetched", async () => {
    const share = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    vi.stubGlobal("navigator", { share, canShare: () => true });
    expect(await press("Share")).toBe("Shared");
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0]).toEqual([{ title: "StonkHouse outcome", text: pnlShareText(fixture), url: URL_ }]);
  });

  it("stays silent when the reader dismisses the share sheet", async () => {
    const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
    const share = vi.fn(async () => { throw abort; });
    vi.stubGlobal("fetch", ok());
    vi.stubGlobal("navigator", { share, canShare: () => true });
    expect(await press("Share")).toBe("");
    expect(share).toHaveBeenCalledTimes(1);
  });

  it("offers the copy link route when sharing fails twice", async () => {
    vi.stubGlobal("fetch", ok());
    vi.stubGlobal("navigator", { share: vi.fn(async () => { throw new Error("nope"); }) });
    expect(await press("Share")).toBe("Could not share. You can copy the link instead.");
  });
});
