/**
 * TxToast: describeError's revert-naming ladder, the toast host's markup per tone, the provider's state updaters, and
 * the transaction runner's stage-by-stage toasts. There is no DOM renderer here, so React's hooks are wrapped: by
 * default they are the real ones (SSR renders go through them), and a test can swap in a context value or capture a
 * state setter to drive the provider's updaters and the runner directly.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BaseError, ContractFunctionRevertedError, encodeErrorResult, parseAbi, UserRejectedRequestError, type Hex,
} from "viem";
import { useConfig } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as React from "react";
import { txUrl } from "@/lib/chain";
import { V2ReceiptUnknownError } from "@/lib/v2/txStatus";
import { describeError, ToastProvider, useNotice, useTxRunner, useV2ReceiptNotice, type Toast } from "./TxToast";

const captured = vi.hoisted(() => ({ ctx: undefined as unknown }));
vi.mock("react", async (orig) => {
  const real = await orig<typeof import("react")>();
  return {
    ...real,
    useState: vi.fn(real.useState),
    useCallback: vi.fn(real.useCallback),
    useContext: vi.fn((c: Parameters<typeof real.useContext>[0]) => {
      const value = real.useContext(c);
      captured.ctx = value;
      return value;
    }),
  };
});
vi.mock("wagmi", () => ({ useConfig: vi.fn(() => ({ id: "cfg" })) }));
vi.mock("wagmi/actions", () => ({ waitForTransactionReceipt: vi.fn() }));

const HASH = `0x${"ab".repeat(32)}` as Hex;
type Ctx = { toasts: Toast[]; push: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; dismiss: ReturnType<typeof vi.fn> };

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(React.useState).mockReset(); // vitest 3: back to the real-hook wrapper
});

describe("describeError", () => {
  const abi = parseAbi(["error Other(uint256 x)"]);

  it("a wallet rejection anywhere in the cause chain reads 'Rejected in wallet.'", () => {
    const err = new BaseError("outer", { cause: new UserRejectedRequestError(new Error("user said no")) });
    expect(describeError(err)).toBe("Rejected in wallet.");
  });

  it("a revert viem decoded by name is explained by lib/revert (known name, and unknown name with args)", () => {
    const vaultAbi = parseAbi(["error UseQueue()", "error Mystery(uint256 a, bool b)"]);
    const known = new ContractFunctionRevertedError({ abi: vaultAbi, functionName: "f",
      data: encodeErrorResult({ abi: vaultAbi, errorName: "UseQueue" }) });
    expect(describeError(new BaseError("x", { cause: known }))).toBe("A call is open, so this redemption has to go through the queue.");
    const unknown = new ContractFunctionRevertedError({ abi: vaultAbi, functionName: "f",
      data: encodeErrorResult({ abi: vaultAbi, errorName: "Mystery", args: [7n, true] }) });
    expect(describeError(unknown)).toBe("Reverted: Mystery (7, true)");
  });

  it("a revert NOT in the call's ABI is re-decoded from raw data against the vault ABI", () => {
    const data = encodeErrorResult({ abi: parseAbi(["error UseQueue()"]), errorName: "UseQueue" });
    const err = new ContractFunctionRevertedError({ abi, functionName: "f", data });
    expect(err.data).toBeUndefined();
    expect(describeError(err)).toBe("A call is open, so this redemption has to go through the queue.");
  });

  it("an unrecognised selector falls back to viem's short message, never the bare hex", () => {
    const err = new ContractFunctionRevertedError({ abi, functionName: "f", data: "0xdeadbeef" });
    const text = describeError(err);
    expect(text).toBe(err.shortMessage);
    expect(text).not.toContain("0xdeadbeef00");
  });

  it("other viem errors use shortMessage; plain errors their message; anything else is stringified", () => {
    expect(describeError(new BaseError("Short one"))).toBe("Short one");
    expect(describeError(new Error("plain"))).toBe("plain");
    expect(describeError("text")).toBe("text");
    expect(describeError(42)).toBe("42");
  });
});

describe("ToastHost", () => {
  const toasts: Toast[] = [
    { id: 1, tone: "pending", title: "Depositing", body: "Confirm in your wallet." },
    { id: 2, tone: "success", title: "Deposited", hash: HASH },
    { id: 3, tone: "error", title: "Failed", body: "Rejected in wallet." },
    { id: 4, tone: "unknown", title: "Status unknown", actions: [{ label: "Open portfolio", href: "/portfolio" }, { label: "Docs", href: "/docs" }] },
  ];

  function renderWith(list: Toast[]) {
    vi.mocked(React.useState).mockImplementationOnce(() => [list, vi.fn()]);
    return renderToStaticMarkup(createElement(ToastProvider, null, createElement("main", null, "page")));
  }

  it("no toasts: only the children, no live region", () => {
    const html = renderWith([]);
    expect(html).toBe("<main>page</main>");
  });

  it("each tone gets its stripe; pending spins; body, actions and the explorer link render when present", () => {
    const html = renderWith(toasts);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    for (const [tone, stripe] of [["pending", "bg-usdg"], ["success", "bg-accent"], ["error", "bg-danger"], ["unknown", "bg-warn"]]) {
      expect(html).toMatch(new RegExp(`data-tone="${tone}"[^>]*><span aria-hidden="true" class="absolute inset-y-0 left-0 w-1 ${stripe}"`));
    }
    expect(html.match(/animate-spin/g)).toHaveLength(1);
    expect(html.match(/aria-label="Dismiss"/g)).toHaveLength(4);
    expect(html).toContain("Rejected in wallet.");
    expect(html).toContain('href="/portfolio"');
    expect(html).toContain(">Open portfolio</a>");
    expect(html).toContain(`href="${txUrl(HASH)}"`);
    expect(html).toContain(`${HASH.slice(0, 10)}…${HASH.slice(-8)}`);
    expect(html.match(/target="_blank"/g), "only the hash leaves the app").toHaveLength(1);
  });
});

describe("ToastProvider state", () => {
  it("push appends with increasing ids; update patches one; dismiss removes one", () => {
    const set = vi.fn();
    vi.mocked(React.useState).mockImplementationOnce(() => [[{ id: 9, tone: "pending", title: "x" }], set]);
    renderToStaticMarkup(createElement(ToastProvider, null, null));
    const ctx = captured.ctx as Ctx;
    expect(ctx.toasts).toHaveLength(1);

    expect(ctx.push({ tone: "pending", title: "A" })).toBe(1);
    expect(ctx.push({ tone: "error", title: "B" })).toBe(2);
    const apply = (n: number, state: Toast[]) => (set.mock.calls[n]![0] as (s: Toast[]) => Toast[])(state);
    const afterA = apply(0, []);
    expect(afterA).toEqual([{ tone: "pending", title: "A", id: 1 }]);
    const afterB = apply(1, afterA);
    expect(afterB.map((t) => t.id)).toEqual([1, 2]);

    ctx.update(2, { tone: "success", title: "Done" });
    const updated = apply(2, afterB);
    expect(updated[1]).toEqual({ id: 2, tone: "success", title: "Done" });
    expect(updated[0]).toBe(afterB[0]);

    ctx.dismiss(1);
    expect(apply(3, updated).map((t) => t.id)).toEqual([2]);
  });

  it("a hook used outside the provider throws a clear error", () => {
    vi.mocked(React.useContext).mockReturnValueOnce(null);
    expect(() => useNotice()).toThrow("ToastProvider is missing above this component");
  });
});

describe("hooks against a fake context", () => {
  let ctx: Ctx;
  beforeEach(() => {
    let id = 0;
    ctx = { toasts: [], push: vi.fn(() => ++id), update: vi.fn(), dismiss: vi.fn() };
    vi.mocked(React.useContext).mockImplementation(() => ctx);
    vi.mocked(React.useCallback).mockImplementation(((fn: unknown) => fn) as never);
    vi.mocked(waitForTransactionReceipt).mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.mocked(React.useContext).mockReset();
    vi.mocked(React.useCallback).mockReset();
  });

  const labels = { pending: "Depositing", success: "Deposited" };

  it("success: pending -> waiting with hash -> success, auto-dismissed after 9s, returns the hash", async () => {
    vi.mocked(waitForTransactionReceipt).mockResolvedValue({ status: "success" } as never);
    const run = useTxRunner();
    await expect(run(async () => HASH, labels)).resolves.toBe(HASH);
    expect(ctx.push).toHaveBeenCalledWith({ tone: "pending", title: "Depositing", body: "Confirm in your wallet." });
    expect(ctx.update).toHaveBeenNthCalledWith(1, 1, { body: "Waiting for the chain…", hash: HASH });
    expect(ctx.update).toHaveBeenNthCalledWith(2, 1, { tone: "success", title: "Deposited", body: undefined, hash: HASH });
    expect(vi.mocked(waitForTransactionReceipt)).toHaveBeenCalledWith({ id: "cfg" }, { hash: HASH });
    expect(vi.mocked(useConfig)).toHaveBeenCalled();
    vi.advanceTimersByTime(8999);
    expect(ctx.dismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ctx.dismiss).toHaveBeenCalledWith(1);
  });

  it("reverted: an error toast that keeps the hash, returns null, never auto-dismisses", async () => {
    vi.mocked(waitForTransactionReceipt).mockResolvedValue({ status: "reverted" } as never);
    await expect(useTxRunner()(async () => HASH, labels)).resolves.toBeNull();
    expect(ctx.update).toHaveBeenLastCalledWith(1, { tone: "error", title: "Transaction failed", body: undefined, hash: HASH });
    vi.runAllTimers();
    expect(ctx.dismiss).not.toHaveBeenCalled();
  });

  it("receipt unavailable after submission: 'status unknown', not a failure", async () => {
    vi.mocked(waitForTransactionReceipt).mockRejectedValue(new Error("RPC timeout"));
    await expect(useTxRunner()(async () => HASH, labels)).resolves.toBeNull();
    expect(ctx.update).toHaveBeenLastCalledWith(1, expect.objectContaining({ tone: "unknown", hash: HASH,
      title: "Transaction submitted; status unknown" }));
  });

  it("the wallet send fails: a 'Failed' toast with the described error, no hash, no receipt wait", async () => {
    await expect(useTxRunner()(async () => { throw new BaseError("x", { cause: new UserRejectedRequestError(new Error("no")) }); }, labels))
      .resolves.toBeNull();
    expect(ctx.update).toHaveBeenCalledTimes(1);
    expect(ctx.update).toHaveBeenCalledWith(1, { tone: "error", title: "Failed", body: "Rejected in wallet." });
    expect(waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it("useNotice pushes and dismisses after 5s", () => {
    const notice = useNotice();
    notice("success", "Copied", "Link copied.", [{ label: "Open", href: "/x" }]);
    expect(ctx.push).toHaveBeenCalledWith({ tone: "success", title: "Copied", body: "Link copied.", actions: [{ label: "Open", href: "/x" }] });
    vi.advanceTimersByTime(4999);
    expect(ctx.dismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ctx.dismiss).toHaveBeenCalledWith(1);
  });

  it("useV2ReceiptNotice pushes a sticky toast only for an unknown receipt", () => {
    const notify = useV2ReceiptNotice();
    expect(notify(new Error("reverted"))).toBe(false);
    expect(ctx.push).not.toHaveBeenCalled();
    expect(notify(new V2ReceiptUnknownError(HASH, "close", new Error("RPC timeout")))).toBe(true);
    expect(ctx.push).toHaveBeenCalledWith(expect.objectContaining({ tone: "unknown", hash: HASH }));
    vi.runAllTimers();
    expect(ctx.dismiss).not.toHaveBeenCalled();
  });
});
