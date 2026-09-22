/**
 * UX review item 6, the maker scores table: `minWidth={790}`, two screens of sideways scroll on a
 * 390px phone. Below `sm` it is now a card list carrying all nine columns.
 *
 * AUTHORED, NOT RUN — this worktree is not hydrated (vitest and tsc both exit 127). Reported, not
 * repaired.
 *
 * WHY THIS IS A SOURCE TEST AND NOT A RENDER TEST, stated rather than left as an omission:
 * `MakersPage` is a client component driven by `useInfiniteQuery`, `useAccount` and the v2 api
 * client, and there is no existing MakersPage render harness to extend — `TrustPage.test.ts`
 * renders `TrustPageView`, a presentational split this page does not have. Rather than invent
 * that split inside a mobile-layout row, this asserts the binding: the page uses the responsive
 * pair, and every column heading in the table also appears as a card field label. The card
 * RENDERING itself is covered by `RecordCards.test.ts`, which does render. The gap that remains
 * is that nothing renders this page's cards with real data, and that is in the ledger.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

  it("does not fix the width by hiding columns below sm", () => {
    // The explicitly forbidden fix. If someone later reaches for it, this is where it shows up.
    const cardBlock = source.slice(source.indexOf("TableOrCards"), source.indexOf("</TableOrCards>"));
    expect(cardBlock).not.toContain("hidden sm:table-cell");
    expect(cardBlock).not.toContain("max-sm:hidden");
  });
});
