import { describe, expect, it, vi } from "vitest";

import { robinhoodChain } from "./chain";
import {
  addChainParameter,
  classifyConnectError,
  isMobileUserAgent,
  mobileDeepLinks,
  orderWallets,
  readRecent,
  RECENT_KEY,
  rememberRecent,
  switchOrAddChain,
  walletEntries,
  walletKey,
  type ConnectorLike,
} from "./wallets";

let n = 0;
const conn = (over: Partial<ConnectorLike> & Pick<ConnectorLike, "id" | "name">): ConnectorLike => ({ uid: `u${++n}`, type: "injected", ...over });

// The shapes lib/wagmi.ts produces: metaMask() and the static Phantom target, plus what EIP-6963 adds.
const metaMaskSdk = () => conn({ id: "metaMaskSDK", name: "MetaMask", type: "metaMask", rdns: ["io.metamask", "io.metamask.mobile"] });
const phantomStatic = () => conn({ id: "phantom", name: "Phantom" });
const phantom6963 = () => conn({ id: "app.phantom", name: "Phantom", rdns: "app.phantom", icon: "data:image/svg+xml,phantom" });
const rabby = () => conn({ id: "io.rabby", name: "Rabby Wallet", rdns: "io.rabby", icon: "data:image/svg+xml,rabby" });
const coinbase = () => conn({ id: "com.coinbase.wallet", name: "Coinbase Wallet", rdns: "com.coinbase.wallet", icon: "data:image/png,cb" });
const generic = () => conn({ id: "injected", name: "Injected" });

const all = () => true;
const none = () => false;

describe("walletKey", () => {
  it("maps every id and rdns MetaMask or Phantom can arrive under to one key", () => {
    for (const c of [metaMaskSdk(), conn({ id: "io.metamask", name: "MetaMask" }), conn({ id: "x", name: "MetaMask", rdns: "io.metamask.mobile" })]) {
      expect(walletKey(c)).toBe("metamask");
    }
    expect(walletKey(phantomStatic())).toBe("phantom");
    expect(walletKey(phantom6963())).toBe("phantom");
    expect(walletKey(rabby())).toBe("io.rabby");
  });
});

describe("walletEntries: discovery dedupe", () => {
  it("keeps ONE Phantom when both the static target and the EIP-6963 announcement exist, and prefers the announced one", () => {
    const announced = phantom6963();
    const entries = walletEntries([metaMaskSdk(), phantomStatic(), announced], all);
    const phantoms = entries.filter((e) => e.key === "phantom");
    expect(phantoms).toHaveLength(1);
    expect(phantoms[0]!.connector).toBe(announced);
    expect(phantoms[0]!.icon).toBe("data:image/svg+xml,phantom");
  });

  it("prefers the connector that has a provider over one that only has an icon", () => {
    const stat = phantomStatic();
    const announced = phantom6963();
    const entries = walletEntries([stat, announced], (c) => c === stat);
    const phantom = entries.find((e) => e.key === "phantom")!;
    expect(phantom.connector).toBe(stat);
    expect(phantom.installed).toBe(true);
    expect(phantom.icon, "the icon is kept from the twin that lost").toBe("data:image/svg+xml,phantom");
  });

  it("never shows MetaMask twice, whatever ids arrive", () => {
    const entries = walletEntries([metaMaskSdk(), conn({ id: "io.metamask", name: "MetaMask", rdns: "io.metamask" })], all);
    expect(entries.filter((e) => e.name === "MetaMask")).toHaveLength(1);
  });

  it("lists every other announced extension under its own name and icon", () => {
    const entries = walletEntries([metaMaskSdk(), phantomStatic(), rabby(), coinbase()], all);
    expect(entries.map((e) => e.name).sort()).toEqual(["Coinbase Wallet", "MetaMask", "Phantom", "Rabby Wallet"]);
    expect(entries.find((e) => e.key === "io.rabby")!.icon).toBe("data:image/svg+xml,rabby");
  });

  it("drops the generic Injected row when a named wallet is installed, and keeps it when it is the only wallet", () => {
    expect(walletEntries([generic(), rabby()], all).map((e) => e.key)).toEqual(["io.rabby"]);
    expect(walletEntries([generic(), metaMaskSdk()], (c) => c.id === "injected").map((e) => e.key)).toContain("injected");
  });

  it("the no-wallet state: nothing installed, MetaMask then Phantom offered", () => {
    const entries = walletEntries([metaMaskSdk(), phantomStatic()], none);
    expect(entries.every((e) => !e.installed)).toBe(true);
    expect(entries.map((e) => e.key)).toEqual(["metamask", "phantom"]);
  });
});

describe("recent ordering", () => {
  it("puts installed wallets first, the most recent first among them, then the rest by name", () => {
    const entries = walletEntries([metaMaskSdk(), phantomStatic(), rabby(), coinbase()], (c) => c.id !== "phantom", ["io.rabby", "metamask"]);
    expect(entries.map((e) => e.key)).toEqual(["io.rabby", "metamask", "com.coinbase.wallet", "phantom"]);
    expect(entries.filter((e) => e.recent).map((e) => e.key)).toEqual(["io.rabby", "metamask"]);
  });

  it("a recent wallet that is not installed does not jump the installed ones", () => {
    const order = orderWallets(
      [
        { key: "phantom", name: "Phantom", installed: false },
        { key: "io.rabby", name: "Rabby", installed: true },
      ],
      ["phantom"],
    );
    expect(order.map((e) => e.key)).toEqual(["io.rabby", "phantom"]);
  });

  it("remembers at most three, most recent first, and survives a storage that throws", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    rememberRecent("metamask", storage);
    rememberRecent("phantom", storage);
    rememberRecent("io.rabby", storage);
    rememberRecent("metamask", storage);
    rememberRecent("com.coinbase.wallet", storage);
    expect(readRecent(storage)).toEqual(["com.coinbase.wallet", "metamask", "io.rabby"]);
    expect(JSON.parse(store.get(RECENT_KEY)!)).toHaveLength(3);

    const hostile = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readRecent(hostile)).toEqual([]);
    expect(rememberRecent("metamask", hostile)).toEqual(["metamask"]);
    expect(readRecent({ getItem: () => "{not json", setItem: () => {} })).toEqual([]);
    expect(readRecent(null)).toEqual([]);
  });
});

describe("classifyConnectError", () => {
  it("reads codes and names anywhere in the cause chain", () => {
    expect(classifyConnectError({ code: 4001 })).toBe("rejected");
    expect(classifyConnectError({ name: "ConnectorAlreadyConnectedError", cause: { name: "UserRejectedRequestError" } })).toBe("rejected");
    expect(classifyConnectError({ code: -32002, message: "Request already pending" })).toBe("pending");
    expect(classifyConnectError({ name: "ProviderNotFoundError" })).toBe("unsupported");
    expect(classifyConnectError(new Error("boom"))).toBe("unknown");
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(classifyConnectError(loop)).toBe("unknown");
  });
});

describe("mobile", () => {
  it("recognises phones and tablets, not desktops", () => {
    expect(isMobileUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148")).toBe(true);
    expect(isMobileUserAgent("Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari/537.36")).toBe(true);
    expect(isMobileUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15")).toBe(false);
  });

  it("deep-links the current page into the MetaMask and Phantom in-app browsers", () => {
    const links = mobileDeepLinks("https://app.stonkhouse.fun/markets/NVDA?side=call#ticket");
    expect(links.metamask).toBe("https://metamask.app.link/dapp/app.stonkhouse.fun/markets/NVDA?side=call#ticket");
    expect(links.phantom).toBe(
      "https://phantom.app/ul/browse/https%3A%2F%2Fapp.stonkhouse.fun%2Fmarkets%2FNVDA%3Fside%3Dcall%23ticket?ref=https%3A%2F%2Fapp.stonkhouse.fun",
    );
  });
});

describe("the wrong-chain flow", () => {
  it("builds wallet_addEthereumChain for 4663 from lib/chain.ts, not from typed values", () => {
    const p = addChainParameter(robinhoodChain);
    expect(p.chainId).toBe(`0x${robinhoodChain.id.toString(16)}`);
    expect(p.chainName).toBe(robinhoodChain.name);
    expect(p.rpcUrls).toEqual([...robinhoodChain.rpcUrls.default.http]);
    expect(p.blockExplorerUrls).toEqual([robinhoodChain.blockExplorers!.default.url]);
    expect(p.nativeCurrency).toEqual(robinhoodChain.nativeCurrency);
  });

  it("a switch that works needs nothing else", async () => {
    const switchChain = vi.fn().mockResolvedValue(undefined);
    const getProvider = vi.fn();
    await switchOrAddChain(robinhoodChain, switchChain, getProvider);
    expect(switchChain).toHaveBeenCalledOnce();
    expect(getProvider).not.toHaveBeenCalled();
  });

  it("an unknown chain is added, then switched to", async () => {
    const switchChain = vi.fn().mockRejectedValueOnce({ code: -32603, message: "Unrecognized chain ID" }).mockResolvedValueOnce(undefined);
    const request = vi.fn().mockResolvedValue(null);
    await switchOrAddChain(robinhoodChain, switchChain, async () => ({ request }));
    expect(request).toHaveBeenCalledWith({ method: "wallet_addEthereumChain", params: [addChainParameter(robinhoodChain)] });
    expect(switchChain).toHaveBeenCalledTimes(2);
  });

  it("a rejected switch is not followed by an add", async () => {
    const rejected = { code: 4001, message: "User rejected" };
    const request = vi.fn();
    await expect(switchOrAddChain(robinhoodChain, vi.fn().mockRejectedValue(rejected), async () => ({ request }))).rejects.toBe(rejected);
    expect(request).not.toHaveBeenCalled();
  });

  it("with no provider to ask, the original error surfaces", async () => {
    const err = { code: -32603 };
    await expect(switchOrAddChain(robinhoodChain, vi.fn().mockRejectedValue(err), async () => undefined)).rejects.toBe(err);
  });
});
