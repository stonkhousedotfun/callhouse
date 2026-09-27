/**
 * FreezeBanner: which v1 markets are halted comes from each factory's writesHalted() (only a successful `true` counts),
 * and the freeze date comes from the registry, formatted as a New York calendar date.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useReadContracts } from "wagmi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FreezeBanner } from "./FreezeBanner";

const M = vi.hoisted(() => ({ list: [] as Array<{ ticker: string; factory: string }> }));
vi.mock("wagmi", () => ({ useReadContracts: vi.fn() }));
vi.mock("@/lib/legacy", () => ({ get LEGACY_MARKETS() { return M.list; } }));

const F1 = "0x00000000000000000000000000000000000000f1";
const F2 = "0x00000000000000000000000000000000000000f2";
const html = (dates: Record<string, number | null> = {}) => renderToStaticMarkup(createElement(FreezeBanner, { dates }));

beforeEach(() => {
  M.list = [{ ticker: "NVDA", factory: F1 }, { ticker: "TSLA", factory: F2 }];
  vi.mocked(useReadContracts).mockReturnValue({ data: undefined } as never);
});

describe("FreezeBanner", () => {
  it("asks each factory for writesHalted, every 30s", () => {
    html();
    const cfg = vi.mocked(useReadContracts).mock.lastCall![0] as unknown as { contracts: Array<{ address: string; functionName: string }>; query: object };
    expect(cfg.contracts.map((c) => [c.address, c.functionName])).toEqual([[F1, "writesHalted"], [F2, "writesHalted"]]);
    expect(cfg.query).toEqual({ enabled: true, refetchInterval: 30_000 });
  });

  it("names only the markets whose read succeeded with true", () => {
    vi.mocked(useReadContracts).mockReturnValue({ data: [{ status: "success", result: true }, { status: "failure", result: true }] } as never);
    expect(html()).toContain(" New sales are paused on chain for NVDA.");
    vi.mocked(useReadContracts).mockReturnValue({ data: [{ status: "success", result: true }, { status: "success", result: true }] } as never);
    expect(html()).toContain("paused on chain for NVDA, TSLA.");
    vi.mocked(useReadContracts).mockReturnValue({ data: [{ status: "success", result: false }, { status: "success", result: 1 }] } as never);
    expect(html()).not.toContain("paused on chain");
  });

  it("freeze dates are New York calendar dates; null or zero dates are left out", () => {
    // 2026-01-01T00:00:00Z is still 31 December in New York.
    const out = html({ NVDA: 1_767_225_600, TSLA: null });
    expect(out).toContain(" Freeze date: NVDA December 31, 2025.");
    expect(html({ NVDA: 1_767_225_600, TSLA: 1_767_312_000 })).toContain("Freeze date: NVDA December 31, 2025 · TSLA January 1, 2026.");
    expect(html({ NVDA: 0 })).not.toContain("Freeze date");
  });

  it("always says the exits remain; no markets means no reads", () => {
    M.list = [];
    const out = html();
    expect(out).toContain("New listings have moved to v2.");
    expect(out).toContain("You can still settle, withdraw and exercise here.");
    const cfg = vi.mocked(useReadContracts).mock.lastCall![0] as unknown as { query: { enabled: boolean } };
    expect(cfg.query.enabled).toBe(false);
  });
});
