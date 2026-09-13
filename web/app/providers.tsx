"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { WagmiProvider } from "wagmi";

import { ToastProvider } from "@/components/TxToast";
import { wagmiConfig } from "@/lib/wagmi";

/**
 * One QueryClient per browser session, created inside the component so a server render never
 * shares a cache between requests.
 *
 * `retry: 1` and a 15s stale window match the chain read cadence in lib/hooks.ts. The indexer
 * client in lib/api.ts already fails soft on its own, so nothing here needs a retry storm to
 * paper over a dead history endpoint.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            staleTime: 15_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
