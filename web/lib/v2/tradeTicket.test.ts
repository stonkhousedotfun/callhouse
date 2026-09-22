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
vi.mock("@/lib/v2/hooks", () => ({ useConfig: vi.fn(), v2Keys: { all: ["v2"] } }));

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
  it("starts dollar-first, promotes outcome and max loss, and renders the payoff before input", () => {
    const html = render();
    expect(html).toContain("Amount to spend");
    expect(html).toContain("$10");
    expect(html).toContain("$50");
    expect(html).toContain("$200");
    expect(html).toContain("Max");
    expect(html).toContain("Estimated settlement value if TSLA reaches $400");
    expect(html).toContain("Pay · max loss");
    expect(html.indexOf("Estimated settlement value")).toBeLessThan(html.indexOf("Pay · max loss"));
    expect(html).toContain("USDG conversion may deliver less or fall back to tokens");
    expect(html).toContain("Explore the payoff");
    expect(html).toContain("<summary");
    expect(html).toContain("Advanced</summary>");
    expect(html).not.toContain("<details open");
  });

  it("honours the W4 discriminated prefill contract and the legacy shares route", () => {
    const prefilled = render({ initialPrefill: { kind: "shares", shares: "0.1" } });
    expect(prefilled).toContain("Quantity in shares");
    expect(prefilled).toContain('id="ticket-shares"');
    expect(prefilled).toContain('value="0.1"');
    expect(prefilled).not.toContain("Amount to spend");

    const legacy = render({ initialShares: "1" });
    expect(legacy).toContain('value="1"');
    expect(legacy).not.toContain("Amount to spend");
  });
});
