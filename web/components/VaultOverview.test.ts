/**
 * VaultOverview (the closed pooled vault's glance, still on /legacy/vault/nvda): the figures and their units (Stock
 * Token and shares 18 decimals, USDG 6), the strike fallbacks by phase, and the order block: Seaport's fill count
 * first, the keeper feed only when Seaport has no answer, and "—" with a note (never the whole listing) when neither
 * gives a count. The order reads are asked for only while the vault is Listed with a live hash inside the sale window.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useKeeperOrderBook } from "@/components/CyclePricing";
import { useNow, useOrderStatus, useVaultSnapshot, type VaultSnapshot } from "@/lib/hooks";
import { VaultOverview } from "./VaultOverview";

const C = vi.hoisted(() => ({ vault: "0x00000000000000000000000000000000000000aa" as string | undefined }));
vi.mock("@/lib/contracts", async (orig) => {
  const real = await orig<typeof import("@/lib/contracts")>();
  return { ...real, get VAULT() { return C.vault; } };
});
vi.mock("@/lib/hooks", async (orig) => ({
  ...(await orig<typeof import("@/lib/hooks")>()),
  useVaultSnapshot: vi.fn(), useNow: vi.fn(), useOrderStatus: vi.fn(),
}));
vi.mock("@/components/CyclePricing", () => ({ useKeeperOrderBook: vi.fn() }));
vi.mock("@/components/PhaseBadge", () => ({ VaultPhaseBadge: () => null, GuardBadges: () => null }));
vi.mock("@/components/CycleTape", async () => {
  const { createElement: h } = await vi.importActual<typeof import("react")>("react");
  return { CycleTapeInline: () => h("i", null, "TAPE") };
});
vi.mock("@/components/PositionSplit", async () => {
  const { createElement: h } = await vi.importActual<typeof import("react")>("react");
  return { PositionSplit: (p: Record<string, bigint | undefined>) => h("i", null, `SPLIT ${p.idle} ${p.sold} ${p.assigned}`) };
});
vi.mock("@/components/ui/Time", async () => {
  const { createElement: h } = await vi.importActual<typeof import("react")>("react");
  return { Time: ({ at }: { at: number }) => h("time", null, `T${at}`) };
});

const E18 = 10n ** 18n;
const HASH = `0x${"ab".repeat(32)}` as const;

/** Listed, window open until 2000, 10 contracts listed at 25 USDG gross (2.5 each), capacity 8, fee 5%. */
function listed(over: Partial<VaultSnapshot> = {}): VaultSnapshot {
  return {
    ready: true, spotStale: false, symbol: "cNVDA", phase: 1, cycleNumber: 7,
    totalAssets: 100n * E18, totalSupply: 80n * E18, idleAssets: 90n * E18, lockedAssets: 10n * E18, contractsAssigned: 0n,
    spotUsdg: 150_000_000n, cycleStrikeUsdg: 160_000_000n, cycleExerciseTs: 2_000, cycleExpiryTs: 88_400,
    listingHash: HASH, listingAmount: 10n, listingGrossUsdg: 25_000_000n, capacity: 8n, contractsWritten: 2n, listingsThisCycle: 1,
    policy: { protocolFeeBps: 500 } as VaultSnapshot["policy"],
    ...over,
  };
}
let now: number;
let status: { data?: Record<string, unknown>; isLoading: boolean };
let feed: { data?: unknown; isLoading: boolean };
function html(v: VaultSnapshot) {
  vi.mocked(useVaultSnapshot).mockReturnValue({ data: v } as never);
  vi.mocked(useNow).mockReturnValue(now);
  vi.mocked(useOrderStatus).mockReturnValue(status as never);
  vi.mocked(useKeeperOrderBook).mockReturnValue(feed as never);
  return renderToStaticMarkup(createElement(VaultOverview));
}
/** The text of the row whose key is `k` (Rows render k and v as siblings). */
function row(out: string, k: string): string | undefined {
  const i = out.indexOf(`>${k}<`);
  if (i < 0) return undefined;
  const rest = out.slice(i + k.length + 2);
  const m = rest.match(/<dd[^>]*>(.*?)<\/dd>/);
  return m?.[1]!.replace(/<[^>]+>/g, "");
}
const text = (out: string) => out.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

beforeEach(() => {
  C.vault = "0x00000000000000000000000000000000000000aa";
  now = 1_000;
  status = { data: { isCancelled: false, totalFilled: 3n, totalSize: 10n }, isLoading: false };
  feed = { data: undefined, isLoading: false };
  vi.mocked(useOrderStatus).mockClear();
  vi.mocked(useKeeperOrderBook).mockClear();
});

describe("the figures", () => {
  it("collateral with its USDG value at feed spot, shares, and collateral per share to 6 decimals", () => {
    const t = text(html(listed()));
    expect(t).toContain("Collateral 100 NVDA 15K USDG at feed spot");
    expect(t).toContain("Shares 80 cNVDA 1.25 NVDA per share");
  });

  it("no spot: 'spot unavailable'; no supply: no per-share figure", () => {
    const t = text(html(listed({ spotUsdg: undefined, totalSupply: 0n })));
    expect(t).toContain("spot unavailable");
    expect(t).toMatch(/Shares 0 cNVDA — /);
  });

  it("the split passes idle, sold (locked) and assigned (lots x 1e18)", () => {
    expect(html(listed({ contractsAssigned: 2n }))).toContain(`SPLIT ${90n * E18} ${10n * E18} ${2n * E18}`);
    expect(html(listed({ lockedAssets: undefined, contractsAssigned: undefined }))).toContain(`SPLIT ${90n * E18} 0 0`);
  });

  it("an on-chain symbol other than the share ticker is named; a uiMultiplier other than 1 adds the -eq line", () => {
    const out = text(html(listed({ symbol: "cNVDA2", uiMultiplier: 2n * E18 })));
    expect(out).toContain("cNVDA vault · on-chain symbol cNVDA2");
    expect(out).toContain("collateral: 200 . Share maths uses the raw balance above.");
    const plain = text(html(listed({ uiMultiplier: E18 })));
    expect(plain).not.toContain("on-chain symbol");
    expect(plain).not.toContain("uiMultiplier other than 1.0");
  });
});

describe("the strike", () => {
  it("armed: the exact strike, calls sold with capacity (Listed only), and the expiry", () => {
    const t = text(html(listed()));
    expect(t).toContain("This week's strike 160.00 USDG 2 calls sold this week · capacity for 8 more Expiry T88400");
    expect(text(html(listed({ phase: 2 })))).toContain("2 calls sold this week Expiry");
  });

  it("terms unreadable but a strike on chain outside Idle: the strike from the snapshot, no expiry line", () => {
    const t = text(html(listed({ cycleExerciseTs: 0 })));
    expect(t).toContain("This week's strike 160 USDG 2 calls sold this week");
    expect(t).not.toContain("Expiry T");
  });

  it("Idle: a dash and 'nothing armed'; phase unread: a dash under the strike; strike zero: a dash", () => {
    expect(text(html(listed({ phase: 0 })))).toContain("This week's strike — USDG nothing armed this cycle");
    // phase unread: no terms, the snapshot's strike still shows (the fallback only excludes Idle), the sub is a dash
    expect(text(html(listed({ phase: undefined })))).toContain("This week's strike 160 USDG — SPLIT");
    expect(text(html(listed({ cycleStrikeUsdg: 0n, contractsWritten: undefined })))).toContain("This week's strike — USDG 0 calls sold");
  });
});

describe("this week's order", () => {
  it("Seaport's count wins: 10 listed, 3 of 10 filled → 7 left (capacity 8); gross 7 x 2.5; 5% fee", () => {
    const out = html(listed());
    expect(vi.mocked(useOrderStatus)).toHaveBeenCalledWith(HASH);
    expect(row(out, "Price per contract")).toBe("2.50 USDG");
    expect(row(out, "Contracts left to buy")).toBe("7");
    expect(row(out, "Order total if every remaining contract sells")).toBe("17.50 USDG");
    expect(row(out, "Protocol fee on that total, charged at harvest")).toBe("0.875 USDG");
    expect(out).not.toContain('data-slot="this-week-fill-note"');
  });

  it("capacity caps the count; no fee policy leaves the fee a dash", () => {
    status.data = { isCancelled: false, totalFilled: 0n, totalSize: 10n };
    const out = html(listed({ capacity: 4n, policy: undefined }));
    expect(row(out, "Contracts left to buy")).toBe("4");
    expect(row(out, "Order total if every remaining contract sells")).toBe("10.00 USDG");
    expect(row(out, "Protocol fee on that total, charged at harvest")).toBe("—");
  });

  it("Seaport unread: the feed row's remaining for this hash (capped at the listing); a finished hash is 0", () => {
    status = { data: undefined, isLoading: false };
    feed.data = { listings: [{ orderHash: HASH.toUpperCase().replace("0X", "0x"), remaining: "3" }], closed: [] };
    expect(row(html(listed()), "Contracts left to buy")).toBe("3");
    expect(vi.mocked(useKeeperOrderBook)).toHaveBeenLastCalledWith(HASH, true);
    feed.data = { listings: [], closed: [{ orderHash: HASH, state: "soldOut" }] };
    expect(row(html(listed()), "Contracts left to buy")).toBe("0");
  });

  it("neither gives a count: dashes and the note linking the cycle page, never the whole listing", () => {
    status = { data: { isCancelled: undefined }, isLoading: false };
    const out = html(listed());
    expect(row(out, "Contracts left to buy")).toBe("—");
    expect(row(out, "Order total if every remaining contract sells")).toBe("—");
    expect(out).toContain('data-slot="this-week-fill-note"');
    expect(out).toContain('href="/vault/nvda/cycle"');
  });

  it("no note while Seaport or the feed is still loading", () => {
    status = { data: undefined, isLoading: true };
    expect(html(listed())).not.toContain("this-week-fill-note");
    status = { data: undefined, isLoading: false };
    feed.isLoading = true;
    expect(html(listed())).not.toContain("this-week-fill-note");
  });

  it("a cancelled order on Seaport: no feed is asked, 0 left", () => {
    status.data = { isCancelled: true, totalFilled: 0n, totalSize: 10n };
    expect(row(html(listed()), "Contracts left to buy")).toBe("0");
    expect(vi.mocked(useKeeperOrderBook)).toHaveBeenLastCalledWith(HASH, false);
  });

  it("no vault configured: the feed is never asked", () => {
    C.vault = undefined;
    status = { data: undefined, isLoading: false };
    html(listed());
    expect(vi.mocked(useKeeperOrderBook)).toHaveBeenLastCalledWith(HASH, false);
  });

  it("window closed, clock unread, not Listed, or no live hash: no order reads and no order rows", () => {
    for (const [v, n] of [[listed(), 2_000], [listed(), 0], [listed({ phase: 2 }), 1_000], [listed({ listingHash: `0x${"0".repeat(64)}` as `0x${string}` }), 1_000]] as const) {
      now = n;
      vi.mocked(useOrderStatus).mockClear();
      const out = html(v);
      expect(vi.mocked(useOrderStatus)).toHaveBeenCalledWith(undefined);
      expect(out).not.toContain(">Contracts left to buy<");
      expect(out).not.toContain("this-week-fill-note");
    }
  });
});

describe("the rest of the block", () => {
  it("order hash: a dash, 'no live listing', or a short link to the cycle page", () => {
    expect(row(html(listed({ listingHash: undefined })), "Order hash")).toBe("—");
    expect(row(html(listed({ listingHash: `0x${"0".repeat(64)}` as `0x${string}` })), "Order hash")).toBe("no live listing");
    const out = html(listed());
    expect(row(out, "Order hash")).toBe(`${HASH.slice(0, 10)}…${HASH.slice(-8)}`);
  });

  it("listings authorised out of 3; cycle number or dashes", () => {
    expect(row(html(listed()), "Listings authorised")).toBe("1 / 3");
    const out = html(listed({ listingsThisCycle: undefined, cycleNumber: undefined }));
    expect(row(out, "Listings authorised")).toBe("— / 3");
    expect(row(out, "Vault cycle")).toBe("#—");
  });

  it("countdowns from the clock, dashes before it starts; without terms the cycle tape instead", () => {
    const out = html(listed());
    expect(row(out, "Until the exercise deadline")).not.toBe("—");
    expect(row(out, "Until expiry")).toMatch(/^1d/);
    now = 0;
    const early = html(listed());
    expect(row(early, "Until the exercise deadline")).toBe("—");
    expect(row(early, "Until expiry")).toBe("—");
    now = 1_000;
    const idle = html(listed({ phase: 0 }));
    expect(idle).toContain("TAPE");
    expect(idle).not.toContain(">Until expiry<");
  });

  it("no unit price without a live listing", () => {
    expect(html(listed({ listingHash: undefined }))).not.toContain(">Price per contract<");
  });
});
