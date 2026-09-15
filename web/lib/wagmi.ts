import { createConfig, fallback, http } from "wagmi";
import { injected } from "wagmi/connectors/injected";
import { metaMask } from "wagmi/connectors/metaMask";

import { robinhoodChain } from "./chain";
import { APP_URL } from "./site";

/**
 * wagmi config.
 *
 * Two named wallets, no generic `injected()`:
 *   - `metaMask()` — wagmi's MetaMask connector (extension via EIP-6963, SDK fallback)
 *   - `injected({ target: "phantom" })` — Phantom's EVM provider (`window.phantom.ethereum`)
 *
 * `multiInjectedProviderDiscovery` is off so EIP-6963 does not add a third "Injected" row for
 * every other extension. WalletConnect is not wired (no project id, no relay).
 *
 * Transports: the same two RPCs as lib/chain.ts, primary first. `rank: false` keeps that order.
 * `ssr: true` because these pages are prerendered.
 */
export const wagmiConfig = createConfig({
  chains: [robinhoodChain],
  connectors: [
    metaMask({
      dappMetadata: {
        name: "Stonkhouse",
        url: APP_URL,
      },
    }),
    injected({ target: "phantom", shimDisconnect: true }),
  ],
  multiInjectedProviderDiscovery: false,
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
