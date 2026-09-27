import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/v2/hooks", () => ({ useHouse: vi.fn(), useHouseVaultReads: vi.fn() }));
// The real usdgText, wrapped so a test can see that the card formats through it and not a private copy.
vi.mock("@/lib/v2/houseRows", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/v2/houseRows")>();
  return { ...real, usdgText: vi.fn(real.usdgText) };
});

import { HOUSE_ARMING_UNREAD } from "@/components/v2/LaunchCountdown";
import { useHouse, useHouseVaultReads } from "@/lib/v2/hooks";
import type { HouseVaultReads } from "@/lib/v2/chainReads";
import { VAULT_MARK_LABEL_UNDATED } from "@/lib/v2/vaultCopy";
import { HouseCardFigures, HouseOverview } from "./HouseOverview";
import { houseWindDownHeadline } from "@/lib/v2/houseWindDown";
import { usdgText } from "@/lib/v2/houseRows";

const vault = "0x0000000000000000000000000000000000000066";
const reads = (over: Partial<HouseVaultReads> = {}): HouseVaultReads => ({
  nav: 184_220_000_000n, totalSupply: 178_130n * 10n ** 18n, balance: null, performanceFeeBps: 0, epochPerformanceFeeBps: 0, performanceFeeCeilBps: 2000,
  highWaterMark: null, splitter: null, oracle: null, lastSettlementPrice: null, limits: null, protocolAccountsConfirmed: true, ...over,
});

beforeEach(() => {
  // The card's cadence is the /v2/house `kind` (the launch vaults are weekly by their factory), not a chain read.
  vi.mocked(useHouse).mockReturnValue({ data: { items: [{ market: "NVDA", vault, kind: "weekly", currentEpoch: { id: "3", start: 1, end: 1_789_156_800, nav: null, resultUsdg: null } }] },
    isError: false, isPending: false } as unknown as ReturnType<typeof useHouse>);
  vi.mocked(useHouseVaultReads).mockReturnValue({ data: reads() } as unknown as ReturnType<typeof useHouseVaultReads>);
});

/** The index card gains the labelled mark, TVL and cadence; never a rate. */
// React escapes the apostrophe; compare against the rendered form rather than retyping the escaped sentence.
const asRendered = (copy: string) => copy.replace(/'/g, "&#x27;");

describe("HouseOverview", () => {
  it("shows the mark per share and TVL, each with the not-a-live-price label, and the cadence badge", () => {
    const html = renderToStaticMarkup(createElement(HouseOverview));
    // The money rule truncates toward zero: 184,220 / 178,130 = 1.03418.. -> "1.0341" (Intl rounded it to 1.0342).
    expect(html).toContain("1.0341 USDG");
    // The total goes through the money rule: compact from 10,000, no zero tail ("184,220.00" before).
    expect(html).toContain("184.2K USDG");
    expect(html).not.toContain("184,220.00");
    expect(html).toMatch(/Vault total<span[^>]*><button[^>]*aria-label="About vault total"/);
    expect(html.split(VAULT_MARK_LABEL_UNDATED).length - 1).toBe(2);
    expect(html.match(/role="tooltip"[^>]*>as of the last close · not a live price</g)).toHaveLength(2);
    expect(html).toContain("Weekly");
    expect(html).not.toMatch(/APY|APR|per year/i);
  });

  it("a daily vault gets the Daily badge; an unread vault says not read, never 0", () => {
    vi.mocked(useHouseVaultReads).mockReturnValue({ data: reads({ nav: null }) } as unknown as ReturnType<typeof useHouseVaultReads>);
    const html = renderToStaticMarkup(createElement(HouseCardFigures, { vault, kind: "daily" }));
    expect(html).toContain("Daily");
    expect(html).toContain(asRendered("priced at today's close"));
    expect(html.split("not read").length - 1).toBe(2);
    expect(html).not.toContain(">0.00 USDG<");
  });

  it("the SPCX daily vault's card says Daily, Fridays only; NVDA's daily card is unchanged", () => {
    vi.mocked(useHouseVaultReads).mockReturnValue({ data: reads({ nav: null }) } as unknown as ReturnType<typeof useHouseVaultReads>);
    const spcx = renderToStaticMarkup(createElement(HouseCardFigures, { vault, kind: "daily", market: "SPCX" }));
    expect(spcx).toContain("Daily, Fridays only");
    expect(spcx).toContain(asRendered("priced at today's close"));
    expect(spcx).not.toContain(asRendered("after today's options settle"));
    const nvda = renderToStaticMarkup(createElement(HouseCardFigures, { vault, kind: "daily", market: "NVDA" }));
    expect(nvda).not.toContain("Fridays only");
    expect(nvda).toContain(asRendered("after today's options settle"));
  });

  it("the lede no longer promises once a week for every vault", () => {
    const html = renderToStaticMarkup(createElement(HouseOverview));
    // reworded short; still names both cadences and never promises weekly for every vault.
    expect(html).toContain("once a day, or once a week for a weekly vault");
  });

  it("an unknown or absent kind is labelled unknown on the card, never Weekly", () => {
    for (const kind of ["unknown", undefined] as const) {
      const html = renderToStaticMarkup(createElement(HouseCardFigures, { vault, kind }));
      // The badge wording (lib/v2/houseCopy.ts houseCadenceBadge).
      expect(html).toContain("Schedule unknown");
      expect(html).not.toMatch(/Weekly|Daily|Friday/);
    }
  });
});

/** Every listed vault card carries the indexer's earliestWithdrawal, worded, with the FAQ link. */
describe("/house cards: earliest withdrawal", () => {
  it("renders the boundary line from the item's earliestWithdrawal", () => {
    vi.mocked(useHouse).mockReturnValue({ data: { items: [{ market: "NVDA", vault, kind: "daily",
      currentEpoch: { id: "3", start: 1, end: 1_789_156_800, nav: null, resultUsdg: null },
      earliestWithdrawal: { kind: "daily", at: 1_789_156_800, reason: "epoch-boundary" } }] },
      isError: false, isPending: false } as unknown as ReturnType<typeof useHouse>);
    const html = renderToStaticMarkup(createElement(HouseOverview));
    expect(html).toContain("Earliest withdrawal:");
    expect(html).toContain('data-earliest-withdrawal="epoch-boundary"');
    expect(html).toMatch(/After (today|tomorrow)&#x27;s 4pm ET close|After the 4pm ET close on /);
    expect(html).toContain("/faq#house-vault");
  });
});

/**
 * No launch clock on /house. Each card says whether ITS vault quotes, from that vault's own
 * protocolAccountsConfirmed read -- so a daily and a weekly vault of one market no longer share one arming state.
 */
describe("/house: per-vault quoting line, no clock", () => {
  const noClock = (html: string) => {
    expect(html).not.toContain('role="timer"');
    expect(html).not.toMatch(/quotes in|house-countdown/);
    // The next close is now a <time dateTime="2026-…T20:00:00.000Z">, whose machine-readable attribute holds an
    // hh:mm:ss. A ticking clock is visible text, so the hh:mm:ss check reads the text the card shows, tags removed.
    expect(html.replace(/<[^>]*>/g, "")).not.toMatch(/\d\d:\d\d:\d\d/);
  };

  it("an armed vault's card says it is quoting", () => {
    const html = renderToStaticMarkup(createElement(HouseOverview));
    expect(html).toContain('data-armed="true"');
    expect(html).toContain("The NVDA house vault is quoting.");
    noClock(html);
  });

  it("a vault not armed says so, statically", () => {
    vi.mocked(useHouseVaultReads).mockReturnValue({ data: reads({ protocolAccountsConfirmed: false }) } as unknown as ReturnType<typeof useHouseVaultReads>);
    const html = renderToStaticMarkup(createElement(HouseOverview));
    expect(html).toContain("The NVDA house vault is not quoting yet. Deposits open when it is.");
    noClock(html);
  });

  it("a failed arming read is said, not hidden, and never reads as quoting", () => {
    for (const mocked of [{ data: reads({ protocolAccountsConfirmed: null }) }, { data: reads(), isError: true }]) {
      vi.mocked(useHouseVaultReads).mockReturnValue(mocked as unknown as ReturnType<typeof useHouseVaultReads>);
      const html = renderToStaticMarkup(createElement(HouseOverview));
      expect(html).toContain(HOUSE_ARMING_UNREAD);
      expect(html).not.toContain("is quoting.");
    }
  });

  it("two vaults of one market carry their own arming, keyed by vault", () => {
    const weekly = "0x00000000000000000000000000000000000000e1";
    const daily = "0x00000000000000000000000000000000000000e2";
    vi.mocked(useHouse).mockReturnValue({ data: { items: [
      { market: "NVDA", vault: weekly, kind: "weekly", currentEpoch: null },
      { market: "NVDA", vault: daily, kind: "daily", currentEpoch: null },
    ] }, isError: false, isPending: false } as unknown as ReturnType<typeof useHouse>);
    vi.mocked(useHouseVaultReads).mockImplementation(((address: string) =>
      ({ data: reads({ protocolAccountsConfirmed: address === daily }) })) as unknown as typeof useHouseVaultReads);
    const html = renderToStaticMarkup(createElement(HouseOverview));
    // daily first: its card is armed, the weekly card is not.
    expect([...html.matchAll(/data-armed="(\w+)"/g)].map((m) => m[1])).toEqual(["true", "false"]);
  });
});

/**
 * Once a daily vault is listed, daily vaults lead the page and each weekly card
 * says it is winding down, with the boundary to withdraw at. A market may then list two vaults.
 */
describe("/house: daily first, weekly winding down", () => {
  const WEEKLY = "0x0000000000000000000000000000000000000071";
  const DAILY = "0x0000000000000000000000000000000000000072";
  const END = 1_789_156_800;
  const item = (market: string, address: string, kind: "weekly" | "daily") =>
    ({ market, vault: address, kind, currentEpoch: { id: "3", start: 1, end: END, nav: null, resultUsdg: null } });
  const listed = (items: ReturnType<typeof item>[]) =>
    vi.mocked(useHouse).mockReturnValue({ data: { items }, isError: false, isPending: false } as unknown as ReturnType<typeof useHouse>);

  it("the daily vault's card comes before the weekly one, and only the weekly card carries the wind-down line", () => {
    listed([item("NVDA", WEEKLY, "weekly"), item("NVDA", DAILY, "daily")]);
    const html = renderToStaticMarkup(createElement(HouseOverview));
    expect(html.indexOf(">Daily<")).toBeGreaterThan(-1);
    expect(html.indexOf(">Daily<")).toBeLessThan(html.indexOf(">Weekly<"));
    expect(html.split('data-slot="house-wind-down"').length - 1).toBe(1);
    expect(html).toContain(asRendered(houseWindDownHeadline(END)));
    expect(html.indexOf('data-slot="house-wind-down"')).toBeGreaterThan(html.indexOf(">Daily<"));
  });

  it("control: weekly only (the launch state) shows no wind-down line", () => {
    listed([item("NVDA", WEEKLY, "weekly"), item("SPCX", "0x0000000000000000000000000000000000000073", "weekly")]);
    const html = renderToStaticMarkup(createElement(HouseOverview));
    expect(html).not.toContain('data-slot="house-wind-down"');
    expect(html).not.toContain("Winding down");
  });
});

/** A market with a weekly and a daily vault shows two cards, and each opens its own vault's page. */
describe("/house cards link their own vault", () => {
  it("two NVDA cards (weekly and daily) have two different hrefs, each carrying its own vault", () => {
    const weekly = "0x00000000000000000000000000000000000000c3";
    const daily = "0x00000000000000000000000000000000000000d4";
    vi.mocked(useHouse).mockReturnValue({ data: { items: [
      { market: "NVDA", vault: weekly, kind: "weekly", currentEpoch: null, sharesSupply: null },
      { market: "NVDA", vault: daily, kind: "daily", currentEpoch: null, sharesSupply: null },
    ], nextCursor: null }, isError: false, isPending: false } as unknown as ReturnType<typeof useHouse>);
    const html = renderToStaticMarkup(createElement(HouseOverview));
    const hrefs = [...html.matchAll(/href="(\/house\/[^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([`/house/nvda?vault=${daily}`, `/house/nvda?vault=${weekly}`]);
  });
});

/**
 * The card's figures go through houseRows' usdgText, whose minimum fraction digits are clamped to the maximum
 * The private copy this file had fixed the minimum at 2, so a caller at 0 or 1 places threw a RangeError.
 */
describe("/house cards format USDG through the one clamped usdgText", () => {
  // (no zero tails): the card now formats through lib/format's fmtUsdg (rules), so
  // it no longer calls usdgText at all. What guarded -- no private copy that can throw -- still holds: the
  // shared formatter is the only one used, and usdgText keeps its clamp (next case).
  it("the mark and the total on the card go through the shared fmtUsdg, not a private copy or usdgText", () => {
    vi.mocked(usdgText).mockClear();
    const html = renderToStaticMarkup(createElement(HouseCardFigures, { vault, kind: "weekly" }));
    expect(vi.mocked(usdgText)).not.toHaveBeenCalled();
    for (const text of ["1.0341 USDG", "184.2K USDG"]) expect(html).toContain(text);
  });

  it("at 0 and 1 places it renders instead of throwing", () => {
    expect(usdgText(184_220_000_000n, 0)).toBe("184,220 USDG");
    expect(usdgText(184_220_000_000n, 1)).toBe("184,220.0 USDG");
  });
});
