/**
 * The vault surfaces collapse into one nav entry and one index page.
 *
 * WHAT IS PINNED HERE. Two things a reader depends on and a refactor can silently drop:
 * every vault states BOTH what goes in and when it comes back out (that pairing is the whole
 * reason the page exists), and no vault shows a figure the index has no source for.
 *
 * The two vaults are Earn, the USDG lending vault at /earn, and
 * House. The self-directed writer feature that used to be the Earn card moved to /sell and is not on this page.
 *
 * The nav half checks behaviour through lib/ui/navEntries.ts. It used to be a source
 * assertion on NavLinks.tsx's inline link array and its VAULT_ROUTES constant; the Neon header moved the
 * list and the active rule into that module so the header and the phone tab bar share one copy, and
 * a grep for the old literals would then have pinned dead text. What it asks is unchanged: one Vaults
 * entry, no Earn/Lend/House entries, and Vaults lit on the three routes it stands for.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// VaultsOverview reads the launch gates through React Query (LaunchCountdown.tsx), so without this mock
// the file died at collection with "No QueryClient set" -- red once with ZERO tests run, which is a
// suite that reports nothing rather than a suite that passes. Gates unread = deposits shown shut, the fail-closed state.
// The page also reads /v2/house (for the vaults' kind). The gate hook is stubbed unread -- open
// false, pending null -- which is the fail-closed state; the real launch-gate copy renders.
vi.mock("@/components/v2/LaunchCountdown", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/v2/LaunchCountdown")>()),
  useHouseIndexGate: () => ({ open: false, pending: null, isError: false }),
}));
vi.mock("@/lib/v2/hooks", () => ({
  useHouse: vi.fn(() => ({ data: undefined, isError: false })),
}));
// The Earn card's pill follows whether the build resolves the Earn vault. Configured by default.
const earnVault = vi.hoisted(() => ({ address: "0x00000000000000000000000000000000000000e1" as `0x${string}` | null }));
vi.mock("@/lib/v2/lendTx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/lendTx")>()),
  earnVaultAddress: () => earnVault.address,
}));

import { V2_NAV_ENTRIES, activeV2Href } from "@/lib/ui/navEntries";
import { useHouse } from "@/lib/v2/hooks";
import { EARN_CARD_TIP, EARN_FACTS, VaultsIndex, VaultsOverview, houseIndexNotQuoting, houseIndexWithdrawal } from "./VaultsOverview";

describe("the vaults index", () => {
  const html = renderToStaticMarkup(createElement(VaultsOverview));

  // The two vaults are Earn (the lending vault) and House; nothing is labelled "Lend" any more.
  it("names both vaults; the House CTA is a disabled button while the gates are unread", () => {
    for (const name of ["Earn", "House"]) expect(html).toContain(`>${name}<`);
    expect(html).toContain('href="/earn"');
    expect(html).toContain("opens when quoting starts");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Deposit opens when quoting starts<\/button>/);
    expect(html).not.toContain('href="/house"');
    expect(html).not.toContain(">Lend<");
  });

  it("states BOTH what goes in and when it comes out, for every vault", () => {
    expect(html.match(/You deposit/g) ?? []).toHaveLength(2);
    expect(html.match(/You can withdraw/g) ?? []).toHaveLength(2);
  });

  it("the Earn card is the USDG lending vault: what goes in, where the yield comes from, how it comes out", () => {
    expect(html).toContain("Be the house.");
    expect(html).toContain("Deposit USDG. It&#x27;s lent out for interest.");
    expect(EARN_FACTS).toEqual([
      { term: "You deposit", value: "USDG" },
      { term: "Your yield", value: "Interest from lending it out" },
      { term: "You can withdraw", value: "Now if the venue can pay; otherwise in the vault's queue, in order" },
    ]);
    for (const { value } of EARN_FACTS) expect(html).toContain(value.replace(/'/g, "&#x27;"));
    expect(EARN_CARD_TIP).toContain("At launch it only lends.");
    // The self-directed writer card left this page for /sell: none of its facts or links remain.
    for (const gone of ["Your free balance, any time", "Collateral, until the option settles", "Capped at the strike you sell",
      "You sell the option", 'href="/sell']) expect(html).not.toContain(gone);
  });

  it("the Earn pill is Live only while the build resolves the vault's address", () => {
    const earnPill = (markup: string) => /data-vault="earn"[\s\S]*?data-status="([a-z]+)"/.exec(markup)?.[1];
    expect(earnPill(html)).toBe("live");
    earnVault.address = null;
    try {
      const unset = renderToStaticMarkup(createElement(VaultsOverview));
      expect(earnPill(unset)).toBe("soon");
      expect(unset).toContain('href="/earn"');
    } finally {
      earnVault.address = "0x00000000000000000000000000000000000000e1";
    }
  });

  it("the House row names both cadences instead of promising once a week for every vault", () => {
    // reworded short ("close", not "boundary"/"epoch"); still names both cadences.
    expect(html).toContain("once a day, or once a week for a weekly vault");
  });

  it("quotes no figure at all, since the two vaults source theirs differently", () => {
    // A currency amount or a percentage anywhere on this index would have to come from somewhere, and the index reads
    // neither vault's figures. Each vault shows its own numbers on its own page.
    expect(html).not.toMatch(/\$\d|\d+(\.\d+)?\s*%|\bUSDG\s+\d/);
  });
});

describe("the nav collapses the three vault entries into one", () => {
  it("offers Vaults and no longer offers Earn, Lend or House as top-level entries", () => {
    expect(V2_NAV_ENTRIES).toContainEqual({ href: "/vaults", label: "Vaults" });
    const labels = V2_NAV_ENTRIES.map((entry) => entry.label);
    for (const gone of ["Earn", "Lend", "House"]) expect(labels).not.toContain(gone);
  });

  it("keeps the Vaults entry lit on the vault routes it stands for", () => {
    for (const route of ["/vaults", "/earn", "/earn/rewards", "/lend", "/house", "/house/nvda"]) {
      expect(activeV2Href(route, ["NVDA", "SPCX"]), route).toBe("/vaults");
    }
    // The controls: a route outside them does not light Vaults, and Sell options is not a vault.
    expect(activeV2Href("/wins", ["NVDA", "SPCX"])).not.toBe("/vaults");
    for (const route of ["/sell", "/sell/nvda"]) expect(activeV2Href(route, ["NVDA", "SPCX"]), route).toBe("/");
  });
});

describe("the Neon House card", () => {
  const render = (props: Partial<Parameters<typeof VaultsIndex>[0]>) => renderToStaticMarkup(createElement(VaultsIndex, {
    houseOpen: false, pending: null, gatesError: false, houseKinds: [], earnLive: true, ...props }));
  const shutButton = /<button[^>]*disabled=""[^>]*>Deposit opens when quoting starts<\/button>/;

  it("before quoting, one static line names the vault that is not quoting; no clock; Deposit shut", () => {
    const html = render({ pending: ["NVDA"] });
    expect(html).toContain('data-slot="house-not-quoting"');
    expect(html).toContain(houseIndexNotQuoting(["NVDA"]));
    expect(html).not.toContain('role="timer"');
    expect(html).not.toMatch(/\d\d:\d\d:\d\d|quotes in/);
    expect(html).toContain('data-status="soon"');
    expect(html).toMatch(shutButton);
    expect(houseIndexNotQuoting(["NVDA", "SPCX"])).toBe("The NVDA and SPCX house vaults are not quoting yet. Deposits open when they are.");
  });

  it("unread gates keep Deposit a disabled button and show no not-quoting claim it cannot make", () => {
    const html = render({ pending: null });
    expect(html).toMatch(shutButton);
    expect(html).not.toContain('href="/house"');
    expect(html).not.toContain('data-slot="house-not-quoting"');
  });

  it("once armed: no clock, a Live pill and a real Deposit link", () => {
    const html = render({ houseOpen: true, pending: [] });
    expect(html).not.toContain('data-slot="house-not-quoting"');
    expect(html).not.toContain('role="timer"');
    expect(html.match(/data-status="live"/g) ?? []).toHaveLength(2);
    expect(html).toContain('href="/house"');
    expect(html).not.toContain("opens when quoting starts");
  });

  it("a failed arming read says so and keeps Deposit shut", () => {
    const html = render({ gatesError: true });
    expect(html).toContain("The on-chain arming could not be read");
    expect(html).toMatch(shutButton);
  });

  it("the withdrawal line follows the vaults' kind, never the mockup's fixed weekly", () => {
    expect(houseIndexWithdrawal(["daily", "daily"])).toMatch(/^Daily, at the 4:00 pm ET close/);
    expect(houseIndexWithdrawal(["weekly"])).toMatch(/^Weekly, at the week's last 4:00 pm ET close/);
    for (const mixed of [[], ["daily", "weekly"], ["unknown"], [undefined]] as const) {
      expect(houseIndexWithdrawal(mixed)).toContain("once a day, or once a week for a weekly vault");
    }
    expect(render({ houseKinds: ["daily", "daily"] })).toContain("Daily, at the 4:00 pm ET close");
  });
});

/** Once a daily vault is listed the weekly ones are winding down, so the card names the daily cadence only. */
describe("the House card's cadence once the daily vaults are live", () => {
  const listed = (kinds: Array<"weekly" | "daily">) => vi.mocked(useHouse).mockReturnValueOnce({ data: { items: kinds.map((kind, i) => ({
    market: i % 2 ? "SPCX" : "NVDA", vault: `0x${(0x80 + i).toString(16).padStart(40, "0")}`, kind, currentEpoch: null, sharesSupply: null })),
  nextCursor: null }, isError: false } as unknown as ReturnType<typeof useHouse>);

  it("weekly and daily listed: the card states the daily cadence, not both", () => {
    listed(["weekly", "weekly", "daily", "daily"]);
    const html = renderToStaticMarkup(createElement(VaultsOverview));
    expect(html).toContain("Daily, at the 4:00 pm ET close");
    expect(html).not.toContain("once a day, or once a week for a weekly vault");
  });

  it("control: weekly only (the launch state) still states the weekly cadence", () => {
    listed(["weekly", "weekly"]);
    expect(renderToStaticMarkup(createElement(VaultsOverview))).toContain("Weekly, at the week&#x27;s last 4:00 pm ET close");
  });
});
