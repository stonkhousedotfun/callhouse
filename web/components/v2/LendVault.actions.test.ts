/**
 * LendVault (/earn) on the redesigned page. Rewritten from the earlier LendVault.actions.test.ts
 * which drove the pre-redesign layout. The interest panel's every branch, and the page's write handlers,
 * which a static render cannot click: deposit (approve exactly, then deposit; a queued deposit says why it waits), redeem
 * at the vault's share decimals (and the named-error explanation), process queue, cancel a queued request, claim a held
 * payment, and the shared failure path ("<label> stopped" unless the receipt-unknown notice took it). Also the minute
 * clock and the per-request queued-preview fetcher.
 *
 * React's useState/useEffect are a slot stand-in while LendVault is called as a function (no DOM renderer here); the
 * handlers are read from the returned tree. The redesign puts the Deposit and Redeem forms in the Tabs `items[].panel`
 * props, and the request and held-payment cards (EarnRequests, EarnHeldPayments) render only while there is something
 * to show, so the walk below descends into every prop and the card tests give the page a queued request.
 * Writes are mocked at lib/v2/lendTx and lib/v2/tx.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useWalletClient } from "wagmi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import { EarnHeldPayments, EarnRequests } from "@/components/v2/earn/EarnRequests";
import { USDG } from "@/lib/contracts";
import type { ConfigResponse } from "@/lib/v2/api-types";
import { v2ConfigWarnings } from "@/lib/v2/config";
import { useHeldPayments } from "@/lib/v2/earnDeferred";
import { lendQueueCards } from "@/lib/v2/earnQueue";
import { explainEarnRedeemError } from "@/lib/v2/errors";
import { useConfig, useEarn, useEarnVaultReads } from "@/lib/v2/hooks";
import {
  cancelQueuedRequest, claimDeferredPayment, depositToVaultTracked, processVaultQueue, redeemFromVaultTracked,
} from "@/lib/v2/lendTx";
import { formatEarnQueuedPreview, readEarnQueuedPreview } from "@/lib/v2/moneyPreviews";
import { approveExact } from "@/lib/v2/tx";
import { LendInterest, LendVault, lendInterestView } from "./LendVault";

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
vi.mock("wagmi", () => ({ useAccount: vi.fn(), useWalletClient: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn() }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));
vi.mock("@/components/TxToast", () => ({ useNotice: vi.fn(), useV2ReceiptNotice: vi.fn() }));
vi.mock("@/lib/v2/hooks", () => ({ useConfig: vi.fn(), useEarn: vi.fn(),
  useEarnVaultReads: vi.fn(), useSplitterReads: vi.fn(() => ({ data: undefined })),
  useMarkets: vi.fn(() => ({ data: [], isError: false })) }));
vi.mock("@/lib/v2/earnDeferred", async (orig) => ({
  ...(await orig<typeof import("@/lib/v2/earnDeferred")>()),
  useHeldPayments: vi.fn(),
}));
vi.mock("@/lib/v2/earnQueue", async (orig) => ({
  ...(await orig<typeof import("@/lib/v2/earnQueue")>()),
  lendQueueCards: vi.fn(() => []),
}));
vi.mock("@/lib/v2/lendTx", async (orig) => ({
  ...(await orig<typeof import("@/lib/v2/lendTx")>()),
  earnVaultAddress: () => "0x0000000000000000000000000000000000000066",
  cancelQueuedRequest: vi.fn(), claimDeferredPayment: vi.fn(), depositToVaultTracked: vi.fn(), processVaultQueue: vi.fn(),
  redeemFromVaultTracked: vi.fn(),
}));
vi.mock("@/lib/v2/config", async (orig) => ({ ...(await orig<typeof import("@/lib/v2/config")>()), v2ConfigWarnings: vi.fn() }));
vi.mock("@/lib/v2/tx", async (orig) => ({ ...(await orig<typeof import("@/lib/v2/tx")>()), approveExact: vi.fn() }));
vi.mock("@/lib/v2/moneyPreviews", async (orig) => ({
  ...(await orig<typeof import("@/lib/v2/moneyPreviews")>()),
  readEarnQueuedPreview: vi.fn(), formatEarnQueuedPreview: vi.fn((p: unknown) => `line:${String(p)}`),
}));

const config = JSON.parse(readFileSync(fileURLToPath(new URL("../../../ops/fixtures/api/v2/config.json", import.meta.url)), "utf8")) as ConfigResponse;
const ACCOUNT = "0x0000000000000000000000000000000000000044" as const;
const VAULT = "0x0000000000000000000000000000000000000066";
const WALLET = { id: "wallet" };
const E18 = 10n ** 18n;
const NOW_S = 1_789_600_000;
const CTX = { account: ACCOUNT, wallet: WALLET };

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
  for (const value of Object.values(node as Record<string, unknown>)) all(value, pred, out, seen);
  return out;
}
const text = (n: ReactNode): string => Array.isArray(n) ? n.map(text).join("") : isValidElement(n) ? text((n as El).props.children) : n == null || typeof n === "boolean" ? "" : String(n);

let notice: ReturnType<typeof vi.fn>;
let unknownReceipt: ReturnType<typeof vi.fn>;
let heldRefetch: ReturnType<typeof vi.fn>;

function render() {
  H.on = true;
  H.i = 0;
  H.effects = [];
  try { return LendVault() as ReactNode; } finally { H.on = false; }
}
const one = (pred: (e: El) => boolean, what: string) => {
  const found = all(render(), pred);
  expect(found, `exactly one ${what}`).toHaveLength(1);
  return found[0]!;
};
const input = (id: string) => one((e) => e.props.id === id, `#${id}`);
const type = (id: string, value: string) => (input(id).props.onChange as (e: { target: { value: string } }) => void)({ target: { value } });
const settle = () => vi.waitFor(() => expect(notice.mock.calls.length + unknownReceipt.mock.calls.length).toBeGreaterThanOrEqual(2));
async function click(label: string) {
  (one((e) => typeof e.props.onClick === "function" && text(e.props.children) === label, `"${label}" button`).props.onClick as () => void)();
  await settle();
}
const flatReads = (over: Record<string, unknown> = {}) =>
  ({ data: { adapter: null, shareDecimals: 18, balance: 5n * E18, hasOpenPosition: false, venueUnreadable: false, ...over } }) as never;

beforeEach(() => {
  vi.resetAllMocks();
  H.slots = [];
  vi.useFakeTimers();
  vi.setSystemTime(NOW_S * 1000);
  notice = vi.fn();
  unknownReceipt = vi.fn(() => false);
  heldRefetch = vi.fn();
  vi.mocked(useQuery).mockReturnValue({ data: undefined, isPending: false, isError: false } as never);
  vi.mocked(useAccount).mockReturnValue({ address: ACCOUNT } as never);
  vi.mocked(useWalletClient).mockReturnValue({ data: WALLET } as never);
  vi.mocked(useNotice).mockReturnValue(notice as never);
  vi.mocked(useV2ReceiptNotice).mockReturnValue(unknownReceipt as never);
  vi.mocked(useConfig).mockReturnValue({ data: config, isError: false, isRefetchError: false } as never);
  vi.mocked(useEarn).mockReturnValue({ data: undefined } as never);
  vi.mocked(useEarnVaultReads).mockReturnValue(flatReads());
  vi.mocked(v2ConfigWarnings).mockReturnValue([]);
  vi.mocked(useHeldPayments).mockReturnValue({ data: undefined, refetch: heldRefetch } as never);
  vi.mocked(lendQueueCards).mockReturnValue([]);
  vi.mocked(formatEarnQueuedPreview).mockImplementation(((p: unknown) => `line:${String(p)}`) as never);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("LendInterest", () => {
  const html = (view: Parameters<typeof LendInterest>[0]["view"]) => renderToStaticMarkup(createElement(LendInterest, { view }));

  it("a figure: earned over the named period and our cut, both as percentages", () => {
    const view = lendInterestView({ vault: VAULT, realisedUsdg: 1_234_000n, balanceUsdg: 100_000_000n, periodLabel: " last 7 days ", skimBps: 1_000, ceilBps: 2_000 });
    const out = html(view);
    expect(out).toMatch(/Earned · last 7 days<\/dt><dd[^>]*>1\.23%</);
    expect(out).toMatch(/Our cut of that<\/dt><dd[^>]*>10\.00%</);
    expect(out).toContain("It is not a forecast.");
  });

  it.each([
    [{ kind: "unconfigured" }, "The lending vault is not live yet."],
    [{ kind: "not-read" }, "Your interest could not be read right now."],
    [{ kind: "unlabelled-period" }, "Your interest is hidden because the period it covers is unknown."],
    [{ kind: "skim-above-ceiling", skimBps: 2_500, ceilBps: 2_000 }, "The vault reports a 25.00% cut, above its 20.00% limit, so no figure is shown."],
    [{ kind: "no-interest-yet" }, "No interest has been paid to this balance yet."],
  ] as const)("%o says why there is no figure", (view, reason) => {
    const out = html(view as never);
    expect(out).toContain(reason);
    expect(out).not.toContain("Our cut of that");
  });

  it("the view never turns an unread figure or an unread skim into 'no interest', and a skim above its ceiling shows no net figure", () => {
    const base = { vault: VAULT as `0x${string}`, periodLabel: "last 7 days", ceilBps: 2_000 };
    expect(lendInterestView({ ...base, vault: null, realisedUsdg: 1n, balanceUsdg: 1n, skimBps: 0 }).kind).toBe("unconfigured");
    expect(lendInterestView({ ...base, realisedUsdg: null, balanceUsdg: 1n, skimBps: 0 }).kind).toBe("not-read");
    expect(lendInterestView({ ...base, realisedUsdg: 5n, balanceUsdg: 100n, skimBps: null }).kind).toBe("not-read");
    expect(lendInterestView({ ...base, realisedUsdg: 0n, balanceUsdg: 100n, skimBps: 0 }).kind).toBe("no-interest-yet");
    expect(lendInterestView({ ...base, realisedUsdg: 5n, balanceUsdg: 100n, skimBps: 2_001 }).kind).toBe("skim-above-ceiling");
  });
});

describe("LendVault: deposit", () => {
  it("approves exactly the amount on USDG for the vault, then deposits; an instant one says submitted", async () => {
    vi.mocked(depositToVaultTracked).mockResolvedValue({ queuedId: null } as never);
    type("lend-deposit", "12.5");
    await click("Deposit (instant)");
    expect(approveExact).toHaveBeenCalledWith(CTX, USDG, VAULT, 12_500_000n);
    expect(depositToVaultTracked).toHaveBeenCalledWith(CTX, 12_500_000n);
    expect(vi.mocked(approveExact).mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(depositToVaultTracked).mock.invocationCallOrder[0]!);
    expect(notice).toHaveBeenNthCalledWith(1, "pending", "Deposit into the lending vault", "Review each requested transaction in your wallet.");
    expect(notice).toHaveBeenLastCalledWith("success", "Deposit into the lending vault", "Deposit submitted.");
    expect(input("lend-deposit").props.value).toBe("");
  });

  it("a queued deposit names its request and why it waits", async () => {
    vi.mocked(depositToVaultTracked).mockResolvedValue({ queuedId: 7n } as never);
    vi.mocked(useEarnVaultReads).mockReturnValue(flatReads({ balance: 0n, hasOpenPosition: true }));
    type("lend-deposit", "1");
    await click("Deposit (queued — priced when flat)");
    expect(notice).toHaveBeenLastCalledWith("success", "Deposit into the lending vault", "Deposit queued as request #7. It goes in once the open options settle.");
  });

  it("nothing typed: refused before any approval", async () => {
    await click("Deposit (instant)");
    expect(approveExact).not.toHaveBeenCalled();
    expect(depositToVaultTracked).not.toHaveBeenCalled();
    expect(notice).toHaveBeenLastCalledWith("error", "Deposit into the lending vault stopped", "Enter a positive deposit.");
  });

  it("a config mismatch refuses the deposit with the reason, even if the handler is reached", async () => {
    vi.mocked(v2ConfigWarnings).mockReturnValue(["Indexer chain differs from this app."]);
    type("lend-deposit", "1");
    await click("Deposit (instant)");
    expect(approveExact).not.toHaveBeenCalled();
    expect(notice).toHaveBeenLastCalledWith("error", "Deposit into the lending vault stopped",
      "App and indexer contract settings do not match. New lending deposits are paused. Indexer chain differs from this app.");
  });

  it("a failed config request refuses the deposit too, never read as 'no mismatch'", async () => {
    vi.mocked(useConfig).mockReturnValue({ data: config, isError: true, isRefetchError: false } as never);
    type("lend-deposit", "1");
    await click("Deposit (instant)");
    expect(approveExact).not.toHaveBeenCalled();
    expect(notice).toHaveBeenLastCalledWith("error", "Deposit into the lending vault stopped",
      "Live deployment settings could not be loaded. New lending deposits are paused.");
  });

  it("no wallet client: 'Connect your wallet first.'", async () => {
    vi.mocked(useWalletClient).mockReturnValue({ data: undefined } as never);
    type("lend-deposit", "1");
    await click("Deposit (instant)");
    expect(approveExact).not.toHaveBeenCalled();
    expect(notice).toHaveBeenLastCalledWith("error", "Deposit into the lending vault stopped", "Connect your wallet first.");
  });

  it("an unknown receipt goes to the receipt notice only; a non-Error gets the generic line", async () => {
    vi.mocked(depositToVaultTracked).mockRejectedValueOnce(new Error("receipt unknown"));
    unknownReceipt.mockReturnValueOnce(true);
    type("lend-deposit", "1");
    await click("Deposit (instant)");
    expect(notice).toHaveBeenCalledTimes(1);
    notice.mockClear();
    unknownReceipt.mockClear();
    vi.mocked(depositToVaultTracked).mockRejectedValueOnce("nope");
    await click("Deposit (instant)");
    expect(notice).toHaveBeenLastCalledWith("error", "Deposit into the lending vault stopped", "Try again after refreshing.");
  });
});

describe("LendVault: redeem and the queue", () => {
  it("redeems whole shares at the vault's decimals; a queued redeem names its request", async () => {
    vi.mocked(redeemFromVaultTracked).mockResolvedValue({ queuedId: 3n } as never);
    type("lend-redeem", "1.5");
    await click("Redeem");
    expect(redeemFromVaultTracked).toHaveBeenCalledWith(CTX, 15n * E18 / 10n);
    expect(notice).toHaveBeenLastCalledWith("success", "Redeem lending-vault shares", expect.stringMatching(/^Queued as request #3\. /));
    expect(input("lend-redeem").props.value).toBe("");
  });

  it("a redeem at a vault with 6-decimal shares sends 6-decimal units", async () => {
    vi.mocked(useEarnVaultReads).mockReturnValue(flatReads({ shareDecimals: 6, balance: 9_000_000n }));
    vi.mocked(redeemFromVaultTracked).mockResolvedValue({ queuedId: null } as never);
    type("lend-redeem", "1.5");
    await click("Redeem");
    expect(redeemFromVaultTracked).toHaveBeenCalledWith(CTX, 1_500_000n);
  });

  it("a redeem paid at once says confirmed", async () => {
    vi.mocked(redeemFromVaultTracked).mockResolvedValue({ queuedId: null } as never);
    type("lend-redeem", "1");
    await click("Redeem");
    expect(notice).toHaveBeenLastCalledWith("success", "Redeem lending-vault shares", expect.stringMatching(/^Redeem confirmed\./));
  });

  it("unread share decimals or no amount: refused before any write", async () => {
    type("lend-redeem", "1");
    vi.mocked(useEarnVaultReads).mockReturnValue({ data: { adapter: null, shareDecimals: null, balance: null } } as never);
    await click("Redeem");
    expect(notice).toHaveBeenLastCalledWith("error", "Redeem lending-vault shares stopped", "The vault's share decimals could not be read. Refresh and try again.");
    notice.mockClear();
    vi.mocked(useEarnVaultReads).mockReturnValue(flatReads({ balance: E18 }));
    type("lend-redeem", "");
    await click("Redeem");
    expect(notice).toHaveBeenLastCalledWith("error", "Redeem lending-vault shares stopped", "Enter a positive share amount.");
    expect(redeemFromVaultTracked).not.toHaveBeenCalled();
  });

  it("a failed redeem is explained through the Earn redeem error table", async () => {
    const failure = new Error("RPC down");
    vi.mocked(redeemFromVaultTracked).mockRejectedValue(failure);
    type("lend-redeem", "1");
    await click("Redeem");
    expect(notice).toHaveBeenLastCalledWith("error", "Redeem lending-vault shares stopped", explainEarnRedeemError(failure));
  });

  it("process queue asks the vault to serve up to 8 requests", async () => {
    await click("Process queue");
    expect(processVaultQueue).toHaveBeenCalledWith(CTX, 8n);
    expect(notice).toHaveBeenLastCalledWith("success", "Process withdrawal queue", "Queue processing submitted.");
  });

  it("with nothing queued or held, no request or held-payment card is on the page", () => {
    const tree = render();
    expect(all(tree, (e) => e.type === EarnRequests)).toHaveLength(0);
    expect(all(tree, (e) => e.type === EarnHeldPayments)).toHaveLength(0);
  });

  it("cancel a queued deposit or withdrawal by its queue id; a card without one is refused", async () => {
    vi.mocked(lendQueueCards).mockReturnValue([{ kind: "deposit", cancelId: 4n }] as never);
    const onCancel = one((e) => e.type === EarnRequests, "request list").props.onCancel as (c: unknown) => void;
    onCancel({ kind: "deposit", cancelId: 4n });
    await settle();
    expect(cancelQueuedRequest).toHaveBeenCalledWith(CTX, 4n);
    expect(notice).toHaveBeenLastCalledWith("success", "Cancel queued deposit", "Cancelled. The USDG it held is back in your wallet.");
    notice.mockClear();
    onCancel({ kind: "redeem", cancelId: 5n });
    await settle();
    expect(cancelQueuedRequest).toHaveBeenLastCalledWith(CTX, 5n);
    expect(notice).toHaveBeenLastCalledWith("success", "Cancel queued withdrawal", "Cancelled. The shares it held are back in your wallet.");
    notice.mockClear();
    vi.mocked(cancelQueuedRequest).mockClear();
    onCancel({ kind: "redeem", cancelId: null });
    await settle();
    expect(cancelQueuedRequest).not.toHaveBeenCalled();
    expect(notice).toHaveBeenLastCalledWith("error", "Cancel queued withdrawal stopped", "This request has no queue id to cancel.");
  });

  it("claim a held payment to the chosen receiver, then re-read the held list", async () => {
    vi.mocked(lendQueueCards).mockReturnValue([{ kind: "deposit", cancelId: 4n }] as never);
    const onClaim = one((e) => e.type === EarnHeldPayments, "held-payment list").props.onClaim as (c: unknown, to: string) => void;
    onClaim({ held: { id: 9n }, amount: "3 USDG" }, "0x00000000000000000000000000000000000000Ee");
    await settle();
    expect(claimDeferredPayment).toHaveBeenCalledWith(CTX, 9n, "0x00000000000000000000000000000000000000Ee");
    expect(heldRefetch).toHaveBeenCalled();
    expect(notice).toHaveBeenLastCalledWith("success", "Claim held payment #9", "Claimed. 3 USDG was sent to 0x00000000000000000000000000000000000000Ee.");
  });

  it("the queued-preview fetcher reads each cancellable request's preview, skipping cards without an id", async () => {
    vi.mocked(lendQueueCards).mockReturnValue([{ cancelId: 4n }, { cancelId: null }, { cancelId: 6n }] as never);
    vi.mocked(readEarnQueuedPreview).mockImplementation((async (_c: unknown, _v: unknown, id: bigint) => `p${id}`) as never);
    render();
    const options = vi.mocked(useQuery).mock.calls.map((c) => c[0] as unknown as { queryKey: unknown[]; enabled: boolean; queryFn: () => Promise<unknown> })
      .filter((o) => o.queryKey[1] === "earn-queued-preview").at(-1)!;
    expect(options.queryKey).toEqual(["v2", "earn-queued-preview", VAULT, "4,6", 18]);
    expect(options.enabled).toBe(true);
    await expect(options.queryFn()).resolves.toEqual({ "4": "line:p4", "6": "line:p6" });
    expect(readEarnQueuedPreview).toHaveBeenCalledTimes(2);
    expect(formatEarnQueuedPreview).toHaveBeenCalledWith("p4", 18);
  });

  it("the minute clock re-reads the time every 60 s and stops on unmount", () => {
    vi.stubGlobal("window", globalThis);
    render();
    const tick = H.effects.find((fn) => String(fn).includes("setNow"));
    expect(tick, "the page's minute clock").toBeDefined();
    expect(H.slots.filter((v) => v === NOW_S)).toHaveLength(1);
    const cleanup = tick!() as () => void;
    vi.advanceTimersByTime(60_000);
    expect(H.slots).toContain(NOW_S + 60);
    cleanup();
    vi.advanceTimersByTime(120_000);
    expect(H.slots).not.toContain(NOW_S + 180);
  });
});
