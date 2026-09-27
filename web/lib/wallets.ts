import { numberToHex, type Chain } from "viem";

/**
 * The wallet picker's logic, kept out of the component so it can be tested without a browser.
 *
 * Where the rows come from (lib/wagmi.ts):
 *   - `metaMask()` (id `metaMaskSDK`, rdns `io.metamask` / `io.metamask.mobile`). wagmi routes an
 *     announcing MetaMask extension to this connector and suppresses its EIP-6963 twin
 *     (@wagmi/core createConfig, the rdns set).
 *   - `injected({ target: "phantom" })` (id `phantom`). The static target declares no rdns, so wagmi
 *     does NOT suppress Phantom's own EIP-6963 announcement (`app.phantom`): both arrive, and
 *     `walletEntries` keeps one.
 *   - every other extension that announces itself over EIP-6963: id = its rdns, with its own name
 *     and icon.
 */

/** The fields of a wagmi connector the picker reads. A structural subset, so tests need no wagmi. */
export type ConnectorLike = {
  id: string;
  uid: string;
  name: string;
  type: string;
  icon?: string;
  rdns?: string | readonly string[];
};

export type WalletEntry<C extends ConnectorLike = ConnectorLike> = {
  /** Stable across sessions: the canonical wallet key ("metamask", "phantom", or an rdns). */
  key: string;
  name: string;
  icon?: string;
  /** A provider for it is present in this browser. `false` means connecting cannot work here. */
  installed: boolean;
  /** Connected with it before, on this device. */
  recent: boolean;
  connector: C;
};

/** The two wallets the app names. Each lists every id/rdns that can stand for it. */
export const KNOWN_WALLETS = {
  metamask: {
    name: "MetaMask",
    ids: ["metaMaskSDK", "metaMask", "io.metamask", "io.metamask.mobile"],
    install: "https://metamask.io/download/",
  },
  phantom: {
    name: "Phantom",
    ids: ["phantom", "app.phantom"],
    install: "https://phantom.com/download",
  },
} as const;

export type KnownWallet = keyof typeof KNOWN_WALLETS;

const rdnsOf = (c: ConnectorLike): string[] => (c.rdns === undefined ? [] : typeof c.rdns === "string" ? [c.rdns] : [...c.rdns]);

/** The canonical key of a connector: a known wallet's name, else its rdns / id. */
export function walletKey(c: ConnectorLike): string {
  const ids = [c.id, ...rdnsOf(c)];
  for (const [key, known] of Object.entries(KNOWN_WALLETS)) {
    if (ids.some((id) => (known.ids as readonly string[]).includes(id))) return key;
  }
  return c.id;
}

/**
 * One row per wallet.
 *
 * `detected(c)` says whether a provider for the connector exists in this browser: an EIP-6963
 * connector always has one (it was announced), a static target has one only if its window
 * property is there. Passed in, because only the component can ask the connector.
 *
 * When two connectors are the same wallet, the one with a provider wins, then the one with an
 * icon (the EIP-6963 announcement carries it). The generic "Injected" connector wagmi creates for a
 * bare `window.ethereum` is dropped whenever a named wallet is installed: it is the same provider
 * under a worse name.
 */
export function walletEntries<C extends ConnectorLike>(
  connectors: readonly C[],
  detected: (c: C) => boolean,
  recentKeys: readonly string[] = [],
): WalletEntry<C>[] {
  const byKey = new Map<string, WalletEntry<C>>();
  for (const connector of connectors) {
    const key = walletKey(connector);
    const known = KNOWN_WALLETS[key as KnownWallet];
    const entry: WalletEntry<C> = {
      key,
      name: known?.name ?? connector.name,
      icon: connector.icon,
      installed: detected(connector),
      recent: recentKeys.includes(key),
      connector,
    };
    const prior = byKey.get(key);
    if (prior === undefined) {
      byKey.set(key, entry);
      continue;
    }
    const score = (e: WalletEntry<C>) => (e.installed ? 2 : 0) + (e.icon ? 1 : 0);
    const winner = score(entry) > score(prior) ? entry : prior;
    byKey.set(key, { ...winner, icon: winner.icon ?? prior.icon ?? entry.icon });
  }
  let entries = [...byKey.values()];
  if (entries.some((e) => e.key !== "injected" && e.installed)) entries = entries.filter((e) => e.key !== "injected");
  return orderWallets(entries, recentKeys);
}

/**
 * Installed wallets first; among them the most recently used first (in `recentKeys` order), then
 * the rest by name. Wallets that are not installed come last, MetaMask and Phantom in that order.
 */
export function orderWallets<E extends { key: string; name: string; installed: boolean }>(entries: readonly E[], recentKeys: readonly string[]): E[] {
  const rank = (e: E) => {
    const r = recentKeys.indexOf(e.key);
    return r === -1 ? recentKeys.length : r;
  };
  const known = Object.keys(KNOWN_WALLETS);
  return [...entries].sort((a, b) => {
    if (a.installed !== b.installed) return a.installed ? -1 : 1;
    if (a.installed) return rank(a) - rank(b) || a.name.localeCompare(b.name);
    const ka = known.indexOf(a.key);
    const kb = known.indexOf(b.key);
    return (ka === -1 ? known.length : ka) - (kb === -1 ? known.length : kb) || a.name.localeCompare(b.name);
  });
}

/* ------------------------------------------------------------------------------------------ */
/*  recent wallets                                                                             */
/* ------------------------------------------------------------------------------------------ */

export const RECENT_KEY = "stonkhouse.wallet.recent";
const RECENT_MAX = 3;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // a sandboxed frame or a privacy mode that throws on access
  }
}

/** The wallet keys used on this device, most recent first. Never throws; [] when unreadable. */
export function readRecent(storage: StorageLike | null = browserStorage()): string[] {
  try {
    const raw = storage?.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** Put `key` at the front. Returns the new list. Storage failures are swallowed: memory is a nicety. */
export function rememberRecent(key: string, storage: StorageLike | null = browserStorage()): string[] {
  const next = [key, ...readRecent(storage).filter((k) => k !== key)].slice(0, RECENT_MAX);
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // quota or privacy mode
  }
  return next;
}

/* ------------------------------------------------------------------------------------------ */
/*  errors                                                                                     */
/* ------------------------------------------------------------------------------------------ */

export type ConnectFailure = "rejected" | "pending" | "unsupported" | "unknown";

/** EIP-1193 / EIP-1474 codes, and wagmi / viem error names, anywhere in the cause chain. */
export function classifyConnectError(err: unknown): ConnectFailure {
  const seen = new Set<unknown>();
  let e: unknown = err;
  while (e !== null && typeof e === "object" && !seen.has(e)) {
    seen.add(e);
    const { code, name } = e as { code?: unknown; name?: unknown };
    if (code === 4001 || name === "UserRejectedRequestError") return "rejected";
    if (code === -32002 || name === "ResourceUnavailableRpcError") return "pending";
    if (
      code === 4200 ||
      name === "ProviderNotFoundError" ||
      name === "ConnectorNotFoundError" ||
      name === "ConnectorChainMismatchError" ||
      name === "ChainNotConfiguredError" ||
      name === "UnsupportedProviderMethodError"
    )
      return "unsupported";
    e = (e as { cause?: unknown }).cause;
  }
  return "unknown";
}

export const CONNECT_FAILURE_TEXT: Record<ConnectFailure, string> = {
  rejected: "You declined the request in your wallet.",
  pending: "Your wallet already has a request waiting. Open it and approve or reject that one first.",
  unsupported: "This wallet cannot connect from this browser. Try another, or install it.",
  unknown: "The wallet did not connect.",
};

/* ------------------------------------------------------------------------------------------ */
/*  mobile                                                                                     */
/* ------------------------------------------------------------------------------------------ */

export function isMobileUserAgent(ua: string): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
}

/**
 * Open this page inside a wallet's in-app browser, where its provider is injected.
 *   MetaMask: https://metamask.app.link/dapp/<host><path><query> (no scheme).
 *   Phantom:  https://phantom.app/ul/browse/<url-encoded url>?ref=<url-encoded origin>.
 */
export function mobileDeepLinks(href: string): Record<KnownWallet, string> {
  const url = new URL(href);
  const bare = `${url.host}${url.pathname}${url.search}${url.hash}`;
  return {
    metamask: `https://metamask.app.link/dapp/${bare}`,
    phantom: `https://phantom.app/ul/browse/${encodeURIComponent(url.href)}?ref=${encodeURIComponent(url.origin)}`,
  };
}

/* ------------------------------------------------------------------------------------------ */
/*  network                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/** The `wallet_addEthereumChain` parameter for `chain` (EIP-3085), from lib/chain.ts's definition. */
export function addChainParameter(chain: Chain) {
  return {
    chainId: numberToHex(chain.id),
    chainName: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: [...chain.rpcUrls.default.http],
    blockExplorerUrls: chain.blockExplorers?.default ? [chain.blockExplorers.default.url] : undefined,
  };
}

type Requester = { request: (args: { method: string; params?: unknown }) => Promise<unknown> };

/**
 * Switch the wallet to `chain`. wagmi's `switchChain` already adds the chain on a 4902; some wallets
 * answer something else for an unknown chain (a generic -32603, or a wrapped error), so on any
 * failure that is not the user saying no, add the chain explicitly and switch once more.
 * A rejection is rethrown untouched: asking again after "no" is not a fallback.
 */
export async function switchOrAddChain(
  chain: Chain,
  switchChain: (chainId: number) => Promise<unknown>,
  getProvider: () => Promise<Requester | undefined>,
): Promise<void> {
  try {
    await switchChain(chain.id);
    return;
  } catch (err) {
    if (classifyConnectError(err) === "rejected") throw err;
    const provider = await getProvider();
    if (provider === undefined) throw err;
    await provider.request({ method: "wallet_addEthereumChain", params: [addChainParameter(chain)] });
    await switchChain(chain.id);
  }
}
