/**
 * RedeemQueue's actions: typing an amount, max, over-balance, the wrong-network and disconnected gates, and the three
 * writes (redeem/queueRedeem, completeRedeem, settleQueue) with their exact args, chainId pin and toast labels, plus
 * the busy state and onDone only on a hash. The copy per state is covered by VaultCopyReview.test.tsx.
 *
 * No DOM renderer here, so while the component function is called directly, useState/useMemo are a slot stand-in (H.on);
 * the returned tree is then server-rendered with the real hooks for its markup.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useAccount, useWriteContract } from "wagmi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CHAIN_ID } from "@/lib/chain";
import type { AccountPosition, VaultSnapshot } from "@/lib/hooks";
import { useTxRunner } from "./TxToast";
import { RedeemQueue } from "./RedeemQueue";

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
vi.mock("wagmi", () => ({ useAccount: vi.fn(), useWriteContract: vi.fn() }));
vi.mock("./ConnectButton", async () => {
  const { createElement } = await vi.importActual<typeof import("react")>("react");
  return { ConnectButton: () => createElement("button", null, "Connect wallet") };
});
vi.mock("./TxToast", () => ({ useTxRunner: vi.fn() }));
vi.mock("@/lib/contracts", async (orig) => ({
  ...(await orig<typeof import("@/lib/contracts")>()),
  VAULT: "0x00000000000000000000000000000000000000aa",
}));

const VAULT = "0x00000000000000000000000000000000000000aa";
const ME = "0x00000000000000000000000000000000000000bb";
const HASH = `0x${"1".repeat(64)}`;
const E18 = 10n ** 18n;

type Props = Record<string, unknown> & { children?: ReactNode };
type El = ReactElement<Props>;
function all(node: ReactNode, pred: (e: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) { for (const n of node) all(n as ReactNode, pred, out); return out; }
  if (!isValidElement(node)) return out;
  if (pred(node as El)) out.push(node as El);
  const p = (node as El).props;
  all(p.children, pred, out);
  if (isValidElement(p.v)) all(p.v as ReactNode, pred, out);
  return out;
}
const text = (n: ReactNode): string => Array.isArray(n) ? n.map(text).join("") : isValidElement(n) ? text((n as El).props.children) : n == null || typeof n === "boolean" ? "" : String(n);
const button = (tree: ReactNode, label: string) => all(tree, (e) => typeof e.props.onClick === "function" && text(e.props.children) === label)[0];

let run: ReturnType<typeof vi.fn>;
let write: ReturnType<typeof vi.fn>;
let onDone: ReturnType<typeof vi.fn>;

function account(over: Record<string, unknown> = {}) {
  vi.mocked(useAccount).mockReturnValue({ address: ME, isConnected: true, chainId: CHAIN_ID, ...over } as never);
}
function render(snapshot: Partial<VaultSnapshot>, position: Partial<AccountPosition>) {
  H.on = true;
  H.i = 0;
  const tree = RedeemQueue({ snapshot: { ready: true, ...snapshot } as VaultSnapshot, position: { ready: true, ...position }, onDone }) as ReactNode;
  H.on = false;
  return { tree, html: renderToStaticMarkup(tree as ReactElement) };
}
function type(tree: ReactNode, value: string) {
  const field = all(tree, (e) => e.props.id === "redeem-shares")[0]!;
  (field.props.onChange as (e: { target: { value: string } }) => void)({ target: { value } });
}

beforeEach(() => {
  H.slots = [];
  account();
  write = vi.fn(async () => HASH);
  run = vi.fn(async (send: () => Promise<string>) => send());
  onDone = vi.fn();
  vi.mocked(useWriteContract).mockReturnValue({ writeContractAsync: write } as never);
  vi.mocked(useTxRunner).mockReturnValue(run as never);
});

describe("the withdraw form", () => {
  const free = { shares: 3n * E18 + E18 / 4n };

  it("nothing typed: the submit is disabled", () => {
    const { tree } = render({ canRedeemInstantly: true }, free);
    expect(button(tree, "Redeem now")!.props.disabled).toBe(true);
  });

  it("max fills the exact free balance (no rounding), which then enables the submit", () => {
    const first = render({ canRedeemInstantly: true }, free);
    (button(first.tree, "max")!.props.onClick as () => void)();
    const { tree } = render({ canRedeemInstantly: true }, free);
    expect(all(tree, (e) => e.props.id === "redeem-shares")[0]!.props.value).toBe("3.25");
    expect(button(tree, "Redeem now")!.props.disabled).toBe(false);
    H.slots = [];
    (button(render({ canRedeemInstantly: true }, { shares: 2n * E18 }).tree, "max")!.props.onClick as () => void)();
    expect(all(render({}, {}).tree, (e) => e.props.id === "redeem-shares")[0]!.props.value, "a whole number has no '.'").toBe("2");
  });

  it("more than the free shares: a danger notice and a disabled submit", () => {
    type(render({ canRedeemInstantly: false }, free).tree, "3.2500001");
    const { tree, html } = render({ canRedeemInstantly: false }, free);
    expect(html).toContain("More than your free shares.");
    expect(button(tree, "Queue redemption")!.props.disabled).toBe(true);
  });

  it("zero, or an unparseable amount, stays disabled", () => {
    for (const v of ["0", "abc", "1.2.3"]) {
      type(render({ canRedeemInstantly: true }, free).tree, v);
      expect(button(render({ canRedeemInstantly: true }, free).tree, "Redeem now")!.props.disabled, v).toBe(true);
    }
  });

  it("instant: redeem(shares, me, me) pinned to 4663; on a hash the field clears and onDone fires", async () => {
    type(render({ canRedeemInstantly: true }, free).tree, "1.5");
    const { tree } = render({ canRedeemInstantly: true }, free);
    const pending = (button(tree, "Redeem now")!.props.onClick as () => Promise<void>)();
    expect(text(button(render({ canRedeemInstantly: true }, free).tree, "Working…")!.props.children), "busy while sending").toBe("Working…");
    await pending;
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      address: VAULT, functionName: "redeem", args: [3n * E18 / 2n, ME, ME], chainId: CHAIN_ID,
    }));
    expect(run.mock.calls[0]![1]).toEqual({ pending: "Redeeming", success: "Redeemed — NVDA returned" });
    expect(onDone).toHaveBeenCalledTimes(1);
    const after = render({ canRedeemInstantly: true }, free).tree;
    expect(all(after, (e) => e.props.id === "redeem-shares")[0]!.props.value).toBe("");
    expect(button(after, "Redeem now"), "busy cleared").toBeDefined();
  });

  it("queued path: queueRedeem(shares); a failed tx (null) keeps the amount and skips onDone", async () => {
    run.mockImplementation(async (send: () => Promise<string>) => { await send(); return null; });
    type(render({ canRedeemInstantly: false }, free).tree, "2");
    await (button(render({ canRedeemInstantly: false }, free).tree, "Queue redemption")!.props.onClick as () => Promise<void>)();
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ functionName: "queueRedeem", args: [2n * E18], chainId: CHAIN_ID }));
    expect(run.mock.calls[0]![1]).toEqual({ pending: "Queuing redemption", success: "Queued for this week's close" });
    expect(onDone).not.toHaveBeenCalled();
    expect(all(render({}, free).tree, (e) => e.props.id === "redeem-shares")[0]!.props.value).toBe("2");
  });

  it("a thrown runner still clears busy", async () => {
    run.mockRejectedValue(new Error("boom"));
    type(render({ canRedeemInstantly: true }, free).tree, "1");
    await expect((button(render({ canRedeemInstantly: true }, free).tree, "Redeem now")!.props.onClick as () => Promise<void>)()).rejects.toThrow("boom");
    expect(button(render({ canRedeemInstantly: true }, free).tree, "Redeem now")).toBeDefined();
  });

  it("wrong network: no submit button at all, a switch hint; disconnected: the connect button", () => {
    account({ chainId: 1 });
    const wrong = render({ canRedeemInstantly: true }, free);
    expect(button(wrong.tree, "Redeem now")).toBeUndefined();
    expect(wrong.html).toContain("Switch to Robinhood Chain to redeem.");
    account({ address: undefined, isConnected: false, chainId: undefined });
    expect(render({ canRedeemInstantly: true }, free).html).toContain("Connect wallet");
  });
});

describe("the queued-redemption block", () => {
  it("settleable (Idle, entry in the current epoch): settleQueue() with no args, then onDone", async () => {
    const { tree, html } = render({ canRedeemInstantly: true, phase: 0, epochId: 7n, isStranded: false }, { shares: 0n, queuedShares: E18, queuedEpoch: 7n });
    expect(html).toContain("batch #7 · now #7");
    expect(button(tree, "Collect earlier redemption"), "nothing collectable yet").toBeUndefined();
    await (button(tree, "Settle queue")!.props.onClick as () => Promise<void>)();
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ functionName: "settleQueue", args: [], chainId: CHAIN_ID }));
    expect(run.mock.calls[0]![1]).toEqual({ pending: "Settling the queue", success: "Queue settled: ready to collect" });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("settleable while stranded, with an earlier payout: the note mentions the claim; collect calls completeRedeem(me)", async () => {
    const { tree, html } = render({ canRedeemInstantly: false, phase: 0, epochId: 7n, isStranded: true },
      { queuedShares: E18, queuedEpoch: 7n, pendingUsdg: 5_000_000n });
    expect(html).toContain("books this batch&#x27;s share of the stranded claim");
    await (button(tree, "Collect earlier redemption")!.props.onClick as () => Promise<void>)();
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ functionName: "completeRedeem", args: [ME], chainId: CHAIN_ID }));
    expect(run.mock.calls[0]![1]).toEqual({ pending: "Completing redemption", success: "Redemption collected" });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("settleable on the wrong network: the settle button is disabled and the actions refuse to send", async () => {
    account({ chainId: 1 });
    const { tree, html } = render({ phase: 0, epochId: 7n }, { queuedShares: E18, queuedEpoch: 7n, pendingAssets: 1n });
    expect(button(tree, "Settle queue")!.props.disabled).toBe(true);
    expect(button(tree, "Collect earlier redemption")!.props.disabled).toBe(true);
    expect(html).toContain("Switch to Robinhood Chain to redeem.");
    await (button(tree, "Settle queue")!.props.onClick as () => Promise<void>)();
    await (button(tree, "Collect earlier redemption")!.props.onClick as () => Promise<void>)();
    expect(write).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("waiting on the keeper (a call is open): the amounts fill in later; an earlier payout is collectable meanwhile", () => {
    const waiting = render({ phase: 1, epochId: 7n }, { queuedShares: E18, queuedEpoch: 7n });
    expect(waiting.html).toContain("The amounts above fill in then.");
    expect(button(waiting.tree, "Collect earlier redemption")).toBeUndefined();
    const owed = render({ phase: 1, epochId: 7n }, { queuedShares: E18, queuedEpoch: 7n, pendingAssets: E18 });
    expect(owed.html).toContain("from an earlier redemption and can be collected now");
    expect(button(owed.tree, "Collect earlier redemption")!.props.disabled).toBe(false);
  });

  it("settled: Complete redemption pays out; the payable legs are formatted with their own decimals", async () => {
    const { tree, html } = render({ phase: 1, epochId: 8n }, { queuedShares: E18, queuedEpoch: 7n, pendingAssets: 15n * E18 / 10n, pendingUsdg: 12_340_000n });
    expect(html).toContain("batch #7 · now #8");
    expect(html).toMatch(/Payable NVDA[\s\S]*1\.5/);
    expect(html).toMatch(/Payable USDG[\s\S]*12\.34/);
    const btn = button(tree, "Complete redemption")!;
    expect(btn.props.variant).toBe("primary");
    await (btn.props.onClick as () => Promise<void>)();
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ functionName: "completeRedeem", args: [ME] }));
  });

  it("a failed completion does not call onDone", async () => {
    run.mockResolvedValue(null);
    const { tree } = render({ phase: 1, epochId: 8n }, { queuedShares: E18, queuedEpoch: 7n, pendingAssets: 1n });
    await (button(tree, "Complete redemption")!.props.onClick as () => Promise<void>)();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("disconnected: complete and settle send nothing", async () => {
    account({ address: undefined, isConnected: false, chainId: undefined });
    const settle = render({ phase: 0, epochId: 7n }, { queuedShares: E18, queuedEpoch: 7n });
    await (button(settle.tree, "Settle queue")!.props.onClick as () => Promise<void>)();
    const done = render({ phase: 1, epochId: 8n }, { queuedShares: E18, queuedEpoch: 7n, pendingAssets: 1n });
    await (button(done.tree, "Complete redemption")!.props.onClick as () => Promise<void>)();
    expect(run).not.toHaveBeenCalled();
  });

  it("only a staged strand share: 'Ready to collect', and the three follow-up notices by state", () => {
    const waiting = render({ epochId: 9n, lastResolvedGen: 1n }, { owedStrandWad: 1n, owedStrandGen: 2n });
    expect(waiting.html).toContain("Ready to collect");
    expect(waiting.html).toContain("nothing queued");
    expect(waiting.html).toContain("Part of this is a share of the stranded claim.");
    const complete = button(waiting.tree, "Complete redemption")!;
    expect(complete.props.disabled, "nothing collectable yet").toBe(true);
    expect(complete.props.variant).toBe("ghost");

    const recovered = render({ epochId: 9n, lastResolvedGen: 2n }, { owedStrandWad: 1n, owedStrandGen: 2n, pendingAssets: 1n });
    expect(recovered.html).toContain("The stranded claim has been redeemed.");

    const usdg = render({ epochId: 9n }, { pendingUsdg: 1_000_000n });
    expect(usdg.html).toContain("Some USDG from an earlier collection is still owed.");
  });

  it("nothing queued, collectable or staged: no block", () => {
    expect(render({ epochId: 9n }, {}).html).not.toContain("Complete redemption");
  });

  it("an unread epoch shows '—' rather than a made-up number", () => {
    expect(render({ phase: 1 }, { queuedShares: E18 }).html).toContain("batch #— · now #—");
  });
});
