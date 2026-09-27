/**
 * The /sell overview page (EarnOverview) on the redesigned screen: which markets get a row in "Pick a market" (live
 * only, none on error), what each row says (spot or the display fallback with its source line, the four figures, Write
 * vs View), the loading / error / empty states, the Try again wiring, and the whole-history query behind the realised
 * block (keyed by the lower-cased address, disabled without one, reading 200-row pages through the cursor).
 *
 * Every hook the page calls is mocked, the clock (useNow) included, so the page can also be called as a plain function
 * to reach a handler in its element tree. Markup is server-rendered.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useNow } from "@/lib/hooks";
import { v2Api } from "@/lib/v2/api";
import type { Market } from "@/lib/v2/api-types";
import { useDisplaySpots, type DisplaySpot } from "@/lib/v2/displaySpot";
import { useMarkets } from "@/lib/v2/hooks";
import { EarnOverview, WHOLE_HISTORY_MAX_ROWS, WHOLE_HISTORY_PAGE } from "./EarnOverview";

vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn() }));
vi.mock("wagmi", () => ({ useAccount: vi.fn() }));
vi.mock("@/lib/v2/hooks", () => ({ useMarkets: vi.fn() }));
vi.mock("@/lib/v2/displaySpot", async (orig) => ({
  ...(await orig<typeof import("@/lib/v2/displaySpot")>()),
  useDisplaySpots: vi.fn(() => ({ data: undefined })),
}));
vi.mock("@/lib/v2/api", () => ({ v2Api: { getHistory: vi.fn() } }));
vi.mock("@/lib/hooks", async (orig) => ({ ...(await orig<typeof import("@/lib/hooks")>()), useNow: vi.fn() }));
// The reader's zone is not known on the server: New York, as the page falls back to.
vi.mock("@/components/ui/Time", async (orig) => ({
  ...(await orig<typeof import("@/components/ui/Time")>()), useViewerTimeZone: vi.fn(() => null),
}));

const markets = JSON.parse(readFileSync(fileURLToPath(new URL("../../../ops/fixtures/api/v2/markets.json", import.meta.url)), "utf8")) as Market[];
const ADDRESS = "0xAbC0000000000000000000000000000000000001";
const NOW = 1_789_600_000;
const q = (over: Record<string, unknown> = {}) => ({ data: undefined, isPending: false, isError: false, refetch: vi.fn(), ...over }) as never;
const render = () => renderToStaticMarkup(createElement(EarnOverview));
const rows = (html: string) => html.match(/data-slot="writing-market"/g)?.length ?? 0;
const figure = (label: string, value: string, unit?: string) =>
  new RegExp(`${label}</dt><dd[^>]*>${value.replace(/\./g, "\\.")}${unit ? `<small[^>]*>${unit}</small>` : ""}</dd>`);
type El = ReactElement<Record<string, unknown>>;
const textOf = (n: unknown): string => typeof n === "string" || typeof n === "number" ? String(n)
  : Array.isArray(n) ? n.map(textOf).join("") : isValidElement(n) ? textOf((n.props as { children?: unknown }).children) : "";
function findAll(node: unknown, pred: (el: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) { node.forEach((child) => findAll(child, pred, out)); return out; }
  if (!isValidElement(node)) return out;
  const el = node as El;
  if (pred(el)) out.push(el);
  for (const value of Object.values(el.props)) findAll(value, pred, out);
  return out;
}

beforeEach(() => {
  vi.mocked(useAccount).mockReturnValue({ address: undefined } as never);
  vi.mocked(useQuery).mockReturnValue(q());
  vi.mocked(useMarkets).mockReturnValue(q({ data: markets }));
  vi.mocked(useDisplaySpots).mockReturnValue({ data: undefined } as never);
  vi.mocked(useNow).mockReturnValue(NOW);
});

describe("the market rows", () => {
  it("one row per live market, with its spot, the four figures, and a Write link to its sell page", () => {
    const html = render();
    expect(html).toContain(">Sell options</h1>");
    expect(html).toContain("Writing a call caps your upside above its strike.");
    expect(html).toContain("Pick a market");
    expect(html).toContain(">2 live</span>");
    expect(rows(html)).toBe(2);
    expect(html).toMatch(/>NVDA<span[^>]*>\$215\.5<\/span>/);
    expect(html).toMatch(/>TSLA<span[^>]*>\$355\.85<\/span>/);
    expect(html).toMatch(figure("Premium · 7d", "9.24854", "USDG"));
    expect(html).toMatch(figure("Volume · 24h", "4.3064", "USDG"));
    expect(html).toMatch(figure("Open options", "15"));
    expect(html).toMatch(figure("Open interest", "8.75", "sh"));
    expect(html).toMatch(/href="\/sell\/nvda"[^>]*>Write NVDA<\/a>/);
    expect(html).toMatch(/href="\/sell\/tsla"[^>]*>Write TSLA<\/a>/);
  });

  it("a planned market gets no row; puts on a live market switch the copy", () => {
    vi.mocked(useMarkets).mockReturnValue(q({ data: [{ ...markets[0]!, puts: true }, { ...markets[1]!, status: "planned" }] }));
    const html = render();
    expect(rows(html)).toBe(1);
    expect(html).not.toContain(">TSLA<span");
    expect(html).toContain(">1 live</span>");
    expect(html).toContain("cash-secured puts");
    expect(html).toContain("a put can lose the difference below its strike from USDG collateral.");
  });

  it("no API spot: the display fallback with its source line, and the button only offers View", () => {
    const fallback: DisplaySpot = { raw: 214_250_000n, updatedAt: NOW - 60, source: "pool" };
    vi.mocked(useDisplaySpots).mockReturnValue({ data: new Map([["NVDA", fallback]]) } as never);
    vi.mocked(useMarkets).mockReturnValue(q({ data: [{ ...markets[0]!, spot: null, spotUpdatedAt: null }] }));
    const html = render();
    expect(html).toMatch(/>NVDA<span[^>]*>\$214\.25<\/span>/);
    expect(html).toContain('aria-label="About the NVDA price"');
    expect(html).toMatch(/Pool price, updated /);
    expect(html).toMatch(/href="\/sell\/nvda"[^>]*>View NVDA<\/a>/);
    expect(html).not.toContain("Write NVDA");
  });

  it("a fallback older than an hour from Chainlink reads as the last close, on the mounted clock", () => {
    const fallback: DisplaySpot = { raw: 214_250_000n, updatedAt: NOW - 2 * 86_400, source: "chainlink" };
    vi.mocked(useDisplaySpots).mockReturnValue({ data: new Map([["NVDA", fallback]]) } as never);
    vi.mocked(useMarkets).mockReturnValue(q({ data: [{ ...markets[0]!, spot: null, spotUpdatedAt: null }] }));
    const html = render();
    expect(html).toMatch(/Last close price, updated /);
    expect(html).toContain("View NVDA");
  });

  it("before the clock is set (useNow() 0, the server render), a two-day-old Chainlink price is dated, not current", () => {
    vi.mocked(useNow).mockReturnValue(0);
    const fallback: DisplaySpot = { raw: 214_250_000n, updatedAt: NOW - 2 * 86_400, source: "chainlink" };
    vi.mocked(useDisplaySpots).mockReturnValue({ data: new Map([["NVDA", fallback]]) } as never);
    vi.mocked(useMarkets).mockReturnValue(q({ data: [{ ...markets[0]!, spot: null, spotUpdatedAt: null }] }));
    const html = render();
    expect(html).toContain("Updated Sep 14, 7:06 PM EDT");
    // The bare time is the current-price form; before the fix the age was measured against 0 and it showed.
    expect(html).not.toMatch(/Updated \d{1,2}:\d{2} [AP]M/);
  });

  it("no API spot and no fallback: 'Price unavailable', no source line", () => {
    vi.mocked(useMarkets).mockReturnValue(q({ data: [{ ...markets[0]!, spot: null, spotUpdatedAt: null }] }));
    const html = render();
    expect(html).toMatch(/>NVDA<span[^>]*>Price unavailable<\/span>/);
    expect(html).not.toContain("About the NVDA price");
    expect(html).not.toMatch(/updated /i);
    expect(html).toContain("View NVDA");
  });
});

describe("page states", () => {
  it("loading: a status panel, no rows", () => {
    vi.mocked(useMarkets).mockReturnValue(q({ isPending: true }));
    const html = render();
    expect(html).toMatch(/role="status"[^>]*>Loading writing markets…/);
    expect(rows(html)).toBe(0);
    expect(html).not.toContain("No writing markets are open yet.");
  });

  it("error: the unavailable notice with Try again (which refetches), and no rows even with cached data", () => {
    const refetch = vi.fn();
    vi.mocked(useMarkets).mockReturnValue(q({ isError: true, data: markets, refetch }));
    const html = render();
    expect(html).toContain("Writing markets are unavailable.");
    expect(html).toContain("Try again");
    expect(rows(html)).toBe(0);
    expect(html).not.toContain("Pick a market");
    expect(html).not.toContain("No writing markets are open yet.");
    const [again] = findAll(EarnOverview(), (el) => typeof el.props.onClick === "function" && textOf(el.props.children) === "Try again");
    expect(again).toBeDefined();
    (again!.props.onClick as () => void)();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("loaded with nothing live: the empty panel", () => {
    vi.mocked(useMarkets).mockReturnValue(q({ data: markets.map((m) => ({ ...m, status: "paused" })) }));
    const html = render();
    expect(html).toContain("No writing markets are open yet.");
    expect(rows(html)).toBe(0);
  });
});

describe("the realised block and its history query", () => {
  it("disconnected: the query is disabled and no realised block renders", () => {
    const html = render();
    expect(vi.mocked(useQuery).mock.calls.at(-1)![0]).toMatchObject({ enabled: false, queryKey: ["v2", "historyWhole", undefined], retry: 0 });
    expect(html).not.toContain("What you have made");
  });

  it("connected: keyed by the lower-cased address; the query walks pages of 200 through the cursor", async () => {
    vi.mocked(useAccount).mockReturnValue({ address: ADDRESS } as never);
    render();
    const options = vi.mocked(useQuery).mock.calls.at(-1)![0] as unknown as {
      enabled: boolean; queryKey: unknown[]; queryFn: (ctx: { signal: AbortSignal }) => Promise<{ items: unknown[]; complete: boolean }>;
    };
    expect(options.enabled).toBe(true);
    expect(options.queryKey).toEqual(["v2", "historyWhole", ADDRESS.toLowerCase()]);
    vi.mocked(v2Api.getHistory)
      .mockResolvedValueOnce({ items: [{ id: "a" }], nextCursor: "c1" } as never)
      .mockResolvedValueOnce({ items: [{ id: "b" }], nextCursor: null } as never);
    const signal = new AbortController().signal;
    await expect(options.queryFn({ signal })).resolves.toEqual({ items: [{ id: "a" }, { id: "b" }], complete: true });
    expect(v2Api.getHistory).toHaveBeenNthCalledWith(1, ADDRESS, { limit: WHOLE_HISTORY_PAGE }, { signal });
    expect(v2Api.getHistory).toHaveBeenNthCalledWith(2, ADDRESS, { limit: WHOLE_HISTORY_PAGE, cursor: "c1" }, { signal });
  });

  it("connected with history: the realised figures; a partial walk says how many entries it counted", () => {
    vi.mocked(useAccount).mockReturnValue({ address: ADDRESS } as never);
    const usdg = (raw: string) => ({ raw, decimals: 6, formatted: raw });
    const fill = { id: "f", kind: "fill", data: { side: "sell", premium: usdg("3000000"), fee: usdg("30000"), rebate: usdg("10000"), realisedPnl: null } };
    vi.mocked(useQuery).mockReturnValue(q({ data: { items: [fill], complete: true } }));
    const html = render();
    const stat = (label: string, value: string) =>
      new RegExp(`${label}</div><div data-slot="stat-value"[^>]*>${value.replace(/\./g, "\\.")} <small[^>]*>USDG</small>`);
    expect(html).toContain("What you have made");
    expect(html).toMatch(stat("Premium, net", "3"));
    expect(html).toMatch(stat("Fees paid", "0.03"));
    expect(html).toMatch(stat("Rebates earned", "0.01"));
    expect(html).toContain("Realised across your whole history, in USDG.");
    vi.mocked(useQuery).mockReturnValue(q({ data: { items: [fill], complete: false } }));
    expect(WHOLE_HISTORY_MAX_ROWS).toBe(5_000);
    expect(render()).toContain("Realised across your latest 5,000 history entries, in USDG.");
  });
});
