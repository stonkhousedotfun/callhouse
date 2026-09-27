/**
 * /legacy/vault/nvda (also /legacy/collect): the closed pooled vault, where a queued cNVDA redemption is still
 * collected. What the page decides: the missing-vault and failed-read notices, the connected position (raw vs the
 * display-only -eq figures), the last CLOSED week with premium kept apart from strike proceeds, the capacity and
 * deposit rows, and that its refresh refetches both the vault and the position. The children (RedeemQueue, UsdgClaim,
 * StrandedBanner, VaultOverview, …) have their own tests and are stubbed to show the props they receive.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useAccount } from "wagmi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CycleRow } from "@/lib/api";
import { useCycleHistory } from "@/lib/history";
import { useAccountPosition, useNow, useVaultSnapshot, type AccountPosition, type VaultSnapshot } from "@/lib/hooks";
import VaultPage from "./page";
import CollectPage from "../../collect/page";

const C = vi.hoisted(() => ({ vault: "0x00000000000000000000000000000000000000aa" as string | undefined }));
const S = vi.hoisted(() => ({ onDone: [] as Array<() => void> }));
vi.mock("wagmi", () => ({ useAccount: vi.fn() }));
vi.mock("@/lib/contracts", async (orig) => ({ ...(await orig<typeof import("@/lib/contracts")>()), get VAULT() { return C.vault; } }));
vi.mock("@/lib/hooks", async (orig) => ({
  ...(await orig<typeof import("@/lib/hooks")>()),
  useVaultSnapshot: vi.fn(), useAccountPosition: vi.fn(), useNow: vi.fn(),
}));
vi.mock("@/lib/history", async (orig) => ({ ...(await orig<typeof import("@/lib/history")>()), useCycleHistory: vi.fn() }));
vi.mock("@/components/ui/Time", async () => {
  const { createElement: h } = await vi.importActual<typeof import("react")>("react");
  return { Time: ({ at }: { at: number }) => h("time", null, `T${at}`) };
});
function stub(name: string) {
  return async () => {
    const { createElement: h } = await vi.importActual<typeof import("react")>("react");
    return {
      [name]: (p: { onDone?: () => void; idle?: bigint; sold?: bigint; assigned?: bigint }) => {
        if (p.onDone) S.onDone.push(p.onDone);
        return h("i", null, `[${name}${p.sold !== undefined ? ` ${p.idle} ${p.sold} ${p.assigned}` : ""}]`);
      },
    };
  };
}
vi.mock("@/components/CycleTape", stub("CycleTape"));
vi.mock("@/components/VaultOverview", stub("VaultOverview"));
vi.mock("@/components/RedeemQueue", stub("RedeemQueue"));
vi.mock("@/components/StrandedBanner", stub("StrandedBanner"));
vi.mock("@/components/UsdgClaim", stub("UsdgClaim"));
vi.mock("@/components/PositionSplit", stub("PositionSplit"));
vi.mock("@/components/PhaseBadge", async () => ({ VaultPhaseBadge: () => null, GuardBadges: () => null }));

const E18 = 10n ** 18n;
const ME = "0x00000000000000000000000000000000000000bb";
let refetchVault: ReturnType<typeof vi.fn>;
let refetchPosition: ReturnType<typeof vi.fn>;

function snapshot(over: Partial<VaultSnapshot> = {}): VaultSnapshot {
  return {
    ready: true, spotStale: false, phase: 0, totalAssets: 100n * E18, idleAssets: 100n * E18, lockedAssets: 0n,
    contractsWritten: 0n, capacity: 0n, depositCap: 500n * E18, reservedAssets: 2n * E18, usdgReservedForQueue: 3_000_000n,
    canRedeemInstantly: false, depositsOpen: false, uiMultiplier: E18,
    policy: { protocolFeeBps: 500, maxUtilizationBps: 10_000, maxContractsCap: 40n } as unknown as VaultSnapshot["policy"],
    ...over,
  };
}
function setup(v: VaultSnapshot, position: Partial<AccountPosition> = {}, rows: CycleRow[] = [], isError = false) {
  vi.mocked(useVaultSnapshot).mockReturnValue({ data: v, isError, refetch: refetchVault } as never);
  vi.mocked(useAccountPosition).mockReturnValue({ data: { ready: true, ...position }, refetch: refetchPosition } as never);
  vi.mocked(useCycleHistory).mockReturnValue({ rows } as never);
}
const html = () => renderToStaticMarkup(createElement(VaultPage));
const text = () => html().replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/\s+/g, " ");

beforeEach(() => {
  C.vault = "0x00000000000000000000000000000000000000aa";
  S.onDone = [];
  refetchVault = vi.fn();
  refetchPosition = vi.fn();
  vi.mocked(useAccount).mockReturnValue({ address: ME } as never);
  vi.mocked(useNow).mockReturnValue(1_000);
  setup(snapshot());
});

describe("/legacy/vault/nvda", () => {
  it("/legacy/collect is the same page", () => {
    expect(CollectPage).toBe(VaultPage);
  });

  it("says the vault is closed; no vault configured or a failed read gets its notice", () => {
    expect(text()).toContain("The pooled vault is closed. Collect a queued redemption here.");
    expect(html()).not.toContain("No vault address configured.");
    C.vault = undefined;
    setup(snapshot(), {}, [], true);
    const out = html();
    expect(out).toContain("No vault address configured.");
    expect(out).toContain("Can&#x27;t read the vault right now.");
  });

  it("every child's onDone refetches both the vault and the position", () => {
    html();
    expect(S.onDone).toHaveLength(3);
    for (const f of S.onDone) f();
    expect(refetchVault).toHaveBeenCalledTimes(3);
    expect(refetchPosition).toHaveBeenCalledTimes(3);
    expect(vi.mocked(useAccountPosition)).toHaveBeenCalledWith(ME);
  });

  it("no wallet: the connect line instead of a position", () => {
    vi.mocked(useAccount).mockReturnValue({ address: undefined } as never);
    expect(text()).toContain("Connect a wallet to see your position.");
  });

  it("the position: raw figures, and -eq figures scaled by the multiplier for display only", () => {
    setup(snapshot({ uiMultiplier: 3n * E18 / 2n }), {
      shares: 4n * E18, sharesValueAssets: 5n * E18, claimableUsdg: 1_250_000n, queuedShares: 2n * E18, queuedEpoch: 9n,
      assetBalance: 2n * E18, usdgBalance: 7_000_000n,
    });
    const t = text();
    expect(t).toContain("Shares 4 cNVDA worth 5 NVDA raw");
    expect(t).toContain("Claimable USDG 1.25");
    expect(t).toContain("Queued shares 2 epoch 9");
    expect(t).toContain("Wallet NVDA, raw 2");
    expect(t).toContain("Wallet NVDA-eq ×1.5 3");
    expect(t).toContain("Share value NVDA-eq 7.5");
    expect(t).toContain("Wallet USDG 7");
  });

  it("nothing queued says so; a queue without an epoch shows a dash", () => {
    setup(snapshot(), { queuedShares: 0n });
    expect(text()).toContain("nothing queued");
    setup(snapshot(), { queuedShares: E18 });
    expect(text()).toContain("epoch —");
  });

  it("no closed week yet: says so", () => {
    setup(snapshot(), {}, [{ cycle: 3, settled: false } as CycleRow]);
    const t = text();
    expect(t).toContain("no closed week");
    expect(t).toContain("No week has closed yet.");
  });

  it("the last CLOSED week: premium per share, fee, net, net/collateral; strike proceeds only on an assigned week", () => {
    const filled = { cycle: 5, settled: true, filled: true, contractsSold: 3n, closedAt: 1_700_000_000, premiumGrossUsdg: 10_000_000n,
      feeUsdg: 500_000n, premiumNetUsdg: 9_500_000n, premiumNetPerShare: 95_000n, assetsAtHarvest: 100n * E18, spotUsdgAtHarvest: 150_000_000n,
      contractsAssigned: 0n } as CycleRow;
    setup(snapshot(), {}, [{ cycle: 6, settled: false } as CycleRow, filled]);
    const t = text();
    expect(t).toContain("cycle #5");
    expect(t).toContain("Net premium per cNVDA 0.095 3 calls sold · T1700000000");
    expect(t).toContain("Premium received 10 Protocol fee 0.50 Net premium to depositors 9.50");
    // 9.5 USDG over 100 NVDA x 150 = 15,000 USDG is 0.063%
    expect(t).toContain("Net premium / collateral <0.1%");
    expect(t).not.toContain("Strike proceeds 0");
    setup(snapshot(), {}, [{ ...filled, contractsAssigned: 2n, strikeProceedsUsdg: 300_000_000n }]);
    expect(text()).toContain("Contracts assigned 2 Strike proceeds 300");
    setup(snapshot(), {}, [{ ...filled, contractsAssigned: 0n, strikeProceedsUsdg: 1n }]);
    expect(text(), "proceeds without an assignment still get their line").toContain("Strike proceeds <0.01");
  });

  it("an unfilled closed week, a stranded close (recovered or not), and no close time", () => {
    const base = { cycle: 4, settled: true, filled: false, premiumNetUsdg: 0n } as CycleRow;
    setup(snapshot(), {}, [base]);
    // an unfilled week is exactly 0 per share (not a dash), and its net/collateral is unknowable without a TVL
    expect(text()).toContain("Net premium per cNVDA 0 unfilled, 0 · — Premium received —");
    setup(snapshot(), {}, [{ ...base, premiumNetUsdg: undefined }]);
    expect(text()).toContain("Net premium per cNVDA — unfilled, 0");
    setup(snapshot(), {}, [{ ...base, stranded: true }]);
    expect(text()).toContain("unfilled, 0 · claim stranded at the close ·");
    setup(snapshot(), {}, [{ ...base, stranded: true, strandRecovered: true }]);
    expect(text()).toContain(" · claim stranded at the close, since recovered ·");
  });

  it("collateral: sold of at most the policy cap, capacity, deposit cap, queue reserve, instant or queue only", () => {
    setup(snapshot({ contractsWritten: 4n, capacity: 36n, canRedeemInstantly: true }));
    const t = text();
    expect(t).toContain("Calls sold this week 4 of at most 40");
    expect(t).toContain("Capacity remaining 36 contracts");
    expect(t).toContain("Deposit cap 500 NVDA");
    expect(t).toContain("Reserved for the redeem queue 2 NVDA · 3 USDG");
    expect(t).toContain("Instant redemption open");
    expect(t).toContain("Protocol fee 5%");
    setup(snapshot({ contractsWritten: undefined, capacity: undefined, policy: undefined, phase: undefined }));
    const bare = text();
    expect(bare).toContain("Calls sold this week — ");
    expect(bare).toContain("Capacity remaining —");
    expect(bare).toContain("Instant redemption queue only");
    expect(bare).toContain("Deposits —");
    expect(bare).toMatch(/Protocol fee — /);
  });

  it("deposits row: cap full reads 'cap full', never 'closed'", () => {
    setup(snapshot({ totalAssets: 500n * E18, depositsOpen: true }));
    expect(text()).toContain("Deposits cap full");
    setup(snapshot({ depositsOpen: false }));
    expect(text()).toContain("Deposits closed");
  });

  it("the split passes idle, sold and assigned; the vault address links only when configured", () => {
    setup(snapshot({ idleAssets: 60n * E18, lockedAssets: 40n * E18, contractsAssigned: 1n }));
    expect(html()).toContain(`[PositionSplit ${60n * E18} ${40n * E18} ${E18}]`);
    expect(html()).toContain(" · vault ");
    C.vault = undefined;
    expect(html()).not.toContain(" · vault ");
  });
});
