/**
 * HouseVault.claimOwed() is `restricted` to QUOTER (callhouse-contracts HouseVault.claimOwed; roles.v8.json
 * HouseVault "claimOwed()": "QUOTER"), so a button calling it from a depositor's wallet reverted on every click. The
 * page must offer no such action at all -- not a button that catches the revert and shows a friendly error, which
 * would still be a button that can never work. The depositor's own exit, "Claim settled withdrawal", stays.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, useWalletClient } from "wagmi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import type { HouseMarketResponse } from "@/lib/v2/api-types";
import { useConfig, useHouseMarket, useHouseVaultReads, useSplitterReads } from "@/lib/v2/hooks";
import * as houseTx from "@/lib/v2/houseTx";
import { HouseVault } from "./HouseVault";

vi.mock("@tanstack/react-query", () => ({ useQueryClient: vi.fn(), useQuery: () => ({ data: undefined, isError: false }) }));
vi.mock("wagmi", () => ({ useAccount: vi.fn(), useWalletClient: vi.fn() }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => createElement("button", null, "Connect wallet") }));
vi.mock("@/components/TxToast", () => ({ useNotice: vi.fn(), useV2ReceiptNotice: vi.fn() }));
vi.mock("@/lib/markets", () => ({ v2Markets: () => [{ ticker: "NVDA", asset: "0x0000000000000000000000000000000000000011" }] }));
vi.mock("@/lib/v2/hooks", () => ({
  // The page reads the /v2/house list to decide a weekly wind-down; an unread list winds nothing down.
  useHouse: vi.fn(() => ({ data: undefined, isError: false })),
  useHouseMarket: vi.fn(), useHouseVaultReads: vi.fn(), useSplitterReads: vi.fn(), useConfig: vi.fn(),
  // The guardian brakes; unread by default: not a pause, but the deposit door stays shut until it answers.
  useMarkets: vi.fn(() => ({ data: undefined, isError: false })),
  // The real key takes the requested vault as a third argument; the mock mirrors that signature.
  v2Keys: { houseMarket: (ticker: string, address?: string, vault?: string) => ["v2", "house", ticker, address, vault] },
}));

/** An ordinary depositor: connected, holding shares, with a settled withdrawal to claim. Not a QUOTER. */
const depositor = "0x0000000000000000000000000000000000000044" as const;
const market: HouseMarketResponse = {
  market: "NVDA",
  vault: "0x0000000000000000000000000000000000000066",
  kind: "weekly",
  currentEpoch: { id: "12", start: 1_760_000_000, end: 1_760_604_800, nav: null, resultUsdg: null },
  epochs: [],
  shares: { address: depositor, shares: "1000000000000000000", queued: [] },
  queue: [],
};

beforeEach(() => {
  vi.mocked(useAccount).mockReturnValue({ address: depositor } as unknown as ReturnType<typeof useAccount>);
  vi.mocked(useWalletClient).mockReturnValue({ data: {} } as unknown as ReturnType<typeof useWalletClient>);
  vi.mocked(useQueryClient).mockReturnValue({ invalidateQueries: vi.fn() } as unknown as ReturnType<typeof useQueryClient>);
  vi.mocked(useNotice).mockReturnValue(vi.fn() as ReturnType<typeof useNotice>);
  vi.mocked(useV2ReceiptNotice).mockReturnValue(vi.fn() as ReturnType<typeof useV2ReceiptNotice>);
  vi.mocked(useHouseMarket).mockReturnValue({ data: market, isError: false } as unknown as ReturnType<typeof useHouseMarket>);
  vi.mocked(useHouseVaultReads).mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useHouseVaultReads>);
  vi.mocked(useSplitterReads).mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useSplitterReads>);
  vi.mocked(useConfig).mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useConfig>);
});

/** Every <button>'s visible text in the rendered page. */
function buttonTexts(html: string): string[] {
  return [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, "").trim());
}

describe("no depositor-facing claimOwed", () => {
  it("an ordinary wallet sees no claim-owed action, and still sees its own settled-withdrawal claim", () => {
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    const buttons = buttonTexts(html);
    expect(buttons).toContain("Claim settled withdrawal");
    expect(buttons.filter((text) => /owed/i.test(text))).toEqual([]);
    expect(html).not.toMatch(/still owed/i);
  });

  it("the write layer offers no claimOwed wrapper for any page to call", () => {
    expect(Object.keys(houseTx)).not.toContain("claimHouseOwed");
    expect(Object.keys(houseTx).filter((name) => /owed/i.test(name))).toEqual([]);
    const source = readFileSync(fileURLToPath(new URL("../../lib/v2/houseTx.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/simulatedWrite\([^)]*"claimOwed"/);
  });
});

/**
 * The claim button follows the vault's REQUEST reads (houseClaim.ts houseClaimState), and beside it the page
 * shows `claimable(account)`, the vault's own quote. The amount never gates the button: a matured request can
 * quote (0, 0, 0) and must still be claimed, because requestDeposit / requestWithdraw refuse TooEarly until claim()
 * retires it.
 */
describe("the claim amount comes from claimable(account) and never gates Claim", () => {
  /** A withdrawal requested in epoch 11 of a vault now in epoch 12: matured, so claim() retires it. */
  const matured = (claimable: { shares: bigint; usdg: bigint; stock: bigint } | null) => ({
    epochId: 12n, withdrawRequest: { epochId: 11n, shares: 5n * 10n ** 18n }, depositRequest: { epochId: 0n, usdg: 0n, stock: 0n },
    claimable,
  });
  const render = (reads: unknown) => {
    vi.mocked(useHouseVaultReads).mockReturnValue({ data: reads } as unknown as ReturnType<typeof useHouseVaultReads>);
    return renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
  };
  /** The Claim button's opening tag. SSR writes `disabled=""` only on a disabled button. */
  const claimButton = (html: string) => {
    const tag = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].find((m) => m[2]!.includes("Claim settled withdrawal"));
    if (!tag) throw new Error("no Claim button");
    return tag[1]!;
  };
  const slot = (html: string, name: string) => html.match(new RegExp(`data-slot="${name}"[^>]*>([\\s\\S]*?)</p>`))?.[1]?.replace(/<[^>]+>/g, "") ?? null;

  it("a matured request quoted at (0, 0, 0) keeps Claim enabled and says to claim it anyway", () => {
    const html = render(matured({ shares: 0n, usdg: 0n, stock: 0n }));
    expect(claimButton(html)).not.toContain(' disabled=""');
    expect(slot(html, "house-claim-amount")).toMatch(/pays nothing\. Claim it anyway/);
    // The in-kind panel shows the vault's zero, not "not available".
    expect(slot(html, "house-in-kind")).toMatch(/^Your claim pays 0 USDG and 0 Stock Tokens/);
  });

  it("a matured request shows the vault's quote beside Claim and in the in-kind panel", () => {
    const html = render(matured({ shares: 0n, usdg: 12_340_000n, stock: 250_000_000_000_000_000n }));
    expect(claimButton(html)).not.toContain(' disabled=""');
    expect(slot(html, "house-claim-amount")).toBe("Claim pays 12.34 USDG and 0.25 Stock Tokens.");
    expect(slot(html, "house-in-kind")).toMatch(/^Your claim pays 12\.34 USDG and 0\.25 Stock Tokens:/);
  });

  // A deposit the close refused (epochRates depositRefused) comes back as queued; say so.
  it("a refused deposit's refund is shown as the deposit returned, beside Claim and in the in-kind panel", () => {
    const html = render({ ...matured({ shares: 0n, usdg: 12_340_000n, stock: 0n }), withdrawRequest: { epochId: 0n, shares: 0n },
      depositRequest: { epochId: 11n, usdg: 12_340_000n, stock: 0n }, depositRefused: true });
    expect(claimButton(html)).not.toContain(' disabled=""');
    expect(slot(html, "house-claim-amount")).toBe(
      "The close refused your deposit, so the claim returns it as you queued it instead of minting shares. Claim pays 12.34 USDG.");
    expect(slot(html, "house-in-kind")).toMatch(/It includes your refused deposit, returned as you queued it\.$/);
    expect(slot(html, "house-in-kind")).not.toMatch(/priced request/);
  });

  it("a priced deposit (depositRefused false) keeps the priced wording", () => {
    const html = render({ ...matured({ shares: 3n * 10n ** 18n, usdg: 0n, stock: 0n }), depositRefused: false });
    expect(slot(html, "house-claim-amount")).toBe("Claim pays 3 shares.");
    expect(slot(html, "house-in-kind")).toMatch(/for your priced request\.$/);
  });

  it("an unread quote shows no amount, and Claim still follows the requests alone", () => {
    const html = render(matured(null));
    expect(claimButton(html)).not.toContain(' disabled=""');
    expect(slot(html, "house-claim-amount")).toBeNull();
    expect(slot(html, "house-in-kind")).toBeNull();
  });

  it("with no wallet connected, a quote in the reads shows no amount and Claim stays disabled", () => {
    vi.mocked(useAccount).mockReturnValue({ address: undefined } as unknown as ReturnType<typeof useAccount>);
    const html = render(matured({ shares: 0n, usdg: 12_340_000n, stock: 0n }));
    expect(claimButton(html)).toContain(' disabled=""');
    expect(slot(html, "house-claim-amount")).toBeNull();
    expect(slot(html, "house-in-kind")).toBeNull();
  });

  it("a request still in the current epoch keeps Claim disabled even with a quote lying around", () => {
    const html = render({ ...matured({ shares: 0n, usdg: 1n, stock: 1n }), withdrawRequest: { epochId: 12n, shares: 5n * 10n ** 18n } });
    expect(claimButton(html)).toContain(' disabled=""');
    expect(slot(html, "house-claim-amount")).toBeNull();
  });
});

/**
 * rollEpoch holds a close the vault did not lock for a week; the page says so and when, instead of
 * calling it seven hours late. The page reads pinnedBoundary() and the exposure (totalSupply, pending deposits).
 */
describe("a held close is shown as held until a week after it, not as late", () => {
  const end = market.currentEpoch!.end!;
  const render = (reads: unknown) => {
    vi.mocked(useHouseVaultReads).mockReturnValue({ data: reads } as unknown as ReturnType<typeof useHouseVaultReads>);
    return renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
  };
  const exposed = { totalSupply: 10n ** 18n, pendingDeposit: { usdg: 0n, stock: 0n } };

  it("an exposed close the vault did not lock: the held notice names the week-later time; no late alert", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime((end + 8 * 3_600) * 1000);
      const html = render({ ...exposed, pinnedBoundary: 0 });
      expect(html).toContain("This close is held until ");
      expect(html).not.toContain("more than seven hours late");
      const locked = render({ ...exposed, pinnedBoundary: end });
      expect(locked).not.toContain("This close is held until ");
      expect(locked).toContain("more than seven hours late");
      const unread = render({ ...exposed, pinnedBoundary: null });
      expect(unread, "an unread lock holds nothing").not.toContain("This close is held until ");
    } finally {
      vi.useRealTimers();
    }
  });
});
