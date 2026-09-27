/**
 * MigrationGuide: the v1 writer's way out, one journey per legacy market. The gates (no wallet, wrong chain, no
 * markets), each journey's read states (checking, error with retry, no account, loading), which step's button is
 * offered (lib/legacy.ts migrationStep: wait, settle, claim, withdraw, then v2), the stuck-collateral warning, and the
 * three writes: each simulated against the account first, sent pinned to the chain, then every read refreshed.
 *
 * AccountJourney is not exported; it is reached through the elements MigrationGuide returns and called directly with a
 * useState slot stand-in, as RedeemQueue.flow.test.ts does.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useAccount, useBlock, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CHAIN_ID } from "@/lib/chain";
import { USDG, ZERO_ADDRESS } from "@/lib/contracts";
import { isV2Live } from "@/lib/markets";
import { useNotice, useTxRunner } from "@/components/TxToast";
import { MigrationGuide } from "./MigrationGuide";

const H = vi.hoisted(() => ({ on: false, slots: [] as unknown[], i: 0 }));
const M = vi.hoisted(() => ({ list: null as unknown[] | null }));
vi.mock("react", async (orig) => {
  const real = await orig<typeof import("react")>();
  return {
    ...real,
    useState: (init: unknown) => {
      if (!H.on) return real.useState(init);
      const k = H.i++;
      if (!(k in H.slots)) H.slots[k] = init;
      return [H.slots[k], (v: unknown) => { H.slots[k] = v; }];
    },
  };
});
vi.mock("wagmi", () => ({ useAccount: vi.fn(), useBlock: vi.fn(), usePublicClient: vi.fn(), useReadContract: vi.fn(), useWriteContract: vi.fn() }));
vi.mock("@/components/ConnectButton", async () => {
  const { createElement } = await vi.importActual<typeof import("react")>("react");
  return { ConnectButton: () => createElement("button", null, "Connect wallet") };
});
vi.mock("@/components/TxToast", () => ({ useTxRunner: vi.fn(), useNotice: vi.fn() }));
vi.mock("@/lib/legacy", async (orig) => {
  const real = await orig<typeof import("@/lib/legacy")>();
  return { ...real, get LEGACY_MARKETS() { return M.list ?? real.LEGACY_MARKETS; } };
});
vi.mock("@/lib/markets", async (orig) => ({ ...(await orig<typeof import("@/lib/markets")>()), isV2Live: vi.fn() }));

const ME = "0x00000000000000000000000000000000000000bb";
const ACCT = "0x00000000000000000000000000000000000000cc";
const HASH = `0x${"1".repeat(64)}`;
const E18 = 10n ** 18n;
const ASSET = "0x00000000000000000000000000000000000000a5";
const NVDA = { ticker: "NVDA", factory: "0x00000000000000000000000000000000000000f1", asset: ASSET };

type Props = Record<string, unknown> & { children?: ReactNode };
type El = ReactElement<Props>;
function all(node: ReactNode, pred: (e: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) { for (const n of node) all(n as ReactNode, pred, out); return out; }
  if (!isValidElement(node)) return out;
  if (pred(node as El)) out.push(node as El);
  all((node as El).props.children, pred, out);
  return out;
}
const text = (n: ReactNode): string => Array.isArray(n) ? n.map(text).join("") : isValidElement(n) ? text((n as El).props.children) : n == null || typeof n === "boolean" ? "" : String(n);
const button = (tree: ReactNode, label: string) => all(tree, (e) => typeof e.props.onClick === "function" && text(e.props.children) === label)[0];
const flush = () => new Promise((r) => setTimeout(r, 0));

type Key = "accountOf" | "listedExpiryTs" | "idleAssets" | "reserved" | "claimKey" | "usdg" | "walletStock";
let R: Partial<Record<Key, unknown>>;
let Q: Partial<Record<Key, Record<string, unknown>>>;
let refetch: Record<string, ReturnType<typeof vi.fn>>;
let cfgs: Record<string, Record<string, unknown>>;
let client: { simulateContract: ReturnType<typeof vi.fn> };
let run: ReturnType<typeof vi.fn>;
let write: ReturnType<typeof vi.fn>;
let notice: ReturnType<typeof vi.fn>;

function account(over: Record<string, unknown> = {}) {
  vi.mocked(useAccount).mockReturnValue({ address: ME, chainId: CHAIN_ID, ...over } as never);
}
function guide() {
  return MigrationGuide() as ReactNode;
}
/** Render one market's journey: the element MigrationGuide returns, called as a function. */
function journey(market = NVDA) {
  M.list = [market];
  // The guide itself only mounts journeys for a connected wallet on the right chain; the journey gets the test's account.
  vi.mocked(useAccount).mockReturnValueOnce({ address: ME, chainId: CHAIN_ID } as never);
  const el = all(guide(), (e) => typeof e.type === "function" && (e.type as { name?: string }).name === "AccountJourney")[0]!;
  H.on = true;
  H.i = 0;
  const tree = (el.type as (p: unknown) => ReactNode)(el.props);
  H.on = false;
  return { tree, html: tree === null ? "" : renderToStaticMarkup(tree as ReactElement) };
}

beforeEach(() => {
  H.slots = [];
  M.list = null;
  account();
  vi.mocked(isV2Live).mockReturnValue(true);
  vi.mocked(useBlock).mockReturnValue({ data: { timestamp: 1_000n } } as never);
  R = { accountOf: ACCT, listedExpiryTs: 0n, idleAssets: 0n, reserved: 0n, claimKey: 0n, usdg: 0n, walletStock: 0n };
  Q = {};
  refetch = {};
  cfgs = {};
  vi.mocked(useReadContract).mockImplementation(((c: { functionName: string; address?: string }) => {
    const k = (c.functionName === "balanceOf" ? (c.address === USDG ? "usdg" : "walletStock") : c.functionName) as Key;
    cfgs[k] = c as Record<string, unknown>;
    refetch[k] ??= vi.fn(async () => ({}));
    return { data: R[k], isPending: false, isError: false, isSuccess: true, refetch: refetch[k], ...(Q[k] ?? {}) };
  }) as never);
  client = { simulateContract: vi.fn(async (c: Record<string, unknown>) => ({ request: { ...c, simulated: true } })) };
  vi.mocked(usePublicClient).mockReturnValue(client as never);
  write = vi.fn(async () => HASH);
  run = vi.fn(async (send: () => Promise<string>) => send());
  notice = vi.fn();
  vi.mocked(useWriteContract).mockReturnValue({ writeContractAsync: write } as never);
  vi.mocked(useTxRunner).mockReturnValue(run as never);
  vi.mocked(useNotice).mockReturnValue(notice as never);
});

describe("MigrationGuide gates", () => {
  it("no wallet: find your account, with the connect button", () => {
    account({ address: undefined, chainId: undefined });
    const html = renderToStaticMarkup(guide() as ReactElement);
    expect(html).toContain("Find your v1 account");
    expect(html).toContain("Connect wallet");
  });

  it("wrong chain: the switch notice, no journeys", () => {
    account({ chainId: 1 });
    const tree = guide();
    expect(renderToStaticMarkup(tree as ReactElement)).toContain("Switch to Robinhood Chain.");
    expect(all(tree, (e) => (e.type as { name?: string }).name === "AccountJourney")).toHaveLength(0);
  });

  it("one journey per legacy market, keyed by ticker; none in the build says so", () => {
    M.list = [NVDA, { ...NVDA, ticker: "TSLA" }];
    const js = all(guide(), (e) => (e.type as { name?: string }).name === "AccountJourney");
    expect(js.map((e) => [e.key, (e.props.market as { ticker: string }).ticker])).toEqual([["NVDA", "NVDA"], ["TSLA", "TSLA"]]);
    M.list = [];
    expect(renderToStaticMarkup(guide() as ReactElement)).toContain("No v1 markets in this build.");
  });
});

describe("a journey's read states", () => {
  it("reads the account from the market's factory for this wallet", () => {
    journey();
    expect(cfgs.accountOf).toMatchObject({ address: NVDA.factory, args: [ME], query: { enabled: true } });
    expect(cfgs.usdg).toMatchObject({ address: USDG, args: [ACCT], query: { enabled: true } });
    expect(cfgs.walletStock).toMatchObject({ address: ASSET, args: [ME] });
  });

  it("no wallet: nothing (the guide shows its own connect card)", () => {
    account({ address: undefined });
    expect(journey().tree).toBeNull();
    expect(cfgs.accountOf).toMatchObject({ args: undefined, query: { enabled: false } });
  });

  it("checking, then an error with a retry that refetches the factory read", async () => {
    Q.accountOf = { isPending: true };
    expect(journey().html).toContain("Checking NVDA v1 account…");
    Q.accountOf = {};
    Q.claimKey = { isError: true, isSuccess: false };
    const { tree, html } = journey();
    expect(html).toContain("Could not read the NVDA v1 account.");
    (button(tree, "Retry")!.props.onClick as () => void)();
    expect(refetch.accountOf).toHaveBeenCalledTimes(1);
  });

  it("no account (zero address, or not a string): says so, and the account reads stay disabled", () => {
    R.accountOf = ZERO_ADDRESS;
    expect(journey().html).toContain("No v1 account for this wallet.");
    expect(cfgs.idleAssets).toMatchObject({ address: undefined, query: { enabled: false } });
    R.accountOf = 5n;
    expect(journey().html).toContain("No v1 account for this wallet.");
  });

  it("any account read not yet in: loading", () => {
    Q.usdg = { isSuccess: false };
    expect(journey().html).toContain("Loading NVDA v1 account…");
  });
});

describe("the steps", () => {
  it("the figures (18-decimal Stock Token, 6-decimal USDG) and the account address", () => {
    R.idleAssets = 3n * E18 / 2n;
    R.reserved = E18;
    R.usdg = 2_500_000n;
    R.listedExpiryTs = 5_000n;
    const { html } = journey();
    expect(html).toContain(ACCT);
    expect(html).toContain(">1.5 NVDA<");
    expect(html).toContain(">1 NVDA<");
    expect(html).toContain(">2.50 USDG<");
    expect(html).toContain('href="/legacy/nvda/account"');
  });

  it("week still running: no settle, claim or withdraw button yet", () => {
    R.listedExpiryTs = 1_001n;
    R.usdg = 1n;
    R.idleAssets = 1n;
    const { tree, html } = journey();
    expect(html).toContain("Expiry: ");
    expect(all(tree, (e) => typeof e.props.onClick === "function")).toHaveLength(0);
    vi.mocked(useBlock).mockReturnValue({ data: undefined } as never);
    R.listedExpiryTs = 1n;
    expect(button(journey().tree, "Settle v1 week"), "no block read: still waiting").toBeUndefined();
  });

  it("expiry reached: settle() simulated on the account, sent pinned to the chain, then every read refreshed", async () => {
    R.listedExpiryTs = 1_000n;
    (button(journey().tree, "Settle v1 week")!.props.onClick as () => void)();
    await flush();
    expect(client.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ account: ME, address: ACCT, functionName: "settle", args: [] }));
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ functionName: "settle", simulated: true, chainId: CHAIN_ID }));
    expect(run.mock.calls[0]![1]).toEqual({ pending: "Settle v1 week", success: "V1 week settled" });
    for (const k of ["listedExpiryTs", "idleAssets", "reserved", "claimKey", "usdg", "walletStock"]) expect(refetch[k], k).toHaveBeenCalledTimes(1);
  });

  it("settled: claim the account's USDG, then withdraw exactly the free Stock Token", async () => {
    R.usdg = 5_500_000n;
    R.idleAssets = 7n * E18 + 1n;
    const { tree } = journey();
    expect(button(tree, "Settle v1 week")).toBeUndefined();
    (button(tree, "Claim 5.50 USDG")!.props.onClick as () => void)();
    await flush();
    expect(client.simulateContract).toHaveBeenLastCalledWith(expect.objectContaining({ address: ACCT, functionName: "claimUsdg", args: [] }));
    expect(run.mock.calls[0]![1]).toEqual({ pending: "Claim v1 USDG", success: "V1 USDG claimed" });
    (button(journey().tree, "Withdraw 7 NVDA")!.props.onClick as () => void)();
    await flush();
    expect(client.simulateContract).toHaveBeenLastCalledWith(expect.objectContaining({ address: ACCT, functionName: "withdraw", args: [7n * E18 + 1n] }));
    expect(run.mock.calls[1]![1]).toEqual({ pending: "Withdraw v1 Stock Tokens", success: "Idle Stock Tokens withdrawn" });
  });

  it("a rejected transaction refreshes nothing; a failed simulation becomes the notice", async () => {
    R.usdg = 1n;
    run.mockResolvedValueOnce(null);
    const claim = all(journey().tree, (e) => typeof e.props.onClick === "function")[0]!;
    (claim.props.onClick as () => void)();
    await flush();
    expect(refetch.usdg).not.toHaveBeenCalled();
    client.simulateContract.mockRejectedValueOnce(new Error("NotSettled()"));
    (all(journey().tree, (e) => typeof e.props.onClick === "function")[0]!.props.onClick as () => void)();
    await flush();
    expect(notice).toHaveBeenCalledWith("error", "Migration step stopped", "NotSettled()");
    client.simulateContract.mockRejectedValueOnce("rpc");
    (all(journey().tree, (e) => typeof e.props.onClick === "function")[0]!.props.onClick as () => void)();
    await flush();
    expect(notice).toHaveBeenLastCalledWith("error", "Migration step stopped", "The chain read failed.");
  });

  it("wrong chain, no client, or busy: the buttons are disabled and a click sends nothing", async () => {
    R.usdg = 1_000_000n;
    account({ chainId: 1 });
    const wrong = all(journey().tree, (e) => typeof e.props.onClick === "function")[0]!;
    expect(wrong.props.disabled).toBe(true);
    (wrong.props.onClick as () => void)();
    account();
    vi.mocked(usePublicClient).mockReturnValue(undefined as never);
    (all(journey().tree, (e) => typeof e.props.onClick === "function")[0]!.props.onClick as () => void)();
    await flush();
    expect(client.simulateContract).not.toHaveBeenCalled();
    vi.mocked(usePublicClient).mockReturnValue(client as never);
    let release!: (v: unknown) => void;
    client.simulateContract.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    (all(journey().tree, (e) => typeof e.props.onClick === "function")[0]!.props.onClick as () => void)();
    const busy = all(journey().tree, (e) => typeof e.props.onClick === "function")[0]!;
    expect(busy.props.disabled).toBe(true);
    (busy.props.onClick as () => void)();
    expect(client.simulateContract).toHaveBeenCalledTimes(1);
    release({ request: {} });
    await flush();
    expect(all(journey().tree, (e) => typeof e.props.onClick === "function")[0]!.props.disabled).toBe(false);
  });

  it("v2 live: both Sell options links; not live: says so and offers no link", () => {
    const live = journey().html;
    expect(live.match(/href="\/sell\/nvda"/g)).toHaveLength(2);
    vi.mocked(isV2Live).mockReturnValue(false);
    const notLive = journey().html;
    expect(notLive).toContain("Not live in v2 yet.");
    expect(notLive).not.toContain('href="/sell/nvda"');
  });

  it("a claim key left after settle: the stuck-collateral warning (not while a week is open)", () => {
    R.claimKey = 3n;
    expect(journey().html).toContain("Some collateral is stuck.");
    R.listedExpiryTs = 9_999n;
    expect(journey().html).not.toContain("Some collateral is stuck.");
  });

  it("all exited with Stock Token in the wallet and v2 live: the ready-for-v2 note with the exact amount", () => {
    R.walletStock = 25n * E18 / 10n;
    expect(journey().html).toContain("Your wallet holds 2.5 NVDA, ready for v2.");
    vi.mocked(isV2Live).mockReturnValue(false);
    expect(journey().html).not.toContain("ready for v2");
    vi.mocked(isV2Live).mockReturnValue(true);
    R.idleAssets = 1n;
    expect(journey().html, "not at the deposit step yet").not.toContain("ready for v2");
  });
});
