import { createConfig, fallback, http } from "wagmi";
import { injected } from "wagmi/connectors/injected";
import { metaMask } from "wagmi/connectors/metaMask";

import { robinhoodChain } from "./chain";
import { APP_URL } from "./site";

/**
 * wagmi config. The picker that reads it is components/ConnectButton.tsx (logic: lib/wallets.ts).
 *
 * Connectors:
 *   - EIP-6963 discovery (`multiInjectedProviderDiscovery`): every extension that announces itself
 *     gets its own row, with the name and icon it announces.
 *   - `metaMask()`: declares rdns io.metamask, so wagmi hands an announcing MetaMask extension to it
 *     instead of adding a second MetaMask row. Its SDK fallback (`@metamask/connect-evm`, an optional
 *     peer) is NOT installed, so without the extension it cannot connect; the picker shows MetaMask
 *     as "not installed" there, with the install link and, on a phone, the in-app browser link.
 *   - `injected({ target: "phantom" })`: Phantom's EVM provider (`window.phantom.ethereum`), for a
 *     Phantom that does not announce over EIP-6963. When it does announce, lib/wallets.ts keeps one
 *     Phantom row.
 *   - No Coinbase Wallet: wagmi's `coinbaseWallet()` needs `@coinbase/wallet-sdk`, an optional peer
 *     that is not installed, and this app adds no dependency for it. A Coinbase Wallet extension
 *     still appears through EIP-6963.
 *   - No WalletConnect.
 *
 * Transports: the same two RPCs as lib/chain.ts, primary first. `rank: false` keeps that order.
 * `ssr: true` because these pages are prerendered; discovered wallets appear after hydration.
 */
export const wagmiConfig = createConfig({
  chains: [robinhoodChain],
  connectors: [
    metaMask({
      dappMetadata: {
        name: "StonkHouse",
        url: APP_URL,
      },
    }),
    injected({ target: "phantom", shimDisconnect: true }),
  ],
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
