"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useConnectors, useDisconnect, useSwitchChain } from "wagmi";

import { Button } from "@/components/ui";
import { CHAIN_ID } from "@/lib/chain";
import { shortAddress } from "@/lib/format";
import { useMounted } from "@/lib/hooks";
import { describeError, useNotice } from "./TxToast";

/**
 * Wallet connect: MetaMask and Phantom only.
 *
 * RainbowKit / connectkit are not installed. The two connectors are declared in lib/wagmi.ts;
 * this widget lists those two names, never a generic "Injected" row.
 *
 * The app is single-chain: CHAIN_ID is pinned to 4663. A wallet on any other network gets a
 * switch prompt, never a network picker.
 *
 * `block` stretches the button to its container's width (forms render this in place of submit).
 */
const MENU = "absolute right-0 top-[calc(100%+8px)] z-40 rounded-md bg-surface p-2 shadow-lift ring-1 ring-line";

const WALLET_ORDER = ["metaMaskSDK", "metaMask", "phantom"] as const;

export function ConnectButton({ block = false }: { block?: boolean }) {
  const mounted = useMounted();
  const { address, isConnected, chainId } = useAccount();
  const connectors = useConnectors();
  const { mutateAsync: connect, isPending: connecting } = useConnect();
  const { mutate: disconnect } = useDisconnect();
  const { mutateAsync: switchChain, isPending: switching } = useSwitchChain();
  const notice = useNotice();

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!mounted) {
    return (
      <Button size={block ? "md" : "sm"} disabled className={block ? "w-full" : undefined}>
        Connect
      </Button>
    );
  }

  if (isConnected && chainId !== CHAIN_ID) {
    return (
      <Button
        size={block ? "md" : "sm"}
        className={block ? "w-full" : undefined}
        disabled={switching}
        onClick={async () => {
          try {
            await switchChain({ chainId: CHAIN_ID });
          } catch (err) {
            notice("error", "Could not switch network", describeError(err));
          }
        }}
      >
        {switching ? "Switching…" : `Switch to Robinhood Chain`}
      </Button>
    );
  }

  if (isConnected && address) {
    return (
      <div ref={wrapRef} className={block ? "relative w-full" : "relative"}>
        <Button
          size={block ? "md" : "sm"}
          variant="ghost"
          className={block ? "w-full" : undefined}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-accent" />
          <span className="num">{shortAddress(address)}</span>
        </Button>
        {open ? (
          <div className={`${MENU} w-[240px]`}>
            <p className="num mb-2.5 px-1 text-xs leading-snug text-ink-3 [overflow-wrap:anywhere]">{address}</p>
            <Button
              size="sm"
              variant="ghost"
              className="w-full"
              onClick={() => {
                disconnect();
                setOpen(false);
              }}
            >
              Disconnect
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  const options = WALLET_ORDER.flatMap((id) => connectors.filter((c) => c.id === id));

  return (
    <div ref={wrapRef} className={block ? "relative w-full" : "relative"}>
      <Button
        size={block ? "md" : "sm"}
        className={block ? "w-full" : undefined}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        {connecting ? "Connecting…" : "Connect"}
      </Button>
      {open ? (
        <div className={`${MENU} w-[220px]`} role="listbox" aria-label="Wallets">
          <div className="grid gap-1">
            {options.map((connector) => (
              <Button
                key={connector.uid}
                size="sm"
                variant="ghost"
                className="w-full justify-start!"
                onClick={async () => {
                  setOpen(false);
                  try {
                    await connect({ connector, chainId: CHAIN_ID });
                  } catch (err) {
                    notice("error", "Could not connect", describeError(err));
                  }
                }}
              >
                {connector.name}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
