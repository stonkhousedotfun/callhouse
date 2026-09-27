/**
 * ConnectButton's client-side flows, which a server render cannot reach: opening the picker, probing connectors,
 * connecting (success, failure, a stale answer after Cancel), the account menu (copy, explorer, disconnect, outside
 * click and Escape), and switching network (switch, add-then-switch, declined, other failure).
 *
 * There is no DOM renderer in this package (node environment by design), so React's hooks are swapped for a tiny
 * slot-based stand-in while a test "renders" by calling ConnectButton as a function. Child components are not
 * rendered; their props (the handlers) are read from the returned element tree and called.
 */
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useAccount, useConnect, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useNotice } from "@/components/TxToast";
import { addressUrl, CHAIN_ID } from "@/lib/chain";
import { useMounted } from "@/lib/hooks";
import { readRecent, rememberRecent, type WalletEntry } from "@/lib/wallets";
import { ConnectButton, WalletMenu, WrongNetworkBanner } from "./ConnectButton";
import { WalletDialog, WalletPicker, type PickerView } from "./WalletModal";

const H = vi.hoisted(() => ({ slots: [] as unknown[], i: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (orig) => {
  const real = await orig<typeof import("react")>();
  const slot = (init: () => unknown) => {
    const k = H.i++;
    if (!(k in H.slots)) H.slots[k] = init();
    return k;
  };
  return {
    ...real,
    useState: (init: unknown) => {
      const k = slot(() => (typeof init === "function" ? (init as () => unknown)() : init));
      return [H.slots[k], (v: unknown) => { H.slots[k] = typeof v === "function" ? (v as (p: unknown) => unknown)(H.slots[k]) : v; }];
    },
    useRef: (init: unknown) => H.slots[slot(() => ({ current: init }))],
    useEffect: (fn: () => void | (() => void)) => { H.effects.push(fn); },
    useMemo: (f: () => unknown) => f(),
    useCallback: (f: unknown) => f,
    useId: () => ":r0:",
  };
});
vi.mock("wagmi", () => ({
  useAccount: vi.fn(), useConnect: vi.fn(), useConnectors: vi.fn(), useDisconnect: vi.fn(), useSwitchChain: vi.fn(),
}));
vi.mock("@/lib/hooks", () => ({ useMounted: vi.fn() }));
vi.mock("@/components/TxToast", () => ({ useNotice: vi.fn(), describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)) }));
vi.mock("@/lib/wallets", async (orig) => ({
  ...(await orig<typeof import("@/lib/wallets")>()),
  readRecent: vi.fn(() => []),
  rememberRecent: vi.fn((k: string) => [k]),
}));

type Props = Record<string, unknown> & { children?: ReactNode };
type El = ReactElement<Props>;
const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678" as const;

function all(node: ReactNode, pred: (e: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) { for (const n of node) all(n as ReactNode, pred, out); return out; }
  if (!isValidElement(node)) return out;
  const el = node as El;
  if (pred(el)) out.push(el);
  all(el.props.children, pred, out);
  return out;
}
const text = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(text).join("") : isValidElement(node) ? text((node as El).props.children) :
    node === null || node === undefined || typeof node === "boolean" ? "" : String(node);
const byType = (tree: ReactNode, type: unknown) => all(tree, (e) => e.type === type);
const byText = (tree: ReactNode, t: string) => all(tree, (e) => typeof e.props.onClick === "function" && text(e.props.children).includes(t))[0];

/** One commit: React re-runs a component that set state while rendering, so render until nothing changes. */
function render(props: { block?: boolean } = {}): ReactNode {
  let tree: ReactNode;
  let before: string;
  do {
    before = JSON.stringify(H.slots, (_k, v) => (typeof v === "function" ? "fn" : v));
    H.i = 0;
    H.effects = [];
    tree = ConnectButton(props) as ReactNode;
  } while (JSON.stringify(H.slots, (_k, v) => (typeof v === "function" ? "fn" : v)) !== before);
  return tree;
}
function account(over: Record<string, unknown> = {}) {
  vi.mocked(useAccount).mockReturnValue({ address: undefined, isConnected: false, chainId: undefined, connector: undefined, ...over } as never);
}
const connectors = [
  { uid: "u1", id: "io.rabby", name: "Rabby Wallet", type: "injected", rdns: "io.rabby", getProvider: vi.fn(async () => ({})) },
  { uid: "u2", id: "metaMaskSDK", name: "MetaMask", type: "metaMask", rdns: ["io.metamask"], getProvider: vi.fn(async () => { throw new Error("no sdk"); }) },
  { uid: "u3", id: "phantom", name: "Phantom", type: "injected", getProvider: vi.fn(() => new Promise(() => {})) },
];

let connect: ReturnType<typeof vi.fn>;
let disconnect: ReturnType<typeof vi.fn>;
let switchChain: ReturnType<typeof vi.fn>;
let notice: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  H.slots = [];
  vi.mocked(useMounted).mockReturnValue(true);
  account();
  connect = vi.fn();
  disconnect = vi.fn();
  switchChain = vi.fn();
  notice = vi.fn();
  vi.mocked(useConnectors).mockReturnValue(connectors as never);
  vi.mocked(useConnect).mockReturnValue({ mutateAsync: connect } as never);
  vi.mocked(useDisconnect).mockReturnValue({ mutate: disconnect } as never);
  vi.mocked(useSwitchChain).mockReturnValue({ mutateAsync: switchChain, isPending: false } as never);
  vi.mocked(useNotice).mockReturnValue(notice as never);
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64)", clipboard: { writeText: vi.fn(async () => {}) } });
  vi.stubGlobal("window", { location: { href: "https://app.example/nvda?x=1" } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function openPicker(): ReactNode {
  const first = render();
  (byText(first, "Connect")!.props.onClick as () => void)();
  return render();
}
const picker = (tree: ReactNode) => byType(tree, WalletPicker)[0]!.props as unknown as Parameters<typeof WalletPicker>[0];
const dialog = (tree: ReactNode) => byType(tree, WalletDialog)[0]!.props as unknown as Parameters<typeof WalletDialog>[0];

describe("the picker", () => {
  it("is closed until Connect is clicked; opening reads the recent wallets and starts in the list view", () => {
    vi.mocked(readRecent).mockReturnValueOnce(["io.rabby"]);
    const closed = render();
    expect(dialog(closed).open).toBe(false);
    expect(picker(closed).detecting).toBe(false);
    const open = openPicker();
    expect(dialog(open).open).toBe(true);
    expect(dialog(open).labelledBy).toBe(":r0:");
    expect(picker(open).view).toEqual({ kind: "list" });
    expect(picker(open).detecting, "opening starts a probe").toBe(true);
    expect(picker(open).entries.find((e) => e.key === "io.rabby")?.recent).toBe(true);
    expect(picker(open).mobile).toBe(false);
    expect(picker(open).deepLinks).toBeUndefined();
  });

  it("probes each connector: a provider is installed, a throwing one is not, a silent one times out after 1.5s", async () => {
    vi.useFakeTimers();
    openPicker();
    const probe = H.effects[0]!;
    probe();
    await vi.advanceTimersByTimeAsync(1500);
    const tree = render();
    const p = picker(tree);
    expect(p.detecting).toBe(false);
    const installed = Object.fromEntries(p.entries.map((e) => [e.name, e.installed]));
    expect(installed).toMatchObject({ "Rabby Wallet": true, MetaMask: false, Phantom: false });
  });

  it("a probe that answers after the picker closed is ignored", async () => {
    vi.useFakeTimers();
    openPicker();
    const cleanup = H.effects[0]!() as () => void;
    cleanup();
    await vi.advanceTimersByTimeAsync(1500);
    expect(picker(render()).detecting, "still marked detecting: the stale answer was dropped").toBe(true);
  });

  it("the probe effect does nothing while the picker is closed", () => {
    render();
    expect(H.effects[0]!()).toBeUndefined();
    expect(connectors[0]!.getProvider).not.toHaveBeenCalled();
  });

  it("a phone gets deep links for this page", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)" });
    const p = picker(openPicker());
    expect(p.mobile).toBe(true);
    expect(p.deepLinks?.metamask).toBe("https://metamask.app.link/dapp/app.example/nvda?x=1");
  });

  it("connect success: connecting view, remembered as recent, picker closed; on chain 4663", async () => {
    let resolve!: () => void;
    connect.mockReturnValue(new Promise<void>((r) => { resolve = r; }));
    const entry = picker(openPicker()).entries[0]! as WalletEntry;
    picker(render()).onSelect(entry);
    const connecting = render();
    expect(picker(connecting).view).toEqual({ kind: "connecting", entry });
    expect(byText(connecting, "Connecting…"), "the opener says it is connecting").toBeDefined();
    expect(connect).toHaveBeenCalledWith({ connector: entry.connector, chainId: CHAIN_ID });
    resolve();
    await Promise.resolve(); await Promise.resolve();
    expect(rememberRecent).toHaveBeenCalledWith(entry.key);
    expect(dialog(render()).open).toBe(false);
  });

  it("connect failure: the error view classifies the failure and keeps the detail", async () => {
    connect.mockRejectedValue(Object.assign(new Error("User rejected."), { code: 4001 }));
    const entry = picker(openPicker()).entries[0]! as WalletEntry;
    picker(render()).onSelect(entry);
    await vi.waitFor(() => expect((picker(render()).view as PickerView).kind).toBe("error"));
    expect(picker(render()).view).toEqual({ kind: "error", entry, failure: "rejected", detail: "User rejected." });
    expect(rememberRecent).not.toHaveBeenCalled();
    picker(render()).onBack();
    expect(picker(render()).view).toEqual({ kind: "list" });
  });

  it("Cancel while connecting: a late success or failure is ignored and the picker stays as the user left it", async () => {
    let settle!: (ok: boolean) => void;
    connect.mockImplementation(() => new Promise<void>((res, rej) => { settle = (ok) => (ok ? res() : rej(new Error("late"))); }));
    const entry = picker(openPicker()).entries[0]! as WalletEntry;
    picker(render()).onSelect(entry);
    picker(render()).onCancel();
    expect(picker(render()).view).toEqual({ kind: "list" });
    settle(true);
    await Promise.resolve(); await Promise.resolve();
    expect(rememberRecent).not.toHaveBeenCalled();
    expect(dialog(render()).open, "a cancelled attempt does not close the picker").toBe(true);

    picker(render()).onSelect(entry);
    dialog(render()).onClose();
    settle(false);
    await Promise.resolve(); await Promise.resolve();
    expect(picker(render()).view.kind, "a late failure after closing does not show an error").toBe("connecting");
    expect(dialog(render()).open).toBe(false);
  });

  it("the account connecting from elsewhere closes the open picker", () => {
    openPicker();
    account({ address: ADDRESS, isConnected: true, chainId: CHAIN_ID });
    render();
    account();
    expect(dialog(render()).open).toBe(false);
  });
});

describe("the connected account menu", () => {
  beforeEach(() => account({ address: ADDRESS, isConnected: true, chainId: CHAIN_ID, connector: { id: "io.rabby", name: "Rabby Wallet", type: "injected", uid: "u1" } }));

  const menu = (tree: ReactNode) => byType(tree, WalletMenu)[0]?.props as unknown as Parameters<typeof WalletMenu>[0] | undefined;
  function openMenu(): ReactNode {
    (byText(render(), "0x1234")!.props.onClick as () => void)();
    return render();
  }

  it("toggles open with the address and the connector name, and closes again", () => {
    expect(menu(render())).toBeUndefined();
    const open = openMenu();
    expect(menu(open)).toMatchObject({ address: ADDRESS, via: "Rabby Wallet" });
    (byText(open, "0x1234")!.props.onClick as () => void)();
    expect(menu(render())).toBeUndefined();
  });

  it("copy: success notice; a blocked clipboard: an error notice; the menu closes either way", async () => {
    await menu(openMenu())!.onCopy();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(ADDRESS);
    expect(notice).toHaveBeenLastCalledWith("success", "Address copied");
    expect(menu(render())).toBeUndefined();
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("denied"));
    await menu(openMenu())!.onCopy();
    expect(notice).toHaveBeenLastCalledWith("error", "Could not copy", "Your browser blocked the clipboard.");
  });

  it("explorer closes the menu; disconnect disconnects and closes", () => {
    menu(openMenu())!.onExplorer();
    expect(menu(render())).toBeUndefined();
    menu(openMenu())!.onDisconnect();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(menu(render())).toBeUndefined();
  });

  it("while open, an outside click or Escape closes it; an inside click and other keys do not; cleanup unlistens", () => {
    const listeners: Record<string, (e: unknown) => void> = {};
    const removed: string[] = [];
    vi.stubGlobal("document", {
      addEventListener: (t: string, f: (e: unknown) => void) => { listeners[t] = f; },
      removeEventListener: (t: string) => { removed.push(t); },
    });
    const wrap = byType(render(), "div")[0]!;
    expect(H.effects[1]!(), "no listeners while the menu is closed").toBeUndefined();
    const tree = openMenu();
    const inside = {};
    (byType(tree, "div")[0]!.props as unknown as { ref: { current: unknown } }).ref.current = { contains: (n: unknown) => n === inside };
    expect(wrap).toBeDefined();
    const cleanup = H.effects[1]!() as () => void;
    listeners.mousedown!({ target: inside });
    listeners.keydown!({ key: "Enter" });
    expect(menu(render())).toBeDefined();
    listeners.keydown!({ key: "Escape" });
    expect(menu(render())).toBeUndefined();
    openMenu();
    listeners.mousedown!({ target: {} });
    expect(menu(render())).toBeUndefined();
    cleanup();
    expect(removed.sort()).toEqual(["keydown", "mousedown"]);
  });

  it("no connector object: a plain dot instead of a logo, and no 'via'", () => {
    account({ address: ADDRESS, isConnected: true, chainId: CHAIN_ID, connector: undefined });
    const tree = openMenu();
    expect(all(tree, (e) => e.type === "span" && String(e.props.className).includes("rounded-full bg-accent"))).toHaveLength(1);
    expect(menu(tree)!.via).toBeNull();
  });

  it("block centres the wrapper and the button instead of stretching them", () => {
    const tree = ConnectButton({ block: true }) as El;
    expect(tree.props.className).toBe("relative justify-self-center self-center");
  });
});

describe("switching network", () => {
  const provider = { request: vi.fn(async () => null) };
  beforeEach(() => {
    provider.request.mockClear();
    account({ address: ADDRESS, isConnected: true, chainId: 1, connector: { getProvider: async () => provider } });
  });
  const switchButton = () => {
    const el = render() as El;
    return (el.type as (p: Props) => El)(el.props);
  };

  it("the wrong-network button switches to 4663", async () => {
    switchChain.mockResolvedValue(undefined);
    const btn = switchButton();
    expect(text(btn.props.children)).toBe("Switch to Robinhood Chain");
    await (btn.props.onClick as () => Promise<void>)();
    await vi.waitFor(() => expect(switchChain).toHaveBeenCalledWith({ chainId: CHAIN_ID }));
    expect(provider.request).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
  });

  it("a wallet that does not know the chain gets it added, then switches", async () => {
    switchChain.mockRejectedValueOnce(Object.assign(new Error("Unrecognized chain"), { code: 4902 })).mockResolvedValueOnce(undefined);
    (switchButton().props.onClick as () => void)();
    await vi.waitFor(() => expect(switchChain).toHaveBeenCalledTimes(2));
    expect(provider.request).toHaveBeenCalledWith(expect.objectContaining({ method: "wallet_addEthereumChain" }));
  });

  it("declined in the wallet: 'Declined in your wallet.'; any other failure: the described error", async () => {
    switchChain.mockRejectedValue(Object.assign(new Error("no"), { code: 4001 }));
    (switchButton().props.onClick as () => void)();
    await vi.waitFor(() => expect(notice).toHaveBeenCalledWith("error", "Could not switch network", "Declined in your wallet."));
    account({ address: ADDRESS, isConnected: true, chainId: 1, connector: undefined });
    switchChain.mockRejectedValue(new Error("chain down"));
    (switchButton().props.onClick as () => void)();
    await vi.waitFor(() => expect(notice).toHaveBeenLastCalledWith("error", "Could not switch network", "chain down"));
  });

  it("while switching: disabled, 'Switching…', in the button and the banner", () => {
    vi.mocked(useSwitchChain).mockReturnValue({ mutateAsync: switchChain, isPending: true } as never);
    const btn = switchButton();
    expect(btn.props.disabled).toBe(true);
    expect(text(btn.props.children)).toBe("Switching…");
    const banner = WrongNetworkBanner() as El;
    const bannerBtn = all(banner, (e) => typeof e.props.onClick === "function")[0]!;
    expect(bannerBtn.props.disabled).toBe(true);
    expect(text(bannerBtn.props.children)).toBe("Switching…");
  });

  it("the banner's button runs the same switch", async () => {
    switchChain.mockResolvedValue(undefined);
    const banner = WrongNetworkBanner() as El;
    (all(banner, (e) => typeof e.props.onClick === "function")[0]!.props.onClick as () => void)();
    await vi.waitFor(() => expect(switchChain).toHaveBeenCalledWith({ chainId: CHAIN_ID }));
  });
});

describe("WalletMenu markup", () => {
  it("shows the full address, the connector, and three 44px menu items; the explorer item links to this address", () => {
    const html = renderToStaticMarkup(createElement(WalletMenu, { address: ADDRESS, via: "Rabby Wallet", onCopy: vi.fn(), onExplorer: vi.fn(), onDisconnect: vi.fn() }));
    expect(html).toContain('role="menu"');
    expect(html).toContain('aria-label="Wallet"');
    expect(html).toContain(`>${ADDRESS}</p>`);
    expect(html).toContain("via Rabby Wallet");
    expect(html.match(/role="menuitem"/g)).toHaveLength(3);
    expect(html.match(/min-h-11/g)).toHaveLength(3);
    expect(html).toContain(`href="${addressUrl(ADDRESS)}"`);
    for (const label of ["Copy address", "View on explorer", "Disconnect"]) expect(html).toContain(label);
  });

  it("without a connector name there is no 'via' line; the copy item calls onCopy", () => {
    const onCopy = vi.fn();
    const tree = WalletMenu({ address: ADDRESS, via: null, onCopy, onExplorer: vi.fn(), onDisconnect: vi.fn() }) as El;
    expect(renderToStaticMarkup(tree)).not.toContain("via ");
    (byText(tree, "Copy address")!.props.onClick as () => void)();
    expect(onCopy).toHaveBeenCalledTimes(1);
  });
});
