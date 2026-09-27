import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SITE_URL } from "@/lib/site";
import { lendApyView } from "@/lib/v2/lendApy";
import type { EarnVault } from "@/lib/v2/api-types";
import { EarliestWithdrawalLine } from "./EarliestWithdrawal";
import { LendApy } from "./LendApy";

const NOW = 1_790_186_400;

describe("EarliestWithdrawalLine", () => {
  it("renders the line, its reason behind the \"?\" InfoTip (read by a screen reader), and the FAQ link", () => {
    const html = renderToStaticMarkup(createElement(EarliestWithdrawalLine, {
      value: { kind: "daily", at: 1_790_193_600, reason: "epoch-boundary" }, surface: "house", now: NOW,
    }));
    expect(html).toContain("Earliest withdrawal:");
    expect(html).toContain("After today&#x27;s 4pm ET close");
    // The reason moved from a `title` (invisible to touch) into the InfoTip. The words are lib's, unchanged.
    expect(html).toContain('aria-label="Why this time"');
    expect(html).toMatch(/role="tooltip" id="[^"]+" hidden=""[^>]*>This daily vault&#x27;s epoch ends at every session close/);
    const tip = /role="tooltip" id="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`aria-describedby="${tip}"`);
    expect(html).not.toContain("title=");
    // Said once: the InfoTip text is the screen-reader path, so no second sr-only copy of the reason.
    expect(html.split("epoch ends at every session close")).toHaveLength(2);
    expect(html).toContain(`href="${SITE_URL}/faq#house-vault"`);
    expect(html).toContain('data-earliest-withdrawal="epoch-boundary"');
  });

  it("an indexer without the field renders Unavailable, never Now", () => {
    const html = renderToStaticMarkup(createElement(EarliestWithdrawalLine, { value: undefined, surface: "earn", now: NOW }));
    expect(html).toContain("Unavailable");
    expect(html).not.toContain("Now");
    expect(html).toContain('data-earliest-withdrawal="not-sent"');
  });
});

describe("LendApy", () => {
  const row = {
    vault: "0xf7d21652473014d1Ca0e22FF75420494cdd09164", asset: null, adapter: null, fundingEnabled: true,
    sharesSupply: "1", deposited: "1", skimmed: null, indicativeAssetsPerShare: null, indicativeTotalAssets: null,
    hasOpenPosition: false,
    apy7d: { bps: 412, reason: null, from: 1_789_581_600, to: NOW },
    apy30d: { bps: null, reason: "short-history", from: null, to: NOW },
    venue: { address: "0xBeEff033F34C046626B8D0A041844C5d1A5409dd", name: "Steakhouse USDG",
      apy24h: { bps: 520, reason: null, from: NOW - 86_400, to: NOW }, apy7d: { bps: 500, reason: null, from: NOW - 604_800, to: NOW },
      withdrawable: "5000000", withdrawableSource: "position", position: "5000000" },
  } satisfies EarnVault;

  it("renders realised, venue (linked to Morpho) and the net estimate with the cut read from the vault", () => {
    const html = renderToStaticMarkup(createElement(LendApy, {
      view: lendApyView({ vault: row.vault, row, skimBps: 1_000, ceilBps: 1_000 }),
    }));
    expect(html).toContain("4.12%");
    expect(html).toContain("Less than 30 days of history so far");
    expect(html).toContain("https://app.morpho.org/robinhood-chain/vault/0xBeEff033F34C046626B8D0A041844C5d1A5409dd");
    expect(html).toContain("Steakhouse USDG");
    expect(html).toContain("5.20%");
    expect(html).toContain("4.50%");
    // shortened to "our cut (10.00%)"; the figure is still the skim read from the vault.
    expect(html).toContain("our cut (10.00%)");
    expect(html).toContain("Your net · estimate");
  });

  it("renders the not-sent refusal and nothing for an unconfigured vault", () => {
    expect(renderToStaticMarkup(createElement(LendApy, { view: { kind: "not-sent" } })))
      .toContain("interest rate isn&#x27;t reported yet"); // shortened, same statement
    expect(renderToStaticMarkup(createElement(LendApy, { view: { kind: "unconfigured" } }))).toBe("");
  });
});
