/**
 * ExercisePanel: the v1 buyer's exercise, which stays available through the last Valorem option window. Each click
 * re-reads the chain before the wallet opens (the option tuple, the block clock, the held balance, the fee switch, the
 * USDG balance and allowance) and refuses with a notice when any of them says no. The approval is exactly the total
 * (strike x amount + the clearinghouse fee), sent only when the allowance is short; both writes are simulated first and
 * pinned to the chain.
 *
 * The component function is called directly with a useState slot stand-in, as RedeemQueue.flow.test.ts does.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CHAIN_ID } from "@/lib/chain";
import { CLEARINGHOUSE, USDG } from "@/lib/contracts";
import { useNotice, useTxRunner } from "@/components/TxToast";
import { ExercisePanel, type LegacyHeldCall } from "./ExercisePanel";

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
  };
});
vi.mock("wagmi", () => ({ useAccount: vi.fn(), usePublicClient: vi.fn(), useWriteContract: vi.fn() }));
vi.mock("@/components/TxToast", () => ({ useTxRunner: vi.fn(), useNotice: vi.fn() }));

const ME = "0x00000000000000000000000000000000000000bb";
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
const btns = (tree: ReactNode) => all(tree, (e) => typeof e.props.onClick === "function");
const flush = () => new Promise((r) => setTimeout(r, 0));

let chain: { option: unknown; now: bigint; held: bigint; feesEnabled: boolean; feeBps: number; usdg: bigint; allowance: bigint | undefined };
let client: { readContract: ReturnType<typeof vi.fn>; getBlock: ReturnType<typeof vi.fn>; simulateContract: ReturnType<typeof vi.fn> };
let run: ReturnType<typeof vi.fn>;
let write: ReturnType<typeof vi.fn>;
let notice: ReturnType<typeof vi.fn>;
let onDone: ReturnType<typeof vi.fn>;

function account(over: Record<string, unknown> = {}) {
  vi.mocked(useAccount).mockReturnValue({ address: ME, chainId: CHAIN_ID, ...over } as never);
}
const row = (over: Partial<LegacyHeldCall> = {}): LegacyHeldCall => ({ optionId: 9n, balance: 2n, window: "open", ...over });
function render(rows: LegacyHeldCall[] = [row()]) {
  H.on = true;
  H.i = 0;
  const tree = ExercisePanel({ rows, ticker: "NVDA", onDone }) as ReactNode;
  H.on = false;
  return { tree, html: tree === null ? "" : renderToStaticMarkup(tree as ReactElement) };
}
async function exercise(rows?: LegacyHeldCall[]) {
  (btns(render(rows).tree)[0]!.props.onClick as () => void)();
  await flush();
}

beforeEach(() => {
  H.slots = [];
  account();
  // Valorem Option: (underlyingAsset, underlyingAmount, exerciseAsset, exerciseAmount, exerciseTimestamp, expiryTimestamp, ...)
  chain = { option: { underlyingAmount: E18, exerciseAmount: 150_000_000n, exerciseTimestamp: 1_000n, expiryTimestamp: 2_000n },
    now: 1_500n, held: 2n, feesEnabled: true, feeBps: 5, usdg: 1_000_000_000n, allowance: 0n };
  client = {
    readContract: vi.fn(async (c: { address: string; functionName: string }) => {
      switch (c.functionName) {
        case "option": return chain.option;
        case "feesEnabled": return chain.feesEnabled;
        case "feeBps": return chain.feeBps;
        case "allowance": return chain.allowance;
        case "balanceOf": return c.address === CLEARINGHOUSE ? chain.held : chain.usdg;
        default: throw new Error(c.functionName);
      }
    }),
    getBlock: vi.fn(async () => ({ timestamp: chain.now })),
    simulateContract: vi.fn(async (c: Record<string, unknown>) => ({ request: { ...c, simulated: true } })),
  };
  vi.mocked(usePublicClient).mockReturnValue(client as never);
  write = vi.fn(async () => HASH);
  run = vi.fn(async (send: () => Promise<string>) => send());
  notice = vi.fn();
  onDone = vi.fn();
  vi.mocked(useWriteContract).mockReturnValue({ writeContractAsync: write } as never);
  vi.mocked(useTxRunner).mockReturnValue(run as never);
  vi.mocked(useNotice).mockReturnValue(notice as never);
});

describe("what the panel shows", () => {
  it("no held calls: nothing at all", () => {
    expect(render([]).tree).toBeNull();
  });

  it("one card per call with its balance; the label and the enabled state follow the window", () => {
    const { tree, html } = render([row({ optionId: 1n, balance: 3n, window: "open" }), row({ optionId: 2n, window: "before" }),
      row({ optionId: 3n, window: "expired" }), row({ optionId: 4n, window: "unknown" })]);
    expect(html).toContain("Yours to exercise");
    expect(html).toContain("3 NVDA call");
    expect(btns(tree).map((b) => [text(b.props.children), b.props.disabled])).toEqual([
      ["Exercise", false], ["Opens later", true], ["Expired", true], ["Exercise", true],
    ]);
  });

  it("no wallet, or the wrong chain: disabled, and a click reads nothing", async () => {
    account({ address: undefined });
    expect(btns(render().tree)[0]!.props.disabled).toBe(true);
    await exercise();
    account({ chainId: 1 });
    expect(btns(render().tree)[0]!.props.disabled).toBe(true);
    await exercise();
    vi.mocked(usePublicClient).mockReturnValue(undefined as never);
    account();
    await exercise();
    expect(client.readContract).not.toHaveBeenCalled();
  });
});

describe("the exercise", () => {
  it("allowance short: approve(clearinghouse, exactly strike x amount + fee), then exercise(id, amount); onDone", async () => {
    await exercise();
    // 2 x 150 USDG = 300 USDG; 5 bps fee = 0.15 USDG
    expect(client.simulateContract.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ account: ME, address: USDG, functionName: "approve", args: [CLEARINGHOUSE, 300_150_000n] }),
      expect.objectContaining({ account: ME, address: CLEARINGHOUSE, functionName: "exercise", args: [9n, 2n] }),
    ]);
    expect(write.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ functionName: "approve", simulated: true, chainId: CHAIN_ID }),
      expect.objectContaining({ functionName: "exercise", simulated: true, chainId: CHAIN_ID }),
    ]);
    expect(run.mock.calls.map((c) => c[1])).toEqual([
      { pending: "Approve v1 exercise cost", success: "USDG approved" },
      { pending: "Exercise v1 call", success: "V1 call exercised" },
    ]);
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: CLEARINGHOUSE, functionName: "balanceOf", args: [ME, 9n] }));
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: USDG, functionName: "allowance", args: [ME, CLEARINGHOUSE] }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(notice).not.toHaveBeenCalled();
  });

  it("fees off, allowance already covers it: no approve; the positional option tuple is read too", async () => {
    chain.feesEnabled = false;
    chain.allowance = 300_000_000n;
    chain.option = [ME, E18, USDG, 150_000_000n, 1_000n, 2_000n];
    await exercise();
    expect(client.simulateContract).toHaveBeenCalledTimes(1);
    expect(client.simulateContract.mock.calls[0]![0]).toMatchObject({ functionName: "exercise", args: [9n, 2n] });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("a fee that rounds to zero is charged as one base unit", async () => {
    chain.feeBps = 1;
    chain.option = { underlyingAmount: E18, exerciseAmount: 1n, exerciseTimestamp: 1_000n, expiryTimestamp: 2_000n };
    await exercise([row({ balance: 1n })]);
    expect(client.simulateContract.mock.calls[0]![0]).toMatchObject({ functionName: "approve", args: [CLEARINGHOUSE, 2n] });
  });

  it("USDG short of the total: the notice names the exact total and nothing is simulated", async () => {
    chain.usdg = 300_149_999n;
    await exercise();
    expect(notice).toHaveBeenCalledWith("error", "Exercise not sent", "You need 300.15 USDG to exercise.");
    expect(client.simulateContract).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  const refusals: Array<[string, () => void, string]> = [
    ["an unreadable option", () => { chain.option = null; }, "Could not read this call."],
    ["an incomplete option", () => { chain.option = { exerciseAmount: 1n }; }, "Could not read this call."],
    ["the window has closed on chain since the page read it", () => { chain.now = 2_000n; }, "This call is outside its exercise window."],
    ["the window has not opened yet on chain", () => { chain.now = 999n; }, "This call is outside its exercise window."],
    ["the held balance dropped below the amount", () => { chain.held = 1n; }, "Your call balance changed. Refresh the page."],
    ["an unread allowance", () => { chain.allowance = undefined; }, "Could not calculate the USDG approval."],
  ];
  for (const [what, set, message] of refusals) {
    it(`refuses on ${what}`, async () => {
      set();
      await exercise();
      expect(notice).toHaveBeenCalledWith("error", "Exercise not sent", message);
      expect(write).not.toHaveBeenCalled();
    });
  }

  it("a zero amount is refused even with a balance", async () => {
    await exercise([row({ balance: 0n })]);
    expect(notice).toHaveBeenCalledWith("error", "Exercise not sent", "Your call balance changed. Refresh the page.");
  });

  it("a rejected approve stops before the exercise; a rejected exercise skips onDone", async () => {
    run.mockResolvedValueOnce(null);
    await exercise();
    expect(client.simulateContract).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
    chain.allowance = 10n ** 12n;
    run.mockResolvedValueOnce(null);
    await exercise();
    expect(client.simulateContract.mock.calls[1]![0]).toMatchObject({ functionName: "exercise" });
    expect(onDone).not.toHaveBeenCalled();
  });

  it("a simulation revert becomes the notice; a non-Error throw gets the generic line", async () => {
    client.simulateContract.mockRejectedValueOnce(new Error("execution reverted: ExpiredOption"));
    await exercise();
    expect(notice).toHaveBeenLastCalledWith("error", "Exercise not sent", "execution reverted: ExpiredOption");
    client.getBlock.mockRejectedValueOnce("rpc down");
    await exercise();
    expect(notice).toHaveBeenLastCalledWith("error", "Exercise not sent", "Could not verify this call.");
  });

  it("busy while in flight: the buttons disable and a second click reads nothing; busy clears after", async () => {
    let release!: (v: unknown) => void;
    client.readContract.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    (btns(render().tree)[0]!.props.onClick as () => void)();
    const during = render().tree;
    expect(btns(during)[0]!.props.disabled).toBe(true);
    (btns(during)[0]!.props.onClick as () => void)();
    expect(client.readContract).toHaveBeenCalledTimes(1);
    release(null);
    await flush();
    expect(btns(render().tree)[0]!.props.disabled).toBe(false);
  });
});
