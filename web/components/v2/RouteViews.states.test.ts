/**
 * RouteViews: the shared StatePanel (loading skeleton, failed-with-no-data notice with the error text and a retry,
 * stale-data banner, empty panel, data) through each shell, and the config-mismatch notice. Fixtures are the API
 * fixtures in ops/fixtures/api/v2.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAccount } from "wagmi";
import { v2ConfigWarnings } from "@/lib/v2/config";
import { useConfig, useMakers, useMarkets, usePnl, usePositions } from "@/lib/v2/hooks";
import { EarnShell, MakersShell, NotificationsShell, PnlShell, PortfolioShell, V2ConfigNotice } from "./RouteViews";

vi.mock("wagmi", () => ({ useAccount: vi.fn() }));
vi.mock("@/components/ConnectButton", () => ({
  ConnectButton: () => createElement("button", { type: "button" }, "Connect wallet"),
}));
vi.mock("@/lib/v2/hooks", () => ({
  useConfig: vi.fn(), useMakers: vi.fn(), useMarketSeries: vi.fn(), useMarkets: vi.fn(), usePnl: vi.fn(), usePositions: vi.fn(),
}));
vi.mock("@/lib/v2/config", async (orig) => ({ ...(await orig<typeof import("@/lib/v2/config")>()), v2ConfigWarnings: vi.fn() }));

const fx = (path: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../ops/fixtures/api/v2/${path}`, import.meta.url)), "utf8"));
const markets = fx("markets.json");
const makers = fx("makers.json");
const pnl = fx("pnl/87928758254318692721909164101369622513960639781458875980445111726519827316414-0x300a7AB2f92B536e3f58422372c964B2Bb535ea2.json");

const ADDRESS = "0x0000000000000000000000000000000000000001";
function q(over: Record<string, unknown> = {}) {
  return { data: undefined, isPending: false, isError: false, error: null, refetch: vi.fn(), ...over } as never;
}
const html = (c: unknown, props: object = {}) => renderToStaticMarkup(createElement(c as never, props));

beforeEach(() => {
  vi.mocked(useAccount).mockReturnValue({ address: ADDRESS } as unknown as ReturnType<typeof useAccount>);
  for (const h of [useConfig, useMakers, useMarkets, usePnl, usePositions]) vi.mocked(h).mockReturnValue(q());
  vi.mocked(v2ConfigWarnings).mockReturnValue([]);
});

describe("StatePanel states (through the shells)", () => {
  it("pending with no data: a labelled loading skeleton, nothing else", () => {
    vi.mocked(useMarkets).mockReturnValue(q({ isPending: true }));
    const out = html(EarnShell);
    expect(out).toContain('role="status"');
    expect(out).toContain('aria-label="Loading market data"');
    expect(out).toContain("animate-pulse");
    expect(out).not.toContain("Live data is unavailable.");
    expect(out, "the writer warning is always shown").toContain("Premium arrives only when a buyer fills.");
  });

  it("failed with no data: the unavailable notice, the error message and a retry", () => {
    vi.mocked(useMakers).mockReturnValue(q({ isError: true, error: new Error("HTTP 503 from indexer") }));
    const out = html(MakersShell);
    expect(out).toContain("Live data is unavailable.");
    expect(out).toContain("HTTP 503 from indexer");
    expect(out).toMatch(/<button[^>]*>Try again<\/button>/);
  });

  it("no data and no error object: the notice without an error line", () => {
    const out = html(MakersShell);
    expect(out).toContain("Live data is unavailable.");
    expect(out).not.toContain('class="mt-1 text-xs"');
  });

  it("pending but with cached data shows the data, not the skeleton", () => {
    vi.mocked(useMakers).mockReturnValue(q({ isPending: true, data: makers }));
    const out = html(MakersShell);
    expect(out).not.toContain("Loading market data");
    expect(out).toContain("Epoch 2958");
    expect(out).toContain("3 makers scored.");
  });

  it("an error with cached data: the data plus a 'refresh is delayed' banner", () => {
    vi.mocked(useMakers).mockReturnValue(q({ isError: true, data: makers }));
    const out = html(MakersShell);
    expect(out).toContain("Showing the latest available data. Refresh is delayed.");
    expect(out).toContain("Epoch 2958");
  });

  it("makers: an empty epoch says so", () => {
    vi.mocked(useMakers).mockReturnValue(q({ data: { ...makers, items: [] } }));
    expect(html(MakersShell)).toContain("No maker scores published for this epoch.");
  });
});

describe("EarnShell", () => {
  it("lists only live markets, each linking to its sell page", () => {
    vi.mocked(useMarkets).mockReturnValue(q({ data: [...markets, { ...markets[0], ticker: "AAPL", status: "planned" }] }));
    const out = html(EarnShell);
    expect(out).toContain('href="/sell/nvda"');
    expect(out).toContain('href="/sell/tsla"');
    expect(out).not.toContain("/sell/aapl");
    expect(out).toContain("Tesla • Robinhood Token");
  });

  it("no live market: the empty text", () => {
    vi.mocked(useMarkets).mockReturnValue(q({ data: markets.map((m: object) => ({ ...m, status: "paused" })) }));
    const out = html(EarnShell);
    expect(out).toContain("No writing markets are open yet.");
    expect(out).not.toContain("/sell/");
  });
});

describe("PortfolioShell counts", () => {
  it("counts longs, shorts and orders separately", () => {
    vi.mocked(usePositions).mockReturnValue(q({ data: { longs: [1, 2], shorts: [1], orders: [1, 2, 3] } }));
    const out = html(PortfolioShell);
    expect(vi.mocked(usePositions)).toHaveBeenCalledWith(ADDRESS);
    expect(out).toMatch(/Long positions<\/h2><p[^>]*>2</);
    expect(out).toMatch(/Short positions<\/h2><p[^>]*>1</);
    expect(out).toMatch(/Open orders<\/h2><p[^>]*>3</);
  });

  it("all three empty: the empty text", () => {
    vi.mocked(usePositions).mockReturnValue(q({ data: { longs: [], shorts: [], orders: [] } }));
    expect(html(PortfolioShell)).toContain("No positions or open orders for this wallet yet.");
  });
});

describe("PnlShell", () => {
  it("names the series and states multiple, cost to payout, and the max loss", () => {
    vi.mocked(usePnl).mockReturnValue(q({ data: pnl }));
    const out = html(PnlShell, { id: "x" });
    expect(vi.mocked(usePnl)).toHaveBeenCalledWith("x");
    expect(out).toContain("NVDA $210 call");
    expect(out).toContain("3.8×");
    expect(out).toContain("0.462 → 1.770299 USDG");
    expect(out).toContain("Max loss was 0.462 USDG.");
  });

  it("a put is labelled put", () => {
    vi.mocked(usePnl).mockReturnValue(q({ data: { ...pnl, series: { ...pnl.series, isPut: true } } }));
    expect(html(PnlShell, { id: "x" })).toContain("NVDA $210 put");
  });
});

describe("NotificationsShell connected", () => {
  it("with config: the placeholder that controls arrive with the notifier", () => {
    vi.mocked(useConfig).mockReturnValue(q({ data: {} }));
    const out = html(NotificationsShell);
    expect(out).toContain("Notification controls will appear when the notifier is connected.");
    expect(out).not.toContain("Connect a wallet");
  });
});

describe("V2ConfigNotice", () => {
  it("renders nothing without config or with a matching config", () => {
    expect(html(V2ConfigNotice)).toBe("");
    vi.mocked(useConfig).mockReturnValue(q({ data: { chainId: 4663 } }));
    expect(html(V2ConfigNotice)).toBe("");
    expect(vi.mocked(v2ConfigWarnings)).toHaveBeenCalledWith({ chainId: 4663 });
  });

  it("lists each difference and counts them", () => {
    vi.mocked(useConfig).mockReturnValue(q({ data: {} }));
    vi.mocked(v2ConfigWarnings).mockReturnValue(["Indexer chain differs from this app.", "USDG address differs from this app."]);
    const out = html(V2ConfigNotice);
    expect(out).toContain("App and indexer configuration differ.");
    expect(out).toContain("Trade actions must wait for matching deployment settings.");
    expect(out).toContain("Show 2 configuration differences");
    expect(out).toContain("<li>Indexer chain differs from this app.</li><li>USDG address differs from this app.</li>");
  });
});
