/**
 * LenderRewardsPage on the redesigned page. Rewritten from the earlier LenderRewardsPage.test.ts
 * which drove the pre-redesign layout. Look up one published week, show its pool from the file, and hand the
 * week to the shared claims panel. Node only: react-query is mocked per query key, `RewardClaims` is replaced by a stub
 * that records its props, and the week input and the lookup form are driven through a small `useState` harness (the page
 * runs as a function, handlers are called directly, the next render is read as markup).
 *
 * The redesign moved "Look up" into a <form> (the button is type="submit", the lookup is the form's onSubmit), moved
 * "Anyone can claim." into the claims panel's `lede` prop and the look-up prompt into its `notice` prop, and shows the
 * pool as two rows instead of one sentence.
 */
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- hook harness: react's state/memo hooks become in-memory slots while `render` calls the page ----
const h = vi.hoisted(() => ({ active: false, cursor: 0, slots: [] as unknown[] }));
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

type QueryState = { isPending?: boolean; isError?: boolean; data?: unknown; error?: Error };
type QueryCall = { queryKey: unknown[]; queryFn: () => Promise<unknown>; enabled?: boolean };
const q = vi.hoisted(() => ({ states: {} as Record<string, QueryState>, calls: [] as QueryCall[] }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: QueryCall) => {
    q.calls.push(options);
    return { isPending: false, isError: false, data: undefined, ...q.states[String(options.queryKey[0])] };
  },
}));
const acct = vi.hoisted(() => ({ address: undefined as Address | undefined }));
vi.mock("wagmi", () => ({ useAccount: () => ({ address: acct.address }) }));
const claims = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
vi.mock("@/components/v2/RewardClaims", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return { RewardClaims: (props: Record<string, unknown>) => {
    claims.props.push(props);
    return react.createElement("section", { "data-claims": String(props.epochs) }, props.notice as ReactNode);
  } };
});
const lender = vi.hoisted(() => ({ distributor: null as Address | null, parse: vi.fn((body: unknown) => body), resolve: vi.fn() }));
vi.mock("@/lib/v2/lenderRewards", async () => {
  const programs = await vi.importActual<typeof import("@/lib/v2/rewardPrograms")>("@/lib/v2/rewardPrograms");
  return {
    lenderDistributorAddress: () => lender.distributor,
    lenderRewardProgram: () => programs.lenderProgram(lender.distributor),
    parseLenderEpochFile: lender.parse,
  };
});
vi.mock("@/lib/v2/rewardPrograms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/rewardPrograms")>()),
  resolveRewardToken: lender.resolve,
}));

import { InfoTip } from "@/components/ui";
import type { RewardProgram, RewardToken } from "@/lib/v2/rewardPrograms";
import { LenderRewardsPage } from "./LenderRewardsPage";

const DISTRIBUTOR = "0x00000000000000000000000000000000000000d2" as Address;
const STONK: RewardToken = { address: "0x00000000000000000000000000000000000000c8", decimals: 18, symbol: "STONKHOUSE" };
const entry = (amount: string) => ({ index: 0, account: DISTRIBUTOR, amount, proof: [] });

let tree: ReactNode = null;
function render(): string {
  h.active = true; h.cursor = 0; claims.props = [];
  try { tree = LenderRewardsPage(); } finally { h.active = false; }
  return renderToStaticMarkup(createElement("div", null, tree));
}
type El = ReactElement<Record<string, unknown>>;
/** The first element whose props match, walking every prop (the page nests content in props other than children). */
function findWhere(pred: (e: El) => boolean, node: unknown = tree): El {
  const seen = new Set<unknown>();
  const walk = (n: unknown): El | null => {
    if (n === null || typeof n !== "object" || seen.has(n)) return null;
    seen.add(n);
    if (Array.isArray(n)) { for (const c of n) { const r = walk(c); if (r) return r; } return null; }
    if (!isValidElement(n)) return null;
    if (pred(n as El)) return n as El;
    for (const v of Object.values((n as El).props)) { const r = walk(v); if (r) return r; }
    return null;
  };
  const hit = walk(node);
  if (!hit) throw new Error("no such element");
  return hit;
}
const text = (n: unknown): string => typeof n === "string" || typeof n === "number" ? String(n)
  : Array.isArray(n) ? n.map(text).join("") : isValidElement(n) ? text((n.props as { children?: unknown }).children) : "";
const lookUp = () => findWhere((e) => e.props.type === "submit" && text(e.props.children) === "Look up");
const form = () => findWhere((e) => e.type === "form");
function type(value: string): string {
  (findWhere((e) => e.props.id === "lender-epoch").props.onChange as (e: unknown) => void)({ target: { value } });
  return render();
}
/** Submitting the form (Enter or the submit button): it must not navigate, and it looks up only a valid week. */
function submit(): { html: string; prevented: boolean } {
  let prevented = false;
  (form().props.onSubmit as (e: unknown) => void)({ preventDefault: () => { prevented = true; } });
  return { html: render(), prevented };
}
const lastClaims = () => claims.props.at(-1) as { program: RewardProgram; epochs: number[]; address: Address | undefined; lede: string };

beforeEach(() => {
  h.slots = []; q.states = {}; q.calls = []; acct.address = undefined; lender.distributor = null;
  lender.parse.mockClear(); lender.resolve.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("LenderRewardsPage: an unconfigured program", () => {
  it("says rewards are not configured, that anyone can claim, that a week is not a forecast, and never reads a token", () => {
    const html = render();
    expect(html).toContain("Rewards are not configured yet.");
    expect(lastClaims().lede).toContain("Anyone can claim.");
    const tip = findWhere((e) => e.type === InfoTip && String(e.props.label).includes("published weeks"));
    expect(String(tip.props.text)).toContain("not what a future week will pay");
    expect(q.calls.find((c) => c.queryKey[0] === "reward-token")!.enabled).toBe(false);
    expect(lastClaims().program.status).toBe("planned");
    expect(lastClaims().epochs).toEqual([]);
  });

  it("stays unconfigured with a distributor but no token read yet", () => {
    lender.distributor = DISTRIBUTOR;
    expect(render()).toContain("Rewards are not configured yet.");
    const read = q.calls.find((c) => c.queryKey[0] === "reward-token")!;
    expect(read.enabled).toBe(true);
    expect(read.queryKey).toEqual(["reward-token", "lender", DISTRIBUTOR]);
    void read.queryFn();
    expect(lender.resolve).toHaveBeenCalledWith(DISTRIBUTOR);
  });

  it("is live once the distributor's token resolves, and passes the resolved program to the claims panel", () => {
    lender.distributor = DISTRIBUTOR;
    acct.address = DISTRIBUTOR;
    q.states["reward-token"] = { data: STONK };
    expect(render()).not.toContain("Rewards are not configured");
    expect(lastClaims().program).toMatchObject({ status: "live", token: STONK, distributor: DISTRIBUTOR });
    expect(lastClaims().address).toBe(DISTRIBUTOR);
  });
});

describe("LenderRewardsPage: the week lookup", () => {
  it("keeps Look up disabled, and the form inert, until the input is a whole week number of at most nine digits", () => {
    expect(render()).toContain("Look up a week first");
    expect(lookUp().props.disabled).toBe(true);
    for (const bad of ["abc", "1.5", "-3", "1234567890", "1e3"]) {
      expect(type(bad)).toContain("Enter a whole week number.");
      expect(lookUp().props.disabled).toBe(true);
      const { prevented } = submit();
      expect(prevented, "the form never navigates").toBe(true);
      expect(lastClaims().epochs, `${bad} looks nothing up`).toEqual([]);
    }
    expect(type(" 2958 ")).not.toContain("Enter a whole week number.");
    expect(lookUp().props.disabled).toBe(false);
  });

  it("hands the looked-up week to the claims panel and drops the look-up prompt", () => {
    q.states["lender-epoch-file"] = { isPending: true };
    type("2958");
    const { html, prevented } = submit();
    expect(prevented).toBe(true);
    expect(lastClaims().epochs).toEqual([2958]);
    expect(html).not.toContain("Look up a week first");
    expect(html).toContain("Week 2958: checking published rewards…");
  });

  it("reads the lender's own published file for that week", async () => {
    q.states["lender-epoch-file"] = { isPending: true };
    type("12"); submit();
    const read = q.calls.find((c) => c.queryKey[0] === "lender-epoch-file")!;
    expect(read.queryKey).toEqual(["lender-epoch-file", 12]);
    const body = { epoch: 12 };
    const fetchMock = vi.fn(async () => ({ status: 200, ok: true, json: async () => body }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await read.queryFn()).toBe(body);
    expect(fetchMock).toHaveBeenCalledWith("/lender-epochs/12.json", { cache: "no-store" });
    expect(lender.parse).toHaveBeenCalledWith(body, 12);
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 404, ok: false })));
    expect(await read.queryFn()).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 503, ok: false })));
    await expect(read.queryFn()).rejects.toThrow("Reward file could not be loaded.");
  });

  it("shows an unpublished week and a file error as such", () => {
    q.states["lender-epoch-file"] = { data: null };
    type("3");
    expect(submit().html).toContain("Week 3: no rewards published yet.");
    q.states["lender-epoch-file"] = { isError: true, error: new Error("Reward total or indices do not match the entries.") };
    expect(render()).toContain("Week 3: Reward total or indices do not match the entries.");
  });

  it("reads the pool from the file in the token's decimals and counts only paid wallets", () => {
    q.states["reward-token"] = { data: STONK };
    lender.distributor = DISTRIBUTOR;
    q.states["lender-epoch-file"] = { data: { epoch: 4, total: "3000000000000000000",
      entries: [entry("1000000000000000000"), entry("2000000000000000000"), entry("0")] } };
    type("4");
    const { html } = submit();
    expect(html).toMatch(/Week 4 pool[\s\S]*?>3 STONKHOUSE</);
    expect(html).toMatch(/Shared by[\s\S]*?>2 of 3 wallets in the file</);
  });

  it("says Unavailable, not a number, while the token is unread, and uses the singular for one wallet", () => {
    q.states["lender-epoch-file"] = { data: { epoch: 5, total: "7", entries: [entry("7")] } };
    type("5");
    const { html } = submit();
    expect(html).toMatch(/Week 5 pool[\s\S]*?>Unavailable</);
    expect(html).not.toMatch(/Week 5 pool[\s\S]*?>7</);
    expect(html).toMatch(/Shared by[\s\S]*?>1 of 1 wallet in the file</);
  });
});
