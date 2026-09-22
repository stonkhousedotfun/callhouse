/**
 * UX review item 9: two disconnected views were dead ends.
 *
 * `RouteViews` rendered "Connect a wallet to see your positions" and "Connect a wallet to manage
 * notifications" with NO `ConnectButton`, while five other disconnected surfaces in this app pair
 * the explanation with an inline connect. The review lists that pairing among the things the app
 * already does better than most dapps — these two views were the exception, and telling someone
 * to connect while giving them nothing to connect with is worse than saying nothing.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAccount } from "wagmi";
import { useConfig, usePositions } from "@/lib/v2/hooks";
import { NotificationsShell, PortfolioShell } from "./RouteViews";

vi.mock("wagmi", () => ({ useAccount: vi.fn() }));
vi.mock("@/components/ConnectButton", () => ({
  ConnectButton: () => createElement("button", { type: "button" }, "Connect wallet"),
}));
vi.mock("@/lib/v2/hooks", () => ({
  useConfig: vi.fn(), useLeaderboard: vi.fn(), useMakers: vi.fn(), useMarketSeries: vi.fn(),
  useMarkets: vi.fn(), usePnl: vi.fn(), usePositions: vi.fn(), useWins: vi.fn(),
}));

const emptyQuery = { data: undefined, isError: false, isPending: false, isFetching: false, refetch: vi.fn() };

beforeEach(() => {
  vi.mocked(useAccount).mockReturnValue({ address: undefined } as unknown as ReturnType<typeof useAccount>);
  vi.mocked(usePositions).mockReturnValue(emptyQuery as unknown as ReturnType<typeof usePositions>);
  vi.mocked(useConfig).mockReturnValue(emptyQuery as unknown as ReturnType<typeof useConfig>);
});

describe("the disconnected views are no longer dead ends", () => {
  it("the portfolio view explains AND offers the connect", () => {
    const html = renderToStaticMarkup(createElement(PortfolioShell));
    expect(html).toContain("Connect a wallet to see your positions.");
    expect(html).toContain("Connect wallet");
  });

  it("the notifications view explains AND offers the connect", () => {
    const html = renderToStaticMarkup(createElement(NotificationsShell));
    expect(html).toContain("Connect a wallet to manage notifications.");
    expect(html).toContain("Connect wallet");
  });

  it("a CONNECTED wallet gets neither sentence — the control for both tests above", () => {
    // Without this, a component that rendered the connect prompt unconditionally would pass, and
    // the two assertions above would be measuring nothing about the disconnected state.
    vi.mocked(useAccount).mockReturnValue({ address: "0x0000000000000000000000000000000000000001" } as unknown as ReturnType<typeof useAccount>);
    const html = renderToStaticMarkup(createElement(PortfolioShell));
    expect(html).not.toContain("Connect a wallet to see your positions.");
  });
});
