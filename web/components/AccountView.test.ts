/**
 * AccountView: the v1 solo-writer account page, which v1 writers still use to exit (settle, collect USDG, withdraw).
 * The gates (mounted, connected, chain, account read, no account), the figures and their decimals (Stock Token 18,
 * USDG 6), every write with its exact args, target and chainId pin, the approve-then-deposit and set-amount-then-list
 * sequences, the disabled states, and the run-off mode (NEXT_PUBLIC_V2=1) that keeps only the exits.
 *
 * No DOM renderer: the component function is called directly with a useState/useMemo slot stand-in (H.on), as
 * RedeemQueue.flow.test.ts does, and the returned tree is server-rendered for its markup.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useAccount, useBlock, useReadContract, useWriteContract } from "wagmi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CHAIN_ID } from "@/lib/chain";
import { USDG, ZERO_ADDRESS } from "@/lib/contracts";
import { useMounted } from "@/lib/hooks";
import { LEGACY_MARKETS } from "@/lib/legacy";
import { useTxRunner } from "./TxToast";
import { AccountView } from "./AccountView";

const H = vi.hoisted(() => ({ on: false, slots: [] as unknown[], i: 0 }));
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
    useMemo: (f: () => unknown, deps: unknown[]) => (H.on ? f() : real.useMemo(f, deps)),
  };
});
vi.mock("wagmi", () => ({ useAccount: vi.fn(), useBlock: vi.fn(), useReadContract: vi.fn(), useWriteContract: vi.fn() }));
vi.mock("@/lib/hooks", () => ({ useMounted: vi.fn() }));
vi.mock("./ConnectButton", async () => {
  const { createElement } = await vi.importActual<typeof import("react")>("react");
  return { ConnectButton: () => createElement("button", null, "Connect wallet") };
});
vi.mock("./TxToast", () => ({ useTxRunner: vi.fn() }));

const market = LEGACY_MARKETS[0]!;
const ME = "0x00000000000000000000000000000000000000bb";
const ACCT = "0x00000000000000000000000000000000000000cc";
const HASH = `0x${"1".repeat(64)}`;
const E18 = 10n ** 18n;

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
const button = (tree: ReactNode, label: string | RegExp) =>
  all(tree, (e) => typeof e.props.onClick === "function" && (typeof label === "string" ? text(e.props.children) === label : label.test(text(e.props.children))))[0];
const click = (tree: ReactNode, label: string | RegExp) => (button(tree, label)!.props.onClick as () => Promise<unknown>)();
const field = (tree: ReactNode, id: string) => all(tree, (e) => e.props.id === id)[0];
const type = (tree: ReactNode, id: string, value: string) =>
  (field(tree, id)!.props.onChange as (e: { target: { value: string } }) => void)({ target: { value } });

/** The reads, by name. balanceOf splits three ways: the wallet's Stock Token, the wallet's USDG, the account's USDG. */
type Key = "accountOf" | "walletStock" | "walletUsdg" | "accountUsdg" | "idleAssets" | "reserved" | "requestedLots"
  | "listedLots" | "contractsWritten" | "listedExpiryTs" | "allowance" | "week" | "writesHalted";
let R: Partial<Record<Key, unknown>>;
let Q: Partial<Record<Key, Record<string, unknown>>>;
let refetch: Record<string, ReturnType<typeof vi.fn>>;
let cfgs: Record<string, Record<string, unknown>>;
let run: ReturnType<typeof vi.fn>;
let write: ReturnType<typeof vi.fn>;

function keyOf(c: { functionName: string; address?: string; args?: readonly unknown[] }): Key {
  if (c.functionName !== "balanceOf") return c.functionName as Key;
  if (c.address === market.asset) return "walletStock";
  return c.args?.[0] === ME ? "walletUsdg" : "accountUsdg";
}

function account(over: Record<string, unknown> = {}) {
  vi.mocked(useAccount).mockReturnValue({ address: ME, isConnected: true, chainId: CHAIN_ID, ...over } as never);
}
function blockAt(ts: bigint | undefined) {
  vi.mocked(useBlock).mockReturnValue({ data: ts === undefined ? undefined : { timestamp: ts } } as never);
}
const openWeek = { id: 3, strikeUsdg: 150_000_000n, exerciseTs: 1_000, baseExpiryTs: 2_000, askUsdg: 1_234_500n };

function render() {
  H.on = true;
  H.i = 0;
  const tree = AccountView({ market }) as ReactNode;
  H.on = false;
  return { tree, html: renderToStaticMarkup(tree as ReactElement) };
}

beforeEach(() => {
  H.slots = [];
  vi.mocked(useMounted).mockReturnValue(true);
  account();
  blockAt(500n);
  R = { accountOf: ACCT, idleAssets: 0n, reserved: 0n, walletStock: 0n, walletUsdg: 0n, accountUsdg: 0n, requestedLots: 0n,
    listedLots: 0n, contractsWritten: 0n, listedExpiryTs: 0n, allowance: 0n, week: openWeek, writesHalted: false };
  Q = {};
  refetch = {};
  cfgs = {};
  vi.mocked(useReadContract).mockImplementation(((c: { functionName: string; address?: string; args?: readonly unknown[] }) => {
    const k = keyOf(c);
    cfgs[k] = c as Record<string, unknown>;
    refetch[k] ??= vi.fn(async () => ({}));
    return { data: R[k], isLoading: false, isFetching: false, isError: false, isSuccess: true, refetch: refetch[k], ...(Q[k] ?? {}) };
  }) as never);
  write = vi.fn(async () => HASH);
  run = vi.fn(async (send: () => Promise<string>) => send());
  vi.mocked(useWriteContract).mockReturnValue({ writeContractAsync: write } as never);
  vi.mocked(useTxRunner).mockReturnValue(run as never);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("the gates before the account", () => {
  it("before mount: an empty placeholder, no copy and no button", () => {
    vi.mocked(useMounted).mockReturnValue(false);
    const { tree, html } = render();
    expect(html).toBe('<div class="min-h-[calc(100dvh-16rem)]"></div>');
    expect(button(tree, /./)).toBeUndefined();
  });

  it("disconnected: the connect button, with v1 or run-off copy", () => {
    account({ address: undefined, isConnected: false, chainId: undefined });
    expect(render().html).toContain(`Connect to deposit ${market.ticker}.`);
    vi.stubEnv("NEXT_PUBLIC_V2", "1");
    const { html } = render();
    expect(html).toContain(`Connect to see your ${market.ticker} v1 account.`);
    expect(html).toContain("Connect wallet");
  });

  it("wrong chain: a switch hint and nothing that writes", () => {
    account({ chainId: 1 });
    const { tree, html } = render();
    expect(html).toContain("Switch to Robinhood Chain.");
    expect(button(tree, "Open account")).toBeUndefined();
    expect(button(tree, /Collect|Withdraw|Deposit/)).toBeUndefined();
  });

  it("the account lookup is keyed to the connected wallet and disabled without one", () => {
    render();
    expect(cfgs.accountOf).toMatchObject({ address: market.factory, functionName: "accountOf", args: [ME], query: { enabled: true } });
    expect(cfgs.allowance).toMatchObject({ address: market.asset, args: [ME, ACCT], query: { enabled: true } });
    expect(cfgs.accountUsdg).toMatchObject({ address: USDG, args: [ACCT] });
    account({ address: undefined, isConnected: false });
    render();
    expect(cfgs.accountOf).toMatchObject({ args: undefined, query: { enabled: false } });
  });

  it("while the account lookup loads with no data: a placeholder, not 'Open account'", () => {
    R.accountOf = undefined;
    Q.accountOf = { isLoading: true };
    expect(render().html).toBe('<div class="min-h-[calc(100dvh-16rem)]"></div>');
    Q.accountOf = { isFetching: true };
    expect(render().html).not.toContain("Open an account");
  });

  it("a failed lookup offers a retry that refetches the lookup", async () => {
    R.accountOf = undefined;
    Q.accountOf = { isError: true };
    const { tree, html } = render();
    expect(html).toContain("Could not read this wallet&#x27;s account.");
    await click(tree, "Retry");
    expect(refetch.accountOf).toHaveBeenCalledTimes(1);
  });

  it("no account (zero address): open one with createAccount() on the market's factory, pinned to the chain", async () => {
    R.accountOf = ZERO_ADDRESS;
    const { tree, html } = render();
    expect(html).toContain("Open an account");
    await click(tree, "Open account");
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ address: market.factory, functionName: "createAccount", chainId: CHAIN_ID }));
    expect(run.mock.calls[0]![1]).toEqual({ pending: "Open account", success: "Account opened" });
    expect(Object.values(refetch).every((f) => f.mock.calls.length === 1), "every read refreshed once").toBe(true);
  });

  it("a non-string lookup result is treated as no account", () => {
    R.accountOf = 123n;
    expect(render().html).toContain("Open an account");
  });

  it("run-off with no account: no way to open one, a link to Sell options instead", () => {
    vi.stubEnv("NEXT_PUBLIC_V2", "1");
    R.accountOf = ZERO_ADDRESS;
    const { tree, html } = render();
    expect(html).toContain("No v1 account");
    expect(html).toContain(`href="/sell/${market.ticker.toLowerCase()}"`);
    expect(button(tree, "Open account")).toBeUndefined();
  });
});

describe("the figures", () => {
  it("Account is free + reserved (18 decimals); USDG is the wallet's, at 6 decimals", () => {
    R.idleAssets = 2n * E18 + E18 / 2n;
    R.reserved = E18;
    R.walletUsdg = 12_340_000n;
    const { html } = render();
    const dds = [...html.matchAll(/<dd[^>]*>(.*?)<\/dd>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ""));
    expect(dds).toEqual([`3.5 ${market.ticker}`, `2.5 ${market.ticker}`, "12.34"]);
  });

  it("non-bigint reads count as zero rather than breaking the arithmetic", () => {
    R.idleAssets = "5";
    R.reserved = undefined;
    R.walletUsdg = null;
    const { html } = render();
    const dds = [...html.matchAll(/<dd[^>]*>(.*?)<\/dd>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ""));
    expect(dds).toEqual([`0 ${market.ticker}`, `0 ${market.ticker}`, "0"]);
  });

  it("the chips: listed/sold counts, week closed, paused", () => {
    R.listedLots = 2n;
    R.contractsWritten = 1n;
    R.writesHalted = true;
    R.week = { ...openWeek, id: 0 };
    const { html } = render();
    expect(html).toContain("2 listed");
    expect(html).toContain("1 sold");
    expect(html).toContain("Week closed");
    expect(html).toContain("Paused");
    R.listedLots = 0n; R.contractsWritten = 0n; R.writesHalted = false; R.week = openWeek;
    const plain = render().html;
    expect(plain).toContain("Not listed");
    expect(plain).not.toMatch(/Week closed|Paused| sold</);
  });
});

describe("deposit and withdraw (v1)", () => {
  beforeEach(() => { R.walletStock = 3n * E18 + 1n; });

  it("the wallet shortcut fills the exact wallet balance, all 18 decimals", () => {
    const first = render();
    expect(text(button(first.tree, /^Wallet /)!.props.children)).toBe("Wallet 3");
    void click(first.tree, /^Wallet /);
    expect(field(render().tree, "solo-deposit")!.props.value).toBe("3.000000000000000001");
    expect(button(render().tree, "Deposit")!.props.disabled).toBe(false);
  });

  it("empty, zero, unparseable, over 18 decimals or over the wallet: Deposit is disabled", () => {
    expect(button(render().tree, "Deposit")!.props.disabled).toBe(true);
    for (const v of ["0", "abc", "1.2.3", "0.0000000000000000001", "3.000000000000000002"]) {
      type(render().tree, "solo-deposit", v);
      expect(button(render().tree, "Deposit")!.props.disabled, v).toBe(true);
    }
  });

  it("allowance short: approve(account, exact amount) on the Stock Token, then deposit(amount); the field clears", async () => {
    R.allowance = E18;
    type(render().tree, "solo-deposit", "1.5");
    await click(render().tree, "Deposit");
    expect(write.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ address: market.asset, functionName: "approve", args: [ACCT, 3n * E18 / 2n], chainId: CHAIN_ID }),
      expect.objectContaining({ address: ACCT, functionName: "deposit", args: [3n * E18 / 2n], chainId: CHAIN_ID }),
    ]);
    expect(run.mock.calls.map((c) => c[1])).toEqual([
      { pending: "Approve", success: "Approved" },
      { pending: "Deposit", success: "Deposited" },
    ]);
    expect(field(render().tree, "solo-deposit")!.props.value).toBe("");
  });

  it("allowance covers it: no approve, straight to deposit", async () => {
    R.allowance = 2n * E18;
    type(render().tree, "solo-deposit", "2");
    await click(render().tree, "Deposit");
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toMatchObject({ functionName: "deposit", args: [2n * E18] });
  });

  it("an unread allowance counts as zero; a rejected approve stops before the deposit", async () => {
    R.allowance = undefined;
    run.mockImplementation(async (send: () => Promise<string>) => { await send(); return null; });
    type(render().tree, "solo-deposit", "1");
    await click(render().tree, "Deposit");
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toMatchObject({ functionName: "approve" });
    expect(field(render().tree, "solo-deposit")!.props.value, "the amount is kept").toBe("1");
  });

  it("Out withdraws exactly the free balance and is disabled with none", async () => {
    expect(button(render().tree, "Out")!.props.disabled).toBe(true);
    R.idleAssets = 7n * E18 + 3n;
    await click(render().tree, "Out");
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ address: ACCT, functionName: "withdraw", args: [7n * E18 + 3n], chainId: CHAIN_ID }));
    expect(run.mock.calls[0]![1]).toEqual({ pending: "Withdraw", success: "Withdrawn" });
  });

  it("busy while a send is in flight, cleared afterwards, even when the runner throws", async () => {
    R.idleAssets = E18;
    let release!: (v: string) => void;
    run.mockImplementation(() => new Promise((r) => { release = r; }));
    const pending = click(render().tree, "Out");
    expect(button(render().tree, "Out")!.props.disabled, "busy").toBe(true);
    release(HASH);
    await pending;
    expect(button(render().tree, "Out")!.props.disabled).toBe(false);
    run.mockRejectedValue(new Error("boom"));
    await expect(click(render().tree, "Out")).rejects.toThrow("boom");
    expect(button(render().tree, "Out")!.props.disabled).toBe(false);
  });
});

describe("the offer (v1)", () => {
  beforeEach(() => { R.idleAssets = 2n * E18 + E18 / 2n; });

  it("shows the week's strike and ask (ask to 3 decimals), the free whole lots as the placeholder and shortcut", () => {
    const { tree, html } = render();
    expect(html).toContain("150 strike · 1.234 USDG");
    expect(field(tree, "solo-offer")!.props.placeholder).toBe("2");
    void click(tree, "Free 2");
    expect(field(render().tree, "solo-offer")!.props.value).toBe("2");
  });

  it("with nothing typed the offer defaults to every free whole lot", async () => {
    await click(render().tree, "Offer");
    expect(write.mock.calls[0]![0]).toMatchObject({ address: ACCT, functionName: "requestWrite", args: [2n], chainId: CHAIN_ID });
    expect(write.mock.calls[1]![0]).toMatchObject({ address: ACCT, functionName: "list", chainId: CHAIN_ID });
    expect(run.mock.calls.map((c) => c[1])).toEqual([
      { pending: "Set amount", success: "Amount set" },
      { pending: "List", success: "Listed" },
    ]);
  });

  it("more than the free whole lots, zero, or not a number: disabled", () => {
    for (const v of ["3", "0", "-1", "abc"]) {
      type(render().tree, "solo-offer", v);
      expect(button(render().tree, "Offer")!.props.disabled, v).toBe(true);
    }
    type(render().tree, "solo-offer", "1");
    expect(button(render().tree, "Offer")!.props.disabled).toBe(false);
  });

  it("less than one whole free lot: no shortcut and nothing to offer", () => {
    R.idleAssets = E18 - 1n;
    const { tree } = render();
    expect(button(tree, /^Free /)).toBeUndefined();
    expect(field(tree, "solo-offer")!.props.placeholder).toBe("0");
    expect(button(tree, "Offer")!.props.disabled).toBe(true);
  });

  it("the requested amount already matches: list() only", async () => {
    R.requestedLots = 1n;
    type(render().tree, "solo-offer", "1");
    await click(render().tree, "Offer");
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toMatchObject({ functionName: "list" });
  });

  it("a rejected requestWrite stops before list()", async () => {
    run.mockImplementation(async (send: () => Promise<string>) => { await send(); return null; });
    await click(render().tree, "Offer");
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toMatchObject({ functionName: "requestWrite" });
  });

  it("the week's state replaces the form: loading, not open, already listed, paused", () => {
    Q.week = { isSuccess: false, isError: false };
    expect(render().html).toContain("Loading…");
    Q.week = { isSuccess: false, isError: true };
    R.week = undefined;
    expect(render().html).toContain("Week not open.");
    Q.week = {};
    R.week = { ...openWeek, id: 0 };
    const closed = render();
    expect(closed.html).toContain("Week not open.");
    expect(closed.html).not.toContain(" strike · ");
    R.week = openWeek;
    R.listedLots = 2n;
    R.contractsWritten = 1n;
    const listed = render();
    expect(listed.html).toContain(`2 ${market.ticker} listed · 1 sold.`);
    expect(button(listed.tree, "Offer")).toBeUndefined();
    expect(button(listed.tree, /^Free /), "no shortcut once listed").toBeUndefined();
    R.contractsWritten = 0n;
    expect(render().html).toContain(`2 ${market.ticker} listed.`);
    R.listedLots = 0n;
    R.writesHalted = true;
    const paused = render();
    expect(paused.html).toContain("New sales are paused.");
    expect(button(paused.tree, "Offer")).toBeUndefined();
  });
});

describe("close the week and collect", () => {
  it("Close week appears only once the chain clock reaches the listed expiry, and calls settle()", async () => {
    R.listedExpiryTs = 600n;
    blockAt(599n);
    expect(button(render().tree, "Close week")).toBeUndefined();
    blockAt(undefined);
    expect(button(render().tree, "Close week"), "no block read yet").toBeUndefined();
    blockAt(600n);
    await click(render().tree, "Close week");
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ address: ACCT, functionName: "settle", chainId: CHAIN_ID }));
    expect(run.mock.calls[0]![1]).toEqual({ pending: "Close the week", success: "Week closed" });
  });

  it("a numeric expiry read is accepted too; no listing (0) never offers Close week", () => {
    R.listedExpiryTs = 400;
    expect(button(render().tree, "Close week")).toBeDefined();
    R.listedExpiryTs = 0n;
    blockAt(10_000n);
    expect(button(render().tree, "Close week")).toBeUndefined();
    R.listedExpiryTs = "400";
    expect(button(render().tree, "Close week"), "a string is not an expiry").toBeUndefined();
  });

  it("Collect names the account's USDG at 6 decimals and calls claimUsdg()", async () => {
    R.accountUsdg = 5_500_000n;
    const { tree } = render();
    expect(text(button(tree, /^Collect /)!.props.children)).toBe("Collect 5.50 USDG");
    await click(tree, /^Collect /);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ address: ACCT, functionName: "claimUsdg", chainId: CHAIN_ID }));
    expect(run.mock.calls[0]![1]).toEqual({ pending: "Collect USDG", success: "Collected" });
  });
});

describe("run-off mode (NEXT_PUBLIC_V2=1)", () => {
  beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_V2", "1"); });

  it("no deposit and no offer; the exits remain", async () => {
    R.idleAssets = 4n * E18;
    R.accountUsdg = 1_000_000n;
    R.listedExpiryTs = 100n;
    const { tree, html } = render();
    expect(field(tree, "solo-deposit")).toBeUndefined();
    expect(field(tree, "solo-offer")).toBeUndefined();
    expect(html).toContain("New v1 deposits have moved to v2.");
    expect(button(tree, "Close week")).toBeDefined();
    expect(button(tree, "Collect 1 USDG")).toBeDefined();
    await click(tree, "Withdraw 4");
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ address: ACCT, functionName: "withdraw", args: [4n * E18], chainId: CHAIN_ID }));
  });

  it("Withdraw is disabled with nothing free", () => {
    expect(button(render().tree, "Withdraw 0")!.props.disabled).toBe(true);
  });
});
