/** lib/wagmi.ts: the config's chain, connectors and transport order. No wallet or network is touched. */
import { describe, expect, it } from "vitest";

import { robinhoodChain } from "./chain";
import { wagmiConfig } from "./wagmi";

describe("wagmiConfig", () => {
  it("targets only Robinhood Chain", () => {
    expect(wagmiConfig.chains.map((c) => c.id)).toEqual([robinhoodChain.id]);
  });

  it("registers MetaMask and a Phantom-targeted injected connector, and no WalletConnect or Coinbase SDK", () => {
    const ids = wagmiConfig.connectors.map((c) => c.id);
    expect(ids).toContain("metaMaskSDK");
    expect(ids).toContain("phantom");
    expect(ids.some((id) => /walletconnect|coinbase/i.test(id))).toBe(false);
  });

  it("uses a fallback transport over both RPCs, in order", () => {
    const client = wagmiConfig.getClient({ chainId: robinhoodChain.id });
    expect(client.transport.type).toBe("fallback");
    const transports = (client.transport as unknown as { transports: Array<{ value?: { url?: string } }> }).transports;
    expect(transports.map((t) => t.value?.url)).toEqual(robinhoodChain.rpcUrls.default.http);
  });
});
