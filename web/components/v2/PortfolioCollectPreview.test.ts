/**
 * Portfolio's Collect: Clearinghouse.previewRedeem is shown on the long card and on the short card BEFORE the
 * Collect button, for the card's own token id, and a revert says "cannot preview", never a number. Rendered with the
 * preview query answered, so removing either card's line turns its case red. A file of its own because it mocks
 * react-query (the cards read the wallet balance, the book, fair value, the series and the chain clock through it);
 * Portfolio.test.ts renders pure views and keeps the real module.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { useQuery } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LongPosition, PositionsResponse, ShortPosition } from "@/lib/v2/api-types";
import { CANNOT_PREVIEW, formatOptionRedeemPreview, type OptionRedeemPreview } from "@/lib/v2/moneyPreviews";
import { LongCard, ShortCard } from "./Portfolio";

vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn(), useQueryClient: vi.fn(), useInfiniteQuery: vi.fn() }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));

const fixture = <T>(wallet: string) => JSON.parse(readFileSync(fileURLToPath(new URL(
  `../../../ops/fixtures/api/v2/accounts/${wallet}/positions.json`, import.meta.url)), "utf8")) as T;
const longs = fixture<PositionsResponse>("0xE37876AcBfbA6186E4687f4ef465D9AC21558De3").longs;
const shorts = fixture<PositionsResponse>("0xD6b49a27Ead99118b61F0827C7aB2782aea07bE6").shorts;
const account = "0x00000000000000000000000000000000000000c3" as const;
const ASSET = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as const;
const settled = <P extends LongPosition | ShortPosition>(p: P): P => ({ ...p, series: { ...p.series, status: "settled" as const } });
const long = settled(longs[0]!);
const short = settled(shorts[0]!);
const unread = { data: undefined, isPending: false, isError: false };

/** The wallet holds 5 units (so the card offers Collect) and the preview query answers `preview`. */
const answer = (preview: Record<string, unknown>) => vi.mocked(useQuery).mockImplementation(((options: { queryKey?: unknown }) => {
  const key = options?.queryKey;
  const name = Array.isArray(key) && key[0] === "v2" ? String(key[1]) : "";
  if (name === "wallet-long" || name === "wallet-short") return { ...unread, data: 5n };
  return name === "option-redeem-preview" ? { ...unread, ...preview } : unread;
}) as never);
const previewKeys = () => vi.mocked(useQuery).mock.calls.map(([options]) => (options as { queryKey: unknown[] }).queryKey)
  .filter((key) => key[1] === "option-redeem-preview");
afterEach(() => { vi.mocked(useQuery).mockReset(); });

const common = { history: [], account, payoutPrefs: { inKind: false, toLedger: false }, run: async () => {}, ready: true,
  exitReady: true, busy: null, fees: null, trading: true };
const renderLong = (position: LongPosition = long) => renderToStaticMarkup(createElement(LongCard, { ...common, position,
  now: position.series.expiry + 3_600, resaleFeeBps: 0, pendingFees: null, withdrawalTiming: null }));
const renderShort = (position: ShortPosition = short) => renderToStaticMarkup(createElement(ShortCard, { ...common, position,
  now: position.series.expiry + 3_600, spot: null, usdg: null }));
const line = (html: string) => html.match(/<p data-slot="option-redeem-preview"[^>]*>([^<]*)<\/p>/)?.[1] ?? null;

const ok: OptionRedeemPreview = { ok: true, units: 5n, asset: ASSET, owed: 4_620_000_000_000_000n, minUsdgOut: 4_500_000n };

describe.each([
  ["long", renderLong, long.series.longId],
  ["short", renderShort, short.series.shortId],
] as const)("the settled %s card shows previewRedeem before Collect", (_side, render, tokenId) => {
  it("the units, the asset, the amount owed and the USDG floor, for this card's own token id", () => {
    answer({ data: ok });
    const html = render();
    expect(html).toContain(">Collect</button>");
    expect(line(html)).toBe(formatOptionRedeemPreview(ok));
    expect(line(html)).toBe(`Collecting would redeem 5 units of ${ASSET} and pay 4620000000000000 base units of that asset, `
      + "at least 4.50 USDG if converted.");
    expect(html.indexOf('data-slot="option-redeem-preview"')).toBeLessThan(html.indexOf(">Collect</button>"));
    expect(previewKeys().map((key) => key[2])).toEqual([tokenId]);
  });

  it("pending, then a revert: says so, and shows no number", () => {
    answer({ isPending: true });
    expect(line(render())).toBe("Checking what collecting would pay…");
    answer({ data: { ok: false } });
    const html = render();
    expect(line(html)).toBe(CANNOT_PREVIEW);
    expect(html).not.toContain("Collecting would redeem");
  });
});

describe("no Collect, no preview", () => {
  it("an open position asks nothing and shows no line", () => {
    answer({ data: ok });
    expect(line(renderLong(longs.find((p) => p.series.status === "open")!))).toBeNull();
    expect(line(renderShort(shorts.find((p) => p.series.status === "open")!))).toBeNull();
    expect(previewKeys()).toEqual([]);
  });
});

/**
 * ShortCard's wallet short balance (`wallet-short`, Clearinghouse.balanceOf) that
 * failed to read, or has not answered yet, is not 0 shares: the card must not ask for "up to 0 shares" (it showed that
 * role="alert" line on a failed read), and a failed read says the balance is unavailable, as LongCard does. An OPEN
 * short renders the size field whatever the clock (closeAllowed), so the alert line is reachable in every case here; the
 * answered case is the positive control that it does render.
 */
describe("ShortCard never turns an unread wallet balance into 0 shares", () => {
  const openShort = shorts.find((p) => p.series.status === "open")!;
  const wallet = (result: Record<string, unknown>) => vi.mocked(useQuery).mockImplementation(((options: { queryKey?: unknown }) => {
    const key = options?.queryKey;
    return Array.isArray(key) && key[0] === "v2" && key[1] === "wallet-short" ? { ...unread, ...result } : unread;
  }) as never);
  const UNAVAILABLE = "Wallet balance unavailable. Actions are paused until it loads.";

  it("a failed read shows the unavailable notice and no size limit", () => {
    wallet({ isError: true });
    const html = renderShort(openShort);
    expect(html).toContain(`id="buyback-size-${openShort.series.longId}"`);
    expect(html).toContain(UNAVAILABLE);
    expect(html).not.toContain("Choose up to");
  });

  it("a read that has not answered yet shows neither", () => {
    wallet({ isPending: true });
    const html = renderShort(openShort);
    expect(html).toContain(`id="buyback-size-${openShort.series.longId}"`);
    expect(html).not.toContain(UNAVAILABLE);
    expect(html).not.toContain("Choose up to");
  });

  it("an answered balance smaller than the size still asks for at most that balance (positive control)", () => {
    wallet({ data: 5n });
    const html = renderShort(openShort);
    expect(BigInt(openShort.units)).toBeGreaterThan(5n);
    expect(html).toContain("Choose up to 0.05 shares in 0.01 steps.");
    expect(html).not.toContain(UNAVAILABLE);
  });
});
