/**
 * Every trade button follows OrderBook's trading brake, and every trade click re-reads it on chain BEFORE its
 * first write. The brake's two halves are tested in lib/v2/tradingGate.test.ts and the ask preflight's in
 * lib/v2/earnTx.createSeries.test.ts; this file pins that each call site uses them, read from source the way
 * ChainTimeChecks.test.ts pins the chain clock.
 *
 * WHAT THE BRAKE DOES NOT TOUCH, pinned too: OrderBook.cancel and every Clearinghouse call (close, redeem, deposit,
 * withdraw) never read `tradingPaused`, so Cancel, Close matched units and Collect must stay open under it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
function body(text: string, start: string, nested = false): string {
  const at = text.indexOf(start);
  expect(at, start).toBeGreaterThan(-1);
  const end = text.slice(at + start.length).search(nested ? /\n\s+(?:async )?function / : /\n(?:async )?function |\nexport |\nconst /);
  return end === -1 ? text.slice(at) : text.slice(at, at + start.length + end);
}
/** `first` appears in `text`, and before `then`. */
function before(text: string, first: string, then: string) {
  const a = text.indexOf(first);
  const b = text.indexOf(then);
  expect(a, first).toBeGreaterThan(-1);
  expect(b, then).toBeGreaterThan(-1);
  expect(a, `${first} before ${then}`).toBeLessThan(b);
}

const portfolio = source("./Portfolio.tsx");

describe("the trade buttons shut on the brake", () => {
  it("SellTicket (the Sell page and the market page's Sell mode): Place ask", () => {
    const earn = source("./sell/SellTicket.tsx");
    expect(earn).toContain("const askTrading = tradingOpen(market);");
    expect(earn).toMatch(/<Button disabled=\{!canWrite \|\| !askTrading \|\|[^}]*\} onClick=\{\(\) => void listAsk\(\)\}>/);
  });

  it("TradeTicket: Buy now and Place bid (writeReady), from the market's brake the rail passes in", () => {
    expect(source("./TradeTicket.tsx")).toMatch(/const writeReady = Boolean\([^\n]*!tradingPaused[^\n]*\);/);
    expect(source("./SeriesPage.tsx")).toContain("tradingPaused={!tradingOpen(market)}");
  });

  it("Portfolio: Sell now, List for sale, the resale listing, Buy back and close, Edit and Save replacement", () => {
    const long = body(portfolio, "function LongCard(");
    expect(long).toMatch(/disabled=\{!ready \|\| !trading \|\|[^}]*\}\s*onClick=\{\(\) => void run\(`\$\{key\}-sell`/);
    expect(long).toContain("disabled={!ready || !trading || Boolean(busy)} onClick={() => setListing((value) => !value)}>List for sale");
    expect(long).toMatch(/disabled=\{!ready \|\| !trading \|\|[^}]*\}\s*onClick=\{\(\) => void run\(`\$\{key\}-list`/);
    const short = body(portfolio, "function ShortCard(");
    expect(short).toMatch(/disabled=\{!ready \|\| !trading \|\|[^}]*\}\s*onClick=\{\(\) => void run\(`\$\{key\}-buyback`/);
    const order = body(portfolio, "function OrderCard(");
    expect(order).toContain("editDisabled={!ready || !trading ||");
    expect(order).toContain("disabled={!ready || !trading || Boolean(busy)} onClick={() => void run(`${key}-edit`");
  });

  it("each card gets its own market's brake", () => {
    expect(portfolio).toContain("const tradingFor = (ticker: string) => tradingOpen(");
    for (const card of ["<LongCard ", "<ShortCard ", "<OrderCard "]) {
      const at = portfolio.indexOf(card);
      expect(portfolio.slice(at, portfolio.indexOf("\n", at)), card).toMatch(/trading=\{tradingFor\((item|order)\.series\.ticker\)\}/);
    }
  });

  it("Cancel, Close matched units and Collect never read it: the contracts do not", () => {
    expect(body(portfolio, "function OrderCard(")).toContain("cancelDisabled={!exitReady || Boolean(busy)}");
    const short = body(portfolio, "function ShortCard(");
    expect(short).toMatch(/disabled=\{!exitReady \|\| Boolean\(busy\) \|\| walletBalance\.data === undefined \|\| !units \|\| units > available\}\s*onClick=\{\(\) => void run\(`\$\{key\}-close`/);
    for (const card of ["function LongCard(", "function ShortCard("])
      expect(body(portfolio, card), card).toMatch(/disabled=\{!exitReady \|\| Boolean\(busy\) \|\| walletBalance\.data === undefined \|\| !payoutPrefs\}\s*onClick=\{\(\) => void run\(`\$\{key\}-collect`/);
  });

  it("MATCH, pinned: Close matched units shows until the series settles (Clearinghouse.close refuses AlreadySettled, and works after expiry until then)", () => {
    expect(body(portfolio, "function ShortCard(")).toContain('const closeAllowed = position.series.status !== "settled";');
  });
});

describe("the lending redeem button is capped at the wallet's shares", () => {
  it("LendVault: the redeem button and its line follow lendRedeemOverBalance on the vault read's balance", () => {
    const lend = source("./LendVault.tsx");
    // The cap moved into lendRedeemInput, which parses AND caps at the vault's decimals() and calls
    // lendRedeemOverBalance on the balance given here (lib/v2/lendTx.test.ts pins that at 6 and 18 dp).
    expect(lend).toContain(
      "const { shares: redeemShares, over: redeemOver } = lendRedeemInput(redeemAmount, shareDecimals, address ? reads.data?.balance : null);");
    expect(lend).toContain("disabled={!exitReady || !!busy || !redeemShares || redeemOver !== null}");
  });
});

describe("each trade click re-reads the brake before its first write", () => {
  it("TradeTicket: before the buy's approval and the bid's approval", () => {
    const submit = body(source("./TradeTicket.tsx"), "async function submit()", true);
    before(submit, "await assertTradingOpen(", "await executeCrossing(");
    before(submit, "await assertTradingOpen(", "await approveExact(");
  });

  it("Portfolio: selling, listing and buying back check before the token or USDG approval", () => {
    before(body(portfolio, "async function sellNow(", true), "await assertTradingOpen(", "await approval(");
    before(body(portfolio, "async function list(", true), "await assertTradingOpen(", "await approval(");
    const buyBack = body(portfolio, "async function buyBack(", true);
    before(buyBack, "await assertTradingOpen(", "await approveExact(");
  });

  it("Portfolio: an edit checks before anything, because a crossing resale edit CANCELS the old ask first", () => {
    const edit = body(portfolio, "async function editOrder(", true);
    before(edit, "await assertTradingOpen(", "await cancel(");
    before(edit, "await assertTradingOpen(", "await approveExact(");
    before(edit, "await assertTradingOpen(", "await replace(");
  });
});
