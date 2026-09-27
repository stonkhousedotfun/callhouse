/**
 * The sell ticket's Review step locks the ask it reviewed. An untouched price follows the live fair value,
 * which refetches every 15 s, and strike, expiry, series and side come from the parent. Before this fix "Review order"
 * only set `reviewing`, and "Place ask" sent the live price: reviewed at 2.5 USDG, a refresh to 2 listed at 2 with no
 * second review. These tests review, change the fair value or a prop underneath, and assert that "Place ask" is blocked
 * and nothing is sent; then that a new review sends the new order, and that a typed price ignores fair refreshes.
 *
 * Harness (as in TradeTicket.review.test.ts): `react`'s useState/useMemo/useEffect are swapped for in-memory slots while
 * the ticket function runs, the element tree is searched for a control and its handler is called directly, and the next
 * render is read as markup. Every chain boundary is a mock, so a test asserts exactly what the ticket sends.
 */
import { createElement, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  active: false, cursor: 0, slots: [] as unknown[], effects: [] as (() => unknown)[],
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (init: unknown) => {
      if (!h.active) return actual.useState(init);
      const i = h.cursor++;
      if (!(i in h.slots)) h.slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
      return [h.slots[i], (next: unknown) => {
        h.slots[i] = typeof next === "function" ? (next as (v: unknown) => unknown)(h.slots[i]) : next;
      }];
    },
    useMemo: (fn: () => unknown, deps: unknown[]) => (h.active ? fn() : actual.useMemo(fn, deps)),
    useEffect: (fn: () => unknown, deps?: unknown[]) => (h.active ? void h.effects.push(fn) : actual.useEffect(fn as never, deps)),
  };
});

const ACCOUNT = "0x00000000000000000000000000000000000000a1" as Address;
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as Address;
const m = vi.hoisted(() => ({
  fair: "2500000" as string | null,
  isPut: false, // a put ticket, for the review card's collateral row
  notice: vi.fn(),
  receipt: vi.fn(() => false),
  preflightAsk: vi.fn(), createSeries: vi.fn(), nextAskExpiry: vi.fn(), readMintCutoff: vi.fn(),
  readWriterBalance: vi.fn(), readWriterRent: vi.fn(),
  place: vi.fn(), setOperator: vi.fn(), approveExact: vi.fn(), deposit: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => {
    const kind = options.queryKey[1];
    if (kind === "writerBalance") return { data: { free: 10n ** 22n, wallet: 10n ** 22n }, isError: false };
    if (kind === "writerRent") return { data: { rent: 0n, free: 10n ** 22n }, isError: false };
    return { data: undefined, isError: false };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("./useWriteGate", () => ({
  useWriteGate: () => ({
    address: ACCOUNT, wallet: { data: { id: "wallet" } },
    markets: { isError: false, data: [], refetch: vi.fn() },
    config: { data: { fees: { premiumFeeBps: 500 }, constants: { settlementWindow: 1800 }, pendingFees: null } },
    market: { ticker: "NVDA" }, isPut: m.isPut, underlying: NVDA, collateralAsset: NVDA, collateralDecimals: m.isPut ? 6 : 18,
    collateralLabel: "NVDA", spot: 180_000_000n, spotDecimals: 6, canWrite: true,
  }),
}));
vi.mock("@/lib/v2/hooks", () => ({
  useFair: () => ({ data: m.fair === null ? undefined : { fair: { raw: m.fair }, provenance: null } }),
  v2Keys: { all: ["v2"] },
}));
vi.mock("@/components/TxToast", () => ({ useNotice: () => m.notice, useV2ReceiptNotice: () => m.receipt }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));
vi.mock("@/components/v2/PendingOperationsNotice", () => ({ PendingOperationsNotice: () => null }));
vi.mock("@/components/v2/PendingFeeNotice", () => ({ PendingFeeNotice: () => null }));
vi.mock("@/components/v2/FairProvenanceNote", () => ({ FairProvenanceNote: () => null }));
vi.mock("@/components/ui/PayoutTiming", () => ({ PayoutTiming: () => null }));
vi.mock("@/lib/v2/earnTx", () => ({
  preflightAsk: m.preflightAsk, createSeries: m.createSeries, nextAskExpiry: m.nextAskExpiry, readMintCutoff: m.readMintCutoff,
  readWriterBalance: m.readWriterBalance, readWriterRent: m.readWriterRent,
}));
vi.mock("@/lib/v2/tx", () => ({ place: m.place, setOperator: m.setOperator, approveExact: m.approveExact, deposit: m.deposit }));
vi.mock("@/lib/v2/tradingGate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/tradingGate")>()), tradingOpen: () => true,
}));
vi.mock("@/lib/v2/upgradePause", () => ({ depositDoor: () => ({ open: true, note: null }) }));
vi.mock("@/lib/v2/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/v2/config")>();
  return { ...actual, requireV2Address: () => "0x00000000000000000000000000000000000000b0",
    V2_DEPLOYMENT: { ...actual.V2_DEPLOYMENT, contracts: { ...actual.V2_DEPLOYMENT.contracts,
      clearinghouse: "0x00000000000000000000000000000000000000c0", orderBook: "0x00000000000000000000000000000000000000b0",
      expiryCalendar: "0x00000000000000000000000000000000000000e0" } } };
});

import { displayQuantity } from "@/lib/numberFormat";

import { ASK_CHANGED_LINE, askDrift, SellTicket, type ReviewedAsk } from "./SellTicket";

const LONG_ID = "1234567890";
const EXPIRY = 1_790_000_000;
const STRIKE = 190_000_000n;
const row = {
  series: { longId: LONG_ID, strike: { raw: STRIKE.toString() }, expiry: EXPIRY, mintCutoff: EXPIRY - 1800 },
  quote: { fair: { raw: "2500000" }, bestAsk: null, fairProvenance: null },
} as unknown as ComponentProps<typeof SellTicket>["row"];

type Props = ComponentProps<typeof SellTicket>;
let props: Props;
let tree: ReactNode = null;
function run(): string {
  h.active = true; h.cursor = 0; h.effects = [];
  try { tree = SellTicket(props); } finally { h.active = false; }
  return renderToStaticMarkup(createElement("div", null, tree));
}
function mount(over: Partial<Props> = {}): string {
  props = { ticker: "NVDA", row, expiry: EXPIRY, ...over };
  return run();
}
type El = ReactElement<Record<string, unknown>>;
function findWhere(pred: (p: Record<string, unknown>) => boolean): El {
  const walk = (n: unknown): El | null => {
    if (Array.isArray(n)) { for (const c of n) { const r = walk(c); if (r) return r; } return null; }
    if (!isValidElement(n)) return null;
    const p = n.props as Record<string, unknown>;
    if (pred(p)) return n as El;
    for (const v of Object.values(p)) { const r = walk(v); if (r) return r; }
    return null;
  };
  const hit = walk(tree);
  if (!hit) throw new Error("no such element");
  return hit;
}
const textOf = (n: unknown): string => typeof n === "string" || typeof n === "number" ? String(n)
  : Array.isArray(n) ? n.map(textOf).join("") : isValidElement(n) ? textOf((n.props as { children?: unknown }).children) : "";
const button = (label: string) => findWhere((p) => typeof p.onClick === "function" && textOf(p.children) === label);
const click = (label: string) => { (button(label).props.onClick as () => void)(); return run(); };
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
async function pressPlace(): Promise<string> {
  (button("Place ask").props.onClick as () => void)();
  await flush();
  return run();
}
const typePrice = (value: string) => {
  (findWhere((p) => p.id === "ask-price").props.onChange as (e: unknown) => void)({ target: { value } });
  return run();
};
const typeShares = (value: string) => {
  (findWhere((p) => p.id === "ask-size").props.onChange as (e: unknown) => void)({ target: { value } });
  return run();
};
/** A review-card row's value as text, by its label. */
const rowValue = (html: string, k: string) =>
  html.match(new RegExp(`>${k.replace(/[()]/g, "\\$&")}</dt><dd[^>]*>(.*?)</dd>`))?.[1]?.replace(/<[^>]+>/g, "") ?? null;

beforeEach(() => {
  h.slots = []; h.effects = [];
  m.fair = "2500000";
  m.isPut = false;
  for (const fn of [m.notice, m.receipt, m.preflightAsk, m.createSeries, m.nextAskExpiry, m.readMintCutoff, m.readWriterBalance,
    m.readWriterRent, m.place, m.setOperator, m.approveExact, m.deposit]) fn.mockReset();
  m.receipt.mockReturnValue(false);
  m.preflightAsk.mockResolvedValue({ longId: BigInt(LONG_ID), operator: true, exists: true, now: EXPIRY - 86_400, mintCutoff: EXPIRY - 1800 });
  m.nextAskExpiry.mockReturnValue(EXPIRY - 1800);
  m.place.mockResolvedValue("0xplace");
});
afterEach(() => { vi.restoreAllMocks(); });

describe("a fair-value refresh cannot change the reviewed ask", () => {
  it("reviewed at 2.5, fair refetched to 2: Place ask is disabled, the notice shows, and nothing is sent", async () => {
    mount();
    let html = click("Review order");
    expect(html).toContain("at $2.5 per share or more");
    expect(button("Place ask").props.disabled).toBe(false);
    expect(html).not.toContain(ASK_CHANGED_LINE);

    m.fair = "2000000"; // the 15 s refetch lands
    html = run();
    expect(button("Place ask").props.disabled).toBe(true);
    expect(html).toContain(ASK_CHANGED_LINE);
    expect(html).toContain("at $2.5 per share or more"); // the review still states what was reviewed

    await pressPlace(); // a click that reached the handler anyway: listAsk refuses on its own
    expect(m.place).not.toHaveBeenCalled();
    expect(m.preflightAsk).not.toHaveBeenCalled();
    expect(m.notice).toHaveBeenCalledWith("error", "Place your ask stopped", ASK_CHANGED_LINE);
  });

  it("after Edit and a new review at 2, the ask sent is 2", async () => {
    mount();
    click("Review order");
    m.fair = "2000000";
    run();
    click("Edit");
    const html = click("Review order");
    expect(html).toContain("at $2 per share or more");
    expect(html).not.toContain(ASK_CHANGED_LINE);
    await pressPlace();
    expect(m.place).toHaveBeenCalledTimes(1);
    expect(m.place.mock.calls[0]!.slice(1)).toEqual([BigInt(LONG_ID), 2, 2_000_000n, 1n, EXPIRY - 1800]);
  });

  it("with no change, Place ask sends the reviewed order", async () => {
    mount();
    click("Review order");
    run(); // a refetch that returns the same fair value changes nothing
    await pressPlace();
    expect(m.place.mock.calls[0]!.slice(1)).toEqual([BigInt(LONG_ID), 2, 2_500_000n, 1n, EXPIRY - 1800]);
  });

  it("a typed price is unaffected by a fair refresh: no notice, and the typed price is sent", async () => {
    mount();
    typePrice("3");
    click("Review order");
    m.fair = "2000000";
    const html = run();
    expect(html).not.toContain(ASK_CHANGED_LINE);
    expect(button("Place ask").props.disabled).toBe(false);
    await pressPlace();
    expect(m.place.mock.calls[0]!.slice(1)).toEqual([BigInt(LONG_ID), 2, 3_000_000n, 1n, EXPIRY - 1800]);
  });
});

describe("a strike, expiry or series change under the review blocks Place ask", () => {
  it("the custom-strike field (EarnMarket) changing during Review counts as a change", async () => {
    mount({ row: null, customStrike: STRIKE });
    click("Review order");
    expect(button("Place ask").props.disabled).toBe(false);
    props = { ...props, customStrike: STRIKE + 10_000_000n };
    const html = run();
    expect(button("Place ask").props.disabled).toBe(true);
    expect(html).toContain(ASK_CHANGED_LINE);
    await pressPlace();
    expect(m.place).not.toHaveBeenCalled();
  });

  it("a different expiry counts as a change", () => {
    mount();
    click("Review order");
    props = { ...props, expiry: EXPIRY + 86_400 };
    const html = run();
    expect(button("Place ask").props.disabled).toBe(true);
    expect(html).toContain(ASK_CHANGED_LINE);
  });

  it("askDrift names every field of the order, and nothing else", () => {
    const reviewed: ReviewedAsk = { price: 2_500_000n, units: 1n, strike: STRIKE, expiry: EXPIRY, isPut: false, longId: LONG_ID };
    expect(askDrift(reviewed, { ...reviewed })).toBeNull();
    for (const live of [null, { ...reviewed, price: 2_000_000n }, { ...reviewed, units: 2n }, { ...reviewed, strike: STRIKE + 1n },
      { ...reviewed, expiry: EXPIRY + 1 }, { ...reviewed, isPut: true }, { ...reviewed, longId: "1" }]) {
      expect(askDrift(reviewed, live), JSON.stringify(live, (_k, v) => typeof v === "bigint" ? `${v}` : v)).toBe(ASK_CHANGED_LINE);
    }
  });
});

describe("the review card's figures are the reviewed order's, not the live quote's", () => {
  it("reviewed at 2.5 on 10 shares, fair refetched to 2: credit, premium and fee stay the 2.5 order's until a new review", () => {
    mount();
    typeShares("10");
    let html = click("Review order");
    const reviewedAt25 = { credit: "$23.75", gross: "$25.00", fee: "$1.25" }; // 1,000 units x 2.5 / 100, less 500 bps
    const figures = (page: string) => ({
      credit: rowValue(page, "Estimated credit"), gross: rowValue(page, "Gross premium"), fee: rowValue(page, "Seller fee (500 bps)"),
    });
    expect(figures(html)).toEqual(reviewedAt25);

    m.fair = "2000000"; // the 15 s refetch lands; the live quote is now 2's: $19.00 credit
    html = run();
    expect(html).toContain(ASK_CHANGED_LINE);
    expect(figures(html)).toEqual(reviewedAt25);

    click("Edit");
    html = click("Review order");
    expect(figures(html)).toEqual({ credit: "$19.00", gross: "$20.00", fee: "$1.00" });
  });

  it("a put's Locked while open stays the reviewed strike's collateral when the custom strike moves under the review", () => {
    m.isPut = true;
    mount({ row: null, customStrike: STRIKE, typeChoice: "put" });
    typeShares("10");
    let html = click("Review order");
    const at190 = `${displayQuantity(1_900_000_000n, 6)} USDG`; // 1,000 units x $190 / 100
    expect(rowValue(html, "Locked while open")).toBe(at190);
    props = { ...props, customStrike: STRIKE + 10_000_000n };
    html = run();
    expect(html).toContain(ASK_CHANGED_LINE);
    expect(rowValue(html, "Locked while open")).toBe(at190);
    expect(at190).not.toBe(`${displayQuantity(2_000_000_000n, 6)} USDG`);
  });
});

describe("the review card names the reviewed order's side and collateral asset, at that asset's decimals", () => {
  // EarnMarket keeps the ticket mounted when a custom strike's call/put switch flips (its key is the selected strike), so
  // the live side, asset and decimals change under the open review. The card must keep describing the reviewed order.
  const cases = [
    { reviewed: "call", flipped: "put", locked: `${displayQuantity(10n ** 19n, 18)} NVDA`, // 1,000 units x 1e16 Stock Token
      misread: `${displayQuantity(10n ** 19n, 6)} USDG`, side: "Call", other: "Put", asset: "NVDA", otherAsset: "USDG" },
    { reviewed: "put", flipped: "call", locked: `${displayQuantity(1_900_000_000n, 6)} USDG`, // 1,000 units x $190 / 100
      misread: `${displayQuantity(1_900_000_000n, 18)} NVDA`, side: "Put", other: "Call", asset: "USDG", otherAsset: "NVDA" },
  ] as const;
  for (const c of cases) {
    it(`reviewed a ${c.reviewed}, switched to ${c.flipped} under the review: Locked while open, the title and the note stay the ${c.reviewed}'s`, async () => {
      m.isPut = c.reviewed === "put";
      mount({ row: null, customStrike: STRIKE, typeChoice: c.reviewed });
      typeShares("10");
      let html = click("Review order");
      expect(rowValue(html, "Locked while open")).toBe(c.locked);
      expect(html).toMatch(new RegExp(`>Sell NVDA \\$190(\\.0+)? ${c.side}</p>`));
      expect(html).toContain(`Keep your ${c.asset} deposited`);

      m.isPut = c.flipped === "put"; // the switch flips; useWriteGate now answers for the other side
      props = { ...props, typeChoice: c.flipped };
      html = run();
      expect(html).toContain(ASK_CHANGED_LINE);
      expect(button("Place ask").props.disabled).toBe(true);
      expect(rowValue(html, "Locked while open")).toBe(c.locked);
      expect(rowValue(html, "Locked while open")).not.toBe(c.misread);
      expect(html).toMatch(new RegExp(`>Sell NVDA \\$190(\\.0+)? ${c.side}</p>`));
      expect(html).not.toMatch(new RegExp(`>Sell NVDA \\$[\\d.,]+ ${c.other}</p>`));
      expect(html).toContain(`Keep your ${c.asset} deposited`);
      expect(html).not.toContain(`Keep your ${c.otherAsset} deposited`);
      await pressPlace();
      expect(m.place).not.toHaveBeenCalled();
    });
  }
});
