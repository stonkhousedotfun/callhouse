/**
 * The Buy home page component (Marketplace, Neon redesign) end to end with fixtures: the clock (useNow ticks every 15 s
 * and clears its interval), the launch markets' ticker cards, which market's chain is embedded (the soonest listed
 * expiry by default, the reader's card after a pick, remounted per market), and the loading state. The embedded
 * chain itself (day chips, calls only, empty / delayed / failed states, Retry) is MarketPage's and is driven in
 * MarketPage.flow.test.ts ("embedded on the Buy home" and "states"); here it is a stub that records its props.
 *
 * Handlers are read from the returned element tree: React's useState/useEffect are a slot stand-in while the
 * component function is called directly (no DOM renderer in this package); the tree is then server-rendered with the
 * real hooks.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Market } from "@/lib/v2/api-types";
import { useDisplaySpots, type DisplaySpot } from "@/lib/v2/displaySpot";
import { useMarkets } from "@/lib/v2/hooks";
import { MarketPage } from "./MarketPage";
import { Marketplace, TickerCards } from "./Marketplace";

const H = vi.hoisted(() => ({ on: false, slots: [] as unknown[], i: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (orig) => {
  const real = await orig<typeof import("react")>();
  return {
    ...real,
    useState: (init: unknown) => {
      if (!H.on) return real.useState(init);
      const k = H.i++;
      if (!(k in H.slots)) H.slots[k] = init;
      return [H.slots[k], (v: unknown) => { H.slots[k] = typeof v === "function" ? (v as (p: unknown) => unknown)(H.slots[k]) : v; }];
    },
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => (H.on ? void H.effects.push(fn) : real.useEffect(fn, deps)),
  };
});
vi.mock("@/lib/v2/hooks", () => ({ useMarkets: vi.fn() }));
vi.mock("@/lib/v2/displaySpot", async (orig) => ({
  ...(await orig<typeof import("@/lib/v2/displaySpot")>()),
  useDisplaySpots: vi.fn(() => ({ data: undefined })),
}));
// The embedded chain, as a stub that prints which market it was given.
vi.mock("@/components/v2/MarketPage", async () => {
  const { createElement: h } = await import("react");
  return { MarketPage: vi.fn(({ ticker, embedded }: { ticker: string; embedded?: boolean }) =>
    h("div", { "data-market-page": ticker, "data-embedded": String(Boolean(embedded)) })) };
});

const fx = (p: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../ops/fixtures/api/v2/${p}`, import.meta.url)), "utf8"));
const markets = fx("markets.json") as Market[];
const NOW = 1_789_589_112; // the fixture's spotUpdatedAt
// Two launch markets: the fixture's NVDA (first expiry 1789675200) and its TSLA made a launch market (1789761600).
const twoLaunch = markets.map((m) => (m.ticker === "TSLA" ? { ...m, launch: true } : m));

type Props = Record<string, unknown> & { children?: ReactNode };
type El = ReactElement<Props>;
function all(node: ReactNode, pred: (e: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) { for (const n of node) all(n as ReactNode, pred, out); return out; }
  if (!isValidElement(node)) return out;
  if (pred(node as El)) out.push(node as El);
  all((node as El).props.children, pred, out);
  return out;
}
const q = (over: Record<string, unknown> = {}) => ({ data: undefined, isPending: false, isError: false, refetch: vi.fn(), ...over }) as never;
const chain = (tree: ReactNode) => all(tree, (e) => e.type === MarketPage);
const cards = (tree: ReactNode) => all(tree, (e) => e.type === TickerCards)[0]!;

function render(): { tree: ReactNode; html: string } {
  H.on = true;
  H.i = 0;
  H.effects = [];
  const tree = Marketplace() as ReactNode;
  H.on = false;
  return { tree, html: renderToStaticMarkup(tree as ReactElement) };
}
/** Mount: run the clock effect once (it ticks immediately), then render with the time set. */
function mounted() {
  render();
  const cleanup = H.effects[0]!();
  return { ...render(), cleanup: cleanup as () => void };
}

beforeEach(() => {
  H.slots = [];
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000 + 500);
  vi.stubGlobal("window", globalThis);
  vi.mocked(useMarkets).mockReturnValue(q({ data: twoLaunch }));
  vi.mocked(useDisplaySpots).mockReturnValue({ data: undefined } as never);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Marketplace page", () => {
  it("the clock ticks at mount and every 15 s, in whole seconds, and the interval is cleared on unmount", () => {
    render();
    expect(cards(render().tree).props.now, "no tick before the effect runs").toBeNull();
    const cleanup = H.effects[0]!() as () => void;
    expect(H.slots[0]).toBe(NOW);
    expect(cards(render().tree).props.now).toBe(NOW);
    vi.advanceTimersByTime(15_000);
    expect(cards(render().tree).props.now).toBe(NOW + 15);
    cleanup();
    vi.advanceTimersByTime(60_000);
    expect(H.slots[0], "no tick after cleanup").toBe(NOW + 15);
  });

  it("mounted: the launch markets' cards, and the chain of the market with the soonest expiry, embedded and keyed by it", () => {
    const spots = new Map<string, DisplaySpot>([["NVDA", { raw: 1n, updatedAt: NOW, source: "pool" }]]);
    vi.mocked(useDisplaySpots).mockReturnValue({ data: spots } as never);
    const { tree, html } = mounted();
    const props = cards(tree).props;
    expect((props.cards as { ticker: string }[]).map((c) => c.ticker), "launch markets only, registry order").toEqual(["NVDA", "TSLA"]);
    expect(props.fallback).toBe(spots);
    expect(props.selected).toBe("NVDA");
    const [page, ...extra] = chain(tree);
    expect(extra).toHaveLength(0);
    expect(page!.props).toMatchObject({ ticker: "NVDA", embedded: true });
    expect(page!.key, "a new market is a new page: nothing carries over from the last one").toBe("NVDA");
    expect(html).toContain('data-market-page="NVDA" data-embedded="true"');
    expect(html).not.toContain('aria-label="Loading markets"');
  });

  it("the soonest listed expiry decides, not the registry order", () => {
    vi.mocked(useMarkets).mockReturnValue(q({ data: twoLaunch.map((m) => (m.ticker === "TSLA" ? { ...m, expiries: [1_789_600_000, ...m.expiries] } : m)) }));
    const { tree } = mounted();
    expect(chain(tree)[0]!.props.ticker).toBe("TSLA");
    expect(cards(tree).props.selected).toBe("TSLA");
  });

  it("picking another market's card embeds that market's chain, remounted, and marks the card", () => {
    const { tree } = mounted();
    (cards(tree).props.onSelect as (t: string) => void)("TSLA");
    const next = render().tree;
    const page = chain(next)[0]!;
    expect(page.props).toMatchObject({ ticker: "TSLA", embedded: true });
    expect(page.key).toBe("TSLA");
    expect(cards(next).props.selected).toBe("TSLA");
  });

  it("a picked market that stops being a live launch market cannot stay on screen: the page falls back to the soonest", () => {
    const { tree } = mounted();
    (cards(tree).props.onSelect as (t: string) => void)("TSLA");
    expect(chain(render().tree)[0]!.props.ticker).toBe("TSLA");
    vi.mocked(useMarkets).mockReturnValue(q({ data: twoLaunch.map((m) => (m.ticker === "TSLA" ? { ...m, status: "paused" } : m)) }));
    const after = render().tree;
    expect(chain(after)[0]!.props.ticker).toBe("NVDA");
    expect((cards(after).props.cards as { ticker: string }[]).map((c) => c.ticker)).toEqual(["NVDA"]);
  });

  it("no listed expiry at all: the first launch market's chain is still embedded (it says nothing is open), not a loader", () => {
    vi.mocked(useMarkets).mockReturnValue(q({ data: twoLaunch.map((m) => ({ ...m, expiries: [], cutoffExpiries: [] })) }));
    const { tree, html } = mounted();
    expect(chain(tree)[0]!.props.ticker).toBe("NVDA");
    expect(html).not.toContain('aria-label="Loading markets"');
  });

  it("markets loading with nothing cached: the loading skeleton after the clock is read, and no cards or chain", () => {
    vi.mocked(useMarkets).mockReturnValue(q({ isPending: true }));
    const { tree, html } = mounted();
    expect(html).toContain('role="status" aria-label="Loading markets"');
    expect(chain(tree)).toHaveLength(0);
    expect(html).not.toContain('aria-label="Launch markets"');
  });

  it("markets failed with a cached list: the cached market's chain stays embedded (it carries the failure notice)", () => {
    vi.mocked(useMarkets).mockReturnValue(q({ isError: true, data: twoLaunch }));
    const { tree } = mounted();
    expect(chain(tree)[0]!.props).toMatchObject({ ticker: "NVDA", embedded: true });
  });
});
