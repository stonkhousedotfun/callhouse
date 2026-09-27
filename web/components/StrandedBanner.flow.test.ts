/**
 * StrandedBanner's arithmetic and its retry: the account's queued share of the claim (staged WAD plus the queued
 * epoch's WAD prorated by queued/remaining shares, the contract's own sum), the held share (live WAD x shares /
 * supply), the stranded test (isStranded, or Idle with a claim key), compact mode, and retryStrandedClaim() pinned to
 * 4663 with onDone only on a hash. Copy is covered by VaultCopyReview.test.tsx.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useAccount, useWriteContract } from "wagmi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CHAIN_ID } from "@/lib/chain";
import type { AccountPosition, VaultSnapshot } from "@/lib/hooks";
import { useTxRunner } from "./TxToast";
import { StrandedBanner } from "./StrandedBanner";

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

function render(snapshot: Partial<VaultSnapshot>, position?: Partial<AccountPosition>, extra: { compact?: boolean; noDone?: boolean } = {}) {
  H.on = true;
  H.i = 0;
  const tree = StrandedBanner({
    snapshot: { ready: true, ...snapshot } as VaultSnapshot, position: position ? { ready: true, ...position } : undefined,
    onDone: extra.noDone ? undefined : onDone, compact: extra.compact, className: "cls",
  }) as ReactNode;
  H.on = false;
  return { tree, html: tree ? renderToStaticMarkup(tree as ReactElement) : "" };
}
/** The value cell of the row whose label starts with `label`. */
function row(html: string, label: string): string {
  const at = html.indexOf(label);
  const dd = html.slice(at).match(/<dd[^>]*>([\s\S]*?)<\/dd>/)![1]!;
  return dd.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
const stranded = { isStranded: true, phase: 0, strandedRemainingWad: (6n * E18) / 10n, totalSupply: 10n * E18, epochId: 9n };

describe("when the banner shows", () => {
  it("isStranded, or Idle with a non-zero claim key (the chain has not answered isStranded yet)", () => {
    expect(render({ isStranded: true }).tree).not.toBeNull();
    expect(render({ phase: 0, claimKey: 5n }).tree).not.toBeNull();
    expect(render({ phase: 1, claimKey: 5n }).tree, "a live week holds a claim key normally").toBeNull();
    expect(render({ phase: 0 }).tree).toBeNull();
  });

  it("no cycle number: the title omits it; compact: no rows and no retry", () => {
    const { html } = render({ isStranded: true }, undefined, { compact: true });
    expect(html).toMatch(/A claim is stranded(<!-- -->)?: the week closed/);
    expect(html).not.toContain("Retry claim");
    expect(html).not.toContain("Claim owed to current holders");
  });
});

describe("the account's share", () => {
  it("staged only: the queued share is owedStrandWad", () => {
    expect(row(render(stranded, { owedStrandWad: E18 / 4n }).html, "Your share, queued")).toBe("25%");
  });

  it("a settled queued epoch adds its WAD prorated by queued / remaining shares", () => {
    const html = render(stranded, {
      owedStrandWad: E18 / 10n, queuedShares: 2n * E18, queuedEpoch: 8n, epochStrandWad: E18 / 2n, epochSharesRemaining: 8n * E18,
    }).html;
    // 10% + 50% x 2/8 = 22.5%
    expect(row(html, "Your share, queued")).toBe("22.5%");
  });

  it("the whole remaining epoch (or an unread remainder) takes the epoch's full WAD, not a division by zero", () => {
    const base = { queuedShares: 2n * E18, queuedEpoch: 8n, epochStrandWad: E18 / 5n };
    expect(row(render(stranded, { ...base, epochSharesRemaining: 2n * E18 }).html, "Your share, queued")).toBe("20%");
    expect(row(render(stranded, { ...base, epochSharesRemaining: 0n }).html, "Your share, queued")).toBe("20%");
    expect(row(render(stranded, base).html, "Your share, queued")).toBe("20%");
  });

  it("an entry still in the current epoch (not settled) adds nothing", () => {
    const html = render(stranded, { queuedShares: E18, queuedEpoch: 9n, epochStrandWad: E18 / 2n, epochSharesRemaining: 2n * E18 }).html;
    expect(row(html, "Your share, queued")).toBe("0%");
  });

  it("held share: live WAD x shares / supply; claim split between holders and settled withdrawals", () => {
    const html = render(stranded, { shares: 5n * E18 }).html;
    expect(row(html, "Your share, held")).toBe("30%");
    expect(row(html, "Claim owed to current holders")).toBe("60%");
    expect(row(html, "Claim owed to settled withdrawals")).toBe("40%");
  });

  it("zero or unread supply, or an unread live WAD: '—' instead of a divided-by-zero share", () => {
    expect(row(render({ ...stranded, totalSupply: 0n }, { shares: E18 }).html, "Your share, held")).toBe("—");
    const unread = render({ isStranded: true, totalSupply: 10n * E18 }, { shares: E18 }).html;
    expect(row(unread, "Your share, held")).toBe("—");
    expect(row(unread, "Claim owed to current holders")).toBe("—");
    expect(row(unread, "Claim owed to settled withdrawals")).toBe("—");
    expect(row(unread, "Stranded claim")).toBe("#—");
  });

  it("no wallet, or a position not read yet: no per-account rows", () => {
    account({ address: undefined, isConnected: false, chainId: undefined });
    expect(render(stranded, { shares: E18 }).html).not.toContain("Your share");
    account();
    H.on = true; H.i = 0;
    const el = StrandedBanner({ snapshot: { ready: true, ...stranded } as VaultSnapshot, position: { ready: false } }) as ReactElement;
    H.on = false;
    expect(renderToStaticMarkup(el)).not.toContain("Your share");
  });
});

describe("retry", () => {
  const retry = (tree: ReactNode) => clickable(tree)!;

  it("sends retryStrandedClaim() on 4663, busy meanwhile, onDone on a hash", async () => {
    const pending = (retry(render(stranded).tree).props.onClick as () => Promise<void>)();
    const busy = retry(render(stranded).tree);
    expect(text(busy.props.children)).toBe("Working…");
    expect(busy.props.disabled).toBe(true);
    await pending;
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ functionName: "retryStrandedClaim", args: [], chainId: CHAIN_ID }));
    expect(run.mock.calls[0]![1]).toEqual({ pending: "Retrying the stranded claim", success: "Claim redeemed: the week's collateral and strike USDG are back" });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(text(retry(render(stranded).tree).props.children)).toBe("Retry claim");
  });

  it("no hash: no onDone; no onDone prop at all is fine", async () => {
    run.mockResolvedValueOnce(null);
    await (retry(render(stranded).tree).props.onClick as () => Promise<void>)();
    expect(onDone).not.toHaveBeenCalled();
    await (retry(render(stranded, undefined, { noDone: true }).tree).props.onClick as () => Promise<void>)();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("wrong network: disabled with a hint, and the action refuses to send", async () => {
    account({ chainId: 1 });
    const { tree, html } = render(stranded);
    expect(retry(tree).props.disabled).toBe(true);
    expect(html).toContain("Switch to Robinhood Chain to retry.");
    await (retry(tree).props.onClick as () => Promise<void>)();
    expect(run).not.toHaveBeenCalled();
  });

  it("disconnected: disabled (anyone can send it, but someone has to be connected)", () => {
    account({ address: undefined, isConnected: false, chainId: undefined });
    expect(retry(render(stranded).tree).props.disabled).toBe(true);
  });
});
