/**
 * MarketSwitcher: v2 (NEXT_PUBLIC_V2=1) is a picker over the registry that routes to /<ticker> (or /sell/<ticker> from a
 * sell page); v1 is a native select that keeps the current section. Handlers are driven by calling the component
 * functions directly (they use no React state), so the routing is asserted, not just the markup.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { usePathname, useRouter } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarketPicker } from "@/components/v2/MarketPicker";
import type { Market } from "@/lib/v2/api-types";
import { useMarkets } from "@/lib/v2/hooks";
import { MarketSwitcher } from "./MarketSwitcher";

vi.mock("next/navigation", () => ({ usePathname: vi.fn(), useRouter: vi.fn() }));
vi.mock("@/lib/v2/hooks", () => ({ useMarkets: vi.fn() }));
vi.mock("@/components/v2/MarketPicker", () => ({ MarketPicker: vi.fn(() => null) }));

const markets = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../ops/fixtures/api/v2/markets.json", import.meta.url)), "utf8"),
) as Market[];
const push = vi.fn();

function at(pathname: string | null) {
  vi.mocked(usePathname).mockReturnValue(pathname as string);
}
type Props = Record<string, unknown>;
/** Unwrap MarketSwitcher -> inner switcher element -> its rendered tree. */
function tree(): ReactElement<Props> {
  const outer = MarketSwitcher({ className: "c" }) as ReactElement<Props>;
  const inner = outer.type as (p: Props) => ReactElement<Props>;
  return inner(outer.props);
}

beforeEach(() => {
  push.mockReset();
  vi.mocked(useRouter).mockReturnValue({ push } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useMarkets).mockReturnValue({ data: markets, isError: false } as unknown as ReturnType<typeof useMarkets>);
});
afterEach(() => vi.unstubAllEnvs());

describe("v2 switcher", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_V2", "1"));

  it("on a market page it selects that market and routes a pick to the new market page", () => {
    at("/nvda/some-series");
    const el = tree();
    expect(el.type).toBe(MarketPicker);
    expect(el.props.selected).toBe("NVDA");
    expect(el.key).toBe("NVDA");
    expect(el.props.className).toBe("c");
    expect((el.props.markets as { ticker: string }[]).map((m) => m.ticker).sort()).toEqual(["NVDA", "SPCX"]);
    (el.props.onSelect as (t: string) => void)("SPCX");
    expect(push).toHaveBeenCalledWith("/spcx");
  });

  it("on /sell/<ticker> it keeps the sell section", () => {
    at("/sell/spcx");
    const el = tree();
    expect(el.props.selected).toBe("SPCX");
    (el.props.onSelect as (t: string) => void)("NVDA");
    expect(push).toHaveBeenCalledWith("/sell/nvda");
  });

  it("a generic page (or an unknown ticker) has no preselected market", () => {
    at("/portfolio");
    expect(tree().props.selected).toBe("");
    at("/sell");
    expect(tree().props.selected, "/sell alone is not a sell market page").toBe("");
    at(null);
    expect(tree().props.selected).toBe("");
  });

  it("loading and error states still list the registry markets (not tradeable)", () => {
    at("/nvda");
    vi.mocked(useMarkets).mockReturnValue({ data: undefined, isError: false } as unknown as ReturnType<typeof useMarkets>);
    expect((tree().props.markets as { availability: string }[]).every((m) => m.availability === "checking")).toBe(true);
    vi.mocked(useMarkets).mockReturnValue({ data: markets, isError: true } as unknown as ReturnType<typeof useMarkets>);
    const rows = tree().props.markets as { availability: string; tradeable: boolean }[];
    expect(rows.every((m) => m.availability === "unavailable" && !m.tradeable)).toBe(true);
    expect(tree().props.selected, "the ticker is still in the registry").toBe("NVDA");
  });
});

describe("legacy switcher", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_V2", "0"));

  function select(el: ReactElement<Props>): ReactElement<Props> {
    const kids = el.props.children as ReactElement<Props>[];
    return kids.find((k) => k?.type === "select")!;
  }

  it("renders a native select of live v1 markets with the current one selected", () => {
    at("/nvda/trade");
    const html = renderToStaticMarkup(createElement(MarketSwitcher));
    expect(html).toContain('data-slot="market-switcher"');
    expect(html).toContain('<option value="NVDA" selected="">NVDA</option>');
    expect(html).toContain('<span class="sr-only">Market</span>');
  });

  it("choosing the same market is a no-op; another keeps the section (default 'account')", () => {
    at("/nvda/book");
    const sel = select(tree());
    expect(sel.props.value).toBe("NVDA");
    const onChange = sel.props.onChange as (e: { target: { value: string } }) => void;
    onChange({ target: { value: "NVDA" } });
    expect(push).not.toHaveBeenCalled();
    onChange({ target: { value: "TSLA" } });
    expect(push).toHaveBeenCalledWith("/tsla/book");

    at("/nvda/trade");
    expect(select(tree()).props.value, "a known market with an unknown section").toBe("NVDA");
    (select(tree()).props.onChange as (e: { target: { value: string } }) => void)({ target: { value: "TSLA" } });
    expect(push, "an unknown section falls back to account").toHaveBeenLastCalledWith("/tsla/account");

    at("/portfolio");
    const fallback = select(tree());
    expect(fallback.props.value, "an unknown path falls back to the default market").toBe("NVDA");
    (fallback.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: "AAPL" } });
    expect(push).toHaveBeenLastCalledWith("/aapl/account");
  });
});
