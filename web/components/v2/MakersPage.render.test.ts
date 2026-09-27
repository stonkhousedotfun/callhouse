/**
 * MakersPage rendered with data, on the redesigned screen: the scores table and
 * its phone cards, the four headline stats (the live-or-launch fill rebate and the scoring week), the refresh / retry /
 * load-more controls, the contract list (now inside a Disclosure) and the maker claims panel's epoch list.
 *
 * MakersPage.test.ts pins the source bindings; this file renders the page against the makers fixture with react-query,
 * wagmi and the v2 hooks mocked, and calls the page's button handlers directly. MakersPage itself holds no React
 * state (the claims panel's useMemo runs only inside renderToStaticMarkup), so it runs as a plain function to reach
 * its element tree. The tree walker walks every prop value, not only `children`, because the redesign passes content
 * through `label`, `value` and `sub` props (Stat) as well.
 *
 * Every figure below is derived by hand from the fixture under the shared number rules (lib/numberFormat.ts): a
 * money figure is truncated to two decimals, a percent to one decimal, a count is grouped.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Address } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MakerResponse, MakersResponse } from "@/lib/v2/api-types";

type Infinite = {
  isPending?: boolean; isError?: boolean; isFetching?: boolean; hasNextPage?: boolean; isFetchingNextPage?: boolean;
  data?: { pages: MakersResponse[] }; refetch?: () => unknown; fetchNextPage?: () => unknown;
};
const state = vi.hoisted(() => ({
  infinite: {} as Infinite,
  options: null as null | { queryKey: unknown[]; queryFn: (ctx: { pageParam: string | undefined; signal: AbortSignal }) => unknown;
    getNextPageParam: (last: { nextCursor: string | null }) => unknown; initialPageParam: unknown },
  address: undefined as Address | undefined,
  config: { data: undefined as undefined | { fees: { makerRebateBps: number } } },
  maker: { data: undefined as MakerResponse | undefined, isError: false },
  makerArgs: [] as unknown[],
  claims: [] as Record<string, unknown>[],
  getMakers: vi.fn(),
  deployment: {} as { contracts: Record<string, string | null>; fees: Record<string, unknown> | null },
}));
vi.mock("@tanstack/react-query", () => ({
  useInfiniteQuery: (options: typeof state.options) => { state.options = options; return state.infinite; },
}));
vi.mock("wagmi", () => ({ useAccount: () => ({ address: state.address }) }));
vi.mock("@/lib/v2/hooks", () => ({
  useConfig: () => state.config,
  useMaker: (address: unknown) => { state.makerArgs.push(address); return state.maker; },
}));
vi.mock("@/lib/v2/api", () => ({ v2Api: { getMakers: state.getMakers } }));
vi.mock("@/lib/v2/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/v2/config")>();
  Object.assign(state.deployment, original.V2_DEPLOYMENT, { contracts: { ...original.V2_DEPLOYMENT.contracts } });
  return { ...original, V2_DEPLOYMENT: state.deployment };
});
vi.mock("@/components/v2/RewardClaims", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return { RewardClaims: (props: Record<string, unknown>) => {
    state.claims.push(props);
    return react.createElement("section", { "data-epochs": String(props.epochs) }, props.unavailable as never);
  } };
});

import { Stat } from "@/components/ui";
import { MakersPage } from "./MakersPage";

const fixtures = new URL("../../../ops/fixtures/api/v2/", import.meta.url);
const read = <T,>(path: string) => JSON.parse(readFileSync(fileURLToPath(new URL(path, fixtures)), "utf8")) as T;
const makers = read<MakersResponse>("makers.json");
const profile = read<MakerResponse>("makers/0xd3b47D8a6B8e3fc6160Cd02634CF7Ae74aDeB66f.json");
const [top, second] = makers.items;
const html = () => renderToStaticMarkup(createElement(MakersPage));
const stripTags = (s: string) => s.replace(/<[^>]+>/g, "");
/** The table's body cells, in order (the cards' cells carry classes, so they are not matched). */
const cells = (markup: string) => [...markup.matchAll(/<td>(.*?)<\/td>/g)].map((m) => stripTags(m[1]!));
/** The phone cards: each card's title text, its label -> value fields, and whether it is highlighted. */
function cards(markup: string) {
  return [...markup.matchAll(/<article([^>]*)>(.*?)<\/article>/g)].map((m) => ({
    highlighted: /class="[^"]*\bbg-accent-soft\b/.test(m[1]!),
    title: stripTags(/<h3[^>]*>(.*?)<\/h3>/.exec(m[2]!)![1]!),
    fields: Object.fromEntries([...m[2]!.matchAll(/<dt[^>]*>(.*?)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map((f) => [stripTags(f[1]!), stripTags(f[2]!)])),
  }));
}

type El = ReactElement<Record<string, unknown>>;
function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: unknown }).children);
  return "";
}
/** Depth-first over every prop value (elements, arrays and plain objects), not only `children`. */
function search(pred: (el: El) => boolean, node: unknown): El | null {
  if (Array.isArray(node)) { for (const child of node) { const hit = search(pred, child); if (hit) return hit; } return null; }
  if (isValidElement(node)) {
    if (pred(node as El)) return node as El;
    return search(pred, Object.values(node.props as Record<string, unknown>));
  }
  if (node && typeof node === "object" && Object.getPrototypeOf(node) === Object.prototype) return search(pred, Object.values(node));
  return null;
}
/** Runs the page once and searches the element tree it returns. */
const findEl = (pred: (el: El) => boolean): El | null => search(pred, MakersPage());
function button(label: string): ReactElement<{ onClick: () => void; disabled?: boolean }> {
  const hit = findEl((el) => typeof el.props.onClick === "function" && textOf(el.props.children) === label);
  if (!hit) throw new Error(`no button ${label}`);
  return hit as never;
}
/** One headline stat, rendered on its own: the figure and the line under it, as the page shows them. */
function stat(label: string): { value: string; sub: string } {
  const el = findEl((node) => node.type === Stat && textOf(node.props.label).startsWith(label));
  if (!el) throw new Error(`no stat ${label}`);
  const markup = renderToStaticMarkup(el);
  const slot = (name: string) => stripTags(new RegExp(`data-slot="${name}"[^>]*>(.*?)</div>`).exec(markup)?.[1] ?? "");
  return { value: slot("stat-value"), sub: slot("stat-sub") };
}

beforeEach(() => {
  state.infinite = { data: { pages: [makers] }, refetch: vi.fn(), fetchNextPage: vi.fn() };
  state.address = undefined; state.config = { data: undefined }; state.maker = { data: undefined, isError: false };
  state.makerArgs = []; state.claims = []; state.getMakers.mockReset();
  state.deployment.fees = { makerRebateBps: 5_000 };
  state.deployment.contracts = { ...state.deployment.contracts, orderBook: "0x00000000000000000000000000000000000000b1",
    makerVault: null, makerRegistry: null, rewardsDistributor: "0x00000000000000000000000000000000000000d1" };
});

describe("MakersPage: the scores", () => {
  it("renders each maker's row, and its phone card, with the shared number rules", () => {
    const markup = html();
    // Fixture row 1: score 91.6, uptime 99.4, spread 1480 bps, depth 2240, 10 fills, volume 8.606980 USDG,
    // rebates 0.362699 USDG (both truncated to two decimals), tier 5000 bps.
    const expected = [`${top!.maker.slice(0, 6)}…${top!.maker.slice(-4)}`,
      "91.6", "99.4%", "14.8%", "2,240", "10", "8.60 USDG", "0.36 USDG", "50%"];
    expect(cells(markup).slice(0, 9)).toEqual(expected);
    // A maker with no spread sample shows a dash, not 0%.
    expect(second!.avgSpreadBps).toBeNull();
    expect(cells(markup).slice(9, 18)[3]).toBe("—");
    expect(markup).toContain(`href="https://`);
    expect(markup).toContain(`title="${top!.maker}"`);
    // The phone card carries every column the row carries, under the column's own heading, with the same text.
    const [card, card2] = cards(markup);
    expect(card!.title).toBe(expected[0]);
    expect(card!.fields).toEqual({ Score: "91.6", Uptime: "99.4%", Spread: "14.8%", "Depth (units)": "2,240", Fills: "10",
      Volume: "8.60 USDG", Rebates: "0.36 USDG", "Tier share": "50%" });
    expect(card2!.fields.Spread).toBe("—");
    // The scoring week is now a headline stat: the epoch id, and "Epoch <id>" in its explanation.
    expect(stat("Scoring week").value).toBe(`#${makers.epoch.id}`);
    expect(markup).toContain(`Epoch ${makers.epoch.id}`);
  });

  it("highlights the connected wallet's row, and its card, whatever its address casing", () => {
    state.address = second!.maker.toLowerCase() as Address;
    const markup = html();
    expect(markup.match(/<tr class="bg-accent-soft">/g)).toHaveLength(1);
    expect(markup).toMatch(new RegExp(`<tr class="bg-accent-soft"><td><a[^>]*title="${second!.maker}"`));
    const highlighted = cards(markup).filter((c) => c.highlighted);
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]!.title).toBe(`${second!.maker.slice(0, 6)}…${second!.maker.slice(-4)}`);
  });

  it("merges pages and drops a maker repeated across pages (case-insensitively)", () => {
    const repeat = { ...makers, items: [{ ...top!, maker: top!.maker.toLowerCase(), score: 12 }] };
    state.infinite = { ...state.infinite, data: { pages: [makers, repeat] } };
    const markup = html();
    expect(markup.match(/<tr class="/g)).toHaveLength(makers.items.length);
    expect(cards(markup)).toHaveLength(makers.items.length);
    // The later page's row replaces the earlier one.
    expect(cells(markup)[1]).toBe("12");
    expect(cards(markup)[0]!.fields.Score).toBe("12");
  });

  it("says loading, then unavailable with a retry, and never shows a table without data", () => {
    state.infinite = { isPending: true, refetch: vi.fn() };
    const loading = html();
    expect(loading).toContain("Loading maker scores…");
    expect(loading).not.toContain("<table");
    state.infinite = { isPending: false, isError: true, refetch: vi.fn() };
    const markup = html();
    expect(markup).toContain("Maker scores are unavailable.");
    expect(markup).not.toContain("<table");
    expect(markup).not.toContain("<article");
    expect(stat("Scoring week")).toEqual({ value: "—", sub: "Latest recorded week" });
    button("Try again").props.onClick();
    expect(state.infinite.refetch).toHaveBeenCalledTimes(1);
    expect(state.claims).toHaveLength(0);
  });

  it("keeps saved scores on screen while a refresh fails", () => {
    state.infinite = { ...state.infinite, isError: true };
    const markup = html();
    expect(markup).toContain("Showing saved scores while live updates recover.");
    expect(markup).toContain("<table");
    expect(cells(markup)[1]).toBe("91.6");
  });

  it("says no scores for an empty week", () => {
    state.infinite = { ...state.infinite, data: { pages: [{ ...makers, items: [] }] } };
    const markup = html();
    expect(markup).toContain("No maker scores have been recorded for this week.");
    expect(markup).not.toContain("<table");
  });

  it("refreshes, and disables Refresh while fetching", () => {
    state.infinite = { ...state.infinite, isFetching: false };
    expect(button("Refresh").props.disabled).toBe(false);
    button("Refresh").props.onClick();
    expect(state.infinite.refetch).toHaveBeenCalledTimes(1);
    state.infinite = { ...state.infinite, isFetching: true };
    expect(button("Refresh").props.disabled).toBe(true);
  });

  it("offers Load more only with a next page, and disables it while loading", () => {
    expect(html()).not.toContain("Load more makers");
    state.infinite = { ...state.infinite, hasNextPage: true, isFetchingNextPage: false };
    expect(button("Load more makers").props.disabled).toBe(false);
    button("Load more makers").props.onClick();
    expect(state.infinite.fetchNextPage).toHaveBeenCalledTimes(1);
    state.infinite = { ...state.infinite, isFetchingNextPage: true };
    expect(html()).toContain("Loading…");
    expect(button("Loading…").props.disabled).toBe(true);
  });

  it("pages the maker list 25 at a time by cursor", () => {
    html();
    const options = state.options!;
    expect(options.queryKey).toEqual(["v2", "maker-list"]);
    expect(options.initialPageParam).toBeUndefined();
    const signal = new AbortController().signal;
    void options.queryFn({ pageParam: "c1", signal });
    expect(state.getMakers).toHaveBeenCalledWith({ limit: 25, cursor: "c1" }, { signal });
    expect(options.getNextPageParam({ nextCursor: "c2" })).toBe("c2");
    expect(options.getNextPageParam({ nextCursor: null })).toBeUndefined();
  });
});

describe("MakersPage: fill rebates", () => {
  const LAUNCH = "Launch setting shown; the current rate has not loaded.";

  it("shows the live share without the launch label", () => {
    state.config = { data: { fees: { makerRebateBps: 4_000 } } };
    expect(stat("Fill rebate")).toEqual({ value: "40%", sub: "of the taker fee" });
    expect(html()).not.toContain("Launch setting shown");
  });

  it("labels the registry's launch value while the live value is missing", () => {
    expect(stat("Fill rebate")).toEqual({ value: "50%", sub: LAUNCH });
    expect(html()).toContain(LAUNCH);
  });

  it("shows a dash and no label when neither value is usable", () => {
    state.deployment.fees = null;
    expect(stat("Fill rebate").value).toBe("—");
    expect(stat("Fill rebate").sub).not.toContain("Launch setting shown");
    expect(html()).not.toContain("Launch setting shown");
  });
});

describe("MakersPage: contracts and claims", () => {
  it("links each deployed contract checksummed and says Awaiting deployment for the rest", () => {
    // A lower-case address with letters, so the checksum is visible. Its checksummed form is the fixture's file name.
    // The week is empty so no score row links the same address and the only link to it is the contract's.
    state.infinite = { ...state.infinite, data: { pages: [{ ...makers, items: [] }] } };
    state.deployment.contracts = { ...state.deployment.contracts, orderBook: profile.maker.toLowerCase() };
    const markup = html();
    expect(markup).not.toContain("<table");
    expect(markup).toContain(`/address/${profile.maker}"`);
    expect(markup).not.toContain(`/address/${profile.maker.toLowerCase()}"`);
    expect(markup).toContain(`${profile.maker.toLowerCase()}</a>`);
    expect(markup).toContain("0x00000000000000000000000000000000000000d1</a>");
    // makerVault and makerRegistry are null in beforeEach.
    expect(markup.match(/Awaiting deployment/g)).toHaveLength(2);
  });

  it("claims the current epoch plus the maker's own epochs, newest first, de-duplicated and capped at 12", () => {
    state.address = profile.maker as Address;
    const many = Array.from({ length: 15 }, (_, i) => ({ ...profile.epochs[0]!, epoch: { ...profile.epochs[0]!.epoch, id: 2940 + i } }));
    state.maker = { data: { ...profile, epochs: [...profile.epochs, ...many] }, isError: false };
    html();
    const props = state.claims[0] as { epochs: number[]; address: string; program: { id: string; distributor: string } };
    expect(props.epochs).toHaveLength(12);
    expect(props.epochs[0]).toBe(2958);
    expect(props.epochs).toEqual([...props.epochs].sort((a, b) => b - a));
    expect(new Set(props.epochs).size).toBe(12);
    expect(props.program).toMatchObject({ id: "maker", distributor: "0x00000000000000000000000000000000000000d1" });
    expect(props.address).toBe(profile.maker);
    expect(state.makerArgs).toContain(profile.maker);
  });

  it("shows only the current epoch, with a notice, when the maker's history fails", () => {
    state.maker = { data: undefined, isError: true };
    const markup = html();
    expect(markup).toContain('data-epochs="2958"');
    expect(markup).toContain("Older epochs are unavailable. The current one is shown.");
  });
});
