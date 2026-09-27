/**
 * The Buy home when /v2/markets fails. With nothing cached it used to show the "Loading markets" skeleton
 * forever; it now says the quotes could not load and offers a Retry that refetches (the pre-redesign page said
 * "Live quotes are delayed." with a Retry). With a cached list the embedded market page stays; its own market-data
 * notice says the prices may be delayed (MarketPageStates.test.ts). The embedded page is a stub here.
 *
 * Marketplace is called as a function with React's useState/useEffect as a slot stand-in (H.on), so its Retry
 * handler can be pressed; the tree is then server-rendered with the real hooks.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Market } from "@/lib/v2/api-types";
import { useMarkets } from "@/lib/v2/hooks";
import { Marketplace } from "./Marketplace";

const H = vi.hoisted(() => ({ on: false, slots: [] as unknown[], i: 0 }));
vi.mock("react", async (orig) => {
  const real = await orig<typeof import("react")>();
  return {
    ...real,
    useState: (init: unknown) => {
      if (!H.on) return real.useState(init);
      const k = H.i++;
      if (!(k in H.slots)) H.slots[k] = typeof init === "function" ? (init as () => unknown)() : init;
      return [H.slots[k], (v: unknown) => { H.slots[k] = v; }];
    },
    useEffect: (fn: () => void, deps?: unknown[]) => (H.on ? undefined : real.useEffect(fn, deps)),
    useSyncExternalStore: (sub: (cb: () => void) => () => void, get: () => unknown, server?: () => unknown) =>
      (H.on ? (server ?? get)() : real.useSyncExternalStore(sub, get, server)),
  };
});
vi.mock("@/lib/v2/hooks", async (orig) => ({ ...(await orig<typeof import("@/lib/v2/hooks")>()), useMarkets: vi.fn() }));
vi.mock("@/lib/v2/displaySpot", async (orig) => ({
  ...(await orig<typeof import("@/lib/v2/displaySpot")>()), useDisplaySpots: () => ({ data: undefined }),
}));
vi.mock("@/components/v2/MarketPage", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return { MarketPage: ({ ticker }: { ticker: string }) => react.createElement("div", { "data-market-page": ticker }) };
});

const markets = JSON.parse(readFileSync(fileURLToPath(new URL("../../../ops/fixtures/api/v2/markets.json", import.meta.url)), "utf8")) as Market[];
let refetch: ReturnType<typeof vi.fn>;
const answer = (over: Record<string, unknown>) =>
  vi.mocked(useMarkets).mockReturnValue({ data: undefined, isPending: false, isError: false, isFetching: false, refetch, ...over } as never);

type El = ReactElement<Record<string, unknown>>;
function all(node: unknown, pred: (e: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) { for (const n of node) all(n, pred, out); return out; }
  if (!isValidElement(node)) return out;
  const el = node as El;
  if (pred(el)) out.push(el);
  for (const value of Object.values(el.props)) all(value, pred, out);
  return out;
}
const text = (n: unknown): string => Array.isArray(n) ? n.map(text).join("") : isValidElement(n) ? text((n.props as { children?: unknown }).children)
  : typeof n === "string" ? n : "";
function page() {
  H.on = true; H.i = 0; H.slots = [];
  let tree: ReactNode;
  try { tree = Marketplace() as ReactNode; } finally { H.on = false; }
  return { tree, html: renderToStaticMarkup(tree as ReactElement) };
}
const retry = (tree: ReactNode) => all(tree, (e) => typeof e.props.onClick === "function" && /^Retr/.test(text(e.props.children)))[0];

beforeEach(() => { refetch = vi.fn(); });
afterEach(() => { H.on = false; });

describe("the Buy home when the market list fails", () => {
  it("failed with nothing cached: the delayed notice and a Retry that refetches, not the loading skeleton", () => {
    answer({ isError: true });
    const { tree, html } = page();
    expect(html).toContain("Live quotes are delayed.");
    expect(html).toContain("Markets could not load.");
    expect(html).not.toContain('aria-label="Loading markets"');
    expect(html).not.toContain("data-market-page");
    const button = retry(tree)!;
    expect(button.props.disabled).toBe(false);
    (button.props.onClick as () => void)();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("while the retry runs: the button says so and is disabled", () => {
    answer({ isError: true, isFetching: true });
    const { tree, html } = page();
    expect(html).toContain("Retrying…");
    expect(retry(tree)!.props.disabled).toBe(true);
  });

  it("still loading with nothing cached: the skeleton, and no failure notice", () => {
    answer({ isPending: true });
    const { html } = page();
    expect(html).toContain('role="status" aria-label="Loading markets"');
    expect(html).not.toContain("Markets could not load.");
  });

  it("failed with a cached list: the cached market's page stays embedded, with no page-level failure notice over it", () => {
    answer({ isError: true, data: markets });
    const { html } = page();
    expect(html).toContain('data-market-page="NVDA"');
    expect(html).not.toContain("Markets could not load.");
    expect(html).not.toContain('aria-label="Loading markets"');
  });
});
