/**
 * MarketAccessGate after the launch clocks went. Three routes a market page can take, each from chain facts:
 *   (a) enabled on chain -> the page, even when the indexer lists no markets (the 2026-09-22 locked-page bug);
 *   (b) registered, not enabled -> the faded LockedMarket page with a static line and no clock;
 *   (c) not registered -> NotListedMarket.
 * The launch gates (and the fallback enabled read) come through React Query; the mock answers per query key.
 */
import { useQuery } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn() }));
vi.mock("@/lib/v2/hooks", () => ({ useMarkets: vi.fn() }));

import { useMarkets } from "@/lib/v2/hooks";
import type { LaunchGates } from "@/lib/v2/launchGates";
import { NOT_LISTED_LABEL } from "@/lib/v2/marketAccess";
import { MarketAccessGate } from "./MarketAccessGate";

function answer(gates: LaunchGates | undefined, gatesError = false) {
  vi.mocked(useQuery).mockImplementation(((options: { queryKey: readonly unknown[] }) => {
    if (options.queryKey[1] === "launchGates") return { data: gates, isError: gatesError };
    // The indexer-error fallback read; never reached while the indexer answers.
    return { data: undefined, isError: false, isPending: true };
  }) as unknown as typeof useQuery);
}

/** `/v2/markets` answered 200 with an empty array: absence of evidence, not a "disabled" verdict. */
const indexerListsNothing = () =>
  vi.mocked(useMarkets).mockReturnValue({ data: [], isError: false } as unknown as ReturnType<typeof useMarkets>);

const page = (props: { registered: boolean }) => renderToStaticMarkup(createElement(MarketAccessGate,
  { ticker: "NVDA", registered: props.registered, releaseStatus: "live" } as Parameters<typeof MarketAccessGate>[0],
  createElement("main", { "data-slot": "market-page" }, "NVDA market page")));

beforeEach(() => indexerListsNothing());

describe("MarketAccessGate", () => {
  it("(a) enabled on chain renders the page even though the indexer lists no markets", () => {
    answer({ trading: { NVDA: true }, house: {} });
    const html = page({ registered: true });
    expect(html).toContain('data-slot="market-page"');
    expect(html).not.toMatch(/<fieldset disabled/);
    expect(html).not.toContain("Trading is not open yet");
  });

  it("control: the same indexer answer with the chain saying not enabled locks the page", () => {
    answer({ trading: { NVDA: false }, house: {} });
    expect(page({ registered: true })).toMatch(/<fieldset disabled/);
  });

  it("(b) registered but not enabled renders LockedMarket: static line, controls off, no timer and no clock digits", () => {
    answer({ trading: { NVDA: false }, house: { NVDA: false } });
    const html = page({ registered: true });
    expect(html).toContain("NVDA is listed. Trading is not open yet.");
    expect(html).toContain('data-slot="market-page"');
    expect(html).toMatch(/<fieldset disabled=""/);
    expect(html).not.toContain('role="timer"');
    expect(html).not.toMatch(/\d\d:\d\d:\d\d|--:--:--/);
  });

  it("an unread launch gate never opens the page on its own", () => {
    answer(undefined);
    expect(page({ registered: true })).toMatch(/<fieldset disabled/);
    answer(undefined, true);
    expect(page({ registered: true })).toMatch(/<fieldset disabled/);
  });

  it("(c) an unregistered market renders NotListedMarket, never the page or the locked view", () => {
    answer({ trading: { NVDA: true }, house: {} });
    const html = page({ registered: false });
    expect(html).toContain(NOT_LISTED_LABEL);
    expect(html).not.toContain('data-slot="market-page"');
    expect(html).not.toMatch(/<fieldset/);
  });
});
