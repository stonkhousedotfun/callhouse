import { createConfig, fallback, http } from "wagmi";
import { injected } from "wagmi/connectors/injected";

import { robinhoodChain } from "./chain";

/**
 * wagmi config.
 *
 * Connectors: `injected()` only, with EIP-6963 multi-provider discovery on. That covers every
 * browser wallet the user actually has installed (MetaMask, Rabby, Brave, Coinbase extension …)
 * with zero extra dependencies. connectkit and RainbowKit are deliberately NOT installed — the
 * connect button in components/ConnectButton.tsx is fifty lines and adds no supply chain.
 * WalletConnect is not wired either: it would need @walletconnect/* and a project id, and a
 * relay hop for a chain whose wallet story is a browser extension.
 *
 * Transports: the same two RPCs as lib/chain.ts, primary first, in a fallback. `rank: false`
 * keeps the order fixed rather than letting latency sampling promote the backup, which is the
 * one that refuses archive reads.
 *
 * `ssr: true` because these pages are prerendered: it stops wagmi touching storage on the server
 * and defers hydration of the persisted connection to the client.
 */
export const wagmiConfig = createConfig({
  chains: [robinhoodChain],
  connectors: [injected({ shimDisconnect: true })],
  multiInjectedProviderDiscovery: true,
  ssr: true,
  transports: {
    [robinhoodChain.id]: fallback(
      robinhoodChain.rpcUrls.default.http.map((url) => http(url)),
      { rank: false },
    ),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
