/**
 * /legacy/activity: every week of the closed pooled vault, zeros included. What the page decides: the three totals
 * (a column total is a number only when every row's figure is known, else a dash), premium kept apart from strike
 * proceeds, each row's figures (an unfilled week is 0, not a dash), the result chip's tone, the tx link (closing tx
 * first), and the empty-table sentence by state.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CycleRow } from "@/lib/api";
import { useCycleHistory } from "@/lib/history";
import ActivityPage from "./page";

const C = vi.hoisted(() => ({ vault: "0x00000000000000000000000000000000000000aa" as string | undefined }));
vi.mock("@/lib/contracts", async (orig) => ({ ...(await orig<typeof import("@/lib/contracts")>()), get VAULT() { return C.vault; } }));
vi.mock("@/lib/history", async (orig) => ({ ...(await orig<typeof import("@/lib/history")>()), useCycleHistory: vi.fn() }));
vi.mock("@/components/ui/Time", async () => {
  const { createElement: h } = await vi.importActual<typeof import("react")>("react");
  return { Time: ({ at }: { at: number }) => h("time", null, `T${at}`) };
});
vi.mock("@/components/ui", async (orig) => {
  const real = await orig<typeof import("@/components/ui")>();
  const { createElement: h } = await vi.importActual<typeof import("react")>("react");
  return { ...real, Chip: ({ tone, children }: { tone?: string; children?: unknown }) => h("b", { "data-tone": tone }, children as string) };
});

const E18 = 10n ** 18n;
const TX_CLOSE = `0x${"c".repeat(64)}`;
const TX_OPEN = `0x${"a".repeat(64)}`;

function history(rows: CycleRow[], over: Record<string, unknown> = {}) {
  vi.mocked(useCycleHistory).mockReturnValue({ rows, source: "indexer", error: undefined, isLoading: false, ...over } as never);
}
const html = () => renderToStaticMarkup(createElement(ActivityPage));
const text = (s = html()) => s.replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/\s+/g, " ");
/** The cells of the row whose first cell is `#cycle`. */
function cells(out: string, cycle: number): string[] {
  const tr = out.match(new RegExp(`<tr><td[^>]*>#${cycle}</td>.*?</tr>`))![0];
  return [...tr.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<"));
}
const tone = (out: string, cycle: number) => out.match(new RegExp(`#${cycle}</td>.*?data-tone="([a-z]+)"`))![1];

const filled: CycleRow = {
  cycle: 3, settled: true, filled: true, contractsSold: 4n, contractsAssigned: 0n, strikeUsdg: 160_000_000n, closedAt: 1_700_000_000,
  premiumGrossUsdg: 10_000_000n, feeUsdg: 500_000n, premiumNetUsdg: 9_500_000n, strikeProceedsUsdg: 0n, premiumNetPerShare: 95_000n,
  assetsAtHarvest: 100n * E18, spotUsdgAtHarvest: 150_000_000n, txClose: TX_CLOSE, txOpen: TX_OPEN,
} as CycleRow;
const unfilled: CycleRow = { cycle: 2, settled: true, filled: false } as CycleRow;
const assigned: CycleRow = { ...filled, cycle: 1, contractsAssigned: 2n, strikeProceedsUsdg: 320_000_000n, feeUsdg: 250_000n, premiumNetUsdg: 4_750_000n, premiumGrossUsdg: 5_000_000n, txClose: undefined } as CycleRow;
const open: CycleRow = { cycle: 4, settled: false, filled: false, contractsSold: 1n } as CycleRow;

beforeEach(() => {
  C.vault = "0x00000000000000000000000000000000000000aa";
  history([open, filled, unfilled, assigned]);
});

describe("the totals", () => {
  it("weeks closed with filled/unfilled; net premium and fee summed over closed weeks; assigned and strike proceeds apart", () => {
    const t = text();
    expect(t).toContain("Weeks closed 3 2 filled · 1 unfilled");
    expect(t).toContain("Net premium to depositors 14.25 after 0.75 protocol fee");
    expect(t).toContain("Contracts assigned 2 320 USDG strike proceeds");
  });

  it("a filled week with no known net premium makes the net total a dash; an assigned week with no proceeds, the proceeds total", () => {
    history([{ ...filled, premiumNetUsdg: undefined }, { ...assigned, strikeProceedsUsdg: undefined }]);
    const t = text();
    expect(t).toContain("Net premium to depositors — after");
    expect(t).toContain("— USDG strike proceeds");
  });
});

describe("the rows", () => {
  it("a filled week: every figure, the per-share premium to 6 decimals, net/TVL, the closing tx", () => {
    const out = html();
    expect(cells(out, 3)).toEqual(["#3", "T1700000000", "160", "4", "0", "10", "0.50", "9.50", "0", "0.095", "<0.1%", "filled", "0xcccccc…"]);
    expect(out).toContain(`href="https://`);
    expect(out).toContain(`title="${TX_CLOSE}"`);
    expect(tone(out, 3)).toBe("accent");
  });

  it("an unfilled week: zeros, not dashes; neutral chip; no tx is a dash", () => {
    const row = cells(html(), 2);
    expect(row.slice(3, 9)).toEqual(["0", "0", "0", "0", "0", "0"]);
    expect(row[2]).toBe("—");
    expect(row[12]).toBe("—");
    expect(tone(html(), 2)).toBe("neutral");
  });

  it("an assigned week: strike proceeds in their own column, the opening tx when there is no closing one, a USDG chip", () => {
    const out = html();
    const row = cells(out, 1);
    expect(row[4]).toBe("2");
    expect(row[8]).toBe("320");
    expect(row[12]).toBe("0xaaaaaa…");
    expect(tone(out, 1)).toBe("usdg");
  });

  it("an open week is neutral and its sold count falls back to `contracts`", () => {
    history([{ ...open, contractsSold: undefined, contracts: 5n } as CycleRow]);
    const out = html();
    expect(cells(out, 4)[3]).toBe("5");
    expect(tone(out, 4)).toBe("neutral");
  });

  it("stranded and not recovered is danger; recovered is warn; unfilled-but-assigned (an incomplete record) is warn", () => {
    history([{ ...filled, stranded: true }, { ...assigned, cycle: 7, stranded: true, strandRecovered: true }, { ...unfilled, cycle: 8, contractsAssigned: 1n }]);
    const out = html();
    expect(tone(out, 3)).toBe("danger");
    expect(tone(out, 7)).toBe("warn");
    expect(tone(out, 8)).toBe("warn");
    expect(cells(out, 8)[8], "assigned with no proceeds recorded").toBe("—");
  });

  it("a filled week missing its premium figures shows dashes, not zeros", () => {
    history([{ ...filled, premiumGrossUsdg: undefined, premiumNetUsdg: undefined, premiumNetPerShare: undefined, strikeUsdg: undefined, closedAt: undefined }]);
    const row = cells(html(), 3);
    expect([row[1], row[2], row[5], row[7], row[9], row[10]]).toEqual(["—", "—", "—", "—", "—", "—"]);
  });
});

describe("empty and error states", () => {
  it("the empty sentence follows the state: no vault, loading, no source, nothing closed", () => {
    history([]);
    expect(text()).toContain("No week has closed yet.");
    expect(text()).toContain("indexer");
    history([], { isLoading: true, source: "chain" });
    expect(text()).toContain("Loading…");
    expect(text()).toContain("rebuilt from vault logs");
    history([], { source: "none" });
    expect(text()).toContain("History is unavailable right now.");
    expect(text()).toContain("no source");
    C.vault = undefined;
    const t = text();
    expect(t).toContain("Set a vault address to load its weekly history.");
    expect(t).toContain("No vault address configured.");
  });

  it("a history error is shown", () => {
    history([filled], { error: "Indexer unreachable; rebuilt from logs." });
    expect(text()).toContain("Indexer unreachable; rebuilt from logs.");
  });
});
