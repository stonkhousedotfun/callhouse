import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useAccount, useWalletClient } from "wagmi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import { USDG } from "@/lib/contracts";
import type { ConfigResponse } from "@/lib/v2/api-types";
import type { EarnResponse } from "@/lib/v2/api-types";
import { useConfig, useEarn } from "@/lib/v2/hooks";
import {
  FLAT_VALUE_LABEL, INDICATIVE_VALUE_LABEL, LendVault, lendConfigBlockReason, lendInterestView, lendValueView,
  submitLendDeposit,
} from "./LendVault";

vi.mock("wagmi", () => ({ useAccount: vi.fn(), useWalletClient: vi.fn() }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => createElement("button", null, "Connect wallet") }));
vi.mock("@/components/TxToast", () => ({ useNotice: vi.fn(), useV2ReceiptNotice: vi.fn() }));
vi.mock("@/lib/v2/hooks", () => ({ useConfig: vi.fn(), useEarn: vi.fn() }));
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
    expect(html).toContain("not an instant withdrawal");
    expect(html).toContain("No fixed time — it depends on available liquidity");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Deposit<\/button>/);
    // The lookahead must exclude the ATTRIBUTE, not the word: every button's class list carries
    // Tailwind's `disabled:cursor-not-allowed disabled:opacity-60`, so `(?![^>]*disabled)` could
    // never match any button and this assertion was red at every base. See T-407 evidence.
    expect(html).toMatch(/<button(?![^>]*disabled="")[^>]*>Process queue<\/button>/);

    const source = readFileSync(fileURLToPath(new URL("./LendVault.tsx", import.meta.url)), "utf8");
    const terms = source.indexOf('<WithdrawalTerms className="mt-3" surface="lending"');
    const confirm = source.indexOf('onClick={() => void act("Deposit into the lending vault"');
    expect(terms).toBeGreaterThan(-1);
    expect(confirm).toBeGreaterThan(terms);
  });

  // T-404 epoch 3. The queue caveat was only on the deposit side, and the deposit side is not where a
  // holder asks for their money back: `redeem()` returns a requestId and `processQueue()` serves it later
  // (plan 2026-09-20 section 5.5). The panel that submits that request has to say so before its button.
  it("states the queue terms on the redeem panel too, above its button", () => {
    const source = readFileSync(fileURLToPath(new URL("./LendVault.tsx", import.meta.url)), "utf8");
    const redeemPanel = source.slice(source.indexOf('aria-label="Redeem"'));
    expect(redeemPanel).not.toBe("");
    const terms = redeemPanel.indexOf('<WithdrawalTerms className="mt-3" surface="lending"');
    const confirm = redeemPanel.indexOf('onClick={() => void act("Redeem lending-vault shares"');
    expect(terms).toBeGreaterThan(-1);
    expect(confirm).toBeGreaterThan(terms);

    // And it renders: two panels, so the queue sentence appears on both, not once.
    const html = renderToStaticMarkup(createElement(LendVault));
    const occurrences = html.split("not an instant withdrawal").length - 1;
    expect(occurrences).toBe(2);
  });
});

/**
 * W5, plan section 5.4 items 2-3: the interest percentage the owner asked for, its period label,
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
 * T-OP-086 (SEC-19 / T-OP-065). Three states, each rendered from the /v2/earn row the indexer builds from the
 * vault's own `indicativeAssetsPerShare()` / `hasOpenPosition()` -- never from `convertToAssets`, which
 * reverts while a position is open.
 */
describe("LendVault value per share", () => {
  const earnRow = (patch: Partial<EarnResponse["vaults"] extends (infer T)[] | undefined ? T : never>) => ({
    configured: true,
    vaults: [{
      vault, asset: USDG, adapter: null, paused: false, sharesSupply: "10000000000000000000000",
      deposited: "10000000000", skimmed: null, ...patch,
    }],
    account: null,
  } as EarnResponse);

  it("shows the indicative figure with the mark label while a position is open", () => {
    vi.mocked(useEarn).mockReturnValue({ data: earnRow({
      indicativeAssetsPerShare: "1004000", indicativeTotalAssets: "10040000000", hasOpenPosition: true,
    }) } as ReturnType<typeof useEarn>);
    const html = renderToStaticMarkup(createElement(LendVault));
    expect(html).toContain("Indicative value");
    expect(html).toContain("1.004000");
    expect(html).toContain("10,040.00");
    // The em dash is HTML-escaped by the renderer, so the label is asserted by its two halves.
    expect(html).toContain("marks written options at the oracle spot");
    expect(INDICATIVE_VALUE_LABEL).toContain("marks written options at the oracle spot");
    expect(html).toContain("only at the flat boundary");
    expect(html).not.toContain(FLAT_VALUE_LABEL);
  });

  it("shows the flat figure with the boundary label when no position is open", () => {
    vi.mocked(useEarn).mockReturnValue({ data: earnRow({
      indicativeAssetsPerShare: "1000000", indicativeTotalAssets: "10000000000", hasOpenPosition: false,
    }) } as ReturnType<typeof useEarn>);
    const html = renderToStaticMarkup(createElement(LendVault));
    expect(html).toContain("1.000000");
    expect(html).toContain(FLAT_VALUE_LABEL);
    expect(html).not.toContain("marks written options at the oracle spot");
  });

  it("says unavailable, never 0, when the figure is null", () => {
    vi.mocked(useEarn).mockReturnValue({ data: earnRow({
      indicativeAssetsPerShare: null, indicativeTotalAssets: null, hasOpenPosition: null,
    }) } as ReturnType<typeof useEarn>);
    const html = renderToStaticMarkup(createElement(LendVault));
    expect(html).toContain("The value per share is unavailable");
    expect(html).toContain("not the same as zero");
    expect(html).not.toContain("0.000000");
  });

  it("treats an unread open-position flag as open, and a missing row as unavailable", () => {
    expect(lendValueView(vault, { vault, asset: USDG, adapter: null, paused: false, sharesSupply: "1",
      deposited: null, skimmed: null, indicativeAssetsPerShare: "1000000", hasOpenPosition: null }).kind).toBe("indicative");
    expect(lendValueView(vault, null).kind).toBe("unavailable");
    expect(lendValueView(null, null).kind).toBe("unconfigured");
  });
});
