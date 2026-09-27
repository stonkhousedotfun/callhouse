import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { useAccount, useConnect, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useMounted } from "@/lib/hooks";
import { CHAIN_ID } from "@/lib/chain";
import { walletEntries, type ConnectorLike } from "@/lib/wallets";
import { ConnectButton, WrongNetworkBanner } from "./ConnectButton";
import { WalletPicker, type PickerView } from "./WalletModal";

vi.mock("wagmi", () => ({
  useAccount: vi.fn(),
  useConnect: vi.fn(),
  useConnectors: vi.fn(),
  useDisconnect: vi.fn(),
  useSwitchChain: vi.fn(),
}));
vi.mock("@/lib/hooks", () => ({ useMounted: vi.fn() }));
vi.mock("@/components/TxToast", () => ({ useNotice: () => vi.fn(), describeError: (e: unknown) => String(e) }));

const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

function account(over: Partial<ReturnType<typeof useAccount>> = {}) {
  vi.mocked(useAccount).mockReturnValue({ address: undefined, isConnected: false, chainId: undefined, connector: undefined, ...over } as ReturnType<typeof useAccount>);
}

beforeEach(() => {
  vi.mocked(useMounted).mockReturnValue(true);
  account();
  vi.mocked(useConnectors).mockReturnValue([] as unknown as ReturnType<typeof useConnectors>);
  vi.mocked(useConnect).mockReturnValue({ mutateAsync: vi.fn() } as unknown as ReturnType<typeof useConnect>);
  vi.mocked(useDisconnect).mockReturnValue({ mutate: vi.fn() } as unknown as ReturnType<typeof useDisconnect>);
  vi.mocked(useSwitchChain).mockReturnValue({ mutateAsync: vi.fn(), isPending: false } as unknown as ReturnType<typeof useSwitchChain>);
});

describe("ConnectButton", () => {
  it("keeps its public props: { block } only", () => {
    const source = readFileSync(fileURLToPath(new URL("./ConnectButton.tsx", import.meta.url)), "utf8");
    expect(source).toContain("export function ConnectButton({ block = false }: { block?: boolean })");
  });

  it("SSR: before hydration the server and the first client render are the same disabled Connect", () => {
    vi.mocked(useMounted).mockReturnValue(false);
    // Even with a wallet connected on the client, the pre-mount render must not depend on it.
    account({ address: ADDRESS, isConnected: true, chainId: CHAIN_ID });
    const server = renderToString(createElement(ConnectButton));
    account();
    const firstClient = renderToString(createElement(ConnectButton));
    expect(server).toBe(firstClient);
    expect(server).toMatch(/<button[^>]*disabled[^>]*>Connect<\/button>/);
    expect(renderToString(createElement(ConnectButton, { block: true }))).toContain("justify-self-center");
  });

  // Unstretched it is a header control, 44px tall in every state; `block` keeps md's classes.
  it("every state is the touch size; block sits centred, not stretched", () => {
    const touch = / min-h-11 px-4 py-2 text-sm /;
    vi.mocked(useMounted).mockReturnValue(false);
    expect(renderToStaticMarkup(createElement(ConnectButton))).toMatch(touch);
    const block = renderToStaticMarkup(createElement(ConnectButton, { block: true }));
    expect(block).toMatch(touch);
    expect(block).toContain("justify-self-center");
    expect(block).not.toContain("w-full");
    vi.mocked(useMounted).mockReturnValue(true);
    expect(renderToStaticMarkup(createElement(ConnectButton))).toMatch(touch);
    account({ address: ADDRESS, isConnected: true, chainId: 1 });
    expect(renderToStaticMarkup(createElement(ConnectButton))).toMatch(touch);
    account({ address: ADDRESS, isConnected: true, chainId: CHAIN_ID });
    expect(renderToStaticMarkup(createElement(ConnectButton))).toMatch(touch);
    expect(renderToStaticMarkup(createElement(ConnectButton))).not.toContain("min-h-9");
  });

  it("disconnected: a Connect button that opens a dialog, and no dialog until it is clicked", () => {
    const html = renderToStaticMarkup(createElement(ConnectButton));
    expect(html).toContain(">Connect</button>");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('role="dialog"');
  });

  it("wrong chain: a switch prompt, never a network picker", () => {
    account({ address: ADDRESS, isConnected: true, chainId: 1 });
    const html = renderToStaticMarkup(createElement(ConnectButton));
    expect(html).toContain("Switch to Robinhood Chain");
    expect(html).not.toContain(ADDRESS.slice(0, 6));
  });

  it("connected on 4663: the short address, with the account menu closed", () => {
    account({ address: ADDRESS, isConnected: true, chainId: CHAIN_ID });
    const html = renderToStaticMarkup(createElement(ConnectButton));
    expect(html).toContain("0x1234");
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).not.toContain("Disconnect");
  });
});

describe("WrongNetworkBanner", () => {
  it("renders only for a connected wallet on another network", () => {
    account({ address: ADDRESS, isConnected: true, chainId: 1 });
    expect(renderToStaticMarkup(createElement(WrongNetworkBanner))).toContain("Your wallet is on another network");
    account({ address: ADDRESS, isConnected: true, chainId: CHAIN_ID });
    expect(renderToStaticMarkup(createElement(WrongNetworkBanner))).toBe("");
    account();
    expect(renderToStaticMarkup(createElement(WrongNetworkBanner))).toBe("");
    vi.mocked(useMounted).mockReturnValue(false);
    account({ address: ADDRESS, isConnected: true, chainId: 1 });
    expect(renderToStaticMarkup(createElement(WrongNetworkBanner)), "nothing before hydration").toBe("");
  });
});

describe("WalletPicker states", () => {
  let n = 0;
  const conn = (over: Partial<ConnectorLike> & Pick<ConnectorLike, "id" | "name">): ConnectorLike => ({ uid: `c${++n}`, type: "injected", ...over });
  const connectors = [
    conn({ id: "metaMaskSDK", name: "MetaMask", type: "metaMask", rdns: ["io.metamask"] }),
    conn({ id: "phantom", name: "Phantom" }),
    conn({ id: "io.rabby", name: "Rabby Wallet", rdns: "io.rabby", icon: "data:image/svg+xml,r" }),
  ];
  const picker = (view: PickerView, over: Partial<Parameters<typeof WalletPicker>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(WalletPicker, {
        view,
        entries: walletEntries(connectors, () => true),
        detecting: false,
        mobile: false,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
        onBack: vi.fn(),
        titleId: "t",
        ...over,
      }),
    );

  it("lists installed wallets with icons, and marks the recent one", () => {
    const html = picker({ kind: "list" }, { entries: walletEntries(connectors, () => true, ["io.rabby"]) });
    expect(html).toContain('id="t"');
    expect(html).toContain("Installed");
    expect(html).toContain('src="data:image/svg+xml,r"');
    expect(html.indexOf("Rabby Wallet")).toBeLessThan(html.indexOf("MetaMask"));
    expect(html).toContain("Recent");
  });

  it("no wallet on a desktop: install links for MetaMask and Phantom", () => {
    const html = picker({ kind: "list" }, { entries: walletEntries(connectors.slice(0, 2), () => false) });
    expect(html).toContain("No wallet found in this browser");
    expect(html).toContain('href="https://metamask.io/download/"');
    expect(html).toContain('href="https://phantom.com/download"');
    expect(html).not.toContain("Open in MetaMask");
  });

  it("no wallet on a phone: deep links into the in-app browsers", () => {
    const html = picker(
      { kind: "list" },
      {
        entries: walletEntries(connectors.slice(0, 2), () => false),
        mobile: true,
        deepLinks: { metamask: "https://metamask.app.link/dapp/x.test/", phantom: "https://phantom.app/ul/browse/x" },
      },
    );
    expect(html).toContain("Open in MetaMask");
    expect(html).toContain('href="https://metamask.app.link/dapp/x.test/"');
    expect(html).toContain("Open in Phantom");
  });

  it("while detecting, says so instead of claiming there is no wallet", () => {
    const html = picker({ kind: "list" }, { entries: walletEntries(connectors.slice(0, 2), () => false), detecting: true });
    expect(html).toContain("Looking for wallets");
    expect(html).not.toContain("No wallet found");
  });

  it("connecting: names the wallet and offers Cancel", () => {
    const entry = walletEntries(connectors, () => true)[0]!;
    const html = picker({ kind: "connecting", entry });
    expect(html).toContain(`Waiting for ${entry.name}`);
    expect(html).toContain(">Cancel</button>");
  });

  it("errors: rejected, already pending and unsupported each say what happened", () => {
    const entry = walletEntries(connectors, () => true)[0]!;
    expect(picker({ kind: "error", entry, failure: "rejected" })).toContain("Connection declined");
    const pending = picker({ kind: "error", entry, failure: "pending" });
    expect(pending).toContain("already has a request waiting");
    expect(pending).toContain("Try again");
    const unsupported = picker({ kind: "error", entry, failure: "unsupported" });
    expect(unsupported).toContain("cannot connect from this browser");
    expect(unsupported, "retrying an unsupported wallet cannot work").not.toContain("Try again");
  });
});
