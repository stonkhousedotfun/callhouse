/**
 * BookView: the v1 book for one market. What it decides: which lots are shown (only validated, uncancelled, unfilled
 * Seaport orders, keyed 1:1 to their hash reads), the ask per lot (the consideration summed, USDG 6 decimals), which
 * held calls go to ExercisePanel (deduped, zero balances dropped, with their exercise window), and the fill (a USDG
 * balance check, an exact approval to Seaport only when short, then fulfillAdvancedOrder for 1/1 to the buyer).
 * Run-off mode (NEXT_PUBLIC_V2=1) hides the book and keeps exercise.
 *
 * The component function is called directly with a useState/useMemo slot stand-in, as RedeemQueue.flow.test.ts does.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getAddress } from "viem";
import { useAccount, useBlock, usePublicClient, useReadContract, useReadContracts, useWriteContract } from "wagmi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CHAIN_ID } from "@/lib/chain";
import { CLEARINGHOUSE, SEAPORT, USDG, ZERO_CONDUIT_KEY, ZERO_HASH } from "@/lib/contracts";
import { LEGACY_MARKETS } from "@/lib/legacy";
import { ExercisePanel } from "@/components/legacy/ExercisePanel";
import { useNotice, useTxRunner } from "./TxToast";
import { BookView } from "./BookView";

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
vi.mock("wagmi", () => ({
  useAccount: vi.fn(), useBlock: vi.fn(), usePublicClient: vi.fn(), useReadContract: vi.fn(), useReadContracts: vi.fn(),
  useWriteContract: vi.fn(),
}));
vi.mock("./ConnectButton", async () => {
  const { createElement } = await vi.importActual<typeof import("react")>("react");
  return { ConnectButton: () => createElement("button", null, "Connect wallet") };
});
vi.mock("./TxToast", () => ({ useTxRunner: vi.fn(), useNotice: vi.fn() }));
vi.mock("@/components/legacy/ExercisePanel", () => ({ ExercisePanel: vi.fn(() => null) }));

const market = LEGACY_MARKETS[0]!;
const ME = "0x00000000000000000000000000000000000000bb";
const A1 = "0x00000000000000000000000000000000000000a1";
const A2 = "0x00000000000000000000000000000000000000a2";
const OWNER1 = "0x1111111111111111111111111111111111111111";
const HASH = `0x${"1".repeat(64)}`;
const OH = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

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
const buttons = (tree: ReactNode, label: string) => all(tree, (e) => typeof e.props.onClick === "function" && text(e.props.children) === label);
/** Buy's onClick is `() => void fill(order)`: it returns nothing to await, so let the fill's promise chain drain. */
const buy = async (tree: ReactNode, i = 0) => { (buttons(tree, "Buy")[i]!.props.onClick as () => void)(); await new Promise((r) => setTimeout(r, 0)); };
const panelRows = (tree: ReactNode) => all(tree, (e) => e.type === ExercisePanel)[0]!.props.rows as Array<{ optionId: bigint; balance: bigint; window: string }>;

/** A lot order as viem decodes the struct: one ERC1155 call offered, USDG consideration split fee + seller. */
function lot(offerer: string, salt: bigint, prices: bigint[] = [1_200_000n, 34_500n]) {
  return {
    offerer, zone: "0x0000000000000000000000000000000000000000",
    offer: [{ itemType: 3, token: CLEARINGHOUSE, identifierOrCriteria: 7n, startAmount: 1n, endAmount: 1n }],
    consideration: prices.map((p, i) => ({ itemType: 1, token: USDG, identifierOrCriteria: 0n, startAmount: p, endAmount: p, recipient: i === 0 ? offerer : OWNER1 })),
    orderType: 0, startTime: 1n, endTime: 99_999_999_999n, zoneHash: ZERO_HASH, salt, conduitKey: ZERO_CONDUIT_KEY, counter: 0n,
  };
}
const ok = (result: unknown) => ({ status: "success" as const, result });
const bad = { status: "failure" as const, error: new Error("revert") };

type Row = { status: "success" | "failure"; result?: unknown; error?: Error };
/** Answers per functionName, given the contracts array the component asked for. */
let reads: Record<string, (contracts: Array<{ address: string; args?: readonly unknown[] }>) => Row[] | undefined>;
let calls: Record<string, Array<{ address: string; functionName: string; args?: readonly unknown[] }>>;
let refetch: Record<string, ReturnType<typeof vi.fn>>;
let single: Record<string, { data?: unknown; isSuccess?: boolean; isError?: boolean }>;
let run: ReturnType<typeof vi.fn>;
let write: ReturnType<typeof vi.fn>;
let notice: ReturnType<typeof vi.fn>;
let readContract: ReturnType<typeof vi.fn>;
let usdg: { balance: bigint; allowance: bigint | undefined };

function account(over: Record<string, unknown> = {}) {
  vi.mocked(useAccount).mockReturnValue({ address: ME, isConnected: true, chainId: CHAIN_ID, ...over } as never);
}
const openWeek = { id: 2, strikeUsdg: 150_000_000n, exerciseTs: 1_000, baseExpiryTs: 2_000, askUsdg: 1_234_500n };

function render() {
  H.on = true;
  H.i = 0;
  const tree = BookView({ market }) as ReactNode;
  H.on = false;
  return { tree, html: renderToStaticMarkup(tree as ReactElement) };
}

/** Two live accounts; A1 lists two lots, A2 one; every hash and status read succeeds and every order is open. */
function book() {
  single.liveCount = { data: 2n };
  reads.liveAt = () => [ok(A1), ok(A2)];
  reads.listedLots = () => [ok(2n), ok(1n)];
  reads.liveListingCount = () => [ok(2n), ok(1n)];
  reads.owner = () => [ok(OWNER1), bad];
  reads.lotOrder = (cs) => cs.map((c) => ok(lot(c.address, c.args![0] as bigint)));
  reads.getOrderHash = (cs) => cs.map((_, i) => ok(OH(i + 1)));
  reads.getOrderStatus = (cs) => cs.map(() => ok([true, false, 0n, 0n]));
}

beforeEach(() => {
  H.slots = [];
  account();
  vi.mocked(useBlock).mockReturnValue({ data: { timestamp: 1_500n } } as never);
  reads = {};
  calls = {};
  refetch = {};
  single = { liveCount: { data: 0n }, week: { data: openWeek, isSuccess: true } };
  vi.mocked(useReadContracts).mockImplementation(((cfg: { contracts: Array<{ address: string; functionName: string; args?: readonly unknown[] }> }) => {
    const fn = cfg.contracts[0]?.functionName ?? "none";
    calls[fn] = cfg.contracts;
    refetch[fn] ??= vi.fn();
    const data = cfg.contracts.length === 0 ? undefined : reads[fn]?.(cfg.contracts);
    return { data, refetch: refetch[fn] };
  }) as never);
  vi.mocked(useReadContract).mockImplementation(((c: { functionName: string }) => ({ isSuccess: false, isError: false, ...single[c.functionName] })) as never);
  usdg = { balance: 10_000_000n, allowance: 0n };
  readContract = vi.fn(async (c: { functionName: string }) => (c.functionName === "balanceOf" ? usdg.balance : usdg.allowance));
  vi.mocked(usePublicClient).mockReturnValue({ readContract } as never);
  write = vi.fn(async () => HASH);
  run = vi.fn(async (send: () => Promise<string>) => send());
  notice = vi.fn();
  vi.mocked(useWriteContract).mockReturnValue({ writeContractAsync: write } as never);
  vi.mocked(useTxRunner).mockReturnValue(run as never);
  vi.mocked(useNotice).mockReturnValue(notice as never);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("which lots are for sale", () => {
  it("reads liveAt(0..count-1), then one lotOrder per listed salt, and prices each lot at its consideration's sum", () => {
    book();
    const { html } = render();
    expect(calls.liveAt!.map((c) => c.args)).toEqual([[0n], [1n]]);
    expect(calls.lotOrder!.map((c) => [c.address, c.args![0]])).toEqual([[A1, 0n], [A1, 1n], [A2, 0n]]);
    expect(calls.getOrderStatus!.map((c) => c.args![0])).toEqual([OH(1), OH(2), OH(3)]);
    // 1.2 + 0.0345 USDG, three decimals: "1.234"
    expect(html.match(new RegExp(`1 ${market.ticker} · 1.234 USDG`, "g"))).toHaveLength(3);
    expect(html).toContain(` This week: 1.234 USDG each.`);
  });

  it("'From' is the account's owner when read, else the order's offerer", () => {
    book();
    const { html } = render();
    expect(html).toContain("0x1111…1111");
    expect(html).toContain("0x0000…00a2");
  });

  it("an account with nothing listed, or no live listing, asks for no lots; failed index reads are skipped", () => {
    single.liveCount = { data: 3n };
    reads.liveAt = () => [ok(A1), bad, ok(A2)];
    reads.listedLots = () => [ok(0n), ok(1n)];
    reads.liveListingCount = () => [ok(1n), ok(0n)];
    const { html } = render();
    expect(calls.listedLots!.map((c) => c.address)).toEqual([A1, A2]);
    expect(calls.lotOrder).toBeUndefined();
    expect(html).toContain("Nothing is for sale right now.");
  });

  it("cancelled, unvalidated or fully filled orders are dropped; a partly filled one stays", () => {
    book();
    const statuses = [[true, true, 0n, 1n], [false, false, 0n, 0n], [true, false, 1n, 1n]];
    reads.getOrderStatus = (cs) => cs.map((_, i) => ok(statuses[i]));
    expect(render().html).toContain("Nothing is for sale right now.");
    statuses[2] = [true, false, 1n, 2n];
    expect(render().html.match(/1 NVDA · /g)).toHaveLength(1);
  });

  it("a failed hash read maps to ZERO_HASH for its status call, and that lot is shown unfiltered", () => {
    book();
    reads.getOrderHash = (cs) => cs.map((_, i) => (i === 1 ? bad : ok(OH(i + 1))));
    reads.getOrderStatus = (cs) => cs.map(() => ok([true, true, 0n, 0n]));
    const { html } = render();
    expect(calls.getOrderStatus!.map((c) => c.args![0])).toEqual([OH(1), ZERO_HASH, OH(3)]);
    expect(html.match(/1 NVDA · /g), "only the lot whose status is unknown").toHaveLength(1);
  });

  it("a failed lotOrder read is skipped without shifting the next lot's status", () => {
    book();
    reads.lotOrder = (cs) => cs.map((c, i) => (i === 0 ? bad : ok(lot(c.address, c.args![0] as bigint))));
    // hashes are for lots 1 and 2 only; the first of them is cancelled
    reads.getOrderStatus = (cs) => cs.map((_, i) => ok(i === 0 ? [true, true, 0n, 0n] : [true, false, 0n, 0n]));
    const { html } = render();
    expect(calls.getOrderHash).toHaveLength(2);
    expect(html.match(/1 NVDA · /g)).toHaveLength(1);
    expect(html).toContain("0x0000…00a2");
  });

  it("decodes the order from a {c: …} wrapper and from a positional tuple; drops a malformed one", () => {
    single.liveCount = { data: 1n };
    reads.liveAt = () => [ok(A1)];
    reads.listedLots = () => [ok(3n)];
    reads.liveListingCount = () => [ok(3n)];
    reads.owner = () => [ok(OWNER1)];
    const o = lot(A1, 5n, [2_000_000n]);
    const tuple = [o.offerer, o.zone,
      o.offer.map((x) => [x.itemType, x.token, x.identifierOrCriteria, x.startAmount, x.endAmount]),
      o.consideration.map((x) => [x.itemType, x.token, x.identifierOrCriteria, x.startAmount, x.endAmount, x.recipient]),
      o.orderType, o.startTime, o.endTime, o.zoneHash, 6n, o.conduitKey, o.counter];
    reads.lotOrder = () => [ok({ c: o }), ok(tuple), ok({ offerer: A1 })];
    reads.getOrderHash = (cs) => cs.map((_, i) => ok(OH(i + 1)));
    const { html } = render();
    expect(calls.getOrderHash, "the malformed order gets no hash call").toHaveLength(2);
    expect(calls.getOrderHash![1]!.args![0]).toMatchObject({ salt: 6n, consideration: [{ startAmount: 2_000_000n, recipient: A1 }] });
    expect(html.match(/1 NVDA · 2 USDG/g)).toHaveLength(2);
  });

  it("ignores null, primitive and incomplete lotOrder results", () => {
    single.liveCount = { data: 1n };
    reads.liveAt = () => [ok(A1)];
    reads.listedLots = () => [ok(3n)];
    reads.liveListingCount = () => [ok(3n)];
    reads.lotOrder = () => [ok(null), ok("0x"), ok({ ...lot(A1, 0n), counter: undefined })];
    const { html } = render();
    expect(calls.getOrderHash).toBeUndefined();
    expect(html).toContain("Nothing is for sale right now.");
  });

  it("the week gates the list: loading, not open (id 0 or unreadable), then the lots", () => {
    book();
    single.week = { data: undefined };
    expect(render().html).toContain("Loading this week.");
    single.week = { data: { ...openWeek, id: 0 }, isSuccess: true };
    const closed = render().html;
    expect(closed).toContain("Nothing is for sale yet this week.");
    expect(closed).not.toContain("This week: ");
    single.week = { isError: true };
    expect(render().html).toContain("Nothing is for sale yet this week.");
  });

  it("disconnected or on the wrong chain, each lot offers the connect button instead of Buy", () => {
    book();
    account({ chainId: 1 });
    expect(buttons(render().tree, "Buy")).toHaveLength(0);
    expect(render().html).toContain("Connect wallet");
    account({ address: undefined, isConnected: false, chainId: undefined });
    expect(buttons(render().tree, "Buy")).toHaveLength(0);
  });

  it("an unread liveCount asks for nothing", () => {
    single.liveCount = { data: undefined };
    render();
    expect(calls.none).toEqual([]);
    expect(calls.liveAt).toBeUndefined();
  });
});

describe("buying one lot", () => {
  beforeEach(book);
  const cost = 1_234_500n;

  it("USDG short of the ask: an error naming the exact amount, and nothing is sent", async () => {
    usdg.balance = cost - 1n;
    await buy(render().tree, 0);
    expect(notice).toHaveBeenCalledWith("error", "Not enough USDG", "Need 1.2345 USDG in this wallet.");
    expect(write).not.toHaveBeenCalled();
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ address: USDG, functionName: "allowance", args: [ME, SEAPORT] }));
  });

  it("allowance short: approve(Seaport, exactly the ask), then fulfillAdvancedOrder 1/1 to the buyer; the reads refresh", async () => {
    usdg.allowance = 1n;
    const tree = render().tree;
    await buy(tree);
    expect(write.mock.calls[0]![0]).toMatchObject({ address: USDG, functionName: "approve", args: [SEAPORT, cost], chainId: CHAIN_ID });
    const fill = write.mock.calls[1]![0] as { address: string; functionName: string; args: [{ numerator: bigint; denominator: bigint; parameters: { offerer: string; totalOriginalConsiderationItems: bigint } }, unknown[], string, string]; chainId: number };
    expect(fill).toMatchObject({ address: SEAPORT, functionName: "fulfillAdvancedOrder", chainId: CHAIN_ID });
    expect(fill.args[0]).toMatchObject({ numerator: 1n, denominator: 1n, parameters: { offerer: getAddress(A1) } });
    expect(fill.args.slice(1)).toEqual([[], ZERO_CONDUIT_KEY, ME]);
    expect(run.mock.calls.map((c) => c[1])).toEqual([{ pending: "Approve USDG", success: "Approved" }, { pending: "Buy", success: "Bought" }]);
    expect(refetch.lotOrder).toHaveBeenCalledTimes(1);
    expect(refetch.liveListingCount).toHaveBeenCalledTimes(1);
    expect(refetch.getOrderStatus).toHaveBeenCalledTimes(1);
  });

  it("allowance already covers the ask: no approve", async () => {
    usdg.allowance = cost;
    await buy(render().tree, 1);
    expect(write).toHaveBeenCalledTimes(1);
    expect((write.mock.calls[0]![0] as { args: [{ parameters: { salt: bigint } }] }).args[0].parameters.salt).toBe(1n);
  });

  it("a rejected approve stops before the fill; busy clears", async () => {
    run.mockImplementation(async (send: () => Promise<string>) => { await send(); return null; });
    await buy(render().tree, 0);
    expect(write).toHaveBeenCalledTimes(1);
    expect(buttons(render().tree, "Buy")[0]!.props.disabled).toBe(false);
  });

  it("an unread allowance, or no public client, sends nothing", async () => {
    usdg.allowance = undefined;
    await buy(render().tree, 0);
    vi.mocked(usePublicClient).mockReturnValue(undefined as never);
    await buy(render().tree, 0);
    expect(write).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("busy while filling: every Buy is disabled", async () => {
    const waiting: Array<(v: bigint) => void> = [];
    readContract.mockImplementation(() => new Promise((r) => { waiting.push(r); }));
    (buttons(render().tree, "Buy")[0]!.props.onClick as () => void)();
    expect(buttons(render().tree, "Buy").every((b) => b.props.disabled === true)).toBe(true);
    for (const r of waiting) r(10_000_000n);
    await new Promise((r) => setTimeout(r, 0));
    expect(buttons(render().tree, "Buy").every((b) => b.props.disabled === false)).toBe(true);
  });
});

describe("the calls this wallet holds", () => {
  beforeEach(() => {
    single.liveCount = { data: 3n };
    reads.liveAt = () => [ok(A1), ok(A2), ok(OWNER1)];
    reads.listedLots = () => [ok(0n), ok(0n), ok(0n)];
    reads.liveListingCount = () => [ok(0n), ok(0n), ok(0n)];
  });

  it("one row per distinct option with a balance, each with its window from the chain clock", () => {
    reads.optionId = () => [ok(11n), ok(11n), ok(12n)];
    reads.balanceOf = () => [ok(4n), ok(4n), ok(1n)];
    reads.option = (cs) => cs.map((c) => (c.args![0] === 11n
      ? ok({ exerciseAmount: 150_000_000n, underlyingAmount: 10n ** 18n, exerciseTimestamp: 1_000n, expiryTimestamp: 2_000n })
      : ok([0n, 10n ** 18n, 0n, 1n, 1_600n, 1_700n])));
    const { tree } = render();
    expect(calls.balanceOf!.map((c) => [c.address, c.args])).toEqual([[CLEARINGHOUSE, [ME, 11n]], [CLEARINGHOUSE, [ME, 11n]], [CLEARINGHOUSE, [ME, 12n]]]);
    expect(calls.option!.map((c) => c.args![0])).toEqual([11n, 12n]);
    expect(panelRows(tree)).toEqual([
      { optionId: 11n, balance: 4n, window: "open" },
      { optionId: 12n, balance: 1n, window: "before" },
    ]);
  });

  it("zero ids, zero or failed balances, and failed option reads: dropped or 'unknown'", () => {
    reads.optionId = () => [ok(0n), bad, ok(13n)];
    reads.balanceOf = () => [ok(5n), ok(5n), ok(2n)];
    reads.option = () => [bad];
    expect(calls.balanceOf).toBeUndefined();
    const { tree } = render();
    expect(calls.balanceOf!.map((c) => c.args![1]), "a failed optionId asks for id 0").toEqual([0n, 0n, 13n]);
    expect(panelRows(tree)).toEqual([{ optionId: 13n, balance: 2n, window: "unknown" }]);
    reads.balanceOf = () => [ok(5n), ok(5n), bad];
    expect(panelRows(render().tree)).toEqual([]);
    reads.balanceOf = () => [ok(5n), ok(5n), ok(2n)];
    reads.option = () => [ok({ exerciseAmount: 1n })];
    expect(panelRows(render().tree)[0]!.window, "an incomplete option tuple").toBe("unknown");
    reads.option = () => [ok(null)];
    expect(panelRows(render().tree)[0]!.window).toBe("unknown");
  });

  it("an expired option is passed as 'expired'; no block yet is 'unknown'", () => {
    reads.optionId = () => [ok(13n), ok(0n), ok(0n)];
    reads.balanceOf = () => [ok(1n), ok(0n), ok(0n)];
    reads.option = () => [ok({ exerciseAmount: 1n, underlyingAmount: 1n, exerciseTimestamp: 1n, expiryTimestamp: 1_500n })];
    expect(panelRows(render().tree)[0]!.window).toBe("expired");
    vi.mocked(useBlock).mockReturnValue({ data: undefined } as never);
    expect(panelRows(render().tree)[0]!.window).toBe("unknown");
  });

  it("no wallet: no balance reads, no rows; the panel's onDone refetches the balances", () => {
    reads.optionId = () => [ok(11n), ok(0n), ok(0n)];
    reads.balanceOf = () => [ok(1n), ok(0n), ok(0n)];
    const { tree } = render();
    (all(tree, (e) => e.type === ExercisePanel)[0]!.props.onDone as () => void)();
    expect(refetch.balanceOf).toHaveBeenCalledTimes(1);
    account({ address: undefined, isConnected: false });
    calls = {};
    expect(panelRows(render().tree)).toEqual([]);
    expect(calls.balanceOf).toBeUndefined();
  });
});

describe("run-off mode (NEXT_PUBLIC_V2=1)", () => {
  it("no lots, no Buy, no week price; the exercise panel stays", () => {
    vi.stubEnv("NEXT_PUBLIC_V2", "1");
    book();
    const { tree, html } = render();
    expect(html).toContain("Your v1 calls.");
    expect(html).toContain("Exercise the calls you hold while their window is open.");
    expect(html).toContain("New v1 buys have moved to v2.");
    expect(html).not.toContain("This week: ");
    expect(buttons(tree, "Buy")).toHaveLength(0);
    expect(all(tree, (e) => e.type === ExercisePanel)).toHaveLength(1);
  });

  it("v1 mode names the market in the lede", () => {
    expect(render().html).toContain(`Each offer is one ${market.ticker} call from one seller.`);
  });
});

/*
 * hashCalls skips a SUCCESSFUL lotOrder row whose result asLotOrder cannot decode, so liveRows must advance its hash
 * index only for decodable rows. When it counted every successful row, each later lot read the NEXT lot's hash/status
 * (the last one read none and was shown unfiltered), so a cancelled or filled order could be listed as buyable.
 */
it("an undecodable lotOrder row does not shift later lots onto the wrong Seaport status", () => {
  single.liveCount = { data: 1n };
  reads.liveAt = () => [ok(A1)];
  reads.listedLots = () => [ok(2n)];
  reads.liveListingCount = () => [ok(2n)];
  reads.lotOrder = () => [ok({ offerer: A1 }), ok(lot(A1, 1n))];
  reads.getOrderHash = (cs) => cs.map(() => ok(OH(1)));
  reads.getOrderStatus = () => [ok([true, true, 0n, 0n])]; // the one decodable lot is cancelled
  expect(render().html).toContain("Nothing is for sale right now.");
});
