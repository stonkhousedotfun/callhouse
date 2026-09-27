/**
 * HouseVault's write handlers on the redesigned page, which a static render cannot click. Rewritten
 * from the earlier HouseVault.actions.test.ts, which drove the pre-redesign layout. Each action re-checks its gate
 * on the chain before writing, writes to the vault the RESPONSE named with the wallet's account, clears its input on
 * success, reports pending then success, and on failure reports "<label> stopped" with the reason unless the
 * receipt-unknown notice took it. Also: the USDG deposit's instant-vs-queued choice is asked again at the click; the
 * countdown tick; the queued-row wording for missing amounts; and the boundary notices.
 *
 * React's useState/useEffect are a slot stand-in while HouseVault is called as a function (no DOM renderer here); the
 * returned tree is then server-rendered with the real hooks. The redesign puts the Deposit, Withdraw and Requests forms in
 * the Tabs `items[].panel` props, so the element walk below descends into every prop, not only `children`.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, useWalletClient } from "wagmi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import { USDG } from "@/lib/contracts";
import type { HouseMarketResponse } from "@/lib/v2/api-types";
import type { HouseVaultReads } from "@/lib/v2/chainReads";
import { HOUSE_DEPOSIT_QUEUE_LABEL, HOUSE_DEPOSIT_QUEUED_NOTICE } from "@/lib/v2/houseCopy";
import { assertHouseGate, readHouseGateState } from "@/lib/v2/houseGates";
import {
  cancelHouseDepositRequest, cancelHouseWithdrawRequest, claimHouseWithdrawal, depositHouseNow, previewHouseDepositNow,
  requestHouseDeposit, requestHouseWithdraw,
} from "@/lib/v2/houseTx";
import { useConfig, useHouse, useHouseMarket, useHouseVaultReads, useSplitterReads } from "@/lib/v2/hooks";
import { HOUSE_BOUNDARY_OVERDUE, HOUSE_BOUNDARY_WAITING } from "@/lib/v2/vaultCopy";
import { HouseVault } from "./HouseVault";

const H = vi.hoisted(() => ({ on: false, slots: [] as unknown[], i: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (orig) => {
  const real = await orig<typeof import("react")>();
  return {
    ...real,
    useState: (init: unknown) => {
      if (!H.on) return real.useState(init);
      const k = H.i++;
      if (!(k in H.slots)) H.slots[k] = typeof init === "function" ? (init as () => unknown)() : init;
      return [H.slots[k], (v: unknown) => { H.slots[k] = typeof v === "function" ? (v as (p: unknown) => unknown)(H.slots[k]) : v; }];
    },
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => (H.on ? void H.effects.push(fn) : real.useEffect(fn, deps)),
  };
});
vi.mock("@tanstack/react-query", () => ({ useQueryClient: vi.fn(), useQuery: vi.fn() }));
vi.mock("wagmi", () => ({ useAccount: vi.fn(), useWalletClient: vi.fn() }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));
vi.mock("@/components/TxToast", () => ({ useNotice: vi.fn(), useV2ReceiptNotice: vi.fn() }));
vi.mock("@/lib/markets", () => ({ v2Markets: () => [{ ticker: "NVDA", asset: "0x0000000000000000000000000000000000000011" }] }));
vi.mock("@/lib/v2/hooks", () => ({
  useHouse: vi.fn(), useHouseMarket: vi.fn(), useHouseVaultReads: vi.fn(), useSplitterReads: vi.fn(), useConfig: vi.fn(),
  useMarkets: vi.fn(() => ({ data: [], isError: false })),
  v2Keys: {
    houseMarket: (ticker: string, address?: string, vault?: string) => ["v2", "house", ticker, address, vault],
    vaultReads: (kind: string, vault?: string, address?: string) => ["v2", "vault-reads", kind, vault, address],
  },
}));
vi.mock("@/lib/v2/houseGates", async (orig) => ({
  ...(await orig<typeof import("@/lib/v2/houseGates")>()),
  readHouseGateState: vi.fn(async () => ({ gate: "state" })),
  assertHouseGate: vi.fn(),
}));
vi.mock("@/lib/v2/houseTx", async (orig) => ({
  ...(await orig<typeof import("@/lib/v2/houseTx")>()),
  previewHouseDepositNow: vi.fn(), depositHouseNow: vi.fn(), requestHouseDeposit: vi.fn(), cancelHouseDepositRequest: vi.fn(),
  requestHouseWithdraw: vi.fn(), cancelHouseWithdrawRequest: vi.fn(), claimHouseWithdrawal: vi.fn(),
}));

const ACCOUNT = "0x0000000000000000000000000000000000000044" as const;
const VAULT = "0x0000000000000000000000000000000000000066" as const;
const STOCK = "0x0000000000000000000000000000000000000011";
const END = 1_760_604_800;
const NOW = END - 86_400;
const E18 = 10n ** 18n;
const USDG_LABEL = "Deposit USDG into the house vault";
const market = (over: Partial<HouseMarketResponse> = {}): HouseMarketResponse => ({
  market: "NVDA", vault: VAULT, kind: "weekly",
  currentEpoch: { id: "12", start: 1_760_000_000, end: END, nav: null, resultUsdg: null },
  epochs: [], shares: { address: ACCOUNT, shares: "0", queued: [] }, queue: [], ...over,
});
const reads = (over: Partial<HouseVaultReads> = {}): HouseVaultReads => ({
  nav: 1_000_000n, totalSupply: E18, balance: E18, performanceFeeBps: 0, epochPerformanceFeeBps: 0, performanceFeeCeilBps: 2000,
  highWaterMark: 1_000_000n, splitter: null, oracle: null, lastSettlementPrice: null, limits: null, ...over,
} as HouseVaultReads);

type Props = Record<string, unknown> & { children?: ReactNode };
type El = ReactElement<Props>;
/** Every element in the tree whose props match, walking EVERY prop (the Tabs panels are `items[].panel`, not children). */
function all(node: unknown, pred: (e: El) => boolean, out: El[] = [], seen = new Set<unknown>()): El[] {
  if (node === null || typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) { for (const n of node) all(n, pred, out, seen); return out; }
  if (isValidElement(node)) {
    if (pred(node as El)) out.push(node as El);
    for (const value of Object.values((node as El).props)) all(value, pred, out, seen);
    return out;
  }
  // A plain object inside a prop (a Tabs item {value, label, panel}): walk its values too.
  for (const value of Object.values(node as Record<string, unknown>)) all(value, pred, out, seen);
  return out;
}
const text = (n: ReactNode): string => Array.isArray(n) ? n.map(text).join("") : isValidElement(n) ? text((n as El).props.children) : n == null || typeof n === "boolean" ? "" : String(n);

let notice: ReturnType<typeof vi.fn>;
let unknownReceipt: ReturnType<typeof vi.fn>;
let invalidate: ReturnType<typeof vi.fn>;
const WALLET = { id: "wallet" };

function render(vault?: string) {
  H.on = true;
  H.i = 0;
  H.effects = [];
  try { return HouseVault({ ticker: "NVDA", vault }) as ReactNode; } finally { H.on = false; }
}
const button = (label: string, vault?: string) => {
  const found = all(render(vault), (e) => typeof e.props.onClick === "function" && text(e.props.children) === label);
  expect(found, `exactly one "${label}" button`).toHaveLength(1);
  return found[0]!;
};
const click = async (label: string, vault?: string) => {
  (button(label, vault).props.onClick as () => void)();
  await vi.waitFor(() => expect(notice.mock.calls.length).toBeGreaterThanOrEqual(2));
};
const input = (id: string) => {
  const found = all(render(), (e) => e.props.id === id);
  expect(found, `exactly one #${id}`).toHaveLength(1);
  return found[0]!;
};
const type = (id: string, value: string) => (input(id).props.onChange as (e: { target: { value: string } }) => void)({ target: { value } });
const contextOf = (fn: unknown) => vi.mocked(fn as (...a: unknown[]) => unknown).mock.calls[0]![0] as {
  account: string; wallet: unknown; onConfirmed: () => Promise<void>;
};
const html = () => renderToStaticMarkup(render() as ReactElement);

beforeEach(() => {
  vi.resetAllMocks(); // back to each vi.fn's own implementation, so a rejected write does not leak
  H.slots = [];
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  notice = vi.fn();
  unknownReceipt = vi.fn(() => false);
  invalidate = vi.fn(async () => {});
  vi.mocked(useQuery).mockReturnValue({ data: undefined, isError: false } as never);
  vi.mocked(useAccount).mockReturnValue({ address: ACCOUNT } as never);
  vi.mocked(useWalletClient).mockReturnValue({ data: WALLET } as never);
  vi.mocked(useQueryClient).mockReturnValue({ invalidateQueries: invalidate } as never);
  vi.mocked(useNotice).mockReturnValue(notice as never);
  vi.mocked(useV2ReceiptNotice).mockReturnValue(unknownReceipt as never);
  vi.mocked(useHouseMarket).mockReturnValue({ data: market(), isError: false } as never);
  vi.mocked(useHouseVaultReads).mockReturnValue({ data: reads({ protocolAccountsConfirmed: true } as Partial<HouseVaultReads>) } as never);
  vi.mocked(useSplitterReads).mockReturnValue({ data: undefined } as never);
  vi.mocked(useConfig).mockReturnValue({ data: undefined } as never);
  vi.mocked(useHouse).mockReturnValue({ data: { items: [], nextCursor: null }, isError: false } as never);
});
afterEach(() => vi.useRealTimers());

describe("HouseVault: the USDG deposit", () => {
  it("instant: asks the vault again, re-checks the gate for an instant deposit, deposits with a 0.01% share floor", async () => {
    vi.mocked(previewHouseDepositNow).mockResolvedValue({ instant: true, shares: 10_000n * E18 } as never);
    vi.mocked(depositHouseNow).mockResolvedValue({ shares: 9_999n * E18 } as never);
    type("house-deposit-usdg", "250.5");
    await click(HOUSE_DEPOSIT_QUEUE_LABEL); // the label is the queued one until the vault's preview is read
    expect(previewHouseDepositNow).toHaveBeenCalledWith(VAULT, 250_500_000n);
    expect(readHouseGateState).toHaveBeenCalledWith(VAULT, ACCOUNT);
    expect(assertHouseGate).toHaveBeenCalledTimes(1);
    expect(depositHouseNow).toHaveBeenCalledWith(expect.objectContaining({ account: ACCOUNT, wallet: WALLET }), VAULT, USDG, 250_500_000n,
      10_000n * E18 - E18);
    expect(requestHouseDeposit).not.toHaveBeenCalled();
    expect(notice).toHaveBeenNthCalledWith(1, "pending", USDG_LABEL, "Review each requested transaction in your wallet.");
    expect(notice).toHaveBeenNthCalledWith(2, "success", USDG_LABEL, "Deposited. You got 9,999 shares.");
    expect(input("house-deposit-usdg").props.value, "cleared").toBe("");
  });

  it("instant with no DepositedNow log: says the shares were added without a number", async () => {
    vi.mocked(previewHouseDepositNow).mockResolvedValue({ instant: true, shares: E18 } as never);
    vi.mocked(depositHouseNow).mockResolvedValue({ shares: null } as never);
    type("house-deposit-usdg", "1");
    await click(HOUSE_DEPOSIT_QUEUE_LABEL);
    expect(notice).toHaveBeenLastCalledWith("success", USDG_LABEL, expect.stringContaining("refresh to see them"));
  });

  it("queued: requests the deposit for the next close", async () => {
    vi.mocked(previewHouseDepositNow).mockResolvedValue({ instant: false, refusal: "PastCutoff" } as never);
    type("house-deposit-usdg", "10");
    await click(HOUSE_DEPOSIT_QUEUE_LABEL);
    expect(requestHouseDeposit).toHaveBeenCalledWith(expect.objectContaining({ account: ACCOUNT }), VAULT, USDG, 10_000_000n);
    expect(depositHouseNow).not.toHaveBeenCalled();
    expect(notice).toHaveBeenLastCalledWith("success", USDG_LABEL, HOUSE_DEPOSIT_QUEUED_NOTICE);
  });

  it("a gate refusal on the chain stops before any write and says why; the amount stays", async () => {
    vi.mocked(previewHouseDepositNow).mockResolvedValue({ instant: false } as never);
    vi.mocked(assertHouseGate).mockImplementationOnce(() => { throw new Error("Deposits are closed for this epoch."); });
    type("house-deposit-usdg", "10");
    await click(HOUSE_DEPOSIT_QUEUE_LABEL);
    expect(requestHouseDeposit).not.toHaveBeenCalled();
    expect(depositHouseNow).not.toHaveBeenCalled();
    expect(notice).toHaveBeenLastCalledWith("error", `${USDG_LABEL} stopped`, "Deposits are closed for this epoch.");
    expect(input("house-deposit-usdg").props.value).toBe("10");
  });

  it("an empty or non-positive amount is refused before anything is read", async () => {
    type("house-deposit-usdg", "0");
    await click(HOUSE_DEPOSIT_QUEUE_LABEL);
    expect(previewHouseDepositNow).not.toHaveBeenCalled();
    expect(readHouseGateState).not.toHaveBeenCalled();
    expect(notice).toHaveBeenLastCalledWith("error", `${USDG_LABEL} stopped`, "Enter a positive deposit.");
  });

  it("an unknown receipt is left to the receipt notice: no 'stopped' error on top, and the busy flag clears", async () => {
    vi.mocked(previewHouseDepositNow).mockResolvedValue({ instant: false } as never);
    vi.mocked(requestHouseDeposit).mockRejectedValue(new Error("receipt unknown"));
    unknownReceipt.mockReturnValue(true);
    type("house-deposit-usdg", "10");
    (button(HOUSE_DEPOSIT_QUEUE_LABEL).props.onClick as () => void)();
    await vi.waitFor(() => expect(unknownReceipt).toHaveBeenCalled());
    await vi.waitFor(() => expect(H.slots, "busy cleared").not.toContain(USDG_LABEL));
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith("pending", USDG_LABEL, expect.any(String));
  });

  it("a non-Error failure falls back to a generic line", async () => {
    vi.mocked(previewHouseDepositNow).mockRejectedValue("boom");
    type("house-deposit-usdg", "10");
    await click(HOUSE_DEPOSIT_QUEUE_LABEL);
    expect(notice).toHaveBeenLastCalledWith("error", `${USDG_LABEL} stopped`, "Try again after refreshing.");
  });

  it("the write context refreshes this vault's market and chain reads after it confirms; no wallet refuses", async () => {
    vi.mocked(previewHouseDepositNow).mockResolvedValue({ instant: false } as never);
    type("house-deposit-usdg", "10");
    await click(HOUSE_DEPOSIT_QUEUE_LABEL, VAULT);
    const ctx = contextOf(requestHouseDeposit);
    await ctx.onConfirmed();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["v2", "house", "NVDA", ACCOUNT, VAULT] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["v2", "vault-reads", "house", VAULT, ACCOUNT] });

    notice.mockClear();
    vi.mocked(requestHouseDeposit).mockClear();
    vi.mocked(useWalletClient).mockReturnValue({ data: undefined } as never);
    type("house-deposit-usdg", "10");
    await click(HOUSE_DEPOSIT_QUEUE_LABEL, VAULT);
    expect(requestHouseDeposit).not.toHaveBeenCalled();
    expect(notice).toHaveBeenLastCalledWith("error", `${USDG_LABEL} stopped`, "Connect your wallet first.");
  });

  it("disconnected: the gate check refuses before reading the chain", async () => {
    vi.mocked(previewHouseDepositNow).mockResolvedValue({ instant: false } as never);
    vi.mocked(useAccount).mockReturnValue({ address: undefined } as never);
    type("house-deposit-usdg", "10");
    await click(HOUSE_DEPOSIT_QUEUE_LABEL);
    expect(readHouseGateState).not.toHaveBeenCalled();
    expect(requestHouseDeposit).not.toHaveBeenCalled();
    expect(notice).toHaveBeenLastCalledWith("error", `${USDG_LABEL} stopped`, "Connect your wallet first.");
  });
});

describe("HouseVault: the other actions", () => {
  it("Stock Token deposit: 18 decimals, on the registry's Stock Token, after the gate check", async () => {
    type("house-deposit-stock", "1.5");
    await click("Queue Stock Token deposit");
    expect(assertHouseGate).toHaveBeenCalledTimes(1);
    expect(requestHouseDeposit).toHaveBeenCalledWith(expect.anything(), VAULT, STOCK, 15n * E18 / 10n);
    expect(notice).toHaveBeenLastCalledWith("success", "Deposit Stock Tokens into the house vault", HOUSE_DEPOSIT_QUEUED_NOTICE);
    expect(input("house-deposit-stock").props.value).toBe("");
  });

  it("Stock Token deposit with nothing typed is refused", async () => {
    await click("Queue Stock Token deposit");
    expect(requestHouseDeposit).not.toHaveBeenCalled();
    expect(notice).toHaveBeenLastCalledWith("error", "Deposit Stock Tokens into the house vault stopped", "Enter a positive deposit.");
  });

  it("cancel a queued deposit: gate first, then the cancel on the response's vault", async () => {
    await click("Cancel queued deposit");
    expect(assertHouseGate).toHaveBeenCalledTimes(1);
    expect(cancelHouseDepositRequest).toHaveBeenCalledWith(expect.objectContaining({ account: ACCOUNT }), VAULT);
    expect(notice).toHaveBeenLastCalledWith("success", "Cancel queued deposit", "Queued deposit cancelled.");
  });

  it("request a withdrawal in 18-decimal shares; nothing typed is refused", async () => {
    await click("Request withdrawal");
    expect(requestHouseWithdraw).not.toHaveBeenCalled();
    expect(notice).toHaveBeenLastCalledWith("error", "Request a house vault withdrawal stopped", "Enter a positive share amount.");
    notice.mockClear();
    type("house-withdraw", "0.25");
    await click("Request withdrawal");
    expect(assertHouseGate).toHaveBeenCalledTimes(1);
    expect(requestHouseWithdraw).toHaveBeenCalledWith(expect.anything(), VAULT, E18 / 4n);
    expect(notice).toHaveBeenLastCalledWith("success", "Request a house vault withdrawal", "Withdrawal queued until the next close.");
    expect(input("house-withdraw").props.value).toBe("");
  });

  it("a withdrawal the chain gate refuses writes nothing and keeps the shares typed", async () => {
    vi.mocked(assertHouseGate).mockImplementationOnce(() => { throw new Error("You have no shares to withdraw."); });
    type("house-withdraw", "0.25");
    await click("Request withdrawal");
    expect(requestHouseWithdraw).not.toHaveBeenCalled();
    expect(notice).toHaveBeenLastCalledWith("error", "Request a house vault withdrawal stopped", "You have no shares to withdraw.");
    expect(input("house-withdraw").props.value).toBe("0.25");
  });

  it("cancel a queued withdrawal", async () => {
    await click("Cancel queued withdrawal");
    expect(assertHouseGate).toHaveBeenCalledTimes(1);
    expect(cancelHouseWithdrawRequest).toHaveBeenCalledWith(expect.anything(), VAULT);
    expect(notice).toHaveBeenLastCalledWith("success", "Cancel queued withdrawal", "Queued withdrawal cancelled.");
  });

  it("claim a settled withdrawal: the done line names what was paid", async () => {
    vi.mocked(claimHouseWithdrawal).mockResolvedValue({ paid: { shares: E18, usdg: 12_500_000n, stock: 0n }, quoted: null } as never);
    await click("Claim settled withdrawal");
    expect(claimHouseWithdrawal).toHaveBeenCalledWith(expect.anything(), VAULT);
    expect(notice).toHaveBeenLastCalledWith("success", "Claim a settled withdrawal", expect.stringMatching(/^Claim confirmed\. It paid .*12\.50 USDG/));
  });
});

describe("HouseVault: page details", () => {
  it("the countdown re-reads the clock every 30 s and stops on unmount", () => {
    render();
    const tick = H.effects.find((fn) => String(fn).includes("setNow"));
    expect(tick, "the page's clock effect").toBeDefined();
    const at = H.slots.indexOf(NOW);
    expect(at, "the clock slot holds the page's now").toBeGreaterThan(-1);
    const cleanup = tick!() as () => void;
    vi.advanceTimersByTime(30_000);
    expect(H.slots[at]).toBe(NOW + 30);
    cleanup();
    vi.advanceTimersByTime(60_000);
    expect(H.slots[at]).toBe(NOW + 30);
  });

  it("queued rows with missing amounts say so rather than printing 0", () => {
    const queued = [
      { kind: "withdraw", account: ACCOUNT, assets: null, stockAmount: null, shares: null, requestedAt: 1_760_000_100 },
      { kind: "deposit", account: ACCOUNT, assets: "0", stockAmount: null, shares: null, requestedAt: 1_760_000_200 },
      { kind: "deposit", account: ACCOUNT, assets: null, stockAmount: "0", shares: null, requestedAt: 1_760_000_300 },
      { kind: "deposit", account: ACCOUNT, assets: null, stockAmount: undefined, shares: null, requestedAt: 1_760_000_400 },
    ];
    vi.mocked(useHouseMarket).mockReturnValue({ data: market({ shares: { address: ACCOUNT, shares: "0", queued } as never }), isError: false } as never);
    const amounts = [...html().matchAll(/data-slot="house-queued-amount">([^<]*)</g)].map((m) => m[1]);
    expect(amounts).toEqual(["shares unavailable", "0 USDG", "0 Stock Tokens", "amount unavailable"]);
  });

  it("past the close: waiting, then overdue; a close the vault did not lock is held", () => {
    vi.setSystemTime((END + 60) * 1000);
    H.slots = [];
    expect(html()).toContain(HOUSE_BOUNDARY_WAITING.replace(/'/g, "&#x27;"));
    vi.setSystemTime((END + 8 * 3_600) * 1000);
    H.slots = [];
    expect(html()).toContain(HOUSE_BOUNDARY_OVERDUE.replace(/'/g, "&#x27;"));
    vi.setSystemTime((END + 60) * 1000);
    H.slots = [];
    vi.mocked(useHouseVaultReads).mockReturnValue({ data: reads({ pinnedBoundary: END - 604_800, pendingDeposit: { usdg: 0n, stock: 0n } } as Partial<HouseVaultReads>) } as never);
    const held = html();
    expect(held).toMatch(/This close is held/i);
    expect(held).not.toContain(HOUSE_BOUNDARY_OVERDUE.replace(/'/g, "&#x27;"));
  });
});
