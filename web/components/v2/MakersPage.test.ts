/**
 * UX review item 6, the maker scores table: `minWidth={790}`, two screens of sideways scroll on a
 * 390px phone. Below `sm` it is now a card list carrying all nine columns.
 *
 *
 *
 *
 * WHY THIS IS A SOURCE TEST AND NOT A RENDER TEST, stated rather than left as an omission:
 * `MakersPage` is a client component driven by `useInfiniteQuery`, `useAccount` and the v2 api
 * client, and there is no existing MakersPage render harness to extend — `TrustPage.test.ts`
 * renders `TrustPageView`, a presentational split this page does not have. Rather than invent
 * that split inside a mobile-layout row, this asserts the binding: the page uses the responsive
 * pair, and every column heading in the table also appears as a card field label. The card
 * RENDERING itself is covered by `RecordCards.test.ts`, which does render. The gap that remains
 * is that nothing renders this page's cards with real data, and that is a known gap.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { makerRebateShare, makerScript } from "./MakersPage";

const source = readFileSync(fileURLToPath(new URL("./MakersPage.tsx", import.meta.url)), "utf8");

/** The nine columns the table has carried since the page shipped. */
const COLUMNS = ["Maker", "Score", "Uptime", "Spread", "Depth (units)", "Fills", "Volume", "Rebates", "Tier share"];

describe("maker scores on a phone", () => {
  it("the source was actually read — the control for every assertion below", () => {
    // Without this, a renamed or moved file would make `source` empty and every `toContain`
    // below would fail loudly rather than a `not.toContain` passing for the wrong reason.
    expect(source.length).toBeGreaterThan(1_000);
    expect(source).toContain("export function MakersPage");
  });

  it("uses the responsive pair rather than a bare wide table", () => {
    expect(source).toContain("TableOrCards");
    expect(source).toContain('cardsLabel="Maker scores for the latest epoch"');
  });

  it("EVERY table column also appears as a card field label", () => {
    // The one that matters. Drop a column from the card list and this names it.
    const cardBlock = source.slice(source.indexOf("TableOrCards"), source.indexOf("</TableOrCards>"));
    for (const column of COLUMNS.slice(1)) {
      expect(cardBlock, `${column} is missing from the card fields`).toContain(`label: "${column}"`);
    }
    // The first column is the maker address, which becomes the card's title rather than a field.
    expect(cardBlock).toContain("shortAddress(row.maker)");
  });

  it("keeps the connected wallet's row highlighted in the card layout too", () => {
    expect(source).toContain("highlighted: address?.toLowerCase() === row.maker.toLowerCase()");
  });

  it("formats every figure through the shared number rules, with no zero tails", () => {
    // Before: row.score.toFixed(1) ("91.0"), the indexer's full-precision USDG strings, and bps as raw integers.
    const cardBlock = source.slice(source.indexOf("TableOrCards"), source.indexOf("</TableOrCards>"));
    expect(cardBlock).toContain("TableOrCards"); // the control: the slice is the card and table block
    expect(cardBlock).not.toContain(".toFixed(");
    expect(cardBlock).not.toContain(".formatted");
    expect(source).not.toContain("Intl.NumberFormat");
    expect(source).toContain('from "@/lib/numberFormat"');
  });

  it("does not fix the width by hiding columns below sm", () => {
    // The explicitly forbidden fix. If someone later reaches for it, this is where it shows up.
    const cardBlock = source.slice(source.indexOf("TableOrCards"), source.indexOf("</TableOrCards>"));
    expect(cardBlock).not.toContain("hidden sm:table-cell");
    expect(cardBlock).not.toContain("max-sm:hidden");
  });
});

/**
 * The "Fill rebates" figure is OrderBook `makerRebateBps`, which the fee manager can change. It used to come
 * from the generated registry (the launch value) only, so after a fee change the page kept showing the old share.
 * It now reads /v2/config `fees.makerRebateBps` and uses the registry only while that is loading or unavailable.
 */
describe("maker rebate share: the live value, the registry only as a fallback", () => {
  it("prefers the live /v2/config value over the registry's launch value", () => {
    expect(makerRebateShare({ makerRebateBps: 4_000 }, 5_000)).toEqual({ bps: 4_000, source: "live" });
    expect(makerRebateShare({ makerRebateBps: 0 }, 5_000)).toEqual({ bps: 0, source: "live" });
  });

  it("falls back to the registry value, labelled as such, while the live value is missing or unusable", () => {
    expect(makerRebateShare(undefined, 5_000)).toEqual({ bps: 5_000, source: "registry" });
    expect(makerRebateShare({ makerRebateBps: 10_001 }, 5_000)).toEqual({ bps: 5_000, source: "registry" });
    expect(makerRebateShare({ makerRebateBps: 1.5 }, "5000")).toEqual({ bps: 5_000, source: "registry" });
  });

  it("shows nothing rather than a made-up 0 when neither is usable", () => {
    for (const registry of [undefined, null, "", "abc", -1, 10_001]) {
      expect(makerRebateShare(undefined, registry)).toEqual({ bps: null, source: "registry" });
    }
  });

  it("the page wires the live config into the panel and labels the fallback", () => {
    expect(source).toContain("const config = useConfig();");
    expect(source).toContain("makerRebateShare(config.data?.fees, V2_DEPLOYMENT.fees?.makerRebateBps)");
    expect(source).not.toContain("const rebateBps = Number(V2_DEPLOYMENT.fees?.makerRebateBps)");
    expect(source).toContain("Launch setting shown; the current rate has not loaded.");
  });
});

/**
 * (measured on a v9 fork): the published sample's orders mined, but the book never listed them
 * and no take could fill them, because the sample never approved the order book as the maker's Clearinghouse operator.
 * Its validUntil also came from the machine's clock, while the book judges block.timestamp. The app's own ask flow
 * (EarnMarket listAsk) sets the operator first; the sample now does the same.
 */
describe("the quoting sample produces an order the book can fill", () => {
  it("approves the order book as Clearinghouse operator BEFORE placing", () => {
    const setOp = makerScript.indexOf("functionName: 'setOperator', args: [orderBook, true]");
    const place = makerScript.indexOf("functionName: 'place'");
    expect(setOp, "setOperator(orderBook, true) is in the sample").toBeGreaterThan(-1);
    expect(place, "place is in the sample").toBeGreaterThan(-1);
    expect(setOp).toBeLessThan(place);
    // It is sent to the Clearinghouse with the Clearinghouse ABI, not to the book.
    expect(makerScript).toContain("address: clearinghouse, abi: clearinghouseAbi,\n    functionName: 'setOperator'");
    expect(makerScript).toContain("import { clearinghouseAbi } from './lib/abi/v2/clearinghouse';");
    // Skipped only when the chain already says the book is this maker's operator.
    expect(makerScript).toContain("functionName: 'isOperator', args: [account.address, orderBook]");
  });

  it("counts validUntil from the latest block's timestamp, not the machine's clock", () => {
    expect(makerScript).toContain("await publicClient.getBlock({ blockTag: 'latest' })");
    expect(makerScript).toContain("const validUntil = Number(head.timestamp) + 3600;");
    expect(makerScript).not.toContain("Date.now()");
  });

  it("says an AskWrite needs free collateral AND the book as Clearinghouse operator, in the sample and on the page", () => {
    expect(makerScript).toMatch(/AskWrite needs BOTH free collateral in the Clearinghouse ledger AND the order book approved as your\n\/\/ Clearinghouse operator/);
    expect(source).toContain("needs free collateral in the Clearinghouse and the order book approved as your Clearinghouse operator");
    expect(source).toContain("<code>{makerScript}</code>");
  });
});
