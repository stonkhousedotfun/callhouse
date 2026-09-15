"use client";

/**
 * Toasts, and the one runner every form sends its transactions through.
 *
 * A revert is surfaced by name on purpose: the vault ABI carries every custom error, including
 * the ones raised inside its linked libraries, so viem decodes `UseQueue()` or
 * `PremiumBelowFloorAtFill(...)` instead of leaving a bare selector on screen. Those names are the
 * product rules, and lib/revert.ts translates the ones a depositor or a buyer can actually hit.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, type Hex } from "viem";
import { useConfig } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

import { ExternalLink, Panel } from "@/components/ui";
import { txUrl } from "@/lib/chain";
import { cn } from "@/lib/cn";
import { shortHash } from "@/lib/format";
import { decodeRevertData, explainRevert } from "@/lib/revert";

export type ToastTone = "pending" | "success" | "error";

export type Toast = {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
  hash?: Hex;
};

type ToastContextValue = {
  toasts: Toast[];
  push: (toast: Omit<Toast, "id">) => number;
  update: (id: number, patch: Partial<Omit<Toast, "id">>) => void;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * Turn any failure into a sentence a human can act on.
 *
 * viem decodes a revert against the ABI the call was made with; a vault error surfacing through a
 * Seaport call (the fill hooks) is not in Seaport's ABI, so the raw data is decoded again here
 * against the vault's merged ABI (lib/revert.ts) before falling back to viem's own message.
 */
export function describeError(err: unknown): string {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return "Rejected in wallet.";
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      if (name) return explainRevert(name, (reverted.data?.args ?? []) as readonly unknown[]);
      const decoded = decodeRevertData(reverted.raw);
      if (decoded?.name) return decoded.text;
      return reverted.shortMessage || "Reverted.";
    }
    return err.shortMessage || err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((toast: Omit<Toast, "id">) => {
    const id = nextId.current++;
    setToasts((current) => [...current, { ...toast, id }]);
    return id;
  }, []);

  const update = useCallback((id: number, patch: Partial<Omit<Toast, "id">>) => {
    setToasts((current) => current.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const value = useMemo(() => ({ toasts, push, update, dismiss }), [toasts, push, update, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastHost />
    </ToastContext.Provider>
  );
}

function useToastContext(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("ToastProvider is missing above this component");
  return ctx;
}

/** The stripe down a toast's left edge says its state before the words do. */
const STRIPE: Record<ToastTone, string> = {
  pending: "bg-usdg",
  success: "bg-accent",
  error: "bg-danger",
};

function ToastHost() {
  const { toasts, dismiss } = useToastContext();
  if (toasts.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed inset-x-3 bottom-3 z-60 flex flex-col gap-2 sm:left-auto sm:right-5 sm:bottom-5 sm:w-[380px]"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <Panel
          key={t.id}
          lift
          pad="none"
          data-tone={t.tone}
          className="pointer-events-auto relative overflow-hidden py-3 pl-[18px] pr-3 text-sm ring-1 ring-line"
        >
          <span aria-hidden="true" className={cn("absolute inset-y-0 left-0 w-1", STRIPE[t.tone])} />
          <div className="flex items-baseline justify-between gap-3">
            <span className="flex items-center gap-2 font-semibold text-ink">
              {t.tone === "pending" ? (
                <span
                  aria-hidden="true"
                  className="size-3 shrink-0 animate-spin rounded-full border-2 border-usdg/30 border-t-usdg"
                />
              ) : null}
              {t.title}
            </span>
            <button
              type="button"
              className="-my-1 cursor-pointer rounded-sm px-1.5 text-lg leading-none text-ink-3 transition-colors hover:text-ink"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
          {t.body ? <div className="mt-0.5 text-ink-2 [overflow-wrap:anywhere]">{t.body}</div> : null}
          {t.hash ? (
            <div className="mt-1">
              <ExternalLink href={txUrl(t.hash)} arrow className="link num text-[13px] text-usdg">
                {shortHash(t.hash)}
              </ExternalLink>
            </div>
          ) : null}
        </Panel>
      ))}
    </div>
  );
}

export type TxRun = {
  /** Shown while the wallet is open and while the tx is in flight. */
  pending: string;
  /** Shown once the receipt says status === "success". */
  success: string;
};

/**
 * Run one transaction with a toast for every stage, and a Blockscout link as soon as there is a
 * hash. Returns the hash on success, or null if anything went wrong — callers use that to decide
 * whether to move to the next step of a two-step flow (approve → deposit).
 */
export function useTxRunner() {
  const { push, update, dismiss } = useToastContext();
  const config = useConfig();

  return useCallback(
    async (send: () => Promise<Hex>, labels: TxRun): Promise<Hex | null> => {
      const id = push({ tone: "pending", title: labels.pending, body: "Confirm in your wallet." });
      try {
        const hash = await send();
        update(id, { body: "Waiting for the chain…", hash });
        const receipt = await waitForTransactionReceipt(config, { hash });
        if (receipt.status === "reverted") {
          update(id, { tone: "error", title: "Transaction reverted", body: undefined, hash });
          return null;
        }
        update(id, { tone: "success", title: labels.success, body: undefined, hash });
        setTimeout(() => dismiss(id), 9000);
        return hash;
      } catch (err) {
        update(id, { tone: "error", title: "Failed", body: describeError(err) });
        return null;
      }
    },
    [push, update, dismiss, config],
  );
}

/** Fire-and-forget notice, for things that are not transactions (copy to clipboard, API errors). */
export function useNotice() {
  const { push, dismiss } = useToastContext();
  return useCallback(
    (tone: ToastTone, title: string, body?: string) => {
      const id = push({ tone, title, body });
      setTimeout(() => dismiss(id), 5000);
    },
    [push, dismiss],
  );
}
