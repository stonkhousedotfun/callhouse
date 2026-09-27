/**
 * The deadline and expiry checks tested here take the chain's clock, not the browser's. The clock itself
 * is tested in lib/v2/chainClock.test.ts and the ask preflight's in lib/v2/earnTx.createSeries.test.ts; this file pins
 * that each named call site uses it. Countdown ticks (`setNow(Math.floor(Date.now() / 1000))`) are display and stay.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
/**
 * The text from `start` up to the next declaration at the same depth: top level by default, or the next sibling
 * function inside a component when `nested` (the component's own handlers are indented `async function`s).
 */
function body(text: string, start: string, nested = false): string {
  const at = text.indexOf(start);
  expect(at, start).toBeGreaterThan(-1);
  const end = text.slice(at + start.length).search(nested ? /\n\s+(?:async )?function / : /\n(?:async )?function |\nexport |\nconst /);
  return end === -1 ? text.slice(at) : text.slice(at, at + start.length + end);
}

describe("chain time at the named deadline checks", () => {
  it("SellTicket: the ask's validUntil counts from the preflight block, not Date.now()", () => {
    const listAsk = body(source("./sell/SellTicket.tsx"), "async function listAsk()", true);
    expect(listAsk).toContain("nextAskExpiry(beforePlace.now, cutoff)");
    expect(listAsk).not.toContain("Date.now()");
  });

  it("Portfolio: selling into bids checks each bid's validUntil against the chain's clock", () => {
    const sell = body(source("./Portfolio.tsx"), "async function executeSellQuote(");
    expect(sell).toContain("await chainNow(context.client ?? publicClient)");
    expect(sell).not.toContain("Date.now()");
  });

  it("Portfolio: an order card's Expired label and Edit gate read the chain-clock tick", () => {
    const card = body(source("./Portfolio.tsx"), "function OrderCard(");
    expect(card).toContain("const chainNowS = onChainClock(now || null, useChainClockOffset());");
    expect(card).toContain("chainNowS !== null && order.validUntil <= chainNowS ? \"Expired; cancel to recover escrow\"");
    // The trading brake is on the same gate; the chain-clock half is unchanged.
    expect(card).toContain("editDisabled={!ready || !trading || Boolean(busy) || chainNowS === null || order.validUntil <= chainNowS}");
    expect(card).not.toMatch(/order\.validUntil <= now\b/);
  });

  it("Portfolio: a held long's and a written option's trade window read the chain-clock tick", () => {
    for (const start of ["function LongCard(", "function ShortCard("]) {
      const card = body(source("./Portfolio.tsx"), start);
      expect(card, start).toContain("const chainNowS = onChainClock(now || null, useChainClockOffset());");
      expect(card, start).toContain("tradeWindowOpen(position.series, chainNowS)");
      expect(card, start).not.toMatch(/now < position\.series\.expiry/);
    }
  });

  it("TradeTicket: the expired pre-check reads the chain-clock tick", () => {
    const ticket = source("./TradeTicket.tsx");
    expect(ticket).toContain("const chainNowS = onChainClock(now, useChainClockOffset());");
    expect(ticket).toContain("const expired = chainNowS === null || chainNowS >= detail.series.expiry");
    expect(ticket).not.toMatch(/const expired = now === null/);
  });
});
