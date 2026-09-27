/**
 * RewardClaims / ClaimForEpoch: the epoch-reward claim UI shared by the maker and lender programs.
 *
 * What is pinned: every per-epoch state (loading, file error and retry, unpublished, claim error, no reward,
 * token unread, claimed, ready), that an amount is formatted in the PROGRAM TOKEN'S OWN decimals and symbol,
 * that no claim button appears without a resolved token, and the claim handler's success, failure and
 * unknown-receipt paths. Node only: react-query is mocked per query key, and the claim button's handler is
 * called through a small `useState` harness (the component runs as a function, the handler is invoked, and
 * the next render is read as markup).
 */
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- hook harness: react's state/ref/effect hooks become in-memory slots while `run` calls a component ----
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
  };
});

type QueryState = { isPending?: boolean; isError?: boolean; isFetching?: boolean; data?: unknown; error?: Error; refetch?: () => unknown };
type QueryCall = { queryKey: unknown[]; queryFn: () => Promise<unknown>; enabled?: boolean };
const q = vi.hoisted(() => ({
  states: {} as Record<string, QueryState>,
  calls: [] as QueryCall[],
  invalidate: vi.fn(async () => undefined),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: QueryCall) => {
    q.calls.push(options);
    return { isPending: false, isError: false, isFetching: false, data: undefined, refetch: vi.fn(), ...q.states[String(options.queryKey[0])] };
  },
  useQueryClient: () => ({ invalidateQueries: q.invalidate }),
}));
const w = vi.hoisted(() => ({ wallet: { id: "wallet" } as unknown }));
vi.mock("wagmi", () => ({ useWalletClient: () => ({ data: w.wallet }) }));
const toast = vi.hoisted(() => ({ notice: vi.fn(), receipt: vi.fn(() => false) }));
vi.mock("@/components/TxToast", () => ({ useNotice: () => toast.notice, useV2ReceiptNotice: () => toast.receipt }));
vi.mock("@/components/ConnectButton", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return { ConnectButton: () => react.createElement("button", null, "Connect wallet") };
});
const chain = vi.hoisted(() => ({
  claimReward: vi.fn(), readRewardClaim: vi.fn(), parse: vi.fn((body: unknown) => body), resolveRewardToken: vi.fn(),
}));
vi.mock("@/lib/v2/rewardClaim", () => ({
  claimReward: chain.claimReward, readRewardClaim: chain.readRewardClaim, parseRewardEpochFile: chain.parse,
}));
vi.mock("@/lib/v2/rewardPrograms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/rewardPrograms")>()),
  resolveRewardToken: chain.resolveRewardToken,
}));

import { lenderProgram, makerProgram, type RewardToken } from "@/lib/v2/rewardPrograms";
import { ClaimForEpoch, RewardClaims } from "./RewardClaims";

const DISTRIBUTOR = "0x00000000000000000000000000000000000000d1" as Address;
const ACCOUNT = "0x00000000000000000000000000000000000000a1" as Address;
const USDG: RewardToken = { address: "0x00000000000000000000000000000000000000c6", decimals: 6, symbol: "USDG" };
const STONK: RewardToken = { address: "0x00000000000000000000000000000000000000c8", decimals: 18, symbol: "STONKHOUSE" };
const FILE = { epoch: 7, root: `0x${"1".repeat(64)}`, total: "2500000", entries: [] };
const ENTRY = { index: 0, account: ACCOUNT, amount: "2500000", proof: [] };

const maker = (token: RewardToken | null = USDG) => makerProgram(DISTRIBUTOR, token);

let tree: ReactNode = null;
function claimRow(program = maker()): string {
  h.active = true; h.cursor = 0;
  try { tree = ClaimForEpoch({ program, epoch: 7, account: ACCOUNT, distributor: DISTRIBUTOR }); } finally { h.active = false; }
  return renderToStaticMarkup(createElement("div", null, tree));
}
function control(label: string): ReactElement<{ onClick: () => unknown; disabled?: boolean }> {
  const walk = (n: unknown): ReactElement | null => {
    if (Array.isArray(n)) { for (const c of n) { const r = walk(c); if (r) return r; } return null; }
    if (!isValidElement(n)) return null;
    const props = n.props as { children?: unknown; onClick?: unknown };
    if (props.onClick && [props.children].flat().join("") === label) return n;
    return walk(props.children);
  };
  const hit = walk(tree);
  if (!hit) throw new Error(`no control ${label}`);
  return hit as never;
}
const ready = (status: "ready" | "claimed" | "no-reward" = "ready") => {
  q.states["maker-epoch-file"] = { data: FILE };
  q.states["maker-claim"] = { data: status === "no-reward" ? { status, entry: null } : { status, entry: ENTRY } };
};

beforeEach(() => {
  h.slots = []; q.states = {}; q.calls = []; w.wallet = { id: "wallet" };
  for (const fn of [q.invalidate, toast.notice, toast.receipt, chain.claimReward, chain.readRewardClaim, chain.resolveRewardToken]) fn.mockClear();
  toast.receipt.mockReturnValue(false);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("ClaimForEpoch: the states before a claim", () => {
  it("says it is checking while the epoch file loads", () => {
    q.states["maker-epoch-file"] = { isPending: true };
    expect(claimRow()).toContain("Epoch 7: checking…");
  });

  it("shows a file error with a retry that refetches, and a disabled Retrying while it runs", () => {
    const refetch = vi.fn();
    q.states["maker-epoch-file"] = { isError: true, error: new Error("Reward file could not be loaded."), refetch };
    expect(claimRow()).toContain("Epoch 7: Reward file could not be loaded.");
    control("Try again").props.onClick();
    expect(refetch).toHaveBeenCalledTimes(1);
    q.states["maker-epoch-file"] = { ...q.states["maker-epoch-file"], isFetching: true };
    claimRow();
    expect(control("Retrying…").props.disabled).toBe(true);
  });

  it("says an epoch with no published file is not published yet, and does not read the claim", () => {
    q.states["maker-epoch-file"] = { data: null };
    expect(claimRow()).toContain("Epoch 7: not published yet.");
    expect(q.calls.find((c) => c.queryKey[0] === "maker-claim")!.enabled).toBe(false);
  });

  it("keys the claim read by epoch, account, the file's root and the distributor", () => {
    ready();
    claimRow();
    const claim = q.calls.find((c) => c.queryKey[0] === "maker-claim")!;
    expect(claim.queryKey).toEqual(["maker-claim", 7, ACCOUNT, FILE.root, DISTRIBUTOR]);
    expect(claim.enabled).toBe(true);
    chain.readRewardClaim.mockResolvedValue("x");
    void claim.queryFn();
    expect(chain.readRewardClaim).toHaveBeenCalledWith(DISTRIBUTOR, FILE, ACCOUNT);
  });

  it("shows a claim-read error (a proof that does not match the chain) with its own retry", () => {
    const refetch = vi.fn();
    q.states["maker-epoch-file"] = { data: FILE };
    q.states["maker-claim"] = { isError: true, error: new Error("Published rewards do not match the on-chain root."), refetch };
    expect(claimRow()).toContain("Epoch 7: Published rewards do not match the on-chain root.");
    control("Try again").props.onClick();
    expect(refetch).toHaveBeenCalled();
    q.states["maker-claim"] = { ...q.states["maker-claim"], isFetching: true };
    claimRow();
    expect(control("Retrying…").props.disabled).toBe(true);
    q.states["maker-claim"] = { isPending: true };
    expect(claimRow()).toContain("Epoch 7: checking…");
  });

  it("says the wallet has no reward in this epoch", () => {
    ready("no-reward");
    expect(claimRow()).toContain("Epoch 7: no reward for this wallet.");
  });

  it("shows no amount and no claim button while the reward token is unread", () => {
    ready();
    const html = claimRow(maker(null));
    expect(html).toContain("Epoch 7: Unavailable — the reward token could not be read.");
    expect(html).not.toContain("<button");
  });
});

describe("ClaimForEpoch: the amount and the button", () => {
  it("formats the same base units in each program's own decimals and symbol", () => {
    ready();
    expect(claimRow(maker(USDG))).toContain("2.5 USDG");
    expect(claimRow(maker(STONK))).toContain("0.0000000000025 STONKHOUSE");
  });

  it("marks a claimed epoch and offers no button", () => {
    ready("claimed");
    const html = claimRow();
    expect(html).toContain("Claimed");
    expect(html).not.toContain("<button");
  });

  it("disables the claim button with no wallet client", () => {
    ready();
    w.wallet = undefined;
    claimRow();
    expect(control("Claim USDG").props.disabled).toBe(true);
  });

  it("claims, invalidates this epoch's claim read and reports success in the program's token", async () => {
    ready();
    chain.claimReward.mockResolvedValue(undefined);
    claimRow(maker(STONK));
    const pressed = control("Claim STONKHOUSE").props.onClick();
    expect(claimRow(maker(STONK))).toContain("Claiming…");
    await pressed;
    expect(chain.claimReward).toHaveBeenCalledWith(w.wallet, ACCOUNT, DISTRIBUTOR, FILE, ENTRY);
    expect(q.invalidate).toHaveBeenCalledWith({ queryKey: ["maker-claim", 7, ACCOUNT] });
    expect(toast.notice.mock.calls).toEqual([
      ["pending", "Confirm maker reward", "Review the STONKHOUSE claim in your wallet."],
      ["success", "Reward claimed", "STONKHOUSE was sent to your wallet."],
    ]);
    expect(claimRow(maker(STONK))).toContain("Claim STONKHOUSE");
  });

  it("reports a failed claim, and a non-Error failure generically", async () => {
    ready();
    chain.claimReward.mockRejectedValueOnce(new Error("Switch to Robinhood Chain to claim."));
    claimRow();
    await control("Claim USDG").props.onClick();
    expect(toast.notice).toHaveBeenLastCalledWith("error", "Claim stopped", "Switch to Robinhood Chain to claim.");
    chain.claimReward.mockRejectedValueOnce("x");
    claimRow();
    await control("Claim USDG").props.onClick();
    expect(toast.notice).toHaveBeenLastCalledWith("error", "Claim stopped", "The claim could not be completed.");
    expect(claimRow()).toContain("Claim USDG");
  });

  it("leaves an unknown-receipt failure to the receipt notice instead of calling it stopped", async () => {
    ready();
    const error = new Error("receipt timeout");
    chain.claimReward.mockRejectedValueOnce(error);
    toast.receipt.mockReturnValueOnce(true);
    claimRow();
    await control("Claim USDG").props.onClick();
    expect(toast.receipt).toHaveBeenCalledWith(error);
    expect(toast.notice.mock.calls.map((c) => c[0])).toEqual(["pending"]);
  });

  it("does nothing when pressed after the wallet disconnected", async () => {
    ready();
    w.wallet = undefined;
    claimRow();
    // The button is disabled, and its handler also refuses on its own if it is reached anyway.
    await control("Claim USDG").props.onClick();
    expect(chain.claimReward).not.toHaveBeenCalled();
    expect(toast.notice).not.toHaveBeenCalled();
  });
});

describe("ClaimForEpoch: fetching the published epoch file", () => {
  function fileQuery(program = maker()) {
    q.states["maker-epoch-file"] = { isPending: true };
    q.states["lender-epoch-file"] = { isPending: true };
    q.calls = [];
    claimRow(program);
    return q.calls.find((c) => String(c.queryKey[0]).endsWith("epoch-file"))!;
  }

  it("reads the program's own path, uncached, and parses against the epoch", async () => {
    const body = { epoch: 7 };
    const fetchMock = vi.fn(async () => ({ status: 200, ok: true, json: async () => body }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fileQuery().queryFn()).toBe(body);
    expect(fetchMock).toHaveBeenCalledWith("/maker-epochs/7.json", { cache: "no-store" });
    expect(chain.parse).toHaveBeenCalledWith(body, 7);
    const lender = fileQuery(lenderProgram(DISTRIBUTOR, STONK));
    expect(lender.queryKey).toEqual(["lender-epoch-file", 7]);
    await lender.queryFn();
    expect(fetchMock).toHaveBeenLastCalledWith("/lender-epochs/7.json", { cache: "no-store" });
  });

  it("treats a 404 as not published and any other failure as an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 404, ok: false })));
    expect(await fileQuery().queryFn()).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 500, ok: false })));
    await expect(fileQuery().queryFn()).rejects.toThrow("Reward file could not be loaded.");
  });
});

describe("RewardClaims: the panel", () => {
  const panel = (props: Partial<Parameters<typeof RewardClaims>[0]> = {}) => renderToStaticMarkup(createElement(RewardClaims, {
    program: maker(), address: ACCOUNT, epochs: [9, 8], heading: "Claim rewards", ...props,
  }));

  it("asks for a wallet first", () => {
    const html = panel({ address: undefined, lede: "A lede.", tip: "A tip.", notice: createElement("p", null, "Lead notice") });
    expect(html).toContain("Connect wallet");
    expect(html).toContain("A lede.");
    expect(html).toContain("Lead notice");
    expect(html).toContain('aria-label="About reward claims"');
    expect(html).toContain('id="maker-rewards"');
  });

  it("shows the program's own not-configured notice and no epochs when it has no distributor", () => {
    const html = panel({ program: makerProgram(null) });
    expect(html).toContain("Reward claims will open after the RewardsDistributor is deployed.");
    expect(html).not.toContain("Epoch 9");
    const lender = panel({ program: lenderProgram(null) });
    expect(lender).toContain("Rewards are not configured yet.");
    expect(lender).toContain('id="lender-rewards"');
  });

  it("lists every epoch it is given, newest as passed, after the caller's unavailable notice", () => {
    q.states["maker-epoch-file"] = { data: null };
    const html = panel({ unavailable: createElement("p", null, "Older epochs are unavailable.") });
    expect(html.indexOf("Older epochs are unavailable.")).toBeLessThan(html.indexOf("Epoch 9: not published yet."));
    expect(html.indexOf("Epoch 9")).toBeLessThan(html.indexOf("Epoch 8"));
  });

  it("resolves an unresolved program's token from its distributor, and never reads for one that has it", async () => {
    q.states["reward-token"] = { data: STONK };
    q.states["maker-epoch-file"] = { data: null };
    const html = panel({ program: maker(null) });
    // With the token folded in the program is live, so the epochs render instead of the notice.
    expect(html).toContain("Epoch 9: not published yet.");
    const read = q.calls.find((c) => c.queryKey[0] === "reward-token")!;
    expect(read.queryKey).toEqual(["reward-token", "maker", DISTRIBUTOR]);
    expect(read.enabled).toBe(true);
    await read.queryFn();
    expect(chain.resolveRewardToken).toHaveBeenCalledWith(DISTRIBUTOR);
    q.calls = [];
    panel({ program: maker(USDG) });
    expect(q.calls.find((c) => c.queryKey[0] === "reward-token")!.enabled).toBe(false);
  });

  it("stays unconfigured while the token read has no answer", () => {
    q.states["reward-token"] = { data: undefined };
    expect(panel({ program: maker(null) })).toContain("Reward claims will open after the RewardsDistributor is deployed.");
    q.states["reward-token"] = { data: null };
    expect(panel({ program: maker(null) })).toContain("Reward claims will open after the RewardsDistributor is deployed.");
  });
});
