import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { useQuery } from "@tanstack/react-query";
import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useAccount, useWalletClient } from "wagmi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import { USDG } from "@/lib/contracts";
import type { ConfigResponse } from "@/lib/v2/api-types";
import type { EarnResponse } from "@/lib/v2/api-types";
import { v2AddressOverrideConflictNotices, v2ConfigWarnings } from "@/lib/v2/config";
import { useConfig, useEarn } from "@/lib/v2/hooks";
import { useHeldPayments } from "@/lib/v2/earnDeferred";
import { timeText } from "@/components/ui/Time";
import { fmtUsdg } from "@/lib/format";
import { CANNOT_PREVIEW, formatEarnDepositPreview, formatEarnRedeemPreview } from "@/lib/v2/moneyPreviews";
import {
  FLAT_VALUE_LABEL, INDICATIVE_VALUE_LABEL, LEND_WRITE_OFF_TITLE, LendVault, lendConfigBlockReason, lendInterestView, lendValueView,
  lendWriteOffLines, submitLendDeposit,
} from "./LendVault";

vi.mock("wagmi", () => ({ useAccount: vi.fn(), useWalletClient: vi.fn() }));
// The real useState unless a test types an amount (see `typed` in the block below).
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: vi.fn(actual.useState) };
});
// The page reads EarnVault previews through useQuery. Without a client the page render throws
// "No QueryClient set" and every render test dies before an assertion. Unread data is the
// fail-closed preview (the paragraph stays off until a share amount is typed).
vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(() => ({ isPending: false, isError: false, data: undefined })),
}));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => createElement("button", null, "Connect wallet") }));
vi.mock("@/components/TxToast", () => ({ useNotice: vi.fn(), useV2ReceiptNotice: vi.fn() }));
vi.mock("@/lib/v2/hooks", () => ({ useConfig: vi.fn(), useEarn: vi.fn(),
  // The page's chain reads; pending (data undefined) unless a test sets them.
  useEarnVaultReads: vi.fn(() => ({ data: undefined })), useSplitterReads: vi.fn(() => ({ data: undefined })),
  // The guardian brakes; unread by default: not a pause, but the deposit door stays shut until it answers.
  useMarkets: vi.fn(() => ({ data: undefined, isError: false })) }));
// Real behaviour by default; one case below swaps in one return value to check the page wiring.
vi.mock("@/lib/v2/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/v2/config")>();
  return { ...original,
    v2AddressOverrideConflictNotices: vi.fn(original.v2AddressOverrideConflictNotices),
    v2ConfigWarnings: vi.fn(original.v2ConfigWarnings) };
});
// The held-payment read is a react-query hook; nothing held unless a test sets one.
vi.mock("@/lib/v2/earnDeferred", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/earnDeferred")>()),
  useHeldPayments: vi.fn(() => ({ data: undefined })),
}));
vi.mock("@/lib/v2/lendTx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/lendTx")>()),
  earnVaultAddress: () => "0x0000000000000000000000000000000000000066",
}));

const fixture = fileURLToPath(new URL("../../../ops/fixtures/api/v2/config.json", import.meta.url));
const matchingConfig = JSON.parse(readFileSync(fixture, "utf8")) as ConfigResponse;
const mismatchedConfig = { ...matchingConfig, chainId: matchingConfig.chainId + 1 };
const account = "0x0000000000000000000000000000000000000044" as const;
const vault = "0x0000000000000000000000000000000000000066" as const;
const context = { account, wallet: { getChainId: async () => 4663 } } as never;

beforeEach(() => {
  vi.mocked(useAccount).mockReturnValue({ address: account } as unknown as ReturnType<typeof useAccount>);
  vi.mocked(useWalletClient).mockReturnValue({ data: {} } as unknown as ReturnType<typeof useWalletClient>);
  vi.mocked(useConfig).mockReturnValue({ data: mismatchedConfig, isError: false } as ReturnType<typeof useConfig>);
  vi.mocked(useEarn).mockReturnValue({ data: undefined } as ReturnType<typeof useEarn>);
  vi.mocked(useHeldPayments).mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useHeldPayments>);
  vi.mocked(useNotice).mockReturnValue(vi.fn() as ReturnType<typeof useNotice>);
  vi.mocked(useV2ReceiptNotice).mockReturnValue(vi.fn() as ReturnType<typeof useV2ReceiptNotice>);
});

describe("LendVault deployment guard", () => {
  it.each([
    ["config is unavailable", null, false, vault, /Checking live deployment settings/],
    ["the config request failed with cached data", [], true, vault, /could not be loaded/],
    ["config differs", ["Indexer chain differs from this app."], false, vault, /contract settings do not match/],
    ["the vault address is unavailable", [], false, null, /vault is not deployed/],
  ] as const)("refuses approval and deposit when %s", async (_label, mismatch, requestFailed, configuredVault, reason) => {
    const calls: string[] = [];
    const approve = vi.fn(async () => { calls.push("approve"); return null; });
    const deposit = vi.fn(async () => { calls.push("deposit"); return "0x01" as const; });

    await expect(submitLendDeposit(context, 1n, configuredVault, mismatch, requestFailed, { approve, deposit }))
      .rejects.toThrow(reason);
    expect(approve).not.toHaveBeenCalled();
    expect(deposit).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("approves the exact USDG amount before depositing when every guard is ready", async () => {
    const calls: string[] = [];
    const approve = vi.fn(async () => { calls.push("approve"); return null; });
    const deposit = vi.fn(async () => { calls.push("deposit"); return "0x01" as const; });

    await expect(submitLendDeposit(context, 7n, vault, [], false, { approve, deposit })).resolves.toBe("0x01");
    expect(approve).toHaveBeenCalledWith(context, USDG, vault, 7n);
    expect(deposit).toHaveBeenCalledWith(context, 7n);
    expect(calls).toEqual(["approve", "deposit"]);
  });

  it("fails closed while config is unavailable or its request failed", () => {
    expect(lendConfigBlockReason(null, false)).toMatch(/Checking live deployment settings/);
    expect(lendConfigBlockReason(null, true)).toMatch(/could not be loaded/);
    expect(lendConfigBlockReason([], true)).toMatch(/could not be loaded/);
  });

  it("surfaces why deposits are paused when config differs without blocking exits", () => {
    const html = renderToStaticMarkup(createElement(LendVault));
    expect(html).toContain("App and indexer contract settings do not match");
    expect(html).toContain("Indexer chain differs from this app");
    expect(html).toContain("New lending deposits are paused");
    expect(html).toContain("queued request");
    // plain words, same statement. 
    expect(html).toContain("isn&#x27;t an instant withdrawal");
    expect(html).toContain("No fixed time — it depends on available liquidity");
    // The label is state-aware; with the reads pending the vault is treated as
    // possibly open, so it reads "queued". The assertion is still that the DEPOSIT button is disabled.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Deposit \(queued — priced when flat\)<\/button>/);
    // The lookahead must exclude the ATTRIBUTE, not the word: every button's class list carries
    // Tailwind's `disabled:cursor-not-allowed disabled:opacity-60`, so `(?![^>]*disabled)` could
    // never match any button and this assertion was red at every base. See evidence.
    expect(html).toMatch(/<button(?![^>]*disabled="")[^>]*>Process queue<\/button>/);

    const source = readFileSync(fileURLToPath(new URL("./LendVault.tsx", import.meta.url)), "utf8");
    const terms = source.indexOf('<WithdrawalTerms surface="lending"');
    const confirm = source.indexOf('onClick={() => void act("Deposit into the lending vault"');
    expect(terms).toBeGreaterThan(-1);
    expect(confirm).toBeGreaterThan(terms);
  });

  // An env override the registry outranked is shown on the page, and it is not a reason to
  // pause deposits. The conflict itself is computed and unit-tested in lib/v2/config.test.ts.
  it("shows an override the registry outranked without pausing deposits", () => {
    const conflict = "NEXT_PUBLIC_V2_EARN_VAULT is set to 0x70556BaA315dD8d467ea452aBcd7deEbEa073Ff9, but the generated registry "
      + "records earnVault at 0x2222222222222222222222222222222222222222. This app uses the registry address; remove or correct the override.";
    // Once each: one render reads each once, and every other case keeps the real functions.
    vi.mocked(v2ConfigWarnings).mockReturnValueOnce([]);
    vi.mocked(v2AddressOverrideConflictNotices).mockReturnValueOnce([conflict]);
    const html = renderToStaticMarkup(createElement(LendVault));
    expect(html).toContain(conflict);
    expect(html).not.toContain("New lending deposits are paused");
  });

  it("states the terms box once, and the redeem's own queue outcome above the Redeem button", () => {
    const source = readFileSync(fileURLToPath(new URL("./LendVault.tsx", import.meta.url)), "utf8");
    expect(source.split('<WithdrawalTerms surface="lending"').length - 1).toBe(1);
    const redeemPanel = source.slice(source.indexOf("const redeemPanel ="));
    expect(source.indexOf("const redeemPanel =")).toBeGreaterThan(-1);
    const outcome = redeemPanel.indexOf("data-redeem-preview={redeemLine.outcome}");
    const earliest = redeemPanel.indexOf("data-earliest-withdrawal=");
    const confirm = redeemPanel.indexOf('onClick={() => void act("Redeem lending-vault shares"');
    expect(outcome).toBeGreaterThan(-1);
    expect(earliest).toBeGreaterThan(-1);
    expect(confirm).toBeGreaterThan(outcome);
    expect(confirm).toBeGreaterThan(earliest);

    const html = renderToStaticMarkup(createElement(LendVault));
    const occurrences = html.split("isn&#x27;t an instant withdrawal").length - 1;
    expect(occurrences).toBe(1);
    expect(html.indexOf("data-redeem-preview=")).toBeGreaterThan(html.indexOf('id="lend-redeem"'));
    expect(html.indexOf("data-redeem-preview=")).toBeLessThan(html.indexOf(">Redeem</button>"));
  });
});

/**
 * The interest percentage the page shows, its period label,
 * and the protocol skim beside it.
 *
 * WHAT THESE PIN, and why each is a separate case rather than one happy-path assertion: every
 * branch below is a refusal to render, and a refusal is exactly the kind of thing that decays into
 * a render when someone simplifies the conditional. The percentage without its period is the one
 * that matters most -- "4%" is not a terser "4% over the last 7 days", it is an unfalsifiable claim.
 */
describe("the /lend interest figure", () => {
  const vault = "0x0000000000000000000000000000000000000066" as const;
  const base = {
    vault,
    realisedUsdg: 4_000_000n, // 4 USDG realised
    balanceUsdg: 100_000_000n, // on 100 USDG deposited -> 4.00%
    periodLabel: "last 7 days",
    skimBps: 1_000, // 10.00%, read from the chain, not from the design doc
    ceilBps: 2_000,
  };

  it("states the percentage WITH its period and the skim beside it", () => {
    expect(lendInterestView(base)).toEqual({
      kind: "figure",
      percent: "4.00%",
      periodLabel: "last 7 days",
      skimPercent: "10.00%",
    });
  });

  it("refuses the percentage when the period is not labelled", () => {
    expect(lendInterestView({ ...base, periodLabel: "   " })).toEqual({ kind: "unlabelled-period" });
  });

  it("says nothing has been paid rather than dividing by an empty balance", () => {
    expect(lendInterestView({ ...base, balanceUsdg: 0n })).toEqual({ kind: "no-interest-yet" });
    expect(lendInterestView({ ...base, realisedUsdg: 0n })).toEqual({ kind: "no-interest-yet" });
  });

  it("distinguishes NOT READ from NO INTEREST, which are different claims", () => {
    // "the vault has paid nothing" is about the vault; "we did not read it" is about this page.
    // A depositor can act on the first and cannot on the second, so they must not render alike.
    expect(lendInterestView({ ...base, realisedUsdg: null })).toEqual({ kind: "not-read" });
    expect(lendInterestView({ ...base, balanceUsdg: null })).toEqual({ kind: "not-read" });
    expect(lendInterestView({ ...base, realisedUsdg: 0n }).kind).toBe("no-interest-yet");
  });

  it("reports an undeployed vault instead of a figure", () => {
    expect(lendInterestView({ ...base, vault: null })).toEqual({ kind: "unconfigured" });
  });

  it("states no skim rather than guessing one when skimBps was not read", () => {
    // The design doc says "~10%". Rendering that against a vault configured otherwise is a number
    // that looks right because nothing can see its subject.
    expect(lendInterestView({ ...base, skimBps: null })).toEqual({ kind: "not-read" });
  });

  it("refuses when the skim read exceeds its own on-chain ceiling", () => {
    expect(lendInterestView({ ...base, skimBps: 2_500, ceilBps: 2_000 })).toEqual({
      kind: "skim-above-ceiling",
      skimBps: 2_500,
      ceilBps: 2_000,
    });
  });

  it("computes the ratio in integer arithmetic, so a large balance does not go through a float", () => {
    // A realised amount too small to register at two decimals is still a REALISED amount, so it is
    // reported as 0.00% over the period rather than as "nothing paid yet". Those are different
    // claims and the depositor can tell them apart: one says the vault paid, the other says it did
    // not. Only a genuinely zero accrual takes the no-interest-yet branch.
    const dust = lendInterestView({ ...base, realisedUsdg: 1n, balanceUsdg: 3_000_000_000_000n });
    expect(dust).toEqual({ kind: "figure", percent: "0.00%", periodLabel: "last 7 days", skimPercent: "10.00%" });
    expect(lendInterestView({ ...base, realisedUsdg: 0n })).toEqual({ kind: "no-interest-yet" });
  });
});

/**
 * Three states, each rendered from the /v2/earn row the indexer builds from the
 * vault's own `indicativeAssetsPerShare()` / `hasOpenPosition()` -- never from `convertToAssets`, which
 * reverts while a position is open.
 */
describe("LendVault value per share", () => {
  const earnRow = (patch: Partial<EarnResponse["vaults"] extends (infer T)[] | undefined ? T : never>) => ({
    configured: true,
    vaults: [{
      vault, asset: USDG, adapter: null, fundingEnabled: true, sharesSupply: "10000000000000000000000",
      deposited: "10000000000", skimmed: null, ...patch,
    }],
    account: null,
  } as EarnResponse);

  it("shows the indicative figure with the mark label while a position is open", () => {
    vi.mocked(useEarn).mockReturnValue({ data: earnRow({
      indicativeAssetsPerShare: "1004000", indicativeTotalAssets: "10040000000", hasOpenPosition: true,
    }) } as ReturnType<typeof useEarn>);
    const html = renderToStaticMarkup(createElement(LendVault));
    // "Indicative value" -> "Estimated value"; the explanation moved into the heading's "?" tip.
    expect(html).toContain("Estimated value");
    expect(html).toMatch(/USDG per share<\/dt><dd[^>]*>1\.004<\/dd>/); // No zero tail
    expect(html).not.toContain("1.004000");
    expect(html).toContain("10K"); // 10,040 USDG, compact from 10,000
    // plain words, and the label is the tip's text (the tip is in the markup, hidden until opened).
    expect(INDICATIVE_VALUE_LABEL).toContain("valued at today's stock price");
    expect(html).toContain("valued at today&#x27;s stock price");
    expect(html).toContain('role="tooltip"');
    expect(html).not.toContain("oracle spot");
    expect(html).not.toContain("flat boundary");
    expect(html).not.toContain(FLAT_VALUE_LABEL);
  });

  it("shows the flat figure with the boundary label when no position is open", () => {
    vi.mocked(useEarn).mockReturnValue({ data: earnRow({
      indicativeAssetsPerShare: "1000000", indicativeTotalAssets: "10000000000", hasOpenPosition: false,
    }) } as ReturnType<typeof useEarn>);
    const html = renderToStaticMarkup(createElement(LendVault));
    expect(html).toMatch(/USDG per share<\/dt><dd[^>]*>1<\/dd>/); // 1.000000 per share reads 1
    expect(html).not.toContain("1.000000");
    expect(html).toContain(FLAT_VALUE_LABEL);
    expect(html).not.toContain("valued at today&#x27;s stock price");
  });

  it("says unavailable, never 0, when the figure is null", () => {
    vi.mocked(useEarn).mockReturnValue({ data: earnRow({
      indicativeAssetsPerShare: null, indicativeTotalAssets: null, hasOpenPosition: null,
    }) } as ReturnType<typeof useEarn>);
    const html = renderToStaticMarkup(createElement(LendVault));
    expect(html).toContain("The value per share is unavailable");
    // The "not the same as zero" padding is gone; it still never shows a 0.
    expect(html).not.toContain("0.000000");
  });

  it("treats an unread open-position flag as open, and a missing row as unavailable", () => {
    expect(lendValueView(vault, { vault, asset: USDG, adapter: null, fundingEnabled: true, sharesSupply: "1",
      deposited: null, skimmed: null, indicativeAssetsPerShare: "1000000", indicativeTotalAssets: null, hasOpenPosition: null }).kind).toBe("indicative");
    expect(lendValueView(vault, null).kind).toBe("unavailable");
    expect(lendValueView(null, null).kind).toBe("unconfigured");
  });
});

/**
 * EarnVault.setAdapter can write off a venue that stopped answering (VenueWrittenOff); the indexer sends each
 * write-off on the /v2/earn row (`venueWriteOffs`). The page says so beside the value it lowered, with the event's own
 * amount, and says nothing when there is none.
 */
describe("a venue write-off is shown on the Earn page", () => {
  const AT = 1_789_500_000;
  const TX = `0x${"ab".repeat(32)}`;
  const OLD_VENUE = "0x00000000000000000000000000000000000ad0a1";
  const earnWith = (venueWriteOffs?: { adapter: string; amount: string; ts: number; tx: string }[]) => ({
    configured: true,
    vaults: [{
      vault, asset: USDG, adapter: null, fundingEnabled: true, sharesSupply: "10000000000000000000000",
      deposited: "10000000000", skimmed: null,
      // A share value that has nothing to do with the write-off: the notice must not be worked out from it.
      indicativeAssetsPerShare: "990000", indicativeTotalAssets: "9900000000", hasOpenPosition: false,
      ...(venueWriteOffs === undefined ? {} : { venueWriteOffs }),
    }],
    account: null,
  } as EarnResponse);
  const day = timeText({ at: AT, dateOnly: true }, null);

  it("names the date and the event's own amount, and says the vault's total value fell by it, each share in proportion", () => {
    vi.mocked(useEarn).mockReturnValue({ data: earnWith([{ adapter: OLD_VENUE, amount: "12345678", ts: AT, tx: TX }]) } as ReturnType<typeof useEarn>);
    const html = renderToStaticMarkup(createElement(LendVault));
    expect(html).toContain(LEND_WRITE_OFF_TITLE);
    expect(html).toContain(`>On <time dateTime="${new Date(AT * 1000).toISOString()}">${day}</time> the vault wrote off ${fmtUsdg(12_345_678n)} USDG left at a lending venue that stopped responding. The total value of the vault fell by that amount, and the value of each share fell in proportion.</p>`);
  });

  it("says a zero write-off did not change the share value, and lists every write-off newest first", () => {
    vi.mocked(useEarn).mockReturnValue({ data: earnWith([
      { adapter: OLD_VENUE, amount: "5000000", ts: AT, tx: TX },
      { adapter: OLD_VENUE, amount: "0", ts: AT - 86_400, tx: TX },
    ]) } as ReturnType<typeof useEarn>);
    const html = renderToStaticMarkup(createElement(LendVault));
    const newer = html.indexOf(`the vault wrote off ${fmtUsdg(5_000_000n)} USDG`);
    const older = html.indexOf("Its last known balance there was 0 USDG, so the share value did not change.");
    expect(newer).toBeGreaterThan(-1);
    expect(older).toBeGreaterThan(newer);
    expect(html).toContain(`${timeText({ at: AT - 86_400, dateOnly: true }, null)}</time> the vault wrote off its balance at a lending venue that stopped responding.`);
    expect(lendWriteOffLines(earnWith([{ adapter: OLD_VENUE, amount: "0", ts: AT, tx: TX }]).vaults![0])).toEqual([{ at: AT, amount: 0n, tx: TX }]);
  });

  it("shows no notice when the vault has had no write-off, or the indexer does not send the field", () => {
    for (const none of [[], undefined]) {
      vi.mocked(useEarn).mockReturnValue({ data: earnWith(none) } as ReturnType<typeof useEarn>);
      const html = renderToStaticMarkup(createElement(LendVault));
      expect(html).toContain("USDG per share"); // the value block rendered, so the page did render
      expect(html).not.toContain(LEND_WRITE_OFF_TITLE);
      expect(html).not.toContain("wrote off");
    }
    expect(lendWriteOffLines(null)).toEqual([]);
  });
});

/*//////////////////////////////////////////////////////////////
                 -- EARN VAULT PAGE BLOCKS
//////////////////////////////////////////////////////////////*/

import { useEarnVaultReads } from "@/lib/v2/hooks";
import type { EarnVaultReads } from "@/lib/v2/chainReads";
import { VAULT_INDICATIVE_LABEL, EARN_NO_VENUE } from "@/lib/v2/vaultCopy";
import { earnDepositLabel, earnHeroModel, earnProofRows, earnVaultEmpty, earnVenueLine, LEND_QUEUE_FLAT, LEND_QUEUE_OPEN, LEND_QUEUE_PRICE_UNREAD, LEND_QUEUE_VENUE_UNREADABLE,
  LEND_QUEUED_PREVIEW_VENUE_UNREADABLE, lendDepositQueuedMessage, lendQueuedPreviewLine, lendQueueState, LendVault as LendVaultPage } from "./LendVault";
import { NOT_READ } from "./VaultHero";
import { EARN_NO_SHARES_LABEL, EARN_NO_SHARES_VALUE } from "@/lib/v2/vaultCopy";

const earnReads = (over: Partial<EarnVaultReads> = {}): EarnVaultReads => ({
  hasOpenPosition: true, shareDecimals: 18, assetsPerShare: null, totalAssets: null, indicativeAssetsPerShare: 1_007_100n, indicativeTotalAssets: 412_880_000_000n,
  totalSupply: 410_000n * 10n ** 18n, skimBps: 0, skimCeilBps: 1000, highWaterMark: 1_000_000n, adapter: "0x0000000000000000000000000000000000000000",
  splitter: "0x00000000000000000000000000000000000000aa", balance: 5_000n * 10n ** 18n, venueUnreadable: false, ...over,
});
const esc122 = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
const statValue = (html: string, id: string) => {
  const cell = new RegExp(`data-stat="${id}"[\\s\\S]*?data-slot="stat-value"[^>]*>([\\s\\S]*?)</div>`).exec(html);
  return cell ? cell[1].replace(/<[^>]+>/g, "") : null;
};

describe("LendVault vault-page blocks", () => {
  it("hero: open position shows the INDICATIVE mark and never the flat-path number", () => {
    const h = earnHeroModel(earnReads({ assetsPerShare: 999n }));
    expect(h.open).toBe(true);
    expect(h.value).toEqual({ text: "1.0071 USDG", label: VAULT_INDICATIVE_LABEL, tone: "caution" });
    expect(h.positionAtMark?.label).toBe("indicative");
  });

  /**
   * A vault with 100 USDG in, half redeemed, so the wallet holds 50 whole shares (50e18 base units) at
   * one USDG a share. The position is the balance over ONE WHOLE SHARE AT decimals(): with 6-dp shares the same 50 shares
   * are 50e6 base units and still 50 USDG. RED if the divisor is hard-coded to 1e18 again (the 6-dp case shows 0).
   * An unread decimals() shows no position value rather than one in a guessed unit.
   */
  it("hero: the position is worth balance x price per whole share at the vault's decimals()", () => {
    const flat = { hasOpenPosition: false, assetsPerShare: 1_000_000n, totalAssets: 50_000_000n, totalSupply: 50n * 10n ** 18n };
    expect(earnHeroModel(earnReads({ ...flat, balance: 50n * 10n ** 18n })).positionAtMark?.text).toBe("50 USDG");
    expect(earnHeroModel(earnReads({ ...flat, shareDecimals: 6, balance: 50_000_000n })).positionAtMark?.text).toBe("50 USDG");
    expect(earnHeroModel(earnReads({ ...flat, shareDecimals: null, balance: 50n * 10n ** 18n })).positionAtMark?.text).toBeNull();
    expect(earnHeroModel(earnReads(flat)).value.text).toBe("1 USDG");
  });

  /**
   * The hero's share count is the wallet's balance formatted at the vault's decimals(): the
   * same 50 whole shares read "50 shares" whether one share is 1e18 or 1e6 base units. RED if LendVault formats the
   * count at a hard-coded 18 again (the 6-dp balance then shows as dust) or at any other fixed scale (the 18-dp balance
   * then shows as trillions). An unread decimals() shows "not read", never a count in a guessed unit.
   */
  it("hero: the wallet's share count is its balance at the vault's decimals()", () => {
    const heroShares = (reads: EarnVaultReads) => {
      vi.mocked(useEarnVaultReads).mockReturnValue({ data: reads } as unknown as ReturnType<typeof useEarnVaultReads>);
      const html = renderToStaticMarkup(createElement(LendVaultPage));
      return statValue(html, "your-position");
    };
    expect(heroShares(earnReads({ balance: 50n * 10n ** 18n })), "the hero cell was located -- the control").toBe("50 shares");
    expect(heroShares(earnReads({ shareDecimals: 6, balance: 50_000_000n }))).toBe("50 shares");
    expect(heroShares(earnReads({ shareDecimals: 6, balance: 12_345_678n }))).toBe("12.3456 shares");
    expect(heroShares(earnReads({ shareDecimals: null, balance: 50n * 10n ** 18n }))).toBe(NOT_READ);
  });

  it("hero: only an observed flat vault gets the current figure; an unread flag stays indicative", () => {
    const flat = earnHeroModel(earnReads({ hasOpenPosition: false, assetsPerShare: 1_002_000n, totalAssets: 10_000_000n }));
    expect(flat.value).toMatchObject({ text: "1.002 USDG", label: "current" }); // No zero tail
    expect(earnHeroModel(earnReads({ hasOpenPosition: null })).open).toBe(true);
    expect(earnHeroModel(null).value.text).toBeNull();
  });

  it("venue, deposit label and proof follow the reads", () => {
    expect(earnVenueLine(earnReads())).toBe(EARN_NO_VENUE);
    expect(earnVenueLine(null)).toBeNull();
    expect(earnDepositLabel(true)).toBe("Deposit (queued — priced when flat)");
    expect(earnDepositLabel(false)).toBe("Deposit (instant)");
    // An unreadable venue queues deposits too; an open position is still named first.
    expect(earnDepositLabel(false, true)).toBe("Deposit (queued until the venue can be read)");
    expect(earnDepositLabel(true, true)).toBe("Deposit (queued — priced when flat)");
    expect(earnDepositLabel(false, false)).toBe("Deposit (instant)");
    expect(lendQueueState(false, true)).toBe(LEND_QUEUE_VENUE_UNREADABLE);
    expect(lendQueueState(false, false)).toBe(LEND_QUEUE_FLAT);
    expect(lendQueueState(true, true)).toBe(LEND_QUEUE_OPEN);
    // P3: an unread venue probe (null, or no read yet) never promises "instant" / "go in now".
    expect(earnDepositLabel(false, null)).toBe("Deposit (may queue)");
    expect(lendQueueState(false, null)).toBe(LEND_QUEUE_PRICE_UNREAD);
    expect(lendQueueState(false, undefined)).toBe(LEND_QUEUE_PRICE_UNREAD);
    expect(lendDepositQueuedMessage(7n, false, true)).toBe("Deposit queued as request #7. It goes in once the lending venue can be read again.");
    expect(lendDepositQueuedMessage(7n, true, true)).toBe("Deposit queued as request #7. It goes in once the open options settle.");
    expect(lendDepositQueuedMessage(7n, false, false)).toBe("Deposit queued as request #7. It goes in once the open options settle.");
    const venue = earnProofRows(vault, earnReads(), { burnBps: 5000, treasury: null }).find((r) => r.label === "Venue adapter")!;
    expect(venue).toMatchObject({ value: null, note: "none attached" });
  });

  it("renders the blocks, the read skim line, and the state-aware button", () => {
    vi.mocked(useConfig).mockReturnValue({ data: matchingConfig, isError: false } as ReturnType<typeof useConfig>);
    vi.mocked(useEarnVaultReads).mockReturnValue({ data: earnReads() } as unknown as ReturnType<typeof useEarnVaultReads>);
    const html = renderToStaticMarkup(createElement(LendVaultPage));
    for (const label of ["USDG lending vault summary", "Where the return comes from", "What it costs", "How to exit", "What can go wrong", "History", "On chain"])
      expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain(esc122(VAULT_INDICATIVE_LABEL));
    // The skim line through displayRatioPercent (lib/v2/vaultCopy.ts earnSkimLine), exact.
    expect(html).toContain(
      "Skim 0% now (up to 10%), taken only on realised gains above the previous high, and only when no call is open and no queue is waiting.",
    );
    expect(html).toContain("Deposit (queued — priced when flat)");
    expect(html).toContain("No chart yet");
  });
});

/**
 * The page wires the indexer's earliestWithdrawal and the public rate: rendered from a /v2/earn row the
 * way sends it, with skimBps coming from the CHAIN reads (useEarnVaultReads), never from the row.
 */
describe("/lend: earliest withdrawal and the public rate", () => {
  const apy = (bps: number | null) => ({ bps, reason: bps === null ? "short-history" as const : null,
    from: bps === null ? null : 1_789_581_600, to: 1_790_186_400 });
  const earnRow = {
    vault, asset: USDG, adapter: "0x0000000000000000000000000000000000000077", fundingEnabled: true, sharesSupply: "100",
    deposited: "1000", skimmed: null, indicativeAssetsPerShare: null, indicativeTotalAssets: null, hasOpenPosition: false,
    apy7d: apy(412), apy30d: apy(null), totalAssets: "7000000",
    venue: { address: "0xBeEff033F34C046626B8D0A041844C5d1A5409dd", name: "Steakhouse USDG", apy24h: apy(520), apy7d: apy(500),
      withdrawable: "5000000", withdrawableSource: "position" as const, position: "5000000" },
    earliestWithdrawal: { kind: "now" as const, at: 1_790_186_400, reason: "liquid" as const, liquidityCap: "6000000" },
  };

  it("shows the line with its reason, the realised and venue rates, and the net from the skim READ on chain", async () => {
    const { useEarnVaultReads } = await import("@/lib/v2/hooks");
    vi.mocked(useEarn).mockReturnValue({ data: { configured: true, vaults: [earnRow], account: null } } as unknown as ReturnType<typeof useEarn>);
    vi.mocked(useEarnVaultReads).mockReturnValue({ data: { ...earnReads(), skimBps: 800, skimCeilBps: 1_000 } } as unknown as ReturnType<typeof useEarnVaultReads>);
    try {
      const html = renderToStaticMarkup(createElement(LendVault));
      expect(html).toContain("Earliest withdrawal<");
      expect(html).toContain("Now (up to 6 USDG available)"); // No zero tail
      expect(html).toContain('data-earliest-withdrawal="liquid"');
      expect(html).toContain('aria-label="Interest rate"');
      expect(html).toContain("4.12%");
      expect(html).toContain("Steakhouse USDG");
      // 5.00% x (1 - 800 / 10_000) = 4.60%: the cut is the vault's 8%, not a typed 10%.
      expect(html).toContain("4.60%");
      expect(html).not.toContain("4.50%");
      expect(html).not.toContain("Observed yield is not shown on this page yet");
    } finally {
      vi.mocked(useEarnVaultReads).mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useEarnVaultReads>);
    }
  });

  it("an older indexer: the line says Unavailable and the rate panel says it is not reported", () => {
    vi.mocked(useEarn).mockReturnValue({ data: { configured: true, vaults: [{ ...earnRow, apy7d: undefined, apy30d: undefined,
      venue: undefined, earliestWithdrawal: undefined }], account: null } } as unknown as ReturnType<typeof useEarn>);
    const html = renderToStaticMarkup(createElement(LendVault));
    expect(html).toContain('data-earliest-withdrawal="not-sent"');
    // shortened (the "not the same as zero" padding is gone); still states the rate is not reported.
    expect(html).toContain("interest rate isn&#x27;t reported yet");
  });
});

/**
 * /lend shows the wallet's open requests in THIS vault as cards, and says before a redeem whether it pays
 * now or queues. Rendered from a /v2/earn response the way the indexer sends it (indexer/src/api/v2/earn.ts).
 */
describe("/lend: queued request cards and the redeem preview", () => {
  const EXPIRY = 1_790_366_400;
  const row = (earliestWithdrawal: unknown) => ({
    vault, asset: USDG, adapter: null, fundingEnabled: true, sharesSupply: "100", deposited: "1000", skimmed: null,
    indicativeAssetsPerShare: null, indicativeTotalAssets: null, hasOpenPosition: true, queue: { depth: 2, oldestRequestedAt: 1 },
    earliestWithdrawal,
  });
  const queued = (over: Record<string, unknown>) => ({
    id: `${vault}-5`, status: "queued", sharesQueued: "3000000000000000000", assetsRequested: null, fulfilledAssets: null,
    requestedAt: 1, vault, queueId: "5", kind: "withdrawal", assetsQueued: null, sharesEscrowed: "3000000000000000000",
    position: 1, ...over,
  });

  it("renders a card per open request in this vault -- never another vault's -- and the queue preview on Redeem", () => {
    vi.mocked(useEarn).mockReturnValue({ data: { configured: true,
      vaults: [row({ kind: "queued", at: EXPIRY, reason: "open-position", liquidityCap: null })],
      account: { address: account, shares: null, queued: [
        queued({}),
        queued({ id: `${vault}-6`, queueId: "6", kind: "deposit", sharesQueued: "0", sharesEscrowed: "0", assetsQueued: "250000000", position: 2 }),
        queued({ id: "0x0000000000000000000000000000000000000077-9", vault: "0x0000000000000000000000000000000000000077", queueId: "9" }),
      ] } } } as unknown as ReturnType<typeof useEarn>);
    const html = renderToStaticMarkup(createElement(LendVault));
    expect(html).toContain("Your queued lending requests");
    expect(html).toContain("Queued withdrawal #5");
    expect(html).toContain("Queued deposit #6");
    expect(html).not.toContain("#9");
    expect(html).toContain("Cancel and return shares");
    expect(html).toContain("Cancel and return USDG");
    expect(html).toContain("2 requests waiting in the queue, below.");
    expect(html).toContain('data-redeem-preview="queues"');
    expect(html).toContain("Will queue: the vault has an option that settles after");
  });

  it("with nothing queued there is no card section, and an unread vault state previews Unavailable, never paid now", () => {
    vi.mocked(useEarn).mockReturnValue({ data: { configured: true,
      vaults: [row({ kind: "unknown", at: null, reason: "not-read", liquidityCap: null })],
      account: { address: account, shares: null, queued: [] } } } as unknown as ReturnType<typeof useEarn>);
    const html = renderToStaticMarkup(createElement(LendVault));
    expect(html).not.toContain("Your queued lending requests");
    expect(html).toContain('data-redeem-preview="unknown"');
    expect(html).not.toContain("Paid now");
  });
});

/**
 * The contract previews on /lend, RENDERED: each surface has a case that goes red if its paragraph is
 * removed. A static render never types, so `typed` hands LendVault's two amount fields (its first two `useState("")`,
 * deposit then redeem) a value, and every case checks the input's value first so the text is known to have landed in
 * the right field. `answers` returns a result for each named preview query (the second queryKey element); every other
 * query stays unread. The numbers come from the mocked contract answers, never from local math.
 */
describe("/lend: the contract previews are shown before the user confirms", () => {
  const unread = { isPending: false, isError: false, data: undefined };
  let realUseState: typeof useState;
  beforeAll(async () => { realUseState = (await vi.importActual<typeof import("react")>("react")).useState; });
  afterEach(() => {
    vi.mocked(useState).mockImplementation(realUseState);
    vi.mocked(useQuery).mockImplementation((() => unread) as never);
    vi.mocked(useEarnVaultReads).mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useEarnVaultReads>);
  });
  const typed = (deposit: string, redeem: string) => {
    const fields = [deposit, redeem];
    vi.mocked(useState).mockImplementation(((init?: unknown) =>
      realUseState(init === "" && fields.length > 0 ? fields.shift() : init)) as typeof useState);
  };
  const answers = (byName: Record<string, Record<string, unknown>>) => {
    vi.mocked(useQuery).mockImplementation(((options: { queryKey?: unknown }) => {
      const key = options?.queryKey;
      const name = Array.isArray(key) && key[0] === "v2" ? String(key[1]) : "";
      return name in byName ? { ...unread, ...byName[name] } : unread;
    }) as never);
  };
  // A flat vault (convertToAssets readable at 1.50 USDG a share), and an indexer that says the vault can pay 6 USDG now.
  const flatVault = (queued: unknown[] = []) => {
    vi.mocked(useEarnVaultReads).mockReturnValue({ data: earnReads({ hasOpenPosition: false, assetsPerShare: 1_500_000n }) } as
      unknown as ReturnType<typeof useEarnVaultReads>);
    vi.mocked(useEarn).mockReturnValue({ data: { configured: true, vaults: [{
      vault, asset: USDG, adapter: null, fundingEnabled: true, sharesSupply: "100", deposited: "1000", skimmed: null,
      indicativeAssetsPerShare: null, indicativeTotalAssets: null, hasOpenPosition: false,
      queue: { depth: queued.length, oldestRequestedAt: queued.length ? 1 : null },
      earliestWithdrawal: { kind: "now", at: 1_790_186_400, reason: "liquid", liquidityCap: "6000000" },
    }], account: { address: account, shares: null, queued } } } as unknown as ReturnType<typeof useEarn>);
  };
  const render = () => renderToStaticMarkup(createElement(LendVault));
  const slot = (html: string, name: string) => html.match(new RegExp(`<p data-slot="${name}"[^>]*>([^<]*)</p>`))?.[1] ?? null;
  const TYPED_DEPOSIT = /id="lend-deposit"[^>]*value="12.5"/;
  const TYPED_REDEEM = /id="lend-redeem"[^>]*value="2"/;

  it("deposit: previewDeposit's shares sit between the amount and the Redeem panel; queued, pending and a revert say so", () => {
    flatVault();
    typed("12.5", "");
    const shares = { ok: true as const, shares: 12_412_000_000_000_000_000n, queued: false };
    answers({ "earn-deposit-preview": { data: shares } });
    let html = render();
    expect(html).toMatch(TYPED_DEPOSIT);
    expect(slot(html, "earn-deposit-preview")).toBe(formatEarnDepositPreview(shares, 18));
    expect(slot(html, "earn-deposit-preview")).toBe("You would receive 12.412 shares.");
    expect(html.indexOf('data-slot="earn-deposit-preview"')).toBeGreaterThan(html.indexOf('id="lend-deposit"'));
    expect(html.indexOf('data-slot="earn-deposit-preview"')).toBeLessThan(html.indexOf('id="lend-redeem"'));

    typed("12.5", "");
    answers({ "earn-deposit-preview": { data: { ok: true, shares: 0n, queued: true } } });
    expect(slot(render(), "earn-deposit-preview")).toBe("This deposit will queue. No shares are minted until it is served.");

    typed("12.5", "");
    answers({ "earn-deposit-preview": { isPending: true } });
    expect(slot(render(), "earn-deposit-preview")).toBe("Checking what this deposit would do…");

    typed("12.5", "");
    answers({ "earn-deposit-preview": { data: { ok: false } } });
    html = render();
    expect(slot(html, "earn-deposit-preview")).toBe(CANNOT_PREVIEW);
    expect(html).not.toContain("You would receive");
  });

  it("redeem: previewRedeem's amount sits above Redeem, and the indexer's paid-now line stands only when it pays now", () => {
    flatVault();
    typed("", "2");
    const pays = { ok: true as const, assets: 3_250_000n, queued: false, needsVenue: false };
    answers({ "earn-redeem-preview": { data: pays } });
    const html = render();
    expect(html).toMatch(TYPED_REDEEM);
    expect(slot(html, "earn-redeem-preview")).toBe(formatEarnRedeemPreview(pays));
    expect(slot(html, "earn-redeem-preview")).toBe("You would receive 3.25 USDG now.");
    expect(html.indexOf('data-slot="earn-redeem-preview"')).toBeGreaterThan(html.indexOf('id="lend-redeem"'));
    expect(html.indexOf('data-slot="earn-redeem-preview"')).toBeLessThan(html.indexOf(">Redeem</button>"));
    // Positive control for the P3 cases below: with the contract paying, the indexer's cash line is shown.
    expect(html).toContain("Paid now: about 3 USDG");
  });

  it.each([
    ["needs the venue", { data: { ok: true, assets: 3_250_000n, queued: false, needsVenue: true } },
      "You would receive 3.25 USDG only if the lending venue delivers the rest.", "Not guaranteed until the lending venue delivers the rest"],
    ["queues", { data: { ok: true, assets: 0n, queued: true, needsVenue: false } },
      "This withdrawal will queue. Nothing is paid now.", "Will queue: the vault&#x27;s own preview says this amount is not paid now"],
    ["is still pending", { isPending: true },
      "Checking what this withdrawal would pay…", "No amount is shown until the vault&#x27;s own preview answers"],
    ["reverted", { data: { ok: false } },
      CANNOT_PREVIEW, "No amount is shown until the vault&#x27;s own preview answers"],
    ["failed to load", { isError: true },
      CANNOT_PREVIEW, "No amount is shown until the vault&#x27;s own preview answers"],
  ] as const)("redeem: when previewRedeem %s, no paid-now cash amount is shown", (_label, result, contractLine, indexerLine) => {
    flatVault();
    typed("", "2");
    answers({ "earn-redeem-preview": result });
    const html = render();
    expect(html).toMatch(TYPED_REDEEM);
    expect(slot(html, "earn-redeem-preview")).toBe(contractLine);
    expect(html).toContain(indexerLine);
    expect(html).not.toContain("Paid now: about");
  });

  it("a queued request card shows previewQueued's amount; a failed read shows cannot preview, never a number", () => {
    const request = { id: `${vault}-5`, status: "queued", sharesQueued: "3000000000000000000", assetsRequested: null,
      fulfilledAssets: null, requestedAt: 1, vault, queueId: "5", kind: "withdrawal", assetsQueued: null,
      sharesEscrowed: "3000000000000000000", position: 1 };
    flatVault([request]);
    answers({ "earn-queued-preview": { data: { 5: "If served now: 4 USDG." } } });
    let html = render();
    expect(html).toContain("Queued withdrawal #5");
    expect(slot(html, "queued-contract-preview")).toBe("If served now: 4 USDG.");

    answers({ "earn-queued-preview": { isError: true } });
    html = render();
    expect(slot(html, "queued-contract-preview")).toBe(CANNOT_PREVIEW);
    expect(html).not.toContain("If served now");
  });

  // (every queued card, deposit and withdrawal). While the vault cannot
  // price its venue, previewQueued still quotes a figure at the last known venue value (headNow false), next to
  // the card's "can't price" reason. No card shows it then, and none shows one while the venue flag is unread.
  it("no queued card shows previewQueued's estimate while the venue cannot be read, or its read failed", () => {
    const withdrawal = { id: `${vault}-5`, status: "queued", sharesQueued: "3000000000000000000", assetsRequested: null,
      fulfilledAssets: null, requestedAt: 1, vault, queueId: "5", kind: "withdrawal", assetsQueued: null,
      sharesEscrowed: "3000000000000000000", position: 1 };
    const deposit = { ...withdrawal, id: `${vault}-6`, queueId: "6", kind: "deposit", sharesQueued: "0", sharesEscrowed: "0",
      assetsQueued: "250000000", position: 2 };
    const lines = { 5: "Estimate, earlier requests are served first: 4 USDG.",
      6: "Estimate, earlier requests are served first: 166.66 shares." };
    const venue = (data: EarnVaultReads | undefined, isError = false) => vi.mocked(useEarnVaultReads).mockReturnValue(
      { data, isError } as unknown as ReturnType<typeof useEarnVaultReads>);
    const cardLines = (html: string) =>
      [...html.matchAll(/<p data-slot="queued-contract-preview"[^>]*>([^<]*)<\/p>/g)].map((m) => m[1]).sort();
    flatVault([withdrawal, deposit]);
    answers({ "earn-queued-preview": { data: lines } });

    // The control: a readable venue shows both figures, as before this change.
    venue(earnReads({ hasOpenPosition: false, assetsPerShare: 1_500_000n, venueUnreadable: false }));
    let html = render();
    expect(html).toContain("Queued withdrawal #5");
    expect(html).toContain("Queued deposit #6");
    expect(cardLines(html)).toEqual([lines[5], lines[6]].sort());

    venue(earnReads({ hasOpenPosition: false, assetsPerShare: null, venueUnreadable: true }));
    html = render();
    expect(cardLines(html)).toEqual([esc122(LEND_QUEUED_PREVIEW_VENUE_UNREADABLE), esc122(LEND_QUEUED_PREVIEW_VENUE_UNREADABLE)]);
    expect(html).not.toContain("Estimate, earlier requests");
    expect(html).not.toContain("4 USDG");
    expect(html).not.toContain("166.66 shares");

    // A failed read, a pending one, an unread venue probe (null), and a failed REFETCH that kept the last readable
    // answer in `data` (react-query keeps it beside isError) show no figure either.
    for (const unread of [() => venue(undefined, true), () => venue(undefined),
      () => venue(earnReads({ hasOpenPosition: false, assetsPerShare: null, venueUnreadable: null })),
      () => venue(earnReads({ hasOpenPosition: false, assetsPerShare: 1_500_000n, venueUnreadable: false }), true)]) {
      unread();
      html = render();
      expect(cardLines(html)).toEqual([CANNOT_PREVIEW, CANNOT_PREVIEW]);
      expect(html).not.toContain("Estimate, earlier requests");
    }
  });

  it("lendQueuedPreviewLine shows the contract's line only on an observed readable venue", () => {
    const line = "If served now: 4 USDG.";
    expect(lendQueuedPreviewLine(false, false, line)).toBe(line);
    expect(lendQueuedPreviewLine(false, false, undefined)).toBeNull(); // pending preview, readable venue: as today
    expect(lendQueuedPreviewLine(false, true, line)).toBe(CANNOT_PREVIEW);
    expect(lendQueuedPreviewLine(true, false, line)).toBe(LEND_QUEUED_PREVIEW_VENUE_UNREADABLE);
    expect(lendQueuedPreviewLine(true, true, line)).toBe(LEND_QUEUED_PREVIEW_VENUE_UNREADABLE);
    expect(lendQueuedPreviewLine(null, false, line)).toBe(CANNOT_PREVIEW);
    expect(lendQueuedPreviewLine(undefined, false, line)).toBe(CANNOT_PREVIEW);
  });
});

/**
 * On an empty vault both per-share views return 0 (EarnVault `convertToAssets` and
 * `indicativeAssetsPerShare` on `supply == 0`), so the hero printed "0.0000 USDG current" -- a price nobody can get --
 * while the indexer's notice below it said the value was unavailable. The empty state is keyed on the totalSupply
 * READ, never on the value, so a real zero with shares outstanding still shows 0 and a failed read still says so.
 */
describe("/lend: an empty vault states it has no shares", () => {
  const indexerRow = { configured: true, account: null, vaults: [{ vault, asset: USDG, adapter: null, fundingEnabled: true, sharesSupply: "0",
    deposited: "0", skimmed: null, indicativeAssetsPerShare: null, indicativeTotalAssets: null, hasOpenPosition: false }] };
  const render = (reads: EarnVaultReads) => {
    vi.mocked(useEarn).mockReturnValue({ data: indexerRow } as unknown as ReturnType<typeof useEarn>);
    vi.mocked(useEarnVaultReads).mockReturnValue({ data: reads } as unknown as ReturnType<typeof useEarnVaultReads>);
    return renderToStaticMarkup(createElement(LendVault));
  };
  const heroValue = (html: string) => statValue(html, "share-price");
  const noNumericPerShare = (html: string) => {
    expect(html).not.toContain("0.0000 USDG");
    expect(html).not.toContain("USDG per share"); // the LendValue panel's figure
    expect(html).not.toContain("value per share is unavailable");
  };

  it("flat and empty: the hero says there are no shares, and no value per share is printed anywhere", () => {
    const html = render(earnReads({ hasOpenPosition: false, totalSupply: 0n, assetsPerShare: 0n, totalAssets: 0n, balance: null }));
    expect(heroValue(html), "the hero cell was located -- the control").toBe(EARN_NO_SHARES_VALUE);
    expect(html).toContain(esc122(EARN_NO_SHARES_LABEL));
    noNumericPerShare(html);
  });

  it("open and empty, with indicative marks of 0: the same no-shares state", () => {
    const html = render(earnReads({ hasOpenPosition: true, totalSupply: 0n, indicativeAssetsPerShare: 0n, indicativeTotalAssets: 0n, balance: null }));
    expect(heroValue(html)).toBe(EARN_NO_SHARES_VALUE);
    noNumericPerShare(html);
  });

  // With the venue unreadable the vault queues deposits too, so "Deposits go in now" would be false.
  it("a flat vault that cannot read its venue says deposits and withdrawals wait, and the deposit button says queued", () => {
    const html = render(earnReads({ hasOpenPosition: false, totalSupply: 10n ** 18n, assetsPerShare: null, totalAssets: 1n, venueUnreadable: true }));
    expect(html).toContain(esc122(LEND_QUEUE_VENUE_UNREADABLE));
    expect(html).not.toContain(esc122(LEND_QUEUE_FLAT));
    expect(html).toContain("Deposit (queued until the venue can be read)");
    expect(html).not.toContain("Deposit (instant)");
    const readable = render(earnReads({ hasOpenPosition: false, totalSupply: 10n ** 18n, assetsPerShare: 1n, totalAssets: 1n, venueUnreadable: false }));
    expect(readable).toContain(esc122(LEND_QUEUE_FLAT));
    expect(readable).toContain("Deposit (instant)");
  });

  it("a real zero with shares outstanding is still shown as 0", () => {
    const html = render(earnReads({ hasOpenPosition: false, totalSupply: 10n ** 18n, assetsPerShare: 0n, totalAssets: 0n }));
    expect(heroValue(html)).toBe("0 USDG"); // No zero tail
    expect(html).not.toContain(EARN_NO_SHARES_VALUE);
  });

  it("an UNREAD supply never produces the no-shares state", () => {
    const html = render(earnReads({ hasOpenPosition: false, totalSupply: null, assetsPerShare: 0n, totalAssets: 0n }));
    expect(heroValue(html)).toBe("0 USDG"); // No zero tail
    expect(html).not.toContain(EARN_NO_SHARES_VALUE);
    expect(earnVaultEmpty(earnReads({ totalSupply: null }))).toBe(false);
    expect(earnVaultEmpty(null)).toBe(false);
  });

  it("a failed value read still renders 'not read'", () => {
    const html = render(earnReads({ hasOpenPosition: false, totalSupply: 10n ** 18n, assetsPerShare: null, totalAssets: null }));
    expect(heroValue(html)).toBe(NOT_READ);
    expect(earnHeroModel(earnReads({ hasOpenPosition: false, totalSupply: 0n, assetsPerShare: null })).value.text).toBe(EARN_NO_SHARES_VALUE);
  });

  it("lendValueView: the chain's empty answer outranks the indexer row; without it nothing changes", () => {
    expect(lendValueView(vault, null, true).kind).toBe("no-shares");
    expect(lendValueView(vault, null).kind).toBe("unavailable");
    expect(lendValueView(null, null, true).kind).toBe("unconfigured");
  });
});

/*
 * /lend shows a payment the vault HELD for this wallet, read on chain, with a Claim.
 */
describe("/lend: payments held for you", () => {
  it("a wallet with a held payment sees it, with its amount and an enabled Claim to a receiver it can change", () => {
    vi.mocked(useHeldPayments).mockReturnValue({ data: { status: "ok", complete: true, checked: 4,
      items: [{ vault, id: 4n, owner: account, receiver: account, assets: 3_000_000n }] } } as unknown as ReturnType<typeof useHeldPayments>);
    const html = renderToStaticMarkup(createElement(LendVault));
    expect(vi.mocked(useHeldPayments)).toHaveBeenCalledWith(vault, account);
    expect(html).toContain("Payments held for you");
    expect(html).toContain("Held payment for request #4");
    expect(html).toContain("3 USDG"); // No zero tail
    expect(html).toContain(`value="${account}"`);
    expect(html).toMatch(/<button(?![^>]* disabled="")[^>]*>Claim<\/button>/);
  });

  it("nothing held: no section; a failed read: says it could not check, never that nothing is held", () => {
    vi.mocked(useHeldPayments).mockReturnValue({ data: { status: "ok", complete: true, checked: 0, items: [] } } as unknown as ReturnType<typeof useHeldPayments>);
    expect(renderToStaticMarkup(createElement(LendVault))).not.toContain("Payments held for you");
    vi.mocked(useHeldPayments).mockReturnValue({ data: { status: "unavailable", reason: "rpc" } } as unknown as ReturnType<typeof useHeldPayments>);
    expect(renderToStaticMarkup(createElement(LendVault))).toContain("could not be checked right now");
  });

  it("the queued-redeem success line no longer promises automatic payment unqualified", () => {
    const source = readFileSync(fileURLToPath(new URL("./LendVault.tsx", import.meta.url)), "utf8");
    // shortened, and still qualified: a payment that cannot be delivered is held, and the line says where.
    expect(source).toContain('If it can\'t be delivered, it\'s held for you under "${HELD_SECTION_TITLE}".');
  });
});

/*
 * EarnVault.deposit has no pause of its own, so while the chain says the whole deployment is paused (trading
 * AND every market's mint) the deposit button is closed with one note; redeem, cancel and claim are not touched. The
 * deposit button is also disabled by its empty amount input in a static render, so the gate is proven through
 * `depositDoor` (lib/v2/upgradePause.test.ts), the rendered note, and the one wiring line below.
 */
import { useMarkets } from "@/lib/v2/hooks";
import { UPGRADE_PAUSE_NOTE, UPGRADE_PAUSE_UNREAD_NOTE } from "@/lib/v2/upgradePause";

describe("the lending deposit closes while the deployment is paused for an upgrade", () => {
  const markets = (tradingPaused: boolean, mintPaused: boolean) => vi.mocked(useMarkets).mockReturnValue({
    data: [{ ticker: "NVDA", tradingPaused, mintPaused }, { ticker: "SPCX", tradingPaused, mintPaused }], isError: false,
  } as unknown as ReturnType<typeof useMarkets>);
  const page = () => { vi.mocked(v2ConfigWarnings).mockReturnValueOnce([]); return renderToStaticMarkup(createElement(LendVault)); };

  it("paused: the deposit says it is paused for upgrade; redeem and Process queue stay enabled", () => {
    markets(true, true);
    const html = page();
    expect(html).toContain('data-slot="upgrade-paused"');
    expect(html).toContain(UPGRADE_PAUSE_NOTE);
    // Either label (instant or queued) depending on the vault reads other cases left mocked; the button is the deposit.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Deposit \((instant|queued — priced when flat)\)<\/button>/);
    expect(html).toMatch(/<button(?![^>]*disabled="")[^>]*>Process queue<\/button>/);
  });

  it("unpaused, or only one market's mint paused: no note, the deposit keeps its own gates", () => {
    for (const [trading, mint] of [[false, false], [true, false], [false, true]] as const) {
      markets(trading, mint);
      const html = page();
      expect(html).not.toContain('data-slot="upgrade-paused"');
      expect(html).not.toContain(UPGRADE_PAUSE_NOTE);
    }
  });

  // A FAILED /v2/markets read is not "unpaused", even while an unpaused list from an earlier read is still
  // cached (React Query keeps it beside isError): the deposit is disabled and says it could not check. Only the
  // markets query differs from the unpaused case above.
  it("a failed market read shuts the deposit and says it could not check, even with an unpaused list cached", () => {
    try {
      vi.mocked(useMarkets).mockReturnValue({
        data: [{ ticker: "NVDA", tradingPaused: false, mintPaused: false }, { ticker: "SPCX", tradingPaused: false, mintPaused: false }],
        isError: true,
      } as unknown as ReturnType<typeof useMarkets>);
      const html = page();
      expect(html).toContain('data-slot="upgrade-paused"');
      expect(html).toContain(UPGRADE_PAUSE_UNREAD_NOTE);
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Deposit \((instant|queued — priced when flat)\)<\/button>/);
    } finally {
      // Do not leak a failed read into the tests after this one: they would pass with the door shut for this reason.
      markets(false, false);
    }
  });

  it("the deposit button's readiness is the door, and the door wraps the page's own deposit gate", () => {
    const source = readFileSync(fileURLToPath(new URL("./LendVault.tsx", import.meta.url)), "utf8");
    expect(source).toContain("const lendDeposit = depositDoor(Boolean(exitReady && !configBlockReason), markets.isError ? null : markets.data);");
    expect(source).toContain("const depositReady = lendDeposit.open;");
    expect(source).toContain('<Button className="w-full" disabled={!depositReady || !!busy || !parsePositive(depositAmount, USDG_DECIMALS)}');
  });
});

/*
 * The redeem box parses and caps at the vault's decimals() through lendRedeemInput
 * (lib/v2/lendTx.test.ts proves the helper at 6 and 18 dp), and a failed redeem is worded by explainEarnRedeemError
 * (lib/v2/errors.test.ts). A static render cannot type into the box or click it, so the wiring is pinned here.
 */
describe("the redeem box's wiring", () => {
  const source = readFileSync(fileURLToPath(new URL("./LendVault.tsx", import.meta.url)), "utf8");

  it("reads the amount and the over-balance line at the vault's decimals, for the button and for the write", () => {
    expect(source).toContain("const shareDecimals = reads.data?.shareDecimals ?? null;");
    expect(source).toContain("lendRedeemInput(redeemAmount, shareDecimals, address ? reads.data?.balance : null)");
    expect(source).toContain("const amount = lendRedeemInput(redeemAmount, shareDecimals, null).shares;");
    expect(source).not.toMatch(/parsePositive\(redeemAmount/);
  });

  it("words a failed redeem with the redeem copy, not the general line", () => {
    expect(source).toMatch(/\}, explainEarnRedeemError\)\}>Redeem<\/Button>/);
  });
});
