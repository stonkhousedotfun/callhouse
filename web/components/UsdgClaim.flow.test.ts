/**
 * UsdgClaim's claim action and its figures: claimUsdg() with no args pinned to chain 4663, busy while it runs, onDone
 * only on a hash, refused on the wrong network or when disconnected; the per-share index divided by 1e9 into USDG
 * base units. The copy is covered by VaultCopyReview.test.tsx. useState is a slot stand-in while the component
 * function is called directly (no DOM renderer in this package).
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useAccount, useWriteContract } from "wagmi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CHAIN_ID } from "@/lib/chain";
import type { AccountPosition, VaultSnapshot } from "@/lib/hooks";
import { useTxRunner } from "./TxToast";
import { UsdgClaim } from "./UsdgClaim";

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
const clickable = (tree: ReactNode) => all(tree, (e) => typeof e.props.onClick === "function")[0];

let run: ReturnType<typeof vi.fn>;
let write: ReturnType<typeof vi.fn>;
let onDone: ReturnType<typeof vi.fn>;
function account(over: Record<string, unknown> = {}) {
  vi.mocked(useAccount).mockReturnValue({ address: ME, isConnected: true, chainId: CHAIN_ID, ...over } as never);
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

function render(snapshot: Partial<VaultSnapshot>, position: Partial<AccountPosition>) {
  H.on = true;
  H.i = 0;
  const tree = UsdgClaim({ snapshot: { ready: true, ...snapshot } as VaultSnapshot, position: { ready: true, ...position }, onDone }) as ReactNode;
  H.on = false;
  return { tree, html: renderToStaticMarkup(tree as ReactElement) };
}

describe("UsdgClaim", () => {
  it("claimable: a primary 'Claim 12.34 USDG' that sends claimUsdg() on 4663 and calls onDone", async () => {
    const { tree } = render({}, { claimableUsdg: 12_340_000n });
    const btn = clickable(tree)!;
    expect(text(btn.props.children)).toBe("Claim 12.34 USDG");
    expect(btn.props).toMatchObject({ variant: "primary", disabled: false });
    const pending = (btn.props.onClick as () => Promise<void>)();
    expect(text(clickable(render({}, { claimableUsdg: 12_340_000n }).tree)!.props.children)).toBe("Working…");
    expect(clickable(render({}, { claimableUsdg: 12_340_000n }).tree)!.props.disabled).toBe(true);
    await pending;
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      address: "0x00000000000000000000000000000000000000aa", functionName: "claimUsdg", args: [], chainId: CHAIN_ID,
    }));
    expect(run.mock.calls[0]![1]).toEqual({ pending: "Claiming USDG", success: "USDG claimed" });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(text(clickable(render({}, { claimableUsdg: 12_340_000n }).tree)!.props.children), "busy cleared").toBe("Claim 12.34 USDG");
  });

  it("a failed or rejected claim (null) does not call onDone, and busy still clears", async () => {
    run.mockResolvedValue(null);
    await (clickable(render({}, { claimableUsdg: 1n }).tree)!.props.onClick as () => Promise<void>)();
    expect(onDone).not.toHaveBeenCalled();
    expect(clickable(render({}, { claimableUsdg: 1n }).tree)!.props.disabled).toBe(false);
  });

  it("nothing claimable (or unread): a disabled ghost 'Nothing to claim'", () => {
    for (const position of [{ claimableUsdg: 0n }, {}]) {
      const btn = clickable(render({}, position).tree)!;
      expect(text(btn.props.children)).toBe("Nothing to claim");
      expect(btn.props).toMatchObject({ variant: "ghost", disabled: true });
    }
  });

  it("wrong network: no claim button at all, a switch hint instead", () => {
    account({ chainId: 1 });
    const wrong = render({}, { claimableUsdg: 5n });
    expect(clickable(wrong.tree)).toBeUndefined();
    expect(wrong.html).toContain("Switch to Robinhood Chain to claim.");
    expect(wrong.html).not.toContain("Claim 0");
  });

  it("disconnected: the connect button instead of a claim", () => {
    account({ address: undefined, isConnected: false, chainId: undefined });
    expect(render({}, { claimableUsdg: 5n }).html).toContain("Connect wallet");
  });

  it("per-share figure: accUsdgPerShare / 1e9 in USDG base units, 6 decimals; '—' when unread", () => {
    // 1.234567 USDG per share = 1_234_567 base units = index 1_234_567e9.
    expect(render({ accUsdgPerShare: 1_234_567n * 1_000_000_000n + 999_999_999n, totalUsdgDistributed: 0n }, {}).html)
      .toMatch(/per (<!-- -->)?cNVDA<\/dt><dd[^>]*>1\.234567/);
    expect(render({}, {}).html).toMatch(/per (<!-- -->)?cNVDA<\/dt><dd[^>]*>—</);
  });
});
