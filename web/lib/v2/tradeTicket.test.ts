import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useAccount, useWalletClient } from "wagmi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import type { BookResponse, Card, ConfigResponse, SeriesDetailResponse } from "@/lib/v2/api-types";
import { useConfig } from "@/lib/v2/hooks";
import { TradeTicket } from "@/components/v2/TradeTicket";

vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn(), useQueryClient: vi.fn() }));
vi.mock("wagmi", () => ({ useAccount: vi.fn(), useWalletClient: vi.fn() }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => createElement("button", null, "Connect wallet") }));
vi.mock("@/components/TxToast", () => ({ useNotice: vi.fn(), useV2ReceiptNotice: vi.fn() }));
// The ticket's PayoffExplainers reads the markets to learn whether a live market enables puts. Unread here.
vi.mock("@/lib/v2/hooks", () => ({ useConfig: vi.fn(), useMarkets: vi.fn(() => ({ data: undefined, isError: false })), v2Keys: { all: ["v2"] } }));

const fixtures = fileURLToPath(new URL("../../../ops/fixtures/api/v2/", import.meta.url));
const read = <T>(path: string): T => JSON.parse(readFileSync(`${fixtures}/${path}`, "utf8")) as T;
const hero = read<{ card: Card }>("cards/hero.json").card;
const detail = read<SeriesDetailResponse>(`series/${hero.series.longId}.json`);
const book = read<BookResponse>(`series/${hero.series.longId}/book.json`);
const config = read<ConfigResponse>("config.json");
const emptyQuery = { data: undefined, isError: false, isPending: false, isFetching: false, refetch: vi.fn() };

beforeEach(() => {
  vi.mocked(useAccount).mockReturnValue({ address: undefined } as ReturnType<typeof useAccount>);
  vi.mocked(useWalletClient).mockReturnValue({ data: undefined } as ReturnType<typeof useWalletClient>);
  vi.mocked(useQueryClient).mockReturnValue({ invalidateQueries: vi.fn() } as unknown as ReturnType<typeof useQueryClient>);
  vi.mocked(useQuery).mockReturnValue(emptyQuery as never);
  vi.mocked(useConfig).mockReturnValue({ ...emptyQuery, data: config } as unknown as ReturnType<typeof useConfig>);
  vi.mocked(useNotice).mockReturnValue(vi.fn() as ReturnType<typeof useNotice>);
  vi.mocked(useV2ReceiptNotice).mockReturnValue(vi.fn() as ReturnType<typeof useV2ReceiptNotice>);
});

function render(overrides: Partial<ComponentProps<typeof TradeTicket>> = {}): string {
  return renderToStaticMarkup(createElement(TradeTicket, {
    ticker: hero.series.ticker,
    detail,
    book,
    target: BigInt(hero.target.raw),
    spot: BigInt(hero.spot!.raw),
    marketSettlement: undefined,
    onRefresh: vi.fn(),
    ...overrides,
  }));
}

describe("Polymarket-style trade ticket", () => {
  it("opens as a limit order at the best ask for 0.10 share, with the estimated cost, the outcome and the payoff explorer", () => {
    const html = render();
    expect(html).toContain('for="ticket-bid-price"');
    expect(html).toMatch(/id="ticket-bid-price"[^>]*value="0.3989"/);
    expect(html).toMatch(/id="ticket-shares"[^>]*value="0.10"/);
    expect(html).toContain(">Bid<");
    expect(html).toContain(">Mark<");
    expect(html).toContain(">Ask<");
    expect(html).toContain("Estimated cost");
    expect(html).toContain('data-slot="max-loss"');
    expect(html).toContain(">If TSLA reaches $400");
    expect(html).toContain("Buys now");
    expect(html).toContain("USDG conversion may deliver less or fall back to tokens");
    expect(html).toContain("Explore the payoff");
    expect(html).toContain("<summary");
    expect(html).toMatch(/<summary[^>]*>.*Advanced<\/span>/);
    expect(html).not.toContain("<details open");
  });

  it("honours the W4 discriminated prefill contract and the legacy shares route", () => {
    const prefilled = render({ initialPrefill: { kind: "shares", shares: "0.1" } });
    expect(prefilled).toContain('for="ticket-shares" class="text-[13px] font-semibold text-ink-2">Shares</label>');
    expect(prefilled).toMatch(/id="ticket-shares"[^>]*value="0.1"/);

    const legacy = render({ initialShares: "1" });
    expect(legacy).toMatch(/id="ticket-shares"[^>]*value="1"/);

    const budget = render({ initialPrefill: { kind: "budget", amountUsdg: "50" } });
    expect(budget).toMatch(/id="ticket-shares"[^>]*value="0.10"/);
  });
});
